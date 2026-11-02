# limits — the usage-limit resume queue, phone side

When the account hits a usage limit the desktop parks every blocked session and resumes them once
the window resets (`limit.ts` / `limitlog.ts` on the host; the rules are in the `heuristics`
skill). This folder holds what the phone knows and decides about that queue: the host-wide config,
the `limits` sheet and the session toolbar's `limit` toggle (`LimitToggle.tsx`).

The `limits` sheet is the **blocked sheet** (`BlockedSheet.tsx`, wired by `OpenBlockedSheet.tsx`): every
session behind a wall outside it, grouped Sign-in → Network → Spend → Usage limit, reached from the
launcher's "N blocked" chip. Its rows are `attentionCut(…, "blocked", …)` (`src/attention.ts`) — the
call that chip counts with — so the number and the rows are one array, and when the list hides some
(hidden or unfocused repos) it says "n of N" above the rows with *show all*. The sign-in card is one
act for the account (`signInPlan` in `logic.ts`: open the newest printed link, else `/login` through
the send queue into a free signed-out session, else say why); once the host confirms a sign-in
(`SessionInfo.signInWait.signedInAt`) the card turns into *Signed in again* with *continue all N* and each
such row gets its own *continue* — ASKED, never typed by itself. `signInSplit` (`logic.ts`) is the one
partition (ready / already tapped / still signed out) that feeds the count, the ids sent, the rows and the
headline. The tap is `signin.continue`, DURABLE (`continueSignedIn` in `actions.ts` → `queueOp`, lane
`signin`): offline it is kept and sent on reconnect, and the host types only into sessions still waiting.
The receipt is the host's own sentence, toasted by `onOpAck`. Network rows use `netRetryNow` /
`netRetryCancel` (`netRetryCfg.ts`), the session retry bar's own messages.

**Owns** (`store.ts`, one writer — `onLimitConfig` in `actions.ts`, called by the `limit.config`
handler): `limitCfg` = `{ auto, mode, hold }` — the global auto-continue switch (starts `true` until
the host says), the release mode (`one`/`repo`/`all`; an older host omits it and the last known mode
stands) and the account-wide hold after a resume came back still blocked. Read hooks
`useLimitAuto()`, `useLimitCfg()`. `logic.ts`: the override cycle (inherit → on → off → inherit) and
every receipt the taps toast.

Also `netRetryCfg` (`NetRetryConfig | null`, one writer `onNetRetryConfig`, from `netretry.config`):
the desktop's other self-typed recovery, the network-error retry switch. Null until the host says,
so an older host shows no row. Host-persisted like auto-continue, never in settings sync. The store,
the `netretry.set` sender and the switch component live TOP-LEVEL (`netRetryCfg.ts`, `NetRetrySwitch.tsx`)
because a stalled backlog/Activity row (`NetStalled.tsx`) draws the same switch beside *retry now*;
this feature re-exports them and keeps the one writer.

**Sheet**: `limits` (not persisted). **Messages**: `limit.config`, `netretry.config`. **Toolbar item**: `limit` (the id,
label and icon stay in `toolbar.ts`; `null` when the session has no limit state).

**Reads from core**: `world.sessions`, `world.backends`, `world.cwdVisible`, `conn.status/send/liveSend`,
`queue.submitInput` (the sign-in card's `/login`), `nav.attach/close`, `say.toast/track`. No storage keys of its own (`SNAP_AT_KEY` is read for the sheet's age line).

**Rules that apply**: every queue and retry control is LIVE-ONLY, never queued (the sign-in card's
link needs no desktop, and its `/login` is a typed command, so it rides the send queue) — a limit decision replayed an hour
later is about a situation that has moved on; `liveSend` says so in words when there is no link.
No usage-limit banner phrase appears in any string here (the detector would read it off the
screen).

**Exports for App**: `useLimitAuto()` (the session row's `auto`/`no auto` chip and the Settings
row), `useLimitCfg()`, `setGlobalAuto(enabled)`.

**Settings rows** (`NetRetrySettings.tsx`, Sessions, order 11): `net-retry` — with the env override it
shows the SAVED value ("saved on") and the shared sentence, never a greyed switch.
(`LimitSettings.tsx`, Sessions, order 10): `limit-auto` and the usage budget beside
it (`budget`, `budget-session`, `budget-weekly`) — the host's `world.budget`, sent back as
`budget.set`; a slider drag is a local draft until the host echoes the saved value.

**Tests**: `logic.test.mjs`, `src/attention.test.mjs` (the bucket, the cut, the groups). e2e: `scripts/e2e-limit.mjs`, `scripts/e2e-limitreset.mjs`.
