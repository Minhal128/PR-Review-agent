import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { runAgents } from "./agents.ts";
import { aggregate, type AggregateOptions } from "./aggregate.ts";
import { parseDiff, reviewable } from "./diff.ts";
import { fetchPullRequest, postReview, summaryBody, type PullRequest } from "./github.ts";
import { DEFAULT_SONAR, runSonar, sonarContext, type SonarOptions } from "./sonar.ts";
import type { ReviewResult, Severity } from "./types.ts";

export interface Config extends AggregateOptions {
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  ignore: string[];
  agents?: string[];
  requestChangesOnCritical: boolean;
  /** skip review entirely past this many changed files - a 400-file PR is not reviewable */
  maxFiles: number;
  /** SonarQube runs before the agents; baseRef is filled in from the PR */
  sonar: Omit<SonarOptions, "baseRef">;
}

export const DEFAULT_CONFIG: Config = {
  effort: "high",
  minConfidence: 0.6,
  minConfidenceCritical: 0.4,
  maxComments: 15,
  minSeverity: "minor" as Severity,
  ignore: [
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/*.snap",
    "**/*.min.js",
    "**/*.svg",
    "dist/**",
    "build/**",
    "**/__generated__/**",
  ],
  requestChangesOnCritical: false,
  maxFiles: 60,
  sonar: DEFAULT_SONAR,
};

export interface RunOptions {
  owner: string;
  repo: string;
  number: number;
  config: Config;
  dryRun: boolean;
  log?: (msg: string) => void;
}

export interface RunOutcome {
  pr: PullRequest;
  result: ReviewResult;
  reviewUrl?: string;
  event?: string;
  skipped?: string;
  markdown: string;
}

export async function run(opts: RunOptions): Promise<RunOutcome> {
  const log = opts.log ?? (() => {});
  const { owner, repo, number, config } = opts;

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) throw new Error("GITHUB_TOKEN is not set");

  const octokit = new Octokit({ auth: githubToken });
  const anthropic = new Anthropic();

  log(`fetching ${owner}/${repo}#${number}`);
  const pr = await fetchPullRequest(octokit, owner, repo, number);

  const parsed = parseDiff(pr.diff);
  const files = reviewable(parsed, config.ignore);
  log(`${parsed.length} files in diff, ${files.length} reviewable`);

  const empty: ReviewResult = { findings: [], suppressed: 0, usage: [] };

  if (files.length === 0) {
    const skipped = "nothing reviewable in this diff (only ignored, deleted, or binary files)";
    log(skipped);
    return { pr, result: empty, skipped, markdown: summaryBody(empty, pr) };
  }
  if (files.length > config.maxFiles) {
    const skipped = `${files.length} changed files exceeds maxFiles=${config.maxFiles}; split the PR`;
    log(skipped);
    return { pr, result: empty, skipped, markdown: summaryBody(empty, pr) };
  }

  // Static analysis first. It is deterministic, exhaustive and cheap, so it
  // should claim everything it can before any token is spent - and the agents
  // are then told not to repeat it.
  let sonarReport;
  if (config.sonar.enabled) {
    log("running sonar scans");
    sonarReport = await runSonar({ ...config.sonar, baseRef: pr.baseRef }, log);
    log(`sonar: ${sonarReport.issues.length} issue(s) from [${sonarReport.ran.join(", ") || "none"}]`);
  }

  const prContext = [
    `Pull request: ${pr.title}`,
    pr.body ? `\nDescription:\n${pr.body}` : "",
    `\nAuthor: ${pr.author}`,
  ].join("\n");

  log(`running agents (effort=${config.effort})`);
  const runs = await runAgents(
    anthropic,
    files,
    prContext,
    config.effort,
    sonarReport ? sonarContext(sonarReport) : "",
    config.agents,
  );
  for (const r of runs) {
    log(
      `  ${r.agent}: ${r.findings.length} raw finding(s) in ${(r.usage.ms / 1000).toFixed(1)}s${r.usage.failed ? ` [${r.usage.failed}]` : ""}`,
    );
  }

  const result = { ...aggregate(runs, files, config), sonar: sonarReport };
  log(`${result.findings.length} kept, ${result.suppressed} suppressed`);

  const markdown = summaryBody(result, pr);

  if (opts.dryRun) {
    log("dry run - not posting to GitHub");
    return { pr, result, markdown };
  }

  const posted = await postReview(octokit, pr, result, config.requestChangesOnCritical);
  log(`posted ${posted.event} review: ${posted.url}`);
  return { pr, result, reviewUrl: posted.url, event: posted.event, markdown };
}
