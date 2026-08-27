# pr-reviewer

Multi-agent pull request reviewer. Four specialist agents read the diff in parallel, each
responsible for one concern, and their findings are confidence-gated and deduplicated before
anything is posted to the PR.

Built following the architecture in [freeCodeCamp's multi-agent PR reviewer course](https://www.freecodecamp.org/news/learn-system-design-for-ai-agents-build-a-production-ready-multi-agent-pr-reviewer/),
with the delivery layer swapped for GitHub Actions — see [Deviations](#deviations-from-the-article)
below for what changed and why.

## How it works

```
PR opened / pushed
        │
        ▼
GitHub Actions  ──► webhook delivery, HMAC, queueing, idempotency, hosting
        │
        ▼
   fetch diff  ──► parse hunks, map added lines, drop ignored/binary/deleted files
        │
        ▼
   ┌────┴────┬──────────┬────────┐
security  correctness  tests   docs      ← four agents, concurrent, one API call each
   └────┬────┴──────────┴────────┘
        ▼
  aggregate  ──► confidence gate → dedupe → severity sort → comment cap
        │
        ▼
  post review ──► inline comments on changed lines + summary
```

Each agent gets a narrow brief and is explicitly told that returning nothing is a correct
answer. A single generalist reviewer drifts toward whatever is easiest to say — naming and
formatting — because it feels obliged to produce output. Four narrow agents cannot: style is
not in the security agent's brief, so it has nothing to pad with.

## Setup

```bash
npm install
cp .env.example .env      # fill in ANTHROPIC_API_KEY and GITHUB_TOKEN
npm test                  # self-check, no API calls, no network
```

Try it against a real PR without posting anything:

```bash
npm run review -- --repo owner/name --pr 42 --dry-run
```

## Running it on your repos

1. Push this project to GitHub as `<you>/pr-reviewer`.
2. Add `ANTHROPIC_API_KEY` to the target repo: **Settings → Secrets and variables → Actions**.
3. Copy `.github/workflows/pr-review.yml` into the target repo.
4. Edit the `repository:` field in that workflow to point at your `pr-reviewer` repo.

`GITHUB_TOKEN` is provided by Actions automatically — you do not create one.

## Configuration

`reviewers.config.json`, or CLI flags which override it:

| Key | Default | What it does |
|---|---|---|
| `effort` | `high` | Model reasoning depth: `low` … `max`. Cost scales with it. |
| `minConfidence` | `0.6` | Findings below this are dropped. |
| `minConfidenceCritical` | `0.4` | Lower bar for `critical` — a missed critical costs more than one false positive. |
| `minSeverity` | `minor` | `nit` findings are dropped by default. |
| `maxComments` | `15` | Inline comment cap. Overflow is demoted to the summary, never discarded. |
| `maxFiles` | `60` | Skip review past this many changed files. |
| `requestChangesOnCritical` | `false` | Post `REQUEST_CHANGES` instead of `COMMENT` when a critical is found. |
| `ignore` | lockfiles, snapshots, `dist/**`… | Glob patterns to skip. |

```bash
npm run review -- --repo o/n --pr 42 --agents security,correctness --effort max
npm run review -- --repo o/n --pr 42 --json > findings.json
```

## Design decisions worth knowing

**Line mapping is the fragile part.** GitHub rejects a review comment on a line that is not
part of the diff, and one bad line rejects *the entire review*, not just that comment. So the
diff parser tracks exactly which new-file line numbers the PR touched, and any finding anchored
elsewhere is demoted to the summary instead of posted inline. `npm test` covers this.

**Failures degrade, they do not cascade.** One agent hitting a rate limit or declining does not
take the review down — the other three still report, and the summary says which area went
unreviewed. Silently returning three-quarters of a review as if it were whole would be worse
than saying so.

**Confidence is asymmetric on purpose.** Criticals clear a lower bar (0.4) than everything else
(0.6). A false-positive critical wastes a few minutes; a missed one ships.

**Duplicates collapse.** Two agents often notice the same defect from different angles. Findings
at the same `file:line` with overlapping titles collapse to the most severe version.

## Deviations from the article

| Article | Here | Why |
|---|---|---|
| Self-hosted webhook server, HMAC verification, Redis queue, idempotency keys | GitHub Actions | Actions already provides every one of these, free and hosted. Rebuilding them buys nothing for repos you own. |
| LangGraph orchestration | `Promise.all` | The graph is a single fan-out into one aggregation step. That is four lines of TypeScript; a framework would be the larger dependency. |
| Tiger Cloud / pgvector semantic code search | Diff only | The diff plus its context lines is what a reviewer reads. Retrieval across the repo is worth adding when findings start needing whole-repo knowledge — measure that first rather than assuming it. |
| Token economics dashboard | Token counts in the PR summary | Same number, no service to run. |

If you later want cross-file reasoning — "this change breaks a caller three directories away" —
that is the point where the retrieval layer earns its cost. It does not before.

## Cost

Four `claude-opus-5` calls per PR, one per agent, each reading the whole reviewable diff. A
small PR runs a few cents; drop `effort` to `medium` or trim `agents` to bring it down. Token
usage is printed in every PR summary so the real number is visible rather than estimated.

## Limitations

- **Fork PRs are skipped.** The workflow uses `pull_request`, which does not expose secrets to
  forks. Reviewing them needs `pull_request_target`, which runs a write-scoped token against
  untrusted code — not a safe default.
- **No repo-wide context.** The agents see the diff, not the codebase.
- **Non-determinism.** Two runs on the same diff may not produce identical findings. The
  confidence gate reduces the spread; it does not remove it.
