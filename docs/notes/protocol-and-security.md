# Wire protocol, session substrate, security & heuristics

_Full rationale split out of CLAUDE.md. Index: [docs/notes/README.md](README.md)._

### Session substrate: tmux, the only one

Every session runs each `claude` inside a tmux session on a **private** tmux server (`-L waterplane`, never the user's own). The node-pty we hold is then only a tmux *client* — a viewport. The tmux server daemonizes, so it outlives the host: restarting waterplane detaches the client instead of killing `claude`, and `rediscover()` re-attaches every live `usmc_*` session on boot (a `LiveMeta` record per session rebuilds `SessionInfo`; the tmux pane's own `#{pane_current_path}` is ground truth for cwd). There is no other substrate: the direct spawn (where `claude` was our child and died with us) was the `WATERPLANE_TMUX=0` escape hatch, and is removed along with the knob — tmux is required (`tmuxreq.ts`), native Windows is unsupported.

The tmux server is keyed by **socket name, not by `WATERPLANE_ROOT`** — which is why a throwaway root (under the OS tmpdir, i.e. an e2e host) derives its own socket hash instead of using `waterplane`. Without that, stub sessions from a test daemonize onto the real server and the real host adopts them on its next boot. Tests go one step further and move the socket DIRECTORY (`scripts/lib-tmuxiso.mjs`: a private `TMUX_TMPDIR` per script, `TMUX` deleted, every server in it killed on exit), so no `-L` name a test picks can resolve to the owner's live server — they used to pin `WATERPLANE_TMUX=0` instead, which tested a substrate nobody runs. Verified by `e2e-tmux.mjs`.

Under tmux the host reads a redraw of the FINAL screen, so the stub delays its repaint after a verdict line: a line printed and cleared in one tick never reaches it.

### The tmux client's terminal queries, answered by the host

