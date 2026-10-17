# Architecture & host module map

_Full rationale split out of CLAUDE.md. Index: [docs/notes/README.md](README.md)._

## Architecture

Monorepo, three workspaces:

- **`packages/shared`** — wire-protocol types. `src/index.ts` defines `ClientMessage` / `HostMessage` discriminated unions plus all DTOs (`SessionInfo`, `BacklogItem`, `DetectedPrompt`, `LaunchOpts`, etc). Must be built before host or web. `src/queue.ts` (re-exported) is the send-queue scheduler — pure functions, no DOM: it lives here rather than in `web` because `shared/dist` is node-runnable, so `e2e-queue.mjs` can pin the ordering rules instead of trusting a comment. It also owns `holdUntilIdle` (an entry whose lane is in `busyLanes` is skipped, is exempt from TTL expiry **while held** — it is *supposed* to wait — and keeps its lane position so what is behind it waits too; `armed` does NOT override the busy check). The exemption ends the instant the lane goes quiet, which is why release is its own step: an entry parked against a 35-minute turn is ALREADY past `ttlMs` when it becomes deliverable, so measuring the age from `e.ts` there expired it ("queued too long") on the exact flush that should have sent it. `selectSendable` therefore returns a third list, `release`, and the caller persists `applyRelease()` over its store — fresh `ts`, park flag dropped. It also returns `blocked` — why each queued entry stayed put — because a flush that sends nothing was otherwise indistinguishable from a dead link, and got reported as one (see `queueIdleReason`, and web.md). A blanket TTL exemption would have fixed the symptom and reopened the double-type hole: `ts` also bounds RETRIES, and a retry outliving the host's 45-minute ack ledger (`ACK_TTL_MS`) is a prompt typed twice. It also owns `retargetEntry`/`canRetarget` (move a queued send to another session/repo, or flip input↔backlog) and `pendingCreate`/`bindPendingSession` — the prompts queued BEHIND a `session.create` in its `create:<cwd>` lane. Such an entry is never picked (its `sessionId` is a lane key, not a session, so writing it to the socket would address a session the host has never heard of) and it holds its lane, so the create stays first and what is behind it stays behind; it is also TTL-exempt while it waits, because the wait is for the session to exist and its fate follows the create anyway (the client fails these alongside it). `bindPendingSession(entries, lane, sessionId, now)` runs when `op.ack` names the session: lane rewritten, flag dropped, TTL clock restarted, **ackIds kept** — unlike `retargetEntry`, these entries are provably un-sent, so no host verdict can exist for them and minting new ids would only lose the dedupe. It also owns `answerInsertAt` — where a tapped ANSWER goes in the flat queue, which is neither the end of its lane nor the front. Not the end, because everything queued behind a blocked session is prose and prose typed into a session parked on a dialog goes INTO the dialog (it neither runs nor answers). Not the front, because a checkbox box is answered by several taps that all carry the SAME fingerprint (toggle, toggle, Submit), and jumping each to the head delivers them in reverse and submits the wrong set. Ahead of the lane's first queued non-answer, behind any answer already there, never overtaking a `pending` entry. It also owns `noTtl`, the one exemption from the queue clock: the TTL exists because delivering old TEXT is dangerous in a way nothing can check, and an ANSWER is the opposite — it carries the fingerprint of the question box it was minted against and the host refuses it once that box is gone, so a late answer is either still correct or rejected, never quietly wrong. Expiring one on a clock would discard exactly the case the offline path exists for. `maxAttempts` still binds it, because unbounded RETRIES (not age) are what could outlive the host's ledger. `src/promptid.ts` (also re-exported) is the question-identity half of that: `promptFingerprint`/`promptStillCurrent`, node-runnable so `e2e-answer.mjs` can pin what counts as "the same question" instead of trusting that the host's copy and the phone's copy of the hashing agreed. `src/settings.ts` (also re-exported) is the catalog of which localStorage keys follow the USER rather than the browser — it is shared because both ends check against the same allow-list, and the reasoning for every key that is deliberately NOT on it lives there too. `src/hints.ts` (also re-exported) is the catalog of what every button MEANS, plus `decideHint` — the single rule for when a tap is spent on an explanation instead of the action. It is here rather than in `web` for the usual reason: both failure directions are SILENT. Too eager and a fresh install is a click-through with ~290 interruptions in it; too shy and the feature is simply absent — no error either way, just the row of unlabelled icons it was built to explain. `src/hosturl.ts` (also re-exported) is here for the same node-runnable reason: it holds the Android shell's address rules — `normalizeHostBase` (what a typed address canonicalises to: http/https only, the daemon's port assumed over plain HTTP but never over https, path stripped, IPv6 re-bracketed) and `resolveHostUrl`, whose allowlist is the load-bearing part. **Only `/api` and `/ws` are ever re-aimed at the daemon**; `/`, `/assets/*`, `/sw.js` and the icons stay local by construction, because serving the shell off the host is exactly the failure the APK exists to remove. A protocol-relative `//evil.example/api/x` is an ABSOLUTE url and is left alone — splicing it behind the base would aim the request at whoever owns that authority — and an empty base makes every function a no-op, which is what keeps the browser client byte-identical. `src/netfuse.ts` (also re-exported) is the **fuse on a request that never answers**: `timedFetch`, `TimeoutError`, `isOffline` and the three budgets. A dead Tailscale path does not refuse a connection, it SWALLOWS it — no bytes, socket open, `fetch` waiting for as long as the platform allows — and every offline fallback in the client hangs off the fetch REJECTING, so with no fuse the cached transcript, the slash cache and the gallery's stale rows are unreachable code exactly when they are the point (observed: a reader on "loading transcript…" indefinitely with a good cached document one IndexedDB read away). A wall-clock cap, not `pull.ts`'s stall detector, because these are small one-chunk JSON responses. Three budgets, and their ORDER is the load-bearing part: the reader's poll (12 s) must be shorter than the generic call (20 s) since a poll still pending when the next is due has already failed, while `git push`/`checkout` get 180 s — cutting a push at the generic budget reports failure for work the host then completes, which is worse than the hang. A caller's own abort stays an `AbortError` (a cancel reported as a dead link is a wrong diagnosis someone would act on), and a status — 404 included — is an ANSWER, never "offline". In `shared` for the node-runnable reason: `e2e-netfuse.mjs` points it at a real server that accepts and then says nothing.
- **`packages/host`** — Node daemon. ESM, `tsx` in dev, `tsc` build → `dist/`. Owns PTY processes, repo discovery, git ops, push notifications, and serves `packages/web/dist` as static files.
- **`packages/web`** — React 18 PWA with xterm.js. Vite dev server proxies `/api` and `/ws` to the host on :8770. Single WebSocket per tab carries everything (PTY bytes base64'd into JSON frames to stay on one channel).

Plus a fourth package that is deliberately **not** a workspace:

- **`packages/app`** — the **Android shell**: a Capacitor wrapper that ships `packages/web/dist` inside an APK. It exists for one property — *the app shell is never on the network*. In the PWA the application itself lives on the far side of the tunnel, so any navigation while the tunnel is down (a reload, the `ws.ts` watchdog, Chrome restoring a discarded tab) re-fetches `index.html` from a host that isn't answering and replaces the entire app with the browser's error page; the send queue, drafts, pad and cached transcripts are all still in localStorage and all unreachable, because the code that reads them is gone. Over plain `http://100.x` there is not even a service worker to cache a shell against it. **Capacitor, explicitly NOT Ionic Framework** — the two are different products and the distinction decides the design: Ionic Framework is a UI component library (adopting it means rewriting all ~30 sheets, the xterm host, the gallery — a reimplementation), while Capacitor is the native runtime from the same team and ships the existing Vite bundle verbatim, zero UI changes. A Bubblewrap/TWA wrap was rejected because a TWA *is* Chrome: same secure-context rules, same navigation, so the shell still comes over the tunnel and the failure is unchanged. Kept out of the root `workspaces` on purpose — adding it would drag Capacitor's dependencies into every `npm install`, CI included, for a package only an Android build needs. **The UI updates itself over the air**, so a web change does NOT need a new APK — only a change to this package (Java, manifest, icons) does: the daemon publishes what it is serving (`host/webbundle.ts`), the app downloads and sha256-verifies it (`web/webUpdate.ts`) and hands it to a small native plugin that points Capacitor's WebView at it. Details, build steps and known limits: `packages/app/README.md`. Verified end to end on an emulator, including a cold start in airplane mode; screenshots in `.claude/outbox/android-apk/`.

### Host module map (`packages/host/src/`)

- `main.ts` — HTTP + WS server, message router. `attached: WeakMap<WebSocket, Set<sessionId>>` so PTY output streams only to sockets viewing that session. **`durableOp()`** is the at-most-once wrapper every ackId-carrying OP goes through (`session.create`, `fanout.run`, `fanout.followup`, `build.run`): a settled ackId is re-acked from the ledger without re-executing, and an ackId still in flight (`opsInFlight`, memory only — a crash mid-op must not leave a "already did it" for work that never ran) is joined rather than started again, because the phone's reconnect retry normally RACES the first delivery. A thrown op is deliberately not remembered (host fault ⇒ a retry deserves a real second attempt); a returned `ok:false` is. Answers `op.ack`. **`inputsInFlight` is the `session.input` twin of `opsInFlight`**, and load-bearing for the same reason: a raw input write is synchronous, so a duplicate ackId could never race it, but a `submit` delivery takes SECONDS and the phone's retry lands in that window constantly — without it the retry would find nothing remembered (the ledger only learns the verdict once delivery settles) and type the prompt a second time. **`session.create` may carry a `prompt`**, typed into the session it just made via `deliverToNewSession()` — fire-and-forget, because `ok` on an op means *accepted*, and a delivery failure is a toast rather than a failed op (the session IS open; re-sending would spawn a second one).
- `acks.ts` — the **ackId ledger**, extracted from `main.ts` and hardened when ops joined it. Bounded + expiring as before, but the TTL is now 45 min (it was 15 — *shorter* than the client's 30 min `QUEUE_TTL_MS`, so a long-offline retry could legitimately re-execute) and the map is persisted to `<STATE_DIR>/acks.json` and reloaded on boot. Persistence is the load-bearing part for ops: `npm run restart` is routine, and without it a queued `fanout.run` retried across a restart would spawn a second 12-repo sweep. **The restart is also what makes the WRITE policy load-bearing**, since `npm run restart` is launchd `kickstart -k` = an immediate SIGTERM: op verdicts (`AckRecord.op`) are written SYNCHRONOUSLY rather than on the 500 ms debounce (a restart lands inside that window; ops are rare enough to afford it — only keystroke-frequency `input.ack` records need the debounce), `main.ts` flushes on SIGTERM/SIGINT, and the write is tmp-file + rename because a kill mid-`writeFileSync` leaves truncated JSON that the constructor's catch turns into an EMPTY ledger — i.e. the same duplicate sweep. Cap eviction drops **non-op records first**: the cap is shared between the two populations, so plain oldest-first eviction let enough acked keystroke sends push a still-retryable fan-out verdict out inside the client's retry window. OP verdicts are written SYNCHRONOUSLY (they are rare; only keystroke-frequency `input.ack` records use the debounce), the file is written tmp+rename (a kill mid-write must not leave truncated JSON that the constructor's catch turns into an empty ledger), `main.ts` flushes on SIGTERM/SIGINT (`launchctl kickstart -k` sends one immediately, which is exactly the restart persistence exists for), and cap eviction drops non-op records first so a cheap keystroke receipt can never push out the verdict that stops a 12-repo sweep re-running. All I/O best-effort — a corrupt or unwritable file degrades to the old in-memory behaviour, never throws into the request path.
- `sessions.ts` — `SessionManager` spawns `claude` under node-pty, tracks idle time, exposes `input()` / `resize()` / `kill()`. Emits `data` events; `main.ts` fans them out. **Turn-boundary signal via claude hooks:** every spawned session is launched with `--settings <inline-json>` that injects `SessionStart`/`UserPromptSubmit`/`Stop` (and `Notification`/`SessionEnd`) hooks which `curl`-POST each event to `POST /api/hook` → `onHookEvent`. This is the POSITIVE signal that replaces silence-guessing: `Stop` = "turn finished, at the prompt, ready for input" (fires per-turn, never during a mid-task pause or while paused on a tool/plan prompt), `UserPromptSubmit` = "turn started", `SessionStart` hands us the conversation id at boot (retires the project-dir polling in `watchClaudeId`). Hooks are ADDITIVE across settings sources (the user's own hooks still run) and best-effort (short `curl` timeout, `|| true`); a session that never reports (stub binary / no curl / hooks off) transparently falls back to the silence heuristics. `SessionInfo.hooked` flips true once the pipe is confirmed live; `isHooked()`/`stopCount()` expose it; a `turnEnded` event carries the finished-turn count.
- `backlog.ts` — `BacklogManager`, now a **VIEW of the intent store** plus the one thing that is genuinely the backlog's. What left: the per-repo store (`<repoDir>/.waterplane/backlog.json`, written with a bare `writeFileSync` and no tmp+rename), the 2 s tick, the lifecycle, the completion watcher and the `waiting()` narrator — all five of which the daemon now has exactly one of, in `intents/`, for every subsystem at once. A work item is the PLAINEST intent there is: prose, `trigger: {kind:"idle"}`, `target: {kind:"repo"}` or `{kind:"session"}`. `isBacklogRow` is that SHAPE rather than an `origin` marker, deliberately — anything posted that fits the description belongs in the list whoever wrote it, which is what makes the sheet a view of the store rather than a second store with a view; the exclusions are only the rows that have their own surface and would otherwise appear twice (a parked create, a standing rule, a build, a fan-out's targets). What stayed: **the sessions** — `openItemSession` (one session per fired item, titled `backlog · <repo> · <label>`), `autoSessionCount` (what the cap subtracts from), `reapAutoSession` (close the oldest idle one when a slot is needed) and `lingerSweep` (close them all once they have been sat on long enough to look at). `ensureRepoSession` / `resolveRepoSession` remain only for the two things that still ask about a REPO's session rather than an item's: the sheet's own "open a session here" button, and a hand fire on a row old enough to predate `fresh`. `IntentDeps.repoSession(cwd, adopt)` is still the one implementation of that question. Also stayed: the `deliverPrompt` executor and `deliveryError`'s three sentences, whose middle one (`unsubmitted`) must never read like "nothing happened". **Session-death handling is the store's**: a still-`running` row whose session dies is NOT marked `done` (a clean end would have completed it first) — anything but a limit exit ⇒ `failed` with a reason; a limit exit ⇒ `queued` for a `{kind:"session"}` row, and for a row in a session of its OWN, held `running` and re-aimed at the revival, never requeued (see `intents/`). **`waiting()` is now literally `blockDetail`** — the verdict the tick acted on, recorded on the row when the words changed — rather than a parallel ladder kept in step by a comment saying it must be. **Migration**: on first boot every discovered repo's `backlog.json` (and a pre-per-repo global one, whose rows name their own repo) is imported and the source renamed `*.migrated`; a row whose id is already in the store is skipped, so restoring a backup cannot duplicate work.
- `review.ts` — `check` / `validate` / `nextStep` / `continueWork`, and the four prompt builders they use. Lifted out of `backlog.ts`, where they were a third of the file and never belonged: everything else there was about WHEN a piece of work runs, and this is about what happened after it did. Both reviewers run a one-shot headless `claude -p --output-format json` (a clean machine envelope, so parsing never fights the TUI), preferring `--continue` in the item's own repo for warm context and falling back to an independent review of the git diff. Verdicts live in a **sidecar** — `<STATE_DIR>/reviews.json`, keyed by intent id, tmp+rename — and are merged into `BacklogItem` at render time, so the wire DTO carries them exactly where it always did without nine fields riding on every `Intent` for one sheet's benefit. **A chosen next step POSTS its own intent** (`origin: review:<id>`, `interject`, `resume` when it has to open a session) instead of flipping the reviewed row back to `running`: one row describing two different pieces of work is precisely what "have I dealt with this?" cannot be asked of.
  - **Delivery types the instruction AT MOST ONCE.** `feed()` returns `ok` / `retry` (nothing was typed — safe to re-run) / `unconfirmed` (bytes were written but never showed up on screen). Only `retry` is auto-retried; `unconfirmed` fails the item with a "check the session before re-firing" message. The old code retyped 3× per feed AND re-ran feed up to `MAX_FIRE_ATTEMPTS`, so a session whose echo we couldn't read got the same prompt ~15 times. Echo detection reads `sessions.screenText()` — the raw capture replayed through a headless VT — not an ANSI-stripped byte window: ONE claude-TUI repaint is tens of KB, so every byte window is wrong in one direction (too small ⇒ visible text reads as "not echoed", too big ⇒ stale scrollback false-positives). The composer check looks only at the bottom rows, so an identical prompt echoed higher in the conversation can't read as "already typed". Verified by `e2e-backlog-echo.mjs`.
  - **A queued item says WHY it is still queued** (`waiting()`, published beside the items on `backlog.list`). A queued row used to explain nothing while any of six different things was true — auto-fire off, no session open for the repo, the session it was queued for gone, another item holding that session, the agent mid-turn, the agent parked on a question — so "the backlog is stuck" and "the backlog is waiting exactly as designed" looked identical from the phone. The same gap `pulls.whyIdle()` closes for downloads. The ladder is `tick()`'s eligibility ladder in the same order and the per-session half is `sessions.autoFireBlocker()` — the very function `readyForAutoFire` now delegates to — because an explanation derived from a second reading of the state drifts from the behaviour it describes. Since the backlog became a view of `intents/`, that is no longer a property this file has to maintain by hand: `waiting()` returns the row's own `blockDetail`, which IS the verdict `intentVerdict` handed the tick when it decided not to fire, in the sentence `intentReasonText` finished. The two are one function for every subsystem at once now, so there is nothing left to keep in step. Transient by construction: computed on demand, never stored on an item and never snapshotted client-side, since "the session is working" read from an offline cache describes a session that may have ended an hour ago. **Re-broadcast when the WORDS change, not only when the backlog does** — every reason is a fact about a session, and a session moves (turn ends, question opens, limit lands) without the backlog moving at all, so a mutation-only broadcast left the phone reading "the session is working" over one that had been idle for ten minutes: a wrong answer to the exact question the line exists to answer. The tick diffs the serialized map and pushes on a real transition. The two "no session" cases are deliberately different sentences: a repo with NO session needs one, while a repo whose only session the USER opened has one auto-fire refuses to adopt (it never types into a hand-driven session) — under one message the second reads as a bug, since the screen plainly shows a live session for that repo. Both were the one tap the row itself offered (`onOpenRepoSession`) — since removed along with the per-repo backlog session it opened; firing a row now opens its own. Verified by `e2e-backlog-wait.mjs`.
- `deliver.ts` — `deliverPrompt(sessions, sessionId, text, kind)`: type an instruction into a live session as if a human typed it, and CONFIRM it landed (`ok` / `retry` = nothing typed, safe to re-run / `unconfirmed` = written but never seen, MUST NOT be auto-retried / `unsubmitted` = provably in the composer but the Return never took — the caller must say "press Return there", never retype). **The Return is verified, not assumed:** the old code pressed Enter once and accepted "the scrollback grew by >80 bytes" as proof, but a claude TUI repaints constantly, so that threshold is met whether or not the keystroke landed — a 12-repo fan-out reported every target `running` while every session sat holding an un-run prompt. On a `hooked` session the proof is exact (`UserPromptSubmit` flips `turnActive`, a turn that already finished bumped `stopCount`) and Return is re-pressed up to 5× until it shows — safe because a Return, unlike retyped text, cannot stack a second copy. Non-hooked sessions keep the old press-and-look guess and still return `ok`: with no hook pipe, "swallowed Return" and "quiet agent" are indistinguishable, and claiming failure would be the same guess in reverse. `deliverPrompt(..., { interactive: true })` is the COMPOSE-BAR variant: it waits only for the TUI to stop mid-draw, never for the turn to end — see the wire invariants. `deliverToNewSession()` is the just-spawned variant (one retry on `"retry"` — a session seconds old is legitimately still booting, and `"retry"` means provably nothing was typed): used by both `fanout.ts` and `session.create`'s `prompt`. Extracted from `backlog.ts` when `fanout.ts` needed the identical at-most-once guarantees — every trap documented on the backlog bullet (rendered-screen echo check, composer-only bottom rows, trust-dialog auto-accept, text and Return as separate writes) lives here now. Keep it ONE implementation; two copies would drift and re-open the repeated-prompt bug. **The echo check POLLS, it does not look once.** Looking again is free — it is retyping that stacks copies — and a single check 500 ms after the write is what a mid-turn interjection lost to: the composer of a working session redraws on the TUI's own schedule (a spinner frame, a tool result, the token counter all take the paint first), so the text was genuinely there and simply not on screen yet. That read returned `"unconfirmed"`, the one verdict that is never auto-retried, and the prompt was reported not delivered while sitting in the composer of a session that was working fine. `ECHO_WAIT_MS` (4 s) is the budget. **And it PLACES the echo rather than slicing the bottom N rows**: typing `/cost` opens the completion menu BELOW the input box (a row per command plus a wrapped description), which pushes the echo ~17 rows up and clean out of a bottom-rows window — text plainly on screen, read as never typed, `unconfirmed`, and then the composer sweep's Esc closed the menu, which is what the user actually saw: "something presses Esc for me". That fix widened the window and kept the yardstick, and **the yardstick was the bug**: distance from the bottom of the render measures the TEAR, not the composer — see "The bottom of the render is not the bottom of the screen" below. Placement is STRUCTURAL now (`echo.ts`'s `composerEcho`: is the text inside the box the CLI draws to take typing), with the distance rule kept only for a screen that has no such box on it at all. **And a MULTI-LINE write is a paste, which the TUI does not echo at all.** The host writes the whole instruction in one chunk — indistinguishable from a paste — and claude collapses a paste to `[Pasted text #1 +11 lines]` plus whatever tail still fits, which hides precisely the head `echoProbe` is cut from. So every long multi-line prompt (the Build sheet's one-tap "set up" prompt is 15 lines) echoed perfectly, read as never typed, returned `unconfirmed`, got the composer sweep, and sat there un-run: the user's report was "it put the prompt in the CLI but missed to fire it", and a Return was all it needed. The placeholder is therefore an echo like any other — but it names no text, so it counts only with a second fact tying it to THIS instruction: the tail of the text on screen (the head is what is hidden, so the tail is what is drawn), or a hidden-line count that accounts for essentially all of it. A stale placeholder from an earlier, different paste satisfies neither. `settle.ts` reads the same shape for the same reason, one file over. `e2e-pastechit.mjs` pins it with a stub whose composer collapses multi-line input the way the real one does — and it fails, exactly as the field did, the moment the placeholder stops counting. **A TUI-LOCAL command is a different contract at the submit end too.** `slash.ts`'s `isLocalCommand()` names the commands `claude` handles inside its own TUI — `/cost`, `/usage`, `/context`, `/config`, `/resume`, `/clear`, … — which open a view and never submit a prompt. They therefore fire no `UserPromptSubmit`, so on a hooked session the turn-start proof CANNOT arrive: the loop pressed Return five times, the first press ran the command and the other four dismissed the view it opened (`/usage` → "Settings dialog dismissed"), and the verdict was `unsubmitted` for a command that had run. The proof that fits is the SCREEN MOVING — a local command redraws, an idle TUI that ate the Return does not — and it is self-limiting: once a view is up the screen has changed, so no further Return can reach it. The sweep on `unconfirmed` also drops its Esc for these. The list is POSITIVE on purpose: `/init`, `/compact`, `/review` and every custom `.md` command really do start a turn and keep the ordinary contract. Verified by `e2e-slashlocal.mjs`.
- `settle.ts` — **what became of a delivery `deliver.ts` could not confirm**, asked later. The two ambiguous verdicts are correct at the moment they are given and useless for ever after: `unconfirmed` (written, never seen on screen) and `unsubmitted` (in the composer, every Return swallowed) may not be auto-retried — retrying what may already be there is what stacked five copies of one prompt — so the phone's queue kept the row and *nothing ever revisited it*. A permanent gravestone for a prompt whose fate is, minutes later, perfectly knowable: the ambiguity belongs to a 4-second echo window, not to the world. `settleDelivery()` answers from evidence, in order — the CLI's OWN conversation log has the prompt ⇒ `landed` (it ran, and the log outlives the session, so a closed one still answers); the text is on the rendered screen ⇒ `composer` (still one keypress from running, still the user's call); the log is readable and has it, and neither does the screen ⇒ `absent` — it never ran and nothing is holding it, which is the one thing the original verdict could not say and the reason a re-send is now provably safe. Everything else is `unknown`, the answer that must never be turned into an action. Three rules carry it: **only the `jsonl` source counts** for `landed` (the `history` fallback is our OWN record, written by `recordPrompt` *before* the Return is pressed, so an unsubmitted prompt is in it — using that as proof it ran would confirm exactly the case this exists to catch); **`absent` requires the log**, because a screen is the last 40 rows and a prompt that ran and produced a long answer has scrolled off it, and the client acts on `absent` by sending it again; and it is **read-only by construction** — it decides what is true, `main.ts` reports it, the phone decides what to do. Wire: `input.settle` (batched, capped) → `input.settled`. Shares `squash`/`echoProbe`, **the composer anchor** (`composerEcho` — the same box, not a bottom-rows slice, and the same `ROW_WINDOW` too, so a prompt above streamed output settles `composer` rather than `unknown` here just as it confirms there) **and the collapsed-paste rule** with `deliver.ts` so "is this text there?" cannot get two answers — a multi-line prompt shows as `[Pasted text #1 +N lines]` with its head hidden, and reading that as not-there would answer `absent`, on which the client acts by sending again: a second copy stacked on the first, in the composer, which is the outcome this file exists to prevent. Verified by `e2e-settle.mjs`.
- `fanout.ts` — `FanoutManager`: **one prompt, N repos, a fresh session each.** The maintenance sweep (`/init` everywhere, "what did this project cost this month?") that was otherwise N repo taps and N retypings. **A run is DURABLE now, and that is the change.** It used to be an in-memory ring on the argument that "the sessions survive a host restart, the run record doesn't need to" — which is wrong in exactly the case that matters: a restart mid-sweep left twelve live `claude` processes and no account at all of what they were for, no way to follow up on them as a set, and for a sweep the phone had just posted, no sweep. A fan-out is now N intents sharing a `groupId` — a parent row (`target: {kind:"repos"}`, whose id IS the run id the receipt names) plus one child per repo (`target: {kind:"repo", fresh:true}`) — and `FanoutRun` is rebuilt from those rows on demand (`intents/adapters.ts`'s `fanoutRuns`), so `fanout.*` is unchanged on the wire while a restart mid-run reconciles instead of forgetting. `finishedAt` is DERIVED (nothing in the group is still going), which is also what makes a follow-up correctly reopen a settled run. What stayed here: dir validation against `discoverTargets()` (an arbitrary path can never become a session cwd; an unknown one is silently dropped, never spawned), the per-target spawn + `deliverToNewSession`, and the one-shot `retry` re-attempt (a just-spawned session may still be booting, and `retry` means provably nothing was typed so no copy can stack; `unconfirmed` never is). What left: the runs ring, the watching map, the second `onSessionTurnEnded`/`onSessionExit` watcher, `settle()`, and the concurrency pool — which is now a store rule, a bound on rows of one `groupId` that are `starting`, i.e. exactly what the in-process pool meant minus the process it died with. A target completes on a `Stop` past its baseline and NEVER on silence (`watch: "hook"`): a sweep's whole output is the claim that N repos did the work, and a guess is not that claim, so a non-hooked session honestly stays `running`. **`followUp(runId, text, dirs?)`** posts one child intent per live session (`target: {kind:"session"}`, `interject`, sharing a batch id so the run records the subset one tap addressed) and spawns nothing — a target whose session is gone is left out and said so, because a fresh session would run "now commit that" against a repo that never did step one. `interject` is load-bearing: without it a follow-up would queue behind its own target row under the one-intent-per-session rule and, on a session with no hook pipe, wait for ever. A SCHEDULED sweep gets a fresh run id per occurrence — sharing one would make next week's occurrence post children that already exist (at-most-once by intent id) and therefore never run. Verified by `e2e-fanout.mjs`, which now also kills the daemon mid-run and asserts the run comes back with its targets, its sessions and its follow-up, reconciled rather than re-typed.
- `intents/` — **the durable Intent store: one file, one tick, one lifecycle, for every piece of deferred work the host owns.** It replaces `launch.ts` and `schedule.ts`, which were the same 240 lines twice — launch's own header admitted the shape was "borrowed wholesale from `schedule.ts`" — and which were each right, in isolation, about the two rules that matter. Their reasoning is kept below, because it is the reason the store is shaped the way it is.
- `localslot.ts` — **the local-model gate**: how many coding sessions on a LOCAL model may be working at once (synced setting, default 1), and the model loaded before an automatic item opens on it. Rung 4.55 `localModel`; see [The local-model gate](#the-local-model-gate--rung-455-localmodel).

  **Why the wait belongs to the host at all.** The bug it closes is one screenshot: *"8 messages not delivered — the image it refers to never uploaded — queued too long."* Everything about "open a session in this repo and look at `.claude/inbox/shot.jpg`" used to be assembled on the PHONE — bytes parked in the send queue, the `session.create` parked BEHIND them in the same lane, the ordering enforced by a browser tab on a device with a bad tunnel. The desktop, which was going to do the work and was not on a train, never learned that any of it was supposed to happen. Thirty minutes (the client's `QUEUE_TTL_MS`) and the upload failed, the create failed with it, and every prompt queued behind the create failed too. So the intent is handed over as early as it can possibly be, and the WAIT happens here. On the client such a create goes to the FRONT of its lane, ahead of the very uploads it depends on: handing over the intent is one small JSON message, and the megabytes can take as long as they take.

  **Why the clock is a trigger and not a module.** The motivating instruction was never "cron for its own sake" but the weekly usage window: quota left over when the week rolls is quota that evaporates, so the thing worth automating is "two hours BEFORE the reset, fan a security review out across every repo". That shape forces three decisions, all of which survive as properties of the `at` trigger. **The zone is stored, not an epoch** — the anchor is a wall clock the user knows about their account ("Thursday 18:00 German time") and the daemon may run under a different TZ entirely (a launchd service inherits whatever the login session had); an instant computed once on the phone would be an hour wrong for half the year, in the direction that matters, past the reset it was meant to beat. `nextFireAt()` (`shared/schedule.ts`, node-runnable so `e2e-schedule.mjs` pins it and the sheet's preview is the same answer rather than an approximation) re-resolves it per occurrence. **The lead time is a separate field** — "Thu 18:00 minus 2h" and "Thu 16:00" fire at the same instant and do not mean the same thing: when the reset moves, one is a one-field edit and the other is a re-derivation the user has to do in their head. **Nothing is armed in advance**, no `setTimeout` per row: a long timer is silently wrong across all three things a schedule exists to survive — the host restarting (documented as routine), the machine sleeping, and a DST switch. Every tick just asks the rule again, and an inbox POST *kicks* it (`api.ts` → `fileLanded`) so a files trigger is not tick latency.

  The rules the store enforces, all of them inherited from one of the two:
   - **`op.ack ok` means on the desktop's DISK.** `post()` persists synchronously and the route acks after, because "the phone may now forget these words" is the whole promise being made.
   - **`starting` is written BEFORE the executor**, and for an `at` trigger so is `lastOccurrence`. A crash between the two must leave a visibly stuck row — never an invitation to open a second claude in the same worktree, and never a sweep that runs twice. On boot such a row asks `settle.ts`'s log verdict rather than being blindly requeued.
   - **At-most-once is per OCCURRENCE for a clock, and by intent id for everything else** — and the id outlives the ack ledger's 45 minutes, which is what will make deleting the phone's 30-minute expiry safe.
   - **Late is a first-class outcome.** A desktop sleeps, so the interesting failure is a fire whose instant passed while nothing was running. Inside the row's grace it runs and is labelled late; past it the row says it was missed — and *says* it, which the old module did not: a missed occurrence emitted nothing at all, and a spent one-time entry was deleted with its prompt text still in it.
   - **It owns WHEN, not WHAT.** Executors are injected from `main.ts`, so this module imports neither `sessions.ts` nor `fanout.ts` nor `backlog.ts`, and a scheduled sweep is still a caller of the fan-out's own sweep rather than a second sweep implementation. Since stage 4/5 it also owns the three rules that used to be one per manager: the completion watcher (the pre-delivery stop-count baseline plus the turn-ended/exit subscription — there were two copies of it, and a `Stop` past the baseline now OUTRANKS the echo probe's verdict, because on a fast turn the hook beats the executor's return value), `INTENT_MAX_ATTEMPTS` (only a `retry` verdict requeues; `unconfirmed` never), and the fan-out's concurrency pool.
   - **A deadline is absolute** (`LAUNCH_WAIT_MS`, 6 h — far past the client's half hour, because the phone's clock is exactly what stopped mattering), and expiry names the files that never came. Two decisions stay human: cancel it, or open it anyway — and a launch that went without its files SAYS so for ever, because the prompt inside that session still tells the agent to read a path that is not there.
   - Persisted to `<STATE_DIR>/intents.json` (tmp+rename), with `launches.json` and `schedules.json` imported on first boot and renamed `*.migrated` rather than deleted, so a restored backup re-imports safely. Eviction is compaction into `intents-archive.jsonl` and never touches un-run work. `e2e-intent.mjs`, `e2e-launchwait.mjs`, `e2e-schedule.mjs`.


- `prompt.ts` — heuristic detector that scans PTY output for Yes/No, tool-approval, plan, trust prompts. Surfaces them as `DetectedPrompt` so the phone shows big one-tap approve buttons. **Two-stage, and both stages exist for a reason:** the cheap stage scans an ANSI-stripped byte window (fast enough to run per quiet period) and runs **lenient** (`detectPrompt(text, { lenient: true })` — a repaint can leave the cursor row or the footer row outside the window while the option rows sit inside it, and demanding them there would drop a real prompt before it ever reached the render); a hit is only a CANDIDATE, re-detected STRICTLY against `sessions.screenText()` (headless VT replay = what's actually on screen) and THAT result is published. A repaint-based TUI makes any byte window a shuffled, hole-punched approximation — fragments joined across cursor jumps, letters missing — and those fragments used to be surfaced verbatim as option labels. A choice box must also carry a selection cursor (`❯ 1. …`) or the "Enter to confirm · Esc to cancel" footer, labels are length-capped, and indices must run 1..N — without that, a numbered list in the assistant's OWN prose ("1. Now: … 2. Then: …") reads as a prompt and phantom approve bars flicker in and out mid-answer. `stripAnsi` must keep eating charset designators (`ESC ( B`) and single-char escapes, not just CSI, or "(B" ends up glued to the label text. Options need NOT be contiguous: `AskUserQuestion` puts a wrapped description row under every choice, and the old contiguous-run scan therefore found only the last two rows, read "first index is not 1" and published nothing — the phone showed no approve bar and the reader view read "working" for as long as the box was up. Non-option rows between two numbered options are a bounded GAP (`GAP_MAX`), indices must still descend by exactly one walking up, and a checkbox marker (`1. [ ] …`) is stripped into the label and flagged `DetectedPrompt.multi` — a digit TOGGLES a row in that box, so the phone sends the digit alone plus an explicit Submit (`\r`), and the oracle never auto-fires one. **Fallback:** when the rendered screen carries a dialog footer (`DIALOG_FOOTER_RE` — "Enter to confirm/select" / "Esc to cancel", never the working line's "esc to interrupt") but nothing parses, `SessionInfo.awaitingInput` is published and notified: no one-tap buttons, but the session says "a dialog is open in the CLI" instead of silently reading as busy. Unit-pinned in `e2e-tier12.mjs`. **Lifetime, not just detection:** output alone never retires a published prompt. `sessions.ts` used to null it on every PTY chunk and rebuild it after 600 ms of quiet, but a box waits with the TUI repainting its working line underneath — so a live dialog was cleared and re-published about once a second and the phone's answer panel flashed too briefly to read or tap. Now only the strict verifier may clear it, its check is a debounce with a ceiling (`PROMPT_MAX_STALE_MS`, earliest-armed-wins) so a repaint stream delays verification by a bounded amount rather than starving it for ever, real input arms a 250 ms re-check (a stale box is a tap that types a digit into a running turn), and a `UserPromptSubmit` hook or a PTY exit clears it outright. A numbered-choice oracle suggestion now lives and dies with the box. **The strict stage flaps, too:** a capture taken mid-repaint holds a half-drawn box (options there, cursor row or footer not yet redrawn), and publishing `null` on it made the panel blink at about 1 Hz even after output stopped clearing it — measured on a live session as `PROMPT → none → awaiting` 14 ms apart, over and over. So a failed parse whose screen still carries a dialog footer KEEPS the published box, counting the miss; `PROMPT_MISS_MAX` misses in a row degrade it to `awaitingInput`, and the cheap gate's own exit (no candidate, no footer in the byte window) still clears immediately with no misses at all. Each miss re-arms its own next check — checks are otherwise driven by output, and a box answered at the DESK leaves a quiet screen behind, on which a retained prompt would never be re-verified. `e2e-promptlive.mjs`. **Answering a checkbox box is a different act from answering a single-choice one.** A multi-select box confirms on an unnumbered `Submit` ROW; Return anywhere else TOGGLES the row the cursor is on. The phone's Submit button sent a bare `\r`, and the cursor starts on option 1 and does not follow a digit — so the tap re-toggled option 1, undid the pick the user had just made, and left the box open, looking for all the world like it had worked. The client cannot fix this: it has no cursor position, and the arrows it would need are the deliberately undurable raw-keystroke path. So `session.input` carries `promptSubmit`, `navToSubmit()` measures the distance from the cursor to the Submit row in SELECTABLE ROWS (each option draws a wrapped description under it that the arrows step over, so a screen-line count is not a row count), and `sessions.submitPromptBox()` walks it there — re-reading the rendered screen between moves rather than pressing Down N times open-loop, because whether a digit moves the cursor and whether the ends of the list wrap are upstream details, and a loop that re-measures converges on an overshoot where a counted burst lands on the wrong row. No Submit row or no cursor on screen (a box taller than the terminal can have scrolled either off) ⇒ the bare Return, exactly what it did before: guessing a direction from half a box would toggle a row nobody chose. `e2e-checkbox.mjs` (stub `STUB_MODE=checkbox`), rule unit-pinned in `packages/host/test/prompt.test.mjs`.

  **The box can be taller than the terminal, and requiring index 1 made that an oscillator.** Six
  options with a wrapped description each does not fit a phone's 40 rows, so the CLI scrolls its own
  top away and the screen starts mid-box. The strict pass then read "first index is not 1" and
  published `null` — which unmounted the approve panel, which gave the ~200 px back to the terminal,
  which resized the PTY, which made claude repaint a box that now FIT, which republished it. About
  once a second: the "renders and hides and renders and hides" the phone showed. The anchor is now
  strict-only-optional: a run starting above 1 is published with the indices it has (they are what a
  keystroke means) plus `DetectedPrompt.truncated`, and only on PROOF of a dialog — the dialog footer
  or the `❯` cursor, never `footerSeen` alone, since `FOOTER_RE` also matches the working line's "esc
  to interrupt" and prose numbered from 2 under a busy session would otherwise parse. The lenient
  gate keeps the anchor unconditionally: it has neither piece of evidence by design.

  **The cheap gate had the one exit around "only the strict verifier clears it."** It reads a fixed
  byte window (`PROMPT_GATE_BYTES`), and a box whose own frame is a large fraction of that window
  plus the repaints after it pushes the footer out of view while the box is plainly still on screen —
  clearing the panel with no misses spent. Now a gate miss retires a prompt only when there is none
  published; with a box up it falls through to the render and the strict pass decides. A box that is
  genuinely gone leaves a screen with no dialog footer, which clears it on that same pass, so this
  costs no latency — only a render per check for as long as a box is up.
- `question.ts` — **the question with no box around it.** `prompt.ts` answers "is the CLI blocked on
  a dialog"; this answers "did the turn END ON A QUESTION TO YOU", which is the commonest way work
  actually stops here and the one the app had no word for. The agent finishes with "Want 2
  implemented, or leave it at 1?" and returns to its composer: nothing is blocked in the CLI, so
  `prompt` and `awaitingInput` are both empty, the session went `idle`, the push said "Turn
  finished" and the launcher badged it `done` — a completed turn, nothing owed, while the one thing
  that would move it forward sat unasked on a screen nobody was looking at. The heuristic itself is
  not new: it lived inside `oracle.ts`, where it gated a Gemini call, which made the DETECTION
  conditional on a third-party API key — with `GEMINI_API_KEY` unset (the ordinary case) the tail
  was never looked at at all. So it moved out; since the oracle became a plugin, a plugin hears it as
  a `question` event instead of owning it.
  `questionWindow()` takes the last 8 content lines with the CLI's own chrome (composer rules, the
  mode line, the key legend) stripped off the bottom; `looksLikeQuestion()` is true when one of them
  ends in "?" or the closing lines carry asking phrasing ("want me to", "should i", "which");
  `askLine()` picks the LAST line ending in "?" — not `questionText()`'s 240-character join of the
  closing lines, because a push body and a launcher row have room for one sentence and the paragraph
  form cut the question out of it. `sessions.checkAsking()` runs it on the turn-end transition and
  publishes `SessionInfo.asking`; a parsed `prompt` outranks it (that is the same question with
  buttons), a limit-blocked session is waiting on a clock and not on you, and any keystroke or a
  turn starting retires it — including one typed at the DESK, which is why the clearing hangs off
  `setTurn` and not only off our own writes. The `at` stamp is kept across re-idles: idle re-enters
  on every repaint, and a question whose clock restarted twice a second reads "asked 0s ago" for as
  long as it goes unanswered. It never blocks anything — `sessionWall`/`laneBusy` are untouched,
  because typing a reply into that session is exactly the right move and a prose question is not a
  box a queued prompt could fall into. `packages/host/test/question.test.mjs`, `e2e-askprose.mjs`.
- `askbox.ts` — **the question as the CLI itself wrote it.** `prompt.ts` scrapes a terminal, which is
  the only source there is for a tool approval or a trust dialog; but `AskUserQuestion` is a TOOL
  CALL, and its input — the question, every label, every option's full description — is written to
  `~/.claude/projects/<slug>/<uuid>.jsonl` the moment the assistant asks, before anyone answers. The
  screen's copy of that same text is lossy three ways at once: truncated at the right edge, cut again
  by the preview pane drawn beside the options, and on a tall box scrolled off entirely. What reached
  the phone was a one-tap button reading "A + B + C (Recommended)" with the paragraph explaining it
  nowhere on the device — a button you cannot honestly press.

  So the scraped box is ENRICHED, never replaced: same options, same indices, same keystrokes, plus
  `DetectedPrompt.ask` (the real question) and `PromptOption.desc`. The rules, each of which is a way
  to get it silently wrong:
  - Only a PENDING call counts — a `tool_result` for that `tool_use_id` means the box is gone, and
    enriching it would put the previous question's paragraphs under the current one's buttons. Newest
    pending wins (a box re-asked after a refusal strands the older one in the same window).
  - Matching is by LABEL, never by index or by the question text. The TUI appends rows the tool never
    sent ("Type something.", "Chat about this"), a truncated run starts above 1, and the question is
    exactly the row that scrolls off — requiring it would fail precisely when this matters most. A
    label the terminal cut is a PREFIX of the real one, so containment runs one way only.
  - Two labels must agree AND be a majority of the smaller side. One is never enough: two boxes in a
    row can both offer "Yes". "Smaller side" is what keeps the rule usable in both directions the
    lists differ — TUI extras on one side, a truncated screen on the other.
  - `ask`, `desc` and `truncated` are all **outside `promptFingerprint`**. They change nothing about
    what a keystroke MEANS, and enrichment that arrives one check later must not invalidate an answer
    already queued against the box.
  - Read-only and best-effort in exactly the way `transcript.ts` is (the record shape is the CLI's
    internal format, not a contract): every failure returns nothing and the scraped box is published
    unchanged. Cached on the log's mtime, since the strict pass runs about twice a second while a box
    is up and the log does not move in that window; the tail read is 512 KB, not `transcript.ts`'s
    24 MB, because a pending call is by construction the last thing in the file. `e2e-askbox.mjs`.
- `login.ts` — **the sign-in link, put back together.** `/login` is the one flow in this app that cannot be completed inside it: the CLI prints an OAuth URL, a browser has to visit it, and the code it hands back has to reach the CLI's own input. On a phone every step of that was hostile. A terminal is a GRID — it has no soft wrap — so a 300-character URL at 53 columns is six separate rows with nothing marking them as one thing. It cannot be tapped (there is no link, only fragments), cannot be selected (the rows are not contiguous text in any selectable sense once the alt screen redraws), and cannot be transcribed (it is base64 with no word breaks). The session published `awaitingInput`, correctly, and the only honest advice was "go and use the desktop". **What makes rejoining safe is that it is evidence, not a character class.** `shared/urls.ts`'s `findUrls` does not ask "does the next row also look URL-ish" — that swallows a repo path printed under a link, which is a shape this project's own output produces constantly. It asks whether the rows show a WRAP: the continuation starts at the same inset the first row did, every row of the run except the last is the same width, and no row carries a scheme of its own (a second link printed underneath the first is the one shape that passes every other test). The width comes from the run's own geometry rather than from `cols`, deliberately — the CLI also wraps inside its own box at an inset of its choosing, and a rule anchored on the terminal width misses exactly the case this exists for. **Two published facts, because they are two different next actions**: `url` ("open this") and `awaitingCode` ("the CLI is sitting on its paste-the-code input"), and they do not always both apply — a link with no input yet, an input with no fresh link. **Detection is on the URL's SHAPE, never on the CLI's prose.** An OAuth query (`client_id`, `redirect_uri`, `code_challenge`, `response_type`) is proof on its own; a bare `/auth`-shaped path counts only while the code input is visibly up, because a documentation link in a transcript has that shape too. Matching printed English would also fire on a session that happens to be *displaying* that English, which is the reason `limit.ts` carries its keep-the-phrases-out warning, and a repo that greps itself makes that a real event rather than a hypothetical. **Where it runs**: `checkPrompt`'s strict pass. The login screen carries a dialog footer, so the expensive headless VT replay has already been bought every time there is a link to find — this costs a regex on a string the host already had. `applyLogin` mirrors `applyPrompt` (`sameLogin` first, or a `session.list` broadcast per repaint), the cheap gate's early exit will not retire a published login without looking, and a PTY exit clears it beside `prompt`/`awaitingInput`. `at` is stamped when a URL first appears and kept while it is the same URL: a login link expires, and "nine minutes ago" is the difference between a page that signs you in and one that refuses for no stated reason. Pinned by `packages/host/test/login.test.mjs` (fixtures) and `e2e-login.mjs` (a stub `/login` screen, end to end, including that the link RETIRES once used).
- `limit.ts` — usage-limit banner detection + reset-time parsing for **auto-continue**: when a session hits a Claude usage limit, `sessions.ts` badges it (`SessionInfo.limit`), answers the stop-and-wait menu, and schedules a `continue` at the parsed reset time (else retries on `WATERPLANE_LIMIT_RETRY_MS`). Global switch persisted in `<STATE_DIR>/limit.json` (`limit.setAuto`), per-session override via `limit.session`. Keep the rendered banner phrases OUT of comments/strings repo-wide — a session printing them on screen would false-positive.
  - **The resume queue — what happens when MORE THAN ONE session is blocked.** A plan limit is an
    ACCOUNT fact, so sessions do not hit it one at a time: every session working at that moment
    blocks, and each parses the same reset instant out of the same banner (observed: five launcher
    rows all reading `limit · auto 12:02`). Firing them together is therefore the normal case, and it
    is self-defeating — they race for a window one of them consumes, the rest re-block, and each
    spends one of its bounded `LIMIT_MAX_ATTEMPTS` proving what the first already proved. So both
    resume paths (the in-place `continue` and the resurrect-with-`--continue` of a session that
    EXITED at the limit) go through one host-wide queue: `requestResume` → `pumpResume` → one
    resume at a time by default, the next released once the previous reached a verdict. Four things
    are load-bearing. **Membership is derived, never stored** (`resumeOrder()`: blocked, auto-continue on,
    attempts left) — a stored order drifts from the ladder that decides, the trap `backlog.waiting()`
    avoids the same way; the one exception is a session that exited at the limit, which is in line on
    its REQUEST rather than on `limit.blocked`, because the CLI usually quits before an idle scan
    ever set that flag. **The verdict is not "we typed it"**: release comes from a hook-reported turn
    START, from the banner-gone scan, from re-blocking, or from a watchdog — and deliberately NOT
    from `setTurn(true)` on a non-hooked session, since `markSubmitted` sets that flag from our OWN
    write, so releasing on it would treat typing "continue" as proof the continue worked and wave the
    whole queue through instantly. **A resume that comes back still blocked arms a host-wide
    hold-off** (`resumeHoldUntil`, one retry cadence) and re-schedules anything parked on an earlier
    time — the failure is a fact about the account, so nobody else should spend an attempt learning
    it, and a countdown the phone shows must be one the attempt will really fire at. **The order is
    steerable**: `limit.first` (oldest tap first) → starred → longest blocked, with `limit.resume`
    the explicit override that ignores both the hold-off and the gap, because a tap is the user
    overruling exactly that clock. Queue place rides on `SessionLimit.queuePos`/`resuming`/`first`,
    the host-wide half on `limit.config` (`resumingId`, `resumingIds`, `holdUntil`, `mode`). UI:
    `LimitSheet.tsx`, reached from the launcher's "N at limit" chip. Verified by
    `e2e-limitqueue.mjs`.
  - **Sequential or parallel — the release mode** (`LimitResumeMode`: `one` / `repo` / `all`,
    `limit.setMode`, persisted beside the global switch in `.waterplane/limit.json`). The serialization
    argument above is an argument about EVIDENCE: N sessions typing `continue` at one reset instant
    spend N bounded attempts to learn one fact about the account. It justifies the FIRST resume of a
    wave being alone and nothing past it — once one session has provably started a turn, the limit
    demonstrably lifted, and whether the other ten follow one-by-one or together is a question about
    the WORK, which the daemon has no business answering on the user's behalf. Five rows all reading
    `usmc · main` and five rows in five worktrees are not the same situation, and the sheet showed
    them identically.
    So: `resumingIds` is a SET, and `canResumeAlongside()` gates it. The probe rule comes first —
    `resumeProven` is false until a `resumed` verdict, and goes false again on a `blocked` verdict or
    on any session hitting the wall fresh — so a mis-set `all` on an account that has NOT reset still
    costs exactly one attempt, which is the property the whole queue exists to protect. Past that,
    `one` keeps the old behaviour, `all` releases everything waiting, and `repo` allows one resume per
    repo DIRECTORY using `@waterplane/shared`'s `serialGroup()` — deliberately the same grouping the send
    queue's `waterplane.serialSessions` uses for queued opens, because it is the same underlying rule (two
    agents must not edit one checkout; two worktrees are not each other's business) and a second
    definition of "same repo" would drift from it. In `repo` mode `pumpResume` picks the first
    CANDIDATE rather than the head of the line, so a session whose worktree is busy does not hold up
    one whose worktree is free. `LIMIT_RESUME_GAP_MS` stays a RATE limit in every mode — even `all`
    spaces the resumes, so a mis-tap cannot type into eleven sessions inside a second — and the pump
    stops when no candidate fits rather than polling, since capacity only ever opens in
    `releaseResume()` or `setResumeMode()`, both of which pump. Watchdogs became per-id
    (`resumeGuards`), and the resurrect handover moves the slot to the new session id.
    `e2e-limitparallel.mjs` pins the three claims that matter: the probe is alone, two repos overlap,
    two sessions in one repo never do.
  - **Limit-EXIT resurrection:** the current CLI often *quits* on a plan limit (prints the `/usage-credits` banner and exits) instead of parking at a wait-menu — so there is no live PTY to type `continue` into. `sessions.ts` (`maybeScheduleResurrect`/`resurrect`) detects a limit banner in an exited session's tail and reopens the conversation with `--continue` at the reset time (else `WATERPLANE_LIMIT_RETRY_MS`), carrying the attempts count forward so it stays bounded by `WATERPLANE_LIMIT_MAX_ATTEMPTS`. A user **kill/remove** sets a `killed` flag that suppresses resurrection; a clean (non-limit) exit is never resurrected. The backlog re-adopts the revived session for its repo (`resolveRepoSession` → `diedAtLimit`) so queued work follows its own session across the bounce. Verified by `e2e-resurrect.mjs`.
- `push.ts` — Web Push (VAPID); fires on prompt-detected and turn-finished (idle). Notifications can carry an `image` (opens the annotator) or a `file` (outbox artifact — tapping posts `download-file` to an open window — or encodes `dlRepo`/`dlPath`/`dlMtime` in the cold-start hash — and the app queues it through `web/download.ts`; the browser is never navigated at `download=1`, which sets Content-Disposition attachment). New non-image outbox files (APK/zip/pdf…) are detected per turn like images and notify with a download tap; limit events append to `<STATE_DIR>/limit-events.jsonl`.
- `notifyprefs.ts` — **which notification KINDS may fire at all** (`<STATE_DIR>/notify.json`). Every alert the daemon raises went two places unconditionally: the in-app feed and, when subscribed, an OS push. That is right for the kinds that need a human — a session parked on a question, a usage limit — and wrong for `idle`, the "Turn finished" ping, which fires once per turn per session: a handful of agents working a backlog produces a notification a minute, and the observed result is a feed that is ~40 identical "Turn finished" rows with the two urgent kinds buried somewhere inside it. The switch had to exist, and the default had to change. **The gate is on the host, not in the client.** A client-side filter can only hide a row it has already been sent — the phone still buzzed, which is the half that actually interrupts someone — and the synced-settings store cannot hold it either, because `settings.ts` keeps opaque strings the daemon deliberately never parses (that opacity is what lets the web bundle update without the daemon). So it is its own small store, checked inside `server/clients.ts`'s `notify()` before the feed entry, the broadcast and the push alike: a muted kind leaves no trace anywhere, rather than being recorded and hidden. **Sparse by construction** — only the kinds the user has explicitly touched are stored, so a kind added in a later version arrives with its own default instead of being silently muted by a file written before it existed (`notifyEnabled`/`cleanNotifyPrefs` in `@waterplane/shared`, where the client checks the same rule to draw the switches). The one bypass is `pull`: a payload carrying a pull id is not an alert but the TRANSPORT for auto-download — the service worker starts a Background Fetch from the push handler with the app closed — so gating it would silently turn auto-pull off for anyone who muted "artifact". Wire: `notify.prefs.set` → a `notify.prefs` BROADCAST (the mute follows the account, so a second device must not keep showing a switch the desktop just flipped), plus `notify.prefs` unprompted on hello. Verified by `e2e-notifyprefs.mjs`.
- `decisionlog.ts` — the **decision log** (`<STATE_DIR>/decision-log.json`, `DecisionLogEntry`, a 500-entry ring): every automatic thing done or proposed on a session's behalf — usage-limit auto-continue lifecycle rows (`source: "limit"`: blocked → attempt → resumed/gave up) and plugin suggestions/answers (`source: "plugin"`, `plugin` set). It was the oracle's log; on first boot `.waterplane/oracle-log.json` is migrated in (oracle rows → `plugin: "oracle"`) and renamed `.migrated`, never deleted. Every change broadcasts `decisions.log`; routes `decisions.get/archive/delete/archiveAll`.
- `sentlog.ts` — the **sent-command audit log** (`<STATE_DIR>/sent.json`), the answer to "what did this thing type into my agent, and when?". Automation drives a session through the same PTY a person does, so a backlog item firing, a fan-out target, a plugin's gated answer and a usage-limit `continue` all land in the scrollback looking exactly like typed text — and the moment that question gets asked, the scrollback is the evidence under suspicion. Two rules make it worth reading. **One entry per semantic command, not per PTY write**: `deliver.ts` writes the text and the Return separately and re-presses Return up to five times, so a per-write log would show six rows for one prompt; the entry is recorded when delivery SETTLES, which is also what lets it carry the verdict. And **the verdict is kept, not flattened** — `unsubmitted` (text sitting in the composer, un-run) and `ok` are opposite facts about the session, so a log that called both "sent" would state the one thing that is untrue. Recording is not per-caller: `deliverPrompt()` records on every exit path (including `"retry"` = provably nothing typed, because "the backlog never managed to feed this session" is as much of an answer as the opposite), and the raw automation writes that bypass it — the oracle's auto-fired digit, the usage-limit menu answer, the auto-`continue` — call `recordSent()` at their own site. The store is reached through a module-level singleton (`setSentLog` in `main.ts`) rather than threaded through every caller, so a new send path is recorded by default instead of by remembering. Persisted for the same reason `acks.ts` is (`npm run restart` is routine, and an in-memory trail is empty exactly when something surprising happened before the last restart): tmp+rename, debounced, flushed on SIGTERM, every I/O failure degrading to in-memory. Wire: `sent.get`/`sent.clear` → `sent.log`, plus a `sent.new` broadcast per entry so an open sheet stays current without refetching. UI: `SentLogSheet.tsx`. Verified by `e2e-sent.mjs`.
- `settings.ts` — **the settings that follow the USER, not the browser** (`<STATE_DIR>/settings.json`). Everything the app remembered lived in localStorage, which is right for a send queue or a measured uplink rate and wrong for the things the user AUTHORED: prompt templates (snippets), fan-out presets, header commands, the prompt pad, the toolbar layout, the default launch flags. Those were per-browser, so a template written on the phone did not exist on the desktop and a reinstalled PWA lost the lot — while a host that already persists the backlog, the ack ledger and the audit log sat right there. Deliberately dumb, because the alternative is a sync engine. **Opaque values**: a record is `{ value, ts }` where `value` is the client's RAW localStorage string, never parsed — shapes change with the UI, and `webbundle.ts` exists precisely so the phone can update its web bundle without the daemon moving. **Last write wins on the CLIENT's timestamp**, with equal timestamps losing (a reconnect re-push must not re-broadcast to every device), and the loser of a race is answered with the winning value instead of being ignored, so it stops holding a version nobody else has. **An allow-list, not a mirror** (`SYNCED_SETTING_KEYS` in `@waterplane/shared`, where both ends read it): syncing `waterplane.outbox` would let a second device replay another device's queue — a prompt typed twice — and syncing `waterplane.dataSaver`/`uploadScale` would copy a phone's DERP-relayed link settings onto a desktop on the LAN. An over-cap value is refused rather than truncated (a value silently cut in half is a corrupt prompt list on every other device). Persisted tmp+rename, debounced, flushed on SIGTERM, degrading to in-memory on any I/O failure. Wire: `settings.get`/`settings.set` → `settings.all` (sent unprompted on hello) + a `settings.update` broadcast. Verified by `e2e-settings.mjs`.
- `scaffold.ts` — `newWorktree`, new-folder / new-repo scaffolding. **A new repo is a new *project*, initialized for phone use** (`newRepo(..., { setup: true, description })`, the default): `git init -b main` (symbolic-ref fallback for git < 2.28), the `.claude/inbox` + `.claude/outbox` drops and `.waterplane/` created, a `.gitignore` covering all three (plus the usual node/env noise), a README, a CLAUDE.md whose "Working from a phone" section tells the agent to write artifacts into the outbox instead of dumping unreadable walls of terminal output, and an initial commit (so `git worktree add` — hence backlog parallel mode — works immediately). No git identity configured → the commit is retried with a placeholder one and the result carries a `warning` (the phone shows it instead of jumping straight into the session). `usmc: false` is the old bare `git init` + empty commit; e2e scripts that need a non-compliant repo pass it. Verified by `e2e-scaffold.mjs`.
- `repos.ts` / `discover.ts` — recursive multi-root repo + worktree discovery: an async walk (entry types from `readdir`, a `stat` only for a symlink), a single-worktree repo read off `.git/HEAD`, `git worktree list` only where `.git/worktrees/` has entries; concurrent scans share one. `discoverTargets` always scans; `listTargets` (the launcher's `/api/repos` only) answers the last scan when a fresh one takes over 1.5 s, and the route's git counts come from `git.ts`' `changedCountsWithin` (four at a time, cached, budgeted). Why: [distribution.md](distribution.md#windows-the-launcher-drives-the-host-in-wsl) — over WSL's `/mnt/c` the old synchronous walk froze the daemon for minutes. `repolist.test.mjs`.
- `git.ts` — status, unified diffs, stage/unstage, commit, push (Tier-3 git review from the phone).
  `countChangedFiles()` feeds the launcher's git badge (`RepoTarget.changedCount`) and counts EVERY
  uncommitted path — staged, unstaged, untracked — because the tap opens the git view, which lists
  exactly those. It counted `ls-files --others` alone once: the badge said 4 while the sheet it
  opened listed 33, i.e. a count on a control that was not the cut it opened. `--untracked-files=all`
  is load-bearing — porcelain collapses a wholly untracked directory to one `?? src/` line, so ten
  brand-new files would have counted as one (the same trap `tree.ts` walks ancestors around).
- `transcript.ts` — **reader view** source. Parses the claude CLI's OWN conversation log (`<claude home>/.claude/projects/<slug>/<conversation-uuid>.jsonl`, one JSON record per line) into `TranscriptTurn[]`: one turn per real user prompt, with the assistant's text / thinking / tool calls (name + one-line label + input + matched result + error flag) in order. Synthetic prompt records (hook output, slash plumbing, `<task-notification>`, caveats) and sidechain (sub-agent) lines never open a turn — sidechains are counted. **A LOCAL COMMAND is the exception, and it is the one the reader was lying about.** `/goal`, `/context`, `/help` are written by the CLI as an envelope (`<command-name>` + `<command-args>`) with a `<local-command-stdout>` record beside it, and dropping both as plumbing — correct for opening a model turn, correct for titling an archive row — also deleted the command and its answer from read mode, while the terminal one swipe away showed both. `localCommandOf`/`localOutputOf` recognise the pair and give it a turn of its own, marked `local: "log"`, whose output is a `screen` BLOCK: terminal text, rendered monospace and never as markdown, because box drawing through a markdown renderer is soup. **And some commands the CLI never writes down at all** — `/btw` is the measured case: no envelope, no stdout, nothing in the log, so the exchange exists only on the screen and in waterplane's own per-turn PTY capture. `screenCommandTurns()` rebuilds those from `HistoryEntry.output` (cut to the command's own echo by `sliceToCommand`, folded to one answer by `foldRepaints`, stripped of the composer/mode/hint furniture by `trimTuiChrome`) and `mergeLocalTurns()` splices them in by time, RENUMBERING every turn — `n` is what the outline scrolls to, and two turns sharing a number send the reader to the wrong one. They are marked `local: "screen"` and say so on the row: approximate by construction, and not forkable (there is no log record to cut at). Only COMMANDS are taken from the capture and only ones the log does not already carry — a prompt reaches the log by definition, and re-adding a logged command would print it twice, the second time approximately. The `since` short-circuit takes `max(log mtime, newest history stamp)`, because a `/btw` moves neither the log nor its mtime and an open reader would otherwise not see it until something else wrote to the log. **Two things that capture is NOT, said out loud rather than papered over.** It is a VT replay, and this TUI does not print a panel and move on: it paints a short draft, then repaints a taller one as the text arrives, and each paint SCROLLS into the replay buffer instead of overwriting the last. Measured (2026-09-12), one `/btw` came back as the question plus its opening paragraph, then the question plus the whole answer — which read as the same exchange happening twice, the first time truncated. Every paint restates the echoed command, so the echoes are the seams: `foldRepaints` drops a section whose body is the BEGINNING of another section's body (that section's earlier draft) and keeps anything that says something the others do not — an answer long enough to scroll leaves rows in an early paint that no later one holds, and folding on "keep the longest" would delete them silently. Compared on the body only, ignoring whitespace, because the echo line itself differs between drafts: the TUI truncates it to the width it has (`very very …`, then `very very e…`). And a replay only has cells that were PAINTED. A TUI paints only the visible slice of a scrollable panel, so rows below the fold were never written to the PTY and are in no record this daemon keeps — not the capture, not the scrollback, not the log the command never reached. The CLI's own `↑/↓ to scroll` footer is the only evidence that happened, and it is chrome `trimTuiChrome` throws away, so `scrollHintTrimmed` keeps it as `TranscriptBlock.scrollable` and the reader says the record is partial rather than presenting it as the whole answer. Asked of the TRAILING chrome run only — a hint mid-capture belongs to a panel the CLI has since repainted over, and hanging the notice under an unrelated answer points at the wrong thing — and worded as *the panel could scroll*, never as *text was lost*, because the footer is printed whether or not anything overflowed. Measured precision on this desktop's history: 1 of 36 command captures. The obvious neighbouring signal — "the capture ends in content, so it sealed mid-paint" — was measured at 18 of 36 and dropped: half of those end in statusline rows (`5 shells · 2 agents`, an agent's elapsed/token line) that `CHROME` does not list, so it would have put a doubt on half the reader's screen blocks to catch a real one. `packages/host/test/localcmd.test.mjs`. Each turn also carries the outline fields: a **heuristic** summary (first sentence of the final assistant text — no AI call, so it's instant and nothing leaves the host), tool count, and repo-relative files touched. Tail-reads at most 24 MB and keeps the newest 500 turns (`truncated` flags either). Exposes `claudeProjectDir()` (`sessions.ts` imports it; defined in `claudeconfig.ts` with `claudeConfigDir()` — the ONE definition of the CLI's private dir: `CLAUDE_CONFIG_DIR` (replaces `~/.claude`, inherited by spawned `claude`, also onto the tmux pane's `env(1)` prefix) over `WATERPLANE_CLAUDE_HOME` + `.claude` (tests) over `~/.claude`; a slug past 200 chars is truncated + hashed by the CLI, so the folder is found by its head and accepted only when exactly ONE holds a log naming this cwd, else absent) and `transcriptFromHistory()` — the fallback that builds turns from the recorded prompt + PTY capture when a session has no conversation log (stub binary, nothing produced yet). Served by `GET /api/transcript?id=<sessionId>[&since=<updatedAt>][&detail=full]`, which answers **204 from a stat** when the log hasn't changed, so the client can poll cheaply. **The default document is `lite`**: tool inputs and results are withheld and each tool block carries `omitted: true` instead. Those two strings are the overwhelming majority of a real conversation's bytes — a day's work is a few KB of prose and many MB of `git diff` and test output — and the phone paid for all of them twice, once over the tunnel on every poll that found a change and once into IndexedDB, which is what made a long session slow to open and unreliable to keep offline at all. What survives the strip is everything the reader shows without being asked: name, one-line label, and `ok` — the last one deliberately, because it is set exactly when a `tool_result` was matched back and is therefore the only remaining evidence that a call FINISHED; without it "still running" and "text stayed on the host" would render identically. The withheld pair comes back per turn from `GET /api/transcript/tools?id=<sessionId>&turn=<turnId>` → `{ tools: { <tool_use id>: { input, result, ok, resultTruncated } } }`, keyed by turn **id** and not turn number on purpose: `n` is a position in the read window, so as the log grows and the 24 MB tail-read slides, turn 7 stops being the turn it was. `?detail=full` returns the old whole-document shape for a caller that wants every byte (the reader's "download details" setting, and `e2e-transcript.mjs`). Works for a merely-closed session too, as long as its conversation id is still remembered. Verified by `e2e-transcript.mjs`.
- `slash.ts` — built-in slash commands + reads user's `.claude/commands/`.
- `files.ts` — file upload to `.claude/inbox/` (ANY kind — photos, PDFs, office docs, archives, audio, source files), artifact gallery (outbox or whole tree), with path-traversal guards. `statInTree()` is the same viewability gate as `readInTree` without the read — it exists so the artifact route can STREAM a big deliverable (see `api.ts`) instead of buffering it. `saveInboxFile(..., { dedupe })` (the `x-dedupe: 1` header) is what makes the phone's QUEUED uploads re-sendable: there is no ackId ledger on the HTTP path, so without it a tunnel that dropped mid-POST leaves the same photo under `name` and `name_2`. The client names a queued upload with a random suffix precisely so "same name, same byte count already on disk" identifies that upload rather than a collision; every interactive upload still always uniquifies. Upload cap = `WATERPLANE_MAX_UPLOAD`. **Two extension sets, deliberately different:** `DISCOVERABLE` (image+video+`DOC_EXT`) is what `discoverArtifacts` walks the tree for, `VIEWABLE` (= that plus `SERVE_ONLY_EXT`: source, config, patches…) is what the transport routes may SERVE. Putting source extensions in the discovery set floods the gallery's "this repo" tab and the per-turn new-file notifications with every `src/*.ts` in the repo; leaving them out of the serve set means the app accepts an upload and then refuses to hand it back. The curated **outbox** scope uses the full set (an agent's `report.yaml` is a deliverable), a whole-repo walk does not. The inbox GET passes `anyType` — an inbox file is there because this app uploaded it, so no extension list gates it — and `.env` files are refused on every path (same promise `git.ts` makes). Filenames arrive percent-encoded in `x-file-name`: an HTTP header is Latin-1 and the browser throws on anything else, so an umlaut in a document name used to kill the upload before it started. **Outbox convention:** the gallery's "outbox" tab scans the dirs in `OUTBOX_SUBDIRS` — `.claude/outbox/` (ours) and a top-level `.outbox/` (some repos' convention), repo→phone. Agents that produce screenshots/artifacts for the phone should save them into one of those; otherwise they only surface under the broader "this repo" tab and the new-image popups (which scan the whole tree). Outbox is deliberately narrow so it stays a curated, phone-facing drop — add new locations to `OUTBOX_SUBDIRS` in `files.ts` if more conventions appear. **The repo badge counts the outbox, not the inbox** (`countOutbox`/`markOutboxSeen`, a `.seen` marker per outbox dir whose mtime is "when you last looked"): the number answers "is there something for me to look at", and inbox files are the ones this phone just uploaded — counting them made the badge a receipt for your own action. It is counted THROUGH `discoverArtifacts`, so the badge and the outbox tab can't disagree about what a file is, and the marker itself is invisible to both (`.seen` has no viewable extension). Clearing is a POST (`/api/repos/:id/artifacts/seen`) for the same reason the inbox marker is: no `/api` GET may change state. The other half of the promise lives in the client — a chip carrying a count opens the outbox with the time filter OFF, because "unread since you last looked" is routinely older than the tab's 4h default, and the bug this all started from was a badge saying 42 opening an empty grid. Verified by `e2e-outboxbadge.mjs`.
- `archive.ts` — **the conversation archive: every chat the CLI ever wrote for a repo, read off disk instead of remembered.** The question it answers is "can we archive conversations instead of just killing them", and the honest answer was that killing already archived — badly. `sessions.kill()` ends the PTY and the tmux session; it never touches `~/.claude/projects/<slug>/<uuid>.jsonl`, and `session.create` with `resumeSessionId` reopens that exact conversation. What was missing was the route back. The two records of a closed session are both **shortlists with a cap**: `recentlyClosed` (the launcher's "Recently closed") and `recent` (`.waterplane/sessions.json`, "Resume recent", capped per-cwd so one busy repo can't evict the rest). On a machine with 60+ live sessions in one repo, the top-of-list × closes all of them in one tap and most fall off both lists in the same gesture — the conversations still on disk, unreachable from the phone. Two fixes, and they are different in kind. `recentlyClosed` is now **persisted** (`.waterplane/closed.json`, tmp+rename, cap raised to 120) and downgrades a stale `alive: true` on load, because a claim that a tmux session is still running is only true if the server survived the restart — `alive` is re-earned by `hasLiveTmux`, never by a file. That is the cheap patch; it makes the shortlist survive the restart it used to be wiped by. The real fix is this module, which keeps no state at all: a listing is `readdir` + `stat` over the CLI's own project directory, newest first, and the filename IS the conversation id, so a row is resumable without anything having remembered it. Nothing to fall out of sync, no cap, nothing a restart can lose. The cost discipline matters because a repo here holds thousands of logs: a row's TITLE is its first user prompt, which means reading the file, so titles are read only for the page being returned, from a bounded head (96 KB — enough for a conversation's opening records even with a `<system-reminder>` block), and memoized by conversation id, which is sound precisely because a first prompt is immutable once written. The `q` search is the one path that has to title everything in the directory to filter it; that sweep warms the same cache, so it is paid once per repo per boot — and it is a SUBMIT in the UI rather than a keystroke filter for the same reason. Titles come from `transcript.ts`'s exported `promptOf()`, which is also what `parseTranscript` now opens a turn on: two copies of "which records are real prompts" would drift, and the visible symptom would be an archive row named `<command-name>` or `<user-prompt-submit-hook>`. `deleteArchived()` is the one genuinely destructive act in the app — the only way to lose a conversation — so it is a separate verb from closing a session, refuses anything that is not a bare id (`transcriptPath` would otherwise happily take `../../`), and the phone arms it per row and refuses it outright while the conversation is open. Routed as `GET`/`DELETE /api/repos/:id/archive`, i.e. inside the same `findTarget` containment every other per-repo route uses. `e2e-archive.mjs` pins the ordering, the awkward title shapes, search, paging, the delete guards, that closing a session leaves its conversation listed, and that the reopen stack comes back after a real host restart.
- **A closed row says what the session WAS and why it ENDED** (`ClosedSession`'s optional facts, built by `sessions/roster.ts`'s `closedRowOf`, rules in `shared/closed.ts`). Asked for because a *Recently closed* list of bare titles was unrecognisable — and a session the HOST closed on its own (close-when-done) has to read differently from one a person closed. `closedBy` is named by the CALLER of `remove`/`kill` (`s.closeBy`): the phone's ×/kill/detach ⇒ `you`, a relaunch's `replaceSessionId` ⇒ `replaced`, `lingerSweep` ⇒ `auto-done`, `reapAutoSession` ⇒ `auto-slot`; the exit path fills in the rest only for a session nobody killed — `limit` when `diedAtLimit` says so (and `doResurrect` writes `resumedAs` onto that row), else `exited` with node-pty's own `exitCode`/`exitSignal` (dropped for a close we caused: that code describes our kill). A kill that named no reason gets NO `closedBy`. There is no "host shutdown" value because no such row is ever written: tmux sessions survive a restart and a non-tmux host exits before any PTY exit handler runs. How it was OPENED rides the live session as `Session.origin` (`create`'s `origin`, set by each opener — `routes/session.ts` `hand`/`fork`, `fork()`, `openItemSession`/`intentDeps.freshSession`/`fanout.runTarget` via `sessionOriginOfIntent`, `doResurrect` `resurrect` carrying the item forward) and is persisted in the `live/` record so a re-attached session keeps it; absent ⇒ no `kind`, never a guess from the title. The item's OUTCOME is read through the store at close time (`setItemLookup`, wired in `server/sessionEvents.ts`) and only for a SETTLED row — `running` on a row that has closed would be untrue of it. Everything else is what the session already held: `openedAt` (`createdAt`), `lastActiveAt` (`lastTurnAt`, else the last recorded capture), `turns` (recorded prompts — a FLOOR, the desktop keyboard is not counted), first/last prompt, the persisted summary and tab name (no new model call), `model`. No branch: nothing on the session knows it without a git spawn. Every string is one line clipped to `CLOSED_TEXT_CAP` (200) and the stack loads row by row through `cleanClosedRow`, so a row from an older host reads back unchanged and a malformed one is dropped alone. `closedrow.test.mjs`, `shared/test/closed.test.mjs`, `e2e-archive` (`you`, `exited` + code, survives restart), `e2e-resurrect` (`limit` + `resumedAs`, `exited`, `you`), `e2e-backlog-slots` (`auto-slot` + the item).
- `tree.ts` — **the worktree as a tree, and the only route that writes a file back.** It exists because `files.ts` answers a different question: `discoverArtifacts` is a flat, mtime-sorted list of DELIVERABLES, and it deliberately keeps source and config extensions out of discovery (`SERVE_ONLY_EXT`) so a repo's own `src/` doesn't flood the grid. "What is actually in this repo" is the opposite shape — a directory at a time, every extension, dotfiles included, ordered by name — so it is its own module rather than a fifth gallery filter. Listing is **lazy**: one `readdir` per request, which is why `node_modules` can be shown rather than hidden (opening it costs a directory read, not a walk); the single recursive path is the `q` name search, and that one DOES use `files.ts`'s exported `SKIP_DIRS`, because the answer nobody wants is fifty copies of `api.ts` from inside a dependency. Git decoration is two processes per listing and both choices are deliberate: `status --porcelain` once for the whole worktree (a folder row wants the worst code UNDER it, so the current level alone is not enough) with an **ancestor walk** on top, since porcelain collapses a wholly-untracked directory into one `?? src/` line and a brand-new file would otherwise render unmarked under a folder that says "new"; and `check-ignore --stdin` for the ignore flags, never `status --ignored`, which enumerates every file in `node_modules`. Ignored files are FLAGGED, not hidden — a build output is exactly the file you want to read from a phone.

  The write half is where the care is. **The second writer is normal here, not exotic**: an agent is working in the same repo while a file sits open on a phone, so a save must present `baseSha` — the sha256 of the bytes it read — and a mismatch is refused `stale` (HTTP 409) with nothing written and the current sha named, so the client can re-read deliberately instead of guessing. Last-write-wins would silently delete a turn's work. The corollary is the part a refactor could quietly break: **a body we could not show in full carries no `sha` at all** (binary, or past `MAX_EDIT_BYTES` = 512 KB), which is what makes a shown prefix un-writable over the rest of the file — the un-editability is a consequence of the data, not a UI flag that could drift. It creates nothing (a missing path is refused: this is an editor, not a file manager), refuses `.env` in both directions (the same promise `git.ts` `readTextFile` makes and the secret sheet relies on), and writes tmp+rename **carrying the original mode** — a rename installs the tmp file's inode, so a hook script silently loses its `+x` otherwise. There is deliberately no queued/offline write path: a save composed now and replayed in an hour carries a base the file left behind long ago, and the only honest verdict for it is the `stale` refusal it would already get. Verified by `e2e-tree.mjs`.
- `thumbs.ts` — **server-made image thumbnails**, the single biggest bandwidth lever. The gallery grid, the new-image strip and the backlog attachment row used to point an `<img>` at the ORIGINAL artifact: measured across this machine's outbox dirs, 1170 images averaging 607 KB (worst case 14 MB), so one scroll through a 300-row grid was >100 MB — unusable on a roaming link. A `?thumb=<w>` on the artifact/inbox GET routes returns a JPEG instead (a real 3.25 MB screenshot → 18 KB at 320 px, 63 KB at 640 px). **No image library is added:** node has no decoder and `sharp` is a native dep that would have to build on every host, so it shells out to whatever the platform already ships — `sips` on macOS (part of the OS), ImageMagick or ffmpeg elsewhere — the same way `host.ts` does screen capture. Widths come from a fixed allow-list (an open one would let a caller fill the cache); results are cached in `<STATE_DIR>/thumbs/` keyed by **path+mtime+size+width**, so a regenerated file at the same path never serves a stale thumb, and the dir self-prunes oldest-first. **Null always means "serve the original"** (no converter, unsupported type, source already under 48 KB, conversion failed) — the feature degrades to the old behaviour rather than breaking. Two carve-outs in `api.ts`: `download=1` always sends the real file, and a VIDEO poster that can't be produced answers 404 rather than falling through — falling through would push the whole movie into an `<img>`/`poster`. Verified by `e2e-thumbs.mjs`.
- `httpio.ts` — response compression + conditional GETs, in one place so every route gets both. `sendBody()` negotiates brotli (quality 4 — near-gzip encode speed, better ratio) then gzip, only for compressible types over 1 KB, and never for a 206 (a compressed byte range is meaningless). `notModified()`/`statTag()` add ETag+304: artifacts revalidate, versioned thumbs (`&v=<mtime>` in the URL, so the URL changes when the file does) are `immutable` for a week, and Vite's content-hashed `/assets` are `immutable` for a year while `index.html` revalidates. Before this, every transcript poll re-sent hundreds of KB of raw JSON and every gallery revisit re-downloaded images the phone already had.
- `builds.ts` — `BuildManager`: per-repo named build commands (persisted in `<repoDir>/.waterplane-shared/builds.json`, COMMITTED with the repo, plus this desktop's own gitignored `<repoDir>/.waterplane/builds.json` — see *two files, one list* below), runnable from the phone WITHOUT a claude session — the **token-limit escape hatch** (still build an APK when Claude is rate-limited). Each run spawns `$SHELL -lc <cmd>` under node-pty, streams output (`build.output` frames, broadcast to all — builds are rare, no per-session attach gating; `full` on reconnect replays the retained tail), and on completion scans the repo (incl. `build/`/`dist/`/`target/`, which the gallery skips) for build-output files touched during the run → surfaces them as `BuildArtifact`s downloaded via the normal artifact endpoint (`files.ts` `DOC_EXT` was widened to cover apk/aab/ipa/jar/… so the serve path allows them). The output scan reads dirents (only candidate files are `stat`ed), never follows symlinks, visits output-looking dirs (`build`/`dist`/`out`/`outputs`/`target`/`bin`/…) FIRST and bounds itself at 200k entries — a flat 40k budget that `stat`ed every entry made detection depend on readdir order in a repo with a big data tree (one app repo: 47k entries, 41k of them under `service/data/`), so a successful build could show no artifact at all. `.iq`/`.prg` (Garmin Connect IQ) are recognised alongside apk/aab/…. **A build that wrote NOTHING still names the artifact.** "Touched during the run" is the right test for what a build PRODUCED and the wrong one for what it can hand you: an incremental build whose outputs are current writes no file at all — gradle prints BUILD SUCCESSFUL and "52 actionable tasks: 2 executed, 50 up-to-date" — so a green `assembleRelease` offered zero downloads and read as a broken setup. With nothing fresh, detection falls back to the newest matching deliverables in the repo, each flagged `stale` with its `mtime`, and the sheet's row says "unchanged by this run": "here is the APK" and "this run made it" are different claims, and only the honest pair is worth showing. Optional per-build sub-dir is traversal-guarded. **Two files, one list.** The owner asked for build buttons on every machine and clone of a repo, and chose a second, committed folder over un-ignoring one file inside the state dir: `.waterplane-shared/` (`BRAND.sharedDirName`, `repoSharedDir`, `sharedRel`; new with this identity, so no legacy spelling) holds the `builds.json` every checkout gets, while `.waterplane/builds.json` stays for what is true of THIS desktop alone — a `JAVA_HOME` path, a local SDK. `list()` is shared then local, and a local entry with a shared id REPLACES that entry in place: a machine override, never a second button. `save(repo, list, local?)` partitions the phone's whole list back — ids in `local` go local; with no `local` (an older bundle) an id stays where it lives and a NEW one goes shared, because reaching every checkout is the point — and a shadowed shared entry is kept exactly as it is, so overriding here never edits what other checkouts run. A file is written only when its content changed (the shared one is in git; a no-op save must not dirty the tree), an emptied local file is deleted, no shared file is created to hold nothing, and a file that exists but does not parse is never overwritten. Wire: `build.list` carries optional `localIds` (absent from an older host = nobody said), `build.save` optional `local`; no `PROTOCOL_VERSION` bump, both are additive. `onboard.ts`' `bindToolchain` saves its JAVA_HOME-prefixed copies as LOCAL overrides; the `builds-configured` setup row reads the merged list and its fix writes the SHARED file (`wx`). Trust model = same as spawning `claude`: the shared file is part of the checkout and exactly as trusted as it (the same buttons run that checkout's gradle files and `package.json` scripts anyway), and a run SNAPSHOTS its command at fire time, so a later pull changes the next run, never a recorded one — no separate gate. Pinned by `packages/host/test/buildsmerge.test.mjs`. Wire: `build.list`/`build.save`/`build.run`/`build.cancel`. UI: the repo-row Hammer button → `BuildSheet.tsx`. **The runs list is not this file's any more.** It was an in-memory ring with a hand-written "never evict a still-running run" loop (evicting one would orphan its process and leak its output); a run is now a `{payload:{kind:"build"}, target:{kind:"shell"}}` intent whose id IS the `runId` the wire already carried, so `build.output` frames are unchanged, and the store's compaction rule already guarantees the thing the loop was for — nothing queued, starting or running may leave the file at all. It guarantees the other half too, which the ring never did: a build that was running when the daemon died comes back as a row that says so rather than a run nobody can account for. The config is RESOLVED and snapshotted onto the row at fire time (name, command, guarded working dir), for two reasons — `builds.json` is edited between runs and a row that renames itself afterwards is a lie about what ran, and every refusal ("unknown build", "invalid working dir") is answered synchronously while there is still a socket to tell. `cancel` records that the death was ASKED FOR, because an exit code from a `kill` is otherwise indistinguishable from a failing command, and the row settles `canceled` rather than as one more red `failed`. **What a run produced is not what a person is handed** — see `artifacts.ts` below. Verified by `e2e-build.mjs` (which runs a second, no-op build to pin the stale fallback).
- `installlog.ts` — **which version of what is on which phone.** Every other part of the download path is a conversation between one desktop and one device, and this is the one question that is not: a build produced here is fetched by every phone whose allow-list names its package and installed by each of them by `ShellPullService`, with the app closed and the document frozen. The only account of that install is a row in the phone that did it — so *is the new build on both phones, and when did the second one get it?* is unanswerable from any single device and trivially answerable here, because this is where the builds came from and the only thing that outlives a reinstall of the app. The store is `settings.ts`' posture exactly: `<STATE_DIR>/installs.json`, tmp+rename, debounced, flushed on SIGTERM, cleaned on the way IN as well as out (a desktop's JSON file is hand-editable, and a row that cannot say what was installed is a gap pretending to be a log line wherever it is read). **It records and never decides** — nothing here installs, refuses or instructs a phone; it is an account of what already happened (`CLAUDE.md`). Three rules carry the whole design. **A report is a RE-STATEMENT, not an event**: the install worth logging is the one that happened at 3 a.m. with the tunnel down, so a phone cannot send it when it happens — it sends everything it still holds on every `hello`, and the merge is keyed and idempotent (`@waterplane/shared`'s `mergeInstallLog`), which is why the route stays QUIET when a reconnect re-states what is already held. Without that, every handshake would broadcast the whole log to every socket for no news. **The key is `<deviceId>:<pullId>:<at>`, and the `at` is in it on purpose**: installing the same build twice is two things that happened, and a key that folded them would lose the second; a shell too old to stamp `installedAt` falls to `0` and folds its re-installs into one row, which is the honest consequence of not knowing rather than a row per reconnect. **The host stamps only its own clock** — `at` is the phone's and an older shell leaves it ABSENT, so a reader says *reported 08:14*, a claim about the log, instead of *installed 08:14*, a wrong claim about the install. A repeat may FILL IN what was missing (the phone has since read the app's label) and may never blank what was there. The devices are DERIVED per read, never stored beside the entries: a device list that can disagree with the log is one nobody can trust, and a phone whose entries all aged out would otherwise linger claiming installs nobody can see. Wire: `install.get`/`install.report` → `install.log`, additive, `PROTOCOL_VERSION` stays 1, not durable and never queued offline — an ackId protects a delivery that is not already idempotent, and this one is. `packages/shared/test/installlog.test.mjs` (the rules) · `packages/host/test/installlog.test.mjs` (the store).
  **What a review changed, and why each one was reachable.** The cap was spent on `entryAt`, which prefers the PHONE's clock: a device a year fast held the top of the log for a year, and the rows that aged out were every other device's real history — reachable by a wrong unit as easily as by malice, since the key carries `at` and a varying one mints a new row per report. Eviction is `reportedAt` now (the host's own stamp, unspoofable) and only the DISPLAY order is `entryAt`; an equal share is reserved per device and the remainder goes by recency, so one phone alone still gets the whole cap and the share only ever costs the loudest device. An `at` later than the moment the host was told is refused outright — an install is reported after it happens, so that is provably not its instant — and the row then says *reported*, which is true. The key is JSON rather than `a:b:c`, because neither half is shape-checked and `("a:b","c")` and `("a","b:c")` were the same string, which is one phone's install landing on another's row. A failure's words no longer travel onto an outcome that is not a failure: on an `at`-less key (an older shell, where a retry folds onto one row) a failed install followed by a successful one came out `installed` still carrying *no space*, which `cleanInstallEntry` refuses to build in the first place. The load path drops a row with no usable `reportedAt` instead of stamping the boot instant on it — the same invention it forbids for `at` — and per-report truncation sorts by recency first, so a phone holding more terminal rows than one report may carry loses its OLDEST rather than whichever the sender happened to list first. **And `auto` became tri-state**, which was the sharpest of them: `false` is not the absence of a claim, it is the positive claim *a person tapped this*, so every unattended overnight install performed by a shell older than the field was logged as something somebody did by hand. Absent now prints no clause at all.
- `artifacts.ts` (+ `@waterplane/shared`'s `artifacts.ts`) — **what a build leaves behind, and what it is called.** Three defects, measured across nine repos on this desktop at once, all of them invisible on the phone: three repos each produce a deliverable called exactly `app-debug.apk`, so the download list, the install log and the outbox show one word identifying neither the app nor the build; a script that copies its output to a friendlier name leaves the original in place, both are detected, both are queued, and the phone — which fetches one download at a time — spends 454 MB on one 227 MB APK; and nothing anywhere ever removes an old one (the 6.8 GB of transport files across fourteen repos that produced the sweep came mostly from here). The answer is host-side and not per-repo, because nine repos cannot each be taught this and the tenth is written by an agent that has never read the other nine: after every run, what it produced is FOLDED to the distinct artifacts among them, COLLECTED into `.claude/outbox/` under a name carrying the repo + the variant + the project's own version, and older builds of that same artifact are PRUNED. On by default, per repo, in `<repoDir>/.waterplane/artifacts.json` beside `builds.json` and `autopull.json` — how a project names and keeps its deliverables is a property of the project. Wire: `artifacts.get`/`artifacts.save` → `artifacts.config`, additive, not durable, BROADCAST on a save (`pull.save`'s shape and its reasons, including the containment: it MKDIRs and writes inside a client-named directory). **The rules are in `@waterplane/shared`** so the phone words the switches with the vocabulary the host acts on, and so they are pinned with no filesystem (`shared/test/artifacts.test.mjs`); `familyKey` MOVED there from `autopull.ts` because the prune asks it the same question the download queue does — "is this an older build of the thing I just made?" — and two answers to that would mean the phone de-duplicating one way while the desktop deletes another. **A name that already says which build it is, is kept** (`picture-app-debug-v1.1.0-344.apk`, `fp-functions-bundle-20260922-1042.tgz`): renaming those breaks the link between what the build printed and what arrived. **Identity for the fold is size AND a head+tail fingerprint, never size alone** — two ABI splits of one app are within bytes of each other and folding them would silently drop a release; a file that cannot be read is never folded with anything. **The copy is a COW clone, not a hard link** (`COPYFILE_FICLONE`, falling back to a real copy): links were cheaper and wrong, because `flutter build`, `cp -f` and `printf >` all rewrite their output IN PLACE, so the next build landed inside the artifact collected from the previous one and "the newest 3" became three names for one file. **The prune is narrower than the sweep and deliberately so**: only inside `.claude/outbox/`, only files whose `familyKey` matches something THIS run just produced, only past the newest `keep` (3), never the run's own output, and always through `files.ts`' `deleteArtifact` rather than a second `rmSync` with its own idea of safe — a build cleans up after itself and never touches a family it did not just rebuild. Every action is a LINE IN THE RUN'S OWN OUTPUT: a file appearing in the outbox and an older one ceasing to exist must both be sentences somebody can read afterwards. Nothing here may fail a build — an unwritable outbox, a refused clone or a vanished file degrades to "collected nothing", which is exactly where the feature started — and nothing touches what the build wrote: gradle's tree is not ours to tidy. `packages/host/test/artifactcollect.test.mjs` pins the disk half, `scripts/e2e-artifacts.mjs` the wire and the prune. **The AI that writes a repo's build buttons is told all of this** (`web/buildPrompt.ts`'s `ARTIFACT_RULES`, in both prompts): the first generation of those prompts produced exactly the three defects above, so a generated command must now not copy into the outbox, not stamp a name, and not delete anything.

- `buildscan.ts` — **what this repo can already build, read off its own files.** `builds.ts`' sheet already had one answer to an empty field: the *set up* button, which opens a session and spends an agent turn working the whole project out. That is the right tool for an empty sheet and the wrong one for adding ONE more command — and it is the wrong tool at exactly the moment this sheet exists for, since a rate-limited Claude is the reason you are looking at the Build sheet in the first place. The second answer costs nothing: walk the worktree, read the files that DESCRIBE builds (`package.json` scripts, gradle build files, `Makefile`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `CMakeLists.txt`, `.github/workflows/*.yml`, `scripts/*.sh`) and hand their text to `@waterplane/shared`'s `scanCandidates`, which owns every rule about what may be suggested. Measured on this repo: 31 candidates in 10 ms. **The split is the point** — the walk is the only part that needs a disk, so every decision is pinned by `packages/shared/test/buildscan.test.mjs` with no filesystem and no daemon. The walk is bounded in three directions (depth 3, 400 directories, 256 KB a file) because this runs on a WebSocket frame from a phone in the process pumping every live PTY, and `SKIP_DIRS` is pruned before descending rather than after reading; a truncated walk is still an honest answer, so hitting a cap degrades to a shorter list and never to an error. Dotted directories are skipped and `.github/workflows` is then read back explicitly, because CI is the single most honest description of how a project builds — it is the command set somebody proved works on a clean machine. Wire: `build.scan` → `build.candidates`, additive, `PROTOCOL_VERSION` stays 1, contained like `build.list` for `build.list`'s reason and NOT durable, since it reads files, writes nothing, and a duplicate frame costs one more walk for the same list. A failed scan answers with an EMPTY list rather than silence: the editor is waiting on that frame to stop saying "reading the repo…", and a phone that never hears back cannot tell a slow desktop from a broken one. **`MANIFESTS` here and the readers in `shared/buildscan.ts` widen together** — a name added to one and not the other is a file that is read, parsed by nobody, and quietly ignored.

- `autopull.ts` — **auto-download**: the inbox in reverse. The phone could push images into a repo and pull one back by tapping it; what was missing is the case that matters on a bad link — an agent drops a 90 MB APK into the outbox while the phone is in a tunnel, and by the time you look, "download" starts a fresh transfer that a dead spot kills at 80%. Two halves on purpose: the **rule** is per repo (`<repoDir>/.waterplane/autopull.json`, next to `builds.json` — what is worth auto-pulling is a property of the project: `scope` outbox|repo, glob-ish `match` patterns, a `maxBytes` cap, `builds` on/off, `supersede` on/off), and the **queue** is host-wide and persisted (`<STATE_DIR>/pulls.json`, tmp+rename, capped + age-pruned). The queue is on disk for the same reason the ack ledger is: the file almost always lands while nothing is connected, so a live broadcast alone reaches nobody, and `npm run restart` is routine enough that an in-memory queue would silently drop exactly the pull you were waiting for. Item ids are `sha1(repoId + relPath + mtime)` — a re-detect is the SAME entry (no double download), while a REGENERATED file at the same path is a new one. What is deliberately NOT tracked: whether a device already has the file — several phones can subscribe, so "done" is per-device client state. Detection is its own baseline in `main.ts` (`pullSeen`, snapshotted per session WITH the scope it was taken under, so a rule edited mid-session re-seeds rather than reporting the whole new scope as freshly produced), independent of the notification scans and their spam caps. `source: "manual"` (the legacy `pull.add` route — a current client's taps are `local` records in `web/pull.ts` and never reach the host at all) bypasses the rule entirely — gating an explicit tap on a configured pattern would make the button silently do nothing (the `supersede` flag is still read for it, since "keep only the newest" is a property of the project, not of how a file got queued). **Newest-only (`familyKey`)**: an APK named with its build hash is a NEW path every rebuild, so an afternoon of builds queued five 23 MB files and the phone — one download at a time — spent 115 MB to reach the one it wanted, LAST in the queue. Each queued item carries a `family`: dir + extension + the name with the *variable* tokens folded out (all-digit runs, a hex run of 6+ that CONTAINS a digit — so words like "facade" stay stable and don't merge unrelated artifacts — `v2`-style versions, and files.ts's `_N` uniquifier). Every stable word is kept, which is what stops `app-debug.apk` from eating `app-release.apk`; a name that is entirely variable (`1000074170.jpg`) falls back to the exact path, so a same-path regeneration still supersedes while two unrelated photos never do. **The separator set is part of that rule, not a detail of it.** Splitting on `[-_. ]` alone left `picture-app-1.1.0+343.apk` folding to `picture-app-0+343.apk`: `+` is not a separator there, so the build number stayed fused to the last version digit as `0+343`, which is neither all-digit nor hex and therefore read as a stable WORD. Every build of that app was its own family, nothing ever superseded anything, and the phone re-fetched 130 MB per build and kept the previous one queued beside it — the failure landing on exactly the artifacts whose names carry a version, which is what the rule exists for. `+` (semver build metadata, and what Flutter, pub and a Gradle `versionName+versionCode` write) and `~` (the Debian pre-release spelling) split too. Deliberately NOT folded: a letters-plus-digits token like `rc1` or `arm64` — folding those would make an `arm64` build supersede the `x86` one, and an extra release candidate on the phone is a far cheaper mistake than a silently deleted ABI split. The key is also RE-DERIVED when the queue is loaded rather than trusted from the file: it is a pure function of the path, so that changes nothing except when the rule itself has been corrected, where a row still carrying the old key would be superseded by nothing for as long as it sat in the queue. `packages/host/test/autopull.test.mjs` pins both directions, since folding too little costs a download and folding too much deletes an artifact. When a new item lands, queue entries with the same repo+family and a **strictly older mtime** are dropped and named in the new item's `supersedes` (equal mtimes are not evidence one replaces the other — a build legitimately writing two files in one second must keep both). **Saving a rule that is ENABLED catches up with what is already on disk** (`catchUpCandidates` + `main.ts`'s `pullCatchUp`): every other path here is a DETECTOR — the turn-end scan diffs the scope, a finished build hands over what it produced — so all of them only ever see a file that appears AFTER the rule exists. Measured: the rule for picture-app was saved at 10:43 and the 227 MB APK it was saved FOR finished at 10:42, one minute earlier, so nothing was ever queued, silently, and the switch read as broken. A person switches the rule on while looking at the artifact they mean. The catch-up is bounded because the same argument does not extend to a year of artifacts — the newest of each `familyKey` only, three at most, nothing older than a day — and the LAST BUILD is asked separately from the scope, since a build writes where it writes (`build/app/outputs/…`, the repo root) and an "outbox" scope does not cover that at all, which is precisely how the miss happened; an artifact the run recorded but that is gone from disk is skipped rather than queued as a download the phone can only fail at. The save **answers either way** — what it queued, or *nothing here matches yet* — because a queue you cannot see filling and a switch that does nothing are the same screen. Verified by `e2e-autopull.mjs`.
- `answergate.ts` + `plugins/` — **plugins and the answer gate**, the decision oracle's successors: the oracle itself is now a plugin outside this repo. The reasoning and the rules are [plugins.md](plugins.md); `answergate.ts` holds the oracle's old `isBlocked`/`isBlockedText` blocklist as CORE, because it guards the core's keystrokes whoever asks for them.
- `readImageText` (in `readtext.ts`, route `POST /api/host/readtext`) — **the words inside one highlighted band of an image, read back verbatim.** `GEMINI_API_KEY` and the `postGemini` transport (one retry/timeout policy), and deliberately none of a decider's machinery: no blocklist, no confidence, no caps, no autofire. It DECIDES nothing — the sentence it returns is shown on the phone to the person who drew the mark, who edits or drops it before anything is sent anywhere — and it is asked for by hand, once per mark, so the budgets that exist to bound an unattended spender do not apply. The reason it exists is a measured loss: the marked copy of a screenshot is re-encoded down to the link's width on the way up (`web/uploadScale.ts`), so the band a person drew round an error message survives and the eight-pixel text inside it does not, leaving the agent a picture of a sentence it cannot read. Reading the crop at the resolution the phone still holds turns that into the sentence itself — fewer tokens than an image to squint at, and unmisreadable. The contract is transcription ONLY (no summary, no correction, no description; an empty string is a verdict), a long answer is REFUSED rather than quoted (a model that started describing instead of reading is the one wrong answer this must never give), and every failure is a different sentence: no key, off by `WATERPLANE_OCR=0`, dead network, no legible words. The route writes nothing and names no repo — the bytes are the body because the crop is cut from an image that has not been uploaded yet and may never be — and a reason comes back as a **200**, since "this host has no reader" is an answer to show, not a transport failure to retry. Metered as `kind: "ocr"` beside the oracle's own calls. `e2e-api.mjs` pins the no-key answer, the empty body and the non-image body.
- `meter.ts` / `usage.ts` — cost + budget telemetry, two different sources. `meter.ts` counts waterplane's OWN LLM calls (the text reader's, kind `ocr`, and plugins', kind `plugin:<id>`) into `<STATE_DIR>/usage-meter.json` with a per-model price table; unknown models cost 0 rather than a guess (`WATERPLANE_METER=0` disables recording, history stays readable). `usage.ts` is the CLAUDE-side figure: there is no local file or flag for live rate-limit consumption, so it scrapes `/usage` from a short-lived `claude` PTY and caches it (`WATERPLANE_USAGE_TTL_MS`), `ok:false` when parsing fails.

  **`? / ? wk` after every OTA update, and the three separate reasons for it** (2026-09-22). The
  phone's gauge went blank whenever a new web bundle shipped — which is to say after every
  `npm run restart`, since that is what ships one — and stayed blank for minutes. Three faults
  stacked, each of which alone was enough:

  1. **The probe could not succeed at all under launchd.** The daemon's `claude` inherited no
     `USER` (a launchd agent inherits almost nothing), and a `claude` without one opens `/usage`
     with its local Session panel drawn and the ACCOUNT rows — the two percentages — never arriving.
     Bisected against a probe that waits 40 s: every other variable absent still paints in 5 s,
     `USER` absent alone never paints. `ptyEnv()` moved out of `sessions.ts` into `ptyenv.ts` and
     now floors `USER`/`LOGNAME` from `os.userInfo()` beside the `LANG` floor that was already
     there for the same launchd reason, and the scrape uses it — one env floor for a session and
     for a probe, since they spawn the same binary.
  2. **A blank screen outranked a real reading.** A render that named NEITHER window took the
     SUCCESS path: `ok:false` with a fresh `checkedAt`, which overwrote the cache and then stood
     for the whole eight-minute TTL with nothing asking again. A probe that produced nothing is now
     a FAILURE (`fail()`), and a failure keeps the last reading minus any window that has since
     rolled over — `usagelog.ts` already says why ("a failed probe is a fact about this daemon, not
     about the account's limits") and the live gauge is the same fact. `FAIL_TTL_MS` is what keeps
     a screen that asks on every navigation from spawning a `claude` per tap while the CLI really
     is unreadable.
  3. **The cache is in memory, so a restart started at "unknown".** The readings were on disk the
     whole time. `usage.seed(usageLog.last())` re-offers the newest one at boot, and every rule
     about what may be claimed from it is in `rememberedUsage`: a window is offered ONLY while the
     reset instant the screen named is still in the future, `checkedAt` stays the ORIGINAL probe's
     instant (so `budget.ts`'s staleness gate and `getFresh`'s TTL both keep working with no second
     rule), and `remembered: true` rides to the phone — the stats sheet says the reading is from
     before the restart and can only have filled further, and a plugin's answer policy (via
     `api.claudeUsage`) can refuse to type a digit into somebody's session on a reading nobody took
     this boot.

  The same rollover rule runs on the LIVE cache (`usageAfterResets`, in `get()`): nothing re-scrapes
  on a clock here, so a cache can outlive its own five-hour window by hours, and 46% of a window
  that reset at lunchtime is not 46% of anything. And the screen is now LOOKED at repeatedly rather
  than once at nine seconds — the first probe after a restart races a cold `claude`, looking again
  costs a render of a buffer already in memory, and the hard stop at 20 s is the only place a probe
  is declared failed. `packages/host/test/usage.test.mjs` pins the remembering and the rollover.

  **The capture is RENDERED before it is parsed** (`render.ts`, the headless VT replay lifted out
  of `sessions.ts` so `screenText()` and this probe share one implementation). The TUI draws with
  absolute cursor moves, so the gap between `Current` and `session` is a cursor jump and not a
  space: an ANSI-stripped capture reads `Currentsession` and `ResetsSep10at7pm(Europe/Berlin)`.
  The two PERCENTAGES survived that, being read off a deliberately squashed copy — which is why
  nobody noticed — but both RESET instants are read off a spaced one, matched nothing, and came
  back null on a screen that printed them both. The phone then said *the screen did not name a
  reset time for this window* under each bar, and a percentage with no clock on it is the half of
  the answer that cannot say whether to wait ten minutes or three days. `packages/host/test/
  usage.test.mjs` pins both instants off a real rendered screen, and keeps the stripped input as a
  test of its own: percentages yes, resets null.
- `context.ts` — context-window percentage/token scraping off the PTY tail, same heuristic family as `prompt.ts`/`limit.ts`. Degrades to `null` (badge hidden), never to a wrong number.
- `compliance.ts` — **repo setup checklist + idempotent fixes**: is this repo wired the way the phone workflow expects (CLAUDE.md tells the agent about `.claude/outbox`, transport dirs gitignored, `.env` files ignored, optional Gemini credential reachable). Fixes only ever ADD (a gitignore line, a CLAUDE.md section, a helper script) — never delete or untrack — so re-running one can't lose work. UI: `SetupSheet.tsx`. Verified by `e2e-setup.mjs`.
- `requirements.ts` (now `packages/extensions/requirements/host/requirements.mts`, an in-repo extension contributing through `api.setupCheck`/`setupFix` — [plugins.md](plugins.md#in-repo-extensions)) — **the requirements list as a setup row.** The list (`docs/requirements/`, format and prompt filter in `shared/requirements.ts`) is built by `scripts/requirements/update.mjs`: haiku extracts candidates from the person's prompts in the CLI transcripts, sonnet merges them with commit subjects+bodies as add/amend/status OPS in chunks of 120, and the script applies the ops itself so an item no op names keeps its bytes — a drifting model cannot drop one. It leaves an uncommitted diff; nothing applies itself. The row never spends: not set up is a PASS with the `requirements` fix (writes the preset + an index stub) because an opt-in offered as a warn is a warn on every repo nobody can close; set up and never built, or `REQ_STALE_PROMPTS` prompts behind, is a warn whose detail quotes the command, which `setupRemedy.ts` hands to the repo's agent with a brief to verify `requested` items against the code (the step commit messages cannot do). Transcripts are append-only, so the count reads each file once and afterwards only its new bytes — waterplane's own folder is over a gigabyte (first scan ~3 s, then ~20 ms). It also says when `cleanupPeriodDays` would delete prompts before any build reads them. Measured on child-paint: 27 prompts, 13 commits → ~26 items for ~$0.20 per full build; commit bodies took `shipped` from 12 to 19 of 29.
- `apkcheck.ts` — **the repo half of a quiet APK install**: the `apk-install` setup row, emitted
  only for a repo that builds an Android app — is there a build in the outbox for the phone to
  download, which key signs it, is `targetSdk` at or above `APK_TARGET_SDK_LINE`. Advisory and
  read-only; a value it cannot read (a `targetSdk` from a variable) is absent, never a number. The
  phone half (install access, the app's auto-install switch, waterplane having done the first install) is
  read on the phone (`installPolicy.ts`). Tested by `apkcheck.test.mjs`.
- `appready.ts` (+ `apkcheck.ts`' `apkRepoFacts`) — **the same repo half as DATA, across every
  repo**: `GET /api/apps/readiness`. Measured need (2026-10-09): nine Android apps over nine repos,
  the repo half a prose paragraph in each repo's setup sheet, the phone half on the Apps screen, the
  outcomes in the install log — and the owner had lost track of which apps were actually set up,
  while Tiptoi passed every repo check and failed on the phone (Play Protect, a new device id) and
  picture-app failed on a full disk. So the desktop reports facts per app module — package plus each
  literal `applicationIdSuffix` (the waterplane app installs as `….dev`), key kind, `targetSdk`, outbox
  APKs, which build commands read like APK builds (a label, never a filter), and whether the
  auto-download rule's patterns and size cap take the newest APK — and the PHONE words them
  (`appReady.ts`, joined with its own half in `AppsSetupPane.tsx`, the Apps screen's `setup` pane):
  the first `no` is the blocker, `unknown` blocks nothing, the last attempt is this phone's own.
  Primary checkouts only (an agent worktree is the same app twice), one repo at a time on the loop,
  and a package-less module beside a named one (a root `apply false` plugin line, a template) is
  dropped. `installPolicy.ts`' `failureText` now says what Play Protect's
  `INSTALL_FAILED_VERIFICATION_FAILURE` and an abandoned session mean.
- `setupwatch.ts` — **the checklist, asked without being asked.** `compliance.ts` only ever ran when
  someone opened the sheet and picked a repo from a dropdown, i.e. for the repos they already
  suspected; the ones that bite are the other ones — a clone made on the desktop and then driven from
  the phone, where the first symptom is an inbox photo showing up in `git status`, or an agent that
  never uses an outbox because its CLAUDE.md never mentioned one. So the host sweeps: every
  discovered PRIMARY worktree is inspected once when first seen (`WATERPLANE_SETUP_SWEEP_MS`, batched by
  `WATERPLANE_SETUP_SWEEP_BATCH`, yielding to the event loop between repos), re-inspected when the verdict
  goes stale (`WATERPLANE_SETUP_RECHECK_MS`), and inspected again on `sessions.on("created")` — the moment
  a repo starts being driven is the moment its wiring starts to matter. Three rules hold it in place:
  **it never writes into a repo** (only `inspectRepo()` runs here — a daemon that edits the CLAUDE.md
  of a repo you have not opened is a worse surprise than the misconfiguration), **absent ≠ clean**
  (`RepoTarget.setup` is simply omitted for a worktree nothing has checked, so the UI can't read
  silence as a pass), and **host-scope rows don't count** (`summarize()` skips `scope: "host"` —
  one unset `GEMINI_API_KEY` would otherwise flag every repo on the machine, and a badge that is
  always on is a badge nobody reads). **A CONTRIBUTED host-scope row is not on a repo's checklist
  at all** (`setupcontrib.ts`: `contributedChecks` leaves it out, `hostChecks`/`hostFixes` serve
  `GET /api/host/setup` + `POST /api/host/setup/fix`): the live desktop's grants were listed under
  every repo, where a fact about the Mac read as that repo's fault, and the phone draws them once
  in Settings → Tools → *desktop setup*. A fix there runs only if a desktop row names it now. Persisted to `.waterplane/setup.json` (tmp+rename), keyed by
  **realpath** because `git worktree list` resolves symlinks and a session `cwd` does not — two
  spellings of one directory would mean the badge never clears for the repo you just fixed.
  `/api/repos` reads the store rather than shelling out to git per repo per request; the checklist
  GET and the fix POST write their fresh verdict back into it, so the row badge clears on the next
  listing instead of the next sweep. UI: the chip on the launcher's repo row — amber for warns, red
  for a failing check — plus the repo menu's `repo setup · N` entry, which is drawn whatever the
  verdict is so a CLEAN or never-inspected repo can still reach its own checklist. Both open
  `SetupSheet` on that repo; the chip is a findings badge, the menu entry is the door, and neither
  gate does the other's job (see `RepoSetupState`). `e2e-setupwatch.mjs`.
- `secrets.ts` — **write-only** secret setter: splice `KEY=value` into a gitignored dotenv file, host scope (a fixed per-user config dir, so secrets don't move with `WATERPLANE_ROOT`; `WATERPLANE_CONFIG_DIR` overrides for tests) or repo scope. There is deliberately NO read path — a written value can never come back to the phone, a transcript, or the oracle's context; callers get a masked tail. The gitignore GATE refuses to write into a git-TRACKED file and auto-ignores an untracked one, so a secret can't reach history. Not at-rest secrecy: the file is plaintext on the host and the `claude` CLI can read it. Verified by `e2e-secret.mjs`.
- `update.ts` — `claude` update availability + apply, **on whatever installed it**. The install
  route is READ off the realpath of the binary the host spawns (`routeFromPath`: `Caskroom` ⇒ brew,
  `node_modules/@anthropic-ai/claude-code` ⇒ npm, `~/.claude/local` or `~/.local/…` ⇒ native, else
  `unknown`), never configured — the near end of the symlink is the same path under brew and npm, and
  two managers can both answer "yes I have claude-code" while only one is on the PATH. `unknown` gets
  **no command**: running some other manager's upgrade reports ITS complaint as the CLI's.
  `applyPlan` is the one place a route becomes commands, and its `label` rides to the phone
  (`UpdateInfo.applyLabel`) so the button says `npm update` or `brew upgrade` without the UI
  re-deriving ownership.
  Two independent signals feed `available`: the route's own index (`brew outdated --cask`, or
  `npm view … version` compared numerically — `2.1.10` is newer than `2.1.9`, which a string compare
  gets backwards) OR the CLI's own scraped "Update available!" banner. The banner exists because the
  CLI checks **npm** while brew's cask index lags it — measured 2026-09-24, cask at 2.1.273 against
  npm 2.1.281, eight releases. On npm the index and the CLI's reference are the same registry, so
  `installed === latest` may clear the banner; on brew they are two indexes and a current cask must
  never silence an npm-sourced nag, or the button goes quiet while the nag stays on screen.
  If an upgrade runs clean and the version doesn't move we say why in that route's terms instead of
  reporting a false success. **That sentence was invisible for its whole life**: `App.tsx` ranked the
  "an update is available" headline above a fresh `lastResult`, and a no-op upgrade leaves
  `available` true — so the bar asked for the upgrade again and only a few-second toast ever carried
  the reason. The result now outranks the headline while it is fresh.
  Live sessions keep their loaded binary (the kernel holds the inode) — only new spawns pick it up,
  so upgrading, and even swapping routes, is safe mid-session.
  **Keeping a fallback binary is `ln`, never `cp`**: a copy is a new inode, so macOS re-runs the
  Gatekeeper assessment on first exec and a 200 MB Mach-O sits blocked in dyld for minutes. A hard
  link is the inode the system has already assessed, and it survives `brew uninstall` deleting the
  Caskroom entry.
- `host.ts` — desktop introspection for the phone: CPU/mem/load snapshot, GPU utilization + memory in use (Apple Silicon only, off `ioreg`, `null` on any other platform or failure — see `localrt.ts`'s section for why it degrades on multiple accelerators), and a whole-screen capture (macOS `screencapture`, Linux tools in turn). Capture is POST (`/api/host/screenshot`) because it has side effects — see `origin.ts`.
- `auth.ts` — LAN password gate; see **Security model** below.
- `webbundle.ts` — **what the Android shell updates itself from**, plus the one definition of `WEB_DIST` (`main.ts` serves static files from it, so the bytes we serve and the bytes we describe can never be two different trees). `GET /api/webbundle` walks the built PWA and returns a build id plus per-file size+sha256; `GET /api/webbundle/file?path=…` hands one file back. It exists because the APK carrying the UI — the whole point, since a dead tunnel can then no longer take the app away — would otherwise ALSO freeze it at APK build time, and pushing an APK for a CSS change is the wrong half of that trade. **The id is content-derived** (`dist/build-id.txt`, written by the web build's `buildStamp` plugin): `npm run restart` rebuilds constantly, and an id that moved per build would have the phone re-downloading ~1 MB over a roaming link to arrive at a byte-identical bundle. **Per-file sha256** so the client can verify each piece before it replaces a working app — that is protection against a truncated transfer, NOT against a hostile host, which already runs `claude` on this machine (SECURITY.md). Hashes are cached against a paths+sizes+mtimes fingerprint (the phone polls this). Exposes nothing `serveStatic` doesn't already hand out at `/` — the same tree, described instead of served — and degrades to `ok:false` with a reason (no dist, no `build-id.txt`, past the caps) rather than throwing. Verified by `e2e-webbundle.mjs`.
- `api.ts` — HTTP endpoints for files, slash, git, push subscription, etc. WebSocket carries everything stateful; HTTP carries uploads/downloads. **Artifacts over `STREAM_MIN` (2 MB) are piped off disk, not buffered** (`serveFileStream`): `readInTree` reads the whole file, which is fine for a screenshot and wrong twice over for a 300 MB APK — the host holds its full size in RAM per request, and a phone resuming the download re-requests ranges of that same file, so every resume would re-read all of it. Streaming makes a resume cost the bytes it asks for. Four details are load-bearing for resumability: `accept-ranges: bytes` on the 200 (without it a downloader has no choice but to restart), a correct `content-range` total on the 206, **416 for an unsatisfiable range** — falling through to a 200 there makes a resuming client append a whole second copy to what it already has and call the result complete — and **`if-range`**: a resume says "continue only if this is still the same file", so a validator that no longer matches drops the range and sends the whole body. Without it a rebuilt APK at the same path answers the old offset with bytes from the NEW build, which the client appends to the old prefix: a corrupt file that looks complete and passes every check the client can make. Both rules hold on the buffered small-file path as well — a client cannot tell which path served it. Small (text) artifacts keep the buffered path so `sendBody` can still compress them. The inbox POST **logs one line per file** (`[usmc] inbox <repo> · <name> · <bytes> · saved|already there (re-send)|REFUSED <why>`): it is the only record that an upload ARRIVED, and without it "the POST never happened" and "the POST was refused" are indistinguishable afterwards — which is what made a batch of phone images that never reached `.claude/inbox` impossible to diagnose from the host side.
- `net.ts` — Tailscale IP detection for default bind; `lanIps()` (private IPv4s for the "hit the LAN IP to bypass the tunnel" hint), `peerKind()` (trust tier of a socket's remote address) and `tailscaleBin()`.
- `origin.ts` — **same-origin guard** for `/api/*` and the WS upgrade. The network-identity boundary does NOT cover browsers: a WebSocket is exempt from the same-origin policy, and the API used to answer `access-control-allow-origin: *`, so any web page loaded in a browser on this machine or any tailnet device could open `ws://127.0.0.1:8770/ws`, spawn a session and run code — without ever being on the tailnet. `checkRequestOrigin()` therefore checks BOTH `Origin` (browser-set, unforgeable; the primary check) and `Host` (closes DNS rebinding, where an attacker name resolving to 127.0.0.1 makes the requests same-origin). A MISSING `Origin` is allowed — curl, the e2e scripts and the hook sink never send one, and a browser always does when it matters. The gap that leaves is a cross-origin **GET** (`<img src=…>`), which carries no `Origin` at all; `Sec-Fetch-Site` is the backstop for it (browser-set, unforgeable by page JS, absent on non-browser clients → anything but `same-origin`/`none` is refused). Belt and braces: side-effecting endpoints must not be GET routes either — `/api/host/screenshot` is POST for exactly this reason. Allowed hosts: loopback/127.x, the Tailscale IP, the exact MagicDNS name, this machine's own `<hostname>.local`, bound LAN IPs, plus `WATERPLANE_ALLOWED_HOSTS`/`WATERPLANE_ALLOWED_ORIGINS` for a reverse proxy or custom alias. `*.ts.net` is accepted by suffix ONLY as a fallback when we couldn't read our own MagicDNS name — don't widen it back to a blanket wildcard, and don't reinstate `*.local`. Ports: the bound port, 80, 443, **our own discovered `tailscale serve` front door whatever port it landed on** (`OriginConfig.serveUrl`, fed from the same `serveHttpsUrl(PORT)` the client gets as `welcome.httpsUrl`), plus the Vite dev port when `WATERPLANE_DEV=1` (set by the host's `dev` script — a production daemon has no reason to trust another server on the machine). The serve-door entry is not a widening — it is read off the local tailscaled and only for the listener whose proxy target is OUR port — and it closes a trap that mattered: `--https=443` claims one slot per machine, so a host already serving something there gets fronted on some other port, and a guard that refuses it makes the app advertise an HTTPS address it then 403s. The user then stays on plain `http://100.x`, which is not a secure context, so there is no service worker — and a dropped tunnel during ANY navigation (a reload, or Chrome discarding and restoring the tab) replaces the whole app with `ERR_CONNECTION_TIMED_OUT`. `corsHeaders()` reflects the caller's (already-allowlisted) origin — never `*` again. Configured at boot once the Tailscale/LAN facts are known. Verified by `e2e-origin.mjs`.
- `doctor.ts` — **preflight checks**, the "why isn't this working" answer. Nearly every first-run failure is silent: a logged-out `claude` spawns a PTY that dies at the login screen, no Tailscale IP means the phone can never reach the host, plain HTTP means push/clipboard/install no-op. Each check returns `ok|warn|fail` with a one-line finding and a one-line fix. Runs fire-and-forget after listen (warnings only — a degraded host still works) and standalone via `npm run doctor` (`main.js --doctor`, report and exit). `WATERPLANE_PREFLIGHT=0` disables the boot run; the e2e scripts set it. The secure-context check consults `tailscale serve status` so it doesn't nag someone who already set up TLS.
  - **WSL checks** (`doctorwsl.ts`, pure over injected facts, only under WSL): `wsl-tailscale` (no Tailscale IP: mirrored networking or in-distro Tailscale), `wsl-systemd` (PID 1 not systemd: `/etc/wsl.conf`), `wsl-interop` (EXECUTES `/mnt/c/Windows/System32/cmd.exe /d /c exit 0`, 5 s: "Exec format error" — ENOEXEC, exit 126 or the words — is a warn naming what is lost and both fixes, `wsl --shutdown` or re-registering `WSLInterop` as root; no file or a timeout is NO row, never a verdict; never keyed on the binfmt entry's name, since newer WSL registers `WSLInterop-late` — `interopFromProbe`; with it off, `wsl-idle`'s could-not-ask names it and `wsl-tailscale` stops sending a person to `.wslconfig`), `wsl-idle` (VM shuts down when idle), `wsl-root` (repo root under `/mnt/<drive>`), `wsl-claude` (the Windows `claude` on a Linux PTY: fail). `wsl-idle` asks Windows through interop (`schtasks.exe /query /tn`, exit 1 = no such task) for a keep-alive task — the launcher's `autostart` task (`<slug>-host` for a checkout, `<slug>-host-npm` for an npm install, `launcherTaskName`; [distribution.md](distribution.md#windows-the-launcher-drives-the-host-in-wsl)) or the two names `service install` prints — and is `ok` naming it, saying only that a task of that name EXISTS (not that it is enabled, nor which install it starts). None is a warn; Windows not answering (interop off, timeout) is a DIFFERENT warn sentence, never "none". The fix names the command for the install the host runs from (`keepAliveCommand`): the checkout launcher's `autostart`, the npm launcher's, or `service install` inside the distro — it used to name a `<slug>-host start` command that exists on no route, and stayed a warn while the task was there. On native win32 the report is ONE `platform` failure (`nativeWindowsCheck`) naming that launcher. A missing `claude-binary` names Claude Code's install docs and says opencode support is experimental.
  - **tmux is required, and it is the ONE substrate** (`tmuxreq.ts`, pure but for a PATH scan). History: `<PREFIX>TMUX` was opt-in and set only by the dev-checkout `deploy/install-service.sh`, so a release install lost every live session on each restart and self-update; then it was on unless exactly `0`, keeping the direct-PTY spawn as a test/dev escape hatch that every e2e host pinned. **The direct path is removed** (owner decision: tmux on macOS/Linux/WSL2, native Windows unsupported) — no `USE_TMUX`, no branch in `spawnBackend`/`persistLive`/`hasLiveTmux`/`rediscover`/`detach`/`kill`/`remove`/the pan, and `welcome.tmux` is always `true` (kept on the wire for old clients). The knob is IGNORED: `tmuxKnobSet` only lets `doctor` say so. With no `tmux` on PATH, `sessions/tmux.ts`'s `spawnBackend` THROWS `tmuxRefusal()`'s sentence (no session started, the install command for the package manager that is here) — asked per spawn, uncached, so installing tmux needs no restart. Doctor rows: `tmux-knob` — WARN "ignored" while the old knob is still set; `tmux` — FAIL when missing (with the command), WARN when older than 3.3 (the generated `tmux.conf` sets `allow-passthrough`, added in 3.3; an older server shows the config error in the first pane, in view mode, where typed text goes nowhere), else the version; `tmux-locale` — the UTF-8 trap (`protocol-and-security.md`): clients run `-u` and `ptyEnv()` supplies a UTF-8 `LANG` when NO locale is set (`en_US.UTF-8` on macOS, `C.UTF-8` on Linux, where `en_US` is often not generated), so the one visible failure is a locale that is SET and not UTF-8 (`LC_ALL` > `LC_CTYPE` > `LANG`), which the panes inherit. The login service bakes no tmux knob. **Tests isolate by socket DIRECTORY** (`scripts/lib-tmuxiso.mjs`: a private `TMUX_TMPDIR`, `TMUX` deleted, every server in it killed on exit; `run-e2e.mjs` hands each script its own) — a `-L` name is only a name, a directory is a boundary the owner's live server cannot be reached across. `packages/host/test/tmuxreq.test.mjs`.
- `speedtest.ts` — bidirectional throughput probe + connection diagnostics behind three non-repo-scoped endpoints (`/api/speedtest/{download,upload,debug}`). Download streams a preallocated **random** block (incompressible so nothing inflates the rate) with backpressure + a 256 MB ceiling; upload drains + times the body server-side. **`debug` is the useful bit:** classifies the client IP the socket sees (tailscale 100.x / lan / loopback / public), and for a Tailscale client runs `tailscale ping --until-direct=false` against that exact peer to report **direct vs DERP relay** — the usual cause of a slow same-WiFi transfer — plus the host's LAN IPs so the phone can be told to hit `http://<lanIp>:8770` and skip the tunnel. Surfaced in `SpeedTestSheet.tsx` (Settings → Tools → speed test). All shell probes are best-effort/independently guarded.
- `uistats.ts` — **UI feature-usage counters**, the "what do I actually use?" ledger. The phone `track()`s every feature entry point locally and flushes deltas to `POST /api/ui-usage`; this merges them into `<STATE_DIR>/ui-usage.json` (`{ updatedAt, since, features: { "toolbar:diff": { count, first, last } } }`). Ids are opaque namespaced strings the client invents (`toolbar:<id>`, `overlay:<name>`, `action:<name>`) — adding a `track()` call needs no host change — but they're sanity-capped (length/charset/per-flush increment, 1000 distinct ids) so a buggy client can't grow the file. `GET` returns the doc (the Settings viewer), `DELETE` resets the window. Writes are debounced 3 s. Purely local: nothing is sent anywhere, and the point of the file is that a coding agent can read it and prune what never fires. Verified by `e2e-uiusage.mjs`.
- `netstats.ts` — **connectivity + delivery telemetry**, the "where did my prompt go?" record. Everything else reports the link as it is RIGHT NOW (`speedtest.ts` when asked, `NetActivity` while a request is in flight, the reconnect banner while it is down) and none of it survives the moment — but the failures that matter here are only noticed afterwards. Persisted to `<STATE_DIR>/netstats.json` (tmp+rename, debounced, flushed on SIGTERM), holding three populations kept deliberately apart. **Host facts**: sockets opened/closed with the CLOSE CODE (1006 = the tunnel dying under the socket, 1001 = the phone backgrounding it — identical from the app, opposite meanings), the peer's trust tier, and each closed socket's lifetime (a handful of sub-second opens means the handshake is failing, which looks nothing like a slow link). **Delivery outcomes** per `deliver.ts` verdict — it already knew "the turn started" from "the Return was swallowed"; nothing was keeping score, so a phone losing a prompt a day had no way to show it was happening, let alone which of the three it was. **Ack REPLAYS**, the single most useful number: a retry that found the work already done means the receipt never made it back, which neither end can see alone (the host thinks it answered, the client thinks it was ignored). Plus the newest **client roll-up per device** (`web/link.ts`), never merged — two phones on one host have genuinely different links and averaging them hides the bad one. Bounded and sanitised on the way in (a buggy client can't grow the file or poison the readout); `GET`/`POST`/`DELETE /api/netstats`. Nothing leaves the machine. Verified by `e2e-netstats.mjs`. **HTTP stalls** (`shared/netstall.ts`, `web/link/stallRecorder.ts` + `linkStalls.ts`) land in `clients[id].stalls`: the phone records every request that hit its fuse or stayed in flight past `NET_STALL_MS` (12 s, the `NetActivity` chip's moment) with what was true AT the stall — how many HTTP requests were in flight and which (six or more = Chromium's HTTP/1.1 per-host pool full), the WebSocket's last pong, visibility and how long since it changed, `navigator.onLine`, upload bytes sent. That tells a half-open keep-alive socket after Doze (WS healthy, few in flight, right after wake) from a full pool (many in flight). It travels over the SOCKET (`net.stalls`), never a POST, because the pool is what is stuck; the host merges on each event's key (counts outlive the 50-event ring, the `open` list replaces) and carries it across a new roll-up. Diagnostics only: nothing changes how a request is made. Read it with `npm run netstalls`.


## `routes/` — the client-message table

`main.ts` used to dispatch every client message from one `switch` with 92 arms, 717 lines long. Two
things came out of that shape, and only the second is about size.

**Cross-cutting rules were per-arm things somebody had to remember.** `durableOp()` is the
at-most-once wrapper every ackId-carrying op needs — it was called by hand inside six case bodies.
`containRepoDir()` is described in CLAUDE.md as "the ONE gate on a directory a client named", and it
was called by hand in two. Nothing about arm 93 would have made either a compile error to omit, and
neither omission announces itself: the first shows up as a fan-out that ran twice across twelve
repos, the second as an agent spawned outside the configured root. Both are exactly the failures the
ack ledger and the containment gate exist to prevent, defeated by a handler that simply did not call
them.

So they are DECLARED on the table entry now. `durable: true` means the handler returns an
`OpVerdict` and the dispatcher wraps it — a replayed ackId is re-acked from the ledger and the work
is not repeated. `contain: "cwd"` names the field holding a client-chosen directory; it is resolved
before the handler runs and a refusal never reaches the handler at all, with `refusal` supplying the
sentence when the default ("that folder is outside the configured root") is not specific enough. Six
entries are durable, two contain. A reviewer reads the omission in the table, next to ninety siblings
that got it right, instead of not reading it in a body.

**Every feature edited the same file.** `main.ts` was second only to `App.tsx` in churn, for the
plain reason that adding anything to the wire meant adding an arm here. Handlers now live in
`routes/session.ts` (one session: lifecycle, input, history, the limit it may be blocked on),
`routes/work.ts` (backlog, fan-out, builds, downloads, schedules, launches) and `routes/system.ts`
(the handshake, the LAN gate, settings, plugins and the decision log, telemetry, the notification feed). `main.ts` went
2,009 → 1,380 lines and keeps what it should have kept: the server, boot, the managers, the
snapshots, and `notify()`.

Three details worth keeping:

- **A handler takes ONE object**, not positional arguments. `noUnusedParameters` is on and most
  handlers want two of the four values (`c`, `msg`, `ws`, `att`); positional parameters would mean
  underscore-prefixed noise on every second handler, or turning the check off.
- **An unknown `t` is ignored, not thrown.** The wire is versioned. A client one version ahead
  sending a message this host has never heard of should be a no-op — throwing would close a socket
  that is carrying ninety other message types that all work.
- **`HostCtx` is a bag, and that is on purpose.** These are singletons with real lifetimes — PTYs,
  timers, files on disk — and they were module-level `const`s reached by import. The change that
  matters is not that the interface is narrow (it is not) but that they are PASSED, which is what
  lets a test construct the two or three it needs instead of booting the whole daemon. That is the
  door the host unit-test layer walked through.

## `sessionSearch.ts` — a core lifted out of `SessionManager`

`SessionManager` is 2,500 lines and 56 methods spanning PTY lifecycle, idle tracking, limit
resumption, transcript reading, oracle flags and search. Two pieces of it were pure decisions with a
real argument in them, and neither could be asserted while it lived inside a class that owns
processes.

**`sessionSearch.ts`** holds the scan: a substring walk with context lines and two caps. The caps are
the part worth pinning, and they exist for the LINK rather than for tidiness — a frame carrying every
match of a common word across every open session is precisely the payload a bad tunnel cannot
deliver. The subtle half is that hits stop being COLLECTED at the cap but keep being COUNTED, so the
sheet can say "40 of 300"; a cap that also stopped the counter would make it say "40", which is a
different and false claim. Context lines are there because reading a match in place is the thing the
search sheet exists for — jumping into a terminal on a phone to see the surrounding lines is the
behaviour it replaces. `SessionManager.search()` still decides WHAT to scan (rendered scrollback for
"recent", every recorded turn for "history"); that part genuinely needs the sessions.

The other, `oracleFlags.ts` (`deriveOracleState`, the per-session oracle cap waived while you watch),
went with the oracle when it became a plugin ([plugins.md](plugins.md)); a cap is the PLUGIN's
policy now, not the core's.


## `shared/index.ts` → `shared/wire/`

1,768 lines, 85 exports, and twenty commits deep — one of the three files (with `App.tsx` and
`main.ts`) that every feature in the project touched, which made it a permanent merge-conflict
surface and made the protocol itself unreadable: 49 interfaces interleaved with two unions and a
codec.

Split by what a field is ABOUT — `wire/session.ts`, `wire/backend.ts`, `wire/oracle.ts` (since split: `wire/sent.ts` + `plugin.ts`),
`wire/telemetry.ts`, `wire/notify.ts`, `wire/work.ts`, `wire/repo.ts`, `wire/transcript.ts` — with the
two unions and `PROTOCOL_VERSION` in `wire/messages.ts`. That last separation is the one with an
argument behind it: `messages.ts` changes when a MESSAGE is added and the DTO files change when a
FIELD is, and keeping them together meant both kinds of edit landed in the same place.

`wire/backend.ts` is `BackendInfo` — the wire subset of a host-side `BackendDescriptor`, added so the
host can drive more than `claude` in the same PTY substrate without re-implementing anything: a
second backend is DATA (capability booleans, a model catalogue, an optional context-window size)
plus the same delivery machinery, never a second code path. Every `caps` flag says whether the
backend HAS a feature at all, not whether it is on right now, so a backend that declares fewer of
them is structurally incapable of making the claude path worse. `contextWindowTokens` absent means
unknown and must never render as a number — the same "degrade to null, not to a wrong number" rule
as everywhere else. `LaunchOpts.backend` and `SessionInfo.backend` (`wire/session.ts`) are the two
fields that name one; both are additive and optional, and an absent `SessionInfo.backend` means
`claude` — the shape every session had before this field existed — so an old phone reading a new
host's claude sessions sees exactly the document it already knew. The `{ t: "backends", list }`
message (`wire/messages.ts`) is sent on hello and is additive too: an unknown `t` is ignored on both
ends, which is why none of this bumps `PROTOCOL_VERSION`, and a new phone talking to an old host that
never sends it must not render a backend picker at all — absent, not greyed.

`index.ts` is now 92 lines and re-exports everything, so `import { SessionInfo } from "@waterplane/shared"`
is unchanged and no import site anywhere names a file — which is precisely what made the split safe
to do at all. It stays the index; nothing new should be declared in it.


## `startPrompt()` — the prompt a create loses

"Open a session here AND run this" is one op, and the op is acked the moment the PTY exists. That is
correct — the create IS accepted, and answering it later would make an offline retry spawn a second
`claude` — but it means the ack has nothing to say about the typing, which happens seconds afterwards
and can fail: a TUI that never becomes ready, an echo that cannot be confirmed, a Return that is
swallowed.

What that failure produced was a **broadcast toast**. By then the phone's copy of the prompt is gone
in every path that matters: the pad note was removed on dispatch (a dispatched note has done its
job), the queue entry was acked `ok` and dropped. So a sentence rendered for whoever happened to be
looking at a screen in that second was the entire remaining trace of the message — which is exactly
the report that came back: *a new session opened and the prompt never showed up*.

Two changes, split on the only distinction that matters here, which is whether anything was typed:

- **`retry`** — `deliverPrompt` returns this when the session never became ready, and it means
  provably nothing was written. Safe to hold and safe to run: it becomes a **work item** in that
  repo, aimed at the session that did open. Durable (`.waterplane/backlog.json`), restart-proof, one tap to
  fire, and it does not re-type into the same un-ready TUI a second time.
- **`unconfirmed` / `unsubmitted`** — the prompt may be in that composer. These are never re-queued;
  a second copy is the failure mode the whole delivery module exists to prevent. They are named
  instead, with the action that is actually correct (press Return there / open it and check).

Both go through `notify("undelivered")` rather than `broadcast({t:"toast"})` — a feed row that
persists and a push that reaches a phone in a pocket, gated by `notifyprefs` like every other kind.
The kind is its own rather than folded into `info` for one reason: it is the only report of a message
that is otherwise gone, so muting the chatty "session opened" notices must not mute this.

The same path serves the Intent store's deferred opens, which call `startPrompt` too — a create parked for
six hours waiting on its files and then failing to type is the worst version of this bug, and it now
reports.


## CLAUDE.md entries in full

CLAUDE.md keeps the rule; these are the host-module entries as they were written before the compression
pass, carrying the reasoning they were trimmed of. Nothing below is a summary — each block is the
original paragraph, and CLAUDE.md's per-entry links point at these headings.

### `packages/shared`

- **`packages/shared`** — wire types (`ClientMessage`/`HostMessage` unions, DTOs) + the pure logic
  both ends must agree on, kept here because `shared/dist` is node-runnable so e2e can pin it.
  `index.ts` is an INDEX, not the protocol: the DTOs live in `wire/` (`session` `oracle` `telemetry`
  `notify` `work` `repo` `transcript`) and the two unions in `wire/messages.ts`, all re-exported, so
  no import site anywhere names a file. Split because it was 1,768 lines that every feature edited —
  one of the three permanent conflict surfaces with `App.tsx` and `main.ts` — and because a union
  changes when a MESSAGE is added while a DTO changes when a FIELD is. Add a message ⇒
  `wire/messages.ts`; add a field ⇒ the domain file. The rest:
  `queue.ts` (send-queue **transport**: lanes, `holdUntilIdle`+`release`, `retargetEntry`,
  `pendingCreate`/`bindPendingSession` — which bind on the create's own `createAck`, not on the
  lane, because `create:<cwd>` is per REPO and two offline "open a session and run these" for one
  repo otherwise gave the second one's chain to the first session (`ownedPendingCreates` is the
  same ownership rule the fail paths read) —, `answerInsertAt`, `adoptReferencedUploads`,
  `serial`+`busySerialGroups` — a lane frees at the ACK, which for a `session.create`
  means five queued opens for one repo all start at once, so a serialized entry waits for its group
  to go quiet; the group is the **cwd**, hence worktrees stay independent,
  `goneLanes` — a queued prompt for a session that has GONE is blocked, never fired: the host refuses
  it un-retryably, so a lane of five was delivered one per flush and buried as five red rows and five
  toasts, one fact told five times and none of them naming the re-aim that fixes it. `input` ONLY —
  a work item is added to the REPO and the host falls back to its default session, an upload is an
  HTTP POST to the inbox, an op lane is not a session id — so the lane is not held either.
  **THERE IS NO CLOCK IN THIS MODULE.** `ttlMs`, `noTtl`, `hold`/`applyHold` and every age-based
  `expire` are deleted: "queued too long" was a sentence about a thirty-minute timer told for
  failures that were never about time, and it is what shredded prompts somebody had spent an evening
  on. It was deletable because at-most-once moved off the host's 45-minute ack ledger and onto an
  intent id that lives as long as the row (`intents/`); `applyRelease` therefore only drops the park
  flag, and `maxAttempts` — a host that keeps ANSWERING no — is the one give-up left),
  and the RESCUE is gone from this module entirely — `rescuableEntries` and its `RESCUE_GRACE_MS`
  are deleted. Blocking a gone lane was only half an answer (nothing ever un-blocked it), and the
  client-side other half was worse than it looked: it re-aimed stranded prompts at that repo's work
  items on a 45-second grace measured by the PHONE's clock, which only ticks while a tab is
  foregrounded. Worse still, the block itself made the HOST's rescue unreachable — `deliverInput`
  has written the words to the repo's work items and answered `rescued` since the day it landed, but
  a blocked entry never reaches the socket, so in the queued-offline case both halves sat idle. Now
  a gone lane is only held when the entry names no `cwd` (nowhere to rescue it TO); with one it is
  sent, and the host answers `rescued`,
  `promptid.ts` (question fingerprint), `settings.ts` (synced-key allow-list), `hints.ts`
  (button catalog + `decideHint`), `hosturl.ts` (Android address rules), `netfuse.ts` (fetch fuse),
  `screenlog.ts` (what scrolled off an alt screen: `scrollOffCount` anchors on the TOP of the new
  grid, because the bottom of a claude screen redraws every frame whether it scrolled or not),
  `urls.ts` (a URL the terminal GRID broke across rows, put back together: `findUrls` rejoins on the
  WRAP GEOMETRY — full rows, one inset, one width — never on "the next row also looks URL-ish",
  which would swallow a path printed under a link; a row carrying its own scheme ends the run),
  `schedule.ts` (wall-clock rules: anchor + named zone + lead time, `nextFireAt`, and the
  zone↔epoch helpers `limit.ts` also parses banners with), `gallery.ts` (what a CACHED file listing
  may be re-filtered into: `coversQuery` is strict containment, never a broadness score, because
  images-all-time and everything-4h are incomparable), `wire/localrt.ts` + `localrt.ts` (what the
  local model runner is holding, and the pure "will a second model fit" sentence the phone says under
  the picker — the shapes moved out of the host the moment the PHONE had to draw them, because
  `reachable: false` is not an empty model list and one copy of that distinction is all there may
  be), `wire/backendtokens.ts` (**a backend's OWN token ledger, `BackendTokensDoc` — a SECOND
  document that is never summed with `TokenTotals`**: different cache tiers, different multipliers
  behind `sessioncost.ts`, an account limit that exists for one and not the other, and kinds that are
  the backend's own (a `Record`, never folded into claude's four to make the shapes match).
  `available: false` rides at 200 with a stated reason, because "this desktop has no such store" is
  an answer and not an error. A backend extension whose ledger predates the generic shape keeps its
  own document type in its folder; the host serves it verbatim at `/api/tokenstats/<id>` and the
  phone draws it through that extension's `LedgerViewDef`), `attach.ts` (what became of the FILES a
  prompt names: `attachState` ranks the host's own listing over the send queue over bytes still on
  the phone over a local "that upload died" record — and `unknown` (host unasked) is never collapsed
  into `missing` (host asked, hasn't got it), because one is a dead tunnel and the other is a lost
  photo), `launch.ts` (what is LEFT of the old launch gate — `safeRel`, `describeLaunch`,
  `LAUNCH_WAIT_MS`. `launchVerdict` and `cleanIntent` are DELETED: `intent.ts` below owns both jobs
  now, and its presence-before-deadline rule is the same one — a file that arrives one second early
  opens the session rather than being expired by the same tick that would have opened it),
  `intent.ts` (the durable INTENT — the model, and `intentVerdict`, the ONE ladder that decides
  whether a piece of deferred work may run yet: gate, budget, trigger, serial, target readiness, in
  that order, because the order is by what the user can DO about it. It is `backlog.waiting()`'s
  ladder, which is `tick()`'s ladder, kept as one function for every subsystem at once — an
  explanation derived from a second reading of the state drifts from the behaviour it describes.
  `cleanIntentRow` caps counts and labels and NEVER the words; `busyIntentGroups` drops
  `busySerialGroups`' startup grace, because the host holds an intent in `starting` across exactly
  the window that timer existed to cover — a fact instead of a timer. **Only QUEUED work holds a
  serial group** (`intentSerialHolders`, the one derivation behind both `busyIntentGroups` and the
  sentence): rows `starting`/`running`, and live sessions opened FOR queued work
  (`SerialSessionState.automatic` — `isAutomaticOrigin` or the `backlog · ` title mark) behind a
  wall, where a turn that ended asking in prose (`asking`) counts as an open question. A session a
  person opened by hand never holds one — a serial row sat five hours behind *'<repo>' (working)*, a
  hand session, while its owner worked in that repo by hand all day. An idle automatic predecessor
  lets the next row go; one with a question open holds it, the sentence says *waiting for your
  answer in 'x'*, and the session's id travels (`IntentVerdict.holderSessionId` →
  `Intent.blockSessionId` → `BacklogItem.holderSessionId`) so the row can open it. The phone's own
  send queue (`busySerialGroups`) still counts every session: its serial entries are a person's
  own sequential creates),
  `collage.ts` (several pictures as ONE picture: `pickCols` optimizes the ASPECT that comes out, not
  the count — two phone screenshots stacked are a 0.23:1 ribbon whose marks are untappable, so
  portraits go side by side and landscapes stack, from one target number and no per-orientation
  case; rows normalize on HEIGHT, a short last row is centered, and `maxWidth` caps width ALONE
  because the upload rule does),
  `pad.ts` (`mergePad`, the PER-NOTE merge that stops a synced pad from deleting notes behind your
  back. `notesToRescue` — the diff that guessed which drops were losses, and the device-local rescue
  store behind it — is deleted: the merge is fixed instead, so there is nothing to rescue. One JSON
  array of notes AND tombstones, discriminated by fields, so an older bundle drops the tombs and
  keeps a working pad; `serializePad` is CANONICAL or the two devices never stop pushing at each
  other; the tie-break is lexical, never *prefer mine*; an EDIT after a delete keeps the note and
  drops the tombstone; and a merge NEVER sheds for size — the caps bind on a local add, which
  REFUSES in words. **There is no clock in it**: the tombstone TTL is cut against the newest stamp
  in the UNION of the two documents, never `Date.now()`, because a per-device cutoff made two
  clock-skewed phones push a tombstone back and forth at each other once per debounce for the whole
  skew window — same union ⇒ same function ⇒ same bytes, whatever either device thinks the time is.
  The cap is applied AFTER the resurrection rule, so reviving one note costs no other delete its
  place),
  `budget.ts` (the usage BUDGET: stop starting AUTOMATIC work past a percentage of the session
  window, and start again when it resets. `limit.ts` is recovery *after* the wall — always too
  late, because the queue already spent the reserve on whatever was next in line. `budgetVerdict`
  FAILS OPEN on an unreadable or stale reading — it is scraped off a TUI, and a parse broken
  upstream must not freeze every queue on every host — and clears past a known reset instant on
  the CLOCK alone, so auto-continue needs no fresh scrape and no observer),
  `assess.ts` (**what an assessment is ALLOWED to conclude** — a CLI verdict on the user's own open
  work is the most dangerous input this app takes, and "implemented" said of something
  half-implemented is the EXPECTED failure. `cleanAssessment` is where a claim earns its verdict: a
  retiring verdict citing nothing is downgraded to `unclear` (which retires nothing), a `superseded`
  naming itself or an unknown id or a cycle is flattened to one hop and otherwise downgraded, a
  merge — the one verdict that writes a prompt in place of the user's words — needs
  2..`MAX_MERGE_SIZE` ids each in exactly one group with the prompt actually present, and an item
  the run never mentioned comes back `unclear`, because silence about a row is not a decision about
  it. Every cap is on a COUNT, a citation or a label, never on the words: prose past
  `MAX_PROMPT_CHARS` is DROPPED with a note, half an instruction that runs being worse than one that
  never ran. `applyAssessment` decides the mutations and the host performs them, which is what makes
  "nothing applies itself" checkable),
  `naming.ts` (**a title and a kind for a row, and who wrote them.** A headline is the one string in
  this app a MODEL writes FOR a person, over words that person wrote themselves, in the place a
  reader looks first — everything else a model produces here either runs (a prompt), cites
  (evidence) or explains (a note). So three rules, each enforced rather than asked for.
  **It never stands in for them:** `itemHeadline` is the ONE display rule for both ends — a `label`
  somebody typed wins, always, and a machine's `headline` stands only where they put nothing; two
  copies of that rule would be two answers to "whose words are on this row". **It never replaces a
  name they typed:** every value carries a `NameAuthor` (`hand`/`assess`/`name`) and is stored with
  it or dropped with it, because a title that cannot say who wrote it cannot say whether a person
  may be overwritten — `hand` is what makes *never overwrite typed words* checkable instead of
  promised, and `IntentManager.name()` refuses a `hand` field PER HALF, since a row whose title
  somebody typed and whose kind nobody ever set is the ordinary case. **It is never guessed:**
  `cleanCategory` knows four words and no synonyms — `"bugfix"` is `undefined`, never rounded to
  `chore` — because a synonym table is a second vocabulary, and a second vocabulary is how "no kind"
  becomes "chore" for every row nobody looked at. Absent is a real answer on both fields and means
  NOBODY SAID. A fourth rule is the shape of the caps: a headline is a LABEL, so it is CLIPPED for
  length rather than dropped — the opposite of `assess.ts`'s prompts, because half a title is still
  a title and half an instruction is a different instruction.
  **`cleanHeadline`'s one strictness is that a "title" which is merely its own item's first words is
  not a title** — the truncation the display rule exists to hide, the same string twice on one card,
  cut once by a slice and again by CSS ellipsis. That test is deliberately ONE-directional
  (`text.startsWith(headline)`) and is NOT `typedName`'s. `typedName` answers a different question —
  *is the string in the NAME slot a name, or the derivation this app itself wrote there?* — and both
  ends fill that slot with `text.slice(0, sliceLen)` when nobody typed one, so it has to refuse in
  both directions. A headline has no such derivation behind it: nothing in this app ever writes one
  out of the prompt. Borrowing the second clause refused, for every prompt under 40 characters,
  every title that began with the whole prompt — text `dark mode`, title
  `dark mode toggle for settings`, dropped — and dropped in SILENCE, since `edit()` wrote nothing
  and answered as though it had. Hence `headlineRefusedText`/`categoryRefusedText`, here beside the
  rules that refuse: *never overwrite typed words* has a quieter twin, which is never to DROP typed
  words without saying so. Both sides of the comparison are whitespace-collapsed, or a prompt that
  wraps between two of its own opening words reads as a different string and the truncation goes
  through),
  `itempaths.ts` (`imagePaths`/`transportPaths`: the image and `.claude/outbox|inbox` paths a work item's words name). Build before host/web.

### `routes/`

- `routes/` — **the client-message table.** `main.ts` dispatched all 92 arms from one 717-line
  `switch`, which made this the second most-edited file in the project and made two cross-cutting
  rules into things arm 93 could silently omit. Handlers now live in `routes/session.ts`,
  `routes/work.ts` and `routes/system.ts`, keyed by `t`, and the rules are DECLARED on the entry:
  `durable: true` wraps it in `durableOp` (the handler returns a verdict instead of acking itself),
  `contain: "cwd"` resolves the client-named directory through `containRepoDir` BEFORE the handler
  runs, so a refusal never reaches it. Everything a handler may reach for is `HostCtx`
  (`routes/types.ts`), built once in `main()` — which is also what lets a test construct two managers
  instead of booting the daemon. An unknown `t` is ignored, never thrown: the wire is versioned, and
  a client one version ahead must not close a socket carrying ninety types that do work.

### `main.ts`

- `env.ts` — `ROOT`, `STATE_DIR` and the `.env` loads (`<STATE_DIR>/.env`, the repo's `.env`, the per-user
  config dir), imported by `main.ts` FIRST. **The daemon's global state lives OUTSIDE the code root**
  (2026-10, before the open-source release): `STATE_DIR` is `WATERPLANE_STATE_DIR` →
  `$XDG_STATE_HOME/waterplane` → `~/.local/state/waterplane` on every platform (`branddirs.ts`'
  `resolveStateDir`), and `hostStateDir(root)` is the ONE function every global store opens under.
  It used to be `<ROOT>/.waterplane`, which had two faults: changing `ROOT` orphaned every ledger,
  session list and the ack ledger with them, and a fresh install wrote a dot-dir into a stranger's
  code folder. `hostStateDir` answers the bound dir for the daemon's own `ROOT` only — a store a unit
  test builds on a mkdtemp root keeps `<root>/.waterplane`, so no test can reach a person's real
  state (compared by REALPATH; still an argument rather than a no-argument read of the binding,
  because dozens of unit tests give each store its own mkdtemp root and a no-argument resolver
  would put them all in one dir) — and the intent store, a leaf slice, gets it injected (`IntentDeps.stateDir`). The **boot
  move** (`migrateStateDir`, daemon entry only and never under `--doctor`, after the brand-rename
  move and before any store opens) renames `<ROOT>/.waterplane` (or a legacy name) to `STATE_DIR` and
  leaves a symlink at the old place (a `MOVED.txt` dir when a symlink is impossible); across
  filesystems it copies to `<new>.incoming-<ts>`, verifies names, kinds, sizes and bytes, swaps that
  in and renames the old dir to `<old>.moved-<ts>` — **never a delete**. When the new dir already
  holds state and so does the old, the old dir is MERGED in entry by entry — the ack ledger first,
  never overwriting, a name both hold left in the old dir beside a `MOVED.txt` and named in the log
  and the doctor's `state` row. It was "keep the new, ignore the old" for one commit, and that was a
  double-delivery bug: a `.DS_Store` or a `.env` a person put in the new dir (these docs invite it)
  made the daemon boot on a dir with no `acks.json` — ABSENT, not corrupt, so nothing even said so —
  and the old `.env`'s allowed hosts vanished, locking the phone out. Desktop noise (`.DS_Store`,
  `._*`, our own markers, an entry renamed aside) is never "state". **Any failure before the new dir
  holds the ack ledger binds the OLD dir**: `acks.json` is the at-most-once memory, and booting on an
  empty one would let a queued prompt run twice. **No move while another host for this root still
  answers** on the port (`env.ts`, top-level await, asked only when there is a move to make): its
  write between the rename and the pointer would recreate a real dir at the old path and split the
  state in two. A crash is finished on the next boot: stale `<new>.incoming-<ts>` copies are removed,
  a missing pointer is put back (only where the travelling `moved-from.json` says state came from,
  never invented in a fresh install's code folder), and a swapped-in copy whose old dir was never
  renamed aside is recognised as identical and finished. `cli/service.ts` (and
  `deploy/install-service.sh`) BAKE the resolved `ROOT` and `STATE_DIR` into the plist/unit — the
  precedence is `@waterplane/shared`'s `statedir.ts`, so the standalone CLI needs no host import —
  and the doctor's `state-service` row warns when the installed service's environment would resolve
  a different state dir than the shell running it. PER-REPO state (`<repo>/.waterplane/`: `builds.json`, `capture.json`, `artifacts.json`,
  `autopull.json`, `repohealth*`, `assess-*`, `peer-job.json`, a repo's own `backlog.json`) is the
  repo's and does not move. `STATE_DIR` and `ROOT` are read from the process environment, the repo
  `.env` and the per-user config `.env` — loaded into a scratch copy before either is resolved
  (`loadHostEnv(null, …)`) — but never from the `.env` inside the state dir, which can only be found
  once they are known. Until 2026-10-07 only the process environment counted, so a root set in the
  repo `.env`, as `.env.example` said to, was silently ignored. Under WSL a drive-letter value
  (`c:/dev`) is its `/mnt/<drive>` mount (`branddirs.ts`' `wslMountPath`). The default root `~/dev` is spelled once
  (`branddirs.ts`' `defaultRoot`; `sessions/knobs.ts` reads `env.ts`' `ROOT`), and the doctor's `root`
  row says when that default was assumed and does not exist, instead of the phone silently listing
  no repos. `statedir.test.mjs` · `e2e-statedir.mjs`. Until 2026-09-25 the loop sat in `main.ts`'s body, which
  runs after every import has been evaluated, so each knob read at import (`sessions/knobs.ts`,
  `intents/contract.ts`'s `TICK_MS`, `backends/claude.ts`'s `WATERPLANE_CLAUDE_BIN`, …) had already read
  `process.env` and a knob set only in a file was ignored — while `.env.example` documented the
  files as the place for it. `envfiles.ts` is the merge, pure and tested: the process's own env
  beats every file, a later file beats an earlier one, so the per-user file wins over the repo
  `.env` over the legacy one. Until 2026-09-28 the loads were `process.loadEnvFile`, which never
  overwrites, so the FIRST file won and the per-user file — the one set-secret writes and
  hot-reloads — lost every restart to a stale repo `.env`: set from the phone, gone on restart.
- `main.ts` + `server/` — HTTP+WS server, boot, the managers, the snapshots and `notify()` (the
  functions live in `server/`: `notify()` in `clients.ts`, `containRepoDir()`/`durableOp()` in
  `wsops.ts`, the snapshots in `intentEvents.ts`; `main.ts` keeps the constructions in boot order —
  [host-architecture.md](host-architecture.md), "Result"). `containRepoDir()` is
  the ONE gate on a directory a client named — `session.create` spawns `claude` in it and `build.run` executes a shell command in it, so
  it must be inside `ROOT` (via `scaffold.inRoot`, realpath-compared) or a discovered worktree;
  everything else a client names was already contained, this was the asymmetry. Refuse, never guess.
  `attached` WeakMap gates PTY frames. `durableOp()` =
  at-most-once wrapper for every ackId-carrying op; `opsInFlight`/`inputsInFlight` join a retry that
  races the first delivery. Thrown op ⇒ not remembered; `ok:false` ⇒ remembered.
  `startPrompt()` types a create's first prompt, and a FAILURE there is the one loss this app could
  not report: the op was acked `ok` (accepted) seconds earlier and the phone has already dropped its
  copy, so "a session opened and the prompt never showed up" used to be a broadcast toast and nothing
  else. Split on whether anything was typed — `retry` (provably nothing) becomes a WORK ITEM in that
  repo aimed at the session, `unconfirmed`/`unsubmitted` are only named (re-queueing them is how a
  prompt runs twice) — and both `notify("undelivered")`, i.e. a feed row and a push, because the
  thing this has to survive is the phone being in a pocket.

### `backlog.ts`

- `backlog.ts` — **a VIEW of `intents/`, plus the prompt executor.** The store, the 2 s tick, the
  lifecycle, the completion watcher and the "why is this queued" narrator all now exist once, for
  every subsystem; a work item is the plainest intent there is (prose, `trigger:"idle"`,
  `target: repo | session`) and `isBacklogRow` is that shape, not an `origin` marker — so anything
  posted that fits belongs in the list whoever wrote it. What could not move stayed: the SESSIONS
  (below), the `deliverPrompt` executor, and `deliveryError`'s three sentences. `waiting()` is now
  literally `blockDetail`, i.e. the verdict the tick acted on, rather than a second reading kept in
  step by hand. Per-repo `<repoDir>/.waterplane/backlog.json` is MIGRATED on first boot and renamed
  `*.migrated`.

#### Only a FIRST-step `retry` may re-run an item

`deliveryError`'s three sentences say what became of a delivery; `retryableStep` says who is allowed
to act on it. **`retry` means "provably nothing was typed" about the STEP that returned it, never
about the item.** A work item is a CHAIN — one item delivered a turn at a time, `deliverChain` /
`backlog.deliver` walking `payload.steps` and stopping at the first that does not land — so a `retry`
from step 2 arrives with step 1 already run. `{ retry: last === "retry" }` sent the whole row back to
`queued` with no `sessionId`, and the next tick opened a SECOND session and typed step 1 into it
while the first session was still working on the first copy. "Run it twice" is the thing the entire
intent store exists to prevent, and this was one line in each of the two executors quietly promising
it. Both now ask `retryableStep(delivered, step)`, and a later step's failure carries
`chainDeliveryError`'s sentence instead: *"…This is turn 2 of 3; turn 1 already ran in this session,
so it is NOT re-run from the top — send the rest by hand."* `packages/host/test/backlogstore.test.mjs`.

**…and the step has to travel, because a `Stop` is evidence about ONE turn.** That fix was only half
of it. `fire()` carries a shortcut for a real case — on a fast turn the hook beats the executor's
return value, so a `Stop` past the pre-delivery baseline outranks a four-second echo window that
could not confirm what it typed, and calling that row `unsubmitted` would gravestone work the CLI
itself recorded as done. But the shortcut fired on ANY non-`retry` failure with a Stop past the
baseline. On a chain, `noteSession` takes the baseline at 0 when the session is opened, step 1's turn
ENDS while step 2 is being delivered, step 2 comes back `unconfirmed` — and a three-step item settled
**`done`**, saying *"its turn finished — the hook confirmed it even though the screen never echoed"*,
with two of its three turns never typed and the sentence naming the stopped step thrown away. The
person is told the item is finished. (It also manufactures the reap's worst shape: a `done` row over
a session whose turn is live.)

The Stop proved step 1 ran, which a later step's failure already takes for granted. So
`ExecutorResult.step` carries the 0-based index the executor stopped on — `freshSession` from
`failedStep`, `backlog.deliver` from its loop index — and the shortcut is gated on `(res.step ?? 0)
=== 0`. Absent is 0, which is the single-step case and every executor that has no chain, i.e. absent
means exactly the old behaviour.

#### `backlog-config.json` is tmp+rename, like every other store here

It was a bare `writeFileSync`, which is the pattern this whole area was written to retire — and it
matters because it holds the global auto-fire switch (it once held a second setting, the removed smart
pick's per-repo ticks; a stale `smartPick` key is ignored on read and dropped on the next write).
`init()` reads it inside `try { … } catch { /* fresh */ }`, so half a JSON document comes back as
`auto: false` — **auto-fire off on the next boot, silently**. "Half a JSON document where a backlog used to be" is this repo's
recorded failure for exactly this. The observable difference from the reader's side is the INODE,
which is what `backlogstore.test.mjs` asserts: a truncate-in-place keeps it, a rename replaces it.

#### A drag is RECORDED (`handOrdered`), and the tick that sorts around it

`reorder()` and `swap()` are the only two things in this daemon that stamp `Intent.handOrdered`, and
they are reached from a drag and a one-step move and from nowhere else. Nothing recorded a placement
before: `add()` puts a new row on top with `min(orders) - 1`, so five minutes later a row somebody
dragged to the front is indistinguishable from one that simply arrived last — and the moment anything
automatic sorted this list it could not tell them apart and would quietly undo the one deliberate act in the
sheet (nothing sorts automatically any more, since the smart pick was removed 2026-10-16; the mark stays). `reorder()` stamps EVERY id in the posted order, not just the row that moved: the client sends
the whole display order, and the rows a drag went past are where they are because of it. Machinery
never sets the flag and never clears it, so a row placed once keeps its slot until it runs. A pinned assessment rank
leaves the same mark.

#### Why every item gets its own conversation (F4 → F5 → this)

There used to be ONE `backlog · <repo>` session per repo, keyed on that exact title, and every item
that repo ever queued was typed into it. Nothing ever closed one — an earlier version of this very
file said so approvingly: *"nothing here auto-closes a session… which is what makes the next item
cheap"*. That sentence was wrong, and the number that disproves it was already in the tree.

### What the gaps cost, as opposed to the work

Every figure this daemon derives answers *what did the work cost*. `coldStarts` answers a question
nothing here could ask before: a conversation resumed inside the hour re-READS its window out of the
prompt cache at a tenth of the write rate, and one resumed the next morning re-WRITES it. Same
tokens, same conversation, up to twenty times the price — and it is invisible in every chart, because
the window is the same size either side of a re-write and those tokens look like any other cache
write.

Measured through this reader over one desktop: **387 re-writes, 80.3M tokens, $751.87 for the writes
of which $711.95 is premium over re-reading the same tokens.** The premium is the figure worth
printing; the rest was always going to be sent.

Two traps, both of which manufacture a fake WARM reading, and both defended twice:

- **A compaction inside the gap.** The window drops to a tenth, so the next write looks nothing like
  a re-write of the old one. The boundary flag excludes it, and so does the arithmetic (31,579
  written against 347,182 carried-and-not-read is not a re-write of that window) — which is what
  covers a boundary the log never recorded. Charging it here as well would bill compacting twice;
  `CompactionLedger.rebuildTok` already has it.
- **`cache_creation > cache_read` is the WRONG discriminator.** Every cold resume still reads the
  tools-and-system preamble — a separate cache entry, kept warm by sibling sessions in the same repo,
  measured at 32.5k-36.8k here. A 66k conversation coming back cold reads 36,770 and writes 30,638:
  write below read, stone cold. The test is whether the read covered what was CARRIED, and the bar is
  0.8 rather than a half, because half calls that same conversation warm on the preamble alone.

A rebuild is a dated event but **not a mark on the spark and not a tick on any chart**: there is
nothing at that x for a rule to point at, and the chart has exactly two event colours, validated
under three kinds of colour blindness in both themes. Painting it in the usage-limit red would say
*your account refused this request*, which is a different and far more alarming claim. It travels as
a count, a sentence, and a row in the values view wearing the ink dot.

`shared/sessioncost.ts` is the arithmetic: every turn re-sends the whole conversation, so a window
sitting at k× its own baseline pays `k·base·R` per turn for ever, while a fresh one pays a single
`base·W` and `base·R` after that. Its own levels put the crossover at ~13 turns for 2.5×, ~5 for 5×
and ~3 for 9×. A shared backlog session reaches 5× within a handful of items, because each item reads
ITS OWN files into the window and none of that helps the next one. The desktop-wide measurement in
`CLAUDE.md` is the same shape from the other end: 124 conversations out of 8,968 grew past 200k and
were **76% of every token spent in a fortnight**. A backlog session of unrelated items, appended to
for ever, with nobody watching, is precisely that shape.

So the default is `{kind:"repo", fresh:true}` — which `cleanTarget` now normalises EVERY repo target
to, retiring the non-fresh reading for rows already on disk and for APK bundles pinned to an older
wire alike. Decisions that came with it:

- **No `/clear` in front of it.** A fresh process IS the clear, and it also lands the item as its own
  reopenable conversation in `archive.ts`; a `/clear` would have buried N items in one log with no
  boundary between them.
- **The title is a PREFIX, never an exact string.** `backlog · usmc · fix the flaky test` and the
  older `backlog · usmc` are both automatic sessions: both count against the cap, both are reapable.
  `isBacklogTitle` was already a prefix test, which is what made this a rename rather than a
  migration. Recognition rather than bookkeeping remains the rule — a persisted map would need
  writing, migrating and keeping in step with sessions that die on their own, while the title is
  already on the row, already survives `rediscover()`, and is already what the user sees.
- **`adoptBacklogSession` is prefix + cwd, newest-IDLE-first**, and has exactly two callers left:
  `resolveRepoSession(cwd, adopt = true)` (a hand fire on a pre-`fresh` row) and the reap. Automatic
  work adopts nothing, which is the old rule in its simplest possible form.
- **A person who wants the shared context says so**, and it is a choice rather than a side effect of
  a title match: `{kind:"session"}` (the sheet's *queue here*), or `resume` — a new session that
  picks up the repo's last conversation with `claude --continue`.
- **`serial` is set on every repo-target work item** (`backlogDraft`). It was free while a repo's
  items shared one session — rung 5 would not type a second prompt into a session already holding an
  intent — and it stopped being free the moment each item opened its own: nothing else in the ladder
  would stop five due items putting five agents into one worktree. A `session`-target row does NOT
  get it; those still serialize on the session, and holding them for the whole repo would make
  *queue here* wait on work it has nothing to do with.

#### The linger and the reap

**Both are OPT-IN since 2026-10-01** (R-sessions-022). The person asked that automatic sessions *not*
close themselves by default — a session a fired item opened is where its work is shown, and closing it
behind their back was the complaint. So closing is a setting: the synced `waterplane.backlog.closeWhenDone`
(`CLOSE_WHEN_DONE_KEY`, read by the host through `closeWhenDoneSetting`, OFF unless `"1"`) plus a
per-item `Intent.closeWhenDone` (absent inherits; `false` is a real "keep this one open"). `reapable()`
asks it FIRST: off ⇒ neither the linger nor the reap below touches the session. The cost is stated in
the row instead of hidden: a `noSlot` row facing a full cap of keep-open sessions WAITS, and
`autoSlotsWaitText` says "N automatic sessions open (close one to make room)"; `backlog.list.autoSlots`
carries the open ids, a fact the phone turns into a person's tap on the ordinary close. Everything
below describes what happens once closing is allowed.

A session that is never closed is the old model with extra steps, so there are two ways one ends, and
both are **`sessions.remove()`, never `kill()`** — remove lets the exit path record it under *Recently
closed*, where it reopens with `--continue`; kill is a teardown with no closed-row on the other side
of it, which for work that has just RUN is the one outcome nobody wants.

- **Linger** (`WATERPLANE_BACKLOG_LINGER_MS`, 10 min): a finished item's session stays open that long, for
  the person who walks back to the desk and wants to see what the thing actually did. Closing it the
  instant the turn ended would make "open the session" a button that is never there when anybody
  presses it. Armed on a plain interval in `main.ts` — the one timer in this area, and legitimately
  so: nothing is FIRED on it (no work runs, no prompt is typed, no decision a restart could get
  wrong), and "ten minutes from now" is a question no event can answer, because the session's last
  event is the turn that ended it.
- **Early reap** (`reapAutoSession`) — **REMOVED 2026-10-14, see *Only a working session holds a
  slot* below.** It was: when a row that everything else has said yes to is held on `noSlot`, the
  manager asks the host to make room — once per pass — and the host closes the OLDEST automatic
  session that is reapable.

#### Only a working session holds a slot (R-automation-042, 2026-10-14)

The cap counted every running `backlog · …` session, busy or idle, and since 2026-10-01
(`cd044878`) automatic sessions stay open by default. Together: three finished items left open for
reading and the desktop fired NOTHING more — fourteen timed rows armed for the hour before a weekly
reset were going to sit on `noSlot` behind seven idle sessions. The owner's rule: a session does not
need to be closed, only idle. The cap now bounds how many agents RUN at once.

- `slotBusy(id)` (`backlogsessions.ts`) is the reading, and it is `reapable()`'s list of reasons not
  to close, minus "attached" (a person reading a finished session is not an agent running): a row
  `starting`/`running` in it, a background shell `working`/`serverLike`, a background agent,
  `autoFireBlocker` non-null (a turn, a box, a limit wall; the no-hook silence floor is
  `REAP_IDLE_MS`), overruled only by `REAP_CEILING_MS` of PTY silence — a lost `Stop` must not hold
  a slot until restart.
- `autoSessionCount()` counts only those; `AutoSlotFacts.open[].busy` says which, absent = an older
  host = busy. `autoSlotsWaitText` says "N are working; a slot frees when one goes idle"; the phone's
  *close one to make room* lists only the working ones (closing an idle one frees nothing).
- **The reap is gone**: closing an idle session would free no slot, so nothing is ever closed to make
  room and `IntentDeps.reapAutoSession` no longer exists. `closedBy: "auto-slot"` stays readable for
  closed rows written before. The linger sweep is untouched — close-when-done still closes.
- Pinned by `backlogsessions.test.mjs` (the count), `intentsched.test.mjs` (order when a slot frees),
  `e2e-backlog-keepopen.mjs` (the default: kept open, the next item runs anyway) and
  `e2e-backlog-slots.mjs` (one at a time, in order, nothing closed).

**What "reapable" is, and why it stopped being PTY silence.** `PLAN.md` §2.2 promised *"Never a
session a person is looking at, never one mid-turn"*, and the implementation's proxy for the second
half was "an intent `starting`/`running` in it" — a different fact. The gap is not theoretical and it
is common by construction: a chain row whose step 2 failed ends `failed` while step 1's turn is still
running in a `backlog · …` session with no row in it; a first-step `unconfirmed` does the same (the
words DID land, the row says failed); and `ensureRepoSession` is a hand-driven session wearing the
mark with nothing ever `running` in it. And what "mid-turn and silent for sixty seconds" IS in
practice is a session waiting on a PERSON — a permission box, or an `AskUserQuestion` — because the
working spinner repaints every second, so a live TOOL CALL is never silent. Closing it drops the
pending tool call, SIGHUPs an agent mid-`Edit`, and "makes room" by closing the one session that was
doing something. `remove()` means nothing is destroyed, but nobody answers the box.

So `reapable()` asks `sessions.autoFireBlocker(id, idleFor) === null` — the ONE implementation of "is
this session free", hook-aware (`turnActive`), box-aware (`sessionWall`: limit, prompt,
`awaitingInput`), and for a session with no hook pipe it IS the silence rule at `idleFor`. No fourth
ladder and no second reading of `turnActive`; `"hasn't printed anything yet"` matches the old
`idleMs() === null`.

The cost, stated: a hooked session whose `Stop` was lost keeps `turnActive` for the life of the
process and would never be reaped — a slot held until restart. `REAP_CEILING_MS` is the only thing
that overrules the CLI's own word: **6× the linger of PTY silence**, an hour at the shipped default,
far past any real tool call or permission box. One lost conversation against a slot held for ever.
`backlogsessions.test.mjs` pins all three: a live turn is not reaped, a box is not reaped, and the
ceiling reaps anyway.

**Flag for follow up when done (`backlogfollowup.ts`, R-sessions-043).** A row, schedule or fan-out
launched with `flagWhenDone` marks the session it opened for the person to come back to. The rule is
the same shape as the close: the row that OPENED the session decides (`openerRow`, one lookup shared
with `closesWhenDone`), and only a row that is `done` with an ok result and whose session `slotBusy`
calls free — a failed or limit-stopped run never flags, and a turn, a box or a background shell/agent
defers it. It flags ONCE per row; the applied ids are kept in `followup-launched.json` (capped), because
the alternative, re-asserting "this row wants a flag" every tick, would undo a person clearing it, and
a restart would re-flag every finished row. `BacklogManager.lingerSweep` calls it first so a session
that wants a flag is flagged before anything may close it. `followupsweep.test.mjs` pins all of it.

**A session a PERSON reopens does not wear the mark.** The `backlog · ` prefix is the only thing
that says a session is machinery's — it is what `autoSessionCount()` counts against the cap, what the
reap may close and what the linger sweep retires. A finished item's session is closed BY the linger
sweep with its title intact, so it lands in *Recently closed* still called `backlog · usmc · fix the
flaky test`, and the phone's reopen button sends that very title back in a `session.create`. The
session a person was then driving counted against the cap, was reapable after sixty seconds of a
silent screen (a permission box, a long tool call) and lingered after ten minutes — and "never a
session somebody is looking at" was only ever true while the SOCKET was attached, which a phone in a
pocket is not. `routes/session.ts` now strips the prefix off any title that came off the wire
(`withoutBacklogMark`); the three host-side openers that MINT it — `openItemSession`,
`ensureRepoSession`, `doResurrect` — go through no route and are untouched. The tab keeps the rest of
its name, so the person can still tell which conversation it is.

**Three exemptions and no more**, which is the decision this design actually made: currently
attached (a socket is on it, so somebody has it on screen), an intent `starting`/`running` in it
(counted off the STORE — `starting` is the whole window in which a delivery is being proved, which is
exactly the window in which the session looks idle and is not), and active in the last
`WATERPLANE_BACKLOG_REAP_IDLE_MS` (60 s; the only guard there is against closing a session whose agent is
between two tool calls). There is deliberately **no "somebody looked at it once" exemption**: a
session nobody has open, with no work in it, that has printed nothing for a minute is a session whose
only remaining value is its conversation — and that survives being closed.

`packages/host/test/backlogsessions.test.mjs` pins all of it over a fake `SessionManager`;
`scripts/e2e-backlog-slots.mjs` pins the cap and the reap against a real host with one slot.

### `review.ts`

- `review.ts` — `check` / `validate` / `nextStep` / `continueWork` and their prompt builders, lifted
  out of the backlog: verbs on work that has SETTLED, not lifecycle. Verdicts live in a sidecar
  (`.waterplane/reviews.json`, keyed by intent id) merged into `BacklogItem` at render time, so the wire
  DTO still carries them where it always did without nine fields riding on every `Intent`. A chosen
  next step POSTS its own intent (`origin: review:<id>`, `interject`) rather than flipping the
  reviewed row back to `running` — one row per piece of work is what "have I dealt with this?" needs.

### Notifications: three rows for one file

Photographed from a phone's notification feed: one APK, three notifications —
`Outbox: app-debug-…apk` **twice**, plus auto-pull's `Downloading: …` row.

A keying bug, and the kind that only shows up with two sessions open in one checkout. `outSeen` was
keyed by SESSION ID while the thing it watches, `scanOutboxDocs(cwd)`, is keyed by REPO: every
session in that repo ran its own turn-end scan, diffed the same new file against its own baseline,
and fired its own notification. A repo's outbox is a fact about the repo, so the baseline is now
keyed by `cwd` and the first turn to see a file claims it for every session in that checkout.

Two details the change turns on. **Seed only when absent** — a second session opening in a repo must
not re-seed, or everything produced since the first session opened is marked seen and the
notification nobody has had yet is swallowed. **Do not drop the baseline when one session exits** —
its siblings are still running against it; only a checkout with nothing open in it is forgotten. The
notification `tag` moved off the session id too (it is now the repo + path), because a tag is what
makes a re-show REPLACE rather than stack, and with a session id in it two notifiers could only ever
stack.

`imgSeen` stays per session deliberately: its scan feeds a per-session broadcast (`session.images`,
the session's own new-image strip) as well as a notification, so its key is doing a second job this
one never had.

### `deliver.ts`

**The bottom of the render is not the bottom of the screen.** `deliver.echo` — *"confirming a prompt
reached the composer"* — sat at roughly 30% misses on this host, just the healthy side of amber, and
was read for months as the price of a phone repainting over a slow tunnel. It was not the probe. A
capture of one failing delivery settles it: the text (`Yes all 3`, a person interjecting into a
working session, well inside `ECHO_WAIT_MS`) was **in the composer**, with the CLI's footer drawn
TWICE and nine rows of streaming turn output sitting underneath the box. The probe found it. The
check then threw the find away, because it accepted a hit only within ~11 rows of the last row of the
render.

The cause is one file over. `render.ts` replays the whole scrollback into a fixed 50-row VT, so
mid-turn a repaint caught half-done TEARS: fresh rows and stale rows both land, and the newest
composer frame ends up with older paint below it. "How far from the bottom" was measuring the tear.
It is a fine yardstick for an idle TUI and meaningless for the one case this app is built around —
typing at an agent that is working.

So the question is structural now: **is the text inside the box the CLI draws to take typing.**
`echo.ts`'s `composerEcho` finds every composer frame on the screen — a `❯` input row with one of
the composer's full-width rules adjacent above, running down to the rule that closes the box — and
asks the ordinary `screenEcho` rules of the frame's own contents, so a wrapped prompt and a collapsed
paste chit are covered without a second rule. `❯` only, never a plain `>`: this CLI renders a past
user turn into the scrollback as `> yes all 3` verbatim, and accepting that row would let a prompt
that ran twenty minutes ago read as one sitting unsent (`prompt.ts` accepts both, correctly, because
it is answering a different question — the constant is shared, the semantics deliberately are not).
Frames are scanned bottom-up, since a torn repaint can leave a stale EMPTY frame below the live one.
It degrades the safe way: **no frame found ⇒ `null`**, and every caller falls back to exactly what it
did before, because a composer we stop recognising must never brick delivery. The render slice
widened from 40 rows to 100 for the same reason the anchor exists — the box is not near the bottom
mid-turn — and it is still ONE render call.

**The wider window is for the ANCHORED rule and for nothing else** (`echo.ts`'s `ROW_WINDOW` vs
`FALLBACK_ROWS`). "Back to the old rule" is only true at the old depth: the fallback places a hit by
counting rows from the bottom, and its slash-completion allowance accepts a hit at ANY height as long
as two squashed rows below it start with `/` — which is how every file path in every tool result
starts. The only thing that ever bounded that branch was that the old code could not see past 40
rows. Handed 100, of which ~50 are scrollback above the viewport, the `before`-check for a re-sent
`/review packages/host/…` finds the EARLIER send sixty rows up (rendered `>/review…`, with
`/Users/…` output rows under it), calls it "already typed, provably ours", types nothing and presses
Return at an empty composer. So the fallback keeps 40 and the anchor keeps 100: the rule that knows
WHERE the box is may look further, the rule that is guessing may not.

`settle.ts` was narrowing by the same bottom-`depth` slice and its comment already said the two were
"meant to be the same rule"; they now are — **including the window**, which is shared rather than
copied. A tear putting the frame 40–100 rows up was otherwise confirmable by `deliver.ts` and
invisible to the reader asked about it minutes later. Its `seen` gate had to move with it: that gate
gated the structural answer on the narrow tail, so the wider anchored read would have been a no-op
and text inside a box fifty rows up would still have fallen through toward `absent` — the verdict
that sends a prompt a second time. `seen` is the OR of the two readings now and the narrowing still
only ever DOWNGRADES. An interjection the echo window could not confirm settles `composer` instead of
`unknown` when the text sits above streamed output.

**The tear runs both ways, and the second way `newestOnly` guesses wrong.** "Does the composer
ALREADY hold my text" is a claim about the LIVE box, so it is asked of the bottom-most frame that is
holding anything — right when the stale frame is the empty one, wrong when an interjection was just
SUBMITTED and the live box is the empty one at the bottom while a stale frame above it still shows
the words that have gone. Believing the stale frame there means typing nothing and pressing Return at
an empty composer: `unsubmitted` for a prompt that never ran, off a screen that said "provably ours".
Which frame is live cannot be read off a rendered screen, so `composerFramesAmbiguous()` reports that
the screen is not answerable and the delivery takes the branch it already has for "I cannot tell" —
`retry`, provably no side effect, a sentence in the audit row, and no health observation. It is a
predicate rather than a fourth `EchoRule` member on purpose: the three rules are evidence grades that
`echoAmbiguous`, `settle.ts` and the delivery path all switch on, and a member meaning "disregard the
other three" would read as a match at every site that forgot it.

**And the miss path was doing damage, not just filing a bad verdict.** After an unconfirmed echo the
delivery sweeps the composer so a re-fire starts clean — an Esc, then six ctrl-Us. That is right for
an idle session and a weapon against a working one: the Esc **interrupts the running turn** (the
hazard the log-proof ordering above already documents, which ordering alone does not remove — a miss
caused by a misplaced echo arrives here with the turn very much alive), and the ctrl-Us then delete
the interjection that HAD landed, which the sweep re-sends minutes later. So the sweep is suppressed
outright when a hooked session says a turn is active. Nothing is lost by skipping it: text left in a
busy composer is `settle.ts`'s `composer` verdict — one keypress from running, and not `absent`, so
no re-send can stack under it.

**The ambiguous-`before` branch records NO health observation.** When the composer already holds text
this app cannot tell apart from the caller's, the delivery types nothing and answers `retry` with a
sentence — that part is unchanged. What it used to do as well was file a `deliver.echo` miss, and
that is the "was this the right rule" mistake (`shared/clihealth.ts`): nothing had been typed yet, so
no echo of our text was ever owed and the probe did not fail to find it. It refused to credit
somebody else's words to this delivery, which is the rule being right. The shape that triggers it is
a re-send of a prompt whose first attempt is still in the box, i.e. the commonest shape there is, so
counting it pinned the signal amber on a path where nothing is broken.

**A view is not an interjection, and the second Return is what closes it.** Reported with two frames
from the same minute: one showing a delivery stuck at *"Sending… 10s"* with the completion menu open,
the other showing `/usage` followed by the CLI's own **"Settings dialog dismissed"** — with the
session 22 minutes into a turn. *"It looks like some automatic esc command is triggered after I see
the selection screen."* No Esc: there is exactly one in this file and it is already suppressed for a
local command. It was a RETURN, and the cause is two decisions that were each defensible alone.

*The client sent it at all.* `session.input` is delivered `interactive` — "a person typed this, do
not wait for the agent to finish" — which is right for prose and wrong for a command that submits no
prompt and opens a MODAL: over a streaming turn it contests the composer that turn is using and is
dismissed by the next thing that touches the screen. So `isLocalCommand` moved to `@waterplane/shared`
(both ends need the same answer and only the host had it) and the phone now parks one aimed at a BUSY
session — the send queue already had the mechanism and the strip above the composer already says it
is waiting and offers *send now*. An idle session takes it at once, which is every ordinary use.

*And the submit loop pressed twice.* A Return that OPENED a view is invisible for as long as the view
takes to draw, and this one is an ink component behind a control-request. The loop waited ten 150 ms
polls, concluded the press had been swallowed, and pressed again **into the view the first press had
just opened**. The two costs are not symmetric: patience costs latency on a Return that really was
swallowed, impatience destroys the thing the person asked for after it had already worked. So
`LOCAL_MOVE_POLLS` is ~5 s and `LOCAL_SUBMIT_TRIES` is 2, not 3 — a third press never rescued
anything the second did not, and every extra press is another chance to close what the last one
opened.

**The rescue a slash command could never reach.** When the echo does not turn up inside
`ECHO_WAIT_MS`, the delivery asks the conversation log whether the text ran anyway — and for a slash
command that question is unanswerable by construction: the CLI writes those as an envelope the
transcript reader drops (`isSlashText`), so the log is silent whether it ran or not. Measured on this
host, `deliver.echo` misses ~23% of deliveries (a phone repainting over a slow tunnel); an ordinary
prompt is rescued by the log and a local command went straight to `unconfirmed`, the verdict that is
never retried. Reported from a phone as *"/cost — not delivered · typed, but never appeared on
screen"*, with the command plainly sitting in the composer.

The proof that fits is the one the submit branch 60 lines below already rests on for this same class
of command: **the screen moved.** Typing into a composer redraws it; typing nothing does not. It is
allowed to be weaker evidence than an echo because the hazard `unconfirmed` exists to prevent is
absent here — that verdict is never retried because a second attempt could send a PROMPT twice, and a
local command sends nothing to the model at all. Running `/usage` twice opens the usage view twice.
If the text really never landed, the Return falls through to `unsubmitted`, which is a better answer
than `unconfirmed` and equally un-retried. Scoped to `isLocalCommand` and pinned three ways in
`packages/host/test/deliversubmit.test.mjs` — rescued when the screen moves, NOT rescued for an
ordinary prompt, and still `unconfirmed` on a screen that never moves. The caveat is written at the
call site rather than left implicit: **a busy screen reads as moved**, this TUI repainting on its own,
so a genuinely swallowed local command can be upgraded on evidence that would have been there anyway
— the same caveat the submit proof 60 lines below carries, resting on the same fact.

**A rescue is not also a success.** The rescue records a `fallback`, which `shared/clihealth.ts`
counts as a MISS — the primary rule did not answer — and then control left the failed-echo block and
fell through to the unconditional `noteHealth("deliver.echo", "good")` at the end of it. One local
delivery whose echo never appeared therefore wrote a miss AND a success into the same twenty-slot
window: a `good` claiming an echo nobody saw, against the rule this whole subsystem is argued from,
and a rate describing no event at all with the real misses diluted out of it. **It is one observation
per DELIVERY** — the comment three lines above already said so — so the `good` is gated on the echo
actually having been seen. `packages/host/test/deliverecho.test.mjs` asserts the COUNT, not the last
value: a pair like that reads correct from either end on its own.

**`/btw` is not a view, and it still starts no turn.** The two questions this subsystem had been
answering with one list came apart on the one command that is in neither category. `/btw` takes the
composer's words, files them as a note for the agent to read at the end of the turn, clears the box —
and fires no `UserPromptSubmit`. So the hooked path pressed Return five times waiting for a turn that
cannot start, asked the conversation log (silent for a slash command by construction, and for this
one *completely* silent: `transcript.ts` measured `/btw` as writing no envelope and no stdout record
at all, which is why `screenCommandTurns()` has to rebuild it from waterplane's own PTY capture), and filed
the note as **`unsubmitted`** — "it is sitting in the composer, unsent — do not retype it", which is
the one verdict in this app written to be acted on by hand. Reported from a phone as a red Activity
row about a note that had been filed perfectly.

Adding it to `LOCAL_ONLY` would have fixed the host and broken the phone: that same list is what
parks a command aimed at a busy session, and `/btw` exists *precisely* to be said to a working agent
without interrupting it. So `shared/slash.ts` now answers two questions instead of one.
`startsNoTurn()` is the wider one and the one the submit contract hangs off — no turn-start proof, no
log, so the proof is the screen moving; `isLocalCommand()` stays the narrower "this opens a VIEW" and
is asked by exactly two callers, the phone's hold-until-idle rule and the composer sweep's Esc (which
`/btw` must NOT be spared: it opened nothing, so there is no view for the Esc to destroy). Every
`isLocalCommand` is a `startsNoTurn`; the reverse is the whole point. The honest cost, written at the
call site: on a busy screen the moved-screen proof is satisfied by the turn's own repainting, so a
`/btw` whose keystrokes were genuinely swallowed can be upgraded to `ok` — worth a duplicate note the
agent reads once, against telling someone their note is unsent when it is not. `BackendDelivery`
carries both, and opencode answers `false` to both for the reason it always has: its vocabulary was
never measured.

**The command is `/usage`, and `/cost` is an alias.** The CLI's own table (2.1.236) reads
`{ name: "usage", aliases: ["cost", "stats"] }`, which is why its completion menu draws the entry as
`/usage (cost)`. The toolbar sent the alias, so the button and the CLI's own menu named the command
two different ways and the one on screen was never ours. Both stay in `LOCAL_ONLY` (an older CLI has
only `/cost`) and both carry the CLI's current words. `usage.ts`'s parser was checked against the
live output at the same time and is fine — session, week and both reset instants all read correctly.

- `deliver.ts` — **the one implementation** of "type into a live session like a human, and confirm".
  Returns `ok` / `retry` (nothing typed, safe to re-run) / `unconfirmed` (written, never seen —
  never auto-retry) / `unsubmitted` (in composer, Return swallowed — say so, never retype). Echo is
  checked by POLLING the RENDERED screen (`ECHO_WAIT_MS` 4 s), never a byte window — and by PLACING
  the echo STRUCTURALLY (`echo.ts`'s `composerEcho`: inside the `❯` box the CLI draws to take
  typing), not by distance from the bottom of the render. A slash command draws its completion menu
  UNDER the composer, and mid-turn the replay TEARS and leaves stale rows under the live box — both
  hide text that is plainly there, and the second was ~30% of deliveries. No box on the screen ⇒ the
  old distance rule at the OLD DEPTH (`echo.ts`'s `FALLBACK_ROWS`, 40, against `ROW_WINDOW`'s 100
  for the anchor): the wide window is only safe for a rule that knows where the box is, and the
  fallback's slash allowance would otherwise read a `/review …` that ran sixty rows ago as one
  sitting unsent. A composer we stop recognising must never brick delivery. **Two frames that do not
  agree are not a composer** either (`composerFramesAmbiguous`) — a live EMPTY box under a stale one
  still holding submitted words is the same tear upside down, and picking wrong presses Return at
  nothing. The miss
  path's composer sweep is SUPPRESSED mid-turn — its Esc interrupts the running turn and its ctrl-Us
  delete the interjection that landed. **ONE health observation per delivery**: a rescue records the
  `fallback` and the trailing `good` is gated on the echo having actually been seen — a miss and a
  success for one delivery is a rate about nothing. **A multi-line write IS a
  paste**, and the TUI collapses one to `[Pasted text #1 +N lines]` — hiding the very head the probe
  is cut from, so a long prompt (the Build sheet's "set up" one) echoed perfectly, read as never
  typed, and sat in the composer unsubmitted. **The collapse has a second trigger and the placeholder
  a second form**, both measured off the 2.1.236 binary: the composer collapses on
  `text.length > 800 || newlines > 2`, so LENGTH alone is enough and a one-line write is not exempt;
  and the placeholder is built from the NEWLINE count, with the clause omitted entirely when that
  count is zero. A long single-line prompt — which is what a message typed on a phone is — therefore
  draws a bare `[Pasted text #5]`: no head, no tail, no count. A regex that required `+N lines`
  matched none of them, and `unconfirmed` was the verdict for every one, so the phone showed "1
  message not delivered — the host could not read that session's conversation log or its screen"
  while the words sat in the composer one keypress from running. An absent clause is a STATEMENT —
  zero newlines — which is evidence FOR a one-liner and AGAINST a twelve-line prompt; reading it as
  `NaN` is what dropped it out of the bound. It is also the weakest tie there is (two long
  one-liners are indistinguishable behind it), so `echoAmbiguous` treats any collapsible rival as a
  rival and the answer degrades to `retry`/`unknown` rather than to a Return at somebody else's
  words. The placeholder counts as the echo when it can be tied
  to THIS text (its tail on screen, or a hidden-newline count covering all of it); `settle.ts` applies
  the same rule, so a collapsed prompt settles `composer`, never `absent` — which would re-send it
  on top of itself. `e2e-pastechit.mjs`. Return is verified and
  re-pressed up to 5× on a hooked session. `{ interactive: true }` = human interjection (waits only
  for the draw to settle). **A TUI-local command (`slash.ts`'s `isLocalCommand()` — `/cost`,
  `/context`, `/resume`, …) opens a view instead of running a turn**, so it fires no
  `UserPromptSubmit`: the proof is the screen MOVING (self-limiting — once the view is up no further
  Return is sent) and the composer sweep must send NO Esc, because the view it would close is the one
  the user asked for. **A probe is a PREFIX, so a match is only evidence when nothing else could
  have produced it** (`echo.ts`: `screenEcho` says WHICH rule matched, `echoAmbiguous` asks whether
  another open delivery into that session shares the head): 14 characters made a re-send
  indistinguishable from its original, which returned `ok` for a prompt that never ran — and nothing
  ever revisits an `ok`. Ambiguous ⇒ nothing typed, nothing submitted, `retry` with a sentence saying
  so — and NO health observation, because nothing was typed and no echo was owed. **And the composer
  is a VIEWPORT, not a field.** The box is sized off the TERMINAL's height and the text SCROLLS
  inside it, so a prompt longer than the box is only partly drawn — and after a write the cursor is
  at the end, so the part drawn is the TAIL. Measured against the 2.1.267 binary at 56 columns, the
  same 632-character prompt draws 3 composer rows at a terminal height of 12, 5 at 20 and all 14 at
  40: the heights a phone reports are exactly the ones that hide it. Every screen rule asked for the
  fourteen-character head, which is off the top of the box; and under 800 characters the CLI
  collapses nothing, so the placeholder rule that rescues the longer prompts cannot speak about
  these at all. The live host filed `unconfirmed` for **45% of every delivery between 300 and 800
  characters** against 17% of the short ones, each one a prompt sitting in plain sight in a composer
  behind a gravestone that is never auto-retried. So a box whose WHOLE contents are a window onto
  this text is an echo (`echo.ts`'s `scrolled` rule, `SLICE_MIN` = 40 squashed characters). The
  window is asked for as a SUBSTRING and not as the suffix a fresh write produces, because
  `settle.ts` asks the same question minutes later and by then the box has been scrolled wherever
  the reader left it — the capture that started this showed the HEAD of a 632-character prompt hours
  after it was typed. It is more evidence than `head` and less than identity, so it is ordered
  between `paste` and `head`, and `echoAmbiguous` polices it the same way: a rival sharing any
  window of our text is a rival, asked conservatively (do these two share a window at all, since the
  screen's actual window is not in hand), and past `SLICE_SCAN_MAX` a rival is simply treated as
  confusable rather than scanned for. `e2e-scrollcomposer.mjs` pins it against a stub whose composer
  draws only its last three wrapped rows; it fails exactly as the field did the moment the rule is
  removed. Don't fork this file.

**The CLI was carrying the proof all along.** Every rule above reasons about a SCREEN, and the
scrolled-composer measurement says how far that gets: on this desktop `deliver.echo` still ran 20
good to 18 miss, the sent log put 46% of deliveries between 300 and 800 characters at `unconfirmed`
against 19% below it, and the health record's own sample for the signal is `1 lines, 632 chars` —
one line, because a phone message has no newlines and therefore no paste placeholder to rescue it.
Those prompts were typed, in the composer, one keystroke from running, and the miss path swept them
away with a ctrl-U and reported them unsent.

`UserPromptSubmit` carries the submitted text. Verified against 2.1.267: `{session_id,
transcript_path, cwd, prompt_id, permission_mode, hook_event_name, prompt}`. The host had been
reading that event for the FACT that it fired and throwing the words away — so the whole submit
ladder rested on evidence about a SESSION (a turn count moved, a turn is running, the scrollback
grew), every piece of which is equally true of a session busy for its own reasons. The prompt is the
one signal that is about a DELIVERY. Two things follow, and they are the whole change:

- **An echo nobody could read is no longer the end of it.** Where the screen never showed the text
  and the conversation log has nothing yet, a hooked session gets ONE Return and is then asked what
  it took (`PROMPT_HOOK_WAIT_MS`). A Return can never stack a copy — the same property the ladder
  below already presses five of them on — and `sessions.ts`'s `claimSubmittedPrompt` answers with
  our own words or not at all. Match ⇒ `ok`, recorded as a `deliver.echo` FALLBACK (the primary rule
  did not answer) plus a `deliver.submit` good (a proof that exists is worth recording). No match ⇒
  everything downstream is untouched, sweep included: the composer is still cleared when no turn is
  provably live, so a later re-send still starts clean. An UNHOOKED session presses nothing, because
  there would be nothing to ask.
- **An interjection is provable for the first time.** `interactive` cost the submit proof by
  construction — `turnActive` is already true, so no turn-start can be attributed to our Return — and
  the health record was told to write NOTHING rather than file a miss for how the user likes to
  work. A hook naming our text is not confusable that way, so that branch now records a good when
  the CLI answers and stays silent when it does not.

**The claim is spent, exactly once.** Two deliveries of identical words — `continue`, or the sweep
re-sending a prompt it proved never ran — would otherwise both read one event as their own and the
second would be reported `ok` having never run; same rule and same reason as `settle.ts`'s
`spendTurn`, and the window is floored at the delivery's own start so an earlier event cannot be
claimed late. The one outcome this makes visible for the first time is a Return into a box holding
words this app could not read: the hook names what actually went in, so the row SAYS the session
submitted something other than your text instead of reporting a clean miss.

**And the row now carries what the delivery was SHAPED like** (`DeliveryShape` on `SentCommand`):
characters, lines, the PTY grid the composer was drawn in, which echo rule answered, what proved the
submit — and `view`, the one fact only the phone has. The reader unmounts the xterm, so nothing
host-side distinguishes a send composed over the reader from one composed over the live grid, and
"deliveries written in the reader feel less reliable" was a question this log could not be asked.
It rides `session.input`, is stamped at COMPOSE time (a queued entry flushes long after the person
switched screens) and **no branch on either side reads it**: measuring a hunch is not the same as
acting on one, and every field degrades to absent rather than to a zero.

### `settle.ts`

- `settle.ts` — **what became of a delivery that couldn't be confirmed**, asked LATER.
  `unconfirmed`/`unsubmitted` are honest about a 4 s echo window and useless after it, and neither
  may be auto-retried — so the queue kept a gravestone nothing revisited. `settleDelivery()` reads
  the CLI's own conversation log and the live screen: log has it ⇒ `landed`, on screen ⇒ `composer`,
  READABLE log without it ⇒ `absent` (never ran, nothing holding it — a re-send is now provably
  safe), else `unknown`. Only the `jsonl` source proves `landed` (the history fallback is our own
  pre-Return record) and `absent` requires the log (a screen is 40 rows). Read-only: it types
  nothing, ever. **The LOG is compared WHOLE** (`echo.ts`'s `logEcho`, needle capped at
  `LOG_NEEDLE_MAX`), never on the screen's 14-char head: the jsonl has no truncation to work around,
  and a prefix let one prompt's turn prove a different prompt had run — the row retires and the words
  are gone. **A log turn is evidence for exactly ONE delivery** (`spendTurn`, keyed by ackId,
  re-seeded from the persisted `turnId`), which is the half whole-text matching cannot do: two
  deliveries of the SAME words are what a re-send IS. The second to arrive gets `unknown`, never
  `absent` — "somebody claimed this turn" is not a readable log that lacks the words, and `absent`
  authorises a re-send. A screen match a rival could have produced is `unknown` too, never
  `composer`. `e2e-settle.mjs`.

- **The re-send is a BUDGET, not a boolean** (`opendeliveries.ts`, `RESEND_TRIES`,
  `WATERPLANE_RESEND_TRIES`, default 4). One attempt, then a full stop, was the original rule, and the
  complaint it produced was about WORDING before it was about the count: a send went red inside
  fifteen seconds saying nothing ran and that nobody would try again — which reads as fatal for what
  is usually a session that stayed busy one moment longer. The safety argument is unchanged and is
  what allows the change: every attempt is preceded by its OWN fresh `absent` verdict, i.e. a
  readable log that does not contain the prompt and a screen that does not either, so there is never
  a copy for the next one to stack on. That proof is per-verdict, so a third attempt is as safe as
  the first was, and the count is only a stop rule — a row proved absent four times is not waiting on
  another five seconds, and the honest end of that is a sentence a person reads. The gap before each
  re-ask doubles from `WATERPLANE_SETTLE_BASE_MS` with the attempts (five seconds has already failed twice
  for this row by the third), which keeps all four attempts inside the first minute — the window the
  complaint was about — while a `retry` result still finishes the row immediately, because "the
  session never became ready" is a state rather than a race and another attempt in five seconds is a
  poller with a nice name. `resends` rides on the wire beside `resentAt` so the phone can say "still
  trying, third time" rather than "tried once and stopped"; a row written before the count existed
  and carrying a `resentAt` counts as one try.

### `fanout.ts`

- `fanout.ts` — one prompt → N repos, fresh session each, dirs validated against `discoverTargets()`
  (unknown paths silently dropped, never spawned), `WATERPLANE_FANOUT_CONCURRENCY` at a time.
  **A run is now N intents sharing a `groupId`** — a parent (`target: repos`) plus one child per repo
  — so `FanoutRun` is REBUILT from rows (`fanoutRuns`) and a sweep survives the daemon for the first
  time: a restart used to leave twelve live claudes and no record of what they were for. The runs
  ring, the watching map, the second turn-ended/exit watcher and `settle()` are gone; `finishedAt` is
  derived (nothing in the group still going), which is also what makes a follow-up reopen a run.
  `followUp()` posts one child per session (`interject`, shared batch id = the subset one tap
  addressed) and never spawns. A SCHEDULED sweep gets a fresh run id per occurrence — sharing one
  would make the second occurrence post children that already exist and therefore never run.

### `intents/`

- `intents/` — **the durable Intent store**: one file (`.waterplane/intents.json`, tmp+rename), one tick
  (`WATERPLANE_INTENT_TICK_MS`), one lifecycle, for every piece of deferred work the host owns. It
  REPLACES `schedule.ts` and `launch.ts`, which were the same 240 lines twice (launch's header said
  so) and each right in isolation about the two rules that matter. `intents/` owns the store, the tick,
  restart reconciliation and every state transition — `manager.ts` is the facade over the slices
  (`disk.ts`, `ladder.ts`, `fire.ts`, `watch.ts`, …); the executors are injected from
  `server/intentDeps.ts`,
  so a schedule is still a caller of the sweep and never a second one. It also owns the three rules
  that used to be per-manager: the **completion watcher** (the pre-delivery stop-count baseline and
  the turn-ended/exit subscription — there were two copies, the backlog's and the fan-out's, and a
  `Stop` past the baseline OUTRANKS the echo probe's verdict, because on a fast turn the hook beats
  the executor's return value), **`INTENT_MAX_ATTEMPTS`** (only a `retry` verdict requeues,
  `unconfirmed` never — stated once for every executor), and the **fan-out's concurrency pool**, as
  a bound on rows of one `groupId` that are `starting`. `ExecutorResult.watch` says what ends a
  delivered row: `"turn"` (a Stop, or silence on an unhooked session — the backlog) or `"hook"`
  (a Stop only — a sweep's output is a claim about N repos, and a guess is not one). Rules:
  **`op.ack ok` means on the desktop's DISK** — `post()` persists synchronously and the route acks
  after, because "the phone may now forget these words" is the whole promise; **`starting` (and an
  `at` trigger's `lastOccurrence`) is written BEFORE the executor**, so a crash leaves a visibly
  stuck row, never two claudes in one worktree or a sweep that runs twice; **at-most-once by intent
  id, forever** — the second guard past the ack ledger's 45 min, and what will make deleting the
  phone's 30-minute TTL safe; **nothing is armed with a timer** (a tick re-asks `intentVerdict`, so a
  restart, a sleep and a DST switch can't mis-fire it; an inbox POST and a post kick it); **eviction
  is compaction, never deletion of un-run work** — queued/blocked/starting/running and every
  recurring rule are never evictable, `failed` needs `dismissedAt` first, and what leaves is appended
  to `intents-archive.jsonl`. Restart reconciliation asks the CLI's own log about a `starting` row
  (`settle.ts`'s `logVerdict`) — and about a `running` one: `absent` from a READABLE log ⇒ `queued`;
  `landed` with the session back (tmux) ⇒ RE-ADOPTED `running`, settled later by its Stop or the
  silence sweep; `landed` with the session gone ⇒ `failed` saying it did not come back (at the usage
  limit it FOLLOWS, as every dead session does); anything else ⇒ failed and says so. Never `done`
  off the log alone — `landed` proves the words were delivered, not that the turn ended — and never
  a blanket requeue, which under tmux is a double delivery. See *A restart while the turn is still
  running* below.
  `adapters.ts` speaks the two OLD vocabularies over it, so `launch.*` and `schedule.*` are unchanged
  on the wire: a launch is `{target: repo+fresh, trigger: files}` and a schedule is `{trigger: at}`.
  A missed occurrence past its grace and a spent `once` both KEEP their row now (the old code deleted
  the row, prompt text and all, and emitted nothing); `runNow` still does not spend the occurrence,
  and a launch run early still names the files it went without — but ONLY that run: `missing` is
  assigned by `fire()`/`block()`, never merged, or a launch that waited, got its upload and ran
  perfectly keeps saying it went without a file that is sitting right there. **A `sessionId` is
  per-boot for a PTY and is NOT under tmux**, so it is no longer dropped on load: `reconcile()` runs
  after `sessions.rediscover()` and clears only the ids whose session did not come back — with the
  ids cleared, a finished fan-out could never be followed up (`followUp()` re-drives existing
  sessions and never spawns). Migrates `launches.json` /
  `schedules.json` on first boot and renames each `*.migrated`. `e2e-intent.mjs`, `e2e-launchwait.mjs`,
  `e2e-schedule.mjs`, `e2e-tmux.mjs`.

#### *Let past the budget* lifts ONE rung — `intent.waive` and `Intent.pastBudget`

The re-time sheet had a bulk *run all 4 now, past the budget*, and it sent
`intent.run` per row. `runNow` skips the whole ladder — it is one row's tap,
and a tap is not a pick — so four queued rows in one repo, each `serial`,
`holdForHost`, started in parallel in one
worktree. What the person wanted was the budget out of the way and every other
wait kept. So the waiver is a persisted row fact, `pastBudget: true`, which
rung 2 and the `budget` trigger skip and nothing below them reads: serial,
`hostBusy` and `noSlot` still hold the row. It is set by a new
additive message rather than an `intent.update` patch key, for two reasons:
`update()` forces `queued`, refuses failed rows and re-arms clocks, none of
which a waiver should do; and an older host acks an unknown patch key `ok`
while it IGNORES an unknown `t` — so against an old daemon the rows stay held
(fails closed) instead of the phone saying "let past" over nothing.

Its lifetime is ONE start **inside the window it was granted in**. The first
version was a bare `true` that lived until the row started, and rung 2 sits
ABOVE rung 3, so every auto row over budget read *budget* — including a one-off
for tomorrow 09:00. Waived at 20:00, it fired tomorrow past a fresh block
nobody had seen. So `pastBudget` is `{ until }` now, the LATEST reset among the
ceilings tripped when `waive()` runs (`budgetWaiverUntil` over the same
`budgetOver()` that `bdd2968`'s before-reset `budgetPass` reads — the two are
one shape of answer, a lift that ends at a reset), and `budgetHold` is the ONE
function asking both: a live waiver lifts every tripped cap, a `budgetPass`
only its own window's. `budgetWaived(i, now)` is the reading everyone shares —
rung 2, the `budget` trigger, the tick's sweep that DROPS an expired waiver (so
no phone draws a chip over a row the budget holds again) and the
phone's chip. `waive()` refuses in words when nothing is tripped or no tripped
ceiling says when it resets (no window ⇒ nothing to scope to, never a guessed
one), and on an archived row. `cleanIntentRow` DROPS the legacy `true`: a waiver
with no window cannot be scoped, and dropping it only makes the row wait. The
phone offers the waiver only for rows that would run NOW (`isBudgetHeld`: no
future `nextAt`, a chain's predecessor settled) — the same test the header's ⌛
count reads.

**It stays on through `starting`** and is cleared once `execute()` returns on
every outcome but a provable `retry`; the tick never evaluates a starting row,
so it is inert there. That is what lets a restart mid-start that reconciles to
*absent — nothing ran, queued again* hand back a row still let past; the other
reconcile outcomes (landed, lost recurring occurrence, the failures) clear it.
The window-skip branch, `recordMissed`, `settle()` and `revive()` clear it;
`upsert()` carries it like every other host field a draft cannot say. A
recurring rule let past the budget therefore runs exactly one occurrence past
it, and its F14 child inherits it, `until` and all (`workItemInherits`, the
rule still carrying it while `execute()` runs). `intent.post` strips it (and
`budgetPass`) off the wire — only `waive()` and the host's own drafts write it,
which is why `post()` itself stays permissive.

**A bulk verb never reaches `runNow`**; `packages/web/src/bulkverbs.test.mjs`
counts the `intent.run`, `schedule.run` and `launch.run` call sites in
`App.tsx` so a new loop is a test failure, not a review miss.
`packages/host/test/pastbudget.test.mjs` pins the incident.
Its automatic sibling is `Intent.budgetPass` (below, *A row timed BEFORE a reset*): the waiver is a
PERSON lifting every cap for one start, the pass is the host lifting ONE window's cap for a row timed
to spend what is left before that window resets. A row its pass is lifting is not budget-held, and
one whose time has not come is not due, so neither is counted into *let these N past the budget*;
one the OTHER window's cap holds is, because only the waiver can lift that.

#### A restart while the turn is still running

2026-09-24, 18:51:57: a restart found twelve backlog items mid-turn, each in its own
`backlog · <repo> · <label>` session, all alive under tmux (tmux is the one substrate). Nine were
settled `done` — *"the host restarted after this was delivered — the conversation log has it"* —
while their `.jsonl` files kept growing. `reconcileOne` read `landed` as `done`, and `logVerdict`
only ever says the USER turn is in the log: a turn still running writes exactly the same line.

**Why the decision is deferred, not made.** At reconcile time a re-attached session knows nothing:
`reattach()` → `register()` starts it `hooksActive:false, turnActive:false, stopCount:0`,
`sessionIdleMs` is null until its first byte, and `autoFireBlocker` says it *hasn't printed
anything yet*. So `reconcileOne` re-adopts the row — `running`, a fresh `stopBase` at the current
count, `watchMode` `"turn"`, `blockDetail` saying it is being watched across a restart, the id in
the in-memory `readopted` set — and the two ordinary endings settle it. **Its Stop** reaches the
re-attached session (`routeHook` matches `claudeSessionId`), passes the baseline, and `onTurnEnded`
completes it: *"…its turn finished afterwards — the conversation log has it"*. **Silence**, for a
session still unhooked (after a restart that is every session until its first hook event, and the
ONLY path for a turn that finished while the host was down — its Stop went nowhere): `sweepRunning`
completes it past `idleWindowMs` with *"…the session has gone quiet since"*. A fan-out target
(`"hook"`) is re-adopted as `"turn"` for exactly that reason. A re-adopted row shields its session
from the reaper like any running row (`reapable()`).

**The `awaitingInput` gap, closed on the way.** `sweepRunning` skipped a PARSED box
(`sessionHasPrompt`) but not a dialog the detector could not read: `awaitingInput` rode on
`deps.sessions()` and the sweep never asked. It does now, for every running row — silence under an
open dialog is a person being waited on, not an ending.

**A session that did not come back** can say nothing about how far its turn got, so the row is
`failed` (a standing rule: `queued`, `ok:false`, re-armed) with a sentence sending the reader to
*Recently closed* or the archive — never `done`, and never requeued, because the words ARE in that
conversation. At the usage limit it is left `running` and the first tick's `sweepRunning` hands it
to `endWithDeadSession`, which follows the resurrection by the ordinary rule below.

**Three ways the silence could lie, closed after review.** *Copy-mode*: a pane can outlive the
daemon in tmux copy-mode (`reattach` reads it back), where the client shows history and no live
bytes arrive — so the turn runs on underneath a perfectly silent PTY. `main.ts` hands the store
`sessionIdleMs` = `null` for such a pane (`SessionManager.inCopyMode`; the store is that dep's only
reader), and `null` + alive is "no reading", never quiet. *A `Notification` is not a turn*:
`hooksActive` flips on ANY hook, and the first one after a restart is often the `idle_prompt` a
minute after a turn that ended while the host was down — whose Stop went nowhere. A hooked row then
waited for ever. Rather than change what `hooksActive` means (it gates delivery readiness,
`autoFireBlocker`, `markIdle` and the Stop verifier), the session records `turnHookSeen` — a
`SessionStart`/`UserPromptSubmit`/`Stop` since this process attached — and `sweepRunning` treats a
hooked session that has seen none as unhooked (IntentDeps `turnHookSeen`, optional, absent ⇒ the old
behaviour). *A lost Stop*: the hook is a `curl -m 2` with no retry, and a hooked row whose Stop never
arrived held its session — and, because `reapable()` exempts a session with a running row, an
automatic slot — for the life of the process. `sweepRunning` now FAILS (never `done`; a standing
rule goes back to `queued`, `ok:false`) a hooked row silent for `REAP_CEILING_MS` — the reaper's
own number, exported from `backlog.ts` and handed over as `reapCeilingMs` so there is one
definition — saying no turn-end signal arrived. A visible box or `awaitingInput` still exempts it:
that silence is a person being waited on. And `fail`'s standing-rule branch now clears `sessionId` (a
row back in the queue is aimed at nothing yet); a failed ONE-OFF keeps it, dead or not, because a
fan-out run is rebuilt from its rows and each target still names the session it opened
(`e2e-fanout.mjs` pins that, and the activity sheet reads it).

**Not fixed, not worsened:** a session that stopped at the usage limit and was NOT yet reopened
when the host restarted is not known to have died at the limit — `diedAtLimit` for a session the
host no longer holds reads `.waterplane/revived.json`, which only `doResurrect` writes — so its row takes
the session-gone path instead of following. Pre-existing; the restart subsection does not change it.

**Caveats, accepted.** A person who attaches and types a turn of their own before the silence sweep
fires completes the row on THEIR Stop. And an `alive` + `absent` verdict on a delivery cut
mid-typing requeues into a NEW session while the old composer may still hold the text — pre-existing,
unchanged. `intentsched.test.mjs` §13, `scripts/e2e-tmux.mjs` (a busy loop plays the turn across a
SIGKILL), `scripts/e2e-fanout.mjs` (targets that died with a PTY host end `failed`, never `done`).

#### Following a resurrection instead of requeueing it

`endWithDeadSession` requeues a `running` row whose session died AT THE USAGE LIMIT, and for the
shared-backlog-session model that was right: `resolveRepoSession` followed the resurrection, so the
requeued row landed back in the same conversation. For a row whose session was opened FOR IT, a
requeue runs the work **twice** — `sessions.ts` reopens that very conversation with `--continue` at
the reset AND the queued row opens a second fresh session to run the same words in. Nothing about
that shows on a screen: two agents, two sessions, one item, both of them looking correct.

So a limit exit on a row with `needsSlot(row)` true is asked a different question first. If
`revivedSessionFor(deadSessionId)` answers, the row is re-aimed (`target` → `{kind:"session", sessionId:
revived}`, `sessionId` and a FRESH `stopBase`, since the old count died with the PTY) and stays
`running`. If it does not answer yet, the row is held `running` — never `queued`, which is the whole
point — with `blockDetail` *"its session stopped at the usage limit — following it to the reopened
one"*, and `sweepRunning` re-enters the same path every tick until the revival appears. It is the
move the tick already made for a `session` target, extended to the row that had no target to re-aim
because its session was its own.

**The exemption is about the ROW, and it used to be read off the TARGET the row happened to wear.**
`needsSlot(row)` asks "does this row open its own session", which is true on the way INTO the first
wall and false on the way out of it — the re-aim above rewrites `target` to `{kind:"session",
sessionId: S2}`. So at the SECOND wall the row took the ordinary branch (`queued`, *"it will run
again when the session reopens"*), and the tick's own `session`-target re-aim then pointed it at S3
and `targetVerdict` answered `deliver`: the whole item typed into the conversation that had just
`--continue`d it and was already resuming it. The words run twice, which is the one thing this store
exists to prevent.

And it is not an edge. `maybeScheduleResurrect` reopens a WEEKLY-limited session at `now + 5_000`
("an upgraded plan continues now"), up to `LIMIT_MAX_ATTEMPTS`: S2 opens five seconds later and hits
the same wall **by construction**, so every weekly wall is a two-wall sequence and the first S_n that
actually serves gets the item a second time. `Intent.followed` is the fact, written at the moment the
manager learns it (beside the re-aim that destroys the evidence) and persisted for the reason
everything else here is — the gap to a reset is HOURS, and a restart inside one must not turn the row
back into one that can be requeued. The condition is now `diedAtLimit && (needsSlot(row) ||
row.followed)`, and `fire()` clears the flag, because it is a fact about one run's session.

`scripts/e2e-resurrect-item.mjs` pins it: the row is walked through TWO walls, three sessions born in
that repo all told, never queued, the requeue sentence never said, and the words typed once.

**That question is asked about the SESSION, and it used to be asked about the directory.**
`revivedSessionFor` was `sessions.runningSessionFor(cwd)` — the newest live session whose cwd matches,
whichever it was — and the gap between a limit exit and its reset is HOURS. In that window a person
opens a session by hand in that repo (or taps the sheet's *open a session here*), and the row was
re-aimed at the session they were driving: `target = {session}`, `sessionId = <theirs>`, `stopBase`
taken there. Their next turn ending completed the item — *"its turn finished"* — for work that had
never run; and at the reset the real `--continue` reopened the item's own conversation and finished
it with nobody watching, so if that resurrection then failed (attempts cap) the work was lost under a
`done` row. Under the shared-session model the same weakness existed at `pass()`'s `session` re-aim,
but it only ever pointed at a session that was already somebody's; here it was the default path of
every fired item.

`SessionManager` now records the pairing where both ids are known for certain — `doResurrect` writes
dead id → new id into `revivedBy` — and `revivedSessionFor(deadSessionId)` follows that chain (two
walls in one item is a real sequence) and answers `null` unless it ends on a session that is actually
RUNNING. Memory-only, bounded, and deliberately: the resurrection TIMER is memory too, so after a
restart there is no resurrection to follow and `null` is the honest answer — restart reconciliation
then has the row, with the CLI's own dated log as its evidence. `IntentDeps.revivedSessionFor` takes
a session id, and `intentsched.test.mjs` pins that it is handed one.

#### A `retry` gives the occurrence back, or the prompt never runs

`fire()` SPENDS an `at` row's occurrence before the executor is invoked — `lastOccurrence` stamped,
`nextAt` re-armed — and that ordering is the whole of this module: a crash in the gap leaves a row
that is visibly stuck rather than a sweep that runs twice on boot. It is right for everything that
spends an occurrence by RUNNING. `retry` is the one verdict that says the opposite — *provably
nothing was typed* — and the retry branch handed the row back to the queue without giving the
occurrence back with it.

For a one-off that is fatal, and `isTimedWorkRow` is what made it reachable: a one-off with a clock
takes `freshSession`'s AWAITED backlog branch now, which is the only executor that can answer `retry`
at all (a full pty table, `notready`, an ambiguous echo). So the row went back to `queued` with
`nextAt: null`, and the next tick's rung 3, finding a non-recurring `at` with no occurrence left,
wrote the gravestone: *"that instant has passed and this was a one-off — post it again if you still
want it"*. The instant had not passed. The spawn had failed. Reproduced against the built store — a
`once` row due one second ago whose executor answers `retry` exactly once:

```
once after tick 1: queued attempts=1 nextAt=null
once after tick 2: failed attempts=1 ran=1   | that instant has passed and this was a one-off…
idle (control)  tick 2: done ran=2           | delivered
```

Zero runs, and the sentence on the row tells the person to retype a prompt the daemon never typed —
this repo's worst failure class, landing on exactly the rows the change had just moved into the
backlog. `unspend()` is the fix: for a NON-RECURRING `at`, `nextAt` goes back to the occurrence and
`lastOccurrence` is cleared. `clearedOccurrence` is restored with it, and that is a statement of fact
rather than a kindness — reaching `fire()` IS rung 3 having released that occurrence, so the retry
must not be judged a second time against a grace the first attempt spent. `INTENT_MAX_ATTEMPTS`
bounds the loop, as it already did.

A `window oneShot` row failed worse-shaped: `armFrom` finds the FOLLOWING reset perfectly happily, so
a retried row was left armed a reset out and ran, silently, at a moment nobody chose.

Recurring rules are deliberately untouched. Their occurrence is one of many and the next one is
already placed; handing this one back would arm the same instant twice, which is this file firing a
schedule twice by another route — the standing-policy reading `reconcileOne` and `recordMissed` both
take. `reconcileOne`'s `absent` verdict, though, IS the same proof `retry` is (a readable log without
the words), and it had the same hole: a restart mid-delivery wrote *"nothing ran, so it is queued
again"* onto a row with nothing left to be queued for, and the next tick overwrote that with the
gravestone. Same answer, same helper. `intentsched.test.mjs` §11 holds all of it, controls included
— an identical `idle` row, and a weekly rule that must keep the old behaviour.

#### `intents.json` that is corrupt, or from a newer host

**Corrupt** (does not parse, or is not `{ schema, intents }` / an array): `readJsonGuardedDetail`
moves it to `intents.json.corrupt-<ts>`, the store starts empty, and `main.ts` puts a `backlog` feed
row up saying where the bytes went (`storeNotice()`). The old `catch { /* fresh host */ }` booted too
— and its first `persist()` erased the only copy. **A NEWER `schema`** than `STORE_SCHEMA`: the rows
are read as far as `cleanIntentRow` understands them, and the store is **read-only for this boot** —
`persist()` and `archive()` write nothing, `post()`/`upsert()` refuse in words (`ok` means on disk),
`pass()` and `runNow` fire nothing (a `starting` that cannot reach the disk is a row the next restart
may run twice), and the legacy imports are skipped (they rename their source). The feed row says to
update the host. Never downgrade the file. `packages/host/test/intentstorefile.test.mjs`.

#### `intents.json` schema 2 and 3, and the `.bak`

The file was a bare ARRAY (schema 1) and is now `{ schema, intents: [...] }`. The number is a ladder
of conversions that have run. **2** records one thing: every `{kind:"repo"}` row in it has been
re-read as `{kind:"repo", fresh:true}` — i.e. every work item that was queued for its repo's one
shared backlog session now opens a session of its own. `cleanTarget` performs the conversion, on the one path every row enters through; `load()` only
says it happened, so a host that finds `schema: 2` does not write the backup a second time. Both
shapes are read, because an e2e writes a v1 array on purpose to exercise exactly that path.

**3** records the other one: the LEGACY two-row shape has been folded. Before `isTimedWorkRow`, a
one-off `at` row with `origin: schedule:work` did not run its own words — it made a CHILD backlog
item and settled itself `done` with the child's id, so one piece of work was two rows. That shape is
gone, but eight of those parents are in the live store, and under the new classification they are
BACKLOG rows: the repo's backlog showed each piece of work twice, once as the session that ran it and
once as a parent with a clock chip, no session, no *open*, and a *re-fire* that would type the words
again; and the spent-clocks foot counted them as timed items that "have been and gone — run or
missed", which they neither did. `foldLegacyWorkParents()` archives a timed WORK row whose
`result.childId` names a row this store still holds — `archived` is rung 1 of the ladder (*set aside
— bring it back to let it run*), so nothing fires, nothing is deleted and the fold is one tap from
being undone. A `childId` pointing at a row that has been compacted away is LEFT ALONE: the parent is
then the only account of that work left.

The schema bump is what makes it run ONCE EVER rather than once per boot, and that is the whole
reason it is a number on the file rather than a pass over the rows. The fold is a judgement a person
may disagree with, restarts here are routine, and a conversion re-derived from the rows would undo
their *bring it back* on the next one. The mark is written even when nothing was folded — a
conversion that found nothing to do is still a conversion that has run.

The `*.bak` beside it is the same posture every other conversion in this store takes — the words were
the user's and a conversion nobody can check is a conversion nobody can trust — and it is also the
rollback: an older host reads only the array form, and the copy beside the file IS that array. The
copy is written BEFORE the new file, which is the only ordering in which a crash between the two
loses nothing.

#### `noteSession` — a row says where it is running before it finishes running

An executor that OPENS a session and then delivers into it holds its row in `starting` for the whole
delivery — seconds, while `deliverPrompt` proves what it typed — and `ExecutorResult.sessionId`
cannot help, because it arrives at the end. For that whole window the row rendered as running with no
session on it: an item plainly in flight, and *open the session* leading nowhere. `noteSession(id,
sessionId)` is what the executor calls the moment the session exists. It also takes the completion
baseline there, which is the earliest honest moment for it — the session is up and nothing has been
typed into it yet, so the first `Stop` past that count is genuinely this row's turn ending; on a fast
turn the hook used to arrive against a `starting` row with no baseline at all and was dropped.

#### Recurrence decides the list — and a one-off runs itself

An `at` trigger was read as one thing, and it is two. A **standing rule** is a clock to arm, pause
and skip; a **one-off aimed at one place** is waiting work whose WHEN happens to be an instant. The
second is exactly the argument `isBacklogRow` already made for `after` — *"a chained item is a work
item whose WHEN happens to be an event… there is no recurrence, no clock to arm, nothing for the
schedule sheet to pause"* — one trigger over.

It was found in a live store rather than on a screen, which is why it lasted through two earlier
passes over the same seam: **9 live `at` rows on the author's desktop, every one of them one-off,
zero recurring; seven of them `failed`.** The Schedules sheet was, in practice, a second backlog with
clocks on it — and because `isBacklogRow` excluded `at`, none of those rows was in any repo's
backlog, so no backlog feature could see one, and the user
asked for the third time why "scheduled tasks and backlogs" were two things.

`@waterplane/shared`'s **`isTimedWorkRow`** is the whole classification: an `at` trigger whose rule does not
recur (`ruleRecurs`, so `oneShot` counts, not just `kind: "once"`), a prompt payload, aimed at ONE
place (`repo` or `session`), and not a fan-out child. Such a row is `isBacklogRow` and is NOT
`isScheduleRow`. A recurring rule of any target stays a card, and so does a one-off **sweep**
(`repos`) — it names every repo it touches and has no single backlog to live in. **It is DERIVED,
never stored:** an edit that flips *tonight* to *every Thursday* moves the row between the two lists
on the next read, with nothing to migrate and no field on disk free to disagree with the trigger
beside it. `intentKind`'s order is unchanged; `schedule` simply stops claiming these and they fall
through to `work`.

Three rules in `intents/` turn on it (`execute()` and `fire()` in `fire.ts`, `update()` in `write.ts`), and each was wrong for a one-off before it existed:

- **`execute()` hands a `schedule:work` row to `workItem` only when `isScheduleRow`.** A recurring
  rule outlives each occurrence, so each occurrence needs a row of its own to be the account of — F14
  and `workItemInherits` are unchanged and now describe that case only. A one-off has nothing to
  outlive, and it falls through to `freshSession`'s AWAITED branch, which `isBacklogRow` is the one
  line gating: its own session (`backlog · <repo> · <label>`), `startPrompt` + `deliverChain`,
  `watch: "turn"`, `deliveryError`'s wording, the `retry`-only requeue. `serial` and `holdForHost`
  are already on the row (`scheduleToIntent` sets both from `waitUntilFree`), so rungs 4 and 4.5 hold
  it exactly as the tick always meant to.
- **`fire()` no longer returns a hand-run timed WORK row to `queued`.** That branch keeps a promise
  — *this does not use up the next scheduled run* — about a row that HAS a next run. A one-off has
  none, and kept, the branch put an item that had just run straight back in the queue.
- **`update()` gained one carve-out**, the same shape as `runNow`'s: a **`failed`** timed work row,
  patched with a **`trigger`**, is revived (`queued`, and the field set `requeue()` clears). Each
  clause of that gate earns its place — `done` ran and `canceled` was called off, neither is owed
  anything; a standing rule never terminates and a spent sweep is the schedule sheet's; and a
  text-only patch on a failed row is still refused, because rewording a gravestone quietly turned it
  back into pending work. Dropping the clock (`{trigger: {kind: "idle"}}`) also drops `nextAt`,
  `lastOccurrence` and `clearedOccurrence`; re-clocking it arms from scratch (`armNew`), never from
  the spent occurrence, and a `once` still past its grace arms to `null` and is failed again in its
  own words.

On the wire, **nothing moved.** `PROTOCOL_VERSION` stays 1, `scheduleToIntent` is untouched and
`schedule.save` still accepts a one-off, so an APK pinned to an old bundle saves one exactly as it
did and still gets its ack. Only `intentToSchedule` changed: it answers `null` for a timed work row,
which is the precedent it already set for a non-`at` row — a list that has no vocabulary for a row
does not show it with its fields missing, it does not show it. `BacklogItem` gained two OPTIONAL
fields instead: `at { rule, graceMin, nextAt }` (the WHOLE rule, never a rendered sentence, for
`intentToSchedule`'s reason — quiet hours and the headroom guard are clauses on the rule, and a field
list is a list to forget the newest one from) and `holdForHost`. Absent = the row it always was.
**`main.ts`'s `onChange` sends a clocked row to BOTH lists.** It keyed the schedule broadcast on
`isScheduleRow` and the backlog broadcast on `isBacklogRow` — each row to the list it belongs to NOW,
which is right for every row whose list cannot change. Classification is derived, so a timed row's
list CAN change, and moving between them by editing *once* → *every week* is the point of all this.
The phone's backlog copy is only ever replaced by a `backlog.list` frame — `intent.changed` never
touches it, and nothing on the phone re-asks — so the row it had just left sat in the Backlog sheet
with its old clock chip until the socket reconnected, and the reverse direction left a stale card in
Schedules. Neither list can say "this left me"; only the pair of them can. So any `at` row re-sends
both snapshots: it MAY have just crossed, and the cost is one small extra list per transition of a
clocked row against a phantom of the very edit this exists for. The one crossing no test of the new
row can see is a clock being taken AWAY — there is no clock left to key off — so `update()`
broadcasts the bare `onChange()` when a patch changes the trigger's kind, which is the shape that
already means "the whole store moved". Pinned in `e2e-timedwork.mjs` §7, on the FRAMES and over a
deliberately quiesced socket: both lists are also re-sent by ordinary churn, so "the row is gone from
the list" passes for the wrong reason the moment anything else in the store moves.

**…and so does the notification it settles under.** `intents.on("settled")` branched on
`trigger.kind === "at"` too, so a timed work row announced itself as *"Scheduled: …"* / *"Schedule
failed: …"* — which put a backlog item's outcome behind the **`info`** notification preference
(`notifyprefs.ts`), the one a person turns down to stop hearing about clocks, and gave it no
`sessionId`, so the tap opened nothing. It is `isScheduleRow` now, so a one-off falls through to the
same *Backlog item done* / *Backlog item not delivered* line every other work item uses: governed by
the **`backlog`** preference, tagged `backlog`, carrying the session it ran in so the notification
opens that conversation. A standing rule and a one-off sweep keep the schedule wording, which is the
only thing either of them is. `missed` is untouched and needs nothing: `recordMissed` is only ever
reached by a rule that HAS a next occurrence, since a non-recurring row past its grace fails at rung
3 instead. **`skipped` is untouched and is still wrong for a one-off**, which is a pre-existing hole
this made easier to reach: a `window` rule marked `oneShot` whose condition says no settles `failed`
with `nextAt: null`, and the notification says *"Nothing ran; the next occurrence is armed"* about a
row that has none. It was as wrong for a one-off SWEEP before any of this; it is written down here
rather than fixed in passing, because the sentence is a `notifyprefs` question with no test layer of
its own yet.

**F6, checked and intact.** The audit that found the above also reported that `waitUntilFree` was
being lost on a round trip, because four failed rows carried `holdForHost: true` while "their own
rule said `waitUntilFree: false`". It is not lost, in either direction: that flag lives on
`ScheduleEntry` and never on `ScheduleRule`, so it was read off the wrong object. What was missing
was a PIN, and `intentsched.test.mjs` now has it both ways — entry → `upsert` → `intentToSchedule`
keeps `true`, half a tick reads back as absent, and an entry without it comes back with the key
absent rather than `false` (the phone's `seedFromIntent` reads the box with the same expression, so
one direction was never enough).

**F7 — `upsert()` carries what `ScheduleEntry` cannot say.** The same round trip found a worse
hole than F6's, and this one was real. `ScheduleEntry` is a lossy view of an intent: it says when,
what and where, and it cannot say what the row is CALLED, where it sits in a list, whether somebody
dragged it there, whether it is set aside, or how many times it has been put back. Every one of
those is the HOST's field, and `upsert()` rebuilds the row from the DRAFT — so a field left to the
spread alone is a field this path DELETES.

It bit because a one-off with a clock is now a BACKLOG row (`isTimedWorkRow`). A person titles it in
the backlog's own editor, stamped `hand` — the one author no machine may write over — and later
changes its time in the send sheet. That is `schedule.save` → `scheduleToIntent` → `upsert()`, and
the title, the kind and BOTH authors came back out gone. Worse than gone: the row was then untitled,
so the next naming pass wrote machine words into the field a person had typed in, which is the single
failure the whole `NameAuthor` apparatus exists to make impossible. This is `revivedShape`'s rule —
*what a row is CALLED is not a fact about the run that just failed* — one path over, and
`revivedShape` had it written down while the other rebuild-from-draft path did not.

The four naming fields, `order`/`handOrdered`/`archived` and `requeues`/`requeueCount` are therefore
carried from `prev` when the draft is silent about them, PAIRWISE for the two naming halves, exactly
the treatment `lastOccurrence` and `result` already had. A draft that DOES name a title means it
(`intent.post` can send one, and `cleanIntentRow` drops a value whose author is missing either way).
The audit of the file's other rebuild-from-draft paths found no second instance: `post()` returns the
existing row untouched when the id is already known, `update()`/`retarget()` spread the patch over
the ROW rather than over a draft, and `migrateFile()` skips any id the store already holds.
`intentsched.test.mjs` pins it — title, stamp, kind, position, hand-placement and archived all
survive a re-timing, and a draft that names a headline still wins.

`scripts/e2e-timedwork.mjs` is the end-to-end half: saved through `schedule.save`, listed in
`backlog.list` and not in `schedule.list`, fired once in a session of its own with no child row, a
missed one still in the backlog and re-firable, *drop the clock* rescuing another, and a weekly rule
still minting a child per occurrence.

#### Putting a failed row back in the queue

An assessment judges `queued`, `blocked` and `failed` rows, and until this landed applying *still
wanted* to one wrote a sort position and nothing else. For a queued row that is the whole verdict.
For a **failed** row it is nothing at all: the row is terminal, the tick's ladder never looks at it
again, and a position in an order the row is not in changes nothing anybody could observe — while
the sheet said "position 1 in the order" about exactly that row. Measured on the desktop this was
written on: the usmc backlog was 0 queued and 19 failed, so the only verdict the run could usefully
reach was a no-op.

So there is one private transition, `revive(row, entry)`, and two public verbs over it.

**The transition.** `state = "queued"`, and then three lists that each earn their place:

| cleared | kept | untouched |
|---|---|---|
| `attempts`, `startedAt`, `settledAt`, `sessionId`, `dismissedAt`, `blockReason`, `blockDetail`, `missing`, `followed`, `clearedOccurrence` | `result` | `id`, `cwd`, `payload`, `target`, `serial`, `holdForHost`, `auto`, `order`, `handOrdered`, `label`, `title`, `origin`, `groupId`, `createdAt` |

Everything cleared is an account of the run that just ended, or of a ladder verdict about to be
re-derived. Three of them are not cosmetic: a queued row still wearing `startedAt` renders as having
started, one still wearing `sessionId` offers a tap into somebody else's session, and one still
wearing `dismissedAt` is pending work `compact()` is already allowed to evict.

**`result` is KEPT**, which is the decision most likely to be "tidied" later. A re-queue is not a
claim that the run never happened — the row says *queued, and this is how it went last time* until
the next run overwrites it. That is already the posture on the other side: `adapters.ts`'
`intentToBacklogItem` reads `error` only on a row whose STATUS is failed, so a queued row's `result`
renders as history rather than as a red line. Clearing it would lose the failure at the exact moment
somebody decided to do something about it. The history entry (`IntentRequeue`) carries a COPY of it,
so after the next run the row says how it went this time and `requeues[last].result` is the only
account of the time before. Capped by COUNT at `REQUEUE_KEEP`, newest kept, nothing inside an entry
ever clipped — `cleanIntentRow` applies the same cap on the way in.

**The cap is on the WORDS, and the NUMBER is `requeueCount`.** `BacklogItem.requeued.n` read
`requeues.length` for its first version and was wrong from the sixth re-queue on: the list stops at
five because it carries sentences, so a row put back eleven times said *(5th time)* for ever, on a
chip a person reads as a warning. `revive()` bumps an uncapped `Intent.requeueCount` instead, and
`adapters.ts` reads that and **nothing else** — no fallback to the length, which would put the wrong
number back for exactly the rows that have been around longest. The one legitimate read of
`requeues.length` is the FLOOR `revive()` takes once for a row written before the field existed
(four entries and no count: four is a better first answer than one). `cleanIntentRow` refuses
anything but a positive integer, and absent means nobody counted — never zero, never a stale five.

**`origin` is never rewritten.** It is CLASSIFICATION — `scheduleIdFromOrigin` reads a rule's id back
out of it, and the fan-out markers are read the same way — so stamping "an assessment put this back"
there would re-file the row under a rule that does not exist. Provenance is `requeues[].by`, which is
the field that exists to say so, and the wire flattens the last entry onto `BacklogItem.requeued`.

**`requeue(id, opts?)`** is the old verb, for its one caller: `backlog.ts`'s re-fire button passes
`{allowDone: true, by: "run"}`. `allowDone` because "run it again" is meant about work that RAN —
without it a `done` row is refused, so the two sentences stay apart. `by` because the entry is the
row's only account of who put it back and what they meant by it, and **that is a fact only the call
site has**: `run` is *put back only as the first half of running it now* (this button, and `runNow`'s
failed branch, both of which fire the row in the same breath), `hand` is a tap on *put it back* that
leaves it waiting, `assess` is a proposal somebody approved. The default is `hand`.

**`requeueFailed(id, by, opts?)`** is the new one, and **only a `failed` row passes**. That is the safety
rather than a limitation: `AssessMutations.requeue` is read off the run's START snapshot, twenty
minutes old, so it means "the person approved putting these back" and never "these are failed right
now". The live state is re-asked here, which is what makes a LATE apply — or a re-queue queued
offline on a phone and delivered an hour later — safe to perform rather than something that has to
expire. Every refusal is a sentence, and `done` and `canceled` get their own rather than a shared
"it is already X", because the next move differs and a refusal that does not name it is a dead end
on a phone:

| state | refusal |
|---|---|
| gone | *that intent is gone* |
| `starting` / `running` | *it is already running* |
| `queued` / `blocked` | *it is already waiting its turn* |
| `done` | *it already ran — a done item is re-fired, not put back in the queue* |
| `canceled` | *it was called off — post it again if you still want it* |
| at `PENDING_MAX` | the same sentence `post()` refuses with |

**…and the state is only half the question. The other half is whether the revived row could get
anywhere**, which is asked BEFORE anything is written: `wouldNotRun()` runs `intentVerdict` over a
COPY of the row as the transition would leave it (`revivedShape()` — the same function `revive()`
applies, so the probe is never about a row nobody is about to write), with the facts a tick supplies.
Three outcomes are refused:

| shape | what would happen | refusal |
|---|---|---|
| a chain whose predecessor is gone, archived or recurring | `intentVerdict` fails it on the very next tick, with the sentence it is already wearing | *it would stop again straight away: &lt;the ladder's own detail&gt;* |
| a `{kind: "session"}` target whose session has closed | rung 5 answers `sessionGone`, and nothing in this store ever re-aims it | *it would wait for ever: …* |
| an archived row | `buildAssessInput` filters on STATE, so an unscoped run judges set-aside rows; rung 1 then holds them at *set aside* for ever | *it is set aside — bring it back first, …* |

The row is left `failed`, uncounted and unmutated, and nothing is announced. The failure that makes
this a rung rather than a nicety is the SENTENCE: Apply says "19 put back in the queue … they run
again when their turn comes", and before this it was untrue of several of them at the moment it was
printed — the phone showed a history entry, a list re-render and a second gravestone one tick later.

**The ordinary waits are NOT refused, and that list is the whole safety of the rule**: the budget, a
free slot, `serial`, `holdForHost`, quiet hours, auto-fire switched off, a live chain still running.
Every one of those is exactly what *when its turn comes* means, and a rung that read them as "it
would not run" would be a phone that will not put anything back while the desktop is busy.

`archived` is asked on the ROW rather than off the verdict, because rung 1 turns both it and
auto-fire-being-off into a `gate` wait and one of those two is a row that runs the moment a switch
flips. `knownDirs` is the one fact the pre-flight cannot go and get — it is async and this verb is
not — so the last listing a pass took is reused and a `repos` row is NOT judged when there has never
been one: absent means nobody said, never "none of those repos exist".

**The clock is dropped.** A failed `isTimedWorkRow` row carries `nextAt: null` and an instant in the
past, so putting it back as it was queues a row rung 3 will fail again on the next tick for the only
reason it can — that instant has passed. The person taps *still wanted* and watches it die of the
same sentence, which is this bug moved two seconds later. So `requeueFailed` sets `{kind: "idle"}`
and clears `nextAt`/`lastOccurrence`/`clearedOccurrence` — exactly what the phone's *drop the clock*
does through `update()`'s carve-out, and the same trade: it runs in its turn instead of at a time
that is gone. It is a change to what somebody asked for, so the row SAYS it (`clockDropped: true`)
rather than being quietly a different row afterwards. A trigger-KIND change also needs the BARE
`deps.onChange()` on top of the row's own, for `update()`'s reason: a row LEAVING a list is not
expressible as a changed row.

**Nothing is emitted.** `emit("requeued", …)` is the usage-limit channel — `main.ts` turns it into a
"Backlog paused" push about work the HOST parked. A person's tap is not that, and a notification
saying the backlog was paused because they asked for something to run is worse than silence. The tap
gets `onChange(row)` and `kick()` — **unless the caller passed `{kick: false}`, which is a
correctness option and not a tuning one.** A kick runs a pass synchronously as far as its first
`await`, so a caller with more to write has to be able to withhold it: `applyProposal` writes N
re-queues and then the approved ranks and calls `intents.kick()` ONCE at the end (`AssessIntents`
carries `kick` for exactly this), and `runNow` fires the row itself. Before that, applying nineteen
verdicts fired the FIRST revived row while the other eighteen revives and the whole rank loop had
still to happen: and the row went without the approved order.

**The chain.** `chainFacts()` supplies `settled` and `knownIntents` from one walk and they answer
differently about a revived row, which is what makes this safe mid-chain: it is dropped from
`settled` the moment it is not terminal, so a successor waiting on it waits for the NEW finish rather
than inheriting the old one; it stays in `knownIntents`, so that successor WAITS rather than failing
with "the row it was waiting for is gone"; and a successor that has **already** failed is not revived
by its predecessor coming back — nothing walks forward, and putting a chain back is a decision per
row.

**And `runNow` on a failed row now fires it.** That branch used to answer *it is already failed* while
`ActivitySheet` offered *run it now* on exactly those rows: the phone showed the verb, the host
refused it for being in the state the verb exists for. It goes through
`requeueFailed(id, {kind: "run"}, {kick: false})` first — so the whole transition happens, including
the history entry — and then falls through to `fire()`. `done` and `canceled` are refused exactly as
before.

**Not kicked, and `fire()` guards the claim.** The first version kicked and then fired the same row,
and the only thing between that and a double fire was the kicked pass happening to yield
(`await Promise.resolve()`) before its claim. In one ordering the pass gets further: a chain fail, or a
failed one-off SWEEP (`isTimedWorkRow` is false for `repos`, so its `nextAt: null` clock is not
dropped and rung 3 gravestones it) settles the row `failed` synchronously, and `runNow` then started
a row this store had just written down as over. So the tap does not invite the tick — the sentence
beside the spent-one-off carve-out, *nothing reaches it in between*, is true of both branches again —
and `fire()` opens with the claim every other caller already asks: **`inflight`, `starting` or
`running` ⇒ return without firing**. The persisted states cover a restart; the in-memory map covers
the window between that line and the executor's first `await`, where there is no persisted state
yet. What it costs to be wrong is a prompt typed twice into one session, or two agents in one
worktree.

**Which failure the tapper was looking at.** `failed` is a STATE, not an event, and both paths into
this verb can be applied minutes or hours after the thing they were decided about: a row can fail, be
put back by hand, run, and fail again on something else entirely, and the live-state re-ask says
*yes, failed* to that. Reviving it then starts the work over on the strength of a failure nobody has
read and quietly retires the one actually on the row. So the instant travels and is compared:
`intent.requeue` carries `failedAt` and `routes/work.ts` refuses a mismatch in words (*it has failed
again since you looked — open it and read the new failure…*); `buildAssessInput` stamps
`AssessItem.failedAt: i.settledAt` on every failed candidate and `applyProposal` SKIPS a mismatch,
uncounted and not a failure of the apply. Absent — an older client, an older document, a row with no
stamp — proceeds on the state alone, which is every optional field's posture on this wire: absence is
the fact not having been written, never a refusal.

`packages/host/test/requeue.test.mjs` pins the transition field by field, every refusal sentence
including the three pre-flight ones, the cap against the uncapped count, the three `by` values, the
absent event, the chain cases, `fire()`'s claim and both `failedAt` refusals;
`packages/host/test/assessapply.test.mjs` pins the one-kick-after-the-ranks ordering and the
apply-side skip. `scripts/e2e-assess.mjs` §10 runs the pair through the wire in one apply: a row
stranded behind a predecessor that does not exist, REFUSED with the sentence it would have died of,
beside a one-off whose instant went past, put back with its clock dropped. One verdict, two answers —
which is the whole rule, because *still wanted* moves a row only where the ladder would let it go
somewhere.

### Scheduling: the six ways it said one thing and did another

Every one of these was found from a single screenshot of the Schedules sheet — a row chipped **due
now** that had already failed, and another chipped **in 51m** that would never fire again. None of
them crashed anything, which is exactly why they lasted: a schedule that quietly does nothing looks
identical to one that is waiting.

1. **A terminal one-off stayed armed.** `settle()` set the state and left `nextAt` alone.
   `intentToSchedule` derives `enabled` from `nextAt !== null` and the sheet renders
   `inWords(nextAt)`, so a `once` that missed its grace window wore *due now* for a day — for a row
   the tick skips (`isTerminal`) and that `runNow` refused. `isSpentOnce` could not correct it: it
   keys on the null the row never got. Fixed where the fact changes: `settle()` nulls it for a
   non-recurring `at` row.
2. **Running one by hand consumed it.** `runNow` passes `spendOccurrence: false` and the button says
   *this does not use up the next scheduled run* — then the completion path settled the row terminal
   anyway, so the tick never looked at it again. The schedule was cancelled by the act of testing it.
   `fire()` now returns a hand-run one-off whose own instant is still ahead to `queued`.
3. **A one-off that arrived late was dead on arrival.** `post()`/`upsert()` armed from
   `createdAt - 1`, which sits AHEAD of `armFrom`'s grace floor, so `nextFireAt` answered null and
   the row failed immediately with *post it again*. That is precisely the offline case the send queue
   exists for: written at 20:58 for 21:00, delivered at 21:05. `armNew` arms a `once` from the floor
   (it runs late, and says so) and a recurring rule from now (*every Thursday 18:00* saved at 19:00
   means next Thursday, not thirty seconds ago).
4. **A spent one-off could not be re-fired.** The row still holds the words; the answer to "its time
   passed while the desktop slept" is not "retype it". `runNow` revives a terminal non-recurring `at`
   row in place — deliberately without a `kick()`, since the ladder's honest answer for a spent
   one-off is `fail` and this is the exception to it, and `fire()` claims the row synchronously.
5. **The work a schedule posted had nowhere to go.** The big one. A `backlog` schedule fires by
   ADDING a work item (`ORIGIN_SCHEDULE_WORK` → `main.ts`'s `workItem` executor), the item targets
   `{kind:"repo"}`, and `targetVerdict` asks `repoSession(cwd, adopt=false)` — which never adopts a
   hand-driven session and never spawned anything. Nothing else did either: `ensureRepoSession` had
   exactly one caller, the `backlog.openRepoSession` route, i.e. a tap. So auto-fire only ever worked
   in a repo where the user had once pressed that button and the host had not restarted since.
   Measured on the author's own store: **40 rows `blocked: sessionGone`**, 25 of them in one repo,
   the oldest three months old, including all five items posted by schedules that evening.

6. **A one-off was two rows, and the first could fail before the second existed.** Found a year
   later and in a different way — not on a screen, but by reading the live store (see **Recurrence
   decides the list** above). A `backlog` schedule fires by ADDING a work item, so one piece of
   one-off work had two rows and two accounts of itself; and when the parent missed its grace it
   failed at rung 3 with the child never made, leaving the words in a row that was in no repo's
   backlog at all. Seven rows on the author's desktop were in exactly that state. A one-off runs
   itself now; only a standing rule still mints a child.

The fix for (5) was `IntentDeps.openBacklogSession`, wired in `main.ts` and bounded by
`BACKLOG_SESSIONS_MAX` (`WATERPLANE_BACKLOG_SESSIONS`, default 3). Its shape carried the argument, and
every line of it survives the redesign that replaced it:

- **The rule was "not THAT session", never "wait for a person".** So the host opens a session of its
  own — then the repo's `backlog · <repo>` one, now one per ITEM — and the session you are driving by
  hand is still never typed into. `e2e-backlog-wait.mjs` pins that half by asserting the item ran in a
  session id that is NOT the hand-opened one.
- **It is reached only after the gate, the budget and the trigger have all said yes**, which is what
  keeps it from spawning a CLI for work nobody wants run yet.
- **Automatic work only.** A hand-posted item that is waiting has a person looking at it who can tap
  either button. A hand FIRE is the opposite case and does open one — refusing a tap with "no session
  open" when opening one is a thing this host does just teaches people to do it themselves.

**What replaced it, and what it got wrong.** `openBacklogSession` answered with a verdict rather than
an id, so its refusal string ("waiting for a free backlog session — …open this repo's backlog session
yourself") was a second ladder living in a side door, invisible from the row; and it opened at most
ONE repo's session per tick, because spawning was the most expensive thing the loop could do. Both
are gone: the cap is rung 4.6 (`noSlot`, below), and a fired row simply opens its own session in
`freshSession` — so there is no "one per pass" left to ration.

The other thing this section used to say was wrong, and it is worth keeping the sentence to say so:
*"Nothing here auto-closes a session: a backlog session that finishes its work stays open and idle,
which is what makes the next item cheap."* It is the opposite of cheap. Every turn re-sends the whole
conversation, so the session that stays open is the one that keeps charging for everything already in
it — see **Why every item gets its own conversation** under `backlog.ts`, and the linger and the reap
that now end one.

### `holdForHost` — rung 4.5, and the one that got away

`Intent.holdForHost` is the Schedule sheet's *wait until it's free*, as a field: hold this fire until
nothing anywhere on this host is `starting` or `running` (`IntentFacts.hostBusy`, which the manager
computes from the same occupied-rows list it already builds for `busyCwds`). It exists because
`serial` cannot cover the case it was reached for. `serial` is scoped to ONE worktree, so it stops
two fires piling into the same repo and says nothing at all about five schedules in five different
repos that are all due the instant the weekly window resets — the exact shape the sheet's chip is
offered for. Worse, a `repo`+`fresh` target never passes through rung 5's session check at all
(nothing has been created yet for the tick to see as busy), so each of those five reads the world as
idle and each opens a session. `holdForHost` is how a row opts out of being one of that pile.

It is checked AFTER `serial`, and that order is the specification: both can be true at once, and the
repo-scoped answer is the one that tells the reader something they could not already guess from the
host-wide one. It is also opt-in in both directions — absent, the host being busy elsewhere is none
of this row's business, exactly as it was before the rung existed — and `adapters.ts` sets it
together with `serial` from the one chip, never one without the other.

**Recorded mistake, because it cost a red tree.** While this rung was being written, rung 2 — the
budget — was widened from `i.auto` to *"budget-blocked and not already `failed` or `canceled`"*. That
reads like tidying and is not. The budget ceiling holds UNATTENDED work short of the usage wall; a
person spending what is left of the budget is the entire purpose of what is left of the budget, which
is what `Intent.auto`'s own comment and the doc block three lines above the rung both say. The
widening was additionally a no-op for the states it named, since terminal rows never reach the ladder
at all (the tick filters them first) — so every row it actually changed was a person's own, held for
a reason that was never about them. It broke `packages/shared/test/intent.test.mjs`, a test nobody
had touched, and the tree was handed over with `npm run test:unit` failing. The unit suite is ~90 ms
and needs no daemon: there is no version of "I was only editing the rung above it" that survives not
running it. The pin is now *a hand-posted row is not budget-held even when queued*, which asserts the
exemption in every state the ladder can see.

#### A row timed BEFORE a reset is lifted past that window's ceiling — `budgetPassOf`/`budgetHold`

**The incident.** Twelve auto backlog rows were timed *an hour before the weekly window resets*
(`{kind:"window", window:"weekly", edge:"before", offsetMin:-60, oneShot:true}`, grace 120, *wait
until free*): due 18:00 CEST, reset 19:00. `budget.json` had `weeklyMax` 75 and the week stood at
97%, so rung 2 held every one of them and none ran. The rule is right in general and wrong here: a
ceiling exists to save allowance for LATER in the window, and a row whose whole point is to spend what
is left before the reset has no later. Whatever it does not spend in that hour is gone at 19:00.

**The rule.** Rung 2 lifts for an `auto` row iff it is timed on a `window` rule, `before` edge
(absent = before, as `cleanRule`/`nextFireAt` read it), with a NEGATIVE lead; the tripped ceiling is
about the SAME window; that ceiling's `resetAt` is the reset the row was armed against (`nextAt −
offset`, within `RESET_MATCH_MS` inclusive); and `nextAt ≤ now <` the later of the two readings of
that reset. **The tolerance is five minutes because one minute was measured to be wrong**:
`usagelog.jsonl` shows `sr`/`wr` flipping by exactly 60 000 ms between consecutive scrapes (a relative
*resets in 1h 59m* read as now + that, truncated to the minute), `nextAt` is fixed from one reading
and the ceiling carries the latest, so `< 60 000` failed on alternate ticks and the lift flickered.
Five minutes cannot confuse two windows — the nearest other reset is hours or days away. Decided per tick from the row's own `nextAt` and the ceiling, no new clock. Recurring rules
get it per occurrence exactly like `oneShot` ones. NOT lifted: before its time (held, in a sentence
that says it will be lifted then — `budgetPassPendingText`); at or past the reset (a new window, a new
ceiling); the `after` edge (it fires into a window that has just emptied); `offsetMin` 0 (fires AT the
reset); the weekly cap for a before-SESSION row (`budgetOtherCapText` names the exemption it does not
cover — the weekly ceiling saves for the days after that session window resets); a reset that moved;
`facts.budgetOver` absent (nobody said which cap ⇒ hold as before); a `budget` TRIGGER (that person
asked to wait until under the ceiling); an `after` chain; and `pinned` makes no difference either way.
The real usage limit is untouched — this is the ceiling before the wall, never the wall.

**Why every ceiling, not the verdict.** `budgetVerdict` names only the FIRST ceiling over (session
before weekly), which is right for the sentence and wrong for the ladder: with both over, a
before-session row must be lifted from the session one and still held by the weekly one. So
`budgetCeilings` is the per-window list the verdict is the first line of, and the host hands it in
as `IntentDeps.budgetOver()` beside `budgetBlocked`.

**A weekly pass covers the session cap too** (2026-09-30). The first cut held a before-weekly row
on the session ceiling (`sessionMax` 95) — the same mistake one level down: that cap saves the last
slice of a 5-hour window for later, in a week that ends at the reset the row is spending up to.
Within `[from, until)` there is no later for it either. Lifted on the pass's own reading of the
weekly reset; if the weekly cap is tripped and its reset MOVED, nothing is lifted — the session
cap included. Before its time the session hold says it will be lifted, naming the weekly window.

**The child.** A recurring `backlog` rule's occurrence mints a child (`workItem` → `backlog.add` →
`backlogDraft`), which is `auto`, trigger `idle` and would be re-held by the very cap its parent was
exempt from. So `workItemInherits` stamps `Intent.budgetPass` (`{window, from, until}`) from the
parent's `lastOccurrence` — written before the executor, so it IS the occurrence being fired — and
`budgetPassOf` reads the stamp on a row with no clock. An `after` chain does not inherit it; a
fan-out target row never had one. Once rung 3 releases the row it may still wait on `serial`,
`holdForHost` or `noSlot`; if that outlives the reset, the NEW window's budget applies —
expected, and what the pass's `until` says.

**Arming one that is saved LATE** (`intents/clock.ts`'s `newBasis`). The incident rows were re-timed at
18:50 for *an hour before the 19:00 reset* — already past their instant. `armNew` armed every
non-`once` rule from `createdAt`, so `nextFireAt` answered null: the row sat *waiting for the first
usage reading* (false — the reading was there), its grace was never consulted, and once 19:00 passed
it armed NEXT week's reset. A silent skip of exactly the run it was written for. Every ONE-OFF —
`!ruleRecurs`: a `once`, or a `weekly`/`window` rule with `oneShot` — now arms from `0` everywhere a
never-spent row is armed (`post`, `upsert`, `update`'s re-clock and merge branches, the tick's
unread-window re-arm), and `armFrom`'s grace floor decides: inside the grace it arms THIS occurrence
and runs late; past it, this occurrence is never offered (so never recorded as missed either — the
rule finds its next one). **Decided 2026-09-24 for the weekly case too**: a `oneShot` WEEKLY rule
used to arm from now like every weekly rule, so *Thursday 18:00, once* (the send sheet's *just the
next one* chip) saved on Thursday at 19:00 with a 120-minute grace armed NEXT Thursday. A one-off
names one instant whatever its anchor, and the grace is the person's own "how late is still worth
starting" — so it now runs at once, late, like a `once`; saved past the grace it arms next Thursday.
A RECURRING rule still arms from now. `setArmed` (resume) still re-arms from now. Legacy migration (`migrateFile`) still arms from
`createdAt`: it runs once, on files nothing writes any more.
#### What a lift leaves behind after the reset — `leftoverOf` and the leftover ceiling

Both lifts end at the reset, and that was the leak. A row let past a week's
budget exists to spend allowance the reset would throw away; one that did not
get to START before the reset (serial, the slots) fell back to
the ordinary ceilings, and a week that has just reset reads 0%, so every
leftover started at once. A desktop with a dozen "an hour before the weekly
reset" rows spent the first hours of each new week on them.

`budgetLeftoverOf` names such a row: a WEEKLY `budgetPass` with `now >= until`
(read off the row, no stamp needed), or `Intent.leftoverOf`, which the tick
stamps as it drops an expired waiver that was granted against the weekly cap
(`BudgetWaiver.weekly`). Rung 2 holds it while `leftoverCeiling` is tripped:
the week's reading at or over `UsageBudget.leftoverMax` (default 20, `null` off).
Choices, each made deliberately:

- **Weekly only.** A session window refills in hours; the week does not.
- **A waiver counts** — a tap made against last week's cap was about last week.
  An old waiver with no `weekly` mark leaves nothing behind (absent ⇒ no hold).
- **A new waiver lifts it** — `waive()` counts the tripped leftover ceiling as a
  ceiling, so the person's newer answer wins; that waiver is then about THIS week.
- **The whole week's reading**, a person's own sends included: the number on the
  usage screen, measured, not an estimate of what the leftovers alone spent.
- **One global number** in `budget.json`, never per row.
- **Not an account pause**: `budgetCeilings`/`budgetVerdict` never include it,
  so nothing but a leftover reads as held. It FAILS OPEN like the rest, and
  past the reading's `weeklyResetAt` it is untripped on the clock.
- The stamp clears wherever a waiver is spent by a start (`fire.ts`, `watch.ts`);
  - `BudgetStore.set` keeps the stored `leftoverMax` when a set omits it: an older
  phone bundle's silence is not a reset to the default.
- **The other side of the reset too** (`budgetAfterResetOf`, R-automation-045):
  a row timed AT the weekly reset or within `AFTER_RESET_LEFTOVER_MS` (5 h, the
  new week's first session window) after it is held by the same ceiling once
  that reset has passed. Moving a pile of before-reset rows past the reset is
  the same burst into a 0% week, so it gets the same answer, worded as its own
  case (`budgetLeftoverText(…, afterReset)`). Only `window`/weekly rules — a
  `once` at a wall-clock time is not anchored to a reset and is not read as one;
  further than 5 h in, the row was timed for a moment of the week.


### `noSlot` — rung 4.6, the cap as a rung

Once every backlog item opens a session of its OWN (`{kind:"repo", fresh:true}`, which `cleanTarget`
now normalises every repo target to — the shared `backlog · <repo>` conversation is retired, for
`sessioncost.ts`'s numbers), `BACKLOG_SESSIONS_MAX` stops being a side-door refusal string inside
`openBacklogSession` and becomes a rung: `if (i.auto && needsSlot(i) && facts.autoSlotsFree <= 0)`.
Same meaning it always had — at most N `claude` processes opened by machinery at once — now said as a
wait the row wears, in the ladder, with a sentence from `intentReasonText` like every other reason.
`autoSlotsFree` is counted off the SESSIONS and never off a map of rows, which is the rule
`repoSession` already has: a session opened by the sheet's own button is a running agent and counts,
and a bookkeeping map would count the host's intentions rather than its processes. Only `auto` rows
are bounded (the gate's and the budget's exemption shape: a person's own tap spends a slot because
they decided to), `{kind:"session"}` rows open nothing so they are not the cap's business, and a
`repos` sweep keeps `FANOUT_CONCURRENCY` — one bound per kind of spawn, never two over one. The
sentence carries NO numbers: this module is handed `autoSlotsFree` and never the ceiling it was
subtracted from, so the host fills in *"runs 3 automatic sessions at a time and 3 are busy"* as
`blockDetail`, the arrangement `budgetDetail` already has, and shared never guesses a plausible
number nobody measured.

**The host half.** (The reap below was removed on 2026-10-14 — *Only a working session holds a
slot*.) `IntentDeps` lost `openBacklogSession` and gained three things: `autoSlotsFree()`
(= `BACKLOG_SESSIONS_MAX − backlog.autoSessionCount()`), `autoSlotsDetail()` (the numbers, the way
`budgetDetail` supplies the budget's) and `reapAutoSession()` (make room). The manager then does with
`base.autoSlotsFree` exactly what it does with `hostBusy` and `busyCwds` — **decrements it per fire
within one pass** — and that is the fact that matters: a fresh repo target passes rung 5
unconditionally, because nothing has been created yet for the tick to see busy, so five rows due in
five repos in one tick would each read the cap as untouched and each open a session. It is
decremented whether or not the ROW was bounded by the cap: rung 4.6 only holds `auto` rows, but the
session a person's tap opens is as real as any other and the automatic row behind it in the same pass
must see one fewer. `reapAutoSession` is asked **once per pass**, and the slot it frees is
deliberately not claimed by the pass that freed it — the executor re-reads `autoSlotsFree` on the next
tick, and a pass that closed three sessions to answer three blocked rows would spend the whole cap on
one sweep of the clock.

**That sentence was true of the row that asked and false of every row behind it.** The reap branch
did `base.autoSlotsFree += 1` and then `continue`d past the blocked row, so every LATER `go` row in
the same pass read the slot as free and took it. Reproduced with a cap of 1: A (order 0, repo 1)
blocks *"waiting for a free slot … — closing an idle one to make room"* while B (order 1, repo 2)
fires in the same pass; with three repos, when A's finished session is reaped for B's request it is C
that takes the slot, and B runs only once nothing is queued behind it. The user's order — which is
the whole of what makes a queue a queue — inverted for as long as there was due work, and
`e2e-backlog-slots.mjs` was green because it counted sessions and never asked what ORDER they ran in.
It asks now. The increment is gone: the next tick's fresh `autoSlotsFree()` hands the slot to the
first row in order, and the `— closing an idle one to make room` sentence stays, because what the
host did is still worth saying.

#### The whole ladder is re-asked after one microtask yield

`base` is built once per pass — `busyCwds`, `busySessions`, `hostBusy`, `autoSlotsFree`, the chain
facts. Before each `go` row's claim the loop does ONE `await Promise.resolve()`. It used to be the
smart pick's `pickHold` await (a real hold spawned `git`, a macrotask window `backlog.fire` →
`runNow` fit through, so the held row fired on a stale verdict and put two agents in one worktree);
the pick is gone (2026-10-16) but the yield is kept, because a kick runs the pass synchronously only
that far, so a synchronous batch of writes lands before any claim (~30 host tests pin that batching).
The re-read below is kept for the same reason. `fire()` still sets `starting` synchronously.

The re-read after the yield was widened from "is this row still there" to the facts as well: the
currently `starting`/`running` rows are folded back into `busyCwds` and `busySessions`, `hostBusy` is
re-checked, the cap is re-read as `min(base.autoSlotsFree, host's live free)`,
and `intentVerdict` is asked AGAIN.

**That cap line subtracted this pass's own fires twice, and the first version of this re-read is
where the second subtraction came from.** It read `min(base.autoSlotsFree, max(0, autoSlotsFree() −
slotsSpent))`, on the reasoning that `base.autoSlotsFree` is `initial − slotsSpent` so the live count
needs the same subtraction to be comparable. It does not: `autoSlotsFree()` is
`BACKLOG_SESSIONS_MAX − backlog.autoSessionCount()` and `autoSessionCount()` counts sessions that
ALREADY EXIST — a fired row's session exists synchronously, because `fire()` → `execute()` →
`freshSession()` → `openItemSession()` → `sessions.create()` all run before the executor's first
`await`. So the live count already holds every session this pass opened. Reproduced at cap 3 with an
empty host, three due rows in three repos (the re-ask runs for every `go` row, so this was every pass on the real host): `a` and `b`
fire, `c` reads `noSlot` with one slot genuinely free, and `reapAutoSession()` is asked — which
closes the oldest idle automatic session, a finished item somebody may still have been reading, well
inside its ten-minute linger, to make room that was already there. `c` then fired anyway on the next
tick. The PRE-await decrement stays; it is what makes the rows behind a fire in the same pass see one
fewer slot before the host has counted anything. The test could not see it either, because its
`autoSlotsFree` fake was a hand-set number rather than a count of the executor's own sessions — it
now counts them, and the cap-3/three-repo case is pinned both ways. Every one of those is **monotonic** — nothing is ever removed
from either set and `hostBusy` is never un-set — because those sets also carry this pass's own claims,
and a cwd that went quiet during the await is simply a row that runs on the next tick. A non-`go`
second verdict goes through the same `nonGo` handler the first one would have: one spelling, so the
two cannot drift. `packages/host/test/ladderpass.test.mjs` pins both halves with a sibling hand-fired during the yield and an executor that stays pending. `openFor`, `opened` and the one-repo-per-pass rule are gone with the side
door they served.

#### …and rung 5 had to be re-ordered for that sentence to be true

*A fresh repo target passes rung 5 unconditionally* was the claim, and the code only kept it while
the repo had no session at all: `if (!sid) { if (i.target.fresh) return go(); … }` read
`facts.repoSession` FIRST, so a repo that answered that lookup with a session dropped straight
through to `sessionBlocker` on it. Which repos answer it? Exactly the ones an item has already run
in — `resolveRepoSession` recognises an automatic session by the `backlog ·` PREFIX its title
carries, which is what `openItemSession` writes. So the second item in a repo, with the first item's
session still lingering its ten minutes, was gated on a conversation it was never going to use: idle,
it was handed that session's id to wear until `noteSession` corrected it; busy — somebody had walked
back to the desk and started typing in the output they went there to read — it was held under *the
session is working*. Nothing on screen connected the two.

The `fresh` test is now asked **before** the lookup, which is also what made `GONE_NO_BACKLOG`
deletable: *no backlog session open for this repo — open one with the “session” button* named a
shared conversation that no longer exists, and its sibling `GONE_HAND_DRIVEN` existed to tell that
case apart from *a session is open, but automatic work will not adopt it* — a distinction that was
only ever visible while automatic work had a repo session to adopt. One sentence is left, on a
non-`fresh` row `cleanTarget` cannot produce, kept so a row that reached the ladder some other way
wears words rather than crashing. `IntentFacts.repoAnySession` went with the branch that read it,
along with its `IntentDeps` entry and the per-repo `sessions.list().some(…)` the tick was running to
build it.

### The local-model gate — rung 4.55, `localModel`

Asked 2026-10-13 (R-intent-local-001), after 9dea53cd let a queued item open its session on a picked
backend and model. The owner's words: *"the model must be loaded and aligned with other agents that
use local ai — only one active coding session at a time for local ai as default but the user needs a
setting to change this."* Before it, an item on `claude-local` whose model was not loaded started
cold, and two local items could run at once on one GPU — each one slower than either alone, and an
Ollama that evicts one model to load the other turns both into minutes of reload.

**"Active" is a turn running** (`SessionInfo.turnActive`) plus every local row `starting`/`running`
(the spawn → first `UserPromptSubmit` window, and a chain between its turns). An idle local session
that is merely open holds nothing — the same reading R-automation-042 gave the automatic-session cap
— and a HAND session mid-turn counts too: it uses the same GPU.

**Locality is a backend fact, never an id string.** `BackendDescriptor.localRunner: "ollama"`
(`claude-local`) is local exactly when `ollamaUrl()` is loopback; any other backend is local for a
model its boot catalogue placed `where: "local"` (`backendModelWhere`, opencode's local providers).
Unknown is never local: the cap may only hold work KNOWN to compete for the machine.

**Who waits is the host's decision, not the rung's.** `localSlotReading` builds `IntentFacts.local =
{free, rows, busy}`: `rows` is the automatic rows (`auto`) and sweep targets (`origin ===
ORIGIN_FANOUT_TARGET`) on a local launch; sweep parents, fan-out follow-ups and shells are not gated
(each target is its own row). The pure rung (`intent/verdict.ts`, after `holdForHost`, before
`noSlot`) holds a row in `rows` when `free <= 0`, unless its target session is itself in `busy` — it
then waits on rung 5 as `sessionBusy`, the more precise sentence. Absent `local` ⇒ the rung is
skipped, exactly the old behaviour. The detail is the host's (`localSlotWaitText`: *"1 local session
is working (name); this desktop runs 1 at a time"*), substituted like `noSlot`'s, never a number the
shared module guessed.

**The ladder.** `local` is read once per pass and decremented per local fire (the `autoSlotsFree`
trick: a fresh repo target passes rung 5 unconditionally, so two local rows in two repos would each
read the cap as untouched). `localHold(row)` is asked after the sweep pool,
synchronously: a sentence blocks the row `localModel`, claims nothing and stamps `clearedOccurrence`.
After the pre-claim yield the reading is re-taken MONOTONICALLY (`min` of free,
union of busy) — the same reason the whole ladder is re-asked there.

**The model, loaded first** (`LocalModelGate`) — only for a backend with a `localRunner`, because
Ollama is the one runner this host can ask (`localrt.ts` `loadLocalModel`: `/api/generate` with no
prompt; 404 ⇒ `missing`, abort ⇒ `timeout`, fetch error ⇒ `unreachable`). The first ask starts ONE
background load per model and holds (*"loading qwen3 on Ollama"*); its end kicks the tick. Ready is
trusted `READY_FRESH_MS` (60 s), a failure `RETRY_MS` (30 s). Each failure is its own sentence —
Ollama unreachable at the URL, the model missing (with the `ollama pull`), or the timeout in seconds
(`WATERPLANE_LOCAL_LOAD_TIMEOUT_MS`, 180 s) — and **never a fallback model**: work picked for a model runs
on it or waits saying why.

**A person's start is told, never refused.** `runNow` never asks the ladder or `localHold` (a tap is
not a pick); the backlog executor appends `localStartNotice` to the row's *ran in …* detail, and a
wire `session.create` past the cap gets a toast (`localSlotOverText`). CLAUDE.md's *nothing applies
itself* has a mirror here: nothing refuses itself either.

**The setting.** Synced key `waterplane.local.maxSessions` (`LOCAL_SESSIONS_KEY`,
`localSessionsSetting`): 1..16 is the cap, `"0"` is no cap, anything else falls back to
`WATERPLANE_LOCAL_SESSIONS`, else 1. The phone's *local model sessions at once* row writes it;
*desktop default* deletes the key.

Pinned by `packages/shared/test/localslot.test.mjs` (the rung, the sentences, the setting parse) and
`packages/host/test/localslot.test.mjs` (locality, the reading, the gate's one-load-per-model and its
failure sentences, the swap guard, and the ladder over a real store: one of two due local items
starts, the other waits naming the local model and fires exactly once when the first ends).

### The four scheduling additions, and the facts the host had to supply

The anchor model did not change: `clock`|`window` + recurrence + lead + grace + `waitUntilFree` +
`guardWindow` is byte-for-byte what it was. Four things were added beside it, each one a field
that is ABSENT by default, and absent means the old behaviour exactly.

#### S1 `after` — a chain, and the four facts it reads

`{kind:"after", id, onlyIfOk?, graceMin?, title?}` is "when that one finishes, run this one". The
rule itself is `@waterplane/shared`'s; what the host owes it is four optional facts, and the interesting
part is that they are four rather than one. A chain asks four questions with four different wrong
answers — *has it finished?*, *is it still there at all?*, *does this chain bite its own tail?*,
*is it the KIND of row that ever finishes?* — and one map can only answer the first. Absence from
`settled` is all four of those at once, and they are opposite instructions: one means wait, the rest
mean fail loudly and say so.

- **`settled`** — how the finished rows finished, from the live rows PLUS the tail of
  `intents-archive.jsonl`. The archive half is not an optimisation: a chain has to survive its
  predecessor being compacted out of the live file, which is also why the trigger carries a `title`
  SNAPSHOT — the row must be able to say what it is waiting for after the thing it names is gone.
- **`knownIntents`** — every id this store can still see. It is the only thing that turns a dead
  predecessor into a failure instead of a row that waits for ever under a perfectly reasonable
  sentence, which is the exact shape of lost work this store exists to end. A row `remove()`d while
  it was still QUEUED is in the archive but deliberately not in here: it never finished and never
  will, so counting it would strand the chain behind it.
- **`chainWaits`** — id → the id it waits on, for every live `after` row. A cycle is invisible from
  inside a single row (each member reads the other as "not finished yet", for ever, and on screen
  that is indistinguishable from work that is simply next), so the edge list is what lets one row
  fail with a sentence instead of two rows waiting politely at each other.
- **`neverSettles`** — the rows that can never go terminal, which today is exactly the RECURRING
  schedules (`isRecurring`, the one reading of recurrence, in `intents/contract.ts`). `settled` is
  terminal-only by contract and a standing rule never terminates: it fires, records its occurrence
  and re-arms, for ever. So *after the nightly sweep* read `not settled` on every tick until the
  desktop was switched off, wearing *waits for “the nightly sweep” to finish* — the most reassuring
  sentence in the vocabulary, describing work that was never going to run. It is the same failure
  `knownIntents` catches one question earlier: that one asks whether the predecessor is THERE, this
  one asks whether it is the kind of thing that ends. The verdict is a `fail` naming the rule and
  saying what to do instead (*give it a time, or chain it to one run of that work*) — a schedule's
  individual occurrence posts a child work item, and that child is a real predecessor that finishes.

  The picker on the phone already declines to offer one (`sendIntent.ts`'s `chainCandidates`, using
  the same `ruleRecurs` so the two ends cannot disagree), and that is a courtesy rather than the
  guard: a rule can be edited from *once* to *every day* long after the chain behind it was made, at
  which point no filter that ran at pick time is in a position to help. **Every wait this store
  holds has to be a wait something can end**, and the one that could not was the only one with no
  sentence.

All four are supplied together, on every pass, or none of them is. They are optional on
`IntentFacts` and an absent one means "nobody said" ⇒ WAIT — so a manager that built `settled` and
skipped `knownIntents` would produce a store where every chain looks patient and none of them is.
`intents/disk.ts`'s `chainFacts()` is one walk of the rows that builds all four.

#### The grace is a window on being CLEARED to start, not on starting

This one was audited out of a live `/Users/me/dev/.waterplane/intents.json`, where it had already
eaten a real piece of somebody's work:

```
myrepo · "Add a script that does X and report back…"
  rule: once · right after the weekly window resets · waits until free · grace 120 min
  → state: failed
  → "missed — the desktop was not running when it was due (more than 120 min late)"
```

**The desktop was running the whole time.** The chain is four steps and every one of them is the
code doing what it was told:

1. the rule opts into `waitUntilFree` (`holdForHost`) — *hold until nothing else on this desktop is
   starting or running*;
2. rung 3 judges the occurrence due and inside its grace, and rungs 4–4.6 (`serial`, `hostBusy`,
   `noSlot`) hold the row;
3. **every tick re-runs rung 3 from scratch** — the ladder is a pure function of `(row, facts, now)`
   and remembers nothing — so the clock keeps advancing while the row is held;
4. the desktop stayed busy for over two hours, so rung 3 eventually judged the same occurrence
   missed and failed the row. It was killed for performing exactly the wait it was configured to
   perform, and then the sentence blamed the machine.

The trigger's own documentation said this was the design — *"The deadline is WALL CLOCK: time this
row spends held on a lower rung (a busy repo, a full desktop, a paused account) is spent out of
it"* — on both the `at` and the `after` arms. It was not a design; it was the bug, written down.

**The invariant now: a row's deadline may not be spent by the waits the row was told to perform.**
Once rung 3 has released an occurrence, rung 3 does not re-judge it.

*How it is carried.* `Intent.clearedOccurrence` — the `at` occurrence (or, for a chain, the
predecessor's settlement instant) that rung 3 let through. Every wait produced BELOW rung 3 carries
it out as `IntentVerdict.clearedOccurrence`; the manager stamps it on the row (`stampCleared`) and
clears it when the occurrence is spent, skipped, recorded missed, or the row fires.

It is a persisted stamp rather than a derivation, and both halves of that matter. **A pair, not a
flag**: the fact needed is *which* occurrence was released and that it was, and nothing else on the
row carries both — the nearest derivation, "`blockReason` is one of the rungs below 3", cannot tell
a hold below rung 3 from `gate`/`budget` ABOVE it (which never reached rung 3 and must still be able
to miss), and is anonymous about the occurrence, so last week's hold would exempt this week's. **And
persisted**, because the hold outlives the process: `npm run restart` is routine here, and an
in-memory stamp would re-arm the bug on the first tick after one.

*What still expires it.* `HELD_MAX_MS`, 24 h, and never shorter than the configured grace. "Held for
ever, silently" is not an improvement on "failed wrongly" — a permanently busy desktop, a `serial`
group with a wedged session can each hold a released row
indefinitely, and a row that waits a week without a word has disappeared just as completely. It is
an order of magnitude past the grace the send sheet offers (0–120 min) on purpose: it is a backstop
for work nobody is ever going to get to, not a second deadline competing with the first.

*And what it SAYS.* While held, the row says it is held (`intentReasonText`'s `hostBusy`/`serial`/
`noSlot` sentences) — never that it is late, and never anything about the desktop being
off, which in this branch is demonstrably false. When the ceiling does bite, `heldOutText` is a
DIFFERENT sentence from `missedText`, because it is a different fact and the reader can do a
different thing about it: *missed — it was due and cleared to start, then waited 24 h without ever
getting a free moment (the grace you set was 120 min)*. It names the grace so the reader can see
that the 120 minutes they configured is not what binned it, and — like `missedText` — it claims the
clock and nothing about the cause.

Pinned in `packages/shared/test/intent.test.mjs` (the ladder, both arms, the ceiling, the
per-occurrence stamp and the round trip through `cleanIntentRow`) and in
`packages/host/test/intentsched.test.mjs`, which walks the real manager through the real case with
`Date.now` under the test's control: a weekly `waitUntilFree` rule, a desktop busy for three hours
against a 120-minute grace, and the work still runs.

#### The archive tail is BOUNDED, and what the bound costs

`ARCHIVE_TAIL_BYTES` is **256 KB**, read as a byte tail (`readArchiveTail`) and cached against the
file's own size+mtime — the archive is append-only, so "unchanged" is exactly "nothing was compacted
since the last read", and the re-parse happens on the tick after a compaction rather than on every
tick for ever. Bytes rather than lines because bytes are what the read costs and a row's length is
the length of the prompt inside it. The first line of the slice is dropped unless the slice starts at
0: a byte offset lands mid-row.

**The trade, stated: a predecessor older than the tail reads as GONE, and the row FAILS.** It is
absent from `knownIntents`, so the verdict is *"the item this waited for is gone — nothing is going
to release it"* rather than a wait. That is intended, and the bound is chosen for it. 256 KB is
roughly 250–2,000 archived rows against a live file that keeps the newest `SETTLED_KEEP` (200)
settled rows before archiving anything at all, so a predecessor has to be several hundred FINISHED
rows old before it falls off the end — by which point the chain has sat through hundreds of other
pieces of work, and being told so is worth more than being told nothing. The alternative is an
ever-growing file read on the loop that also pumps every PTY, which is the cost `tokenstats.ts` had
to yield to the event loop to survive. Raising the number trades bytes per tick for how far back the
line falls; it does not change which side of it a row lands on.

#### S2 `hours` — quiet hours, and the grace floor that had to move with them

`ScheduleRule.hours` is a run window in minutes of day, half-open, wrapping midnight. `nextFireAt`
knows nothing about it on purpose — an anchor is a fact about when work becomes worth doing, quiet
hours are a policy over every anchor — so the verdict does two things with it: refuse to run outside
the window (*"outside its hours (22:00–07:00) — runs when they open"*), and **count the grace from
the moment the window OPENED, never from the anchor**.

The host half is `armFrom`'s floor, and it had to move or the feature could not work at all. The
floor is `now − grace`, and it is what makes a missed fire behave: an occurrence the host slept
through is still ahead of it and comes back due, one from last week is behind it and is never
considered. But a rule anchored at 03:00 behind a 07:00–22:00 window is due at 03:00 and may not run
until 07:00 — at 07:05 with two hours of grace the plain floor is 05:05, the 03:00 occurrence is
already behind it, and `nextFireAt` never returns it. Not late: **never offered**, every single day.

`graceFloor()` widens it, and only where it can matter. Open at the floor ⇒ nothing older can still
be live, so the floor is unchanged (the ordinary case for a daytime rule at a daytime moment). Shut
at the floor ⇒ every occurrence from the last close to the floor shares ONE next opening, so they are
live or dead together and `hoursOpenFrom` answers which; if live, the floor goes back a day, which is
the widest a shut stretch can be. The widening only makes a candidate VISIBLE — `intentVerdict` then
does the exact arithmetic on it and answers `go`, `wait`, or a recorded miss.

**And it does not re-derive a local time.** There is exactly one implementation of "what time is it
in this rule's zone" — `schedule.ts`'s `zoneMinuteOfDay`, behind the `inHours` / `hoursOpenFrom`
exports — and a second one in the host would disagree with the verdict across a DST edge, which is
the drift the zone is stored to prevent in the first place.

#### S3 `guardWindow`, and why neither clause needed a line in `adapters.ts`

`ScheduleRule.guardWindow` names the OTHER usage window for the headroom condition ("right after the
session window resets, but only if 30% of the week is left"). Both it and `hours` are clauses on the
RULE, and the rule is carried whole in both directions — in through `cleanRule(e.rule)`, out through
`intentToSchedule`'s `rule: i.trigger.rule`. There is no field list in the adapter for them to be
forgotten from, and that is the design rather than luck: an adapter that named each clause on the way
past is one that silently drops whichever was added most recently, and the symptom is a user whose
"not before 07:00" vanishes the first time they rename the schedule. `intentsched.test.mjs` pins the
round trip through `post()` — through `cleanIntentRow`, not just the two adapters — including the
row that carries neither clause and must come back with neither key.

#### S4 + F14 — the `workItem` executor was gating the wrong event

A schedule whose action is *add a backlog item* does not run a prompt: it creates a CHILD row, which
then does the waiting on its own clock. So the parent is where the ticks are set and the child is
where the work happens, and anything left behind on the parent gates the making of a row —
instantaneous, never busy, always allowed — while the work it was written for runs into whatever else
the desktop was doing. Nothing on a screen says so; the parent reports *queued* and is telling the
truth.

`workItemInherits()` (in `adapters.ts`, next to the draft it is read against) is that list, and it is
a seam rather than three lines inside the executor because it is the whole of F14:

- **the CHAIN travels whole.** Only `steps[0]` used to reach the child, so a scheduled three-step
  prompt quietly became a one-step one — the other two were on the parent row, in the store, in full,
  where nobody could watch them go missing. One item carrying N turns, never N items;
  `deliverChain` puts them on separate turns in the order given.
- **`holdForHost` travels**, because nothing else carried it. This is *wait until it's free* actually
  reaching the fire it was ticked for.
- **`resume` travels**, being a statement about which conversation the work runs in.
- **`serial` does not need to.** Every repo-target item is `serial` by construction
  (`backlogDraft`), so the parent's `serial` is satisfied before it is asked for — and a schedule
  aimed at a repo has no other shape of child.

`scripts/e2e-schedule.mjs` pins the chain end to end (three steps, delivered in order, each exactly
once); `intentsched.test.mjs` pins the inheritance and the loss it replaces.

**…and the child says WHICH rule wrote it.** The only link between a schedule and the rows it
produces was `ScheduleResult.childId` — the LAST item a rule wrote, and nothing before it. A nightly
rule that had run four times therefore showed *backlog · 1 item* on its card, and three rows in the
Backlog list said nothing at all about where they came from. `backlog.add` now takes an `origin`
(it is the one place a work item is minted, so it is the one place provenance can be attached) and
the `workItem` executor passes `scheduleItemOrigin(i.id)` — `schedule:<entry id>`, durable, already
on the wire through `intentToBacklogItem`. It is read back through `scheduleIdFromOrigin` and never a
bare `startsWith("schedule:")`, because that prefix already carries two RESERVED suffixes for the
RULE's own row (`schedule:work`, `schedule:sweep`) and a bare prefix test would read those as an
entry id called "work". Absent by design on every row written before this existed — a chip that is
not there is the honest answer, and guessing one from the label would be wrong on every item somebody
happened to name similarly.

**The last link was a missing field on the wire, and until it existed the send sheet had to apologise
for it.** `workItemInherits` carries a chain from a parent row to its child, but nothing could put a
chain on the parent in the first place: a scheduled send is the one path that goes through
`ScheduleAction`, whose `backlog` arm had `text` and nothing else, so `scheduleToIntent` could only
ever write `payload: { steps: [action.text] }`. `dispatchIntent`'s `at` arm therefore kept step 1 and
**said so in a toast** — deliberately, because discarding words somebody typed without telling them
is the one thing a send surface may never do, and deleting the sentence before the field existed
would have been the worse half of the fix. `ScheduleAction.backlog.steps?: string[]` closes it:
`cleanAction` carries it (bounded on the COUNT, never on the words, and `[text]` is stored as ABSENT
so a one-turn rule is byte-identical to every rule written before the field), `scheduleToIntent`
reads `action.steps ?? [action.text]`, and `intentToSchedule` reads it back OUT — without that half,
renaming a schedule would have silently shortened it to its first turn, which is the same drop one
round trip further on. A SWEEP keeps its own sentence: `fanout.ts` reads `steps[0]` and nothing else,
because a sweep is one question asked of N repos.

### `prompt.ts`

- `prompt.ts` — two-stage prompt detector: lenient scan of a stripped byte window produces a
  *candidate*, re-detected STRICTLY against `screenText()`. Needs a selection cursor or dialog
  footer, capped labels, indices 1..N with a bounded gap (`AskUserQuestion` wraps descriptions).
  Checkbox rows ⇒ `multi` (a digit toggles). Unparsable dialog ⇒ `awaitingInput`. **Both stages must
  survive a screen they can only half-read**, because every failure here is one silent nothing: the
  cheap gate matches the footer with its spaces REMOVED too (`hasDialogFooter` — a repaint erases a
  cell and steps over it rather than rewriting the space, so a byte window reads `Entertoselect`)
  and scans `PROMPT_GATE_BYTES`, several repaints wide, since the footer is not the last thing
  drawn; an option row tolerates any ONE-character marker before the index (only `❯` is *proof* of a
  cursor — a marker we don't recognise must cost us the cursor, not the whole box); and a label is
  cut before the preview pane the newer box draws to the RIGHT of the options, on the same rows.
  `e2e-prompt.mjs`. **Output never retires a prompt** — the TUI repaints its working line under
  a live box, and clearing on data + re-detecting only after 600 ms of quiet made the answer panel
  blink in and out about once a second (unreadable, untappable). Only the strict verifier clears it;
  the check is a debounce with a CEILING (`PROMPT_MAX_STALE_MS`) so a repaint storm delays it by a
  bounded amount instead of starving it, real input re-verifies within 250 ms, and a turn starting
  (`UserPromptSubmit`) or the PTY exiting clears it outright. And a strict parse that FAILS while a
  dialog footer is still on screen is a half-drawn repaint, not a box that left: the published box is
  kept for `PROMPT_MISS_MAX` such misses (each re-arming its own next check, since a box answered at
  the desk leaves a quiet screen) before degrading to `awaitingInput`. `e2e-promptlive.mjs`.
  **A box may be TALLER than the terminal**, so the strict pass no longer anchors on index 1: the
  visible run is published with the indices it has plus `truncated`, and only the lenient gate keeps
  the anchor (it has no footer or cursor to lean on, and prose numbered from 2 under a busy session's
  working line would otherwise read as a box). Not a gap but an OSCILLATOR — the approve panel takes
  its height from the terminal, so publishing null unmounted it, the terminal grew, the PTY resized,
  claude repainted a box that now fit, and the panel came back, about once a second. The cheap gate
  is the same rule: with a box published a gate miss falls through to the render (a frame wider than
  `PROMPT_GATE_BYTES` pushes the footer out of a window the box is plainly still on screen in) —
  only the strict verifier clears a prompt, which was always the stated rule and had one exit around
  it.
  **A repaint WE asked for is not evidence the box is gone** (`RESIZE_REPAINT_MS`, `lastResizeAt`).
  The oscillator above was described and half-cured: the panel takes its height from the terminal, so
  it was made to stop GROWING without limit. What was left is that it still changes the height ONCE,
  each way — and a resize is a SIGWINCH, and a SIGWINCH makes this TUI clear and repaint the whole
  screen. Every capture taken across that repaint is half-drawn *by construction*, and they were
  being counted against `PROMPT_MISS_MAX`: three of them at `PROMPT_CHECK_MS` retired a box that had
  never moved, the panel unmounted, the grid grew back, another SIGWINCH, the box parsed again, the
  panel returned — measured from a phone at about 2 Hz, which is a live question nobody can answer.
  Every part of it was individually correct. So the miss budget, which exists for a screen we
  happened to catch mid-repaint, is not spent on one we KNOW is mid-repaint because we asked for it;
  `dialogStillUp` still gates it, so a box genuinely closed during a resize is retired on that same
  pass with no budget at all. Pinned in `packages/host/test/prompt.test.mjs` from the phone's own
  wrapped-footer screen, which parses cleanly at both widths — the screen was never the problem.
  The web half is the other bound: `.approve-opts` is height-capped on BOTH branches now (only the
  `rich` column had it, and the reported box was a six-option chip grid), and Submit/Esc moved OUT of
  that scroller — capping a list with the commit button inside it puts the only control that answers
  a multi-select below the fold.

  **A geometry too small to draw a composer in is not a viewport** (`shared/ptysize.ts`,
  `sessions.resize`/`create`, web `Terminal.report`). Both ends used to accept any size above two
  rows, which is how a session ran three rows tall for forty minutes. Nothing failed loudly: the
  phone's terminal container was laid out with (almost) no height — a sheet over it, the reader view,
  a WebView mid-layout — `FitAddon` divided that container by the cell size exactly as it is supposed
  to, and reported `54x3`. As arithmetic it is right; as a viewport it is nothing. The consequence is
  not cosmetic, because the claude TUI cannot draw its composer box in three rows: text typed into
  that session appears NOWHERE on the rendered screen, and the rendered screen is the only thing
  `deliver.ts` has to confirm a delivery with. So every send answered `unconfirmed`, every `absent`
  verdict correctly authorised a re-send that also could not be read back, and the composer stacked
  five copies of one prompt that nobody could see — twenty-eight consecutive `deliver.echo` misses
  filed against a heuristic that was working perfectly. A layout bug wearing a delivery bug's
  clothes, and it presented to the user as "sending from the app is broken".
  Two guards, because the two ends have different jobs. The CLIENT does not REPORT a fit it measured
  on a collapsed container (`drawableViewport`), and deliberately does not update its
  last-reported geometry when it withholds one, so the report that follows the collapse is not
  skipped as a no-change; withholding costs nothing, since the layout change that ends the collapse
  fires another fit and `session.attach` re-states the geometry on reconnect. The HOST clamps rather
  than refuses (`ptySize`), on `resize` AND on `create` — a client reporting a small grid still has a
  session open, and a PTY bigger than the viewport is a scrolled view, which is survivable, while one
  too small to read back is not. The floor is 12 rows and 20 cols: under any real phone in portrait
  (≈24-40 rows), so it can only ever catch a measurement nobody was looking at. Clamping on `resize`
  is also what HEALS a session already stuck at three rows — the next report differs from the stored
  size, so it is applied rather than skipped. `packages/shared/test/ptysize.test.mjs`.

  **A box that has scrolled UP is a box that was answered** (`isComposerRow`, `dialogStillUp`). The
  detector scans upward and had no bottom anchor at all, which was sound while the reasoning was
  "an alt screen is repainted, so what is on it is what is up". This CLI does not use an alt screen:
  it scrolls, and the strict pass reads the last 60 rendered LINES — so a box answered thirty
  seconds ago is still in that window, still carries its `❯` and its footer, and was re-detected on
  every check until the conversation pushed it out. Reported from the phone as *"these dialogues are
  stale and block sight to the consoles"*, and it is three faults at once: an approve bar for a
  question nobody is being asked, eating the terminal's height in front of a live console; an
  `awaitingInput` interlock that makes an idle session "waiting" and holds everything queued for it;
  and `PROMPT_MISS_MAX` never running out, because the miss counter only counts parses that FAIL.
  Ground truth, three captures off the real binary (workspace-trust, a Bash permission box, the
  resume-from-summary box): **while a dialog is open the CLI draws no composer** — the footer is the
  last non-blank row — and the composer comes back under the box once it is answered. So the rule is
  "is a composer drawn below this box", asked of something structural: its full-width rules, its
  `❯` input row (a row that is not a numbered option), its mode line. A row COUNT was tried first
  and could not separate a real composer from a shell stub echoing one prompt per Return, which is a
  live box in every e2e that drives one. The failure direction is deliberate: a composer we no
  longer recognise reads as "no composer", i.e. the box lingers exactly as it did before, where the
  opposite mistake would retire a LIVE box and take the approve bar with it. Strict pass only — the
  lenient gate reads a byte window whose bottom is wherever a repaint stopped.
  `packages/host/test/prompt.test.mjs`.
  **A checkbox box is SUBMITTED on its own row**, so an answer of `\r` is not a keystroke to write
  wherever the cursor is: Return on option 1 — where the cursor starts, and a digit does not move it
  — toggles that option, undoing the user's own pick and leaving the box open. `navToSubmit()`
  measures the gap to the unnumbered `Submit` row in SELECTABLE ROWS (an option's wrapped
  description is a screen line the arrows step over, not a row), and `sessions.submitPromptBox()`
  walks it there against the RENDERED screen, re-reading between moves — pressing Down N times
  open-loop would encode a guess about whether a digit moves the cursor and whether the list wraps,
  while a loop that re-measures converges on an overshoot. No Submit row or no cursor on screen ⇒
  the bare Return, i.e. what it did before. `e2e-checkbox.mjs`.

  **…and the commit row's marker slot is the CURSOR GLYPH only**, unlike `OPTION_RE`'s deliberately
  permissive one. There a loose slot is a defence: an unrecognised marker used to cost the whole
  option row. Here it is the opposite — the row is two common words, so `- Next` or `# Next` in the
  agent's own prose inside `NAV_WINDOW` reads as a commit row. "Newest box wins" hides that while
  the real row is on screen; restricting the slot means the bullet cannot be the target when the
  real row has scrolled off either. An unrecognised cursor glyph costs the walk, which falls back
  to the bare Return it always did.

  **…and that row does not always say "Submit".** Read off the installed binary (claude 2.1.267),
  the multi-select list is handed `submitButtonText: <on the last question> ? "Submit" : "Next"` —
  an `AskUserQuestion` carrying SEVERAL questions draws "Next" on every question but the last.
  `SUBMIT_ROW_RE` matched the one word, so on exactly those boxes `navToSubmit` found no commit row
  at all, returned null, and every Submit from the phone fell back to the bare Return that toggles
  whatever the cursor is sitting on. That is the health board's *Placing the cursor on a multi-select
  Submit row* going red: 1 good / 5 missed all-time, with the captured sample showing the word
  "Next" where the rule was looking for "Submit". Both words are matched now and the one that was
  DRAWN travels (`SubmitNav.label` → `DetectedPrompt.submitLabel` → the phone's button), because
  Return on "Next" moves to the following question rather than answering, and a button reading
  Submit over that row is a claim about what a tap does. Absent (row or cursor scrolled off) reads
  as "Submit", which is what it always said. The commit row is still anchored at BOTH ends with a
  one-character marker slot, so a numbered option labelled "Next" (`1. Next`) cannot fill it.

  **One box stays ONE box while the TUI repaints under it** (`sameBox`, `mergeBox`). The strict pass
  runs about twice a second while a dialog is up and reads whatever is legible AT THAT MOMENT — and
  this CLI scrolls, so panning the console, a repaint the phone's own answer card provoked, and a
  box taller than the terminal all change that. Each change re-published a different
  `DetectedPrompt` for a question nobody had touched, and a re-publish is not cosmetic: the phone's
  card is keyed on `promptFingerprint`, so collapsing it or hiding it — the two ways to answer at
  the DESK instead — was undone on the next repaint; an answer already queued against the old
  fingerprint goes `stale`; and `applyPrompt` fires a push per change. Reported as "the console
  refreshes itself sometimes and that seems to trigger a redraw of the questions dialogue… super
  annoying if I want to answer by the CLI only".

  The identity question is answered by the CLI where it can be. `askId` (`askbox.ts`) is the pending
  call's own id plus the question index inside it: minted upstream, in the log before anybody
  answers, and untouched by any repaint. Two `AskUserQuestion` boxes in a row have different ones,
  so nothing has to be guessed and the merge is provably safe.

  Everything else — a tool approval, a trust dialog — carries no such call, and there identity is
  structural: kind, shape (`multi`/`nav`), and the option rows at the indices the two passes SHARE,
  with labels compared by prefix in either direction. There the QUESTION is compared strictly too,
  because without an id nothing else stands between "this box again" and "the next box, whose
  buttons mean something else", and a wrong question over live buttons is the one mistake this must
  not make. Those boxes are a few rows tall and do not truncate, so the strictness costs them
  nothing. It is not a rule that could be relaxed on a hunch: driven against a shell stub,
  `detectPrompt` published ONE box's question three ways inside four seconds — `Do you want to
  proceed?`, then `1. Yes 2. No bash-3.2$ for i in 1 2 3 …`, then a third — because the question is
  up to four lines joined from above option 1 and on a scrolling screen those lines are whatever is
  there. `e2e-promptlive.mjs` therefore pins the OPTIONS across a repaint stream and says why it
  does not pin the question.

  Three things a review of the first cut found, all of them the same failure — one box mistaken for
  another — and all of them now pinned in `packages/host/test/prompt.test.mjs`:

  **A matching `askId` is not enough; the ROWS still have to agree.** The id says which question the
  LOG holds, not that the screen is still drawing it, and it is minted by a matcher working on a
  handful of labels. Two questions of one ask that share "Yes" and "No" got the same id, so after a
  Tab to question 2 the card stood unchanged over question 2's buttons — index 3 reading `Not sure`
  while a `3` keystroke picked `Later`.

  **Agreeing on the TUI's own rows is agreeing on nothing.** `Other`, `Chat about this` and
  `Type something` are drawn under every question the TUI draws, numbered like options. A new box
  taller than the terminal can present nothing but those, and two generic rows matching the previous
  box's two generic rows glued the dead box's question AND its labels onto the live one, with
  `truncated` cleared, for as long as nobody panned. So at least one agreeing index must be a row of
  the box's OWN (`GENERIC_ROW_RE`).

  **`kind` is derived, so it must not outrank an id.** It comes from the question plus the labels,
  and a truncated pass has no question — an ask whose words contain "proceed"/"plan"/"approve"
  therefore flips `tool`→`select` on every pan, and `kind` is IN the fingerprint. Tested after the
  id now: where the CLI has named the box, its own id beats a reading of words that are not on
  screen. Unnamed, `kind` still decides — a "2" at a trust dialog and a "2" at a tool approval are
  different acts.

  **And a published label is never rewritten, in either direction.** "The screen cut this one, so
  the longer read is the truer one" fails twice: the labels ARE the fingerprint, so growing one
  restarts the card and makes a queued answer stale — the thing the merge exists to stop — and a
  garbled longer read (a panel border the side-panel cut missed) would then win permanently, since
  the correct shorter read could never take it back. What makes a cut label readable is `desc`/`ask`,
  which carry the CLI's own words.

  **`samePrompt`, not `JSON.stringify`.** `applyPrompt` decided "changed" on the serialised bytes,
  which also compare KEY ORDER — and the merge builds its object in its own order. The pass after
  every merge therefore bought a broadcast, a push and an oracle call (a plugin event now) for a card that had not moved.

  `mergeBox` is the other half: the published box wins every field it has and a fresh parse may only
  ADD — an index nobody had seen yet, a real question where the placeholder stood, a longer reading
  of a label the screen had cut. Nothing is invented; every option in the result was read off this
  screen, for this box, while it was up. A label only ever GROWS, because a narrow repaint must not
  rewrite a label a queued answer named. The result is byte-identical pass after pass, which is what
  makes the card stop moving. `askId` is the exception to "published wins" — it takes the freshest
  reading, since a pass that could not reach the log says nothing rather than something older.

### `screenlog.ts` — the desktop's scrollback, RECORDED because it cannot be read back

- The phone keeps a reconstruction of what it displayed (`web/screenlog.ts`) and the report is what
  that costs: *"it looks like a copy-paste result of random moments that duplicate lines and misses
  some as well… I suspect this could be done better if the scrollback recording is reliably done in
  the server."* Right on both counts, and the second half is the interesting one.

  **The obvious server implementation does not work, and no amount of buffer fixes it.** The daemon
  already keeps every PTY byte and has one headless VT (`render.ts`), so "replay the ring when
  somebody asks" is the first thing to try. It was, and it answers with ONE SCREEN. Measured on
  claude 2.1.267, on every live pane of this desktop:

      history_size=0   alternate_on=1

  The CLI draws in the ALTERNATE screen buffer, which by definition keeps no scrollback: a line
  that leaves the top of the grid is overwritten, not pushed anywhere. A session running for hours
  replayed to **31 lines** — and tmux, the substrate here, has nothing either, because
  `capture-pane -S -` reads the pane's history, which belongs to the NORMAL buffer the CLI is not
  using. (`tmuxscroll.ts` had already measured `alt=1 history_size=0` for its own reasons; the
  scrollback question is the same fact asked a second way. A `capturePane` helper was written and
  then deleted, because it returns the same 31 rows.) Shipping that replay as the phone's preferred
  source made the feature WORSE than the thing it replaced: a sheet with one screen in it and
  nothing to scroll, over an archive the phone had been keeping for an hour.

  So a line that scrolled away was only ever visible while it was on the grid, and the only way to
  have it later is to write it down THEN. `screenlog.ts` is that: one live headless VT per session,
  fed the PTY chunks as they arrive, its grid read on a debounce and diffed against the previous one
  with `@waterplane/shared`'s `absorbScreen` — the SAME pure rule the phone uses, which is why it lives in
  `shared`.

  **What changes is the vantage point, not the rule, and that is the whole improvement.** The phone
  only sees a session while it is on screen and the app is awake; everything painted while it was
  closed, backgrounded, or looking at another session never passed through it. Those gaps are also
  what produces the *duplicates*: a jump too large to anchor reads as a full repaint, so the outgoing
  screen is archived WHOLE — correct, since dropping it would lose content — and the same block
  lands twice on the way back. Fewer gaps, fewer unanchorable jumps, fewer duplicates. The daemon
  has no gaps at all: it is the process the bytes arrive at, watching every session, always.

  Cost is one incremental VT per session, which is less than this file already spends elsewhere:
  `checkPrompt` buys a FULL replay of the ring about twice a second while a box is up, and this
  parses each byte once as it arrives. The grid is read on a settle (400 ms) with a ceiling
  (1200 ms) — `armPromptCheck`'s rule, and for its failure: a TUI that repaints continuously never
  goes quiet, and a pure debounce would then never sample the stretch where the most content is
  scrolling past. The VT is given NO scrollback of its own (there would be nothing in it) and the
  archive is capped at `SCREENLOG_MAX_LINES`.

  **`history` is the honest half of the answer** (`GET /api/scrollback`). False means nothing beyond
  the current grid has been recorded — a session that just started, or one the daemon only began
  watching at its last restart — and the phone must then keep its own archive rather than throw it
  away for one screen. That is not hypothetical: it is precisely the bug above, and the client rule
  is now "the host's copy wins only when it is actually more" (`history || longer`). `bounded` says
  the record has already dropped its own oldest lines. The VT is disposed when the PTY exits but the
  archive is not — the scrollback of a session that just closed is still readable.
  `scripts/e2e-screenrec.mjs` drives 60 lines through a 14-row grid and asserts all 60 come back,
  once each, in order.

### `agents.ts` — the work the turn flag does not cover

The reader's status strip had one job: with no terminal in the view, say whether the agent is
working or waiting. It got it wrong in exactly one state, and that state is now common.

The screenshot that started it: the terminal says

```
2 background agents launched (↓ to manage)
├ Fable review: correctness
└ Fable review: design and API
✳ Waiting for 2 background agents to finish
  auto mode on (shift+tab to cycle) · ⏵⏵ 2 agents
  ○ general-purpose  Reading r… 59s · ↓ 73.4k tokens
  ○ general-purpose  Reading r… 40s · ↓ 78.1k tokens
```

and the reader, two taps away, says **"idle — nothing running"**.

Nothing there is a bug in the turn heuristics. A background agent is launched BY a turn and outlives
it: the main loop's `Stop` hook fires, the composer comes back (you can type — the person in that
screenshot had), and `turnActive` goes false because the main loop's turn really did end.
`markIdle` then marks the session `idle`, the push says "Turn finished", the launcher row says
`done`. Every one of those is the answer to "what is the MAIN LOOP doing", and every one of them is
the wrong answer to "is anything happening here", which is what a person reads them as.

The old rungs cannot be stretched to cover it. `turnActive` is the hook pipe's own fact and must
stay exactly that — widening it to mean "or an agent is running" would make `Stop` stop being a
turn boundary, and half this daemon (backlog readiness, auto-fire, `laneBusy`, the settle paths)
is built on that boundary being sharp. So this is a SEPARATE fact, published beside it.

**Read off the logs, not off the screen.** The TUI does show it, and scraping was the obvious move —
but what the footer carries is a COUNT and a hint (`⏵⏵ 2 agents`), the descriptions only exist
inside a panel you have to press `↓` to open, and the whole line is one repaint from being gone.
The CLI meanwhile writes all of it to disk:

```
<project>/<conversation>/subagents/agent-<id>.jsonl       the agent's own transcript
<project>/<conversation>/subagents/agent-<id>.meta.json   {agentType, description, model}
<project>/<conversation>.jsonl                            the parent — where the END lands
```

so a `readdir` plus a `stat` per agent answers "which agents exist and when did each last write",
the meta file answers "what was it asked to do" (`description` — "Fable review: design and API", the
same string the CLI prints in its own tree), and the parent answers "has it finished".

**The end is an exact signal, not a guess.** When a background agent stops, the parent log gets a
record carrying

```
<task-notification><task-id>a141a1e425712cd1b</task-id><status>completed</status>
```

which is the CLI telling itself. `notifiedAt()` collects those by id, and an agent is retired when
its last notification is NEWER than its last write. Not a boolean: the CLI's own note in that
payload says a task-notification "fires each time this agent stops", and `SendMessage` resumes one —
so "was it ever retired" would kill a resumed agent off for good, while "did it write after it was
last retired" survives the resume.

Freshness is only the BACKSTOP, for the shapes that never emit a notification: a foreground `Task`
call (which runs inside a turn that is already busy, so nothing is lost), a CLI that was killed, a
daemon that restarted while agents were mid-flight. `WATERPLANE_AGENT_STALE_MS` is deliberately generous
(10 minutes): an agent sitting in a ten-minute `npm test` writes nothing at all, and calling THAT
finished is the exact lie this module exists to stop telling. The cost of generosity is bounded on
the other side, because the notification retires a real ending within seconds.

**What it is allowed to be wrong about.** Nothing, in the direction that matters: a missing meta file
costs the description and never the row, an unparseable agent log costs the `doing` line and never
the agent, a missing directory answers an EMPTY LIST, and no conversation id answers the same.
Absent, never a count nobody can see.

**Polled, because there is no event.** No hook fires for an agent, and the parent's log is not
written while a background agent runs — the parent is asleep waiting for it. `checkAgents()` polls
at `WATERPLANE_AGENT_POLL_MS` (5 s), and the timer is armed ONLY while agents are running, so a desktop
holding a hundred quiet sessions pays nothing. It is called on both turn edges (`markIdle` for the
end — which is the transition that used to publish "idle" — and `setTurn(true)` for a foreground
Task call), and on ATTACH, because opening a session is the moment its list has to be right and the
poll is not running for a session nobody was watching.

**Broadcasts are on a CHANGE, not on a tick.** `SessionInfo` goes to every attached client, and a
5-second poll over a hundred sessions could trivially become a hundred broadcasts every five
seconds. Elapsed is counted on the PHONE off `startedAt`, so a clock ticking costs nothing;
`agentsChanged()` compares the set, the descriptions and the `doing` line, and a poll that moved only
a timestamp emits nothing.

**Where it surfaces.** The reader's strip gains a rung between "waiting on you" and "idle"
(`N agents running · 3m`), with one row per agent under it — the count is not the progress, and "what
is it doing" is the whole reason the view exists. `sessionStatus()` puts an idle session with agents
in `coding` rather than `done`, so the launcher row, the per-repo roll-up and the status filter all
agree (they read one ladder for exactly this reason). And the turn-finished push says
"Turn finished · 2 agents still running" rather than three words that claim the work is over.

**What it deliberately does NOT do.** It is a signal, not an interlock — the same line `question.ts`
draws. `laneBusy`, `sessionWall`, auto-fire and the backlog are untouched: the CLI takes typing
while it waits for its agents, queueing behind them is a legitimate thing to want, and a heuristic
over somebody else's log files is not something to let block a send.

**Background shells, and the footer count that is not ours** (2026-09-27, CLI 2.1.283). A
`run_in_background` Bash or a Monitor outlives its turn exactly like a background agent, the footer
reads `· 2 shells`, and the reader said *done* under it. No log records a shell, but the CLI's own
per-process record does: `~/.claude/sessions/<pid>.json` carries `status` — `busy`, `idle`, or
`shell` (idle main loop, shells still running) — plus the `sessionId` and the `tmux` target the
process runs in. `readCliStatus` matches OUR record by that tmux target (`waterplane_<id>:`), which is
exact; the conversation id is the fallback only when exactly one LIVE pid claims it, because a
`--resume` of a conversation open elsewhere gives two records one id. No match ⇒ null, never a
neighbour's status. It publishes `SessionInfo.shells` (a boolean — the record holds no count), and
`checkAgents` keeps polling while shells run AND while the record still says `busy` after our turn
flag dropped, since the Stop hook can land before the CLI rewrites `busy` → `shell`.
The same CLI version added `← N agents` to the footer. **That is NOT this session's subagents**: it
is the machine-wide count of other busy Claude sessions (every pane shows the same N, and it equals
the `busy` records in `~/.claude/sessions/`). Never read it as a subagent count.

### The `Stop` hook is a question, not a verdict — and some work announces nothing

The other half of the same screenshot, found on the live desktop the same way: a session spinning

```
✻ Crafting… (9m 35s · ↓ 34.5k tokens)
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents
```

with the reader two taps away saying **"idle — nothing running"**, and — the expensive part — a
queued prompt typed into it, retried four times, and reported to the phone as
*"1 message not delivered — nothing ran"*.

**`Stop` is the CLI ASKING whether the turn may end.** A hook that answers `decision: block` sends
the reason back in and the CLI carries straight on. That is how every keep-going loop is built (a
`/goal` hook, a checklist driver, anything that feeds the next step in), and it is invisible from
here in the one way that matters: **no `UserPromptSubmit` follows**, because no prompt was
submitted. The continuation lands in the conversation as a meta message —
`"Stop hook feedback: …"` — and nothing on the wire says a turn is running again. So the exact
signal fires, this host believes it, and every consumer of "the turn ended" acts on a turn that has
nine more minutes to run: `turnActive` false, `markIdle`'s turn-finished push, `turnEnded` to the
intent store, `autoFireBlocker` waving the queue through into a live turn.

**So a Stop is held against the screen before it is believed** (`armTurnWatch` /
`checkTurnWatch` / `settleStop`, `WATERPLANE_STOP_VERIFY_MS`, default 1.2 s). The only thing allowed to
contradict it is the CLI's own working line printed AFTER it — `shared/working.ts`, which is the
same matcher the phone's reader scrapes its status strip from and was moved into `shared` for
exactly this: two spinner matchers would be two opinions about whether a session is working, and the
interlock that keeps a queued prompt out of a live turn hangs off the answer.

Three things make it cheap and make it safe to be wrong:

- **Each pass looks only at what was printed since the last one** (`seq` deltas, capped at 64 KB).
  A working CLI repaints its spinner several times a second, so an empty window IS a session sitting
  at its composer. No VT replay, no render — a regex over one repaint.
- **The hold is re-earned every pass, never granted once.** A continuation that ends without a
  second `Stop` (the turn killed, the spinner simply stopping) falls out of the hold at the next
  window. Otherwise this rescue would trade a session wrongly idle for a session wrongly busy
  for ever, which is the worse of the two: an idle lie is visible, a busy lie stalls the queue in
  silence.
- **Everything else settles the Stop**, immediately and by default, including `WATERPLANE_STOP_VERIFY_MS=0`
  and a session with no PTY left to look at.

`settleStop` is the single end-of-turn path (flag, `stopCount`, capture seal, push, `turnEnded`),
idempotent and gated on a pending Stop, because three things call it for the same one: the settle
pass, a `UserPromptSubmit` that overtakes it (a person typed — the old turn is over, in that order),
and a `SessionStart`/`SessionEnd`.

**The same watch answers the other half of the same complaint, which arrived an hour later:**

```
❯ /compact
· Compacting conversation… (35s)  ▬▬▬▬▬▬▬  32%
```

with the strip above it, again, saying "idle — nothing running". `/compact` fires **no hook at
all** — no `UserPromptSubmit` (nothing was submitted), no `Stop` (no turn ended) — and grinds for
minutes. There is no pipe to have lost: the screen is the only witness there is. So the watch is
armed on OUTPUT too (`scheduleChecks`, only on a hooked session with no turn in flight, only when a
pass is not already pending), and a working line where no turn is believed publishes one —
`setTurn(s, true, { fromScreen: true })`. It retires the moment the line stops printing, and it
retires **quietly**: no `stopCount` (the backlog completes items on a real Stop), no turn-finished
push, no `turnEnded`. Nothing finished a turn, because nothing announced one.

That provenance is load-bearing in one more place. `deliver.ts`'s submit proof asks a narrower
question than "is this session working" — *did THIS keystroke start a turn* — and a spinner the host
inferred is no evidence about a Return: a `/compact` that began before the delivery paints the same
line. So the proof reads `sessions.turnFromHook()`, hook-announced turns only, on both sides of its
`alreadyWorking` test. The Esc-sweep interlock (`midTurn`) deliberately keeps reading plain
`turnActive`: an Esc into a compaction interrupts it, and for that question a screen-read turn is
exactly as real as a hook-read one. `e2e-submit.mjs`'s `deaf` case is what says so — its stub paints
idle churn that reads as a spinner, so a proof ladder that accepted a screen turn reported a
swallowed Return as delivered.

**And then the same rule, kept for the right reason, produced the wrong answer about the very
command it was written around.** Reported from a phone months later: the terminal drawing

```
❯ /compact
✳ Compacting conversation…  ▬▬▬▬  15%
```

and the app, on the screen beside it, saying *"typed, but Return was swallowed — open the session
and press Return · it is sitting in the composer, unsent — do not retype it"*, with **rewrite it**
and **discard** offered under it. Every rung of the submit ladder was genuinely missing: no
`UserPromptSubmit` (nothing was submitted), no `Stop` (no turn ended), no `turnFromHook` (the turn
was read off the screen), and `ranAnyway()`'s log rescue is silent about slash commands by
construction. The ladder answered honestly and was wrong about the one thing the sentence is written
to make a person do by hand — press a Return that would at best do nothing and at worst compact a
conversation twice.

So `/compact` became a category: `shared/slash.ts`'s **`worksUnannounced`**, a set of one, held
apart from the two that were already there because each answers a different reader's question
(`isLocalCommand` is the phone's *is this a modal?*, `startsNoTurn` is the host's *is there a turn to
wait for at all?*, and this is *is there anything that can answer for the Return?*). For that set,
and only for it, `deliver.ts` accepts `sessions.turnFromScreen()` as the bottom rung — guarded by a
snapshot taken BEFORE the keystroke, so a session already painting a spinner proves nothing. The two
weaknesses that bar this evidence everywhere else are both excluded by construction: the command is
named, so it cannot be an ordinary prompt confused by somebody else's compaction, and the session
was idle when the Return went in. The budget changes with it — 3 s per press instead of 900 ms, two
presses instead of five, because the screen proof is published a window after the CLI starts
painting and a budget cut for a hook concludes "swallowed" while the first frame is still drawing.
The audit row keeps it apart as `submit: "screen-turn"`: same verdict, visibly weaker evidence.

`e2e-submit.mjs` pins both sides in one file — case 7 is `STUB_MODE=goal` answering `/compact` with
the line and no hook (ok, typed once, one Return), and case 4 is the `deaf` stub with an ordinary
prompt, still `unsubmitted`.

**And it still did not work, because the rule was reading the evidence in the wrong form — twice.**
Driven against the real binary (a throwaway repo, `--model haiku`, six one-line turns so the CLI
would not answer *"Not enough messages to compact"*), the verdict came back `unsubmitted` with the
compaction visibly running. Two separate causes, both invisible to a stub:

1. **The line has no parenthetical for its first half-minute.** `PHRASE_OBJ_RE` was gated on a
   measured parenthetical, and this desktop's own turn captures show the CLI printing
   `Compacting conversation…` over a bar and a percentage, with `(32s)` only appearing later — and
   the first seconds are exactly the window a delivery watches. So `working.ts` now accepts the
   PROGRESS ROW as the measurement: block glyphs and a percentage and nothing else on the row, read
   off the row below the phrase (or the same row on a wide terminal). It is a stricter gate than a
   duration, which is what keeps the truncation-ellipsis case refused — a `─` rule is not in the
   glyph class, because the line cleaner turns box rules into whitespace.
2. **The raw byte tail is not text.** `checkTurnWatch` measured "is it working" over the bytes
   printed since the last pass, and a TUI repaint interleaves cursor moves and charset escapes with
   the characters: measured on 2.1.267, the compaction line arrives as
   `C\x1b(Bo\x1b(Bm\x1b(Bp…` spliced through the previous frame, so a phrase on screen for two
   minutes matched nothing. The byte delta stays as the cheap GATE (nothing printed ⇒ nothing to
   look at), and what is read is now `screenLog.gridText()` — the live VT the recorder already
   feeds, so it is a buffer read and not a replay, the same per-frame cost this pass was designed
   around. The old byte window survives as the fallback for a session whose recorder is gone.

Validated end to end on the real CLI: `ok` in 1.3 s, `turnActive` published for the length of the
compaction and retired when it finished. The stub now paints what the binary paints — the early
no-parenthetical shape, each character followed by its charset escape — and ignores a Return at an
empty composer, which is what the real CLI does and what the old stub did not: it answered the
ladder's second press with a turn, handing the delivery a proof the binary would never give it, and
that is why case 7 passed against a host that failed. Remove the grid read and `e2e-stophook.mjs`
case 4 and `e2e-submit.mjs` case 7 both fail; that is the pin.

**Nothing is recorded on the health board for this.** The hook did not fail — it was answered — and
`clihealth.ts`'s rule is that an observation is a miss only if the primary rule was the RIGHT RULE
and failed. A signal that reads `broken` for every session with a keep-going hook is a permanent
amber nobody reads, which is the failure mode that board exists to avoid.

`shared/working.ts` had to grow one shape for this: the spinner's phrase is normally a gerund
directly before the ellipsis ("Clauding…"), and the compaction line puts its object in between
("Compacting conversation… (35s)"). The relaxed form is accepted ONLY on a line that also carries a
measured parenthetical — a duration or a token count — because relaxed on its own it matches the
TUI's *truncation* ellipsis, and "⚠ Transcript saving is off — inherited CL…" read as an activity is
the app inventing one, which is the failure that file's doc names.

`e2e-stophook.mjs` pins both with `STUB_MODE=goal`: the stub posts `UserPromptSubmit`, then a `Stop`
150 ms later while it keeps painting its working line, and only posts the real `Stop` when the
spinner stops — and it answers `/compact` with the compaction line and no hook at all. The turn
survives the refused Stop, ends once when the work does, the phone never sees a flicker in between,
and the compaction is published as a turn and retired when it stops.

### `askbox.ts`

- `askbox.ts` — **the question as the CLI wrote it, not as the terminal cut it.** `AskUserQuestion`
  is a TOOL CALL: its question, labels and full per-option descriptions are in the conversation jsonl
  before anyone answers, while the screen's copy is truncated at the right edge, cut again by the
  preview pane, and on a tall box scrolled off. So the scraped box is ENRICHED — `ask` (the real
  question) and per-option `desc`. Only a PENDING call counts (a `tool_result` means that box is
  gone), newest wins, matching is by LABEL and never by index (the TUI appends "Type something." /
  "Chat about this", and a truncated run starts above 1), and a cut label is a PREFIX so containment
  runs one way only. Two labels must agree AND be a majority of the smaller side — one is not enough,
  two boxes in a row can both offer "Yes". All three fields are **outside `promptFingerprint`** on
  purpose: enrichment arriving one check late must not invalidate a queued answer. Cached on the
  log's mtime (the strict pass runs ~twice a second while a box is up). `e2e-askbox.mjs`.

#### Two things the log knows that the screen cannot be asked

**`recoverHead` — the options a tall box scrolled off its own top.** A box with six options and a
description each does not fit a phone's terminal, so the CLI scrolls its top away and the strict
pass publishes a run starting at 4. The card then offered three buttons for a six-option question,
with a line saying the rest were unreachable — which is a question you cannot honestly answer from
the phone, and is exactly what was reported ("the first options I have are scrolled away already
and therefore missing in our selection dialogue").

The recovery is exact rather than heuristic, because the TUI's numbering is the tool's own. Read
off the installed binary (claude 2.1.267), the drawn list is `[...the tool's options, "Other",
("Chat about this")]` numbered from 1, so the log's option *i* IS the row a keystroke of *i*
selects. Two rules keep it honest. It must be PROVED: at least one index the two lists share has to
agree (prefix-wise — the screen cuts a label, the log does not) and no shared index may disagree, so
a run made up only of the TUI's own appended rows overlaps nothing and returns null. And it only
ever ADDS: a label already on screen is left exactly as scraped, because `promptFingerprint` is
built from the labels and rewriting one would make an answer already queued against this box read
as stale. `truncated` goes with the recovery — nothing is unreachable from the card any more.

**`pickAsk` — WHICH logged question is on screen, or nothing.** `asks.find(askMatches)` took the
FIRST question of the call that overlapped, and one `AskUserQuestion` may carry several. Two of them
sharing two labels is ordinary — "Yes"/"No" are in both halves of most pairs — so after a Tab to
question 2 the matcher handed back question 1, and with it question 1's `askId` (so `sameBox` called
the new box the old one), question 1's descriptions, and question 1's first options as the
"recovered" head a digit would select. Every one of those is a wrong number where the rule is that a
heuristic degrades to absent. So every candidate is scored and a UNIQUE winner is required: a tie
means the screen does not say which question it is showing, and the honest answer is no enrichment
at all — the box is still published, with the labels as the terminal cut them.

**`AskQuestion.id` — the one handle on a box that a repaint cannot move.** The pending call's
`tool_use` id plus which of its questions this is (`<toolUseId>#<n>`). The `#n` is load-bearing: one
`AskUserQuestion` may carry several questions and the TUI draws them one at a time with Tab between
them, so the id alone would call two different boxes one box. What it is FOR is `prompt.ts`'s
`sameBox` — see below; nothing else about a box on screen survives a repaint, and this is minted by
the CLI and written down before anybody answers. Outside `promptFingerprint` for the same reason
`ask` and `desc` are.

### `planbox.ts`

- `planbox.ts` — **the plan a plan-approval box asks you to approve.** Reported from the reader: the
  card said "Claude has written up a plan and is ready to execute. Would you like to proceed?" over
  three buttons, and the plan itself was nowhere on the phone — the terminal draws it ABOVE the box,
  long scrolled away on a phone grid, and the reader is fed by the log.

  `askbox.ts`'s route does not exist here. Measured on 2.1.x (2026-10-08, a picture-app session): the
  `ExitPlanMode` call is **not in the jsonl while its box is up** — the log ends on the `ToolSearch`
  that loaded the tool; the assistant record lands only once the box is answered. What IS on disk is
  the plan FILE the CLI draws that box from, the path its own footer names after "ctrl+g to edit".
  Its location comes from the log, never from the screen (the footer wraps at phone width): the
  newest `plan_mode` attachment's `planFilePath` when the tail still holds one, else
  `<config>/plans/<slug>.md` off the `slug` every record carries.

  The box is recognised by its QUESTION ("…a plan…"), never by `kind`: that question also says
  "proceed", which `prompt.ts`'s older rule files under `tool`. The text rides as
  `DetectedPrompt.plan` (`text`, `path`, `cut`), capped at `PLAN_CAP` because the box is part of
  `SessionInfo` and goes out on every `session.updated` while it is up; outside `promptFingerprint`
  for `desc`'s reason. Cached on the log's mtime AND the file's (`Session.planCache`) — the plan can be
  edited while its box is up, and `mergeBox` takes the freshest read for the same reason. Every miss
  is absent: no log, no slug, no file, an empty file.

  Once the box is answered the call IS logged, and the parser renders its `input.plan` as a prose
  block ahead of the tool row — a `lite` document would otherwise carry the plan only behind a
  folded row nobody opens. `packages/host/test/planbox.test.mjs`.

### `login.ts`

- `login.ts` — **the sign-in link, reassembled.** `/login` is the one flow that cannot be finished
  inside this app: the CLI prints a 300-character OAuth URL, a browser has to visit it, and the code
  it returns has to get back into the CLI's own input. At phone width the grid breaks that URL across
  six rows with nothing joining them, so it was untappable, unselectable and untypeable — the session
  read as `awaitingInput` for ever. `detectLogin` rejoins it (`shared/urls.ts`) off the RENDERED
  screen and publishes `SessionInfo.login`; it rides on `checkPrompt`'s strict pass, which the login
  screen's own dialog footer has already paid for. Detection is on the URL's SHAPE (an OAuth query,
  or an auth-shaped path while the code input is visibly up), never on the CLI's prose — same reason
  `limit.ts` states about banner phrases. `applyLogin` mirrors `applyPrompt` (a broadcast per repaint
  otherwise) and keeps `at` across repaints of the same URL, because a login link expires and its age
  is the difference between a page that signs you in and one that refuses. `e2e-login.mjs`.

### `backends/shell.ts` + `sessions/links.ts` + `shelllinks.ts` — a plain shell, and the links it wants opened

- `shell.ts` — **a login shell in the repo, as a backend**. Data
  like every descriptor and no new function: `$SHELL_BIN`/`$SHELL`/`/bin/sh` with `-l`, every
  claude-shaped cap false, `healthScope:false`, and ONE new cap, `turns: false`, because the two
  readers that were not already gated assumed a turn: `turn.ts`'s silence ping ("Turn finished" after
  every `ls`) and `record.ts`'s model-made tab name (a spend per shell). With `turns: false` the
  shell gets neither — a static `shell · <repo>` name instead — and an unhooked delivery presses
  Return ONCE (a second Return in a shell is a second, empty command). Any resume mode is refused in
  words: a shell has no conversation. On the wire it is `BackendInfo.kind: "shell"`, derived from
  the cap, so the phone offers it as "open a shell here" rather than in the model picker; a plugin
  backend that says nothing about `turns` has them. A peer job can never open one.
  `$BROWSER` in every shell session is `ensureBrowserShim`'s 0700 script under the state dir, which
  POSTs the URL to the loopback-only `POST /api/shell/open` (always exit 0, curl `-m 2`).
- `links.ts` — **the one merge point for a shell's links** (`SessionInfo.links`, `ShellLink`):
  `addBrowserLink` (the shim — exact, kept 10 min regardless of the screen) and `setScreenLinks`
  (the screen reader's list — `at` kept per URL across repaints, retired off screen). A URL both
  sources saw is ONE entry. Only for a `turns:false` session, so a claude session's document never
  changes; `updated` on a change only; absent when empty, never `[]`; cleared on exit.
  `armLinksCheck` is the screen half's clock: armed from `scheduleChecks` only for `caps.turns ===
  false`, the prompt check's debounce-with-ceiling, one render (`screenText`, 40 rows) in flight at a
  time, and none while the byte tail carries neither a scheme nor a code word and nothing published
  could be retired. `packages/host/test/shellbackend.test.mjs`, `e2e-shell.mjs`.
- `shelllinks.ts` — **a shell's links and one-time codes, off the rendered grid** (`login.ts`'s
  sibling for sessions that are not claude). `detectShellLinks(screen)` → `{links, awaitingCode}` or
  null on a throw. Every `https://` URL (`findUrls`, plus `hardWrapped` for the TERMINAL's wrap of an
  indented URL — gcloud's four-space inset continues at column 0, proved by a row exactly `cols` wide; a
  painted-over link is dropped); `http://` only for this desktop, flagged `local`; newest last, one
  per URL, at most 3. **A code is only ever a property of a link** — within 6 rows, attached to the
  NEAREST link: `XXXX-XXXX` device shapes on their own, any 6–12 `[A-Z0-9-]` token only right after a
  code label; never pure hex ≥7 (a SHA), never after `$`/`pid`/`port`. A code-shaped token with no
  link is nothing, because the false code costs a sign-in and the missed one costs a copy by hand.
  `awaitingCode` = the LAST non-blank row ends on an authorization-code prompt, so an answered or
  abandoned prompt is history. Label and prompt patterns are built from split halves, for the
  reason `login.ts`/`limit.ts` give. `packages/host/test/shelllinks.test.mjs` (gh, gcloud, firebase,
  codex, npm, tailscale, `git log`, no-URL, localhost, scrolled-off fixtures), `e2e-shell.mjs` 4b.

### `limit.ts`

- `limit.ts` — usage-limit banner + reset parsing → auto-continue, plus the **resume queue** in
  `sessions.ts`: a limit is an ACCOUNT fact, so sessions block as a group on one reset instant and
  resuming them together is self-defeating. Order steerable (`limit.first` → starred →
  longest blocked), a failed resume arming a host-wide hold-off; `limit.resume` overrules the clock.
  **How MANY resume at once is a mode** (`LimitResumeMode`, persisted in `.waterplane/limit.json`,
  `limit.setMode`): `one` (default, wait for each verdict) / `repo` (one per worktree, via the send
  queue's own `serialGroup`) / `all`. In every mode the FIRST resume of a wave goes alone — the probe
  — because "don't spend N attempts on one wall" is an argument about the account, and it stops
  applying the moment one session provably works again (a fresh block or a still-blocked verdict
  makes the wave unproven again). The gap between two resumes is a rate limit that survives every
  mode. UI: `LimitSheet.tsx` off the launcher's "N at limit" chip. Verified by `e2e-limitqueue.mjs`
  (serialized default) and `e2e-limitparallel.mjs` (probe first, parallel across repos, never two in
  one worktree).
  **Keep banner phrases out of
  strings/comments repo-wide** — printing one on screen false-positives.

#### `detectHeadlessLimit` — the same wall, hit by a run with no terminal

Four things in this daemon call `claude` with no PTY at all: `review.ts`'s **check** and
**validate**, `assess.ts`, and `sessions.ts`'s advisory summary. All four went through
`execFile(claude, ["-p", "--output-format", "json"])`, and all four reported a failure as
`String(err)`.

What that produced, out of a real `.waterplane/reviews.json` row:

```json
{"checkStatus": "error",
 "checkNote": "Error: Command failed: claude -p --output-format json",
 "checkDetail": "You've hit your session limit \u00b7 resets 5:10pm (Europe/Berlin)"}
```

The note names no fact anybody can act on and reads as a broken install; the sentence that says what
actually happened, and the hour it stops being true, was in the **detail** the whole time, one
disclosure chevron away. Measured on CLI 2.1.236: a refused headless run exits non-zero, puts the
banner in the envelope's `result`, and writes **nothing to stderr** — which is exactly why the
`(stderr || String(err))` ladder every caller shared could only ever reach the useless half.

So `detectHeadlessLimit(stdout, stderr)` unwraps the envelope (`result`, plus `error` when it is a
string), joins it with the raw streams, and hands the lot to `detectLimitText` — the same regexes the
PTY path uses, so there is one statement of what a block looks like and not a second one that drifts.
A miss degrades to the caller's old message: a wrong "the account is out of quota" on a run that died
for a missing binary would be worse than the errno it replaced, since it describes something that
fixes itself in five hours.

`limitNote(det, verb)` is the sentence all four say. Two rules in it:

- It states **what did not happen** ("Nothing was checked"), never that something failed. The
  reviewer never ran, so there is no verdict about the work — reported as a failure it reads as one.
- It is **not the banner's wording**. This string travels to a phone, into a notification and onto
  disk; re-printing upstream's phrasing is how a readout false-positives the detector that produced
  it.

`BacklogCheckStatus` and `BacklogValidateStatus` gain **`limited`** for the same reason `error` was
wrong: the check did not fail, it did not happen. The web renders it in `var(--limit)`, the one
colour every at-limit fact in this app wears. And `check()`/`validate()` **skip the diff-review
fallback** on a limited first pass: the fallback exists for a reviewer that could not answer, not for
an account that will refuse the second run exactly as it refused the first.

`packages/host/test/headlesslimit.test.mjs` pins the envelope shape, the stderr-only variant, the two
false positives (an ordinary bad verdict, junk on stdout) and the sentence.

### `spendwall.ts`

- `spendwall.ts` — **a balance is not a window.** An API-key / cloud account whose credit ran out, or
  that hit a workspace / organisation / gateway spend limit, is read as a wall by `limit.ts`
  (`LimitDetection.spend`, line-anchored so prose that merely quotes the error is not one) and by
  `limitlog.ts` (the CLI's synthetic API-error turn, `LimitLogVerdict.spend`). Wording: the installed
  CLI bundle (2.1.300) for the credit and gateway messages; the workspace sentence is the API's own,
  least certain. A plan banner outranks, so subscription behaviour is unchanged.
  **No ladder:** typing into an empty balance earlier changes nothing, so a spend wall takes ONE
  attempt, at an instant the message printed in full or the earliest active usd CALENDAR period's
  reset (`periodBounds`, via `setSpendPeriodSource` from `main.ts`), else `noteGaveUp` - the person is
  told it needs them. A clock time is never guessed. With no printed instant the missing reset is the
  rule answering correctly, so `limit.reset` records neither a miss nor a good.
  `packages/host/test/spendlimit.test.mjs`.

### `limitlog.ts`

- `limitlog.ts` — **the same question, asked of the CLI's own log, which is DATED.** A banner is the
  last thing a blocked session prints, so it sits in the scrollback tail for as long as that session
  sits idle — days — and `checkLimit` re-affirmed it every sweep, re-resolving its bare "resets 10pm"
  against TODAY. Nothing lifted it either: while the session is quiet the banner never leaves the
  window, so the scan could only ever confirm. The CLI writes each rejection to the conversation
  jsonl as a synthetic assistant turn carrying `quotaLimits` (`status`, `resetsAt` as an INSTANT,
  `rateLimitType`), and an ordinary assistant turn stamped after it is the account serving this
  session again — the positive signal that lifts a block with nobody typing anything. So `blocked` =
  newest rejection, unanswered, reset not yet passed; `clear` = readable and not that; **`unknown`
  when there is nothing to read** (no conversation id, no file yet), where the screen heuristic
  stands unchanged — an absent log is never a verdict. The log OUTRANKS the screen in both
  directions in `checkLimit`, `diedAtLimit` and `maybeScheduleResurrect` (a stale banner must not
  book a `--continue` that starts a turn nobody asked for). `packages/host/test/limitlog.test.mjs`.

#### Outranking the screen needed a reason, not a state

The first version answered `clear` for three different situations and the caller read them as one.
Measured on the live host over one night (2026-09-10), that cost the feature both halves of its job:

- **A `clear` that has never SEEN the rejection.** The CLI prints the wall on screen and writes the
  `quotaLimits` row a moment after, and `SessionManager.limitLog` memoises the verdict on the file's
  **mtime** — which then does not move, because a session sitting at a wall writes nothing. A read
  taken inside that gap said *no rejection in this log*, which suppressed the banner that was on
  screen right then, for two hours: rejected at 20:20, finally noticed at 22:21, wearing no badge
  and arming no resume in between.
- **A `clear` that is only the CLOCK.** The rejection still stands, nothing has been served since,
  and its own `resetsAt` has merely passed. `checkLimit` called that positive proof and cleared the
  block — and `clearLimitBlock` kills `limitTimer`, i.e. it cancels the auto-continue that was the
  entire point. The same night: reset at 00:00, the minute sweep cleared two sessions at 00:00:38,
  their attempts were due at 00:02, so no `continue` was ever typed and the prompts that hit the
  wall never ran. The third session survived only because its cached verdict happened not to be
  re-read in that 82-second window — the bug was a race, which is why it looked intermittent.
- **The same clock-only clear, asked about a session that EXITED.** `diedAtLimit` and
  `maybeScheduleResurrect` both treated any `clear` as *this had nothing to do with a wall*, so a
  limit death whose reset arrived before anyone asked became permanent: no resurrect, and the work
  items requeued for a limit death were failed instead.

So a `clear` now carries `clearedBy`: `served` (an ordinary turn after the rejection — proof about
the ACCOUNT, and the only one strong enough to lift a block by itself), `reset` (proof about the
clock alone) or `none` (the log has nothing to say about a wall). `none` may not overrule a live
screen banner; `reset` may not cancel an UNSPENT attempt, and still counts as a limit death. Once an
attempt HAS been typed the hold ends — `attempts > 0` was already a clearing proof, and holding
past it would be the mirror bug, a badge with nothing left to lift it. The mtime memo is
additionally re-read the moment a `blocked` row's own reset instant passes, since that transition
happens on the clock and never in the file. `e2e-limitreset.mjs`.

### `ctxlog.ts`

- `ctxlog.ts` — **how full the context window has been, asked of the CLI's own log, which is DATED.**
  Same argument as `limitlog.ts`, one level up. `context.ts` reads a percentage off the terminal,
  which is right for a badge and useless for a graph: one number, overwritten in place, with no
  record of what it was ten minutes ago and nothing at all to say about the moment it dropped from
  4% to 96%. A series accumulated from it host-side would start empty on every restart, hold only
  what one daemon lifetime saw, and — the indicator is not always on screen — be full of holes it
  could not describe. The conversation jsonl already carries every one of these facts, timestamped:
  each assistant turn's `message.usage`, where `input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens` is what the request actually sent (output is excluded — it is not
  context until the turn after); a compaction's `{"subtype":"compact_boundary","compactMetadata":
  {"trigger","preTokens","postTokens"}}`, which is both WHEN the drop happened and how far it fell;
  and the `quotaLimits` row `limitlog.ts` already reads, so the walls land on the same axis for free.

  Three things it will not do, each one a way a chart can be plausible and wrong:

  - **A streaming turn is one point.** The CLI writes the same `message.id` several times with the
    same usage, so counting each puts three identical readings on one instant — and, on an
    incremental read, once per pass for ever. `remember()` is a bounded FIFO because the duplicates
    are adjacent and an unbounded `Set` on a conversation nobody closes is a leak.
  - **The rejection turn is not a reading.** A wall is itself written as an assistant turn, with
    `<synthetic>` for a model and a usage block of zeros. Plotted, it draws a cliff to zero at
    exactly the moment nothing happened.
  - **A sidechain is a different conversation's window.** A subagent's turns are skipped.

  The **cursor** (`updateContextLog`) is what makes this affordable: a 20 MB conversation costs 50 ms
  to walk, and the miniature is refreshed once per turn per session, so the second pass reads only
  what was appended. Its one subtlety is `consumed` — the offset past the last NEWLINE, never
  `st.size`: the CLI appends while we read, and resuming from `st.size` silently loses whichever
  record was half-written. A file that shrank or went backwards in time is a different conversation
  wearing the same name and is re-read from scratch.

  `downsample` bounds the series at `MAX_SAMPLES` **without flattening it**: each bucket contributes
  its highest and its lowest reading, in the order they occurred, because the shape here is a
  sawtooth and a stride sample steps over exactly the two points that carry each tooth — the peak
  before a compaction and the floor after it. `sparkOf` is the ~200-byte miniature that rides on
  every `SessionInfo`; its ticks are placed by finding the READING nearest each event and using that
  index, so a tick lands on the cliff it names rather than beside it.

  **When it is rebuilt is part of the feature.** `refreshSpark` has two callers: the once-a-turn
  context scan (`markIdle`), and `SessionManager`'s periodic sweep. The sweep's own gates —
  `sawData`, and "nothing younger than `IDLE_PING_MS`" — belong to `checkLimit`, which reads the
  SCREEN and must not read a half-drawn repaint. The miniature reads the LOG, so neither gate says
  anything about it, and behind them the two callers collapsed into one condition: *the session went
  quiet*. A session mid-turn, spinner repainting every frame, was never refreshed at all — so a NEW
  session's launcher row carried no curve for the whole of its first turn, which is exactly the
  session whose context is climbing fastest, and a restored session that had printed nothing to this
  process carried none either. The refresh therefore runs first in the sweep, ahead of both gates; it
  costs one `statSync` per live session per sweep and returns immediately when the log has not moved.
  `e2e-ctxgraph.mjs` drives the shape directly: a session poked often enough that it is never quiet
  must still publish a spark, and must do it while still mid-churn.

  **What the session SPENT is a second question, answered in the same pass.** The curve is the input
  side of one conversation, which is the right number for *what does the next turn re-read* and the
  wrong one for *what has this cost me* — and on this desktop those two are not close. Measured
  against one real session in this repo: the window read **271k** and the session had used **368M
  tokens**, of which **355M** was **19 subagents**. Nothing on any screen could say that, because
  the only per-session figure that existed was the sum of the readings.

  So `SeriesCursor.usageTok` is a RUNNING counter (never a fold over `samples` — those are capped at
  `RAW_CAP` and downsampled on the way out, so a derived total would shrink as a conversation got
  long, which is the one direction a spend figure must never move), deduped by `message.id` like the
  readings and including `output_tokens`, which the readings deliberately exclude. And `agentUsage()`
  reads the Task tool's own logs beside it.

  **The agents are in a different file, and that was measured, not assumed.** `updateContextLog`
  skips `isSidechain` rows — and on this CLI there are none: **0 of 7,761 logs in this repo carry
  one**, because an agent is written to `<conversation>/subagents/agent-<id>.jsonl` (27 conversations
  here have that directory; `agents.ts` reads the same one for what they are DOING). The guard stays
  for the older shape precisely so the two cannot both count the same agent. `agentUsage` is an
  incremental cursor per FILE, for the reason the series is: an agent's log grows for minutes while
  the parent log is asleep — which is also why `refreshSpark` reads it BEFORE the "has the log moved"
  early return, or the total would freeze for the whole of a fan-out, the one session it exists for.
  A missing directory is a MEASUREMENT (the CLI creates it with the first agent) and answers zero;
  any other failure answers null, and then `sparkOf` publishes **no total at all** rather than the
  main conversation's spend under a name that promises the agents are in it. A log that vanished
  keeps its tally — those tokens were spent, and a number that drops while you watch reads as a
  broken readout.

  Both are FLOORS — a tail-capped read undercounts, an agent log that was cleaned up is one nobody
  can add — so every screen words it *so far*, and the sentence is written once, in
  `shared/sessioncost.ts`'s `usageText`.

  **The running total rides along with the reading** (`ContextSample.used`). The phone draws a second
  chart from it — what the conversation had SPENT by each request, against what it was carrying — and
  the two are only worth stacking if the curve's end is the same figure this file prints as
  `usageTok`. So it is the same counter, sampled: `cur.usageTok` is written onto each sample as it is
  pushed. Folding it out of `samples` afterwards would have been a cumsum that ends a few percent
  LOW, because the total counts a request whose readings were unreadable and the readings skip it;
  two totals that nearly agree is the worst failure available here. It survives the downsampler for
  free (monotone, emitted in time order) and a tail-capped read simply starts the curve part-way up,
  which is correct and is said beside the chart. The SUBAGENT share stays out of it — those logs are
  read as totals with no clock, so the phone draws them as a reference line and never as part of a
  curve over time.

  **The window size is not in the log** — nothing here invents one. `autoCompactTok` is a
  measurement (the newest `trigger:"auto"` compaction's own `preTokens`) and is never relabelled as
  the window. The window is resolved once, in `SessionManager.contextWindow()`, against
  `shared/ctxwindow.ts`'s ordering: a TUI-printed gauge, then the per-model high-water mark from
  `host/ctxwindow.ts`, then the id alone, then `none`. The model itself is taken from the LOG rather
  than from `SessionInfo`, because that is the authority on what actually ran and it is the only
  source a CLOSED session has — and a closed session's graph must sit on the same axis as everyone
  else's.

  **And the split, in the same pass.** `usageTok` alone is the number `shared/tokens.ts` opens by
  calling this app's most misleading: 96% of it, measured over 9,444 logs here, is the conversation
  being re-read out of the prompt cache. So `SeriesCursor.split` (and `AgentUsage.split`) carries
  the four kinds plus a request count, accumulated behind the IDENTICAL guards — the streaming
  dedupe, the `<synthetic>` skip, the sidechain skip — so that `tokenTotal(split)` IS `usageTok`,
  asserted in the tests and again in `e2e-ctxgraph.mjs`. A second tally with its own guards would
  come out a few percent off and there would be no way to argue about which was right.

  Its record rules are `tokenstats.ts`'s, deliberately and exactly: the all-zero usage block is
  dropped before the turn counter, and the 1-hour cache-write tier is READ out of
  `cache_creation.ephemeral_1h_input_tokens` rather than assumed. Verified against a real corpus
  rather than by inspection — two conversations (4.7 MB, and one with 34 subagent logs totalling
  778M cache reads) re-counted with `tokenstats.ts`'s own algorithm agree to the token on every
  kind and on the request count. **`split.turns` is REQUESTS while `turns` is what the outline
  lists**, and that is the whole reason both exist: `cacheReading` divides context by turns on the
  per-session AND the all-sessions screen, and a denominator meaning tool calls on one and prompts
  on the other makes one conversation read two ways depending which you opened.

  **And the COST, in that same pass, priced PER RECORD.** The launcher row prints money rather than
  a token count (`web.md`), which makes this fold the thing standing behind a dollar figure on
  screen — so the granularity is not a detail. A rate is a property of the model that ran a request
  and of the day it ran on, and both change inside one conversation: a session that starts on sonnet
  and finishes on opus, a price that moves. Pricing `split` as a whole afterwards would have to pick
  one model, and the only one available is `cur.model` — the NEWEST — which charges the entire
  history at whatever ran last (haiku's rates are a fifth of opus's, so that is a 5× error on the
  turns it gets wrong). So `costOf(bag, thisRecord.model, localDay(t))` accumulates into
  `SeriesCursor.cost` off the same bag the split is built from, behind the same guards: one record,
  two accumulators, and no way for the money and the tokens to come from different sets of records.
  `AgentUsage.cost` does the same per agent log, on the AGENT's own model — a fan-out running haiku
  workers under an opus parent is the ordinary shape, and it is the case where the parent's rate is
  wrong about most of the bill.

  `localDay` is `tokenstats.ts`'s `localHour` truncated, for its reason: slicing the ISO string
  would file a 01:30 turn under the previous UTC day. It only ever decides which side of a price
  change a record falls on — but two screens disagreeing about the zone would put the same record on
  different sides of it.

  Two absences, both deliberate. A conversation where nothing could be priced publishes **no cost at
  all**, never a breakdown of zeros: `$0` beside a session that visibly ran reads as "this was
  free", and the row falls back to the token total, which is exactly what it showed before any of
  this existed. And `sparkOf` publishes the money only where the subagent directory was READ —
  the same rule `usageTok` follows, because a bill that leaves eight conversations out is worse than
  no bill. What could not be priced is COUNTED (`unpriced`, in tokens) and travels beside the
  figure, so the reading can name a model the table has no rate for instead of coming in silently
  low; a rate table goes stale the week after it is written, and that is the one way this number
  goes wrong without looking wrong.

  **And what each reading was MADE OF, and WHO made it.** The split above is the
  conversation's whole traffic; a stacked chart needs it per reading, so every sample carries two
  four-number tuples and a model index. `kinds` is that request (input, output, cache read, cache
  write — `TOKEN_KINDS`' order, read only through `sampleTotals`) and `cum` is the same four as a
  RUNNING counter. Both, because the spend chart is cumulative and the context chart is not, and
  **a client-side cumsum over the surviving samples would end below the total printed above it**:
  `samples` is capped at `RAW_CAP` and thinned by keeping each bucket's min and max, so a derived
  running figure loses every dropped request. A recorded counter survives thinning — the argument
  `used` already rests on, applied per kind. Tuples rather than objects because there are up to
  1,200 of them and the key names would be most of the document.

  The model rides as an INDEX into `ContextLog.models`, and two rules make that safe. The table is
  keyed by **ALIAS** (`normalizeModel`), never by the logged id: the log spells one model several
  ways (a dated snapshot, the `[1m]` marker) and banded raw they are two slots, two colours and two
  legend entries both reading `opus-5` — measured here on a real conversation whose parent and whose
  own subagent took separate slots while every sentence named one model. Pricing still uses the RAW
  id, which is where a dated snapshot belongs. And the table is sorted by VOLUME on the way out
  (`modelOrder`) with **every index rewritten with it** — the phone assigns a colour by position, so
  a table sorted without its indices re-pointed is a chart that is confidently, silently wrong about
  which model did what. The re-pointing writes NEW sample objects, because `downsample` hands back
  the cursor's own array under the cap.

  **`agentUsage` keeps a ROSTER as well as a total** (`AgentUsage.runs`). `agentTok` says the agents
  spent 355M and cannot say how many there were, WHEN, or on what — three questions already answered
  on disk, since each `subagents/agent-<id>.jsonl` is dated and carries `message.model` beside a
  `.meta.json` naming the task type (read through `agents.ts`'s own memoised `readMeta`, exported
  rather than copied). An agent whose log carries **no usable timestamp is counted in the total and
  left off the roster** — it was spend, it is not a moment, and a bar at the epoch is a claim about
  when. `withAgentRuns` is where the roster meets the table, because an agent's model need not be
  one the conversation ever ran: measured on a real 45 MB log here, the parent ran only
  `claude-opus-5` and its 34 agents ran `claude-fable-5` and `claude-sonnet-5`. Appended, by alias,
  never dropped.

  **What the compactions DID** is the last thing the same pass answers, and it is a different kind
  of figure from everything else in this file: a counterfactual about requests that really happened.
  The chart already draws a tick at every compaction, and a tick is the one thing about a compaction
  nobody needs telling. `CompactionLedger` is what it did — split by trigger, because *was typing
  `/compact` worth it* and *was the CLI right to compact when it did* are two questions that cannot
  be told apart once they are added together.

  Three quantities, and only the first is a plain measurement:

  - **Shed** — `Σ preTokens − postTokens`, both written down at the boundary. It CHAINS: after two
    compactions the uncompacted window is the real one plus both sheds, because each drop is
    measured against what the previous one left behind.
  - **Saved** — the shed summed over every REQUEST since, not per compaction. That distinction is
    the whole figure: one boundary shedding 173k with seven requests after it saved 1.2M, not 173k,
    and the per-compaction reading understates a long conversation by the number of turns in it.
    Priced as **cache reads**, on each request's own model and day — the cheapest those tokens could
    have been, and deliberately so: a conversation resumed after the cache expired re-writes its
    prefix at 12.5–20× the read rate, and pricing the shed at the write tier would let the figure
    flatter the feature it reports on.
  - **Rebuild** — the cache write on the FIRST request after each boundary, the window being built
    again from nothing. Measured, and an overstatement on purpose: part of that write is the turn's
    own growth, which an uncompacted conversation would have paid too. Erring low on the saving and
    high on the cost is one decision made twice — neither may make compacting look better than it is.

  **The summarisation request is not in the log.** Measured: between a `compact_boundary` and the
  next prompt there is no assistant record at all, and the summary itself arrives as a `user` row
  with `isCompactSummary` and no usage. So the one part of the cost nothing here can see is the
  model reading the whole window in order to summarise it — which makes `rebuildTok` a floor, and
  is why the two sides are never subtracted into a net anywhere the wording cannot follow.

  A boundary missing either end of the drop, or missing its trigger, goes to `unmeasured` and enters
  no row: "the CLI's own" is a claim, and `count + unmeasured` minus the manual ones would be
  asserting a trigger nobody recorded. Same posture as `unpricedTok`, applied to a count. Measured
  through this reader over this desktop's 32 logs that have ever compacted: 19 compactions, 16 of
  them typed by hand, **$748 saved against $7.19 in rebuilds**. Reading the same logs whole reports
  20 and $984 — three of them were past `MAX_READ`, so their earliest boundary and the requests
  before the cut were outside the tail that was read. **That gap was later closed (2026-09-26): every
  log is now read whole, forward in `MAX_READ` chunks.** Treating the tail as a "floor" was wrong: the
  screens printed it as the total, and on one fan-out session it showed 307M of 786M agent tokens
  and $175 of ~$440. On the longest of them the counterfactual window is 1.4M, so the
  honest reading there is not that compacting was thrifty but that those turns could not have run at
  all.

  `packages/host/test/ctxlog.test.mjs`, `e2e-ctxgraph.mjs`, and the web half in
  [web.md](web.md#contextsheettsx--the-context-window-as-a-shape).

### `ctxwindow.ts`

- `ctxwindow.ts` — **the most context each model has ever been SEEN to hold**, on this host.

  The y axis of every context graph rests on one number, and the first design got it from the model
  id: 200k unless the id carried `[1m]`. That is wrong, and the way it is wrong is the worst kind —
  quiet, plausible, and five-fold. The CLI's conversation log records the BASE id even for a 1M
  conversation. Measured across one machine's logs: `claude-opus-5` reached **998,242** tokens of
  context and `claude-opus-4-8` **994,851**, neither carrying a suffix; two more models on the same
  machine also exceeded 200k (`claude-opus-4-7` at 335,928, `claude-fable-5` at 263,800). An
  id-keyed table drew those sessions at 500% — and, far worse, would have drawn a fresh one at five
  times its real fullness with nothing on screen saying so.

  What the log CAN prove is the other direction: a conversation that held 346k tokens was not
  running in a 200k window. `ctxlog.ts` already computes that peak on every turn, so the store is
  just the memory — `.waterplane/ctxwindow.json`, keyed by model, tmp+rename, debounced 3 s, flushed on
  SIGTERM beside `acks.flush()`. Persisting it is what makes it useful rather than merely correct in
  hindsight: a mark learned from Monday's long session is what tells Tuesday's fresh one, at 40k,
  that it is 4% full and not 20%.

  Two rules. **The mark only ever RISES** — "no conversation has exceeded 200k lately" is not
  evidence of a 200k window, and letting a quiet week walk the axis back down would silently
  rescale every historical graph. And **it is never used raw**: `windowContaining` snaps it up the
  `WINDOW_LADDER` (200k, 1M), so one long conversation cannot make the axis 346k — an axis topping
  out at whatever this series happened to reach is exactly the per-series axis the shared scale
  exists to replace. `packages/shared/test/ctxwindow.test.mjs`, `e2e-ctxgraph.mjs`.

### `tokenstats.ts`

- `tokenstats.ts` — **how many tokens every conversation on this desktop has ever used.**

  Nothing in the app answered "how much have I used, ever". `meter.ts` counts what this app spends
  on the oracle — one small subsystem. `usage.ts` scrapes the CLI's `/usage` screen for a percentage
  of the current window: no history, no total, and gone at the next reset. The CLI meanwhile writes
  the real answer down and has done since the first day: every assistant turn in every conversation
  jsonl carries `message.usage`, including sessions this app never drove. Same source as the
  transcript and the context graph, no new bookkeeping to desync.

  **Three rules make the number correct, and each of them is a 30–70% error if dropped.**

  - *Dedupe by `message.id`.* A streaming turn is written several times with one id and one usage
    block. Measured on the corpus this was built against: 69,931 real turns against 49,260 duplicate
    records. Counting them inflates every figure on the screen by 70%.
  - *Skip the `<synthetic>` turns.* A usage-limit rejection is written as an assistant turn with a
    zero usage block. It is not a turn that ran.
  - *Keep the four kinds apart, for ever.* 96% of the total is cache reads. A store that summed them
    could never un-sum them, and every screen downstream would be free to imply that 13.65 billion
    tokens is what somebody spent.

  **Subagents are counted**, unlike in `ctxlog.ts` — and the two are not inconsistent, they are
  answering different questions. There it is "how full is THIS conversation's window", and a
  subagent's turns belong to a different one. Here it is what was spent, and a subagent spends real
  tokens. They live one directory deeper (`<conversation>/subagents/agent-*.jsonl`), they were a
  QUARTER of the real total, and the first implementation walked only the top level and produced a
  headline a third too small — which looked entirely plausible.

  **The store is per-file summaries, not a patched aggregate.** A cold scan is seconds over ~10,000
  files and 2 GB, fine once and unacceptable per request; the obvious fix, a running aggregate plus
  deltas, needs a subtract path for any file that changes, and subtracting from the per-day and
  per-model buckets means keeping those buckets per file anyway. So the file IS the summaries and
  the aggregate is DERIVED on every read: no patching, no drift, and a deleted conversation simply
  stops being in the fold. Measured: 1.66 MB on disk, 6 ms to reparse, average file 1.01 days and
  1.00 models. A changed file is re-read WHOLE rather than appended to, because the duplicate rule
  needs that file's own id set and an appended read cannot have one.

  **The scan yields to the event loop every 64 reads, and that is not an optimisation.** Done in one
  synchronous go it holds the loop for the whole ~7 s: no PTY frames, no socket writes, no hook
  POSTs, for every session on the machine. On a host driving 44 sessions that is not a slow screen,
  it is a seven-second outage. After the change, the worst unrelated request measured during a cold
  scan was 71 ms. `main.ts` also warms it once in the background 20 s after boot, so the first tap
  on the screen is never the one that pays.

  Scope is stated rather than implied — every log CURRENTLY ON DISK, so a conversation deleted from
  the archive stops counting — because that is the only definition that can be checked against
  anything. `e2e-tokenstats.mjs`, and the web half in
  [web.md](web.md#tokenstatssheettsx--every-token-this-desktop-has-used).

  **The bucket key is an HOUR, not a day** (store version 4). A day key cannot be refined back into
  hours, while an hour key IS a day key in its first ten characters — so the day rows are a FOLD of
  the hour rows and the two cannot disagree about which day an 01:30 turn belongs to. It costs
  roughly threefold on disk (a conversation averages 1.01 days but ~3 hours) and it buys the only
  chart on the screen that can show a burst at 14:00. Two things ride out of it: `hours`, cut to a
  recent window on the way OUT (`WATERPLANE_TOKENSTATS_HOUR_DAYS`, 14 days — the store keeps everything,
  so widening it is a restart rather than a rescan), and `hourOfDay`, 24 slots folded over the WHOLE
  corpus, which is the intraday reading that needs no raw hours on the wire at all. The cut is
  bounded because the document is fetched over HTTP and cached on a phone; `hoursFrom` states where
  it starts, so an empty left edge reads as retention rather than as a quiet fortnight.

  **The cross key is what makes three more charts free.** It already holds an hour AND a model per
  file, so day×model, repo×model and "when did a subagent START" are all projections of the loop
  that was running anyway — no rescan, no store version bump, no second walk:

  - **`TokenDay.byModel`** — the per-day stack by model, which is the one form a model migration is
    visible in. In a total it is nothing at all; as bands it is a crossing.
  - **`TokenGroup.byModel` on the REPO rows** — the answer to the question the bar lengths raise and
    cannot settle. Two repos with the same token count can be several-fold apart in cost, and the
    reason is never in the total: opus is 2.5× sonnet per token and 5× haiku, so a repo whose share
    of the MONEY exceeds its share of the tokens is a repo running a dearer model and nothing else.
    Absent on the MODEL rows, where it would be the row itself.
  - **`TokenDay.agents`** — subagents STARTED that day, by model. A count of EVENTS, not a slice of
    tokens (`subagents` already carries the spend): a day that ran one agent for an hour and a day
    that ran twenty for three minutes each carry the same subagent total and were nothing alike. A
    transcript's launch is its EARLIEST hour bucket and its model is the one that ran in it, so a
    long agent is one bar on the day it began rather than smeared over the days it worked. An empty
    array is a day on which none ran — a reading — and only the whole field being absent means an
    older host.

  **`windowSeries()` — the same ledger folded into PAST rate-limit windows** (`GET
  /api/tokenwindows`, web `usageCut.ts`'s grids).

  The document ships a bounded fortnight of hours on purpose, which is enough to cut the window
  running NOW and nothing older — a weekly window from July is four months back in a record the wire
  does not carry. The store keeps every hour it ever saw, so the fold happens here and what crosses
  is one small row per window that had anything in it: measured on this desktop, 103 KB and 26 ms
  warm for 117 five-hour windows and 8 weeks, against the megabytes shipping the buckets would have
  cost. It is a second READ rather than a field on the document because the grid moves independently
  of the scan: every five hours the anchor is a different instant and the same buckets fall in
  different cells.

  **The GRID is the caller's.** Neither the reset instant nor the length of a window is a fact about
  a ledger of hours — one is scraped off the CLI's own `/usage` screen and the other is a property of
  the plan — so the route takes `w=<id>:<anchor>:<length>`, repeated, and echoes each back by id.
  This module folds buckets into a grid somebody else defined and asserts nothing about what the grid
  means, which is also what keeps the two windows' semantics in ONE place, on the phone.

  **`windowCells()` is the whole of the correctness** and is exported for its own test, because the
  fold is a sum and every way a heat grid can be wrong is a bucket landing in the wrong box. It
  calls — deliberately, rather than re-deciding — the rule the live cut states on screen:
  `windowStartHour` (shared), the hour NEAREST the instant, at both edges, so an hour counts in
  `[windowStartHour(opened), windowStartHour(closes))` and the cells tile. It used to floor the
  opening hour, which put that hour in two cells and 59 minutes of last week into a week resetting
  Thu 18:59 (≈ 4 points of over-count, measured). Still a LIST, so empty needs no sentinel. An
  exclusive rule of the grid's own would have made cell 0 and the line under the limit bar two
  different numbers about the same five hours.

  A window with no row RAN NOTHING — a reading, drawn as a real empty box — and `oldestHour` is what
  tells that apart from a window the record does not reach back to. Cost is crossed by model like
  everything else here, for the same reason: a rate belongs to a model and a day, so a cell priced as
  a whole would be charged at whichever model came last.

### `usagelog.ts`

- `usagelog.ts` — **the `/usage` readings this daemon took, kept.**

  `usage.ts` publishes a point in time with no memory. That answers "can I run something now", which
  is what the launcher chip asks, and it cannot answer the question a person asks immediately after:
  am I burning this week faster than usual. The CLI prints a percentage and no history and there is
  no file on disk holding one, so the only place a history can come from is the readings this daemon
  already takes.

  **Nothing is scraped for this file.** It records what was fetched for some other reason — the
  auto-fire gate's poll, a phone opening the token screen, a manual refresh. A timer that spawned a
  `claude` PTY purely to draw a line would make the chart the most expensive thing on the host, and
  it would be a chart of its own polling. The consequence is that the series is IRREGULAR by
  construction, which the DTO says out loud and the chart honours: a gap is drawn as a gap, never
  resampled, never carried forward.

  **The reset instants ride along with every reading**, and that is what makes the 5-hour line
  legible. It climbs, then a window rolls over and it drops to near zero; joined as one polyline
  that reads as usage being refunded, which is not a thing that happens. A change in the reset
  instant the screen NAMED is the evidence that the drop was a rollover, so the line is cut there and
  the break is drawn — and a drop with the instant unchanged is a real fall, left visible rather than
  smoothed.

  **Kept only when it says something new**: a failed probe is dropped rather than recorded as two
  nulls (that is a fact about this daemon, not about the account), an identical reading is skipped
  for `WATERPLANE_USAGELOG_REPEAT_MS` — but not for ever, because "flat for four hours" and "nobody looked
  for four hours" are opposite facts and a change-only series draws them the same. JSONL, appended,
  compacted in place against `WATERPLANE_USAGELOG_CAP` and `WATERPLANE_USAGELOG_RETAIN_MS`; a corrupt line is
  skipped and a corrupt file starts again. `packages/host/test/usagelog.test.mjs`; the web half is
  `UsageSpark` in [web.md](web.md#tokenstatssheettsx--every-token-this-desktop-has-used).

### `usagesources.ts` and `usagesourcelog.ts`

- `usagesources.ts` — **usage readings PER SOURCE: claude's, then every contributed probe.**

  Asked 2026-10-15: one chip segment per account that has a reading (Claude, Copilot, any plugin),
  a source with nothing to say drawing nothing. claude's `/usage` scrape could not simply become
  "one of the sources": its `UsageInfo` is read by three host decisions (the budget gate, the intent
  ladder's window conditions, the burn and session-budget calibrators) and by the public plugin API's
  `claudeUsage()`, and `usage.ts` is pinned against growing. So the registry wraps
  `UsageChecker.get()` through the shared `claudeReading()` and puts the LIST beside it —
  `usage.status` keeps `usage` and gains `readings` (additive; `PROTOCOL_VERSION` stays 2; an older
  host's frame without it is adapted on the phone). `createUsageSources()` gives `main.ts` ONE publisher, called by
  claude's callback and by the registry's `onUpdate`, so two publishers in one tick both carry the
  whole list and the phone's last write wins.

  A probe (`api.usageProbe`, plugin API 1.7) answers a `UsageReading` or null. **Null is ABSENT**
  (the source leaves the list — never `pct: null` with nothing beside it); **a throw or a timeout
  keeps the last reading** until its windows reset, one log line per source until it recovers —
  `UsageChecker`'s last-good-reading rule — **except a window that names NO reset**, which is
  dropped once it is 24 h past its last successful probe (`readingAfterAge`, `KEPT_UNNAMED_MAX_MS`;
  the drop is published). Copilot's quota may omit its reset date, and a probe failing for days (gh
  signed out) drew a three-day-old `5% mo` as today's; absent beats that. Claude's reading is not
  aged — its readers have `BUDGET_STALE_MS`. Every answer is VETTED: the identity is the definition's
  (a probe cannot speak for another source), a percentage outside 0..100 or a count with no limit
  is dropped, a future `checkedAt` is not believed. One probe in flight per source; the phone's
  `usage.refresh` asks behind claude's TTL, a null or failed answer is not re-asked within a minute.
  Polling is OFF by default and follows the predicate claude's `/usage` poll uses ("something gates
  on usage") — never a bare timer, because a probe spawns something (`gh` for Copilot). Boot re-offers
  each source's last kept row as `remembered` once its probe registers, only for windows whose named
  reset is still ahead, keeping the row's own instant. `packages/host/test/usagesources.test.mjs`;
  the plugin seam in `pluginseam.test.mjs`.

- `usagesourcelog.ts` — **those readings kept, one `usagelog-<source>.jsonl` per source** (the id
  escaped one-to-one, `_`→`__` and `:`→`_c`, so `a:b` and `a_b` never share a file).
  `usagelog.ts`'s rules and knobs exactly — the knobs are `USAGELOG_KNOBS`, read once there (dropped when nothing parsed, a repeat every REPEAT_MS,
  CAP and RETAIN, corrupt lines skipped), in a file of its own so claude's `usagelog.jsonl` and its
  route stay byte-for-byte as they were — **no migration**. A row on disk keeps the window's unit and
  count beside the wire sample's three fields, so the boot re-offer can draw the chip's text; the
  route `GET /api/usagelog/:source` answers the wire `UsageSourceHistoryDoc` and a 404 in words for
  claude or a source never kept. Flushed on SIGTERM after `usagelog.ts`.
  `packages/host/test/usagesourcelog.test.mjs`.

  **Copilot** is the first probe, an in-repo extension (`packages/extensions/copilot-usage/`,
  host-only): `gh api /copilot_internal/user` — measured on this desktop to answer the plan, the
  monthly reset and per-kind quota snapshots with gh's keyring token, no new credential. It is an
  INTERNAL endpoint, so the parser names each field it reads and anything else is null. It registers
  only with `copilot` on PATH, so a desktop that never runs Copilot never spawns `gh`. **A plugin
  backend billed by its own provider keys contributes nothing yet**: there is no account quota to
  read, and a dollar sum with no cap has no hot state.

### `costwindow.ts`

- `costwindow.ts` — **the token ledger folded over any span: `GET /api/costwindow?from&to`.**

  Why it exists: on 2026-10-09 the weekly figure stood at 32% thirteen hours after its reset, and
  the cost view could not say where it went. Read off the logs at list price that week was about
  $470 API-equivalent in 13 h; one architect-review fan-out over ~36 repos was ≈48% of it, two
  garmin-monorepo sessions ≈41% (92% of those subagents, mostly Opus), subagents 73% overall.
  `TokenStatsDoc` could show none of it: its repo rows and its costliest list are all-time, its
  hour rows carry no conversation, and under a live window the repo list could only say it was
  not answerable. The store (`tokenstats.ts`) already keeps every hour of every file crossed by
  model, so any span is a fold over that map and not a second scan.

  **The fold prices exactly as `aggregate()` does** (per model and day), and the e2e pins a span
  covering the whole fixture to the all-time fold to the cent. **The hour rule is repeated, not
  re-decided**: an hour is the finest bucket on record, so the phone sends a window's `from` already
  on its `windowStartHour` (`windowCells`' rule) and the fold's `hourFloor(from)` is the identity;
  for a raw instant (the burn push) the document says how much wider than asked it came out
  (`fromHour`). Tokens no list price covers go to `unpriced`, never charged zero. A subagent log
  folds into the conversation `fileKey.split("/")[0]` names, the parent's worktree names the repo
  (`repoOfWorktree`, which moved here from `tokenstats.ts` and is re-exported, so the two modules
  import one way only), and a log with no cwd is "unknown repo". `TokenConvo` rows gained
  `agentByModel` for the "Opus subagents: N%" sentence. A span that is malformed or wider than 35
  days answers an EMPTY document, not a 400 (`/api/tokenwindows`' rule).

  **`costMeta` joins names; the ledger stays the source.** Titles come from the roster (live
  `sessions.list()`, else the closed stack's `tabTitle`/`title`, live wins, newest closed wins);
  launches come from how the session was opened (`originOf`), and a fan-out target's `itemId` is
  `${runId}#${n}`, so the run is `itemId.split("#")[0]` and its label is the run's intent row
  (a scheduled sweep's id `${id}@${startedAt}` is looked up by the part before the `@`). Closed
  sessions are in because the logs are every conversation on disk and a session that ended an hour
  ago is the likeliest answer to "where did it go". A lookup that throws leaves the field absent: a
  missing name is a row labelled `repo · id8`, a failed read would be a card with nothing on it.
  **Known edge**: the closed stack holds 120 rows, so a conversation older than that has no title or
  launch. It groups as `unrecorded` — worded "no launch record", never "by hand": the daemon's own
  `claude -p` spenders land there too, and calling those a person's sessions was a wrong reading,
  not a missing one. `archive.ts`'s first-prompt index is the follow-up if that matters. Peak
  context per conversation was planned for the row and dropped (the wire field stays optional and
  unset). **A launch row's kind is the RUN's** (`runKind`): a key that is a fan-out runId is a
  fan-out even when its dearest target was resumed at reset, and an item's resume never renames
  the item.

  **The cap** (`COST_CONVOS_CAP`, 60): a real week was 591 conversations and 782 KB, nearly all
  of it per-conversation hour and model splits. The dearest 60 ship whole; the rest fold by repo ×
  launch into `rest` (`CostConvoRest`: a count and the sums, no ids), with `convosTotal` for the N
  of "n of N" and `CostHour.restConvos` per hour. Hours, totals and every `byRepo` count them
  already; `foldLaunches(convos, rest)` and `rankRepos(convos, rest)` add them back so a fan-out of
  forty cheap targets is still the dear run it was. **No hour names a folded id** — the phone's
  `convoIds` are built from carried rows, and `weekCut.restText` says what each list is hiding.
  A folded run keeps only the run's own launch fields (one target's `itemId` or model is not the
  run's). All three fields are optional, so an older phone parses the document and simply lists
  the 60. `filterText` reads the bucket's own `t`: the key is host-local, and re-parsing it on a
  phone in another zone printed a second clock beside the strip's.

### `burnwatch.ts`

- `burnwatch.ts` — **a push when the weekly figure climbs fast, not a hold.** The same ask
  wanted something that says so while the week burns, not after. `shared/burn.ts` owns the rule:
  the readings are cut into reset-bounded stretches by the SAME segment rule the usage chart uses
  (`usageSegments`, lifted out of the chart kit so a push and a drawn line cannot disagree about a
  rollover), the climb over the last three hours is a rate, and `burnVerdict` applies the
  threshold, the cooldown and "never twice for one stretch". This module is plumbing: read the
  kept readings, ask the verdict, look up the dearest launch in the stretch from the cost fold,
  notify, remember.

  **It pushes and never holds.** Nothing applies itself, so a fast burn is a sentence a person acts on: the words end "Nothing was paused." and the kind is default-on because it fires at most
  once per cooldown. `WATERPLANE_BURN_PTS_PER_HOUR` (default 4, 0 = off) and
  `WATERPLANE_BURN_COOLDOWN_MS` (default 3 h). **No timer of its own**: `UsageChecker`'s callback
  drives `observe`, and rides the same irregular readings the chart does. That callback only fires
  while something polls, and at first nothing polled for the burn push — it spoke only while a
  plugin, an armed budget or a %-budget session happened to keep `/usage` warm, and `burnStretch`
  needs two readings 45 min apart inside 3 h. So `syncUsagePolling` also polls while `armed()`
  (threshold > 0) and the `burn` kind is not muted (`notify.prefs.set` re-syncs it). The poll is
  the existing one: a short-lived `claude` PTY reading the `/usage` screen every `USAGE_POLL_MS`
  (8 min), no model call — the same cost the budget already pays by default. The state
  (`burnwatch.json`: last push, last stretch's start) is written BEFORE the push, so a crash loses a push rather than repeating one. A cost fold that cannot be
  read costs the push only its "dearest in it" line. The points clause calibrates over an 8-day
  cost window, not the stretch (a calibration needs 6 h+ stretches with cost in them) and is
  simply absent when `ptsCalibration` refuses.

### `budget.ts`

- `budget.ts` — **the ceiling before the wall.** Stores the usage budget (`.waterplane/budget.json`,
  tmp+rename, clamped on read) and is the ONE place that asks `shared/budget.ts`'s rule. Two
  consumers, both of which start work with nobody present: `backlog.ts`'s auto-fire (gated
  account-wide ABOVE every per-item and per-session condition, and its `waiting()` says so in the
  same words) and the phone's send queue (`selectSendable`'s `budgetBlocked` — an explicit *send
  now*, an ANSWER to a live box, and UPLOADS are never held, because the budget stops unattended
  work and not a person, an unblocking keystroke, or bytes that cost no tokens). Held entries are
  parked like `serial`: clock stamped forward, so waiting out a session window cannot expire the
  queue. Host-side rather than synced settings because the backlog fires with no client attached at
  all. `usage.ts` polling is now driven by this too — a gate reading a cache nobody refreshes goes
  stale in 25 min and fails open for ever, i.e. a safety switch that quietly does nothing.
  `e2e-budget.mjs` (`scripts/claude-stub-tui.mjs`'s `STUB_USAGE=<sess>,<week>` renders a
  parseable `/usage` screen — the only way to drive the real scrape end to end).
  `ceilings()` is `shared/budget.ts`'s `budgetCeilings`: every tripped ceiling, session first, the
  per-window truth `verdict()` is the first line of — the ladder needs it to lift a before-reset row
  from its own window's cap and still hold it on the other's. `main.ts`'s `budgetDetail` is now
  `budgetHoldText` of the first one: its private *resumes* clause printed
  `toLocaleTimeString()` alone, and for a weekly reset days out a bare time reads as *today*;
  `budgetResumesText` names the weekday when the reset is not on the host's current local day.

### `sessionbudget.ts` — a session's own budget

Asked 2026-10-01: a cap on ONE session, subagents included, settable on a live session, at launch
and on scheduled work, in tokens, dollars, or percent of the 5-hour or weekly window. The account's
`budget.ts` above is untouched — that one pauses AUTOMATIC work everywhere near the wall; this is a
number a person put on one conversation.
The pure rule is `shared/sessionbudget.ts`; the host half is three pieces.

- **The judge, `sessions/budgetwatch.ts`** (`BudgetSlice`). Spend is the session's own TOTAL, the
  figure the reply footer already prints: `ContextSpark.usageTok`/`costUsd`, which carry the
  subagents (`ctxlog.ts`'s `agentUsage`). Compared as a total, never a delta, so a restart cannot
  reset a session's account. The verdict is re-derived at the end of every `refreshSpark` — the one
  per-session cadence, and the right one because the verdict moves with the CLOCK too (a usage
  reading going stale turns a percent verdict `unknown`) — when a person sets a cap, and when a new
  calibration lands. The cap and its verdict live on `info.budget`, the one copy; it reaches the
  phone on the ordinary `session.updated` and the `live/` record keeps it across a restart.
  `persistLive` takes the budget off the LIVE session rather than from the record it was handed,
  because `convid.ts` rewrites that record field by field on every id adoption and would otherwise
  delete a cap it has never heard of.
- **Only the crossing is an event.** `budgetTripped` fires on the edge into `over` and the latch
  (`Session.budgetTripped`, persisted beside the cap) holds it; re-judging a session still over says
  nothing. The latch clears on `ok` or on a NEW cap, and deliberately not on `unknown`: a reading
  that goes stale for twenty minutes and comes back is not a second overspend, and a second
  crossing would be a second notification and a second Esc for one event. A restart keeps the latch
  for the same reason. **Unknown never trips** — an unpriced model, no reading, a stale one, a window
  too young to calibrate: each is `unknown` with its `why`, and `sessionBudgetHeld` is false for
  all of them. A wrong "over" stops work a person asked for; a missing one only delays the cap.
- **What a crossing does** (`server/sessionEvents.ts`). Sends are held by the shared predicate on
  both ends — the phone's queue (`budgetHeldLanes`) and the intent ladder (`budgetHeldSessions`,
  supplied by `intentDeps.ts` off `sessions.list()`, read by `ladder.ts`/`requeue.ts`: a row aimed
  at that session waits `sessionBudget`; a repo or fresh target is untouched; `runNow` is a tap and
  fires anyway). A notification says so (`Session budget hit`, `sessionBudgetText`, tag
  `session-budget:<id>`), and — per-budget `interrupt`, default on, and
  `WATERPLANE_SESSION_BUDGET_INTERRUPT` not `0` — ONE Esc is written into the running turn.
  **The Esc is OWED, not attempted once** (`Session.budgetEscOwed`, persisted in `live/`): set at
  the crossing when the budget interrupts, re-asked on every judge while still over
  (`budgetEscDue` — `refreshSpark` runs on the sweep, so a few seconds apart), and settled by the
  Esc going out, a person's own send (`deliverInput` — they chose to let it work), `interrupt`
  switched off, a new cap or `ok`. The one-shot version asked at the crossing INSTANT and, with
  no turn there, never again: on 2026-10-12 a session crossed $150 right after a limit resume, no
  Esc, and worked on to $178+. A late Esc is said once (`Session budget · … interrupted`).
  **The Esc is gated, never assumed** (`budgetEscBlocker`): the running turn is proven on the
  LIVE grid (below), NOT by the hooks — it used to need `turnFromHook`, and the turns that
  overspend most never have one (driven by background agents' task notifications, which fire no
  `UserPromptSubmit`; or already running when the daemon restarted); never at a choice box or an unparsed dialog (`prompt`/`awaitingInput` — Esc
  there DECLINES, a decision nobody made); never while a delivery into that session is still
  unconfirmed (`opendeliveries.ts` — an Esc at a composer holding those words is the deletion
  `deliver.ts`'s miss sweep is forbidden). **And then the screen, in the write's own tick**
  (`budgetEscScreenBlocker` over `sessions.liveGrid`, the recorder's VT): `prompt`/`awaitingInput`
  are the detector's LAST reading, and a permission box painted inside its debounce window is on
  screen and not yet in them — so the live grid must show `workingLine` NOW and no box by any of
  `detectPrompt`/`dialogEvidence`/`dialogStillUp`; an unreadable grid refuses. Each refusal is the
  sentence the notification carries instead. The latch clears on `ok` or a new cap (`unit`/`max`),
  never on flipping `interrupt` alone — that would tell the same crossing twice, or Esc late. It is a raw `sessions.write`, not
  a delivery — there is nothing to echo or confirm — so `deliver.ts` is not forked. That an Esc
  mid-turn interrupts is this repo's own measurement (`deliver.ts`, the miss sweep and `ranAnyway`
  ordering); the stub TUI cannot show it — its Esc is a no-op and its turns end on their own
  schedule — so no e2e pins the interruption itself, only the gate (`sessionbudget.test.mjs`).
- **The calibrator, `sessionbudget.ts`**, for the percent units. A percent budget is the session's
  own DOLLARS converted at the window's dollars-per-point: for each `/usage` reading — asked of the
  usage cache once a minute from `server/sessionEvents.ts`, not from main.ts's usage callback as
  planned, because main.ts is at its line ratchet and a minute of lag on a calibration is nothing —
  ONE `windowSeries` over the token ledger with two grids, each from the window's opening
  (`resetAt − 5 h | 7 d`) to the reading's `checkedAt`; its newest cell's cost ÷ the pct the screen
  showed at that instant is the figure — `weekUsdPerPct`'s rule (R-usage-018) for both windows, with
  `SESSION_BUDGET_CAL_MIN_USD` as a floor so a window that has barely run calibrates nothing. The
  ledger buckets by HOUR, so the 5-hour figure is up to an hour wide and every percent is worded
  "≈". Cached on `checkedAt`; a failed fold keeps the last figure, which then goes stale on its own.
  It **never spawns a scrape**: `syncUsagePolling` gains a third reason to poll — a running session
  with a percent budget (`sessions.wantsBudgetUsage()`, re-asked on `session.budget.set` and on a
  budgeted create) — because a calibration nobody refreshes is a cap that silently reads `unknown`.
  The figure reaches the phone as `SessionInfo.budget.cal`, on every budgeted session.
- **Where a budget comes from.** `session.budget.set` (not durable, never queued: a cap delivered
  late would hold or release a session on a figure the person has since changed; idempotent; garbage
  refused in words; `null` clears). At birth: `session.create`, `backlog.add`, `fanout.run` (each
  target), the agent routes, and scheduled `backlog`/`fanout` actions — an explicit `budget` field
  threaded exactly like `closeWhenDone`, NOT a `LaunchOpts` field, because `openItemSession` passes
  no launch. `upsert()` carries it when a draft is silent (a re-time from an older bundle must not
  delete it), `workItemInherits` hands it to a recurring rule's child, `postClientDraft` passes it
  through. A fork does not inherit one, and a reopened closed row starts without one.

### `notifyprefs.ts` and the small stores

- `push.ts` · `notifyprefs.ts` (**which notification KINDS may fire at all** — `.waterplane/notify.json`,
  checked inside `notify()` before the feed entry AND before the push, since muting only the display
  still buzzes the phone. Host-side rather than a synced `waterplane.*` key because `settings.ts` stores
  opaque strings the daemon never parses. Sparse, so a kind added later arrives with its own default;
  `idle` — the per-turn "Turn finished" ping — is the one kind OFF by default, because it fires once
  per turn per session and buried the two kinds that need a human. A payload carrying `pull` bypasses
  the gate: that push is auto-download's transport, not an alert. `e2e-notifyprefs.mjs`) ·
  `decisionlog.ts` (decision log) · `sentlog.ts` (audit of everything typed into a session:
  one entry per semantic command, verdict kept — and CORRECTED when the sweep later proves what
  became of an ambiguous one (`recordSettled`, via the row's `sentId`), beside `result` and never
  instead of it. This file is what "what happened to my deliveries" is read out of, so a log that
  only ever hears the echo window's opinion does not lose a detail, it manufactures a failure rate) · `settings.ts` (user-following settings, opaque
  values, last-write-wins on client `ts`, allow-list) · `scaffold.ts` (new repo = initialized
  project) · `repos.ts`/`discover.ts` · `git.ts` · `transcript.ts` (reader-view source, parses the
  CLI's own conversation jsonl, 204-on-unchanged; the default document is **lite** — tool
  inputs/results are ~all the bytes, so they stay here behind `omitted` and one turn's set comes
  back from `/api/transcript/tools`; `?detail=full` is the whole thing) · `slash.ts`.

### `files.ts`

- `files.ts` — inbox uploads (any kind), artifact gallery, traversal guards. **`DISCOVERABLE` ≠
  `VIEWABLE`**: source/config extensions may be *served* but must not flood discovery. `.env` refused
  everywhere. `x-dedupe` makes queued uploads re-sendable. Outbox = `OUTBOX_SUBDIRS`. The repo
  count badge is `countOutbox()` — UNSEEN OUTBOX files (`.seen` marker, cleared by opening the tab),
  never the inbox: the badge asks "did an agent leave me something", and the inbox is what this
  phone uploaded. A count opens the tab AND the window it was counted over (`initialAllTime`) —
  a badge that opens on an empty grid is worse than no badge. `e2e-outboxbadge.mjs`.
- **`listTransport` + `sweepTransport` — the bulk cleanup** (`SweepSheet.tsx` is the screen; the
  rules and the sentences are `shared/sweep.ts`). Two things they do NOT inherit, both of which are
  silent when wrong:
  - **A sweep lists more than the gallery does.** `discoverArtifacts` filters by extension because
    it answers "what can the phone PAINT". A cleanup asks the opposite question — what is taking up
    room — and transport directories here hold `.zip`, `.log`, `.json` and the odd `.tar.gz`, none
    of them `DISCOVERABLE` and all of them bytes. A sweep that inherited that filter would report a
    directory clean while leaving most of it on disk. Dotfiles stay out, and `.seen` is the reason:
    deleting the marker would silently un-read every artifact in the repo.
  - **Containment is `deleteArtifact`'s, unchanged.** Every removal in the bulk path goes through
    the one guarded delete this daemon has — resolved path, inbox-or-outbox only, files only. A
    second `rmSync` would be a second place to get the traversal check wrong, and this is the path
    reached over HTTP with a client-supplied LIST of paths, which is exactly the shape that guard
    exists for (`artifactdelete.test.mjs` is why the guard resolves before it compares).

  It takes PATHS and never an age: the phone sends the rows a person looked at, and re-deriving that
  set here would delete files that were never on their screen. The outcome splits `missing` (already
  gone — the sweep succeeding by another route) from `failed` (refused or un-removable, i.e. bytes
  still on disk), which needed `contained()` rather than `resolveInTree()` — that one folds "escapes
  the tree" and "is not there" into the same null, and those are the two outcomes this function
  exists to tell apart. Sizes are read BEFORE the unlink or the byte total is always zero.
  Routes are `GET /api/repos/:id/sweep?scope=` (the plan, writes nothing) and `POST` the same path
  (deletes, capped at `SWEEP_MAX` paths and REFUSED IN WORDS past it rather than truncated — a sweep
  that silently dropped the tail would report success over files it never touched). The POST answers
  200 even with failures: the body says what became of every path, and a non-2xx would make a
  partial success indistinguishable from a refusal on the phone. `sweepfiles.test.mjs`.

### `transportsurvey.ts` + `hoststore.ts` — the same question, one level up

The sweep above answers "what is in THIS repo's outbox?". Two questions it cannot answer came out of
the measurement that motivated it — 7.5 GB across fourteen repos, 4.5 GB of it in one — and both are
about the desktop as a whole.

**`transportsurvey.ts` — which repo.** `SweepSheet` is reached from one repo's gallery, so using it
means already knowing which repo is fat; fourteen trips to find out is not a cleanup tool. The survey
is every discovered worktree ranked by what its two transport directories hold.

It **walks nothing of its own**: every tally is `listTransport`, the same function the per-repo sweep
serves its rows from. That is not tidiness — the survey row is what a person TAPS to open that sweep,
so if the two ever came from different code the row would say 38 files and the sheet would show 39,
and a person would learn to distrust both. `scripts/e2e-storage.mjs` asserts the two are byte-equal,
which is the only assertion in that script that could not be made without a real host.

Two bounds, neither of which today's numbers need. `listTransport` is synchronous `readdir` +
`lstat` and this runs on the loop that pumps every PTY; the measured worst case is a 523-file inbox
across fourteen repos, i.e. milliseconds. But nothing stops a repo holding a hundred thousand files
and a phone asking for this whenever it likes, so: an **entry budget past which that repo's tally is
`null`, never a partial count** — a truncated count printed as a total is the wrong number CLAUDE.md
forbids, and it is worse here than usual because the number's whole job is to say where to go and
delete things — and a **yield between repos** so a pathological tree cannot stall a keystroke on its
way to a session. The budget is deliberately not an env knob: a survey that counts a different amount
on two desktops is a survey whose "not counted" row means something different in every bug report.

Nothing is cached, host-side. The walk is cheaper than a stale answer is worth, and a cached byte
total on a screen about deleting is the reading most likely to be acted on and least likely to be
true. The phone reads it through `useRemoteResource`, so a cached copy there says its own age.

**`hoststore.ts` — the daemon's own store.** `<root>/.waterplane` is 28 MB here, 21 MB of it the thumbnail
cache, and the interesting half of that answer is WHY it is not more: almost everything in it is
already bounded by whoever writes it — `sentlog.ts` a 1000-entry ring, `decisionlog.ts` a 500-entry
ring, `limit-events.jsonl` a 256 KB rotation, `usagelog.ts` 5000 rows / 30 days, `history/` and
`summaries/` a boot sweep behind a 7-day gate and an alive-set guard, `thumbs/` a 256 MB prune. So
this module is the REPORT that makes those bounds visible, and the finding inside it: `tokenstats.json`
is the one store with no bound of its own.

What may be removed is exactly two things — the thumbnail cache (a cache, whose owner re-makes and
already prunes it) and the migration leftovers (`*.json.bak`, `*.json.migrated`, copies a one-time
upgrade took whose live files have been rewritten hundreds of times since). Everything else is
reported with a **`cant` naming its own bound**, which is what makes those rows readable as "already
handled" rather than as something the screen forgot to offer. A ledger is history, not a cache:
deleting `usagelog.jsonl` costs the record, not a re-read. Live state is worse — `acks.json` IS the
at-most-once memory, so losing it can make a queued prompt run twice, which no amount of space is
worth. And a file the catalogue does not name is `unknown`: counted, shown, never touched, because a
sweep that removes what it cannot identify is a sweep that removes the next feature's store. The
catalogue is a fixed list and the FALLBACK is `unknown` on purpose — a new store that landed in
`live` by default would be described to a person as something it may not be, and one that landed in
`rollback` by default would be deleted.

**Containment here is not `contained()`, and that is the part worth reading twice.** This directory
is not inside a repo worktree, so the guard every transport delete goes through does not apply. What
replaces it: **no path ever arrives from the client** — a clear request carries a catalogue id and an
instant, and every filename is derived here from `join(root, ".waterplane")`, the same expression every
store constructor uses, with `root` the daemon's own configured root and never a request field. Names
are **matched against a strict regex, never sanitised** (`sessions.ts`' `STORE_FILE_RE` posture), so
`..json.bak` is not a leftover that got cleaned up, it is a non-match. `lstat`, files only, symlinks
skipped, no recursion into anything unnamed, plus `inRoot()` as the realpath-resolving belt because
`<root>` itself may be a symlink — which is exactly why `paths.ts` has two guards and not one.

**`at` is the contract**, the way the sweep's list of paths is. A person read a report taken at an
instant; nothing written since goes. The transport sweep sends its rows because those rows ARE the
decision; here they are not — nobody chooses which thumbnails to keep — so the same promise is kept
with one number instead of a 1541-name request body.

Routes: `GET /api/storage/transport`, `GET /api/storage/host` (reads, so GET is correct) and
`POST /api/storage/host/clear` (deletes, so never a GET — CLAUDE.md, and what stops a cross-origin
`<img src>` from firing it). They sit outside the `/api/repos/` prefix because `api.ts` reads the
segment after it as a repo id. The clear answers **200 even when it refuses**: the refusal is a
sentence a person is meant to read, and a non-2xx collapses it into the phone's generic error state.
HTTP rather than a durable WS op, on `repohealth.ts`' reasoning — it types into no session, it is
idempotent by construction, and a clear delivered an hour late clears bytes nobody is looking at.
`hoststore.test.mjs` · `transportsurvey.test.mjs` · `scripts/e2e-storage.mjs`.

### `localrt.ts` — what the LOCAL model runner is holding

A hosted model's cost is a number on somebody's invoice. A local model's cost is this machine: 18 GB
resident for `qwen3-coder:30b`, 9.2 GB for `gemma4:e4b` (both measured), on a desktop carrying 26 GB
of `claude` processes and a nearly-full swap file before anybody asked it to think. From a phone that
cost was completely invisible — a session works, and nothing says the machine just paged in 18 GB.

Measured from ollama's own `/api/ps`: which models are RESIDENT, bytes held, the VRAM split, and when
the runner intends to evict them. Measured from the OS: CPU and memory, and — Apple Silicon only, via
`host.ts`'s `readGpuStat`/`parseGpuIoreg`, off `ioreg -r -d 1 -c IOAccelerator` — GPU utilization and
GPU memory in use. **Both GPU keys are read from ONE `PerformanceStatistics` block, and only when
there is exactly one**: a two-accelerator box (an Intel iGPU+dGPU pair, a Mac Pro) prints a block per
device, and matching each key independently over the whole dump could pair one device's utilization
with the other's memory figure — a composite neither device reports, so several blocks answers `null`,
the same as none. All local, all cheap, no tokens.

**The distinction the whole readout rests on: `reachable: false` is not an empty model list.** "The
runner answered and is holding nothing" and "nobody answered" are opposite facts, and a strip that
collapsed them would report a missing runner as an idle one. `parsePs` degrades every field
independently — no name ⇒ the row is dropped, an unreadable size ⇒ 0 rather than a `NaN` that
poisons every total drawn from it, an unparsable `expires_at` ⇒ ABSENT rather than a guessed instant.

**Watching is a LEASE, not a subscription** (`LEASE_MS` 60 s, renewed every 25 s by the phone). The
route table has no socket-close hook, so watch state must not be able to outlive its socket; a client
that stops renewing simply lapses, costing at most one lease period of extra loopback GETs — the
cheap direction to be wrong in. A set the host prunes on close is a leak the day a close event is
missed. The poll runs only while a live lease exists and **stops with its last watcher**; `dueWatchers`
is the pure half so renewal, lapse and empty-stops-polling are pinned with no daemon. `WATERPLANE_LOCAL_RUNTIME=0`
answers a one-shot `disabled` frame and never polls — "polling is off here" is a different sentence
from "the runner did not answer", and the wire keeps them apart with their own field.

**Five seconds, and the reason is the events.** What this catches is model load/evict (ollama's
`keep_alive` default is 5 minutes) and memory pressure. Neither moves sub-second. The link probe's
faster cadence answers a different question.

**The host keeps NO history** — it emits samples, the phone keeps the ring (`link.ts`'s pulse split:
a ring buffer on the host is a second copy of a series the phone is already drawing).

**Tokens per second is absent and must stay absent.** Nothing this host can read publishes it, and
the available estimate — PTY bytes over wall clock — is wrong in both directions that matter: a TUI
repaints, so screen bytes are not output tokens, and a model thinking emits nothing while doing the
expensive part. F2 in `open-sourcing.md`. `packages/host/test/localrt.test.mjs`,
`packages/host/test/gpustat.test.mjs`.

### `sysstat.ts` — the machine, the way `top` would have told you

The sheet above said **"memory free 1.1 GB of 64.0 GB"** on a desktop holding NO local model at all,
and had nothing to say about who had the other 62.9 GB. Both halves of that were bad. `os.freemem()`
on macOS counts genuinely untouched pages, so a healthy Mac with a warm file cache reports almost
nothing free for ever — measured here the same minute: 1.0 GB free, **33.2 GB available**, 15.1 GB of
it file cache the OS hands back the moment anything wants it. And the question the number provokes —
*then WHO has it?* — was unanswerable anywhere in the app. (It was 23 `claude` processes holding
11.7 GB, 11 `opencode` holding 3.9 GB.) `cpuPct` had the same shape of problem: it is the one-minute
load average over the core count, which is a QUEUE LENGTH, not utilization, and reads well past 100%
on a busy build. So both travel now, worded apart, and neither replaces the other.

Four readers, each independent, each degrading to an ABSENT field and never to a zero:

- **CPU** — `os.cpus()` tick deltas, pure node, no subprocess. `cpuBusyFrom` is the pure half:
  cumulative counters, so `nice` goes in with user and `irq` with system (a machine running a `nice`d
  build otherwise reads as idle), a changed core count or a counter that went backwards answers
  `null`, and **the FIRST reading of a process has no interval to describe** and therefore no split.
- **Memory** — `vm_stat` + `sysctl vm.swapusage` on macOS, `/proc/meminfo` on Linux. **The page size
  is read from `vm_stat`'s own header, never assumed**: 4096 on Intel and 16384 on Apple Silicon, and
  hard-coding either is a 4× error on half the fleet. `usedBytes` follows Activity Monitor — app
  (anonymous minus purgeable) + wired + what the compressor OCCUPIES, never what is STORED in it,
  which is the compressor's win and not a cost. Linux gets `MemAvailable` — the kernel's own
  estimate — and **no invented app/wired/compressed split**; the phone words the caption off `source`.
- **Processes** — `ps -Ao pid=,rss=,pcpu=,comm=`, **folded BY PROGRAM**. The fold is the feature: the
  honest answer to "what has my memory" is one browser wearing twelve renderers, and twelve identical
  rows say it badly while pushing everything else off a phone screen. `procs` carries the count and
  `pid` survives only on a fold of one, because a pid beside a fold of twenty-three names whichever
  process `ps` printed first. RSS **counts a shared page once per process holding it**, so
  `rssSumBytes` ships too (38.3 GB over 830 processes on a 64 GB machine) and the phone says that out
  loud rather than letting somebody total the column and conclude their desktop is overcommitted.
- **Temperature and fans** — Linux reads `/sys/class/thermal` + `/sys/class/hwmon` directly, no
  subprocess. **macOS has no unprivileged reader and the absence is deliberate**: measured on this
  desktop, `powermetrics` answers `powermetrics must be invoked as the superuser`, and `--samplers
  smc` does not even exist on Apple Silicon. A daemon whose job is spawning `claude` must not prompt
  for a root password, and `sudo -n` in a poll loop is a password prompt waiting for the timestamp to
  expire. Reading the SMC without root takes a third-party helper, and which one (and how it is
  built) is not core's to choose: a **plugin contributes the reader** (`api.thermalReader`, 1.3) and
  core only checks its figures (`cleanThermal` — a `0.0` from a sensor that has not answered yet, or a
  digit lifted out of an error message, is dropped, never drawn). With none, the field is absent with a
  SENTENCE (`MAC_THERMAL_NOTE`) saying a plugin fills it in — **this repo's rule is that a heuristic
  degrades to absent, and the corollary nobody writes down is that an absence a person cannot explain
  reads as a bug in the app.** (Until 2026-10 core shelled out to `smctemp`/`istats` itself; on an M4
  Max that read `smctemp -f` — fail-soft mode — as the fan list, and took the first digit of
  `smctemp -g`'s "In M2 Mac…" error as a 2 °C GPU.)

**Cost.** This runs inside `localrt.ts`'s 5 s watch, in the process that pumps every PTY, so the two
expensive readers are on a slower cadence of their own (`WATERPLANE_SYSSTAT_SLOW_MS`, 15 s, floored at 5 s)
and cached between: a full `ps -A` measured 31 ms over 793 processes, a cached sample 2.3 ms. **The
cached rows carry their OWN timestamp** and the phone says the age — a 14-second-old table drawn as
current is the stale-presented-as-live failure the whole strip exists to prevent.
`WATERPLANE_SYSSTAT_PROCS=0` stops sending program names at all, and the section then says it was switched
off rather than that nothing is running. `packages/host/test/sysstat.test.mjs`.

### `localusage.ts` — what the LOCAL runner did, kept

`localrt.ts` says what the runner is holding NOW and keeps no history; this keeps what it DID —
compute time, tokens and memory per model per day — for `GET /api/localusage` and the token-stats
*Local runner* tab. Measured first (2026-10-02, Ollama 0.35.0 at its default INFO log, `OLLAMA_NUM_PARALLEL:1`,
`qwen3-coder:30b-64k`): the log's timing block matched the native `/api/chat` fields exactly for the
same request, and its format was identical across all five rotated logs.

- **Sources are passive.** None of the APIs the backends use (`/v1/messages`, `/v1/responses`,
  `/v1/chat/completions`) carries the runner's durations, and reading their responses would sit in
  their path. Ollama copies `llama-server`'s `print_timing` block into `server.log` at the default
  level — prompt tokens processed + time, tokens generated + time, exactly the native `/api/chat`
  fields — and closes each request with a `[GIN]` line (path, wall time). Tailed incrementally
  (`parseRunnerLog`), up to a COMMIT POINT only (a timestamped line with no block open or waiting),
  so a chunk ending mid-request is re-read, and the cursor (first-line hash + byte offset) is saved
  with the data: a restart neither loses nor re-counts. A rotation (`server.log` → `server-1.log` on
  every ollama start) is followed by finishing the old file first. **No measuring proxy** in front of
  `:11434`: it would sit in every session's request path, and measuring must never break or slow a
  session. Revisit only if a future Ollama stops copying `print_timing` into its INFO log, and then as
  an opt-in nothing depends on.
- **Runner time and time to answer are never one number.** Busy = prompt processing + generation;
  loading is its own line (`llama-server started in`); time to answer is the `[GIN]` wall time, which
  includes waiting in the runner's queue (3.4 s of 3.65 s in the spike). A request with a `[GIN]` line
  and no block is counted as time-to-answer only; two blocks waiting for one access line keep their
  timings and drop the wall time (it belongs to one of them, unknown which).
- **The log never names the model, so ps does.** Nothing in it joins reliably: the registry name
  appears only on a `template selection` line whose place relative to a load varies, `keep_alive`
  expiries are not logged at INFO, an `evicting` line does not say which model, and two resident
  models' blocks interleave. `pickModel`: the models `/api/ps` showed from the last
  sample before the request's second to the first after it; one ⇒ it, several ⇒ the one whose context
  equals the block's `n_ctx_slot`, if exactly one; a load the samples do not explain, a sampling gap, or
  no sample after ⇒ **`model: null`**, its own row with one sentence (`UNATTRIBUTED_WHY`) — never the
  most-recently-loaded guess. Hence also **no back-fill**: the ledger starts when this host first
  watched (cursor at the log's END), because history has no ps samples to attribute it with.
- **Memory** is the ps samples (resident bytes, GPU share, context) folded as samples/sum/peak plus
  resident time (consecutive samples only, each interval capped at 3×), and `sysstat.ts`'s
  `sampleMemory` while a model is resident (used/available/swap — on Apple silicon a Metal model is
  WIRED memory, not the ollama process's RSS).
- **Cost.** One loopback GET + one bounded async read of the log's new bytes per tick
  (`WATERPLANE_LOCAL_USAGE_MS`, 20 s; ×4 while ollama does not answer), the machine reader only while
  something is resident. `localusage.json` in the host store, 120 days, tmp+rename at most every 30 s
  (`hoststore.ts` lists it as a bounded ledger). `WATERPLANE_LOCAL_USAGE=0`/`WATERPLANE_LOCAL_RUNTIME=0` ⇒
  never started and the route says so; `WATERPLANE_OLLAMA_LOG` names the log (Linux has none by
  default — the document says so and memory is still sampled). Started from `main.ts` outside
  `--doctor`. `packages/host/test/localusage.test.mjs` (real 0.35.0 lines in
  `test/fixtures/ollama-server-log.txt`).

### `queuedTurns` — the prompt the CLI is holding

**The outline was not wrong about the log; the log was not the whole of what is known.** Reported
from a phone: *"the last thing I sent was accepted by the CLI and is worked on but it does not show
in the list"*, over an outline reading `2 turns`. The record settles it — in that conversation the
prompt rows run 05:48, 06:59, and then nothing until 08:04 UTC, while the screenshot was taken at
07:59. Nothing was broken: the TUI HOLDS a prompt typed into a session that is mid-turn. It sits in
the composer, visibly accepted, and the CLI writes to the conversation log only when it actually
starts it — here seven minutes later, behind a turn that ran 131 tools. Every reader in this app is
built on that log, so for those minutes the newest thing the person had sent was simply absent from
it, which reads as a list that is missing something rather than as a CLI that has not got there yet.
(An in-flight turn is NOT the case: the user row is written when the turn starts, verified against a
live log mid-turn — so this is about the window before the CLI takes the prompt at all.)

waterplane holds the other half of that record. `recordPrompt` writes a `HistoryEntry` for a delivery
whose text was SEEN in the composer, so a row there means *these words are in that session* and
never *this prompt ran* — which is exactly, and only, what the queued turn claims: `queued: true`,
no blocks, no tools, no summary, and the reader says *sent from this app · the CLI has not started
it yet* under it rather than leaving a turn with an empty body (which would read as an agent
answering with silence). It is `screenCommandTurns`'s sibling and deliberately not an extension of
it: a local command never reaches the log AT ALL, this one has not reached it YET, and the two need
different words on the row.

Three rules keep it from becoming a second, fictional conversation. It must be **newer than every
logged turn** — which is also what makes the list self-healing, since nothing has to retire a queued
row: the next logged turn ends its life, including for a delivery that echoed and was then cleared.
It must **not already be in the log**, matched on the squashed head (`echo.ts`'s own `squash`, one
opinion about whether a prompt has been taken) rather than on equality, because the log stores the
prompt with whatever the CLI appended to it — an image note, a pasted-file expansion — and equality
would draw the row a second time beside the real turn it has become. And it is **bounded** at five,
newest kept. The outline counts them APART (`2 turns · 1 waiting`): calling it three turns would
make the number the thing that is wrong. Both backends get it from one implementation — opencode's
store also records a prompt only once the binary takes it, so its reader was missing exactly the
same minutes. `packages/host/test/queuedturns.test.mjs`.

### `archive.ts`

- `archive.ts` — **every conversation the CLI ever wrote for a repo, read off disk.** Closing a
  session was never a delete: the PTY dies, the `~/.claude/projects/<slug>/<uuid>.jsonl` stays, and
  `--resume <uuid>` reopens it. What was missing is the ROUTE BACK — the reopen stack and the recent
  list are capped SHORTLISTS, and one bulk close of a busy repo retires more sessions than either
  holds. So this remembers nothing and lists the logs themselves (`readdir` + `stat`, uncapped, no
  bookkeeping to desync, nothing a restart loses); the filename IS the conversation id, which is what
  makes a row resumable. A repo here holds thousands of logs, so the TITLE (first user prompt, via
  `transcript.ts`'s exported `promptOf` — one rule, or an archive row ends up named
  `<command-name>`) is read only for the page returned, from a bounded head, memoized by id (a first
  prompt never changes). A `q` search is the one path that must title everything; that sweep warms
  the same cache. `deleteArchived` is the ONLY way to lose a conversation in this app — hence a
  separate verb from closing, a bare-id regex, and a per-row confirm on the phone. `e2e-archive.mjs`.

### `tree.ts`

- `tree.ts` — **the worktree as a tree, and the one place that WRITES a file back.** The gallery
  answers "what did an agent leave me" (flat, mtime-sorted, deliverables only); this answers "what
  is in this repo", which is a directory at a time, every extension, dotfiles included. Listing is
  lazy — one `readdir` per request, so opening `node_modules` is cheap — and the single recursive
  path (the `q` name search) uses `files.ts`'s `SKIP_DIRS`. Git marks come from one `status
  --porcelain` per listing, with an ancestor walk because porcelain COLLAPSES an untracked directory
  to one `?? src/` line; `ignored` is asked per listing with `check-ignore --stdin`, never
  `status --ignored` (which enumerates all of `node_modules`). A save must present `baseSha`, the
  sha256 of the bytes it read: the second writer here is an AGENT in the same repo, so last-write-
  wins would silently delete a turn's work, and a mismatch is refused `stale` (409) with nothing
  written. The corollary is easy to lose in a refactor — **a body we could not show in full (binary,
  or past `MAX_EDIT_BYTES`) carries NO `sha`**, which is what makes a prefix un-writable over the
  rest of the file. Creates nothing (missing path ⇒ refused), refuses `.env` both ways, tmp+rename
  carrying the original mode (a rename installs the tmp inode — a hook script loses its +x
  otherwise). `e2e-tree.mjs`.

### `builds.ts`

- `builds.ts` (per-repo build commands without a session — the rate-limit escape hatch. Keeps
  everything mechanical: the pty spawn with `CI=1`, the output ring and the streaming frames (keyed
  by `runId`, which IS the intent id, so `build.output` is unchanged), `cancel`, and
  `detectArtifacts`. The runs ring and its never-evict-a-running-run loop are gone — a run is a
  `{payload:"build", target:"shell"}` intent, and the store's compaction rule already refuses to
  evict anything unsettled; the config is snapshotted onto the row at fire time, because a run that
  renames itself when `builds.json` is edited is a lie about what ran. The
  sheet's **set up** button fires a predefined prompt in a real session that writes
  `.waterplane-shared/builds.json` itself (the committed file; `.waterplane/builds.json` only for a desktop-only path), since wiring one by hand means typing a gradle task on a phone.
  Artifacts are "what was written since the run started", which an INCREMENTAL build satisfies for
  nothing at all — a successful `assembleRelease` with 50 tasks UP-TO-DATE produced no file — so a
  run that touched nothing falls back to the newest matching deliverables, flagged `stale`: "here is
  the APK" and "this run made it" are different claims) ·
  `autopull.ts` (per-repo rule + host-wide persisted queue, `familyKey` newest-only supersede) ·
  `readtext.ts` (the highlighter's text reader; the Gemini second opinion that shared its key is a
  plugin now, [plugins.md](plugins.md)) · `meter.ts`/`usage.ts` · `context.ts` · `compliance.ts` (fixes only ever ADD) ·
  `setupwatch.ts` (**the checklist run on its own**: primaries swept on a timer, plus every
  `session.created`, so a repo nobody opened in the sheet still gets flagged. Verdict rollup on
  `RepoTarget.setup` → the launcher row's amber chip, and the repo menu's always-drawn
  `repo setup · N` entry for the repo with nothing to badge. **Never writes into a repo** — flagging is the
  feature, the fix stays a tap; **absent ≠ clean** (unchecked publishes no rollup); **host-scope
  checks are excluded** (`scope: "host"` — a fact about the daemon must not flag every repo; the
  retired Gemini-key row was the one such row).
  Store `.waterplane/setup.json`, keyed by realpath, and the checklist routes write their verdict back so
  the badge clears on the next listing) ·
  `secrets.ts` (**write-only**, gitignore gate) · `update.ts` · `host.ts` · `auth.ts` ·
  `webbundle.ts` (content-derived build id, per-file sha256; owns `WEB_DIST`).

### A build that ASKS: `shared/buildparams.ts`

- **The case that forced it**: a Garmin monorepo where one screenshot pipeline serves forty apps
  under `apps/`. A build command was a constant, so saying WHICH app meant forty near-identical
  buttons or a command typed out on a phone keyboard — the friction this app exists to remove. An
  entry may now declare `params`, and the value is asked for at the moment you tap run.
- **Four rules, all in `shared/buildparams.ts` so the phone's form and the host's shell cannot hold
  two opinions**, and three of them exist because the plausible alternative fails SILENTLY:
  - A value is substituted VERBATIM at `{{id}}` in `cmd` **and in `dir`** (`apps/{{app}}` is how one
    entry serves one member of a monorepo), and is ALSO exported as `WATERPLANE_PARAM_<ID>` whether or not
    the command line names it — verbatim because a parameter is as legitimately a flag fragment as a
    word, and the env copy is what a command that wants safety reads (`"$WATERPLANE_PARAM_APP"`).
  - **A value is ONE LINE** (`cleanParamValue`, applied on the way in, once): a newline substituted
    into a command line is a second command nobody typed.
  - **A placeholder nothing declares is LEFT AS WRITTEN.** Substituting an empty string turns
    `--app {{ap}}` — a typo — into `--app`, which builds something, successfully, that nobody asked
    for. Left alone the shell sees the braces and it fails loudly, which is the only outcome readable
    off a build log afterwards. The editor SAYS which placeholders are unanswered; it never refuses.
  - **A declared parameter with no value and no default REFUSES the run**, synchronously, naming the
    field — beside "unknown build" and "invalid working dir", and for their reason: while there is
    still a socket to tell. That refusal is what an unattended fire (a schedule, a chain, Activity's
    *run it now*) and an older bundle sending no `params` both hit, and the alternative is a build
    that runs on whatever was last picked, at 3 a.m., reporting success.
- The dir is substituted BEFORE `contained()`, never after: the guard runs on the resolved path, so a
  value cannot walk out of the repo (`e2e-buildparams.mjs` pins `{{app}}` set to `../../../etc`).
- **A choice's options may be READ rather than transcribed** — `optionsCmd`, a shell one-liner run in
  the repo ROOT when the form opens (never the entry's `dir`, which may itself be parameterised, so
  resolving it would need the answer this call exists to produce). Wire: `build.options` →
  `build.options`, additive, `PROTOCOL_VERSION` stays 1, contained for `build.list`'s reason and the
  stronger form of it (this ends in a shell), not durable. **ASYNC on purpose** — it runs on the loop
  that pumps every live PTY, and a six-second synchronous listing is a six-second outage for every
  session. A failure is a SENTENCE per parameter, never an empty list: "that command is broken" and
  "this monorepo has no apps" are opposite facts and only one of them means the form should quietly
  offer a typed field instead.
- The values are snapshotted onto the row (`BuildPayload.params`) for `cmd`'s reason and one of their
  own: `cmd`/`cwd` are already substituted, so this is what the executor still needs in order to
  export `WATERPLANE_PARAM_*` — and a run reconciled after a restart would otherwise re-spawn the same
  command line with the environment missing. They ride back on `BuildRun.params` and into the
  intent's TITLE (`buildRunTitle`), because with parameters two runs of one button are two different
  builds and a row that cannot say which app it screenshotted cannot be told from the four above it.

### `buildscan.ts` — the free half of "set up"

- `shared/buildscan.ts` is the decider and `host/buildscan.ts` is the walker, and the split is what
  makes every rule below testable from literals.
- **Its claim to being trustworthy is that it invents nothing.** Every row was read out of a file
  somebody already wrote in this repo, so the list cannot contain a gradle task that does not exist.
  Concretely: `assembleRelease`/`bundleRelease` are offered only when the build file applies
  `com.android.application`, an android LIBRARY gets assemble and no bundle, and a plain JVM project
  gets `build` and `test` — the two the base plugin gives every gradle project. `./gradlew` is
  suggested only in a directory that HAS a wrapper. A suggest list that names a task the project
  does not have teaches people it lies, and one that has lied once is one nobody reads again.
- **A suggestion is typing, not saving.** Tapping a row fills the editor's three fields; the Save tap
  is still the user's, the command is still editable, and no candidate has run by having been
  suggested. That is what lets the list be generous — a row you disagree with is a row you don't tap,
  not a build that ran. It is `Nothing applies itself` at the size of one form.
- **A publishing command is flagged, never filtered.** `PUBLISHY` matches on the whole command line
  AND, for an npm script, on its BODY (`npm publish` inside a script called `rel`), and the row
  carries a sentence saying these run later with nobody watching. It is not dropped: a release script
  is a legitimate thing to want on a phone, and silently hiding the one command somebody came here
  for sends them back to typing it into a phone keyboard, which is the friction this exists to
  remove. The caution also survives the dedupe — the same command described by two files is one row,
  and the row keeps the note.
- **An already-configured command stays in the list, flagged `already`.** Filtering them out would
  make the list silently shrink as you use it, which is indistinguishable from the scan breaking.
  `already` is keyed on cmd AND dir, because `npm run build` in `packages/web` is not the one at the
  root.
- **What CI contributes is single-line `run:` steps and nothing else.** A block scalar (`run: |`) is
  a script and half of one is worse than nothing; a step carrying `${{ … }}` is resolved by the CI
  runner and would reach our shell verbatim; `npm ci`, `apt-get`, `brew` and friends are every
  workflow's plumbing and nobody's phone button — and the `sudo` strip before that check is not
  cosmetic, since `sudo apt-get install -y tmux` is exactly the line it is there to drop and survived
  without it. CI's `npm test` is rewritten to `npm run test` so it dedupes against the manifest's own
  script instead of appearing as a second, different-looking button.
- **Ranking is by what comes out.** Things that produce a downloadable file rank above checks, which
  rank above everything else, and shallower paths win inside a band — a build button's whole point is
  the artifact at the end of it, and `builds.ts` offers exactly those for download when a run
  finishes.
- The list is capped (60) but `total` rides back with it, so the editor can say what it is not
  showing rather than implying the repo has sixty commands. An unparseable `package.json` contributes
  NOTHING rather than a row saying so, and a repo describing no build at all answers with an empty
  list — a real answer, worded as one by the sheet, and not the same claim as "nobody has asked yet".

### `api.ts`

- `api.ts` — HTTP routes. Artifacts over `STREAM_MIN` (2 MB) are **piped, not buffered**, and
  resumability rests on four things: `accept-ranges` on the 200, a correct `content-range`, **416 not
  200** past the end, and `if-range` (a stale validator ⇒ whole body) — on the buffered path too.
  Inbox POST logs one line per file. `artifact?…&stat=1` answers mtime+size and no bytes — the half a
  client with only a PATH needs to build a *versioned* thumb URL (web `fileMtime.ts`); same
  containment + viewability gate as the byte path, so it never confirms a file this route would refuse.

## Modules CLAUDE.md links here for and this file never covered

Written from the modules' own headers, which is where the measurements live.

### `shared/hosts.ts` — the desktops a phone knows, as data

One host used to be one `waterplane.hostBase` string; now it is a list of `SavedHost` rows with exactly
one ACTIVE (its keys live bare in storage, every other host's are PARKED under `waterplane.h.<id>.`). This
module owns the rules both the web store and its tests must agree on, kept pure so they are
node-tested: `cleanSavedHost` (anything unreadable is dropped, never defaulted into a host nobody
added), `planHostMigration` (the one legacy `hostBase` becomes the first entry, idempotent — a second
run writes nothing), `planHostSwitch` (which keys a switch copies and in what order — every copy
lands BEFORE the bare key it came from is removed, so a switch interrupted at any step has lost
nothing), and `dbNameFor` (which IndexedDB a host's caches live in). `HostLan` is a host's LAN side —
address, saved Wi-Fi names, and the "switch to LAN automatically" setting, off by default; the
DECISION that setting feeds is `lanroute.ts`'s.

### `shared/lanroute.ts` — LAN or tailnet, decided the same way on both ends

Three gates, ANDed, all fresh evidence rather than remembered: the phone is on Wi-Fi with a saved
SSID, the LAN address answered `/api/health` inside `LAN_PROBE_TIMEOUT_MS`, and `/api/lan/verify`'s
HMAC proved it is this desktop. Anything missing, unknown or failed — or a LAN failure newer than the
last good probe — is `tailnet`, the route that always works, until the next trigger re-probes.
`decideLanRoute` is pure and carries the one sentence the UI says about its verdict; a number the
input does not have (the probe time) is left out rather than guessed. `NetState` is also the contract
of the Android `ShellNet` plugin (`packages/app`'s `ShellNetPlugin.java`): `ShellNet.current()` resolves
to one, `window.shellNetChanged(json)` delivers one on every change.

### `shared/pairing.ts` — a QR code that expires and is spent once

An 8-character code (`PAIR_ALPHABET`, no 0/O or 1/I, so it can be typed off a screen) that lives
`PAIR_TTL_MS` and is spent by its first successful redeem. The QR carries the landing URL
(`<base>/pair/<code>`, host-rendered — see host's `pair.ts`); the installed app is reached through
the `waterplane://pair?u=<base>&c=<code>` deep link. Both parse to the same `{base, code}`
(`parsePairDeepLink` / `parsePairLandingUrl` / `parsePairInput`), and the base always runs through
`normalizeHostBase` so a scanned or pasted link can never aim the app at a `javascript:` or `data:`
base — the QR is not a place to smuggle a URL scheme.

### `shared/devices.ts` — the paired-device ledger, as the phone sees it

The host keeps one row per device (`deviceledger.ts`, token hashed at rest); this is that row without
the hash — `DeviceRow` (`id`, `name`, `createdAt`, `lastSeenAt`, `lastKind`, `current?`). Revoking a
row kills its token at once. `lastSeenAt` is throttled to once per `DEVICE_SEEN_THROTTLE_MS`, so it
reads "seen within the last minute", never a live presence. `sortDevices` / `cleanDeviceRow` /
`normalizeDeviceName` are the pure half both the host's ledger and the phone's "paired devices" list
use, so a row cannot read differently in the two places.

### `deviceledger.ts`, `lanid.ts`, `ratelimit.ts`, `authroutes.ts`, `pair.ts` — the auth boundary's new companions

Same treatment as `auth.ts` itself: security-adjacent, never a skill, described here and pointed at
from the router's prose rather than routed to by module name. `deviceledger.ts` is the persistent
per-device token ledger (`.waterplane/devices.json`, 0600, sha256-at-rest, `timingSafeEqual`, revoke =
delete the row); `lanid.ts` is this desktop's LAN identity (`.waterplane/lan-identity.json`, `hostId` +
secret, `GET /api/lan/identity` loopback/Tailscale-only before the token gate, `POST /api/lan/verify`
pre-auth and rate-limited); `ratelimit.ts` is the token bucket both pre-auth routes share (`RateLimiter`,
memory-only, pruned); `authroutes.ts` wires those two into `/api/lan/*` and `/api/devices*`; `pair.ts`
is the QR flow — code store (in memory, sha256-at-rest), mint/redeem, and the host-rendered `/pair/<code>`
landing page. Full detail: [protocol-and-security.md](protocol-and-security.md).

### `convfork.ts`

A conversation cut at a TURN and written out under a new id, so a session that went wrong at turn 7
reopens at turn 6. The need is ordinary and the CLI answers none of it non-interactively: a session
misreads the request and spends an hour down a wrong path, and the only moves are to let it finish,
interject, or kill it and lose the good half with it — all three expensive on a phone.
`--fork-session` forks from the END; `/rewind` is a TUI picker. So we write the file.

Writing another program's state file is only defensible because of two facts about the format, both
CHECKED against real logs on this machine rather than assumed:

1. **The message chain points backward, but the bookkeeping does not.** Over 132,320 `parentUuid`
   values in three projects' logs, not one names a record appearing later in its file; the same
   holds for `leafUuid`, `snapshotMessageId`, `logicalParentUuid` and the compact metadata's
   `headUuid`/`tailUuid`. The conversation is therefore a prefix-safe structure: no `parentUuid` to
   re-point, no `last-prompt` to patch. What is NOT true — and the design note that preceded the
   file said it was, on the strength of one 399-record sample — is that *nothing* points forward.
   Two record kinds are written slightly AHEAD of the message they name, because the CLI writes them
   when a turn begins rather than when it lands: `file-history-snapshot.messageId`, and the `system`
   record that opens a compact, whose `compactMetadata.preservedSegment.anchorUuid` names the
   compact SUMMARY record that follows it. Simulating the cut at all 7,076 turn boundaries in four
   projects' logs, 4.8% left at least one such reference naming a record the cut had removed.
2. **The CLI's own `--fork-session` output is the template.** Three logs in one project directory
   are a parent and two independent forks of it. Diffing the 1,241 records all three share, keyed by
   `uuid`: `sessionId` is rewritten on every copied record (1,241 of 1,241); `session_id` — the
   other spelling, which really does occur alongside it on `user`/`assistant`/`attachment`/`system`
   records — is NOT (all 1,226 copied records carrying it still name the PARENT in both forks);
   `uuid`, `parentUuid` and `timestamp` are untouched, which is what makes the backward-pointing
   property survive the copy at all; and the two sibling forks differ from each other in exactly
   `sessionId` and `promptId`.

So `rewriteInto()` moves **`sessionId` and only that**. The argument, beyond copying the CLI's
output: the two fields answer different questions. On a natively forked log `sessionId` is uniform
across the file and `session_id` is not — copied records keep the parent's, records the fork itself
produced carry the fork's. `sessionId` is "which conversation file is this record part of", a
property of the file that must be rewritten or the records do not belong to it; `session_id` is
"which session produced this record", which is PROVENANCE, and for a copied record the honest answer
is still the source session. Rewriting it would make the fork claim it produced turns it did not.
`promptId` is left alone too, where the CLI mints a fresh one: nothing in the format points at a
`promptId` — every backward reference names a `uuid` — so regenerating it buys no consistency and
puts nondeterminism into the output of a function whose whole safety story is that you can diff its
result against the source and see one field move. `JSON.stringify` over a `JSON.parse` result is
byte-identical to what the CLI writes (key order preserved, compact lines, no value `JSON.parse` can
produce that would serialise differently), verified over a real 197-record log, all 197
round-tripping exactly.

The cut is after the WHOLE turn — before the next record `promptOf()` accepts as a real prompt, so
tool results and attachments ride along, and `promptOf` is reused rather than re-derived.

**`pruneStranded()` is not cosmetic**, and the obvious reading ("a dangling id in a bookkeeping
record, who cares") is wrong in exactly the situation the feature is for. A `/compact` writes a
`system` record carrying `compactMetadata` and then a `user` record carrying the SUMMARY of
everything it dropped; `promptOf` accepts that summary as a real prompt — correctly, it is what the
reader shows as a turn — so a fork at the last turn BEFORE a compact cuts between the two. The
prefix then keeps the instruction to discard the pre-compact history and loses the summary standing
in for it. Observed, not reasoned: a two-turn conversation forked that way could name only its
second turn, where the same fork with that `system` record pruned named both. The other 99% of the
class is `file-history-snapshot`, whose `messageId` names the first message of the turn the cut
removed; those are harmless (a resume with one dangling was verified to work) but they are the same
fact, so they go the same way rather than by a second rule.

Reference detection is a short CLOSED list — `parentUuid`, `logicalParentUuid`, `leafUuid`,
`snapshotMessageId`, `messageId`, `headUuid`, `tailUuid`, `anchorUuid` — because the format is full
of ids from other namespaces that look identical and resolve to nothing: `id`, `tool_use_id` and
`toolUseID` are API message and tool-call ids, and across 100,808 of them in three projects' logs
not one named a record uuid. Treating those as references would make the pruner delete most of the
conversation. The eight above resolve essentially always — 146,849 hits, 8 misses, all `messageId`
on a snapshot whose message is not in the file at all — which is what makes "not in the prefix" a
sound reading of "the cut removed it" without a second parse of everything past the cut. The
`message` and `toolUseResult` subtrees are never walked (every foreign id lives there, none of the
eight keys does, and between them they are ~all the bytes of a log): a correctness rule first and a
cost rule second. Only a record naming a uuid ABSENT from the prefix is dropped, so a chain record
never can be — `parentUuid` points backward and everything backward is in the prefix by
construction. Over 7,076 simulated cuts this removed only `file-history-snapshot` (838) and compact
`system` (8) records, never a `user`, `assistant` or `attachment`, left zero stranded references,
never lost the turn the cut was aimed at, and reached a fixed point in one pass every time. The loop
is capped anyway: a rule that can delete records must not be able to delete all of them because of a
format change nobody has seen yet.

**The failure mode is contained by construction**, which is the other half of why this is allowed to
be tried at all: the source is opened READ-ONLY and never modified, the output is tmp+rename under a
FRESH uuid, and so a malformed result is a new file under a new id that nothing yet points at. The
original conversation is never the file we wrote; two forks from one turn are simply two files; and
`deleteArchived` stays the only way to lose a conversation. Its bare-id regex is reused here for its
own reason: an id reaches `transcriptPath`, which is a `join` and would take `../../…` perfectly
happily, so a traversal-shaped id is REFUSED rather than sanitised — stripping the dots would
silently fork some other directory's conversation, and a refusal is a bug report where a
sanitisation is a mystery. `MAX_SOURCE_BYTES` (256 MB) exists so that a corrupted or runaway file
becomes an error message instead of an out-of-memory kill of the daemon driving every other session
on the machine: `parseTranscript` gets to tail-read a huge log because it only shows the newest
turns, but a fork needs the HEAD and has to hold the whole file. File checkpoints in
`~/.claude/file-history/<sessionId>/` are NOT copied, which bounds a fork's own `/rewind`.

`ForkOk` reports `records`, `dropped` (unparseable lines, normally 0) and `pruned` (fires on roughly
one fork in twenty). **The premise was tried on the real CLI before anything was built on it** (a
throwaway repo, four cheap turns): `claude --resume <newId>` accepts a file we wrote, headless and in
the TUI, and answers from the forked history (forked at turn 1, "what did you say" answered "ONE"
where the original answered "ONE, TWO, FOUR"). A cut at a tool turn carries the whole turn, `tool_use`
and `tool_result` together; the original's sha256 was unchanged after every fork, malformed ones
included. **Driving `/rewind` inside a fork is not built**, and what blocks it is known: a fork has
none of its parent's checkpoints until `file-history/<sessionId>/` is copied (a second write outside
the conversation file), it needs a picker-walker on `submitPromptBox`'s pattern (read, move, re-read,
never open-loop key counts), and an in-place rewind branches the log, which the linear
`parseTranscript` would render as both branches.
`packages/host/test/convfork.test.mjs`, `scripts/e2e-forkfrom.mjs`.

### `assess.ts`

"Of the work still standing here, what is actually still worth doing?" — the half of that question
that touches the disk.

**The contract is a FILE, both directions.** The obvious implementation pastes eighty-four prompts
into a kickoff message and parses the answer out of what comes back; both halves are wrong here. A
multi-line write into a TUI is a paste, and `deliver.ts` documents at length what the CLI then does
to it; and an answer scraped out of prose is a parser fighting a narrator. So the host writes
`.waterplane/assess-in.json`, asks for `.waterplane/assess-out.json` and `.waterplane/plan.md` back, and the kickoff
prompt is four paragraphs naming two paths and the rules. The items are never in the prompt at all,
which is also why the run is cheap enough to offer. The envelope is the completion signal and the
error channel, never the content — the run is bought with `claude -p --output-format stream-json
--verbose` so it can be watched (below), which moves the envelope to the LAST line of the stream and
changes nothing about what it is; `resultText` reads it in either shape. A run whose file is missing or
unparseable FAILS and says which, keeping the envelope text as the detail — when the file is not
there the envelope is the only thing left to debug from, and throwing it away leaves a red row
nobody can act on. The one deviation tolerated on the way back is a document wrapped in a markdown
fence, unwrapped rather than refused, because asking again costs a whole repo read and a fence is
the single most common way a model complies-but-not-quite.

Three things that are easy to get wrong:

- **The stale output file.** `.waterplane/assess-out.json` is deleted before the run. Without that, a run
  that writes nothing at all silently "succeeds" with the PREVIOUS run's verdicts — retiring rows on
  the strength of an assessment of a repo two days older. Same failure `settle.ts` guards with
  `spendTurn`: evidence that belongs to somebody else.
- **A fresh session, deliberately.** `review.ts`'s runners prefer `--continue` so a check starts with
  warm context. An assessment must not: the conversation it would resume is the one that did the work
  it is being asked to grade, and its opinion of its own output is the one opinion this run cannot use.
- **It has to be allowed to WRITE.** Every other headless runner in this daemon says "do not make any
  changes"; this one's entire deliverable is two files. Hence `--permission-mode acceptEdits`, and
  hence the prompt saying "change nothing else" in the same breath.

The input document is everything addressable by this `cwd`, from two stores — the intents the host
holds for the repo, and the pad notes carrying that `cwd`. A note is not a send that gave up:
`retireToPad` is deleted and a failed queue row now keeps its own row and its full words for as long
as it takes. A note is a thought written with no target that named a repo anyway — when it attached a
file, or was written for one — and skipping those re-asks the question the whole rework was about. The split between `assessable`
and `context` is the load-bearing part: finished, running and cancelled rows go in so the CLI can see
what already ran — that is how it tells the item next to them was quietly implemented — but
`cleanAssessment` drops any verdict naming one, and a row that is mid-flight is not a candidate for
retirement either, being worked on right now. A chain's steps are JOINED rather than dropped, because
`steps[0]` is what everything reading an intent as one prompt uses and a triage judging an item by its
first turn alone would judge half of it. The kickoff prompt states the vocabulary, that evidence is
REQUIRED and that a claim without one is rejected rather than quietly softened, the merge rules and
the caps — interpolated from the shared constants, since a prompt teaching a limit the parser does
not enforce is worse than no prompt at all.

The timeout is twenty minutes, overridable: `review.ts` allows 180 s to judge ONE task against a
diff, and the same number would fail every run on any repo worth assessing and report it as "the CLI
wrote no file". There is deliberately no retry — a second full read of a repo because the first
wrote malformed JSON is real money spent on a guess, and the failed row says exactly what went wrong
so a person who has read it can repeat the tap.

The run is an Intent with `target: {kind:"shell"}` — `builds.ts`' shape — which buys four properties
for free: on disk before the tap returns, visible in Activity while it works, budget-gated like
every other unattended run, and at-most-once by intent id across a restart. `runId` IS the intent id.
It sets no `watch`: unlike a delivery into a session there is no turn afterwards to wait for. A
failed run is `ok: false` and never `retry` — nothing here was half-typed into anything. The proposal
lives in a sidecar keyed by run id, `ReviewStore`'s shape for `ReviewStore`'s reason (the intent store
is the LIFECYCLE — state, trigger, target, result — and a proposal is none of those; it outlives the
run, one sheet reads it, and putting it on `Intent` would make every consumer carry a field it will
never look at), tmp+rename because half a JSON document is worse than none. Eviction never touches a
`running` run — the store's rule, not a timer's — and never the newest run for a repo, which is the
one the sheet opens. `AssessRun.status` keeps `applied` distinct from `done`: a finished run is a
diff waiting for a person, an applied one is what they decided.

The manager slice this file takes is an INTERFACE (six methods when it was written; `kick` and
`name` joined it later, each with its own note on the type), because that is all applying a
proposal is allowed to do and the narrow type is the place that says so. Nothing here can delete a
row — `remove()` is deliberately not in it — and the one rule the whole feature rests on is that an
assessment retires words and never loses them. Nothing here decides, either: verdicts arrive through
`shared/assess.ts`'s `cleanAssessment`, which is where every rule that stops a confident-sounding
model from retiring real work lives and which can be pinned without spawning anything.
It is deliberately NOT a replan: replacing the list loses the sentences a person wrote, so every row
survives with a verdict attached, and a retirement is dimmed, never hidden. It is manual only (no
schedule, sweep or fire-on-idle: it reads a whole repo), one run per repo at a time (two proposals on
one list is a merge nobody can do on a phone), and its button sits in the Backlog/Activity header,
not the launcher row, where a token-spending button gets pressed by accident. "Sequence" is an
integer rank over the `wanted` rows plus the per-repo `serial` group, never a dependency graph: a
graph would be wrong, cannot be repaired from a phone, and nothing in the daemon executes edges.
`scripts/e2e-assess.mjs`.

#### What the run says these things should be CALLED

The prompt asks for one more pair of fields on every open item, merge group and new item: a
`headline` of three to eight words and a `category`, one of four. Both caps are INTERPOLATED from
`@waterplane/shared`'s `naming.ts` — the merge-size rule applied to two more limits, and for the same
reason, since a prompt that teaches a limit the parser does not enforce buys a repo read and spends
it on drops. `packages/host/test/assessprompt.test.mjs` pins the interpolation rather than the text,
because `MAX_HEADLINE_CHARS` is a number that goes stale silently and `ITEM_CATEGORIES` is a list
that goes wrong the day a fifth kind appears.

Writing them is a SEPARATE question from every other approval on the sheet (`AssessChoices.
writeNames`, absent is no), and the apply honours that asymmetry in two directions:

- **Existing rows** go through `IntentManager.name(id, n, "assess")`, which writes each half only
  where that field's author is not `hand`. `counts.named` counts a row when EITHER half was actually
  written — the manager's return value, never the suggestion — so a run whose every title was
  refused reports none rather than reporting that it had opinions. `N titled` joins the apply's
  one-line detail only when N is non-zero, which is `requeued`'s rule for `requeued`'s reason.
- **Posted rows** — a merge, a new item — carry their title REGARDLESS of the answer, stamped
  `assess` through `backlogDraft`. `AssessPost`'s note is the argument: the prompt on such a row was
  written by the same run in the same breath, so there are no typed words for a title to stand on
  top of, and the alternative to a machine's title there is no title at all.

And the merged row's `label` lost the `merge of 3: a1 b2 c3` it used to carry. That string was a
count and three internal ids written into the one field on a row that means *the name somebody gave
this* — machine bookkeeping in a person's field — and the link it existed to preserve is not lost
with it: the ids are on `AssessRun.proposal.merges[].ids` and every retired member already says
`merged into <id>` in its own result. Rows already wearing the old label KEEP it; there is no
migration, deliberately, because rewriting `label` on rows in somebody's store to tidy a string is
exactly the *words nobody typed* write this app refuses.

#### A pad note the run says is still worth doing

`wanted` was the one verdict on a note with nowhere to go. A retiring verdict on one is
informational by design — the pad is a synced document the host does not own, and the per-note merge
that makes writing one safe is the CLIENT's (`pad.ts`, run on adopt), so all the host could do to it
is replace the whole opaque string, last-write-wins, with no diff — and that is still true. But *still worth
doing* was informational too: the note was read, judged, counted, and left, with no route into the
backlog at all, which is a button that reads a person's own words and then asks them to retype one.

So a `wanted` note is now OFFERED, as an ordinary row on the sheet's "new" list, ticked and applied
like every other verdict. The load-bearing part is WHERE the offer's words come from:
`cleanAssessment` synthesises it from the input item's own `text` (`AssessNew.fromNote`), so "it
carries the note's words" is true by construction rather than because the CLI was asked to copy them
and complied. The prompt tells the CLI not to restate a note under `new`, and a run that does it
anyway has its copy dropped with a note naming the pad note it repeated — the sheet must not offer
one sentence twice under two authors. The offer is deliberately NOT counted against `MAX_NEW`: that
cap guards a run that INVENTS things, and these are sentences the person already wrote.

The apply side is two small asymmetries. The posted row carries **no `label`** — `from an assessment`
is true of a merge and of a genuinely new item, and a lie over words a person typed, and
`itemHeadline` lets a non-derived label beat the headline, so it would sit above their own sentence
as a title claiming a machine wrote it. And the detail says `N filed from the pad` beside the
existing `N pad note(s) judged and left on the pad`, `requeued`'s rule for `requeued`'s reason. The
host still never reads or writes `waterplane.pad`: `AssessPost.fromNote` travels so the PHONE can clear the
note on the receipt, which is the half that owns that document — without it the person holds the same
sentence in two places with nothing saying which one is going to run.

**And the receipt names which notes were filed, one by one.** This is the only pad delete in the app
taken on a REMOTE receipt instead of on a durable local copy, which is exactly why it is the only one
that can lose words. `intents.post` refuses on its own — `PENDING_MAX`, a draft that could never run
— and `applyProposal`'s loop does `if (!r.ok) continue`, so an apply where NOT ONE row landed still
answers `{ok: true}` with counts and no ids. Tick three offers at a host sitting on `PENDING_MAX` and
the phone cleared three notes with no row anywhere to show for them. So `AssessApplyOutcome.filed`
collects the `fromNote` ids that actually posted, `op.ack` carries `filed?: string[]` (additive —
`PROTOCOL_VERSION` stays 1, and the field is remembered in `acks.ts` so a replayed receipt says the
same thing), and the phone clears exactly `ticked ∩ filed`. The contract is in the wire type's own
doc comment because that is where the client reads it: **absent means this host cannot tell you, so
assume nothing was filed** — an older daemon, or a guard that refused before the posts ran — while an
EMPTY ARRAY is the stronger, opposite claim that this host filed nothing. A phone holding an absent
field clears nothing and says the notes were left on the pad, which costs one tap; the alternative
cost the words. `assessapply.test.mjs` pins the refused-post case.

The sixth method is `requeueFailed`, and it is the one that widened the slice after the fact — see
[putting a failed row back in the queue](#putting-a-failed-row-back-in-the-queue) for the transition
itself. Applying `still wanted` to a `failed` row used to write a sort position onto a terminal row,
which is a place in an order the row is not in, so the whole verdict was a no-op on the 19 failed
rows this repo actually had. What the widening makes reachable is one thing: a row that had STOPPED
becomes runnable again. What it does NOT make reachable is worth naming, because a narrow type is
only as good as the list it excludes — still no `remove` (nothing here can lose words), no
`markDone` (an assessment cannot claim work happened), no `runNow` (nothing here spawns an agent; a
re-queued row waits its turn and the ladder decides), no `update`/`retarget` (it cannot rewrite what
a row says or where it runs), no un-archive, and no reviving a `done` or `canceled` row — the NAME is
the type saying so, since the bare `requeue()` that `backlog.ts` reaches with `allowDone` is not in
this interface at all.

`applyProposal` runs the re-queues BEFORE the rank loop, and that order is load-bearing in the mirror
image of the posts-first rule: `applyAssessment` puts a `wanted` failed row on BOTH lists, so putting
it back first means the rank that follows lands on a row that is in the order it names. A refusal
from `requeueFailed` is expected traffic, not an error — the ids come off the run's START snapshot
and a row may have run in the twenty minutes since — so it is not counted and it does not stop the
rest of the apply. The count travels through `AssessApplyOutcome.counts` into `AssessRun.applied`
(`requeued?`, optional because it postdates the persisted row) and adds `N put back in the queue` to
the apply's one-line detail — worded as the verb rather than as a state, and only when N is non-zero,
since a `0 put back` on a repo with nothing failed is noise in a line read once.
`packages/host/test/assessapply.test.mjs`.

#### Watching one run happen

A run takes up to twenty minutes and the sheet said one sentence for all of it — *the assessment is
reading the repo* — which is character-for-character what a run that died in its first second shows.
On a desktop you glance at the terminal; on a phone there is nothing to glance at. So the run is
bought with `--output-format stream-json --verbose` and READ as it goes: `foldAssessEvent` turns each
line into a step (shape, the tool's own name, and what it named — a repo-relative path, a pattern, a
command), and `AssessRun.progress` carries a TAIL of them plus the counts, the model, the run's last
words and whether the two contract files have appeared yet.

Seven things about it are deliberate.

- **It is a reading, never a lifecycle.** Nothing on `AssessProgress` is read by anything that
  decides: the status is still `status`, the verdicts are still only the proposal's, and the FILE is
  still the content. A line that will not parse contributes no step — `foldAssessEvent` returns the
  very object it was given, so a stream of noise pushes nothing — and a host that sends no progress
  at all leaves the old screen exactly as it was.
- **Live readings never touch the disk.** `AssessStore.setLive` writes memory and broadcasts;
  `set()` (whole-file tmp+rename over every run's input snapshot) would run several hundred times per
  run to persist a fact that cannot survive a restart anyway — the constructor fails every `running`
  row on boot, because the run was a child process of the dead daemon. The LAST reading is persisted
  by the `set()` that settles the run, where it becomes the record of what it looked at.
- **The throttle has a TRAILING EDGE.** A reading goes out at most every `ASSESS_PROGRESS_MS`
  (1.5 s), because every push is a broadcast to every connected phone and a repo read fires tool
  calls faster than anyone can read them. Pushing only when a chunk arrives late enough, though,
  withholds every step folded inside the window until the NEXT chunk — and the step most worth
  watching is exactly the one with no chunk behind it: at t=0.4 s the run folds `Bash npm test`, the
  command runs for four minutes printing nothing, and the phone shows the step BEFORE it as what the
  run is doing while `assessWatch` counts the quiet age off that older step's `at`. Both halves of
  the reading are then false and nothing on the screen says so. So a throttled reading arms one timer
  for the rest of the window; it is cleared on every push and when the run answers, because this
  daemon outlives every run and a timer holding a finished one is a leak with a `setLive` on the end
  of it. There is no "has it any steps yet" gate either — the `system/init` event carries the MODEL
  and no step, and which model is about to spend twenty minutes is worth arriving before the first
  tool call rather than never. "Identical object ⇒ nothing to push" is what makes a stream of noise
  free: `foldAssessEvent` returns the very object it was given, so the comparison is identity.
- **The stream is why the run is spawned rather than `execFile`d — for EVERY run, watched or not.**
  `sidecar.ts` grew `onOut` for this: `execFile` buffers all of stdout and kills the child the moment
  it passes `maxBuffer`, and a stream-json run prints every tool result it takes. `runClaude`
  therefore passes `onOut` unconditionally and `onProgress` only decides whether the readings go
  anywhere — the gate used to be "watched ⇒ streamed", which left a caller that simply did not want
  readings putting a stream-json run through an 8 MB buffer and getting killed for succeeding loudly,
  reported as "the assessment wrote no file". The watched branch keeps only the tail
  (`ASSESS_KEEP_BYTES`), which is where the envelope and any usage-limit notice are. `resultText`
  searches lines from the END and still reads the single-object envelope, which is what the unwatched
  callers print.
- **The limit detector is handed the PARSED result text.** It is not true that `detectHeadlessLimit`
  needed no change: `limit.ts`'s `envelopeResult` is a whole-document `JSON.parse` of stdout, written
  for `--output-format json`, and on NDJSON it throws by construction and contributes `""`. Detection
  survived the format change only on the raw-text regex backstop — i.e. on the banner happening to
  sit inside the result line where the JSON escaping leaves it readable, which is luck rather than a
  contract. `limit.ts` is the heuristics layer with its own skill and its own rules, so the fix is on
  this side: `assess.ts` calls the detector with `resultText`'s parsed text when it found one,
  followed by the raw tail so nothing detectable today stops being detectable (a notice can also
  arrive on a line that is not the envelope).
- **A timeout ANSWERS, and the answer is final.** The streamed branch resolves at the deadline with
  what was printed by then and chases the process separately (SIGTERM, then SIGKILL), because `close`
  waits for every pipe and a killed process's own children can hold one open — while the intent row
  says `running` until the promise settles. Both signals go to the process GROUP (`spawn` with
  `detached`, `process.kill(-pid, …)`): `claude -p` is a shell away from every tool it runs, so a
  signal aimed at the direct child leaves the grandchild alive — `sidecarstream.test.mjs`'s timeout
  case took 30.5 s of every `npm run test:host` waiting for a `sleep 30` behind a killed `sh`, and in
  the daemon an orphaned `claude` that outlives SIGTERM can write `.waterplane/assess-out.json` AFTER the
  next run's `rmSync`, which is the stale-output-file failure this whole file is built around
  preventing. And nothing is handed over once the promise has answered: `sidecar.ts` drops late
  chunks (one guard covering both the callback and the retained tail, so "what was returned" and
  "what was kept" cannot describe different runs) and `assess.ts` says the same thing on its own side,
  because the cost of being wrong is a `setLive` on a row the executor has already settled — memory
  out of step with the disk until the next `set()` on any run persists the divergence.
- **The plan document is VERSIONED.** `AssessRun.planMtime` is `.waterplane/plan.md`'s mtime at the moment
  the run settled, recorded beside `planPath`. The contract names ONE path and every run rewrites it,
  so a reader caching documents by `(repo, path, mtime)` had one key for every plan the repo ever
  produced and *read the plan* could open this morning's document under Tuesday's verdicts —
  `spendTurn`'s failure (evidence belonging to somebody else) on a screen approved with one tap. A
  stat that throws leaves the field ABSENT rather than 0: a zero is a version that says
  "unversioned", which two different documents would share.

`packages/host/test/assessprogress.test.mjs` (the fold and the envelope) ·
`packages/host/test/sidecarstream.test.mjs` (the spawn branch, against a real child process through
`WATERPLANE_CLAUDE_BIN`, no account and no network).

### The slot check — `shared/intent/slot.ts` and the assessment's `conflict`/`split`

Smart pick (removed 2026-10-16: ~26 real passes, 0 merges, 2 reorders) re-judged the queue at fire
time and was mostly blocked by the clock rule. Its replacement asks ONCE, when a timed row lands in
a slot that already holds others, and the check is the ordinary assessment scoped to that slot —
one sidecar call, only on a tap, every change approved one at a time
(R-automation-057).

**A slot is "fires together", computed by one function on both ends.** `slotsOf` buckets waiting
one-off timed rows: `window` rows by the reset read back off their own `nextAt` (both edges, any
lead), one-off instants by `nextAt`, both within `RESET_MATCH_MS` — the scrape jitter
`budgetpass.ts` measured. A one-off instant that lands on a window slot's reset, or on a member's
own fire instant, JOINS that slot: they fire together, and splitting them by how the clock was
typed would hide the pair most likely to collide. Clustering is greedy from the earliest instant so
rows 4 minutes apart never chain into one long slot. `SlotRow` is the one input shape;
`slotRowOfIntent`/`slotRowOfItem` build it so "waiting" means one thing on both ends, and
`slotMates` is the cut whose length is the count. A key travels on `assess.run`'s optional `scope`
and is matched back with tolerance (`findSlot`) — the phone may read the reset a minute apart.

**Merging across clocks inside one slot takes the LATEST member's clock** (`latestClock`), so the
merged row never runs before any member asked; a near-tie between two different rules is null,
because which one is later can flip on the next scrape.

**`conflict` is words.** Two or more known ids and a sentence; there is no `AssessChoices` field
and no mutation for it, so "nothing applies itself" holds by construction. **`split` posts two
texts in place of one intent row** (same clock, original ARCHIVED, never cancelled) and is refused
when the two texts together no longer name every path the original did (`transportPaths`) —
appending the lost path would be this module writing the instruction.
`packages/shared/test/slot.test.mjs` · `packages/shared/test/assessslot.test.mjs`.

**The host half** (`assess/hassexec.ts`, `hassinput.ts`, `hassapply.ts`). `assess.run` with a slot
`scope` judges EXACTLY the caller's ids, never the host's slot: `startAssessment` re-derives the
slot from this repo's live assessable rows with `findSlot` only to CONFIRM them — every id sent must
still be waiting and sit in that slot, and at least two must, else "the slot changed since you
looked — it now holds N; open the check again". It used to run over the host's members instead,
and greedy clustering means one row posted since (an agent's `new` at T−2m beside the `a`@T,
`b`@T+4m the phone counted) moves the cut: the run judged a row nobody saw and dropped one they
did. A slot that merely GREW around the rows sent runs over the rows sent. A key that matches
nothing (rows ran or moved, the reset drifted past `RESET_MATCH_MS`) or a slot down to one row is
refused in a sentence too, and no run is posted — nothing is bought. The prompt gains one paragraph only on a slot run
(when they fire, order WITHIN the slot, merges on the latest clock, splits, conflicts) plus the two
JSON lists; the repo-wide prompt is unchanged. On apply:

- **split** posts both halves on the original's trigger and run settings (`holdForHost`, target,
  budget, launch…, never its `label`), THEN archives the original with `edit({archived:true})`. The
  ids are a hash of (run, sid) (`splitIds`), so a replayed apply finds them through `post()`'s
  at-most-once and posts nothing twice. **Every stop leaves one runnable copy, never two:** a
  refused post sets aside EVERY half that exists and has not started — not only this call's, since a
  replay can find half 1 from an interrupted apply, and left queued beside the original that job
  ran twice — and an original whose archive `edit` is refused (`.ok` is read) sets both halves aside
  and says so in `detail`. **A split is refused when a live row chains `after` the original**
  ("it is waited on by “…”") — archived, the original never settles and the chain waits for ever.
  Refused rather than re-pointing the chain at half 2: that rewrites a person's trigger, and "after
  the whole job" is not "after its second half". The archived row carries no reason (there is no
  field for one); the halves' `origin` (`assess:<runId>`) is the link back.
- **conflict** has no branch in the apply at all.
- **merge**, slot or repo-wide: the merged row now carries `latestClock` of its members' ONE-OFF
  clocks (trigger with its grace, plus that member's `holdForHost`). Before, every merge posted
  untimed, so merging a timed row made it run earlier than asked. Untimed members do not stop it
  (they are content to wait); recurring members are a rule and their clock is never copied; a null
  `latestClock` refuses that merge in words and its members stay. Members are still
  cancelled+dismissed — `merged into <id>` lives on that result, and archive has no reason field.
- **order** in a slot run goes through `backlogedits.reorder` (the drag's verb: the rows trade their
  own seats, every one stamped `handOrdered`); `pinRanks` is not consulted. A slot MERGE is posted
  at its members' lowest seat (`memberSeat`: `order ?? createdAt`) so it joins that trade — posted
  at the run's `rank` (a small integer) it handed the backlog's first seat to the slot.

Refusals travel only in the apply `detail` (the toast), not as a wire field.
`packages/host/test/assessslot.test.mjs`.

### `clihealth.ts`

The CLI integration's own health, host-side: the file it is kept in, the ten places the daemon feeds
it, and the one alert that makes a degrading heuristic loud. The RULE half lives in `@waterplane/shared`'s
`clihealth.ts` — the catalog, the rolling window, the verdict, the redaction and the sentence — pure,
unit-pinned, and shared with the phone so a badge and a notification cannot word the same fact two
ways. This half owns the three things a pure rule cannot: the JSON on disk, the clock, and the
broadcast.

Three properties of the shape are load-bearing, each because the obvious version is worse:

- **Module-level singleton plus a free `noteHealth()`.** The same argument `sentlog.ts` and
  `opendeliveries.ts` make: the observation points are ten files deep in the delivery path, the
  prompt detector and the transcript reader, and threading a handle through all of them means call
  site eleven forgets. Unset — a unit import, a test constructing a manager without booting a daemon
  — is a SILENT NO-OP, so nothing here can ever be the reason something else fails to run.
- **Debounced writes, debounced broadcast.** `observe()` is called from a delivery and from a prompt
  check; a file write or a socket frame per observation would make the measurement the cost of the
  thing measured, which is exactly the failure `web/link.ts`'s traffic reading names about itself. `PERSIST_DEBOUNCE_MS`
  is 2 s — a fan-out records a verdict per repo inside a second or two, and a screen-reading signal
  can fire twice while a box is drawn and answered, so two seconds coalesces every one of those into
  a single rename, and losing the last two seconds of health history to a hard kill costs nothing
  anybody can act on. `CHANGE_DEBOUNCE_MS` is 5 s, longer on purpose: a health record must not become
  a frame source on the link this app spends its life apologising for, nothing on the phone is
  time-critical here (a signal that went bad five seconds ago is equally bad now), and the alert path
  — which IS time-critical — does not go through it at all. The persist is flushed on SIGTERM beside
  `acks.flush()`.
- **Notify on a verdict TRANSITION, never on an observation.** A signal sitting at `broken` is one
  fact, not one fact per miss. The last verdict per signal is seeded from what came off disk, so a
  restart does not re-announce a state the user was already told about. The alert goes out through
  `server/clients.ts`'s `notify()`, so it obeys the notification-kind gate like every other alert.

On the samples: a `line` capture is TUI chrome the CLI drew — a dialog footer, a meter row, a block
notice — kept as text because "this line no longer matches" is only actionable with the line in hand.
`observe()` applies the redaction itself, per signal, so a call site cannot leak prose into a record
that was declared to hold none. One of those samples is captured BLOCK-NOTICE text, and it has
exactly one rule attached: **it may reach disk, the wire and the phone, and it must never be routed
back into a PTY** — printed on a claude screen it would false-positive the very detector it
documents. Nothing in this file writes to a session, and nothing downstream may make it do so.

The phone's half is `CliHealthSheet.tsx` ([web.md](web.md#clihealthsheettsx)); what counts as a miss
at all is in CLAUDE.md's Heuristics section. `scripts/e2e-clihealth.mjs`.

### `ptycap.ts` — why a PTY could not be allocated, as a sentence

The kernel caps concurrent pseudo-terminals system-wide (`kern.tty.ptmx_max`, 511 on macOS;
`kernel.pty.max` on Linux). Past the cap node-pty throws `posix_spawnp failed.` and nothing else — a
syscall wrapper's name, naming no fact anybody can act on.

Measured when this was written: the table sat at 511/511 with **287 held by an orphaned scratch
script owned by nobody**, and the phone showed four repos failing to open a session, an APK build
failing, and four `no session` marks. Six symptoms, one cause, and no screen in the app could have
suggested `kill`.

So `spawnFailure(err)` asks the kernel how full the table is and says so. `sessions.ts`'s
`spawnBackend` rethrows it once rather than at each of the four callers of `create()`; `builds.ts` and
`fanout.ts` use it directly; `doctor.ts`'s `pty-capacity` check warns under 32 free.

Three rules:

- **The count runs only on the failure path.** An `lsof` walk of every process costs ~1 s on macOS,
  so it is cached (`COUNT_TTL_MS`) and a thirteen-repo fan-out asks once.
- **It is system-wide, deliberately.** The host held 143 of 511 and was not the problem; a number
  that can only accuse ourselves points at the wrong process.
- **It degrades to the raw message, never to a wrong number.** A message matching the pattern while
  capacity REMAINS keeps its own words — a confident "the pty table is full" on a spawn that failed
  for a missing binary is worse than the errno it replaced.

`ptycap.test.mjs`.

**The leak that filled it, 2026-09-25 — and `ownPtys()`.** The table ran dry again: the live host
held 248 `/dev/ptmx` masters for 67 live sessions, and a `main.js --doctor` held 193 more, 25 h
after it had printed its report. Two causes, neither in a session's own exit path (a dead session's
master WAS closed — 248 = 67 live masters + one per spawn ever made):

- **node-pty 1.1.0's macOS `pty_posix_spawn` leaked two fds into the PARENT on every spawn** — the
  spare `/dev/ptmx` it opens to fill fds 0-2 (its cleanup loop ran `count > 0` from `count = 0`, so
  `low_fds[0]` was never closed) and the child's SLAVE fd (closed only in the child, by a posix_spawn
  file action). `lsof` showed exactly one extra master and one `(revoked)` per spawn. Fixed upstream
  in 1.2.0-beta (`close(slave)`, `i <= count`), which `packages/host` now pins EXACTLY; the JS API is
  unchanged and `spawn-helper.cc` is byte-identical, so a running host on the old binary keeps
  spawning across the upgrade.
- **`--doctor` imported `main.ts`, whose module body starts managers** — the usage poll among them,
  one `claude` /usage probe in a PTY every 8 min, into a process that `return`ed from `main()` and
  never exited. Now `DOCTOR` gates every module-level starter (`intents.start()`,
  `openDeliveries.start()`, `syncUsagePolling()` — a doctor that ticked the intent store would fire
  deferred work from a second process), and the report ends in `process.exit`, under a 90 s ceiling.

`ownPtys()` is the per-PROCESS gauge the system-wide count is not: a readdir of `/dev/fd` and an
`fstat` each (major 15 master, 16 slave; `/proc/self/fd` on Linux), no subprocess, so it is cheap
enough for `/api/health` to answer `ptys: {masters, slaves}` next to `sessions` on every call. A
healthy host holds one master per live PTY and NO slave. `ptyleak.test.mjs` (spawn/exit/kill six,
back to baseline; SKIPS saying so when the table is already full) · `e2e-ptyleak.mjs` (doctor exits
on its own; four stub sessions, exited and killed, return the gauge to baseline).

### `paths.ts` — the two containment guards, written once

Six files hand-rolled the same three lines under six names — `resolveInTree`, `pathInTree`, `inDir`,
`inTree`, and twice inline. They agreed. The point of collapsing them is that nothing guaranteed the
seventh would.

**There are deliberately TWO, and neither is the fixed version of the other.**

`inRoot` is REALPATH-resolving and guards a directory a client NAMES — `session.create` spawns
`claude` in it, `build.run` runs a shell command in it — against `ROOT`, where macOS's `/var` →
`/private/var` makes an honest path look like an escape. Its `realResolve` walks up to the deepest
ancestor that EXISTS and re-appends the tail, because a new worktree is named before it is created
and a plain `realpathSync` would fall all the way back.

`contained` is LEXICAL and guards a repo-relative path joined onto a worktree already trusted, where
`..` is the whole surface. Making it realpath-strict would refuse a symlink that legitimately lives
inside a repo, for no gain: a symlink in a worktree is not a privilege boundary when whoever can
create one can already run code there.

### `convlog.ts` — the two record decoders, shared

`limitlog.ts` and `ctxlog.ts` read the same fields off the same file, and their copies of these two
said so in their own comments:

- `stamp` — an undated row is NOT a row that happened now, so it returns null, never `Date.now()`.
- `toMs` — seconds or milliseconds, so a unit change upstream is not a reset 56,000 years out.

### `fanoutruns.ts` — a sweep, rebuilt from its rows

`fanoutRuns` reconstructs a run from the N intents sharing its `groupId`. It lives in `@waterplane/shared`
and is not duplicated, because both ends render it. It walks every intent, so call it ONCE per list
and never per row.

### `context-weight` — what a repo costs to have open

A row on the repo-setup checklist (`compliance.ts`, swept by `setupwatch.ts`), and the rule behind it
is `@waterplane/shared`'s `contextweight.ts`.

**What it measures.** `CLAUDE.md` (plus any `.claude/CLAUDE.md`) and every skill's frontmatter
`description`. That sum is re-read on every turn of every session and every subagent, so it is
multiplied by everything the repo ever does. Measured on this desktop, one repo's `CLAUDE.md` had
reached 148,582 chars — ~37k tokens — and was **21% of every token that repo spent in a week**.

**Why skill bodies are excluded, and reported anyway.** A skill's body is loaded only when the skill
is invoked; its description is in the listing on every turn. Counting bodies would tell somebody who
correctly moved their reference out of `CLAUDE.md` that they had made things worse — and they would
move it back. So bodies are reported beside the verdict as what was successfully taken OFF the
always-on path: evidence the split is working, never debt.

**The calibration.** Defaults are 16,000 chars to warn (~4k tokens/turn) and 40,000 to say so loudly
(~10k). 16k was picked against this repo after its own split: 9,672 chars of `CLAUDE.md` plus 2,762
of skill descriptions = 12,434. A threshold that flags a repo which has already done the right thing
is one people learn to ignore, and those 2,762 chars are good spend — they are what keeps 58k of
reference off every turn. Overridable per host with `WATERPLANE_CONTEXT_WARN_CHARS`,
`WATERPLANE_CONTEXT_HARD_CHARS` and `WATERPLANE_CONTEXT_MAX_SKILLS`, because the checklist is swept with no
client attached — the same argument `budget.ts` makes for being host-side rather than synced.

**It warns and never fails, and carries no `fix`.** There is no correct size: a repo with genuinely
hard-won invariants needs a bigger file than a scratch project, and which half is reference is a
judgement only the author can make. A checklist that auto-trimmed a `CLAUDE.md` would be deleting the
one thing it cannot read. It names the *groom CLAUDE.md* fan-out preset instead.

Run across eleven real repos when it was written: seven lean, four warning at 21k–39k.
`contextweight.test.mjs`.

**The line is per repo now, and the sentence says whose it is.** The row's own wording gave the game
away: *"over the 16k you asked to be warned at"* — about a number nobody had ever been offered. The
knobs were env-only, host-wide and needed a restart, so the phone could see neither the threshold nor
a way to move it, and the two repos that most need different lines are exactly the ones that could
not have them: a scratch project where 16k of instructions is already absurd, and a repo whose
invariants are genuinely load-bearing and which therefore sits amber for ever. An amber that cannot
be answered is an amber that gets ignored, which costs the check the only thing it has.

So a threshold has a SOURCE — `repo` > `env` > `default`, resolved per field in
`resolveContextLimits()` — and `weighContext()` takes those sources and attributes the number it
quotes: *"you set for this repo"*, *"you asked to be warned at"*, or plainly *"default"*. Four rules
hold the rest up:

- **The override is a HOST store keyed by the worktree's realpath** (`contextlimits.ts`,
  `<STATE_DIR>/contextlimits.json`), never a file written into the repo. `setupwatch.ts` inspects
  repos nobody has opened and its one boundary is that it never writes into one; and a threshold is
  not a fact about the source tree, it is this desktop's opinion about a directory on it. Realpath
  for the same reason as `setupwatch.ts`'s key: a worktree arrives spelled two ways, and two
  spellings would mean the override you just saved is not the one the sweep reads.
- **A partial is a partial.** An entry holds only the fields that were set; the rest keep falling
  through. Storing all three would freeze the untouched two at today's defaults, so a later change to
  a shipped default would silently never reach the repo. Pinned by e2e (`a field the repo did not set
  still inherits`).
- **The editor opens on the stored override, never on the effective number.** They differ whenever
  env is doing the work, and pre-filling from `effective` would quietly convert *inheriting 20k* into
  *pinned at 20k for ever* the first time anyone pressed Save. Hence `ContextLimitsView` carries
  `repo` and `env` separately from `effective`.
- **Out of range is refused in words, never repaired.** A stored fixed-up number is a number the user
  did not choose, quoted back at them in a sentence claiming they did — the original bug, rebuilt.
  The one thing resolution does move is a `hardChars` left below a raised `maxChars` (otherwise
  "steep" swallows "heavy" and the warn line can never fire), and it says so in `note` rather than
  doing it quietly.

The row still carries no `fix`: raising the line is the user disagreeing with a threshold, which is
theirs to do, while trimming a `CLAUDE.md` remains a judgement no checklist can make.
`ContextLimits.tsx` is the control, on the one row that quotes a number; `e2e-setup.mjs` pins the
override reaching the CHECK, outranking env, being refused, and being given back.

### `auto-compact` — how large one conversation may grow (`autocompact.ts`)

Measured first: a subagent in one repo ran 819 requests averaging 484k of context and peaking at
967k of a 1M window, about a quarter of a week's usage. The CLI's `autoCompactWindow` defaults to
`auto`, which compacts near the MODEL's window — on a 1M model, ~1M re-read on every step. So the
checklist states which value a session waterplane spawns in the repo would see, and from where.

- **Precedence**: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the daemon's environment (a spawned PTY
  starts from `ptyEnv()`, and claude's `spawnEnv` carries only `DISABLE_AUTOUPDATER`) beats every settings file — read out of
  the installed CLI bundle, which returns `source:"env"` before it looks at settings. Between the
  files it is Claude Code's documented merge, `.claude/settings.local.json` > `.claude/settings.json`
  > `~/.claude/settings.json` (`CLAUDE_CONFIG_DIR` honoured); that part was not re-derived for this
  key. A pane in an existing tmux server takes the server's environment, which
  this read cannot see.
- **Values**: `auto`, `400k`, `1M`, `1.5M`, a bare integer, a JSON number. Anything else is
  UNPARSEABLE and the row quotes it — never a guessed number. A settings file that is not a JSON
  object is named and decides nothing (the CLI cannot read it either).
- **Level**: pass at a size ≤ 500k; unset, `auto`, larger or unreadable is a WARN, never a fail —
  the `context-weight` posture: nothing is broken, a session is only allowed to get expensive.
- **The write**: `fix: "auto-compact"` sets `"autoCompactWindow": "400k"` in the repo's
  `.claude/settings.json`, keeping every other key (2-space indent, trailing newline, tmp+rename),
  refusing a file that is not a JSON object, and refusing a `.claude` that realpaths out of the repo.
  Offered only where that file would WIN (not under the env var or `settings.local.json`). It is a
  CHOSEN setting, not a repaired convention, so it is `CONFIRM_GATED_FIXES`: a two-tap
  `ConfirmButton` on the row, never in *Fix all*, never counted as "one-tap fixable". Where no write
  is offered, the row goes to the repo's agent with guidance that changes nothing when the value is
  the person's own (env or local).

### Making a repo waterplane-aware: the `waterplane` skill (`reposkill.ts`, `reposkilltext.ts`)

The agent that needs to know what waterplane does for a repo is the `claude` process running IN that
repo. Before this, a driven repo learned only what the `## waterplane conventions` CLAUDE.md block said
(inbox and outbox, written once, never updated) and, where capture was configured, the
`visual-check` preset. Builds, the artifact collection, autopull, the capture trigger and the frame (a
phone reader, often away, answers on the person's behalf, resumes at a limit reset, unattended
prompts, no interactive programs, secrets set from the phone) were told to nobody.

- **Handed to every spawned `claude` via `--plugin-dir`**, never written into a repo. The skill is
  generated from `reposkilltext.ts` into `<config dir>/claude-plugin/` (beside the host's own
  `.env`), rewritten only when its text or the port changes, and `backends/claude.ts` passes that dir
  on every launch (pinned in `backendargs.test.mjs`). One copy, always today's, and only in the
  sessions it describes.
- **Why not a file in each repo** — it was one, for an afternoon: keeping N copies true needed a hash
  stamp, a stale-copy checklist finding, a one-tap update, and a confirm-gated replace that rescued
  edited copies. All of that existed only to fight the copies.
- **Not a waterplane plugin.** A plugin (`plugin.ts`, [plugins.md](plugins.md)) extends waterplane; this is the
  core telling a repo what it offers. Plugins have no way to add to it.
- **It must grow with waterplane.** `tools/reposkill.test.mjs` fails when the host reads a per-repo
  `.waterplane/` file the text never names, unless excused with a reason. A capability with no file (a new
  loopback route an agent may call) still needs its author to remember — the `host-machine`
  skill says so.

### `agentintents.ts` — later work, asked for by an agent

The gap it closes: the phone could post a timed prompt (`schedule.save`), a chained one (`intent.post`
with `after`) and a new session with a prompt (`session.create`), and the agent the person was
talking to could do none of them — asked for "run this three hours before the weekly reset", a
session could only write the prompt into a file for the person to paste into the send sheet.

- **One path into the store, not two.** `postClientDraft` is what `routes/work.ts`'s `intent.post`
  did inline — `containRepoDir`, the naming authors forced to `hand`, `pastBudget`/`budgetPass`
  stripped — lifted out so the socket route and this HTTP route both call it. A rule added to one
  is added to both by construction.
- **`origin: "agent"` is the host's to write** (`ORIGIN_AGENT`, `shared/intent.ts`). The route stamps
  it; the socket path strips it, so a row wearing it was posted by an agent and nothing else. The
  phone says so in `AGENT_POSTED_WORDS` on the backlog row and the Activity row — one string — and
  otherwise treats the row like any other: edit, re-time, delete.
- **At-most-once by the caller's `key`, forever.** The row id IS `agent-<key>` and
  `IntentManager.post` answers an id it already holds with that row (`existing: true`). That guard
  outlives the 45-minute ack ledger, which is why the route needs no ackId of its own: a curl retried
  a day later, racing, or after a cancel gets the same row and writes nothing.
- **The phone's own draft shapes** (`useSend.tsx`): a repo target is `serial` and opens a fresh
  session; a session target is `pinned`; every row is `auto`, so it waits for the person's auto-fire
  switch and the budget like a scheduled item. **One-offs only** — `once`, a `window` rule with
  `oneShot`, `after`, `now`. A standing rule is refused in words: it is something the person should
  see every week on the phone's Schedules sheet, not something an agent sets up in passing.
- **`fires` is `whenWords`** — moved, unchanged, from the web's `sendIntent.ts` into
  `shared/schedule.ts` (with `fmtWhen`/`inWords`/`afterWords`, re-exported there) so the agent is told
  the send sheet's sentence and not a second phrasing of it. A window rule before the host has read
  the usage meter says *armed once the host reads the window*, never *never*.
- **`POST /api/agent/backlog` — words on the person's list, never started.** The socket's
  `backlog.add` body moved into `addClientBacklogItem` and both routes call it (the socket keeps its
  ack ledger and in-flight join around it; the agent's at-most-once is the same `agent-<key>` id,
  through `backlog.add`'s new `opts.id`). The item carries `Intent.manual`: **rung 1 holds it** with
  `MANUAL_HOLD_TEXT`, auto on or off, pinned or not, so auto-fire cannot
  start it — the person's own `fire` is `runNow`, which skips the ladder, and is the one way it runs.
  A new field rather than `archived` (hidden by default, so the person would never see the add) or
  "no `auto`" (which the ladder reads as a person's tap and fires at once). The phone's backlog row
  says it, and `▶ next` skips it as it skips a clock still ahead. A `when` or `fire` on this route is
  refused in words — timed work is the intents route.
- **`GET /api/agent/queue` + `POST /api/agent/queue/order` — the run order, by prompt.** Several
  rows on one reset fire in `order ?? createdAt` order, and the person asked to say which goes
  first by telling their agent rather than dragging. The queue lists EVERY waiting row (not settled,
  not started, not archived), the person's too, because the person is the one asking; `order` takes
  2–200 ids and calls the drag's own `backlog.reorder`, so the rows are stamped `handOrdered` and **trade their OWN slots** — a row not listed keeps its seat.
  That same change is what let the phone drag inside a filtered cut: `reorder` used to renumber
  the list 0..n, so a subset would have jumped ahead of every row off screen, and drag was refused
  whenever anything was filtered — including the *on a clock* cut built to gather these rows.
- **Who may call** is [protocol-and-security.md](protocol-and-security.md)'s paragraph: loopback,
  not proxied, not a browser. DELETE cancels only a row an agent posted; a person's row is theirs.
- Pinned: `packages/host/test/agentintents.test.mjs` (every refusal as a sentence, the non-loopback
  gate no e2e can reach), `scripts/e2e-agentintent.mjs` (post, retry, race, list, cancel, the phone
  sees the mark, a socket cannot claim it, browsers and proxies refused).

### Advisory rows — a thing to consider, and ignorable (`setupprefs.ts`)

`context-weight` and `auto-compact` (`ADVISORY_CHECKS` in `@waterplane/shared`) read what a repo COSTS
against a line somebody chose. Nothing is broken, and "leave it" is a legitimate answer — yet both sat
amber in the findings cut and in the repo badge beside a committed secret, so the person asked for
them to be *a thing to consider only*, and to be able to ignore them.

- **`advisory: true` on the check, set in ONE place** at the end of `inspectRepo()`, so no row's own
  code can forget it. It keeps its `warn` status (the fact is still on that side of the line), but
  `isSetupFinding` excludes it: never in the badge, never in *Fix all*, never in the bulk agent
  hand-off. `isSetupConsider` is its twin predicate; the row still offers its remedy (the groom
  preset, the confirm-gated write) and draws with a `Lightbulb` and the word *consider*.
- **Ignore is per repo, host-side** (`<STATE_DIR>/setupprefs.json`, realpath-keyed, the
  `contextlimits.ts` arrangement and for the same reasons). **Only advisory ids** — a finding is not a
  switch. An ignored row is still measured and still sent (`ignored: true`) and folds under *Ignored in
  this repo* with *stop ignoring*, so un-ignoring shows what it says today rather than a guess.
- **The window the `auto-compact` fix writes is a Settings choice** (Sessions → *auto-compact window*,
  `/api/host/setupprefs`), host-side because the sweep needs it with no phone attached and
  `settings.ts` never parses its strings. Range-checked and refused in words (`cleanAutoCompactDefault`,
  100k–900k). The row PASSES at ≤ max(500k, chosen), so the value the checklist itself writes can
  never read as a warning; a smaller choice never lowers the 500k line.


### `optins.ts` — offers a repo can turn on, which are not findings

The setup checklist is hygiene: pass/warn/fail, counted in the badge. A requirements list, a weekly
security review or a pre-push hook are worth having and their absence is not a defect, so they live in
the shared `OPT_INS` catalog and this module answers the one question about each: *already on here?*

- **Probes are filesystem + local repo reads, bounded, never paid.** No network, no model, no `gcloud`,
  no spawning the repo's code. Each `detail` is one sentence naming what was read; a probe that cannot
  read answers `unknown` with the reason, never a guessed on/off. `gcp-cleanup` is ALWAYS `unknown`:
  the registry's policy is in the cloud, so the person closes it by saying *done*.
- **A repo's own health readings count only when COMMITTED** (the file at `HEAD`, non-empty
  `readings`), the same rule `repohealth.ts` runs under. Written but uncommitted reads `off`, saying so.
- **Two inputs are injected, not imported:** `standingPrompts(worktree)` (the route wires it from the
  intent store: recurring, not archived, not spent, realpath-equal cwd; a prompt carrying
  `optInMarker(id)` is the card's own schedule) and the registered fix ids (`requirements` is offered
  only while its extension is loaded). `null` prompts ⇒ `unknown`.
- **The person's word** (`declined`/`done`) lives in `setupprefs.json` under `optIns`, realpath-keyed,
  and is only STAMPED on the row; it never changes `state`. Ids outside the catalog and any other
  choice are refused in words; `null` clears.
- **Nothing here touches `inspectRepo`**, `ComplianceCheck`, the sweep's store or the badge
  (`optins.test.mjs` pins it). `GET /api/repos/:id/optins` · `POST …/optins/choice` `{id, choice}`
  (a POST: it writes), answering with the fresh report.

### `nameTab()` — the four words a session tab wears

The phone's tab strip (`web/SessionTabsBar.tsx`) needs a name short enough to read at a quarter of a
phone's width. `title` is `<repo> · <branch>`, which is the same string on every tab of one repo, and
the row is told apart by its own field (`SessionInfo.tabTitle`) and its own call.

**The per-turn AI summary (`summarize()`, `SessionInfo.summary`) is gone** (user decision,
2026-10-01): it was the biggest unattended cost in the daemon, one call per turn-end per session. The
tab name is now the only call of its kind, and **its ONLY input is the session's FIRST PROMPT**
(`history[0].text`, ≤1000 chars, `record.ts`'s `firstPromptOf`) — never the screen, never a summary,
never a later prompt or output.

It is the cheapest call in the daemon by construction. Same model and the same three flags as the
summary had, so it inherits every measurement there (`--setting-sources user --tools ""`, its own
system prompt; 83k tokens → 1.9k), and it asks for no thinking: naming four words off one prompt is
a compression, not a decision. The automatic pass fires on the first `idle` event after a prompt
exists and `tabTitle` is absent (`sessions.nameTab`, `server/sessionEvents.ts`); `s.nameAsked` keeps
a refusal from being re-bought every turn of the same process. **Four and not three** because the tab is not the only
place these words are read — the session screen shows them in full when you open it, where a fourth
word is the difference between a category and a description, and the tab clips to its own width
either way.

**Once per session, ever.** The gate is `info.tabTitle` being absent, not a clock. A refresh would be
wrong twice over — it would turn a one-off into a per-turn call, and, worse, a tab that renames
itself as the conversation moves is a tab whose position cannot be learned, which is the only thing a
tab strip is for. The persisted copy matters: it
rides `<STATE_DIR>/summaries/<id>.json` as `{tab}` (older files also carry `text`/`len`, ignored on
read), and losing it across a restart would rename every
tab on the strip at once rather than merely re-spend a call.

**It refuses rather than guesses.** A model that answers `(none)`, or with prose, or with a
truncation mark, leaves the field ABSENT and the tab wears the repo and branch it has everywhere
else — `cleanTabTitle` in `shared/naming.ts` is that rule, node-tested, and the stored value is read
back through it too (a file written by an older build has no tab; one hand-edited to a paragraph must
not become a tab as wide as the strip). CLAUDE.md's heuristics rule, applied to the one string a
person taps.

### The per-session stores, and the sweep that bounds them

`sessions.ts` keeps two things per session outside the process: `<STATE_DIR>/history/<id>.json` (the
prompt/output history the reader falls back to) and `<STATE_DIR>/summaries/<id>.json` (the persisted
tab name — the file's old name is kept; its retired per-turn summary once cost 224M tokens in a week
when re-derived on boot).
Both are written per session and, until the sweep existed, were only ever unwritten by `remove()`.

**Two leaks, one shape.** `remove()` deleted the history and not the summary, because the summaries
store was added after that line and the matching delete was never written — so a store whose whole
job is to be cheap grew without bound. That is the one-liner. The structural half is that `remove()`
is the exit a session usually does NOT take: a session that exits at a usage limit, one whose tmux
was killed at the desk, one that went away across a `--continue` bounce — none of them pass through
it, and each leaves both files behind for good. Measured on the live host: **436 history files and 98
summaries against ~107 live sessions**, 2.8 MB and 392 KB. That is a tidiness and correctness leak,
not a performance problem, and the fix is sized accordingly — one deferred pass at boot, no
bookkeeping file that could itself go stale, no background cadence.

**`sweepSessionStores(dirs, alive, now?, maxAgeMs?)`** is deliberately pure fs — directories in, an
alive set in, files gone — for the same reason `convfork.ts`'s exports are: it is a delete loop, and
a delete loop should be assertable against a fixture without a `SessionManager`, a PTY or a tmux
server (`packages/host/test/sweepstores.test.mjs`). Three rules carry it:

- **The alive set has two halves, and both come from what already exists.** An id is alive if it is
  in the session map OR has a record in `<STATE_DIR>/live/` — the same store `rediscover()` adopts
  from. A tmux session this boot happened not to re-attach (server slow, `reattach` threw) still has
  its live record, so it is not an orphan. Inventing a second list to keep in step would be wrong
  exactly when the sweep is asked.
- **The age gate is load-bearing, but for a narrower case than it first appears.** Both halves of the
  alive set can come back short for reasons that say nothing about the sessions — a `rediscover()`
  that threw, a root mounted late — and with no gate one transient failure would answer by deleting
  every live session's prompt history. What the gate actually protects is a file whose session was
  ACTIVE RECENTLY during such a moment.
  It does **not** protect a live tmux session idle for longer than the gate, and this host
  accumulates those: such a file is past the gate and, with an empty map, absent from it too. The
  only thing standing between it and a delete is the `live/` read succeeding — which is why
  `aliveSessionIds()` distinguishes *no live store* (ENOENT, honest, sweep proceeds) from *the live
  store could not be read*, and returns null for the second. **A null alive set is not "nothing is
  alive" — it is "the question is unanswerable this boot", and `sweepSessionStores` answers it by
  deleting nothing** (`skipped: true`). That rule lives inside the destructive function rather than
  at its one call site, so it travels with the code and is pinned by a test. Skipping a pass costs
  kilobytes until the next restart; guessing costs a session its prompt history.
- **`live/` is pruned by `rediscover()`, not by the sweep.** `deleteLive` used to run only while the
  daemon watched a session end (`kill`, `remove`, the exit path), so a tmux session that died while
  the daemon was down — a reboot, a crash, a `kill-session` at the desk — left a live record that
  shielded its history and summary for good: on this desktop 162 of 277 records had no tmux session,
  the oldest seven weeks old. That was called conservative and not a bug, on the reasoning that only
  a live daemon can know a session ended. But `rediscover()` already holds the answer: a `tmux ls` of
  this host's own server. So right after adoption it deletes (`reclaimStaleLive`, the rules in the
  pure `staleLiveIds` beside `sweepSessionStores`, pinned in `sweepstores.test.mjs`; end to end in
  `e2e-livereclaim.mjs`) every record that is **provably** gone, and it is safe because each
  condition keeps on doubt:
  - **only past a listing that succeeded.** Every way `tmux ls` can fail to list — no server
    (after a reboot), a socket error, a permission error — exits non-zero, throws, and returns before
    the reclaim; a failure is never read as an empty listing. (Measured: "no server running",
    "error connecting", "Permission denied" all exit 1.) The cost is that a boot finding NO server
    reclaims nothing; the next boot with any session running does.
  - **only against the server the record belongs to.** `persistLive` stamps every record with this
    process's `TMUX_SOCKET_ID` (socket dir + `-L` name), and a record stamped with another server is
    kept — a listing of one server says nothing about another, and a dev host on a different
    `TMUX_TMPDIR` or `WATERPLANE_TMUX_SERVER` sharing the state dir would otherwise delete the
    service's records. A record from before the stamp is judged only by a host on the DEFAULT
    socket (`TMUX_SOCKET_DEFAULT`: neither override set) — the only way such a record's pane lives
    elsewhere is a host that once ran with an override.
  - **only past an age gate** (`STALE_LIVE_MIN_AGE_MS`, 1 h, e2e shortens it): `create()` writes the
    record in the same tick it starts the tmux client, but `new-session` happens in that client,
    asynchronously — a second host process listing the server in between would see a record with
    no session. An hour is orders of magnitude past that window; a spared record goes next boot.
  - **never what this host holds** — the session map and the parked set (a parked record has a LIVE
    pane, so it is in the listing anyway); never a record it cannot stat or parse (read with a plain
    parse, not `loadLive`, whose guard would rename a corrupt one aside); never a non-`<id>` name.
  Every backend runs in tmux (the one substrate) — opencode's panes too, and its seat reaper asks the
  tmux session, not the record — so there is no record kind that legitimately lacks a session. The
  orphan sweep, armed earlier but run 30 s later, then reads a `live/` that tells the truth, and the
  freed sessions' history and summaries go once they pass its own 7-day gate. `aliveSessionIds` is
  unchanged: still the map plus every record.
- **It deletes files and nothing else.** No recursion, no directory removal, and the filename must be
  a bare `<id>.json` — a traversal-shaped name is refused and left alone, never sanitised, which is
  `archive.ts`'s `deleteArchived` rule for the same reason: this function deletes.

It is armed from inside `rediscover()` rather than from `main.ts`, because its correctness rests on
being asked after re-attachment has filled the map, and on an unref'd timer so boot never waits on it
and it can never hold the process open. (Before tmux became the only substrate, the direct-PTY mode's
`rediscover()` returned immediately and the sweep still armed — every id from a previous boot really
was dead there.)

### `lastTurnAt`'s memo, bounded

`transcript.ts`'s `lastTurnAt` is asked once per session per settle with a hundred sessions live, so
it memoizes on the file's own `size:mtimeMs`. The map had no bound: an entry was added per PATH the
process ever asked about and none was ever dropped, so a long-lived daemon accumulated one per
conversation it had ever touched, closed ones included. The fix is the cap and nothing else — 512
entries, delete-and-reinsert on a hit so Map insertion order approximates LRU, oldest evicted past
the cap — because the I/O it guards was measured and is already negligible: 3 of 107 sessions had
turned in the last hour, the memo held for the other 55 resolvable logs, and a full cold pass is
12.4 MB once. Redesigning the caching or the 256 KB tail would be spending a refactor on a number
that is fine.

The function itself had no test at all, which mattered more than the map did: it feeds
`SessionInfo.lastTurnAt` → the web's `inactiveMs` → **the bulk-close cutoff**, so a wrong answer here
does not render wrong, it closes sessions. Every failure mode is a plausible number rather than a
crash, which is exactly what e2e cannot see. `packages/host/test/lastturn.test.mjs` pins the doc
comment's own reasoning: the newest `user`/`assistant` timestamp wins wherever it sits in the file;
the bookkeeping rows the CLI rewrites on every attach (`mode`, `last-prompt`, `atis-latch`,
`bridge-session`, `queue-operation`) are not turns, and neither is a message record with no usable
timestamp; the half-written first line of a tail read is skipped rather than thrown on; a missing
file and a tail holding no message record both answer null; and the memo both hits and invalidates.

### `backends/` — the binary this daemon drives, named

waterplane's central design choice is that it drives the real binary in a pseudo-terminal and never
re-implements it. That is what makes a *second* binary conceivable at all — and it is also what had
made the knowledge about the first one invisible. Before this, `claude` was not a concept in the
host; it was the string `"claude"` written out with its own `|| "claude"` default in six modules
(`sessions.ts`, `usage.ts`, `main.ts`, `update.ts`, `assess.ts`, `review.ts`), an argv block inline
in `SessionManager.create()`, a settings blob a hundred lines above it, and a handful of regexes in
`deliver.ts` / `echo.ts`. Every copy was correct on its own, which is exactly why nothing in review
would have caught the seventh reader spelling the default differently.

`backends/types.ts` is the shape: **`id`, `label`, `bin()`, `launchArgs()`, `delivery`, `caps`,
`models()`, `healthScope`**. Data plus two functions, deliberately — `bin()` and `launchArgs()` are
the only things a backend has to compute; the rest are constants and regexes. A third function per
backend is the sign this has started growing into a plugin interface, and goes back through review.

`backends/claude.ts` is today's behaviour, moved rather than rewritten: `claudeBin()` (the ONE place
`WATERPLANE_CLAUDE_BIN` is read), `hookSettingsArg()` (the `--settings` injection, which is a fact about
the binary and not about the session manager), the four-mode argv, the trust-prompt regex, the
composer rules, the paste placeholder and `isLocalCommand`. Its `models()` answers the ONE model
catalogue (`claudemodels.ts`): the built-in ids, read off the installed binary's strings, merged with
the owner's optional `models.json`. The phone used to carry a second copy; it now reads
`BackendInfo.models` off the wire and, before the first `backends` frame, shows a typed field and a
sentence — never an invented list (demo mode's fake host supplies a small fixture list instead).

#### `models.json` — adding and hiding claude models

`<config dir>/models.json` (`~/.config/waterplane/models.json`; `WATERPLANE_CONFIG_DIR` moves the dir)
is optional:

```json
{ "add":  { "aliases": ["my-alias"], "ids": ["claude-opus-6"] },
  "hide": ["haiku", "claude-opus-4-5"] }
```

`add` appends (de-duplicated), `hide` removes by exact id or alias from the built-ins AND from `add`.
Either key may be absent; unknown keys and non-string or empty entries make the file invalid. **An
invalid file is ignored whole** — the built-in list stands, one `[models]` line goes to the daemon log,
nothing crashes and nothing is half applied. The file is read when the catalogue is primed at boot, so
an edit needs `npm run restart`. It affects the `claude` backend only (claude-local, claude-endpoint
and opencode name their own models). A model id added here is passed to `--model` untouched: the
binary, not waterplane, decides whether it exists. `packages/host/test/claudemodels.test.mjs`.

`backends/claude-sources.ts` is claude's hook pipe as a `BackendSources` (`claudeBackend.sources`,
inherited by `claude-local`/`claude-endpoint`; behaviour-neutral: same edges, same order, same wire).
`/api/hook` → `turn.ts`'s `onHookEvent` ROUTES the payload (the router needs this host's session
table, which no source sees) and hands it to `postClaudeHook`, which translates it into the seam's
edges — health `up` on the first hook, `SessionStart` ⇒ `identified` + `ready`, `UserPromptSubmit` ⇒
`started` with the words, `Stop` ⇒ `ended`, `SessionEnd` ⇒ `ready` — consumed by `sidechannel.ts`
→ `sourceTurn` like opencode's. Two flags say what is different about it, as data: `inBand` (live
from `attach`, never published as `sideChannel`, health is `hooked`) and `turns.verifyEnds` (an
`ended` is a REQUEST held against the working line, and the screen turn watch stays armed). Only
`turns`: transcript and context stay the named jsonl readers, and the delivery proof stays
`deliver.ts`'s `prompt-hook` rung over the words `started` records. `claudehooks.test.mjs`.
**The router stays in core** because a source never sees this host's session table (live
`claudeSessionId`s, cwds, spawn times). Its cwd-fallback candidates are the sessions subscribed to the
claude hook pipe (`claudeHookWatched`), not "any backend whose `caps.hooks` is not none", so a
`plugin-inject` backend is never handed a claude hook. `turnHookSeen` stays a fact the sink sets, not a
source edge (`SessionEnd` maps to `ready` but never sets it). One known difference from the old switch:
a hook routed to a session whose channel already closed is dropped instead of applied to a dead record,
invisible because the exit path has already ended the turn.

**The rule that makes a second backend safe** is the one this repo already lives by: a heuristic
degrades to null or absent, never to a wrong number. `caps` is therefore read only to decide whether
a reader RUNS, never to decide what it answers — so a backend declaring fewer capabilities is
structurally incapable of making anything worse. A context meter that is not armed publishes
nothing, and the phone already renders "nothing here is measured" differently from "0%".
`healthScope` is the same idea aimed at `clihealth.ts`: the health board measures how well this
app's readers track the *claude* TUI, so a backend those readers were never written for would amber
it by simply existing — a rate describing no event at all.

**`backends/index.ts`'s `resolveBackend(id?)` refuses an unknown id in words.** The tempting shape is
`TABLE[id] ?? claudeBackend` — one character, no error path, and wrong in the one way that matters:
the id exists to choose which binary gets spawned with which flags, so substituting claude for a
name this host does not know means the launch that was asked for did not happen and something else
happened instead, with nothing on screen saying so. It throws, and the message names the id and
lists the ids that would have worked, because "unknown backend" leaves a person guessing at the
spelling. `durableOp()` treats a thrown failure as not remembered, which is the right memory here:
fix the id, send again. Absent or `undefined`, on the other hand, IS claude — that is how every
session that exists today launches, and an old client that has never heard of backends must keep
launching exactly what it launched before.

**What was deliberately NOT touched.** `deliver.ts`, `echo.ts` and `settle.ts` have the most
expensive failure history in this daemon — prompts stacked, prompts vanished, a Return pressed at an
empty box — so the descriptor DECLARES their literals while those files still own them, and the
stage that hands the regexes over is the last one, not the first. One consequence is a second copy
of `echo.ts`'s private `COMPOSER_CURSOR_RE` living in `backends/claude.ts`. Two copies of a rule are
two opinions waiting to happen, so `packages/host/test/backendargs.test.mjs` holds them to the same
answers row-for-row until the copy is deleted.

That test is also the regression pin for the argv itself, per launch mode — fresh, continue,
continue-by-id, pick, fork — because the failure it guards is silent in every way a failure can be.
A `--continue` that quietly becomes a fresh conversation produces no error and no empty screen, just
a session that has forgotten an afternoon of context, discovered by a person wondering why the agent
is asking again. The e2e suite cannot see it either: the stub binary ignores its flags.

#### `backends/claude-local.ts` — the real `claude`, pointed at Ollama (WP5)

`claudeBackend` spread over four changes: `launchArgs` adds `LaunchPlan.env`
(`ANTHROPIC_BASE_URL` = `WATERPLANE_OLLAMA_URL`, `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY=""`) and
**refuses a launch with no model in words** (the CLI would ask Ollama for a `claude-*` id and die with
`not_found_error` a minute in); `models()` reads `/api/tags`, drops only what Ollama's OWN `capabilities`
say cannot chat, and reads each window from `/api/show` (`windowFromShow`: the Modelfile `num_ctx`, else
the architecture's `context_length`; **0 or missing is absent**, and a failed `/api/show` keeps the id
with no window). Caps `usageLimits`/`usageProbe`/`remoteControl`/`contextMeter` are false and
`healthScope` is false. **Unreachable Ollama keeps the backend LISTED**: an empty catalogue plus
`BackendModels.unavailable` = `Ollama not reachable at <url>`, which rides `BackendInfo.unavailable`.
Cost is absent with no code of its own (`pricing.ts` prices only `claude-*`), and
`resolveContextWindow` refuses a non-claude id, so the claude table is never borrowed. Measured
2026-10-01 on claude 2.1.287 + `qwen3-coder:30b-64k` (probe: `scripts/probe-claude-local.mjs`): the TUI prints **no context gauge at all** after a
turn, hooks (SessionStart/UserPromptSubmit/Stop) and the jsonl work unchanged, so `contextMeter:false`
is the right cap, not a workaround. `packages/host/test/claudelocal.test.mjs`.

**Lean, warm, and the window sentence (2026-10-02, Ollama 0.35.0, `scripts/probe-claude-local.mjs`
with `PROBE_LEAN=1`).** The 64k window was half spent before
anybody typed: the first request carried 32.4k tokens, and the one-word turn took 65 s on a model
that was ALREADY resident — prefill, not loading (cold and unlean: 33.7k, 81 s). The built-in tool
schemas are ~27k of those tokens. `leanArgs` appends `--tools
Read,Edit,Write,Bash,Grep,Glob --strict-mcp-config` (default ON for claude-local only,
`WATERPLANE_CLAUDE_LOCAL_LEAN`/`_TOOLS`): 5.7k tokens, 5 s warm, 8 s cold, and tool calls still
work. `--tools` is the whole saving; `--disable-slash-commands` measured nothing once Skill was gone,
and `--setting-sources project,local` (−1k) would drop the person's own permissions, so neither is
used. `--strict-mcp-config` measured nothing in an empty dir and is kept so a repo's `.mcp.json`
cannot add schemas to every turn. The warm ping (`localrt.ts`'s `warmLocalModel`, `WATERPLANE_CLAUDE_LOCAL_KEEP_ALIVE`, default
`30m`, `off`) is fired from `launchArgs` and never awaited — `warmDeps` is the seam a test replaces
so no unit test loads 18 GB. Ollama's `/v1/messages` IGNORES a `keep_alive` in the body (measured:
expiry stayed at the 5-minute default), but a model loaded with an explicit `keep_alive` KEEPS it:
later `/v1/messages` calls re-arm the same 30 minutes. `backends/overhead.ts` reads the input of the
FIRST request of the most recently written conversation per model id (newest 40 project dirs, 300
files, 256 KB heads, never `subagents/`) into `BackendModels.overheadTok`; it and `contextWindow`
ride the wire per id (`BackendInfo.models`, both optional) and `shared/windowadvice.ts`'s
`windowAdviceText` is the ONE sentence, drawn under `ModelField` — only when both are measured and
the first request took at least a quarter of the window.

#### `backends/claude-endpoint.ts` — the real `claude`, pointed at any Anthropic-compatible URL

Same shape as claude-local, configured by `WATERPLANE_CLAUDE_ENDPOINT_URL` / `_MODELS` (`id` or
`id=tokens`) / `_KEY_FILE` / `_KEYCHAIN` / `_LEAN` / `_TOOLS`. Catalogue: the static list wins, else
Ollama's `/api/tags` (+ `/api/show` windows), else `/v1/models` (`data[].id`, no window guessed);
every model is `hosted` (a loopback LiteLLM still forwards to a cloud), never `zeroCost`.
**The key never enters argv, env, a log or the wire**: a launch's env reaches the tmux pane as
`env K=V` ARGV, so the CLI gets Claude Code's `apiKeyHelper` (`cat '<file>'` or `security
find-generic-password -w -s '<service>'`) merged into the `--settings` blob (`withSettings`), with
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` both EMPTY (either set would beat the helper). Measured
on 2.1.287 with a stub endpoint: the helper's output arrived as `Authorization: Bearer` and
`x-api-key`, over a claude.ai login. With no key the token is `none`, so a person's claude.ai
credential is never sent to a third-party URL. A key file readable by group/other is REFUSED
(`keyProblem`), and so is a keychain service that is not there (asked without `-w`). Unconfigured,
bad key, or no model list ⇒ LISTED with `unavailable`. `packages/host/test/claudeendpoint.test.mjs`.

#### The registry, the reader names and the sources seam

`backends/registry.ts` is the live list: claude and opencode are seeded as core (`registerCore`,
never removable), a plugin's backend joins with `registerBackend` and leaves with `unregisterBackend`,
and `onBackendsChanged` is how the `backends` frame gets re-broadcast without the registry knowing
a socket. Every refusal is a sentence that lists the ids that are live right now — a duplicate id
(registration never replaces, because two backends answering to one id is the substitution
`resolveBackend` exists to forbid), an id that is not a plain lowercase word, a core id asked to
leave, and a `caps` naming a reader this host does not have. `backends/readers.ts` is that closed
vocabulary (`PROMPT_READERS`, `TRANSCRIPT_READERS`): the `caps` enums are its keys, so core stays
closed at compile time while a plugin's string is checked at runtime — a screen reader is measured
against one binary and pinned by fixtures, so a backend names one and never brings its own. The
dispatch itself stays in `sessions/boxes.ts` and friends, each asking for the exact name it was
written for. `shared/backendsources.ts` is the pure types of a source per fact (turns, dialogs,
delivery proof, transcript, context, tokens, and `attach`); `backendInfos()` derives each wire
boolean from caps OR a source, so the phone sees no new field, and a source never lowers a cap.
`LaunchPlan.env` is merged after `spawnEnv` (`sessions/tmux.ts`'s `backendPaneEnv`) and the one
merged object feeds both the direct spawn and the `env(1)` prefix, so a per-launch variable cannot
reach one and not the other (`tmuxenv.test.mjs`, `backendregistry.test.mjs`).

#### The side channel and the one answer dispatcher (WP1b)

`sessions/sidechannel.ts` (`ChannelSlice`) is where a backend's `sources` are CONSUMED for the two
facts that steer a live session: it `attach()`es on `register()` for a descriptor with `sources` (a
backend without them never reaches it, so it is exactly today's backend), publishes the channel's
health as `SessionInfo.sideChannel` ("down" until the channel says otherwise — a `requiresChannel`
backend's sends are held meanwhile), feeds `sources.turns` into `turn.ts`'s one end-of-turn path
(`sourceTurn` → `setTurn`/`settleStop`, believed outright because a source's `ended` IS the end,
idempotent so a repeated `ended` counts one turn) with `hooked` true while that channel is up, and
publishes `sources.dialogs` through `applyPrompt` with `askId` = the CLI's own id and `nav: true`,
oldest open dialog first, reconciled against `pending()` on the `up` edge. While the channel owns the
dialogs the screen reader stands down (`boxes.ts`'s `screenReaderOff`: two readers on one box re-key
its fingerprint); on `down` every rung is handed back at once — `hooked` false, the channel's box
retired, a prompt check armed now. A dialog that states no question or no option is not published,
and a `pending()` of `null` leaves the screen reader on: nothing a source reports becomes a box it did
not state. **`boxes.ts`'s `answerBox` is the ONE answer dispatcher** — the phone's digit tap and its
`promptChoice` (`routes/session.ts`) and every gated plugin answer (`answergate.ts`, whose
`GateDeps.sessions` is now `get` + `answerBox` and nothing that types) go through it: the CLI's own
channel for a box it posed, else the walk for a `nav` box (or a `promptChoice`), else `"<n>\r"`. While
the channel owns the dialogs a box it does not know — resolved a moment ago, withdrawn — is refused in
words, never typed at. `sidechannel.test.mjs` (a fake `BackendSources`, no server),
`answergate.test.mjs`.

**A source may answer with keys, never type them (WP3c).** `SourceDialog.answer` may resolve to
`{ keys }` — the dialog is now in the CLI's own TUI (Copilot after its hook hold: the digit, no
Return). `answerBox` (`typeSourceKeys`) types them into the SAME session through `core.input`, the
path the digit tap takes, once, and only while the channel still has that dialog open — a source
that withdrew it before returning gets "no longer open" and nothing is typed. The bound is
`sourceKeysProblem`: at most `SOURCE_KEYS_MAX` (8) keys, each printable or one of the keys the walks
already press (`\r`, `\x1b`, `\x1b[A`–`\x1b[D`, an arrow counted as one); a control character, a
bracketed paste or a prompt's worth of text is refused in words. Why not a keystroke API for plugins:
typing into a session is core's, and a general one would be a second way to answer a box around
`answergate.ts`. A box with no channel never reaches this rung, so no source can address it.
`sidechannel.test.mjs` · `e2e-pluginbackend.mjs` (a `tuiDialog` → the stub TUI receives exactly `1`).

#### Plugin backends and parked panes (WP3a)

A plugin registers a backend through `api.backend` (`plugins/pluginapi.ts`'s `pluginDescriptor`
fills the core's half — `healthScope` false, absent anchors null, a bad launch plan refused in
words, a bad catalogue empty — and `registerBackend` refuses the rest); switching the plugin off
unregisters it. `main.ts` subscribes `onBackendsChanged`: re-broadcast `backends`, ask a NEW backend
for its catalogue (`backends/index.ts`'s `primeNewBackendModels` — boot priming never saw it), and
`sessions.retryParked()`. **Parking** is `sessions/tmux.ts`'s `adoptOrPark` / `retryParked` /
`settleParked` / `parkedLive`: `rediscover()` runs before external plugins activate, so a live
record whose `launch.backend` is unknown is held rather than dropped or adopted as claude; once
`loadAll()` settles, a record still unknown becomes an `alive` closed row with `unadopted` naming
the plugin that declares it (`PluginRegistry.backendOwner`), and a later registration adopts it and
drops that row. The hook sink is `POST /api/plugin/<id>/hook` (`api.ts`, loopback-only exactly like
`/api/hook`) → `PluginRegistry.hook`, which holds the response while the plugin's promise is pending
and answers `{}` at `maxHoldMs` or on switch-off. Reasoning: [plugins.md](plugins.md#backends-apibackend-hooksink-onhook).
`pluginbackend.test.mjs`, `scripts/e2e-pluginbackend.mjs`.

#### The four reading rungs and `livesources.ts` (WP1c)

`livesources.ts` is the one lookup from a session id to its live `BackendSources` (+ the
`SourceSession` and the attached handle's health): the side-channel slice installs it with
`setLiveSourceLookup`, every reader asks `liveSourceFor`, and with nothing installed every answer is
null — which is how a backend without sources stays byte-for-byte today's. It exists so
`deliver.ts`, `settle.ts`, `sessions/record.ts` and `sessions/ctxseries.ts` can each ask for ONE fact
without owning (or importing) the channel. The rungs: **delivery** — `sources.delivery.landed` is
OR-ed into `deliver.ts`'s submit proof beside the prompt hook, subscribed once AT the first Return
and floored at that press, so a landing can prove a submit and never stand in for one; asked only
while the channel is up; audit `submit: "source"`, no health observation. **Settle** — where
`keepsClaudeLog` is false, `sources.delivery.userTurns` is the evidence, under `logMatch`'s exact
rules (whole text, recency floor, the spent-turn ledger keyed on the source's turn id), and `absent`
still needs a list the source actually returned. **Transcript** — `sources.transcript.updatedAt`
replaces the opencode store's `MAX(time_updated)` poll when it can say; `read` is the document
(`source: "backend"`) only for a backend with `caps.transcript: "none"`, with `history` still the
last rung. **Context** — `sources.context.sample` is `contextUsedTok`; the window is
`backendContextWindow` (a 0 is not one), and without a window `contextTotalTok`/`contextLeft` are
absent. The claude-jsonl series and spark take the same configured window too (`contextWindow` in
`ctxseries.ts`: screen → measured → the backend's `config` → the id table → none), which is what gives
a `claude-local` session on an Ollama model an axis at all — the id table only knows claude's ids,
and an unconfigured model stays `none`, never claude's 200k. **Tokens** — `GET /api/tokenstats/<backendId>` answers from `sources.tokens.ledger`, keeps
`/opencode`'s store reader where opencode has none, and is `available:false` in words otherwise.
Tests over fake sources: `deliversubmit`, `settle`, `sourcerungs`.

### `sidecar.ts` — where an unattended completion is bought

Four things in this daemon spend tokens with nobody watching: the tab name
(`sessions/record.ts`'s `nameTab`; it was the per-turn summary until 2026-10-01), the assessment (`assess.ts`), the two reviewers (`review.ts`) and the
naming pass (`naming.ts`) — the last added after
this file existed, which is the point of it having an engine axis at all. Two of the four (the tab name and naming) are
toolless BY CONTRACT and may therefore take the local engine; the two that read a repo refuse it in
words. The first three had each grown their own `execFile(claude, ["-p", …])`, and the striking thing about the set is how
unequal it is. The assessment fires when a person taps it. A review fires when a person asks for a
verdict. The summary fires **once per turn-end per session**, on every open session, for as long as
anybody is working — it is the only call in this app whose cost is multiplied by how much the repo
is being used. It was already the cheapest call that could do its job (`--setting-sources user
--tools ""` and its own system prompt: 83k tokens → 1.9k, the 45x measured in `sessions.ts`), and
that is as far as flags can take it. The next question is not "how few tokens" but "whose tokens".

So this module is an **engine axis**, and nothing else. It does not decide when anything runs, what
a result means, or whether to write it down — `assess.ts` keeps its file-both-ways contract,
`review.ts` keeps its verdict JSON, `nameTab` keeps its once-ever gate and its persistence. All
that moves here is HOW the completion is obtained.

**Two engines.** `claude-p` is today's behaviour moved rather than rewritten: same argv, same
timeouts, same `--output-format json` envelope, same `detectHeadlessLimit` read. It is the default
for every task, so a host with no new environment variables set does exactly what it did before this
file existed — that is the whole safety argument for the change. `openai-compat` is one POST to
`{baseURL}/chat/completions` against a local server (ollama, llama.cpp, vLLM), **with no tools**.

**Why the local engine is not offered to everything.** A completion with no tools can only answer
from what is in its prompt. That is a perfect fit for the summary, whose contract already forbids
tools — it runs `--tools ""` precisely because the transcript is IN the prompt and there is nothing
to go and read; and for the
naming pass, which is handed the items' own words and asked what to CALL them. It is a category
error for the assessment and the reviewers, which exist to read a repo and write files. A task that needs tools therefore REFUSES the toolless engine in a sentence
naming the variable, rather than running it and reporting a judgement made without looking at the
code. Nothing falls back to claude either, there or on a malformed spec: a person who routed a task
at a local model did it to stop spending Anthropic tokens, and quietly spending them anyway is the
one outcome that defeats the only reason the knob exists.

**The routing grammar, and why it is not the obvious one.** `.env.example` is authoritative;
`parseSidecarSpec` implements it. The natural spelling — `openai-compat:<baseURL>:<model>` — is
ambiguous against real values, because both halves carry colons: the URL has a scheme and a port
(`http://localhost:11434/v1`) and the model has a tag (`gemma4:e4b`). There is no colon a splitter
can point at and be right. So the exact form separates them with a pipe, which cannot appear
unescaped in a URL and does not appear in a model tag. The colon form is still accepted because it
is what a person will type, but only in the shape where it is decidable: the URL must have a path,
and the split is the first colon after that path begins. `http://localhost:11434/v1:gemma4:e4b`
reads correctly; `http://localhost:11434:gemma4` is refused, because it could equally be a port or a
model and guessing is how a summary silently goes to a server that does not exist.

**What a local model is allowed to be believed about.** Measured on this desktop: `gemma4:e4b`
honours the one-sentence contract cleanly (24 completion tokens, no preamble, ~6.5 s warm for a full
session transcript). A REASONING model is a trap — one spent 421 of its 451 tokens on
`reasoning_content` and returned an **empty** `content`. Two rules come out of that. The completion
budget is generous (`WATERPLANE_SIDECAR_MAX_TOKENS`, 2048), because a tight one is spent entirely on
thinking and produces nothing at all; and the thinking is never read as the answer —
`reasoning_content` / `reasoning` / `thinking` are not looked at, and an inline `<think>…</think>`
block is stripped out of `content`, unclosed ones (the response that ran out of budget mid-thought)
included. What is left after that may be empty, and empty is a correct answer: it is the "" that
`summarize()` already treats as "leave the row alone". Every other failure — refused route, dead
socket, non-2xx, half-written body — lands on the same "". A stale summary costs nothing; an
invented one is a sentence a person reads about a session they are NOT looking at, and there is no
way to tell it apart from a true one afterwards.

**The timeout is not a guess.** ollama unloads an idle model, so the first call after a quiet spell
pays a cold load (~15 s measured here) before it emits a token. The default is 120 s, because the
cost of waiting is nothing — this call is advisory, runs off a turn boundary and blocks no session —
while a tight timeout would make the local engine look broken exactly when it is doing the thing it
was configured to do.

**No phrase matching for the local engine.** `detectHeadlessLimit` reads an ACCOUNT-level block out
of a `claude -p` envelope. A local model has no account and no such block, so running the detector
over its prose could only ever produce a false positive on a model that happened to paraphrase one.
It runs on the claude engine only.

**`runNameTask` keeps every flag `summarize()` has, and adds one.** CLAUDE.md's
standing rule is that a new unattended `claude -p` starts from the summary's flags and justifies
every one it DROPS. This one drops none — `-p --output-format json`, `--model`, `--setting-sources
user`, `--tools ""`, `--system-prompt` — and adds `--thinking disabled` for the measurement recorded
in a comment in `sidecar/sidecarname.ts` (thinking on: $0.0067–$0.025, 13–36 s, 1,044–3,371 thinking tokens; `--effort low` $0.0155, 28 s; the flag $0.0014, 2.8 s, 0 thinking tokens), which applies here more strongly: titling a sentence is not a problem thinking
improves, and thinking is the whole of what a pass like this costs. `maxBuffer` is
1 MiB, since the contract is one small JSON object; the limit detector is asked FIRST, because an
account block's envelope parses and its `result` is a quota banner. The one thing it does NOT copy
is `tidy()` — the summary's whitespace squash and 240-char clip would turn a JSON document into
something `JSON.parse` refuses.

**The local swap guard** (`localslot.ts` `localSwapGuard`, called in `sidecaropenai.ts` before the
fetch). Sidecar calls never count against the local-session cap — they are seconds long — but one
aimed at the SAME runner (host:port) as a local coding turn that is working on a DIFFERENT model is
skipped with one `sayOnce` and the `""` every caller already reads as "no answer": Ollama would
evict the coding model to load the summary's, and the turn pays a full reload for a tab name. Same
model, or nothing local working ⇒ the call goes.

Pinned by `packages/host/test/sidecar.test.mjs` (the spec parser including a model tag with a colon,
the four ways a `/chat/completions` body can be worthless, that the claude engine still unwraps
its envelope and still yields nothing on an account block, and that every task's routing variable is
spelled exactly once) and by `scripts/e2e-sidecar.mjs` and `scripts/e2e-naming.mjs`, which each run
a real daemon against a ten-line Node stub speaking `/chat/completions` — so CI needs no
ollama, no model download and no GPU.

### Smart pick — removed 2026-10-16

An opt-in, per-repo, unattended `claude -p` pass used to run right before a backlog item fired and
pick, merge or re-sort the repo's waiting items. It was removed after ~26 real passes produced 0
merges and 2 reorders — the cost and the pre-fire hold bought nothing a person wanted.

What survived: `handOrdered` is still the "placed by you" mark a drag (or a pinned assessment rank)
leaves, and nothing re-sorts rows automatically any more. The intent ladder keeps ONE microtask yield
(`await Promise.resolve()`) before each `go` claim, with the busy facts re-read and the ladder
re-asked (monotonic) after it — a kick runs the pass synchronously only that far, so a synchronous
batch of writes lands before any claim (~30 host tests pin that batching). The sidecar's measured
argv lives in `sidecar/sidecarname.ts` `runTextTask` (used by `runNameTask`/`runCommitTask`), with
the `--thinking disabled` measurement table as a comment there; `parseLoose` lives in
`assess/hassutil.ts`; `imagePaths`/`transportPaths` moved to `shared/itempaths.ts`.
`backlog-config.json`'s `smartPick` key is ignored on read and dropped on the next write;
`<state dir>/smartpick.json` is left inert on disk. `PROTOCOL_VERSION` is unchanged.

### `naming.ts` — what an untitled backlog row is called

A backlog row shows the first line of whatever somebody typed into it. That is honest and it does
not scan: forty rows of *"I keep losing the scroll position when I rotate the phone and come back
to the…"* is a list a person reads by reading, which on a phone means not reading it at all.
`packages/host/src/naming.ts` is one tap that buys the cheapest completion in this daemon —
toolless, no repo read, no git — and writes a three-to-eight-word headline and one of four kinds
onto the rows that have none. `@waterplane/shared`'s `naming.ts` is the vocabulary and every cleaning
rule; this file is everything that touches the world.

#### The rule the whole file is arranged around

**A name a PERSON typed is never replaced.** A headline is the only string in this app that a model
writes FOR somebody, over words they wrote themselves, in the place they look first — which makes
it the one string that can quietly stand in for their own writing. So the rule is enforced three
times over, and the repetition is deliberate:

- `IntentManager.name(id, n, by)` writes each half only where that field's `*By` is not `hand`, and
  returns **what it actually wrote**, per half. It is its own verb rather than two more fields on
  `edit()` precisely because the posture is the opposite one — `edit()` writes whatever it is given
  and stamps `hand` — and one function that sometimes overwrites and sometimes refuses, switched by
  an argument, is one function a caller will one day pass the wrong argument to.
- `buildNamingInput` does not even put a field a person has written in front of the model — and
  **a typed `label` counts as a title**, by `itemHeadline`'s own test (`typedName(label, text, 40)`).
  It did not, and the host and the phone therefore disagreed about what "needs a title" means: the
  display rule says a typed label beats a headline ALWAYS, so a headline bought for such a row is a
  headline nothing will ever show. With the phone's own `ids` the two agreed by accident — the cut
  was computed under the display rule — but `ids: []`, or a cut a moment out of date, spent real
  money on rows that were already named. A label that is merely the row's own first 40 characters is
  the DERIVATION this app writes itself, not a name, which is exactly what `typedName` is for.
- The finishing sentence SAYS how many fields were left alone (`N kept the name you typed`). A
  silent refusal looks identical to a model that said nothing, and this is the only place the rule
  is visible to the person it protects.

**The two halves are decided separately**, everywhere. A row whose title somebody typed and whose
kind nobody ever set is the ordinary case, and a rule that refused the whole row on one `hand` field
would leave that kind unset for ever while reporting the row as named.

**And `""` clears the value AND the author.** `backlog.update {headline: ""}` reaches
`IntentManager.edit`, which drops both, because absent means *nobody has said* — which is exactly
what clearing a title you dislike has to mean. Keeping `headlineBy: "hand"` on an emptied headline
would produce a row no machine may ever name, for ever, with nothing on any screen explaining why
it is the only untitled one in the list. A non-empty title the cleaner REFUSES (one that is merely
the opening words of the prompt under it) writes nothing at all and leaves what was there: refusing
is not clearing, and a tap meant to rename a row must never be the tap that un-names it.

**…and a refusal is SAID.** `edit()` used to answer a bare `true` here — `ok` meant "is there such a
row" — so a title the cleaner would not write was dropped in total silence: the phone closed its
editor, the row went on showing the old title, and the words somebody had just typed were gone with
nothing anywhere about it. *Never overwrite typed words with words nobody typed* has a quieter twin,
and that was it. `edit()` now returns `{ ok, refused? }`, `backlog.update` carries the sentence back,
and the route toasts it as `backlog: …` — the shape `intent.requeue` already had. It is NOT a failed
op: the rest of the patch landed, and what is reported is the one half that did not. The sentences
themselves are `headlineRefusedText`/`categoryRefusedText` in `@waterplane/shared`'s `naming.ts`, beside
the rules that refuse and with a node test, because a sentence assembled at a call site is a sentence
that can only be checked by driving a phone.

The rule that refuses also got narrower, and that was the other half of the same defect —
see [`naming.ts` under `packages/shared`](#packagesshared): the truncation test borrowed
`typedName`'s two-way comparison, which refused, for any prompt under 40 characters, every title
that opened with the whole prompt. Text `dark mode`, title `dark mode toggle for settings`: dropped,
silently. It is one-directional now (`text.startsWith(headline)`), which is the only direction that
means *this is a truncation of the item*.

#### Batches, and why the words go in WHOLE

`NAME_BATCH_ITEMS` (20) and `NAME_BATCH_CHARS` (40k) cut a repo into calls; the count is the cheap
bound and the characters are the honest one. Nothing is ever CLIPPED to make an item fit — an item
over the budget takes a batch of its own, at full length.

That is a deliberate choice (the removed smart pick clipped and marked the clip; a clipped item can
still be sorted, but a title is not like that). The half of a prompt a clip keeps is precisely the half this app already shows on the row, so
a title written from it can only ever be the truncation `cleanHeadline` refuses — money spent to
produce a drop and a note.

The batches run SEQUENTIALLY. The point of a batch is that one call is small, and three at once is
one large call with extra sockets; it is also what makes the account block mean something, since the
first batch to come back `limited` stops the rest instead of four more calls being spent finding out
the same thing.

#### One pass per repo, and the transient that says so

`NamingManager.running` is a `Map<repoDir, Set<id>>` and it is **transient exactly as `waiting` is**
— memory only, gone with a restart, riding `backlog.list` as `naming`. It means *right now*, never
*this row is locked*: nothing is held while a pass thinks, the backlog stays entirely usable, and
`name()` re-reads the live row before it writes, so a title a person types in that window is `hand`
by the time the answer lands and is refused by the ordinary rule.

Both refusals are SENTENCES rather than silences, and they are different facts a person needs told
apart: *a naming pass is already running for this repo* (two passes over one list write two titles
onto the same rows in an order nobody chose — `startAssessment`'s rule narrowed to one field) and
*nothing here needs a title*. The release is in a `finally`, because a throw that left a repo
holding a pass nothing will ever release would make the first refusal permanent until a restart.

#### Everything else

`NAME_MODEL` is `WATERPLANE_NAME_MODEL` (haiku). `NAME_SYSTEM` is pinned and its last line is
*answer straight away*, for the measured reason: the cost of a
pass like this is thinking, not input. There is deliberately no timeout knob — nothing is HELD behind this call, so the sidecar's generous default is right and a second
variable would be one nobody has a reason to turn.

`parseNamingText` is `assess/hassutil.ts`'s `parseLoose` with one difference: a bare ARRAY is accepted.
An array of of `{id, headline}` is
unambiguous, and every entry still has to name an id that was in the batch before anything is
written.

Every failure is the empty result, the way every other `sidecar.ts` caller treats one: a refused
route, a dead server, an account block, an answer nothing parses out of, a runner that throws. The
cost of that is exactly what it is elsewhere — the rows go on being called what they were already
called, which is their own first line. `namingSentence` is a pure function with its own test for the
same reason as any outcome string: it is the whole of what a person sees of this
feature, and a string assembled inside an async method can only be checked by running a pass.

#### The ack is not the pass

`backlog.name` is `durable: true` and the handler AWAITED `naming.start()`. Do the arithmetic: a pass
is up to ten SEQUENTIAL batches at up to `NAME_TIMEOUT_MS` (120 s) each, against the phone's
`OP_ACK_TIMEOUT_MS` of 20 s and `MAX_SEND_ATTEMPTS` of 8. So a pass that was working perfectly was
re-sent eight times — every one of them correctly suppressed by `opsInFlight`, so the host was never
in danger and nothing was bought twice — then shown on the phone as FAILED while it was still
running, after which the host sent up to eight acks for it.

`NamingManager.begin()` is the split, and it is `startAssessment`'s shape: everything that can answer
a person NOW answers now — one already running, nothing here to title — and the pass itself comes
back as a promise the route does not await. The ack carries `namingStartedNote(rows)`, which says the
NUMBER, because that is the one fact the tap does not already carry; the pass's own sentence arrives
as the toast it always was, whenever it lands, and `send` is a no-op on a socket that has closed by
then (the titles are on disk either way, which is what the tap was for). The rows ride `backlog.list`
as the `naming` transient in the meantime, which is what the list shows while it thinks. `start()`
survives as `begin()` in one line, for the tests and anything that genuinely wants to wait.

The wire is `backlog.name` (`contain`ed on the directory, `durable` because the op SPENDS a
completion and a queued phone re-sending it would buy the same titles twice), `backlog.update`'s
`headline`/`category`, and the four fields on `BacklogItem`. The AUTHORS cross the wire beside the
values because `itemHeadline` decides which string a row shows and the author decides whether the
row may be re-titled — a DTO carrying one without the other would make the phone guess at both.
`intent.post` forces any name off the wire to `hand`: a client may bring a title, never a claim
about who wrote it, for `post()`'s reason one field later — not "a client would not do that" but
"a client cannot say that".

`packages/host/test/naming.test.mjs` (the input's four filters, a typed `label` counting as a title,
both batch cuts, the whole-words rule, `edit`'s stamp, its clear and its spoken refusal, `name`'s
per-half refusal, `begin()` answering while the pass is still in flight, the manager's two refusals
and its sentences) · `scripts/e2e-naming.mjs` (a real daemon against `e2e-sidecar.mjs`'s ten-line stub: the
titles land with their authors on the phone's own list, a row the model omitted stays ABSENT, a
hand-named row is untouched and still takes its kind, a second pass is refused mid-flight, and a
misconfigured route writes nothing and says which variable is wrong).

## `dictate.ts` — speech the phone recorded, words back

### Why local, measured before it was written

Reported: *"So far I was using my android Gboard voice input for this project but
it is not good."* That is a true report about a real engine. Android's
dictation — and the Web Speech API the compose bar's microphone used, which on
Chrome is the same cloud service — commits each word as it is spoken. It never
sees the end of a sentence before deciding the start, so it punctuates badly
and mangles English identifiers inside German prose, which is exactly the shape
of every prompt written here.

Whisper sees the whole utterance first. The question was only whether a local
model is fast enough to be a dictation path rather than a transcription job, so
it was measured on this desktop before a line was written (M4 Max,
`ggml-large-v3-turbo`, Metal, via the copy the other local service already had):

| clip | audio | wall time |
| --- | --- | --- |
| English | 15.1 s | 0.79–1.06 s |
| German, with "OpenAI", "Eleven Labs", "GCP" in it | 28.6 s | 0.95 s |

About 30× realtime, with punctuation, and with the mixed-language technical
words intact. The clip is 32 kB per second over a tunnel already carrying a
terminal, so the whole round trip is roughly a second after you stop talking.

The same run CPU-only (`-ng`) takes 5.62 s for the 28.6 s clip at eight threads,
and the q5_0 quantization does not rescue it (5.03 s — this size is compute-
bound, not memory-bound). That is the number to quote for any machine without a
GPU whisper.cpp can use: still faster than realtime, but a wait rather than an
answer, and the fix there is a smaller model rather than a quantized big one.

### What this ruled out, and what it did not

Paid transcription was priced at the same time, per minute of audio: Groq's
whisper turbo at \$0.00067, Fireworks at \$0.0009, OpenAI `gpt-4o-mini-transcribe`
at \$0.003 and `gpt-4o-transcribe` at \$0.006, Deepgram Nova-3 at \$0.0035,
ElevenLabs Scribe around \$0.004–0.0067, OpenAI's realtime streaming at \$0.017.
At a heavy 12.5 minutes of dictation a day — about 375 minutes a month — the
dearest of those is a couple of euros a month and the cheapest is pennies. So
cost is NOT what decides this, and a note claiming it is would be wrong:

* **Latency decides it.** None of them can be faster than a path with no round
  trip, and the streaming one that would feel comparable is the most expensive
  line in the table.
* **Privacy decides it.** A prompt dictated here quotes the code being worked
  on. The local path sends nothing anywhere.
* **A prepaid cap was the ask** (*"a service where I can put 5 euro and consume
  it without overrunning it"*). OpenAI, Groq and Deepgram all do prepaid credits
  that hard-stop with auto-recharge off; ElevenLabs is a subscription and is the
  one that does not fit that sentence. None of this is needed while the engine
  is local, and the module's shape — one `transcribe()` behind a status probe —
  is what would take a second engine if a laptop with no GPU ever needs one.

### The posture is `readImageText`'s

This module DECIDES nothing, exactly like `readtext.ts`'s image-text reader that
it is modelled on. The sentence it returns is shown to the person who pressed
the microphone, who edits or drops it before it can reach an agent. There is no
repo in the route, nothing is written anywhere, and the audio exists only as a
buffer plus a file under `tmpdir()` removed in a `finally`. The log line it
writes on a failure carries the duration and the reason and never the words —
this is the one place in the daemon where a log could carry what somebody said
out of the process that heard it.

Every way it can fail is a different sentence at a 200, because "install
whisper-cpp" is an answer and not something to retry: the kill switch, no
binary, no model, a model named by hand that is not there, audio that is not
16-bit PCM, silence, a clip past the cap, and a run that failed or timed out.
`dictateStatus()` is asked BEFORE the microphone opens so a button is never
offered for a thing that will fail, and `doctor.ts`'s `dictate` line is always
`ok` for `checkCapture`'s reason — a desktop with no whisper model is not
broken, it simply falls back to the browser's recogniser, and the absence is
only worth naming because it is otherwise invisible.

### The format is the phone's job, and that is deliberate

`whisper-cli` reads 16 kHz mono PCM and nothing else. The obvious shape —
`MediaRecorder` on the phone, ffmpeg on the host — was rejected because ffmpeg
is a binary this daemon otherwise does not need, and on the machine this was
written on it was BROKEN (`Library not loaded: libx265.216.dylib`) while
everything else worked. A dictation path that dies because a video codec was
upgraded is not a dictation path. So the phone opens its capture graph at the
rate whisper wants and writes the 44-byte header itself (`shared/dictate.ts`),
and the host only CHECKS the shape — arithmetic that cannot fail for an
environmental reason.

`wavFacts` walks the chunks rather than assuming `data` at offset 36 (a
recorder that writes a `LIST` chunk is still writing a valid WAV) and measures
the body by the bytes that ARRIVED rather than the length field, because a
socket that died mid-upload otherwise reports the duration of audio that never
came.

### The model lives in XDG, and turbo wins

Weights are machine state, not repo state: `~/.local/share/waterplane/models`
(`$XDG_DATA_HOME` honoured), because 1.6 GB per repo under `.waterplane/` is 1.6 GB
per repo. `WATERPLANE_WHISPER_MODEL` is taken as said INCLUDING its absence — falling
through to a scan would answer a typo by transcribing with some other model,
which is a wrong answer wearing the right shape. The scan prefers turbo and the
unquantized one of those, since on this desktop both run in about a second and
the difference is audible in exactly the mixed-language case this exists for.

Language defaults to `auto`: pinning one makes whisper TRANSLATE the other
rather than transcribe it, and these prompts switch language mid-sentence.

Handed audio with no speech in it, whisper emits its training corpus's subtitle
boilerplate ("Untertitelung des ZDF für funk, 2017"). Those strings are stable
and documented, so matching them needs no threshold — but only the unmistakable
ones are listed, because "Vielen Dank." is also a perfectly ordinary thing to
dictate. `packages/host/test/dictate.test.mjs` pins the model choice and every
no-engine sentence; `packages/shared/test/dictate.test.mjs` pins the format.

### The whisper daemon first, whisper-cli as the fallback

`whisper-cli` loads the whole model for every clip: of the ~0.95 s a 7.6 s
German dictation took, most was the 1.6 GB load. A resident whisper daemon (a
separate repo) is a loopback-only daemon that keeps one `whisper-server` per
model resident, unloads it after ten idle minutes, and is shared with the
another local service's read-along route — one resident model instead of one load per
clip per consumer. The same clip through it: ~0.74 s warm. The model, the
decoding settings and so the words are the same.

It is an accelerator, never a dependency. `viaWhisperd` returns null — use the
CLI — when the whisper daemon is not running, is busy (503), failing (502) or does not
have the model (404); only a 400 ("that is not audio") is final, because the
CLI would refuse the same bytes. The artifact and prompt-echo refusals apply
to both paths, and the whisper daemon's own `heard_no_speech` (a transcript that is only
`[Musik]`-style annotation) is refused the same way. `WATERPLANE_WHISPERD_URL=off`
is CLI only; `WATERPLANE_WHISPERD_MODEL` picks the model (the benchmark in
that daemon's own benchmark report is what the default rests on). The GET the phone asks
before opening the microphone (`dictateStatusLive`) also says yes when only
the whisper daemon is there; `doctor.ts` keeps the synchronous CLI check.

`WATERPLANE_DICTATE_KEEP=1` is the one deliberate exception to "nothing is written
anywhere": each successful clip and its text are saved to
`~/.local/share/waterplane/dictations` (outside every repo, 0600) so real dictations
accumulate for re-running that benchmark. Off unless set, and the log still
never carries the words.

### The person's vocabulary — `shared/dictateterms.ts`

Some words are used constantly and never heard right: an app called `BA3`, a
product name the model has not seen. whisper takes an initial prompt
(`--prompt`) and conditions decoding on it, which is the only lever that moves
the SPELLING rather than patching it afterwards. The host has no way to know
the words, so the list lives on the phone as a synced setting
(`waterplane.dictate.terms` — a word is misheard the same way on every device, unlike
the language, which is a fact about the microphone) and rides with each clip in
the query string, re-parsed and re-capped on the host by the same function.

The prompt's SHAPE was measured, on a clip saying "kwixel" (large-v3-turbo):
`Kwixel.` alone changed nothing — "Quixel" both ways — while `Kwixel, Kwixel.`,
`BA3, Kwixel.` and a "Glossary:" lead-in all spelled it the person's way, and
none changed a German clip in the same run. So the prompt is the bare
comma-separated terms, a list of one said twice, and no English lead-in.

A prompt biases, it does not guarantee, so each line may also name what the
term keeps arriving as (`BA3: bee a three`) and those are replaced afterwards.
Without any, a single-word term arriving SPLIT (`BA 3`, `B.A.3`) is rejoined,
and one that is identifier-shaped (three characters or more, a digit or an
inner capital) is re-cased. An ordinary-word term is never re-cased, or a
term `Go` would rewrite every "go" anyone said. Given a prompt and silence,
whisper sometimes answers WITH the prompt — the same family as the subtitle
boilerplate — so a transcript that is the prompt is refused as no speech. The
browser engine cannot be prompted and gets the corrections only.
`packages/shared/test/dictateterms.test.mjs`.

## `commitmsg.ts` — the commit message the phone asks the desktop to draft

### It is the summary's call wearing a different prompt

Reported as two halves of one ask: *"we have a functionality already that makes
a cheap call without thinking to generate the conversation title. Add a button I
can press to generate this. Use the same mechanism also to generate a commit
comment for the git feature."*

So it is the same mechanism, deliberately and to the letter. `runCommitTask` is
`runNameTask` — literally the same function behind a second routing knob — which
means the argv is `summarize()`'s four measured flags plus `--thinking
disabled`, and CLAUDE.md's rule about a new unattended `claude -p` (start from
those flags, justify every one you drop) is satisfied by dropping none. What a
second hand-written `spawn` would have cost is not hypothetical: the flags in
this daemon are worth 45× on the summary alone, and a copy is how one of them
quietly stops being true.

Except that this call is not unattended. Nothing fires it on a turn boundary, a
tick or a schedule; there is one caller and it is a button. That is also why it
has a timeout knob when the naming pass deliberately has none — somebody is
looking at the button they just tapped.

### Why the recent subjects are in the prompt

`--setting-sources user` drops the project's own `CLAUDE.md`, which is where a
repo's commit style would be written down — 12k characters of it here, to answer
"how does this repo word a commit". Ten subject lines off `git log --format=%s`
are ~400 characters and say the same thing by example. That is the cheap half of
the trade, and it is what lets the flag stay.

### `gitPendingDiff`, and why not `gitReviewDiff`

The diff has to be the one `Commit all` would record: tracked changes against
HEAD, plus the untracked names `git add -A` sweeps in. `gitReviewDiff` diffs
against **main**, which on a feature branch carries work that is already
committed — perfect evidence for a reviewer and the worst possible input for a
message about what is being committed now. Untracked files arrive as NAMES and
never as contents, and the prompt says so, so the model cannot describe a file
it was never shown.

### Two refusals that are the whole point

**A trailer never travels.** These models reproduce `Co-Authored-By:` and a
"generated with" line unasked. On a commit a *person* is making from their
phone, both are false claims about who wrote the change, so
`shared/naming.ts`'s `cleanCommitMessage` drops them — silently, because the
message around them is usually fine and a refusal would read as the call having
failed. The subject cap is the opposite: a refusal, not a clip. A subject is the
one line `git log` shows everybody for ever, and cutting one mid-thought writes
a sentence nobody wrote.

**Typed words are never overwritten.** An empty commit box takes the suggestion
straight away; a box with anything in it gets the draft offered *above* it with
*Use this one* / *Keep mine*. That box is the last copy of those words — there
is no listing and no undo behind it — and seeding over a draft is a delete
(CLAUDE.md's rule, `seedSheetDraft`'s reason). Every other failure is a
sentence under the form: a tap that spends a call and says nothing is what the
whole path is written around.

## `sessions.nameNow()` — naming a conversation because somebody asked

`nameTab` fires once per session ever, off the first prompt, and
that gate is a feature rather than a saving: a tab that renames itself as the
conversation moves is a tab whose position cannot be learned, which is the whole
reason the strip exists.

`nameNow` is the other half of the same rule, not a hole in it. The moment is a
person's, so the rename is one they will not be surprised by and the cost is one
they chose. It is ONE cheap toolless call, with no summary call before it (there
is no summary any more). With no prompt sent yet it answers "no prompt has been
sent to this session yet".

Its input is the first prompt PLUS the last `RENAME_RECENT_PROMPTS` (4) later
prompts, each clipped to `RENAME_RECENT_CHARS`, typed slash commands left out
(`recentPromptsOf`, worded by `RENAME_PROMPT`: recent weigh most). It used to be
the first prompt alone, the automatic pass's input — and that was the one input
that cannot answer the tap: a person asks because the opening prompt's name went
stale, and a session opened on "continue" or a bare command came back "(none)"
every time, however much work followed. Still prompts only, never the screen or
output; ~3k characters at most.

`s.naming` is held across the call, so the automatic pass cannot start a second
naming behind this one and land after it. Every failure answers a sentence and
leaves the existing name exactly where it was: absent is this field's shipped
state, and a wrong title is the version of *degrade to a wrong number* that a
person taps.

## `permmode.ts` + `sessions/livemode.ts` — the footer's mode, and switching it from the phone

The desktop's mode menu (manual / accept edits / plan / auto, plus ultracode) has
one source of truth the host can see: the row the CLI draws under its composer.
`SessionInfo.permissionMode` is only what a session was LAUNCHED with, and a
shift+tab at the desk — or a box's "Yes, and switch to auto mode" — moves the
real mode without telling anyone.

`permmode.ts` reads that row off the RENDERED grid (`screenlog.ts`'s `gridText()`,
never a stripped byte tail). Measured on claude 2.1.293 by pressing `BTab` through
the cycle in a private tmux server, at 100, 46 and 28 columns; the grids are the
fixtures in `packages/host/test/fixtures/permmode/`:

- `⏵⏵ accept edits on` / `⏸ plan mode on` / `⏵⏵ auto mode on` /
  `⏵⏵ bypass permissions on` / `⏵⏵ don't ask on`, usually followed by
  `(shift+tab to cycle)`.
- **The default mode is labelled too: `⏸ manual mode on`** — wherever auto mode
  exists. The brief this was built from expected no label. An older binary (or an
  account without auto mode) draws none, and its idle footer says
  `? for shortcuts`; so "no label" reads `default` only beside that hint. A
  footer with neither is a transient message or a menu, and reads null.
- The cycle: auto → manual → accept edits → plan → auto. `bypassPermissions`
  joins it (between plan and auto) only when launched with it; `dontAsk` exists
  only as a launch mode — the first shift+tab leaves it and it never comes back.

The label is read **only under the newest composer frame** — a full-width rule, a
`❯` row adjacent under it, the rule that closes it, then at most six footer rows.
So a choice box, a picker or a slash menu (all of which replace or push away the
footer) read as null, and words in the transcript that SAY "plan mode on" are
never under a composer. With ultracode on, the composer's top rule wears a label
(`──── ultracode ─`); `echo.ts`'s composer anchor does not accept that shape (a
delivery into such a session takes its old distance fallback), and this reader
must, or turning ultracode on would blind it.

**Ultracode** has no footer row. Two sources, in order: the composer's top-rule
label (drawn for as long as it is on), and the newest line the CLI printed —
`Ultracode on (this session only): …`, `Ultracode off. …`, or a refusal
(`Ultracode needs dynamic workflows enabled`, `Ultracode isn't available on …`,
read as off). The model picker's `· Ultracode on (/effort)` and the effort
picker's `Ultracode  on` are mid-row and never count. A BARE top rule is "off"
only once this session's composer has worn the label (`ultracodeLabelSeen`):
on a binary that never draws one, a bare rule says nothing.

`sessions/livemode.ts` puts both on the session:

- **`liveMode` is the screen now, or absent.** Re-read on the quiet tick
  (`turn.ts`'s `markIdle`, beside `checkContext`), `updated` only on a change. A
  null reading DELETES the field rather than keeping the last one: the thing that
  hides the footer is usually a box, and a box can change the mode. Never
  persisted (`live/` records carry no `SessionInfo`), so after a restart the first
  quiet tick reads it again. Claude's TUI only (`caps.promptBoxes ===
  "claude-numbered"` with permission modes); another backend has no field.
- **`ultracode` is sticky**: the confirmation scrolls away, so the last screen
  that said something stands until another does. Absent until one did. Memory
  only, like `liveMode`.
- **`setMode` (`session.mode`) presses shift+tab like a person.** Refused in words,
  with nothing pressed, for a non-claude session, remote control off, an open
  question box (shift+tab would go to the box), or an unreadable footer. Otherwise
  one `\x1b[Z` at a time through `sessions.write`, then the live grid re-read every
  60 ms for up to 1.5 s until the footer CHANGES; it stops on the target, when a
  mode repeats (the cycle came round: "plan isn't in this session's shift+tab
  cycle", the reply carrying wherever it stopped — normally the start), when a
  press moves nothing, or after 6 presses. It never counts positions in a cycle it
  was told about: the cycle differs per launch, and a count would land one off.
  Serialised per session (`Session.modeChain`), so a double tap is one walk and
  then "already there". Not durable, not queued, not in the ack ledger — a switch
  delivered late changes what an unwatched session may do unasked (`session.name`'s
  reasoning). The reply is `session.moded` to the asking socket; `liveMode` reaches
  everyone with the `updated` it publishes. `packages/host/test/permmode.test.mjs`.

## `repohealth.ts` — the codebase's own vital signs, asked for from the phone

`tools/repohealth.mjs` is a **zero-token metric series over git history**: git, regex and
arithmetic, one row per first-parent commit in `.waterplane/repohealth.jsonl`, the sentences about what
MOVED in `.claude/outbox/repohealth.md`, the four magnitudes drawn in
`.claude/outbox/repohealth.html`. Its constants are pre-registered and its backfill is committed as
a fixture, so a changed definition is a two-part commit that shows the history rewriting itself.
`repohealth.ts` is the small host module that lets a phone ask for all that: `GET
/api/repos/:id/repohealth` describes the series, `POST /api/repos/:id/repohealth/refresh` brings it
up to date, and both always answer 200 with an `ok`.

**Why it is its own module and not `builds.ts`.** On paper a refresh is a build — a command, a
worktree, artifacts in the outbox when it finishes. It is not, and the difference is the part that
matters. A build entry is *configured*: it is whatever string somebody put in `builds.json`, it may
ask for parameters, it runs in a PTY so a person can watch it, and its deliverable is "files written
since the run started", falling back to the newest thing it can find. Here the command is not a
parameter at all — it is three fixed subcommands of one resolved engine — there is nothing to
watch, because the two outputs have known paths, and "what did it write" is not a guess. Folding it
in would put an arbitrary configured string on the same path as this one, which is exactly the
distinction worth keeping.

### Which engine reads a worktree, and why that is not a containment change

For most of this module's life the engine WAS the worktree's own `tools/repohealth.mjs`, and a repo
without one got `tool: false` — twelve of the thirteen repos on this desktop. The phone drew a dead
end whose only implied remedy was to copy ten thousand lines of tool, plus a fixture of *this*
repo's history, into the other repo. The engine takes `--root=<path>` now and derives what a repo is
written in from an extension census, so one copy reads every tree, and the resolution is:

1. **The worktree's own `tools/repohealth.mjs`** when it exists — argv `[path, step]`, cwd the
   worktree, and deliberately **no `--root=`**. A repo that ships the tool is the authority on its
   own root: it may be a version either side of this one and may default somewhere on purpose. It is
   also what keeps this repo self-hosting and every test written against that shape green. The flag
   is a single argv token precisely so an older parser ignores it rather than reading a path as a
   subcommand, so the omission is about *who decides*, not about compatibility.
2. **The bundled engine** — `WATERPLANE_REPOHEALTH_ENGINE` when set, else this checkout's own copy three
   hops up from the module, the same rule `main.ts` uses to find `.env`. It resolves identically
   from `packages/host/src` under tsx and from `packages/host/dist` after a build.
3. **Neither** ⇒ no engine, and the sentence says THE DESKTOP has none. The old sentence blamed the
   repo, which after this change is never the reason and always the wrong place to look.

The containment question is the one a reader should ask, because "the daemon runs a script against a
directory" is new. The answer is that nothing was widened: a worktree reaches this module only as an
`id` matched against `discoverTargets(ctx.root)` — directories under `WATERPLANE_ROOT` holding a `.git`,
plus the entries their own `git worktree list` reports — so **no path in the request is ever read**.
`--root=` is that already-discovered worktree verbatim; the engine path is a host constant or an env
var on this desktop; there is no shell and the argv is fixed. `paths.ts`, `containRepoDir` and
`scaffold.inRoot` are untouched. What changed is what the host may RUN against a directory the
client could already name, not what a client may name.

`status` also carries what a phone needs before a repo has ever been measured — the first-parent
commit count, the engine's version, the active language packs and their file counts, the derived
source groups, and the exact re-cut command for that root and that engine. All of it is parsed
leniently, field by field: a repo carrying an older copy of the tool prints none of it and must
still work. Field by field is load-bearing here — this parser rebuilds its result from the fields it
names, and the last field added to this wire reached the host and was dropped on the floor with no
error anywhere, which took a live read to find.

**Why it is not `assess.ts`, which is the sharper half.** Every other unattended runner in this
daemon goes through `sidecar.ts`, because every one of them buys a model call. This one must be
*provably unable to*. `tools/repohealth.mjs`'s own header argues out why `judge.mjs` — the one paid
command — is a dynamic `import()` inside a single branch: a top-level import would put a model call
one transitive hop from `update`, which runs unattended, and an unattended spender is how a tool
that cost nothing starts costing something nobody chose. A host module that reached for
`sidecar.ts` for any reason at all would hand that guarantee straight back at the seam. So this
module imports none of the spender machinery, and `scripts/e2e-repohealth.mjs` pins the other end of
it: across every subprocess the daemon spawned, `judge` never appears in the argv log. The tool's
test proves the free path cannot *import* the paid one; the e2e proves the daemon cannot *invoke*
it.

**One run per worktree at a time, and it is load-bearing rather than tidy.**
`.waterplane/repohealth.jsonl` is append-only. `update` loads the file, works out which shas are missing
and appends the rest. Two of those overlapping both read before either writes, and both append a
row for the same commit — and there is no undo for that. The duplicate is in the series for ever,
and every later reading is drawn through it: the rank of a value within its trailing window and the
sign of its trailing slope are both computed over rows, so a doubled row silently re-weights the
window it lands in. Single-flight is keyed by WORKTREE and not globally, because two different
repos measuring themselves at once is harmless and a global lock would make one phone wait on
another's backfill for no reason at all.

**The refresh is a plain POST and not a durable op with an ackId.** Everything on that ladder exists
because words ran twice or never ran — a prompt typed into a live session, a scheduled item, a
delivery that has to survive the daemon dying. None of it applies here. The refresh types nothing
into a session; the tool is idempotent by its own construction, so a second `update` over the same
HEAD appends nothing and says `nothing new`; and what a durable op would buy is delivery an hour
late, which for a repo-health reading means measuring a tree nobody is looking at any more. The
honest failure mode for a read-and-redraw is "it did not happen, tap it again", and an ack ledger
around it would be ceremony that makes the stale answer *more* likely to arrive.

**A refusal answers 200, because a refusal is not an error.** Exit 3 out of `update` is the tool
having run, looked at the file, and declined — the series holds rows measured under two definitions
of the same metric, and appending would put them on one plot while leaving every row individually
correct. The refusal it prints is a paragraph that ends in the one command the reader is supposed to
run themselves. `{ ok: false, refused: { text } }` at a 200 keeps that paragraph; a 4xx or 5xx
collapses it into the phone's generic "the request failed", which is the one state that throws the
remedy away. The stderr is relayed VERBATIM for the same reason the tool refuses instead of
rewriting: a host that paraphrased would be a second place the remedy is written, and the two would
drift. Nothing applies itself — the module does not delete the series, and it does not offer to.

**Staleness is counted in COMMITS, not in wall-clock.** The obvious line is "last measured three
days ago", and it is the wrong number twice. The series has one row per first-parent commit, so
"up to date" means "there is a row for HEAD" and says nothing about the calendar. And this repo's
own history has a 57-day hole in it: across that gap a commit distance of 0 is exactly right and a
day count of 57 reads as the tool being broken, so a reader would go looking for a fault that is a
holiday. `behind` is therefore not a git command at all, and the host runs none in this path
either — `repohealth.ts` has no `rev-list` anywhere in it. `listCommits` reads the WHOLE
first-parent history once, oldest first (`git rev-list --reverse --first-parent --format=… HEAD`),
and the tool's `status` subcommand finds the last row's sha in that array and subtracts its index
from HEAD's — `commits.length - 1 - at`, index arithmetic over a list already sitting in memory,
not a second git call scoped to `<last row>..HEAD`. The host only parses the JSON line this prints;
re-deriving `behind` itself would be the daemon re-implementing a definition of the series that the
tool already owns, which is the one thing this module is built not to do. A tree nobody has touched
for a month is not stale — it is measured.

**The plot is a second read, not a field of the status.** They answer different questions. A status
is what the series IS — how many rows, under which `PREREG_VERSION`, through which commit — and it
is the answer every caller needs, including the ones that will never draw anything: the repo row,
the staleness sentence, the refusal warning. A plot is what the series LOOKS LIKE: every point of
every tracked scalar, which is a couple of orders of magnitude more JSON. Folding the points into
`status` would make the cheap answer wait on the expensive one and would hand it to callers that
cannot use it — a phone older than the drawing still has to be told how far behind the repo is, and
an APK in the field is exactly the reader that is older than the feature. Two reads at ~50 ms each
over the same file is not a cost worth trading that for. Both are still reads: the GET's argv is
`status` then `plot` and nothing more, and neither appears in a refresh's three steps, so a drawing
that failed can never be the reason a series did not get appended to.

**A failed plot is an absent field, never a failed view.** The read route has exactly one job that
cannot be allowed to fail — saying what is on disk — and the drawing is an extra that arrived later.
A repo whose tool predates the `plot` subcommand exits 2; a series with nothing in it has no points;
a line that arrives truncated fails validation whole. All three land as `plot: null` beside a
`series` that answers normally, because the alternative is a sheet that shows nothing at all about a
perfectly healthy series on the day the drawing half broke. It is the same rule as everywhere else
in this file — degrade to absent, never to a wrong number — applied one field at a time rather than
to the response.

**…and the null now says which of those three it is, because one of them has no remedy.**
`plot: null` says a chart could not be drawn. It does not say whether the *refresh* button would
change that, and the sheet's standing sentence promised it would: *the repo-health engine read no
series to plot here — refresh it to measure one*. That is right for a repo nobody has measured. It
is false for ever for a worktree carrying its own copy of the engine older than the subcommand: a
repo that ships the tool is spawned WITH that copy and WITHOUT `--root=` — it is the authority on
its own root — so the desktop's newer engine never reads it, every tap runs the same old copy, and
the sentence aims the reader at the one control that cannot help. So `readPlot` returns a reason
beside the null and the view carries it as `plotError`: exit 2 is *this engine has no `plot`
subcommand*, worded by WHICH engine ran (update the copy in this repo, or update the desktop's
checkout), a timeout and any other exit are *the chart could not be read* in `classifyExit`'s own
words, and the ordinary "no series yet" carries no reason at all so the standing remedy stands.
`repoHealthPlotUnavailableText` takes it as a second argument and REPLACES the remedy with it
rather than printing both — two sentences, one of them pointing at a dead button, is worse than the
one that is true. No repo on this desktop is in that state today; the state is designed for
explicitly, here, which is exactly why the sentence had to stop lying about it.

### A repo's own readings — and whose a reading is

The engine's readings are the same method in every repo, which is what makes the health index
comparable across repos — and what makes them blind to anything only one repo knows about itself.
waterplane's own example: how many of the ten CLI screen/log readers are tested against a capture from
the installed `claude` (`tools/screenfixtures.mjs --reading`). So a repo may declare readings of its
own in a COMMITTED `.waterplane-shared/health.json` (`REPOHEALTH_OWN_FILE`; the committed per-repo
config dir `builds.json` already uses — `.waterplane/` is gitignored and holds this desktop's own
things): `{ "readings": [{ key, name, means, better: "lower"|"higher", unit?, run: [argv…] }] }`.

- **Run at HEAD only, by `update`** (`tools/repohealth/own.mjs`): no backfill, no checkout, so a
  reading's history starts when it is declared and every row before is a hole, never a 0. It runs in
  the checkout as it stands — the one caveat for an author: an uncommitted edit is in it.
- **One JSON number or `{"value": n}` on stdout, or ABSENT with the reason** — non-zero exit (its
  last stderr line quoted), 30 s timeout, more than 64 KB, a program not on PATH, text, NaN. At most
  eight run; the rest are listed absent. A file that is not the shape is refused whole, in words.
- **Beside the measurements, never one of them.** Stored under the row's `own` key, which no metric,
  no `readings.mjs` series and no index entry reads; stripped from `fixture.json` (it cannot be
  recomputed from a sha); `PREREG_VERSION` and the pack hash do not move. `plot` ships them as
  `own: { file, declared, series, absent?, problems? }` with `source: "repo"` on each series, and
  every central series carries `source: "central"` — the engine's, worded `BRAND.displayName`'s on
  the phone, so a rename never touches the wire. A scope's plot has no `own` at all.
- **Trust** is the paragraph in `repohealth.ts`' header: this is repo-supplied code run by the
  daemon, the same trust a repo's own `tools/repohealth.mjs` and its build commands already get.
  Declaration read out of the commit (only committed words run), argv only, cwd the measured
  worktree, a minimal env (no key the daemon holds), nothing from a request in the argv.
- **The phone names provenance once per group, as a heading** (`RepoHealthOwn.tsx`, its states in
  `repoHealthWords`' `ownShow`) — "waterplane's readings — measured the
  same way in every repo", "<repo>'s own readings — declared in <file>" — never a badge per tile.
  An own tile carries the repo's `means` and the direction the REPO says it wants ("usmc aims for this
  to rise"), never the sheet's verdict. A repo declaring nothing gets ONE line naming the file; an
  engine sending no `own` block (older, or a repo's older copy) gets nothing, because absent is not
  "declares none". The index's caption says it is built from the engine's five only.

### A repo's say over the central readings — disable or override one, never fork the engine

A repo that disagreed with ONE of the five index readings used to have one exit: ship its own
`tools/repohealth.mjs`, which replaces the whole engine (rule 1 above, still honoured) and freezes the
repo on the day it forked. The same committed `health.json` now carries a `central` object keyed by
index entry (`size`, `retouch`, `hatches`, `context`, `untested`; `tools/repohealth/central.mjs`):
`{ "disable": true, "why": "…" }` or `{ "run": [argv…], "why": "…", "means"?: "…" }`.

- **`why` is required.** Without it — or with an unknown key, both verbs, neither, a bad argv — the entry
  is IGNORED and the sentence lands in `central.problems` on the row and the plot, the way an own reading
  with a bad field is listed absent with its reason.
- **Disable** runs nothing and is honoured per commit from that commit's own declaration (the file is
  read only at the commits that touched it, `declarationsByIndex`). The reading is still measured and
  drawn; it leaves the index mean, and the baseline needs only the entries still enabled (all five
  disabled = no index, never 100).
- **Override** runs in `own.mjs`'s sandbox and prints the number in the central reading's OWN unit,
  lower = healthier (`UNITS`: `retouch`/`untested` a fraction 0–1 — over 1 is refused, not clipped).
  **HEAD only**, like own readings: no history before its first measurement, and a recut restarts it
  at one point. Older rows keep the engine's value; the central value is measured beside the override
  on HEAD too, so dropping the override has history to fall back to.
- **The fingerprint makes a tweak a gap week (score measured, move not compared), never a move.** Each row holding the field carries
  `central.fp` over what was APPLIED (disabled keys + overrides that RAN, with argv); `healthIndex`
  marks a gap where a week's fingerprint differs from the one before, exactly as for a prereg change (`gapReason: "central"`).
  Fixture: `central` is stripped like `own`.
- **Wire**: each central plot series may carry `variant` — `{kind:"disabled", why}` or
  `{kind:"override", why, means, unit, points, last, since, absent?}`, `points` non-null only where
  the same argv ran — plus a document-level `central: {file, problems?}`. Trust: the paragraph in
  `repohealth.ts`' header, the same as own readings.

### What `2026-10-16a` changed in the definitions

One prereg bump carrying two definition changes, so the chain broke once:

- **hatches**: every occurrence is classified (`metrics/hatches.mjs`, per pack `hatchExplain`): a
  TO-DO (`TODO`, `FIXME`, Kotlin's `TODO(` stub — counted once per position), EXPLAINED (the reason on
  the same line after the mark — ESLint's ` -- why`, words after `@ts-expect-error`, `# noqa: X -- why`,
  a trailing comment after `as any`/`!!` — or a comment line with words directly above that is not
  itself an escape), or UNEXPLAINED. The index and the `hatches.perKloc` tile read the unexplained per
  kLOC; `value` keeps every kind's total (the new-kind tripwire), and `split` carries
  `{explained, unexplained, todo, byKind}` as detail.
- **retouch**: a pair that fires a clock counts only when the later commit REMOVES OR CHANGES a line
  the earlier one ADDED — its `-` ranges overlap the earlier `+` ranges, exact because the earlier
  commit is the file's previous first-parent touch. A registry only ever appended to stops reading as
  churn; those pairs are `appends`. Cost: one `git log -p -U0` walk per `update` with rows to measure
  (`git.readHunks`, bytes scanned by hunk count; ~120 MB / ~1.5 s for git on this repo's 1,400 commits).
- **Tile detail, never index**: `size.nearMax` (files within 10% of the largest — the shelf under a lint
  cap), `context.skillBodyChars` (the on-demand bodies beside the always-on chars), `retouch.appends`,
  `hatches.split`. Index points carry `tree: {files, loc}`, `spanDays` (Monday to Monday since the
  previous measured week — a link over 7 spans weeks nobody measured), `gapReason`, the repo's
  `central` fingerprint, `disabled`, `overridden`; `healthIndexVs(points)` is the pure "vs 12 weeks
  ago" (`ratio`, `delta`, the two points, `weeks` between them): the latest measured week AT LEAST 12 back, however far, and the phone names that week; null only when none is that old.
- **On the phone**: a `variant` is said ON its tile (`repoHealthWordsCentral.ts`) — a disabled reading
  draws no curve, only *Disabled here — <why>*; an override prints the repo's own value beside the
  engine's curve with its `means`, `since` and `why` — and `plot.central` is one line under the central
  heading plus one per ignored entry. The index caption counts the basket (*Built from 4 of the 5
  readings; Untested modules is disabled here*) off the latest point and then drops "compares across
  repos". A link with `spanDays > 7` is dashed and its readout says how many weeks it spans; a gap
  week says which of the three `gapReason`s. "This week" is claimed only when the latest MEASURED week
  is the phone's current ISO week (`healthWeekWhen`/`weekWhenWords`) — a repo with no commits this
  week otherwise read "+3 this week" about a month-old week. The two asks (`healthAskPrompts.ts`)
  carry the basket, the carried-by-config weeks, the engine's detail sentences verbatim and the
  vs-12-weeks figure with the week it used.
- **The chip follows the file** (`healthwatch.ts`): `summaryFor` re-derives when the series file's
  mtime+size moved since the cache was filled — the file is also rewritten by a CLI re-cut or the
  VS Code extension, and the chip once read 112 beside an index view computing 98.

### `repohealth.ts` and `repohealthread.ts` in shared — one subject, two failure modes

The phone and this module read the same stdout, so the parsing lives once, in `packages/shared`.
That file reached the 900-line lint cap, and the seam it split along is the one its two halves
already had. `repohealth.ts` is the SHAPES and the WORDS: the paths both ends name
(`REPOHEALTH_TOOL`, `REPOHEALTH_SERIES`, `REPOHEALTH_MD`, `REPOHEALTH_HTML`), the types a status, a
measure and a plot arrive as, and one sentence per state that has nothing to draw
(`repoHealthUnavailableText`, `repoHealthPlotUnavailableText`). `repohealthread.ts` is everything
that turns one run into those shapes: `lastJsonObject`, `parseRepoHealthStatus`,
`parseRepoHealthMeasure`, `parseRepoHealthPlot`, `parseRepoHealthProgress`, `parseUpdateSummary`,
`recutCommandOf`, `secondsToMs` and `classifyExit`. They fail differently and that is the argument
for the line between them: a wrong sentence is read by a person and reported, a dropped field is
read by nobody.

**The standing bug lives in the second file.** Every parser there rebuilds its result out of the
fields it NAMES, so a field nobody named is dropped in silence — the tool emits it, the host relays
it, the phone reads `undefined`, and nothing anywhere fails. That has now happened three times on
one wire: `longest`, then `rank`, then `context.areasAbsent` and an area's own `reason` together.
The last pair is the loudest, because it was not one number going missing: `context` was rebuilt
from `areas` and `absent` alone, so every repo on this desktop without a `<router>-*` convention —
four unrelated projects — arrived as `areas: {}` with no
sentence anywhere, and the phone's per-area panel returned `null` and drew nothing at all. Naming
the field is therefore no longer the whole fix: `packages/shared/test/repohealth.test.mjs` runs the
REAL engine (`plot --fixture`, read-only, over the committed fixture), walks every key path in the
document it prints, and asserts the parsed object still carries each one, with a `DROPPED`
allow-list that is empty and costs a sentence per entry. Two more documents come from the engine's
own `buildPlot` over rows crafted to force the absence branches, which are the only branches this
repo's own history can never produce — it HAS the router convention the missing sentences are
about. Add a field to the tool and that test is red until it is named in the parser.

**The reading crosses the wire already computed, and that is the point.** Each series carries its
points *and* the tool's own verdict on them: the percentile rank, the slope's sign, how many
readings that rank was taken over, the day its window starts, and — when there is no rank — the
reason there is not. None of that is expensive to recompute; it is dangerous to recompute. What a
rank MEANS is `tools/repohealth/constants.mjs`: the trailing window in day-rows, the minimum number
of points below which there is no rank at all, the slope's definition. Those constants are
pre-registered and `fixture.json` re-derives every number from them, so changing one is a commit
that shows the history moving. A second implementation on the phone would sit outside that fixture:
the definition would change, the tool's narrative and the phone's plot would disagree, and both
would look right. `narrate.mjs` already carries the scar — its own injected `readRank` disagreed
with `series.mjs`'s and produced zero rank events for the life of the series, which is why there is
now one `reading()` and a fallback that catches a second opinion. The tool states, the phone draws,
and the phone's `detail` sentence is the tool's sentence.

### The health score, kept current by `healthwatch.ts`

`shared/healthindex.ts` turns the series into ONE number per week, 0 to 100, against fixed good values
(`HEALTH_GOOD`: line-weighted mean file 500, longest file 1,000, rework 0.15, unexplained hatches 2 per
kLOC, untested share 0.2, context half the repo's warn line): an entry scores `100 · min(1, good / value)`.
The headline is `min(geometric mean of the five, worst entry + 30)`; the trend (week and month moves) is
read off that score and said second. The one layer that takes a side, owner-approved 2026-10-15, and
reworked 2026-10-17, each reason measured:

- **Why absolute.** The first version chained ratios from 100 at a repo's first full week, so it measured
  a repo against itself. picture-app was already bad at its own baseline (a 4,764-line file in
  2026-05-25) and by October that file was 8,397 lines, yet the headline read 95. A number that calls the
  worst file on the desktop "about as healthy as ever" is not a health number.
- **Why the cap.** Averaging five buried the giant file: before the cap picture-app scored 66 and this
  repo 63, so the repo with the 8,397-line file looked the healthier. No score now sits more than 30
  above its worst entry, and `cappedBy` names that entry so the reader is told what holds it down.
- **Size reads the giant files.** Size is the geometric blend of the line-weighted mean file length
  (`lineMean`) and the longest file (`max`), not the p95, which is blind to a single huge file.
- **Alerts.** An entry (or size sub-reading) under 50 is a `warn`, under 25 `severe`, one sentence each
  worded in shared so phone and VS Code say it alike; the longest-file alert names the path.
- **The good values are provisional**: chosen by the owner from the repos on this desktop, `retouch` least
  certain. A repo overrides the value it is compared with via `central`, never the constants.

`healthwatch.ts` is the plumbing, and only that:

- **An hourly sweep** (unref'd; `WATERPLANE_HEALTH_SWEEP_MS`) re-runs `refreshRepoHealth` for repos that
  already have a `repohealth.jsonl` and whose last host refresh is over 7 days old (absent = due),
  **one repo at a time** and never two engines at once. A repo with no series is never started; a failed
  run waits 6 h. `WATERPLANE_HEALTH_WEEKLY=0` stops the refresh and the push, not the reading.
- **Boot computes without refreshing**, so the chip has a value at once; a manual
  `POST …/repohealth/refresh` that succeeds stamps `lastRefresh` and recomputes.
- **`/api/repos` reads the cache only** (`RepoTarget.healthIndex`); unknown is absent, never 0.
  `GET /api/repos/:id/healthindex` answers `HealthIndexResponse` (`{series, move, words, lastRefresh,
  reason?}`) from the file on demand, a pure read.
- **One push per repo per week:** kind `health`, tag `health:<repoId>`, title prefixed with the repo name.
  `(week, kind)` last notified is written BEFORE the push to `<STATE_DIR>/healthindex.json` (with
  `lastRefresh`), so a restart loses a push rather than repeating one. Errors log once and push nothing.
- **A new severe alert pushes once more** (owner 2026-10-17): when the latest scored week has a severe
  alert subject the previous scored week did not, one push `<repo>: severe health warning`, body the alert
  sentences worst first, same tag `health:<repoId>`. A move and a severe alert in the SAME sweep are ONE push (the
  later would silently replace the earlier): severe title, severe texts, then the move's body. Never on a gap week
  (`last.gap`: a definition change is not news about the repo). A series whose rows have no `size.lineMean` (older
  engine) answers with a reason naming the re-measure command. Key
  `(week, "alert:"+subject)` is written BEFORE the push. Silent on the first scored week and for a repo
  severe all along: the previous point is computed from the same rows, so a re-measured history (prereg
  bump) or the first refresh after this shipped reads no repo as news. Same `WATERPLANE_HEALTH_WEEKLY`
  switch and notify gate as the move push; it only informs.

## A clock may name a session, because the CONVERSATION outlives it

The reported shape: *"for some of these waiting sessions I have scheduled a
response for after the weekly session window resets, but I'm not sure if that
even works or if such a scheduled go fires in a fresh session"*. It did not
work, and it did fire in a fresh session — by construction, and with a sentence
apologising for it.

**What happened before.** `sendBlocker` refused a clock over a `{kind:"session"}`
target (*"a session id is per-boot — schedule it against the repo instead"*),
and `scheduleReaim`/`seedReaim` softened the refusal by rewriting the target to
the session's repo, saying so in a `form-hint`. Every one of those sentences was
true about the ID. None of them was true about the ASK: at the instant, the row
opened a NEW, EMPTY session in that repo — none of the work the reply was about
in its window, and the waiting session still parked on its question.

Two facts made it fixable:

- a session id lasts as long as its process; the CLI **conversation** does not.
  `--resume <claudeSessionId>` reopens it, which is exactly what `doResurrect`
  already does after a usage-limit exit;
- the moment the row is written, both are known — the session is live, and the
  host can read `SessionInfo.claudeSessionId` off it.

So the row remembers the conversation: `IntentTarget.resumeConvId`, stamped by
`IntentManager.snapshotConv()` on every write path that can set a session target
(`post`, `upsert`, `retarget`, `update`) and **only ever filled** — a re-save
that could blank it would be `revivedShape`'s bug one field along. It is never
read at fire time, because by then the answer is gone and the alternative is the
guess `revivedSessionFor` exists to have stopped making.

`reopensConversation(i)` (`@waterplane/shared`) is the one predicate over it — a
snapshot AND a clock. The clock half is not decoration: a row aimed at a session
for *now* or *when it's free* is about a process that exists as it is written,
and reopening a conversation on its behalf would put a second agent in the
worktree every time a restart took the sessions with it.

**Before reopening, it looks for the conversation already OPEN** (`liveConvSession`,
2026-09-30). The row's session id can be gone while its conversation is live under
another id — a person reopened it from *Recently closed*, or a restart without tmux
re-keyed it — and a second `--resume` then put two CLI processes on one conversation
in one worktree. Rung 5 and `execute()` both ask it over the same session facts
(`SerialSessionState.convId`, off `claudeSessionId`): a live match is typed into,
held by ITS readiness like any session target; none, and the reopen below runs.
The phone says all this on the strip (`tieNote`: *tied to this conversation — close
it before then and the desktop reopens it*) and the close sheet starts such a session
KEPT (`isKept`, `timedKeptNote`), because a bulk close is how it gets closed unlooked-at.

Three places ask it and nothing else re-derives it:

- rung 5 (`targetVerdict`) lets such a row through with its session gone, with
  no session id on the verdict — opening one IS the work, the same position a
  fresh repo target has — and `needsSlot` counts it, so it spends an automatic
  session slot like any other spawn;
- `IntentManager.execute()` routes it to `freshSession` instead of `deliver`,
  and `BacklogManager.openItemSession` reads the same snapshot and passes
  `resumeMode: "continue"` + `resumeSessionId`, i.e. `--resume <id>`. Never
  `--continue`: the gap between writing the row and its instant is days, and
  whatever conversation is newest in that worktree by then is not the one the
  words were about;
- `intentToBacklogItem` ships it as `BacklogItem.reopensConv`, because the
  backlog says two OPPOSITE things about a closed target and the phone cannot
  derive which — *target closed — held* (true of every session-aimed row that
  cannot reopen) against *session closed — reopens its conversation*.

The limit re-aims (`tick`'s and `sweepRunning`'s) now spread `...row.target`
rather than building a fresh one: a resurrection reopens the SAME conversation,
so a row that could reopen it before the wall must still be able to after one.

**What this does NOT do.** A row aimed at a session that is still parked on a
question is held on `awaitingAnswer`, exactly as before — prose typed at an open
dialog goes into the dialog, so it neither runs nor answers. The reply lands
when the box is answered, or, if that session died at the wall, in the reopened
conversation. Scheduling an ANSWER to a box (a choice, fingerprinted) is a
different feature and is not this one.

## A weekly wall gave up the same afternoon it started

Reported alongside the scheduled-reply work above: *"I'm not sure if that even
works"*. It did not, and the reason was not the schedule — it was that the
session the reply was aimed at had stopped existing days before the reset it was
waiting for.

**The arithmetic.** A weekly limit was scheduled as *now + 5 s, then every ten
minutes* (`LIMIT_RETRY_MS`), bounded by `LIMIT_MAX_ATTEMPTS = 24`. That is under
four hours. A weekly window resets days later. So every weekly wall exhausted
its attempts on the afternoon it began, emitted `gaveup`, and left the
conversation shut — while the phone had been told it would come back. The
resurrect path was worse than the in-place one: it took the 5 s branch on EVERY
attempt, so the whole budget went in minutes.

Each of the three pieces was a different thing being conflated:

1. **A DATED reset is not a guess.** The weekly branch existed because a banner
   read off a screen prints a bare clock time, which resolves against TODAY and
   therefore the wrong day. True — and `markLimitBlocked` was applying that
   distrust to the CLI's own log as well, whose `quotaLimits.resetsAt` is an
   INSTANT (`limitlog.ts`) and is exactly as true weekly as five-hourly. It now
   takes a `dated` flag and keeps that one.
2. **Waiting is not churn.** With nothing dated, the delay now WIDENS —
   `limitretry.ts`'s `LADDER_MS`: 5 s, 1 m, 5 m, 30 m, 2 h, then 6 h for ever.
   The short rungs are the cases that answer immediately (an upgraded plan; a
   banner left in the scrollback by a wall that has already lifted); the cap is
   the rate that suits something resetting next week.
3. **Patience is a CLOCK, not a count.** `LIMIT_MAX_ATTEMPTS` is a churn guard
   and says nothing about how long a wall may last, so the give-up is now
   `LIMIT_GIVEUP_MS` (8 days — a weekly window and a bit) and the cap rose to 64
   because the ladder makes 64 attempts span a fortnight rather than an
   afternoon.

**The horizon rule** is the one piece that is not obvious. A dated reset within
one slowest rung (6 h) is simply waited for: second-guessing it spends an
attempt, a queue slot and the 10-minute host-wide hold-off at a wall somebody
has already told us the end of — and `e2e-limitreset.mjs` is the test that says
so, because clearing a block early is how the prompts that hit the wall never
run. Beyond that horizon the ladder runs UNDERNEATH the wait, so a wall that
lifts early is still noticed within six hours, and the attempt still lands
exactly on the reset once it comes inside the horizon.

One rule now serves both paths (`SessionManager.limitRetry`): a session still
running behind a block, and one that exited at it. They had two copies of the
cadence and only one of them had been thought about since.

### …and which session replaced which, across a restart

`revivedBy` — dead session id → the one `doResurrect` opened for it — was
memory-only, with a comment arguing that the resurrection timer is memory too.
That holds for a PTY, whose ids are per-boot. It does not hold under tmux, where
sessions and their ids survive a restart (`rediscover()`), and the gap between a
weekly wall and its reset is DAYS — which is many restarts. So the one fact
nothing else can reconstruct was being dropped inside exactly the window it
exists for, and every row following a resurrection (`manager.ts`) went back to
waiting on a session that was never coming.

It is persisted now (`.waterplane/revived.json`, `{dead: {to, at}}`, capped by count
with the oldest dropped — `at` is there so "oldest" still means something after
a reload), and `diedAtLimit` consults it for a session this host no longer
holds: that file is written by `doResurrect` and nothing else, so an entry in it
IS the answer to "did that session die at a wall".

### The bound that was never reached, because every reopen reset it

Two shapes of the same wall, and only one of them gave up.

A session that stays RUNNING behind a block accumulates `attempts` in one place,
so the old cap was reached in about four hours and the wait ended with `gaveup`.
A session that EXITS at the wall does not: `doResurrect` opens a NEW session,
that session re-hits the wall seconds later, and `markLimitBlocked` treats a
block BEGINNING as a fresh one — `attempts = 0`, `blockedSince = now`. So the
count never grew, the cap was never reached, and a weekly wall reopened the
conversation on the hold-off cadence (~10 min) for days: hundreds of processes,
each dying on the same wall, with nothing in the record saying so.

That path is the common one here — the CLI quits on a plan limit rather than
parking — and it is why a ladder alone would have fixed nothing: every rung
would have been the first rung. `Session.limitCarried` carries the block across
the reopen (its attempt count and when it STARTED), `adoptCarriedBlock` decides
whether to adopt it, and a carry older than `LIMIT_CARRY_MS` is dropped — a
session that came back, worked for a week and met a new wall must not adopt the
old one's clock and give up on arrival.

The give-up notification is now said once per block (`noteGaveUp` +
`Session.limitGaveUp`): both callers are re-asked by the minute sweep, so
emitting from them directly pushed one notification a minute for as long as the
wall stood.

## Background shells: what dies with the session

The turn flag and `agents.ts`'s subagent reader both answer "is work still
happening under this session" — and both miss the same third case. A
`run_in_background` Bash or a Monitor outlives the turn that launched it AS
WELL, but nothing writes it to a conversation log the way an agent's
`subagents/agent-*.jsonl` does: the CLI's only record of it is
`~/.claude/sessions/<pid>.json`'s `status: "shell"`, which says a background
shell exists and nothing else about it — no count, no command, no age. The
footer chip and `checkAgents` had already learned to read that flag
(`SessionInfo.shells`); what they could not say was WHAT was running, or
whether it was still doing anything.

### The shape on `ps`, and why it is unambiguous

Every background shell the CLI starts is the same wrapper, verbatim but for
its stamp and its eval'd text:

    /bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-<stamp>.sh … \
      && eval '<CMD>' < /dev/null && pwd -P >| /tmp/claude-XXXX-cwd

a direct child of the CLI's own pid, in its OWN process group (`pgid ===
pid`), with no tty. That last property is what makes the discriminator cheap
and exact: `ppid === cliPid && pgid !== cliPid && /shell-snapshots\/snapshot-
/.test(command)` (`shells.ts`'s `isShellWrapper`). MCP servers and
`caffeinate` are CLI children too, started the same way any subprocess is —
but they stay in the CLI's OWN process group, so `pgid !== cliPid` excludes
them without needing to know their names at all. Real workers are the
wrapper's descendants that stay inside ITS pgid (`shellsUnder`'s ppid walk,
bounded to the group); a child that escaped into a pgid of its own is not
followed, since job control giving something its own group is itself a signal
that it is not simply this wrapper's plumbing.

`workers` then drops the sleep/pipeline utilities a wait loop is built from
(`sleep`, `tail`, `head`, `zsh`, `sh`, `bash`, `cat`, `grep`, `wc`, `cut`) —
zero real workers is exactly "this shell, right now, is only waiting on
something".

### The eval'd text, and the two escaping styles it survives

`ps` shows the WHOLE wrapper script as one process's command line, so what a
person actually asked to run is the substring between `&& eval '` and `' <
/dev/null`. It arrives shell-escaped one of two ways depending on how deep
the quoting nested — `'\''` (a backslash-escaped quote) or `'"'"'` (a
double-quoted one) — and `evalText` unescapes both before capping at 240
characters. Nothing past `< /dev/null` is ever shown: everything there is the
CLI's own book-keeping (`pwd -P >| /tmp/claude-XXXX-cwd`), never words a
person typed.

### The transcript join has no shared identifier to key on

A `ps` pid and a conversation-log record do not share an id — the wrapper's
pid is not written anywhere in the log, and the Bash tool call's own
`tool_use_id` is not written anywhere in `ps`. The only lever left is the
command TEXT itself, so `shellTranscriptFacts` reads the tail 512 KB of the
conversation log (`agents.ts`'s `readTail`, reused rather than
re-implemented), pairs every Bash `tool_use` to its own `tool_result` by
`tool_use_id` — the CLI's own pairing — and keeps the ones whose result text
says `Command running in background with ID: <taskId>` (the CLI put it there
itself, `launch: "background"`) or `… was moved to the background (ID:
<taskId>)` (the CLI moved it there after a foreground timeout,
`launch: "timeout"`). `joinShellFact` then matches a wrapper's own eval'd
text against that list by WHITESPACE-NORMALISED, 240-CAPPED equality — capped
the same way on both sides, because the `ps` side is capped by construction
and comparing an uncapped transcript command against a capped `ps` one would
simply never match past 240 characters. No match — a command edited before it
ran, a log truncated past the tail this reads — leaves `description`/
`taskId`/`launch` absent, never guessed.

`taskId` also names the output file `shellOutputStat` stats (never reads):
`/private/tmp/claude-<uid>/<slug>/<conv>/tasks/<taskId>.output`, `slug` the
basename of `claudeProjectDir(cwd)`. Only filled in past 0 bytes — most of
these commands redirect their own output, so an empty file is silence BY
DESIGN and must never read as "read and found nothing".

### CPU movement is the honest signal, and it is tracked per WRAPPER

The workers under a wait loop (`sleep`, a `pgrep` invocation) are short-lived
and their own `time` barely ever ticks past `0:00.00` in practice — so
tracking CPU per INDIVIDUAL worker pid would mean almost never seeing the
same pid twice and never learning anything. `shells.ts` instead sums the
whole group's `cpuMs` (wrapper plus every live descendant) at each poll and
tracks that AGGREGATE by the wrapper's own pid, which is stable for the
shell's whole life (`trackCpu`). `cpuMovedAt` is absent on a pid's first ever
reading — there is nothing yet to compare against, which is the "can't tell
yet" state `@waterplane/shared`'s `shellBucket` reads off it — and stays at its
last value while the reading repeats. `pruneCpuTrack` drops a pid once it
stops appearing at all, so the map does not grow for as long as the host runs.

### The wait loop that can never end

Measured live on this desktop:

    until [ -s $L/tasks/X.output ] && grep -qE "…" $L/tasks/X.output \
      && ! pgrep -f "pytest -q -x" >/dev/null; do sleep 10; done; tail -3 …

`pgrep -f` matches a pattern against the FULL command line of every process
on the machine — including the very process running this loop, whose own
`ps` command line is the WHOLE eval'd script above, containing the literal
text `"pytest -q -x"` right there as the argument to the `pgrep -f` call
that is testing for it. The search can never come back empty: this process
always matches itself. `selfMatchOf` (`@waterplane/shared/shells.ts`) names this
by finding a `pgrep -f "…"`/`'…'` call over a LITERAL pattern (no `$`/regex
metacharacters — with one of those in play, whether the pattern still
matches the surrounding text is a real regex question this heuristic does
not attempt, and claiming self-match anyway would be a wrong answer, not an
absent one) and `shellWords` gives it its own sentence naming the pattern,
because "waiting in a loop" is true and leaves out the one fact that matters.

### What dies with the session

The CLI's own `tmux kill-session` ends only the pane process; the wrapper
shells it spawned are its children, not tmux's, and survive as orphans (a
five-day-old test runner, a `vite --watch` nobody meant to leave up). The
product decision (not a heuristic — a person's own choice) is that waterplane
behaves like the plain CLI intends: **closing a session stops every
background shell under it, fully**, no "leave running" option. `shells.ts`
writes the one function this needs, `killShellGroup(cliPid, pid,
startedAt)`, for WP3's close path and its per-row `shell.kill` route to
share: it always re-reads `ps` FRESH (never the 2s memo — acting on a stale
"still there" here is exactly the failure the memo exists to risk
elsewhere), re-checks the pid is still a wrapper under THIS cli, still its
own group leader, and its start time still within 2s of the one the caller
last saw (a pid the OS recycled onto an unrelated process is refused, not
signalled) — then `SIGTERM`s the whole process group, and `SIGKILL`s
whatever in it is still alive 3s later.

### `MAX_SHELLS`, and reading `undefined` correctly

Capped at 12 rows, the same shape as `agents.ts`'s `MAX_AGENTS` — a
pathological fan-out must not turn a status poll into a wall of rows.
`readShellList` returns `undefined` — not `[]` — on `WATERPLANE_SHELLS=0` or any
throw while reading, and a caller must keep the two apart: `undefined` means
"this host could not tell you", `[]` means "it looked, and there are none".
`checkAgents` (`sessions/turn.ts`) only asks while the CLI's own record says
`shell` or `busy` (the same edge `SessionInfo.shells` is already asked
through — the Stop hook can land before the record catches up), and
broadcasts on a fingerprint of `pid:bucket:workers:fg` per row rather than on
every read. That key used to be `pid:cpuMovedAt:outputAt:workers` — the raw
timestamps — which looked like it would only change on a real event, but a
genuinely WORKING shell's CPU moves on nearly every poll by definition, so
`cpuMovedAt` ticked to `now` almost every time this function was even asked
and a working shell rebroadcast every `AGENT_POLL_MS` for as long as it
stayed working. `shellBucket` only changes when the shell actually crosses
working/waiting/quiet/unknown — that IS a change a person would see — and
`workers`/`foreground` cover the rest of what the row's own words depend on.

### Foreground: the discriminator's blind spot

`isShellWrapper`'s shape — a direct child of the CLI, its own process group,
running the shell-snapshot wrapper — is not unique to a BACKGROUNDED Bash
call. A live FOREGROUND one (the ordinary case: the turn is running a
command right now and has not returned yet) spawns through the exact same
wrapper, and `readShellList` used to read it exactly like a background shell
because nothing told the two apart — so `turn.ts`'s "ask while status is
`busy`" edge (there for the case where the Stop hook lands ahead of the
record catching up to `shell`) surfaced the running turn's own command as a
"background shell" a person could apparently stop, with a stop button that
would have killed the turn.

The fix is `SessionShell.foreground?: true`, set by two facts neither of
which is a guess: the conversation-log join (`joinShellFact`) PROVES a
wrapper was launched to the background whenever it succeeds (a `launch`
fact), and the CLI's own record status is the other half — `"shell"` means
the main loop is IDLE, so nothing under it can be the current turn, and every
wrapper left is by construction a survivor. An unjoined wrapper while the
record still says `"busy"` is the ambiguous case, and it reads `foreground`.
`shellsSummary`/`shellCloseWords` never count a foreground shell (a separate
`foreground` tally rides beside the four buckets, and `total` counts
background shells only); `shellWords` answers `"a command this turn is
running"` for one, outranking `serverLike`/`selfMatch`/the bucket entirely;
`killOneShell` (`drive.ts`, the `shell.kill` route) refuses one outright —
`"that is the running turn's own command — not a background shell"` — before
`killShellGroup` is even asked; and `stopShellsUnder` (the close path) skips
one too, via `foregroundWrapperPids` (the same discriminator, minus the
CPU-tracking/output-stat/`MAX_SHELLS` work a kill pass has no use for) — the
`tmux kill-session` right after it ends the turn, and the foreground command
with it, so there is nothing left for that pass to signal separately.

### `waiting`, and a real polling loop's own CPU tick

`shellBucket` used to ask "did the CPU move within `SHELL_QUIET_MS`" before
ever asking whether the shell had real workers — so a wait loop shaped
`until …; do sleep 10; done` (no real worker, `workers === 0`) that happened
to have ticked a few ms of its own CPU on the last `sleep`/`pgrep` pass, a
couple of minutes ago, read as `working` for the whole ten-minute quiet
window, because its OWN plumbing's CPU counts too. `workers === 0` is now
asked FIRST (after the `unknown` check) and wins outright — a shell with no
real worker under it is `waiting`, never `working`, whatever its own CPU did
a moment ago. `shellWords` moved `selfMatch` to outrank the bucket entirely
too, the same way `serverLike` always did, so a self-matching wait loop
always gets its "this never ends" sentence rather than falling back to
`"can't tell yet"` on a shell `shellBucket` would call `unknown`.

### `killShellGroup`: a confirmed kill, and one fresh read per close pass

Two gaps closed together. First, `killShellGroup` used to return `ok: true`
the moment it had SENT `SIGKILL`, never checking whether the group actually
died — a process in an unkillable state (rare, but real) was reported stopped
while it kept running. It now re-reads `ps` a second time after the SIGKILL
and answers `ok: false, reason: "that shell did not stop"` if any row still
shares the wrapper's pgid; it also re-checks the wrapper's OWN `ppid` right
before sending that SIGKILL, over a row read AFTER the SIGTERM, for the same
reason the very first precondition check exists — a pid the OS recycled
during the 3s wait must not be signalled just because an unrelated new
process happens to now share the old pgid.

Second, every precondition read and every kill/sleep call is now behind an
injectable `KillShellDeps` (`rows`/`readPs`/`kill`/`sleep`), which does two
jobs at once: `shells.test.mjs` drives the whole refusal ladder (already
gone, ppid mismatch, `pgid !== pid`, a `startedAt` drift, a survivor that
needs `SIGKILL`, one that still doesn't die) with no real OS process tree at
all, and `stopShellsUnder` (the close path, stopping every background shell
under a session at once) reads `ps` exactly ONCE and passes that table as
`deps.rows` to every group's `killShellGroup` call — an `N`-shell close used
to take `N + 1` fresh reads (one shared at the top, one more inside each
group's own precondition check) for a fact that had not changed between
them. The reads AFTER each group's own SIGTERM stay genuinely fresh, one per
group, because those happen at a different real moment for each one — that
part of "fresh" is not shareable, and `killShellGroup` never pretends it is.

### An automatic reap never stops a background shell on a verdict

`backlog.ts`'s `reapable()` — the question behind `lingerSweep` and
`reapAutoSession` — already refused to close a session mid-turn or waiting on
a person. It had no opinion at all about a background shell, because a
`run_in_background` Bash or a Monitor outlives the turn that launched it BY
DESIGN, so the CLI's own turn flag and `autoFireBlocker` both say the session
is free the moment the main loop goes idle — while an emulator or a dev
server a person cannot see without opening the shells sheet keeps running
underneath. `reapable()` now refuses outright whenever `info.shellList` holds
any NON-foreground shell that reads `working` (`shellBucket`) or
`serverLike` — logged, in words, naming the shell — before it ever asks
`autoFireBlocker`, and this refusal is NOT overruled by `REAP_CEILING_MS`
the way the ordinary silence backstop is: CLAUDE.md's decision that closing a
background shell is a person's tap, never a verdict, has no ceiling. A
`foreground` shell is not this check's business at all — closing the session
IS what ends it, the same as any other turn — and a `quiet` background shell
(no real workers seen moving, not server-like) is reapable as normal.

### `readCliRecord`'s cache, and the guard it used to bypass

`pickCliSession`'s "conversation id only when EXACTLY ONE live process claims
it" rule exists for `--resume` of a conversation already open elsewhere —
two live records naming the same conversation id, and picking either would
be a guess. `readCliRecord`'s per-session-id file cache used to re-validate
against an array holding only the ONE cached record, which is trivially
"exactly one" every single time regardless of what else exists on disk — so
a session running without tmux (`tmuxName` null) that had once matched by
conversation id would keep reading that same cached file for ever, blind to
a second process claiming the same conversation id after the first read. The
cache is now populated, and consulted, ONLY on a TMUX-TARGET match — exact
by construction, so re-validating the one cached file against itself is a
real check. A `tmuxName`-less lookup always rescans the whole directory,
which is the only way that "exactly one" guard can see every candidate.

## `askrules.ts` (host + shared) — ask rules: a box before an irreversible command

Agent authority is what an agent may CAUSE; the vault guards what it may READ. The one thing that
stops an effect before it happens is the argv of the `claude` this host starts, so the list of
rules (`<state>/askrules.json`, pure parsing in `shared/askrules.ts`) goes in as `permissions.ask`
in the `--settings` blob `backends/claude.ts` already passes.

- **A flag outranks the repo.** Measured on Claude Code 2.1.301: a flag-passed ask rule stops the
  command under `default`, `auto` and `bypassPermissions`, beats `--allowedTools`, and beats
  anything the agent writes into the repo's `.claude/settings*.json`. That measurement is why this
  is not a hook or a broker.
- **Empty list, byte-identical argv.** With no rule (or every rule off for the repo) nothing is
  added, so an install that never opens the section launches exactly as before.
- **The change needs an `Origin`** (`confirmgate.ts`'s rule (a)): `PUT /api/askrules` from an
  Origin-less `curl` is refused, so an agent cannot quietly delete the rule that stops it. The tap
  itself is person-only through `answergate.isBlocked`.
- **Applies to sessions started after the change**, and to claude only; other backends take no rule.
- **Honest reach: it stops the accident, not the adversary.** A rule sees the words typed, so a
  wrapper script, an alias or a bare `git push` on a branch tracking `main` is not caught. The
  suggested list is offered, never applied. Plan: `docs/plans/agent-authority.md`.

## Claude never updates itself under the daemon (`DISABLE_AUTOUPDATER`)

Measured 2026-09-30 on the npm-global install route: every `claude` start — a tab, a reopen, the
per-turn `claude -p` summary, the `/usage` probe — ran the CLI's own updater: `npm view
@anthropic-ai/claude-code@latest version --prefer-online`, then `npm install --global
@anthropic-ai/claude-code@2.1.285` over the version that was ALREADY installed. Five reinstalls in
70 s, underneath every live session, with `"autoUpdates": false` in `~/.claude.json`. Sessions
exited unexplained from the day 2.1.285 arrived, one of them seconds after a reinstall. Nothing
proved the reinstall killed it — the host logged no exit at all, which is the second half of the fix.

- `backends/claude.ts`'s `CLAUDE_SPAWN_ENV = { DISABLE_AUTOUPDATER: "1" }` is claude's `spawnEnv`,
  so it reaches the pane through `tmuxEnvPrefix` like opencode's guard does; `sidecar.ts` (both
  spawns) and `usage.ts` merge the same map. `update.ts` stays the one way the CLI changes: a tap.
- `sessions/tmux.ts`'s `exitReport` logs every PTY exit: code, signal, uptime, **whether the tmux
  session outlived the client** (alive ⇒ our client died and the CLI still runs; gone ⇒ the CLI
  ended), and how long ago the binary on disk changed. `packages/host/test/exitreport.test.mjs`.

## `onboard.ts` — the first-app job, and why it is one persisted step list

The first-app journey turns three answers and one consent
screen into a repo, a build the phone can hold and a session. Every step but the last is
deterministic and already existed (`androidenv.ts`, `toolchain.ts`, `scaffold.ts`, `signkey.ts`,
`compliance.ts`, `builds.ts`), so `onboard.ts` only ORDERS them: android `probe → toolchain →
scaffold → signing-key → setup → build → session`, web `scaffold → setup → build → session`. The
agent is not in the setup path: a failure at minute three of someone's first try costs them, and a
template build either works or names its fix.

- **Persisted, resumable, idempotent per step.** `<state dir>/onboard.json` (tmp+rename) on
  every transition, and an `onboard.progress` frame with it. `server/firstapp.ts` constructs the
  manager after `intents.start()` and calls `boot()`, which resumes a `running` job at its first
  step not done. Each step tolerates being run again: the toolchain re-probes and is FOUND, a folder
  with a `.git` is adopted rather than `newRepo`'d a second time, the key is ensured + linked again
  (both idempotent), the build reads its recorded run back (the store fails a build orphaned by a
  restart, so it is re-run once), and the first prompt is a launch intent keyed `<job>-session`, so
  `intents.post` answers `existing` instead of typing it twice.
- **Consent is checked twice.** `start()` refuses unless every `required` line of the plan was
  ticked (`missing` names them); a step whose consent is absent at run time stops at
  `needs-consent` rather than acting. `resume()` may only ADD ticks. The toolchain tick is the
  licence acceptance; nothing else accepts one.
- **Consent is a server fact, not the caller's word** (`confirmgate.ts`). The gated fixes
  (`CONFIRM_GATED_FIXES`), an onboard start and a resume that adds consent need an `Origin` that
  passes `origin.ts` (Origin-less is refused there, never by loosening `origin.ts`) and a one-shot
  token minted by the GET that draws the confirm, bound to what it confirms, live
  `CONFIRM_TTL_MS`, spent only when the action was accepted. It stops one documented POST from an
  agent or plugin accepting Google's licence; it is not a wall against a program running as this user.
- **A template, not the agent, makes hello world.** The first build must not fail or cost tokens;
  the agent's work starts after the first install, and a description becomes the first prompt only
  then. Compose stays: the cold first build measured 323 s (empty Gradle cache) against a 6-minute
  budget, over which the template would drop to plain Views. The web path (`templates/web-hello`)
  is one inline `index.html` drawn by the gallery's sandboxed frame: no new route, no new trust.
- **Toolchain: find first, install user-local, never sudo** (`androidenv.ts`, `toolchain.ts`). No
  emulator: the phone in hand is the device. Downloads go to a private 0700 `mkdtemp` dir and are
  verified and unpacked from inside it, because a shared tmp dir was a TOCTOU.
- **One signing key per desktop** (`signkey.ts`, `<config dir>/keys/sideload.jks`, files 600): one
  secret to back up, and updates keep working across every app it signs. Never in a repo, and not
  the Play upload key.
- **The first prompt goes through the store, not around it.** With a description, the session
  opens as a `files`-trigger intent with no files to wait for — the path a parked `session.create`
  already takes (`sessions.create` + `startPrompt` through `deliver.ts`). Without one, a live
  session in the new repo is adopted or a bare one opened, and the suggested prompt rides the job
  for the phone to offer.
- **Android builds are pointed at the toolchain that was found.** A JDK installed into
  `<config dir>/jdk` or brew's keg-only `openjdk@21` is on nobody's PATH, and AGP does not look in
  `~/Library/Android/sdk` by itself. So when the HOST's env names neither, the build step writes
  `sdk.dir` into the repo's gitignored `local.properties` and prefixes `JAVA_HOME='…'` onto the
  repo's (gitignored, per-desktop) gradle build commands — visible on the Build sheet, never a
  hidden env. `keytool` comes from the same probed JDK.
- **The size on the consent line is derived**: `planToolchain().installBytes` sums what each needed
  step fetches (the pinned cmdline-tools zip's real byte count, estimates for the rest), and
  `androidToolchainConsent(bytes)` in shared words it.

Tests: `packages/host/test/onboard.test.mjs` (fakes: order per path, consent refusal, resume after
a restart mid-build and mid-scaffold, idempotence, a stop naming its fix), `scripts/e2e-onboard.mjs`
(the web path on a real host: frames over the socket, the page in the outbox).

## `peers/` — delegating a job to another waterplane host

Delegate and report back, nothing else: a job opens ONE session on the peer and its final answer
returns as ONE prompt. One entry per module; the wire types are `shared/peer.ts`.

**The decisions.** PULL, not push: the asker polls the peer only while a job is open
(`WATERPLANE_PEER_POLL_MS`, 5 s running, backing off to 60 s while unreachable, 30 s at a usage limit;
a restart resumes from `peer-jobs.json`), so each edge has one direction of trust and the asking side
needs no inbound route. Code travels through the shared git remote, never rsync, and the peer never
clones: a repo it does not have is a refusal sentence, because `WATERPLANE_ROOT` is everything
reachable from the phone and widening it is the owner's call. The job worktree sits under
`.claude/worktrees/`, below discovery depth, so a job never shows up as a repo on the phone; it is
kept for inspection and swept after 7 days (`PEER_WORKTREE_MAX_AGE_MS`). `PEER_API_VERSION` follows
`PROTOCOL_VERSION`'s rule: an additive field never bumps it, a changed meaning does. A peer session
at its usage limit reports `limit` with the reset words and the report arrives after the resume; a
failed fetch on the peer is `failed` with git's stderr; an artifact that cannot be fetched is listed
as "not fetched: <why>" while the rest come.

- **`peers/store.ts`** — `peers.json` (0600, under the host store dir). Outbound rows keep the clear
  token, inbound rows only its sha256 (the `deviceledger.ts` shape); an unlisted name is refused;
  delete invalidates. A separate ledger from devices, so a password change does not rotate it.
- **`peers/routes.ts`** — `/api/peers` (phone, trusted path only via `canManage`; lists the peers from loopback too, and
  answers `self: { addr }` — this daemon's own tailnet `ip:port`, null when it is not bound on one, set by `main.ts`
  through `setPeerSelfAddr`, which is what the phone pairs with when a host is saved as an https front door) and the `/api/peer/*`
  gate (trusted kind, peer bearer, version header: 403 "not paired" / 409). Serves `hello` itself and
  hands the job routes to `serve.ts` through `setPeerServe`. A device token never reaches it.
- **`peers/serve.ts`** — inbound. Matches the request's remote to exactly one local clone by `remoteKey`,
  refuses the clone this daemon runs from, fetches the branch, adds a detached worktree at the commit
  under `<clone>/.claude/worktrees/peer-<from>-<key>` (`<from>` is the peer's name for the asker), writes the
  marker (`<state dir>/peer-job.json`) that `scripts/restart.sh` and `deploy/install-service.sh` refuse on, and posts the job as an ordinary intent row (so the owner's auto-fire switch, budget and slot cap
  hold it). Reports the last assistant turn, capped, plus the outbox files it names.
- **`peers/jobs.ts`** — outbound ledger (`<state dir>/peer-jobs.json`) and state machine, pure over an
  injected clock and fetch. The peer names a job after what IT calls us, so the id from its POST answer is kept as
  `remoteId` and every later read (poll, artifacts, restart-resume) goes by it; the local id never changes. A
  refused/failed POST answer is terminal and its sentence is the report. Polls only while a job is open; `unreachable` is a state, never `failed`.
  The report is a pinned session-target row through `postClientDraft`, once by id; asking session gone
  gives a manual backlog row and a notification.
- **`peers/client.ts`** — http to a peer: the version header on every call, a cached `hello`, one
  in-flight poll per job.
- **`peers/agentpeer.ts`** — the loopback route `/api/agent/peer/<peer>/intents` the asking agent
  `curl`s. Same caller refusal as `agentintents.ts` (loopback, no browser, not proxied); checks the
  branch is on origin before anything is sent. The body's `peerDir` (a path on the PEER) picks one of two clones and
  is forwarded as the job's `dir`; `dir`/`repo` are this host's. Report files land in the asking repo as
  `.claude/outbox/peer-<peer>-<stem>-<timestamp>.<ext>`. The repo-facing paragraph is in `reposkilltext.ts`.
- **What a peer job cost, and who it was for (WP8).** Both desktops usually sign in as the same account, so
  a job's spend counts against the same 5-hour/weekly limits while this desktop's ledger never sees it.
  The PEER measures (`serve.ts` `peerJobCostOf`, off the job session's `getContextSeries` — the same
  `ctxlog.ts` pass its own cost chip draws from): `usd`/`tokens` only where the subagent directory was read
  (`usageTok` present), `model` as an alias, `durationMs` from the row's `startedAt` to `settledAt` (to now
  while it runs), `weekPct` only off a weekly calibration fresher than `BUDGET_STALE_MS`
  (`sessionbudget.ts`'s `lastBudgetCal`) — each ABSENT on its own, never 0. It rides `PeerJobView.cost`
  (additive; `PEER_API_VERSION` unchanged). The asker cleans it field by field (`cleanPeerJobCost`), keeps
  the last reading in its ledger (a later view without one never zeroes it), puts its parts in the report's
  head (`[report from peer pc · $0.84 · opus-5-5 · 6 min]`), publishes every job a session sent as
  `SessionInfo.peerJobs` (open AND settled — `peerWait` is only the one it waits on), and serves the ledger to
  the phone at `GET /api/peerjobs` (trusted path, read-only, no token, no report text). The asking session's
  label rides the request (`askerLabel`) into the job worktree's marker, and `server/sessionEvents.ts` stamps
  any session created in a job worktree with `SessionInfo.peerJob` before its first broadcast, so the peer's
  row says "job from mac · <asking session> · <label>". A cost is never summed with this desktop's: the phone
  prints the split (`peerSpendSplit`), and the weekly calibration adds only jobs wholly inside the window and
  says so (`peerWeekSpend`, "incl. $0.84 on pc").

## `prompts.ts` — customising the unattended prompts without editing core

A fork that wants its own wording for the daemon's unattended model calls drops a file in
`<config dir>/prompts/<name>.md` (the dir `secrets.ts` and the `.env` load use — `~/.config/waterplane/`,
or `<PREFIX>CONFIG_DIR`). `promptText(name, fallback)` returns the file when it holds anything, else the
pinned default, which stays byte for byte what ships. Names: `commit-message` (`commitmsg.ts` system
prompt), `tab-name` (`naming.ts`, the backlog-row headline pass — the name predates the session tab's),
`review-check`, `review-check-diff`, `review-validate`,
`review-validate-diff` (`review.ts`: the instruction paragraph above the task), `session-title-system`,
`session-title`, `session-rename` (`sessions/record.ts`: the session tab title's system prompt, its
wording, and the hand-asked rename's wording — the opening/recent-prompt blocks after it are code) and
`assess-guidance` (`assess/hassinput.ts`'s `ASSESS_GUIDANCE`: the verdict vocabulary, the evidence rule
and the pad-note rule; the file names, the interpolated caps and the out-file JSON shape stay in code).
Every one of these routes through `sidecar.ts`, and **an override changes words only**: the engine
route, the model, `--setting-sources user`, `--tools ""`, `--thinking disabled`, the timeouts and the
trust refusal are set by the callers and the sidecar and no file can reach them (CLAUDE.md's
automatic-spenders rule).

- **Read on every call, no cache.** Calls are minutes apart and the file is tiny; a cache needs an mtime
  check to stay honest, which is what the read already is — and an edit lands without a restart.
- **Never throws, never empty.** Absent → default silently; unreadable or empty/whitespace-only → default,
  logged once per name. A name outside `[a-z0-9-]+` is refused (no path walking out of `prompts/`).
- **Only the wording is yours; the contracts stay in code.** The JSON shapes the parsers read
  (`VERDICT_CONTRACT`, `VALIDATE_CONTRACT`, the task and diff blocks) are appended after the override. An
  override of `tab-name` must still say what the pinned text says about the JSON answer,
  and should keep "answer straight away": the cost of those calls is thinking (CLAUDE.md's flags rule).
- `overriddenPrompts()` lists the names currently overridden — the doctor's `overlays` row reads it.

## `themeoverlay.ts` — a fork's look and name: `<config dir>/theme.json`

The third config overlay, same posture as the two above: optional, never throws, a bad entry is a log line
and the built-in value. The rules are one pure module both ends run, `shared/themeoverlay.ts`; the host
reads the file, the phone re-cleans what it is served.

```json
{ "displayName": "acme remote",
  "colors":   { "dark":  { "--accent": "#ff7a00", "panel": "#15171a" },
                "light": { "--accent": "#b34d00" } },
  "terminal": { "dark":  { "background": "#101214", "foreground": "#e6e6e6" } },
  "icons":    { "favicon": "icons/mark.svg", "apple-touch": "icons/180.png",
                "192": "icons/192.png", "512": "icons/512.png", "maskable": "icons/512-maskable.png" } }
```

- **`icons`** — slot → a path relative to the config dir. `shared` checks the SHAPE only (relative
  segments, no `.`/`..`, `.png`/`.svg`, ≤ 200 chars); the host (`themeIconFile`) resolves it with symlinks
  followed on BOTH sides (`realResolve`, the comparison `inRoot` makes) and refuses anything not inside
  the config dir, anything not a regular file, over 1 MB, or whose bytes are not what the extension says
  (PNG signature, an `<svg` root). Served at `/theme-icon/<slot>?v=<size+mtime>` — the URL names a SLOT,
  never a path, so nothing the request says reaches the filesystem — outside `/api` and ungated like the
  `/assets/icon-*` it stands in for (a manifest's icon fetch carries no credentials), GET/HEAD only,
  under `default-src 'none'` + `nosniff` so an SVG opened as a page runs nothing on the app's origin.
  The served `index.html` (`brandIndexHtml`: `favicon` replaces every `<link rel="icon">` with one,
  `apple-touch` the touch icon's href) and `manifest.webmanifest` (`brandManifest`: an entry is replaced
  only by the slot of its own size/purpose; `favicon` takes the `any` SVG entry when it is an SVG) link
  them, their ETags extended by the icons' tags. A slot not given, or refused, keeps the built-in icon.
  **Never on the wire**: `/api/theme` strips `icons` (`wireThemeOverlay`) — the paths are the desktop's,
  and the shell already carries the links. The APK's own bundle (and so its launcher icon) is build-time
  brand, not this.
- **`colors`** — the CSS custom properties on `:root` in `web/src/styles.css`, per theme, with or without
  the leading `--`. The allowed set is `THEME_TOKENS`, held to the stylesheet both ways by
  `web/src/themeOverlay.test.mjs` (a token added to `:root` must be listed or the test fails). Not in it:
  the `*-rgb` channel triples (an override of `--accent` IS written to `--accent-rgb`, so every wash and
  edge derived from it follows; those hues must be opaque), `--repo-sat`/`--repo-lit` (percentages,
  swept over 360 hues in `theme.test.mjs`) and `--term-bg`. Values: hex, `rgb[a]()`, `hsl[a]()` — no
  names, no `var()` — and they are **re-serialised from the parsed channels**, so no text from the file
  ever reaches a stylesheet. No contrast check is run on a fork's colours: `theme.test.mjs` guards the
  shipped palette, and a fork's palette is the fork's to measure.
- **`terminal`** — background/foreground per theme, opaque, stored `#rrggbb`. `termColorsFor` is the ONE
  statement of the pair: the phone's xterm palette (`termTheme.ts`), `--term-bg` (derived, so the frame
  round the grid is the grid's colour) and the host's OSC 10/11 answers to the tmux client
  (`hostTermColors` → `termqueries.ts`, dark as before — the host has no phone theme to follow). With no
  override it returns `TERM_COLORS[theme]` itself, so identity comparisons still hold.
- **`displayName`** — 1–40 printable characters: the window title, the logo's label and wordmark, the
  crash screen, and the served `manifest.webmanifest` (`brandManifest` in `server/http.ts`, its ETag
  extended by the name so an installed PWA re-reads it). Build-time brand (`shared/brand.ts`,
  `scripts/lib-brand.mjs`, the APK's label) is not this. The ~30 sentences that name the product inside
  longer wording still say `BRAND.displayName`; moving them is a follow-up, not a fork setting.
  **Why this file and not a `brand.json`:** the name is the only brand field a running install can change,
  and it is applied at the same moment as the colours — one file, one read, one cache key, one doctor
  entry, and no file whose name promises the rest of `BRAND` is overridable.
- **Unknown keys are ignored with a note** (top level, theme, token, terminal field), keys starting `//`
  are comments; a file that is not a JSON object is ignored whole. Notes are logged once per file version.
- **Read on demand with an mtime+size check** (`themeOverlayState`): the tmux colour query asks per query,
  so the file is not read each time, and an edit still lands on the next read with no restart.
- **Served** at `GET /api/theme` → `{ overlay }`, cleaned, `{}` with no file. Read-only, origin-gated like
  every `/api` route; the demo answers `{}`.
- **On the phone** (`web/src/themeOverlay.ts`): the cleaned overlay is cached (`LS.themeOverlay`) with its
  derived CSS (`LS.themeOverlayCss`); `index.html`'s inline script injects that CSS before the bundle
  parses (the theme attribute's no-flash trick), `main.tsx` adopts the cache, then asks the host once.
  A failed read keeps the cache; `{}` removes the style element AND both keys, so an absent file is
  today's app byte for byte. Both keys are host-scoped (parked on a host switch).
- **Doctor**: one `overlays` row — `ok` listing what is active (`prompts/ (…)`, `models.json (+n / −m)`,
  `theme.json (…)`, icons by slot), or `none … upstream defaults`; `warn` naming any file ignored whole,
  entry dropped, or icon refused (with why: outside the config dir, not found, not a PNG, …).


## `billing.ts` + `periodspend.ts` + `server/billingwire.ts` — an account that has no weekly window

Plan: `docs/plans/billing-periods.md`. A subscription has two scraped windows; an API-key or
Bedrock/Vertex account has none, and what it answers to is dollars per governed period (a calendar
month, often anchored on a billing day). The host's half of that, with the rules that are not obvious:

- **The profile is probed once and `unknown` until then.** `billing.ts` reads the environment
  (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK/_VERTEX/_FOUNDRY`), `apiKeyHelper` in claude's
  `settings.json`, and runs `claude auth status` once at boot with a timeout; `shared/billing.ts`
  classifies. Answering `api` for the seconds before the auth text arrived would stop the `/usage` poll
  a subscription host needs, so the gap reads `unknown`, which keeps today's behaviour. A key beside a
  claude.ai login is `unknown` too (which one the CLI bills depends on state not read). The person's
  override (`billing.set`, kept in `billing.json`) wins; `null` hands it back to the probe.
- **A known non-subscription profile stops the `/usage` poll** (`main.ts`'s `syncUsagePolling`) and
  empties the `session`/`weekly` periods from `budget.state.periods`. `unknown` and `subscription`
  are exactly the old host.
- **Spend is a cache, because the verdict is synchronous.** `periodspend.ts` folds
  `tokenStats.costWindow` (hour buckets) over each dollar period every minute. The 35-day read cap is
  `GET /api/costwindow`'s, not the fold's, so a month needs no lift. Three rules keep the cache from
  becoming a wrong number: an entry belongs to the period START it was measured for (past the reset
  the cap reads absent and releases with no event and no refresh); an entry older than 10 minutes is
  absent (a stopped refresh fails open like a stale `/usage`); a ledger that was never scanned is
  absent, never $0. The figure is this desktop at list price, never the invoice; a period edge off
  the hour (a half-hour zone) is read from the hour it falls in.
- **A dollar cap holds automatic work only**, through the unchanged ladder: `budgetBlocked`/`budgetOver`
  now come from `budgetVerdict(…, spend)`, so rung 2 holds `auto` rows and a hand-sent prompt never
  asks the verdict. A `window` schedule rule on a period with no edge (`rolling30d`) is refused in
  words on `schedule.save` (`windowRuleRefusal`); a calendar or span period supplies its reset to the
  rule through `usageWindows().periodResetAt`.
- **"$ vs pace"** (`burnwatch.ts`'s `createPaceWatch`): with no weekly percentage to climb, one `burn`
  push per period start when the straight-line projection ends past the cap. Words only.

## `halt.ts` + `sessions/haltall.ts` — the emergency halt: a latch, then a kill

One tap on the phone (launcher **Halt**, or a session's ☰ **halt all AI**, behind a confirm) stops
every AI process this host started and keeps it stopped. Asked for 2026-10-15 as "an emergency all AI
off button that uses hard process kills".

**Why a latch and not a kill.** This host brings work back by itself: the limit-resume queue reopens
conversations with `--continue`, schedules / launches / the backlog fire on the intent tick, and the
sidecar spends on events. A kill with no hold is undone within minutes. So `halt.json` (in the state
dir, `writeJsonAtomic`) is a flag every spawn path asks, and the kill is what happens when it is set.
A file that is present but does not parse reads as **halted** — the person asked for everything to
stop, and a torn write must not be what starts it again. Absent is off. A restart comes back halted.

**The gates** (each refuses with `HALT_REFUSAL`, `shared/halt.ts`):
- `create()` through `openRefusal` — BEFORE the backend's `launchArgs`, because opencode's starts an
  `opencode serve` there. Every create caller (a person, `doResurrect`, the intent tick, the backlog,
  fan-out) already turns a throw into a refusal. Shell sessions are not AI and still open.
- The intent ladder's `pass` returns at once, and `runNow` refuses: a row that fired and was refused
  would be SPENT, so rows are held, untouched, until the lift.
- `runHeadlessClaude` answers a failed run without spawning; `chatCompletion` answers `""` — the
  shapes every sidecar caller already reads as failure, so no caller learned a new verdict.
- `UsageChecker.refresh` keeps the last reading instead of spawning its `claude` probe.

**The kill** (`haltSessions`). Every agent session, in the map (running, or exited and waiting to be
reopened) or only in tmux (detached, a `live/` record). Order is behaviour: each mapped session is
marked `killed` FIRST, so a CLI exiting on the SIGTERM is read as a close and never as a limit exit to
resurrect. Then each pane's process tree (`tmux list-panes` → `ps -Ao pid,ppid,lstart`) gets SIGTERM,
and after one second SIGKILL goes to whichever of THOSE processes is still there. Identity is pid AND
start time, so a pid recycled during the grace is never ours. The second of grace lets the CLI flush
its transcript, so `--continue` still works after the lift. Then the ordinary teardown: `kill()`, or
for a detached pane kill-session plus the live record (no boot re-attaches it). Live headless runs
and the `/usage` probe register with `trackRun` and get the same TERM-then-KILL to their group.

**What it does not reach**, and the receipt says so: `claude`/`codex` started outside waterplane (a
tier-2 scan of the process table is the open follow-up, matched on the executable or `argv[1]`, never
a substring — Claude.app and IDE extension hosts must not match), cloud sessions, and tokens already
spent. An OpenAI-compatible completion already in flight is not aborted (it is bounded by its own
timeout and has no tools).

**Lifting** only clears the flag and kicks the tick. Nothing that was killed comes back by itself.
The wire is `host.halt { on }` (no ackId: setting a latch is idempotent; the phone sends it live-only,
never queued) and `halt.state` on hello and on every change. Pinned by `host/test/halt.test.mjs`
(latch, torn file, tree walk, forced kill, refused headless run) and `scripts/e2e-halt.mjs` (a
TERM-ignoring stub forced, refusal, the latch across a restart, the lift).
