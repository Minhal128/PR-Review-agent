import { z } from "zod";

/** A single reviewable change to one file, already reduced to what an agent needs. */
export interface FileDiff {
  path: string;
  /** true when the file was added in this PR */
  isNew: boolean;
  /** true when the file was deleted; deleted files are not reviewed */
  isDeleted: boolean;
  /** true for binary / unparseable payloads; skipped */
  isBinary: boolean;
  /** Raw hunk text, exactly as GitHub emitted it. This is what the model reads. */
  patch: string;
  /**
   * Line numbers in the NEW file that this PR added or changed.
   * GitHub only accepts inline comments on these lines, so findings
   * anchored anywhere else get demoted to the summary instead.
   */
  commentableLines: Set<number>;
}

export const SEVERITIES = ["critical", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What one specialist agent reports. Kept flat so the model fills it reliably. */
export const FindingSchema = z.object({
  file: z.string().describe("Repo-relative path, exactly as it appears in the diff"),
  line: z
    .number()
    .int()
    .describe("Line number in the NEW version of the file that the finding refers to"),
  severity: z
    .enum(SEVERITIES)
    .describe(
      "critical = data loss, security hole, or broken build. major = real bug users would hit. minor = smaller correctness or clarity problem. nit = style preference",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How sure you are this is a real problem in THIS diff, 0 to 1. Below 0.5 means you are guessing - say so honestly rather than inflating",
    ),
  title: z.string().describe("One short line naming the problem, under 80 characters"),
  detail: z.string().describe("Two or three sentences: what breaks, and under what input or condition"),
  suggestion: z
    .string()
    .describe("The concrete fix. If you can express it as replacement code, give only the replacement lines"),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingsSchema = z.object({
  findings: z.array(FindingSchema),
});

/** A finding once it has been through aggregation. */
export interface ReviewedFinding extends Finding {
  /** which specialist raised it */
  agent: string;
  /** true when the line is inline-commentable on GitHub */
  inline: boolean;
}

export interface AgentUsage {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  failed?: string;
}

/** One normalized SonarQube finding, from any of the three scans. */
export interface SonarIssue {
  scan: "code" | "secrets" | "dependencies";
  rule: string;
  severity: string;
  type: string;
  path: string;
  line: number | null;
  message: string;
}

export interface SonarReport {
  issues: SonarIssue[];
  ran: ("code" | "secrets" | "dependencies")[];
  failed: { scan: "code" | "secrets" | "dependencies"; reason: string }[];
}

export interface ReviewResult {
  findings: ReviewedFinding[];
  /** raised by an agent but dropped below the confidence threshold */
  suppressed: number;
  usage: AgentUsage[];
  sonar?: SonarReport;
}