**A fresh tmux client asks its outer terminal eight questions, and the host answers them** (`termqueries.ts`). Measured on tmux 3.6b with the generated `tmux.conf` (`TERM=xterm-256color`): at start the client sends DA1 `\e[c`, DA2 `\e[>c`, XTVERSION `\e[>q`, OSC 10/11 (`\e]10;?\e\\`, `\e]11;?\e\\`), the colour scheme `\e[?996n`, and the text area in pixels and cells (`\e[14t`, `\e[18t`) — the size pair again on every resize, and OSC 10/11 again once the scheme is answered. No sync-mode `\e[?2026$p` was seen with this config. Unanswered, the client holds a lone Esc typed into it (~0.5 s, measured, where answered it passes at once) and at `TTY_QUERY_TIMEOUT` (~5.15 s) redraws the whole pane (`e2e-termqueries.mjs`: 1,121 bytes of `\e[K` rows with nobody typing). Answering a subset does not help. **A start-up reply has a deadline**: tmux reads DA1, DA2 and XTVERSION replies only inside that window, and one arriving later is forwarded to the pane as KEYS (measured 2026-10-09 on tmux 3.4 and 3.6b, each reply alone: answered at 4.8 s, consumed; at 5.6 s and 7 s, `1;2c`, `0;276;0c` and `:>|xterm.js(6.0.0)^[\` typed at the prompt; the colour, scheme and size replies were consumed at 7 s). The host answers the moment it READS a query, so a late answer means a late read — on a loaded WSL desktop (load 21, repos on `/mnt/c`) a fresh shell session got exactly that junk in front of its first typed line, and a boot re-attaching every live session in one synchronous pass (`reattach`'s `paneCwd` per session) holds every client's queries for the whole pass. So past `STARTUP_REPLY_MS` (4 s) of a client's life, counted from `answerTermQueries`' call right after the spawn, those three are stripped UNANSWERED and the session logs one line saying so: tmux then gives up at ~5 s exactly as before the host answered anything — a repaint, where a late answer is words in the composer.

That made a session's timing depend on the phone: an attached phone's xterm.js answered DA1, DA2 and OSC 10/11 as session INPUT (xterm.js 6 answers neither XTVERSION, `?996n` nor 14t/18t), while scheduled, backlog, fan-out and resumed sessions — all run with the phone off — waited out the timeout and took the repaint, which the continue ladder reads as "busy" and the limit reader saw as a redrawn banner. Two e2e scripts waited the window out (`e2e-limitparallel.mjs`, `e2e-slashlocal.mjs`); they no longer need to.

**So the host answers all eight, in the order asked, the moment the bytes arrive, and STRIPS them** before the first consumer — scrollback, `seq`, the screen recorder, the mode tracker, echo and settle, every phone (`register`'s data handler is wrapped by `answerTermQueries`, the one place a tmux client's output enters). Stripped because a phone that still saw a query would answer it too, and tmux reads a reply it did not ask for as typed text — measured: a 14t answer written before the 18t answer tmux asked for first leaves the 18t one in the pane as `^[[8;24;80t`. A query cut across two chunks is held (at most 9 bytes) and released by a 25 ms timer if no chunk completes it. Every other byte passes untouched.

The answers are what an xterm.js would say, from facts the host owns: DA1 `\e[?1;2c` and DA2 `\e[>0;276;0c` (xterm.js 6's own), XTVERSION `\eP>|xterm.js(6.0.0)\e\\`, OSC 10/11 as `rgb:rrrr/gggg/bbbb` with the query's own terminator, `\e[?997;1n` (dark), `\e[8;<rows>;<cols>t` off the PTY's live geometry and `\e[4;<h>;<w>t` as cells × a nominal 9×18 px cell (nothing here draws pixels). The colours are `shared/termpalette.ts`'s DARK pair — the same constants the phone's grid paints with (`web/termTheme.ts`). The theme a phone picked is a per-DEVICE preference that never reaches the host (`shared/settings.ts`), and a session nobody watches has no device at all, so dark it is.

**What is not intercepted: the pane's own questions.** A program inside the pane (the claude CLI asks OSC 11 for its background) asks tmux, and tmux answers from what it learned — measured: the pane now gets `rgb:0b0b/0d0d/1010` where, before the timeout, it got nothing. Those never reach the client's output. A query a pane program wraps in tmux passthrough arrives byte-identical to tmux's own and is answered the same way: a colour, scheme or size query at any time, its reply landing in tmux's input exactly where a phone's reply always landed. A wrapped DA1/DA2/XTVERSION meets the same start-up deadline as tmux's own (`termqueries.ts`) and loses nothing by it — tmux sets its HAVEDA/DA2/XDA flags on the first such reply or at its start timer and forwards any later one to the pane as keys, so a late passthrough reply was never consumable; stripping it is strictly better than typing it.

What remains at ~5.15 s is tmux's query timer firing anyway: an 18-byte cursor reset (`\e[?25l\e[?12l\e[?25h`) when the pane has drawn anything, no repaint.

### Wire protocol invariants

- One WebSocket per tab carries everything. PTY bytes are framed `{ t: "pty", id, dataB64 }` (base64) to keep one JSON channel — don't add a second socket.
- **The socket runs permessage-deflate** (`main.ts`, `WATERPLANE_WS_COMPRESS=0` to disable). The PTY stream is the largest continuous byte source in the app: a claude TUI repaint is tens of KB of highly repetitive ANSI, and the base64 framing inflates it another ~33%. Context takeover (the `ws` default) is the point — the deflate window carries across frames, so the Nth repaint of the same screen costs almost nothing. Costs a few hundred KB of memory per socket, which is nothing for the handful of tabs this daemon serves. Browsers offer the extension by default, so no client change was needed.
- Sockets explicitly attach/detach to session IDs (`session.attach`, `session.detach`); the host only sends PTY frames to attached sockets.
- **Resumable PTY replay.** Every `pty` frame carries a monotonic `seq` (cumulative output offset); the client records the last one per session. `session.attach` may carry `resumeSeq` — on a reconnect where the client's xterm survived (mobile wake), the host (`sessions.attachReplay`) replays only the delta after it, so a reconnect is a near-invisible append instead of re-streaming the whole scrollback. A fresh attach / session switch omits `resumeSeq` (or the resume point was evicted from the capped buffer) → the host sends a `full: true` frame and the client resets its terminal (remount) before writing it. A resume point that was PERSISTED across a host restart also carries the `welcome.bootId` it was recorded under (`session.attach.resumeBoot`): seq counts bytes since a session was registered and restarts at 0 on the next boot, while a tmux session outlives the daemon — so the same id can carry a fresh low seq that a stored offset falls inside, and the host would stitch a delta out of a byte stream that no longer exists. Boot mismatch ⇒ full replay. Pinned in `e2e-resume.mjs`. This is the fix for reconnect-cost: the socket still drops on every background (by design, `ws.ts`), but re-syncing it is now cheap. See `e2e-resume.mjs`.
- **The host lets go of a socket nobody is on the other end of** (`server/liveness.ts`, wired in `server/wsops.ts` and `server/sessionEvents.ts`). The heartbeat used to be client-only (`web/ws.ts`'s app-level `{t:"ping"}`, every 12 s), which covers the PHONE noticing a dead link and never the HOST: a phone that sleeps, or a tailnet that flaps, leaves a half-open TCP socket that `ws` reports as OPEN for as long as the kernel keeps it. Such a socket stayed in `clients` and stayed attached, so every repaint was queued for it in memory without bound, and `isAttachedToSomeone` counted it as a person watching — which kept `lingerSweep` and the plugins' `watched` set from ever letting an automatic session go. Two fixes, both invisible on the wire (no new frame, `PROTOCOL_VERSION` unmoved): **(1) liveness** — each socket is pinged at the PROTOCOL level every `WATERPLANE_WS_PING_MS` (20 s), which browsers and `ws` answer by themselves; a socket that misses two pings in a row (`pingTick`) is `terminate()`d — not `close()`d, whose handshake a dead peer never completes — and that runs the ordinary close path (netstats records a 1006, `recomputeWatched` runs). Two and not one because a ping can sit behind a backlog that is still draining. **(2) PTY backpressure** — the `data` fan-out, and nothing else, checks `ws.bufferedAmount`: past `WATERPLANE_WS_PTY_BACKLOG_BYTES` (1 MiB) a delta is skipped and the session marked starved for that socket; the first frame after the buffer drains is ONE `full: true` replay off `attachReplay(id, undefined)` — the attach route's exact shape — in place of the delta (`ptyFrameAction`). `seq` already counts the chunk when `data` fires, so the replay's `seq` is that frame's and the client's resume point stays exact; the client already resets its terminal on `full`. Acks, prompts, history and every other frame are never skipped: a repaint can be redrawn from scrollback, a receipt cannot be re-derived. Known cost, accepted: a socket that re-attaches while starved gets the attach replay and then one redundant full replay on the next chunk. Pinned by `packages/host/test/liveness.test.mjs` and `e2e-wsliveness.mjs` (a `ws` client with `autoPong: false` is closed 1006 within ~1 s at a 300 ms ping while an answering one stays open).
- First paint is decoupled from the WS handshake: the launcher seeds `sessions`/`recent`/`closed`/`repos` from a localStorage snapshot (`waterplane.snap.*`) and hydrates when the live lists arrive — so an asleep host / warming Tailscale path doesn't leave the launcher blank. A FIRST-EVER offline load has no snapshot to seed from, and used to paint nothing at all; that case now renders skeleton rows plus an explicit `CloudOff` card with the connection hints, after the same grace window the reconnect banner uses. The service worker serves the app shell cache-first (stale-while-revalidate); build-hash cache names + the `controllerchange` reload keep it fresh, so no network RTT is paid on load.
- **A receipt window that expires must not spend the give-up budget.** Each attempt arms an ack timeout (`ACK_TIMEOUT_MS` 6 s; **ops get `OP_ACK_TIMEOUT_MS`, 20 s** — the host answers `op.ack` on ACCEPT, so it is pure round-trip budget, and a phone reaching the host through a DERP relay regularly needs more than a keystroke's window). On expiry the entry goes back to `queued`, and the attempt is **rolled back when the socket was not open** — nothing reached a host that could answer, so counting it spends `MAX_SEND_ATTEMPTS` on the network being down, which is the one condition the queue exists to ride out. Eight 6-second windows go by in under a minute: that is how "open a session here" ended up permanently `failed` ("delivery kept failing · 8 attempts") while the tunnel was still coming back. A `failed` entry is also **retryable by hand** (`sendQueuedNow` resets status/attempts/`ts` and re-arms it, same ackId — the ledger is what makes that safe); before, a failed OP could only be deleted, since an action has no text to restore into a compose box. **A dead socket requeues its `pending` entries immediately** rather than letting each one sit out its deadline: a `submit` window is 90 s and a pending entry HOLDS ITS LANE, so a tunnel that dropped mid-send would otherwise park everything behind it for a minute and a half with the link already back. Safe because the re-send carries the same ackId — a host mid-delivery joins it, a settled one re-acks. Window sizes come from `ackWindowFor()`: delivery budget for a `submit`, and for an op the MEASURED p95 ping (`link.ts`'s `rttP95()`) rather than a fixed 20 s, widening per attempt — a retry that keeps missing the same deadline is evidence the deadline is too small for this link, and waiting longer is cheaper than spending another of `MAX_SEND_ATTEMPTS` proving it. **And the cap is a count, so it is floored by a clock it cannot outrun** (`MIN_TRY_MS`, 60 s, passed to `selectSendable` as `minTryMs`, measured off `firstTryAt` — the first attempt, never reset): eight windows dropped by a radio in a lift are eight facts about the lift, and "delivery kept failing" said fifteen seconds after the tap is a verdict on the link wearing the message's clothes. **Past the floor the entry still does not die.** Running out of attempts is the end of a ROUND (`nextRound` in `core/queue/send.ts`): `attempts` resets, `round` does not, and the entry waits `roundDelay(round)` — 5 → 10 → 20 → 30 minutes, capped — before trying the whole ladder again, for ever. Only a delivery the host ANSWERED and refused is ever `failed`, because only then has anybody decided anything; a delivery nobody answered is a fact about the tunnel and the tunnel comes back. Safe to repeat indefinitely for the same reason every retry here is: the durable Intent store keys at-most-once on the ackId and re-acks work it has already done.
- **`input.ack` is idempotent, and that is load-bearing.** `main.ts` keeps a bounded, expiring ledger of ackIds it has already handled; a repeat is re-ACKed with the original verdict and the bytes are NOT written again. The phone's send queue (`web/outbox.ts`) relies on this: unsent text lives in localStorage and is re-sent with the SAME ackId on reconnect, which would otherwise type the prompt twice — the client-retry twin of the at-most-once rule `deliver.ts` enforces for the backlog. Never make a retry path that doesn't go through an ackId. Verified by `e2e-queue.mjs`.
- **`session.create` carries `prompt?`** — "open a session here AND run this" as ONE op. It has to be one: offline there is no session id for a `session.input` to name, so a prompt written before the session exists could not be queued at all. The host types it through `deliverToNewSession()` after the create, and the op ledger de-dupes the pair together. Images attached to such a prompt ride in the SAME client lane (`create:<cwd>`) ahead of it, so the files are in `.claude/inbox` before the prompt naming them is typed. **Further prompts are client-side, not a wire change**: the host delivers exactly one prompt per create, and the rest wait in that lane as `pendingCreate` entries until `op.ack` names the session (`bindPendingSession`), then drain like ordinary held sends — a `prompts[]` on the wire would have made the host responsible for turn-boundary pacing it already does better from the client's `holdUntilIdle`. Verified by `e2e-startprompt.mjs` (host half) and `e2e-queue.mjs` (the lane rules).
- **`session.create` carries `replaceSessionId?`** so "relaunch this session with another model" is ONE at-most-once op: the host kills that session (if alive) and only then creates the new one. Sending a bare `session.kill` next to a durably-queued create is the trap — the kill is droppable and the create is not, so an offline relaunch whose tab was killed would replay only the create and leave two `claude` processes in one worktree.
- **`op.ack` is the same contract for ops.** `session.create`, `fanout.run`, `fanout.followup`, `build.run`, `schedule.save` and `schedule.run` accept an optional `ackId` and answer `{ t: "op.ack", ackId, ok, reason?, sessionId?, runId? }` where `ok` means *accepted and started*, not *finished*. Same ledger, plus an in-flight map for the retry that races the first delivery, plus on-disk persistence so a host restart can't turn one queued sweep into two (see `acks.ts`). `session.create` also takes an optional **`replaceSessionId`** — "relaunch with different flags" as ONE op: it kills that session (a target already gone is not an error) and only then creates. Split into a separate `session.kill` the pair is not atomic, because the kill is a bare socket write the ws layer DROPS while the tunnel is down while the create is durably queued — so an offline relaunch whose tab is then killed replays only the create and leaves two claude processes in one worktree. `session.reopen` is deliberately NOT in this set: nothing sends it and the host has no handler, and an ackId on a message no one handles parks an op that is never acked and retries until it ages out (every reopen goes through `session.create` with `resumeSessionId`, which resumes THAT conversation rather than the directory's most recent — see `e2e-restore.mjs`). Every change is additive, so `PROTOCOL_VERSION` stays 1. Verified by `e2e-opqueue.mjs`. `schedule.save` is the one op whose idempotence does not rest on the ledger alone: it upserts on a CLIENT-minted schedule id, so even a replay past the ledger's TTL overwrites the same row instead of arming a second copy of the same weekly sweep. `schedule.run` fires one off-schedule and shares the fan-out lane, because either way it is a herd of `claude` processes.
- **`backlog.add` is idempotent too, when it carries an `ackId`.** Same ledger, same reason as `input.ack`: the phone can queue a work item while offline and re-send it on reconnect. The receipt is `backlog.ack` (it names the item id, and a repeat names the same one). An `ackId`-less `backlog.add` (the Backlog sheet's own add, which only runs online) is unaffected.
- **The queue bar counts seconds, not vibes.** The in-flight branch of `renderQueueBars` said only "Sending…" with a spinner — and an op's receipt window is `OP_ACK_TIMEOUT_MS` (20 s), so twenty silent seconds were indistinguishable from a dead tap. Each attempt now stamps `OutboxEntry.sentAt` (distinct from `ts`, which is queue time and is what bounds retries/expiry), the bar reads elapsed off the OLDEST in-flight attempt, and past the ack window it says "no receipt yet, will retry" rather than leaving the spinner to imply forever. A 1 s repaint ticker runs ONLY while something is `pending` — the outbox state changes on writes, so the counter would otherwise sit frozen for the whole window.

- **`session.input` carries `submit?`, and the submitting Return lives on the HOST.** This is the fix for compose sends that silently disappeared. The old contract was: host writes the bytes, answers `input.ack ok`, the client drops the outbox entry, and 50 ms later the CLIENT fires the Return as a bare, unacked `session.input "\r"`. Everything about that gap is hostile — the ws layer parks an undeliverable send in a RAM-only queue, and the reconnect watchdog *reloads the page*, which is exactly when the tunnel is flapping — so a socket dying in it left the prompt typed-but-unsent in the composer with the queue entry already gone and the UI saying "sent". Nothing on either side could report it. With `submit`, the host runs the same `deliverPrompt()` the backlog and the fan-out use: type, confirm the echo on the RENDERED screen, press Return, and on a hooked session re-press until the turn provably starts. The receipt therefore means *the prompt is running*, not *bytes reached a file descriptor*, and `input.ack` carries a `state` saying which of the four outcomes it was — `ok`, `notready` (provably nothing typed; the ONE auto-retryable case, and the host deliberately does not remember that verdict so a retry gets a real second attempt), `unconfirmed` (written, never seen — must not be auto-retried), `unsubmitted` (in the composer, Return swallowed — say so, never retype). Because the delivery is now ASYNC and takes seconds, `inputsInFlight` is load-bearing in exactly the way `opsInFlight` is: the phone's retry routinely arrives while the host is still typing, and without it the ledger (which only learns the verdict when delivery settles) would let it start a second delivery. The client's receipt window for these is `SUBMIT_ACK_TIMEOUT_MS` (90 s) — not round-trip budget but delivery budget, and a socket that actually dies is caught by the disconnect requeue, not by that deadline. A `submit` send must NOT also send `session.record`: the host records it, and only once the text provably echoed. Verified by `e2e-submit.mjs`.
- **`input.settle` → `input.settled` re-decides a delivery whose verdict was ambiguous.** `unconfirmed` and `unsubmitted` are correct at the moment they are given and useless afterwards: neither may be auto-retried (retrying what may already be there is what stacked five copies of one prompt), so a queue row for a prompt whose fate is knowable minutes later sat there for ever. This is the question, not a send: the host reads the CLI's own conversation log and the rendered screen (`settle.ts`) and answers `landed` / `composer` / `absent` / `unknown` having typed **nothing**. It carries the text and the queue time because the host deliberately keeps no copy of an un-acked prompt anywhere it could be resurrected from, it is batched (a phone settles its whole failed queue at once, usually all in one session ⇒ one transcript parse) and capped, and it is deliberately NOT in the durable-op set — asking twice costs a parse and nothing else. The client acts on the answer: `landed` drops the row, `composer` restates it, `absent` re-sends ONCE under a NEW ackId (the old one's `ok:false` is remembered and would be replayed) and only inside `QUEUE_TTL_MS`, `unknown` is never turned into an action. Verified by `e2e-settle.mjs`.
- **`session.input` carries `expectPrompt?`, and that is what makes answering a question OFFLINE safe.** Every other queued message is TEXT, where landing late is merely stale. An answer is a KEYSTROKE aimed at whatever box is on screen when it arrives: "2" is the option you read while that box was up, and four minutes later it answers a different question — or, with no box at all, drops a stray digit into the composer that the next Return submits as a prompt. Nothing downstream can tell the difference, so the answer names the question it answers. `shared/promptid.ts` derives `promptFingerprint()` from the published `DetectedPrompt` (kind, question, every index paired with its label, and `multi` — a digit TOGGLES a row in a checkbox box rather than answering it), the client stores it on the outbox entry, and the host compares it against the prompt it currently has live. A mismatch — including "no prompt at all" — is refused with `input.ack` state `stale` and NOTHING is written; it is never `retryable`, because a retry can only get staler, and the verdict IS remembered so the phone's re-send gets the same answer rather than a fresh, differently-wrong attempt. Both sides fingerprint the same object, so this is exact equality, not a fuzzy match against re-scraped screen text. Deliberately never combined with `submit`: a dialog takes raw keystrokes, not `deliver.ts`'s type-echo-Return composer path. Three client-side consequences worth keeping: an answer is `armed` by construction ("sends itself when the link is back" is the whole feature, and the staleness check is a better guard than a reconnect prompt nobody is there to tap), it is `noTtl` (see the shared bullet — the guard is exact, so a question answered in a tunnel with the link back an hour later is the case to SERVE), and it JUMPS its lane: prose queued behind it would otherwise be typed into the open dialog instead of run. Verified by `e2e-answer.mjs`.
- **A human interjecting is not the same as automation firing.** `deliverPrompt(..., { interactive: true })` waits only for the TUI to stop mid-draw, never for the turn to end. The backlog and the fan-out must wait (their instruction is a new task, and dropping it into a live answer loses it); a person typing at a working agent means the opposite, and sharing the waiting behaviour would silently turn every compose send into the "hold until idle" mode the app offers as a separate, explicit choice — parking the prompt on the host for 45 s and then answering "not ready". The cost is the Return proof: `turnActive` is already true when you interject, so the delivery falls back to the same press-and-look guess a non-hooked session gets.
- `session.input` writes raw bytes into the PTY. Sending text + Return as one chunk can be interpreted as paste by Claude's TUI — split into two writes with a small delay if Return isn't recognized as a submit keystroke (see `core/compose/useCompose.ts` `sendCompose`).
- **`pull.*` is host-queued, device-acked-by-nobody.** `pull.get`/`pull.save` carry a repo's auto-download rule, `pull.list`/`pull.new` carry the queue (sent on hello, so a phone that was offline when the file landed still learns about it), `pull.add` queues one file by hand, `pull.dismiss` drops one or all. Deliberately NOT in the durable-op set: these are small, idempotent and re-issued by the next tap, and the thing that must survive a bad link — the bytes — is not on the socket at all. Which device already HAS a file is never sent to the host: several phones can subscribe to one host, so "done" is per-device state in `web/pull.ts`. Additive, so `PROTOCOL_VERSION` stays 1. Verified by `e2e-autopull.mjs`.
- **`settings.*` carries the user's own settings, and the host never parses them.** `settings.set { key, value, ts }` stores one raw localStorage string; `settings.all` (sent unprompted on hello) and a `settings.update` broadcast carry them back. Three rules: the update goes to EVERY socket including the writer's (the echo is what confirms the write landed, and a client applies one only when `ts` beats what it holds, so the round trip cannot loop); an OLDER write is answered with the winning value rather than dropped; and the key must be on `SYNCED_SETTING_KEYS`, which is why the send outbox can never travel to a second device. Additive, so `PROTOCOL_VERSION` stays 1. Verified by `e2e-settings.mjs`.
- `PROTOCOL_VERSION` in `shared/src/index.ts` exists for future breaking changes; bump it deliberately.

### The notify link: a socket sent only what it acts on

The APK's `ShellLinkService` holds its own WebSocket so alerts arrive with the app closed, and reads
exactly `notification`, `authRequired` and `pull.new`. Until 2026-10-13 the host treated it as a full
client — every broadcast plus ~20 snapshot frames per reconnect — and each one woke the phone's radio
and CPU to be thrown away, on a link that never sleeps. Now `server/clients.ts`'s `send` is the ONE
filter: a socket whose role is `notify` gets `NOTIFY_LINK_FRAMES` (`shared/wire/notifylink.ts`, plus
`pong` when it asks) and nothing else; `onHello` builds no snapshots for it; `routes/index.ts`
accepts only `hello`/`ping` from it, so it can never attach or count as watching. The role is
`hello.role: "notify"` (APKs built after this) or, as the fallback for every APK already installed,
a `User-Agent` starting `okhttp/` at the upgrade — the WebView sends a Chrome UA. The explicit role
wins. Additive, `PROTOCOL_VERSION` unchanged. `e2e-notifylink.mjs`, `shared/test/notifylink.test.mjs`.

### Security model

No app-level auth on the trusted path. **Tailscale network identity is the boundary.** The daemon spawns `claude` (which can execute arbitrary code), so never bind it to a public interface. `WATERPLANE_HOST` defaults to the Tailscale IP, then loopback — keep it that way. `SECURITY.md` is the public statement of this threat model; keep the two in sync.

**Network identity does not cover browsers** — see `origin.ts`. A WebSocket ignores the same-origin policy, so being on the tailnet is not required to reach the daemon from a browser that IS. Every `/api/*` request and WS upgrade is origin/Host-checked before anything else (including the auth endpoints, so a drive-by page can't brute-force the password). Never reintroduce `access-control-allow-origin: *`. The response also carries `timing-allow-origin` — the same reflected origin, so the phone's own data-usage readout (`web/link.ts`) can read Resource Timing byte counts for the cross-origin images the Android shell loads; it exposes timing detail to a caller that already passed the gate, and nothing else.

File and scaffolding endpoints (`files.ts`, `git.ts`, `scaffold.ts`) must enforce containment guards because the phone supplies paths; the e2e scripts assert these. Don't loosen them. `scaffold.inRoot()` compares **realpath-resolved** paths — on macOS `/var` is a symlink to `/private/var`, so a naive string compare makes every legitimate path look like an escape (and, in the other direction, would let a symlink out of the root through).

`GET /api/slash?cwd=` lists `<cwd>/.claude/commands`, so `cwd` goes through `containRepoDir` like every other directory a client names; a refused or absent one falls back to the root (the composer's list keeps working) and never lists a path outside it. `e2e-rootguard.mjs` asserts it.

`POST /api/hook` (the claude hook sink) is **loopback-only** — hooks always run on this machine, so it refuses any non-`127.0.0.1`/`::1` caller even though a Tailscale peer could otherwise reach it. It also no-ops on any payload that doesn't match a known session, so it can't drive a session a caller doesn't already know the id/cwd of.

`/api/agent/intents` (`agentintents.ts`) is the second loopback-only route, and it is stricter than the hook sink for a reason the hook sink never met: **`tailscale serve` terminates HTTPS and forwards to `127.0.0.1`**, so the phone's own requests through the front door arrive FROM LOOPBACK. The remote address alone cannot tell an agent's `curl` from the phone, so `agentCallerRefusal` also refuses a proxied request (`X-Forwarded-For`, `Forwarded`, `Tailscale-User-Login`) and any browser (`Origin` or `Sec-Fetch-Site` present — `origin.ts` already stops a cross-origin page; this stops the same-origin one too, because an agent's curl sends neither and the phone has its socket). What it may do is no more than the phone's `intent.post`: the one shared `postClientDraft`, the same `containRepoDir` gate, no budget waiver, and the `agent` origin it stamps cannot be claimed over the socket.

**LAN password gate (`auth.ts`).** When the LAN interface is bound (`WATERPLANE_ALLOW_PUBLIC=1`) the Tailscale-identity boundary no longer covers same-WiFi devices, so LAN connections are password-gated. Every socket's remote address is classified (`net.peerKind`): **loopback** always trusted (the management path); **tailscale** trusted unless the optional `gateTailscale` toggle is on; **lan/other** always need a valid token. Password is scrypt-hashed in `<root>/.waterplane/auth.json`; a correct password (`POST /api/auth/login`) mints a device token delivered as an httpOnly cookie the browser replays on fetch + the WS upgrade. **Deny-until-set:** with no password configured, LAN is refused outright (no token can be valid) — set one first from the trusted path. HTTP gates in `server/http.ts` (401 before `handleApi`); the WS gate sends `authRequired` then closes; auth endpoints + static assets stay ungated so the login page can load. Management (`auth.set`/`auth.clear`/`auth.gateTailscale`) is refused from any non-trusted socket — **LAN can never set the password**. Changing/clearing it drops every device row (every gated device re-logs). Managed from the phone via Settings → LAN access (over Tailscale). Client shows a full-screen login takeover on `authRequired` (`features/authGate`); `ws.ts` stops auto-reconnecting while gated until `reconnect()` after a successful login.

**A corrupt `auth.json` never opens the gate.** It is moved to `auth.json.corrupt-<ts>` (`readJsonGuardedDetail`) and the host boots with no password: deny-until-set refuses every LAN peer, and every token — the ledger outlives the file — is refused by `deviceFor`. The one thing a lost file could OPEN is `gateTailscale`, so when the damaged bytes mention it (or could not be read at all) `AuthManager.lost.tailscaleGated` keeps Tailscale refused too, until a person sets or clears the password from loopback (never gated); a new password keeps the gate on, and turning it off is its own tap. `main.ts` puts an `info` feed row up saying which (`authLostNotice`). Bytes that never mention the toggle leave Tailscale trusted, as a fresh host does — locking the phone out of its own host on every corruption would be the larger harm. `packages/host/test/jsonstore.test.mjs`.

**Device tokens and the ledger (`deviceledger.ts`, `auth.ts`).** Every token is one row of `<state dir>/devices.json` (0600): `{id, name, createdAt, lastSeenAt, lastKind, tokenHash}`. The token is 32 random bytes base64url, returned ONCE; the file holds only its sha256, and `lookup` compares the hash against every row with `timingSafeEqual` and no early exit. Why a ledger and not the old in-memory map: the Android shell cannot use the cookie (Capacitor's `http://localhost` origin makes it cross-site, and `SameSite=Lax` withholds it), so it needs a token it keeps itself — and a token that lives on a phone has to survive a host restart and be revocable one device at a time, which is also what lets Settings list "Paired devices". `lastSeenAt`/`lastKind` are written at most once per `DEVICE_SEEN_THROTTLE_MS` per device, so a busy socket is not a disk write per request. **A password change DROPS every row rather than clearing the hashes**: each gated device must log in again anyway, and a tokenless row would be a device in the list that can do nothing. `AuthManager.deviceFor` answers null for every token while no password is set — deny-until-set holds even if a `devices.json` outlives its `auth.json`. The ledger caps at `DEVICE_LEDGER_MAX` rows (least recently seen dropped) because a browser re-login mints a row — a re-login replaces the caller's own row when it still carries the old cookie.

**Where a token rides (`tokenFromRequest`).** Cookie first (the PWA), then `Authorization: Bearer <tok>` (the shell's fetch/XHR), then a `waterplane-tok.<tok>` entry in `Sec-WebSocket-Protocol` (the shell's socket — a browser WebSocket can set no other header). The client offers `["usmc", "waterplane-tok.<tok>"]`; `selectWsProtocol` (the server's `handleProtocols`) selects the first NON-token protocol, so the token is never echoed in a response header — and a client that offers only the token gets no protocol selected, which a browser treats as a failed handshake. `Authorization` is in the preflight's allowed headers, and **a CORS preflight is answered ahead of the token gate** (after the origin gate): a preflight never carries credentials, so gating it made every Bearer request from a LAN phone die at a 401 `OPTIONS` before the real request was sent. It answers headers only; no route runs.

**Minting without a password over the tailnet (`POST /api/auth/token {deviceName}`).** Pre-gate like the other `/api/auth/*`, but it checks trust itself: `!needsToken(kind) || validToken` — so loopback, an ungated Tailscale peer, or a device that already holds a token may mint, and nothing else — AND a password must be set (403 otherwise; such a token could never pass the LAN gate). → `DeviceTokenResponse {token, deviceId}`, `cache-control: no-store`. `GET /api/devices` → `DeviceListResponse` with the caller's own row `current`; `POST /api/devices/revoke {id}` → `DeviceRevokeResponse {ok, revoked, closedSockets}` deletes the row and closes that device's live sockets whatever route they came in on. Both sit behind the normal gate, so an unauthenticated LAN caller reaches neither.

**LAN identity (`lanid.ts`, `authroutes.ts`, `ratelimit.ts`).** A phone on plain-HTTP Wi-Fi cannot tell the desktop at `192.168.1.20:8770` from whatever else answers there after a DHCP shuffle or on a hostile network, and it is about to send its token there. `.waterplane/lan-identity.json` (0600, created lazily) holds `{hostId, secret}`; `GET /api/lan/identity` → `{hostId, secret, hostName}` is refused (403) for every kind but loopback/Tailscale **before** the token gate (a LAN token never unlocks it) and passes the normal gate after (a gated Tailscale peer still needs its token). `POST /api/lan/verify {nonce}` (16–128 printable chars) → `{hostId, mac}` with `mac = hex HMAC-SHA256(key = the secret STRING's UTF-8 bytes, hostId + "\n" + nonce)`; it is pre-auth and rate-limited per remote IP (`RateLimiter`: 10-deep bucket, one per 2 s; memory only, pruned). The phone checks the MAC before EVERY LAN connect and sends its token only after a good one. **Residual, stated in `SECURITY.md`:** a relay on the person's own Wi-Fi that forwards the probe to the real desktop passes the check and then sees plain HTTP; nothing short of TLS on the LAN resists that. `welcome` carries `hostId` (this identity's), `hostName` (the OS hostname minus `.local`) and `deviceId` (only when the socket authenticated with a ledger token). The doctor's `lan` line: quiet unless `WATERPLANE_ALLOW_PUBLIC=1` actually binds a LAN address; warn when bound with no password (deny-until-set refuses every LAN device); ok "LAN ready at http://x:port (password set, identity …)".

**Pairing a new phone (`pair.ts`).** A trusted phone mints a code (`POST /api/pair/mint`, behind the gate, `mintedBy` its device row) and shows `<serve https URL, else http://<tailscale IP>:port>/pair/<code>` as a QR. The code is `newPairCode`'s 8 characters, held **in memory only, as its sha256** — a restart invalidates every outstanding code, which costs "show a new QR" and means no file ever holds a live credential. Lookup hashes and compares against every entry with `timingSafeEqual`, no early exit. TTL `PAIR_TTL_MS` (`WATERPLANE_PAIR_TTL_MS` shortens it for e2e only), at most `PAIR_MAX_OUTSTANDING` (5) live — a sixth mint drops the oldest — and spent by the first successful **redeem only**: the landing page and the APK download do NOT spend it, because the new phone does both before it has an app that can redeem. A spent/expired code is remembered one more TTL only so the phone can be told `used`/`expired` rather than `unknown`. `POST /api/pair/redeem {code, deviceName}` is pre-auth (the code is the credential), rate-limited per IP (burst 5, one per 10 s): it answers `{ok, host:{name, base, httpsUrl, lanBase?}, token?, deviceId?, lanIdentity?, note?}`. A token (a ledger row named `deviceName`) only while a password is set; with none, loopback/Tailscale gets `note` saying no token is needed there, and a LAN peer is refused `no-password` **before the code is spent**. `lanIdentity` goes only to a loopback/Tailscale redeemer, as `GET /api/lan/identity` does. `lanSsids` is never filled by the host — it does not know which Wi-Fi it is on; the phone adds those. `GET /pair/<code>` renders a self-contained page (no script, inline CSS, light/dark) naming the desktop, "Use web version" (the https serve URL, or the http one plus the `tailscale serve` sentence), "Download the Android app" (`/pair/<code>/apk`, the newest of `WATERPLANE_APK_PATH` and gradle's `dev`-flavor `app-dev-debug.apk` (the owner's sideloadable build; the `play` flavor is never handed out here), streamed as `application/vnd.android.package-archive`; with none, a sentence instead of a button) and the typed fallback (address + `ABCD-EFGH` + the `waterplane://pair` deep link). **The code is checked before anything about the desktop is looked up**: malformed, unknown, expired, spent and rate-limited all render the same plain page. `/pair/*` is outside `/api/` — no origin check (a top-level navigation), no token gate (the new phone has none), never the SPA fallback, never in `OPAQUE_READ_ROUTES`.

**Passive devices (`passive.ts`, R-connection-011…014).** The kids' phone: it should get app updates and nothing else, and the owner sometimes needs full waterplane on it. A pairing code minted with `{passive: true}` (refused with no password — a passive phone without a token would be a full one on Tailscale) redeems to a ledger row with `scope: "passive"`; existing rows have no scope and are full. **The host is the boundary, the phone's one screen is a courtesy.** In `server/http.ts`, after the 401 check, any `/api/` request whose token is passive and not unlocked must pass `passiveAllows` — a default-deny list of exact read-only paths (health, web bundle, theme, `/api/passive/state`) plus `GET /api/repos/<id>/artifact` only for an APK the auto-pull queue holds RIGHT NOW (`queuedApkIn`), so it is not a read of the whole repo. A route added anywhere else is refused (403 `{passive: true}`) until someone adds it to that list on purpose. The WebSocket is closed `4403` at the upgrade (not `authRequired`: a password would not help). `/api/auth/token` refuses a passive caller even while unlocked — a minted full token would outlive the unlock. **No tokenless path:** redeeming a passive code stores `gateTailscale: true`, and `AuthManager.gateTailscale()` is also true while any passive row exists; `setGateTailscale(false)` throws a sentence until it is revoked. The gate used to miss every request through `tailscale serve` — those arrive from 127.0.0.1 — so the gate now classifies a loopback request carrying a `PROXY_HEADERS` header as `tailscale` (`requestPeerKind`; only ever a downgrade, `localProcessRefusal` unchanged). No Tailscale tags, whois or ACLs (the owner declined them). **Unlock:** the PIN is scrypt-hashed in `<state>/passive-pin.json` (0600; corrupt ⇒ no PIN ⇒ no unlock), set via `POST /api/auth/pin {pin|null}` only from `canManage(kind)` with a valid token when that path is gated and never from a passive row, unlocked or not. `POST /api/auth/unlock {pin}` (rate-limited per DEVICE: 5, then one a minute) lifts that row for `PASSIVE_UNLOCK_MS` (30 min; `WATERPLANE_PASSIVE_UNLOCK_MS` shortens it for e2e) in memory only, so a host restart comes back locked; a timer closes the device's sockets at expiry and the clock is re-checked on every read. `POST /api/auth/lock` ends it at once; a new PIN ends all. `/api/auth/status` adds `scope`, `unlockedUntil`, `pinSet`. Tests: `packages/host/test/passive.test.mjs`, `scripts/e2e-passive.mjs`. Not covered: the Android `ShellLinkService` needs the socket, so a passive phone gets new builds while the app is open (the screen polls), not in the background.

**Peer tokens (`peers/store.ts`, `peers/routes.ts`).** A paired desktop calls `/api/peer/*` with `Authorization: Bearer <tok>` and the `PEER_API_HEADER` version header. The device-token gate in `server/http.ts` stands aside for that prefix and `peers/routes.ts` checks instead, in this order: trusted-path kind (`peerKind`, never lan/public), peer bearer token against `peers.json` (inbound rows hold only a sha256; unknown ⇒ 403 "not paired", logged with the remote address), version header (409 naming both versions). A device token is simply not in that ledger, so it never unlocks the prefix, and a peer token never passes the device gate for anything else. `/api/peers` (pairing management) sits behind the ordinary gate AND `canManage(kind)`. Peer tokens live in their own ledger, so a password change does NOT rotate them; unpairing is the revoke. `peerAddressOk` (shared) accepts only 100.64/10, `*.ts.net` and 127.0.0.1 with a port, never `*.local`. This widens nothing: a tailnet client without an `Origin` could already drive a host over `/ws`; pairing makes delegation named and refusable.

### Secure context caveats

**The phone is told when it's on the wrong door.** `welcome.httpsUrl` was only listed in Settings → Connection, which nobody reads while things work — so a plain-HTTP session (`isSecureContext === false`) with a discovered HTTPS front door now shows a banner with a one-tap switch (`InsecureBanner` in `core/Banners.tsx`), dismissible for a week (`INSECURE_SNOOZE_MS`), never permanently: the failure it warns about recurs on every dropped tunnel. Without a service worker there is no cached app shell, so a navigation or watchdog reload while the link is down replaces the entire app with the browser's timeout page.

**Plain HTTP is the failure mode, not just a missing feature.** With no service worker there is no cached app shell, so any navigation while the host is unreachable lands on the browser's own error page and the entire app is gone — queue UI, compose box and all — until the tunnel returns. The app therefore (a) banners the insecure origin with a one-tap switch to `welcome.httpsUrl`, **snoozed for a week rather than dismissed forever** (the problem recurs, so a permanent dismiss just hides it), and (b) makes `ws.ts`'s last-resort reload probe `/api/health` TWICE when no service worker controls the page — the second probe is what turns "the link answered once" into "the link is actually up", since without a shell that reload is unrecoverable.

**This is what gates the PWA.** Settings → Install & offline captures `beforeinstallprompt` and offers a real Install button (iOS gets the Share → Add to Home Screen wording instead, since Safari fires no such event), but none of it — and no offline app shell — can work without a service worker, which needs a secure context. Over plain `http://100.x` the section says so and points at the `tailscale serve` fix rather than showing a button that would do nothing. The send queue itself is localStorage-only and works either way.

**The serve port is not necessarily 443.** `tailscale serve --https=443` claims one slot on the whole machine, and a host may already serve something else there — so the HTTPS front door is discovered, never assumed: `net.ts` `serveHttpsUrl(port)` parses `tailscale serve status --json` and matches on the **proxy target** (`http://127.0.0.1:<our port>`), returning that listener's full URL. Matching a substring of the status text instead is the trap that was there before: the target string contains our port too, so ANY serve config read as "we are fronted", and the URL reported back dropped the listener's port — sending the doctor's advice and the phone's Connection shortcut to whatever else lives on 443. The result rides on `welcome.httpsUrl` (null = not fronted); the client must never rebuild it as `https://<tailscaleDns>`. **The same-origin guard only trusts the bound port, 80 and 443**, so a front door on any other port needs `WATERPLANE_ALLOWED_HOSTS`/`WATERPLANE_ALLOWED_ORIGINS` (name **with** the port) — otherwise every `/api` call is 403 and the WS upgrade closes 1008.

Web Push, service workers, install prompt, and native clipboard all require https or localhost. Plain `http://100.x.y.z` over Tailscale is not a secure context — those features silently no-op. Fix by fronting with `tailscale serve --bg --https=443 http://127.0.0.1:8770`. Everything else (terminal, images, backlog, slash) works fine over plain HTTP.

### Heuristics to know

- **Turn boundaries prefer claude hooks over silence.** When a session's hook pipe is live (`SessionInfo.hooked`), "turn finished / ready for the next command" comes from the `Stop` hook (exact, per-turn) — driving backlog auto-fire readiness, backlog item completion, the turn-finished push, and the plugins' turn-end `question` event. Only sessions with no hook pipe (stub binary, missing `curl`, hooks disabled) fall back to the silence heuristic below. See `sessions.ts` (`onHookEvent`) and `backlog.ts` (`onSessionTurnEnded`).
- **Plugins ride a closed union.** `plugin.*` (`list`/`set`/`enable`/`action`/`sessionToggle`/`sessionAnswer` in; `list`/`actionResult`/`error` out) and `decisions.*` are a fixed set of generic messages, so no plugin ever needs a protocol change — the phone draws what a plugin DECLARES, and runs UI code only from in-repo extensions built into the bundle (plugins.md, "Trust"). Every refusal is a `plugin.error` sentence; `plugin.action` is answered by its `reqId`. None of them carries an ackId: nothing here types into a session except through `answergate.ts`, which is the host's own call, not a client's ([plugins.md](plugins.md)).
- **Hold-until-idle** (the compose bar's third send mode, and a per-entry toggle in `QueueSheet`) waits until the target session can actually RUN the prompt — `laneBusy()` in `shared/queue.ts`, not `turnActive` alone. Three states are quiet and unable to take one: parked on a question (prose typed at an open dialog goes INTO the dialog — it neither runs nor answers, the trap `answerInsertAt` exists for), an unparsable dialog (`awaitingInput`), and blocked on a usage limit (the text is typed at the wait menu). On a `hooked` session the turn stays active while a box is up so the hold already held; on a NON-hooked one `turnActive` is the silence guess and a session waiting for an answer is perfectly silent — so exactly the sessions with no hook pipe were the ones that got a held prompt typed into a Yes/No box. These are the same three facts the host gates backlog auto-fire on (`sessions.autoFireBlocker`), which is the point: "queue for this session" and "hold until idle" are one intent said two ways and must not behave differently. A session that has ENDED is deliberately not busy — parking against a dead session would hold it forever, when the right outcome is one attempt, `ok:false`, and a message. Exact only on a `hooked` session; otherwise it inherits the same silence guess as everything else below, and the UI copy says so. A held entry is exempt from the queue TTL *while* held and gets its clock reset when the lane goes quiet (`selectSendable` reports it in `plan.release`, the client persists `applyRelease`) — without the reset it would be expired one flush after becoming deliverable, which is the opposite of what parking it meant; without clearing the flag on release the clock would reset forever and the retry could outlive the host's 45-min ledger TTL.
- Backlog idle detection (fallback only) = "no PTY output for `WATERPLANE_IDLE_MS` ms" ≈ "turn done". It can fire early if the agent pauses mid-task — which is exactly why hooks are preferred; auto-fire is opt-in and every item is manually advanceable.
- Turn-finished push uses a separate, shorter `WATERPLANE_IDLE_PING_MS` (fallback timing; the `Stop` hook supersedes it when live).
- Prompt detection in `prompt.ts` is regex-based against TUI output — fragile to upstream Claude TUI changes; the e2e scripts pin expected shapes.
- **`limit.first` / `limit.resume` steer the RESUME QUEUE**, and neither is durable. `limit.first { id, on }` pushes a blocked session to the front; `limit.resume { id? }` means "stop waiting for the clock" for one session or for every queued one — still serialized host-side, because resuming N sessions at once is the thing the queue exists to prevent. They are deliberately outside the ackId ledger for the same reason `session.kill` and the backlog mutations are: an ordering decision delivered twenty minutes late is about a situation that has already resolved, and re-issuing it is one tap. The queue's per-session state rides on `SessionLimit` (`queuePos`, `resuming`, `first`) and its host-wide state on `limit.config` (`resumingId`, `holdUntil`) — the hold-off belongs to the account, not to any session. Additive, so `PROTOCOL_VERSION` stays 1.
- Usage-limit detection (`limit.ts`) is the same kind of regex heuristic. Unblocking is verified on idle: after an attempt, only banner text at/after the last `continue` echo counts (the old banner stays visible in the conversation), and a block is only auto-cleared after an attempt or after a TURN HAS STARTED since the block (`turnStartedAt` — the `UserPromptSubmit` hook where the pipe is live, `markSubmitted`'s Return where it isn't). The banner leaving the scan window is never evidence on its own: the block is the last thing in a conversation now sitting quietly at an empty composer, so any repaint that pushes it past the last 6000 chars looks identical to a reset. This gate used to accept `lastRealInputAt`, i.e. ANY non-passive byte — an Esc, an arrow, a digit from the special-keys row. None of those runs a turn, and one landing while the session sat in the resume queue cleared the block with attempts still 0: the session left the queue, no `continue` was typed, and the prompt that hit the wall never ran (`e2e-limitstuck.mjs`). Because a blocked session is silent (data-driven checks never fire), a `WATERPLANE_LIMIT_SWEEP_MS` interval re-scans quiet sessions server-side — detection and recovery need no client attach.
- Mobile resume: `ws.ts` never trusts `readyState === OPEN` on wake (zombie sockets after tab freeze); it ping-verifies (two 1.2 s probes — ANY inbound frame counts as proof of life, not just a pong), closes the socket on Page Lifecycle `freeze`/`pagehide`, and arms a last-resort watchdog that hard-reloads the page if no live socket exists 8 s after the LATEST wake or manual refresh (re-armed per wake, rate-limited, visible tabs only). **The reload is gated on the host actually being REACHABLE** (`/api/health`, 4 s fuse — probed TWICE when no service worker controls the page, since a flapping tunnel answers one request and drops the next and there is no cached shell to land on) — a reload only helps the failure it exists for (a live host behind a wedged page), and over plain HTTP there is no service worker, so reloading into a dead tunnel lands on the browser's own `ERR_CONNECTION_TIMED_OUT` page: the whole app gone, queue and compose box included, until the link returns. `navigator.onLine` does not answer this — a phone on 5G is "online" while the Tailscale path is dead, which is exactly the case that was reloading people into the error page. Compose drafts + outbox live in localStorage, so a forced reload loses nothing. `makeConnection()` is a singleton — `core/conn/useConnection.ts` calls it from a `useRef` initializer that React re-evaluates every render, and per-render `HostConnection` orphans (each with its own reload watchdog) once caused spurious full reloads. Service-worker updates (`controllerchange` in `main.tsx`) defer their pickup reload until the page is next hidden — never mid-interaction.

### The tmux substrate, and the locale that broke prompt detection

From CLAUDE.md, verbatim.

Substrate: tmux is the ONE substrate — each `claude` runs inside a **private** tmux server (`-L waterplane`), so it
survives a host restart and `rediscover()` re-attaches on boot. The server is keyed by socket name,
not `WATERPLANE_ROOT` — which is why e2e roots derive their own, and tests also get a private socket DIRECTORY (`scripts/lib-tmuxiso.mjs`). **Every tmux client is spawned `-u`, out
of `ptyEnv()`, which also supplies a UTF-8 `LANG` when the environment has none** — launchd sets no
locale, and a tmux client that cannot conclude its terminal is UTF-8 does not forward UTF-8: it
redraws box characters as ACS and rewrites every other glyph as `_`. That reached the phone as a
screen full of underscores AND cost prompt detection its `❯`, so a live choice box published
nothing. `e2e-tmux.mjs` boots the host in a deliberately MINIMAL env and asserts `client_utf8`;
inheriting a shell's env there re-supplies the locale and the check passes either way.

### Panning the TUI: who gets the wheel, and why the answer changed

`tmuxscroll.ts` was written on two measurements about the claude CLI, both true in 2026-05 and both
false now:

1. it enabled **no** mouse tracking, so wheel bytes written to its stdin were parsed as an unknown
   escape and dropped;
2. tmux held the history (`history-limit` 100000), so the pan could be translated into `copy-mode`
   + `scroll-up` and get real scrollback back.

Re-measured on claude 2.1.267 (2026-09-19), on every live pane of this desktop:

```
tmux -L waterplane list-panes -a -F "alt=#{alternate_on} any=#{mouse_any_flag} sgr=#{mouse_sgr_flag} hist=#{history_size}"
alt=1 any=1 sgr=1 hist=0        # every running claude
alt=0 any=0 sgr=0 hist=13572    # the panes whose claude had EXITED
```

Both premises inverted at once. The CLI now asks for the mouse itself (`?1003h` + `?1006h`) and runs
in the ALTERNATE screen — and a pane in the alternate screen has no history at all: tmux swaps the
grid, so `history-limit` describes the one it swapped out and `scroll-up` has nowhere to go. So the
translation intercepted a gesture the CLI would have handled and turned it into a tmux command that
could not: panning up did nothing, in every session, which is the symptom the module was written to
fix, arrived at from the other end. It degraded rather than broke — sessions started under the older
CLI kept working, which is why this read as "it got worse" before it read as "it is dead".

The fix is to route on the PANE, never on a version: `paneWantsMouse()` asks tmux for
`#{mouse_any_flag}#{mouse_button_flag}#{mouse_standard_flag}` and, where any is set, `sessions.ts`
writes the wheel bytes through instead of translating them. Two facts make that safe, both measured
rather than assumed:

- **tmux forwards the pane's mouse modes to the outer terminal even with `mouse off`** — the client's
  own output carries `?1000h ?1002h ?1003h ?1006h` — so the modes were never ours to enable.
- **tmux forwards the wheel bytes from the client's stdin straight to the pane**, again with `mouse
  off`: writing `\x1b[<64;1;1M` ×3 into an attached client's pty puts exactly those three sequences
  in front of the program in the pane.

The read is per pan and not remembered: a pane enters and leaves the alternate screen as the program
inside it decides, and a cached answer would hand the wheel to whichever half stopped listening.
Anything unreadable — a dead pane, an unknown format, a failed query — reads as "does not want the
mouse" and takes the translation, because a scroll that does nothing costs a gesture while bytes
written into a program that never asked for them cost a keystroke in a live TUI. The pure half of
that reading (`wantsMouse`) is pinned in `packages/host/test/tmuxscroll.test.mjs`.

### What counts as a miss, in full

CLAUDE.md keeps the rule under Heuristics; this is the argument, with both false alarms.

- **An observation is a miss only if the primary rule was the RIGHT RULE and failed** (Decision 8's
  health record, `shared/clihealth.ts`). A rule correctly declining to fire is a good outcome and
  records NOTHING — not a miss, which turns a working heuristic into a permanent amber chip that
  teaches the one person who can act on the board to ignore it, and not a `good` either, which fills
  the twenty-slot window with successes and makes the real misses arithmetically invisible. Both
  mistakes were made on the live host: prose ABOUT the choice-box detector tripped the cheap gate,
  the strict pass correctly refused to read a paragraph as a box (`prompt.ts`'s `dialogEvidence` is
  what tells the two apart), and `hooksActive` — "has a hook reached THIS host process" — logged a
  fallback for every tmux session a restart handed back with a live pipe. Record where the fallback
  is TAKEN, never wherever a flag happens to be false. `e2e-clihealth.mjs`.
  Earned a third time by **`deliver.submit`**, which read 5 misses of the last 20 — degraded, amber,
  permanent — while the sent log said every one of those five came back `ok`. One code path, three
  different events, and the record was told only the code path: a hooked session with a turn ALREADY
  running is a person interjecting, where `DeliverOpts.interactive` already documents that no
  turn-start exists to observe (records NOTHING — and `good` would be as wrong the other way, filling
  the window with successes nobody earned); a pipe the host had not yet HEARD FROM, whose first hook
  landed 677 ms into that very loop, is the primary rule answering late, so ask again before writing
  the record; only no pipe at all is the fallback worth a word.
  `packages/host/test/deliversubmit.test.mjs` (a fake session manager — a real host cannot be asked
  for those states on demand).
- Limit recovery is verified on idle: only banner text at/after the last `continue` echo counts, and
  **a block clears only after an attempt or a TURN STARTING** (`turnStartedAt`) — never on the banner
  merely scrolling out of the scan window, and never on "real user input": an Esc, an arrow or a
  digit from the special-keys row runs no turn and proves nothing about the account, yet one of them
  landing while the session waited in the resume queue cleared the block with attempts still 0, so no
  `continue` was ever typed and the prompt that hit the wall never ran. `e2e-limitstuck.mjs`.
  Blocked sessions are silent, so a
  `WATERPLANE_LIMIT_SWEEP_MS` server-side sweep re-scans them with no client attached.

## Moved out of CLAUDE.md (2026-10-17)

_Verbatim from CLAUDE.md as of 2026-10-17; CLAUDE.md is the rule — where this text disagrees, CLAUDE.md wins._

### `OPAQUE_READ_ROUTES` — why exactly two

From the Security model bullet on browsers (`origin.ts`), verbatim:

Missing `Origin` is allowed (curl, e2e, hook sink). **Never reintroduce `access-control-allow-origin: *`**, never
  widen `*.ts.net` past the MagicDNS fallback, never reinstate `*.local`. Side-effecting endpoints
  must not be GET (`/api/host/screenshot` is POST for this). That backstop exempts exactly two
  read-only routes (`OPAQUE_READ_ROUTES`: artifact + inbox file, safe methods only) because the
  Android shell loads them as `<img src>`/`<a download>` — no `Origin`, `Sec-Fetch-Site:
  cross-site` — and refusing them killed every thumbnail and every download in the APK. Widen that
  list only for another route that is loaded outside a transport, i.e. one `api.ts` builds with
  `abs()`.

### Secure context — the longer form

Plain `http://100.x` is not a secure context ⇒ no service worker, no push, no install, no clipboard
— and **any navigation while the tunnel is down loses the whole app** (no cached shell). Hence the
insecure-origin banner with a one-tap switch, snoozed a week not dismissed, and the double health
probe before the watchdog reload. Fix: `tailscale serve --bg --https=443
http://127.0.0.1:8770`. **The serve port is discovered, never assumed** (`serveHttpsUrl` matches the
proxy target); a front door on another port needs `WATERPLANE_ALLOWED_HOSTS`/`_ORIGINS` *with* the port.

## Moved out of skill `protocol` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

Prose verbatim as it stood in the skill; the rule stays there.

### `intent.*` — how the client came to READ the store

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

### `session.create` fork — the one stated gap

thing — reopen via `session.create` with `resumeSessionId`. **Forking is not a new message
either**: `session.create` gains `forkAtTurn?` and `"fork"` joins `resumeMode`, so the file write
(`convfork.ts`) inherits `durable: true`, `contain: "cwd"` and at-most-once by ackId — a retried
fork re-acks and writes nothing. One gap, stated: a crash BETWEEN the file write and the ack
replays into a second orphan jsonl — an extra archive row, deletable, never a second claude, which
is `starting`-row semantics exactly.

### The tmux locale trap — what it cost

Substrate: tmux is REQUIRED and the ONE substrate (no direct-PTY mode; the old `WATERPLANE_TMUX` knob is ignored and doctor says so; a missing binary refuses the spawn in words, `tmuxreq.ts`). The private server, the `-u` client, the UTF-8 `LANG` from `ptyEnv()` and the minimal-env `client_utf8` check are in [the tmux substrate section](#the-tmux-substrate-and-the-locale-that-broke-prompt-detection).

### Panning — the translation that was unconditional until 2026-09

**A pan is routed by the PANE, never by a version** (`tmuxscroll.ts`, `sessions.panHistory`): the
phone's flick arrives as one SGR wheel write, and where `#{mouse_any_flag}`/`_button_`/`_standard_`
says the program asked for the mouse the bytes are PASSED THROUGH to it — claude ≥ 2.1 enables
`?1003h`+`?1006h` and scrolls itself — otherwise they are translated into tmux `copy-mode` +
`scroll-up`. Exactly one of the two, read fresh per pan. The translation was unconditional until
2026-09 and by then claude also ran in the ALTERNATE screen, where a pane has no history
(`history_size=0`), so every pan in every session silently did nothing.
[Both measurements.](protocol-and-security.md#panning-the-tui-who-gets-the-wheel-and-why-the-answer-changed)

### Second trim pass (skills review, 2026-10-17) — sentences moved verbatim out of the `protocol` skill

- `no-silent-send` has eight (grep `eslint-disable.*no-silent-send`: `core/session/TermArea.tsx`'s `onResize`, seven in `features/**` — `build` ×3, `capture`, `backlog`, `search`, `hostTools`).
- `input.settle`: asking was the wrong end of the wire (a phone, three tries, over a live socket, about rows that retired an hour later).

## Moved out of skill `heuristics` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

Prose verbatim as it stood in the skill; the rules stay there.

### The Stop hook and `/compact` — the long form

- **A `Stop` hook is the CLI ASKING to end the turn, not the answer — and a hook may answer no.** A
  hook that blocks (`decision: block` — every keep-going loop: a `/goal` hook, a checklist driver)
  sends the reason back in and the CLI carries straight on with **no `UserPromptSubmit`**: the
  continuation is a meta message in the conversation, invisible on the wire. So a live turn
  published `turnActive: false`, the reader said "idle — nothing running" over
  "✻ Crafting… (9m 35s)", and the queue typed into it. The exact signal is therefore held against
  the screen before it is believed (`sessions.ts`:
  `armTurnWatch`/`checkTurnWatch`/`settleStop`, `WATERPLANE_STOP_VERIFY_MS`, 1.2 s): the CLI's own
  working line (`shared/working.ts` — ONE matcher, the matcher the phone's reader shares) printed
  AFTER the Stop is the one thing that may contradict it. Each pass scans only the bytes printed
  since the last one (`seq` delta, no render), the hold is **re-earned every pass** so a
  continuation that ends without a second Stop cannot strand the session busy, and everything else
  settles immediately. `settleStop` is the one end-of-turn path (flag, `stopCount`, capture seal,
  ping, `turnEnded`), idempotent. **Records no health observation** — the hook was answered, not
  broken. `e2e-stophook.mjs`.
- **…and `/compact` announces NOTHING** — no `UserPromptSubmit`, no `Stop` — while grinding for
  minutes ("Compacting conversation… (35s)"). **The same watch covers work that announces nothing
  at all**, armed on OUTPUT for a hooked session with no turn believed: a working line with no turn
  believed publishes one (`setTurn(…, {fromScreen:true})`), retired when the line stops and retired
  QUIETLY — no `stopCount`, no push, no `turnEnded`, because nothing finished a turn.
  **`deliver.ts`'s submit proof reads `turnFromHook()`, never this**: a
  spinner the host inferred is evidence the CLI is busy, never evidence about a Return
  (`e2e-submit.mjs`'s `deaf` case is the pin) — **EXCEPT for the one command that can be proved no
  other way.** `/compact` fires no hook, and the log is silent about slash commands, so the ladder
  filed a compaction at 15% as *"typed, but Return was swallowed"*, the one sentence written to be
  acted on by hand. `shared/slash.ts`'s **`worksUnannounced`** (a set of ONE, held apart from
  `isLocalCommand` — the phone's *is this a modal?* — and `startsNoTurn` — *is there a turn to wait
  for?*) admits `turnFromScreen()` as the bottom rung, **guarded by a snapshot taken BEFORE the
  keystroke** so a session already spinning proves nothing; 3 s per press and two presses, because
  the screen proof lands a window after the paint starts; audit row `submit: "screen-turn"`, kept
  apart because it is weaker. Widening that set hands a command the weakest proof in the file.
  **And the watch reads the RENDERED GRID, never the raw bytes** (`screenlog.ts`'s `gridText()` —
  the live VT the recorder already feeds, a buffer read and not a replay): the byte delta is only
  the cheap GATE, because a repaint interleaves cursor moves and charset escapes and the compaction
  line arrives as `C\x1b(Bo\x1b(Bm\x1b(Bp…` spliced through the previous frame — on screen for two
  minutes, matching nothing. **`shared/working.ts` also reads the PROGRESS ROW as the measurement**
  (block glyphs + a percentage + nothing else, on the row below the phrase): the parenthetical
  arrives half a minute in, and the first seconds are the whole delivery window. A stub cannot
  surface either — both were measured against the binary. The Esc-sweep interlock keeps reading
  plain `turnActive` — an Esc into a compaction interrupts it. `scripts/e2e-stophook.mjs`
  (`STUB_MODE=goal`, which now paints the scattered bytes and ignores a Return at an empty
  composer), `scripts/e2e-submit.mjs` case 7.

### `question.ts` — a box is not the only question

- **A box is not the only question.** `prompt.ts` answers "is the CLI blocked on a dialog";
  `question.ts` answers "did the TURN END ON A QUESTION TO YOU" — the question with NO BOX, the
  commonest way work stops here, and the one that published nothing for the longest. The agent ends
  on "Want 2 implemented, or leave it at 1?" and returns to its composer: nothing is blocked in the
  CLI, so `prompt`/`awaitingInput` are empty, the session reads `done`, the push says "Turn
  finished", and a decision sat unasked. The heuristic existed; it lived inside
  the retired in-core oracle gating a Gemini call, so the detection was conditional on `GEMINI_API_KEY` and with
  no key the tail was never read. Now `sessions.checkAsking()` runs it on the turn-end transition
  and publishes `SessionInfo.asking`. A parsed `prompt` outranks it, a limit block is a clock not a
  question, and any keystroke or a turn STARTING retires it (so a reply typed at the desk clears
  the phone's badge too). The `at` stamp survives re-idles — idle re-enters per repaint, and a
  restarted clock reads "asked 0s ago" for ever. **It is a signal, never an interlock; it blocks
  nothing**: `sessionWall`/`laneBusy` are untouched, because typing into that session is the correct
  move and prose is not a box a queued prompt can fall into.
  `packages/host/test/question.test.mjs`, `e2e-askprose.mjs`.

### Health record — what is and is not a miss

- **An observation is a miss only if the primary rule was the RIGHT RULE and failed** (the health
  record, `shared/clihealth.ts`). A rule correctly declining to fire is a good outcome and records
  NOTHING — not a miss, which turns a working heuristic into a permanent amber chip nobody reads any
  more, and not a `good` either, which fills the twenty-slot window with successes and makes the real
  misses arithmetically invisible. **Record where the fallback is TAKEN, never wherever a flag
  happens to be false**; **ONE observation per EVENT** — a rescue that notes its `fallback` and then
  falls through to a trailing `good` files a miss AND a success for one delivery, which is a rate
  about nothing and a `good` claiming something nobody saw (`deliver.ts`'s echo path, fixed by
  gating the `good` on the echo actually having been seen). And where one code path covers three different events, ask which event this
  is before writing the record: a hooked session with a turn ALREADY running is a person interjecting
  (`DeliverOpts.interactive` — records nothing), a pipe the host has not yet HEARD FROM is the
  primary rule answering late (ask again first), and only no pipe at all is a fallback worth a word.
  The CLI's own inline pickers are that trap from the other side: `/effort` and the slash menus draw a
  REAL footer row and a `❯` cursor with NO numbered options, so footer-plus-cursor filed a miss per
  visit to a menu that was never a question. `dialogEvidence.composer` separates them — the composer's
  STATUS LINE inside the box's span means the CLI still takes typing, and a modal box never draws it.
  Only that line counts: the `❯` INPUT row cannot, since an upstream renumber (`1)`) leaves `❯ 1) Yes`,
  which reads as a composer and is the one miss this signal exists for. **The INTERLOCK is unchanged** —
  a picker taking keystrokes is still a session not to type a prompt into.
  `e2e-clihealth.mjs`, `packages/host/test/deliversubmit.test.mjs`. The false alarms in full:
  [protocol-and-security.md](protocol-and-security.md#what-counts-as-a-miss-in-full).

### Limit recovery — the long form

- Limit recovery is verified on idle: only banner text at/after the last `continue` echo counts —
  asked of the RENDERED GRID (rows below the echo row), and still after the block has CLEARED
  (`attempts > 0`), because a repaint redraws the old banner above the echo and tmux repaints on
  every resize and re-attach (its 5 s start-up redraw is gone, `termqueries.ts`): read off the bytes, that redraw re-blocked a
  session that had just resumed (`e2e-limitrepaint.mjs`). And
  **a block clears only after an attempt or a TURN STARTING** (`turnStartedAt`) — never on the banner
  merely scrolling out of the scan window, and never on "real user input": an Esc, an arrow or a
  digit runs no turn and proves nothing about the account, yet one of them landing while the session
  waited in the resume queue cleared the block with attempts still 0, so no `continue` was ever typed
  and the prompt that hit the wall never ran. `e2e-limitstuck.mjs`. Blocked sessions are silent, so a
  `WATERPLANE_LIMIT_SWEEP_MS` server-side sweep re-scans them with no client attached — **and that sweep
  must not skip a blocked session for being mid-turn**, which is the mirror bug: both paths into
  `checkLimit` hung off silence (`markIdle` at `WATERPLANE_IDLE_PING_MS`, the sweep skipping anything
  newer than that), so a session that came back at the reset and worked for an hour straight, spinner
  repainting every frame, was never quiet enough to be re-asked and wore "at limit" the whole time
  while visibly running. A turn STARTING on a session believed blocked asks directly too
  (`setTurn`), that being the earliest moment the belief can be shown wrong.
- **A turn IN FLIGHT outranks a banner still on screen** (`servingNow`,
  `WATERPLANE_LIMIT_SERVING_MS`). Running `checkLimit` more often fixes nothing on its own: the screen
  branch re-marks the block while `det.blocked` holds, and when `limitlog.ts` answers `unknown` —
  no conversation id, no file, a tail with nothing parseable — there is no dated source at all, so
  the wall sits in the rendered tail for the life of the session and shadows the clearing gate for
  ever. Not "a turn started at some point": `blockedSince` is stamped on the `!was` edge ONLY, so a
  failed auto-continue leaves `turnStartedAt > blockedSince` true for the rest of a block that is
  entirely real. **DURATION is what separates them** — a rejected turn dies in seconds, the banner
  being the CLI's answer to it — and a resume in flight is excluded outright, that window belonging
  to `releaseResume`'s verdict. `e2e-limitbusy.mjs` pins both rules, with the banner deliberately
  left ON SCREEN: scrolling it off passes for the easy reason.

### One at-limit fact, one colour

- **One at-limit fact, one colour** (`--limit`, web `styles.css`). The same three blocked sessions
  read as starred (`.tag.limit-auto` in the star's gold), waiting (`.tag.wait`'s red fill, for the
  manual case), broken (`.repo-group-stat.limit` in `--dead`) and blocked (`.head-wait.limit`'s
  orange) depending on which line of the launcher you looked at, plus a red `.key.danger` in the
  session toolbar beside the kill button. All five are `var(--limit)` now; only the manual one is
  filled, because it is the only one that needs a hand.

### `claudeversion.ts` — the build the heuristics were last verified against

`TESTED_CLAUDE_VERSION` is the newest `claude` build a person last checked the screen-reading heuristics against (what `claude --version` said on the dev desktop). Bump it when you re-verify. `claudeNewerThanTested(raw)` returns a warning sentence only when the installed build is NEWER; older is never warned (no minimum is claimed, the launch flags have no recorded first-supported version) and an unparsable version is absent, not a warning about nothing. It never refuses a session.

**2.1.304 (2026-10-20), and what that vouches for.** Bumped by the owner on evidence, not a read-through: eight of the ten clihealth signals have a harvested 2.1.304 fixture that its reader passes (`harvested.test.mjs`), and the real-CLI smoke (`scripts/smoke-real-cli.mjs`) drove a 2.1.304 session through the unnumbered trust box, a delivery and a turn. Not vouched by any 2.1.304 capture yet: the context meter and the limit notice (only the live host can capture them) and `/fork` interception, which the smoke does not exercise.

### `clisuggest.ts` — the CLI's proposal for the next prompt

After a turn claude draws a suggested next prompt in its EMPTY composer in DIM (SGR 2). The host publishes it as `SessionInfo.cliSuggestion` and the phone offers it as one tap. Two reads of the same composer decide it: the PLAIN render holds the words, the render with dim cells blanked (`RenderRow.undimmed`) holds nothing; words that survive the blanking were typed and are never a proposal. The first-run placeholder `Try "how does <filepath> work?"` is refused by shape. `CLI_SUGGESTION_MAX` caps a misread. Null on any doubt.

### Second trim pass (skills review, 2026-10-17) — sentences moved verbatim out of the `heuristics` skill

- `askbox.ts` `pickAsk`: two sharing "Yes"/"No" gave question 1's id, descriptions and head to a screen showing question 2.
- `/compact` watch: A stub cannot surface either; both were measured against the binary.
- health record: A rule correctly declining to fire is a good outcome and records NOTHING — not a miss, and not a `good` either, which fills the twenty-slot window with successes and makes the real misses invisible. ONE observation per EVENT — a rescue that notes its `fallback` and then falls through to a trailing `good` files a miss AND a success for one delivery (`deliver/deliverrun.ts`'s echo path: gate the `good` on the echo actually having been seen). Where one code path covers three events, ask which this is first: a hooked session with a turn ALREADY running is a person interjecting (`DeliverOpts.interactive` — records nothing), a pipe the host has not yet HEARD FROM is the primary rule answering late (ask again first), and only no pipe at all is a fallback worth a word. `dialogEvidence.composer` separates the inline pickers — the composer's STATUS LINE inside the box's span means the CLI still takes typing; the `❯` INPUT row cannot count (an upstream renumber `1)` leaves `❯ 1) Yes`).
