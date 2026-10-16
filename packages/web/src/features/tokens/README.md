# tokens — token statistics and the /usage reading

The host's
scraped `/usage` reading that every usage readout in the app is drawn from. The numbers rules
(a total is never printed without its split, absent never zero) are `web-numbers`'.

**Owns**
- store (`store.ts`): `usage` — the last `UsageInfo`, null until the host says, and `useUsage()`
  over it. ONE writer, the `usage.status` handler. `weekRate` — list-price dollars per weekly
  percent, calibrated per reading by `actions.ts`'s `calibrateWeek` (one `ledgers.tokenWindows`
  cell from the week's opening hour to the scrape), read through `useWeekUsdPerPct()` by
  `core/session/TermArea` so the reader's turn foot can say each cost as a share of the week.
- store, per usage SOURCE (`readings`, `useUsageReadings()`): one `UsageReading` per source with
  something to say (claude, copilot, a plugin's), from `usage.status.readings` or — an older host —
  `[claudeReading(usage)]` (`logic.ts` `readingsOf`); `welcome` clears it. `core/launcher/UsageChip.tsx`
  draws one segment each (`chipCut`), plus claude's `?/? wk` door beside them whenever the scrape is
  held and gave no claude reading (`claudeDoorBeside`); a tap on a NON-claude segment is a FILTER:
  `openTokensOn(tokensOpenSource(source))` sets `tokensOpenOn` (null for claude's — the default
  view, no "opened on" line) and opens the `tokens` overlay.
  The token-stats sheet reads `core().world.tokensOpenOn` ONCE as it opens and clears it (consumed;
  the body keeps its own copy for `all`), and calls `world.clearTokensOn()` on `all` and on close —
  never in an unmount cleanup (StrictMode runs that at mount in dev).
- The `tokens` overlay (the token statistics screen) is the `token-stats` EXTENSION's
  (`packages/extensions/token-stats`); it keeps its core id and `PERSISTED_OVERLAYS` entry.
- wire frames in: `usage.status`. Out: `usage.refresh` is `sdk/ledgers.refreshUsage(quiet?)` (quiet is
  the sheet's own stale-read refresh and sends only when open; a tap goes through `liveAsk`).
- exports for App/core: `useWeekUsdPerPct()`; `useUsage()` (launcher chip, schedule previews, send sheet; App binds it as
  `core().world.usage`).
- `billing` (`store.ts`) — the host's `billing.status` (profile + source), ONE writer, read as `useBilling()`
  and bound as `world.billing`; `useUsageFace()` (+ `logic.ts`'s `usageFace`) is what the launcher and
  session chips draw: the two windows (subscription, unknown, an older host), the primary dollar period
  (`../../periodWords.ts`) on api/cloud, or a bare gauge — never `?`. Periods ride `world.budget.periods`.
- Settings rows (`BillingSettings.tsx`, Sessions, order 11): `billing-profile`, `billing-periods`.
- Settings row (`TokenSettings.tsx`, Tools, order -20 — above the door rack): `token-stats`.

**Not here, on purpose**: the usage BUDGET (`budget.state`) — its handler flushes App's send
queue when the gate lifts — and App's effect that asks for a fresh reading when a screen showing
it comes up. No storage keys.

**Tests**: `logic.test.mjs` (`weekCalKey`: which readings a week share may be calibrated off);
the share wording is `shared/sessioncost.ts`'s, tested there. The statistics maths is the
extension's `usageCut.ts` and kit/chart's `statsPlot.ts`. e2e:
`scripts/e2e-tokenstats.mjs`, `scripts/e2e-uiusage.mjs`.
