import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SonarIssue, SonarReport } from "./types.ts";

const run = promisify(execFile);

/** Scans that run before the agents. Each is independent; one failing does not stop the rest. */
export type SonarScan = "code" | "secrets" | "dependencies";

export interface SonarOptions {
  enabled: boolean;
  /** SonarCloud / SonarQube project key. Required for the code scan. */
  projectKey?: string;
  /** Base ref the PR targets - the code scan only looks at what changed against it. */
  baseRef: string;
  scans: SonarScan[];
  /** STANDARD is per-file; DEEP follows calls across files. */
  depth: "STANDARD" | "DEEP";
  /** Give up on a scan after this long rather than holding the whole review. */
  timeoutMs: number;
}

export const DEFAULT_SONAR: Omit<SonarOptions, "baseRef"> = {
  enabled: true,
  scans: ["code", "secrets", "dependencies"],
  depth: "DEEP",
  timeoutMs: 10 * 60_000,
};

async function sonar(args: string[], timeoutMs: number): Promise<unknown> {
  // The CLI prints warnings on stdout above the JSON body, so take everything
  // from the first brace rather than parsing the whole stream.
  const { stdout } = await run("sonar", args, {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`no JSON in output of: sonar ${args.join(" ")}`);
  return JSON.parse(stdout.slice(start));
}

/**
 * The CLI's JSON shape varies by subcommand and version, and the populated
 * forms could not be observed against a project with live issues. So every
 * reader below probes the plausible locations and skips anything it does not
 * recognise, rather than assuming one schema and throwing on a real PR.
 */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}

function normalizeIssue(raw: unknown, scan: SonarScan): SonarIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // `component` arrives as "projectKey:src/file.ts"; the path is what we need.
  const rawPath = str(pick(o, ["filePath", "path", "file", "component"]));
  const path = rawPath.includes(":") ? rawPath.slice(rawPath.lastIndexOf(":") + 1) : rawPath;

  const range = o["textRange"];
  const lineFromRange =
    range && typeof range === "object"
      ? (range as Record<string, unknown>)["startLine"]
      : undefined;
  const lineRaw = pick(o, ["line", "startLine"]) ?? lineFromRange;
  const line = typeof lineRaw === "number" ? lineRaw : Number(lineRaw);

  const message = str(pick(o, ["message", "title", "description", "ruleName"]));
  if (!path && !message) return null;

  return {
    scan,
    rule: str(pick(o, ["rule", "ruleKey", "ruleId", "id"]), "unknown"),
    severity: str(pick(o, ["severity", "impact", "riskSeverity"]), "UNKNOWN").toUpperCase(),
    type: str(pick(o, ["type", "issueType", "category"]), scan.toUpperCase()),
    path,
    line: Number.isFinite(line) && line > 0 ? line : null,
    message,
  };
}

/**
 * Pull issue arrays out of whatever wrapper the subcommand used.
 * Exported so `selfcheck.ts` can pin the shapes without invoking the CLI.
 */
export function collect(payload: unknown, scan: SonarScan): SonarIssue[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;

  const buckets: unknown[] = [
    root["issues"],
    root["findings"],
    root["results"],
    root["dependencyRisks"],
    root["risks"],
  ];
  for (const key of ["secrets", "agentic", "code", "analysis"]) {
    const nested = root[key];
    if (nested && typeof nested === "object") {
      const n = nested as Record<string, unknown>;
      buckets.push(n["issues"], n["findings"], n["results"]);
    }
  }

  const out: SonarIssue[] = [];
  for (const bucket of buckets) {
    for (const raw of asArray(bucket)) {
      const issue = normalizeIssue(raw, scan);
      if (issue) out.push(issue);
    }
  }
  return out;
}

export async function runSonar(
  opts: SonarOptions,
  log: (msg: string) => void = () => {},
): Promise<SonarReport> {
  if (!opts.enabled) return { issues: [], ran: [], failed: [] };

  const issues: SonarIssue[] = [];
  const ran: SonarScan[] = [];
  const failed: { scan: SonarScan; reason: string }[] = [];

  const jobs: { scan: SonarScan; args: string[] }[] = [];

  if (opts.scans.includes("code")) {
    const args = ["analyze", "--base", opts.baseRef, "--depth", opts.depth, "--format", "json", "--force"];
    if (opts.projectKey) args.push("--project", opts.projectKey);
    jobs.push({ scan: "code", args });
  }
  if (opts.scans.includes("secrets")) {
    jobs.push({ scan: "secrets", args: ["analyze", "secrets", "--format", "json"] });
  }
  if (opts.scans.includes("dependencies")) {
    jobs.push({ scan: "dependencies", args: ["analyze", "dependency-risks", "--format", "json"] });
  }

  // Sequential on purpose: the scans share a local analysis cache and one
  // SonarCloud rate limit, so racing them buys little and fails noisily.
  for (const job of jobs) {
    try {
      log(`  sonar ${job.scan}...`);
      const found = collect(await sonar(job.args, opts.timeoutMs), job.scan);
      issues.push(...found);
      ran.push(job.scan);
      log(`    ${found.length} issue(s)`);
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      failed.push({ scan: job.scan, reason });
      log(`    failed: ${reason}`);
    }
  }

  return { issues, ran, failed };
}

/**
 * Rendered into every agent's prompt. The point is subtractive: an agent that
 * re-reports a rule Sonar already caught is spending a review comment on
 * something the PR author can already see in the Sonar check.
 */
export function sonarContext(report: SonarReport): string {
  if (report.issues.length === 0) {
    if (report.ran.length === 0) return "";
    return [
      "",
      "Static analysis (SonarQube) ran on this PR and reported nothing.",
      "Do not report anything a static analyser would catch - it already looked.",
      "Spend your attention on intent, logic, and things a rule engine cannot see.",
    ].join("\n");
  }

  const lines = [
    "",
    "SonarQube already analysed this PR and reported the findings below.",
    "Do NOT repeat any of them, and do not report near-duplicates. They are already",
    "visible to the author. Your value is what static analysis cannot see: wrong",
    "intent, broken logic across functions, missing cases, absent tests.",
    "",
  ];
  for (const i of report.issues.slice(0, 100)) {
    const where = i.line ? `${i.path}:${i.line}` : i.path || "(project)";
    lines.push(`- [${i.scan}/${i.severity}] ${where} ${i.rule} - ${i.message}`);
  }
  if (report.issues.length > 100) {
    lines.push(`- ...and ${report.issues.length - 100} more`);
  }
  return lines.join("\n");
}
