# repoSetup

One repo's set-up page (`set up <repo>`): everything waterplane can turn on in this repo, ticked and
set up in one go. Rows, default ticks and the plan are `shared/reposetup.ts` (`setupRows`,
`setupDefaultTicks`, `setupPlan`), so the rows ticked, the button's count and what runs are one cut.
Plan: `docs/analysis/repo-setup/PLAN.md`.

**Owns**

- `store.ts` — `openOn` (the worktree path the sheet is on) and `runs` (per worktree path: the ticks the
  person changed, what became of each row, the rows Go saw). Written only by `actions.ts`.
- `actions.ts` — `openRepoSetup(worktreePath)` (a person's tap), `offerRepoSetup` (by itself, over a session
  just started: `core/launch/afterStart.ts` says when, `mayOffer` whether, once per page load), Go and *try again*, the seen mark, the look seed, and the
  boot subscription that follows posted rows (`watchFires`).
- `logic.ts` — tick merge, outcome keying, Go's order, every sentence; `logic.test.mjs`.
- `RepoSetupSheet.tsx` — overlay `repoSetup` (not persisted). Its CSS is `.repo-setup …` in
  `styles/13-insights-onboard.css`.

**Reads from core**: `world.repos/backlogAuto/usage`, `queue.queueOp/queueBacklog/mintAckId/drop`,
`launch.wire`, `nav.open/close/openSend/openSetup/openRepoHealth`, `say`.

**Rules**: a paid row is the Opt-ins card's own seed, posted through the one queue under one fresh
ackId, as an ordinary backlog row (no `autoFire`) or the catalog's weekly rule. An outcome is written
before anything is awaited and outlives the sheet, so nothing posts twice; only a fix that failed or a
post the desktop REFUSED can be tried again. A post nobody confirmed reads *queued*. After a reload the
send queue itself says what is already waiting (`queuedOptIns`). Outcomes are keyed by the path Go ran
on. A background reload never moves a tick the person set. Leaving for good marks the repo seen
(`api.optInSeen`, best effort); a door over the page does not. A suggestion ticks nothing until
*use these suggestions*.

**A row is one short line** (`short`, at most `SHORT_MAX` characters, a test holds it): tick, title, the paid
mark and that line. The tick (a label) and the text (a button, `aria-expanded`) are two 44 px targets; a tap
on the text opens pitch, cost and the probe's detail and never touches the tick. A suggestion, a `sent`
sentence and an outcome stay drawn. Re-check is the sheet head's icon.

**Consent**: nothing PAID is ever ticked without a fresh tap. Go clears the tick of every paid row it takes
(`untickPaid`, in the patch that writes the *waiting* outcomes), so a row whose outcome is reset later (its
item was cancelled or ended) comes back unticked; only a tap or *use these suggestions* ticks it again.
**Order** is `shared/reposetup.ts`'s `tickGroupsFirst`: groups holding a tick row (by kind, so nothing moves
after a tick or Go) before door-only groups, doors after tick rows in a group. A door has no tick gutter: its
text starts on the page gutter and its compact button sits on the title row at the right, else under it. After
Go a row's outcome is the muted line directly under its title. The footer names what runs now when the names
fit one line (`freeWords`), else counts them. *let an agent look first…* carries its cost on its own row; the
words only read and suggest, and the Send sheet seed says so.
