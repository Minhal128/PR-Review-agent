import fs from "node:fs";
import { DEFAULT_CONFIG, run, type Config } from "./run.ts";

const USAGE = `
pr-reviewer - multi-agent pull request review

Usage
  pr-reviewer --repo <owner/name> --pr <number> [options]

Options
  --repo <owner/name>   Repository. Defaults to GITHUB_REPOSITORY.
  --pr <number>         Pull request number. Defaults to PR_NUMBER.
  --config <path>       JSON config file. Defaults to ./reviewers.config.json if present.
  --effort <level>      low | medium | high | xhigh | max   (default high)
  --agents <list>       Comma-separated subset, e.g. security,correctness
  --min-confidence <n>  0-1, drop findings below this (default 0.6)
  --max-comments <n>    Inline comment cap (default 15)
  --dry-run             Print the review instead of posting it
  --json                Print the raw result as JSON (implies --dry-run)
  -h, --help

Environment
  ANTHROPIC_API_KEY     required
  GITHUB_TOKEN          required
`;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--") && a !== "-h") continue;
    const key = a === "-h" ? "help" : a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function loadConfig(path: string | undefined): Config {
  const file = path ?? "reviewers.config.json";
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (err) {
    throw new Error(`could not read config ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const repoArg = (args.repo as string) ?? process.env.GITHUB_REPOSITORY;
  const prArg = (args.pr as string) ?? process.env.PR_NUMBER;

  if (!repoArg || !prArg) {
    console.error("error: --repo and --pr are required (or set GITHUB_REPOSITORY and PR_NUMBER)");
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }

  const [owner, repo] = repoArg.split("/");
  if (!owner || !repo) {
    console.error(`error: --repo must be owner/name, got "${repoArg}"`);
    process.exitCode = 2;
    return;
  }

  const number = Number(prArg);
  if (!Number.isInteger(number) || number <= 0) {
    console.error(`error: --pr must be a positive integer, got "${prArg}"`);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig(args.config as string | undefined);
  if (args.effort) config.effort = args.effort as Config["effort"];
  if (args["min-confidence"]) config.minConfidence = Number(args["min-confidence"]);
  if (args["max-comments"]) config.maxComments = Number(args["max-comments"]);
  if (args.agents) config.agents = (args.agents as string).split(",").map((s) => s.trim());

  const json = Boolean(args.json);
  const dryRun = Boolean(args["dry-run"]) || json;

  const outcome = await run({
    owner,
    repo,
    number,
    config,
    dryRun,
    log: json ? undefined : (m) => console.error(m),
  });

  if (json) {
    console.log(JSON.stringify(outcome.result, null, 2));
    return;
  }

  if (dryRun) {
    console.log("");
    console.log(outcome.markdown);
    console.log("");
    for (const f of outcome.result.findings) {
      const where = f.inline ? "inline" : "summary only";
      console.log(`--- ${f.file}:${f.line}  [${f.severity}] (${where})`);
      console.log(`    ${f.title}`);
      console.log(`    ${f.detail}`);
      console.log(`    fix: ${f.suggestion}`);
    }
  }

  // A critical finding fails the job so the check turns red on the PR.
  if (outcome.result.findings.some((f) => f.severity === "critical")) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
