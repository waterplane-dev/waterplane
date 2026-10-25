# weekburn — the week-end burn, phone side

Once a week, if the subscription week will end with budget unused, the person picks repos to spend
it on: the host posts small, one-commit repo-improvement items there (serial, one live per repo)
from a planned start until the stop line. The mechanism, the stop rule and the start-time maths are
the host's and `@waterplane/shared`'s `weekburn.ts`; this folder is the sheet that makes the pick.

**Sheet**: `weekburn` (not persisted), "This week's burn". Reads `GET /api/weekburn`
(`api.getWeekBurn`) with `useRemoteResource`; saves with `POST /api/weekburn` (`api.postWeekBurn`),
which answers the new status. No store: the host holds the pick, the sheet holds only a local draft
(repos, "ask me each week", stop line) seeded from this week's pick, never from last week's.

**Owns**: `logic.ts` (the save verb, "same as last week" eligibility, running-row words, receipts;
`logic.test.mjs`), `actions.ts` (the one save call, a toast either way), `WeekBurnSettings.tsx` (the
Settings › Sessions door to the sheet). Repo list: `core.world.visibleRepos`, keyed by
`worktreePath` like the fan-out sheet.

**Rules that apply**: the pick is the approval — "same as last week" is a tap that posts, never
something that happens by itself; an empty selection is *Cancel this week* (a live item finishes),
and with nothing to cancel the verb is a sentence, not a dimmed button. When the host says the burn
is unavailable (no subscription windows, no reading) its sentence is printed via `Unavailable`.
`plan.reasonText`, `stoppedText` and `unavailableText` are shared wording, printed as sent. The
`weekburn` notification (`features/notifications`) opens this sheet on a tap.
