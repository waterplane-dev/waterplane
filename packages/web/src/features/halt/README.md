# halt — the emergency "all AI off", phone side

One tap (behind a confirm) stops every AI process the desktop's waterplane started — agent
sessions, attached or running in the background, with their tools, and the headless model runs —
and LATCHES: nothing automatic starts again until a person lifts it. The host half and the reason it
is a latch rather than a kill are `packages/host/src/halt.ts` and `packages/shared/src/halt.ts`.

**Owns** (`store.ts`, one writer — `onHaltState` in `actions.ts`, called by the `halt.state`
handler): the latch as the host last said it, `{ on, since, receipt }`. Starts off until the host
has spoken. `logic.ts`: the banner's line and the confirm's lines (the receipt sentence itself is
shared).

**Draws**: the launcher's **Halt** button and the session menu's **halt all AI** line. No sheet. The
banner is `HaltBanner` in `core/Banners.tsx` (mounted in `main.tsx` beside `UpdateBanner`, because
`App` returns early per overlay); it reads `useHalt`, `haltBannerWords` and `liftHalt` from here.

**Messages**: in `halt.state`; out `host.halt { on }`.

**Reads from core**: `conn.liveSend`. No storage keys.

**Rules that apply**: both verbs are LIVE-ONLY, never queued — a halt replayed later is one nobody
asked for, and a stale lift would undo a newer halt. The banner is never dismissable: while the latch
holds, "why is nothing starting?" must have an answer on screen. Lifting brings nothing back by
itself; it only lets automatic work start again.
