/**
 * Self-check for the two pieces with real logic: the diff line-mapper and the
 * aggregator. Run with `npm test`. No framework - if it exits 0, they work.
 *
 * The line mapping is what matters most: an off-by-one here means every inline
 * comment lands on the wrong line, and GitHub rejects the whole review if a
 * line is not part of the diff.
 */
import assert from "node:assert/strict";
import type { AgentRun } from "./agents.ts";
import { aggregate } from "./aggregate.ts";
import { globMatch, parseDiff, reviewable } from "./diff.ts";
import type { Finding } from "./types.ts";

const SAMPLE = [
  "diff --git a/src/math.ts b/src/math.ts",
  "index 1111111..2222222 100644",
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -1,6 +1,7 @@",
  " export function mean(xs: number[]) {",
  "-  return xs.reduce((a, b) => a + b) / xs.length;",
  "+  if (xs.length === 0) return 0;",
  "+  return xs.reduce((a, b) => a + b, 0) / xs.length;",
  " }",
  " ",
  " export const VERSION = 1;",
  "diff --git a/logo.png b/logo.png",
  "new file mode 100644",
  "index 0000000..3333333",
  "Binary files /dev/null and b/logo.png differ",
  "diff --git a/old.ts b/old.ts",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/old.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-const gone = true;",
  "-export default gone;",
  "diff --git a/package-lock.json b/package-lock.json",
  "index 5555555..6666666 100644",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1,1 +1,2 @@",
  ' {"lockfileVersion": 3}',
  '+{"noise": true}',
].join("\n");

// --- diff parsing -----------------------------------------------------------

const files = parseDiff(SAMPLE);
assert.equal(files.length, 4, "should find four file entries");

const math = files.find((f) => f.path === "src/math.ts")!;
assert.ok(math, "src/math.ts parsed");

// Hunk starts at new-file line 1:
//   1  " export function mean"   context -> line 1
//   -  removed                   does not advance
//   2  "+  if (xs.length..."      added   -> line 2
//   3  "+  return xs.reduce..."   added   -> line 3
assert.deepEqual([...math.commentableLines].sort((a, b) => a - b), [2, 3], "added lines are 2 and 3");
assert.equal(math.isNew, false);
assert.equal(math.isDeleted, false);

const png = files.find((f) => f.path === "logo.png")!;
assert.equal(png.isBinary, true, "binary file detected");

const old = files.find((f) => f.path === "old.ts")!;
assert.equal(old.isDeleted, true, "deleted file detected");
assert.equal(old.commentableLines.size, 0, "deleted file has no commentable lines");

// --- ignore filtering -------------------------------------------------------

assert.ok(globMatch("**/package-lock.json", "package-lock.json"), "leading ** matches root");
assert.ok(globMatch("**/package-lock.json", "a/b/package-lock.json"), "leading ** matches nested");
assert.ok(globMatch("dist/**", "dist/app.js"), "trailing ** matches");
assert.ok(!globMatch("dist/**", "src/app.js"), "unrelated path not matched");
assert.ok(!globMatch("**/*.min.js", "src/app.js"), "extension glob is not over-eager");

const keep = reviewable(files, ["**/package-lock.json"]);
assert.deepEqual(keep.map((f) => f.path), ["src/math.ts"], "binary, deleted and ignored are dropped");

// --- aggregation ------------------------------------------------------------

const finding = (over: Partial<Finding>): Finding => ({
  file: "src/math.ts",
  line: 2,
  severity: "major",
  confidence: 0.9,
  title: "Empty array returns zero instead of NaN",
  detail: "d",
  suggestion: "s",
  ...over,
});

const runs: AgentRun[] = [
  {
    agent: "correctness",
    findings: [
      finding({}),
      finding({ line: 3, severity: "nit", title: "Prefer const here", confidence: 0.95 }),
      finding({ line: 2, confidence: 0.2, title: "Might overflow on huge inputs" }),
      finding({ file: "does/not/exist.ts", line: 1, title: "Hallucinated file" }),
      finding({ line: 999, severity: "critical", confidence: 0.8, title: "Off diff line" }),
    ],
    usage: { agent: "correctness", inputTokens: 10, outputTokens: 5, ms: 100 },
  },
  {
    agent: "security",
    findings: [
      // near-duplicate of the correctness finding at the same line
      finding({ severity: "critical", confidence: 0.7, title: "Empty array returns zero not NaN" }),
    ],
    usage: { agent: "security", inputTokens: 10, outputTokens: 5, ms: 200 },
  },
];

const result = aggregate(runs, keep, {
  minConfidence: 0.6,
  minConfidenceCritical: 0.4,
  maxComments: 15,
  minSeverity: "minor",
});

const titles = result.findings.map((f) => f.title);
assert.ok(!titles.includes("Hallucinated file"), "file outside the diff is dropped");
assert.ok(!titles.includes("Might overflow on huge inputs"), "low confidence is dropped");
assert.ok(!titles.includes("Prefer const here"), "nit is below minSeverity=minor");

const dup = result.findings.filter((f) => f.title.toLowerCase().includes("empty array"));
assert.equal(dup.length, 1, "near-duplicates at the same line collapse to one");
assert.equal(dup[0]!.severity, "critical", "the more severe version survives");

const offDiff = result.findings.find((f) => f.line === 999)!;
assert.ok(offDiff, "off-diff finding is kept, not dropped");
assert.equal(offDiff.inline, false, "off-diff finding is demoted to summary only");

assert.equal(result.findings[0]!.severity, "critical", "sorted most severe first");

// comment cap demotes the overflow to summary rather than discarding it
const capped = aggregate(runs, keep, {
  minConfidence: 0.6,
  minConfidenceCritical: 0.4,
  maxComments: 0,
  minSeverity: "minor",
});
assert.ok(capped.findings.length > 0, "cap does not delete findings");
assert.ok(capped.findings.every((f) => !f.inline), "cap demotes every finding to summary");

console.log(`ok - ${files.length} files parsed, ${result.findings.length} findings after aggregation`);
