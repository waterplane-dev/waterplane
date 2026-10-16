---
name: protocol
description: waterplane wire protocol and the invariants that hold it together: the single WebSocket, ackIds and at-most-once delivery, durable ops, session.input and its verdicts, prompt fingerprints, intents on the wire, the tmux substrate and its locale trap. Load BEFORE adding a message, changing an ack or retry path, touching PROTOCOL_VERSION, or changing how a send is delivered or confirmed. Several rules here exist because a prompt ran twice or never ran at all.
---

# waterplane wire protocol and invariants


Some of these are now checked. `tools/eslint/rules.js` holds the repo-specific rules —
`no-cors-wildcard`, `no-second-socket`, `no-functional-setoutbox`, `no-storage-key-literal`,
**`no-silent-send`** (a socket write in an `on*` JSX handler must end in a toast or a queue entry;
`liveSend`/`liveAsk` (`core/conn/useConnection.ts`, `core().conn` in a feature) are the receipt; in `features/**` every bare `conn.send` needs a
receipt in its own function unless it is in `messages`/`boot`),
**`no-anchor-download`** (an `<a download>` or an `a.download =` outside `pull.ts` — dead in the
APK; downloads go through `download.ts`) — plus the `fetch` ban outside `api.ts`. A genuinely special case takes an inline
`eslint-disable-next-line … -- reason`, so the exemption is visible where it is taken; `no-silent-send` has eight (grep
`eslint-disable.*no-silent-send`: `core/session/TermArea.tsx`'s `onResize`, seven in `features/**` — `build` ×3, `capture`, `backlog`, `search`, `hostTools`). Generic presets are deliberately NOT pulled in — `tsc` already runs strict with
`noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`. Why these are lint rules rather
than paragraphs: [testing-and-ops.md](docs/notes/testing-and-ops.md#why-these-rules-are-lint-rules-and-not-paragraphs).

Wire:

- One WebSocket per tab carries everything; PTY bytes are base64 in `{t:"pty",id,dataB64}`. permessage-deflate is on (context takeover is the point).
- Sockets attach/detach explicitly; frames go only to attached sockets. Every frame carries `seq`;
  `session.attach` may carry `resumeSeq` + `resumeBoot` ⇒ delta replay, else `full: true` and the
  client resets its terminal. Boot mismatch ⇒ full replay (tmux sessions outlive the daemon).
- **Every retry path goes through an ackId.** `input.ack` / `backlog.ack` / `op.ack` are idempotent
  against the persisted ledger; a repeat is re-acked, never re-executed.
  **A LOST ledger fails closed** (shared `preLossRefusal`; why in its header): every ackId'd
  durable message carries optional `firstSentAt` (the queue's `firstTryAt`, unchanged on every retry; `retargetEntry` drops
  it with the old id) + `sentAt` (stamped at the write in `ws.ts`). Inside `acks.lost`'s window an
  UNKNOWN ackId whose AGE (`sentAt - firstSentAt`, one clock, so skew drops out) puts its first send
  before the loss (+5 s transit margin) is refused in `LOST_LEDGER_REFUSAL`, never run, remembered.
  No `firstSentAt` ⇒ runs, as before. Additive; `PROTOCOL_VERSION` stays. `e2e-acklost.mjs`.
- `session.create` carries `needs?` — the files its prompt must not run without. Present and absent
  on disk ⇒ the host PARKS the whole create (as a `files`-triggered intent, `intents/`) and answers
  `op.ack` with `launchId` — and `intentId`, the same string — and **no** `sessionId`; a client must
  never read that absence as "the session was never named". The waiting is the host's from that
  moment: the phone may close.
- **The `intent.*` messages are additive (no `PROTOCOL_VERSION` bump).** `intent.post` (durable —
  and its `ok` means the row is on DISK, not merely accepted), `intent.run`/`update`/`retarget`
  (durable), **`intent.waive`** (durable: lifts ONE rung — `budget` — for one row, until the host-stamped reset of the window it lands in, `on:false` the undo; an old host ignores it, so rows stay held), **`intent.requeue`** (durable: a FAILED row back in the queue keeping its words, its
  place and the failure it had. **`failed` is a STATE, not an event** — a row revived and failed
  AGAIN while the phone was offline still passes a state-only guard, re-running work on a failure
  nobody read — so the op carries `failedAt`, the `settledAt` the TAPPER saw, and the host refuses a
  mismatch. THAT, not the state, is what makes a LATE delivery safe; `expectPrompt`'s posture,
  absence included — an older client that cannot say is accepted on the state alone. The assessment
  path needs the same fact per row: `AssessItem.failedAt`),
  `intent.cancel`/`dismiss` (deliberately NOT durable and never queued offline: a cancel
  delivered an hour late calls off work that has since run), `intent.list`; back come `intent.list`
  and `intent.changed`. Every OLD message keeps working through `intents/adapters.ts`, so the store
  ships with no client change and the APK may pin an old bundle.
  **The client READS the store now**: `intent.list` on hello and on a bare `onChange` (a row LEAVING
  is not expressible as a changed row), `intent.changed` per transition — where `onChange` used to
  broadcast the WHOLE store to every phone on every transition. `intent.retarget` carries an optional
  `cwd`, because a re-aim across REPOS is one decision (`backlog.update` always carried `repoDir`).
  **`intent.dismiss` is the one the client must actually SEND** (`features/activity/actions.ts`'s `dismissOnHost`, off
  Activity's file-away): `Intent.dismissedAt` is the gate a terminal row passes before `compact()`
  may ever evict it, and while nothing sent it every `failed` intent stayed in the live
  `<state dir>/intents.json` for ever — the file only grew. Safe to fire and forget, because the host's
  `dismiss()` refuses anything not terminal and anything already dismissed, so an armed schedule, a
  running item and a double tap are all no-ops. Not undone by Activity's *restore*: there is no
  un-dismiss message, and a restored row may later be compacted — which appends every word to
  `intents-archive.jsonl` rather than deleting it. **Note the arrow of the migration is INVERTED
  from what it looks like**: the shipped web client sends no other `intent.*` message at all and
  still speaks `launch.*`/`schedule.*`/`backlog.*`, so `adapters.ts` is not a legacy shim to be
  deleted — it is the only path into the store, and the `intent.*` routes are the unshipped half.
- `op.ack`'s `ok` means *accepted and started*, not finished. Ops: `session.create` (optional
  `prompt`, optional `replaceSessionId` so relaunch is ONE atomic op), `fanout.run`,
  `fanout.followup`, `build.run`, `schedule.save` (upsert on a client-minted id, so a replay
  overwrites instead of adding a second weekly sweep) and `schedule.run`. `session.reopen` is not a
  thing — reopen via `session.create` with `resumeSessionId`. **Forking is not a new message
  either**: `session.create` gains `forkAtTurn?` and `"fork"` joins `resumeMode`, so the file write
  (`convfork.ts`) inherits `durable: true`, `contain: "cwd"` and at-most-once by ackId — a retried
  fork re-acks and writes nothing. One gap, stated: a crash BETWEEN the file write and the ack
  replays into a second orphan jsonl — an extra archive row, deletable, never a second claude, which
  is `starting`-row semantics exactly.
- **`session.name` is additive (no bump).** *Name this conversation now* —
  the host re-derives the summary and the ≤4-word `tabTitle` off it (`sessions.nameNow`) and
  answers `session.named` with the NAME or the SENTENCE saying why there is none, never neither.
  It SPENDS two cheap toolless calls, so it is never queued offline, never retried and never
  automatic: a name delivered an hour late is a name for a screen nobody is looking at
  (`intent.cancel`'s reason). The rename itself reaches every phone on the session list.
- **`schedule.skipNext` is additive (no bump).** Not durable and never queued
  offline, for `intent.cancel`'s reason: a skip delivered an hour late spends an occurrence that has
  already run.
- `session.input` carries `submit?` — **the submitting Return lives on the HOST** (`deliverPrompt`),
  and `input.ack.state` is `ok` / `notready` (the only auto-retryable one, deliberately not
  remembered) / `unconfirmed` / `unsubmitted`. A `submit` send must not also `session.record`.
  **A bare `/fork [title]` to a claude session is never typed** (CLI ≥ 2.1.291 hands it to its own
  background daemon, invisible here): `routes/session.ts`'s `forkFromInput` opens it as a tab via
  `sessions.fork()`, focuses the asker, and acks `ok` + `state: "forked"` with the sentence;
  remembered, so a retried ackId never forks twice; no conversation id ⇒ refused in words.
  `e2e-slashfork.mjs`, `packages/host/test/slashfork.test.mjs`.
- `session.input` carries `expectPrompt?` — an answer names the question it answers
  (`promptFingerprint`); a mismatch is refused `stale` with nothing written, and that verdict IS
  remembered. Never combined with `submit`. Client-side an answer is `armed` and jumps its lane —
  and, like everything else in that queue, is never expired: its safety is the fingerprint, so a
  late answer is either still correct or refused, which is the case the offline path exists for.
- `session.input` carries `promptSubmit?` — the answer is a checkbox box's **Submit row**, not a
  key. The host places the TUI cursor there before the Return (`submitPromptBox`); a client cannot,
  having no cursor position and only the undurable raw-keystroke path for the arrows. Goes with
  `expectPrompt`, never with `submit`.
- Raw input: text and Return as **two writes** with a small delay, or the TUI reads it as a paste.
- A receipt window expiring must not spend the give-up budget: roll the attempt back when the socket
  wasn't open; a dead socket requeues `pending` entries immediately (same ackId makes it safe).
  Windows come from `ackWindowFor()` (measured p95, widening per attempt).
- `input.settle` → `input.settled` is a read-only QUESTION about past deliveries, not a send: it
  types nothing, carries its own text (the host keeps no copy of an un-acked prompt) and is not in
  the durable-op set. **The web client no longer sends it** — the route stays for an APK pinned to an
  old bundle, but asking was the wrong end of the wire (a phone, three tries, over a live socket,
  about rows that retired an hour later). `delivery.list`/`delivery.settled` are the
  answer arriving unasked: `opendeliveries.ts` re-asks with nobody connected and broadcasts, the queue core (`core/queue/wire.ts`'s `onDeliverySettled`)
  applies it to the row by `ackId`, and `delivery.list` on hello is the reconciliation pass for
  whatever settled while the tab was gone.
- **`PROTOCOL_VERSION` is 2** (deliberate): `plugin.call` → `plugin.reply` (asking socket only) and broadcast `plugin.push` are the generic extension channel. `plugin.call` is a live question — NOT durable, never queued, not in the ack ledger; its ackId addresses the reply, the host's in-memory ledger de-duplicates it, and the client re-sends only `read()` calls (same ackId). A write that must be at-most-once across a restart goes through `handToAgent`'s `key`. An older host ignores it; the call times out and says so.
- `pull.*`, `settings.*`, `notify.prefs.*` and `budget.*` are additive and not in the durable-op set.
  No bump — bump deliberately. **`pull.add` is legacy**: a download is a LOCAL
  queue record now (`web/download.ts`) and the client sends nothing; the route stays for an APK
  pinned to an old bundle, and `e2e-autopull.mjs` still pins it.

Substrate: tmux is REQUIRED and the ONE substrate (no direct-PTY mode; the old `WATERPLANE_TMUX` knob is ignored and doctor says so; a missing binary refuses the spawn in words, `tmuxreq.ts`) — it runs each `claude` inside a **private** tmux server (`-L waterplane`), so it
survives a host restart and `rediscover()` re-attaches on boot. The server is keyed by socket name,
not `WATERPLANE_ROOT` — which is why e2e roots derive their own, and tests also get a private socket DIRECTORY (`scripts/lib-tmuxiso.mjs`). **Every tmux client is spawned `-u`, out
of `ptyEnv()`, which also supplies a UTF-8 `LANG` when the environment has none**: launchd sets no
locale, and a tmux client that cannot conclude its terminal is UTF-8 does not forward UTF-8, which
cost prompt detection its `❯` and published nothing for a live choice box. `e2e-tmux.mjs` boots the
host in a deliberately MINIMAL env and asserts `client_utf8`.
[protocol-and-security.md](docs/notes/protocol-and-security.md#the-tmux-substrate-and-the-locale-that-broke-prompt-detection).

**The tmux client's terminal queries are the HOST's to answer** (`termqueries.ts`, in front of
`register`'s data handler): DA1/DA2/XTVERSION/OSC 10-11/`?996n`/14t/18t answered at once and
STRIPPED before scrollback, recorder, echo or any phone — so a session behaves the same with the
phone off, and no xterm.js answers twice (a duplicate reply is typed input). Never forward a query
to phones; never intercept what the pane asks tmux. `e2e-termqueries.mjs`.
[Why.](docs/notes/protocol-and-security.md#the-tmux-clients-terminal-queries-answered-by-the-host)

**A pan is routed by the PANE, never by a version** (`tmuxscroll.ts`, `sessions.panHistory`): the
phone's flick arrives as one SGR wheel write, and where `#{mouse_any_flag}`/`_button_`/`_standard_`
says the program asked for the mouse the bytes are PASSED THROUGH to it — claude ≥ 2.1 enables
`?1003h`+`?1006h` and scrolls itself — otherwise they are translated into tmux `copy-mode` +
`scroll-up`. Exactly one of the two, read fresh per pan. The translation was unconditional until
2026-09 and by then claude also ran in the ALTERNATE screen, where a pane has no history
(`history_size=0`), so every pan in every session silently did nothing.
[Both measurements.](docs/notes/protocol-and-security.md#panning-the-tui-who-gets-the-wheel-and-why-the-answer-changed)
