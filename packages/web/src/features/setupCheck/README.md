# setupCheck — the Setup check, phone side

One sheet, `setupcheck` (title "Setup check", not persisted): a ranked list of findings about how
this repo, this machine and this account are set up, from `GET /api/setupcheck` (`api.setupCheck`).
The rules and the engine are the host's and `@waterplane/shared`'s `findings/`; this folder only
draws them and carries the taps.

**Always a checked-off list.** Beside the findings the sheet lists every rule that ran and found
nothing (what was checked, against which backends), what was waived (each row can be taken back),
and what could not be checked with its reason. A rule that could not run is never drawn as passed,
and an empty findings list still shows what was looked at.

**Owns** (`store.ts`, one writer `actions.ts`): the aim — `repoId`, `scope` (all repos, this repo, this
machine, account), `rule` (this repo cut to one rule), `openRule` (all repos: the group whose repos are
listed), `from: "all"` (a drill-down: Back returns to the overview, the group still open), and `weight: "finding"` when the repo badge's count opened it (a count on a
control is a filter: the bar says `n of N`). A tap, never a setting; the close clears it.

**Rows**: the sentence, the saving line (`≈$ a week`, labelled at list price, errs low), the
backends line only when one was unread, then up to three controls: the evidence door, the remedy
(`seed` opens the Send sheet and sends nothing, `fix` goes through the compliance fix API with its
confirm, `write` shows the plan and takes a second tap), and waive. waterplane's own install checks
fold under `waterplane install · N`. No score, no solid chip rows.

**All repos** (`AllRepos.tsx`, data from `GET /api/setupcheck/repos`): rule groups whose count is a
control (`repoRollupCut`), then `nothing open` and `not checked` folds. The manifest also contributes
the main menu's `setup check` line (no count, order 5).

**Back** (`actions.ts`): each drill-down level is ONE step Back undoes, armed by the tap with
`armStep` (a history entry above the sheet) and not by the mounted sheet — an evidence door opened over
a drilled card unmounts the sheet, and a step tied to the mount died with it, so Back from the door
landed a level too far down. Menu → all repos → a rule's repos (`openRule`, step 1) → a repo or this
machine (`from: "all"`, step 2); Back from a door returns to the card, then each Back undoes one level.
A scope switch among this repo / this machine / account is a view like the regions of Repo readings,
not a step; leaving the overview for one is a drill. `scripts/ui/journey-back-lands.mjs` walks every
path (`WALKS`) one Back at a time, by the arrow and by `history.back()`. A door whose sheet already
sits lower in the stack (token stats, opened over the usage sheet) is opened AGAIN over the screen
the door was tapped on, so Back returns there step by step. A sheet may therefore appear twice in the stack;
only a bare screen (a leave) is unwound to.
