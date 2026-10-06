# cliHealth — the CLI integration's health board and its unprompted mark

Every point where this app reads something it does not own (the choice-box detector, the hook
pipe, the echo probe, the conversation log…) and what each last managed to read. The verdicts,
sentences and order are all `@waterplane/shared`'s (`clihealth.ts`); nothing here re-derives one. The
board is `CliHealthSheet.tsx` at the top level; this folder owns the state, the frame, the chip.

**Owns**
- stores (`store.ts`): `rollup` — seeded from the `snapCliHealth` snapshot (`localState.ts`
  owns the key) so a degraded CLI is marked before the socket is up; `filter` — the verdicts
  the chip's count opened (a count on a control is a filter), cleared by `onLeave`; and
  `useCliRollup()` over the rollup.
- `actions.ts` — the `clihealth` handler, `requestCliHealth`, `openCliHealth`, and the unrendered
  page-lifetime bookkeeping (`seen`, the worst verdict so far; `waiters`). `logic.ts` — the
  ordering and the chip's filter. `HealthBoardSheet.tsx` — the overlay. `CliHealthChip.tsx` — the
  topbar mark.
- overlay `clihealth` (persisted — in `PERSISTED_OVERLAYS`).
- wire frames in: `clihealth` (saves the snapshot, publishes the rollup, resolves any
  `requestCliHealth` waiters, toasts once on a WORSENING only — `logic.ts`). Out: `clihealth.get`.
- exports for App: `useCliRollup()`, `CliHealthChip` (the launcher topbar mark: renders nothing
  for healthy/unknown), `openCliHealth(verdicts | null)`, `requestCliHealth()`.
- Settings row (`CliHealthSettings.tsx`, Tools, order -10 — the first door of the rack):
  `tool-cli-health`, toned by the rollup.

**Reads from `core()`**: `conn.status`/`conn.send`, `nav.open/close`, `say.toast/track`.

**Tests**: `logic.test.mjs` (ordering, worsening, chip filter). e2e: `scripts/e2e-clihealth.mjs`.
