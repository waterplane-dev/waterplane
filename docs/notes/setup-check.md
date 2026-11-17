# Setup check: the findings engine

One ranked list of what could be better about how an agent is set up, on the phone (Setup check
sheet), in VS Code (Findings tree node and tab) and in the terminal (`setup-check [dir] [--json]`).
All three run the same rules over the same `Finding` type; only the collectors differ.

## Shape

- **`shared/src/findings/`** holds the whole engine and no I/O. `types.ts` (Finding, FindingRemedy,
  EvidenceRoute, PassedCheck, NotChecked, FindingsResult), `rank.ts` (priced saving, then tokens;
  there is no composite score), `cut.ts` (the scope/repo/weight cut and the evidence cut),
  `saving.ts` (`weekSavingOf`), `words.ts` and `rules/` (`repoRules`, `machineRules`,
  `accountRules`, each taking one plain `FindingFacts`).
- **Every findings view has a checked-off list.** A result is `{findings, passed, notChecked}`. A rule
  that ran clean is a passed row; a rule whose fact is absent is a "not checked: <reason>" row, never
  a pass. A waived finding moves to the passed list as "waived: <reason>". So the page is never empty
  and "nothing found" is distinguishable from "nothing looked at" (R-metrics-091).
- **Scopes:** this repo, this machine, account. A machine finding is shown once, never per repo.
- **Saving** is per week at list price with tokens beside it, worded by the billing profile. It is
  absent where it cannot be priced and never estimated from nothing; a character-based saving is
  labelled an estimate.
- **Backends:** a finding names the backends it read; one it could not read is named as not read.

## Collecting (host)

`host/src/setupcheck/`: `readers.ts` (fs-injected), `collect.ts` (`CollectDeps`, every source wrapped
so a throw becomes an absent fact, `runSetupCheck`, `foldContributed`), `store.ts` (answers the last
document at once, re-runs when stale, `pending` on a first sweep). Routes: `GET /api/setupcheck` and
`POST /api/setupcheck/waive`. Machine and account waives live in `setupprefs.ts`; repo waives reuse
the checklist's ignore/accept. Extensions add findings through `api.setupFinding` (the permissions
extension does); a clean extension rule becomes a passed row only when it answered.

## All repos

A view of the same sheet (`all repos` chip, first of the row, only with two or more primary repos), made
from `shared/src/findings/rollup.ts`: `repoRollup` folds every repo's repo-scope findings into rule groups
(`in 7 of 33 repos`, the denominator being the repos the rule RAN in), the repos with nothing open and the
repos that could not be checked; `repoRollupCut` is the one function behind a group's number, its rows and
the "n of N repos" bar. Nothing ranks repos, sums savings or prices anything: the order is rules, and
repos only inside one rule by that rule's own saving. Host: `GET /api/setupcheck/repos` answers the
roll-up from `SetupCheckStore.getAll` (`sweepRepos`: four repos at a time, machine and account sources
read once per sweep by `sharedOnce`, a repo that throws or outlasts its timeout is "not checked"); the
phone passes the repo ids it hides. The main menu's `setup check` line (no count) opens it. Auto-compact
from the user-level setting or none anywhere is ONE machine finding (judged from the desktop's own
layers); a repo finding only where that repo's own settings or the env decide the window. That finding
carries no saving: the row is not priceable.

## Writing into a repo

`repo.efficiency-rules` offers a marked block of generic rules for CLAUDE.md or AGENTS.md
(`shared/src/efficiencyrules.ts`, `host/src/efficiencywrite.ts`). The write is behind a tap and a
confirm token, refuses symlinks, big files and a stale base sha, never overwrites a block edited by
hand and never commits.

## Doors

An evidence door opens the existing screen cut to the named items (`sdk/evidence.ts`: `aimEvidence`,
`useEvidenceFocus`), with "n of N" and a clear. The repo badge counts exactly the rows its tap opens
(`findingCut` feeds the number and the rows). Token stats draws one line, "N findings about this
spend", into the sheet; the charts stay as evidence.

## Gaps worth knowing

The CLI and VS Code have no session history, so no savings and the rules say "not checked". The
permissions engine is not loaded in the CLI. A write, a fix or a waive drops the store's cached
document (`invalidateSetupCheck`), so the next read waits for a fresh run and the finding moves to
the checked-off list at once. A machine finding's fix runs through `/api/host/setup/fix` on its own
row; the repo-health alerts, the capped-period pace and Copilot's quota are read from what the host
already computes (`healthwatch`, the budget, the usage registry). Not checked, with the reason on
screen: the permissions engine in the CLI and VS Code, and Copilot while its extension is off.

## Modules

- Shared: `ledgerfold.ts` (the one ledger cell loop), `sessionmoney.ts` (the one session money rule),
  `remedyprompts.ts` (one wording per remedy), `efficiencyrules.ts`, `contextclock.ts` (the three clock labels: in the working tree, at the last commit measured, in this session now; a figure never prints without its clock).
- Host: `routes/apisetupcheck.ts` (`apisetupcheck.ts`, the GET, `/repos` and the waive POST), `efficiencywrite.ts`.
- Phone: `setupCheckWords.ts` (pure wording for the sheet); in token stats `hostSpendWords.ts` and
  `HostSpendLine.tsx` (the host's own metered calls) and `FindingsLine.tsx` (the one line into the Setup check).
