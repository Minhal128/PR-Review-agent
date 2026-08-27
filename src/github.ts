import { Octokit } from "@octokit/rest";
import type { ReviewedFinding, ReviewResult, Severity, SonarReport } from "./types.ts";

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  headSha: string;
  /** branch this PR targets - Sonar analyses the change set against it */
  baseRef: string;
  author: string;
  diff: string;
}

export async function fetchPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  const [meta, diff] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: number }),
    octokit.pulls.get({
      owner,
      repo,
      pull_number: number,
      mediaType: { format: "diff" },
    }),
  ]);

  return {
    owner,
    repo,
    number,
    title: meta.data.title,
    body: meta.data.body ?? "",
    headSha: meta.data.head.sha,
    baseRef: meta.data.base.ref,
    author: meta.data.user?.login ?? "unknown",
    // With `mediaType.format = "diff"` GitHub returns raw text, but the types
    // still describe the JSON shape.
    diff: diff.data as unknown as string,
  };
}

const EMOJI: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  nit: "⚪",
};

function commentBody(f: ReviewedFinding): string {
  const pct = Math.round(f.confidence * 100);
  const parts = [
    `${EMOJI[f.severity]} **${f.title}**`,
    "",
    f.detail,
    "",
    `**Suggested fix**`,
    "",
    f.suggestion,
    "",
    `<sub>\`${f.agent}\` agent · ${f.severity} · ${pct}% confidence</sub>`,
  ];
  return parts.join("\n");
}

export function summaryBody(result: ReviewResult, pr: PullRequest): string {
  const { findings, suppressed, usage } = result;
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  const lines: string[] = ["## Automated review", ""];

  if (findings.length === 0) {
    lines.push("No findings above the confidence threshold. Nothing blocking from the agents.");
  } else {
    const tally = (["critical", "major", "minor", "nit"] as Severity[])
      .filter((s) => counts[s])
      .map((s) => `${EMOJI[s]} ${counts[s]} ${s}`)
      .join(" · ");
    lines.push(tally, "");

    // Findings that could not be anchored to a changed line still need to be
    // seen - they go here instead of being silently dropped.
    const offDiff = findings.filter((f) => !f.inline);
    if (offDiff.length > 0) {
      lines.push("### Not anchored to a changed line", "");
      for (const f of offDiff) {
        lines.push(
          `- ${EMOJI[f.severity]} \`${f.file}:${f.line}\` **${f.title}** — ${f.detail} _(${f.agent}, ${Math.round(f.confidence * 100)}%)_`,
        );
      }
      lines.push("");
    }
  }

  const sonarSection = sonarBlock(result.sonar);
  if (sonarSection) lines.push("", sonarSection);

  if (suppressed > 0) {
    lines.push(
      "",
      `<sub>${suppressed} finding(s) dropped below the confidence threshold or as duplicates.</sub>`,
    );
  }

  const failed = usage.filter((u) => u.failed);
  if (failed.length > 0) {
    lines.push(
      "",
      `> ⚠️ ${failed.map((u) => `\`${u.agent}\` (${u.failed})`).join(", ")} did not complete, so that area was not reviewed.`,
    );
  }

  const inTok = usage.reduce((n, u) => n + u.inputTokens, 0);
  const outTok = usage.reduce((n, u) => n + u.outputTokens, 0);
  const slowest = usage.reduce((n, u) => Math.max(n, u.ms), 0);
  lines.push(
    "",
    `<sub>${usage.length} agents · ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out tokens · ${(slowest / 1000).toFixed(1)}s · reviewed \`${pr.headSha.slice(0, 7)}\`</sub>`,
  );

  return lines.join("\n");
}

/**
 * Sonar findings get their own section rather than being merged into the agent
 * findings. They come from a rule engine, not a model - collapsing the two
 * would hide which is which, and only one of them can hallucinate.
 */
function sonarBlock(sonar: SonarReport | undefined): string {
  if (!sonar) return "";
  if (sonar.ran.length === 0 && sonar.failed.length === 0) return "";

  const lines: string[] = ["### Static analysis (SonarQube)", ""];

  if (sonar.issues.length === 0) {
    lines.push(`Scans run: ${sonar.ran.join(", ") || "none"}. No issues reported.`);
  } else {
    const byScan: Record<string, number> = {};
    for (const i of sonar.issues) byScan[i.scan] = (byScan[i.scan] ?? 0) + 1;
    const tally = Object.entries(byScan)
      .map(([s, n]) => `**${n}** ${s}`)
      .join(" · ");
    lines.push(tally, "", "<details><summary>Show findings</summary>", "");

    for (const i of sonar.issues.slice(0, 50)) {
      const loc = i.line ? `${i.path}:${i.line}` : i.path;
      const where = loc ? "`" + loc + "`" : "_project_";
      lines.push(`- ${where} **${i.severity}** ${i.message} <sub>${i.rule}</sub>`);
    }
    if (sonar.issues.length > 50) {
      lines.push(`- _...and ${sonar.issues.length - 50} more_`);
    }
    lines.push("", "</details>");
  }

  if (sonar.failed.length > 0) {
    const which = sonar.failed.map((f) => "`" + f.scan + "` (" + f.reason + ")").join(", ");
    lines.push("", `> ⚠️ ${which} did not run, so that check is missing from this review.`);
  }
  return lines.join("\n");
}

export async function postReview(
  octokit: Octokit,
  pr: PullRequest,
  result: ReviewResult,
  requestChangesOnCritical: boolean,
): Promise<{ url: string; event: string }> {
  const comments = result.findings
    .filter((f) => f.inline)
    .map((f) => ({ path: f.file, line: f.line, side: "RIGHT" as const, body: commentBody(f) }));

  const hasCritical = result.findings.some((f) => f.severity === "critical");
  const event =
    requestChangesOnCritical && hasCritical ? ("REQUEST_CHANGES" as const) : ("COMMENT" as const);

  const payload = {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
    commit_id: pr.headSha,
    body: summaryBody(result, pr),
    event,
    comments,
  };

  try {
    const res = await octokit.pulls.createReview(payload);
    return { url: res.data.html_url, event };
  } catch (err) {
    // Two things fail here in practice, and both are recoverable:
    //  - REQUEST_CHANGES on your own PR is rejected by GitHub (422)
    //  - a line slipped through that GitHub does not consider part of the diff,
    //    which rejects the entire review rather than the one comment
    // Retrying without inline comments still delivers the findings via the summary.
    const status = (err as { status?: number }).status;
    if (status !== 422) throw err;

    const res = await octokit.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      commit_id: pr.headSha,
      body: [
        summaryBody(result, pr),
        "",
        "---",
        "",
        "_Inline comments could not be posted, so all findings are listed below._",
        "",
        ...result.findings.map(
          (f) =>
            `- ${EMOJI[f.severity]} \`${f.file}:${f.line}\` **${f.title}** — ${f.detail}\n\n  _Fix:_ ${f.suggestion}`,
        ),
      ].join("\n"),
      event: "COMMENT" as const,
    });
    return { url: res.data.html_url, event: "COMMENT (fallback)" };
  }
}
