# limits — the usage-limit resume queue, phone side

When the account hits a usage limit the desktop parks every blocked session and resumes them once
the window resets (`limit.ts` / `limitlog.ts` on the host; the rules are in the `heuristics`
skill). This folder holds what the phone knows and decides about that queue: the host-wide config,
the `limits` sheet (the flat `LimitSheet.tsx`, wrapped by `LimitQueueSheet.tsx`) and the session
toolbar's `limit` toggle (`LimitToggle.tsx`).

**Owns** (`store.ts`, one writer — `onLimitConfig` in `actions.ts`, called by the `limit.config`
handler): `limitCfg` = `{ auto, mode, hold }` — the global auto-continue switch (starts `true` until
the host says), the release mode (`one`/`repo`/`all`; an older host omits it and the last known mode
stands) and the account-wide hold after a resume came back still blocked. Read hooks
`useLimitAuto()`, `useLimitCfg()`. `logic.ts`: the override cycle (inherit → on → off → inherit) and
every receipt the taps toast.

**Sheet**: `limits` (not persisted). **Messages**: `limit.config`. **Toolbar item**: `limit` (the id,
label and icon stay in `toolbar.ts`; `null` when the session has no limit state).

**Reads from core**: `world.sessions`, `conn.status/send/liveSend`, `nav.attach/close`,
`say.toast`. No storage keys of its own (`SNAP_AT_KEY` is read for the sheet's age line).

**Rules that apply**: every control is LIVE-ONLY, never queued — a limit decision replayed an hour
later is about a situation that has moved on; `liveSend` says so in words when there is no link.
No usage-limit banner phrase appears in any string here (the detector would read it off the
screen).

**Exports for App**: `useLimitAuto()` (the session row's `auto`/`no auto` chip and the Settings
row), `useLimitCfg()`, `setGlobalAuto(enabled)`.

**Settings rows** (`LimitSettings.tsx`, Sessions, order 10): `limit-auto` and the usage budget beside
it (`budget`, `budget-session`, `budget-weekly`) — the host's `world.budget`, sent back as
`budget.set`; a slider drag is a local draft until the host echoes the saved value.

**Tests**: `logic.test.mjs`. e2e: `scripts/e2e-limit.mjs`, `scripts/e2e-limitreset.mjs`.
