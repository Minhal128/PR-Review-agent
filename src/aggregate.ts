import type { AgentRun } from "./agents.ts";
import type { FileDiff, ReviewedFinding, ReviewResult, Severity } from "./types.ts";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2, nit: 3 };

export interface AggregateOptions {
  /** findings below this confidence are dropped */
  minConfidence: number;
  /**
   * Critical findings clear a lower bar. A missed critical costs far more than
   * one false positive, so the asymmetry is deliberate.
   */
  minConfidenceCritical: number;
  /** never post more than this many inline comments in one review */
  maxComments: number;
  /** severities at or below this rank are dropped entirely */
  minSeverity: Severity;
}

export function aggregate(
  runs: AgentRun[],
  files: FileDiff[],
  opts: AggregateOptions,
): ReviewResult {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const kept: ReviewedFinding[] = [];
  let suppressed = 0;

  for (const run of runs) {
    for (const f of run.findings) {
      const file = byPath.get(f.file);

      // The model named a file that is not in this diff. It is reasoning about
      // something it cannot see, so the finding is not trustworthy.
      if (!file) {
        suppressed++;
        continue;
      }

      const bar = f.severity === "critical" ? opts.minConfidenceCritical : opts.minConfidence;
      if (f.confidence < bar) {
        suppressed++;
        continue;
      }

      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[opts.minSeverity]) {
        suppressed++;
        continue;
      }

      kept.push({ ...f, agent: run.agent, inline: file.commentableLines.has(f.line) });
    }
  }

  const deduped = dedupe(kept);

  deduped.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    return b.confidence - a.confidence;
  });

  // Trim to the comment cap, but only count inline comments against it -
  // summary-only findings cost nothing extra in the PR conversation.
  const final: ReviewedFinding[] = [];
  let inlineCount = 0;
  for (const f of deduped) {
    if (f.inline) {
      if (inlineCount >= opts.maxComments) {
        final.push({ ...f, inline: false });
        continue;
      }
      inlineCount++;
    }
    final.push(f);
  }

  return {
    findings: final,
    suppressed: suppressed + (deduped.length < kept.length ? kept.length - deduped.length : 0),
    usage: runs.map((r) => r.usage),
  };
}

/**
 * Two specialists often notice the same defect from different angles - the
 * security agent and the correctness agent both flag an unchecked index, say.
 * Posting it twice makes the review look careless, so near-duplicates at the
 * same location collapse to the most severe version.
 */
function dedupe(findings: ReviewedFinding[]): ReviewedFinding[] {
  const groups = new Map<string, ReviewedFinding[]>();
  for (const f of findings) {
    const key = `${f.file}:${f.line}`;
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }

  const out: ReviewedFinding[] = [];
  for (const group of groups.values()) {
    const survivors: ReviewedFinding[] = [];
    for (const f of group) {
      const twin = survivors.findIndex((s) => similar(s.title, f.title));
      if (twin === -1) {
        survivors.push(f);
        continue;
      }
      const existing = survivors[twin]!;
      if (better(f, existing)) survivors[twin] = f;
    }
    out.push(...survivors);
  }
  return out;
}

function better(a: ReviewedFinding, b: ReviewedFinding): boolean {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (s !== 0) return s < 0;
  return a.confidence > b.confidence;
}

/** Jaccard overlap on lowercased words, ignoring very short tokens. */
export function similar(a: string, b: string, threshold = 0.5): boolean {
  const wordsOf = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    );
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (wa.size === 0 || wb.size === 0) return false;

  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const union = wa.size + wb.size - shared;
  return union > 0 && shared / union >= threshold;
}
