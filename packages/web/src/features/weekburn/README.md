# weekburn — the week-end burn, phone side

Once a week, if the subscription week will end with budget unused, the person picks repos to spend
it on: the host posts small, one-commit repo-improvement items there (serial, one live per repo)
from a planned start until the stop line. The mechanism, the stop rule and the start-time maths are
the host's and `@waterplane/shared`'s `weekburn.ts`; this folder is the sheet that makes the pick.

**Sheet**: `weekburn` (not persisted), "Week-end burn". Reads `GET /api/weekburn`
(`api.getWeekBurn`) with `useRemoteResource`; saves with `POST /api/weekburn` (`api.postWeekBurn`),
which answers the new status. No store: the host holds the pick, the sheet holds only a local draft
(repos, "ask me each week", stop line, the person's task and per-repo notes) seeded from this week's
pick, never from last week's, and never re-seeded over typed words except by a save.

**The prompt is the person's to see and change.** `howItWorks` (logic.ts) prints the steps at the top;
the task ("My own instructions" replaces the weakest-health-reading default) and a ticked repo's own
line go into `prefs.task`/`prefs.notes`. The "Show the prompt" preview is the shared
`weekBurnItemPrompt` over the DRAFT plus `status.readings` (each discovered repo's health summary,
sent by `GET /api/weekburn`), so what is shown is what the host will send. `WEEKBURN_RULES` (one
change, tests, commit, never push) is always appended — not editable.

**Owns**: `logic.ts` (the steps, the save verb, "same as last week" eligibility, running-row words, receipts;
`logic.test.mjs`), `actions.ts` (the one save call, a toast either way), `WeekBurnSettings.tsx` (the
Settings › Sessions door to the sheet). Repo list: `core.world.visibleRepos`, keyed by
`worktreePath` like the fan-out sheet.

**Rules that apply**: the pick is the approval — "same as last week" is a tap that posts, never
something that happens by itself; an empty selection is *Cancel this week* (a live item finishes),
and with nothing to cancel the verb is a sentence, not a dimmed button. When the host says the burn
is unavailable (no subscription windows, no reading) its sentence is printed via `Unavailable`.
`plan.reasonText`, `stoppedText` and `unavailableText` are shared wording, printed as sent. The
`weekburn` notification (`features/notifications`) opens this sheet on a tap.
