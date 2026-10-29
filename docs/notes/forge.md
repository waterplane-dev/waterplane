# The forge seam

Everything the host asks of the remote's hosting service goes through one small interface,
`Forge` (`packages/host/src/forge/types.ts`). GitHub (`forge/github.ts`, the `gh` CLI) is the only
implementation. A GitLab one is **not built** — this note is the design for whoever contributes it.

## Why a seam

P1–P5 of the branch & PR workflow each grew a handful of `gh` calls (rules, push-and-open-PR,
the PR card, the `local-ci` status). Left in four modules, a second forge would mean editing all of
them and re-learning each one's timeouts. Now `forge/github.ts` is the ONLY file under
`packages/host/src` that spawns `gh` for these features (`protectmain.ts`, owner tooling, is the
other); `tools/forgeseam.test.mjs` fails on a new one.

## The interface

- `rules()` — RAW JSON of the default branch's rules (`{ rules, classic, repo }`); `branchrules.ts`
  feeds it to the pure `classifyBranchRules` in shared. Undefined = absent = behave as direct.
- `defaultBranch()`, `existingPr()`, `openPr({head, base}?)` — the push-and-open-PR flow (`prpush.ts`).
- `listPrs()` — RAW JSON, classified by shared's `prViewsFrom`; `prState(n)`, `prInfo(n)`.
- `merge(n, method)`, `autoMerge(n, on, method?)`, `close(n)` — one explicit tap each.
- `checksLog(runId)` — the failing-step log text.
- `postStatus(sha, description)` — the `local-ci` success status.

The raw-vs-classified split is deliberate: the shared classifiers stay pure and are what the phone
and host agree on. Methods whose failure the caller words for a person THROW the raw exec error (the
caller reads `stderr`); methods whose failure means "absent" return undefined. Per-call timeouts and
buffers live in `github.ts` and differ on purpose (rules reads 8 s, a merge 60 s).

`forgeFor(wt)` returns the forge for the worktree's origin (`ghOfRemote`) or undefined, which every
caller treats as absent. `forgeOrGh(wt)` is for the user-initiated PR flow, which has always let `gh`
resolve the repo itself. `setForge(f | null)` is the test seam; the fake-`gh`-on-PATH tests in
`packages/host/test/{prpush,prs,branchrules}.test.mjs` exercise the real GitHub forge.

## How a GitLab plugin would contribute one (not built)

`glab`, merge requests. A plugin would register a `Forge` for origins its `forgeFor` recognises. The
mapping, and where it is not one-to-one:

- Merge requests for PRs; `glab mr create --fill --source-branch --target-branch`, `glab mr merge`,
  `--auto-merge`/`--when-pipeline-succeeds` for auto-merge, `glab mr close`.
- Approvals are not reviews: GitHub's `reviewDecision` becomes "approvals left" — map it into the same
  raw shape so `prViewsFrom` need not learn a second vocabulary, or give shared a second classifier.
- Pipelines are not checks: `statusCheckRollup` becomes the pipeline's jobs; `checksLog` is
  `glab ci trace <job>` (a job id, not an Actions run id — `actionsRunId` is GitHub-shaped).
- Rules: `glab api projects/:id/protected_branches/:branch` plus project merge settings, mapped into the
  inputs of `classifyBranchRules` (or a sibling classifier).
- Status: `glab api projects/:id/statuses/:sha` with `state=success&name=local-ci`.

Open question for the contributor: the plugin contract (`shared/plugin.ts`) has no forge capability
yet; adding one is the first step, and it must keep "nothing answers a box without a tap".
