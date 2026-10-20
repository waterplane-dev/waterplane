# Web (PWA) module map

_Full rationale split out of CLAUDE.md. Index: [docs/notes/README.md](README.md)._

### Web module map (`packages/web/src/`)

- `App.tsx` — the wiring: core hooks (`core/conn|route|term|queue|launch|send|compose|sessions`), the ws switch, `bindCore`, the overlay table; the screens are `core/launcher` and `core/session`.

  **A choice box is answered where there is room for it, which is not under the terminal.**
  Host `askbox.ts` reads the pending `AskUserQuestion` tool call out of the conversation log, so
  `DetectedPrompt.ask` is the question as written and `PromptOption.desc` is the paragraph the
  terminal truncated at the right edge, cut again by the preview pane, or scrolled off entirely on a
  box taller than the screen. A one-tap button labelled "A + B + C (Recommended)" with its
  explanation nowhere on the phone is a button you cannot honestly press — that enrichment is the
  whole reason this card exists.

  It used to be a BAR under the terminal, and every rendering rule on it was compensating for where
  its height came from: the bar took its space FROM the PTY, and a bar that grows shrinks the grid,
  which SIGWINCHes claude into repainting the box, which is the feedback loop `prompt.ts`'s
  `truncated` fix closes from the other side. So the card was capped at `34vh`, descriptions were
  clamped to three lines behind a `more` toggle, the option list scrolled inside the cap, and the
  whole thing had three sizes (card · one line · a muted handle) plus a per-device standing
  preference for which. **It still lost.** Measured on the report that ended it: a six-option box
  with a paragraph each rendered TWO options, with the other four inside a scroll region that has no
  visible scrollbar on Android and nothing on the card saying they existed — "it does not show all
  options", exactly as described. Meanwhile the READER was drawing the same question, all six
  options, unclamped, in a document with its own scroll — and its options were `<span>`s. The
  surface with room could not answer; the one that could had no room.

  In the terminal view the bar had no argument left either, which is the other half of the report:
  **the CLI is drawing that box** — same options, same descriptions — inches above a card restating
  them, and a terminal is driven the terminal's way, by pressing the option's digit (`cliKeys.ts`,
  the special-key row). A card there is most of a phone screen spent covering the thing being
  answered.

  So the bar is gone, and so are its three sizes, `waterplane.promptMini`, the fingerprinted open/hide
  overrides, the `more` toggle and the `vh` cap. **`PromptAnswer.tsx` is the card body, and the two
  surfaces that draw it are the reader's `tr-ask` and `QuestionsSheet`** — both documents with a
  scroll of their own, so nothing is capped or clamped in either: every option, every description,
  the queued-answer line, a plugin's suggestion (named by `suggestionBy.ts`), the `truncated` sentence, and a commit row that
  is never inside the option list (on a multi-select Submit is the only control that answers
  anything, and a commit button found by scrolling past six options is one that gets missed).
  Sharing the body is not tidiness: the sheet's copy had already drifted, sending a DIGIT at a `nav`
  box (opencode's unnumbered permission dialog), where a digit is a stray character in the composer.

  **One box is answered by tap in the terminal view too: the workspace-trust box**
  (`core/session/termAnswers.ts`, `kind: "trust"` on a running session, nothing else). The "the CLI
  is drawing it, press the digit" argument fails for exactly this box, for two reasons. It is a new
  person's FIRST box, met before they know the key bar exists. And claude 2.1.293 draws it
  UNNUMBERED with the cursor on "No, exit", so a digit does nothing and the obvious Return leaves.
  Filmed in the setup journey, a first session sat there with no way forward but ↓ then ↵ on the
  key bar. The card is the same `PromptAnswer` body as an OVERLAY on the grid's bottom
  (`.term-answer`, with its own scroll), so the PTY is never resized for it, and it covers only the
  rows where the CLI draws the same box. A tap is `answerPrompt`, the host walks the cursor
  (`chooseClaudeNavBox`), and the card goes when the host retires the box. Widen the predicate only
  for a box with the same argument: first contact, and no keystroke that works.

  **Nothing about what an answer IS changed.** Every tap still goes through `core/queue/send.ts`'s `answerPrompt`:
  durable, fingerprinted, first in its lane, refused host-side once the box it names is gone. No new
  send path, and `prompt.answer`/`esc`/`submit` still count the taps — the bar's size counters
  (`prompt.mini`/`expand`/`hide`/`show`, `prompt.detail`) went with the bar, because "how often was
  the card got out of the way" is not a question any more. The reader falls back to the old READOUT
  when no `onAnswer` reaches it, pointing at the CLI: a control that cannot act is not drawn as one
  (`Unavailable.tsx`).
- `ws.ts` — `HostConnection`: single WebSocket, message queue while reconnecting, JSON encode/decode of shared types.
- `webUpdate.ts` / `AppUpdate.tsx` — **the Android shell updates its own web bundle**, so a web change reaches the phone without a new APK; only a change to `packages/app` itself (Java, manifest, icons) needs one. Inert everywhere else — the PWA already updates through its service worker. Almost all of the work is here rather than in Java on purpose: the version check, the transfer, the hashing and the retry policy are worth reading and changing without an Android toolchain in the way, and they reuse the app's own host handling; the native plugin does only what a WebView cannot (write files, choose a serving directory, survive a restart). **Which build am I running?** is answered by fetching `/build-id.txt` — a file that ships INSIDE every bundle and is not one of the two paths the shell re-aims at the host, so it reports the running bundle whether that came from the APK or a download, with no bookkeeping that can drift. Every file is sha256-checked against the manifest and a mismatch aborts the WHOLE update: a bundle mixed from two builds is worse than no update. A finished download is **staged**, not applied — this is a remote control for live sessions, and reloading the page mid-turn for an update nobody asked for is worse than waiting; "restart into it" is a button, and a cold start picks it up anyway. **What "a cold start" means on a phone is the part that was quietly missing**: nobody restarts an Android app deliberately, so a staged build sat there for days while the only control that would take it was a button on a settings screen there is no reason to open — checking and downloading were automatic and the last step was not, which is the same as the whole thing being manual. So the restart is automatic too (`autoApply`, on by default, `auto-restart` in the section) and it is timed off **visibility**, which is the only signal that says whether anyone is looking: hidden for 20 s ⇒ reload off screen, so the app is simply new when it is picked up; or, for the phone that froze our timers the moment the screen went off, hidden for two minutes and then shown ⇒ reload on the way IN, where it reads as the app launching rather than as the screen being pulled away. The stated rule does not change — nothing is applied under a screen someone is reading — it is just no longer waiting for a restart that never comes. The failure it has to survive is a bundle that stages and then does not serve: `markHealthy()` clears a per-build attempt counter when the staged id IS the running id, and without that match a build gets `APPLY_MAX_TRIES` (2) auto-restarts and no more, or every pocketing of the phone would reload the app forever. That is the failure the native boot watchdog cannot see (it counts launches that never render, not launches that render the wrong build); the manual button is never gated by the counter. The origin is `http://localhost` either way, so localStorage/IndexedDB (send queue, drafts, paired host, cached transcripts) survive an update. `markHealthy()` fires from `main.tsx` after the first render and is what clears the native boot-failure counter — three launches that never get there and the shell falls back to the bundle inside the APK, which is never deleted. **Three launches was too slow and the revert did not stick** (a white screen, twice, on the owner's phone): reopening a blank app from recents resumes it and counts nothing, and once the counter did fire, the APK's own bundle downloaded the SAME build and auto-restarted into it on the next pocketing. So the shell also gives every page load from a downloaded bundle 15 s of ON-SCREEN time to call `markHealthy` and falls back in-process when it does not (`ShellUpdatePlugin.armBootWatch`), and it REMEMBERS the build it fell back from: `stage`/`applyNow` refuse that id with code `BAD_BUILD` unless `force` is passed, `check()` turns it into phase `held` without downloading, and only the person's own tap (*try build … again* → `download(true)`) retries it. The next different build is taken as usual. A fallback is said once, as a toast, keyed on the native `lastRecoveryAt`. Settings → App version (`AppUpdate.tsx`) shows the ids, the progress, and the manual revert.
- `hostUrl.ts` / `HostSetup.tsx` — **where the host is, when the app is not served by it.** Inert in the browser (`hostBase()` null, `abs()` returns its argument, nothing patched, every request stays same-origin exactly as before) — it only wakes up inside the Android shell, where the UI is loaded out of the APK at `http://localhost` and the daemon is a different origin. Rules live in `shared/src/hosturl.ts` (node-runnable, so `e2e-hosturl.mjs` pins them); this is the runtime half. **The three transports are patched rather than the call sites**: the client has ~60 root-relative URLs across a dozen files and new ones land constantly, so a rule that only holds where someone remembered a helper is a rule that breaks silently in the APK weeks later — `fetch`, `XMLHttpRequest.open` and `sendBeacon` are wrapped once at boot and a `fetch("/api/…")` written next month is correct the day it is written. A native `shouldInterceptRequest` proxy was the alternative and cannot work: it never sees request bodies, so every upload and POST would break. Only the URLs that never pass through a transport call `abs()` by hand — `api.artifactUrl`/`inboxUrl` (they become `<img src>`) and `pull.ts`'s Background Fetch URL. **`/ws` is the one thing a fetch patch cannot cover** (a handshake isn't a fetch), so `makeConnection()` reads `wsUrl()`. Capacitor is detected off the global it injects, never imported — `packages/web` stays dependency-identical for the browser build. `HostSetup.tsx` is the pairing screen `main.tsx` renders *instead of* `App` until an address is stored (it has to sit above `App`, which opens the socket in a `useRef` initializer on its first render); its probe of `/api/health` before saving exists because every failure mode of a wrong address degrades into the app's NORMAL offline behaviour — reconnect banner, filling queue, sends that never ack — which is precisely the state the user opened the screen to escape. Settings → **Paired host** reopens it via a `app:host-setup` event; Settings → Connection is hidden in the shell, because every button there NAVIGATES to another origin, which in the APK means abandoning the bundled shell for the network.
- **A resize repaints the whole screen — so layout churn IS the flicker** (`Terminal.tsx`, `sessions.ts` `resize`, `useLinger.ts`). `.term-wrap` is `flex: 1`, so every strip that mounts above or below the terminal (the queue bar, the composer's upload row, the connection banner) takes height from it; the container resize refits the xterm grid, the fit reports new geometry, the host SIGWINCHes the PTY and the claude TUI answers a SIGWINCH by CLEARING and redrawing everything. That is why the flicker was never confined to the strip that caused it, and why it appeared exactly during sends and reconnects — the moments when those strips come and go. Four rules keep it down: geometry is reported only when cols/rows actually CHANGED (a keyboard closing, a re-fit, a reattach mostly land on the same grid), `sessions.resize` no-ops on an unchanged size (the one place every client and every reattach passes through — `repaintTerminal`'s deliberate rows-1 jiggle still differs, so it still forces its redraw), transient strips LINGER (`useLinger`) so a burst of sends or a retrying upload is one mount instead of one per attempt, and their height is stable across states (`.outbox-recover`'s `min-height`, the upload track always rendered, a "sent"/"uploads done" frame of the same shape). The connection banner does not participate at all: it FLOATS inside `.term-wrap` (`.conn-banner.floating`), because a flapping tunnel is precisely when it mounts and unmounts, so the indicator for a bad link was repainting the screen twice per blip.
- `LoginBar.tsx` + `openExternal.ts` — **signing in, from a phone.** The host publishes the rejoined sign-in link (`host/login.ts`); this is the part you can press. Rendered above the approve bar in the terminal view, amber rather than the approve bar's alarm-red — nothing is broken and nothing is blocked, there is a link to open. Three actions in the order the flow needs them: **open** (hand it to the phone's browser), **copy** (the fallback for a phone whose browser hand-off does not go where you want, and the only path that works with no hand-off at all), and **paste code**, offered ONLY while `awaitingCode` — outside that window the same keystrokes land in the composer as a prompt. Under a disclosure sits the URL itself, wrapping anywhere and selectable: every automatic path here can fail (a blocked popup, a clipboard that needs https, a browser that refuses the intent), and the last resort has to be the text in one piece rather than the six fragments on the terminal. It scrolls rather than growing, for the reason the approve bar's own height is capped — the bar takes its space from the terminal, and a bar that grows makes the CLI repaint. **The code goes in on the RAW, undurable path, on purpose.** `deliverPrompt` proves a delivery by watching for a turn to start, and a login code starts no turn: it goes into the CLI's login field, not the composer. The verified path would therefore conclude the Return had been swallowed and press it up to five more times into whatever the flow moved on to. Queueing it is meaningless for a second reason — a login code is short-lived, so a send saved for a later flush is a send that will be refused when it arrives. Text and Return are two writes with a gap, per the raw-input rule: sent as one chunk the TUI reads them as a paste and the Return becomes a literal. Clipboard content is sanity-checked (non-empty, no whitespace) and every refusal says which wall it hit, because a clipboard read fails silently as an empty string in three different ways. **`openExternal` is the shell split, and getting it wrong is silent in both directions.** In a browser tab it is `window.open(url, "_blank")`. In the Android shell that is the wrong call: Capacitor turns multiple windows off, so `_blank` either no-ops or punts the URL to the phone's browser, where it resolves against Capacitor's own local asset server and loads nothing — the same trap `Markdown.tsx` and `routing.ts` each document from their own side. What works there is an ordinary main-frame navigation: assigning `location.href` is the only form that reaches `MainActivity.guardNavigation`, which sees another origin, asks "open in your browser?" and fires an `ACTION_VIEW` intent while the WebView itself never navigates. Only `http(s)` is handed to the platform — a `javascript:` or `intent:` URL scraped off terminal text is not a link, it is an injection — and a refusal or a blocked popup is reported, never swallowed. The **Terminal text sheet** lists every link on the screen through the same `findUrls`, which is what makes a non-login URL reachable too. `e2e-login.mjs`.
- `Terminal.tsx` — xterm.js host. Resizes round-trip to the PTY via `session.resize`, and only when the grid actually changed size (see above). Deliberately dumb: the **empty-state overlay** is driven from `core/session/TermArea.tsx` state that already exists (`.term-overlay`) — *no output yet* / *session ended* / *offline, output as of <time>*. Before it, a gone session, a restarted host or an evicted resume point rendered a literal black rectangle with no text, which is indistinguishable from a crash. It renders as a CHIP whenever there is readable scrollback and only as a full card when there is nothing to cover.
- **CLI mode — the compose box as a key pipe** (`cliKeys.ts`, the `CLI` toggle at the end of the special-keys row, `waterplane.cliMode`). The send path is deliberately heavy — queued in `outbox.ts`, carried on an ackId, typed host-side by `deliver.ts`, echo-checked against the rendered screen and submitted with a verified Return — and all of that is what makes a prompt survive a dead tunnel. It is also exactly wrong for *driving the TUI*: picking a file in `/resume`, walking a menu, answering a free-text box, typing `y`. There the keystroke IS the interaction, the CLI echoes it itself, and a queued-and-confirmed delivery of the letter `y` is slower AND less correct than sending the byte — which is why the Esc/Tab/arrow row has always been undurable (`sendInput`), and why the alphabet had no way in at all: the only route for a letter was the composer, which would have run it as a prompt. In CLI mode every keystroke goes straight to `session.input`, raw, on that same undurable path and for that same reason (a key aimed at what is on screen right now is meaningless replayed onto a screen that has moved on). The phone is why `cliKeys.ts` exists rather than a `keydown` handler: **Android soft keyboards do not report `keydown` for letters** (keyCode 229, or nothing), only `input` events on a focused editable — so the box holds a PAD of spaces and every input event is DIFFED against it (`decodePipe`): text appended is text typed, characters missing are backspaces (`\x7f`), a rewritten tail is delete-then-retype. Padded rather than empty because Backspace in an EMPTY field is the one keystroke Android may not report at all — there has to be something to delete for the deletion to be observable — and SPACES rather than zero-width characters, which the IME folds into the word it is composing and hands back as autocorrect. The DOM value is reset synchronously inside the handler (React would restore it after the event anyway, but two events landing before that restore would both measure against the pad and double-count deletes), the baseline is deliberately NOT advanced mid-composition (`compositionend` diffs the finished word whole), and autocorrect/autocapitalize are off — a rewritten word is an invented keystroke, and half of what gets typed at a TUI is not a word. `keyToBytes` covers what no diff can see (Return, Tab, Esc, arrows, `^<letter>` from a hardware keyboard); Backspace is left to the diff, since it already shortens the pad. The box shows the pad and nothing else (`.pipe`, transparent text, accent caret): what you type is already on the screen above, echoed by the CLI, and a second copy down here is only a second place for it to get out of step — the compose draft is untouched underneath and comes back when the mode is off, because losing a half-written prompt to a mode toggle makes the toggle something you think twice about. A tap on the terminal focuses the pipe (the gesture anyone who has used a terminal already has — xterm's own hidden textarea stays pinned `inputmode=none`, which is what stops a special-key tap from summoning the keyboard). The compose bar loses Send, Queue, when-idle and later — there is nothing sitting in the box to aim anywhere, it already left — and says the one thing the durable path guarantees and this one does not, naming it outright when the socket is down: these keystrokes are dropped, not held. Not on the synced allow-list: it is not a taste but which way you are driving THIS device, and a desktop with a real keyboard and a phone in a pocket want opposite answers.
- **Persisted scrollback** (`core/term/useTermFeed.ts` + `idb.ts` store `pty`): the attached session's last 64 KB of PTY bytes (trimmed forward to an `\x1b` boundary so a mid-escape cut can't garble the first row) plus its last `seq`, written on a 30 s interval and on `pagehide`/`freeze`. On a cold start the buffer is seeded from it and `lastSeqById` is set BEFORE the attach effect runs (else `resumeSeq` goes out `undefined` and the delta replay is wasted), so a live host stitches only the delta onto restored output and a reload while offline shows the session instead of black. A `full: true` answer REPLACES the restore (never appends). Restored output is dimmed by a CSS filter on the container — never by injecting ANSI dim codes, which replayed content overrides within bytes — and un-dims on the first live frame.
- **Local scrollback — the pan that needs no socket** (`shared/screenlog.ts`, `web/screenlog.ts`, `ScrollbackSheet.tsx`, `idb.ts` store `screenlog`). `claude` draws in the ALTERNATE screen buffer, so xterm has no scrollback of its own and `Terminal.tsx` translates an upward pan into SGR mouse-wheel bytes for the TUI to consume — a REMOTE scroll. With the tunnel down those bytes went nowhere and the gesture did nothing at all: no movement, no message, the one thing a phone is picked up to do when the link is bad. Nothing local can recover the TUI's own buffer, but every line that was ever DISPLAYED passed through this client, so it is kept: 400 ms after the writes settle the visible grid is read (`gridText`) and diffed against the last one, and the lines that scrolled off the top are appended to a per-session archive (capped at 4000 lines, persisted to IndexedDB, newest 12 sessions — the one cache here that cannot be re-fetched, since the wire never carries the TUI's scrollback). **The diff anchors on the TOP of the new grid**, never on whole-grid equality: the bottom of a claude screen is a composer, a spinner and a token count that redraw several times a second whether anything scrolled or not, so any bottom-sensitive rule reports "everything changed" continuously and fills the archive with near-identical screens. Leading blank rows are skipped (their count moves between repaints) and an all-blank grid is treated as a repaint in progress, never as a scroll of everything. A grid with no anchor at all IS a full repaint — a view opening (`/usage`), a `/clear` — and the outgoing screen is archived whole, which duplicates a conversation screen when the view is closed again: the deliberate trade, since dropping it would lose content. An upward pan with the socket down opens `ScrollbackSheet` on that archive (also on the `scrollback` toolbar item and a button in the offline chip): plain wrapped text in a native scroller, opened at the bottom where the terminal was, with find/next/prev, and labelled as a reconstruction of what THIS device rendered — output that scrolled by while the app was closed was never here, and the reader view (cached transcripts) is where older conversation lives. The live grid is snapshotted BEFORE the sheet renders, because the sheet unmounts the terminal. Wheel sends are also batched into ONE write per flick instead of one frame per line — a dozen round trips on a bad link is the other half of why scrolling felt broken. `e2e-screenlog.mjs` pins the rule, including the round trip: a document walked through a scrolling window must come back whole, in order, once.
- `TranscriptView.tsx` — **reader view**: a toggle-in alternative to the terminal for the SAME session (toolbar `read` button, sticky in `waterplane.readMode`). Plain DOM instead of a terminal grid, so scrolling, text selection, links and find all behave like a web page: markdown-lite rendering (headings/lists/quotes/GFM pipe tables/fenced code/inline code/bold/autolinked URLs — React nodes only, never `dangerouslySetInnerHTML`) applied to assistant text AND user prompts, with ```` ```md ```` fences rendered as formatted markdown behind a source/rendered toggle, collapsed thinking + tool blocks (force-opened when they contain the current find hit), a find bar with hit count and prev/next jump, and an **outline** drawer (one row per turn: prompt, heuristic summary, tool/file counts) that filters to matching turns while a find is active. **Unread mark:** a per-session, per-device watermark in localStorage (`waterplane.trSeen.<sessionId>` = ts of the newest seen turn) highlights turns that arrived since you last left, with a "N new since you left" divider, a `N new` jump button in the bar, and `new` tags in the outline. The watermark advances only when you plausibly saw the tail — leaving the reader parked at the bottom, or tapping "mark read" — and a first-ever open adopts the tail silently instead of flagging the whole history. First paint lands on the divider when there is one (otherwise the bottom). Renders the newest 40 turns with a "load earlier" button, follows the tail only while parked at the bottom, and refetches on turn-end plus a 6 s poll (2.5 s while a turn is in flight), both `since`-gated. **Tool calls are folded by default.** A phone screen holds about fifteen lines, and a turn that read six files and ran four commands spent every one of them on `> Bash …` rows — the prose either side, which is what someone opened the reader for, was pushed off both ends. A RUN of two or more consecutive tool calls now collapses into one `N tool calls · 5 Bash, 2 Read` placeholder; opening it reveals the same rows as before, still collapsed. A LONE tool call is never folded: it is already one line, and hiding its label would cost information for no space. Underneath that, the document itself is `lite` (see host.md) — inputs and results stay on the host, and opening any tool call fetches its whole TURN's set in one request, which is what a person reading that turn opens next anyway. Fetched sets are cached in IndexedDB (`tooldetail`, newest 60 turns) so a call you already opened still opens with the tunnel down; a cached set that predates a result the lite block says has landed (`ok` set, cached `result` missing) is refetched rather than shown. All of it is a **setting** — `waterplane.readerTools`, synced, in `transcriptUtil.ts` and Settings → Reader · tool calls: `fold` (default) / `list` (rows back, details still on demand) / `full` (details come down with the transcript, the pre-existing behaviour — everything there offline without opening anything, at the old size). Passed in as a prop rather than read inside the reader, so flipping it refetches in the new shape while keeping the find box and the scroll position; and a mode switch drops `since` for one fetch, since an unchanged log would otherwise 204 and leave the setting looking broken until the session next moved. **Offline:** the last fetched doc per session is cached in IndexedDB (`offlineCache.ts`, newest 12) and seeded on mount; a failed fetch keeps serving it behind a `CloudOff` "showing cached transcript — as of <time>" chip instead of going blank. Switching back to the CLI unmounts the reader and repaints the xterm the same way a fresh attach does (PTY frames keep buffering meanwhile).
  **Busy indicator:** the reader shows no terminal, so a status strip under the toolbar (plus a pulsing card at the tail) states which of *working · waiting for your answer · blocked on a usage limit · idle · session ended* is true. A pending question outranks "working" (a hooked session stays turn-active while the dialog is up, so both are true): the tail card shows the question and its options — the approve bar with the real one-tap buttons sits directly under the reader — or, for an unparsable dialog (`awaitingInput`), an "open the CLI" button. It scrolls itself into view ONCE per question, so reading history can't swallow it but the scroll position isn't hijacked afterwards. "Working" is `SessionInfo.turnActive` — exact when the session is `hooked` (UserPromptSubmit → Stop, so it stays true through a long, silent tool run), else the same silence guess `idle` makes (the strip's tooltip says which). Alongside it, the CLI's own working line (`✳ Clauding… (9m 20s · ↓ 9.7k tokens)`) is scraped client-side out of the PTY frames the socket is already delivering (`App.tsx` keeps a 4 KB per-session tail), so the elapsed/token counter the terminal would show is visible in the reader too — no extra host traffic, and absent (not wrong) if the TUI stops printing it. **That scrape had stopped working, in the way a scrape does: silently.** It anchored on the literal "esc to interrupt", and claude 2.1.236 no longer prints it — measured in a node-pty at 46 columns (a phone) and at 100, the parenthetical carries the duration and the token count and nothing else. Nothing failed and nothing was wrong on screen; the reader just said *working · output appears here as claude writes it* for nine minutes beside a terminal that was counting seconds and tokens, which is the whole feature not existing. So `shared/working.ts` anchors on the SHAPE instead — a gerund, an ellipsis, and a parenthetical carrying a duration or a token count — and is pinned in `shared/test/working.test.mjs` against bytes a real CLI printed, partial redraws included. Two rules hold it honest: the ellipsis alone is not enough (the TUI truncates other lines with one — "⚠ Transcript saving is off — inherited CL…" — and rendering that as an activity would be the app inventing a fact), and a bare gerund with nothing measured behind it is a FALLBACK, never preferred to a line with numbers on it. The elapsed the reader shows is still the host's turn clock, which starts at `UserPromptSubmit`; the CLI's own counter is the fallback for an unhooked session, and the tokens are the part nothing else in the reader can say. **Offline honesty:** with the socket down the status strip and the tail card label themselves *last known* (`TranscriptStatus.linkDown`) instead of asserting "working · 43m 56s" — a counter reading off `turnStartedAt`, which ticks up just as convincingly whether the agent is working or the tunnel died forty minutes ago — and the pulsing dot (which reads as "something is happening right now") goes quiet. Same rule the backlog's waiting reasons follow: a session fact read from a cache is a fact about the past. When there is neither a live fetch nor a cached document, the failure says so in a sentence and offers the CLI view, which has its own persisted scrollback. **The one state the strip got wrong, for as long as it existed:** a session whose turn ended by launching BACKGROUND agents. The main loop's `Stop` really did fire, so `turnActive` is honestly false and `idle` is honestly true — and the reader said *idle — nothing running* while the terminal two taps away drew `⏵⏵ 2 agents` and counted `59s · ↓ 73.4k tokens` against each of them. The fix is not a wider `turnActive` (that flag is the hook pipe's own fact and half the daemon rests on it being a sharp boundary) but a second fact beside it: `SessionInfo.agents`, read by the host off the CLI's own `subagents/` logs and retired by the parent conversation's own task-notification (host `agents.ts`). In the reader it is a rung of its own — under "waiting for your answer" (a question is owed an answer no matter who else is working) and under "working" (the turn is the bigger fact), but above idle — reading `2 agents running · 3m`, with ONE ROW PER AGENT under it: what it was asked to do (the `description` the Agent call carried), the tool it last called, and how long it has been at it. The count is not the progress; "2 agents running" answers how many and nothing about what, and the reason this view exists at all is that the CLI's own agent panel is a keystroke and two taps away on a phone. The same fact moves `sessionStatus()` from `done` to `coding` (`sessionFacts.tsx`), so the launcher row, the per-repo roll-up and the status filter cannot disagree with the reader — that ladder is one function for exactly this reason — and the turn-finished push says *Turn finished · 2 agents still running* rather than three words claiming the work is over. It changes nothing about what may be SENT: the CLI takes typing while it waits for its agents, and a heuristic over somebody else's log files is not something to let block a delivery.

- `Backlog.tsx`, `Gallery.tsx`, `GitView.tsx`, `SlashSheet.tsx`, `NewMenu.tsx`, `ImageAnnotator.tsx` — feature sheets.
- `gitFailPrompt.ts` — **a failed push or pull on the git screen, handed to a new session.** A failed
  push used to show its pre-push log in the note line and offer nothing to do with it — on a phone,
  the person then had to copy a truncated tail into a prompt by hand. `fix in a new session…` opens the
  Send sheet SEEDED with that log plus what an agent starting cold needs and cannot see: the branch,
  the upstream, how many commits were ahead and the run's own clock. It is a seed, never a send — the
  words are edited, timed and aimed from the Send sheet like every other "ask the agent", and the
  prompt itself leaves the push to the person (an agent that pushes on its own is a push nobody
  reviewed). The log is fenced one backtick longer than the longest run inside it, because test output
  quotes source and source here is full of ``` fences that would close a plain one mid-log. The button
  belongs to the note it was told in (`failure.note === note`): any later note — a fresh commit, a
  successful retry — takes it away, so it can never offer to fix a failure that is no longer on screen.
  Pure and pinned by `gitFailPrompt.test.mjs`. **`copy` beside it puts the SAME words on the
  clipboard** — for a session or a chat that is not this repo's new one (the first failure this
  button was built for was pasted by hand into an existing session). One builder, so the two can
  never disagree. Its receipt is a toast, never the note line: the note is what both buttons belong
  to, and writing a receipt there would take them away mid-tap. It shows even where there is no repo
  to aim a session at, since copying needs none.
- `ImageAnnotator.tsx` — the marks are **editable after placing**, and one of them is a plain **line**.
  A phone drag is imprecise and a circle placed two centimetres off used to cost the whole mark (undo,
  redraw, at whatever zoom you happened to be at): the `move` toggle turns drawing off, a tap selects
  the topmost mark under it — strokes hit-tested against their LINE, since a diagonal arrow's bounding
  box is mostly empty — and a drag moves it, while the two end dots reshape it. The live drag is held
  in a ref and repainted per pointer move, exactly like a fresh draw, rather than through state.
  The selection chrome is drawn on the same canvas `toBlob` exports, so `flattenAsync` repaints
  `plain` first — otherwise a dashed blue box ships inside the uploaded PNG. Emptying the marks
  (undo/clear/delete) leaves move mode, or the canvas silently ignores every touch.
  **A SMALL mark cannot be dragged by its own dots — the finger covers the very thing it is
  placing.** The proven answer, from Procreate's Transform and Lightroom mobile rather than from a
  floating handle (an offset cursor or a text-selection lollipop just relocates the occlusion onto a
  new piece of UI a person then has to aim and read), is RELATIVE drag: the finger can land anywhere
  and the selected mark follows by the delta, so the finger is never on the mark at all and nothing
  needs positioning or clamping to the screen. `annMove.ts` is that decision, pure and pinned by
  `annMove.test.mjs`: `smallOnScreen` measures a mark's own end-to-end span AT THE CURRENT ZOOM
  against the same 48px touch-target floor `grabTol` now grants every mark's hit area, so a mark just
  at that edge is exactly as easy to pick as it is to see is small; below it the end dots are not
  drawn (a dot nothing can land on is a promise the UI cannot keep), so a direct drag on a small mark
  always means MOVE. `moveGrab` is the whole pointer-down priority — an end dot beats picking a mark
  under the finger beats a relative drag on the current selection beats nothing — kept in one place so
  the order cannot drift between call sites. Move-vs-resize, otherwise the same gesture, is declared
  by a three-chip row (`whole · A · B`, `tail · head` for an arrow) that replaces the hint line while a
  mark is selected: the chip is what a floating "resize handle" would have had to BE, with no
  on-canvas geometry to manage, and it is consulted only for a relative drag — a direct drag on a
  visible dot always reshapes that end regardless of what the chip says. A relative drag that moved
  less than `TAP_SLOP_PX` was a tap on empty space, not a move: the deselect-on-empty-tap gesture is
  deferred from pointer-down to pointer-up for exactly this reason, so a genuine drag starting there
  still works. **A move now clips on release through the SAME `annClip.ts` rules a fresh draw does**
  (`settleMove`) — direct drags used to commit unclipped, so a mark could already be shoved half
  off-image with no cut at all. The one new rule is the caller's: a move that would leave nothing on
  the picture is REFUSED, not deleted — the mark snaps back to where it was and the chip row says so,
  because a drag has no undo of its own and a slip must not read as a delete.
  **Knob mode is the opt-in other answer** (`annKnobs.ts`, the `knobs` toggle in the move row,
  `waterplane.annKnobs` — SYNCED, because it was asked to be remembered and the annotator opens on
  whichever device the picture is on). Carried over from a children's drawing app, where it was built for a four-year-old:
  the selected mark wears move · size · turn knobs, each hanging off it on a STRING, so the finger is
  on the knob and the mark stays visible — the occlusion is moved off the mark rather than the gesture
  being moved off it. Relative drag stays the default; some people would rather grab than drive from
  elsewhere, and a knob names its gesture where the chip row must be read first. Every mark turns
  except the highlight band: a segment swings its two points, and a mark with an area gains
  `Mark.angle` about its middle — drawn through a turned canvas, hit-tested in its own frame, kept
  whole-or-dropped by `annClip` like the ellipse, and a turned BLUR pixelates the upright box AROUND
  it clipped to the turn (drawing it through a turned canvas would hide the wrong pixels). The band is
  never turned: the host reads its words as an upright strip. Knobs are sized for adults (36 px, a 48 px catch) in screen px at any zoom, pulled back onto
  the picture at an edge and swung round the mark off each other, and they work off the drag's TOTAL
  delta from `base` — so a displaced knob still moves the mark exactly as far as the finger — and
  commit through the same `settleMove`. In knob mode a drag from empty space does nothing; only its
  tap deselects.
  **A mark may be started off the picture.** The gesture belongs to the WRAPPER (the letterboxed area
  around the canvas), not to the canvas: on a phone-sized image a thumb aiming at the very edge lands
  ON the edge, so the first pixel of the drag is already inside whatever it was meant to enclose, and
  the only repair was undo-and-try-again at whatever zoom you happened to be at. `toCanvas` answers
  for a point outside the image too (it maps through the canvas's own rect, which the zoom/pan
  transform already reflects), so nothing else in the drawing path had to change — what did was that
  the marks now have to be CUT. What overhangs is not part of the picture: the canvas clipped it away
  the moment it was drawn, and the one place it would have survived is the sentence `annNote.ts`
  writes for the agent — as percentages of an image those pixels are not in, paid for in tokens and
  read as a claim about something nobody can look at. `annClip.ts` is that cut, pure and pinned by
  `annClip.test.mjs`, and it is four different rules because a mark is four different things. A BOX
  (rect, blur, highlighter) is clipped to the image: its visible part cannot change, since the canvas
  had already clipped it, and what the clip adds is a stroke on the cut edge — the honest drawing of
  "this runs to the border". A SEGMENT (line, arrow) is clipped along its OWN line (Liang-Barsky), so
  an arrow drawn in from off the picture still points where it was aimed with its tail on the border;
  a bounding-box test is not enough here, because a stroke across a corner can have a box that
  overlaps and a line that never does. An ELLIPSE is dropped or kept whole and never clipped:
  shrinking its box shrinks the arc, so a circle would visibly redraw itself the instant the finger
  lifted, and a mark that moves on release is worse than one that overhangs. A LABEL is MOVED onto
  the image, never dropped — it carries typed words, and the never-overwrite-typed-words rule applies
  to a mark as much as to a draft. The same change fixed `clampToImage`, which clamped the ORIGIN and
  kept the width: a crop dragged in from off the left had its right edge pushed further right than it
  was drawn, i.e. it grew as it was dragged off. Both edges are clamped now, which is identical for
  every rect that starts inside — the only ones that could exist before this. The `line` tool is
  the arrow minus its head, and `markBody` names it from end to end (`red line from top-left
  to bottom-right`) — the note is what tells the agent WHERE to look, so a new tool that draws but
  says nothing is half a feature. Every mark states its position as a coarse word AND percentages of
  the image (`top-left (x 12%, y 8%)`, a region as a span on each axis): percent and never pixels,
  because `scaleForUpload` re-encodes the flattened PNG on the way up, so a pixel coordinate names a
  grid the agent never receives. A **text** mark carries its typed string VERBATIM and unclipped —
  it is the one mark that says something the geometry cannot, so it is the last thing that may be
  summarised away; only whitespace is flattened (the note is one line) and the delimiting quotes are
  neutralised so a label containing one cannot read as two marks. The note's own parentheses are why
  `features/images/logic.ts`'s `swapImageRef` tolerates one level of nesting when it strips a stale `(marked: …)`: a
  `[^)]*` stops at the first coordinate and leaves half the old note in the prompt.
  The text mark is placed in TWO steps — a tap stages the spot, a bar under the canvas takes the
  words — because the one step it used to take was `window.prompt`, a native modal that blocks the
  WebView's event loop (the reason `Confirm.tsx` exists) and that an Android WebView may suppress
  outright: the tool drew nothing at all, which is what "add a text marker" was asking for. Leaving
  the text tool drops a staged label rather than keeping an invisible pending spot, and placing
  empty text places nothing — a mark you can only find with undo is worse than no mark.
  The palette is ONE dot of the current colour that opens a row of swatches, and it opens a row
  BELOW the toolbar rather than a popover anchored to itself: the toolbar scrolls sideways, so an
  anchored layer drifts off its own dot. Five always-on swatches were five slots of a phone's
  toolbar spent saying one thing, which is what pushed `undo` — the control you reach for mid-mark,
  with a slip already on screen — to the far end of a strip you had to scroll to reach it. Undo is
  first now.
  **This screen has no text field of its own, so it blurs whatever had focus on mount.** The
  keyboard arriving here belongs to the compose box you tapped `attach` from (Android does not blur
  a textarea when a button is tapped), and it costs the image half its height twice over: the fit is
  measured against a wrapper the keyboard has already shrunk, so dismissing it left the picture
  small and the only way back was pinching. A `ResizeObserver` on the canvas wrapper re-fits when
  that height changes — but only while the view still IS the fit, since after a pinch the user's
  view is the one that matters; `fitRef` is updated either way, or *reset zoom*, the ×N readout and
  the min-zoom clamp would be quoting a wrapper that is gone.
- `annNote.ts` + the **highlighter** (`ImageAnnotator`'s `marker` tool) — **what a marked image SAYS, as opposed to what it shows.**
  The summary used to be built inline in the annotator and was a list of sentences with no
  handle on it: the real prompt log has a message whose six marks arrived as six identical
  copies of `red circle at left`. Nothing in that names a mark, so the sentence next to it
  ("this one is wrong") points at one of six, and a reply cannot point back. Four rules now,
  pure and pinned by `annNote.test.mjs` because each one is a sentence somebody acts on:
  **marks are NUMBERED in the words and in the pixels from one list** (`visibleMarks` feeds
  both `markNote` and the canvas badges `drawBadges` paints, so the `#2` in the prompt and
  the 2 on the image cannot drift, and neither appears for a lone mark); **an exact twin
  collapses** (a double tap is one mark to whoever looks at it); **a colour is said only
  when it distinguishes** — six "red"s on six numbered marks is six tokens buying nothing,
  while a mixed set keeps its colours because there the colour IS the distinction; and
  **words are never clipped**, typed labels and read-back text alike. The uploaded pixel
  grid is appended separately (`withUploadSize`, called from `App.queueUpload` after
  `scaleForUpload` and from the annotator's inline path, which does not re-encode) — the
  percentages are percentages OF something, and stating the size at the wrong end of the
  shrink states a grid nobody receives. Absent rather than guessed when the final size is
  not a fact. `collagePanelNote` (in `@waterplane/shared`, beside the geometry) rides in the same
  clause: a combined image's panel numbers exist only as pixels, so the arrangement — how
  many, which way they run, whether those numbers are real — is finally SAID.
  **The highlighter is the tool that needed all of it.** A swipe along a line of text draws
  translucent ink MULTIPLIED into the picture (a filled rect hides the words it points at;
  white multiplies to nothing, so picking the tool moves white ink to yellow rather than
  drawing an invisible mark). The band POINTS; it is not read. Until 2026-10-18 the host read
  each band with one Gemini call (`POST /api/host/readtext`) so the note could quote the words;
  the owner did not want a paid call, nor the desktop, for a highlight, and the agent reads the
  picture itself. What is left is phone-only: a band's words can be TYPED onto it (`type its
  words` / `edit` / `drop`), shown before anything is sent, keyed by mark id, never by index
  (undo renumbers), and quoted in the note as `highlight over "…"`.
- More sheets, same pattern (full-screen overlay, `track()`ed entry point): `ScheduleSheet.tsx` (**scheduled prompts** — the list of wall-clock rules plus their editor, off the repos header next to the fan-out, off the compose bar's fourth send mode (**Later**: send → queue → when-idle → later, one ladder of "how long until this runs"; it seeds the editor with the compose text aimed at the REPO's backlog, never at the open session, because session ids are per-boot and the run may be days out — and it deliberately does NOT clear the box, since nothing is scheduled until the editor is saved), and off the fan-out sheet's own **later** button, which hands the composed sweep over seeded (`seed`) and opens straight into the editor: the repo picker and the prompt box over there are already the whole sweep, so the only other way to say "this, but on Thursday" would be retyping both, and landing on an empty list after that tap would read as the tap having done nothing. The editor keeps the ANCHOR and the LEAD apart as separate controls, because a moved usage reset should be one field to change rather than a subtraction the user redoes in their head, and it names the anchor's zone explicitly — the device's own zone by default, since "Thursday 18:00" means the user's Thursday. The whole editor body sits in one `.sheet-scroll` — `.sheet` is a fixed-height flex column, so a form taller than the phone simply overflowed with nothing to scroll, and the repo list's own `overflow: auto` inside that unconstrained parent made it two nested scrollers where neither could be reached. The next-fire preview under the form calls `nextFireAt` from `@waterplane/shared`, the same function the host ticks on, so the sheet cannot promise a time the daemon disagrees with. Saving is queued through `queueOp` on a per-schedule lane (upsert on a client-minted id ⇒ a replay overwrites instead of adding a second weekly sweep), while disabling and deleting are live socket messages for the same reason the limit sheet's controls are: they are decisions about a run that may be minutes away, and one delivered an hour late is about a situation that has already resolved itself), `BranchPicker.tsx` (open a session on another branch/worktree), `HistorySheet.tsx` (this session's recorded prompts → resend / pin / copy), `SearchSheet.tsx` (`session.search`, one session or all), `OutlineSheet.tsx` (**the outline as a sheet** — the turn-by-turn table of contents was a drawer inside `TranscriptView` only, so "where am I in this session?" was answerable exclusively in reader view and could not be pinned to the header at all; it is a `TOOLBAR_ITEMS` action now, so it works from the CLI too and tapping a turn switches to the reader and scrolls there (`TranscriptView`'s `jumpTo` prop, keyed per tap so the same turn twice still jumps). It fetches the same `/api/transcript` doc and seeds from the same IndexedDB cache, so it renders offline like the reader's own outline. The ROWS are one component (`OutlineRows`, exported here and used by the reader's drawer) and the watermark/turn helpers live in `transcriptUtil.ts` — a second copy of "which turn is new" would drift from the reader's unread marks within one edit), `SecretSheet.tsx` (write-only secret setter), `SetupSheet.tsx` (**`Repo readings`** — the compliance checklist and its fixes in region 1, the repo-health series as charts in region 2, split by their comparator; see its own section), `QuestionsSheet.tsx` (**every pending question, answerable offline** — the approve bar taken off the session. A parked session's question reached the phone in whatever seconds of tunnel there were, and then the only route to it was that session's TERMINAL, which means knowing which of eleven sessions is waiting: the thing the launcher only shows while it is live. This lists them from the same `waterplane.snap.sessions` snapshot the launcher paints from — reached from the "N waiting" chip, which is a button now — and offers the same one-tap options, saying out loud how old what you are reading is. Fetches nothing, so it renders identically online and off; a dialog `prompt.ts` could not parse into options is listed honestly with an "open the CLI" button rather than a guessed keystroke. Answering calls back into `core/queue/send.ts`'s `answerPrompt`, never the socket — there is deliberately ONE way to answer, so the fingerprint guard and the lane rules cannot drift between the two entry points. A third group lists the sessions whose TURN ENDED ON A QUESTION asked in prose (`SessionInfo.asking`, host `question.ts`): no box, so there is no keystroke that means anything and the only honest control is "open and reply" — but it is the same sentence this sheet exists for, and until it was published that row read `done` with a "Turn finished" ping behind it. `sessionFacts.sessionStatus` buckets it as `wait` — one ladder, so the launcher badge, the per-repo roll-up and the status filter move together — and the pill says **asked you** rather than "waiting", because unlike the other two waits there is nothing on screen to go and look at: the composer is empty and the ask has scrolled up, so the tooltip carries the question itself), `LimitSheet.tsx` (**who resumes first when the limit lifts** — the steering half of the host's resume queue. A plan limit is an account fact, so sessions block as a GROUP and the launcher honestly showed five rows all reading `limit · auto 12:02`, with nothing to do about it: the only controls were a global switch and a per-session toggle buried in one session's toolbar, so "these three, in this order, and not that one" could not be said at all. Rows are rendered in the host's own `queuePos` order and never re-sorted here — a second implementation of "who goes first" would drift from the one that decides, leaving the number on the row as decoration. Fetches nothing (same `SessionInfo` snapshot the launcher paints from), so it renders offline, but its controls are DISABLED with no link rather than queued: unlike a prompt, "resume this one first" delivered twenty minutes late is an instruction about a situation that has resolved itself — the same reason `session.kill` and the backlog mutations are not durable. The sheet also carries the queue's RELEASE MODE — resume one at a time / one per repo / all at once, cycled from one button in `.sheet-actions` and stored on the HOST, because how many agents may run at once is a fact about the desktop's work rather than about the phone that set it. The row text and the section hint are written from the mode (`MODE_TEXT`), so "#3 in line" says what it is actually waiting for; a line about the probe appears whenever the mode is not sequential, since "all at once" that visibly starts one session would otherwise read as broken. Reached from the launcher's "N at limit" chip), `SnippetSheet.tsx` (saved reusable text the compose box appends), `StartSheet.tsx` (**absorbed and deleted by the send-surface unification below** — kept here as the offline-first way into a repo that section's `SendSeed`/`repair` replaced; **start a session with its first prompts** — the offline-first way into a repo, reached from the repo row's notebook button AND from an ordinary repo tap while the socket is down: tapping a repo normally drops you at an empty composer, which is useless with no tunnel because an unborn session has no id a queued `session.input` could name — and queuing a bare "open a CLI here" for later is worth nothing on its own, since the work meant to run in it was the point. The first prompt is written first and rides inside `session.create`; attached images are parked in the same lane ahead of it; **"another prompt" adds further steps**, each queued behind the create as a `pendingCreate` entry with `holdUntilIdle`, so a chain written on a train ("read the failing test" → "fix it" → "commit") is delivered one turn at a time instead of concatenated into the composer. The whole chain is one sheet draft (`\f`-separated, a character no phone keyboard can type) so an interrupted plan survives a reload. **Attached IMAGES open in the annotator**, exactly like a compose attach and routed by the file's own type rather than by which button was tapped (`isAnnotatable`, in `media.ts` so the two sheets cannot drift) — this is the entry point where the picture is most often the entire brief, and it used to send the raw bytes, so what to look at had to be described in words. The round trip goes through the sheet's DRAFT, not component state: the annotator REPLACES this sheet (one overlay at a time), so `appendStartDraft` writes the marked copy's path into the first prompt — the one that rides inside `session.create`, with the image parked ahead of it in the same `create:<cwd>` lane — and reopens the sheet, which re-reads the draft. For the same reason `updatePrompts` saves synchronously instead of only in an effect: the effect belongs to a component that unmounts in that very commit, so a path appended just before annotating would never reach the draft.) **Start is never disabled by an attach in flight** — it was, and a canvas re-encode that never called back (the `<img>` decode / `canvas.toBlob` of a half-supported codec resolve neither callback) left the sheet's one control permanently grey with an "adding…" label as the only explanation; the button now WAITS for the pending attach instead, so the image paths are still appended before the prompt goes, and `scaleForUpload` bounds both browser callbacks and falls back to the original bytes, `PadSheet.tsx` (the **prompt pad** — drafts with no target yet, because `waterplane.compose.drafts` is keyed per EXISTING session and you cannot write three prompts for a repo that has none; each draft is later aimed at a session, a repo backlog, a FRESH session in a repo (`session.create` with the note as its `prompt`) or a fan-out, always through the durable send paths, never the socket), `features/plugins/DecisionLogSheet.tsx` (the **decision log** — usage-limit auto-continues and plugin suggestions/answers, formerly the oracle's log), `SentLogSheet.tsx` (the **sent-command log** — one row per command the app typed into a session, with its source, whether the app or the user decided it, the exact text and the delivery verdict, and a link into the session so the row can be checked against the terminal rather than believed; reached from the launcher's `sent` button for everything and from the `sent` toolbar item for the active session), `BuildSheet.tsx` (**and its “set up” button** — the empty state used to be a sentence telling you to type `./gradlew assembleRelease` into a phone, which is the exact keyboard work this app exists to avoid, and the repo already knows the answer: package.json scripts, a gradlew task, a CI workflow. The header's `set up` opens a session in that repo with a predefined prompt (`SETUP_PROMPT`, exported from the sheet so it lives next to the UI that fires it) through the ordinary `startSessionWithPrompt` durable path — nothing bespoke, so a tap on a dead tunnel is kept and the session opens on reconnect. The agent writes `.waterplane/builds.json` ITSELF, the same file `builds.ts` reads, rather than reporting a list back over some new message the sheet would have to parse; the buttons appear the next time the sheet is opened, since `openBuildFor` re-asks `build.list` on every open. The prompt's constraints are the load-bearing part, not the detection: what it writes is later run with NO session and NO one watching, so non-interactive, no TTY, and nothing that pushes, deploys, publishes or tags — and it is told not to RUN the builds while deciding. The empty state also says to do this while Claude still has tokens, because this sheet is the thing you fall back to when it doesn't. **The EDITOR has the other half of that answer, and it costs nothing.** Adding one more command — the same release build for the other flavour — should not have to spend an agent turn, and it cannot when the reason you are here is that there are no tokens left; so opening the editor fires `build.scan` and the three blank fields arrive with the repo's own answer under them: every command this project already describes, off its manifests, its CI and its scripts (`host/buildscan.ts` walks, `shared/buildscan.ts` decides — see host.md). Tapping a row FILLS THE FIELDS and does nothing else: Save is still a tap, the command is still editable, and nothing suggested has run — which is what lets the list be generous about what it offers. The query is the fields you already typed (`filterCandidates` over name, command, dir and source, word-wise, so "release apk" and "apk release" are one question), and only while the build is NEW: an edit arrives with its own command in the boxes, which would filter the list down to itself. The suggest panel is open on a new build and shut on an edit for the same reason. The count on the control is the count of what a tap opens — the FILTERED list — so the number and the list cannot disagree. Its three empty states are three different claims and are worded apart: nobody has answered yet (`candidates === null`, "reading the repo…"), the repo describes no build at all, and this repo's N known commands match none of the words in the Name box — only the last is undone by clearing a field, and only the middle says anything about the repo. Candidates are deliberately NOT cached to disk the way `buildCfgs` is: that cache exists because an empty build list is a CLAIM a phone must not make with the link down, while this one is a convenience while typing, on a screen that needs the desktop anyway (`build.save` is live-only), so a stale copy would buy nothing and could offer a script the repo dropped last week. A suggested command that reads like it publishes carries its caution verbatim on the row, in `--warn`, because a build button runs later with nobody watching. **One scroll region, because a build log is unbounded and the controls are not.** The build list, the runs list and the log pane were three siblings of the sheet's flex column: `.list` is `flex: 1` (basis 0) while `.build-run` was `flex: 1 1 auto`, i.e. its basis was the log's own height — so the first build that printed a few hundred lines of gradle output squeezed BOTH lists to zero, and the sheet became a header, a hint and a wall of text. One build could be started and then every control for starting another was gone, the row that starts it included. Everything under the hint now lives in a scrolling `.build-body` whose lists size to their content, and the log keeps its own inner scroll at a bounded height. The head wraps for the same class of reason: `.brand` is `flex: 0 0 auto` globally, so a long repo name kept its full width and pushed `set up` and `new` off the right edge with nothing to scroll — it shrinks here, and the head wraps when even that is not enough. Artifact rows say which KIND they are: a run that wrote nothing still lists the APK that is already there (see host.md), labelled "unchanged by this run", and a done run with no artifact at all says so instead of showing an empty space. **And every row says WHEN** (`when` in `format.ts`): a run carried its duration and nothing else, so five runs of the same command read as five identical rows — "Debug APK · done · 17s · 2 artifacts", four times over — whose only distinction was a sort order the reader had to take on trust, and the artifact listed underneath carried a date of its own that nothing on screen revealed. The run stamp is the run's END while it has one (the instant those files came to exist) and its START while it is still running; the artifact stamp is the file's own `mtime`, which the host has always sent. That second one is load-bearing for the stale case in particular: "unchanged by this run" says the bytes predate the run without saying by how much, which is exactly the question a 227 MB APK sitting next to an identically-sized one raises), `UsageSheet.tsx`, `SpeedTestSheet.tsx`.
- `FanoutSheet.tsx` — fan-out UI, entered from the "Repos & worktrees" section head ("fan out"). Prompt box + presets (`/init`, `/cost`, deps/health sweeps), a repo checklist (primaries by default, worktrees behind a toggle; a selected worktree stays selected while filtered out, so hiding a row can't silently drop it from the run), and the live run list — one row per repo with its status, tapping it opens that session. Each run also carries a **follow-up composer** ("follow up in N sessions"): a second instruction into the sessions that run already spawned, with a per-target tick box (defaulting to all of them) rendered as a trailing `row-act` so tapping the row still means "open that session". Past follow-ups are listed under the run's prompt. Selection + draft are sticky in localStorage (`waterplane.fanout.sel` / `waterplane.fanout.text`): a sweep is usually the same repo set twice.
- **Pinned header actions** (`ToolbarCfg.pinned`, `core/session/SessionHeader.tsx`): any `TOOLBAR_ITEMS` action can also sit in the session header. The terminal toolbar is hidden by `headerCollapsed`, absent in reader view, and now behind the burger by default on a phone (below), so a collapsed session had no route to `files` (the artifacts the agent just produced) at all — and pinning is the reason the burger can default to shut. `renderToolbarItem(t, compact)` is the same renderer with two differences: compact is always icon-only, and it ignores `hidden` — pinning an action to the header is a normal reason to drop it from the toolbar below. Pins are configured in BOTH places that ask the question (the header-commands sheet's chip cloud and a per-row `Pin` in Customize toolbar), `files` is pinned by default (as are `browse`, `scrollback`, the reader's three and the `star`, each folded in once for devices whose saved config predates them), and unknown ids from an older build are dropped at load so a stale pin can't render an empty slot.
- **The toolbar IS the burger's menu** (`waterplane.toolbarOpen`, the `Menu` chip beside the collapse
  toggle in the session header, `core/session/SessionHeader.tsx`). `.toolbar` was a permanent full-width row above the
  terminal, and on a phone that is a whole line of a 6-inch screen spent restating verbs that are one
  tap away twice over — pinned into the header (`ToolbarCfg.pinned`), or in the sheet each of them
  opens — while the thing you are actually reading gets pushed down by it. So it became a reveal,
  persisted per device, with the switch beside the OTHER control that decides how much of this screen
  the chrome gets. Revealing it, though, still produced the row: a sideways `overflow-x: auto` strip,
  and a sideways strip **gives no sign it continues**. Four chips fit a phone and the catalog is
  thirty-odd items, so everything past `gallery` existed only for someone who already knew to swipe a
  bar that looks finished. A vertical list of LINE ITEMS — icon gutter, then the name, every row on
  one left edge — names all of them on the axis a phone scrolls anyway.

  Five details worth keeping. **The switch is in the HEADER, not in the menu it opens**: a hide
  button inside the hidden thing is one you can only reach when you no longer want it. **The panel
  is a full-width flex child of `.topbar`, not an absolutely-positioned popover** — the argument
  `.nav-more` already makes for the launcher's menu: this header WRAPS, so a row is the one layout
  that cannot end up off-screen on a narrow phone. Living in the header also means typing room hides
  it for free (`.screen.typing .topbar > *:not(.hdr-typing-keep)`), which is why `styles.css` no
  longer lists `.toolbar` among the things that mode hides. **It is capped at `50svh` with its own
  scroll** — `svh`, not `vh`, because with the keyboard up `vh` is still the un-shrunk viewport and
  the cap would let the panel cover everything left; an uncapped thirty-item menu is the row-eating
  strip again, worse. **A tap is a CHOICE, so it shuts the menu** (`closeToolbarMenu`, writing the
  same `waterplane.toolbarOpen` key the burger writes — open and closed are one fact with one writer),
  except for `MENU_KEEP_OPEN`: `limit` cycles inherit → on → off and the star toggles (a plugin's switches in the `plugins`
  entry never call `dismiss` at all), so closing under the finger would mean
  re-opening to finish what one tap started. And **the labels are not optional any more**, so the
  customize sheet's *icons only* switch is gone and `ToolbarCfg.iconsOnly` is deprecated rather than
  deleted (it is in every device's persisted config, and this object is spread over the stored JSON —
  dropping the field hides it from the type, not from storage). A column of bare glyphs is a column
  of riddles; the label is the entire reason a menu beats the strip. The header PINS stay icon-only —
  they share one line with the session title (`renderToolbarItem`'s `compact`).

  Two things went with the strip. The **>=900px vertical rail** (`.term-area { flex-direction:
  row-reverse }`) existed only to make the horizontal strip vertical on a wide screen, which is what
  the toolbar now is at every width — two renderings of one control is how the two halves drift apart.
  And with the rail went the **width-split default**: `toolbarOpen` is simply shut until asked for,
  because a menu that is open before you ask for it is that strip again with a different shape.
  It renders inside the not-collapsed group, `headerCollapsed` rendering no menu for it to reveal;
  the pending session's `Unavailable` twin (`toolbar-cants toolbar-cants-menu`, taking the panel's
  own geometry) is gated identically, so the burger means one thing in both states.
- **The header collapse toggle is gone (2026-10-07).** `headerCollapsed` (the right-most
  `ChevronsDownUp` button, folding the header to one row) was removed at the owner's ask: the
  terminal corner group's full-screen button does the same job better — it hides the whole chrome,
  keeps the special-key row, and is drawn on both surfaces. Mentions of `headerCollapsed` above are
  history. A stale `waterplane.headerCollapsed = "1"` on a phone is simply no longer read.
- **The `?` chip asks once, then may go (2026-10-07).** `HintToggle` is on the launcher BAR now
  (it was inside the nav menu) as well as the session header. The first time explain mode is LEFT,
  `HintLayer` asks *keep the ? button?* — asked on leaving because only then does the person know
  what it does. "remove it" sets `hintChip = "hidden"` and the one component renders nothing in both
  headers; the backdrop answers nothing (asked again, like a hint card). Settings has the switch back
  (`hints-chip`) and **`ui-reset`**: deletes `UI_RESET_KEYS` (device look only — theme, sizes,
  zooms, strips, tabs, layout switches, the chip; never words or a synced choice, pinned by
  `storage.test.mjs`) and reloads, behind `askConfirm`.
- `headerCmds.ts` — **header commands**: user-configured one-tap chips between the session title and the view controls. They are in the HEADER rather than the terminal toolbar because the header is the one bar that survives `headerCollapsed` and reader view — a `/compact` you fire every few minutes should not cost an expand, a sheet and the keyboard. A tap goes through `submitInput()` (outbox + ackId), never a bare socket write, so a chip tapped on a dead tunnel queues like anything else. Storage is `{ list, removed }` in `waterplane.headerCmds` (synced through the host, like snippets/presets/toolbar cfg — see `web/settings.ts`) so a later build's NEW default can appear without resurrecting deleted ones, and an emptied list stays empty. The editor is `SnippetSheet` reused (same `{id,title,text}` shape) — do not fork it. Entry points: the pencil/`+ command` chip at the end of the row, and the customize-toolbar sheet.
- `settings.ts` — **the client half of "settings follow the user, not the browser"** (the keys and the reasoning are in `shared/settings.ts`). **localStorage is PATCHED, not wrapped**: snippets, presets, header commands, the toolbar config, launch flags and the pad are read and written from a dozen places across `App.tsx` and five sheets, and new ones land regularly (`headerCmds.ts` was `presets.ts` copied wholesale) — a rule that only holds where somebody remembered to call a helper breaks silently three edits later, on the device you are NOT holding, so `setItem`/`removeItem` are wrapped once at boot and a `localStorage.setItem("waterplane.snippets", …)` written next month is correct the day it is written. Same argument `hostUrl.ts` makes for patching `fetch`. Write times live in `waterplane.syncTs`; `mergeSettingsDoc` runs on every `settings.all` (sent unprompted on hello, so on every reconnect), which is also what pushes edits made while the tunnel was down — there is no queue of its own. Adopting a remote value fires a `app:settings` event (`onSettingsChange`) because these are held in React state seeded at mount, so without it a template written on the phone would sit in localStorage on the desktop until the next reload. The one case with no right answer — a device that has never pushed holding a value the host also has — resolves to the HOST, and `pushAllSettings()` (Settings → Synced with the host → "use this device's copy") is the escape hatch, since nothing is deleted and the local values are still under the same keys.
- `toast.ts` / `ToastLayer.tsx` / `ToastLog.tsx` — the one-sentence reply. Module-level state, mounted once beside `App`; see the `HintLayer` note below for why neither may live inside `App`. **Two later fixes, one report** — *"toast like notifications that disappear too fast to read and also don't list in the notification list"*. Both halves are the same bug: a sentence this app judged worth saying was reachable for 2200 ms, once, and then existed nowhere. So (1) the clock is the LENGTH OF THE WORDS — `toastMs()`, a base plus reading time per character up to a ceiling, pure and node-tested, and deliberately base PLUS rather than the larger of the two, since a `max()` gives "copied" and a forty-character explanation the same three seconds, which is the complaint; the toast became a BUTTON so the ceiling costs nobody anything, and the tap only takes it off screen. And (2) every toast is also a ROW, in a bounded durable log the notification feed renders under its own heading. Durable because the failure mode is a reload — the watchdog's, an update's, or the one a person does when the tunnel looks dead — and the sentence being re-read is usually the last thing before it; bounded and repeat-collapsed (identical words inside a minute bump a `×N` count) because ten "queued" rows push the sentence you were looking for off the bottom. The log is NOT the host's feed and is not merged into it: a host notification is something that happened on the DESKTOP while you were not looking, is mutable per kind, can carry a file and is pushed to the OS, whereas these are local sentences about a tap you just made. One merged stream would put "copied" between two prompts that need a person, which is what the notification kinds exist to prevent — so two labelled halves (*From the desktop* / *On this phone*), cleared apart, and **only the desktop's half moves the unread badge**: a badge that counts "copied" is a badge nobody reads. Not synced, for `activityDismissed`'s reason — every row is a thing that happened on THIS screen.
- `hints.ts` / `HintLayer.tsx` — **what this button actually does**, answerable on a touchscreen. The explanations were already written and already good: ~290 `title=` attributes, several of them two sentences. A `title` is a POINTER tooltip, so on the phone this whole product exists for, not one of them has ever been rendered — the UI reads as a row of unlabelled icons (`↑ ↓ ⧗ + ➤ ↵ 🗑`) with the answer sitting in the markup, invisible. Two ways in, because they answer different questions. **Long-press anything** asks "what is this?" before committing — which is exactly why a first-tap dialog cannot be the only route, since the destructive buttons are the ones you least want to probe by tapping. **Explain-then-confirm on first use** covers the curated `confirm` set (~13 of the catalog's 54): the actions whose icon genuinely cannot be guessed — hold, re-aim, chain-a-prompt-behind-a-queued-create, keep-only-the-newest, fork — or whose first tap is expensive to get wrong. Plus **explain mode**, a global "the next tap explains instead of acting" toggle (the `?` chip in both headers, or Settings), which is the relearn path once everything has been dismissed and therefore the reason a permanent dismissal is safe to offer at all; it outranks even `off`, because it is the way out of `off`. Three things are load-bearing. The handler is **DELEGATED at the document, not a wrapper component**, and falls back to the element's own `title` — the app has ~290 of these across a dozen files with new ones landing constantly, so a rule that only holds where somebody remembered a helper would break silently three edits later into *precisely the symptom it fixes*; same argument `settings.ts` makes for patching localStorage and `hostUrl.ts` for patching `fetch`. **A long-press never performs the action** (the click it becomes is swallowed), which is what makes it safe on a red button, and `data-nohint` opts an element out where press-and-hold already means something — the session rows, which use it to drag. And **disabled controls get `pointer-events: auto` in CSS**: "why is this greyed out?" is the question the hints most need to answer, and a disabled control dispatches no pointer events at all, so the press never starts; re-enabling them costs nothing because the engine still suppresses `click`. Dismissals live in the synced `waterplane.hints` key, so being re-taught on the desktop what you already read on the phone — the exact annoyance the feature removes — cannot happen. Verified by `e2e-hints.mjs`. **The layer is mounted beside `App` in `main.tsx`, not inside it** — the same arrangement `NetPulseBar` uses, and for a reason the strip only had to argue theoretically: `App` returns early from a dozen places, one per sheet, and the two `<HintLayer />` renders it did have were on the launcher and terminal branches only. So inside any sheet a long-press explained nothing, and — much worse — a `confirm` hint still SWALLOWED the tap it was explaining (`preventDefault` + `stopPropagation`) to show a card that was never mounted, which made every hint-gated button in a sheet a permanently dead button: only reading the card marks the hint seen, so the next tap was eaten the same way. That covered `queue.hold` / `queue.serial` / `queue.retarget` / `queue.addprompt` / `queue.resend` / `queue.moveup` / `queue.movedown`, `schedule.toggle`, `limit.first` / `limit.resumeone` / `limit.starredonly`, `fanout.run` / `fanout.followup`, `backlog.fire` / `backlog.refire` / `backlog.done`, `gallery.pull` / `gallery.fullres` and `pull.supersede`. Hint state is module-level, so one mount serves every screen. **The toast had the identical hole** and was moved the same way (`toast.ts` + `ToastLayer.tsx`, also mounted in `main.tsx`): it was `App` state rendered on the launcher and terminal branches only, so every sentence a sheet fired — a queue row refusing to send, a save declined, a mode switched — was painted for nobody, and a control that neither acts nor explains is a dead button. Call sites are untouched: `showToast` is still one function taking one string, it just no longer belongs to a component that returns early.
- `fileRefs.ts` — recognises **transport-dir file mentions** in conversation text (`.claude/inbox/…`, `.claude/outbox/…`, a top-level `.outbox/…`, with or without an absolute/`~` lead-in). Deliberately narrow: only paths containing a transport dir, so an ordinary source path in a diff stays plain text. `parseFileRef` strips trailing sentence punctuation and slices the path down to repo-relative — which is exactly what the artifact endpoint takes.
  **`bareFileRef` is the one deliberate exception to that narrowness.** The commonest way an agent lists what it made names the dir once and then the files ("GIFs (in `.claude/outbox/`): `flow.gif`, `highball.gif`"), and every one of those came out as dead text with the pictures one tap away in the gallery. So a BARE name resolves too, under three conditions that between them leave no room for a guess: **code spans only** (the caller decides — prose is untouched), **media extensions only** (`.md`/`.ts` are the file types a repo is full of, i.e. all of the false-positive risk), and **it must exist in this repo's transport dirs, exactly once** — an unknown name is not a reference and a basename in both inbox and outbox is refused rather than resolved to a coin flip. The listing comes from `transportIndex.ts`; with none, nothing resolves, which is exactly the behaviour that came before. The written-out path stays the convention the repo asks agents for (`CLAUDE.md`), because it is the only form that works in prose, in a listing this device could not read, and offline.
- `UploadScalePicker.tsx` / `uploadScale.ts` — **upload sizing**, the mirror image of `media.ts`. Downloads had server-made thumbnails; uploads had nothing, so the annotator's full-resolution PNG went up whole and the compose bar sat blocked ("Send waits for uploads") for tens of seconds on a roaming link. `scaleForUpload()` re-encodes to a max width (JPEG, canvas) and returns the ORIGINAL whenever shrinking wouldn't help (already narrow, unsupported type, decode failed, result bigger) — the feature degrades, never breaks. The width comes from `auto` by default, which reads an EWMA of the **measured** upload rate (`noteUploadRate`, fed by every completed upload) before falling back to `navigator.connection`: the radio's "4g" says nothing about a Tailscale path through a DERP relay. Explicit widths exist because auto can't know the content — a 4K UI screenshot with 10px text is only readable at full size. The picker renders above the annotator's send buttons (the last moment before the bytes commit) and in Settings → Data usage; the preference is per device.
- `Markdown.tsx` — the shared markdown-lite renderer (headings/lists/quotes/GFM pipe tables/fenced code/inline code/bold/autolinked URLs, plus find highlighting via `hl()`). React nodes only, never `dangerouslySetInnerHTML` — an agent-written doc can't inject HTML. Used by `TranscriptView.tsx` (reader view) and `Gallery.tsx` (document preview); extracted from the former when the latter needed it. The optional **`files: FileRefCtx`** prop (supplied by whoever knows which repo the text belongs to) turns every `fileRefs.ts` match into the file itself — a thumbnail for an image, a chip otherwise, both tapping through — including code spans and markdown link targets that are wholly a transport path. The ctx carries the **`repoId`** and takes an **`mtime`** on `url()` because an inline thumbnail is subject to the same rule as every other picture in the app: only an mtime-versioned URL may be cached (see **Path-only pictures** below), and the bytes are resolved through `useThumbSrc()` like the gallery's, so a transcript read with the tunnel down still has its screenshots. Omitted ⇒ paths stay text, which is what every other caller gets. The ctx also carries optional **`known`** — the repo's transport listing — which is what lets a code span holding a bare media filename resolve (`bareFileRef` above); the gallery's document preview passes the listing it is already sitting on (same repo only: a basename is not unique across repos), and the reader passes `transportIndex.ts`. The URL branch of the inline regex is matched BEFORE the file branch, so a URL containing `.claude/outbox/` stays a link.
- **The archive** (`ArchiveSheet.tsx`): the route back to a session you closed. The whole feature exists because the × on a session row LOOKS destructive and is not — it ends the process, and the conversation stays on disk — but the app only ever showed you the last handful of them, so past that edge the two facts were indistinguishable from the phone. The toasts now say "archived" and name where the conversation went; this sheet is where it went once "Recently closed" has rolled over. Repo-scoped, because a conversation log lives under its directory, with a picker for the rest. Search is a SUBMIT, not a keystroke filter — matching a query costs the host a title read of every log in the directory, and a busy repo holds thousands — and the row count is stated as "N of M" so a query that hides things says so. A conversation that is already open as a live session renders as *open now* and offers a jump: resuming it a second time would put two `claude` processes in one conversation, which is how a turn gets lost, and its delete is disabled outright for the same reason. Deleting is per-row and armed by a second tap, because it is the only action in this app that actually loses a conversation. The entry point is the launcher header rather than the "Recently closed" section header — that section returns `null` when the shortlist is empty, which is exactly the moment the archive is the only way back.
- **The file browser** (`FilesSheet.tsx`): browsing the repo as a folder tree, and editing a file in the rare case that is quicker than asking an agent to. It is not a Gallery tab, and the reason is the cache: a gallery listing is keyed by COVERAGE precisely so one can be re-filtered into another (`shared/gallery.ts`), and a directory listing has no coverage — it is the folder you asked for or it is not, and its rows are ordered by name, not time. Bolting a tree onto the grid would mean bypassing the one piece of logic that makes the grid work offline. Its own caching is correspondingly boring: one IndexedDB record per repo + directory (store `tree`, newest 120), painted BEFORE the live listing lands and replaced when it does, and always labelled with its age — a stale listing presented as current is the same failure the gallery guards against, and a file deleted an hour ago still shows here. Opened files reuse the gallery's `artifacttext` store, keyed path + **mtime**, so a file read on wifi is readable in a tunnel. The recursive name search is the one thing with no offline half and says so: a cache of listings is not an index, and answering a whole-repo question from one folder's rows would be right by luck.
- **Remarks on a file** (`FileReview.tsx`, `fileRemarks.ts`): the image annotator's round trip for a file somebody is READING. A README that does not say what it should was a screenshot, a red circle and a sentence about pixels — when the thing being pointed at was text the agent could open. Review mode marks lines in the source view and blocks in the rendered view (`Markdown`'s opt-in `lineTag` tags every top-level block with the SOURCE lines it came from, because a source line is what the agent can act on and a rendered paragraph is not), takes a comment per mark — typed or dictated through the one dictation chrome (`DictateButton`, given its own `boxKey` so a held recording made for a remark never lands in some other box's turn 1) — and sends every remark on the file as ONE message: `path:from-to`, the lines as quoted when marked (elided past four, cut past 160 characters, since the file is on the desktop), and the words, never clipped. Two taps make a range because a phone has no shift key; a tap on the same thing again takes the mark away. One ordering (`orderRemarks`) numbers both the badges and the message, the annotator's `visibleMarks` rule. The remarks and the comment being written are the last copy of typed words, so they persist per repo + path (`LS.fileRemarks`, kept by the hard reset like the drafts) and cancelling written words or deleting a remark asks once. An agent is likely editing the very file under review, so on every open a remark is re-found by its quoted lines (`relocate`): kept where they still stand, moved to the nearest copy, or left in place and flagged *changed since* in the message — never silently re-pointed at whatever now occupies its old line numbers. Sending goes through `remarksToChat`: the session on screen if it is the file's repo, else a live one there, else a new one picking up its last conversation, and the block is APPENDED to that session's draft, never submitted — the person reads it over and decides *now* or *when it's free* where every prompt is decided.

  **Saving is never queued**, which is the deliberate exception to this app's "everything goes through the outbox" rule. A write composed now and flushed on reconnect an hour later carries a base the file left behind long ago; the host would refuse it `stale`, and the queue row would be a gravestone for a save the user believed was in flight. So the save button is disabled while the socket is down and SAYS why, rather than accepting a tap it cannot honour. When a save IS refused stale — an agent wrote the file while it was open here — the typed text is kept and the only offered moves are "reload from disk" (losing the edit, explicitly) and copying it out. It never re-arms with the fresh base and re-sends: that is the single action that would overwrite whatever the agent just produced, and it is exactly the action a naive retry would take. Entry point is the `browse` toolbar item (repo-scoped — a tree is a worktree's tree; the cross-repo question is what the gallery's all-repos search already answers).
- **Gallery listing states** (`Gallery.tsx`): a filter chip tap fires a listing fetch, and on a slow link the grid kept showing the PREVIOUS tab's files while the chip un-highlighted itself on release — the honest reading of that screen is "the button is broken". The tapped chip now keeps its highlight and carries a spinner for as long as its listing is on the wire (scope/kind/since are set synchronously, so the active chip IS the tapped one), stale rows dim during a refetch instead of being wiped, a first load with nothing to keep paints skeleton tiles, and the head's count is replaced by a spinner. **A failed listing is its own state**: it used to render the same "Nothing here yet." as an empty one — a lie that costs a trip to the desktop to disprove — and now shows the error with a Retry while KEEPING whatever rows were already there. The download tap — one button now, not a browser download beside a queue (`download.ts`) — confirms inline, because an unconfirmed tap gets tapped again and two transfers on a bad link both finish later than one.
- **Gallery offline** (`Gallery.tsx` + `shared/gallery.ts` + `offlineCache.ts`): the grid was pure HTTP — four filters (tab, kind, window, search) that each fire a listing fetch — so with the tunnel down it was eight skeleton tiles for ever, while the phone already held the answer twice over: it painted that listing minutes ago, and it has the thumbnail bytes (see **Thumbnail bytes on the device** below). Every unfiltered listing is now cached in IndexedDB (store `gallery`), keyed by TAB (`galleryScopeKey` — the all-repos tab keys on the repo set, because adding a repo changes the listing) and by COVERAGE (kind + window), and a cached listing is re-filtered locally to answer the question actually being asked. The coverage rule is strict containment, never a broadness score: an all-time listing answers "last 4h" by filtering on mtime, a 4h listing may NOT answer "all time", and an images listing may never answer "docs" however wide its window — images-all-time and everything-4h are genuinely incomparable, and a scalar rank would happily serve one for the other. Getting that wrong is silent and looks like data loss (files that exist stop being listed, files that were filtered out on purpose appear), which is why the rules are pure, live in `shared`, and are pinned by `e2e-gallery.mjs`. The local filter mirrors the host's own (`files.ts discoverArtifacts`): the window cuts on **mtime**, and `kind=image` INCLUDES video, so a chip cannot mean two different things depending on whether the link was up. Only unfiltered listings are cached — cached search hits are a subset, and answering the next search from them would be right by luck. The cache is also a SEED on every load, not just a fallback: it paints before the live listing lands (invisible on a good link) and is replaced when the fetch resolves, with a `live` guard so a slow IndexedDB read can never paint over fresh rows. Rows from the cache always say so and say how old they are — a stale list presented as current is the only real failure mode here — and the failure reason moves into that banner (`isOffline` ⇒ "the host didn't answer") instead of being the headline, which it stays when nothing was cached. Two more halves make the offline gallery an actual reader rather than a list: an opened text/markdown document is kept per path **and mtime** (store `artifacttext`, newest 40 — a regenerated report at the same path is a different document), so the outbox report you opened on wifi is readable on the train; and a file whose auto-download finished is rendered in the viewer straight from the bytes in the `pulls` store, which needs no host and is full-res for free (only `done` records — a partial blob would paint as a corrupt file rather than an interrupted transfer). Deletes are the one thing with no offline half: they are writes against a file on the desktop, so a failed one says the host didn't answer instead of leaving a button that looks dead.
- **Gallery document preview:** opening a `.md`/text artifact RENDERS it in the viewer (markdown formatted, with a source toggle; everything else as monospace source) instead of only offering an "Open …" link — an outbox drop is a report meant to be read on the phone. The text is fetched only when a file is opened and capped at `PREVIEW_MAX` (400 KB) with a note. Every open file also gets the app's one download button (`DownloadButton.tsx` → the queue); `?download=1` — the host's `Content-Disposition: attachment`, on both the artifact and inbox GET routes — survives as the URL that queue itself fetches.
- **Artifact read/download marks** (`artifactMarks.ts`): the gallery grid badges each file `new` / opened / downloaded so an outbox stream shows what's already been worked through. Per-device localStorage (`waterplane.artMarks`), keyed repo+relPath and validated against mtime (a regenerated file at the same path is `new` again) — deliberately no host state: it's a per-phone reading position, like the reader view's `waterplane.trSeen.<sessionId>`. Set on open in the viewer; the `downloaded` mark is written when a transfer FINISHES (`download.ts`'s watcher), never on the tap — a transfer that fails must not leave the grid claiming the file was downloaded. `new` renders only in the outbox scope; repo/all-repos scopes show only positive marks, because "never opened" is the default for every file in a repo. **A second, separate badge shows auto-download state** (`pull.ts` records matched on repo+path+**mtime**, so a rebuilt file at the same path never inherits the old build's "on phone"): a phone icon for bytes already here, a spinner+percent while they arrive, `queued`/`stalled` otherwise. It is deliberately not the read mark's eye/`Download` vocabulary — "did I read this" and "do I have this" are different questions, and one badge answering both is what got a 90 MB APK queued twice. The badge and the viewer's single download button read the same `downloadStatus()` (`download.ts`), so the grid cannot say "on phone" about bytes the eviction sweep cleared while the button under the file says otherwise.
- `ZoomableImage.tsx` — the shared pinch/pan/double-tap zoom stage (pointer events, no library). At fit scale a horizontal drag past ~60 px fires `onNav(±1)`, so the same component gives swipe-between-images wherever a list exists. Used by the gallery viewer and `ImageSwiper.tsx`. **Three anti-black-screen invariants** (the symptom was: pinch an outbox image on Android Chrome → all black, browser Back the only way out): the pan is CLAMPED to the stage so the image can never be dragged off it (a near-black overlay with the image gone looks exactly like a crash); the scale ceiling is derived from the GPU's `MAX_TEXTURE_SIZE` (probed once via WebGL, 4096 fallback) because a composited layer past that limit renders black on many Android GPUs; and `will-change: transform` is applied ONLY while a gesture is live, never as a standing CSS declaration that pins an oversized layer for as long as the viewer is open. Pinch is anchored at the finger midpoint (which also carries two-finger pan), and a `zoom-reset` chip is always visible while zoomed — double-tap alone is undiscoverable when the screen looks broken.
- `ImageSwiper.tsx` — full-screen viewer over a KNOWN list of images: tapping a thumb in the new-image strip (agent-produced screenshots) opens it there and swipe/arrow-keys step the batch, instead of close-and-reopen per file. Actions: `mark` (hands the current one to `ImageAnnotator`) and `ref path`. No wrap-around at the ends.
- `useViewport.ts`, `useVoice.ts` — mobile keyboard / viewport quirks, and the microphone: two engines (the desktop's whisper, the Web Speech API) over one button. `dictateHold.ts` + `dictateQueue.ts` are what make a recording survive a bad link — parked before the first attempt, retried for as long as it takes, landing in the box that asked or on the pad.
- `QueueSheet.tsx` — **manage the offline queue**: every queued/in-flight/failed send, grouped by session in delivery order, each entry editable in place (offline text goes stale — the agent may have done half of it by the time the link is back), reorderable within its own session, sendable on its own, restorable into the compose box, or discardable. A `pending` entry is read-only — it may already be on a live PTY. **Retarget** moves a queued send to another session/repo (or flips input↔backlog) and MINTS A NEW ackId, because the old one may already hold a host ledger verdict for the old target; **hold** (`Hourglass`) parks an entry until that session's turn ends. `op` entries are edit-restricted: a fan-out prompt is free text and editable, a `build.run` payload is not, and neither can be "restored into the compose box" — their `text` is a label, not something to paste. A `session.create` row is the exception in both directions: tapping it rewrites the **prompt** that runs once the CLI is up (`op.prompt`), and a `+` button appends further prompts to its chain — a queued open with nothing behind it delivers an empty terminal, which is never what anyone queued. Those chained rows read "runs once that session is open"; discarding the create (or its delivery failing/ageing out) fails them with a reason rather than leaving them parked on a session id that will never exist, and one whose create is gone entirely (the outbox cap evicts oldest-first, and the create is the oldest entry in its lane) is caught by a mount sweep. The queue bar itself carries an **`auto` toggle** next to "Send now": it drives BOTH switches that decide whether queued work leaves on its own (auto-send, and the ask-on-reconnect confirmation), because either one left in the way turns "sends the moment the link is back" into another tap. Same state as the Settings pair, not a third setting. Reached from the "Manage" *Review* button on the reconnect prompt (the "these were typed offline — send, review or hold" bar) and from Settings → Install & offline, whose *manage N queued* button only appears when there is something queued. The standing queue bar it used to hang off is gone: `ActivitySheet` is where a posted piece of work is now followed for its whole life, and this sheet is kept only while that proves out.
- `outbox.ts` — compose durability AND the **offline send queue**. Drafts (unsent text, per session) plus the outbox, which is now the single send path: every compose/slash send lands there as `queued`, moves to `pending` when written to a live socket, and is dropped only on the host's `ok` receipt; `failed` means given up on — and ONLY because the desktop answered and said no in a way that is not safe to send again (a refused op, a stale answer, a prompt left in a composer); a delivery nobody answered is never failed, it goes back to `queued` on `roundDelay` and keeps trying (see the give-up floor in protocol-and-security.md) and the recovery bar offers a restore. Because the entries are in localStorage, text typed while the tunnel is down survives a reload or the OS killing the tab, and **`App.tsx` flushes the queue automatically the moment the socket reopens** — including the submitting Return, so nothing needs tapping. Bounded by `MAX_SEND_ATTEMPTS`/`QUEUE_TTL_MS` so a half-hour-old prompt never fires into a session that has moved on. **The `OUTBOX_CAP` is enforced on the way IN, by `App.tsx`'s `addOutbox`, not by the write path**: a `.slice(-CAP)` in `saveOutbox` can only drop the OLDEST entry, and the oldest entry is routinely an undelivered prompt — the queue's one job failing quietly, precisely when it is busiest. Settled (`failed`) entries are evicted first; if a queue of nothing but live sends still overflows, the oldest is FAILED with a reason so its text stays visible in the recovery bar. Settings → Install & offline has an auto-send switch (on by default) for holding the queue instead. **The retry is only safe because the host de-dupes on `ackId`** (see the wire invariants) — do not add a second send path that bypasses the queue, and do not retry without an ackId. Entries carry a `mode`: `input` (type it into the session — and, with `pendingCreate`, for a session that does not exist YET: the prompts chained behind a queued `session.create`, bound to the real id by `bindPendingSession` when `op.ack` names it), `backlog` (a work item), `upload` (image bytes on their way to a repo inbox — see below), and `op` — the durable form of `session.create`/`fanout.run`/`fanout.followup`/`build.run`, whose full payload (ackId baked in, so a re-send is byte-identical for the host ledger) rides in `op`. Before that, every non-text message went to `ws.send()`, which parks it in a RAM-only queue: opening a session or firing a 12-repo sweep while the tunnel was down was lost on the next reload and invisible in the queue UI. Op entries settle on `op.ack`, never on `input.ack` — they must not press the ack-gated Return and must not `session.record`. Lane keys are `create:<cwd>` / `fanout` (one lane, so sweeps stay ordered) / `fu:<runId>` / `build:<repoDir>`. **`upload` is the one mode that never touches the socket** (it is `api.uploadInbox`'s POST) and **EVERY attached file goes through it, online or not**. It started as the offline path and is now the only one: an annotated image exists nowhere but the tab's canvas state until it is sent, so uploading it straight from RAM leaves a window — the whole transfer — in which a reload destroys it, and a dropped tunnel is exactly what makes `ws.ts`'s watchdog reload the page. The observed failure was text + a marked screenshot, "send & run", tunnel blip, reload: the prompt survived (drafts persist per keystroke) and the picture it named had never existed anywhere else. Parking first writes the bytes to IndexedDB and the intent to the outbox before anything can go wrong, and hands back the predicted path immediately, so the prompt naming it is queued behind it within milliseconds of the tap. The queue is also what enforces ORDER: an attach queues the picture and a prompt saying "look at `.claude/inbox/x.jpg`" together, and delivered the other way round the agent is pointed at a file that isn't there. `queueUpload` (session/annotate flow), `uploadMany` (picked files) and `ImageAnnotator`'s inline send all park; the annotator's direct POST survives only as the fallback for a browser with no IndexedDB. `ws.ts`'s `setReloadGuard` is the other half: the last-resort reload is vetoed (and re-armed) while the annotator is on screen, because everything else the app holds is persisted and that markup is not. Its bytes live in IndexedDB (`idb.ts` store `uploads`, keyed by ackId — a photo is megabytes, and localStorage is the one store the send queue must not be evicted from), it has no ack timeout (an upload on a roaming link legitimately takes a minute; a 6 s receipt deadline would re-POST it mid-flight) but holds its lane through the flusher's `inflight` set, and the re-send is de-duped host-side by `x-dedupe` rather than an ackId. **Three rules make that retry actually work in the background**, and each closed a way the image silently never arrived while the prompt naming it did. (a) A `permanent` verdict is distinguished from a dead link: `api.uploadInbox` used to resolve on ANY status because `xhr.onload` fires for 401/403/5xx too, so `runUpload` saw no `saved[0]`, failed the entry for good and `dismissOutbox` then dropped its bytes from IndexedDB — a transient gate made unrecoverable. Only a 200 carrying `skipped` is the host's verdict; everything else rejects and requeues, and only 413/415 is flagged permanent. (b) The attempt is ROLLED BACK when the link was down, the same rule `armAckTimeout` applies to socket sends and the one this path lacked: retries run on the 5 s sweep, so eight failures went by in under a minute and the image expired ("delivery kept failing") while the tunnel was still coming back. (c) `UPLOAD_STALL_MS` bounds SILENCE, not the transfer — an upload has no ack timeout and the disconnect requeue deliberately skips it, so a POST that neither resolved nor rejected held its lane forever and only a page reload recovered it; XHR's own `timeout` is wrong here because it would kill a legitimate slow 60 MB upload, while a progress-reset stall timer lets a slow-but-moving one run. Aborting before requeuing is what keeps the retry from racing a live POST. (d) **An attempt only counts when the host ANSWERED** (`uploadAttemptWasted` in `shared/queue.ts`, `UploadError.responded`): a status — any status, 500 included — means this file was heard and decided on, while a transport error decided nothing, and `socketOpen` alone is not proof because a host being restarted kills the POST a moment BEFORE its WebSocket close event lands. That gap is exactly where uploads die: `npm run restart` is routine, eight attempts on the 5 s sweep is under a minute, and the image was then failed for good ("delivery kept failing") on a link that was fine either side of it. And a failed upload now **fails the queued messages that NAME it** (`failDependentUploads`, matched on the predicted `relPath` within the same lane): the lane ordering was only enforced on the success path, so a failed image freed its lane like any settled entry and the prompt was delivered pointing at a `.claude/inbox/` file that would never exist — the phone reporting success while the session saw a missing file. **The REFERENCE decides the lane, not the tap that attached the file** (`adoptReferencedUploads` in `shared/queue.ts`): the lane ordering above only ever held when the picture and the prompt happened to be parked under the same key, and they routinely were not — `uploadMany` and the annotator's `onPark` parked under the REPO dir, so an attach made with no session open, a backlog/gallery annotate, or simply switching sessions between attaching and sending left the image in one lane and the prompt in another. Two lanes drain concurrently, so the prompt beat its own image up the wire essentially every time and the agent read a `.claude/inbox/<file>` that did not exist yet — with the link UP, which is why it never looked like a queue problem. Every text-queuing path now runs `guardUploadRefs` first: live uploads whose predicted path appears in the text are moved into THIS lane (ackIds kept — an upload's ackId is the IndexedDB key its bytes live under, and the host de-dupes this path on the file via `x-dedupe`, not on the ledger), and the park-time lane is chosen from where the path will be sent from. A text naming an upload that already FAILED is refused outright (`danglingUploadRefs`, plus `noteDeadUpload`/`deadUploadReason` — a bounded localStorage list, because the path is copied into the compose draft the moment the image is attached and the draft outlives the queue entry, so `failDependentUploads` has nothing to match once the entry is gone): the text stays in the box with "re-attach it", since delivering a path that will never resolve makes both ends disagree about what happened. The path a prompt references is PREDICTED at queue time (`plannedInboxPath` — stem + timestamp + random, so the host's `ensureUnique` has nothing to collide with); if the host renames the file anyway, `rewriteQueuedPath` follows it through every queued message, op payload and the live compose draft. `session.kill` and backlog mutations are deliberately NOT durable: a destructive command delivered an hour late acts on a state nobody is looking at. Also here: the **prompt pad** (`waterplane.pad`) — untargeted drafts, see `PadSheet.tsx`. Alongside the per-session drafts it also holds **sheet drafts** (`waterplane.compose.sheets`, `loadSheetDraft`/`saveSheetDraft`): the text typed in a sheet that has no session to key a draft on — the pad's editor buffer and `StartSheet`'s first prompt — persisted per keystroke rather than on Save. Both are written precisely when there is no tunnel, on a phone that kills backgrounded tabs, so "lost unless you tap Save" meant "lost whenever the network decides"; an interrupted pad note reopens its editor with the text still in it. **Seeding a draft is a DELETE unless it rescues first** (`seedSheetDraft`, `shared/pad.ts`'s `draftToRescue`, lint `local/no-draft-clobber`): this store has no listing of its own, so the only route back to a draft is re-opening the exact sheet that wrote it, and anything that breaks that single route — a routing bug, a reload, an OTA bundle swap, a killed tab — leaves words that exist and that nothing on the phone can reach. `openSend` then overwrote them from its seed, silently, and that WAS the last copy: a prompt typed with a schedule set and a screenshot marked up went that way, and the report was "I can not find that prompt anymore anywhere". A non-empty draft that is not already the seed therefore becomes a PAD NOTE first (`shared/pad.ts`'s `draftToRescue`) and the overwrite is ANNOUNCED, because a silent rescue is a file nobody looks in. The rescue list it used to go to — its own store, its week-long TTL, its *restore* row — is gone with the per-note merge: there is one pad, and a rescued draft is a note on it like any other. `seedSheetDraft` answers `seeded`/`kept`/`refused`, and on a `refused` (the pad is full, which is precisely when somebody opens `send…` on a note to make room) it writes NOTHING: the draft stays exactly where it is and the sheet opens on it. Which is also why the seed then drops its `padId`/`ackId` (`seedAfterRescue` in `sendIntent.ts`) — the sheet is composing the rescued draft, so a Send must not retire the note or the queue row the seed came from, whose words never went anywhere. A rescue that could not happen must not also be a delete. Writing an empty string is left to `clearSheetDraft`, which does not rescue — a discard is the user saying so. The two sheets that OWN a draft still call `saveSheetDraft` per keystroke; the lint rule is scoped off for exactly those, in `eslint.config.js`. Two rules on top of that:
- **An explicit send beats the park** (`sendQueuedNow` / `flushOutbox(armAll)` / `holdWall` / `unpark` in `core/queue` (`verbs.ts`, `send.ts`, `logic.ts`)). `holdUntilIdle` is one flag over four different facts (`laneBusy`), and only three of them survive a decision made by a person. A turn in flight is the ordinary case — typing into a working session is what every UN-parked entry does — so "send this one now" and "send all" already cleared the retry backoff and `serial` on exactly that argument, and quietly did not clear the park: the row said *waiting until the session can take it*, the tap armed it, `selectSendable` blocked it `held` again, and the flush sent nothing. With the toast invisible inside the sheet (above) that was a button with no effect and no explanation — the reported bug. The other three facts are not a wait but a WALL: prose delivered into an open question box goes INTO the box (it neither runs nor answers) and one delivered into a limit-blocked session is typed at a menu, so those keep the hold and are named instead ("a question is on screen in that session — answer it first"), because "nothing happened" is the one answer a tap must never give. Two details are load-bearing. The entries AHEAD of the tapped one in its lane lose their park too — a lane is delivered in order and a held entry HOLDS it, so releasing only the tapped one leaves it queued behind a message that is still waiting, i.e. the same dead tap one row up. And a `pendingCreate` entry is the exception in both paths: its lane is a session that does not exist yet, so its park is not a wait it is serving now but the flag it needs AFTER `bindPendingSession` gives it a real id — stripping it would let a chained prompt be typed while the CLI is still starting up.
- **One session at a time per repo** (`serial` / `busySerialGroups` / `applyHold` in `shared/queue.ts`, `isSerializable` in `outbox.ts`, the `waterplane.serialSessions` switch). The lane rule stops two messages being TYPED into one composer at once; it says nothing about the work they START. `op.ack` means *accepted and started*, and a `session.create` is acked the moment the host has spawned the CLI and typed the first prompt — so a lane holding five queued opens for one repo drains in seconds and leaves five agents running at once. Observed exactly as designed and exactly wrong: prompts written on a dead tunnel, the link comes back, one account's usage limit is spent five ways in parallel, nothing finishes, and five sessions edit the same working tree. A serialized entry therefore waits for its GROUP, not just its lane. The group is the **cwd** (`serialGroup`), which is the whole reason a worktree exists — `parallel` backlog mode makes one per item precisely so the checkouts can't collide — so two opens in two worktrees remain independent, and the setting is about a repo, not about the app. Busy is `laneBusy` folded up to the directory: the same three facts (mid-turn, parked on a question, blocked on a usage limit) that the host gates auto-fire on and that `holdUntilIdle` already waits out, over ANY live session in that directory, including one opened by hand — "don't edit this repo from two agents at once" is not a statement about who started them. Three things make it hold in practice. (a) An entry still on the wire marks its group busy, not just its lane: between the write and the ack there is no session yet to look at. (b) `SerialWatch` covers the next gap — between `op.ack` naming the session and that session reporting its first turn the CLI is still coming up, so the live session list says *idle* and the next open would start a second later; the watch holds the group until the session has a `turnStartedAt` or `SERIAL_STARTUP_MS` runs out, so a session that never comes up cannot wedge the queue for ever. (c) The TTL is split, which is the part that is easy to get wrong: waiting is the behaviour that was ASKED for and routinely outlasts `QUEUE_TTL_MS` (ten queued opens at ten minutes each is over an hour), so a never-attempted entry is parked BEFORE the clock is consulted and handed back in `plan.hold` for `applyHold` to push its `ts` forward — but an entry that has already been on the wire falls through to the ordinary expiry, because the host's ack ledger forgets a verdict after 45 minutes and a retry outliving it is a prompt typed twice. Scope is deliberately narrow: only a `session.create` that CARRIES A PROMPT is serialized. A bare "open a CLI here" runs nothing and edits nothing, and making an interactive tap wait for another session to finish would be an obstruction rather than a safeguard; a fan-out is parallel across repos by definition and has its own host-side concurrency cap; ordinary text is already serialized by the lane of the session it names. Overridable at both altitudes — the sheet's switch decides the default for what gets queued next, the list icon on a row flips one queued open either way, and "send this one now" clears `serial` outright, because a tap is a decision about this message and a default is not.
- **What became of a delivery nobody could confirm.** This used to be the phone's job: `settleFailed`/`applySettled`/`retireStaleFailed` swept `failed` rows on a client timer, asked the host `input.settle`, and `retireToPad` moved a row's words to the prompt pad `FAILED_RETIRE_MS` after it failed with nothing resolved. That was the wrong end of the wire — the sweep only ran from a tab that reloads on the worst link, so on a bad day nothing ever revisited the row. **The host holds the question now** (`opendeliveries.ts`): it re-asks the CLI's own conversation log on its own sweep whether or not anybody is connected, re-sends a provably-absent prompt exactly once, and broadcasts the resolution as `input.settled`. All the client does is apply the verdict to the row it names (`applyDeliverySettled` in `core/queue/useQueue.ts`) — `landed` drops the row and says it ran after all, `composer`/`unknown` restate the row with the host's current sentence, `absent` re-sends once under a new ackId. Nothing retires a row on a clock any more: a failed row keeps its own row, its full words and its `cwd`, for as long as it takes, and Activity is where it is triaged.
  - **One delivery in flight per session** (`shared/queue.ts` `selectSendable`; the flusher only picks the head of each free lane, the ack handler releases it `LANE_GAP_MS` later). Writing two queued messages for the same session at once concatenates them in the PTY composer and the trailing Returns submit the mush — which is exactly what "typed three things while the tunnel was down" produced before. Lanes for DIFFERENT sessions still drain together.
  - **A flush that sends nothing SAYS WHY, and the reason comes from the ladder that decided.** `flushOutbox()` returning 0 was read by every caller as proof the link was down — "still offline — staying queued" — on a screen whose own header simultaneously read `open · 100.64.0.5` and whose queue bar said "going out one per session" while nothing went out. Three statements about one instant, two of them false, and the true one (the queue was held / backing off / behind another send / waiting for a session to open) discarded. Zero-sent has at least seven causes and the dead link is only one of them. So `selectSendable` now emits `plan.blocked` — one `{ ackId, sessionId, reason }` per queued entry it refused, tagged at the `continue` that refused it (`inflight` · `pendingCreate` · `held` · `backoff` · `lane`), with the sixth (`gate`, the user's own auto-send/reconnect switches) appended by `flushOutbox` since `sendEligible` is deliberately a separate question ("did the user mean to send it?" vs "would it corrupt the session?"). `queueIdleReason` picks one sentence, ordered by what a tap can FIX rather than by queue position, so the switch outranks facts about a session; `App.tsx` parks it in `flushIdleReason` for the four "Send now"-shaped call sites and the queue bar. Same rule as the backlog's `waiting()` and `pulls.whyIdle()`: an explanation re-derived from a second reading of the state drifts from the behaviour it describes, which is worse than saying nothing. Verified by `e2e-queue.mjs` (every parked entry is accounted for, a sent one is never "blocked", and with the socket open no reason may claim the link is down).
  - **`mode: "backlog"` entries are the same queue.** The compose bar's queue buttons ("queue for this session" / "add & run now"), the image-attach queue AND the Backlog sheet's own add used to write `backlog.add` straight to the socket, and the ws layer drops sends it can't deliver — so a work item queued offline was lost outright. (The sheet's add was the one left behind by the first pass, while its offline banner already promised the opposite — add is the one control that stays enabled there.) They go through the outbox now and are acked via `backlog.ack`.
  - **`armed` vs auto-drain.** An entry is eligible when it has already been attempted (a retry is the same message), when the user explicitly released it (`armed`: tapped Send with the link up, "Send now", "Send all"), or when auto-send is on and no reconnect confirmation is pending. `waterplane.confirmQueue` (default on) makes a reconnect ASK before draining offline-queued text, because that text was written against a session state that may be long gone; the hold only ever covers entries queued while offline. **Releasing is per LANE, never per message** (`armLane`): a lane is delivered head-first, so arming one entry while an unarmed one sits in front of it would strand the send silently — sending to a session (or tapping send on one of its queued messages) therefore releases everything queued for THAT session, in order, and says so; other sessions stay held. A hold is also cleared on any reconnect that has nothing to ask about, so a stale hold can't park the queue with no prompt to release it. In `App.tsx` the queue is **ref-authoritative**: `writeOutbox()` sets `outboxRef.current`, localStorage and React state together, and every mutation derives from the ref rather than a `setOutbox(prev => …)` updater — the flusher runs synchronously right after a send is queued, and a not-yet-applied functional updater made the new entry invisible to it (every message stalled until the next sweep).
- `attachments.ts` / `AttachStrip.tsx` / `ResendSheet.tsx` (absorbed and deleted by the send-surface unification, below — its file-repair job is now the Send sheet's `repair: true`) — **the files a prompt names, and whether they will be there.** An attached photo is written into the text as `.claude/inbox/<stem>-<ts><rand>.<ext>` BEFORE its bytes move (`plannedInboxPath`), because the prompt and the upload are queued in the same breath and the path cannot wait for an answer. Two consequences, both silent. The name is built to never collide, not to be recognised — a camera counter plus six random characters — so a queue holding three of them cannot be read: “which of these is the crash screenshot?” has no answer short of sending them and looking. And the path says nothing about existence: the upload is a separate queue entry with its own retry budget and its own verdict, so it can fail, be discarded or age out while the message naming it survives intact, reading perfectly and pointing at a file nobody is uploading. `AttachStrip` answers both for any text — a thumbnail per mention, drawn from whichever copy exists (**local bytes first**: they need no link, and while the upload is still queued they are the ONLY copy), plus one sentence of state. The state itself is pure and lives in `@waterplane/shared`'s `attach.ts` (`e2e-attach.mjs`), which ranks the host's own listing over the send queue over bytes retained on the phone over a local “that upload died” record; the ranking matters because a file can arrive by a route this device never saw (a late-landing attempt, the agent writing it, a second phone) and a stale local record must not veto a prompt that is fine. It is equally deliberate that `unknown` (the host could not be asked) is never reported as `missing` (the host was asked and has not got it): the first is a dead tunnel and the second is a lost photo, and telling someone their picture is gone when the tunnel is merely down gets a second copy uploaded. Shown in the compose bar (behind a 700 ms debounce — the alternative is a repo listing per keystroke), under queue rows, and under pad notes; the pad can resolve paths at all because `retireToPad` now keeps the entry's `cwd`. `ResendSheet` is the missing third button next to try-again and discard on a send that gave up: **retrying re-sends the same words to the same session naming the same attachments, which is exactly what already failed.** It opens the text for rewriting (twenty minutes of dead link is enough for half of it to be overtaken), checks every file, and offers per file the action that fixes it — re-attach the copy still on this phone, pick a different file (its own hidden input, so the shared picker's annotator/backlog state machine gains no rarely-taken branch; the new mint is substituted into the text), or drop the mention and send the words alone. Sending mints a NEW ackId and goes through `submitInput`/`queueBacklog`, so there is no second send path and the at-most-once ledger and lane rules stay the ones `e2e-queue` pins; the original row is retired only AFTER the replacement is queued. The enabling change is in the queue (`core/queue/send.ts`'s `retainUploadBytes`): the bytes of a dying upload are **moved aside rather than deleted** (`retainUploadBytes` → `keepUploadBytes`, keyed by the path, bounded oldest-first at `KEEP_CAP`). Erasing the only copy of a photo from the only device that had it — which is what `dismissOutbox`, `removeQueued` and `retireEntry` all did — is what made a failed upload unrecoverable and left `noteDeadUpload` with nothing to offer but a refusal. `NetHealthSheet` gets the same treatment from the other end: it counted the sends that gave up and then said their text was “in the recovery bar” — true, and useless on a screen that is not this one. The count is a button now.
- `media.ts` — client half of the thumbnail scheme, plus **data saver**. `pickThumbWidth()` snaps a CSS size up to a host-allowed width (DPR-capped at 2 — a 3x phone does not need 3x bytes for a thumbnail) and `sized()` appends `thumb`/`v`. The full-screen viewers (`Gallery`, `ImageSwiper`) load a **screen-width** copy and offer an explicit "full res" tap that swaps in the original — reset on every open/swipe, so browsing a batch can't silently pull full-size bytes. Annotation and download always use the original. `dataSaver()` (Settings → Data usage, per device in localStorage) shrinks the requested widths and multiplies the reader view's poll interval by 4.
- **Upload progress**: `api.uploadInbox` uses XHR, not fetch, for exactly one reason — `upload.onprogress`. The compose bar blocks until uploads land, and a bare spinner is indistinguishable from a stalled uplink; the strip shows percent / bytes / rate / ETA over a determinate bar, and each finished upload feeds `noteUploadRate()` so the next `auto` width is better informed. (Streaming request bodies would give fetch the same thing but need HTTP/2 + duplex, unavailable on these browsers.)
- **An `unconfirmed` verdict is the desktop's QUESTION, not a failure** (`sendConfirm.ts`,
  `hostStillConfirming`, the strip's `confirming` branch, `activityRows.queueRow`,
  `OutboxEntry.hostSettled`). `deliver.ts` gives up reading the screen after four seconds and the log
  after two and a half, and the phone applied that verdict to the row as a FAILURE — so seven
  seconds after tapping Send the strip above the composer went red, read "1 message not delivered —
  nothing ran", and offered Restore / Manage / Dismiss. Timed on a phone, complained about with a
  screenshot. Every word of it was premature: the host had at that moment only written the row down,
  and it goes on to re-ask the CLI's own conversation log on a doubling sweep and to retype a
  provably-absent prompt up to `RESEND_TRIES` times — about the first minute — before anything is
  settled. Worse than premature, it asked for the one action nobody may take: re-sending an
  `unconfirmed` prompt by hand is how a prompt runs twice, which is the failure the whole verdict
  exists to prevent. So the row now has a third state on this side — typed, and being confirmed —
  drawn MUTED (never amber, never the failure red), with no warning triangle and no recovery
  buttons, offering only *Which* (the words, so they can be found) and nothing that acts. Activity
  reads it as `running` with its own sentence, and "try again" is refused there with the confirming
  reason rather than the settled one, so the failure count and the *needs you* chip stop claiming a
  row nobody can act on yet. It ends three ways: `delivery.settled` drops the row (`landed`) or
  restates it with the host's own sentence, both of which stamp `hostSettled`; or `CONFIRM_WINDOW_MS`
  (150 s — the host's whole ladder plus slack) runs out with no word at all, and red is finally the
  honest colour. **`unsubmitted` is deliberately NOT in this state**: the host SAW the words in that
  composer, so the fact is known, the action is a person's (press Return there) and the host never
  re-sends one — hiding it behind "confirming" would bury the one send that really is waiting on
  somebody. `sendConfirm.test.mjs`, plus the two Activity cases either side of the window.

- `pull.ts` / `PullSheet.tsx` — **auto-download**, the read-side twin of the send queue. `outbox.ts` makes text survive a dead tunnel on the way UP; this makes bytes survive it on the way DOWN. The host says what is worth having (`host/autopull.ts`); this fetches it and keeps the byte offset across a dropped link, a reload, and the app being killed. Two engines: **Background Fetch** (`registration.backgroundFetch`, Chromium + installed PWA + secure context) hands the transfer to the browser, which keeps going with the app CLOSED, shows an OS progress notification and retries by itself — this is why no APK is needed on Android, and it is started from the SW's **push handler**, the one place that runs with nothing open; and a **chunked Range loop** everywhere else (iOS has no Background Fetch), which reads the body in slices and persists the accumulated Blob **plus its offset in the same IndexedDB record** (`pulls` store) so the two can never disagree — a stored "received: 40 MB" against a 12 MB blob would append the wrong range and produce a corrupt file that looks complete. Every resume branch exists for a specific failure: a server that ignores `Range` answers 200 with the whole body (the stored prefix is thrown away, never prepended), a file rewritten between attempts has a new ETag (`if-range`, restart), and a stream that ends early without an error is still incomplete (`received < total` throws rather than marking done). Downloads run ONE at a time — two transfers on a bad link both finish later than the same two run in sequence, and a half-downloaded APK is worth nothing. The finished bytes are handed over via **Cache Storage** (`waterplane-pulls-v1`), not written to IndexedDB by the worker: a worker opening the app's DB *by version* can collide with a page holding the previous one, and *versionless* would find no `pulls` store on a client that hasn't upgraded — either way the download would be lost at the last step. `sync()` reconciles with the host queue but never deletes a record whose bytes we already hold: dismissing a queue entry must not delete the file you came for. **A superseded item is cancelled, not finished**: an item's `supersedes` ids (and, on reconnect, any local record whose `family` matches a live item with a newer mtime — the host drops each older entry as the next lands, so the ids item N-1 superseded are on nobody's list) are deleted and their partial bytes discarded, ABORTING the transfer if it is the one running, because those bytes are a build that has already been replaced. A `done` record is exempt in both paths — the file is on the phone already, and deleting something the user waited for because a newer one exists is the one move this must never make. The sheet carries the queue AND the per-repo rules, because "why hasn't it downloaded?" is answered by one or the other. **Saving the finished bytes OUT of the app is two paths, not one** (`nativeSave.ts`): in a browser a hidden `<a download href="blob:…">` is exactly right, and inside the Capacitor WebView it does **nothing at all** — no download listener, no error, no file, so "on phone · save" appeared to work in the APK while the 23 MB the phone had spent an hour pulling stayed locked in IndexedDB where nothing else on the device can reach it. A native `DownloadListener` cannot rescue it either: a `blob:` URL lives in the renderer and can't be handed to Android's `DownloadManager`. So the blob is sliced (512 KiB) across the Capacitor bridge to `ShellSavePlugin`, appended to a staging file, and published into Downloads only once complete — `MediaStore` on API 29+ (no permission, `IS_PENDING` until the last byte), the public directory behind `WRITE_EXTERNAL_STORAGE` (declared `maxSdkVersion="28"`) below it. **The destination is read back and shown**, on the toast and on the row (`savedTo`), because MediaStore renames a collision and "saved" without a *where* is the bug this path exists to fix.

  **Nothing may go quiet, and nothing may stay stuck.** A bad link does not fail, it goes SILENT: a `fetch` against a dead Tailscale path hangs indefinitely, and a hung fetch pins `active` — which stops the queue AND makes the retry button provably do nothing, since `pump()` refuses to start a second transfer. So there are two fuses (no response headers in `HEADERS_TIMEOUT_MS`, no bytes for `STALL_MS` mid-stream, both re-armed per chunk) plus a `watchdog()` for the case the fuses themselves were frozen with the page (Android backgrounding the WebView): on any wake, a "downloading" record that has been quiet for twice the stall window is aborted back into the queue. `start()` also revives records left `downloading` by a killed page — `pump` only ever picks `queued`, so those used to spin forever. `navigator.onLine` gates only the AUTOMATIC path: it is true the whole time a tunnel is dead and false in some WebViews, so a user tap always gets a real attempt (`pump(force, preferId)`), and `TICK_MS` re-tries on a timer because a phone moving between cells fires neither `online` nor `visibilitychange`. The socket coming up (`welcome`) pumps too — that is the best evidence the link is actually back. **Attempts that moved bytes reset the attempt count**, so `MAX_ATTEMPTS` only ever counts attempts that transferred NOTHING: a link handing over 40 KB per try is awful but is finishing the file, and giving up on it is the one thing the queue must not do; only an HTTP verdict the host will never change (403/404/410) fails immediately. `pause()` has its own state — parking it back in `queued` meant the next pump restarted it, so Pause visibly did nothing — and `evictOld` keeps an aged-out download `done` + `evicted` instead of re-queuing it, which is what silently re-downloaded a week-old 24 MB APK. Flushes are 1 MB *or* 1.5 s, so both the resume offset and the on-screen percent move on a slow link.
  **The row states what it knows, always.** It used to read `<repo> · <size>` and nothing else unless bytes were actively arriving — so a queue waiting out a backoff, paused, given up, or held by the auto switch was indistinguishable from a broken button, and "24.0 MB" never revealed that 18 of them were already on the phone. Every row now carries a status sentence (percent + `received of total` + measured rate + ETA while running; `retrying in 12s`; `paused · X kept`; `stopped at 63% · tap to retry`; the error and the try count when there is one), a progress bar whose fill is animated ONLY while bytes are moving (a parked bar and a filling one otherwise render identically), and a `stalled` reading taken off the clock (`lastProgressAt`) rather than a flag. The sheet head sums it (`3 · 41.2 MB of 96.0 MB`), offers `resume all`, and `pulls.whyIdle()` says in words why nothing is moving. A 1 s ticker repaints while anything is in flight or counting down — every one of those numbers is a function of the clock, and the records stop changing exactly when the link is worst.

  **The sheet is two panes, and the rows carry words.** It grew by accretion into three stacked sections — queue, finished, per-repo rules — which is fine at four downloads and unreachable at forty-five: the rules sat under eleven thousand pixels of finished APKs, and the report was *"I cannot find the auto-download settings any more"*. Two subjects, two panes (`files` · `rules`), and the tab you are not on says its own state: `rules · auto off` is why nothing is downloading, readable without opening it. The file count on the other tab is a COUNT ON A CONTROL and opens exactly those rows. The rules pane also took the master switch out of the header and the `save to Downloads` preference out of the queue — a setting belongs with settings, and the header chip was the only global switch in the app living on a title bar.

  **And the row's buttons became a labelled strip under the text.** `.row-wrap` is `align-items: stretch`, so four icon buttons beside a text button that had grown to eight lines drew four full-height grey columns — the same disease the live session row had, fixed the same way (`.row-acts`). Labels, because a package-with-a-plus (*install this build*) beside a package-with-a-tick (*install every future build by itself*) is two glyphs nobody can tell apart and a phone has no hover to ask with: a `title` is invisible there, which is the rule `Unavailable.tsx` exists for. The text lost two duplications at the same time — `· 1m ago` and `created 21 Sept, 11:21` are one instant printed twice a line apart (now one line, and the distance is dropped once it is merely a coarser spelling of the date), and a failed save was stated by `downloadStatus().detail` AND repeated by a warn span underneath it.

  **A save was reported as failed while the file was landing.** `ShellPullPlugin.publish` posts an intent and resolves; the copy into MediaStore happens on the service's worker thread. `saveNative` read the row straight back, found no destination on it, and wrote *"the file was not saved — open Downloads to try again"* — on every finished download, permanently, because a `saveError` is exactly what stops the hand-off from retrying. It now waits for the service's answer (bounded, 8 s), a `done` row's own error is kept as the SAVE's error rather than dropped with the download's (the service's *could not save to Downloads: …* is the only sentence that could say why), and a folder that confirms the file is present RETIRES a stale `saveError` — which is what heals the rows that already carry one.

  **The strip above the launcher (`PullBar`) obeys the same rule as the row.** It said `<running file> · <pct>% · <queue total> left`, so a 215 KB screenshot downloading behind two 24 MB APKs read as `emu-05-dialog.png · 0% · 21.2 MB left` — the size belonged to the queue, the percent to the file, and nothing on the strip said which. The running file now carries its OWN remaining bytes and rate; the rest of the queue is a separate `+N more (X)` clause; and `stalled` comes off `lastProgressAt` here too, because a spinning loader over a stream that has not moved in 12 s is the one reading this strip must never give.
- `installLog.ts` + the Apps sheet's second pane — **what actually installed, on which phone, and when.** The rest of the install feature is a phone's own business; this is the one part that is not, because **there is one desktop and there may be many phones.** A build that installed itself overnight leaves its only trace in the device that did it, so the log lives on the host (`host/installlog.ts`) and this module is how a phone tells it and how a screen reads it back. **The report is a re-statement, not an event** — the install worth logging is the one that happened with the tunnel down, so the whole history goes on every `welcome`, unconditionally, and the host merges on a key the phone can reproduce; nothing is queued and nothing carries an ackId, because the delivery is already idempotent and a queued copy would only repeat what the next handshake says. In between, a re-send is skipped when the payload is byte-identical — the host would swallow it either way; that guard is about the LINK, not correctness. **The phone's own clock or nothing**: `installedAt` comes off `ShellPullService`, and a shell too old to stamp it sends no `at` at all rather than the moment this page happened to notice, which would file an overnight install as having happened at breakfast. Only TERMINAL outcomes are reported (`installReportFrom` in shared, node-tested) — `asked` is the system installer waiting for a person and may never be answered, so logging it would claim an install that has not happened. **The device NAME is the one setting that must not sync**: its entire job is to be different per phone, and a synced copy would have the second device overwrite the first one's name with its own — the same reason `waterplane.deviceId` is off `SYNCED_SETTING_KEYS`. The model is read off the Android UA and yields NOTHING where it cannot be read (Chrome's UA reduction writes `K`), so `deviceLabel` falls to `device a1b2c3`, which is honest, rather than `Mozilla`. Attached from `main.tsx` beside `startLocalRtWatch`, whose structural-source shape it copies: `App.tsx` returns early once per overlay, so a store that must report on every connect cannot live inside it — and this needed no `App.tsx` change at all. The screen is the Apps sheet's `installed` pane: one row per install with the app and version, the package on its own line (three repos here build `app-debug.apk`), and a sentence saying who, when, and whether anybody tapped. Device chips and the per-app install count are FILTERS and say what they are hiding, `n of N` with a clear button.

  **`saveHandedAt` is a third save state, and it exists because the other two could each only lie about it.** The bounded wait for the service's answer ended by writing a `saveError`, which every button in the app reads as *the save failed* — and when the answer arrived a second later, nothing retired it: the row went on offering *save to phone* for a file already in Downloads, which is the MediaStore duplicate the whole path exists to prevent. Now an unanswered hand-off is its own fact, with its own sentence (*handed to Downloads, and the phone has not said where it went*), it stops the automatic pump the way an error did, and the service's own answer — or `verifySaved` — clears it. The wait also stopped calling a full `syncNative` per tick: that patches every row, and a patch persists the whole map and wakes every subscriber, so forty-five rows at three polls a second was a thousand localStorage writes to learn one field, during the moment the phone is busy installing an APK. It reads the service's list and syncs once, when there is news — and bails immediately if the row was deleted while it waited, rather than toasting *it is still on this phone* about a file somebody just removed. The install log's screen gained the same honesty about its own emptiness: the doc is cached with the moment it was told (`localState.ts`'s rule — an empty list is a CLAIM), so a cold start with the tunnel down says the desktop has not told this phone yet instead of *nothing has installed itself*, and the reachability line is subscribed rather than read at render.

- `download.ts` / `downloadState.ts` — **downloading a file, the one way.** There used to be two, and which one a button got decided whether it worked at all. Most screens' *download* was a hidden `<a download href="…&download=1">` click: the browser's own download in a tab, and **silently nothing inside the Capacitor WebView** — no listener, no error, no file (`nativeSave.ts` documents the same hole from the save side). So the most-used button in the app was dead in the shell the app actually ships in; and where it did work, the file landed somewhere the app could not name, resumed nothing when the link dropped, and appeared in no list. Meanwhile the gallery viewer ALONE also offered *to phone* — the resumable queue, under a name nobody reads as "download". Now every download button calls `startDownload()`, which files the ask as a **`local` record in `pull.ts`'s queue**. `local` is a row with three privileges, each earned by a specific failure: it is created **without `pull.add`** (a tap must not need a live WebSocket — the bytes come over plain HTTP — and must not queue the same file on every other phone attached to this host; the route stays for a pinned APK bundle), **`sync()` never deletes it** (it is not the host's to withdraw), and **the pump runs it with the auto-download switch off** — that switch governs unattended work the HOST queued, and gating a tap behind it is how "download" started once and then sat still for ever the first time the link blinked. A host queue entry for a file a local row already covers is **shadowed** rather than doubled. Identity is repo + path + **mtime**, and both halves of that matter: a row created blind (a notification carried no mtime, until this refactor put one on the payload) ADOPTS an mtime the moment anything knows it, or it shadows every future build of that path for ever — but only while its transfer is UNFINISHED, since a finished blind row's bytes are frozen at some unknown moment and calling them this version is the same lie from the other end; and two sides that both know an mtime and disagree are two FILES, matching them being exactly how a tap on this week's build hands over last week's APK under this week's name. **One tap, one file**: `autoSave` on the record plus `installDownloads()` mounted in `main.tsx` (above `App`, because the case the whole feature exists for is a transfer that finished with the app closed) hands the bytes to the phone the moment they land, and `saveNow()` words that outcome ONCE — a tap and the automatic hand-off cannot disagree — while its `saving` set keeps 90 MB from crossing the Capacitor bridge twice and keeps the watcher, which re-runs on every queue repaint, from toasting once per flush. What the phone can honestly claim differs by shell, so the record says WHICH (`saveVia`): `device` is a file MediaStore named back to us, `browser` is an anchor the browser may also have refused without a word — so that row says *handed to* and keeps offering the hand-off. `downloadState.ts` is the pure half, split for `contextPlot.ts`'s reason — it is the part that is easy to get subtly wrong and impossible to notice. `downloadStatus()` gives the phase, the percent (null while nothing has arrived and no transfer is running: "0%" and "no idea yet" are different claims), the label and the sentence; `downloadAction()` says what a tap MEANS (a tap on a running transfer opens Downloads, never a second copy); `needsFetch()` is the one that had the first bug — an EVICTED record is `done` with no bytes, so a "not done ⇒ fetch it" test declined to queue anything while the button toasted "downloading…"; `fileMatch()` is the identity rule above. It also holds the two rules the store's privileges rest on, for the same reason — `syncKeeps()` (what a host reconciliation may withdraw) and `pumpEligible()` (the auto switch governs the host's queue, never a tap) — because `pull.ts` reads localStorage at module scope and cannot be run by `node --test`. Node-tested (`downloadState.test.mjs`), and deliberately NOT in `@waterplane/shared`, whose charter is logic both ends must agree on — the host holds no opinion about a button label. `DownloadButton.tsx` is the control: icon, label and title all out of `downloadStatus`, the tap through `downloadTap`, and its own subscription to that file's record when the caller has none — the gallery viewer, the files sheet, the image viewer and the build sheet all render it, so a fifth screen cannot invent a fifth vocabulary. The sheet is retitled **Downloads** ("Auto-download" named the least interesting thing it does) and its clear-queue drops local rows itself, because the host has never heard of their ids. The regression this is exposed to is the next hand-rolled anchor — `FilesSheet`'s survived the first pass of this very refactor — so it is a lint rule, `local/no-anchor-download`, not a paragraph.

  **Then the folder was never asked.** Saving was write-only: the app pushed the bytes across the bridge, MediaStore renamed the collision, and the row remembered the name it was told. Nothing could say whether the file was still there — so a Downloads sheet of 28 finished files offered a save button beside every one of them, each tap making another `app-debug (5).apk` and spending 90 MB of bridge traffic to do it, and it went on offering the same button after the file was deleted in a file manager. `ShellSavePlugin.find` answers it: name family (`stem (n).ext`, MediaStore's own collision form) plus **exact byte size**, since an APK keeps its name across every build and only the size makes a match mean *these bytes*. Scoped storage limits the query to what this app inserted, which is exactly the set worth asking about. Three consequences: `pull.save()` **asks before writing** and returns `already` instead of making a copy; `verifySaved`/`verifyAllSaved` re-ask when the sheet opens, writing `savedPresent` onto the record; and `downloadStatus` gains the two sentences only the folder can produce — *in Downloads/…* and *it was saved to …, and is not in Downloads any more*. **`savedPresent` undefined is not `false`**: a browser, or an APK whose plugin predates `find`, cannot ask, and there the row says exactly what it said before. A confirmed-present file gets **no save button at all** (`downloadAction` ⇒ `open`), the row's sentence being the thing that says where it is — never a greyed-out one, per `Unavailable.tsx`.

  **And the save button itself was the two-step nobody wanted.** `autoSave` was set by a TAP only, so the files a repo's own rule fetched — the ones that arrive while nobody is watching, which is the whole feature — landed in IndexedDB and waited for a hand. `autoSaveEligible` (node-tested) is now the one rule for what the watcher hands over: a tap promised it, **or** the `save to Downloads: automatic` switch says every finished download goes to the folder. Default on, and `autoSaveOut()` is false in a browser whatever the stored value — a programmatic anchor click the browser cannot tie to a gesture is refused silently, so an automatic one is a download that does not happen. Turning it on saves what already finished while it was off. The de-duplication above is what makes automatic safe: a file already in Downloads is left alone rather than copied beside itself.
- `idb.ts` / `offlineCache.ts` — the **read-side offline caches**, the counterpart to the send queue: the phone could keep typing while the tunnel was down but had nothing to type *against* — transcript, slash list and prompt history all died at the fetch. `idb.ts` is a ~60-line best-effort IndexedDB wrapper (DB `waterplane-cache`; stores `transcripts`, `pty`, `uploads`, `pulls`, `tooldetail`, `screenlog`, `gallery` and `artifacttext` — `uploads` keyed by an outbox ackId rather than a session, holding the bytes of a QUEUED image upload, i.e. the only thing in this DB that cannot be re-fetched from the host; every op resolves null rather than throwing, so private mode degrades instead of breaking). `offlineCache.ts` holds transcripts (IDB, newest 12), the slash list per repo (`waterplane.slashCache`, 20 repos — `SlashSheet` used to wipe to `[]` on a failed fetch) and prompt history (`waterplane.snap.history`) **with `output` stripped**: full outputs are multi-KB × 50 entries × N sessions and would evict the one store that must never be evicted, the send outbox. Backlog state has a snapshot too (`waterplane.snap.backlog`), and `Backlog.tsx` goes read-only while the socket is down — except *add*, which is durable. **`prefetchTranscript()` is what makes the transcript cache exist at all for the session you were actually watching.** The cache used to be written only by `TranscriptView`, i.e. only for sessions someone had already opened in READER view — so the normal case (watch a session in the terminal for an hour, lose the tunnel, open the reader to see what it did) found nothing saved and rendered "loading transcript…" over an empty document. The output had been on the phone the whole time; nobody had written it down. It is now also fetched in the background on attach, on each turn-end **for any session, not only the attached one**, and on reconnect — `since`-conditional (a quiet session is one 404 or 204) and throttled to 90 s (×4 under data saver, which multiplies rather than disables: the cache is for the link being GONE, which is when a metered connection has stopped mattering). Skipped while the reader is mounted, since it is already fetching the same document. A failure un-throttles rather than backing off, because the caller only fires this over a live socket. **`sweepTranscripts()` finishes the job**: reading a session offline is only useful if the one you reach for happens to be cached, and the only sessions that ever were are the ones you had open — a phone went offline holding one document and eleven sessions whose reader said "loading transcript…", and which one you want is exactly what you don't know until the link is already gone. `App.tsx` sweeps the whole list on reconnect and every 5 minutes while VISIBLE (a hidden tab's timers are throttled to minutes anyway, and the two events that matter while backgrounded each prefetch on their own), attached session first then newest — the same order the cache's own eviction keeps, so the sweep never fights the prune. Sequential, never parallel: a dozen concurrent fetches over a tunnel that is already the bottleneck would slow the session actually being read. Affordable only because documents are `lite` — a whole list now costs a fraction of what one busy session's transcript used to. A session that 404s (never produced a log) must not abort the sweep, so each is caught on its own.
- **Service-worker Background Fetch** (`public/sw.js`): the half of auto-download that runs with the app closed. A push carrying a `pull` id starts `backgroundFetch.fetch()` right there in the push handler (best-effort — no support just leaves the item queued for the in-page fallback); `backgroundfetchsuccess` parks the finished response in the `PULLS` cache for `pull.ts` to collect, and refuses to cache a non-2xx (`responseReady` resolves for an error page too, and a cached 12-byte "not found" under an artifact URL would land as the APK). `PULLS` is exempt from the `activate` purge alongside `THUMBS` — these are megabytes someone waited for.
- **Thumbnail bytes on the device** (`thumbCache.ts` + `idb.ts` v8): the service-worker cache below covers the browser PWA and *nothing else* — `main.tsx` deliberately does not register a service worker inside the Android shell (the UI is loaded out of the APK, the daemon is a different origin), which is precisely where an offline grid is the entire point of the app existing. In the APK every thumbnail was therefore a live request, and an offline gallery was file names over grey boxes: the one screen whose job is "show me the picture" was the one screen with no pictures. So the page caches them too, in IndexedDB, which behaves identically in both. Same soundness rule as the worker's: the key is the **mtime-versioned** URL (`&thumb=<w>&v=<mtime>`), so a regenerated file at the same path is a different key and yesterday's screenshot can never appear under today's name. Two stores because eviction ranks by age and sums bytes — doing that over the blob store would mean reading 400 thumbnails out of the DB to decide which to drop: `thumbs` holds the blob, `thumbmeta` the `{savedAt, bytes}` record. Ceilings are entry count (400) AND total bytes (24 MB), plus a per-entry 512 KB refusal for the same reason the worker has one — `thumbs.ts` returns null (⇒ the ORIGINAL) whenever it has no converter, so a multi-MB file can come back from a thumbnail URL. Reads are **cache-first**: `useThumbSrc()` (in `thumbSrc.ts`, one implementation shared by the grid, the poster frame and the reader's inline thumbnails) resolves the stored blob before the `<img>` is pointed anywhere, so offline paints with no request that could only fail, and an online tile is never loaded twice (network, then swapped for the stored copy — two decodes and a visible flash). Writes ride the load that already happened (`onLoad` ⇒ `cacheThumb`, `cache: "force-cache"` against an `immutable` response, so it is a local read rather than a second trip over Tailscale). Lazy loading stays, which alone would remember only what happened to scroll past the viewport — so a live listing additionally warms its first `THUMB_WARM` (24) rows, i.e. a screenful, whether or not they were drawn. The warm is skipped when the rows came from the offline cache or the listing failed: two dozen requests at a tunnel already known to be down warm nothing.
- `transportIndex.ts` — one listing of a repo's inbox + outbox, read while the reader is on screen, so the renderer can answer "does this bare filename exist?" synchronously. Deliberately **not cached to disk**, unlike every other listing here: nothing in it is ever shown to a person, so the argument that wins everywhere else (a stale list labelled stale beats an empty screen) does not apply — a week-old listing would instead turn a name into a thumbnail of a file that is gone. Offline it resolves nothing, and a code span stays a code span.

- **Path-only pictures** (`fileMtime.ts` + the host's `?stat=1`): a thumbnail is only cacheable if its URL is versioned, and the gallery is the only screen that gets an mtime for free (its rows carry one). Everything else that shows the same file knows a PATH and nothing more — a file mentioned in a transcript (`fileRefs.ts`), the image a backlog item references, the viewer opened from either — so those asked for `?thumb=<w>` with no `v`, which no cache here may keep. `fileMtime.ts` is the missing half: a small path→mtime map, learned from every source that already knows one (a gallery/search listing that landed, live or cached; the receipt of an upload the host just wrote — the moment the phone can know the mtime of the screenshot it is about to name in a prompt), and otherwise from a one-off `GET …/artifact?path=…&stat=1`, at most once per path per page. With one in hand the reader builds the SAME URL the gallery builds, so the two share a single cache entry and a picture the grid warmed paints in the reader with no request at all. localStorage rather than IndexedDB on purpose: the value has to be readable SYNCHRONOUSLY inside the render that builds the `<img>` src, or the image loads un-versioned first and gets swapped a moment later (two decodes and a flash). Nothing here is a source of truth — a stale mtime costs one wasted request and the next listing corrects it, a missing one costs exactly the old un-versioned behaviour. `stat=1` is read-only and gated exactly like the byte path (same containment guard, same viewability list, no `.env`), pinned by `e2e-thumbs.mjs`.
- **Service-worker thumbnail cache** (`public/sw.js`): versioned thumbnail GETs (`thumb` + `v`, no `download`) are cache-first out of a SEPARATE `waterplane-thumbs-v1` cache, so a re-opened gallery costs zero bytes and an offline gallery still paints. **`v` decides HOW, not WHETHER**: an un-versioned thumb URL is served **network-first** out of the same cache — online the host always wins (a file replaced at the same path can never be answered from yesterday), and the stored copy answers only when the network could not answer at all. Before that split, un-versioned thumbnails were cached by nobody, which made them network-ONLY, which made every picture the reader and the backlog draw a broken image offline — intermittently, because the browser's own HTTP cache (`max-age=86400`) covered them until the entry aged out or was evicted. A 404 is still an answer and is passed through rather than papered over with a stale copy. Two things are load-bearing: the activate purge is `n !== SHELL && n !== THUMBS` (the old `n !== SHELL` would wipe every downloaded thumbnail on each deploy), and a response is only stored when it is a small (<512 KB) `image/*` — a null-thumb fallback serves the multi-MB ORIGINAL under a thumbnail URL, which is exactly the bytes the cache exists to avoid. `download=1` and everything else under `/api` still bypass the worker; `/ws` is never intercepted. `Gallery.tsx` and `ZoomableImage.tsx` render an `ImageOff` placeholder on a failed load (flag keyed by src, so it cannot loop) — a broken `<img>` on a dark stage was another black rectangle.
- the in-flight reading (was `netstate.ts`) / `NetActivity.tsx` — **"is my tap doing anything?"**, the one indicator that is never forgotten. Every HTTP call routed through `api.ts`'s `nfetch` wrapper (which is `jget`/`jpost` and the hand-written DELETE/POST calls) registers as in-flight; `NetActivity` renders a fixed strip at the top of the viewport in three stages — nothing under 400 ms (a bar that flashes on every fast request is worse than none), a 2 px indeterminate bar after that, and past 2 s a chip naming the OLDEST in-flight request plus its elapsed seconds, turning amber past 12 s. The elapsed count is the load-bearing part: on a DERP-relayed path a plain GET takes ten seconds during which the screen used to be completely unchanged, which is indistinguishable from a dead button — and a spinner with no clock cannot answer "is this stuck?" either. Deliberately counted at the `api.ts` chokepoint rather than per call site, so a component that forgot its own busy state still gets an answer. **Background polls must NOT register** (they call `fetch` directly — `api.transcript`, `markInboxSeen`, the usage flush): a bar blinking every 6 s on an idle screen is the noise that hides a real one. `labelForUrl` maps a path to the words. Rendered in BOTH of `App.tsx`'s top-level returns (launcher and terminal), `pointer-events: none` so it can never eat a tap.
- the log reading (was `netlog.ts`) / `NetHealthSheet.tsx` — the phone's half of the same telemetry, and the sheet that reads both halves (Settings → Tools → connection health). The host cannot observe anything that decides whether the app FEELS broken, because it all happens on this side: round trip (timed off the ws heartbeat's ping/pong, which was already being sent for liveness and never measured), how much of the window had no socket at all, how often the watchdog gave up and hard-reloaded the page, and how long a message actually sat in the queue before it was confirmed. Two properties are load-bearing. It is a **window, not a log** — events aggregate on the spot into counters plus two bounded sample arrays, because localStorage is shared with the send outbox, the one store that must never be evicted, and a telemetry buffer that grew with usage would eventually cost a prompt: the exact failure it exists to measure. And it **survives a reload**, because the reload IS a data point (`noteReload` writes through synchronously, since a debounced write would not survive the navigation it describes) — a counter living only in memory would reset itself precisely when the link is at its worst and report a perfect score. Roll-ups POST to `/api/netstats` on a minute timer and via `sendBeacon` on hide, deliberately with raw `fetch` rather than the `api.ts` helpers so a background flush never blinks the `NetActivity` bar. `rttP95()` is also what sizes the op receipt window in `core/queue/send.ts` (`ackWindow`) — a fixed 20 s is wrong in both directions on a real phone. The sheet leads with a **verdict sentence**, because "prompts go missing sometimes" has four different causes and the counters below separate them: text never leaving the phone, receipts not coming back, deliveries the host could not confirm, or the app being reloaded out from under the queue.
- the pulse reading (was `netpulse.ts`) / `NetPulseBar.tsx` — **the permanent connection strip** (Settings → Tools → connection strip; `waterplane.netPulse`, off by default). The three readouts above it are all retrospective: the connection banner appears once the socket is already gone, `NetActivity` once a request is already slow, `NetHealthSheet` only when you go and open it. None of them answers the question actually asked on a bad tunnel — *"is it bad right now, or is the app just being slow?"* — and that question is asked from whatever screen you happen to be looking at. So: a 22 px bar fixed to the top of the viewport, above every sheet and overlay, with a state dot, the last ~30 probes drawn as a sparkline, and the current round trip in ms. Four decisions are load-bearing.
  **A graph, not a number.** A mean cannot tell a steady 250 ms apart from 30 ms with every fourth ping lost, and those two links feel nothing alike — the second is the one where a prompt appears to vanish. Unanswered probes are therefore drawn as full-height red marks and the line is BROKEN across them (bridging one would draw a line straight through the event the graph exists to show); a lone answered probe between two misses is drawn as a point so it isn't silently dropped. Offline stretches sample as misses too, because "there was no socket to ask over" is the same finding from the user's side.
  **It observes and never steers.** `ws.ts` gained `probe(timeoutMs)`, which times one ping→pong and resolves `null` on timeout — and does nothing else: no reconnect, no zombie verdict, no touching `awaitingPong`. `ws.ts` still owns when a socket is dead. A diagnostic that could tear down the socket it is measuring would make a slow-but-working path start dropping *under observation*, which is the one failure mode a readout must not have. (A pong carries no id, so the first pong back after a probe settles it even if it was really the heartbeat's — both are round trips over the same socket moments apart, and a correlation id would be a wire change for a graph.)
  **Its samples do NOT feed the `log` reservoir.** Same measurement, tempting to share — but `netlog.rttP95()` sizes the send queue's receipt deadlines, so probing every 3 s rather than every 12 s would silently change how long a prompt waits before being retried, as a side effect of a bar being switched on. A readout must not move the machinery.
  **Screens make room rather than being covered.** The bar publishes its height as `--ui-pulse-h` on `<html>` and `.screen` / `.sheet` add it to their top padding (0 when off). Every screen in the app is one of those two, so a sheet written next year is clear of the strip without knowing it exists — and the strip never hides a sheet's own header, which would have traded one blind spot for another. `NetActivity` is offset by the same variable. Mounted in `main.tsx` beside `App` (not inside it) for the same reason `HintLayer` is: `App` returns early from a dozen places, one per sheet. It asks for the health sheet by dispatching `app:open-nethealth`, the same arrangement `requestHostSetup()` uses.
  Probes run only while the page is visible — a backgrounded phone must not spend its radio on a graph nobody is looking at — so the window is "the last N pings", never a time axis, and the strip does not pretend otherwise. Per-device, not synced: switching it on spends *this* phone's radio and *this* phone's 22 px, which is exactly the trade a phone on a bad tunnel wants and a desktop on the LAN does not (`shared/settings.ts` records the reasoning).
- **Every reading on the strip is a tap target, and each opens its own section** (`NetPulseBar` segments → `app:open-nethealth` with a `focus` → `NetHealthSheet` scrolls to that section and flashes it once). The strip now carries four separate facts in 22 px — round trip, unanswered pings, how current the screen is, how much data has moved — and at that size each can only be a shape and a number. "54 lost" and "2.0 MB" both provoke *of what?*, and the old behaviour answered by opening a five-section sheet at the top and leaving the reader to hunt. Segments also carry their own `data-hint` (`net.pulse.graph` / `.loss` / `.when` / `.data`), so a long press explains that one reading rather than the strip as a whole; the strip keeps `net.pulse` for itself. The focus is deliberately NOT part of the route — it is where to look on open, not a screen, and restoring it from a URL would re-flash a section nobody tapped. The dot, graph and ms are ONE target: three neighbouring ones at 22 px are not separable by a thumb. Each segment gets vertical padding with a negative margin so the touch slop exceeds the 11 px of text without changing the strip's height. `NetHealthSheet` grew a **Link right now** section to be the destination for the first two — last and median ping, how many probes the window holds, how many went unanswered — since those numbers previously existed only as a drawing.
- the traffic reading (was `nettraffic.ts`) — **volume, the other half of what a link is doing.** The strip above answers *how good*; nothing answered *how much*, and the two are not substitutes: a 227 ms ping reads identically on an idle socket and on one saturated by a 20 MB APK download, and the second is why the tap after it felt dead. On a metered SIM it is also the only number anyone wants. So the right end of the same 22 px strip carries a down group and an up group — an arrow, the current rate, the running total — and `NetHealthSheet` repeats them with the caveats spelled out.
  **Rates appear only while bytes move; totals always stand.** A permanent "0 kB/s" is a number that cannot say *nothing is happening*, so anything under 1 kB/s draws no rate at all and the arrow goes dim — the absence IS the reading. The totals are the opposite kind of fact: they are what you go looking for, so they survive a reload (localStorage, debounced, flushed on `pagehide`). That matters more than it sounds — the `ws.ts` watchdog hard-reloads the page precisely when the link is at its worst, so an in-memory counter would zero itself at the moment its number was most interesting.
  **Instrumented by patching the transports, not by asking call sites.** Same argument as `hostUrl`, `settings` and `hints`: a helper everyone must remember to call is wrong within a month, and here the failure is invisible — an under-count looks exactly like a quiet link. `installLinkMeters()` runs in `main.tsx` **after** `installHostRouting()` (it delegates to whatever `fetch` it found, so ordering it second keeps the host rewrite) and wraps `fetch` + `XMLHttpRequest`; socket frames are counted in `ws.ts`, where every outbound frame now goes through one `wire()` helper and every inbound one is counted BEFORE it is parsed (a frame we cannot decode still crossed the tunnel).
  **What the browser fetches on our behalf needs Resource Timing.** Thumbnails are most of what this app actually downloads and not one of them is a `fetch` — the grid points an `<img>` at a versioned URL and the browser does the rest. A `PerformanceObserver({type:"resource", buffered:true})` picks those up, skipping `fetch`/`xmlhttprequest`/`beacon` entries so nothing is counted twice, and uses `transferSize` — which means a thumb served out of `thumbCache` costs zero, correctly. The catch: a cross-origin response reports zero bytes unless the server opts in, and in the Android shell EVERY image is cross-origin, so `host/origin.ts` now reflects a `timing-allow-origin` beside its CORS headers (the reflected origin, never `*` — the caller that already passed the gate, nobody else).
  **The numbers are stated, not implied**, because a data figure that is quietly wrong is worse than none: requests are counted from `content-length` (so gzip is already subtracted — real wire bytes; the host sets it on every response path and exposes it through CORS), page loads from what came off the network, socket frames from the JSON payload BEFORE permessage-deflate (so a chatty PTY is over-stated), and none of it includes headers, TLS, or the Background Fetch download path the service worker runs outside the page. The health sheet prints exactly that.
  Counting has to be free: a busy session is thousands of PTY frames a minute, so `noteTraffic()` is an integer add into one of ten half-second buckets, the rate is a sum over that ring, and subscribers hear about it once a second — from a ticker that only exists while something is drawing it. String frames are measured with `.length` rather than a `TextEncoder` (JSON and base64 are ASCII, so it is exact where it matters, and an allocation per frame is not worth being right about the occasional é).
- the sync reading (was `netsync.ts`) — **the age of what is on the screen.** This app is built to keep rendering when the host is unreachable — snapshots of the session list, cached repo listings, cached gallery pages, a locally rebuilt scrollback — and every one of those design decisions is right. Their shared cost is that a screen from fifteen minutes ago is pixel-identical to a screen from a second ago, so the strip's middle slot (empty until now) says which it is.
  **Two facts, deliberately not merged.** *Last connected* is the newest frame the host actually sent — `ws.ts` already treats any inbound frame as proof of life, so `noteHostSeen()` stamps the same event — and explicitly NOT `readyState === OPEN`, which survives a tunnel that has already died and would let the strip claim a live link on a dead one. *Last full sync* is when the two halves the main screen is built from were both refreshed **on the current connection**: `session.list` (pushed over the socket after `hello`) and `api.repos()` (a separate HTTP call, which can fail or hang on its own while the socket is healthy). The time reported is the **older** of the two — taking the newer would let a fresh session list paper over a repo listing that has been stale for an hour. Adding a third screen-defining fetch to `SyncPart` automatically makes the claim wait for it, which is the intent: it is a statement about the whole screen, not about whichever call answered last.
  A part that landed BEFORE the current socket came up does not count, so a reconnect honestly reads `syncing sessions+repos…` for the second it takes — and if one half never comes back, the strip names the half rather than spinning forever. Offline, `syncSnapshot().syncedAt` is null (nothing is current, correctly) while `lastSyncEver()` still answers the question actually being asked, which is what the health sheet shows.
  Persisted like `netlog`, for the same reason: the `ws.ts` watchdog hard-reloads the page exactly when the link is at its worst, and a "last connected" that reset to *just now* on that reload would be a lie told at the only moment anybody reads it. Written through immediately on disconnect; while connected the stamp is a variable assignment with the localStorage write rationed to once per 10 s, because it fires on every inbound PTY frame.
- `giveups.ts` — **deleted.** It was a named ledger of the sends that gave up, built because a count
  of dead prompts pointed at nothing. A `failed` queue row is now kept in full and triaged in Activity;
  why, and how the old ledger is migrated once, is under *`giveups.ts`, deleted* and *The queue stopped
  owning the work (stage 6)* below. What still holds of that round is the counter and the host side:
  **The number was wrong in both directions.** `me.failed + me.expired`: `noteSendExpired()` runs in the expiry sweep and then `failOutbox()` runs `noteSendFailed()` on the very same entry, so every aged-out send was counted twice — `expired` is a BREAKDOWN of `failed`, not a second population. Meanwhile four other paths flip a row to `failed` without any counter at all: the cascade that fails prompts queued behind a create that never opened, a prompt whose upload died (`failDependentUploads`), a cap eviction, and an orphaned chain step at boot. Over-counting the loud case and under-counting four quiet ones is the worst of both: the headline is inflated and the interesting failures are invisible.
  **And the rows should mostly stop appearing.** Nearly every give-up in the screenshot that prompted this said `session not available` or `queued too long`, which are the same failure told twice: a session exits, `goneLanes` blocks every prompt queued for it, nothing ever un-blocks them, and the TTL expires the lot half an hour later. The HOST closes it: given a `cwd`, a stranded prompt is sent, and `deliverInput` writes the words to that repo's work items and answers `rescued` (the client-side `rescuableEntries` that used to do this on a 45-second phone-clock grace is deleted — and was in fact unreachable, since the queue blocked the message before it could be sent). This section is the last resort behind that, not the mechanism.
  **"35 lost".** The connection strip's loss reading sat one line above the red give-up sentence, and *lost* did the work of both: a count of lost PINGS reads as a count of lost prompts, which is the one thing it never means. Now "35 pings lost", with the hint and the tooltip saying so outright. Cheap fix, and it was the half of the screenshot that had nothing wrong with the code.
- `usage.ts` — client half of the feature-usage tracking. `track("toolbar:diff")` at every feature entry point: bumps a localStorage counter IMMEDIATELY (so "sort by most used" is instant and works offline) and queues a delta flushed to the host every 20 s, plus on hide/pagehide via `sendBeacon` (a phone is backgrounded, not closed). Failed flushes requeue; nothing here can surface an error. `knownFeatureIds` in `features/tools/logic.ts` is the catalog of every id `track()` can emit — keep it in sync when adding a call, because it's what lets the viewer list features with ZERO uses (the delete list).
- `UsageSheet.tsx` — Settings → Tools → **feature usage**: the host-side aggregate, most-used first, then a "never used" section, with a **copy report** button that yields markdown to paste into a coding agent, and a two-tap reset.
- **Live-session row order** (`core/launcher/useLauncherModel.ts`, over `model.ts`): strictly `createdAt` ascending — oldest on top, new sessions append at the bottom. Status/starred/repo NEVER enter the sort key: the old attention-priority ordering (waiting → coding → done, grouped per repo) reshuffled the overview whenever a session flipped state, which is disorienting and causes mis-taps. A per-device manual override (`waterplane.sessionOrder` in localStorage, list of session ids) is applied on top: **press and hold a row ~400 ms, then drag** (`armRowDrag` → `dragSid` → window-level pointermove + non-passive `touchmove` preventDefault so the list doesn't scroll under the finger; `dragRef` swallows the click a drag ends with, so a plain tap still opens the session). Ids unknown to the stored order fall back to createdAt at the end; "reset order" in the section head clears it. **A final pass keeps same-repo rows contiguous** (repo positioned by its oldest session, still status-free): the list renders one repo group header per run of same-repo rows and a row's own title is only its branch, so an interleaved order emitted the SAME header repeatedly — visibly a list of duplicated `usmc (18)` / `garmin-monorepo (10)` rows, especially with groups collapsed (header stands in for the hidden rows). Dragging is therefore confined to within a repo group. **A collapsed group still shows attention — and now the whole status roll-up:** `attentionByRepo` buckets every row of the group into `limit` / `wait` / `coding` / `done` / `exited`, using the SAME precedence as `statusTags` and mutually exclusively, so the header's chips always sum to its row count and can never disagree with the badges of the rows it hides. Only `waiting` pulses (it is the one that wants you); the rest are quiet coloured counts, and a zero bucket renders nothing. `waiting` and `coding` totals are repeated in the "Live sessions" section head. The header's toggle half `flex-wrap`s: name + count + worktrees + five status chips does not fit next to the action buttons on a phone, and wrapping to a second row beats ellipsizing the repo name away — the counts are the entire point of a collapsed group.
- **Toolbar order modes** (`features/toolbarCfg/store.ts`): the customize sheet toggles `manual` (drag/arrows, `ToolbarCfg.order`) vs `used` (auto, most-used-first from the local counters). The used-order is SNAPSHOTTED into `usedOrder` state — on mount, on session switch, on turning the mode on, and once a minute — never live per tap, so buttons can't move out from under a finger mid-tap.


## `storage.ts` — the key registry

Sixty-seven `localStorage` keys as string literals across thirty files. That was fine right up until
three questions stopped being answerable by reading any one file.

**Does this key sync?** `shared/settings.ts` holds the allow-list and `settings.ts` patches `setItem`
to honour it, so a key written anywhere is synced correctly the day it is written — but nothing at
the WRITE site says which way it went, and the reasoning for why each key is or is not on the list
lived somewhere else again. The registry groups keys by what they describe (authored content,
device identity, properties of the LINK, work in flight, caches, this browser's own banner history),
which is the same grouping that decides whether a key may sync at all. `SYNCED` is checked against
the shared allow-list at module load, so the two cannot drift silently.

**Does this key still exist?** A renamed key leaves the old literal behind in the one file nobody
grepped, and the symptom is a preference that quietly reverts. A constant that no longer exists is a
type error.

**What shape is it?** Nearly every read was the same six tokens — `try { JSON.parse(getItem(k) ?? fb) }
catch { fb }` — copied about forty times, each with its own idea of what an empty value is. `lsJson`
takes the fallback as an argument instead, and treats a stored `null` as absent, which several of the
copies did and several did not.

The helpers are thin on purpose. This is a REGISTRY, not a wrapper you must remember to use: the
cross-cutting rules that actually matter (the sync, the timestamp) still live in `settings.ts`'s
`setItem` patch, for the reason that file states at length. `tools/eslint/rules.js` refuses a new
`waterplane.*` literal outside `storage.ts`, which is what keeps the registry from becoming a list that
some keys are on.

## `Sheet.tsx` — the frame, written once

Thirty-three files were hand-rolling `div.sheet` → `div.sheet-head` → a back button holding a
`ChevronLeft` → `span.brand`. Forty-six copies, because several sheets have more than one head.

Repetition is the small half. The real cost is that this is the CLOSE affordance on a full-screen
overlay, i.e. the only way out on a phone, reimplemented thirty-three times — and that
`.sheet-head`'s CSS carries three separate comments about buttons pushed off the right edge, all
written against markup that was copied rather than shared. A layout rule learned once could not
propagate.

`SheetHead` is the head alone, and it is what the existing sheets adopted: several have a second head
(`FilesSheet`'s file view, `GitView`'s diff), their own scroll container, or a footer that is not
`.sheet-actions`, so rewriting thirty-three render trees to fit one frame would have been a much
larger change for the same benefit. `Sheet` — the full frame, for anything new — is built from
`SheetHead`, so the two cannot drift. Layout still lives in `styles.css`; this owns structure only.

Migrating turned up two heads that had quietly diverged: `NetHealthSheet` used `className="key"` for
its back button and an `<h2>` for its title, and App's model picker used a text `‹` instead of the
icon. Both now match everything else, which is the sort of thing forty-six copies guarantee and one
component makes impossible.

## `useRemoteResource.ts` — one host read, told honestly

Twenty-six sheets had written the same five pieces of state (`loading`, `err`, the rows, the cached
copy, when the cached copy was taken) and the same effect around them — twenty-six slightly different
answers to the question this whole app is about: what do you show when the tunnel is down?

The rule stated in several places here — "cached rows always say how old they are", "with the socket
down, status is labelled *last known*" — is exactly the kind that survives being written once and
rots when it is written twenty-six times. A sheet forgetting the age label is not a crash. It is a
screen quietly claiming to be current, which is worse, and it is invisible in review because the
sheet looks finished.

So the cache is seeded FIRST (paint immediately, offline or not), the live read replaces it, and
`state` never lets the two be confused: `fresh` / `cached` (with `age`, which is not optional) /
`loading` / `error` / `offline`. `error` and `offline` are deliberately separate — "the host refused
this" and "the host was not reachable" lead to different next actions, and collapsing them is how a
permissions problem gets read as a bad tunnel for a week. On a failure the cached data STAYS: it is
still true about the moment it was taken, and it is the only thing on screen. Only the label moves.

`offline` is also an INPUT, because the link signal this app trusts is the SOCKET: `navigator.onLine`
stays true while the Tailscale path is dead, which is the exact failure every offline path here
exists for. A caller that already knows the socket is down passes it, and the cache is served without
spending a request that can only time out — which is what `FilesSheet` was doing by hand.

`key` is also what a late response is matched against, so a slow answer for a repo you have navigated
away from is dropped rather than painted over the new one.

`inflight` is a SIXTH fact and not a sixth state, because it answers a different question: `loading`
means *nothing to show yet*, `inflight` means *a read is out right now*. They came apart the moment a
refresh button wanted to say it was working. `loading` is set only by the first read and by a
NON-quiet `reload` — and every refresh button in this app re-reads quietly, or by moving the key,
because blanking a document somebody is looking at to prove a request went out is worse than the
wait. So `state === "loading"` is false from the first paint onward, and the two token screens spent
a release keying a `disabled` attribute on it and then a spinner, neither of which ever fired. It is
COUNTED rather than a boolean (a key change starts the next read before the cancelled one has
unwound, and a flag would be cleared by the loser) and decremented in a `finally` even for an answer
that is no longer wanted — the request really has finished, and a stranded count is a spinner that
never stops. **A button that cannot tell whether it is running is the same defect whether it spends
that on a spinner or on a grey.**


### What actually adopted it, and what did not

The hook shipped and then sat there: two importers (`FilesSheet`, `UsageSheet`) and two exported
wording helpers (`stalenessNote`, `agoText`) with no call sites at all. A shared rule nobody imports
is a comment.

Now on it: `SlashSheet` (a per-repo palette cache that never said how old it was, and a `.catch` that
rendered a refusal identically to a dead tunnel), `GitView` (both reads were
`.catch(() => setX(null))` — a repo the daemon refused and an unreachable host both painted an empty
list under a header that still said "Review"), `SecretSheet` (two `.catch(() => {})`, on the one
sheet where an empty target dropdown means typing a credential at a path that may not exist),
`SetupSheet` (a checklist that could not be READ is not a repo with no problems — and its `error`
now only ever means the READ failed, because a failed FIX has its own state), and `ArchiveSheet`
(where "No conversations here yet" was being said about repos holding hundreds).

Paging stays hand-rolled beside the hook in `ArchiveSheet`, deliberately. "What is in this archive"
is a read that can be stale, refused or unreachable; "give me the next thirty" is an append that only
happens with the link up and a page already on screen. Folding the append in would let every "load
more" blank the list it is extending.

Four sheets are deliberately NOT on it, and the reason is the same in each: **there is no promise to
wrap.** `ScheduleSheet`, `BuildSheet`, `HistorySheet` and `Backlog` render props pushed over the
SOCKET — App holds the state, the host publishes it, and there is no fetch to have five states about.
`SearchSheet` is the same shape and got the honest half by hand: with the link down its request never
leaves, so it used to sit on "Searching…" for ever, and it now says which nothing that is.
`Gallery` and `PullSheet` have real reasons of their own — a gallery listing is keyed by COVERAGE so
one can be re-filtered into another (`shared/gallery.ts`), which is a cache contract the hook's
single `key` cannot express, and a pull row's state is a TRANSFER (bytes, offset, attempts), not a
read.

The eight hand-rolled `ago()` implementations are down to one (`format.ts`). They differed in whether
they rounded or floored and in where they stopped counting, which breaks nothing and is exactly why
they stayed: two screens showing one instant as "59m ago" and "1h ago" read as two instants, and no
test can notice.


## `SearchSheet.tsx` — three stores, because "what did I ask for" is its own question

The sheet shipped with two: `recent output` (the rendered terminal text) and `full history` (the
persisted prompt AND output of every recorded turn), with `recent` as the default. Neither answers
the question the cross-session search is most often opened for — *where did I say that* — and the
one that comes closest answers it by burying it. A turn's output is hundreds of lines the CLI wrote;
a word that appears in both a prompt and the reply to it ("test", a filename, a branch name) matches
the output dozens of times over the single line somebody typed, and the forty-hit cap is spent on
the CLI's own words before a prompt is reached.

So there is a third scope, `prompts`, and it is the DEFAULT on the all-sessions search. It scans the
recorded `text` of every history entry and nothing else — prompt, slash command and filed backlog
item alike, since all three were sent INTO the session by a person, and each hit still carries its
turn label so the snippet says which kind it was. It is `scanPrompts` in host `sessionSearch.ts`,
deliberately not `scanHistory` with a flag: the two answer different questions, and the difference
is the whole feature.

**The default is keyed on the surface, not set once.** Opened from the terminal toolbar over one
session this sheet IS the CLI's find — the question there is about what is on the screen — so a
scoped search still opens on `recent`. Across sessions the words being looked for are the user's
own, so it opens on `prompts`.

Additive on the wire (`SessionSearchScope`, `PROTOCOL_VERSION` stays 1): the host branches three
ways and an unknown scope still falls through to `history`, which is what shipped.

## `RepoPicker.tsx` — which repo, asked once

Seven sheets asked "which repo?" and seven answered it differently. That is not a bug on its own;
what it cost is the two rules only some of them knew.

**A note that already knows its repo says so.** A retired send carries the `cwd` its words were
written against, and every picker was still listing eleven repos alphabetically to a note that had
already answered. `PadSheet` fixed that for itself and nothing inherited it. `home` now sorts that
repo first and labels the row with WHY it is first — and never preselects it, because a note may
legitimately be re-aimed and a picker that acts on its own is worse than one that guesses.

**A worktree is a repo you can pick, and usually not the one you mean.** `FanoutSheet` and
`ScheduleSheet` each implemented that filter separately, with different wording and different
buttons. One implementation now, with the part that is easy to lose: a worktree already SELECTED
stays visible and counted while the list is filtered to primaries, because hiding a row must never
silently drop it from a run.

Two exports, on purpose. `RepoPicker` is the row list (single or multi) — what a sheet uses when
picking the repo IS the screen. `RepoSelect` is the same rules in a `<select>`, for a form where the
repo is one field among several and a thirty-row list would push the rest off the phone. Sharing the
rules and not the markup is the point: neither is forced into the other's shape, and they cannot
drift.

`PromptComposer` grew the matching `inline` mode for the same reason. "A prompt box has one right
height: whatever the sheet is not using" holds only where the sheet has nothing else to give it —
inside a queue row being rewritten or a backlog item being edited, a `flex: 1` box with an 8.5em
floor either eats the fields under it or, with no flex parent to fill, silently becomes a fixed
8.5em box anyway. Inline takes `rows` and shares everything else. The genuinely different textareas
— a commit message, a secret, a file body, a shell command, and the backlog's search-and-add combo
box with its mic and clear button inside it — are left alone: they are not prompts.


### A spinner waits for the CACHE, never for the host

Reported from the phone: read a transcript on a working link, lose the tunnel, reopen the same
screen — **"loading transcript…" on a black screen**, while the reader's own status line correctly
said *last known* and the activity strip counted "loading repos · 5s" upward. The honesty layer
worked and the data layer did not: the bytes were on the device the whole time.

The mechanism is one line. `load(false)` sets `loading` SYNCHRONOUSLY and the IndexedDB seed is
async, so between them the render `loading && !doc` wins — and it keeps winning for as long as the
fetch takes, which on a dead Tailscale path is the full `TRANSCRIPT_TIMEOUT_MS` fuse (12 s) rather
than a refusal. Twelve seconds of black screen over a document one IndexedDB read away, and the
`netfuse.ts` header describes that exact symptom as the reason the fuse exists.

So the spinner now waits for the CACHE: a `probing` flag is true until the IndexedDB read answers,
and `loading transcript…` may only render once we *know* there is nothing saved for this session.
The cache read is also started before the fetch rather than beside it. `OutlineSheet` had the same
shape and got the same flag.

Two facts were also being conflated in the cached-copy chip. `doc.updatedAt` is when the
CONVERSATION last moved; a session that went quiet at 14:00 and was cached at 18:00 read as "as of
14:00", which says nothing about how out of date the copy is. `getTranscriptAt` returns the entry's
`savedAt` alongside the document, and the chip now says both — and it is raised by the SEED as well
as by a failure, because painting a saved copy silently for twelve seconds is the same lie in a
smaller window.

The repo listing is the other half of that screenshot. It was already snapshot-seeded, so the rows
were never wrong — they just never said they were a memory, and `refreshRepos`'s
`.catch(() => {})` meant a listing the host had stopped confirming looked identical to one confirmed
this second. `saveReposSnap` writes the time beside the list (the rule `saveSessionsSnap` already
followed), and past `REPOS_STALE_MS` the section head says "as of 12 min ago, the host hasn't
answered since" instead of the tap hint. A spinner counting upward tells you the app has given up
without admitting it; an age is the same fact in a form you can act on.

`BranchPicker` was the worst of the audited ones and not a spinner at all: `catch(() => setBranches([]))`
rendered **"No local branches"** — a sentence about the repo — for an unreachable host. It is on
`useRemoteResource` now, like `GitView`'s two reads.

The rule this leaves, and the one to hold in review: **cache-first is not optional on this device.**
The APK ships the shell precisely so that nothing has to be on the network to paint; a reader that
needs the network to show bytes already on the phone defeats the whole arrangement. Every read that
can hang goes through `api.ts`, which means through `netfuse.ts`, which means it trips to `offline`
(never `error`) within a bounded time — and a pending read must never be what keeps a component in
`loading` when there is a cached answer.


## No tap may be silent

`ws.ts`'s `send()` RAM-queues whatever it cannot deliver, invisibly, and the reconnect watchdog's
page reload throws that buffer away. So a bare socket write in a tap handler is a button that
sometimes does nothing and never admits it. The report that started this rework was three sentences
long and all three were about that: *"no button that I press does anything"*, *"pressing the buttons
does nothing"*, *"this shit does nothing"*.

The rule this repo already stated in prose — `sendInput`'s own comment explains precisely why an
answer must not go back through it — was obeyed wherever somebody had happened to read that
paragraph, and 52 tap handlers had not.

Two helpers in `core/conn/useConnection.ts`, because these frames are deliberately NOT durable ops: a "switch that
schedule off", a "cancel this build", a "delete that log" delivered an hour late is a decision about
a situation that has already resolved itself, which is why they are not in the ackId ledger. The
answer for them is not durability, it is a RECEIPT.

- `liveSend(frame, done, blocked?)` — refuse with a reason while the socket is down, confirm when it
  is up. Every tap ends in a sentence.
- `liveAsk(frame, blocked?)` — the same guard for a READ. The screen filling in is the receipt, so a
  confirmation toast there would be noise; what a read still needs is the other half, because a
  question that could not be asked looks identical to a list that is simply empty.

Seven taps got real fixes rather than a receipt bolted on. The largest is `SlashSheet`'s **run**,
which was the only prompt-runner in the app outside the outbox: text, Return and a `session.record`
as three bare writes, so on a dead tunnel the palette closed, the command never ran, and the history
never showed it. It is the same act as typing `/cost` in the compose box and now takes the same path
(`submitInput` — durable, ackId'd, echo-checked host-side, recorded by the host rather than by a
second frame that could arrive without the first).

`tools/eslint/rules.js`'s **`no-silent-send`** is the build-time half. It fires on a socket write
inside a JSX handler (`on[A-Z]…`) whose body contains no toast and no queue call. Two scoping
decisions keep it a rule rather than noise:

- Only `on*` JSX attributes. An effect, a reconnect sweep and a timer all write to the socket
  legitimately, with nobody standing over them.
- A bare `send(…)` counts as a socket write only in a file that BINDS one off the connection
  (`.send.bind(` in the source). Several sheets have a local `send` that is a callback prop, and
  flagging those would have made the rule 74 findings of which 22 were wrong.

There is one inline exemption, `Terminal`'s `onResize`: the terminal reports its own geometry on
every layout change, so a toast would fire several times a second while the keyboard opens, and a
resize that never lands is superseded by the next one and by `session.attach` on reconnect.


## Chrome that changes itself says so

A first-time reader could not find how to start a session: the repo header's `+` was one bare
icon among five. The fix was a word, `+ new`, shown only while the host has never run a session
(`neverRanSession`, the same reading the first-run card uses). That fix had a fault of its own,
pointed out at once: the word **goes away by itself**, and a button that changes its look
without warning reads as a bug or a lost control. That is exactly the habit the first-time aid
was supposed to build.

The header `?` had already solved this. The first time explain mode is left, it ASKS whether it
may go, and its toast names where it comes back. The first-use hint card says *"Explained once.
The next tap on this button just does it."* Both tell the person at the moment of the change.
The `+ new` now does the same: the tap that opens the first session toasts `NEW_LABEL_RETIRES`.

Superseded 2026-10-13: the header's start verbs are now always worded — `+ now` and `+ later`
under the repo name (`RepoGroup.tsx`, `.repo-start`) — so there is no label left to retire and
`NEW_LABEL_RETIRES` is gone. The rule it illustrates stands.

The general rule (skill `ux`, §1): self-changing chrome says so when it changes, says what it
becomes or where it comes back, keys the aid and the notice off one predicate, and **asks** when
it removes a control but **tells** when it only drops a word. It is a skill and not a paragraph
per component because three components had each worked it out separately, and the fourth got it
wrong.

## A strip above the prompt bar folds, it never closes (`Stowable.tsx` + `stow.ts`)

The session screen grows cards between the terminal and the prompt bar — a shell's link card
(`ShellLinksBar`), the sign-in card (`LoginBar`), the next prompt (`NextPrompt`) — and every one
of them takes its height FROM the terminal. On a phone the shell link card alone was a third of
the output area, and it stayed up as long as the link was on screen. The owner asked for a way to
put such cards away that does not throw them away: the link is still the link and the code still
the code, so the answer must still be one tap off.

So it is a FOLD, and it is written once:

- **`Stowable`** wraps the strip; `<StowButton />` goes wherever its head has room. Folded, the
  strip renders nothing and a chip (its own icon and title, plus an optional live `detail` — the
  device code, `+2` behind) stands in the session **status line** via `StowTray`. That line is on
  screen anyway, so a fold gives the terminal back its whole height; a new row of chips would
  have bought back only part of it.
- **A fold is keyed by CONTENT**, not by the strip: slot + `stowKey`. A new link, a new code, the
  CLI starting to wait for a code, the next queued entry — each is a new thing to read and comes
  back up by itself. A fold keyed by slot alone would hide exactly the change that needed seeing.
- **The key is a SET of facts, one per line, and news that breaks a fold drops it** (2026-10-19).
  An exact-string key looped on a shell: folding the link card grows the pane, the host's re-read
  of the taller screen published a different link set, the card came back, the pane shrank, the old
  set returned — and matched the old mark, so it folded again, forever. Now a fold holds while no
  fact on screen is new (a link lost or reordered is not news), and once a new fact unfolds it,
  `Stowable` drops that mark so the old content returning cannot re-fold it.
- **Marks persist per device** (`LS.stowed`, a week, 60 marks) because every OTA update is a
  reload, and a fold that came undone on each one would be a fold nobody trusts.
- **The first fold says where the strip went** (`STOW_TOLD`, once per device, `LS.stowTold`) —
  skill `ux` §1: a control that vanishes names the way back. After that the chip appearing is the
  receipt.

Typing room and full screen hide the status line and therefore the chips; the strip stays folded
and its chip is back when the chrome is.

## The overlay ladder became a table

`App.tsx` chose which sheet to show with forty sequential `if (overlay === "x") return …` branches,
1,450 lines of them. Two costs, and the line count is the smaller one.

Adding a sheet meant splicing into the middle of that chain — five thousand lines away from
`PERSISTED_OVERLAYS` in `routing.ts`, which is the OTHER list a new overlay has to appear in and the
one that decides whether a reload lands back on it. Two lists that must agree, edited five thousand
lines apart, with nothing connecting them.

And because every branch RETURNED, anything meant to be on screen at all times had to be repeated
inside every branch that could be showing. A layer rendered in only some of them is a layer that is
missing from the rest, and that failure does not announce itself — it is the same shape as the bug
that made every refusal fired from a sheet a button with no effect and no sentence.

So: `overlayViews`, a `Partial<Record<Overlay, () => ReactNode>>`, one `overlayNode`, one return.
Anything always-on belongs AROUND that, never inside a branch of it.

The guarded entries are the detail worth keeping. A branch like `overlay === "image" && ann` used to
fall through when its backing state was missing, landing on the screen underneath. The table entry
returns `null` instead, and `overlayNode ?? the screen below` reproduces that exactly — which is what
makes a reload that restored `"image"` with no picked file paint the launcher rather than an empty
sheet.

What this deliberately did NOT do is move the ladder into its own file. The bodies capture 211 names
from `App()`'s closure; the context interface that would require is worse than the file it replaces.
That extraction becomes tractable only after the state is grouped into domain hooks — the capture set
collapses when the ladder reaches for `net.pulse` instead of eight separate names — and the hook
extraction is the part with real regression risk (a ref-authoritative send queue and 52 effects whose
ordering is load-bearing), so it wants doing one group at a time with the suite green in between.


## Where a dead send's words are, and the pad's last-write-wins problem

_History for the give-ups half: the ledger, its `where` rule, `canRetryGiveUp`/`canFixGiveUp` and
`markGiveUpRetired` are all deleted with `giveups.ts` (see *`giveups.ts`, deleted*). The pad half —
the per-note merge in `shared/pad.ts` — still describes the tree._

A screenshot from the phone: the health sheet listing nine sends that gave up, every row ending
"on the pad", and next to it the pad — *Nothing on the pad. Tap "new" to park a thought.* 0 notes.
Two bugs, one screen, and they are worth keeping apart.

**The row was guessing.** The list had two cases and a default:

```
const where = live ? "in the queue" : g.dropped ? "bytes, not words" : "on the pad";
```

Everything that was neither of the first two read as the pad. That covers, at least: a row the user
discarded by hand (`removeQueued` deleted it and never told the ledger); a row the cap evicted
(`addOutbox` the same); a failed photo upload, which `markGiveUpRetired` only flags as bytes an hour
later when the row retires — so for that hour a JPEG claimed its words were on the pad; and a
retired prompt whose note has since been sent, edited away or deleted, on this device or another
one. `padId` records that a note was WRITTEN. It has never been evidence about now.

The fix is that there is no default. `@waterplane/shared`'s `giveups.ts` answers `queue` / `pad` / `none`
from the two facts the ledger cannot hold — does the queue still have the row, does the pad still
have the note — and `none` carries `goneReason`, because "a photo was never text", "the note is
gone" and "you threw the row away" are three different sentences and only the middle one is a loss.
The same rule decides whether *send again* is offered, so the button above the list and the buttons
inside it can no longer disagree with each other, or with what happens on the tap: before this,
`canRetryGiveUp` accepted any row with a `padId`, counted it into "send 9 again", and then reported
"nothing left to send from those rows". It is in `shared` for the ordinary reason — it is pure, it
is read by three parts of one screen, and its failure mode is a sentence that is quietly wrong.

**The retry could not work.** The circled row is a prompt whose photo upload died: `.claude/inbox/
1000074644-…jpg`, "the image it refers to never uploaded". `queueBacklog` refuses any text naming a
dead upload — that guard is the reason a prompt never reaches an agent pointing at a file nobody is
sending — so *send again* on that row was a tap that could not succeed: one toast about re-attaching,
then a second saying "nothing left to send from those rows", and in a bulk retry a silent decrement.
The words were never the problem. So rows whose files are dead are split off (`canFixGiveUp`) and get
*fix & send*, which opens the resend editor — re-attach the phone's retained copy, replace it, or
drop the mention — and carries `giveUpAck` so a send marks the ledger row exactly as a plain retry
does. Those rows are also the only ones that draw an `AttachStrip`: a strip costs a repo listing per
row, and the row stuck ON a file is the one where seeing the picture decides what to do.

**The pad was being emptied.** `waterplane.pad` is a synced setting, and the sync is last-write-wins on
the whole value. A device that writes its pad while holding an older copy replaces every note the
other one had. Nothing on the wire distinguishes that from a deliberate delete, and the loser finds
out by opening a pad that a give-ups row has just promised holds their words.

The first answer was compensation. `settings.ts` calls an `onAdopt` guard before a remote value
overwrites a key (a callback, not an import — the store owner already imports `settings.ts` for
`announceSetting`), and `outbox.ts` registered one that diffed the incoming list against the local
one and kept the drops that read as a LOSS, in a device-local rescue store the sheet offered back in
an amber block. That was three mechanisms and a judgement call — every note sent or deleted on
another device also arrives as a drop, and nothing in the value tells them apart, so the SHAPE of
the diff had to decide — and a judgement call about somebody's words is a coin toss with the
downside on one side only.

**All of it is gone, because the merge is fixed instead.** `shared/pad.ts` now merges per NOTE:
the synced value is still ONE JSON array under `waterplane.pad`, holding notes (a string `text`) and
tombstones (a finite `gone`, no text), and the host still stores a string and still compares a `ts`.
The guard's return value is what changed — `AdoptGuard` may now hand back the string to write, so
the pad's registration is one line, `adoptPad(incoming, current, Date.now()).value`. Where the merge
produced something the host has not got, `applyLocally` stamps it strictly newer than what arrived
and pushes; the host sends the winner back to the loser of a concurrent push (`routes/system.ts`'s
`"older"` branch, already there), the loser re-merges, gets the identical string — serialization is
CANONICAL, which is the whole reason it has to be — and `applyRemoteSetting`'s equality branch stops
the exchange. Two round trips, worst case.

**Two things that push are `settingsPush.ts`'s, stated where a node test can run them** —
`settings.ts` patches `localStorage` and cannot be imported without a browser, and both of these
fail with the screen saying `synced`. (a) `repushAfterAdopt` takes the WRITE's own flag: `setItem`
throws on quota, and the push that follows reads the store back, so a merge that did not land was
being sent as the OLD copy under a stamp strictly newer than the host's. No write, no push — the
two sides reconcile on the next `settings.all` instead. (b) `aheadValue` merges before an AHEAD
device pushes: a phone that wrote offline at t1, while another device pushed at t0 < t1, is newer by
the stamp and was pushing a copy that had never seen the other one's notes, taking them off the host
until that device reconnected and unioned them back. A detour rather than a loss — the tombstones
make it converge either way — but the guard that avoids it is already registered, one call away.
Merge, then push the union stamped strictly newer than both. A guard that throws, or a key with no
guard at all, still pushes what it holds: last-write-wins is exactly right for a preference.

The failure mode this chooses, stated plainly because it is a choice: a legacy array parses as a doc
with no tombstones, so a delete made on an old bundle, or more than `PAD_TOMB_TTL_MS` (30 days)
before a long-offline device finally pushes, comes back once, everywhere, wearing its old date. That
costs one tap. The failure it replaces cost words. And a note EDITED after a delete wins over that
delete and drops the tombstone with it — an edit is words somebody typed, and the delete was made on
a device that had not seen them.

The one place this could bite is a duplicate delivery: without a tombstone on dispatch the other
device unions the sent note straight back in and it is sent twice. So every removal path goes
through `removePadNotes` — the sheet's trash, "emptied = deleted", `retireSendSource`, the Send
sheet's discard, and *file it*.

The last piece is `BootGuard`. Its hard reset kept the outbox and the pad and dropped everything
else, including `waterplane.syncTs` — the local write times. With those gone every remote value is newer
than everything local, so the next `settings.all` replaced the pad with whatever the host last heard
from any device, which on a phone that had just crashed is routinely a copy from before the notes on
it were written. The one store the reset was written to protect was being emptied by the reset. It
now keeps `waterplane.syncTs`, `waterplane.giveups` and `waterplane.padRescue` (plus its migrated mark) too — the
rescue store is retired and READ ONCE, the `giveups` precedent: a phone upgrading to this build has
notes in there and nowhere else (ten of them on the device this was reported from), `migratePadRescue`
puts each back on the pad under its ORIGINAL id and `ts`, reading the key RAW rather than through the
old `rescuedNotes()`, which applied a 7-day TTL and rewrote it on read. The flag is written only if
the pad write succeeded, so a quota refusal retries next boot, and the source value is never
deleted: a migration that got something wrong must not also have destroyed its input.

**The decision half is `padMigrate.ts`** (`migrateRescueRows(rows, doc, now)`), and `App.tsx` keeps
only the raw read, the write and the mark. Not tidiness: those ten notes exist on one phone, the
source is read once and the mark is then written, so a rule that is wrong here is wrong silently and
for ever — and inside `App` not one of them could be run by `node --test`. Each is now a test: an id
already on the pad is left alone (the live copy wins, whatever its `ts`); a repeated id takes the
NEWEST row and counts once (`upsertNote` replaces wholesale, so "last one in the file" is not a
rule); a tombstone at or after a row's own `ts` wins and one from BEFORE it does not, because those
words were typed after that delete; a row with no id or no text is dropped and nothing in the file's
shape can make it throw; `steps`/`cwd` come across when present and stay ABSENT when not, while
`lostAt` and `how` are dropped (there is one pad now); a row with no usable `ts` is stamped `now`,
which is the only honest answer; and the count is what was actually ADDED, because that number is a
sentence somebody reads about their own notes.

## The split button, and why the mode came back

`SendSheet`'s note says the compose bar's per-repo `sendMode` was deleted because "the same tap
sent, queued, held or opened a schedule editor depending on a setting made days earlier and shown
nowhere else." That is a true account of a real bug, and the replacement — one button, one meaning,
everything else in the sheet — over-corrected: the chevron welded to the Send button now opened a
sheet rather than changing what its neighbour did. Reported, exactly: *"If I click it it should
change the purpose of the attached rest of the button but instead it opens the dialogue for one
other function."* A split button that does not split is a control lying about its own shape.

So the mode is back, with the three properties the old one lacked:

- **Per message, never persisted.** `sendMode` was component state written to no store, reset to
  `now` after every send and on every session switch. There is no way to arrive at a session with a
  mode armed that you did not choose for the message in the box. (**This one is superseded** — see
  *And then the memory came back, per repo* below. The other two hold unchanged, and they are what
  makes the memory safe.)
- **Spelled out on the button.** *Send* / *When free*, icon and title with it — the armed choice is
  never only a highlighted row in a menu that is closed.
- **Only what a strip can honestly ask.** The modes change the button; anything needing more than a
  tap opens the sheet.

### And then the memory came back, per repo (`sendMemory.ts`)

Reported over a screenshot with the split button circled: *"This button needs to remember what I
chose last time per repo so I can easily queue many prompts after another the same way, e.g.
schedule for the same time or queue when free."* Which is the real cost of *per message, never
persisted*: queueing five prompts *when it's free* is five taps on the chevron and five on Send,
and setting the same 21:00 clock for five prompts is five trips through the sheet's WHEN row. The
rule above was written against a bug, and the bug was **invisibility**, not memory.

So the memory is back with the invisible half designed out. Four rules, all in `sendMemory.ts` and
pinned by `sendMemory.test.mjs`:

- **The split button is only ever recalled to a mode it can SAY.** `reusableMode` passes `now` and
  `idle` and nothing else, and `sendModeLabel` spells both out on the button face — a repo left in
  *when it's free* reads `When free` before it is tapped. A wall clock never reaches this control,
  which is exactly what the deleted `waterplane.sendMode` did do.
- **A schedule is recalled onto the SHEET.** `openComposeSend` seeds `when` from the repo's memory
  and the origin line says so (`recalledWhenNote` names the repo, because per-repo is the part
  nobody would guess). The sheet draws the rule in words and restates the whole decision on its own
  button, and one tap sets it back to *now* — which is remembered too, or "set it back" would be the
  one answer that never sticks.
- **A stale one-off expires itself**, at READ time as well as at write: a `once` rule whose instant
  has passed would arm a schedule that fires the moment it is saved, or never. A weekly rule is
  durable by nature and survives.
- **A chain is never remembered.** `{kind:"after"}` names ONE predecessor row by id; reused, every
  later prompt would silently park behind a row that settled hours ago.

Two writers, merged rather than replacing: `sendCompose` writes the `mode` it actually sent with (it
no longer resets to `now`), `SendSheet`'s `onSend` writes `intent.when` — and only for a
single-repo target, since a sweep is one decision over N. The store is `waterplane.sendMemory`, per
device, bounded at 40 repos with the oldest decision evicted. The recall effect is keyed on the
**cwd**, not on `activeId`: a session attached before its list arrives has no cwd for one render,
and an effect that had already run on the id would leave the button saying `Send` for a repo that is
set to *when it's free*.

### Then it went from five answers back to three, and the words moved to `composeSend.ts`

The version above shipped with THREE modes and TWO errands, and the three modes were not three
decisions. *When it's free* parked the entry on the PHONE (`holdUntilIdle`); *queue here* handed it
to the DESKTOP as a work item pinned to the session (`backlog.add` + `autoFire`). One user intent,
two holders, and the difference between them — which machine remembers — is not something a person
can be asked to choose, nor anything the strip could show them: the two buttons differed by an
icon. Reported as *"I'm very confused by how these different features relate"*, over a screenshot
with that cluster circled.

The desktop wins, and it is the only holder now. A phone-held wait is only served while this tab is
awake, so a locked screen held prompts that never went in; the desktop is still there. The cost is
the intent tick's latency (~2 s) on a session that was ALREADY idle, against the old near-instant
lift — weighed and accepted. `holdUntilIdle` survives in exactly two places the host cannot reach:
a prompt chained behind a `session.create` (there is no session id yet for a pinned item to name, so
the create's own lane is the queue) and `submitInput`'s local-command-mid-turn guard — and *When
free* on a local command is routed into that second one deliberately. `/usage`, `/model` and `/help`
open a VIEW and start no turn; a pinned work item is delivered with `watch: "turn"` and settles when
a turn ends, so handing one to the desktop hands it a row whose finish condition never happens — it
sits `running` in Activity for ever while the CLI has long since drawn and dismissed a modal. The
phone types it the moment the turn ends and lets go, and `sendModeToast` takes a `phoneHold` reason
so the two phone-held cases read as the two different promises they are: one ends on *leave the app
open*, the other does not.

The two errands went the same way: *at a time…* and *somewhere else…* opened the SAME sheet,
differing only in which row came up expanded. One entry, **elsewhere or later…**, seeded to what the
button would have done — this session, now, both rows collapsed — so it is an expansion of the
decision already made rather than a fresh one.

The words live in **`composeSend.ts`** (`sendModeLabel`, `sendModeTitle`, `sendModeToast`,
`composeMenu`), pure and pinned by `composeSend.test.mjs`. They were inline in `App.tsx`, which has
no test, and they are the labels on the control almost every send in this app goes through: a mode
whose button says one thing and whose toast claims another is not a type error and does not throw,
it is a lie about where somebody's words went. `sendModeToast` takes the HOLDER, because "held" when
the phone is the one holding it is a promise about a locked screen that the phone cannot keep. This
is the only extraction made out of `App.tsx` for that change — `dispatchIntent` and `openSend` close
over twenty of App's refs, and moving them would be motion.

The strip sits ABOVE the compose bar in flow (`.row-more`, the launcher's own menu shape) rather
than floating over it: a popover and a phone keyboard is a coin toss about which one wins.

### And a fourth answer that runs nothing: *keep it on the pad*

Every other exit from this composer ends in something that fires itself. `now` types it in, *when
it's free* hands it to the desktop, and every WHEN in the send sheet is a trigger — a backlog row
is work somebody has decided to do, and `auto` decides WHEN. An idea
to reconsider, or a bug you want to look at once more yourself before an agent does, is not that
yet, and there was nowhere in this menu to put one: the nearest answer, *when it's free*, still
ran it.

So the menu grew one row that is not a send. **`keep it on the pad`** writes the words to the
prompt pad (`addPadNote`) with the session's `cwd` when there is one, and nothing in this app looks
at them again until a person opens the pad — no target, no trigger, out of reach of `auto`.
Filing it onto a backlog later is one deliberate tap there (*file it*). The toast names both facts
a person cannot see from the box emptying — that nothing runs it, and where it went — because this
screen has no pad strip and a note that lands silently is a note nobody finds again. A refusal (the
pad is full, or the write was rejected) leaves the composer EXACTLY as it is: those words are the
only copy, and clearing them on a failed write is the delete the pad's refuse-rather-than-shed rule
exists to prevent. `PAD_KEPT_TOAST` and `PAD_EMPTY_TOAST` are pinned in `composeSend.test.mjs`,
negatively as well: the row may never say *queued*, *scheduled* or *will run*.

An empty box answers in words (`PAD_EMPTY_TOAST`), never with a dimmed row.

### The menu row was as tall as the composer

Three buttons ~140 px high with their labels floating in the middle of them, eating the terminal
above, reported off a screenshot. `.row-more` is written for the LAUNCHER's rows, whose parent is a
wrapping ROW, and its `flex: 0 0 100%` means "a line of my own, full width" there. `.compose` is a
flex COLUMN, so the same basis is read down the MAIN axis: each menu row was asked to be as tall as
the composer, and the composer then grew to hold it. `.send-more` restates `flex: 0 0 auto` (and
`align-self: center` on its buttons, so one tall row cannot drag the others up with it); `.row-more`
keeps the basis it needs. Measured in a headless repro before and after: row 171 → 86 px, button
74 → 31 px. **A `%` flex-basis is a claim about which axis you are on** — check the parent's
`flex-direction` before reusing a row shape inside a column.

## The session screen before the session exists

Two screens answered "start work in this repo", and which one you got depended on whether the
tunnel happened to be up.

**Online:** the launcher's `+` queued a durable `session.create` and left you on the launcher.
Navigation rode on `op.ack`, so on a good link that is a beat and on a bad one it is a receipt
window plus however many attempts — with a spinner chip on the repo row as the only sign anything
had happened. Nothing would take a prompt until the CLI was up.

**Offline:** `openRepo` deliberately diverted to the Send sheet, on a sound argument — an empty
terminal queued for later is not what anyone wanted; the work that runs in it is the point. But
the sheet is a different surface with different features (its own composer, a `To` row, a `When`
row, "write the prompt first", `Start in usmc`), and it is the surface you got precisely when the
app was least able to help.

So the same act had two dialogues, and the poorer one was the offline one.

**The fix is that a queued create IS a session on screen.** `pending:<createAck>` is a synthetic
`SessionInfo` — id per CREATE and never per repo, because the send lane is per repo and two opens
of one checkout must not share one screen — and `active` falls back to it, so the real session
screen renders with no branch of its own. The terminal area carries the explanation the overlay
mechanism already had a slot for (`kind`): *warming up the CLI for you…*, *offline — the session
will be created once you are back online*, *the desktop has it*, or the refusal in the host's own
words with **try again** beside it.

Three things make it more than a placeholder:

- **Typing needs no new path.** `submitInput` routes a `pending:` id into `queueSessionPrompt`,
  which is where prompt 2 of a chain has always gone: the create's own lane, `pendingCreate`,
  released onto the real session by `bindPendingSession` when the ack names it. Every caller —
  compose Send, header chips, the Send sheet's `session` branch, snippets — inherits that for free.
- **Files need no new path either.** `laneFor()` maps the screen id onto `create:<cwd>` in the two
  places a lane is chosen (`guardUploadRefs`, `queueImageUpload`), so an attached photo is parked
  ahead of the prompt naming it, exactly as `startSessionWithPrompt`'s `needs` expects.
- **The draft survives the handover.** Drafts are keyed by session id, so `adoptPendingSession`
  copies it onto the real id before switching — otherwise words typed while the session warmed up
  would vanish at the one moment nobody would suspect: the moment it opened.

What it cannot do says so rather than pretending. There is no PTY, so the raw-key row is not
rendered, CLI mode is not applied (the toggle is remembered, not obeyed), `session.resize` is not
sent, the reader and the star are absent, and the toolbar's slot carries an `Unavailable` line
naming the three groups of verbs and why. The destructive button drops the queued create instead
of killing a session that does not exist.

Two rules worth keeping:

- **The screen must outlive its queue entry.** `op.ack ok` retires the create row, and for a
  create the host PARKED (holding it until its files land) the session id arrives later still, on
  `launch.opened`. A screen derived from the entry alone would fall back to the launcher on the
  very ack that means it worked, so what was opened is remembered in `pendingKept` and the entry
  only ever adds detail.
- **Adoption never ambushes.** `adoptPendingSession` moves the view only when you are standing on
  that create's screen — the same reason `queueOp` refuses to `focus` an op that was queued
  offline and may land twenty minutes later.

## The queue stopped owning the work (stage 6)

Everything above about `giveups.ts`, `QUEUE_TTL_MS`, `FAILED_RETIRE_MS` and `retireToPad` is now
history rather than description. Read it for the reasoning — every one of those mechanisms was a
correct local fix — and read this for what the tree does.

**The four clocks.** A message written on the phone passed through, in order: a 30-minute queue TTL
that expired it as *"queued too long"*; an hour-long `FAILED_RETIRE_MS` that then retired the row
and moved its prose to the synced pad; a give-ups ledger that kept a 200-character head of it for a
day; and, underneath all three, the host's 45-minute ack ledger, which is what the 30-minute TTL
existed to stay inside — a retry that outlived a forgotten verdict is a prompt typed twice. None of
those clocks knew anything about whether the work still mattered. Between them, an evening's writing
was a clipped head by morning, pointing at a pad another device had since overwritten.

The measurement is the part that settles the argument: of 321 deliveries, 70 came back ambiguous and
**46 of them are present in the CLI's own conversation log**. They ran. Two thirds of every
gravestone in that list was a false negative, and the log that proved it was on the same disk,
unread, the whole time.

**What replaced them.** The durable Intent store keys at-most-once on an id that lives as long as
the row does, not on a ledger entry that expires — so the client's TTL was not a safety net any
more, it was only a shredder, and `shared/queue.ts` has no clock in it at all now. `selectSendable`
still refuses, blocks and explains; the only thing it gives up on is `maxAttempts`, which counts a
host that ANSWERED and said no. An attempt made with no socket open is still rolled back, so riding
out an outage of any length costs nothing.

**And what replaced the ledger.** Not another store: the row itself. Nothing retires a `failed`
queue row, so it keeps its full words and the `cwd` they were written for, and Activity renders it
with the three things the ledger existed to provide — what never ran, a re-fire that needs no repo
picker, and a dismissal mark. `OUTBOX_CAP` went 50 → 500 for the same reason: with no ledger, the
cap is the last way this app could delete typed words, and 47 stuck sends against a cap of 50 is an
ordinary afternoon on a bad tunnel. Past the cap the oldest rows are FAILED, never removed.

**The verdict comes to us now.** `settleFailed`/`applySettled` are gone. The phone asked at most
three times, over a live socket, from a tab that reloads on the worst link, about rows that retired
an hour after they failed — machinery that worked on the good day and not on the day the question
gets asked. `opendeliveries.ts` holds the question on the machine that holds the evidence, re-asks
with nobody connected, re-sends a provably-`absent` prompt exactly once, and broadcasts
`delivery.settled`; App applies it to the row by ackId. `delivery.list` on hello is the
reconciliation pass for everything settled while the tab was gone — the case the client-driven
version could never cover at all.

**Migration, because a deletion that loses words is the bug.** `waterplane.giveups` is read once
(`migrateGiveUps`, guarded by `waterplane.giveups.migrated`) and every un-retried row becomes a `failed`
queue row: the pad note's full text where the note survives, the ledger's clipped head otherwise,
and always a FRESH ackId — the ledger's id may still hold a verdict host-side, and a retry carrying
it would be re-acked with that verdict and never delivered. The source value is deliberately left on
disk, so a conversion that got something wrong has not also destroyed its input.

**What deliberately did NOT go.** `goneLanes` stays, narrowed. `rescueStranded` and
`rescuableEntries` are DELETED: the premise above — that the host implements no rescue — was wrong.
`main.ts`'s `deliverInput` writes a stranded prompt to its repo's work items and answers `rescued`,
and the client's block was what kept that message from ever arriving, so the case both were written
for (queued while offline, phone asleep) was served by neither. The client half also rescued on a
grace measured by the PHONE's clock, which only advances while a tab is foregrounded. What is left
of `goneLanes` is the one thing the host cannot answer: an entry with no `cwd` has no work list to
go to, so it is still held rather than turned into a red row. `holdUntilIdle` stays for the one job the host cannot do
— a chain queued behind a `session.create`, where prompt 2 must not be typed while prompt 1's turn
is running. `serial` stays because a queued open is a `session.create`, not an intent, and dropping
it would put five agents in one worktree on the first reconnect. And the pad's own guard
moved to `shared/pad.ts` rather than dying with `giveups.ts`, because it guards the pad against the
synced last-write-wins overwrite, which has nothing to do with the send queue. (`notesToRescue` and
the `padRescue` store are themselves gone now — see *the pad's last-write-wins problem* above: the
merge is per note, so there is nothing left for a rescue list to catch.)


## Two vocabularies for "run it": this second, or in turn

The re-time sheet's *run all 4 now, past the budget* sent `intent.run` per row,
and four agents started in one checkout at the same second. Since then the
verbs split in two, and the words say which:

- **Single-row skip-the-queue verbs** — Backlog `fire`/`re-fire`
  (`backlog.fire` → `runNow`), Activity *run it now* (`intent.run`), the compose
  strip's *send now*. (The schedule sheet's *now* and the queue sheet's launch
  run reach `runNow` too but draw no note; `bulkverbs.test.mjs` pins each to
  one call site.) They skip the WHOLE queue, and the three that say so use ONE sentence,
  `sendIntent.ts`'s `skipQueueNote` (*starts it this second in a session of its
  own — skips the queue: the budget, one at a time and wait
  until free*). As TEXT where the verb is: Activity draws it under the row's
  buttons, the compose strip in its `why` line, the Backlog under a row where
  the skip can hurt (another item is RUNNING in that checkout) or where nothing
  else describes the verb (a `done` row) — on an ordinary queued row it is the
  `backlog.fire` hint card rather than one identical line under every item.
  Into a checkout another agent is already working in (`busyInCheckout`, off
  the worktree, and only for a row that opens a session of its own) the
  consequence is SAID — `SKIP_QUEUE_BUSY_NOTE`, *another agent is working in
  this checkout — this starts a second one beside it*, appended to the note /
  title — and **never asked**: these verbs are the MANUAL OVERRIDE and take ONE
  tap, always. They were a `ConfirmButton`, which disarms after `ARM_MS`; the
  owner tapped `fire` on a `serial`-held row, the tap only armed it, and nothing
  fired. Both sheets read it over the WHOLE intent store plus the live
  sessions mid-turn there — the Backlog once asked over its own items only and
  missed a build or a launch Activity saw. A `serial`-held Backlog row also
  offers the session it waits behind (`holderOffer` over
  `BacklogItem.holderSessionId`): *answer in 'x'* when a question is open there,
  else *open 'x'*. A standing rule whose action QUEUES a
  backlog item (`queuesBacklogItem`) says *queues an item in its backlog — it
  runs in turn* instead, and never asks: its run starts no agent.
- **Bulk releases never send `intent.run`.** *Let these N past the budget* is
  `intent.waive` for exactly `budgetHeldIds` — the one function behind the
  count on the button and the ids it sends — drawn only when the budget holds
  one of the ticked rows, and worded *in turn*, never *now*. Held is
  `isBudgetHeld` — waiting, verdict `budget`, no waiver in force, and DUE (a
  row whose clock is tomorrow reads `budget` too, since rung 2 is above the
  trigger, and waiving it would answer about a window it will not run in); the
  header's ⌛ `· budget` count reads the same function. A waived row wears a
  `let past the budget · undo` chip on the Backlog (`PAST_BUDGET_CHIP`) only
  while its window lasts (`budgetWaived`); the tap is the undo (`on: false`),
  offered only on a waiting row, since the host refuses a waive on one going.

## A "Recently closed" row says what it was and why it ended

The row used to be the folder title, the launch label and "reopen · closed 3h ago" — every row from one repo looked the same, and a session the host had closed ON ITS OWN (close-when-done after its item finished, or reaped early to free a slot for a waiting item) was indistinguishable from one you closed. The host now records the facts on `ClosedSession` (`shared/closed.ts`, all optional, absent = unknown); the words are `core/launcher/closedRowWords.ts`, pure and node-tested (named so, not `closedRows.ts`, because macOS's case-insensitive filesystem makes that the same file as `ClosedRows.tsx` and `tsc` refuses it).

- **Headline** is the item it ran, else its ≤4-word tab name, else the folder title; the folder title then follows as a small line, and only when it is not already the headline.
- **Auto-closed rows** carry a bordered pill on its own line under the headline — the `Bot` icon plus *closed automatically — work finished* / *closed automatically to make room for a waiting item*. Icon and words, never colour alone. A chip *closed automatically · N* above the list cuts to exactly those (`isAutoClosed` counts it and cuts it), with "n of N shown — show all" while the cut is on. The chip is drawn only when N > 0: a standing "· 0" on every launcher is noise, and the cut falls back to everything if its rows go.
- **Kind chip** (by hand / backlog / scheduled / agent / fan-out / fork / reopened after limit), **reason** ("closed by you" small; "ended on its own (exit N)" only when non-zero; "stopped at usage limit — reopened" once `resumedAs` exists), the item's **outcome** with its detail, the **gist** (summary, else last prompt) clamped to two lines, and the **small print**: open-for duration, last active, "N prompts sent from here" (a FLOOR — desk-typed prompts are not counted, so the words say *from here*), model.
- **An old row draws exactly what it drew before** — every function answers nothing for an absent field. The reopen tap is unchanged.

## The close sheet: facets that combine, replacing five single-cut buttons

`CloseAllPicker.tsx` (deleted) was a small `bl-modal` of five buttons, each its
own hand-cut sweep: *All*, *only inactive > 1h*, *only never started*, *only
started*, a typed custom hour cutoff on one of two clocks. They could not
combine — clearing "today's leftovers AND anything nobody ever typed into"
needed two taps and the second one re-swept the first's leftovers too — the
dialog counted a NUMBER, not a reviewable list, so nothing on screen said
which nine sessions "All (9)" meant before the tap; and it was blind to
agents, background shells, drafts and queued prompts, so a close could orphan
a shell mid-build with nothing on the dialog to say so.

`core/launcher/CloseSheet.tsx` + the pure `closeModel.ts` replace it with a
full `Sheet` (`useBackStep` gives it its own Back/gesture step, the way
`RetimeBar.tsx` layers its own editor over a list) and seven FACETS — state,
idle-for, open-for, underneath (agents/shells), words at stake (an unsent
draft or a queued prompt), conversation (never started/started), and repo
(scope `"*"` only). Facets AND together, the options inside one OR — tick
"waiting for your answer" and "at the limit" and a row matching either stays
in; add "idle > 1d" and now only rows matching BOTH stay. Every chip's
own number is read with THAT facet's own picks set aside and every OTHER
facet's current selection applied (`facetCounts`'s `withoutFacet`) — the same
self-exclusion `backlogFilter.ts`'s age/status cross-count uses, generalised
from two axes to seven, so ticking a second option in one facet reads as
"adds these rows", never "recount everything already on screen". Each facet
is its label with kit `FilterChip`s beside it, one per option some row answers
(plus any 0 option that is itself ticked — un-selecting it must stay
possible); every option left off the strip is said once, in one lower-case
line ("none: waiting for your answer, exited"), never missing with nothing on
screen to say so — and never inside `.section`, whose uppercase shouted it
(2026-10-12).

The list under the facets is the ACTUAL rows (`SessionFacts`, the same
component the launcher row and the search sheet already share), each with a
"keep" toggle (`ShieldCheck`) — a person can narrow to "idle > 1d" and still
spare the one row they recognise, without a second dialog. `underneathOf`
reads `shellList` when it has arrived (`unknown` counts as `shellsLive`, never
`shellsQuiet` — the shared rule that a shell seen once with nothing yet to
compare against is not proof of quiet) and falls back to the OLD host's
`shells` boolean as `shellsLive` when it has not — a `shellList` that arrived
EMPTY is still "nothing running", never the stale boolean. The foot sends
`session.remove` once per row still in (cut minus kept) — marking each id
first (`features/shells`' `notePendingClose`, see below) — and says what it is
ABOUT to stop: `close N · stops M background shells` — CLAUDE.md's "closing a
session stops its shells, fully" said as a count on the one button that does
it, not discovered afterward. `N = 0` is `Unavailable.tsx`'s rule applied to
the whole sheet: no button, a sentence why (either "nothing here to close" or
every match is a kept/starred row). One toast for the one tap, naming stars
spared only when nonzero, and shells "stopping" — never "stopped" — since
nothing has actually been killed yet at the moment of the tap (`closeToast`);
the definitive count, `shellsStopped`/`shellsLeft`, is a second, later toast
off `session.closed` (below).

The old dialog's two settings — the custom cutoff number and which clock it
measured — are retired (`lsDel`'d once from `useLauncherModel.ts`): fixed
`> 1h / > 6h / > 1d / > 3d` edges are now two INDEPENDENT facets (idle-for,
open-for) that combine instead of a number behind a switch that picked one.
`closeScope`/`starredSpared` (`model.ts`) are the one piece of the old file
kept as-is — sparing the starred sessions is a SCOPE decision, made before any
facet, exactly as it was.

**`session.closed` is a broadcast, and only the asker gets its toast.** The
host sends it to every open phone once the shells are actually confirmed
stopped (or refused), not only to whichever phone sent `session.remove` — so
`features/shells` (`logic.ts`) keeps a plain in-memory set of ids THIS phone
is waiting on (`notePendingClose`, called right beside every `session.remove`
this app sends — `CloseSheet.tsx`'s foot and the per-row × in
`useSessionVerbs.ts`) and `onSessionClosed` only toasts when `takePendingClose`
proves the id is one of them. The toast itself now says what actually
happened, `shellsLeft` included ("stopped 2 background shells … · 1 did not
stop") — the tap's own `closeToast` only ever claims the softer, immediate
fact ("stopping"). The same fact — a session has background shells worth
saying something about — is drawn exactly ONCE per row: `shellsTag`
(`core/sessions/tags.tsx`) is the one chip; `statusPill` (`sessionFacts.tsx`)
went back to plain "done"/"coding" wording after carrying the same words a
second time. Inside the shells sheet itself (`features/shells/ShellsSheet.tsx`),
a `foreground` shell — the running turn's OWN command, not a background shell
at all — gets its words (`shellWords`'s "a command this turn is running") and
no stop button, never a greyed one.

## CLAUDE.md entries in full

CLAUDE.md keeps the rule; these are the web-module entries as they were written before the compression
pass, carrying the reasoning they were trimmed of. Nothing below is a summary — each block is the
original paragraph, and CLAUDE.md's per-entry links point at these headings.

### `toolbar.ts` / `routing.ts` / `format.ts` / `localState.ts`

- `toolbar.ts` / `routing.ts` / `format.ts` / `localState.ts` — slices lifted OUT of `App.tsx`: the
  button catalog + its per-device config, the hash route (`Overlay`, and which overlays are
  reload-stable — a transient one restored from a URL paints empty), the pure display formatters, and
  the `localStorage` preferences + boot snapshots. Extracted because they had no dependency on App at
  all, and because a button added or a formatter tweaked used to rewrite the file every other feature
  lives in. More of App belongs out here; these are the ones that came free.

  **`convoStart` — the bulk-close dialog's second axis.** Every cut that dialog offered was a clock,
  and a clock is the wrong instrument for the commonest piece of junk on a hundred-session list: a
  shell opened to look at a repo and never typed into. It was opened five minutes ago, so every
  "quiet for over an hour" cut steps around it, and the only button that reaches it is *All* — which
  also kills the session that is mid-turn. So the dialog grew *Only never started (N)* and *Only
  started (N)*, counts that ARE their cuts.

  It has `inactivityKnown`'s shape — THREE answers, not two — and for a sharper version of the same
  reason. `started` is any positive record (a turn in flight, a dated turn in the CLI's own log, a
  prompt in the host's history, a context reading). `fresh` needs that absence to be a MEASUREMENT,
  which is what a known conversation id buys: a fresh claude session is launched with `--session-id`,
  so the id exists before the log does. Everything else is `unknown` — and that is exactly what a
  `--continue` or `pick` resume looks like until the daemon matches a log to it. Folded into `fresh`,
  a button reading "nothing was ever typed into these" would have closed a fortnight of work; folded
  into `started`, a brand-new opencode session would sit behind a confirm it does not need. Neither
  cut holds them, and the dialog says so under both buttons rather than letting two counts quietly
  fail to add up to the scope. *Only started* is the one control here that is a `ConfirmButton`: it is
  the only cut whose whole definition is "the ones with work in them".

  **The star is a SCOPE in that dialog, not a third cut** (`LS.closeKeepStar`, default on). A star is
  the one mark in this app a person set by hand to mean *come back to this*, so it lives in
  `closeAllScope` — the single list every count and every close in the dialog reads — and not in one
  button's handler: a star that protects a session from *Only inactive > 1h* and loses it to *All*
  one tap further down is worse than no protection, because it was believed. Sparing them is the
  default and it is STICKY, since a sweep that has to be re-taught the rule on every open is one
  nobody trusts with *All*. Closing them is a real answer — clearing a finished shortlist is what a
  star is for at the end — so it is a toggle, never a guard that refuses, and the pair is drawn only
  where something in scope is actually starred. What was SPARED is said twice, because it is the half
  of a sweep nobody can see by looking at what is gone: in the scope sentence, and in the receipt.
  And *All* becomes a sentence when the scope is empty for this reason — an `All (0)` is a button
  lying about what it does, where "every session here is starred" is the fact somebody needs.
  **Back is a history STACK, not a URL diff** (`routeKey` + App's routing effects): a sheet the hash
  cannot restore serializes to the same hash as the screen under it, so comparing URLs pushed no
  entry for it and Android's Back left the app from the first sheet. Each screen pushes one entry
  keyed on `history.state` (route + depth), and landing on a screen already in the stack UNWINDS to
  it (`history.go`) instead of stacking a copy. It searches the WHOLE stack, not the entry
  underneath: a sheet reached from another sheet closes two levels down (Settings → Downloads →
  close lands on the launcher), the one-entry check missed that, pushed a duplicate of a screen
  already in the stack, and stranded the sheet's own key one level down — from which the next tap
  that opened that sheet read as "the entry below us is this very screen", unwound into it, and
  popstate re-derived a null overlay from a hash that never carried one. The sheet mounted and
  vanished on the next frame: the "clicking download just flashes the screen open and hides it
  again" report. Unwinding to the real entry keeps the stack a path of DISTINCT screens, which is
  what makes the comparison sound at all. **Superseded for a CLOSE (2026-09-28): closing a sheet is
  exactly ONE Back** (`routeStep`, pure, node-tested) — the arrow and the Android gesture must land in
  the same place, and the gesture pops one entry. "Settings → Downloads → close lands on the
  launcher" was the in-app arrow skipping the sheet the person came from, while the swipe returned to
  it; so a close (same session and focus, no sheet) whose entry below is on the same session and
  focus now goes to THAT entry, sheet and all. Everything else still unwinds to a screen already in
  the stack, so the stack stays a path of distinct screens. **Steps inside a sheet are history too
  (`backStep.ts`, `useBackStep(open, close)`).** The file browser held an opened file in `useState`
  and pushed nothing, so the swipe from a file popped the whole browser to the main view — "open a
  file, swipe back, I'm on the main view instead of the folder". Eight sheets had that shape (files,
  git diff, gallery viewer, build and capture editors, snippet editor, fan-out presets, the host
  switcher). A step pushes one entry (`stepKey`, the screen's key plus `#stepN`, so `overlayFromKey`
  still reads its sheet) and Back closes it; a close by any other route marks the slot `VACANT` and a
  microtask pops it — unless the same commit's routing effect already unwound past it or pushed over
  it, which is why that effect moves the depth SYNCHRONOUSLY before `history.go`. A pop landing on a
  dead step keeps going. A close that leaves the condition true RE-ARMS, which is how one call walks a
  folder tree up a level per Back. The depth and keys live in `backStep.ts`'s `routeStack`, shared by
  both hooks, because the Android shell is told ONE depth. `tools/backstep.test.mjs` fails a file
  that draws two sheet heads closing differently without `useBackStep`; `PadSheet` is exempt because
  its editor's arrow DISCARDS the draft, and a swipe must never delete typed words.
  **A pop is one pure decision** (`routeFromPop`, node-tested), and **it reads the
  overlay off the KEY, never off the hash** (`overlayFromKey`): the hash is allowed to forget a transient overlay — that is what
  `PERSISTED_OVERLAYS` is for — but the entry for that screen still exists, so unwinding INTO one and
  then re-deriving from the URL read "no overlay" for a screen that plainly had one. That is the
  annotator's return from the Send sheet: `setOverlay("send")` finds that screen already in the
  stack, `history.go`s to it, and popstate then dropped the user on the launcher with the typed
  prompt stranded in a draft nothing opens. The key is only trusted for an entry THIS document
  pushed (`routeStack` in `backStep.ts`, rebuilt by `seedRouteStack` after a reload) — a key that merely survived
  in `history.state` has no in-memory state behind it, which is the case the persisted list exists to
  refuse — and an entry carrying no key of ours at all is somebody else's navigation, where the URL is
  the only honest answer. **An entry with no `history.state` at all — a hand-edited hash typed into a
  running app — is instead ADOPTED**: `routeFromPop` treats it as a new screen one depth above where
  we were (`from + 1`) under the key its own URL names, and `useRoute`'s popstate handler stamps it
  there with `replaceState`, so the routing effect finds it already known instead of pushing a
  stamped twin the sheet's Back then unwinds onto. It is a pure function because this decision had been wrong twice in a way
  no test could see: it lived inline in an effect beside four `set…` calls, and the only way to
  exercise it was a phone and a gesture. `routing.test.mjs` pins it. **A document that BOOTS deep seeds its own ancestors**
  (`seedRouteStack`): a notification cold-tap, a restored hash, a `?repo=` link starts on a session
  with nothing of ours below it, and adopting that entry at depth 0 is the app saying "the next Back
  is not mine" — the shell disables its callback AHEAD of the gesture, so the swipe took the whole
  app away from a screen that plainly had one behind it. Launcher → focus → session → sheet are
  pushed as real entries, so Back lands inside our own document and never in a retired OTA bundle.
  The depth is what `window.shellBack()` answers the APK's
  back dispatcher with — depth 0 ⇒ "not mine", which is the only way the app closes — and it is also
  **PUSHED** to the shell (`ShellAndroidInterface.setBackDepth`, from the routing effect *and*
  the popstate handler, initial branch included): Android 13+ asks at the START of a predictive-back
  swipe, before it commits, and there is no `evaluateJavascript` round trip available then, which is
  why the gesture used to behave differently from the button. **Repo focus is part of that
  route** (`?repo=`, in `routeKey`): on the desktop the ↗ button opens a second WINDOW, but the
  Capacitor WebView has multiple windows off, so `window.open("_blank")` there no-ops or punts the
  URL to the phone's browser where it resolves against Capacitor's own local server and loads
  nothing — in the APK focus is a SCREEN, set in place, unwound by Back.
  `localState.ts` also holds the **pending stars**, the one place it shadows HOST state: `session.star`
  is a fire-and-forget frame, so a press with no link queued in the socket's memory, painted nothing
  (the star stayed hollow — it read as ignored) and died with the watchdog's reload. Now the intent is
  written per session id, `applyPendingStars` merges it over the host list ONCE (so rows, the session
  header and `LimitSheet`'s resume order all agree), the reconnect re-sends it — idempotent set-state
  needs no ackId and no queue entry — and `reconcileStars` retires it the moment a LIVE row shows the
  host holding the same value, which is also how a star set on another device wins.
  It also caches the two host lists that are READ with no socket — a repo's **build commands**
  (`loadBuildsSnap`, per worktree, capped, each with the instant the host last confirmed it) and the
  **schedules** (`loadSchedulesSnap`, minus the transient `running`). Both were socket-fed state only,
  so offline they rendered EMPTY, and an empty list is a claim: the build sheet — the escape hatch you
  open precisely when the link is bad — told a repo with five commands it had none and offered to
  spend tokens working them out again. Only the READING is cached; running a build and arming a
  schedule still go through the durable queue. The sheets say how old the copy is, and their empty
  state branches on `online`, because "the host says there are none" and "this device has never seen
  the list" are different facts. `ScheduleSheet` additionally draws the un-acked `schedule.save` ops
  straight out of the send queue as rows marked *queued* (upserting on the id, so an offline edit
  replaces the row it edits) — the save was always durable, but it landed in a list that then showed
  nothing at the one moment you had just scheduled something; such a row offers only *edit*, since
  running, disarming or deleting a schedule the host does not hold yet all mean nothing.
  `e2e-offlinelists.mjs`.

### `resumeRoute.ts` — the one restart that loses the route

A reload keeps the hash, which is the whole reason the route lives in one (`routing.ts`): the
watchdog's reload, a crash recovery, a pull-to-refresh all land back on the screen they left. The
Android shell's own update is the exception, and it is not ours to fix in JavaScript. Capacitor
swaps bundles with `Bridge.setServerBasePath`, whose last line is `webView.post(() ->
webView.loadUrl(appUrl))` — the bare start URL, no search, no hash. The cold launch after a build has
merely been STAGED is the same: `MainActivity` boots the WebView at `appUrl` and nothing carries the
route across. So the restart that is most likely to happen while you are mid-task — the one the app
performs on itself, unasked, once the phone is put down — was also the only one that dropped you back
on the launcher.

So the route is remembered on this device as it changes (App's routing effect, one small JSON write
per screen) and put back in `main.tsx` before React mounts, because `App` reads the hash in a
`useRef` initializer on its first render. `history.replaceState`, not a navigation: the entry
`seedRouteStack` then seeds its ancestors under has to be this one, or Back leaves the app from a
screen that plainly had one behind it.

Three rules, each of them a way "put me back" goes wrong:

- **Only when a version change was expected.** The arm is set wherever a bundle is staged, applied or
  reverted (`webUpdate.ts` — staged as well as applied, because the cold launch days later is the
  second half of the same case) and CONSUMED on the next boot. An ordinary launch therefore still
  opens the launcher — being dropped into yesterday's sheet every morning is not the feature — and a
  bundle that crashes on the restored screen cannot restore it a second time, which matters because
  the native boot watchdog needs three clean-ish launches to decide a bundle is bad.
- **Only onto a bare URL.** A document that booted with a route of its own — a notification cold-tap
  carrying `dlPath`/`imgPath`, a `?repo=` link — has already been told where to go, and that beats
  where this phone happened to be.
- **Only a URL we could have written.** Same-document, no `//`, no backslash, no control character,
  under 2 KB, and carrying something to restore (a bare `/` is the launcher, which is where a fresh
  document already is). This runs before React mounts, with no screen to report a bad navigation on.

What is stored is `routeToUrl`'s output, never `location.href`: the hash a notification cold-tap
arrives on names a file, and replaying it on the next restart would re-open a viewer, or start a
download, nobody asked for twice. The decision is pure and node-tested (`resumeRoute.test.mjs`); the
two lines that touch storage sit at the bottom of the module. A restored session id that no longer
exists degrades to the launcher by construction — `active` is a `find` over the session list — and
the keys are swept by `BootGuard`'s hard reset like every other piece of view state.

### `storage.ts`

- `storage.ts` — **every `localStorage` key this app owns, in one place**, plus the four readers each
  of thirty files was re-writing (`lsGet`/`lsJson`/`lsSet`/`lsSetJson`, which swallow the private-mode
  and quota throws once instead of forty times). Sixty-seven keys as string literals had made three
  things unanswerable from any one file: whether a key SYNCS (the `LS` groups say so, and `SYNCED` is
  checked against `shared/settings.ts`'s allow-list at load, so the two cannot drift silently),
  whether it still exists (a renamed key left the old literal in the file nobody grepped, and the
  symptom is a preference that quietly reverts), and what shape it holds. A registry, NOT a wrapper
  you must remember: the cross-cutting rules still live in `settings.ts`'s `setItem` patch, for the
  reason that file states at length. `tools/eslint/rules.js` refuses a new `waterplane.*` literal outside
  this file.

### `Sheet.tsx`

- `Sheet.tsx` — `Sheet` (full frame) and `SheetHead` (the head alone). Thirty-three files were
  hand-rolling the same back button and `.brand` — forty-six copies — which is thirty-three chances
  to get the CLOSE affordance wrong on the one screen where a phone has no other way out, and the
  reason `.sheet-head`'s CSS carries three separate comments about buttons pushed off the right edge
  is that the markup they were written against was copied, not shared. Existing sheets keep their own
  `div.sheet` (several have a second head or a footer that is not `.sheet-actions`); `Sheet` is built
  from `SheetHead`, so the two can never drift.

### `Empty.tsx`

### Queued and scheduled, said as numbers

The launcher counted sessions well and work badly. Per repo it showed `coding`, `done`, `exited`,
`starred`, `limit` — five states a SESSION can be in — plus a queued-session-open chip that rendered
the bare word **"queued"** with a spinner and no count (the number appeared only past one, so the
common case said nothing). Work *waiting* on a repo appeared nowhere: eleven prompts queued against
a checkout looked exactly like none. Schedules were a bare calendar icon.

Two chips fix it, and one pure rule underneath.

**Waiting commands, per repo** (`queuedByRepo`). Two sources counted as one number, because nobody
thinks of them as two lists: send-queue entries for that `cwd` (words still on this phone) and
intents the host is holding in `queued`/`blocked`. Standing RULES are excluded — the schedules chip
counts those, and they belong to no single repo anyway. A one-off with a clock is NOT excluded any
more (`isScheduleRow`, not `trigger.kind === "at"`): it is a backlog row now, so a header saying 2
about a backlog holding 9 was the same "where did my item go" the whole recurrence change is about.
It is therefore counted here AND on the schedules chip, which is not one list counted twice — one is
*what this repo is waiting on*, the other *what fires on a clock, host-wide*, and each tap opens
exactly what it counted. `failed` is
excluded too: a failure is not *waiting*, it is triage, and Activity is where it lives. Archived
rows are excluded for `activityRows`' reason — archived is the store's own "I have seen this", and a
badge that keeps counting them can never be cleared.

**The horizon, on the schedules button** (`scheduleHorizon` / `horizonWords`, `@waterplane/shared`,
node-tested). A count alone does not answer what people ask of a schedule list: *"7 scheduled"* is
the same badge whether all seven fire tonight or the next is a fortnight out, and those are opposite
situations. So the chip carries the two nearest non-empty buckets — `2 in 24h · 5 more in 2d`.

Three rules in that sentence, each a way it would otherwise mislead:

- **The buckets are DISJOINT, and the word `more` is what says so.** Cumulative counts read as a
  total that keeps growing, and "2 in 24h and 5 in 2d" then means 5 to one reader and 7 to the next.
- **An instant already behind us is `soon`, not `later`.** A missed occurrence inside its grace is
  the most urgent row in the list; bucketing by raw distance files it beyond a week, on the wrong
  side of zero — the one arithmetic slip that makes the most urgent thing the least visible.
- **`unarmed` is its own count and never folds into `later`.** "Not coming at all" and "coming in a
  fortnight" are opposite, and only the first is actionable. With nothing armed the chip says
  `2 not armed` rather than going quiet, because silence there reads as *nothing is scheduled* when
  the truth is *everything scheduled is stuck*.
- **A spent one-off is not counted at all** (`isStandingSchedule`). `unarmed` is for rows a person
  can act on — switched off, or a `window` rule still waiting for its first usage reading. A one-off
  whose instant has passed is neither: `nextFireAt` answers null for ever, so *not armed* names a
  state with no way out, and counting it into `total` put a permanent `10 not armed` on a launcher
  whose desktop was holding nothing pending. Tapping that number then opened
  `showing the not armed · 10 of 10`, which is the filter working exactly as designed over rows that
  should not have been in the list. They are Activity's rows — one row for a thing's whole life,
  with what it produced and where it ran — and `ScheduleSheet` names them in a sentence at its foot
  with a tap that opens exactly those. **The same function makes the count and the cut**, which is
  this file's standing rule about a number on a control.
- **The pool is two kinds of thing and the sentence says which** — `N rules · N on a clock in a
  backlog`. The chip has always counted every `at` row and still does, through the one
  `horizonBucket`, so its tap opens exactly what it counted whichever kind those rows are; what
  would be untrue is calling nine backlog rows "rules". `ScheduleSheet` draws the first kind as
  cards and the second as a directory of doors, and the same edge cuts both.

Empty says **nothing at all** — a badge reading "0 scheduled" is a badge that teaches people to stop
reading badges. It counts `intents` directly, so it counts the same `nextAt` instants the host will
actually fire rather than a second computation of them, and it rides the launcher's existing 30 s
tick rather than starting a clock of its own.

### The schedule card: one string, once

`ScheduleSheet`'s card had the same prompt on it three times, in three lengths. The header printed
`ScheduleEntry.name`; the body printed `act.text.split("\n")[0].slice(0, 110)`; and `name` is not a
name — when nobody types one the host fills it with `action.text.split("\n")[0].slice(0, 120)`
(`scheduleToIntent`, and back out through `intentToSchedule`). So the header was a 120-character cut
of the body's 110-character cut of one sentence, each then ellipsised again by CSS at whatever width
the phone happened to be. The screenshot that started this ended a card on **"already fi"**.

Four rules came out of it, and they are rules about the whole app, not about this sheet:

- **A typed name and a derived one are different facts, and one function tells them apart.**
  `typedName` (`shared/schedule.ts`) is that function: trim both, no name ⇒ nothing, no prose ⇒ the
  name stands (a build or a capture has no prose at all, and `startsWith("")` is vacuously true —
  without the guard every such name would be reported as a truncation of nothing), otherwise null
  when either string is the other's leading slice. The comparison is symmetric because either side
  may be the shorter one. `sliceLen` is the caller's fact: the host cuts at 120, `Backlog.add()` at
  40. Three surfaces ask it now — the backlog's `realLabel` is a two-line delegate, the schedule card
  asks it of `name`, and `activityRows` asks it of `Intent.title`. Two copies of this rule is how one
  screen titles a row by a fragment the other one hides.
- **Prose is clamped by LINES, never by characters.** A character slice cannot know where a word
  ends, and its output is indistinguishable from the text itself — which is what makes "already fi"
  read as content rather than as a cut. The card now renders `act.text` WHOLE inside the app's one
  three-line clamp (`.bl-text` / `.bl-text-btn`, the backlog's), tapping opens it, and there is one
  such clamp in the CSS on purpose: a second copy is how two screens end up a line apart with nobody
  able to say which is right. Not `mono` either — monospace says *this is a command*, and a scheduled
  prompt is the same kind of sentence the backlog and Activity render in the UI font.
- **One vocabulary per question.** On this header the `SyncChip` answers WHERE the rule is stored, the
  tag beside it answers WHEN it fires, and the rule line answers WHAT it is. The card broke that
  twice: an `already spent` tag sat in the WHEN slot (reading as a time), and `no next run` was a
  third spelling of a bucket the launcher chip and this sheet's own filter bar both call
  `not armed` — so `HORIZON_LABEL.unarmed` is the word. `paused` and `off` stay, because they are not
  another name for unarmed, they are the REASON it is. The `one-off`/`repeats` chip went the same way:
  `describeRule` now leads with the kind (`every Thu · 16:00`, matching `once · …`), which is what
  lets the card drop the chip — the section headers keep the grouping and the count, but they are not
  sticky, so a card scrolled past one has only its own lines to go on.
- **A refusal is said at the level it is TRUE at.** Offline, `pause/resume`, `on/off`, `skip next`,
  `delete` and the repo-`session` button are all absent, which is right — `Unavailable.tsx` exists
  because a dimmed `.approve-btn` is indistinguishable from a live one on a phone with no hover. But
  the *reason* is one fact about the link, and putting it in each row's `<Unavailable>` printed the
  same two sentences under every card in the list, burying the per-row facts that genuinely differ
  (this save is queued; that one gave up). So the connection-shaped reasons are compared out of
  `cants` (`SHEET_WIDE_REASONS`) and the sheet's single banner names every verb the dead link takes
  away — plus *edit*, named as the thing that still works, because a save is a durable op that
  upserts on its id. Per-row `<Unavailable>` survives for per-row facts.

Two things that looked like features were dead code. `spent = isSpentOnce(e, now)` was constantly
false on every card that renders: `sorted` is `all` cut by `isStandingSchedule` against the same
`now`, and the two are negations of one function. There is no timer here either, so a row cannot go
spent under a reading thumb. Bringing that chip back would reopen the disagreement `SPENT_ONCE_TEXT`
was written to close — this sheet called such a row *already spent* while Activity, which owns it,
buckets a one-off the desktop slept through as `failed`. For the same reason the foot's sentence no
longer claims the spent one-offs **ran**: `isSpentOnce` reads the CLOCK and nothing else, so it says
they have *been and gone — run or missed, Activity's row says which*, under a `History` icon rather
than a green `CircleCheck`. A tick over a missed run is the same lie in an icon.

### Updates: checked often enough to matter, and said where you are looking

Two halves, and the second is the one that was actually broken.

**How often.** The shell asked the desktop what bundle it was serving every **30 minutes**, and only
on that timer — which is a long time to run last week's UI when the desktop has served the new one
since breakfast, and worse than it sounds: a backgrounded APK is FROZEN (`shellLink.ts`), so the
timer does not run at all while the phone is away. The floor is 5 minutes now, but the floor is not
the mechanism: the two triggers beside it are picking the phone up (`visibilitychange`/`focus`,
rate-limited to one ask a minute) and the socket coming back (`SHELL_NUDGE_EVENT`) — the two moments
a person is present and the two moments a stale bundle is about to be used. `check()`'s own doc
already said it was "cheap enough to run on every reconnect"; nothing was calling it there.

**Saying so.** Everything up to the last step was automatic — check, download, verify, stage — and
then the new bundle sat there, complete and unused, because the only way to apply it was a button on
a settings page nobody opens. `watchAutoApply()` had closed half of that (it restarts once the phone
is put down); `UpdateBanner.tsx` closes the other half, for the case where you are holding it and
would rather have the new one now.

It is mounted in `main.tsx` beside `HintLayer`, `ToastLayer` and `ConfirmHost` — the fourth
subsystem to need the same fix for the same reason: **`App` returns early once per overlay**, so a
banner rendered inside it would vanish the moment anybody opened a sheet. It renders for the
`staged` phase and no other: `downloading` is progress nobody asked to watch, `error` belongs on the
settings screen with the retry beside it, and a bar that says "up to date" is a bar that trains
people to ignore bars. It never applies anything on its own — a restart discards whatever is being
composed in memory, which is `ws.ts`'s `reloadGuard` argument exactly — and its dismissal is keyed to
the BUILD, so waving away this one cannot hide the next.

**"Not now" had one duration, and it was wrong for the phone that gets reloaded.** The × is
in-memory on purpose — a reload is exactly when being told again is useful, since a reload is what
takes the build — but not every reload is a decision anybody made: the wake watchdog reloads on a
bad resume, a cold start reloads, a navigation in the APK reloads. A phone in the middle of
something is then asked the same question a dozen times, and the answer it is being asked to give
costs whatever is half-written in a box. So there is a second, durable answer beside it: **snooze,
per build, for a span you pick** (`updateSnooze.ts`, pure and node-tested). One fixed window was the
first version and it was wrong in both directions — four hours is far too long for "give me two
minutes to finish this message", and too short for "not today" — and the short end is the one that
was actually missing, since the reason this bar gets waved away is almost always a sentence
half-typed. So the clock opens four spans in the bar itself: **5m · 1h · 4h · 1d**, shortest first,
under the thumb that just tapped it.

**Chips in the bar, not a dialog.** `askConfirm` is destructive-only by construction (its primary is
danger-red), and this is a preference; a modal to answer "not for five minutes" also costs more taps
than the thing it is postponing. While the spans are out the sentence becomes the question, *Restart
into it* is not offered beside them, and the clock stays put and takes the choice back — so the way
out of the question is never the × that hides the bar. The bar wraps rather than squeezing the text.

Spans end, none of them is forever, for the same reason the insecure-origin banner is snoozed a week
rather than dismissed — a build that is verified, staged and never taken is the old build still
running. Keyed on the build id like the dismissal, so a newer bundle is a new question; and a stored
`until` further out than the LONGEST span on offer reads as NOT snoozed, which is what a phone that
corrected its clock or changed timezone looks like. It hides a bar and nothing else: `watchAutoApply()`
still restarts once the phone is put down, snoozed or not.

**The APK itself is a different question and is not answered yet.** The web layer updates over the
air; the shell around it does not, and nothing knew what version of the shell it was running.
`ShellUpdatePlugin.info()` now reports `versionName`/`versionCode`, read from the package manager
rather than from a constant in the bundle — `shellLink.ts`'s `PROTOCOL_VERSION` argument, since the
bundle updates while the binary does not and a constant shipped in it would drift away from the APK
it claims to describe. That is groundwork with no consumer: comparing it against *something* needs a
decision about where a new APK comes from, which the README's "sideloaded by design" does not settle.

### The next prompt, decidable from where the turn is being watched

Sending a follow-up while the agent works already had two answers and both were made BEFORE the
send: the compose chevron's *now* types it straight into the working session, *hold until idle* parks
it until the turn ends. What there was no way to do is **change your mind** — which is exactly when
you find out you want to. The turn goes somewhere unexpected and the queued follow-up should land
NOW; or one fired off reflexively should have waited rather than being glued onto the CLI's composer
mid-thought.

Both verbs already existed (`sendQueuedNow`, `toggleHoldQueued`) and both lived in a sheet two taps
away, on a row you had to identify first. On the screen where the progress is actually watched there
was nothing: the queue bar says *"3 queued"* about the WHOLE queue, not about the session in front of
you, and offers neither verb for one message.

`NextPrompt.tsx` is one strip directly above that bar, and `nextPromptState.ts` is the decision, pure
and tested. **The words, not a count** — recognising your own prompt is what the count could never
give. **One verb, and it is the one that is not the current state**: a parked entry offers *send now*,
an un-parked one offers **`when it's free`** — the composer's own words, not a fourth spelling of one
decision; two buttons where one is always a no-op is how a strip this small stops being read. **A refusal is a sentence** — with a dialog open or a limit block, *send now*
would type prose into a menu, so the button is not rendered and the wall says itself.

**It reads BOTH holders now.** Since *when it's free* became the desktop's (above), the prompt
somebody is waiting on is routinely a work item pinned to this session on the HOST and not in this
tab's queue at all — and the strip simply went blank for those, so the composer said nothing about
words that were definitely going to run. `nextPromptView` takes a second input, this session's
pinned items in run order, and `NextPromptView.holder` says which machine is sitting on the row.
The phone's own lane goes first when it has anything: not a ranking of importance, but the fact that
a parked entry is IN FRONT of the pinned one and nothing else knows it exists, so naming the
desktop's head as "next" would name the wrong prompt. On a desktop row *send now* is `backlog.fire`
and the third button is **backlog** (this repo's waiting work, the only list that can reorder or
cancel one) rather than **queue** (the phone's transport); the wait verb is not offered at all,
because a pinned item is waiting by construction. A dead link is not a wait for that row either —
the desktop runs it regardless — so the sentence says the TAP is what the link blocks, never that
the prompt is stuck.

**And the wait verb hands the words to the DESKTOP too.** It called `toggleHoldQueued`, which parks
the entry on THIS PHONE — so *Send* into a busy live session, then tap the strip, then lock the
phone, and nothing was ever delivered: the second holder this whole change removed from the
composer, put back in two taps from the same strip it was removed from. It is `handToDesktop` now —
the same `retargetEntry` the queue sheet uses, into `backlog` mode aimed back at the session it was
already for, with `autoFire` set (that flag is what makes it a pinned item rather than one waiting on
the global switch; `retargetEntry` knows nothing about what *when it's free* means) and a fresh
ackId, because what goes up is a different message on the wire. The phone keeps exactly one lane: a
session that does not exist yet has no id a pinned item could name, and the toast says which machine
is holding the words either way.

**A pinned row is drawn even on an idle session.** "The host fires it within a tick" is a fact this
tab owns about its own queue and a GUESS about the desktop's: a pinned row can be held on the budget
gate, the global auto switch, a usage limit or an answer the agent is waiting for, and none of that
is visible from here. Hidden, the session screen said nothing at all about words that were
definitely going to run — blank strip, blank queue bar (the row is not in this tab's outbox), and a
badge. So the flicker guard stays for the phone's own lane and `pinned` comes through it, wearing
**the host's own sentence** (`backlogWaiting[id]`, the same map the Backlog sheet draws under a row)
rather than anything this side would invent. With no turn in flight it says *the desktop runs it
when this session is free* instead of claiming a turn to wait for, and offline it appends
`· as of <age>`, because `pinned` is then the last synced snapshot and "the desktop is holding it"
asserted from a copy nobody has checked is a claim about right now.

The ladder is four facts that do not agree in the obvious order, which is why it is tested: **a wall
outranks the link** (a reconnect changes nothing while a dialog is open), **the link outranks the
park** (nothing goes anywhere without one), and **the park outranks a turn in flight** — a busy turn
is NOT a wall, because typing into a working session is what every un-parked entry does anyway, and
that distinction is the whole reason *send now* is allowed to beat the park at all. It shows only
while the session cannot take the entry anyway: with an idle, reachable session the strip would
appear for the half-second before the queue drains, which is flicker rather than information.

One mount serves both faces of the session screen — the terminal, where the CLI draws its own
spinner, and the reader, whose working line is its own strip — because they are one screen.

#### The progress indicator this was actually about: the upload row

The first cut aimed at the TURN spinner. The marked screenshot was of the **upload row** — a 99%
progress bar with `Send waits for uploads` beside it and **Send dimmed out underneath**. Same two
verbs, a different blocker, and a worse starting point: a dimmed button whose `title` is invisible on
a phone is exactly the shape `Unavailable.tsx` exists to forbid, sitting on the one screen where
somebody is sitting and watching.

The block was also **obsolete**, and `runUpload`'s own comment had already noticed it: *"the transfer
is the queue's now, but it is still the thing blocking Send"*. Once the bytes are PARKED the path is
in the text, `guardUploadRefs` adopts that upload into this lane, and one-delivery-per-lane makes the
prompt wait for the picture by construction — `releaseLane()` at the end of `runUpload` is that rule
firing. Blocking the composer on top of it bought nothing.

So `inflightRef` was split. It counted encode+park AND the POST and gated Send on the sum; `parkingRef`
is the encode/park window alone — the only one in which sending is genuinely premature, because the
text has no path in it yet. It is milliseconds, it refuses in words, and Send is **never disabled
again**. The row itself carries the two verbs, one tap each, in the queue strip's wording: *send now*
(which cannot outrun its own attachment — the lane still holds it) and *let it wait*.

The other half of the same moment is the instant AFTER you send: `nextPromptState` now recognises an
upload ordered ahead of the prompt in its lane, says *"waits for the picture it names to finish
uploading"*, and does not offer *send now* there — nothing can make a prompt jump the bytes it names,
and a tap that changes nothing is the one answer this app refuses.

### *Queue here* — building a run for the session you are in

> **Since the collapse:** the compose bar's `composeQueueHere` is GONE as a separate mode. What it
> did is what *when it's free* does now — one holder, the desktop — and the per-ROW *queue here*
> below is the same decision made on words already written down. The mechanism in this section is
> unchanged; only the second spelling of it went.

The compose bar had `composeQueueHere` for a while: type words, tap *queue for this session*, and
they become a work item aimed at that session with its own auto-fire flag, appended to the bottom of
the queue so several taps run in order. What it could not do is the far more common shape — a
backlog with fifteen things already in it, a session open on screen, and the wish to run four of them
**here**, in the order you tap them. Fire could only run one, now, into whatever session the repo
happened to have; nothing could BUILD a run.

The mechanism was already whole and only the tap was missing. `BacklogItem.autoFire` maps to
`Intent.pinned`, whose meaning is stated in `intentVerdict` itself — *"the same exemption for work a
person aimed at one session themselves"* — and `sessionBlocker`'s `busySessions` check already means
one item at a time per session. So the change is a field, not a mechanism: `backlog.update` carries
`autoFire`, `IntentPatch` carries `pinned`, and one tap sends **one** message that says three things
at once — aim it at this session, exempt it from the global switch, and move it to the bottom.

**The bottom is the point.** The taps ARE the order. A row that kept its month-old `order` would jump
the queue it was just added to, which is the one thing "build up a queue" must not do. `add` has
always done this for the same flag; `update` now does it for the same reason, and only when the flag
is being SET — un-queueing is not a re-ordering.

**A patch that says nothing about the flag must not clear it.** The patch is spread over the row, so a
bare `pinned: undefined` from an ordinary label edit would silently un-queue everything a person had
just queued. Hence the conditional spread in `backlog.ts`'s `update`, and a test that edits a label
and checks the flag survived.

The button is **absent, not dimmed**, wherever it cannot act — no live session on screen, or one in
another repo — and the sheet states the rule ONCE at the top instead of repeating a sentence down
twenty rows, in the wording that matches which of those it is. Tapping it again takes the item back
off: a queue built by mistake has to be unpickable by the gesture that built it.
`packages/host/test/queuehere.test.mjs` pins the three silent failures.

**It needed no new view, only wayfinding.** The sheet already groups a repo's items BY TARGET SESSION
and already numbers them down the left, so *queue here* lands an item in a visible, ordered queue for
free. What was missing is that with three sessions open in a repo there were four identical-looking
groups and nothing saying which one a tap had just added to — hence the `on screen` marker on the
group that is the session behind the sheet.

### The lost photo, and the button that was never reachable

Reported from a phone on a bad link, twice: *"a send and run command loses the image, and then a
restore send shows that only wants to send the filename of the not sent image."* Two independent
defects, both in the path a poor connection actually takes.

**The retention was armed for the wrong case.** `retainUploadBytes` — *"what makes re-attach a button
rather than an apology"* — was called from the two places a person DISCARDS an upload
(`dismissOutbox`, `removeQueued`) and from nowhere in `failOutbox`. So when the transport killed an
upload by itself, which is the only way it happens on a bad link, the path went into `dead` and never
into `kept`. `attachState` ranks `kept` above `dead` precisely so that a dead upload whose bytes are
still here reads as one tap from fixed — and that rank never got to matter, because nothing ever put
the path in `kept`. The strip drew *"not uploaded"* with nothing to press. **The bytes were in
IndexedDB the whole time**, under the failed row's own ackId.

The tell was already in the code: `guardUploadRefs` refuses such a send with *"Re-attach it before
sending."* It had been telling people to press a button that, in this exact case, was never rendered.

The fix retains on failure too — **without dropping the ackId copy**, because a merely-failed row can
still be revived under the same ackId by `retryFailedQueued`, which flushes from `uploads/<ackId>`.
Deleting it there would revive an entry with no bytes and fail it on the first attempt with the only
copy somewhere the flusher does not look. Two copies for as long as a dead row lives, bounded by
`KEEP_CAP`; the revival paths drop the kept one.

**And Restore was offering a filename as a message.** It picked the newest failed row that was not an
op — ops excluded because their `text` is a description (`open usmc · main`) rather than something
anyone wrote. An upload's `text` is the same kind of thing: `file · 1000074239-….jpg`. So a failed
upload was restored *as prose*, and the send sheet opened holding the NAME of the picture that had
just failed to arrive, ready to post it as a prompt — the exact thing the person was recovering from.
`restorableFailed()` is that rule, pulled out and tested, and when files are all that failed the bar
says so and points at the attachment's own button instead of pretending it has text to give back.

### "No downloads start at all" — a row stranded in `downloading`

Two causes, one symptom, and only the second was still live.

**The first was the 403.** A Background Fetch is issued with no `Origin` and `Sec-Fetch-Site:
cross-site`, which the host's gate refused until `OPAQUE_READ_ROUTES` (2026-09-02); `pull.ts`'s own
comment records the consequence — *"a record that looked untouched, re-registered on every launch,
and the row said 'waiting to start' for ever"*. `bgBlocked` and `recoverBackgroundFetches` landed the
same day. Verified end-to-end against the live `tailscale serve` front door afterwards: the Background
Fetch shape returns 200, a `rangeFetch` resume returns 206 with `content-range`/`etag`/the CORS expose
headers, and the stat probe returns 200.

**The second is the state itself.** `state: "downloading"` is a claim about an ENGINE, and the engine
lives somewhere the record cannot see: in the page (`rangeFetch`, tracked by the in-memory `active`),
in the browser (Background Fetch), or in the native service (`nativeOwned`). Lose the carrier and the
row is stranded in the one state nothing ever picks up again — `pumpEligible` takes only `queued`
(**even under `force`**, so no tap reaches it), `watchdog()` returns early when there is no `active`
to watch, and `whyIdle()` inspected queued/paused/failed and so was silent about the single case
where the queue is genuinely stuck with a spinner on it. The row then reads *"waiting to start"* for
ever with nothing anywhere to act on.

`start()` already unstranded these at BOOT, which is why a restart cured it and why the bug reads as
intermittent. `strandedDownload()` asks the same question while the page is still running — so the
answer is "it fixes itself on the next heartbeat" rather than "restart the app" — and `whyIdle()`
answers it first, because it outranks every other reason: those are all about rows that WILL run.

The rule is pure and pinned (`downloadState.test.mjs`) because it is the direction of its errors that
matters, not its verdict: a carrier that outlives the page — the native service, or a Background Fetch
the browser is still carrying — must NEVER be called stranded, since re-queueing one starts a second
copy of a live transfer. So `bgLive` is the caller's answer from the registration and never a guess
here, and a `native` row is stranded only once the platform that would be carrying it is not even
present.

### Text and icon size, as a setting

Asked for as accessibility and taste: *"being able to define font and icon size so it matches the
individual abilities."* It is a setting at all because of two facts about this codebase, neither of
them an accident — **every font size in the app is a `font-size: Npx` in ONE stylesheet** (298 of
them, 20 distinct values), and **every icon is a lucide `<svg>` that renders its `size` prop as a
`width`/`height` ATTRIBUTE** with a `lucide` class on it. So one multiplier on the root reaches all
298 through `calc()`, and a second reaches all fourteen distinct icon sizes through one
attribute-selector rule each. No component had to learn about this, and none can forget it.

**Icons could not ride `calc()`** — no stylesheet can multiply an attribute. But CSS `width`/`height`
OVERRIDE the attribute, so `svg.lucide[width="14"]` scales every icon drawn at 14 while keeping the
relative sizing components chose: a 12px chip icon stays smaller than an 18px header one. Scoped to
`.lucide` deliberately, because the app draws its own SVGs too — the pulse spark, the context graph,
the usage charts — and those are DATA. Scaling them would move the plot, not enlarge it.

**Per device, like the theme, and harder.** `shared/settings.ts` argues the theme case at length; a
phone at arm's length and a 27-inch display want different numbers out of the same pair of eyes.
What travels is the person; what does not travel is how far away the screen is.

**Two knobs, not one.** A single "UI scale" is tidier and answers the wrong question. Text too small
to read is an ability; an icon too small to hit is a thumb — this app already treats tap targets and
legibility as separate complaints, and wanting big text with compact chrome is not a contradiction.

**The clamp is on the way OUT, and it is the point of the tests.** These are numbers in
`localStorage` — a file a person can edit, and a place an older build may have written a different
range into. A 4× that survived would render an app nobody can reach the settings screen in to undo
it, which is the one failure this setting must not be able to cause. Unparseable reads as 1 and never
`NaN`, because `calc(13px * NaN)` is an invalid declaration and an invalid declaration drops the whole
rule — a typo in storage would UN-STYLE the app rather than mis-size it. The pure half lives in
`uiScaleSteps.ts` for the reason `downloadState.ts` and `costNotice.ts` do: a module that imports
storage cannot be loaded by a test.

**Two things are not CSS and are pushed**, exactly as `theme.ts` pushes its two: `index.html` sets
both properties inline before the bundle parses (a size applied when React mounts is a frame of the
wrong LAYOUT on every cold start, which is worse than a wrong colour because it moves things under a
thumb already travelling), and the TERMINAL is a canvas — `Terminal.tsx` reads the size for xterm's
`fontSize` and refits on change, since a cell-size change is a geometry change and the report that
follows is what resizes the PTY.

**That report was missing for as long as the setting existed.** The scale handler set `fontSize` and
called `fit.fit()` and stopped there, so xterm measured a new grid the host was never told about: the
CLI went on painting at the old cols and rows and the space the new size bought stayed blank until
something else — a keyboard opening, a sheet closing — happened to fire the ResizeObserver. A size
knob that only does half its job is indistinguishable from one that does not work.

#### The console's own zoom

Asked for as *"console zoom buttons so I can see more text on screen"*, which is **not** the question
the text scale answers, and that is the whole reason it is a second knob. Text size is about
eyesight and is right to be global; this one is about how many COLUMNS AND ROWS the CLI gets — a
smaller console font is a bigger grid, the fit reports it, the host resizes the PTY, and the TUI
redraws itself wider. The two wants are opposite as often as not: lists and sheets comfortably large,
the terminal dense enough that a diff stops wrapping.

It **multiplies** the text scale rather than replacing it (`termFontPx` in `uiScaleSteps.ts`, the one
place the rounding and the clamp happen), so somebody who set "larger" because they cannot read 13px
keeps that everywhere and zooming the console moves them relative to it. Its ladder is wider than
`TEXT_STEPS` in both directions because what stops those is the LAYOUT — two-line rows wrapping to
three — and a canvas that redraws in whatever cell size it is given has no such edge. What bounds it
instead is the pixel result: `TERM_PX_MIN`/`TERM_PX_MAX`, because 6px is not "dense", it is a smear a
person then has to undo, and the control that would undo it is in an app the text scale just shrank
too.

**At either end of the ladder the spent direction is not rendered** (`Unavailable.tsx`'s rule, and
`nextTermZoom` returns `null` to say so) — a dimmed button and a live one differ by an opacity nobody
reads on a phone. Nothing vanishes unexplained, because the readout between the two buttons is
carrying the size and says *smallest* / *biggest* when it is one. That readout is also what tells a
zoom that did nothing from one the clamp flattened, which is why `nextTermZoom` SKIPS a step whose
pixel result is the size already on screen rather than offering a button that visibly does nothing.

**Where the buttons are is not a detail.** They were a toolbar item first, and that was wrong twice
over: the toolbar is collapsed behind a burger by default on a phone, so the control for *"I cannot
see enough"* lived inside a closed menu, and it is a row you scroll sideways, so reaching it meant
losing sight of the only feedback this setting has. They float in the terminal's own top-right
corner instead — ABSOLUTE, never in the flex column, for `.conn-banner.floating`'s reason: a strip in
flow takes height off the terminal, a terminal that changes height refits, and a refit SIGWINCHes the
PTY, which the TUI answers by clearing and repainting the whole screen. A control whose job is to
resize the grid must not resize it by existing. It is a SIBLING of `.term-canvas` so a tap on it is
not also the canvas's "let me type here" tap in CLI mode, and it is not drawn over the CARD
explanations (a session that has not started, nothing cached) — there is no grid to resize yet, and
that corner is where the card's own words are.

**Typing room wants the same corner.** With the caret in the box the header is pulled out of flow and
its two survivors — outline and menu — float at the top right of `.screen`, which is where the zoom
pair already is: two controls stacked in one spot, one hittable and one not. The zoom drops below
them, keyed on the `data-typing` attribute `App` already stamps on `<html>`, so nothing has to be
threaded down into the terminal for it to know.

**No size on it.** A "10px" pill sat between the buttons for a build and was cut, because it answers a
question nobody standing in front of a terminal has: the text got smaller, which you can see, and the
number it got smaller TO is not something to act on — over live output it is one more thing in the
way. The pixel figure stays on the Appearance row, where the setting is being READ rather than used.
What survives in the corner is the END of the ladder, as a word: there the button itself is gone
(`Unavailable.tsx`: never a dimmed one), and a control that disappears without saying so is exactly
what that rule exists to stop.

The other entry point is the Appearance section, under the two knobs it multiplies, which is where
you go looking for a setting rather than where you use it.

**The reader/CLI switch moved into the group**, and off the header. It lived there because that row
survives a collapse — but full screen hides the header outright, so the one control that swaps the
whole view was missing from exactly the layout people read a long turn in, and the way back to the
terminal was to leave the mode first. It also belongs with these two by kind: full screen, zoom and
reader/terminal are the three decisions about how the view LOOKS, and the header is a row of session
VERBS. Its old rules come with it unchanged — no `active` highlight (the icon already flips to the
DESTINATION, and highlighting it in read mode painted a selected-looking terminal icon, i.e. the
opposite of the truth), and a backend that keeps no conversation log has no switch at all rather than
a greyed one.

That is also why the terminal's group no longer stands down over the full-card explanations. It drops
the ZOOM pair there — a blank terminal has no grid to make bigger — but the two controls that decide
which view you are in stay, or a phone opening an offline session with no bytes on disk would have no
way to the transcript it does have.

**The reader gets the same corner group**, because "I want to see more of this" is the same question
asked about the other document — but it keeps its OWN stored zoom (`waterplane.readerZoom`). A terminal is
a grid whose size the host is told about; a transcript is a page that reflows. Wanting the CLI dense
while the conversation stays comfortable is not a contradiction, and one value would have made every
console zoom a decision about reading.

The mechanism differs with the surface. Nothing is pushed at the reader: every size in the transcript
is already `calc(Npx * var(--ui-font))`, so the whole document re-sizes by overriding that ONE
property on its subtree — one repaint, no component told anything, the app-wide text setting's own
trick scoped to a branch. The wrapper carrying it is `display: contents`, so `.tr`'s `height: 100%`
still resolves against `.term-wrap`: the buttons must not move the thing they resize. What the reader
clamps is the PRODUCT (`readerScale`, 0.6–1.9) rather than either half, since the text setting is
already a factor in it — 0.45 of the app's smallest text is a page nobody can read the way out of,
and the way out is drawn at a size this very number owns.

Full screen follows it there: `fullMode` no longer excludes the reader, since the exit button is now
drawn on both surfaces — which was the only thing that gate was protecting. The special-key row is
the one thing that does NOT come with it (`.screen.typing.fullscreen.reading .keys`): in the terminal
those keys are the only way to answer a CLI with no keyboard up, and in the reader they answer a CLI
that is not on screen.

**The preview chips defeat their own rules on purpose.** The text chips carry a plain-px inline
`font-size` and the icon chips an inline `width`/`height`, because an inline style beats the
stylesheet and is not an attribute — otherwise each chip would render at the size it sets TIMES the
size already in force, which is how a preview lies.

### `syncState.ts` + `SyncMark.tsx` — is this anywhere but this phone?

Everything a person AUTHORS here is written locally first and synced afterwards —
prompt templates, the toolbar, hidden repos, the fan-out presets, and above all the PAD, which is by
design the last copy of words nobody has decided about yet. The write lands in `localStorage`,
`settings.ts`'s patch stamps and pushes it, the screen shows the new value at once. That is right,
and on this app's link it is also a lie of omission: **the value looks identical whether the desktop
has it or whether it is sitting in a phone that has been off the tunnel for a day.**

Nothing new goes on the wire for this. `routes/system.ts` already broadcasts `settings.update` to
every socket *"the writer included: the echo is what confirms the write landed"* — and
`applyRemoteSetting` recognised that echo, for years, only to drop it on the next line:

```ts
if (ts <= known) return; // our own echo, or a value we have already beaten
```

The receipt arrived and was thrown away one line before it could be recorded. `syncState.ts` is
where it goes instead, fed from the three points the truth already passes through: the `setItem`
patch (a local write is now outstanding), `applyRemoteSetting` (the echo), and `mergeSettingsDoc`
(the reconcile that lands on every connect, which is what makes a COLD START honest rather than a
stored guess).

**Four states, and none collapses into another.** `synced` / `pending` / `offline` / `superseded`.
`pending` and `offline` are split for `useRemoteResource`'s reason — *"waiting for the desktop"* and
*"there is no desktop right now"* are different sentences and only one is a reason to look for a
problem. `superseded` is **not** a failure: the HOST is last-write-wins on the whole value, so another
device's copy winning is an ordinary outcome a person nonetheless has to be able to see, and the
sentence says `nothing of yours was deleted` because the pad MERGES on adopt (`shared/pad.ts`, per
note) — which is what makes that true.
`unknown` is the fifth and renders **nothing** — the window between a cold start and the
`settings.all` on hello has no honest answer, and that window is exactly when a confident "synced"
would do the most damage. Nothing is persisted, for the same reason.

`SyncMark` is prose, not a dot. **A dot is the thing this replaces** — the green light beside a sheet
that has not reached the desktop since Tuesday — and the good state says so out loud rather than by
absence, because silence is what the broken version looked like. Mounted on `PadSheet`,
`SnippetSheet`, `FanoutSheet` and the Settings sheet; the colours are the app's existing semantic
four, since a fifth palette for a fifth subsystem is how "at limit" ended up being five colours.

#### The green check, and why muted was wrong

The first version drew `synced` as a **muted cloud**, on the argument that a reassurance should not
shout. That mistook the question being asked. *"Can I put the phone down now"* is answered yes or
no, it is asked at the moment of leaving, and a grey line beside grey prose is exactly the shape an
eye skips on a screen it is scanning for one thing. `synced` is now `--ok` and a `CircleCheck` — the
colour and the mark this app already means *"this happened and it worked"* by. The prose did not
change and is still the point: the check is what finds the line, the sentence is what the line says.

#### The half that does not go through `settings.ts`

A schedule, a work item, a session being opened — these are durable ops in `outbox.ts`, and the
proof they arrived is a different one: **the host's own listing comes back carrying the row.** An
ack says a frame was taken; the listing says it was stored, and only the second earns a green mark.
`queueSync({queued, failed, onHost, online})` is that rule, pure and tested, and it answers in the
*same five words* the settings half does — a person asking "is this anywhere but this phone" is
asking one question, and answering it with "synced" on the pad and "armed" on a schedule is how two
words for one fact become two mental models of one app. `SyncChip` is the row-sized rendering: a
chip carrying its word, with the sentence as its title (on the schedules sheet a card wears it only
when NOT on the desktop, and the head's `SyncSummary` says the good case once — ten identical
"on desktop" chips were noise, 2026-10-12), because a list is where the full prose
cannot go and also where the silence bit hardest — ten schedule rows, and no way to tell *armed on
the desktop* from *sitting in a phone on a train*.

It also fixed a real lie. `failed` had no phase, so a `schedule.save` that had **given up** stayed in
the pending list and drew the amber *queued* chip: the one row that will never arrive was the one
claiming to be on its way. `failed` outranks everything, the row says `not sent`, and the three
refusals under it stop saying "the desktop does not have it *yet*".

#### The all-clear, on the strip

`link.ts` takes one more pushed number (`noteOutstanding`), on `noteStuckSends`' terms — the rows
carry prompt text and this file may hold a count and never the words. It is the send queue **plus**
`outstandingSync(SYNCED_SETTING_KEYS)`, because a person putting the phone down does not distinguish
the two stores, and counting one of them would make the all-clear a lie about the other.

Three states, and the empty one is a state: a **count** while something is outstanding, a **green
check** when nothing is and something once was, and **nothing at all** otherwise. `everOutstanding`
is that last gate — an all-clear printed from a cold start is true and worthless, nothing was ever at
risk, and a strip that speaks on a good link is a strip people stop glancing at. It is **earned by the
device, not by the page**: a latch counting only this page's history went quiet on every reload, which
is exactly the wrong moment, because someone opening the app the next morning to check that
yesterday's queue drained is the person the reading exists for. The snapshot ORs it with
`doc.log.sent`, which is already persisted and answers the same question. It is withheld while a send
is stuck: *"all saved"* beside *"1 send stuck"* is a contradiction and the red one is the one to
believe. `NetHealthSheet` spells the same two facts out as *On this phone only*, and takes the `sends`
focus anchor when there is no stopped-sends section to take it. `QueueSheet`'s empty state reads the
same one number rather than inferring an all-clear from its own emptiness — the queue cannot see the
settings pushes, and *"Nothing queued."* answers a question nobody opened the sheet to ask.

**Fitting it into the strip's order of sacrifice.** 22 px already carried four readings, and measured
at 412 px with a transfer in progress a rigid fifth shoved the freshness label into an ellipsis — the
one reading that file explicitly protects, and the most useful one when the link is down. So the
green case is one short word whose SPAN clips while the check never shrinks: a green mark with its
sentence in the title, the hint and the health sheet is still the whole answer, and half a word is
not. The count does the opposite and never clips — `3` with the word gone still reads, `unsav…` does
not, and a number that might be truncated is worse than no number.

**Stars were the last surface with a pending state nobody could see.** `pendingStars` has always
existed — painted immediately, re-sent on reconnect, retired by `reconcileStars` when a live row
proves the host holds it — and rendered identically either way. It now carries a dotted underline
and a title that says which of the two it is. Not an opacity change: a dimmed control is how this app
used to say *"not clickable"*, and this one very much is.

**Already answered before this, and left alone:** the send queue (per-row status in Activity),
attachments (`attachState`), downloads
(`downloadStatus`) and file saves (never queued — the button is disabled offline *with the reason*).
The one deliberate omission is `intent.dismiss`, which is fire-and-forget by design: the host refuses
anything not terminal and anything already dismissed, so a lost one is a no-op rather than a fact
worth reporting.

- `Empty.tsx` — **what a list says when it has no rows, written once.** Sixty `div.empty` blocks
  across twenty-five sheets, most of them the same four-line ladder copied by hand — which is
  `useRemoteResource`'s own rot one level up: the hook made "the host refused this" and "the host was
  not reachable" different STATES, and then each sheet decided independently whether to honour the
  distinction and whether a CACHED list mentions its age at all (`stalenessNote` had one importer).
  `<Empty res empty thing noun>` renders the right one of loading/offline/error/nothing plus the
  age line — which appears above a NON-empty list too, the case a ladder guarded by emptiness cannot
  cover. `thing` stays in object position in every sentence ("so branches cannot be read"), because a
  template that must agree in number with a caller's noun will be wrong for half of them.
  `offlineNote` is what is additionally impossible; `note` is what is still possible.

### `Confirm.tsx`

- `Confirm.tsx` — **"are you sure?", once, and never through `window.confirm`.** Two idioms for one
  interaction: three sheets hand-rolled an ARMED TAP (a boolean, a `danger` class, "sure?") and four
  sites called `window.confirm`, a NATIVE MODAL that blocks the WebView's event loop, cannot be
  styled or driven by this repo's own browser automation, and in the APK renders as a system dialog
  stamped with the local asset server's origin. `ConfirmButton` is the armed tap where the act is
  known at render time — one armed button app-wide (arming row B disarms row A, which `ArchiveSheet`
  had by accident) and it DISARMS ITSELF after `ARM_MS`, the half nobody wrote: a row armed and
  scrolled past used to delete a conversation on the next brush. `askConfirm()` is the dialog for a
  question that arrives too late to be a label — a host frame naming uncommitted work, a branch
  delete that came back "not fully merged" — mounted once in `main.tsx` beside the toast, because
  `App` returns early once per overlay. `onConfirm` is named `on…` deliberately: `no-silent-send`
  still sees through it.

### `CliHealthSheet.tsx`

- `CliHealthSheet.tsx` — **Decision 8's readout** (`shared/clihealth.ts`). One row per signal: name,
  verdict pill, `healthSentence()`, what it breaks behind a disclosure, the fallback last taken, and
  the captured sample. Nothing is re-derived — verdict, sentence, order and prose all come from
  `@waterplane/shared`, so the phone's row and the host's push cannot word one fact two ways. Seeded
  through `useRemoteResource` off the snapshot every arriving frame writes, so it paints with the
  tunnel down; a POINT-IN-TIME read (the host debounces its broadcast ~5 s and a verdict moves over
  minutes) with a re-read button. **The unprompted mark is the feature**: an amber/red chip in the
  launcher TOPBAR — not beside "N at limit", whose section is not rendered when no session is live,
  which is exactly when a broken heuristic gets noticed — plus one toast when an arriving rollup is
  WORSE than the last seen while the app is open. `healthy` and `unknown` render nothing; the rollup
  already encodes that rule.

### `useRemoteResource.ts`

- `useRemoteResource.ts` — **one host read, told honestly.** Now actually adopted: `SlashSheet`,
  `GitView`, `SecretSheet`, `SetupSheet`, `ArchiveSheet` and `FilesSheet`/`UsageSheet` (it had two
  importers and its wording helpers had none — a shared rule nobody imports is a comment).
  Deliberately NOT on it are the sheets rendering SOCKET-pushed props (`ScheduleSheet`, `BuildSheet`,
  `HistorySheet`, `Backlog`, `SearchSheet`: there is no promise to wrap), `Gallery` (its cache is
  keyed by COVERAGE so one listing re-filters into another — a contract one `key` cannot express) and
  `PullSheet` (a transfer, not a read). `format.ts`'s `ago` is the one "how long ago" left of eight. Cache seeded FIRST (paint immediately,
  offline or not), live read second, and a `state` that never lets the two be confused: `fresh` /
  `cached` (with `age`, which is not optional) / `loading` / `error` / `offline`. The last two are
  deliberately separate — "the host refused this" and "the host was not reachable" lead to different
  next actions, and collapsing them is how a permissions problem reads as a bad tunnel for a week.
  `offline` as an INPUT takes the socket signal, because `navigator.onLine` stays true while the
  Tailscale path is dead. The rule it centralises ("cached rows always say how old they are") is
  exactly the kind that rots when it is written twenty-six times: one sheet forgetting the age label
  is not a crash, it is a screen quietly claiming to be current.

### `persist.ts`

- `persist.ts` — `navigator.storage.persist()` at boot. IndexedDB is BEST-EFFORT by default and the
  browser may drop the origin under storage pressure unasked — which for `uploads` (the only copy of
  a queued photo), `pulls` (a partial download) and `screenlog` (not on the wire, not on the host)
  means silent, unrecoverable loss on exactly the phone this app targets. A request, not a command:
  the answer is reported in `NetHealthSheet` so "install to home screen" is an actionable next step.

### `App.tsx`

- `App.tsx` — the wiring: one call per core hook (`core/*`), the ws switch, `bindCore`, the overlay
  table. Queue (`core/queue`) is **ref-authoritative**
  (`writeOutbox()` sets ref + localStorage + state; never a functional `setOutbox` updater — the
  flusher runs synchronously right after). **It returns early once per overlay**, so an always-on
  layer may not live in it: `HintLayer` and the toast were rendered on the launcher and terminal
  branches only, so inside a sheet a hint card never mounted (and a `confirm` hint SWALLOWS the tap
  it explains — every hint-gated button in a sheet was permanently dead) and every refusal was a
  sentence painted for nobody. Both are mounted once in `main.tsx` beside `NetPulseBar`, state in
  `hints.ts` / `toast.ts`; `showToast` is unchanged at its ~100 call sites.
  **An explicit send beats `holdUntilIdle`** (`holdWall`/`unpark`): "send now"/"send all" already
  cleared the backoff and `serial` on the argument that a tap is a decision, and not clearing the
  park left it blocked `held` on the very flush the tap ordered. A busy TURN is not a wall — every
  un-parked entry types into one — but a question box, an unparsable dialog and a limit block are:
  those keep the hold and get NAMED. The entries ahead of it in the lane are unparked too (a held
  entry holds its lane), and a `pendingCreate` entry never is (its park is for after it is bound).
  **Which sheet is on top is a TABLE** (`overlayViews`, one `overlayNode`, one return). It was forty
  sequential `if (overlay === "x") return …` branches, and the shape cost more than its 1,450 lines:
  adding a sheet meant splicing into the middle of that chain five thousand lines from
  `PERSISTED_OVERLAYS` — the other list a new overlay must appear in — and because each branch
  RETURNED, anything meant to be on screen at all times had to be repeated inside every branch that
  could be showing. A miss returns null and falls through to the screen underneath, exactly as an
  unmatched branch did, which is what the guarded entries rely on: an overlay whose backing state is
  gone (a reload restored "image" with no picked file) paints the screen below, not an empty sheet.

### Typing room — the chrome the keyboard costs

While the on-screen keyboard is up, the session screen's chrome is bigger than what is left of the
terminal. Measured on a phone with the keyboard open: net-pulse strip, header, status line,
special-key row, the new-images strip and the download strip together left the terminal **two
visible lines** — so the output you are typing *about* is precisely the part not on screen while you
type, and a prompt that refers to what the agent just said has to be written from memory.

`typingMode` (`chromeMode.ts`, via `core/session/useSessionChrome.ts`) is `typingRoom && composeFocused && !cliMode`, and `.screen.typing` in
`styles.css` hides all of it. Rules worth keeping:

- **The signal is FOCUS, not a keyboard measurement.** `visualViewport` shrinks under the keyboard on
  iOS but Android Chrome shrinks the layout viewport with it, so `innerHeight - vv.height` is ~0
  there; a max-height-seen heuristic gets the first reading wrong when the app opens with the
  keyboard already up. The caret being in the box is the fact that actually matters, and it needs no
  measurement. The DEFAULT splits on `(pointer: coarse)` — a desktop keyboard costs no screen, so
  there is nothing to give back there — read ONCE at mount and never re-derived, since a flag that
  flipped on a resize would silently undo a choice made by hand.
- **Leaving is measured RELATIVELY** (`trackKeyboard`, `chromeMode.ts`). Android's back gesture
  hides the keyboard and KEEPS the caret, so focus alone left typing room up with no keyboard: key
  row gone, header gone — a broken-looking full screen — and the next corner-button tap blurred the
  box, brought the chrome back and moved the button before its click landed ("reader view exits full
  screen and stays in the CLI"). While focused, the viewport AT FOCUS is the baseline; the box is
  blurred only once the keyboard has provably opened (a drop of `KEYBOARD_GONE_PX` below it) and
  the viewport is back at the baseline, held still for `KEYBOARD_SETTLE_MS`. The first version
  blurred on "grew back from the shortest seen", which the opening animation's overshoot satisfies
  — it shut the keyboard as it opened and nothing could be typed. A width change restarts the tracker
  (rotation); a hardware keyboard never shrinks anything. The reader switch carries `keepFocus` too.
- **CLI mode is excluded.** There the box IS the keyboard and the special-key row is the rest of it —
  the first thing typing room hides would be the row you are typing with.
- **What survives is the output and TWO buttons** (`.hdr-typing-keep`), their own controls rather
  than pinned toolbar actions, which can be unpinned. Both carry `keepFocus`, without which their
  own pointerdown blurs the box, ends typing mode, and unmounts the button before the click lands.
  - **outline** — "where am I in this session?", the question you ask mid-prompt. It does ONLY the
    outline. It used to clear `composeFocused` on the way, which brought the entire chrome back with
    it: a button labelled outline that also un-hides the header is doing the other button's job.
  - **menu** — everything typing room hid, back, WITHOUT giving up the caret or the keyboard
    (`typingPeek`). Blurring cannot be the way to see the header again: the box is already focused,
    so tapping it fires no focus event and the chrome would stay up until you deliberately blurred
    and re-focused. The peek is transient — it resets when the caret leaves the box and on a session
    change, so the next focus starts hidden — and its way back is a `.hdr-typing-hide` chip on the
    header, which in the peek is the thing covering the output.
- **The header leaves the flow.** Holding one button it was still a row of mostly-empty panel above
  the output — the exact thing this exists to give back — so in typing mode it is absolute against
  `.screen` (made `position: relative` in this mode ALONE, so no other screen changes its containing
  block) and costs zero rows. Not `position: fixed`: under an on-screen keyboard that resolves
  against a viewport `useViewport` has already re-anchored. It buys the row at the price of the
  output's top-right corner, which is the `conn-banner` trade made once more, and for the same
  reason — a corner for as long as the caret is in the box.
- **The reader has two rows of its own** and they go too: `.tr-bar` when it is only the unread jump,
  and `.tr-status.tr-live` (the busy/idle readout). An OPEN find field keeps its box
  (`.tr-bar-find`) — a query still narrowing the document with its own field hidden is a screen
  misrepresenting what it shows — and the bare `.tr-status` below it, the cached-copy notice, stays
  up in every mode, being an honesty marker rather than a readout.
- **Not hidden, deliberately:** the approve bar (a question is why you would be typing at all), the
  send-queue bars (they carry Restore/Manage — a receipt you cannot see is what `giveups.ts` existed
  for) and the insecure/update banners. Only `PullBar` goes, being progress with nothing to decide,
  which is why it now carries its own `pull-bar` class next to the `outbox-recover` it shares.
- **The pulse strip needs a document-level signal** (`html[data-typing="1"]`): it is mounted in
  `main.tsx` outside this tree, and `--ui-pulse-h` is set INLINE on `<html>`, which no stylesheet
  rule can outbid — so the strip and the padding every screen reserves for it are hidden separately.
- **The way out is a tap on the terminal.** A blur ends it; an overlay opening resets
  `composeFocused` by effect, since an unmounted textarea fires no blur and the chrome would
  otherwise stay hidden on a screen with no caret in it.

Nothing here is persisted per session and nothing is destroyed: it lasts exactly as long as the
caret is in the box. The switch itself is `waterplane.typingRoom`, per device (Settings → Compose).

#### Full screen — the same room, without the keyboard

Typing room's layout is a side effect of composing, and it was being asked for on its own: *"a full
screen mode button that does the same as when I put the cursor into the text box, except that it
should not open the keyboard."* Putting the caret in the box to see more output gives back six rows
of chrome and immediately spends half the screen on a keyboard, which is the wrong trade when what
you are doing is READING.

`fullScreen` is a plain piece of state and the conjunction that turns it, `typingRoom` and the peek
into a layout is `chromeMode.ts` — pure and node-tested, because every bug this has had was a bug in
the conjunction and not in a pixel. `chromeHidden` is what the class and the `data-typing` attribute
key on — **the same class**, so there is one hidden-chrome layout and not two that drift apart. The
three rules it adds:

- **`!typingMode`**, because with the caret in the box typing room is already doing this and owns the
  way back. One mode at a time, one exit.
- **The exit is drawn wherever the mode can be entered.** It was gated on `!readMode` while the corner
  group was the terminal's alone — a mode whose only exit lives on a surface the mode can hide is a
  trap. The reader has the group now, so the gate went rather than the rule.
- **The special-key row STAYS** (`.screen.typing.fullscreen .keys`). Typing room hides it because the
  keyboard has replaced it; here there is no keyboard, so Esc / Tab / the arrows are the only way to
  answer a choice box or interrupt a turn, and hiding them would make the mode read-only. Reported
  exactly that way: *"in CLI mode they are required."* **In the READER it is not drawn at all** — see
  below — so full screen there needs no exception, and the CSS rule that used to carve one out is
  gone.

### The raw-key row and CLI mode belong to the terminal

`Esc` · `Tab` · the arrows · `^C` · `↵` aim at a choice box, a menu cursor or a running turn on a
grid. In the reader that grid is not on screen: a box is answered by TAPPING it
(`PromptAnswer.tsx`), prose has no cursor to move, and what the keys do land on is invisible until
you switch back. So the row — and the CLI toggle that lives at its end, being the same thing with
the alphabet added — is **not rendered while the reader is up**. Reported as *"this is only for CLI
relevant but I see it in read mode as well"*, with the keys circled.

Two rules come with it:

- **`cliMode` reads the reader too** (`cliModeOn && !pending && !readerShown`) — the same "remembered,
  not applied" shape a pending session already had. It has to: the toggle is inside the row, so
  hiding the row while the pipe was live would leave the composer as a raw pipe with no way out of
  it. Switching back to the terminal puts the mode back, draft untouched.
- **`readerShown`, never `readMode`.** `readMode` is only the sticky preference; a backend with no
  `transcript` capability draws the terminal under it either way, and a rule keyed on the preference
  would take the keys off a live xterm. One derived value now feeds the `.reading` class, the
  transcript/terminal switch, the zoom overlay's target and the corner group's wording — which also
  fixes the zoom buttons, which on such a backend resized the reader nobody could see.

The button is LAST in the corner group, after the zoom pair, so it never moves. The group is
absolutely positioned against the RIGHT edge and grows leftward — the right-most child is the one at
a fixed place on screen, and everything before it slides. It sat first for exactly this reason,
which was the wrong end of a right-anchored row: the zoom buttons come and go at the ends of their
ladder and the reader switch is absent on a backend with no log, and each of those moved the toggle.
Reported as *"put the full screen toggle to the very right"*. The header's `menu` survivor is the
second way out, one button with two jobs — the peek in typing mode, ending full screen here — rather than a second
identical-looking button in the same corner, which is the confusion the reader's outline pair cost
once already.

**Not persisted**, deliberately: it is a mode you are IN, not a preference (`waterplane.typingRoom` is the
preference). A phone that boots into a hidden-chrome session whose only exit is one small corner
button is a worse first frame than one extra tap.

**What the button SAYS is `fullScreen`, not `fullMode`.** The layout keys on the derived value — one
mode at a time, and typing room owns its own way back — but the control was drawn from it too, and
those are different facts. With the caret in the box `fullMode` is false however the switch is set,
so on a session already in full screen the button showed *enter full screen*, and the tap then wrote
`true` over `true`: no state change, no re-render, a dead button. The cure was to stop typing, and
the thing people reach for that happens to blur the box is the view switch beside it — which is why
it was reported as *"happens often that I have to switch between the views until it works
reliably"*. Icon, `active`, `aria-pressed`, title and the value written are now one reading of
`fullScreen`; turning it on while typing room is already hiding the chrome changes nothing on
screen, which is correct — it decides what happens when the caret leaves.

**…and the button keeps the caret** (`onPointerDown={keepFocus}`, the same preventDefault the
header's two typing-room survivors carry). Without it a tap with the keyboard up blurred the box
first: typing room ended, the chrome came back, and the whole terminal — this button with it — moved
out from under the finger before the click could land. A tap that lands on nothing is a dead button
by another route, and it is the other half of the same report.

##### The mode belongs to the screen it was entered on

Three booleans, one screen, and the two remaining ways the mode outlived it — reported as *"happens
sometimes that I have to open the menu to be able to leave full screen"*, *"the button should only
have effects inside a session"* and *"the 2 status bars should always be visible in the main
view"*. `chromeMode.ts` is where all three now live, because each was a conjunction that read
correctly line by line:

- **`onSessionScreen` gates BOTH hiders.** The two strips this mode takes off the screen
  (`.net-pulse`, `.localrt-bar`) are mounted in `main.tsx`, OUTSIDE `App`'s tree, so they are hidden
  through an attribute on `<html>` rather than a class on a subtree. A mode left switched on
  therefore went on hiding them on the launcher and behind every sheet — screens that draw no
  control to switch it back on. Both hiders could get there: `fullScreen` is simply a switch nobody
  reset, and **`composeFocused` survives the back button** (React fires no blur on unmount — the
  same hole the `overlay` effect beside it patches). One gate on the SCREEN, rather than a reset per
  mode, is what makes that class of leak unreachable.
- **`fullScreen` also resets when the session screen is left** (`!activeId`). The gate above is what
  keeps the launcher's strips on screen; this is what keeps the mode from being a fact you cannot
  see — coming back into a session to find the header gone, with no memory of asking for it, is the
  state bug and not its symptom.
- **The peek suspends full screen too** (`!typingPeeking`). The peek asks for the chrome back
  WITHOUT giving up the caret; with full screen on it was asking one hider to let go while the other
  held on, so the ☰ appeared to do nothing and the only thing that worked was tapping it a second
  time once the keyboard had gone. Leaving the peek resumes whatever was hiding before it.

### `outbox.ts`

- `outbox.ts` — drafts + **the offline send queue, the single send path**. Modes `input` /
  `backlog` / `upload` / `op`. Rules that must hold: one delivery in flight per lane; cap enforced on
  the way IN (never `slice(-CAP)` — that drops undelivered prompts); retries only ever with the same
  ackId; an attempt is rolled back when the socket wasn't open; an upload attempt counts only when
  the host ANSWERED; **every** attached file is parked to IndexedDB before it can be lost; the text
  that names an upload adopts that upload's lane (`adoptReferencedUploads`), and a text naming a
  dead upload is refused. `session.kill` and backlog mutations are deliberately NOT durable.
  Queued opens that carry a prompt are **serialized per repo by default** (`waterplane.serialSessions`,
  `isSerializable`): one agent at a time, so a queue drained on reconnect can't spend one usage limit
  N ways, finish nothing, and edit one worktree from N sessions. A bare open is never held (it runs
  nothing), and "send this one now" clears `serial` on that entry.
  A `failed` row is **kept, in full, for ever** — `QUEUE_TTL_MS`, `FAILED_RETIRE_MS`,
  `retireStaleFailed` and `retireToPad` are all deleted, and so is the clipped give-ups ledger they
  fed. The row keeps its words and its `cwd` and is triaged in Activity, which is where its three
  jobs went: what never ran, the button that re-posts it to that repo, and the dismissal mark.
  `OUTBOX_CAP` is 500 (was 50, against a phone holding 47 stuck sends) and overflow FAILS the oldest
  rather than dropping it — with no ledger, an eviction is the last way this app could delete typed
  words. It is also the localStorage half of the PAD (`loadPadDoc`/`writePadDoc`/`addPadNote`/
  `updatePadNote`/`removePadNotes`, the rules themselves being `shared/pad.ts`'s): adds REFUSE past
  the cap or the byte budget instead of shedding, `removePadNotes` is the one delete and writes the
  tombstone every removal path needs, and `seedSheetDraft` answers `seeded`/`kept`/`refused` so the
  one path where a rescue can itself fail does not become a delete. What became of an ambiguous delivery is the HOST's question now
  (`opendeliveries.ts`): it re-asks the CLI's own log with nobody connected, re-sends a provably
  `absent` prompt once, and broadcasts `delivery.settled` — which App applies to the row by ackId
  (`landed` drops it and says so; nothing else re-sends).

### `attachments.ts` + `AttachStrip.tsx`

- `attachments.ts` + `AttachStrip.tsx` — **the files a queued prompt names**.
  An attached photo becomes `.claude/inbox/<stem>-<ts><rand>.jpg` in the text BEFORE its bytes move
  (`plannedInboxPath`), so the path is unreadable by construction and says nothing about whether the
  file will exist: the upload is a separate entry with its own verdict. `AttachStrip` draws each
  mention as the file itself — local bytes first (the only copy while the upload is queued, and no
  link needed) — and labels it with `@waterplane/shared`'s `attachState`. Shown in the compose bar (behind
  a debounce: otherwise a repo listing per keystroke), on queue rows, on pad notes.
  **Every thumbnail here OPENS** (`requestAttachOpen` → `features/images/actions.ts`'s `onAttachOpen`, the arrangement
  `NetPulseBar` uses): a handler threaded through the seven places a strip is rendered is seven
  chances to leave one strip's pictures dead, which is the state all seven were in. The payload is
  the path, the repo and the verdict and never the URL on screen — the viewer overlay REPLACES the
  sheet, taking that strip's object URL with it — so App resolves its own copy, remembers the screen
  to come back to (`SwipeState.back`, else a tap in the pad closes the pad) and owns the revoke. A
  host file goes to the ordinary viewer; a `kept`/`dead` one opens from this phone's bytes and is
  the ONLY route to that picture, since it is on no host and at no URL — and it offers no *mark*,
  having no repo copy for a marked one to replace. The host's thumbnail is now the same
  mtime-VERSIONED, cache-first URL the gallery and the reader use (`thumbSrc.ts`), so a queue row
  still shows its screenshot with the tunnel down; the un-versioned URL it built before was
  cacheable by nobody, i.e. one request per row per session over the link the row is complaining
  about.
  `SendSheet`'s `repair` mode is the third option next to retry-and-discard for a send that gave up:
  rewrite the words, fix or drop each file, send as a NEW ackId through the ordinary queue (no second
  send path). Bytes of a dying upload are **moved aside, not deleted** (`keepUploadBytes`, keyed by the
  path, bounded oldest-first) — erasing the only copy on the only device that had it is what made a
  failed upload unrecoverable, and it is what turns "re-attach" into a button.

### `collage.ts` + `CollageSheet.tsx`

- `collage.ts` + `CollageSheet.tsx` — **more than one image picked: one picture, or several?** A mark
  cannot leave the image it is drawn on, so a bug that spans three screens can only be circled once
  they are on one canvas. In front of EVERY multi-image pick (compose bar, any-type picker, Start
  sheet, pad, backlog) via `features/images/actions.ts`'s `offerCollage`; declining is one tap and runs exactly the flow that
  ran before, with the order set here. Combining produces ONE picked file, so everything downstream
  (annotator → lane → upload) is the ordinary single-image path and knows nothing about it. The
  order strip is the point — a picker's order is not the sequence the screens happened in — and the
  panel NUMBERS follow it, so the prompt can name a screen. Geometry is `@waterplane/shared`'s
  `collage.ts`; this half decodes ONCE (a decode per picker tap freezes a phone), draws, and is
  paranoid about the encode: a 6 MP canvas is where an Android WebView returns `null` from `toBlob`
  with everything else succeeding, so there is a size LADDER (asked-for → 2600 → 1800 → 1200 → 800),
  a `toDataURL` second encoder, every canvas zeroed before the retry, and the output capped at the
  width the upload would shrink it to anyway. Falling back is REPORTED, never silent.
- **The gallery's combine** (`gallery/useGalleryPick.ts`, `GalleryPickBar.tsx`, and the fetch in
  `features/images/GalleryEntry.tsx`): pictures the DESKTOP made — a screenshot per device, a
  before and an after — are the ones most often compared, and until 2026-10-16 the only multi-image
  picks were the phone's own file pickers, so two outbox screenshots could not be put on one canvas
  without saving them to the phone first. The gallery has a pick MODE with its own worded bar (a
  tile tap opens a file everywhere else, so a hidden long-press would never be found): tiles are
  numbered in TAP order, which is the panel numbering the collage sheet starts from; Combine is
  drawn once two are picked and the bar says why before then. One repo only — the combined picture
  uploads into one inbox. The bytes come through `api.fileBlob` (the auth, routing and fuse of every
  other read), then `offerCollage` exactly as a picker's files would. Asked for the demo's hero story
  (docs/requirements/demo.md R-demo-033: "make ② look like ①").

### `PadSheet.tsx`

- `PadSheet.tsx` — a note is target-less, but it can now be a CHAIN and it can carry FILES.
  `PadDraft.steps` sits beside `text` (never inside it), so everything that reads a note as one
  string still works and a chained note degrades to its first step; dispatch turns the chain into
  several held sends (session), one work item per step (repo), or the create's own chain (start).
  Fan-out takes ONE prompt across N repos, so it sends the first step and the rest STAY on the pad.
  Attaching is the one act that makes a note name a repo early — bytes need an inbox and a path
  minted now — so it asks once and remembers the answer as the note's `cwd`; uploads park in that
  repo's `create:` lane, and ordering holds wherever the note is finally sent because text naming an
  upload adopts that upload's lane (`adoptReferencedUploads`). **A note that knows its repo says
  so** — the row names it, and its own repo is FIRST in the target pickers, labelled: a retired send
  has carried `cwd` all along, and every picker was still asking a note that had already answered.
  Marked, never preselected (a note may legitimately be re-aimed). `focusId` scrolls to and flashes
  one note, which is what makes "your words are on the pad" an answer rather than a search — and it
  is only pointed at a note that EXISTS: App checks first and says so, since focusing an id nothing
  matches opens the pad scrolled nowhere and reads as the pad having lost the words.
  **The pad is synced, and the merge is PER NOTE** (`shared/pad.ts`, on adopt, with tombstones so a
  delete travels). The whole-list last-write-wins it replaces deleted every note the other device
  held, with no diff and nothing on the wire that told it apart from a deliberate delete — and the
  device-local rescue store, the amber *N notes were kept for you* block and `notesToRescue`'s
  judgement about which drops read as a loss were all compensation for that one fact. Fixing the
  merge deleted all three; the argument is above, under *the pad's last-write-wins problem*.
  `BootGuard`'s reset still keeps `waterplane.syncTs`: with no recorded write times every remote value is
  newer than everything local, so the crash recovery replaced the pad with whatever the host last
  heard from any device.
  **The trash is a `ConfirmButton`** because the tap is still the last moment those words exist on
  every device — a delete here writes a tombstone that TRAVELS, which is the point, and it sits a
  thumb's width from **send…** on a phone. Emptying the editor still deletes without arming: the
  words are on screen, and clearing a box you are looking at is not a mis-tap.
  **The pad REFUSES rather than sheds.** `addPadNote` returning a reason (`padFullText`,
  `PAD_WRITE_REFUSED`, both `shared/pad.ts`'s) leaves the editor open with the buffer intact and the
  sentence under the hint — the refusal is checked BEFORE the buffer is cleared, or a pad at its cap
  would have answered a Save by deleting the words it declined to keep. Shedding the oldest note was
  the old behaviour and it deleted a note for being old, which is exactly when nobody has dealt with
  it yet.
  **`file it`** is the one thing a note can do without the Send sheet, and only because it has
  already answered that sheet's first question: it names a repo. `queueBacklog` with the EXISTING
  `mode: "backlog"` entry — `backlog.add`, its own ackId, de-duped by the host ledger, no new send
  path and no wire change. Drawn only where the `cwd` resolves to a known repo; a note with no repo
  draws NOTHING there (`send…` is its path and the hint says so) rather than a dimmed sibling whose
  reason would live in a `title` no phone renders. No `label` is passed: the flusher's
  `text.slice(0, 40)` is what `typedName` recognises as DERIVED, so the row arrives untitled by
  anybody and the Backlog's *name these N* names it like any other. The note is removed only once
  the row is in the durable queue — `retireSendSource`'s rule — and a refusal (a dead upload
  reference) leaves the words on the pad.

### `RepoPicker.tsx`

- `RepoPicker.tsx` — **"which repo?", asked once.** Seven sheets hand-rolled it and only some knew
  the two rules: a note that already names its `cwd` (a retired send always does) has that repo
  FIRST and labelled — marked, never preselected, since a note may legitimately be re-aimed — and a
  worktree is offerable behind a primaries-only filter that must keep a SELECTED worktree visible
  and counted (hiding a row must not silently drop it from a run). `RepoPicker` is the row list
  (single or `multi`), `RepoSelect` the same rules in a `<select>` for a form where the repo is one
  field among several; sharing the rules and not the markup is the point.

### `PromptComposer.tsx`

- `PromptComposer.tsx` — **the one prompt-writing surface** (`SendSheet`, `PadSheet`'s editor). A prompt box has one right height — whatever the sheet is not using — so the
  primary box GROWS (`flex: 1 0 auto` inside a scrolling column) instead of being `rows={N}`: the
  pad's note editor was eight rows with half a phone screen of black under it. It also carries the
  prompt CHAIN (steps delivered one turn at a time, never concatenated), an `inline` mode for a box
  that sits INSIDE something else (a queue row being rewritten, a backlog item being edited — there
  the sheet IS using the room, and a `flex:1` box with an 8.5em floor either eats the fields below
  it or silently becomes a fixed 8.5em box), and `AttachButtons` (the
  image/file pair for the pinned `.sheet-actions`, routed by the file's own type, **plus the
  mic** — see below). It does NOT own
  where the text goes: the chain is a `string[]` the sheet persists, and attachment lanes stay with
  App. Don't hand-roll a fifth prompt textarea.

#### Dictation lives with the one prompt surface, not with whichever sheet remembered it

The backlog sheet's add form had a microphone. That form was a fifth prompt textarea and was
deleted for being one — and the microphone went out in the same commit, because it was a feature of
that form rather than a feature of writing a prompt. Speaking a backlog item became three screens
(open a session, dictate into the compose bar, *elsewhere or later…*) for what had been one tap, and
nobody chose that: it fell out of a deletion. Re-adding a mic to the Backlog sheet would have set up
the same loss again.

So `DictateButton` is part of `AttachButtons`, and its two props are **required**. A sheet that
draws the action bar has voice; a sheet that forgets does not type-check. `SendSheet` and
`PadSheet`'s editor got it back at once, and `SendSheet` is the route the backlog's own `send…`
takes, which is what actually restores dictating a backlog item.

**It dictates into the turn the caret is in**, not into turn one. `AttachButtons` is mounted in the
sheet's action bar and cannot see the focus, so `PromptComposer` writes it on every `onFocus` into a
`focusRef` the two share (a ref, for the same reason the chain is one: the speech callback lives for
as long as somebody keeps talking). It took `prompts.current[0]` as its base and wrote `next[0]` no
matter what, so speaking with the caret in turn 3 appended the words to turn 1, mid-sentence — not a
loss, since it appends, but a surprise about where somebody's words went.

The bar also carries **`in repo`** (`onBrowse`, drawn only where the caller can route it): naming a
file the repo ALREADY has, as opposed to parking new bytes, which is what both attach buttons do.
That capability existed only in the deleted backlog add form, and what was left of it was the
clipboard — which needs a secure context, and a plain `http://100.x` tunnel is not one, so on the
APK over the tunnel this app normally runs on there was no route at all. It opens the gallery with
`returnTo: "send"` and `insertInto: "send"` on the `GalleryCtx`, and *insert path* appends into the
sheet's persisted draft: the same round trip the annotator makes, and it has to be a round trip
rather than a copy for exactly the reason above.

Two behaviours it does not get to choose. **Dictation APPENDS** — `useVoice` grows the transcript
onto the end of what the box holds WHEN THE WORDS ARRIVE (`VoiceBox.read`, called at landing time
and not snapshotted at the tap, because a held recording lands minutes later), since typed words are
the last copy of themselves and a mic that writes over them is a delete (`local/no-draft-clobber` is
the same rule one store over). And the chain is handed over **by ref**: a dictation session outlives the render
that started it, and the callback the Web Speech API holds is the one captured at the tap, so a
plain array would write the chain as it looked a minute ago over a step or an attached path added
since. **Unsupported is ABSENT** — no Web Speech API, no button, never a dimmed one.

**One control, everywhere: `VoiceButton.tsx`.** It used to be two chromes over `useVoice` — the
compose bar's icon-only round `.mic` and a labelled `.key` *dictate* on the sheets — argued as two
controls because one row scrolls beside a terminal and the other has room for words. The person
holding the phone read them as two features that half-agreed (the sheet's had no clock, no held
badge, and said *listening m:ss* in words where the bar showed a red circle with a timer), and asked
for one. The compose bar's was the more finished, so it is the template: red and pulsing while open,
the clock of audio that ARRIVED under the glyph, an hourglass while the desktop reads, the held badge,
the language pill and the fallback pill beside it while recording. The sheets lost their label rather
than the bar growing one. `useVoice` stays with each CALLER — the compose bar dictates into `compose`,
one string App owns; `DictateButton` adapts it to a prompt chain held by ref; a file remark
(`FileReview.tsx`) goes through `DictateButton` with its own `boxKey` — because what a dictation
appends to and where a late one lands is the surface's business, and how the microphone looks is
not. All emit `action:voice`, so the usage sheet counts dictation once.

### `TranscriptView.tsx`

- `TranscriptView.tsx` — reader view (markdown-lite, outline, find, unread watermark, busy strip).
  **The spinner waits for the CACHE, never for the host** (`probing`): `setLoading(true)` is
  synchronous and the IndexedDB seed is not, so `loading && !doc` used to win for the whole
  `TRANSCRIPT_TIMEOUT_MS` fuse — twelve seconds of black screen over a document already on the
  phone. `loading transcript…` may only render once the cache has been asked and had nothing; the
  cached-copy chip is raised by the SEED too, and says `savedAt` (when this phone wrote it down) as
  well as `updatedAt` (when the conversation last moved). `OutlineSheet` is the same rule.
  **Offline honesty:** with the socket down, status is labelled *last known* and the pulse stops.
  Tool calls obey `waterplane.readerTools` (`transcriptUtil.ts`, synced): `fold` (default — a run of 2+
  collapses to one placeholder, details load per turn on the first tap) / `list` / `full` (details
  ride along with the document). A lone tool call is never folded.

  **A partial screen block says so, and only offers the terminal while the terminal can still
  answer.** A `screen` block carrying `scrollable` (host `transcript.ts`) is the rows the CLI
  painted inside a panel it could scroll — what sat below the fold was never printed, so it is in no
  record anywhere. The reader states that under the block, and adds a *scroll it in the CLI* button
  ONLY when `scrollPanelOpen(status.tail)` still finds the panel's footer in the freshest bytes and
  the session is running with the socket up: scrolling the TUI is a REMOTE operation
  (`screenlog.ts`), so with the link down the gesture does nothing, and once the panel closes there
  is nowhere to send anyone. Failing either, the sentence stands alone — never a dead button
  (`Unavailable.tsx`). The tail is raw bytes and not a rendered grid, so a footer the CLI has since
  painted over is still sitting in it; the window is the last 2 KB, which keeps the claim to roughly
  the last repaint and degrades to *no button* rather than to a button that lies about where the
  text went.

  **The reader owns no buttons of its own.** It started with a bar — CLI, outline, find, `N new`,
  refresh — sitting directly under the session header, and on a phone that was a whole row spent
  restating what the row above it already carried: the header's reader/terminal button IS the CLI
  toggle (and it survives a collapse, which is the layout the reader is for), and the outline is a
  pinnable header action. So the controls were PORTALLED into a slot the header owned (`barSlot`,
  `.hdr-read`). That fixed the row and left a subtler version of the same problem: the slot was a
  strip the toolbar config had no say over — not orderable, not hideable, not unpinnable — sitting
  immediately right of the strip the user DOES control, so one header row was half configurable and
  half fixed. It is also exactly how a pinned `outline` and the reader's own outline toggle came to
  render as two identical `List` buttons side by side doing different things (sheet vs. inline
  drawer), papered over with a filter that dropped the pin in read mode.

  So the three are catalog actions now (`toolbar.ts`'s `READER_TOOLBAR_IDS`), pinned by default so
  the reader still opens with them in reach, and `runToolbar` reads each on the view that is up:

  - `outline` — read mode toggles the inline drawer, terminal opens `OutlineSheet` (the sheet in
    the reader would be a second copy of a panel one tap away).
  - `find` — read mode opens the in-page find (the document is ON the phone; it needs no host),
    terminal opens the host-side session search (there is no document to search).
  - `refresh` — read mode refetches; from the terminal it SAYS the terminal is live rather than
    being a button that does nothing.

  A tap reaches the reader as the `cmd` prop, `{kind, key}` keyed the way `jumpTo` is — the kind
  alone is an unchanged prop the second time, and firing find twice must act twice. Props rather
  than an imperative handle because the state stays where it is derived: the find hit count is
  `querySelectorAll(".tr-hit")` over the body, the unread count is the watermark against the loaded
  turns, and lifting either to `App` would mean a second copy kept in step by hand.

  What is left in the component is what a button cannot be — the find FIELD once it is open, the hit
  counter, the `N new` jump — and that strip draws in flow at the top of the reader, only when it
  has something to say, so a reader with nothing searched and nothing unread still spends no row.
  Existing devices have a saved `pinned` array, so the default never reaches them and the buttons
  would simply have vanished: `loadToolbarCfg` folds the three in ONCE and records that as
  `readerPins` INSIDE the config, which syncs with it — a marker in a key of its own would let the
  migration re-run on a second device and re-pin what was unpinned here.

  **The star went the same way** (`STAR_TOOLBAR_ID`, `starPin`). It was a fixed button of the session
  header, inside the `!headerCollapsed` half — so the reading-room layout, the one you sit in through
  a long turn, was the one layout with no star in it, and "come back to this" is decided precisely
  there. The only other star is the launcher row, i.e. leave the session to mark the session. It is a
  catalog action now, so it can be pinned, unpinned, reordered and hidden like the rest, and it is
  the header-commands sheet's chip cloud that was missing it. It keeps a renderer of its own rather
  than the generic one because it carries STATE: filled when the session is starred, `star-pending`'s
  dotted underline while this phone's star is still unconfirmed, and absent on a queued open, where
  there is no session on the desktop to mark. Same one-time fold, same reason as the three above.

### `ForkTurn.tsx`

- `ForkTurn.tsx` — **the reader's two conversation verbs**, on the turn header that already holds
  `#N`, the clock and the copy button (one icon expanding an inline action row, not a nested sheet):
  *fork from here* BRANCHES, *reset to here* REWINDS IN PLACE. Both are one durable `session.create`
  carrying `forkAtTurn`; the host writes the log (`convfork.ts`) and resumes it. Reset is not
  destructive in this codebase's sense — the discarded turns are not deleted, the original stays on
  disk under its old id and stays listed in `ArchiveSheet` — and the confirm says exactly that;
  because it KILLS a running session where fork only creates one, it goes through `askConfirm`,
  naming an in-flight turn when there is one. Lifted out of `TranscriptView` for two rules worth
  stating once: which turns can be forked at all, and what a disabled action must SAY. A CACHED
  transcript is fine to compose from — a turn uuid is stable for ever — but the verb is disabled
  rather than queued, because a reset replayed an hour late kills a session that has since done an
  hour of work, which is `intent.cancel`'s argument exactly.
- `forkAnchor.ts` — **where a tap actually cuts, when the row you tapped is not in the conversation
  log.** The reader's document is not the log: a `/btw` is answered entirely in the CLI's own TUI and
  written down NOWHERE, so it reaches the reader as a `screen:<id>` turn rebuilt from waterplane's PTY
  capture (`host/transcript.ts` `screenCommandTurns`), and a resumed conversation's "(continued)" row
  plus every row of the history fallback are `t<N>`. Both used to answer a tap with the same refusal
  and two dimmed buttons — reported from the phone as fork "not working", on a session whose newest
  turn was a `/btw`. That refusal was accurate about the RECORD and useless about the REQUEST,
  because for a screen turn an exact cut point exists: **a screen turn changed nothing in the log, so
  the conversation state after it IS the state after the previous logged turn.** So the verbs stay
  live, the cut walks BACKWARD to the newest logged turn (never forward — a later turn is history
  this fork is meant not to have), and the row says which number it landed on, because the toast and
  the fork's title take the ANCHOR's number and an app telling two stories about one act is the thing
  this repo refuses everywhere else. A SYNTHETIC turn gets no such redirect and that asymmetry is the
  whole reason this is two rules: `t<N>` stands for real history that IS in the file under records
  the parse could not name, so cutting earlier would silently arrive with less conversation than the
  number promised. Pure and DOM-free (`forkAnchor.test.mjs`, `npm run test:unit`); the unavailable
  case now renders through `Unavailable.tsx` rather than as a disabled pair, which is the house rule
  it was quietly breaking.
- **"Here" is the START of the tapped turn** (2026-09-30). The verbs sit on the turn's header, above
  its prompt, and what a person reaches for them to do is take that prompt BACK — GitHub Copilot's
  restore-checkpoint and the CLI's own `/rewind`, and R-prompts-001 names the first. The first
  version kept the tapped turn and its answer, reported from the phone as "fork ignores the point":
  forked at #8 of nine, the copy was the whole conversation minus one line (host log: 294 of 314
  records), and *reset to here* on the fork's last turn changed nothing at all. The host still cuts
  AFTER a turn — `convfork.ts` is unchanged — so `forkAnchor()` now ALWAYS walks backward from the
  tapped row: over screen turns, stopping at a synthesized one, null when nothing logged comes
  first (turn #1 — a copy from there would be empty, and the row says so). The wire carries the
  anchor's uuid; every word the person reads carries the TAPPED number, as "before #N".
- **The confirm also peeks at the WORKTREE** (`core/launch/useLaunch.ts`'s `resetFileDrift`). "No file in the repo is
  touched" is the sentence people need first, and its corollary is the only way a reset can surprise
  you: the edits the discarded turns made are still on disk, and the reopened session has no memory
  of making them. A clean tree makes that a non-event, so the line is drawn only when there IS drift
  and it names the count — a warning that fires every time is furniture. It reads `api.gitStatus`
  and deliberately NOT `session.closecheck`, which is the precedent for asking this question but not
  a reusable one: its reply frame carries only a session id and App's handler treats any answer as
  "the user is closing this session" — a clean tree there sends `session.remove` on the spot, i.e.
  borrowing it would archive the very session the reset is about to reopen. Never blocks the dialog:
  an unknown repo, a refusal or a link slower than `DIRTY_PEEK_MS` all mean no extra line.

### `LoginBar.tsx` + `openExternal.ts`

- `LoginBar.tsx` + `openExternal.ts` — **signing in, from a phone.** The host publishes the rejoined
  link (`host/login.ts`); this is the button, above the approve bar: *open* (hand it to the browser),
  *copy* (the fallback when the hand-off does not happen) and — only while `awaitingCode` — *paste
  code*, plus a disclosure holding the URL itself, wrapping and selectable, because every automatic
  path here can fail and the last resort has to be the text in one piece. The code goes in on the
  RAW, undurable path: `deliverPrompt` proves a delivery by watching a turn start and a login starts
  none, so the verified path would conclude the Return was swallowed and press it five more times
  into whatever came next — and a code that short-lived is not worth queueing for a later flush.
  Text and Return are two writes with a gap. `openExternal` is the shell split: in a tab it is
  `window.open`, in the APK it is a main-frame `location.href` — the only form that reaches
  `MainActivity.guardNavigation`, which confirms and fires an `ACTION_VIEW` intent while the WebView
  stays put; `_blank` there no-ops or resolves against Capacitor's own asset server. Non-`http(s)`
  is refused: screen-scraped text is not a link. The Terminal-text sheet lists every link on the
  screen the same way. `e2e-login.mjs`.

### `ShellLinksBar.tsx` + `shellLinks.ts` + `features/shellLogins/`

- `ShellLinksBar.tsx` + `shellLinks.ts` + `features/shellLogins/` — **signing in from a shell session.**
  A shell has no sign-in flow of its own; any program in it may print a URL or ask the desktop to open
  one. The host publishes those as `SessionInfo.links` (`host/shelllinks.ts`, the `$BROWSER` shim); the
  bar beside `LoginBar` offers *open*, *copy*, *copy code* (a device code is typed on the phone; on a
  clipboard refusal it is shown large) and *paste code*, only while `awaitingCode`, because elsewhere
  the keystrokes would run as a command. A link to the desktop's own localhost is a sentence, not a
  button, since the phone cannot reach it. `shellLinks.ts` holds the wording, pinned by
  `shellLinks.test.mjs`; it is not `shellLink.ts`, the Android background link. The logins sheet
  lists phone-finishable commands (`--no-launch-browser`, `--device-auth`, ...), inserts one into
  compose and never sends it, and warns on flows whose default redirects to localhost.

### `screenlog.ts` + `ScrollbackSheet.tsx`

- `screenlog.ts` + `ScrollbackSheet.tsx` — **scrolling the TUI is a REMOTE operation** (the pan
  becomes wheel bytes the alt screen consumes), so a dead or crawling link used to mean the gesture
  did nothing at all. Every settled grid is diffed against the last one (`@waterplane/shared`'s
  `absorbScreen`) and the lines that scrolled off are archived per session, in IndexedDB (store
  `screenlog`) so a cold start still has them. An upward pan with the socket down opens that archive
  instead — plain text, no host, and labelled as a reconstruction of what THIS device displayed. A
  flick is also ONE wheel write now, not one frame per line, and a wheel that WAS sent and moved
  nothing for 2.5 s says where the local copy is (the poor-link half). `e2e-screenlog.mjs`.

  **…and where the DESKTOP has more, the desktop wins.** The archive above is a reconstruction and
  it reads like one, which is the report: "it looks like a copy-paste result of random moments that
  duplicate lines and misses some as well." Both halves come from this device's vantage point, not
  from the rule (which is pure, shared, and the same on both ends). A session is only seen while it
  is on screen and the app is awake, so whole stretches were never captured — and a gap makes the
  next sample unanchorable, which archives the outgoing screen WHOLE and lands the same block twice
  on the way back. Gaps cause the duplicates.

  The daemon has neither problem, so it records the same thing from the one place that never stops
  watching (`host/screenlog.ts`, `GET /api/scrollback`, `api.scrollback`). Note what it is NOT: a
  replay. The CLI draws in the alternate screen, which keeps no scrollback, so replaying the raw
  bytes answers with one screen however long the session has run — shipping that as the preferred
  source left a sheet with 31 lines in it and nothing to scroll, over an archive this phone had
  been keeping for an hour.

  Hence the client rule: **the host's copy replaces this one only when it is actually more**
  (`history || lines.length > local.length`). `history` is the host saying it holds something
  beyond the current grid; a daemon that has just restarted does not, and must not talk the phone
  out of its own record. Asked ONCE per successful read — `linkUp` is in the deps so a tunnel that
  returns mid-sheet still gets asked, but `host` short-circuits it, or every flap would refetch and
  re-anchor the list under the reader's thumb. Which copy is on screen is SAID, with a third
  sentence for "the desktop answered, but with less" — a different fact from "the desktop could not
  be reached". The desktop's copy never claims to be the whole session. `e2e-screenlog.mjs` pins
  the client's shape, `e2e-screenrec.mjs` the recording itself.

  **A THIRD zoom, on the sheet** (`waterplane.scrollZoom`, `uiScale.ts`'s `scrollbackZoom` /
  `setScrollbackZoom` / `scrollbackFont`). The corner pair answers "I want to see more of this" on
  the terminal and on the reader; this sheet is where that want bites hardest and had no control at
  all. What is in it is fixed-width lines a terminal already wrapped at its own width, so a phone
  narrower than that grid wraps every one of them a SECOND time and a sentence lands in three
  pieces — which is what the screenshot showed.

  Own stored value, and neither of the other two. Not the console's: zooming the console resizes the
  GRID — the new cols/rows are reported and the host resizes the PTY — so reading an hour of history
  would reshape the session that wrote it. Not the reader's: that is prose that reflows, and the size
  that stops a terminal line wrapping twice is not the size that makes a transcript comfortable. The
  MECHANISM is the reader's, because the sheet is HTML — one `--ui-font` override on `.sb-body`
  (`readerScale(textScale(), zoom)`, clamped as a product), one repaint, no re-render of a thousand
  line divs — and the ladder is `nextReaderZoom`'s for the same reason. The pair sits at the right of
  `.tr-bar` on `margin-left: auto`, never an order in the flex: the hits group between it and the
  find field appears with the query, and buttons that walk across the bar as you type are two
  different controls under one finger. At an end of the ladder the button is ABSENT with the end
  named in a word (`Unavailable.tsx`), never dimmed.

### `cliKeys.ts`

- `cliKeys.ts` — **CLI mode**: the `CLI` toggle at the end of the special-keys row turns the compose
  box into a raw key pipe (`waterplane.cliMode`, per device, NOT synced), for driving the TUI rather than
  sending a prompt. Keystrokes go straight to `session.input` on the same undurable path as the
  Esc/Tab/arrow keys — nothing queued, nothing echo-checked, and the bar SAYS so when the link is
  down. Android soft keyboards report no `keydown` for letters, so the box holds a pad of spaces and
  every `input` event is diffed against it (`decodePipe`: appended = typed, missing = `\x7f`);
  `keyToBytes` covers what a diff can't see. Don't advance the baseline mid-composition, and don't
  reset the value through state — see the `cliKeys.ts` section above.

### `theme.ts` + `termTheme.ts` — light or dark, as a setting

The app was dark-only, and that was not a stylesheet fact: it was two hundred literal colours spread
across `styles.css`, four different ambers, `var(--accent, #58a6ff)` beside `var(--accent, #6ea8fe)`
beside a bare `#4c9aff`, plus a dozen more in `.tsx` inline styles. A light mode is not a filter you
put over that — it is a *second value for every token*, and a colour that is not a token has no
second value. So the port was mostly a tokenisation: `styles.css` now opens with the whole palette
stated twice and contains no literal colour anywhere below it, and `packages/web/src/theme.test.mjs`
parses the file on every `npm run test:unit` to keep it that way.

**Three values, not two.** `system` is the default and it is the only answer that can be right on
two devices at once — the phone follows a schedule the desktop does not — which matters because
`waterplane.theme` **syncs** (`shared/settings.ts`). "I read light" is a fact about a person, not about a
link or a screen, so it does not belong with `waterplane.netPulse` in the per-device half; the
device-specific case is not missing, it is the default.

**What is not CSS.** The resolved theme goes on `<html data-theme>` and every colour follows from
there, but three consumers cannot read a stylesheet and are pushed from `applyTheme()`:

  - the `theme-color` meta the browser paints its own chrome with;
  - **xterm's palette** (`termTheme.ts`). Dark keeps xterm's own sixteen ANSI defaults, exactly as it
    always has — re-specifying them would be a redesign wearing a theme port's clothes. Light *has*
    to state all sixteen, because those defaults are a disaster on white: default yellow is
    `#ffff00` and default bright-white is `#ffffff`, and the CLI uses both. The set used is GitHub's
    light ANSI palette, which exists for exactly this problem. `--term-bg` and the palette's
    `background` are the same colour on purpose: `.term-wrap` paints the padding round the grid, and
    a one-shade mismatch draws a frame that reads as a rendering fault;
  - **the Android window's system bars**, which are window attributes no stylesheet reaches.
    `ShellAndroidInterface.setTheme(theme, bg)` → `MainActivity.setWebTheme` →
    `applyBarAppearance()`. A PUSH rather than a pull, for `setBackDepth`'s reason: the activity
    re-asserts bar appearance on resume from the recents snapshot, before the WebView has run a line
    of script, so the answer has to be already known. Optional in the same way, too — the UI updates
    over the air and the shell does not, so a bundle that never calls it leaves the app dark end to
    end, which is what it was.

**The flash.** `index.html` carries three inline lines that set the attribute off the same
localStorage key before one byte of the bundle is parsed. Deliberately duplicated rather than
imported: anything importable arrives a fetch and a parse too late, which on a light-mode phone is a
full frame of near-black on every cold start — most visible in the APK, where the document is read
off disk fast enough for that frame to land.

**Light is not dark inverted.** Three things had to be re-decided rather than flipped:

  1. *The hues.* `--accent: #4c9aff` is 2.4:1 on white — unreadable as text and unable to carry white
     as a fill. Every light hue is picked to clear 4.5:1 against both `--panel` and `--bg` and to
     carry its `--on-*` ink at 4.5:1.
  2. *The depth order.* In dark a field is DARKER than the panel it sits on; in light the panel is
     the lightest thing and the page around it is grey. `--well` is not "`--bg` again" here, and
     `--raise` — the pressed state — goes down in lightness rather than up.
  3. *The overlays.* Everything built from white-at-low-alpha becomes black-at-low-alpha. A pressed
     row lit with `rgba(255,255,255,.06)` over a white panel is a control with no pressed state.

**What the test pins**, because all four rot silently: the two blocks must declare the same token set
(a token added to dark and forgotten in light does not throw — it inherits, and shows up as a
near-black chip on a white card on whichever screen nobody opened during the port); every text hue
clears 4.5:1 on `--panel`, `--bg` and `--well`; the two chart sets clear 3:1 against the surface a
chart actually sits on (`.sheet` is `--bg`, not `--panel`) and stay separable under simulated
protan/deutan/tritan; and all 360 repo hues clear 4.5:1 — `format.ts` returns a HUE now, with
`--repo-sat`/`--repo-lit` per theme, because 60% lightness is a value picked for a near-black page
and the worst hue on white (yellow, 60°) needed 28%. **Dark's own measured numbers are the floor**,
so the ratchet only turns one way and the port could not quietly redesign a screen nobody asked to
change.

The one thing that is *not* a colour swap is at the bottom of `styles.css` under LIGHT-ONLY
CORRECTIONS: a disabled control fades to `opacity: .4`, which on a dark page dims a filled button
towards the background while its white label stays the brightest thing in it, and on a white page
drags the label down with the fill until the words cannot be read. In light a disabled filled button
gives up its FILL and keeps its INK. That is a stopgap for a pattern the app is already moving away
from — see `.act-cants` and `Unavailable.tsx`, where a blocked verb is a sentence and not a dimmed
button. Convert a call site rather than extending that list.

### `Markdown.tsx` and the media helpers

- `Markdown.tsx` (React nodes only, never `dangerouslySetInnerHTML`; **an anchor only for an
  absolute `http(s)`/`mailto:` href** — `target="_blank"` in the Capacitor WebView is a SAME-FRAME
  navigation with multiple windows off, so a relative href resolved against the local asset server,
  found nothing, and silently replaced the whole app with a blank 404 on one tap. Repo paths render
  as file references or as the label plus the path in a code span) · `fileRefs.ts` ·
  `media.ts`/`uploadScale.ts` (thumbnails down, re-encode up; both degrade to the original) ·
  `fileMtime.ts` (**an un-versioned thumb URL is cacheable by nobody** — the path→mtime map, learned
  from listings and upload receipts, else one `stat=1`, that lets a transcript mention / backlog
  image / viewer build the SAME versioned URL the gallery does, and share its cache entry;
  localStorage because the render that builds the `<img>` needs it synchronously) ·
  `thumbSrc.ts` (`useThumbSrc()` — the ONE cache-first resolution, grid and reader alike) ·
  `ZoomableImage.tsx` (clamped pan, GPU-derived scale ceiling, `will-change` only during a gesture —
  three separate causes of a black screen) · `NetActivity.tsx` (background polls must NOT register).

### `link.ts` — the link, as one store

`netpulse.ts`, `nettraffic.ts`, `netsync.ts`, `netlog.ts` and `netstate.ts` are **gone**; the file is
`link.ts`. The four sections below are still the reasoning for the four READINGS — they are worth
reading and nothing in them is retracted — but the modules they name no longer exist, and the reason
they were merged is itself the point.

Six modules, five persistence keys, four bespoke subscribe/emit systems, three copies of the
`pagehide` write-through handler, and — the part that actually cost bugs — **four independent
derivations of "am I online"**: the socket's `readyState`, `netsync`'s `connectedSince`,
`netpulse`'s `status`, and each caller's own `conn.status !== "open"`. Two readouts disagreeing
about the link is a whole bug class, and it lived here: a strip whose dot was green beside a sheet
saying *last connected 14m ago* is not a cosmetic defect, it is the app being unable to answer the
one question a bad tunnel makes people ask.

So: **one status, one document, one emit.**

- `noteLinkStatus()` is the ONLY writer of online-ness. Edge-triggered and idempotent, which is what
  lets the transport keep calling it from every place it already did — open, close, and the status
  emit — without any of them double-counting a reconnect.
- One persisted document with four sections (`pulse` / `sync` / `traffic` / `log`), one debounced
  writer, one `pagehide` flush. It survives a reload because **the reload IS a data point**: the
  `ws.ts` watchdog hard-reloads the page exactly when the link is at its worst, so a counter living
  only in memory would reset itself at the one moment it matters and report a perfect score.
- One `subscribeLink`. Sections keep their object identity while they have not changed, so a
  consumer that only watches `ops` does not repaint when a ping lands — and the once-a-second clock
  the "14m ago" labels need is OPT-IN (`live`) rather than something an always-mounted strip imposes
  on every screen.

What did NOT merge, deliberately: the probe samples still do not feed the `log` reservoir. Same
measurement, one store now, still two populations — `rttP95()` sizes the send queue's receipt
deadlines, so probing every 3 s rather than every 12 s would silently change how long a prompt waits
before being retried, as a side effect of a bar being switched on. A readout must not move the
machinery.

### the pulse reading (was `netpulse.ts`) + `NetPulseBar.tsx`

- **The permanent connection strip** (`NetPulseBar.tsx`) (`waterplane.netPulse`, off by
  default, per device). Every other link readout here is retrospective — the banner appears once the
  socket is gone, `NetActivity` once a request is already slow, `NetHealthSheet` only when opened —
  and none answers "is it bad RIGHT NOW". A 22 px bar fixed above every screen: state dot, the last
  ~30 probes as a sparkline, the current ms. **Misses are drawn, never averaged** (steady 250 ms and
  30 ms losing one ping in four read alike as a mean, and only the second eats prompts). It
  **observes and never steers** — `ws.ts`'s `probe()` resolves `null` on timeout and does nothing
  else, and probe samples deliberately do NOT feed `netlog`'s reservoir, which sizes the send queue's
  receipt deadlines. Probes only while the page is visible. Screens make room via `--ui-pulse-h` on
  `.screen`/`.sheet`, so a sheet written later is clear of it without knowing it exists.
  **Every reading on it is its own tap target and its own hint**: four facts share 22 px, so the
  strip can only carry a shape and a number, and a tap opens `NetHealthSheet` AT THAT SECTION
  (`app:open-nethealth` carries a `focus`; the sheet scrolls to it and flashes it once). Dropping
  the reader at the top of a five-section sheet to answer "54 lost — of what?" is a hunt, not an
  answer. Adding a reading means adding its section, its `data-hint` and its focus, together.

### the traffic reading (was `nettraffic.ts`)

- **How much, next to how good**: the strip's right half, and a section in
  `NetHealthSheet`. Latency cannot tell an idle socket from one saturated by a 20 MB download, and a
  metered SIM asks the other question. Down/up RATES appear only while bytes move (a readout that
  never reads zero cannot say "nothing is happening"); the two TOTALS stand, persisted, because a
  reload — which the `ws.ts` watchdog performs on exactly the worst link — must not flatter the
  number. Measured by **patching the transports, never by call sites** (`fetch`/XHR wrapped in
  `main.tsx` AFTER `installHostRouting`, socket frames through `ws.ts`'s `wire()`), plus a
  Resource Timing observer for what the BROWSER fetches — every `<img>` in the gallery, which is
  most of what comes down and has no call site to wrap. Requests count `content-length` (gzip
  already off it), page loads count what left the network (a cached thumb correctly costs nothing),
  socket frames count payload BEFORE permessage-deflate (over-states a busy PTY); Background Fetch
  is outside the page and not in it. Counting is an integer add into half-second buckets — a busy
  session is thousands of frames a minute, so a per-frame encode or re-render would make the readout
  the cost. Cross-origin Resource Timing reports zero bytes without `timing-allow-origin`, which is
  why `origin.ts` now reflects one — in the APK every image is cross-origin.

### the sync reading (was `netsync.ts`)

- **Is what I am looking at still true?** The strip's middle slot and a `NetHealthSheet`
  section. Two facts kept apart: **last connected** is the newest INBOUND FRAME (`ws.ts`'s
  `noteHostSeen`), never `readyState` — a tunnel dies under a socket that still reads open — and
  **last full sync** is the OLDER of the session list (socket, after `hello`) and the repo listing
  (a separate HTTP call that can be stale while the socket is fine), because the older half is when
  the whole screen was last current. A part counts only if it landed AFTER the current connection
  came up; until both have, the strip says which one it is still waiting for. Persisted, because the
  `ws.ts` watchdog reloads on the worst link and "last connected: just now" would be a lie told at
  the only moment it matters. The app renders from snapshots when the host is unreachable — this is
  the readout that stops that from being silent.

### `giveups.ts`, deleted

- **`giveups.ts` — DELETED, and this is the entry that says why.** It was the sends that gave up BY
  NAME: a bounded localStorage ledger, cap 200, prompt text clipped to a 200-character head, kept
  for a day. It existed because the ROW did not — a message expired at thirty minutes, its failed row
  retired an hour later, and by the time anybody read the counter there was nothing left to point
  at. Its three jobs are all Activity's now, and each is strictly better as a row than as a copy of
  one: *show me what never ran* (a `failed` queue row, never dropped, never clipped, never pointing
  at a pad note another device deleted), *the button* (the row's own re-fire, posting the FULL words
  as a work item in the `cwd` the row has always carried), and *have I dealt with this* 
  (`activityDismiss.ts`, which files a row without deleting it). `noteStuckSends` — the strip's one
  red reading — is pushed by App from those rows instead, which also fixed what the ledger got
  wrong: it kept counting a row for a day after the user had dealt with it, because a dismissal is
  not something a separate store can see. **The localStorage key is deliberately NOT deleted**:
  `migrateGiveUps` in `core/queue/migrate.ts` converts every un-retried row into a `failed` queue row exactly once
  (`waterplane.giveups.migrated`), using the pad note's full text where the note survives and a FRESH
  ackId always — the ledger's id may still hold a verdict in the host's ledger, and a retry carrying
  it would be re-acked with that verdict and never delivered — and leaves the source value alone, so
  a conversion that got something wrong has not also destroyed its input.

### `nativePull.ts` — the download that survives the app being backgrounded

`pull.ts`'s range engine is a complete, resumable downloader, and in the APK it made **zero
progress** the moment the user switched apps. The obvious suspect is Android's cached-app freezer,
which `ShellLinkService` already exists to defeat — and it is the wrong suspect. With that service
running, the process sits unfrozen indefinitely (`procState=4`, `oom_score_adj=200`,
`cgroup.freeze=0`), and the transfer still stops. **Chromium freezes the DOCUMENT on its own**: on an
API 34 emulator, 300 s after `visibilitychange`, three times out of three, to the second, with timers
running at a dead-on 1/s and no throttling at all up to that instant. A cliff, not a slope.

Everything holding a JS transfer together is inside that document — the pump's `setInterval`, the
retry timer, the headers and stall fuses, the `fetch` reader loop. So five minutes in a pocket left a
90 MB APK at whatever percent it had reached, with a spinner, until somebody looked at the screen.

**No amount of Capacitor configuration fixes that**, and the fix is not `DownloadManager` either: it
runs in `com.android.providers.downloads`, a different app, whose VPN routing, cleartext policy and
metered rules are not this app's. The daemon is reachable because *this* process is inside the
Tailscale tunnel; handing the URL to another process makes reachability an untestable property of a
component the user can also disable, and buys a status enum where these rows say what happened.

So the transfer moved into `ShellPullService`, and this module is how the page asks. What did *not*
move is every decision: what to fetch, in what order, what a row says, when to give up. Three rules
hold the split together.

**The list is the truth; `pullChanged` is a courtesy.** A frozen document runs no tasks, so an event
fired at a backgrounded page is dropped — which is exactly the period the engine exists to cover.
`nativeList()` is re-read on every wake and after every pump, and it answers with the service
*stopped*, straight out of `SharedPreferences`: stopped is its normal state, since it stops itself
when the queue drains.

**`nativeOwned` is what stops the pump handing a row over twice.** The service's `enqueue` is
idempotent, but it clears the backoff and the give-up count — that is what makes it right for a tap.
A pump that re-hands a backing-off row every heartbeat therefore forgives every attempt, and a dead
link retries for ever. So the flag lives on the record, `pumpEligible` refuses an owned row, and
**`force` does not waive it**: `retry()` clears the flag first, which is the entire difference
between a person deciding and a heartbeat firing. A row the service turns out not to hold is swept
back to `queued` by `syncNative`, because the service reports only what it *has* and nothing else
would ever notice.

**The bytes never cross the bridge.** A finished native download is a file in the app's own
directory: a preview is `Capacitor.convertFileSrc` (no bridge traffic, no network request), and the
save into Downloads is a file copy inside Java. `nativeSave.ts`'s base64 slicing stays for the bytes
that only IndexedDB has — a browser transfer, or one the range engine finished before this existed —
which is the whole reason it is worth not putting them there.

The Java half's own rules are in `packages/app/README.md`: the persisted backoff (a timer dies with
the process), the `dataSync`-not-`specialUse` type, and why the service stays alive while a retry is
counting down rather than posting it back into the document it was rescued from.

### `installPolicy.ts` + `nativeInstall.ts` — the APK that installs itself

The transport already ended with a fresh build sitting on the phone minutes after the desktop
finished writing it: an agent builds an app, drops `app-debug.apk` into `.claude/outbox/`, the
repo's `*.apk` auto-pull rule fetches it in `ShellPullService` with the app in a pocket. What was
left was the part nobody automated — find the file in Downloads, tap it, tap through a file
manager, tap the system installer — **once per build, per app**, and there are five Android repos
on this desktop.

**What Android allows, because the whole design is that shape and no other.**

- **"Install unknown apps" is a special access.** `REQUEST_INSTALL_PACKAGES` in the manifest is half
  of it; the other half is a per-app switch in Settings that only the person can turn on.
  `canRequestPackageInstalls()` is asked before any verb is drawn, and the row offers the Settings
  screen rather than a button that would fail — the `Unavailable.tsx` rule, applied to a refusal
  that is the platform's.
- **The FIRST install of any package shows the system dialog.** There is no flag, no permission and
  no trick, and the row says so *in advance* (`autoInstallText`: *the first one asks once*) rather
  than promising a silence it cannot deliver.
- **An UPDATE can be silent** from API 31: `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` with
  `UPDATE_PACKAGES_WITHOUT_USER_ACTION` declared and the target already installed — and from API 34
  the installer must hold *update ownership*, which `setRequestUpdateOwnership(true)` asks for on
  the one install that does show a dialog. So the shape of the feature is **one dialog per app,
  ever**: the first build asks, every build after it is quiet.
- **A refused silence is not a failure.** The platform answers `STATUS_PENDING_USER_ACTION` and
  hands back the same confirmation intent the loud path uses. Every reason for a refusal — a
  signing key from another desktop, an ownership the person took back, a policy this code has never
  heard of — arrives through that one door, so *asking* for silence can never cost an install.

**The list is packages, never file names.** Three different apps can all build
`app-debug.apk`; the file name cannot say which app a row is. `Installs.read` reads the package,
label and version out of the archive itself, at completion, and a file it cannot read leaves those
fields **empty rather than guessed** — such a row still offers the tap (the installer is what judges
a file) and promises nothing about future builds.

**The allow-list is synced (`waterplane.installAllow`) and mirrored into the shell.** Synced for
`waterplane.repoColors`' reason: *"this app is mine, put the new build on"* is a fact about the person, the
same on the second phone, and being asked it again there is the one question this feature exists to
stop asking. Mirrored into `SharedPreferences` because the install happens at the end of a download
that runs in a service **precisely so it does not need the page** — the document is frozen 300 s
after the app is backgrounded (`nativePull.ts`), so a bridge call at that moment would never be
answered. `syncInstallAllow()` at boot is what carries a list adopted from another device across.

**An automatic install is narrower than a tapped one** (`Installs.mayAutoInstall`): the access is
granted, the package is on the list, *and the package is already installed*. A first install
unattended would leave a notification asking for a tap nobody asked for — so the automatic path
covers exactly the case that can be quiet, and everything else waits for the row's own button.

**Where a confirmation cannot be shown, it becomes a notification.** `ShellInstallReceiver` starts
the system installer straight away when the app is in front, and Android refuses a background
activity start otherwise — so the same intent rides on a notification instead, and the row reads
*waiting for you to confirm it on this phone*. Never *failed*: that distinction is the one this
module's test pins hardest, because a pending confirmation and a signature mismatch look identical
from a distance and call for opposite reactions.

**Nothing here installs anything on its own authority.** A browser is told nothing at all
(`installIntroText` answers null) — a phone reading the app over the tunnel has no installer to
offer, and a capability it cannot have is not worth a sentence.

**`AppsSheet.tsx` is the list, and it is its own screen.** The switch first shipped only on a
downloaded row in Downloads, which is two failures at once. A setting reachable only from the
transfer that happened to bring the file cannot be **surveyed** — the count was already on the
screen (*"2 apps install themselves"*) with nowhere to tap, which is exactly the rule this repo
states as *a count on a control is a filter*. And an app whose builds have since been deleted had no
row at all, which is precisely the app somebody wants to switch OFF. So `appRows` is the **union**
of the allow-list and the builds still on the phone: an allowed package with nothing downloaded is a
row (*installs itself when a build arrives*), a downloaded build nobody has decided about is a row
(*new builds wait for a tap*), several builds of one package are ONE row and it is the **newest**,
and a row that cannot be acted on — not an app, still downloading, bytes evicted, package unreadable
— is not a row. Allowed first, then by name. The sheet keeps **no state of its own**: the list is
the synced key and the builds are `pull.ts`'s records, so it paints with no host at all — which is
why it is in `PERSISTED_OVERLAYS`. **The row toggle in Downloads stays**, deliberately: deciding in
the moment about the build in front of you is a different act from surveying, and both write one
store. Its entry point is the nav menu and it is drawn **only in the shell** — an entry that opens a
screen saying *not here* is worse than no entry. `appStateText` and `installStatusText` are one
implementation (`stateText`), because a download row and an app row wording the same outcome two
ways is how *waiting for you to confirm* would turn into *failed* on one of the two screens.

### The model picker groups by WHERE a model runs

Thirty ids in one alphabetical drop-down is a list nobody reads to the end, and the two facts that
actually decide the choice were not on screen at all: does this need the tunnel, and does this cost
money. So `ModelField` splits the catalogue on `BackendInfo.models.where` — chips reading
*On this desktop · 2* and *Hosted · 28*, and one `<optgroup>` per place.

- **A count on a control is a FILTER** (CLAUDE.md). Tapping *On this desktop · 2* shows exactly those
  two. The chip row is drawn only when there is more than one group — one group is furniture implying
  a decision nobody has, the same rule `showBackendPicker` applies to a host with one backend.
- **Local is FIRST, and that is a recommendation whether or not anybody calls it one.** This app
  exists to drive coding from a phone against the machine on your desk; the local models are the ones
  that work with no tunnel and no bill, and the top of a list is what people take.
- **`unknown` is a real third group, never folded into `hosted`.** An id the host said nothing about
  gets its own heading and its own sentence ("This desktop couldn't say where these run"). Defaulting
  the other way would file a local model under the heading that says it costs money and leaves the
  machine, which is the single mistake this whole field exists to prevent — and it is the mistake a
  `boolean` would have made structurally.
- **No map at all ⇒ one group ⇒ the picker it has always been.** The host sets no locality for
  claude, and an older desktop sends none, so `modelGroups` answers a single unknown group and the
  markup is pixel-identical to what shipped before. That is what makes this safe to put in front of
  every backend rather than special-casing opencode.
- **A filter with no matching group is not held.** Switching backend is how you get there, and a
  selection nothing matches is an empty list with no way out, so it falls back to showing everything.
- **A model chosen and then filtered out of view is still the model that will run**, so the field says
  so rather than looking empty-handed.

**The hosted disclaimer, and the rule that keeps it from becoming a lie.** A hosted model means the
prompt — and the contents of every file the agent reads into it — leaves this machine and lands on
hardware somebody else controls. That is worth a non-dismissible warning, and it is drawn whenever a
hosted model is IN PLAY: the group is open, **or the current value is already one**. The second case
is the one a group-only condition misses, and it is where the warning matters most — picker closed,
value set, and the next thing that happens is a session reading a private repo into somebody's
server.

**waterplane states what it structurally knows and never restates an operator's data policy.** Those terms
change without telling anybody, and an app that has baked one in will eventually assert, in its own
voice, something untrue about what happened to somebody's source code — the one failure here that a
later release cannot fix, because the code is already sent. So the sentence says the data leaves the
machine and is governed by the operator's terms *and points at them*, rather than summarising them.
`backendCaps.test.mjs` enforces it: the string may not name a vendor.

**"Free" is measured, not inferred from the name.** `models.zeroCost` is the ids the backend itself
prices at 0/0 (read out of `opencode models --verbose`), never a `-free` suffix. An absent list, or an
id missing from one, is UNKNOWN — and unknown is never drawn as free, because that is the direction
that costs somebody money. The extra line it earns is again about the CLASS and checkable by the
reader ("providers of no-charge tiers commonly keep prompts and completions to train on"), never a
claim about a named vendor's current contract.

The sentence under the chips is where the rest of it lives: a hosted model
needs the tunnel up and may bill. `WHERE_LABEL`/`WHERE_NOTE` are worded around what a person is
choosing between — where the bytes go, who pays — not around "provider", which is opencode's
vocabulary and not a fact anybody on a phone is thinking about. Rules are pure and node-tested in
`backendCaps.test.mjs`; the host half that determines locality at all is `docs/notes/host.md`.

### `LocalRtBar.tsx` + `localRt.ts` — the local runner as a strip

The connection strip's shape, applied to the other thing you only find out about once it has already
gone wrong. `link.ts`'s discipline throughout: ONE store, ONE writer (`noteLocalRtSample`), one
subscribe/emit, and it **observes and never steers** — nothing here touches a session, a launch or
the queue.

- **Five states, worded apart, and never collapsed**: holding · the runner is up and holding nothing ·
  the runner did not answer · polling is off on this desktop · this desktop didn't answer at all (an
  older waterplane that ignored the frame). The middle three would all be "no models" to a lazier readout,
  and they are three different things to do about it. Pinned as five distinct wordings by a set-size
  assertion, so merging two is a test failure rather than a subtle regression.
- **Misses are DRAWN, never averaged and never bridged** (the `Spark` rule): a sample where the
  runner did not answer is a full-height mark of its own. Interpolating across one would smooth over
  the exact event the graph exists to show.
- **The ring is memory-only.** Only the last sample persists (`LS.localRt`), so an offline open says
  "last seen: qwen3-coder:30b holding 18.2 GB, 2h ago" — a cached reading that says its age. A series
  rebuilt from an hour-old buffer and drawn as current is the stale-presented-as-live failure the
  whole readout exists to avoid.
- **Three modes, not two** (`off` / `while a model is loaded` / `always on`). `auto` exists because a
  strip about local models is noise on a phone driving a desktop that is not running one. `always`
  exists SEPARATELY because auto's vanishing act makes one thing impossible — watching a model *not*
  be there — and "nothing is loaded" vs "the runner did not answer" is precisely what this readout
  keeps apart. A bar that hides itself for both can only report good news. `auto` lingers
  `AUTO_LINGER_MS` past an eviction, or it would take the eviction off screen with it. **What `auto`
  does not save is stated on the settings row**: it still polls, because it cannot know whether to
  draw itself without asking — the saving is a line of screen, not battery.
- **The provider-prefix trap.** opencode ids are `ollama/qwen3-coder:30b`; the runner's `/api/ps`
  name is `qwen3-coder:30b`. Match without stripping at the FIRST `/` and the model already resident
  looks absent, so `memoryPressureNote` then warns about a "second model" that is the one already
  loaded. Asserted directly.
- **The pressure note is a SENTENCE and never a block.** Two local models on 64 GB genuinely may not
  fit and every switch reloads from disk — worth saying loudly, not worth refusing work over: the
  size of a model this host has never loaded is unknown, `memFree` understates what is available, and
  `keep_alive` makes the conflict transient. CLAUDE.md's "nothing applies itself", applied to a
  resource fact.
- **Tokens per second is absent**, by decision, with no placeholder. See `host.md`.

### `repoColors.ts` + `RepoColorSheet.tsx` + `shared/repocolor.ts` — which repo is which colour

The per-repo colour is not decoration. It is what tells two group headers apart mid-scroll, what a
session row carries as a left stripe, and — since the tab strip — what identifies a tab at ~85 px,
where the label is one word and an ellipsis. Three things were wrong with the version that shipped.

**1. The hues were not spread.** `repoHue` was `hash * 137.508 % 360`: a golden-angle spread, which
spreads CONSECUTIVE inputs and does nothing whatever for arbitrary ones. Two repo names hash to two
arbitrary numbers, and two arbitrary numbers land 3° apart about as often as 100°. Measured on this
desktop, two of sixteen repos came out 9° apart — one colour, twice, in a strip 30 px tall. A
PALETTE removes that by construction: twelve hues at 28°–38° spacing, indexed by the same hash, so
two repos are either the same colour or a clearly different one. "The same" is a state the UI can
see and offer to fix; "nearly the same" is one it cannot.

**2. Which repo is the blue one is not a thing a stylesheet can know.** Everything else in
`styles.css` is validated against a contrast floor and picked once. This one is a person's own
association, so it is the one part of the palette that can be overruled — a hue pinned per repo,
and a choice of RING to draw the unpinned ones from (`spectrum`, `cool`, `warm`, and a
colour-blind-safe six).

**3. The colours did not match the tab strip.** See the strip's own note below: one token, one
surface.

The split is the usual one. `shared/repocolor.ts` is pure and node-tested — the rings, the hash, the
override resolution, the clash report, and `spreadRepoColors`. `repoColors.ts` is the store half:
one value, ONE writer, and a subscription. `format.ts`'s `repoHue` reads the config as a MODULE
value rather than through a hook, because there are ~30 `repoAccentStyle(...)` call sites and every
one of them is a `style=` in the middle of a list render; what a component needs from a change is
the RE-RENDER, not the value, and two components subscribe for exactly that (`App` and the strip,
which is mounted beside it and would otherwise keep the old colours until the next session list
arrived).

Rules the sheet holds, all of them the repo's own:

- **A count on a control is a filter.** *12 repos share a colour* is a button, and it opens exactly
  those twelve.
- **Nothing applies itself.** *Give them separate colours* is a tap. It says what it will do first,
  it moves only the repos that actually collide (one already alone on its hue keeps it, so the ones
  you recognise stay recognisable), and it **never moves a hue somebody pinned** — a tidy-up that
  silently un-chooses a choice is the draft-clobber rule wearing a different hat.
- **A blocked verb is a sentence.** With more repos than the ring has hues, some must share whatever
  the button does; the note says so and names the two ways past it, rather than grey out the tap.
- **A pinned colour survives a change of ring.** The alternative reading — "slot 4 of whatever ring
  is current" — moves a colour a person chose, without them asking.
- **Synced** (`waterplane.repoColors`), unlike `waterplane.theme` beside it in the allow-list. The theme is a
  fact about the DEVICE; which colour `usmc` is, is a fact about the person, and a repo recognised
  by one colour on the phone and another on the desktop is not recognised at all.

The contrast promise is kept where it always was: only the HUE is a fact about the repo, and
`--repo-sat` / `--repo-lit` per theme are swept over all 360 hues by `theme.test.mjs` — so nothing
that can be picked here can make a name unreadable. The colour-blind ring is measured there too,
under the same CIEDE2000-after-simulation code the chart palettes are held to, because a hue GAP
cannot say anything about CVD: 12° and 40° of hue are the same colour to a deuteranope.

### The session header is two rows, and the break is stated

The session screen's header was four rows of chrome over the output you came to read: the title,
the derived name under it, the chip strip, and the five icon buttons that could not fit beside the
chips. The last of those is the one worth understanding, because it was not a sizing accident that
a smaller basis would have fixed — a wrapping flex row breaks on BASE sizes before it shrinks
anything, so a chip list measuring wider than the row pushes the controls onto a line of their own
however well the chips themselves scroll.

So the break is a child now (`.hdr-row2`) holding both of the things that share the second row, at a
100% basis that can only ever start a line, with `.hdr-cmds` at a basis of ZERO inside it so a long
chip list eats its own row rather than anybody else's. `.hdr-ctl` groups the icon buttons so the row
can break between the chips and the controls and never between the controls themselves. The typing
-room keeps stay DIRECT children of the header, deliberately: the rule that hides everything else in
that mode is `.screen.typing .topbar > *:not(.hdr-typing-keep)`, and a keep nested in the group
would be hidden along with it.

Two more things came off the same pass. A header button is smaller than a button in a sheet
(40 px against `.key`'s 46×44) — the fingertip is right to spend in a menu or on a form, and in a
bar that already wraps every 4 px of it is measured against a whole ROW of the screen. And the
derived session name flows INLINE beside the branch rather than claiming a line of its own: it still
wraps and is still never clipped, which is what four words are for, but a short name now costs
nothing.

The header also wears the repo's hue as a 3 px left edge — exactly `.row-wrap`'s stripe, and exactly
the colour of the tab you got here from. In typing room the stripe goes with the rest of the bar: a
coloured edge down the side of the screen is a bar drawing itself where the bar is gone.

### `SessionTabsBar.tsx` + `sessionTabs.ts` — the sessions you have open, as a strip

The third always-on bar, and the third time the same argument about where a layer may live decides
the shape: `App` returns early once per overlay, so a bar that must be on every screen is mounted
beside it in `main.tsx` (`NetPulseBar`, `LocalRtBar`, then this). That means it can read neither
`App`'s session list nor its setters — hence a store module with ONE writer (`noteSessionTabs`, fed
by the data `App` is already rendering), one subscribe/emit, and taps that leave as events `App`
listens for (`TAB_ATTACH_EVENT` / `TAB_CLOSE_EVENT`). The two verbs are then `App`'s own `attach`
and `closeSession`, unchanged: the strip adds no send path and decides nothing about what a session
is.

**What it is for.** Everywhere else in this app the sessions are a COLUMN grouped by repo — right
for surveying twenty of them, three gestures deep when you are bouncing between two: Back to the
launcher, find the row, tap it. This is the one surface where they sit side by side, one tap from
wherever you are.

- **The colour is the repo's own** — `format.ts`'s `repoHue`, the same ring and the same pinned
  answers the launcher headers and every row stripe use, so a tab is recognised before it is read.
  It is a TINT under `--fg` text and not coloured text: a repo-hued label on a repo-hued ground is
  the one pairing the palette cannot hold at 4.5:1 across all 360 hues, which is what
  `theme.test.mjs` sweeps the circle for. The selected tab is a stronger mix of the SAME hue plus a
  cap of it on its top edge — never the accent blue, which would take the repo identity off the one
  tab you are looking at.
- **The tint is the launcher's own token, over the launcher's own surface.** `--repo-fill` is the
  hue at `--repo-veil` as an ALPHA, `--repo-fill-on` the same at `--repo-veil-on`, and the strip's
  ground is `--bg` — which is the LIST's ground, not the `--panel` a bar in this app usually wears.
  That is what makes a tab and its repo's group header the same COLOUR rather than the same hue in
  two mixes: they were `--tab-veil` over `--panel` against `--repo-veil` over `--bg`, two numbers
  tuned apart at different times, which is what "the colours nearly match" was.
  Those three shapes (`--repo-fill`, `--repo-fill-on`, `--repo-edge`) are declared on the ELEMENTS
  that carry `--repo-accent`, never at `:root`: a custom property's `var()` references are resolved
  on the element that declares it, so a `--repo-fill` written at the root resolves its accent to the
  fallback, computes to a flat transparent and inherits that down to every tab. The symptom is a
  strip of colourless blocks and nothing in the stylesheet that looks wrong.
- **Light mode fills harder than dark** (`--repo-veil-on` 46% against 40%), while the WASH goes the
  other way (10% against 18%) and stays exactly where it shipped. The light accent is a 28%-lightness colour over a white surface, so
  the mix that reads as a solid tab on near-black washes out to grey here — which is what "the tabs
  have no colour in light mode" turned out to mean; the wash stays low because it sits behind TEXT
  of its own hue on the group header — the one pairing already near the floor — and every point of it
  spends some of that. 46% is the most the fill can take and
  still carry `--fg` at 4.5:1 over all 360 hues, which `theme.test.mjs` measures rather than
  assumes.
- **The shape says which tab is the front one.** Rounded at the top only, standing on the strip as a
  rail; the open one is three pixels taller and capped in its own hue. Height rather than brightness
  alone, because "brightest" is also what a repo with a vivid hue looks like. `TAB_STRIP_H` and
  `.sess-tabs`'s `height` are one number in two files and `sessionTabs.test.mjs` holds them
  together: drift and every screen in the app either pads clear of a bar that is shorter than it
  thinks or floats one over its own first row.
- **What a tab is DOING is the launcher's answer, not the strip's.** The tab carries
  `sessionFacts.tsx`'s `SessionStatus` — the same `sessionStatus()` call the row badge, the per-repo
  roll-up and the status filter make — and wears those badges' own five colours: `--accent` working,
  `--dead` waiting on you, `--limit` at the usage limit, `--muted` idle, `--dead` exited. It used to
  hold two booleans of its own (`running`, plus a bare `turnActive`), which is a fourth copy of a
  ladder three surfaces already share, and it drifted in exactly the way that predicts: a session
  blocked on a question and a session at the usage limit both drew as the same quiet grey dot as one
  with nothing left to do, and so did a session whose main loop had stopped while two background
  agents kept working — the case `sessionStatus` exists to get right. The tooltip's words are
  `STATUS_LABEL`'s for the same reason.
- **A running turn SPINS, and only a running turn.** The glyph slot is a dot for the four states that
  are not going anywhere and the launcher's own `Loader` for the one that is — the same icon
  `statusPill` puts beside the word *coding*, so the strip and the row say "working" in one picture.
  The argument against it was real and is written into this file's own history: the strip is 34 px of
  EVERY screen and an animation there is one you cannot leave. What overturned it is that a colour is
  not motion — a green dot sat among four other coloured dots and read as a state, so "is it still
  going?" stayed a question you answered by opening the session, which is the gesture the strip
  exists to save. The mitigations are what make it payable: it runs only while a turn is actually
  running, only on the tabs running one, it stops itself the instant the turn ends, and
  `prefers-reduced-motion` stills it. Stilled, it is still a spoked RING where the others have a dot
  — a busy mark that degrades to "looks idle" would be worse than never animating.
- **How many fit is a setting, and it is not a limit.** `--stab-n` sizes each tab to `1/N` of the
  strip so exactly N fill it; everything past N is still there and the strip scrolls sideways, with
  the active tab scrolled into view when it changes. What the number decides is how WIDE a tab is,
  and therefore how much of its name you can read — which is why it is per device with the other two
  strips' argument: three tabs is a measurement of the screen in your hand. **Three and not four is
  the default** because the names are up to FOUR words: a quarter of a 360 px phone is ~85 px, which
  is one word and an ellipsis, so the default is set by legibility and the capacity is one tap away.
- **Three orders, three different things to want.** `open` is the sequence they were started in and
  never moves, so a tab's position is learnable. `frequent` puts the ones you open most under the
  thumb — a HABIT. `recent` puts the one you were last in first, which is what "where was I"
  actually asks, and is the only order that MOVES under you (the tab you just left walks to the
  front) — a choice, never the default. **The tie-break is always the open sequence**, under all
  three: two sessions with the same count, or the same unknown instant, would otherwise swap places
  on every publish depending on nothing but object order, and a tab that moves when nothing changed
  defeats the whole strip.
- **The open store keeps two facts and migrates the one it used to keep.** `{n, at}` per session —
  the count orders `frequent`, the instant orders `recent` — written by the same tap, so there is
  one store to prune rather than two to keep in step. `migrateOpens` converts the old bare count
  rather than dropping it (a count takes weeks of use to re-earn, an instant takes one tap), and a
  migrated row has no instant until it is next opened, which `orderTabs` reads as longest-ago — true
  of a session nobody has touched since the upgrade, and never "just now".
- **The open counts are per device and pruned on publish** (`pruneOpens`), never against an EMPTY
  session list — a cold start and every dead tunnel look exactly like "no sessions", and deleting a
  device's ordering history because the socket has not answered yet is a loss with no way back. The
  count is bumped in `App`'s `attach`, not in the strip: every route into a session goes through
  that function, and a count that only saw taps on the strip would rank the sessions you reach from
  the launcher last.
- **The × asks** (`Confirm.tsx`, never `window.confirm` — a native modal blocks the WebView's event
  loop). Ending a running CLI process is not something a 22 px target beside the label a thumb is
  aiming at may do on its own, and the question names the session and says the conversation is kept
  either way — it ends in `closeSession`, which is an archive, not a delete.
- **It renders nothing with no sessions**, and its published height goes to zero with it. A strip
  that is permanently empty is furniture — `LocalRtBar`'s reason for being off by default, one step
  further.
- **The label is `tabLabel`'s decision**: the host's ≤4-word `tabTitle` when it has derived one, the
  session's own title otherwise, with the repo prefix cut off the fallback (the tab is already
  coloured by that repo, so `usmc · main` in 90 px spends half the label restating its own stripe).
  Never blank and never invented.
- **The tab is not the only place those words are read.** The session screen's header shows the
  derived name IN FULL (`.brand-name`, wrapping rather than clipping, `Sparkles`
  because it is the machine's title and not one anybody typed) — which is what makes four words
  worth deriving: the strip abbreviates, and this is where the name is read whole. Absent rather
  than blank when nothing has been derived, and dropped with the model subtext in a collapsed
  header, because both are context and the collapse exists to give the rows to the output.

### `sysStat.ts` — the desktop's own numbers, in `LocalRtSheet`

The pure half of the four sections the runner sheet grew when "memory free 1.1 GB of 64.0 GB" turned
out to be the least useful true sentence on the screen (`host.md`'s `sysstat.ts` for the measurement
and the numbers).

- **The bar always adds up to the machine.** Slices are drawn against `memTotal` with the remainder
  as one explicit *available* segment, and a part that overshoots — two counters read microseconds
  apart — is CLAMPED rather than drawn past the end. A picture of a desktop fuller than it is would
  be the same lie the old number told, with better graphics.
- **A slice nobody measured is not drawn.** No 0-byte *compressed* row on a Linux host and no
  zero-width segment: an absent reader produces an absent slice, never a measurement of nothing.
- **The caption leads with AVAILABLE and still names FREE.** ~33 GB available, of which 1.1 GB is
  what nothing has touched at all — naming both is what stops the next person re-discovering the
  same confusion. macOS gets the cached-files sentence, Linux gets `MemAvailable` described as the
  kernel's estimate; one caption per `source`, never macOS's memory model narrated over a Linux box.
- **CPU busy and load average are both drawn, worded apart.** One is how much of the machine is
  busy over a named interval (`cpuSplitText` says the interval — 37% over four seconds and over four
  minutes are different claims), the other is how long the queue is. The busy figure needs a previous
  reading, so the first sample of a watch falls back to the load figure the strip has always shown.
  One bar per logical core beside it: 25% busy is either four cores flat out or sixteen ticking over.
- **Process rows are a FOLD and RSS is not a budget.** `procFoldText` says *23 processes* or *pid
  529* and never a pid standing for a fold; `rssSumText` says out loud that the column sums past the
  machine's memory because shared pages are counted per process.
- **The slow readers say their age** (`slowAgeSec`, only once it is worth saying) — the processes and
  the temperature are sampled on a longer cadence than the poll, and a 14-second-old table drawn as
  current is exactly what this whole readout exists to prevent.
- **An absent temperature is a SENTENCE, not a blank.** macOS keeps the SMC behind root, so the row
  says so and names the helper that fills it in — an unexplained gap reads as a broken app.
  `sysStat.test.mjs`.

### `TokenStatsSheet.tsx` — several ledgers, never one number

> **Moved (2026-10):** the screen is the `token-stats` extension now, `packages/extensions/token-stats/web/` (split by region; layout in [token-stats-architecture.md](token-stats-architecture.md)). `statsPlot.ts`, `TokenComposition.tsx` and `useBoxWidth.ts` live in `packages/web/src/kit/chart/`. The rules below are unchanged; only the paths moved.

The sheet called itself *every token this desktop has used* while another CLI's tokens — 179M of
them, on this desktop — were invisible to it. The fix is a SOURCE PICKER, not a wider total.

**Never merged, structurally**: no combined hero, no "all sources" chip, no summed row, and the
docs never meet in one reducer — each other ledger is its own component tree over its own DTO,
drawn by the extension that knows its shape (a `LedgerViewDef`: `ledgers.views()` in the SDK,
`guests.ts` in the sheet), so `tokenTotal` cannot silently drop a kind claude's four do not have.
Ledgers are different accounting for the same word: cache tiers mean different things, the
read/write multipliers behind `sessioncost.ts` are claude's, and an account usage limit exists for
one and not the other. A single merged number would be the most convincing wrong number this app
could print.

The chips are a **source picker and not a filter, so no counts ride on them** — a count on a control
is a filter, and a count here would be a lie about what the chip does. A contributed chip is drawn
only when its view's `hasData` says the host answered with something in it (the `showBackendPicker`
rule: one source is furniture implying a decision nobody has), so a desktop with no such ledger, or
no such extension, renders the sheet pixel-identical to before. Never greyed — absent means absent.
Resets to Claude on each open. The sheet LENDS the view its own widgets (`LedgerViewParts`:
`DayChart`, `ScopeCard`, `ScopeTag` — an extension cannot import another) and its one chart/values
switch; the view's "All backends" card is its `summary` (kinds apart), totalled and split by the
sheet, so a guest card cannot print a total without its split either. **No price the sheet cannot
source**: `pricing.ts` is claude's table and is never lent to another vendor's models.

### `hostedAck.ts` + `HostedAckSheet.tsx` — one acknowledgement before the first hosted launch

`ModelField`'s disclaimer is not enough on its own: a default chosen once is never seen again, the
per-launch ask is off by default, and every later launch is a repo-row tap with no model control on
the path. So the first launch that will actually send your code to somebody's server stops and says
so, once per device, resettable from Settings.

**The load-bearing rule is that unknown is never folded into hosted.** Only an explicit
`models.where[model] === "hosted"` gates. False for: no `backends` frame, claude, an absent backend,
a launch naming no model, `"local"`, an id the map does not name, and a verdict a newer host
invented. Defaulting the other way would put a notice about sending code to somebody's server in
front of every local and claude launch — which trains people to tap through it, destroying the one
thing it is for.

**The residual is stated rather than closed**: a hosted model reached via the backend's own unnamed
default slips the gate, because catching it means reading "no model" as hosted. `ModelField`'s
non-dismissible disclaimer covers that surface. The gate is client-side and **the host never refuses
a spawn over it** — nothing applies itself. It hangs off `askLaunchFirst`, the one seam all three
fresh-start sites pass through, and `createOp.test.mjs` fails BY NAME when a start site stops handing
its launch over, because a site that quietly un-gates itself is invisible on a claude-only desktop.

### `SweepSheet.tsx` — clearing out a transport directory

Nothing in this app has ever deleted anything from `.claude/outbox/` or `.claude/inbox/`. Measured
across fourteen repos on this desktop: **6.8 GB** in transport directories — 4.0 GB of it in ONE
repo's outbox across 31 files, 2.4 GB in a second, and a 523-file inbox in a third. The gallery's
per-file delete has existed the whole time and is simply the wrong instrument at that size; 523 rows
is not a list anybody taps through.

The sheet is the bulk answer, and it is built out of four rules this repo already had:

- **Nothing applies itself.** It plans, says what the plan is, and a person taps twice. There is no
  timer, no age at which something goes on its own, and deliberately **no "clean up automatically"
  switch** — these are the directories holding the only copy of things nobody committed. That is a
  refusal to add a feature, not an omission.
- **A count on a control is a FILTER.** The chip reading "27 · 3.9 GB" opens exactly those 27 rows,
  because the number and the cut are one function (`shared/sweep.ts`'s `planSweep`/`sweepCounts`,
  over the same `olderThan` predicate). The filtered view carries the standard `.filter-bar`:
  `n of N`, bytes of bytes, the age in words, and a clear button.
- **A count is not the decision; bytes are.** Every tally here is `{count, bytes}` and never a bare
  number. In the measured case the cut was 27 of 31 files — which reads as "most of it" — and 97% of
  the directory's size, which is the fact somebody is actually acting on. `sweepKeepText` then says
  what STAYS, because a destructive control that only describes what it destroys leaves the reader
  to derive the half they care about.
- **The list is the contract, never the age.** The phone sends the exact `relPath`s that were on
  screen; the host re-derives nothing (`files.ts sweepTransport`). A set re-cut on the desktop is a
  set nobody approved, and the window between the preview and the tap is a window in which agents in
  that repo are still writing.

Three more decisions worth the words:

- **The two directions are separate scopes and there is no "both".** The outbox is what an agent
  WROTE — re-derivable by running the thing again. The inbox is what a phone UPLOADED and may be the
  only copy of a photo. One tap that destroys both kinds is not a convenience.
- **The age ladder NESTS** (`older than a week` ⊇ `older than 30 days` ⊇ …), so the chips descend and
  read as "how aggressive do I want to be". Disjoint bins ("between 30 and 90 days") answer a
  question nobody has when the goal is reclaiming space. An empty bucket is still DRAWN: "nothing
  here is older than a year" is an answer, and a missing chip is not.
- **`now` is frozen for the life of one plan.** A ticking clock would move a row across the cut
  between the tap that selected it and the tap that confirmed it, and the number on screen must
  describe the list on screen for as long as it is on screen.

The delete goes through `ConfirmButton` (never `window.confirm`), and when a cut selects nothing the
button is not drawn dimmed — the refusal is a sentence (`Unavailable.tsx`). Afterwards the sheet
RE-READS rather than filtering rows out locally: what the directory holds now is the host's fact, and
a hand-edited list would disagree with it the moment anything failed. The result sentence keeps
"already gone" apart from "could not be removed" — the first is the sweep succeeding by another route
(an agent cleaned up first), the second is bytes still on disk under a message that says done, and
folding them together teaches the reader to distrust a clean run.

Entry point is the gallery's own toolbar, drawn only on the `inbox`/`outbox` tabs of a single repo —
the two directories the host's delete guard permits — and it hands over the tab you were looking at.

### `storagePlan.ts` + `storageAudit.ts` + `StorageSheet.tsx` — the same question about the phone

`SweepSheet` above answers "what is the desktop holding?". Nothing answered it about the device.
Connection health printed one stat — `used 340 MB` — on the one screen somebody had already opened
because they were looking for something to act on, which is the same defect the `notDelivered`
counter had two sections up: a number nobody can act on reads as a report on a problem being
handled. 340 MB tells you the app is heavy. It does not tell you that 21 MB of it is a thumbnail
cache that refills in a second, or that 3 MB of it is the only copy of a photo nobody has sent.

**This is not a second eviction policy, and it must never become one.** Every cache in this app
already has a bound: `thumbCache.ts` 24 MB / 400 entries, `offlineCache.ts` 12 transcripts and 60
tool turns, `pull.ts` 200 records and a seven-day blob eviction, `attachments.ts` 12 orphans,
`dictateQueue.ts` its own hold cap. What no bound can give you is the space back *now*, before it
would have — and a reading of where it went at all. So: measure, rank, say what each row costs, act
on a tap. No timer, no threshold, nothing on open.

**Two kinds, and never one button.** A `cache` row costs a re-fetch. A `keep` row is content: the
scrollback the TUI never put on the wire (the desktop cannot re-send it), recordings the desktop has
not transcribed, photos from sends that *died*. `sweep.ts` refuses an outbox+inbox "both" for this
reason and one tap over both kinds here would be the same mistake with more surface — so `groupUses`
returns two groups and **there is no function in `storagePlan.ts` that returns their union.** The
type of `clearGroupText` takes `UseGroup & { kind: "cache" }`, which is the structural half of the
promise; the prose half is that *Clear all caches* is built from the rows on screen, skipping any
row carrying a `cant`.

**Unknown is not zero, and the browser's own figure is not a fact.** `StoreUse.bytes` is nullable: a
store IndexedDB refused to open is an unmeasured row, it sorts last, and it turns its group's total
to `null` rather than being folded in as a zero — a total that silently omits an unknown is a wrong
number on the one screen whose whole job is bytes. And `navigator.storage.estimate()` is an
approximation that can read BELOW what was just measured, so `unnamedBytes` answers `null` rather
than a negative and `totalText` has a third branch: with more measured than reported, the two
readings are said apart instead of printing "500 B of it is named below" about a reported 100 B, a
sentence that cannot be true. Downloads count toward the named total only for the bytes the browser
is actually holding — a native download is a FILE, outside `estimate()` entirely, and adding it
would manufacture an unaccounted gap out of bytes that were never in the figure. `nativeNoteText`
says those out loud instead, because otherwise the total under-reports by the largest thing on the
phone.

**It reaches into no store it does not own.** This is the part that would pass review and be wrong.
Four of these have state in memory as well as on disk, and clearing only the disk half is a lie with
a delay:

- `thumbCache.ts`' `queued` Set is what stops the warmer re-fetching a picture it has stored. Clear
  the stores and leave it, and the cache is empty *and refuses to refill for the life of the tab* —
  the grid goes back to fetching every thumbnail over Tailscale on every paint, the opposite of what
  the tap was for.
- `screenlog.ts`' `logs` is what the reader draws from, and `dirty` is what the next save beat
  writes — so the megabytes come back, and in the meantime a person is shown scrollback they have
  just been told is gone.
- `dictateQueue.ts` keeps its INDEX in localStorage and its audio in IndexedDB, and its whole
  contract is that an index entry has bytes behind it. Clearing one side leaves the pump chasing ids
  whose audio is gone.
- `offlineCache.ts`' per-session prefetch throttle would report the transcript cache warm while it
  is empty.

So each owner exports its own `forget…` and `storageAudit.ts` calls it. `forgetDictations` also
leaves the clip on the wire alone and reports how many it did not take — deleting the audio of a
transcription that is mid-flight is a loss of words, not a saving.

`uploads` is one store holding two different things, which is why `idbMeasure` takes an `include`
predicate and `idbClearWhere` takes the same one: a `keep:`-prefixed orphan is a photo from a dead
send and is droppable with a second tap, while a photo keyed by a live ackId belongs to a message
still in the queue. That row has a **`cant`** — a sentence, never a dimmed button — pointing at the
queue screen, because the only place that decision can honestly be made is the one with the message's
words on it. `clearRow` refuses it too, so a second caller cannot route around the sentence.

Downloads are read off `pull.ts`' records rather than by measuring the store, because the record is
where "was this saved out?" lives, and that fact splits a free drop from a lossy one — and because
the native engine's bytes are not in IndexedDB at all. Dropping them is `pulls.dropBytes(ids)`:
**ids, never a rule** (`sweep.ts`' plan-is-the-contract, applied on the phone), idempotent, skipping
anything still transferring, and sharing `dropOne` with the automatic seven-day eviction so the
by-hand path cannot forget the native file the timed one remembers. The record survives, flagged
`evicted`, so every row is one tap from being here again — and the unsaved half says the one way that
is not free: the desktop prunes old builds (`artifacts.ts` keeps 3 of each), so "fetch it again" is a
promise about the build, not about the file.

Entry points are Settings → Tools → *storage*, and the `used` stat in connection health, which is now
a door: a count on a control is a filter, and this one opens exactly the itemisation of the bytes it
names.

**And then the same question about the desktop.** Two further sections, both reads over HTTP
(`shared/deskstorage.ts` holds their shapes and every sentence, because the host CLASSIFIES and the
phone DRAWS — a second table of what a kind means on this side would word "this is a ledger you
cannot delete" differently the first time a store changed hands, and that sentence is the only thing
between a person and a delete with no undo).

The repo survey is ranked rows, each with **two tap targets and no combined figure** — a merged
number could not say which scope it would open, and the two scopes are the one thing `sweep.ts`
refuses to treat as one. Tapping one opens that repo's `SweepSheet` on that scope, and the × comes
back HERE rather than to the gallery, which is what `sweepFor.back` in `features/images/store.ts` exists for: the
sheet now has two doors and a close that always returned to the gallery would strand whoever came
through the other one. The gallery's *all repos* scope — the one place its own `clear out…` is
deliberately not drawn, since no single directory is selected — gets a door to this survey, because
that is exactly the scope somebody is on when the question is which repo is fat.

The desktop-store section draws `HostStoreRow`s with the same row component as the phone's own, and
almost all of them carry a `cant`. That is the reading, not a limitation of it: each of those
sentences names the bound its store already has, which is what identifies the one that has none.

### The second sweep ladder — superseded builds

`SweepSheet`'s age chips are the right question for a transport directory in general and the wrong
one for what fills it. Measured: 33 of one repo's 38 outbox files are APKs across 13 build
families, and another holds a single family of 72. "Older than 30 days" selects those and selects them
blindly — some of what it takes is the newest copy of a variant nothing has rebuilt since.

So there is a second chip row over `shared/sweepfamilies.ts`, which is `pruneVictims` called with
every row as "produced" and nothing protected: the by-hand version of the prune `artifacts.ts` runs
after a build. It is the THIRD reader of `familyKey` (the phone's download de-duplication and the
desktop's automatic prune are the other two), and it is the same function for the reason those two
already share it — three answers to "is this an older build of the same thing" is three chances to
disagree.

Three things about it are deliberate. It is **outbox only**: an inbox holds photos whose names are
all-variable, so `familyKey` falls back to the exact path, nothing supersedes anything, and a control
that can only ever select nothing is worse than no control. It is **mutually exclusive with the age
chips** — `pickAge` and `pickKeep` each clear the other — because two predicates feeding one number
is two copies of the edge, which is what "a count on a control is a filter" forbids; the filter bar
and the confirm both name whichever ladder is live. And the **family count is said beside the file
count**, because "14 of 38" could be one family of 38 or nineteen families of two and those are
completely different decisions.

One thing it deliberately is NOT: a policy control. Prune is already on by default for every repo
(`DEFAULT_ARTIFACT_POLICY`), so a switch would change nothing; what those 33 APKs actually came from
is builds run inside a session, which never pass `builds.ts`' prune at all. The honest lever for that
is guidance, not a control — the scaffold's `CLAUDE.md` now says not to hand-copy a build into the
outbox, beside the `ARTIFACT_RULES` the build-setup prompt already carried — and the visible lever is
the chip's own count, which is on screen every time the sheet opens.

### `Gallery.tsx`

- `Gallery.tsx` — the file grid is four filters over an HTTP listing, so a dead tunnel used to mean
  eight skeleton tiles for ever. Every listing is cached per tab + coverage and re-filtered locally
  (`@waterplane/shared`'s `coversQuery`/`filterGalleryRows`: a 4h listing may never answer "all time", an
  images one may never answer "docs", and the window cuts on **mtime** with `kind=image` including
  video — the host's own rule). Cached rows are seeded before the live listing lands and always say
  how old they are. Opened text/markdown is kept per path+**mtime**, a finished auto-download is
  rendered from the bytes already on the phone (no host, and full-res for free). **Thumbnail bytes
  are cached by the PAGE** (`thumbCache.ts`, IDB stores `thumbs`+`thumbmeta`, keyed by the
  mtime-versioned thumb URL) — the service worker's `waterplane-thumbs-v1` does the same job but is never
  registered in the APK, where an offline grid is the whole point. In the worker `v` decides HOW, not
  WHETHER: versioned ⇒ cache-first, un-versioned ⇒ **network-first with the stored copy as the
  offline fallback** (cached by nobody meant network-ONLY, i.e. every path-only picture broken with
  the link down). Cache-first, so the `<img>` is
  pointed at one source and offline paints with no request at all; a LIVE listing also warms the
  first `THUMB_WARM` rows, since lazy loading otherwise remembers only what scrolled past.
  `e2e-gallery.mjs`.

  **An un-versioned document is cacheable by nobody** — `fileMtime.ts`'s rule, written for thumbnail
  URLs and true of the document pane for the same reason. The text cache is keyed on
  `(repo, relPath, mtime)` precisely so a regenerated report at one path is a different document;
  but `open.mtime` is **0** whenever the viewer was seeded from a payload carrying no version, which
  is every `galleryCtxForFile` caller that knows only a path — a notification about an artifact,
  `AssessSheet`'s *read the plan*. With mtime 0 every rewrite of that path collapses onto ONE key,
  and the viewer paints the cached hit first and writes the live text back under it. `.waterplane/plan.md`
  is rewritten at the same path by every assessment run, so the failure was concrete: run A's plan,
  read once and cached at key 0; run B finishes with a different proposal; the tap on *read the plan*
  with the tunnel down paints **run A's plan under run B's verdicts**, labelled only *saved copy from
  &lt;date&gt;* — and online, a flash of A before B arrives. One run's evidence under another run's
  conclusions is `settle.ts`'s `spendTurn` problem on a screen a person approves with one tap. So an
  un-versioned open skips BOTH halves, read and write (`versioned` in the doc effect): fresh bytes or
  nothing, never somebody else's copy of the same path. It is the general fix rather than a special
  case for the plan — any future caller that opens a path without a version gets the same treatment
  without knowing about it — and it costs only an offline copy that was never safe to keep. Every
  gallery row carries the listing's mtime, so the ordinary open caches exactly as it always did. The
  other half is upstream: `AssessSheet`'s `onOpenPlan` now passes `run.planMtime`, so the plan IS
  versioned and IS cached, by the run whose verdicts are behind it.

  **A viewer opened straight at a file has no listing behind it, and its × knows that.** The
  `openFile` route — a notification, *read the plan* — seeds the viewer and leaves the outbox grid
  rendering underneath as scenery the reader never asked for; closing the document dropped them into
  it, so the way back to the sheet they were reading was a second tap through an unrelated listing.
  `directRef` starts true for an `openFile` open and the × then closes the GALLERY, honouring
  `returnTo` through the caller's `onClose`. It is cleared by `showFile`, the one writer of `open` —
  swiping to the next image, following a markdown link, deleting an inbox file — because from that
  moment there is a listing behind the viewer and the reader has been shown it; the ordinary
  browse-then-open path is untouched, where × still means *back to the pictures*. A ref and not
  state: nothing renders differently for it.

  **The chrome read as generated, and each piece of that had a rule it broke** (2026-10-12, from
  the owner's screenshot of a 31-file outbox). The count was said three times — `outbox · 31` in
  the head, `new 31` on a chip, *showing the 31 added since you last looked · 31 here* — and a
  worded `new` pill sat on all 31 tiles under a filter that already meant "new". Two rows of fat
  chips lit three solid fills at once, and both rows held a chip spelled *all* (kind and time),
  two answers under one word. Now: WHERE is the app's `.segmented` control (`GalleryFilters.tsx`,
  the one the Apps, Downloads and Search sheets use), one tab lit; WHAT is a row of slim toggles
  where none lit means everything and a lit one carries a × — the kit's `toggleChip` rule, so the
  *all* chips are gone rather than renamed. The badge's cut is the kit's `FilterBar`
  (`galleryCuts.ts`), which names the rows actually listed only when they differ from the badge's
  number and never while the listing is on the wire. `new` is a dot, and inside the badge's cut no
  mark at all. The count is said once, in the head; the build stamp is that count's long-press
  text, because Settings › app version is where the APK says which bundle it runs. A document tile
  is a file-type glyph (`DocIcon.tsx`), not its extension in monospace across the picture. An empty
  grid under a time cut says *Nothing from the last 4 hours.* with the way out — it used to say
  the outbox was empty, a false statement about a full outbox. And app-wide: `.key` began as the
  terminal key bar's class and became every button, so every button was monospace; monospace says
  *this is a key or a command*, so only `.keys .key` keeps it.

### `docKind.ts` — one click on a notification about a file

The feed listed an outbox drop as **tap to download**, and that is all the row did. On a phone a
download of a six-kilobyte markdown report is three steps and a detour: a transfer, the
notification shade, and whichever app Android decides renders `.md` — to read text this app was
already able to paint, in a viewer that was already built (`Gallery.tsx`'s document pane, cached
per path+mtime and readable with the link down).

So a tap on a notification whose file the viewer can render OPENS it, and the download becomes its
own 36 px target beside it. Two verbs, because they are two different wants: read it now, keep it
on the phone. Everything the viewer cannot paint — an `.apk`, a `.zip` — is the download it always
was, since a viewer whose only answer is "nothing here can render this" is worse than the transfer.

The predicate had to leave `Gallery.tsx` to make that possible: the feed decides before any viewer
exists, and a second copy of "is this markdown?" is exactly how a row and the screen it opens come
to disagree about the same file. `docKind.ts` is that one table (`isText`, `isPdf`, `isImageKind`,
`isAudio` → `viewerHandles`), pure and node-tested (`docKind.test.mjs`), and the gallery imports it
rather than keeping its own.

Three paths reach the viewer, and all three go through `galleryCtxForFile()`: the in-app row, a
push tapped while the app is open (the SW's `download-file` message), and a COLD tap, where the
target rides in on the hash and seeds `overlay`/`galleryCtx` at boot — so no listing has to have
landed for the document to paint. The viewer renders from the notification's own payload
(`Gallery`'s `openFile`), which is the point on a tunnel that is not answering. Closing returns to
the feed rather than the launcher (`returnTo`), because an alert is rarely the only one waiting.

The host words the alert to match what the tap does (`files.ts` `readsInline` → "tap to read" or
"tap to download"). Nothing enforces that its list and `docKind.ts` agree — widen them together.

#### HTML is a page, not a wall of tags

`.html` was on the `isText` list, so the viewer painted a deck as its own source: `<link
rel="preconnect">`, a hundred lines of `:root` custom properties, and no way to see the thing. The
file was WRITTEN to be looked at.

So `isHtml` joins `isMarkdown` under one predicate, `isRich`: the two kinds this viewer shows
FORMATTED first and as source on request, sharing the toolbar's one `rendered ⇄ source` button.
One predicate rather than two spellings, because the toolbar, the render branch and the "saved
copy" line under the path all ask the same question, and a second copy is how one of them starts
lying.

Three things the rendered branch does deliberately:

- **It is a frame over the FILE, never over `doc.text`.** The fetched text is cut at `PREVIEW_MAX`
  for the source view; half a document does not render as half a page, it renders as a broken one.
- **It sits AHEAD of the text gates.** A rendered page needs no fetched text, so a doc read that
  failed or is still in flight must not stand between you and the picture — and the two notes that
  bar carries ("first 32 KB", "saved copy from …") are claims about that text, so they are hidden
  while the frame is what you are looking at.
- **`sandbox="allow-scripts"`, with no `allow-same-origin`.** An artifact is a file the agent wrote;
  rendering it is running it. The opaque origin means its scripts work (a deck with a script still
  behaves) while its requests carry `Origin: null`, which `host/src/origin.ts` refuses by name — an
  artifact cannot call the API that produced it. `referrerPolicy="no-referrer"` keeps the repo path
  out of anything it loads. Adding `allow-same-origin` back would hand a generated page the whole
  daemon; it is the one attribute here that must not be relaxed.

The frame is `fileSrc`, so a copy already pulled to this phone paints with the host down, like
every other media kind in this viewer.

### `ArchiveSheet.tsx`

- `ArchiveSheet.tsx` — **the route back to a session you closed.** The × on a session row is an
  ARCHIVE, not a delete, and the toasts now say so. It sends **`session.remove`, never
  `session.kill`** (`closeSession`, and the `closecheck` answer that fires it): kill ends the PTY but
  leaves the row listed as `exited`, so the tap looked like it did nothing — and that leftover row is
  what `conversationOpen()` reads as "this conversation is already open", which SUPPRESSED its
  "Recently closed" entry, hiding the route back in the same gesture. `remove` kills a live session
  first, so both states take one verb. `session.remove` is answered with the session list even for an
  UNKNOWN id: the client asking is holding a row for it (a snapshot painted offline, a list from
  before a restart) and silence leaves that row on screen for good. `e2e-archive.mjs`; this is where the conversations live once
  "Recently closed" has rolled over. Repo-scoped (a log lives under its directory), titled by first
  prompt, paged, and search is a SUBMIT rather than a keystroke filter — matching a query costs the
  host a title read of every log in the directory. A conversation that is already open shows as
  *open now* and offers a jump, never a second `--resume` of the same chat. Its entry point is the
  launcher header, deliberately NOT the "Recently closed" section header: that section disappears
  when the shortlist empties, which is exactly when the archive is the only way back.

### `FilesSheet.tsx`

- `FilesSheet.tsx` — the repo browser, and the rare edit. Deliberately NOT a Gallery tab: a gallery
  listing is keyed by COVERAGE so one can be re-filtered into another (`shared/gallery.ts`), and a
  directory listing has no coverage — it is the folder you asked for or it is not. Listings and
  opened files are cached and SAY how old they are; **saving is never queued**, because a write
  composed now and replayed in an hour carries a base the file left behind long ago, so the save
  button is disabled with that reason when the socket is down. A `stale` refusal keeps the typed
  text and offers a reload — it never re-sends with a fresh base, which is the one move that would
  overwrite whatever the agent just wrote.

### `ContextLimits.tsx` — arguing with the threshold

The `context-weight` row is the one finding on the repo-setup checklist that is a COMPARISON rather
than a fact: every other row says something is or is not true of the repo, this one says a number is
over a line. Which makes the line part of the finding, and until now it was unreachable — three env
vars on the desktop, host-wide, needing a restart. The row's own sentence gave it away: *"over the
16k you asked to be warned at"*, said on every desktop that had never exported a knob, about a
shipped default the phone could neither see nor move.

The cost of that is not the wording. Two repos need different lines for opposite reasons — a scratch
project where 16k of instructions is already absurd, and one whose invariants are genuinely
load-bearing, which will sit amber for ever. The second is the dangerous one: an amber that cannot be
answered is an amber the user learns to skip, and then the check that catches a `CLAUDE.md` growing
by a clause a week is a check nobody reads. The row already refuses to auto-patch because the trim is
a judgement; the threshold is a judgement too, and it is one the app CAN take.

So the row grew a third affordance, next to `fix` (host patch) and the remedy prompt (agent work):
the thresholds themselves. Four things it does deliberately:

- **It opens on the STORED override, not on the effective number.** Those differ whenever the host's
  env is doing the work, and a form pre-filled from `effective` would convert *inheriting 20k from the
  host* into *pinned at 20k for ever* the first time anybody pressed Save — silently, and in the one
  direction nobody would notice. `ContextLimitsView` therefore carries `repo` and `env` apart from
  `effective`, and the placeholder — not the value — shows what is being inherited.
- **A blank field is “inherit”, not zero.** One knob moves without freezing the other two at
  whatever today's defaults happen to be.
- **Every number states its source**: *default* / *set on this host* / *set for this repo*. That is
  what makes the sentence above it trustworthy again, and it is why "back to the host's line" and
  "back to the default" are worded from `env` rather than being one label.
- **Nothing is greyed out and nothing is repaired.** An out-of-range value gets a sentence; the host
  runs the same rule from `@waterplane/shared` and is the one that decides, so this form is speed, never the
  gate. The host answers with the RE-RUN report, so the paragraph upstairs restates itself against
  the line just set instead of asking the reader to re-check and believe it.

The store, the resolution order and why the override is a host file rather than one written into the
repo are in [host.md](host.md#context-weight--what-a-repo-costs-to-have-open).

### `SendSheet.tsx` + `sendIntent.ts`

- `SendSheet.tsx` + `sendIntent.ts` — **the one send surface**, behind every entry point that used
  to be its own sheet. Twelve of them each hard-coded a different combination of the user's four
  orthogonal decisions — **WHAT** (a prompt, a chain, a build command), **WHERE** (a live session, a
  repo's work items, a fresh session, N repos, a shell), **WHEN** (now, when it's free, at a
  wall-clock time) and **HOW MANY AT ONCE** — forced them in a different order, and answered the ones
  they did not ask by existing. So "queue this for later" was in one sheet and missing from the next,
  and sequential-vs-parallel was never a composition-time choice at all: it was a property of the
  sheet you opened, or a repair made afterwards in the queue manager. Text first (`PromptComposer`),
  then **two collapsed summary rows, *To* and *When***, pre-filled from context and expanding in
  place; the primary button **restates the whole decision** ("Send to fix-e2e now", "Save for Thu
  20:00") and is live the moment there is text — disabled, it says why, the rule `ScheduleSheet`
  followed and nothing else did. `sendIntent.ts` is the vocabulary and the pure rules
  (`sendLabel`/`sendBlocker`/`sequentialMeans`, the time chips, the anchor/lead editor's constants);
  `dispatchIntent()` in `core/send/useSend.tsx` maps one `SendIntent` onto the send paths that **already exist** —
  `submitInput`, `queueBacklog`, `startSessionWithPrompt`, `fanout.run`, `schedule.save`, `build.run`
  — and **adds none**. Sequential is offered only where it can mean something (`sequentialMeans`): N
  repos (a fan-out, or one waiting item per repo) and a new session (the queue's
  `serial`, one agent per repo). A `SendSeed` carries where the words came from — `cwdHint` for
  home-first ordering, and the queue row / pad note / give-up row a successful post retires — which
  is what stops "send again" asking which repo. `repair: true` turns on the file check and the
  per-file fixes, i.e. what `ResendSheet` was. **Absorbed and deleted**: `StartSheet`, `ResendSheet`,
  `ScheduleSheet`'s editor (its list stays — a standing thing needs a list; `new`/`edit` seed this),
  the pad's four per-note buttons and three inline pickers (one **send…**), and the compose bar's
  per-repo `sendMode` (persisted and invisible: a repo silently left in "later" turned the primary
  button into a schedule editor days after anyone chose that, discoverable only by tapping it — WHEN
  is a decision about ONE message), and — since the collapse below — **`Backlog`'s add form**. Left
  alone deliberately: `FanoutSheet` (its runs list and presets), which still composes and which the
  Send sheet can express.

#### The *To* row after the collapse: three answers, and a chip

The row offered four: *session* · *work item* · *new session* · *several repos*. Two of those were
one thing. **`work item` meant "the repo's shared backlog conversation"** — every item ever queued
for that repo appended to one session, which `shared/sessioncost.ts` measured as the shape of the
124 conversations that were 76% of this desktop's whole token spend — and the UI never drew that
session, named it, or gave anybody a way to find out that was what they were choosing. It is retired
host-side (`cleanTarget` normalises every repo target to `fresh`), so the two segments now DO the
same thing and one of them is drawn:

> **`this session`** · **`a new session`** · **`several repos`** (and `shell`, still seeded-only).

What was genuinely different about continuing survives as a **chip under `a new session`: *pick up
its last conversation*** — `resume: true`, i.e. `claude --continue`, which needs no live session and
nothing still open. Its hint says the other half out loud, because that is the half with a price on
it: *"otherwise it starts clean — cheaper for anything that does not need what the last one knew."*
A choice somebody makes on the send, never a side-effect of which segment they happened to tap.

**With nothing open, `this session` is not drawn at all.** It used to be a segment with
`disabled={!live.length}` and its reason in a `title` — on the one device this sheet is ever used
from, an unlabelled `opacity: .4` and a sentence nobody can reach, which is the pair `Unavailable.tsx`
exists to end. Tapping it was not an option either: `firstSession` with an empty list answers a REPO
target, so the segment saying *this session* would silently have switched the send to a new one.
So the control goes and the fact stays — `<Unavailable>` under the segmented row, *no “this session”
— nothing is open on this desktop right now* — which is the same treatment the empty chain picker
gets one row down.

The labels follow. `targetWords`: `X · work item` is gone; what is left is `X · a new session` and
`X · a new session, continued`. `sendLabel` for a repo is one string per WHEN — **`Start in X`** and
**`Queue for X · a new session when this repo is free`** — because one target means one label, and a
second wording for the same send is how two surfaces end up describing one thing as two. (`Run in X
now` and `Open X when it's free` were the other reading's half of the pair and went with it.)

**One clause for the fresh-session wait, and it names what is busy.** That label said *when it's
free*, the toast after the tap said *when that repo is free*, and the hint under the row said *when
a slot is free* — three spellings of one condition, met in that order by anybody using it once. All
three say **when this repo is free** now; what that MEANS is the sentence after it, in text rather
than in a `title` no phone renders (a slot on the desktop, and nothing else running in this
checkout), and a live session's version is still its own wait: turn ended, no question open, no
usage-limit block.

**Offline, the button does not say `Queue` twice.** `offlineLabel` adds the prefix only where the
label does not already open with that verb; unconditional, the commonest label on this sheet read
`Queue · Queue for usmc · a new session when this repo is free` — one decision announced twice, on
the one control a person reads before committing.

**A chain into several repos is refused in words.** `after` + `{kind:"repos"}` is the fan-out, and
`fanout.ts` reads `steps[0]` and nothing else, so turns 2..n were dropped on the desktop with no
sentence anywhere — typed, reported sent, draft cleared, gone. `sendBlocker` says *a sweep is one
prompt — chain a single repo, or send one turn* while the composer is still on screen. Its label was
wrong in the same direction: `Queue in N repos after "x"` is the SEQUENTIAL wording on the one
target that is never sequential (`sequential` is not read in that arm at all), so it reads **`Fan out
to N repos after "x"`**.

`sendIntent.test.mjs` pins every one of these strings — a reword is a decision about the app's
vocabulary, so it is a decision that edits the test.

**Leaving the clock does not delete the rule.** `ruleMemo` remembered a rule across an ANCHOR
switch, and nothing remembered it across the far more ordinary gesture: set *at a time* → *repeating*
→ Thu → 16:00 → *more* → run hours → a name, then tap `when it's free` on the row above to see what
it says, and seven taps are gone with no sentence about it — the "writing over words nobody typed"
rule, applied to a decision rather than to prose. Every exit from `at` goes through one function
(`leaveAt`) which parks the WHOLE `when` in `atMemo` — grace, the name and *hold until the desktop is
free* are part of the same decision, and restoring three fields out of four is its own small delete —
and row one carries a line saying the schedule is kept. Coming back restores it whole; only the rule
is re-anchored when the tap names the other anchor, which is what `ruleMemo` has always been for.

That chip is **`hold until the desktop is free`** now, and was `wait until it's free`: with an `at`
rule set it sat four lines under row one's `when it's free`, two near-identical phrases meaning two
different things on one screen — an instruction about a live target, and a hold on a due schedule.

**"Not armed yet" is not "never".** `previewOf` resolves an `at` rule through the same `nextFireAt`
the host ticks on, and it answers `null` for two unrelated reasons. A `once` rule whose instant is
behind us is genuinely spent — that one blocks the button, and the words say so. A **window** rule
anchored to a usage reset answers `null` until the host has scraped the meter once, which is the
normal state of a rule the second it is written, and is what the editor itself says three paragraphs
higher up: nothing is armed until the host has read the window. The sheet wrote both as *never — the
time it resolves to has passed* and refused the save, so a weekly-window sweep — a lead time, a
headroom condition, every answer filled in — ended on a blocked button telling the user their
schedule was already in the past. A reset the phone CAN see resolves the rule properly now, because
the sheet is handed the usage reading it is already displaying in the topbar (`usage` ⇒
`previewOf(when, resets)`); with no reading, the row names the anchor (`describeRule`) and says it
arms when the host reads the window, and the button saves it. The one blocker left is a `once` in the
past — a weekly wall-clock rule always finds a next day, and a standing window rule is never spent,
so refusing either was refusing the feature rather than the mistake.

**Picking a time re-aims the target; it does not refuse it.** The composer's one errand opens this
sheet seeded To = *this session*, which is right for nearly every send that starts on a session
screen. Tap *at a time* on top of that and the primary button went dead under `sendBlocker`'s *"a
session id is per-boot — schedule it against the repo instead"* — a true sentence, handed to
somebody who had just made a decision, telling them to go back one row and make the second decision
that follows from the first. Nothing was wrong with what they picked; the *seeded* answer was wrong,
and it is the one answer the app can work out for itself, because a session already carries the repo
it runs in. So `scheduleReaim` turns a session target into `{kind:"repo", cwd}` on the tap that
creates the conflict, and `reaimWords` says so in a **`form-hint` under the anchor row** — a `title`
is invisible on the only device this sheet is used from:

> *This was going to fix-e2e. A schedule cannot name a session — the id lasts only as long as the
> process does — so it now opens a new session in usmc when it fires. Change that under To.*

Said on the tap and not later, because a re-aim discovered afterwards from a *To* row quietly
reading something else is a decision made behind somebody's back. Nothing typed or picked is
discarded — the words, the chain, the attachments and the anchor all stay — and the sentence retires
itself the moment the re-aimed target is no longer the one on screen. The **refusal survives for the
case that genuinely cannot be re-aimed**: a session row carrying no `cwd`, where guessing a repo
would schedule somebody's prompt against a directory nobody chose. Both halves are pinned in
`sendIntent.test.mjs`. (`scheduleReaim` and `reaimWords` are since gone — see *A clock may name a
session, because the conversation outlives it* below, where `clockSessionNote` replaces the re-aim
with a session target that survives unchanged.)

#### The *When* row: three anchors, and the rare power under *more*

Scheduling is the one part of this collapse that was asked to get MORE expressive, not smaller — the
user's words were that the scheduling options *"even can be thought further to be more useful"* —
and the shape that keeps both is: the row still reads as **one question with a pre-filled answer**,
the top two rows stay the four common answers, and everything rare is one disclosure away.

**Row one is not a schedule at all.** `now` and `when it's free` are instructions about a live
target. **Row two is the ANCHOR**, and it now has three segments rather than two:

> **`at a time`** · **`a usage window`** · **`after another…`**

*after another…* is the third thing a send can wait for, and the one the other two could not
express. A clock and a live target are both answers to the world; neither can say *"when the
migration finishes, review it"* — the commonest real dependency there is, and the one people were
expressing by guessing a wall clock far enough out. That guess is either wasteful or silently wrong
in the direction of reviewing a half-finished migration. It earns a top-row seat rather than a place
under *more* because it is an ANCHOR: it answers the same question the two segments beside it
answer, and a control that answers the row's own question and is hidden from the row is a control
nobody finds.

It opens a picker of what this desktop is holding — `chainCandidates(intents, now, selfId)`: what is
**running**, then what is **waiting**, then what **settled in the last six hours**, in that order,
because a flat newest-first list buried the running row (the one a chain is nearly always hung off)
under everything queued after it. A `canceled` row is not offered — a chain behind one is released
immediately with `ok: false`, which is a surprising thing to offer and a pointless one to pick — and
a **failed** one is, because whether the predecessor succeeded is exactly what the chip beside the
picker is about.

**A RECURRING rule is not offered either, and that one is not a matter of taste.** `facts.settled` is
terminal-only by contract and a standing rule never goes terminal — it fires, re-arms and does it
again — so a chain hung off *the nightly sweep* reads *waits for “the nightly sweep” to finish* on
every tick until the desktop is switched off. True, reassuring, and permanent: offering a predecessor
that can never release the work is offering a way to lose it. The test is `ruleRecurs`, the same
function the host reads, so this list and `IntentFacts.neverSettles` cannot reach two conclusions
about one row — and a one-off is still offered, because recurrence and not the anchor is the
question (a `weekly` rule marked `oneShot` ends like any other row). The filter is a COURTESY rather
than the guard: a rule can be edited from *once* to *every day* long after the chain behind it was
made, so the ladder fails such a row with a sentence naming it.

**The rows are titled by `intentTitle`, exported from `activityRows.ts`**: the name
the picker shows is SNAPSHOTTED onto the trigger (`IntentTrigger.after.title`) and becomes what the
waiting row says about itself for the rest of its life, so a second copy of the titling rule living
in the sheet would drift — and the first thing to drift would be a schedule titled by a mid-word
slice of its own prompt, which is the bug that rule already exists to stop.

**An empty picker is a state that is WORDED, never a dimmed segment** (`CHAIN_EMPTY`) — a `title`
saying why is invisible on the only device this sheet is used from. The chip is *only if it
succeeded* (`onlyIfOk`), and its off-state sentence carries the case it is the default FOR: *"it
runs either way — “run the tests, then tell me what happened” wants to run when they fail."*
Underneath, `CHAIN_NOTE` says the two things a reader would otherwise have to discover by looking in
the wrong sheet: a chain has **no deadline** (a desktop that slept through the event has lost
nothing), and it is **not a schedule** — no recurrence, no clock to arm, so `isBacklogRow` files it
as work and it appears in Activity, never in Schedules.

**A chain may name a live session; a clock may not.** `scheduleReaim` existed because a rule may fire
days out and a session id is per-boot. A chain is released by an event usually minutes away, the
store holds a `session` target natively, and the ladder already has its own sentence for a session
that went (`sessionGone`) — so *"when the migration finishes, tell THIS session about it"* is left
exactly as it was composed. It is the one WHEN that cannot ride on `backlog.add`, which carries no
trigger at all: a chained send goes out as **`intent.post`**, added to `DurableOp` for its own
reason — `ok` is not sent until the row is on the desktop's disk, which is the moment the phone may
forget the words, and `intent.id` is a second at-most-once key that outlives the ack ledger.

**Under *more*: the RUN window — and it is not called quiet hours anywhere a person can read it.**
The fields default to 07:00–22:00 and `inHours`, `describeRule` and the host all read them as the
hours the rule MAY run: the loud ones. Two labels called that window *quiet hours* — the disclosure
(*more — lead time, quiet hours, late runs, a name*) and the section head — so anybody who wanted
"not while I'm asleep" set 22:00 to 07:00 and got exactly the opposite of what they asked for, while
`describeRule` and `hoursWords` underneath told them the truth. They read *run hours* and *the hours
it may run* now. Two `<input type="time">` and an *any time* chip, writing
`ScheduleRule.hours` — minutes of day in the rule's own zone, half-open, wrapping midnight. It is
under the disclosure and not beside the anchor because **it is not a second anchor and never moves
the occurrence**: "every day at 03:00" is a fact about when the work becomes worth doing, and "not
while I am asleep" is a policy over every anchor (which is also why `composeRule` carries it across
an anchor switch). `hoursWords` owns all four readings, and two of them are the point. A window that
**wraps** is said out loud rather than left to be inferred from two numbers in the wrong order, and a
window with **no width** — both ends on the same minute — is a sentence rather than a silent
no-op: `cleanRule` drops it rather than guessing between "every minute" and "no minute", so the
screen owes the reader *"it is dropped rather than guessed at, so the rule would run at any hour —
move one of them."* Every case names the OPENING, because that is what lateness is counted from
(`hoursOpenFrom`) and it is the most surprising thing about the feature: a 03:00 rule behind a 07:00
window is not four hours late, it is a schedule working.

**The headroom guard now names WHICH meter.** `Only if there is headroom` used to be drawn under
*before it resets* alone, which was right while a condition could only ever read the window the rule
was anchored to — and which made the one instruction people kept asking for unsayable: *"right after
the session window resets, but only if 30% of the week is left."* The anchor has to be the session
reset (that is the instant the work becomes possible) and the condition has to be about the week
(that is the allowance a thirteen-repo sweep eats). So the block is drawn under **both** edges, and
once a percentage is set a segmented control names the two meters — storing `guardWindow: undefined`
for the rule's own one, exactly what `cleanRule` would keep. It is labelled by its VERB (`GUARD_LABEL`:
**checks the session meter** / **checks the weekly meter**) and not by the noun, because ten lines
above it the anchor segmented already reads `session window` / `weekly window`: two controls wearing
the same two words on one screen asks the reader the same question twice, with the difference
carried only in a section-hint. The prose keeps the nouns — `guardWords` and `describeRule` are
sentences, not controls. `guardWords` is the sentence, and it has three readings because there are
three facts: the condition reads the anchor's meter; it reads the OTHER one (*"it waits for the
session window to reset, then asks about the weekly window"*); or it is written in the one shape
that cannot be evaluated at all — an `after` edge guarding its own window, which is empty by
definition. That last one is **said, not dimmed and not refused**: the rule saves perfectly, it
simply loses the clause, so the screen says what will happen and what to do instead. `describeRule`
spells the same two clauses on the row, and nothing in the sheet re-words what it already says.

**One chain is still cut, and still says so.** A chain under a clock keeps only its first turn:
`schedule.save` is the one send path that goes through `ScheduleAction`, whose `backlog` arm has
`text` and no `steps`, so there is nowhere on the wire for turns 2..n to sit between `dispatchIntent`
and `scheduleToIntent`'s `payload: { steps: [action.text] }`. Deleting the toast before the field
exists would be the worse half of the fix — the turns would go on being discarded with nobody told,
which is the one thing a send surface may never do with words somebody typed.

**A re-send ends on the session it went to.** `SendSeed.openAfter` is set by the three entry points
that are a re-send of a message that never arrived — the Activity row's *rewrite it*, the queue
row's *send again*, and the not-delivered bar's *put it back* — and after a successful post `App`
attaches the session the intent named. All three are reached by somebody who has just been told
their words are unsent, and the only answer to "did it go this time?" is the session's own screen:
before this the post left them inside an overlay, two screens and a dismissal away from the one place
that could tell them, with a toast as the whole report. The target is read off the **`SendIntent`**
and never off the seed — the sheet exists so the destination can be re-decided, so the seed holds
what was proposed and the intent holds what was chosen — and a rewrite re-aimed at a repo or a sweep
opens nothing, there being no one screen for those. A session that has since gone says nothing
either: `dispatchIntent` has already spoken for that tap, and a second sentence contradicting the
first is worse than silence.

**The whole decision survives the annotator, not just the words.** Attaching a picture hands the
images to the annotator, which REPLACES this sheet — so the sheet unmounts and is built again when
the marked path comes back. The prompt survives because it is a draft written to disk per keystroke;
WHERE, WHEN and HOW MANY AT ONCE were re-read from the seed, so a schedule set before attaching came
back as **now** — silently, on the one send whose entire point was that it was not now, and with the
primary button restating the wrong decision confidently. `SendResume` is the same promise for those
three, reported through `onDecide` on every change (never on the way out: a component that unmounts
in the same commit does not get to run a cleanup first) and held by `App` in a ref that is cleared
with the seed, so one send's schedule can never be inherited by the next. It is deliberately not
folded into `SendSeed`: a seed is where the send CAME from and is written once by whoever opened the
sheet; this is what the person has since decided.

### `BuildSheet.tsx` — the third answer to an empty field, and the button that asks

`BuildSheet.tsx` was split along the screens it draws: `BuildEditor.tsx` is the add/edit form with its free suggest list, `BuildRunAsk.tsx` the form between the tap and a parameterised run, and `BuildArtifacts.tsx` the `ArtifactPolicyRow` (collect, remove older, keep count) and `ArtifactRow` download rows.

- **What a build LEAVES BEHIND is a row on this sheet** (`ArtifactPolicyRow`): *collect + name*,
  *remove older*, and the keep count, per repo, both switches ON by default. It is here rather than
  in a settings screen for two reasons. It is read in the second before a build is tapped — that is
  when "what will this be called, and what will it replace?" is a live question — and what it
  governs is visible nowhere else on a phone: a name in the download list, and files that stop
  existing. The switches are `SetSwitch` rows (state = the `on`/`off` at the edge); the sentence
  saying what the NEXT build will do (`artifactPolicyText`) is behind the head's `?`, so a switch
  never has to be decoded from its label; "keep − 3 +" is one line, the count a plain readout, each
  stepper absent at its end (2026-10-12: the labels used to read "✓ collect + name: on").
- **`undefined` is not the default.** A host that has not answered (or an older daemon that never
  will) draws NO row. A default painted as this repo's policy is a claim about what the next build
  is about to do to files on disk, and this is the one screen where that claim has to be true.
  Offline the switches are replaced by the reason — the policy lives with the project on the desktop —
  never by dimmed chips, which on a phone explain nothing.
- **The prompts carry the same rules** (`ARTIFACT_RULES`, in both). The first generation of them
  produced, across nine repos here, exactly the three defects the host now owns: a deliverable
  called `app-debug.apk` in three different projects, a script copying its output and leaving the
  original so the phone fetched 227 MB twice, and nothing anywhere that removed an old build. A
  generated command must therefore not copy into `.claude/outbox/`, not stamp a version into the
  file name, and not delete anything — waterplane does all three after the run (host.md, `artifacts.ts`),
  and a command that also does them does them a second time, differently.

- The sheet already had two answers: the header's **set up** (a whole agent turn on the whole repo)
  and the editor's free suggest list (`build.scan`). The third is **`work it out`, in the EDITOR** —
  one agent turn on ONE entry, seeded with whatever is typed in the three fields. The sizes are the
  point: adding "the same as the release APK but for the other flavour" should not re-read a monorepo,
  and the whole-repo prompt merging a second opinion over five working buttons is the failure that
  shape has. Both prompts live in **`buildPrompt.ts`**, pure and pinned (`buildPrompt.test.mjs`),
  because a prompt is a contract with a machine and a JSX file cannot be imported into a node test.
  They share ONE copy of the `.waterplane/builds.json` schema — two copies drift, and the drifting one is
  always the one an agent is reading.
- **The question is asked on the PHONE, before anything is spent.** The first version put it in the
  PROMPT — *ask me what I want before writing anything* — and the session did what a session does: it
  opened and started working on a button nobody had described. **A rule a model may decline is not a
  gate.** The wand now opens a box (`PromptComposer inline`, `chain={false}` — the one prompt-writing
  surface, never a fifth textarea) with the three fields travelling alongside it, and nothing leaves
  the phone until the button under it is tapped. With nothing said and nothing typed the verb is a
  SENTENCE (`ONE_BUILD_NOTHING`), never a dimmed button — a session opened on silence guesses. The
  prompt's own *ask me* branch survives as the belt for a seed that carries no words at all. On
  an EXISTING entry the prompt names the id and says *edit that one in place* — appending a
  near-duplicate is how a sheet ends up with "Release APK" twice and no way to tell which one the
  schedule fires. Delivery is the same route as `set up`: the ordinary durable create-and-prompt
  path, the agent writes the file itself, the list refreshes on the next open. There is no reply
  channel back into the form and deliberately so — the FILE is the contract.
- **A parameterised build does not run on a tap; it opens its form** (`BuildRunAsk`). Two rules, both
  `shared/buildparams.ts`' and both re-asserted on the host: nothing is picked for you (a choice with
  no answer shows no selection, and the Run verb is REPLACED by the sentence saying what it still
  needs — `Unavailable.tsx`, never a dimmed button), and a list that could not be read SAYS SO (a
  failed `optionsCmd`, or a phone with no link, falls back to a typed field carrying the reason; an
  empty drop-down and a broken one look identical and only one of them is about this repo). The form
  shows the listing command itself, because it is a command out of the build config that ran when the
  form OPENED — before anybody confirmed a run — and that must never be a surprise.
- Seeded from the stored defaults and **nothing else**: a remembered "last value" is the one thing
  that would make this form lie, since the point of asking is that this run may not be the last one.
  `buildOpts` is not cached to disk for `buildCands`' reason plus its own — a remembered list of a
  monorepo's apps is stale the week somebody adds one, which is the case the feature exists for.
- The values ride into the queue row's NAME (`buildRunTitle`), because a durable build may sit in the
  outbox for an hour and two rows reading `build “Screenshot”` are two rows nobody can tell apart.
  Run rows draw them as their own line for the same reason `when` was added to them.

### `ScheduleSheet.tsx`

Three things a schedule list has to answer that this one could not.

**Which kind is this?** A repeating rule is standing policy — the question about it is "is it on, and
when is the next one". A one-off happens and is then history. They were one stream sorted by
`nextAt`, and nothing on a row said which it was: `describeRule` renders `once - Wed, 9 Sept, 21:00`
for one and `Thu - 16:00` for the other, and both read as a date. So the list is two sections,
**Repeating** and **One-off**, each drawn only when it has rows (a list of nothing but one-offs is
not two headings and a gap), and every row carries its kind as a tag.

**Can I stop the next one without losing the rule?** The switch already did exactly that —
`setArmed(false)` clears `nextAt`, `setArmed(true)` re-arms from NOW and never fires the occurrences
it slept through — but it called itself *off*, which reads like something turned into scenery rather
than something waiting for you. It is **pause** / **resume** on a repeating rule, and a paused row
says what it WOULD do (`nextFireAt(rule, now)`, computed on the phone from the rule it already has),
because otherwise the cadence you set is invisible for precisely as long as the rule is switched off
— which is when you are deciding whether to switch it back on.

**Just this once, though?** That is a different verb, and the difference is who has to remember: a
pause waits for you to come back, `schedule.skipNext` does not. The host SPENDS the pending
occurrence — `lastOccurrence`, the same field a real fire writes — rather than stepping over it, or
the tick reads it as due again a second later. It is refused for a `once` (skipping the one run a
one-off has is deleting it, and the row would come back marked spent, claiming it had run), and it
is deliberately not durable and never queued offline, for `intent.cancel`'s reason: a skip delivered
an hour late spends an occurrence that has already happened.

And one route rather than a receipt: a `backlog` schedule's whole effect is a WORK ITEM, so what it
reports is `queued in usmc - item 936ff54f`. That id was the end of the trail — the item is a
different row in a different sheet, and the session that ran it is one hop further — so the row named
something nothing on the phone could act on. `ScheduleResult.childId` is the first hop as a field
(set by `main.ts`'s `workItem` executor, carried through `IntentResult`), the item's own `sessionId`
is the second, and the sheet walks both. Where the item has not been typed into anything yet there is
no session id to jump to, so the button falls back to `backlog.openRepoSession` — the session this
repo's work runs in, opened if there is none.

**And one kind of row it no longer holds.** A one-off aimed at a single place is a BACKLOG row —
*Recurrence decides the list* below — so what this sheet keeps of it is a read-only line in the
`On a clock` directory (`clockDirectory.tsx`, cut by `clockCuts.ts`). The spent-sweep foot stays for
the one-off that has no single backlog to be in; the timed items get a foot of their own, one button
per repo, because the count is the filter and a backlog is scoped to one repo.

### A count on a control is a filter

The schedules chip read **2 within the hour**, and tapping it opened all ten schedules.

The number was right, the list was right, and the screen was still useless: the reader had asked
"which two?" and got back ten cards timed `Do., 10. Sept., 21:52`, `Fr., 11. Sept., 00:02`, to do the
hour arithmetic by hand against a clock they cannot see. A count is a CLAIM about a set of rows, and
the only way anybody can check a claim is to see the rows. Opening the whole list hands the
arithmetic the chip had already done back to the person, in a worse notation.

So: **a tap on a number shows exactly the rows that number counted.** Three parts, and all three are
load-bearing.

- **One function owns the edge.** `horizonBucket(at, now)` is where `<= 1h` lives; `scheduleHorizon`
  counts by calling it and `ScheduleSheet` cuts by calling it. A second copy of the boundary is how
  "2 within the hour" opens a list of three, which is worse than not filtering at all — it makes the
  badge a liar rather than merely unhelpful. `horizonLead` says WHICH bucket the chip's leading
  number is counting, so the tap and the words cannot disagree either. `HORIZON_LABEL` is the one
  spelling of each bucket, used by the chip and by the filtered list's own bar.
- **A filtered list says so, with the way out.** `.filter-bar` — the same bar and the same *clear*
  button the launcher's status chips already had: what is being hidden, `n of N` counted against the
  unfiltered list, and a fingertip-sized clear. Without it a short list reads as a short LIST, and
  "my schedules are gone" is the only available reading. The sheet's head shows `2 of 10` for the
  same reason. The empty states stay keyed on the UNFILTERED count, so a filter that matches nothing
  says *nothing is in that window any more* in the bar rather than *Nothing is scheduled*, which
  would be a false claim about the other eight rows.
- **The filter is what the tap asked for, never a setting.** It is component state cleared when the
  overlay closes, so opening Schedules any other way lands on the whole list. A cut made by a tap
  days ago, remembered and shown nowhere, is the `sendMode` mistake in a different sheet.

The set is bucketed against one `Date.now()` per render and deliberately NOT re-cut on a clock tick:
this sheet has no timer, and a row silently leaving a list somebody is reading is worse than a row a
minute stale — the bar says what the filter is and clearing it is one tap.

Generalise it: this is the rule for every count this app paints on a control. The launcher's status
and starred chips were already the shape; `Gallery`'s filters are; the schedules chip was the one
that counted a set and then refused to show it.

#### And two that WERE filters and did not look like one

Reported with two circled screenshots: the `waiting` pill on a session row, and the `31` on the
usmc header. *"Make these clickable / act as filter."* One of them already was.

`statusTags(s, true)` had made the row's status pill a filter for its whole life, and `.tag-filter`
carried exactly one mark saying so: `cursor: pointer` — which **means nothing on a phone**, where
there is no cursor and no hover, and whose companion `title` this app already has a standing rule
about being invisible on touch. So a control that worked was indistinguishable from the plain pill
the search sheet renders from the same `statusPill` parts. Every chip that cuts the list now carries
a **dotted underline**, which is the vocabulary `.star-pending` already uses for "this is
interactive, in a row with no height to spare" — and which is removed once the chip is `.on`, since
the filled background says it then and an underline under that reads as a defect.

The `31` was the real gap: the one count in that header that was NOT a control, sitting among five
that are (waiting, working, idle, at the limit, exited), saying how many rows there are with no way
to get to them. Its cut is the repo itself, so it focuses — the route that already exists, already
has a way out in the topbar, and already unwinds on Android Back. Tapping it again clears.

#### Two more that were counting and not showing

The launcher's **waiting** chip (the hourglass, `queuedByRepo`) said `15` for a repo and opened
Activity on `all` — two hundred rows, the fifteen nowhere named. It is now a list of Activity ROW
KEYS rather than a number: the chip prints `keys.length` and the tap passes those same keys as the
sheet's `focus`, which already knew how to say *showing the 15 waiting in usmc* and carry the way
out. `intentRowKey` was extracted next to `queueRowKey` so the caller cannot spell a key the
selector spells differently. It also stops counting rows FILED on this phone (`activityFiled`): a
dismissal is the local half of the word `Intent.dismissedAt` uses, and a badge that counts what you
have already dealt with can never reach zero.

The **backlog** was the other one, and it had no counts at all. Fifty-two items in one repo, each
row three words of status and a forty-character truncation of its own text, and no way to ask "what
failed" or "what has been sitting here a week". `backlogFilter.ts` is the pure half:

- `ageBucket` owns the edges, and the age chips NEST (`withinAge`) — an item from ten minutes ago is
  in *past hour* and in *past 24h*, because four disjoint bins is not how anybody thinks about "how
  old is this". `older` is the one bin that is exclusive.
- `backlogCounts` cross-counts: with *past 24h* on, the status chips count only what is in that
  window, and with *failed* on, the age chips count only failures. A chip counting the unfiltered
  list while the tap cuts the filtered one is the same lie in a subtler place.
- The row shows the item's OWN TEXT, clamped to three lines, never `label` — `add()` fills `label`
  with `text.slice(0, 40)`, so the list was rendering every instruction cut off mid-clause.
  `realLabel` is what tells a typed label from that truncation.
- Drag-to-reorder is blocked while filtered, for the reason it was already blocked while searching:
  `onReorder` sends the whole top-to-bottom order, and an order computed from a subset renumbers the
  repo's list against rows that are not on screen.

`useNow.ts` came out of `ActivitySheet` in the same change: a rendered age with no timer is frozen
at whatever the last arriving frame made it, and "added 4m ago" that is really forty minutes is how
a stuck item reads as a running one.

#### What the backlog sheet lost when every item got its own conversation

Two whole apparatuses, and both were duplicates rather than losses.

**The add form** — its own `PromptComposer`, a repo select, a target-session select, a dictate
button (which came back, in the one place it cannot be deleted again — see *Dictation lives with the
one prompt surface*) and three attach buttons — was a FIFTH prompt-writing surface, asking a different subset of
the four questions and answering the rest by existing. The header has **`send…`** instead, which
opens the one send sheet seeded to this repo with WHEN already on *when it's free*: the same post,
with every answer reachable and the durable queue underneath it unchanged, so adding while the
socket is down still works and still applies exactly once. The backlog's own image/file/reference
trio went with it (a file reaches an item through the send sheet's annotator and picker now), and
the search box stopped doubling as the draft — typing something to add it used to empty the list of
everything that did not match it.

A draft is the last copy, so deleting the surface that held one is the same delete as writing over
it. `waterplane.backlogDraft` is therefore **rescued and SAID**: whatever that field was holding is shown
at the top of the sheet once, offered as a send in one tap, and thrown away only on a deliberate
second tap (`ConfirmButton`, never `window.confirm`).

**The staged action queue** — `queue` / `queue mode`, the `⊕ fire / check / validate / continue`
buttons, and a runner that polled the session list for idleness — predates the intent store, which
serializes per repo **on the host**. It was a second scheduler watching the first one through a
keyhole, and it only ran while this tab was awake.

Three gates went with the world they described, and each one's capability survives:

- **`canFire`.** Firing used to need somebody to have opened the repo's shared conversation first,
  so an item with no session in its repo got a dimmed *fire* whose `title` — invisible on a phone —
  said *"open a session for this item first"*. Firing OPENS a session now. The only thing that can
  stop it is the link, which says so.
- **The *No session open for this repo* hint.** Not true any more.
- **The `waiting[id]` tap-through.** It opened "this repo's backlog session"; there is none. It is
  kept only where there is an action behind it, and **the gate is whether the target session is
  ALIVE, not what the sentence says**. It was a regex over the words — `/opened by hand|that
  session/` — and the sentence a row aimed at a CLOSED session wears is *"that session is gone — aim
  it at another session…"*, so every such row drew its own obituary as an underlined button whose
  handler looked the dead id up in the session list, found nothing, and did nothing at all: the one
  answer this app refuses, produced by the gate written to prevent it. Liveness first, the regex
  only as a secondary filter over the sentences that actually name a session a tap can reach.
  `noSlot` / `serial` / `hostBusy` are waits with nothing to press, which is exactly when a button
  that changes nothing is worse than none.

The group heads say where work will RUN rather than naming a session nobody could see: **`Each in a
new session`** for the default group, **`In <session title>`** for each live session's own queue,
and **`Aimed at a session that closed`** for the rows that will run nowhere at all. That third
group exists because those rows used to fall through to the first one, under a heading promising
something the host has never done: `sessionBlocker` holds a `{kind:"session"}` row on `sessionGone`
for as long as the row exists, nothing re-aims it but the usage-limit resurrection, and a hand
`fire` resolves the same dead id — yet the chip said *"it runs in a new one instead"* and the row
fed the default group's `▶ next`. The chip now reads **`target closed — held`**, the group carries
one sentence saying what ends the wait (edit it, take the aim off, or remove it), and it is excluded
from `nextFireIds`.

The row's own wait verb is **`when <session> is free`** (`waits for <session>` once it is on), with
the composer's `Hourglass`. It was `queue here`, which needed a three-sentence paragraph under the
repo bar to explain it — and which was a fourth name for one decision: the composer's `When free`,
the next-prompt strip's `make it wait` and the queue row's hourglass are the same post, the same
holder and the same wait. One name, said on the button, which also names the session; the paragraph
went with the jargon it was explaining, and `open a session here` went with it — a control whose one
stated purpose was "somewhere to queue items into by hand", i.e. giving another control a target.
What stays is the reason the verb is MISSING (the session you came from is in another repo, or is no
longer running), one line each, and nothing at all when the sheet was opened from a repo menu and
there was never a session in the picture.

Two more things say themselves rather than being inferred: **`auto off` carries a sentence** —
every *when it's free* post in the app is an `auto` row now, so that one-word chip pauses every
deferred send on the desktop and not just "the backlog" — and the check/validate verdicts wear
`lucide-react` icons (`CHECK_ICON`, exported beside `CHECK_LABEL` so `ActivitySheet` cannot draw one
screen's icon with another screen's words). Their labels used to carry `✓ ~ ? ✗ ⚠ ⏳` glued to the
front; two of those are emoji, which Android renders as full-colour pictures a third larger than the
line they sit on. `auto (10s idle)` lost its number — the idle threshold named the gate it USED to be, waiting
for a shared session to go quiet, and the ladder decides now. A row gained two readings that are
facts about cost: `N turns` (a COUNT; the chain itself stays on the host, un-clipped, because
shipping it would put a whole prompt into every list every phone renders) and `continued` (it
reopens the repo's last conversation rather than starting clean).

#### The smart pick, on the phone — removed 2026-10-16

A per-repo smart-pick tick, its last-look strip, `merged from N` chip/filter and `undo`/`put them
back` (`backlog.unmerge`) lived here; all are gone (reason in
[host.md](host.md#smart-pick--removed-2026-10-16)). What stayed from that work: `hiddenByArchive`
(archived hides a row *unless it is `running`*, one predicate for the sheet's base, the repo counts
and the composer's badge), and the mark below.

- **`placed by you`** on a hand-ordered row. Two things stamp `handOrdered` — a drag, and an
  assessment ranking approved at apply time — so the chip says the thing that is true of both, a
  position a PERSON decided. Nothing re-sorts rows automatically any more; the mark still says whose
  order it is.


### Automatic sessions stay open unless asked (`autoSessions.ts`)

A session a fired backlog or scheduled item opens (`backlog · <repo> · <label>`) no longer closes
itself by default — the person chose a global OFF (*close automatic sessions when done*, Settings →
Sessions, the synced `waterplane.backlog.closeWhenDone`) plus a per-item override. Nothing closes itself:
with the switch off and every slot taken, the next item WAITS and says so.

- **Three-way, absent = inherit.** `BacklogItem.closeWhenDone` absent follows the global, `false` is
  a real "keep this one open". The open backlog row draws the effective sentence first
  (`closeEffectWords`, naming whose answer it is) and three chips: *as set globally (currently: keep
  open)* · *keep open* · *close when done*. The inherit chip SAYS what inheriting means today, so a
  row that merely inherits never reads as an answer that would flip silently with the global.
  `backlog.update` carries `null` to clear (never `false`), on any state — a running item's session
  is exactly the one a person may decide to keep. Only rows that open their own session (no
  `targetSessionId`) are asked; a closed row wears a chip only for its OWN answer.
- **The Send sheet asks the same, only where the desktop opens the session** — a repo target whose
  WHEN is not `now` (a `now` is a session the person opened). Default inherit sends nothing; the
  value rides `backlog.add`, the schedule action, the `after` chain's draft, and the re-decide patch
  (absolute, so both seeders carry the row's answer in rather than clearing it).
- **A row held on a slot offers room, never takes it.** `slotHeld` needs both halves: the host's
  `autoSlots` full AND the row's own wait sentence naming a slot. *close one to make room — N open*
  opens exactly N rows — `autoSlotSessions`, the host snapshot intersected with the LIVE session list
  (a session closed since the snapshot is never offered) — each with its age, whether it closes
  itself, and a close on `nav.closeSession`: the ordinary close (closecheck first when running, a
  confirm only when something would be lost), a person's tap, never a new path.

### Recurrence decides the list: a one-off with a clock is a backlog row

> "there are items in the scheduler that were skipped … Also in the repo's
> backlog these items don't show up so I feel we still have a mismatch: scheduled tasks and backlogs
> are very related!"

That is the THIRD time this seam was raised. The pass before this one answered it with a JOIN — a
link in both directions, described below under *what the join got right* — and the answer came back
that it is still two things. Take that seriously: **a link was not enough.**

**What the complaint actually is.** Not "I cannot find the item from the other sheet". It is that the
SAME piece of waiting work had two homes with two verb sets, and the one with the clock had FEWER
verbs: no drag, no merge, no *re-fire* on a failed one, and no presence at all in the
list a repo's grooming pass is fed from. Measured on this desktop when it was written: **nine live
`at` rows, every one a one-off, zero recurring — seven of them `failed`**, in no backlog, and
invisible to the backlog features, which only read backlog rows. Their Schedules sheet was, in
practice, a second backlog with clocks on it.

**The rule.** `isTimedWorkRow` (`shared/intent.ts`): an `at` trigger whose rule does not recur, a
prompt payload, aimed at ONE place (`repo` or `session`), not a fan-out child. Such a row is a
BACKLOG row and not a schedule row. It is `after`'s own argument one trigger over — the comment above
`isBacklogRow` already said a chained item belongs here because *"there is no recurrence, no clock to
arm, nothing for the schedule sheet to pause"*, and a one-off has exactly one of those, spent by its
one run. Two exclusions, both deliberate: a rule that RECURS is a standing thing whatever it is aimed
at, and a one-off SWEEP (`repos`) has no single backlog to live in, so it stays a card until it is
spent. **Derived, never stored** — an edit that flips *once* ↔ *every week* moves the row between the
two lists on the next read, with nothing to migrate.

**The cost, paid rather than dodged.** This user has zero recurring rules, so "Schedules lists
standing rules" **empties their card list**. The alternatives were worse. *One row, two views* keeps
the exact shape that produced the complaint — the reader is still holding one row in two lists and
asking which one a backlog feature is looking at, and "which is canonical" is a question nobody should
have to ask about their own prompt. *Schedules as a filter over the backlog* throws away the one
thing the Backlog sheet deliberately refuses to be (an all-repos list — `Backlog.tsx` says why) and
the one thing a recurring rule IS (a clock over every repo, with arm / pause / skip verbs no work
item has). So the row lives where its verbs live.

**What the sheet says instead.** `clockDirectory.tsx` + `clockCuts.ts`: **`On a clock · N`**, one
line per timed item — repo, its own words, `describeRule`'s rule, the armed instant, one state word —
grouped by repo, soonest first, and **exactly one affordance: open it where it lives.** A line
whose row is `blocked` for anything but `notYet` also draws the host's `blockDetail` under it,
verbatim — *waiting* alone hid twelve rows a weekly budget was holding, while the backlog row already
wore the sentence; one wording, never a second, and TEXT, never a `title`. `ScheduleSheet`'s card does
the same off its own intent (`ScheduleEntry` carries no block reason). That is why
it is its own module rather than a section of `ScheduleSheet.tsx`: "a line has no verbs" is a rule
worth keeping in a file that has no verbs to offer, and a line that grew one would be the second home
this whole change exists to remove. With no cards and any clocks at all the directory IS the body,
under *Nothing repeats — there is no standing rule on this desktop. N one-offs wait on a clock in
their repos' backlogs, where every verb they have lives.* With neither, the old `Empty` still stands.
A queued `schedule.save` of a one-off is a directory line too, marked by its `SyncChip`, and it stops
being one the moment the host lists the intent — otherwise the row a phone just wrote sits in the
cards until the link returns and then jumps lists.

**Every count is one CALL, not one function used three times.** This was written as "every count
stays one function" and it was not true of the code: there were three hand-rolled readings of *this
row is a standing clock* — the chip's `scheduleHorizon` call, the sentence in that chip's own title,
and the sheet's list. Measured on this desktop, over one set of rows, they said **13 · 8 · 2**. The
chip contradicted the title written on it, and *11 not armed* named eleven rows the tap could not
reach, which is *a count on a control is a filter* broken by eleven.

Two independent causes stacked, which is what three copies of an edge produce — not one bug but as
many as there are copies. The chip's call passed `{nextAt, rule}` and no `lastOccurrence`, and
`isSpentOnce`'s `window`/`oneShot` branch is *only* `lastOccurrence != null`, so five rows that had
run could never read as spent. And neither chip reading dropped rows that had already SETTLED, so six
`done`/`failed` one-offs were "standing" as well — a state with no way out, reported as something to
fix.

So: one predicate (`isStandingClock` in `clockCuts.ts` — has a clock, not set aside, not settled, not
spent read WITH `lastOccurrence`), one pool, and `clockCuts()` returns the cards, the lines, the
pending saves, the horizon and the two kind counts from that single pass. The launcher chip makes the
same call over the same two lists as the sheet it opens, and `horizon.total` IS `standingTotal` —
bucketed over exactly the pool rather than re-cut, so it is an identity rather than two numbers that
have to keep agreeing. `horizonBucket` is still the only place the hour/day/week edges live, so *2
within the hour* opens exactly those two whichever kind they turn out to be. `clockCuts.test.mjs`
asserts the identity itself, so a fourth reading added beside it fails rather than drifting.

The repo header's waiting count stops skipping every `at` row and skips only `isScheduleRow`, because
a timed item IS that repo's waiting work. A timed item is therefore counted in two places on one
screen, and that is not one list counted twice: one is *what this repo is waiting on*, the other
*what fires on a clock, host-wide*, and each tap opens exactly what it counted.

**The row, in the backlog.** Two chips — the clock (`clockWords`: the rule's own words plus *next in
2h*, or *waiting for a usage reading* for a window rule with nothing armed, and only while it is
queued) and `holds until the desktop is free` — and two verbs beyond the ones it already had:

- **`when`** opens the Send sheet seeded from the row. A clock is a whole `ScheduleRule` and this app
  has one surface that composes one; an inline field here would be the fifth spelling of a decision
  three passes have spent collapsing into one.

  **And every arm of that sheet honours the row it was opened on, or refuses in words.** For a while
  exactly one did: `at`, where `schedule.save` upserts on `seed.scheduleId`. Pick *now* or *when it's
  free* or *after another…* on a queued timed row and `dispatchIntent` posted a NEW row — fresh
  ackId, `backlog.add` — while the timed one stayed armed, so the words ran twice: once in turn, once
  at their instant. On a failed row the same taps left the gravestone beside a duplicate. `whenRoute`
  (pure, `sendIntent.ts`, pinned) is the one decision behind every arm now: **upsert** for a clock,
  **patch** for every other WHEN on a live row — `intent.update` carrying the new trigger, the exact
  contract *drop the clock* already uses, and carrying the words and the target too, because a patch
  that moved only the trigger would leave the row saying the old thing at the new moment — **post**
  where there is nothing to re-decide (no row, or a `done`/`canceled` one, which can never run again
  and so cannot be doubled), and **refuse** for the three a patch cannot express: a `starting` or
  `running` row (the host refuses the edit, and a post would type the same words beside the ones
  going in), a re-aim at several repos, and a build. The refusals reach the BUTTON through
  `sendBlocker`, before the tap — the check inside `dispatchIntent` is a second line for the case
  where the list moved under the sheet. The receipt names the row's continuity (*re-timed — the same
  row…*), because "queued" is word-for-word what a second copy would have said.

  `seedFromIntent` carries the WHOLE chain now — it read
  `steps[0]`, survivable while only a schedule reached it and not now that a backlog row's *when*
  comes through the same door.
- **`drop the clock`** takes the instant off and leaves the words: `intent.update` with a `trigger`
  of `idle`, a plain `liveSend` like every other backlog mutation. This is the verb the whole change
  is for. A one-off cannot be re-armed, so a missed one is stuck saying it missed something for ever,
  and `re-fire` beside it runs it THIS SECOND in a session of its own (`runNow` skips the ladder)
  rather than putting it back in the queue. The row's two titles are
  two different offers and never one sentence (`dropClockTitle`), and the receipt is about the CLOCK
  and never a state — the host kicks synchronously, so the row may be `blocked` behind the ladder or
  already firing by the time the toast is read. **`holdForHost` survives it**, because *wait until the
  desktop is free* is something a person asked for about these words, not a property of the instant.
  On the `failed` cut the filter bar grows **`drop the clocks on these N`** (`ConfirmButton`, never
  `window.confirm`): N is the timed rows in the cut on screen and the tap acts on exactly those, with
  `dropClocksNote` saying how many of the shown rows were left alone — and *every one of the N rows
  here carries a clock* when there is no rest, because a clause about an empty remainder sends a
  reader looking for rows that are not there.

  **One tap, one receipt.** The bulk button called the per-row handler once per id, and each of those
  is a `liveSend` with its own toast: seven identical sentences on screen and seven rows in the toast
  log for one decision, with the only number that matters — how many rows it touched — in none of
  them. The wire is unchanged (`intent.update` is per id; there is no batch frame), so what is
  batched is the SENTENCE: `liveSendAll` sends N frames and says `dropClocksToast(n)` once.

  **And the two load-bearing sentences are TEXT now.** *The hold survives a dropped clock* and *auto
  takes it from there* lived in `title` attributes — and **a title is invisible on
  a phone**, which is the only device this app is used from; that is the rule `Unavailable.tsx`
  exists to enforce, brushed here by the two sentences a person most needs before tapping. The hold
  chip carries `· survives a dropped clock` as visible text on exactly the rows where the verb is
  offered (`holdChipWords`), the row draws `dropClockNote` under its chips, and the bulk note says
  both. `dropClockNote` is ONE string used as the note and as the button's `title`, so there is no
  second copy of the claim to drift.

- **`run it again`** is `drop the clock`'s sibling, for the row that is stuck for the other reason.
  A backlog has two kinds of dead row and only one of them has a clock to drop: a row that simply
  FAILED is terminal — the ladder never looks at it again, `auto` skips it. The only verbs this sheet had for one were `re-fire`
  (which starts an agent THIS SECOND, past every rung) and the archive. Measured on this desktop: **0
  queued against 19 failed**, so the list the repo's agent is fed from was empty while nineteen live
  pieces of work sat one state away from it — and an assessment's *still wanted* verdict, applied,
  did nothing at all.

  The message is `intent.requeue` (see [host](host.md) and the wire types in `packages/shared`): the words, the place
  and the failure all kept, the row back where the ladder can see it. **It is the one backlog
  mutation that goes through the DURABLE queue.** Every other one is a `liveSend` because a decision
  replayed an hour late is a decision about a situation that has moved on; this one is not, because
  the HOST refuses anything that is not currently `failed`. A frame that lands an hour after the tap
  either finds the row exactly as it was left or is refused outright — that refusal is the mechanism,
  not a courtesy, and it is what lets the button be drawn with the tunnel down instead of greyed out
  with its reason in a `title` nobody on a phone can read. `App`'s handler is therefore
  `queueOp` with an `intent:<id>` lane (`intent.run`'s rule: one piece of work must not sit behind an
  unrelated sweep), never `liveSend`.

  **The tap names the failure it SAW** (`intent.requeue`'s `failedAt`). "The row is still `failed`"
  is NOT what makes a late delivery safe, and believing it was is the hole this closes: `failed` is a
  STATE, not an event. A row can fail (F1), be revived on the desktop by the assessment or by
  Activity's *run it now* while this phone is offline, run, and fail DIFFERENTLY (F2) — and a
  state-only guard then accepts an hour-old frame and runs work nobody decided on, over a failure
  nobody read. So both taps carry the row's own `finishedAt` (`Intent.settledAt` as this sheet drew
  it, handed over BY the sheet rather than looked up again at send time, which would simply agree
  with whatever the row has since become) and the host refuses a mismatch. **That refusal is said**:
  `op.ack`'s `ok:false` branch toasts the host's own sentence for this op alone, because unlike every
  other durable op its tap is on a row that does not change — the refusal used to land as an outbox
  row in Activity and nothing else, and silence after *run it again* reads as yes.

  **Two verbs, two promises, side by side.** `run it again` puts the row in the QUEUE and `re-fire`,
  right beside it, starts an agent now. Nineteen `re-fire` taps are nineteen agents in one worktree;
  nineteen of these are nineteen rows the queue runs one at a time. That difference is the whole
  reason there are two buttons, and it is the last clause of `runAgainRowNote(it)` — ONE string
  drawn as TEXT under the row's chips AND used as the button's `title` (`dropClockNote`'s rule, for
  its reason), saying where the row goes, WHERE it runs when it gets there, that the failure it had
  stays on the row, and what the button next to it does instead.

  **That "where" is read off the ROW, and it was the one clause here that was simply false.** It was
  a flat *it runs again in a new session of its own*, on every failed row — including the ones in the
  sheet's *In &lt;session&gt;* group, which run in THAT conversation and nowhere else. The sentence
  now branches on `targetSessionId`, the same field `groupKeyOf` reads for the group heads, so the
  phone's promise and the sheet's own grouping cannot disagree. Deliberately NOT `fresh`: that field
  is optional and absent on every row written before it, where absent means the retired
  shared-session reading — a fact about an old row, never a control.

  **And a row aimed at a session that has CLOSED gets no verb at all.** Nothing re-aims such a row
  (`sessionBlocker` holds it on `sessionGone` for as long as it exists, and a hand `fire` resolves
  the same dead id), so a re-queue would turn a stopped row into one that waits for ever — which
  looks like progress. The verb is not drawn and `runAgainClosedNote()` says why, as TEXT, naming the
  two edits that end the state; **never a dimmed button** (`Unavailable.tsx`), and *re-fire* is
  deliberately not offered as the way out. The host is growing a pre-flight refusal for the same
  case: that is the backstop for a frame already in flight, this is the phone not offering it.

  **One eligibility edge, one copy.** `runAgainState(it, liveSessionIds)` answers `offered` /
  `held-closed` / `none`, `runAgainEligible` is the predicate over it, `runAgainIds` is the cut built
  from that predicate, and `Backlog.tsx` asks the same function about one row — it used to restate
  `failed && !at && !archived` beside a comment claiming it was "not a second copy", which is how the
  bar could say 19 over a list where 20 rows wore the verb. The two verbs partition the `failed`
  list and never overlap: **no clock** (a clocked row's verb is *drop the clock* — a different
  sentence about a different reason) and **not archived** (a row somebody set aside stays set aside;
  its own unarchive is the tap that brings it back).

  On the `failed` cut the bar grows **`run these N again`** (`ConfirmButton`) beside `drop the clocks
  on these N` — **the count is the cut on screen**, `runAgainNote(n, shown, aimed)` says what it
  leaves alone (a dead target is now a third reason beside the clock and the archive) and says
  nothing about a rest when there is none, and **one tap is ONE receipt**: the wire has no batch
  `intent.requeue` either, so the app sends N frames and `runAgainToast(n)` is said once. `aimed` is
  `runAgainAimedCount` over the same cut, because *each in a session of its own* is true of a fresh
  row and false of an aimed one and a mixed cut is two clauses, not one — and only the all-fresh
  branch may say *one at a time in this repo*, since rows aimed at different sessions run in
  parallel. The same reason *one at a time* left `runAgainToast`'s plural. Alone among the bulk bars
  here it is NOT gated on the link, for the durability reason above.

  **A row that has been put back says so** (`requeuedWords`, off `BacklogItem.requeued`). Revived, it
  is otherwise indistinguishable from a row that was never in trouble — and `BacklogItem.error` is
  cleared the moment it runs again, so without this the reason somebody had to think twice disappears
  exactly when they are deciding whether to think twice again. Four wordings, because the fact means
  something different in each state: queued/running is the plain statement (*put back in the queue by
  the assessment · 4m ago*), `failed` leads with the judgement about the WORK (*failed again — it was
  put back…*) rather than burying it, `done` is the case for the verb existing and says so (*ran
  after being put back…*). **`by: "run"` is a fourth sentence, not a third spelling of one**: that
  entry is the first half of *run it now* (the backlog's `re-fire`, Activity's *run it now*), which
  revives and fires in the same breath — so the row it is drawn on is starting or already running,
  and *put back in the queue from the phone 3s ago* was a claim about where somebody's work was
  sitting made about the one case where it is not sitting anywhere. It reads **started again**;
  `assess` and `hand` keep their own wording. `(2nd time)` past one and **only when the host sent a
  count** — `requeued.n` is optional, absent means it cannot say, and the sentence is then drawn with
  NO ordinal (never `requeues.length`, capped at `REQUEUE_KEEP`, which freezes at five and then says
  *(5th time)* on the ninth: a reading degrades to absent, never to a wrong number). `· failed
  before: “…”` only where that entry recorded a failure — never an empty quote standing in for one
  nobody recorded.

`▶ next` skips a row whose instant is still ahead: it is not next, its clock is, and marking it would
promise a start at the top of the list that the host will not make until Saturday.

**Activity.** `intentKind` says `work`, so the row wears work verbs — *run it now* on a failed one,
`check` as its primary, *rewrite it* — and its `where` gains the rule as a fragment, in the same slot
`resume` puts its, because it is a fact about where the words are
going. The bucket is unchanged: it has always keyed on the REASON (`notYet` ⇒ *scheduled*, sorted by
`dueAt`), not on the kind. The `edit` arm sends a timed row to the Send sheet for the same reason the
row's *when* button does.

#### What the join got right, and why it was not enough

The previous pass's link survives wholesale for the rows it is still about — a RULE and the rows it
writes. A card's **`backlog · 1 item`** is a count and therefore a filter; a row a rule wrote wears
**`from the schedule “x”`**, one tap to Schedules cut to that rule, and that cut is over every row
the sheet holds rather than the standing ones, because somebody who tapped a rule by name must not be
handed an empty list. The link is narrow and exact: the only parentage on the wire is
`ScheduleEntry.lastResult.childId`, the LAST item each rule produced, so `scheduleMaps`'s `byChild` knows that
one and nothing older, and an older row says nothing rather than guessing. Matching on the LABEL
would "work" — a scheduled child inherits its rule's name — and would name the wrong rule the first
time somebody typed that label themselves.

**The third parent, which the seam above cannot name.** Eight rows on this desktop had already fired
and written a child while a one-off still WAS a `ScheduleEntry`. Their children carry
`origin: schedule:<parentId>`, and both maps that resolve it are built from `schedules` — where the
parent is not listed any more — so every one of those *from the schedule “x”* chips went blank on the
day the build shipped: the work lost the only sentence saying where it came from. So the lookup falls
back to the same join over `intents` (`clockParents`, read AFTER the entry maps — a live rule is the
better answer wherever there is one), and the chip's tap has TWO destinations, because the parent is
one of two things: a rule is a card in Schedules, a timed one-off is a backlog row of its own, so the
door is its repo's backlog cut to that one id. That cut takes the UNHIDDEN base, archived included,
which is exactly why that rule exists — the host sets such a parent aside on first boot under this
build, because the child is the account of the work. `scheduleParentLabel` says so rather than
letting an archived row read as something thrown away, and absent still beats guessed: a parent
compacted out of the store answers nothing and no chip is drawn.

The three sentences of the seam are `backlogFilter.ts`'s (`fromScheduleWords`, `scheduleRuleLabel`,
`scheduleItemsLabel`), the fourth is `scheduleParentLabel`, and the clock's are beside them
(`clockWords`, `dropClockNote`, `dropClocksLabel`, `dropClocksToast`, `holdChipWords`,
`onClockLabel`, `goneOnClockLabel`) for `ageBucket`'s reason: the label on a chip and the label in
the filter bar that chip OPENS are one claim, and a second copy of either is how a tap starts
describing something else. All of them are pinned — in this repo the strings are the deliverable.

What the join could not fix is that it was a link between two homes. It told you where the other copy
was; it did not give the row its verbs. The rows move now, and the link stays for the thing that
genuinely has two ends.

### A title a machine wrote, on words a person wrote

Fifty-two rows of first-lines-of-prose is the list this sheet's whole filter apparatus was built
against, and after age and status there was a third question a reader still could not answer by
looking: **what KIND of thing is each of these.** Nothing derived one, because nothing in this app
applies itself, so the answer was always "nobody has said" and there was no way to say it.

The vocabulary and the rules are `shared/naming.ts`'s, and **the module's own why lives with every
other shared module's, in [host.md](host.md#packagesshared)** — what a `headline` is, why it carries
a `NameAuthor`, and why `hand` can never be written over. What follows is only the phone's half: how
this app APPLIES those rules on a screen.

- **`label` is the person's field and `headline` is the machine's**, never one field. `itemHeadline`
  is the ONE display rule for a `BacklogItem` — a name somebody typed wins, always, and a derived
  title stands only where they put nothing — so `Backlog.tsx` and `AssessSheet.tsx` head the same
  piece of work the same way. `realLabel` is the typed half of exactly that rule, which is why the
  backlog row calls `itemHeadline` now: on the old call a row a pass had titled showed nothing at
  all.
- **`activityRows.ts` is the deliberate EXCEPTION, and it is not `itemHeadline`.** `intentTitle` is
  `i.headline || prose || i.label || i.title || i.id`: the headline displaces the PROSE, and the
  prose still beats `label`. The reason is that `Intent.label` is not the person's field the way
  `BacklogItem.label` is — on an `Intent` it still has three MACHINE writers (`add()`'s
  `text.slice(0, 40)`, `App.tsx`'s `file · <name>` for a queued upload, and assess's *from an
  assessment*), so a label-first order titled rows with filenames nobody typed. The resolution is
  right as far as it goes — a machine's title never displaces a typed one, because the only way
  `label` loses here is to prose the same person wrote — but it is a different order, and the two
  screens therefore disagree: **a label typed in the Backlog form names the row on the Backlog,
  while Activity, the chain picker (`SendSheet.tsx`) and the clock directory (`clockDirectory.tsx`)
  show the machine's headline instead.** The chain picker is the expensive end of that: the name it
  shows is SNAPSHOTTED onto the trigger (`IntentTrigger.after.title`) and is what the waiting row
  says about itself for the rest of its life, so a headline chosen there is kept for ever.
  **The real fix is to stop minting `file · …` and *from an assessment* into `label` at all** —
  both are titles and belong in `Intent.title` — after which `intentTitle` can put `label` first and
  the two orders become one. Not done in this pass; `activityRows.test.mjs` pins the current order
  by name so the exception cannot be lost by accident.
- **Every name carries an AUTHOR** (`headlineBy` / `categoryBy`), and the pair travels together or
  not at all. `hand` is the value that makes a title un-overwritable, so the edit form's hint says
  the one consequence of saving that no later pass can undo — *saving makes it yours* — and clearing
  the field clears the author with it, which is "nobody has said" rather than "a person said
  nothing". Both sentences are `headlineEditHint`'s, in `backlogFilter.ts` with every other sentence
  on this sheet and pinned: a promise about the host's `hand` stamp written as an inline literal is
  a promise nothing notices going stale. `HEADLINE_BY_WORDS` is whose title it is, drawn as TEXT on
  the expanded row and never as a `title` (`Unavailable.tsx`'s rule: on a phone that is not said at
  all).
- **A kind is never guessed.** Absent means NOBODY SAID, so an un-categorised row draws NO chip —
  a default bucket would file work under a heading its author never chose. `categoryBucket` is the
  `ageBucket` of this axis: one function feeding the chip's count and the cut, spelling absence
  `none`, and `backlogCounts` cross-counts all three axes so `bug 2` under `failed` means two failed
  bugs and opens exactly those. **The chips are a FILTER, like every count on a control here** — a
  tap on `bug 2` opens exactly those two rows, and the filter bar then says `n of N` with a clear
  button.

**No colour per kind, deliberately.** A red `bug` chip sits one chip away from a red `failed` tag,
and a column of them reads as a column of failures — so colour in this sheet stays with what
HAPPENED to a row and the kinds differ by word and by `lucide` glyph (`CATEGORY_ICON`: `Bug`,
`Lightbulb`, `TrendingUp`, `Wrench`).

**The verb that fills the axis is `name these N`** (`backlog.name`, durable through the outbox `op`
lane). A count on a control is a filter, so `nameableInCut` is the rows in the cut on screen that
are still missing a field a machine may write, `nameNote` says what is left alone and `NAME_COST_NOTE`
says what it spends — one short toolless call on the cheap model, reading the items' own words and
nothing else. It is the one bulk verb here that is NOT a `ConfirmButton`: naming destroys nothing,
never touches a `hand` field, and a wrong title costs one tap on the row. While the host reports
`naming: string[]` the button is ABSENT with `NAME_RUNNING_NOTE` and each row it names wears its own
`naming…` chip — never a dimmed button, and never a spinner over rows nobody is naming.

### Smart pick's two homes — removed 2026-10-16

The launcher `Sparkles` chip and the backlog sheet's *smart pick is on in N repos* count went with
the feature (see [host.md](host.md#smart-pick--removed-2026-10-16)). `Backlog.tsx`'s private `IMG_RE`
is still gone: the image/transport path regexes are `shared/itempaths.ts`'s (`imagePaths`,
`transportPaths`), both GLOBAL — use `String.match`, never `.test()`, which carries `lastIndex`
between calls.


### `ActivitySheet.tsx`

- `ActivitySheet.tsx` + `activityRows.ts` — **every posted piece of work, one row for its whole
  life.** Eight partial ledgers a piece of work migrated between (the queue sheet, the give-ups list
  buried in network diagnostics, the backlog, the schedule list, the fan-out runs, the build runs,
  the parked launches, the downloads) is why "did my prompt run?" had no single answer screen. A row
  never vanishes on a state change; it changes verdict. `activityRows.ts` is the pure selector over
  state App already holds (node-tested, `activityRows.test.mjs`); the sheet is the view; App
  contributes two handlers and **one new piece of state** — `queueBlocked`, the flusher's OWN verdict
  per ackId (`selectSendable().blocked`, recorded where the single recovery-bar sentence is woven
  from the same array), because re-deriving why an entry is waiting would put a second explanation
  next to the behaviour it explains. `disabledReason` rather than a boolean, so an action cannot be
  greyed out without saying why; the bucket is the row's LEFT EDGE, not its background; a `done` row
  is dimmed, never hidden. `queue` stays reachable while it proves out.

#### The five reconstructions, and why they were there

`activityRows.ts` used to carry seven builders. Five of them — `launchRow`, `backlogRow`,
`scheduleRow`, `fanoutRow`, `buildRow` — were not five jobs. They were five copies of one job, and
the reason is worth keeping because the shape recurs anywhere a store grows a compatibility layer.

`intents/` folded five host managers into ONE durable store, and every row in it carries the decided
answer: `state`, `blockReason`, and `blockDetail` — the finished sentence, written by the very
ladder that made the decision. The host also kept speaking the five OLD vocabularies on the wire so
nothing had to change at once (`adapters.ts`), and **every one of those DTOs drops all three
fields**. `LaunchIntent` has a `state` of its own with four members; `BacklogItem` has `status` with
four different ones; `ScheduleEntry` has `enabled` derived from `nextAt !== null`; `FanoutRun` and
`BuildRun` have `status` strings of their own again.

So the phone received five lossy shadows of a fact it could have had whole, and each builder *guessed
the lifecycle back*: `l.state === "waiting" ? "blocked"`, `waiting ? "blocked" : "queued"`,
`s.running ? "running"`. Five guesses, five vocabularies, five chances to disagree with the desktop
about what is actually happening. The file said so itself, in `backlogRow`:

> which of the ten block reasons it corresponds to is the host's to publish, and until it does,
> `null` is the honest answer rather than a guess this list would then sort on.

It publishes them. It always did — `intent.list` has been broadcast on every change since the store
landed, and `hello` has carried it since. **Nothing read it.** The `intent.*` half of the wire was
the unshipped half, and the arrow of the migration is inverted from how it looks: `adapters.ts` was
never a legacy shim waiting to be deleted, it was the only path the client used.

`intentRow` replaces all five. `state` is taken, `blockReason` is taken, `verdict` is `blockDetail`.
Nothing on this path infers a lifecycle, which is why one builder is shorter than any one of the
five and strictly more correct than all five together: a row can no longer say *waiting* while the
desktop believes it is running. What stays in the phone is the only part that was ever the phone's —
**what a person may do about the row, and whether the link is up to do it with**.

Three consequences worth stating, because each is a rule that moved rather than vanished:

- **`ActivitySource` is a LABEL now, not a routing key.** A launch and a work item are different
  words to a person and the identical `intent.cancel` on the wire. Routing is `subject.source`, which
  has three members (`queue`, `intent`, `pull`); grouping and icons use `row.source`, which still has
  the seven. They are deliberately not the same axis.
- **The check verdict stayed a sidecar** and moved to the SHEET's props rather than onto the row.
  `review.ts` keeps it out of the intent for the same reason — a check verdict is not lifecycle —
  and nothing on this screen decides anything from it. Its *"a check is already running"* refusal is
  gone from the phone entirely: `review.ts` returns early on the same id, so the phone was carrying a
  second copy of a guard the host enforces, and carrying it cost a `checkStatus` field on a DTO whose
  only reader was that one greyed-out button.
- **A fan-out is still ONE row with its targets inside it**, so `fanoutRuns` — the rebuild-from-rows
  aggregation — moved from `host/intents/adapters.ts` into `@waterplane/shared`. It did not become shared
  code by being duplicated; it moved, and the host imports it back. Rebuilt once per list rather than
  per row, since it walks every intent to group by `groupId`.

The wire changed with it, and this is the half that matters on a bad link: `onChange` used to
broadcast **the whole store** and then the changed row, on every transition, to every connected
phone. One row changed now sends one row. The full list is what `hello` is for — and what a bare
`onChange()` still means, since a row LEAVING the store is not expressible as an `intent.changed`.

`intent.retarget` gained a `cwd`. The re-aim it replaced (`backlog.update`) always carried
`repoDir` beside the session, because moving a work item to another repo and pointing it at a session
there is ONE decision; without it the phone would send two messages and the row would sit, briefly,
aimed at a session in a checkout it no longer belonged to.

#### First of the sheets: the fan-out runs are derived, not held

`FanoutSheet` was the cheapest of the four to cut over, because its state was the clearest instance
of the whole problem: **one aggregate, computed twice on one device, from two sources that could
disagree between frames.** A fan-out run has not been a record on the host since `intents/` landed —
it is N rows sharing a `groupId`, and `fanoutRuns()` rebuilds it from them. The phone held the
host's rebuild as `useState`, fed by `fanout.list` and `fanout.run` frames, while the Activity
selector rebuilt the same runs from the same intents a hundred lines away.

Now `const fanoutRuns = useMemo(() => fanoutRunsOf(intents), [intents])`. The state, both frame
handlers and the `FanoutRun` import are gone from `App.tsx`; the host still sends the frames for a
bundle pinned to an older build, and nothing reads them. (This memo has since moved wholesale into
`features/fanout/FanoutEntrySheet.tsx`, calling `@waterplane/shared`'s `fanoutRuns` directly — the
`fanoutRunsOf` alias was App.tsx's own and did not move with it.)

#### The usage figure: the phone stopped owning the desktop's clock

Two effects each re-decided "is the usage reading stale?" against **their own copy of the host's
eight-minute TTL**, one of them with a throttling `ref` on top — the phone's clock deciding when the
desktop should spend a PTY on a scrape, with the constant living in three places. `usage.refresh` is
TTL-respecting host-side now (`getFresh()` rather than `refresh()`), so asking is free and
idempotent and the client simply asks when a screen that shows the figure comes up. One effect, no
clock, no ref, and the rule lives where the scrape does.

**What this does not do, and should not be mistaken for:** `Backlog`, `ScheduleSheet`, `BuildSheet`
and `FanoutSheet` still read the five DTOs, so the projections and their nine App states are all
still there. What has changed is that they are no longer how the app knows what is going on. The
remaining deletion — five states, five message handlers, two bespoke offline snapshots in
`localState.ts`, and the `intentTo*` projections host-side — is one sheet at a time, and each is
mechanical once its sheet reads `Intent`.
- **Three ways a screen full of honest rows still read as a broken delete.** All three were one
  report — "clicking delete seems to do nothing" — and none of them was the delete.
  1. **A spent one-off said it was switched off.** `intentToSchedule` derives `enabled` from
     `nextAt !== null` (an intent has no second flag, deliberately), so a `once` whose instant has
     passed and a schedule somebody disarmed arrive identical. The row said *switched off — it will
     not fire until you turn it back on* and offered the switch; re-arming a past `once` computes
     `nextFireAt` → null again, so the tap changed nothing and reported success. `@waterplane/shared`'s
     `isSpentOnce` is now the one answer, asked by `scheduleRow` and by `ScheduleSheet`: the verdict
     becomes the host's own sentence, `runNow` and the toggle refuse WITH the reason, and *edit* and
     *delete* — the two that still mean something — stay live.
  2. **`op.ack ok:false` was recorded as `other`,** which renders as *nobody recorded whether it
     ran* — printed directly under the host's own explanation of why it did not. On the durable-op
     path every `ok:false` is returned before anything is spawned or typed, so it is a REFUSAL:
     `failState: "refused"`, a new member alongside `stale`.
  3. **The delete worked and its twin stayed.** A `schedule.run` queued by *run it now* carries the
     schedule's NAME and none of its words, so a failed one sat in Activity looking exactly like the
     schedule that had just been deleted, offering a *try again* the host can now only refuse.
     Deleting a schedule drops the queue rows that name it (`scheduleQueueRows` /
     `dropScheduleQueue`, counted in the toast, and only once the desktop has actually been told —
     a refused offline delete leaves the queue as it found it). Rows still `pending` are kept: their
     receipt has to land on something. This is not the "a failed row keeps the user's words for
     ever" rule being broken — an op row has no words of its own, and the ones in the schedule are
     archived host-side by `IntentManager.remove`.
  Plus one label: a hand-fired schedule shares the fan-out LANE (a sweep is a herd of claude
  processes either way) but is no longer LABELLED "Fan-out" — `laneLabel` reads `op.t` first.
- **A verb that cannot run is not a button** (`Unavailable.tsx`). The rule "a disabled action always
  carries a reason" was already here — and the reason was in a `title`, which on a phone nothing can
  show: no hover, no cursor. What was left was a control with the same border, icon, size and label
  as the live one beside it, separated by `opacity: .4`. Reported as *"Are these buttons clickable or
  not… it looks not clickable but I think I can."* So `ActionButton` has **no disabled branch at
  all**: `Row` splits the actions into pressable ones (buttons) and blocked ones (`Unavailable`,
  muted text, no border, no background, verbs sharing a reason collapsed onto one line — three greyed
  buttons on a launch that is no longer waiting were three copies of ONE fact about the row). With no
  pressable action the reasons show unasked, so the row never just stops after its verdict; with one,
  they sit under *more* like everything else. Same treatment for the per-repo terminal icon on a
  fan-out target and for `ScheduleSheet`'s four row verbs. **Do not restyle `.act-cant` back into
  something button-shaped, and do not add a `disabled` branch to these buttons**: pressable things
  look pressable, everything else is prose.

### `AssessSheet.tsx`

- `AssessSheet.tsx` + `assessRows.ts` — **the assessment, as a diff a person approves.** Applied on
  its own, a run's verdicts are a model deleting a person's words on its own recognisance; this is
  the second of the two things that contain it (the first is `shared/assess.ts`): **nothing applies
  itself** — the run produces a proposal, every retirement is a tap made with the words in front of
  you. So every row shows the item's own words IN FULL, never clipped: a triage list may clip (you
  are scanning for one thing you recognise), a diff may not, because the sentence being retired IS
  the decision and two lines and an ellipsis is how you approve what you did not read. A merge gets
  the whole card — proposed prompt beside all N originals, ids named, no collapsing — and is ONE
  decision about all N, so the tick lives on the card and each `merged` row refuses its own accept
  with a sentence saying where the decision is. Confirms are on the BULK buttons, which is where the
  danger is (`askConfirm`, never `window.confirm`). `assessRows.ts` is the pure selector,
  `activityRows.ts`'s split for its reason, and writes no sentence `@waterplane/shared` already writes —
  only the strip ORDER, which rows a bulk button covers, and the refusals for taps that do nothing.

  **A run that takes twenty minutes has to look like one.** The sheet said one sentence for the whole
  run — *the assessment is reading the repo* — which is what a run that died in its first second also
  says, and there is no terminal on a phone to check against. It now draws the host's
  `AssessProgress` (see host.md, *Watching one run happen*): a headline of the last thing it was seen
  doing, the elapsed time TICKING (`useNow` at 1 s, and only while a run is going — a settled sheet
  is a document), the step count against how much of it is on screen, the model, the run's own last
  words, and the tail of steps with an icon per SHAPE, so a tool this app has never heard of draws as
  a wrench and reads as itself. Two rules it obeys: a run nobody has heard from yet says *starting
  up* — an older host sends no progress and a run in its first seconds has done nothing, and neither
  is a failure — and a run that has gone quiet says HOW quiet (`ASSESS_QUIET_MS`), never that it is
  stuck, because a long `Bash` and a wedged run look identical from here and only one of them is
  worth telling somebody about. The same list is kept for a finished run, shut by default: it is
  evidence, not the decision, and *what did it actually look at* is the first question a surprising
  proposal raises. The wording is `assessRows.ts`'s (`assessWatch`, `assessStepVerb`,
  `assessElapsed`), pinned.

  **`accept` had to say what it does.** On a screen full of work items it reads as "accept this task"
  — go and build it — which is the one thing this screen never does; the question was asked in those
  words. `assessAcceptWords` is the answer, per verdict and per STORE: a retiring verdict's button
  says *retire it* and its title says the words are kept and nothing is implemented, a `wanted` row
  says *keep it* and that it takes a position rather than running, and each open strip carries the
  same sentence once above its rows — text, never a `title`, which is invisible on a phone
  (`Unavailable.tsx`'s rule). The pad note is its own sentence because it is the one accept that
  changes nothing at all: the host never edits the pad, so a note is *judged and LEFT on the pad*,
  and calling that "retired" would be a claim about a store this app does not touch.

  **…unless the run still WANTS it, and then it is OFFERED.** That rule left one hole: `still wanted`
  is the verdict meaning the words are worth doing, and on a note it was the only one with nowhere at
  all to go — read, judged, and left, in a pad that is explicitly *a thought written before you know
  which repo it is for*. `cleanAssessment` closes it STRUCTURALLY rather than by prompt: a `wanted`
  note is copied, verbatim, into `proposal.news` as an OFFER carrying the note's id in
  `AssessNew.fromNote`, so "it carries the note's own words" is a property of the code that built the
  row and not a thing the CLI was asked to do and complied with. Offers are APPENDED after every
  CLI-written item, so the indices `AssessChoices.news` names keep their meaning, and they tick
  through exactly the same `pickedNews` set — no control of its own, no second apply path.
  What is different is everything a person READS, because the one thing this screen must let you do
  is tell your own words from words the run invented: a `NotebookPen` head reading *from your pad*
  instead of a `Plus` and *a new item*, `NOTE_ITEM_WORDS` (*file it* / *will be filed*, the pad's own
  verb) instead of *post it*, `assessNoteItemNote` instead of `assessNewItemNote`, and `.asr-offer`'s
  accent rail so the two are distinguishable while scrolling past. The section head changes with them
  — *these are new items, not verdicts on yours* is exactly wrong about a row that IS yours. Accent
  and not a kind colour: `--purple` and friends stand for kinds of work, and an offer is a
  provenance.

  **The note comes off the pad on the RECEIPT, never on the tap.** The host posts the row and never
  touches the pad (synced client state it does not own), so the clear is the phone's half:
  `assessBusy` is a `Map<ackId, string[]>` carrying the note ids an apply is filing (empty for the
  ordinary case, and **ref-authoritative** like the queue — a `useEffect` mirror is a render behind,
  and what this map guards is a delete), and `op.ack` with `ok` calls `removePadNotes` (the one pad
  delete, tombstoned so it travels) and toasts `assessNotesFiledWords`. On `!ok` nothing moves. The
  failure mode is stated rather than hoped away: if the socket dies between the host applying and the
  receipt arriving, the row exists and the note stays — two copies, both visible, cleared by one tap
  on the pad. Never a loss, and never a silent one. The other direction, clearing at the tap, is a
  note deleted for an apply that never happened with nothing on screen to say so.

  **And only on PROOF, note by note.** `ok` is not "every row you ticked was posted": the host's
  apply loop carries on past a row the intent store refuses — the pending cap, a draft it cannot run
  — and still answers `ok` with counts. Three ticked offers against a full queue were therefore three
  notes tombstoned, and a tombstone TRAVELS, so no device put them back: a delete of somebody's own
  words done on the strength of a message that never mentioned them. The ack carries `filed`, the
  `fromNote` ids that actually posted, and the pad loses exactly `ticked ∩ filed` (`assessFiledSplit`
  in `assessRows.ts`, with `assessFiledWords` for all four outcomes — pinned by `node --test`).
  `filed: []` is a positive claim, the loop ran and nothing landed, and reads as *nothing was filed*;
  `filed` ABSENT is a refusal to claim — an older desktop, or an already-applied replay under a fresh
  ackId, which genuinely cannot say which notes the first apply filed — so nothing is cleared and the
  sentence is *left on the pad — the desktop could not say which it filed*, never worded as a
  failure, because the rows may well exist. The two errors are not symmetric and that asymmetry is
  the whole rule: a note left against a row that exists is a duplicate one tap clears, a note cleared
  against a row that does not is words nobody can get back.

  **A verb that does nothing is not drawn.** Three of the accepts on this sheet did nothing at all,
  and one of them did nothing on every row of a whole strip. The host's `applyProposal` reads a
  choice on an `unclear` row as a COUNT and stops there; it reads a pad note the same way, because it
  never edits the pad; and a `merged` member row's decision lives on the card above it, which is why
  that row was already refusing its own tap in a sentence — while still drawing the button that the
  sentence explained away, and drawing the member twice, once inside the card and once as a row of
  its own. Tap any of the three and the tick went on, the count went up, Apply ran, and the words
  were exactly where they had been. That is the shape of the complaint: *"just clicking accept for
  all I did see as I was not shown to really understand the agreement results"* — the ticks were
  agreement with something, and nobody could say what. So the button is not rendered where the tap
  cannot land: a `CantInline` sentence says what this row is and where its decision lives, which is
  the `Unavailable.tsx` rule applied to a control that was worse than a dimmed one, because it looked
  live. The same goes for the greyed `Apply` and `clear` — a bar that says `apply 0` and refuses is
  a bar that has already answered the question it is asking; with nothing ticked it says so in words.
  It also settles the tense: a ticked label is FUTURE — *will be retired*, not *retired* — because on
  this sheet Apply is the only thing that acts, and a past-tense label on a row whose words are still
  in the backlog is the same lie the dead accept told. A guide block at the head says what the three
  strips are and that a tick is a proposal until the bar is pressed, and the bulk buttons name their
  effect (`retire all 10`), not their arithmetic. The pad-note sentence `assessAcceptWords` used to
  write as a button's title is a `CantInline` now: a store this app cannot touch does not get a
  control, it gets a fact.

  **A `still wanted` verdict on a row that FAILED does something else, and the sheet was promising
  the wrong thing.** The row printed `position {rank} in the order` — a literal, inline in the
  component — and on a terminal row that is a place in a queue the row is not in: the ladder never
  looks at it again, so approving the verdict changed nothing anybody could observe. On the repo this
  was found in that was every row, 0 queued against 19 failed, which made this sheet's entire output
  a proposal with no effect. **Apply now PUTS a failed row BACK IN THE QUEUE** (`intent.requeue`, the
  same message `Backlog`'s *run it again* sends), and every sentence on the screen follows the
  mutation rather than the verdict:

  - `AssessDisplayRow.failed` is read off `AssessItem.state`, the same field `applyAssessment` reads
    to choose between a `rank` and a `requeue` — one reading, so the phone cannot word the fact
    differently from the host; absent state ranks, which is what every apply did before the field.
  - `assessRowPosition` replaces the literal: *put back in the queue, position 1* with a rank, *put
    back in the queue* without one (a re-queue needs no position — the row takes its turn where it
    lies, and drawing nothing there made the row whose verdict does the most look like the one that
    does the least), *position 1 in the order* unchanged for every row that was already telling the
    truth.
  - the row's verb becomes **`put it back`** / *will be put back in the queue*
    (`assessAcceptWords(verdict, source, failed)`), and its title carries the three facts a tap needs:
    the position it takes, WHERE it runs again when its turn comes, and that the failure it had STAYS
    on the row. The strip's `effect` line says the same where `g.failed > 0`.
  - **the bulk `keep all N` confirms when the strip holds failed rows**, which is the one place this
    sheet adds a confirm rather than removing one. A confirm on a harmless button is what teaches
    people to tap through the ones that matter — and re-sorting a queue is harmless, while putting
    nineteen pieces of work back on a desktop is the only thing on this screen that causes anything to
    run. The dialog names both numbers (*Keep 3 in usmc — put 2 back in the queue?*), because `Keep
    19` over a repo whose nineteen rows are all dead is the reading that hides the whole effect, and
    `assessBulkLines` then says what happens in the order it happens — back in the queue, one at a
    time in this repo, and where each one lands — plus the two things that do NOT (the failure is not
    wiped, nothing is retired).
  - `AssessApplySummary` gains **`requeue`, DISJOINT from `keep`**: a keep moves a row inside a queue
    it is already in, a re-queue is the row rejoining one, and a run whose whole effect was to revive
    nineteen dead rows must not restate itself as having re-sorted them. So the button reads *Apply in
    usmc — keep 1 in order · put 2 back in the queue · post 4 new*, named in full rather than as
    `requeue 2`, since the complaint this screen answers was vocabulary a person could not interpret
    in the last sentence before the tap. `AssessRun.applied.requeued` is the same count after the
    fact, worded by `assessAppliedWords` beside the label that promised it — a zero `put back` is
    omitted, because it would be a claim about a decision nobody made.
  - `ASSESS_APPLY_NOTE` became **`assessApplyNote(requeue)`**. *Nothing is built or sent by this* is
    exactly right for an apply that retires and re-sorts, and it is a promise a person is entitled to
    rely on — so an apply that revives rows says instead that nothing is started NOW and that the n
    put back run again when their turn comes, one at a time per repo, **each where it was already
    aimed**. A const would have left the old sentence standing on the one apply it no longer
    describes.
  - **…and that last clause used to read *each in a session of its own*, in four strings, and was
    false in all four.** That is true of a `fresh` row; a row carrying `targetSessionId` runs in THAT
    conversation. `AssessItem` does not carry the target — it carries the words, the state and the
    failure instant, which is everything a VERDICT is about — so this side cannot look it up, and the
    fix is to stop asserting the wrong one: `requeueWhereWords(one)` is the single clause, naming
    both outcomes and letting the row decide, shared by the accept verb's title, `assessBulkLines`,
    the bulk keep's title and `assessApplyNote`. Four copies of a claim is four chances for one of
    them to stop being true, and this one already had.

  **`read the plan` OPENS the document.** It used to drop `.waterplane/plan.md` into the composer and copy
  the path — the "here is a file, reference it" gesture every other file affordance in this app makes
  — and on the one screen where the next tap is Send, that is not what a path in the prompt box
  reads as. It reads as *run this*, and it was run: *"it did put the plan file reference to the CLI
  input, implying that what I do is run the result. But this is now again decoupled from the backlog
  and runs all in one session or what? That would contradict best practices like one new session per
  topic."* It does. One session was handed a plan covering every topic in it, which is precisely the
  shape `host/src/backlog.ts` retired when it gave EVERY FIRED ITEM ITS OWN CONVERSATION, and which
  `shared/sessioncost.ts` prices — past about three turns of work that does not need what is already
  in the window, a fresh session is the cheaper one, and this desktop's own fortnight put 76% of
  every token spent inside 124 long conversations. So the plan opens in the viewer, the app's one
  thing that renders a file, through `galleryCtxForFile` with `returnTo: "assess"`. And there is
  deliberately NO parser splitting that file into backlog items: the host asks the run for PROSE, on
  purpose, and cutting up a document a person wrote for a person is guessing at where their
  paragraphs stop being one thought. The structured route from an assessment to work already exists
  and is `AssessProposal.news` — proposed items this same sheet posts ONE AT A TIME, each opening its
  own session when it fires. The plan is what you read to decide; `news` is what carries the decision.

  **And the plan is opened VERSIONED.** `.waterplane/plan.md` is rewritten at the same path by every run,
  the viewer's document cache is keyed on `(repo, relPath, mtime)`, and `galleryCtxForFile` handed no
  mtime seeds 0 — so every run's plan filed under one key, and with the tunnel down *read the plan*
  painted run A's document under run B's verdicts. `onOpenPlan` passes `run.planMtime` (the host
  stat'd the file when the run settled), read off the same `assessRuns` entry this sheet is drawn
  from, so the document that opens is versioned by the run whose proposal is on screen behind it.
  ABSENT stays absent — the host omits it when there was no plan or no stat, and the viewer then
  caches the document neither way (see `Gallery.tsx`, *an un-versioned document is cacheable by
  nobody*) — never coerced to 0, which is the key the bug lived under. Closing the plan comes
  straight back here rather than via the outbox grid, for the same reason the trip is invited at all.

  **Applying used to be the end of the screen.** The tap wrote the retirements, the order, the
  merges, the new items and the re-queues — and then the sheet said what it had done and offered
  nothing: *"still no button to lead to the groomed backlog with the results where I then can kick
  implementation off"*. The whole point of the screen is to groom a list, and the list was one back
  gesture and two taps away with no sign that it was where you now wanted to be.

  So after `run.applied` the footer grows one primary control — `open the backlog — N waiting in
  usmc` (`assessOpenBacklogLabel`) — and **a count on a control is a filter**: the tap goes through
  `openBacklogCut`, the same door the schedule chips and the *Backlog groomed* notification use, so
  the rows that open are exactly the ones the button counted. It is a route and NOT a second
  mutation: the apply already happened by tap, and the sentence under the button says so in TEXT,
  not in a `title`. **And it does not clear `assessRepo` on the way out** — the cut is pushed OVER
  this sheet's own history entry, so a Back that found `overlayViews.assess()` returning null
  painted the launcher while `overlay` still read `assess`, and the next Back changed nothing
  visible. Back off a route returns to the sheet the route was on, with the button still there;
  `onOpenPlan` and `onOpenItem` beside it, and `ScheduleSheet`'s own `onOpenBacklog`, all keep their
  repo for the same reason. The scope is cleared by `onClose`, which is where leaving happens.

  **`assessReadyCut` is the one derivation, it reads the LIVE backlog rather than the ticks, and the
  cut is the WHOLE groomed backlog.** The ticks are the obvious source and are wrong for a reason
  that only shows up later: `assessPicks.ts`'s `dropPicks` is called ON APPLY, on purpose, and a
  reload drops them anyway, so a count derived from them would say 4 before a reload and 0 after it
  about the same backlog. The first live version was wrong in a second way, and worse, because it
  read as right: it took the rows the apply POSTED (`origin === assessOrigin(runId)`) plus this
  run's `wanted` rows still waiting — and *"4 waiting in usmc"* then stood over a repo with SEVEN
  waiting. Every `unclear` row is queued and was excluded by construction, and so was every
  retire-verdict row nobody ticked; `assessOpenBacklogNote(0)` went on to say *"nothing here is
  waiting any more"* while rows waited. A number that means something other than its own words is
  the failure this whole file is organised against, and the fix is not a reword: the cut is now
  **every non-archived `queued`/`blocked` row in the repo**, which IS the groomed backlog and is
  what was asked for. `origin`/`wanted` are gone. `queued` and `blocked` only — a row that has
  started is not waiting for anybody, and an archived row is somebody having said it is not waiting
  (`BacklogStatus` has no `blocked`: the host flattens a blocked intent to `queued`, because a block
  is a sentence on the row and not a state). A zero count is DROPPED rather than printed (`open the
  backlog in usmc`), and the zero sentence is now a fact about the REPO — *nothing is waiting in
  this repo*. The bar names both halves (`assessCutLabel`: *everything waiting in usmc, from the
  assessment*), because naming only the assessment would be the old cut's label over rows the
  assessment never judged. The list handed over is `backlogItems` and NOT `intents`: they share ids,
  but the intent list also holds builds, launches, sweeps and schedules, which are `queued` in the
  same sense and are not rows in anybody's backlog — counted, the button would say more than the
  list it opens can show. This is the one piece of live state the sheet is given; everything else is
  the run's own snapshot, deliberately, and the prop says why.

  **And the cut a person lands in says whether anything is going to run it — about THOSE rows.**
  `focusRunWords` in `backlogFilter.ts` took `cut.length` and a boolean once, and an ids base is the
  one base where a count cannot answer: it is `inRepo` with archived rows in it ON PURPOSE, so
  `merged from 3` — three originals whose never running is the whole point of a merge — was told
  "3 rows" and answered *"these 3 start one at a time in this repo, each in a session of its own, in
  the order you see"*. Four clauses, four of them false, on the screen somebody opens to find out.
  So it takes a BREAKDOWN (`FocusRunBreakdown`) built in `Backlog.tsx` off the same predicates
  `nextFireIds` uses — `groupKeyOf` for where a row runs, `clockAhead` for whether it is next at all
  — and each clause is drawn only for rows it is true of: **`null` when nothing in the cut is going
  to start** (the merge case, a schedule child cut of `done`/`failed` rows, *Aimed at a session that
  closed*); *in a session of its own* only for a FRESH row, *in &lt;session&gt;* for an aimed one
  (whose group head says the same two lines up); *one at a time in this repo* only with nothing
  aimed, because `nextFireIds` picks one per GROUP and two open sessions plus fresh rows start three
  at once; *in the order you see* only where the flat list IS the order — (nothing re-sorts rows automatically any more). What is on screen and is not
  starting is COUNTED and not diagnosed (*the other N here are not going to start — each row says
  why*), because held is four reasons and each row already carries its own. With auto off the
  refusal is a sentence with the existing `onSetAuto` switch beside it — and **that is the only copy
  of "auto is off"**: the head banner is drawn exactly when this sentence is not, keyed on the
  sentence itself rather than on `filter.ids`, so a cut where nothing was going to start still says
  it once. The button's `title` lives here too (`FOCUS_AUTO_ON_TITLE`) — a claim about what a tap
  does is a user-facing sentence. No batch runner, no new execution path, no per-row control
  touched.

  **A progress frame is not a reason to re-render every phone.** The host broadcasts `assess.state`
  on each live progress reading, about every 1.5 s, and `App` rebuilt the `assessRuns` map
  unconditionally — a twenty-minute run is ~800 whole-App renders on every connected phone, the one
  sitting on a terminal in another repo included. Only this sheet reads `progress`, so when it is not
  the open overlay and both the stored and incoming run are the same `runId` and both still
  `running`, the previous map is kept — the same guard `build.output` and `capture.output` already
  carry, one rung up. It swallows nothing that matters: a status transition, a new `runId`, a `null`
  run, an unknown repo and every frame while the sheet is open all still land, and `openAssessFor`
  re-asks `assess.state` on open (the overlay ref is written during render, which commits long before
  an answer the socket has to round-trip for), so the sheet cannot open on a reading older than the
  tap that opened it.

  **The pictures an item names.** A backlog item is often about something you looked at — a
  screenshot, a diagram, a capture in `.claude/outbox/` — and a row that quotes its path asks the
  reader to hold a filename in their head while judging whether the words should be retired. So a row
  whose text `refsIn` finds a file in now draws `AttachStrip compact` UNDER the words. Under, and
  never instead: the words are not passed through `Markdown` here, because this sheet's whole
  contract is that the sentence being retired is shown exactly as it is, and re-typesetting the thing
  being approved is the one place formatting is a change to the evidence. A file that is gone is a
  STATED fact on the strip, not a broken image and not a silence; offline, the strip says it cannot
  check rather than implying either. The listing is fetched lazily through `useInView`, because a
  forty-row proposal would otherwise fire forty listings at a phone on a tunnel the moment the sheet
  opened. And **the ticks survive a side trip**: `App` returns early once per overlay, so opening the
  plan, an item or one of these pictures UNMOUNTS this sheet — decisions kept in component state
  would be gone on the way back. `assessPicks.ts` holds them outside the tree, in memory, keyed by
  `runId` so a different run never inherits them. That was already true; this change is what makes it
  load-bearing, because opening the plan in the viewer is a side trip the sheet now actively invites.

  **What the run wants to CALL each item, and the one switch that decides.** An assessment now reads
  the rows for a title and a kind as well as a verdict (`AssessRow.headline` / `.category`,
  `AssessMerge`, `AssessNew`), and those are the same class of thing as everything else here: a
  proposal. So the row draws them — the kind as a chip, the title in the head, wearing `Sparkles`
  when the words are the run's and not wearing it when they are a name somebody typed (`assessRowHead`
  is `itemHeadline`'s order said in this file's terms) — and NOTHING is written until the switch at
  the end of the scroll says so. `head.kind` survives only where there is no title at all, which is where *backlog item* over a
  list of backlog items was ever worth its line: an unnamed `pad note`, whose accept is refused and
  whose refusal is about that store.

  The decision is `assessNameQuestion` / `ASSESS_NAME_WRITE` / `ASSESS_NAME_SKIP` / `assessNameNote`,
  all `@waterplane/shared`'s because the host says the same thing back, and it sits **beside** the
  pin-ranks question, **at the end of the scroll rather than in the fixed footer**. Both halves of
  that are one measurement, taken once in Chrome at 320×780 with both questions drawn and quoted
  verbatim by `AssessSheet`'s `asks` and by `.asr-pin` in `styles.css` — three claims about one
  number is the thing the check-not-a-paragraph rule exists for, and this subject had three.
  **The list keeps 399 px with the pair in the scroll, and the pair itself is 314 px** (at 400×850:
  520 px and 250 px), both at `--ui-font` 1. Side by side, the taller of the two
  governs, so asking a second question costs almost nothing in height. In the footer, where they
  cannot scroll away, that height comes straight off the list — the guide block's letterbox rebuilt
  at the other end of the screen. So the questions
  moved down into the scroll, immediately above the bar that holds Apply: read in order, one scroll
  position from the tap, and the footer keeps only what is true at every scroll position (the apply
  bar, and the sentence saying what applying does not do).

  **What that placement costs is that a question can be scrolled past, and the footer is where it is
  paid back.** `assessApplyLabel` restates BOTH answers — `· order pinned` / `· order free` whenever
  this apply would give anything a position, and `· title N` whenever the naming switch is on — so
  the last line read before the only irreversible tap here names the decision even when the control
  was never on screen. It said only the naming half for one release, which meant a person could
  Apply having never met the decision about whether the ranks are marked *placed by you*; the order
  part is unconditional on the ANSWER, because a part that appears for one of two answers reports a
  choice as an exception. `assessRows.test.mjs` pins both halves.

  **…and for one release the pair was unreadable on the one device it is used from.** The two
  questions' answer buttons were an `.annot-tools tri wrap` strip borrowed from the annotator, and
  that class is two wrong things at once here: `overflow: visible`, so nothing clips what escapes,
  over `.key`s that are `flex: 0 0 auto`, i.e. always their max-content width and unable to shrink.
  Inside a column whose basis was a FIXED `118px` that was fine at `--ui-font` 1 and false above it
  — the column is a pixel count, the words are a font size — so on a 384 px phone with a larger text
  setting a pin-question sentence painted straight over the naming question beside it and
  `leave the rows as they are` ran off the right edge of the screen: 178–347 px outside the viewport,
  measured. Reported three times, invisible at 320 and 400 in a default-scaled browser, which is why
  it survived two rounds of "verified".

  The fix is that **a basis in pixels is a claim about how wide words are, and words are measured in
  `ch`.** `.asr-asks > .asr-pin` is `flex: 1 1 18ch` — 18 characters of the column's own text, so
  the same rule keeps two columns where two are readable and drops to ONE where they are not, with
  no media query and nothing to re-tune when a font setting moves (side by side at 320/1, 384/1,
  384/1.25, 400/1, 400/1.25; one column at 320/1.25, 320/1.45, 384/1.45, 400/1.45). Inside a
  question, `.asr-answer > .key` is `flex: 1 1 12ch; min-width: 0; white-space: normal`, so an
  answer shares its column and wraps its own words rather than pushing out of it — and the two
  answers sit side by side in a wide column and stack in a narrow one by the same mechanism.

  **What `18ch` is measured in, said exactly, because it was said wrongly.** The comment claimed it
  was "measured in the column's own text"; it is measured in `.form-hint`'s 13 px sans, which is the
  element's font, and the words that actually overflowed are `.key`'s 14 px monospace. Both scale
  with `--ui-font`, so the basis still tracks the text — it is simply not a measurement OF the words
  it decides about, and reading it as one is how a comfort threshold quietly becomes a promise. It
  does not need to be one: **the threshold is the comfort; the correctness does not depend on it.**
  No overflow and no overlap come from `min-width: 0` plus wrapping, unconditionally, and hold at
  `--ui-font` 1.5, 1.8 and a forced 1.9. The 44 px fingertip floor is asserted on `.asr-answer >
  .key` rather than inherited, because `.annot-tools.tri .key` is a deliberate 36 px exception and
  these buttons were inside it — they measured 36 px. (The comment used to cite that exception by
  LINE NUMBER, which was wrong two edits later. Cite the selector.)

  **1.45 is not the ceiling, so three more strips on this sheet got the same recipe.**
  `uiScaleSteps.ts`'s `TEXT_MAX` bounds what the app's own zoom will set; Chrome/WebView on Android
  then multiplies px text by the SYSTEM font scale ON TOP of `--ui-font`, so an effective ~1.9 is
  reachable — on exactly the phone that has reported this three times. At 320 px and 1.9, `approve
  the merge` (`.act-acts`, a merge card), the step-log toggle (`.section-head`, *what it looked at*)
  and the head's scoped re-run button each measured wider on their own than the screen, in
  `overflow: visible` strips of `flex: 0 0 auto` `.key`s: the same bug, three more places, and it
  does not clip — it paints where nothing can scroll to it (330, 346 and 376 px right edges on a
  320 px viewport, measured in headless Chrome against the built stylesheet). So
  `.assess-sheet .act-acts > .key`, `.assess-sheet .section-head > .key` and `.assess-sheet
  .sheet-head > .key` are `flex: 0 1 auto; min-width: 0; max-width: 100%; white-space: normal;
  overflow-wrap: break-word` — `.act-bulk`'s `0 1` and not `1 1`, so a strip of two short verbs does
  not stretch them across the row — with the icon pinned `flex: none` so the WORDS give up width and
  the mark does not. Scoped to `.assess-sheet`: `.act-acts` and `.section-head` are app-wide classes
  whose other users carry short verbs; this is the sheet whose controls are sentences.

  **The Apply label was cut off for the same reason, one class along.** `.act-bulk .key` inherited
  `.key`'s `flex: 0 0 auto`, so the bar's buttons were always max-content: `Apply in usmc — retire 2
  · post 3 new · order pinned · title 6` rendered 567–801 px wide inside a 320–400 px phone. That
  label is deliberately a whole sentence rather than `Apply 4` — it is the last thing read before the
  only irreversible tap on the screen — so truncating it undoes the reason it exists. `.act-bulk
  .key` is now `flex: 0 1 auto; max-width: 100%; white-space: normal; overflow-wrap: break-word`:
  may shrink and wrap, never grows (a bar of three short verbs must not stretch them across the
  row), and `min-width` is untouched so the fingertip floor stands. Fixed for every bulk bar in the
  app, not only this one.

  Neither answer is styled as the safe one. It starts
  on *write*: a title is the cheapest thing on this screen to be wrong about — one tap on the row
  edits or clears it, and a typed one is never touched at all — while an un-named backlog is the
  state somebody opened the sheet to get out of. The answer rides with the ticks in `assessPicks.ts`
  for the ticks' reason, and the guide gains exactly ONE line when the run named anything, because a
  decision first met at the bottom of a sixty-row list is a decision taken without reading.

  `AssessApplySummary.name` counts the EXISTING rows this apply would title — the host's own gate
  (an intent row this device holds that did not go in as context), and **not** `assessNameCount`,
  which includes merges and new items whose names ride with the prompt they are posted with whatever
  the switch says: a posted row has no sentence of anybody's for a title to sit on top of, so the
  question does not arise. It is counted whether or not a row's verdict was ticked, because naming is
  one answer about the whole run — *I do not agree this is done* is not *do not call it that* — and
  it does not go to zero when the switch is off, because a summary that depended on a chip is
  arithmetic nobody can check. The switch decides whether `assessApplyLabel` SAYS it, last in the
  line — after the four parts that change what runs and after the one that decides what may re-sort
  them; `assessAppliedWords` says `N titled` on the settled row, and omits a zero for `requeued`'s
  reason.

### The slot check — `slotCheck.ts`, `slotAskStore.ts`, `SlotAskLayer.tsx`

Smart pick's replacement (2026-10-16): *ask when a slot gets crowded, check it once, the person
approves each change.* A slot is `shared/intent/slot.ts`'s — the waiting timed rows that fire
together at one usage reset or one instant — and the phone never buckets rows itself: every number
below is `slotMates`/`slotOf`/`slotsOf` over `slotRowOfItem`, and the ids a check sends are the ids
the number was counted from (a count is a filter).

- **The ask after a timed send.** `useSend` calls `expectSlotAsk(id, cwd)` on the four timed paths
  (a one-off `schedule.save` aimed at one repo — the backlog row has the entry's id —, a clock aimed
  at a session, a re-decided row's `patch`, and `retimeMany`). It waits for a `backlog.list` that
  holds the row **on the clock the tap set** (`clockStamp`: a re-time's first list may still carry the
  old one), then `resolveSlotAsk`: ≥1 mate and not switched off ⇒ the card *N others run at this
  reset — check them together?* with *check*, *not now*, *don't ask in this repo*. Given up after
  `SLOT_ASK_WAIT_MS`. The card is mounted beside the toast in `main.tsx` (App returns early per
  overlay) and is NOT a modal and NOT a toast — a toast goes on any tap, this has to be answerable;
  unanswered it goes after a minute, and the backlog verb below is still there.
- **The switch is per repo, per host** (`LS.slotAskOff`, not synced). The toast that turns it off
  names the way back — *ask after a timed send*, drawn in that repo's backlog bulk line only while it
  is off (ux §1: said when it changes, named where it comes back).
- **The backlog's *check these N*** (`PickBars`, beside *re-time the N on …*): one per slot with ≥2
  waiting rows, off `inRepo` and never the cut on screen. It is how agent-posted rows — nobody
  there to ask — get checked.
- ***check* never spends over a decision** (`slotCheckStart`): a running run, or an unapplied
  proposal that is not this slot's, opens the sheet and says so; its run button is
  *check these N together* (`assessSlot` carries the scope for *run again*). `assess.run` carries
  `scope: {kind:"slot", key}` beside the ids; the host re-derives the slot and refuses a stale key
  in words — shown as every assess refusal is.
- **The sheet** (`assess/AsxSlotCards.tsx`): a slot run says so (`assessSlotIntro`, the head's
  *slot check · N rows*). A CONFLICT card names every row in full and why; its verbs are the rows'
  own — *open*, *edit* (the Send sheet, the same row re-decided), *drop this one* (archive behind a
  `ConfirmButton`), *leave them* — and there is no apply choice for it at all (`assessChoicesOf`
  has no input for one). A SPLIT card shows the original and both texts in full; *approve the split*
  is behind the merge's `askConfirm` and rides in `AssessChoices.splits`; the apply label says
  *split N in two*.

### `ContextSheet.tsx` — the context window as a shape

- `ContextSheet.tsx` + `ContextGraph.tsx` + `contextPlot.ts` — **how full the window has been, over
  time, with the compactions and the walls on it.** "Context 43% free" is a badge, and a badge can
  only say where you are. The three questions a person actually has are about the shape: is this
  climbing fast enough that it will compact before the task is done, did the last compaction happen
  where the previous ones did, and was that four-hour gap a usage wall or just me not typing. The
  data is the host's `ctxlog.ts` (the CLI's own conversation log, which is dated); the split here is
  the usual one — `contextPlot.ts` is pure geometry and every sentence, node-tested by
  `contextPlot.test.mjs`; `ContextGraph.tsx` emits SVG and owns nothing but the visual contract;
  `ContextSheet.tsx` is the read, the states and the table twin.

  **One control grammar, shared with the all-sessions screen.** The chart/values switch used to be an
  icon-only button in `.sheet-head`, beside refresh — the one control on either sheet that answered
  *what am I looking at* from outside the thing being looked at, at the far end of a phone-wide bar
  from the first row it changed. It is a labelled `show as · chart | values` chip row at the top of
  the body now, identical markup on both screens. The four rules it settles, written as a comment
  above each sheet's return so a fifth spelling cannot quietly appear:

  1. `.sheet-head` holds chrome only — the way back, and verbs about the DOCUMENT. Nothing in the
     head changes what the body shows.
  2. A choice that changes the body is a `.ts-filter` row of labelled `.key` chips, lit
     `.key.active`, directly above the first thing it changes. Where a screen can also keep the
     other half of that rule — below everything it does NOT change — it does; `ContextSheet` cannot,
     because the cost panel, the compaction ledger and the expired-cache panel are invariant and
     INTERLEAVED with what the switch changes, each sitting under the chart it reads. Where the two
     rules collide, *under its subject* wins: moving a panel to satisfy a control's placement is
     arranging the facts around the furniture.
  3. A choice that changes one section's reading is `.ts-seg-chips` inside that `.section-head`.
  4. A verb that cannot run is not drawn and its reason is a sentence; a verb that is RUNNING says so
     in its own glyph. Never `disabled`.

  **`.key.on` was a dead class, and that is how three lit states went missing.** The only `.key.on`
  rule in `styles.css` is scoped to `.bl-modal-seg`, so the head toggle and this sheet's *stack by*
  chips had never once shown which side they were on — a filter that cannot say what it is filtering,
  invisible in review because the markup reads correctly. `.key.active` is the one lit spelling on
  both sheets. `.ctx-panel` was the same failure in the same week (a panel with no rule at all,
  rendering as a bare `div`); the general shape is that a class name is a CLAIM about `styles.css`
  and nothing checks it.

  **The values view is a half of the sheet, not a mode of the chart.** It is split in two around the
  invariant panels so every panel still sits under its subject in BOTH views — a section added to one
  half has to be added to the other at the same position, or the rule silently breaks in the view
  nobody opens. It also means a caption may no longer describe a MARK: the dashed line and the ⁄⁄
  gap marks are chart-only and are withheld there, while the gap FACT is re-worded for the readings
  it separates. `axisNote` stays in both — the scale is what every reading is a percentage of.

  **Long method prose folds; an absence never does.** `compactionMethodText()`'s disclosure is the
  pattern — four blocks on this sheet and eight on the all-sessions one are `details.hint-more` now.
  What may NOT fold is a sentence explaining something that is not on the screen: a mean that is not
  drawn, a form chip that is not offered, a section that cannot be answered, an outlined box standing
  for *nobody measured this*. That is `Unavailable.tsx`'s rule applied to prose, and it is what
  decided every keep/fold call. Restatements, pointers and reassurances were cut outright — including
  *"Nothing on this panel stops you"*, which is the app's standing rule and not this panel's claim.

  **The shape comes first, and each prose panel sits under the chart it is about.** The sheet is
  called *Context window* and the question it exists for is about the shape; it opened instead on
  three lines of methodology, then the cost panel, then the compaction ledger — about thirty lines
  of argument on a phone before a single pixel of chart, reported from one. The order is now
  **summary → the context chart and its legends → the cost panel → the compaction ledger → the spend
  chart → the agent bars → the token split**, which puts the cost reading directly under the curve it
  is reading and the ledger directly under the ticks it explains. Two consequences worth naming: the
  `{!table && …}` fragment is SPLIT in two (the panels sit between its halves, and both are still
  outside the switch, which is the rule they already had), and the intro paragraph is now a caption
  at the foot beside `axisNote` — the top line keeps only the session's own name, because that is the
  one thing on it that changes.

  **Why the geometry is a separate, tested module.** A chart is the one kind of view where being
  slightly wrong is invisible: a row rendering the wrong verdict is caught by anyone reading it, a
  curve whose axis silently excludes the ceiling it is drawn against looks exactly like a correct
  chart. Three bugs found by rendering it and looking, each now pinned:

  - the domain was rounded to a nice ceiling and the ticks were computed over that ceiling
    separately, so a 250k domain carried a tick labelled 300k — and since a value is clamped into
    the domain before it is drawn, that label sat at the top of a plot nothing could reach. Every
    reading was a third lower than the axis said. `yScale`/`pctScale` now return the top AND the
    ticks, and the top IS the last tick.
  - the area path dropped the line's leading `M` instead of replacing it with an `L`, so `M40,200`
    butted against `40,113` parsed as `M40,20040` — the fill entered from off the top of the world
    and stuck a wedge out of the left of the plot.
  - `nearestSample` compared `|s.t - best.t|` against `|s.t - t|` — a candidate against itself —
    which happens to give the right answer on an evenly spaced series and the wrong one everywhere
    else.

  **One y axis for every graph: 0 to 100% of the model's window.** Two sessions' charts are only
  worth putting side by side if "half full" means the same on both, and an axis fitted to each
  series' own peak makes a 40k conversation and a 900k one draw the identical shape. The window
  comes from `@waterplane/shared`'s `resolveContextWindow`, whose answer is a MEASUREMENT rather than a
  table — the CLI's log records the base model id even for a 1M conversation, so an id-keyed table
  was five-fold wrong for the models actually in use ([host.md](host.md#ctxwindowts) has the
  numbers). The sheet names the source, because "assumed from the id" and "this model has been seen
  to hold it" are different claims and only one is defensible. The axis is NOT re-fitted to the data (a
  curve hugging the floor IS the answer to "how full is it"), and it grows past 100% only in whole
  25% steps, so two charts' gridlines stay the same heights. When the model is unrecognised the axis
  falls back to tokens **and the sheet says so** — a chart silently 5× off is worse than one that
  admits it does not know. The same axis is used by the launcher row's `ContextSparkline`, which is
  the entire reason a curve on a list row is worth anything.

  **The time axis is piecewise.** This app exists for sessions that hit a wall in the evening and
  resume the next morning, so a strictly proportional axis is not a neutral choice here: measured on
  a real session — one wall on Wednesday, forty minutes of work on Friday — every reading landed in
  the right-hand 2% of the plot. `timeScale` compresses any stretch with no readings longer than
  `GAP_BREAK_MS`, draws the discontinuity (the ⁄⁄ mark, the strip painted out in the surface
  colour) rather than hiding it, and the sheet names how much time each break holds. Only the
  READINGS anchor the axis — a wall that kept its full proportional width would take the plot over,
  being the longest thing that happens here — and `tx` is a real inverse, so hit-testing works
  across a break. x-axis ticks are placed by PIXEL and read back through `tx`; dividing the time span
  instead put the middle label inside the break, on top of the first one.

  **The colours were validated, not chosen.** Series `#3987e5`, compaction `#c98500`, usage limit
  `#d03b3b` on `--panel`: worst all-pairs CVD ΔE 10.2 (≥8), worst normal-vision ΔE 16.9 (≥15), all
  three ≥3:1 against the surface. Orange-for-compaction was the first draft and failed — `#d95926`
  against the limit red measures 6.8 to normal vision, i.e. two event kinds nobody could tell apart.
  Events carry a SHAPE and a word as well (▼ compaction, ■ wall), the legend is always present, axis
  text wears ink tokens rather than the data colour, and there is a table twin so no value is
  reachable only through the crosshair.

  **What those tokens WERE — and why it took a second screen to notice it was missing.** The spend
  chart under the curve answered "how much": *16M spent so far*. On its own that is the number
  `shared/tokens.ts` opens by calling this app's most misleading — measured across this desktop's
  9,444 logs, **96% of every token was a cache read**, fresh input was 1.0M against 13.15B. A
  reader who takes a session's spend figure for what they typed is out by two orders of magnitude,
  and the all-sessions screen had refused to print a total without its split since the day it was
  written. The per-session screen printed exactly that bare figure, because the strip that would
  have fixed it was a private function inside `TokenStatsSheet.tsx` — twice, once per ledger.

  So the same four kinds, per session: `ContextSeriesDoc.split` (this conversation's requests) and
  `agentSplit` (its subagents'), both plain `TokenTotals`, both accumulated by host `ctxlog.ts` in
  the SAME pass and behind the SAME guards as `usageTok` — `tokenTotal(split)` IS `usageTok`, which
  is a host test and not a hope. A second tally with its own dedupe would drift by a few percent
  and be unarguable. `contextPlot.ts`'s `spendSplit`/`splitSummary`/`splitNote` are the pure half;
  the strip itself is `TokenComposition.tsx`, shared with the all-sessions screen so a kind cannot
  pick up a different hue or a different word on the way between the two.

  Three things the wording has to get right, all pinned:

  - **`split.turns` counts REQUESTS, not prompts.** A turn that ran thirteen tools sent fourteen of
    them. `ContextSeriesDoc.turns` is the outline's count and stays what it was; `cacheReading`
    divides context by turns on BOTH screens, and `tokenstats.ts` counts a request there — a
    per-turn figure meaning tool calls on one screen and prompts on the other makes one
    conversation read two ways depending which you opened.
  - **The bar folds the agents IN, and says how much of it they are.** (It used to add "the chart
    above can only draw them as a gap because their logs carry no clock" — false: agent logs are
    dated, and the spend chart now stacks them as a grey band from `agentCum`.)
  - **`cacheReading(totals, "session")`** — the scope changes two sentences and no arithmetic. The
    corpus wording's escape hatch is *go and read the per-session reading on the context screen*,
    which on this screen points at itself, and its advice would repeat the cost panel six lines
    above that has the actual buttons. So the session scope re-words the mean's caveat and offers no
    advice at all.

  Absent, never zeros: a host one version behind sends no split and the section does not exist; a
  tally of zeros beside an absent total would read as "the agents spent nothing".

  **What compacting saved, and what it cost** (`CompactionPanel`). The chart has always drawn a tick
  at every compaction, and a tick is the one thing about a compaction nobody has to be told — *what
  it did* is the question, and the log can answer it. Two rows, split by trigger (*you typed
  `/compact` 3×* / *the CLI compacted 2×*), each carrying tokens AND money on both sides, because the
  two sides are a cache read and a cache write and their token counts differ by up to twenty times in
  price — a ratio of the counts is a number that means nothing. The arithmetic is the host's
  (`ctxlog.ts`, in the pass that already prices the conversation) and every sentence is
  `shared/sessioncost.ts`'s, so a second surface growing this later cannot word it differently.

  Four rules, all of them the repo's existing ones landing on a new figure:

  - **The saving is money that was never spent**, and the sentence says so. Every other number on
    this screen is spend; read as one more of them, this is the most convincing wrong figure the
    sheet could print. The cost is the opposite — real cache writes, already inside the session's
    own total — so a reader must not add them either.
  - **`saved 0` is the token spelling of `$0`.** A compaction with no turn after it has saved
    nothing YET, which is a different claim from "compacting saved nothing"; the row reads *nothing
    back yet* and the zero side is dropped, never drawn (`compactionRowFacts`).
  - **Past the model's window the saving stops being a saving.** An uncompacted window of 2.6M is
    not an expensive conversation, it is a refused request, and `compactionWindowText` says that
    directly under the multiple — a bare *382× what it cost* with the qualifier two paragraphs down
    is a benchmark nobody can hit. That sentence is also about the turns SINCE, so it is withheld
    where there are none.
  - **A boundary the log could not describe is never called "the CLI's own."** It has its own
    sentence outside the figures, `unpricedTok`'s posture applied to a count.

  Outside the chart/table switch, deliberately: it is words and numbers in both views, and a fact
  reachable only by tapping a chart toggle is what the values view exists to prevent.

  **`compactionMethodText()` folds.** It is four sentences on how both figures were arrived at, and
  it is the third paragraph in a row of prose on a panel whose two numbers are already on the rows
  above. It is not deleted — it is the reason the ratio can be trusted in the direction it will be
  used in (both estimates are biased AGAINST compacting looking worthwhile), and a reader arguing
  with the multiple needs it — so it is a `hint-more` disclosure, the same one `PullSheet` uses.

  Read through `useRemoteResource` with the IndexedDB copy (`ctxseries`, v10) seeded first, because
  this is opened at exactly the moment the link is the thing misbehaving. `e2e-ctxgraph.mjs`;
  the host half is [host.md](host.md#ctxlogts).

### `TokenComposition.tsx` — the one strip, everywhere a total is printed

> **Moved (2026-10):** `TokenComposition.tsx`, `statsPlot.ts` and `useBoxWidth.ts` live in `packages/web/src/kit/chart/` (shared by the context, repo-health and token screens); the token statistics screen itself is the `token-stats` extension, `packages/extensions/token-stats/web/` (layout in [token-stats-architecture.md](token-stats-architecture.md)). The rules below are unchanged; only the paths moved.

- `TokenComposition.tsx` — `KindBar` (the 100%-wide band plus its labelled legend) and
  `CacheVerdict` (the sentences `shared/tokens.ts` writes about the share), extracted from
  `TokenStatsSheet.tsx` the moment a third screen needed them. It holds the validated four-slot
  palette (`SLOT`, and `SERIES` for a single series) and **decides no numbers**: the bag, the
  denominator and the formatter all come from the caller, because the two ledgers count differently
  and one of them has no prices at all. The caller-supplied `whole` is not always the sum of the
  bag — opencode's ledger has a fifth kind the palette has no hue for, and its shares must be
  against everything counted rather than everything painted, which is what `children` (a legend
  entry with no swatch) is for. The point of sharing it is not the saved lines: a reader who has
  learnt to read the band on one screen has learnt to read it on all three.

### The session-cost reminder — what a turn here costs, against a fresh one

- `@waterplane/shared`'s `sessioncost.ts` + `sessionFacts.tsx`'s `sessionCostPill` + `core/sessions/tags.tsx`'s `costTag`
  and its one toast + `ContextSheet`'s top panel.

  **The measurement that produced it.** Across a fortnight of this desktop's own conversation logs:
  9.96B tokens, 94.7% of them cache reads. **124 conversations out of 8,968 grew past 200k of
  context, and those 124 accounted for 76% of every token spent.** Turns at index 80 and beyond were
  54% of the total, at an average of 312k carried per turn. The top ten conversations alone were 28%.
  And in that whole fortnight there were **five compactions** — a 1M window never resets itself, so
  the longest conversation measured ran 454 turns over 88 hours to a 755k peak and was never once
  cut back. None of those sessions was doing anything unusual. They were long, and nothing anywhere
  said what that cost.

  **Why the existing badge could not say it.** `contextPill` is "43% free", which is a statement
  about *when the CLI will compact*. The price of the next turn is a different fact on the same
  axis: every turn re-sends the whole conversation, so what it costs is the size of what is already
  there, not the size of what you are about to ask. A session at 40% of a 1M window is comfortable by
  the first measure and the most expensive thing on the desktop by the second. Folding the two into
  one badge would hide precisely that case, so they sit side by side.

  **The denominator is measured, never assumed.** A fresh session's per-turn cost is dominated by the
  project's own `CLAUDE.md` and tool surface, which varies by an order of magnitude across one
  desktop — measured, median first-turn context ran from 43k in one repo to 100k in another, and in
  this one ~35k of it is `CLAUDE.md` alone. So the baseline is *this session's own first reading*,
  and when the log was truncated there is **no baseline and no claim** rather than a constant that
  would be wrong for most repos. The direction matters: understating is allowed, calling an expensive
  session cheap is not.

  **`breakEvenTurns` is the number worth showing.** Derived from `pricing.ts`'s cache multipliers
  rather than guessed — continuing costs `n · tok · R`, a fresh session pays `base · W` once and
  `base · R` after, so `n = base(W − R) / (R(tok − base))`. At a 71k baseline that is ~13 turns at
  2.5×, ~5 at 5×, ~3 at 9×, which is the band the three thresholds came from. It is also why the
  advice ends *a quick question is still cheaper here*: the write premium is real, and a rule of
  thumb that said "always start fresh" would be wrong about the most common case. The whole point of
  computing this per session is to stop having a rule of thumb.

  **`W` was the 5-minute tier until it was measured, and those numbers were 8 / 3 / 1.** Across all
  13,397 conversation logs on this desktop, 8,160 of 8,160 main-conversation cache writes are at the
  **1-hour** tier (2× input, not 1.25×) — every CLI version sampled, every entry point, every model
  — and the 5-minute tier appears only in the 571 subagent logs, which makes the tier a harness
  policy per request kind rather than a fact about a machine. Reading it at 1.25 understated every
  break-even by about 65%, i.e. it was nudging people out of warm sessions a third of the way early:
  the one number in the module that was wrong rather than absent. `breakEvenTurns` now defaults to
  the 1-hour multiplier and takes an override for a caller that has measured its own.

  **And the advice is wrong in the other direction once the cache has expired.** *A quick question
  is still cheaper here* is a claim about a window that can be re-READ at 0.1× — on one nobody has
  touched for hours it has to be re-WRITTEN first, and the question is then an order of magnitude
  dearer than the same question in a new session. `cacheLikelyCold` is the guard, and everything
  about how it is worded is a consequence of what is actually knowable: the cache is server-side and
  unobservable, its entry refreshes on every hit and expires an hour after the last request's
  START, while the log stamps a turn when generation ENDED.

  **Measuring that from the logs has two traps, and both manufacture fake WARM readings.** A
  compaction inside the gap drops the window to a tenth, so the request after it writes a small
  number that looks nothing like a re-write — those gaps must be excluded, not counted warm. And
  `cache_creation > cache_read` is the wrong discriminator: every cold resume still reads the
  tools-and-system preamble, a separate entry kept warm by sibling sessions in the same repo and
  measured at 32.5k-36.8k here, so a 60k conversation coming back cold reads 36.8k and writes 30.6k
  — write < read, stone cold. The test is whether the read covers the conversation's OWN previous
  context. With both corrected, the cold fraction by gap is 0.2% under 30 minutes, 0% at 30-50, 36%
  in the 58-62 band, 89% at 62-70, 96% at 90-120, **100% (48 of 48) between two and four hours** and
  99% past four. So the threshold is the TTL plus half an hour, and there is no countdown anywhere:
  printing minutes would put a number on the one band where the answer is a coin toss.
  Nor is there a dollar figure, because 55% of cold resumes still read 5-23k of tools-and-system
  preamble kept warm by sibling sessions in the same repo, which makes the real multiple anywhere
  from 5× to 20× (and 80× on a model with its own published cache-read rate). One sentence, worded
  as a likelihood, and the clock is read on the PHONE at render: a warm/cold flag computed on the
  host is stale on arrival, and a device that slept for three hours has to recompute it.

  Three mechanisms make "past the TTL" less than certain, all of them in this repo's own workflow: a
  `--fork-session` continues the same prefix in a DIFFERENT log, an auto-resurrect `--continue`
  after a limit exit does too, and a request that hit the usage wall leaves a record with no usage
  at all and still warmed the cache. What they amount to is ONE warm reading in 118 past four hours,
  and one in 71 between 90 minutes and four. An earlier draft of this rule put that residue at 5%
  and waited two hours because of it; that 5% was the two measurement traps above, not forks. The
  margin is what the generation-END stamp costs, and the residue is why the sentence still says
  *very likely* rather than naming an instant.

  **It is a reminder, and a reminder that can stop you is not one.** Nothing here returns a boolean
  (a unit test asserts that literally, so nobody can add a `blocked` flag later and have it look
  natural); nothing intercepts a send; no button is disabled — the repo's own rule, `Unavailable.tsx`
  and [no dim disabled buttons]. The chip is **absent** until there is something to say, and stays
  absent for the first `MIN_TURNS` readings, because a session reading the files it was pointed at
  climbs steeply off its own baseline and *that is the fresh session*, mid-warm-up. Colour is two
  weights of `--warn` and never `--dead` or `--limit`: both of those already mean broken or stopped
  in this app, and an expensive session is neither.

  **The toast exists because the chip is not enough.** A chip is what you look at when you are
  already suspicious, and the measurement says the expensive sessions are exactly the ones nobody was
  suspicious of — they got there one ordinary turn at a time. So the step up is announced, once per
  session per level, only for the session on screen (a notice about a conversation you are not in is
  one you cannot act on), keyed in `waterplane.costNoticed` and deliberately not synced: it records that a
  toast appeared on *this* screen. A long afternoon in one session yields at most three of them.

  **The sheet's panel renders at every level, including "still cheap"** — unlike the row badge. On a
  row that sentence is furniture; on the screen somebody opened to find out, it is the answer. Its
  buttons are there because an argument with no door beside it is a lecture.

  **Two doors, and `/compact` leads.** The panel shipped with one — *new session in this repo* — and
  directly underneath it the compaction ledger was printing *you typed `/compact` · saved 77M ·
  $38.71 · cost 23k · $0.23*, i.e. **168× what it cost**, measured, on that very session. Two panels
  on one screen arguing opposite things, neither mentioning the other, and the one with the button
  was the one with no figure. They are not the same offer: `/compact` keeps the conversation and
  re-reads a summary of it, a fresh session keeps nothing — so the common case this screen is opened
  for (this work still needs what is already here) is answered by the first and not at all by the
  second. `/compact` is `.key.primary` and first; *new session in this repo* stays beside it; and the
  clause naming what each one keeps is `costDoorsText`'s, not the component's, for the reason every
  other sentence in this module is shared's.

  **The `/compact` button is withheld where `/compact` is not a word** — `sessionCan(subject,
  "slash")`, exactly [`headerCmds.ts`](#headercmdsts)'s bug, which was a `/compact` chip two rows
  above a strip saying this backend has no slash commands: tapped, it asked the binary in English to
  compact itself. Absent with its reason in text (`Unavailable`), never the dimmed twin of the live
  button beside it — and `costDoorsText(false)` is **null**, because a sentence naming a door that
  is not on the screen is the same lie in prose. It sends through `submitInput` on the outbox with an
  ackId, like `runHeaderCmd`, and it is aimed at the sheet's SUBJECT rather than the attached
  session: a launcher row's cost tile opens this graph without attaching, and `/compact` typed into
  the conversation behind the list is the one failure this button could have.

  **The total beside the reading — what the session has USED.** The chip answers *what does the next
  turn price at*; it could not answer *what has this cost so far*, and on a fan-out session those are
  not the same order of magnitude. Measured against one real session in this repo: the launcher row
  said **267k**, and the session had used **368M tokens — 355M of it in 19 subagents**. So the row's
  sparkline pair now carries a second figure behind a `Sigma` glyph, the terminal header says
  `· used 1.4M` on the same line as the context reading, and both are one wording
  (`usageText`): *This session has used 1.4M tokens so far — 900k of it in subagents.* Always "so
  far", because both halves are floors (a tail-capped log, an agent log that was cleaned up).

  Three rules it keeps. **Never a bare second number** — two figures in the same units meaning
  different things on one line is a readout nobody can use, hence the glyph and the word *used*.
  **The agent share is named only when there is one** — "0 of it in subagents" is a sentence about
  nothing. And **absent, never zero, never derived**: the host sends the total or it does not
  (`ContextSpark.usageTok`/`agentTok`, `ContextSeriesDoc` likewise), an older daemon simply shows the
  app as it was, and nothing on this side reconstructs a total out of `spentTok` — that figure leaves
  out the output side and every agent, which is exactly the plausible wrong number. The header's
  readout is gated with the rest of its button on `contextSeries` and **not** on `contextMeter`: this
  one is read off the conversation LOG, not the TUI gauge, so a backend with a readable record and no
  on-screen meter can still say what it spent. The host half is [host.md](host.md#ctxlogts).

  One derivation, two resolutions: `seriesCostFields` lives in `@waterplane/shared` and is called by the
  host filling a `ContextSpark` and by the sheet holding the full document. They must not each decide
  what a baseline is — `pts` is downsampled keeping each bucket's max and min in time order, so on a
  conversation that compacted early `pts[0]` is that bucket's *peak*, not the first turn. Reading the
  baseline there would inflate it and quietly understate every multiple in the app.
  `sessioncost.test.mjs`, `ctxlog.test.mjs`, `e2e-ctxgraph.mjs`.

  **The four readings are ONE tile on the row.** They arrived one at a time and ended up arranged by
  the order they were written rather than by what they say: the curve, the reading it ends at and the
  `Σ` total were right-aligned on the meta line, while the multiple — the one figure derived from the
  other three — wrapped onto the badge line at the far LEFT of the row, two lines and two edges away
  from them. Nothing was wrong with any of them; reading them together took two glances. They are now
  a single `.row-spark` group, `nowrap`, in the order the argument runs: **curve → reading → total →
  multiple**. The multiple goes last because it is the only chip on the line wearing a colour and the
  only one that is a judgement rather than a measurement, and the end of a right-aligned group is
  where nothing can read it as part of a number. It keeps its amber weights, tightened to the meta
  line's type so the group reads as one readout and not as a badge parked beside a chart. The
  terminal header groups the same four the same way, for the same reason.

  **`contextTag`'s percentage deliberately stays on the badge line.** It is the question
  `sessionCostPill`'s header separates out — how much window is LEFT, i.e. when the CLI will compact —
  and it is colour-coded like a status because it behaves like one. Folding it into the cost tile
  would put two readings of different questions in one group and leave the badge line saying nothing
  about the state of the session.

  **The spend chart — what it COST to get where the curve says it is.** `ContextSample` now carries
  `used`: the running total at the moment of each request, written by the same counter that produces
  `usageTok` (host `ctxlog.ts`) rather than folded out of the readings afterwards — a cumsum over
  `samples` would end a few percent below the total the same parse prints, and two totals that nearly
  agree is the most convincing wrong number this pair could produce. `contextPlot.ts` gets `USED`,
  `spendFacts`, `spendSummary` and `spendNote`; `ContextGraph.tsx` gets `SpendChart`; the sheet draws
  it under the context chart, on the same piecewise x axis, at half the height.

  Why a second chart and not a second line: the two series share a unit and nothing else. `tok` is a
  LEVEL and falls by two thirds at a compaction; `used` is a TOTAL and cannot fall at all. On one pair
  of axes the cumulative curve is a wall the sawtooth hides behind (they differ by orders of magnitude
  within an afternoon); on two y axes it is the dual-axis chart that makes any two quantities look
  correlated. Stacked, sharing only the time axis, a compaction becomes the instant one curve drops
  and the other does not — which is the whole claim. It wears the SAME series blue: "this
  conversation's tokens" on both charts, told apart by the shape, rather than a fifth hue the palette
  validator would have to clear again in two themes.

  **The subagent share is a grey band ON TOP of the curve.** The agents' logs are dated: host
  `agentCumOf` merges them into one running total (`agentCum`, last point = `agentTok`), and
  `agentSpendBand` stacks it on the parent's line, STEP-held at the agents' own timestamps, its top
  edge ending on the dashed grand total. An older host sends no `agentCum`, and then the GAP between
  the curve and the dashed line is the share, as before. The
  axis is fitted to include that line (`refs`), because on a fan-out session the share is most of the
  bill and an axis fitted to the curve would draw the total off the top of the chart. A total that
  comes back BELOW the curve is dropped rather than drawn under it. Three ticks, not five — at 110 px
  five labels sit on top of each other and of the dashed line. The values view carries the same figure
  per row (`… spent`), so nothing is gated behind the chart. `contextPlot.test.mjs`.

  **The same pair on a launcher row — two miniatures, and the row's text wrapped around them.**
  `ContextSpark` carries `usedPts` now: the cumulative spend at each of the same sixteen sampled
  readings, ~100 bytes more on a payload that rides every `SessionInfo`. It buys the one thing the
  `Σ` chip could never say — a session that spent 38M in a single fan-out turn and one that crept
  there over two days printed the identical figure, and the curve is the difference. `spendSparkGeom`
  is its geometry and `spendSparkTitle` its one sentence (`contextPlot.ts`, node-tested);
  `SpendSparkline` draws it; a host that sends no `usedPts` draws no second miniature and keeps the
  `Σ` chip beside the first, so an older daemon's rows are pixel-identical.

  **…and the chip beside that curve is MONEY, not a token count.** `Σ 38M` and `Σ 18M` sit next to
  each other on the launcher saying nothing about which conversation was the expensive one: the
  answer is the model each ran and how much of the traffic was cache reads at a tenth of the rate,
  neither of which is in the figure. `Σ $4.21` is the same fact with the arithmetic already done, and
  it is the ONE unit both screens speak — the all-sessions statistics screen has printed list-price
  dollars since it was written, and a launcher row that reported the same sessions in tokens made the
  two incomparable by construction. The tokens are not lost: they move into the title, and the curve
  is still drawn in them (a second y axis in dollars would be the same shape twice).

  The ladder is a fall-through and every rung is ABSENT rather than zero: `costChip(spark.costUsd) ??
  usageChip(spark.usageTok) ?? fmtTokensFine(g.end)`. A host one version behind, a backend that
  records no usage, or a model missing from the rate table each land on exactly the row that shipped
  before this existed — and a `$0` chip, which reads as "this was free", is unreachable. The same
  ladder runs in `ContextSparkline`'s fallback chip, so a row with a spend curve and a row without
  one never print the same session in two different units.

  **The figure is a counterfactual, and every surface says so.** `costText` (shared, one wording) is
  in both miniatures' titles and under the sheet's spend chart: what the API would have charged at
  published rates, priced per request on the model that ran it — not what anybody paid, and nothing
  to do with what a subscription costs. Tokens that ran on a model with no published rate are NAMED
  there rather than charged at zero, because that is the one way the number goes silently low. The
  sheet's headline leads with the same money and keeps the tokens immediately after
  (`$4.21 at list prices · 400k spent so far`): a sheet opened from a row that said `$4.21` and
  headed `400k spent` is two readings of one conversation with nothing to say which to believe.

  Its axis is the row's OWN, which is the opposite of the context miniature's whole argument and is
  said in the title. There is no ceiling to share: no model, plan or window states what a session may
  spend, and any constant picked here would draw nine rows in ten as a flat line on the floor. The
  magnitude is carried by the figure beside the curve, which has to be read anyway; the shape carries
  the pace. The subagent share stays a dashed reference above the curve's end, drawn only where there
  ARE agents — with none, the total IS the end of the curve and a dash lying on the end dot reads as a
  threshold nobody set — and a host total that comes back below the curve is dropped, the same guard
  `spendFacts` applies.

  **The two areas STACK, and the third chart is the fan-out.**

  The single curve answers *how much* and the composition strip at the foot of the sheet answers *of
  what* — but the strip answers it about the whole conversation at once, and the two questions people
  bring to this screen are *when did that change* and *what changed it*. A session that re-read a
  300k window eighty times and one that wrote a fresh 300k cache eighty times print an identical
  strip and were completely different afternoons; a session that moved from opus to sonnet half-way
  has a curve with no seam in it. Stacked, both are one look. `stackBands` is the geometry (over the
  sheet's own piecewise axis), `kindSeries`/`modelSeries` the two splits, and one chip row over the
  charts switches between them and `nothing` — three states, because the flat fill really is the best
  reading of a one-model session whose mix never moves, and a reader who wants the plain shape back
  should not have to work out which split is least busy. Synced (`waterplane.ctx.stack`): which reading you
  find useful is a property of the person, not of the device.

  Four rules, each a way a stack looks finished and is wrong:

  - **The line stays, and the stack's top edge IS it.** A reader who learnt the shape is not asked to
    learn a second one, and the bands reaching something other than the line is a chart disagreeing
    with itself in the one way nobody checks.
  - **The context chart stacks the three kinds that ARE context.** Output is not in the window until
    the turn after, so a stack containing it would not add up to the line it sits inside.
  - **The spend chart stacks the CUMULATIVE tuple** (`ContextSample.cum`), never a running sum of the
    per-request one: the series is thinned, and a client-side cumsum would end below the total
    printed above it.
  - **Bands come out in the palette's own order, bottom first, always** — and accumulated in VALUE
    space, converted once, so rounding cannot open a hairline between two bands that are meant to be
    touching. The same two rules `statsPlot.ts`'s `stacks` states.

  **Four validated slots and no fifth** (`TokenComposition.tsx`), and a model's slot is FIXED by
  its family for the whole app (`modelHue.ts`: opus 1, sonnet 2, haiku 3, fable 4; a second model of
  one family, a non-Claude model and an unattributed record fold into one GREY band, `REST_SLOT`).
  It used to go to the biggest models of the conversation, decided once per screen — which kept two
  charts on one screen agreeing but painted opus blue in a session it led and red in one where a
  sonnet fan-out out-spent it; a person reads colour across screens, so it is one table now. The
  reader's per-turn split is a DONUT beside the figures rather than a full-width bar row. A band
  with nothing in it is dropped and so is its legend entry: the table spans the conversation AND its
  agents, so a fan-out that ran opus workers under a sonnet parent would otherwise put an `opus-5 0
  0%` entry under a chart with no opus band on it (measured here). The *stack by model* chip is
  offered off the BANDS the charts will draw, never off the table, for the same reason.

  **The third chart is the subagents**, on that same axis: one bar per time bucket, height the number
  of agents STARTED in it, stacked by the model each ran. Bars rather than an area because this is a
  count of EVENTS — between two fan-outs there is no number of agents, there is nothing — and on the
  shared axis because "the bill stepped at 09:27" and "six agents started at 09:27" are one fact, and
  two charts on one axis is the only way to show it without the prose asserting the causation. A
  count, not a slice of tokens: a session that ran one agent for an hour and one that ran twenty for
  three minutes have the same `agentTok` and nothing else in common. An agent whose log carried no
  timestamp is in the totals and off this chart — it was spend, it is not a moment — and the section
  is not rendered at all for a session that never fanned out.

  **The tile FLOATS and the prompt runs around it.** It used to sit on the meta line above, pushed
  right by `margin-left: auto`, which spent a whole line of a phone screen on three short readouts and
  put the gist — the part you read to pick a row — one line further down. Now `.row-gist` is one block
  holding both, `.row-spark` floats right in it, and the readings occupy slack at the right of text
  that was never going to fill the width: a row with a two-word prompt came out SHORTER than before,
  not longer. The wrapper is a real block, not a flex child (`float` is ignored on flex items), and its
  `overflow: hidden` does two jobs — the BFC that contains the float, so a row with no gist is the
  height of the tile rather than letting it hang into the row below, and the clip for the clamp.
  `-webkit-line-clamp` was kept only after checking that a `-webkit-box`'s lines DO wrap around a
  float in this engine: they do, and the third line still ends in the ellipsis a height clamp cannot
  draw. The wash under both curves is a downward gradient rather than a flat fill, so the LINE stays
  what the eye lands on — one validated colour at two alphas, nothing new for the palette validator.

  **The multiple LEADS the tile.** It was last, under both curves, on the argument that the only
  coloured chip should sit where nothing can read it as part of a number. It is also the only reading
  in the tile that is a JUDGEMENT rather than a measurement — the one that answers "should this go in
  a fresh session", which is the decision the tile exists to inform — and at the bottom it read as a
  footnote to the figures instead of what they add up to. At the top it still cannot be misread as
  part of a number, because there is nothing above it.

  **The tile OPENS the chart it is a miniature of.** Four readings whose full picture is one sheet
  away sat inside the row's own `<button>`, so a tap on the curve opened the TERMINAL — the one screen
  that is not the numbers — and nothing on screen said why. It is a control now: `.row-spark` carries
  `role="button"` with the same stopPropagation PAIR the image badge on the badge line uses, the click
  and the `pointerdown` that arms the row drag (without the second, a press-and-hold on the tile drags
  the row it sits in). A real `<button>` is not available here and never will be — the row is one, and
  a nested one is invalid markup — which is why `ContextSparkline` still draws nothing interactive
  itself and the tap belongs to whoever composes the tile.

  The affordance is the tile's own EDGE — a hairline well — and not the dotted underline every other
  tappable readout in the launcher wears: that mark is for a line of text, and under a stack of two
  SVGs it draws a rule across the row. Not a `title` and not a cursor, for the reason the dimmed-button
  rule gives: neither exists on a phone. The press state is `:active` rather than a hover, because a
  touch screen's only moment to say "yes, that" is while the finger is down. The padding grows the
  FLOAT box, so the left margin drops by the 4px it adds and the gist wraps at the column it did before.

  **It opens the sheet for THAT session, and does not attach it.** `ContextSheet` reads its series by
  id over HTTP (`api.contextSeries`), so it never needed the session attached — it was scoped to
  `active` only because the session header's chip was the one door in. A second door needs a subject:
  `ctxSid` is it, null meaning "the attached one", which is what every existing caller means, cleared
  on close and by the header chip so the sheet can never re-open on a session you left. An id that no
  longer names a row — closed while the sheet was up, or a restored route carrying a stale one — falls
  back to the attached session rather than painting an empty sheet about nothing. Opening a row's
  numbers therefore spawns no PTY and leaves the list where it was; entering the conversation is the
  rest of the row, which is most of it.

### The session budget — a cap on one conversation, drawn and never decided here

*(Asked 2026-10-01; the decisions: [host.md](host.md#sessionbudgetts--a-sessions-own-budget). The verdict,
the calibration and every sentence are `shared/sessionbudget.ts`'s and the host's; the phone reads
`SessionInfo.budget` and draws it.)*

- **Spend is the session's own total**, subagents inside it, the figure the reply footer already
  prints. A percent unit is those dollars at the window's measured dollars-per-point, so it is an
  estimate and is worded "≈"; **unknown never trips and never holds** — `budget ? — <why>` on the chip,
  a sentence ending "nothing is held" in the sheet.
- **One chip, text not colour** (`core/sessions/tags.tsx` `budgetTag`, over `budgetTagFacts`): ok
  `$0.31 / $0.50`, over `budget hit · $0.52 / $0.50 · sends held`, unknown `budget ? — <why>`.
  A DOOR into the sheet (span + the stopPropagation pair, like `shellsTag`) in the header and on the
  launcher row; absent without a budget and on a session that is not running.
- **The queue holds the lane** (`core/queue`): `budgetHeldLaneSet` (shared's `sessionBudgetHeld`, the
  one predicate) feeds `selectSendable`'s `budgetHeldLanes`; an explicit armed send, an answer and an
  upload still go, and the over → ok edge flushes (`budgetReleased`, `busy → free`'s sibling). The
  reason a held row waits is `SendBlockReason` `sessionBudget`, in text on the row.
- **The field is one component** (`BudgetField.tsx` + `budgetInput.ts`, top-level because the Send
  sheet, the launch ask and the context panel are not the feature and may not import it): unit chips,
  a number, the interrupt switch, a refusal as a sentence. `parseBudgetInput` takes `500k`, `2m`,
  `$2`, `2,50`, `2%` and refuses everything else in words; **blank is no budget, not zero**.
- **At launch the cap rides the target** (`SendTarget.repo/repos.budget`), never `LaunchOpts`: a
  `budget…` chip in the Send sheet's *To* row, restated on the button (`· budget ≤ $2.00`), carried by
  `session.create`, `backlog.add`, `fanout.run`, `schedule.save` and `intent.post`. The launch ask
  starts on the caller's cap and its answer wins (`AskedBudget`: a cap, `null` = asked and none,
  `undefined` = nobody asked). **A re-time that changes a waiting row's cap is refused in words** —
  `IntentPatch` carries none, and dropping it silently is the one thing this app may not do.
- **The toast** is once per session per crossing, for the session on screen only (`shouldNoticeBudget`
  in `core/session/useCostNotices.ts`; leaving over re-arms). In memory on purpose: a reload that finds
  it still over is worth saying once more.
- **Not persisted as a route**: `sessionBudget`'s subject is held in memory (`sessionBudgetDoor.ts`).


### `TokenStatsSheet.tsx` — every token this desktop has used

> **Moved (2026-10):** the screen is the `token-stats` extension now, `packages/extensions/token-stats/web/` (split by region; layout in [token-stats-architecture.md](token-stats-architecture.md)). `statsPlot.ts`, `TokenComposition.tsx` and `useBoxWidth.ts` live in `packages/web/src/kit/chart/`. The rules below are unchanged; only the paths moved.

- `TokenStatsSheet.tsx` + `statsPlot.ts` — the statistics screen behind Settings → Usage, and the
  answer to "how much have I used, cumulative, across everything". Data is `host/tokenstats.ts`;
  the split is the usual one — `statsPlot.ts` is pure geometry (node-tested by `statsPlot.test.mjs`),
  the `.tsx` emits SVG, and every derived figure and its wording comes from `@waterplane/shared`'s
  `tokens.ts` rather than being re-invented here.

  **The control grammar is `ContextSheet.tsx`'s, stated there and obeyed here** — head is chrome,
  `show as · chart | values` is a labelled chip row in the body under an *In detail* heading (not
  *History*: the tiles under it are corpus KPIs and the model and repo bars are all-time, so only the
  four middle charts are history). The tokens/cost switch moved to the TOP of the list and gained the
  label `count in`: `money` decides the hero figure and the shading of the heat grids, both of which
  sat above the control that scoped them. `LimitWindows`' refresh carries the WORD *re-read*, because
  it wore the same `RefreshCw` glyph as the head's rescan while meaning something else, told apart
  only by a `title` — invisible on a phone. The range chips and `WeekNav` are built once as
  `rangeRow` and rendered in both halves; two copies of one control is how the two halves drift.

  **`res.inflight`, never `state === "loading"`.** Both sheets' refresh buttons spent a release
  claiming a running state they could never enter: `loading` is set only by the first read and by a
  NON-quiet `reload`, and every refresh in this app re-reads quietly or by moving the key, because
  blanking a document somebody is looking at to prove a request went out is worse than the wait. So
  the flag was false from the first paint onward — first as a `disabled` attribute that never
  disabled, then as a spinner that never spun. `useRemoteResource` exposes a real `inflight` now,
  counted rather than a boolean (a key change starts the next read before the cancelled one unwinds)
  and decremented in a `finally` even for an answer nobody wants any more. **A button that cannot
  tell whether it is running is the same defect whether it spends that on a spinner or on a grey.**

  **The table twin takes the WINDOW CUT** (`TableView`'s `cut`). The sentence under the scope chips
  says the cut reaches "down to the model bars", and until this it did not in the values view: that
  half printed the ALL-TIME model and repo lists under a live-window heading, while the chart half
  correctly refused *By repo* because an hour bucket carries the model and not the repo. One of the
  two was lying, and it was the twin — which is the half that exists so no fact is reachable only
  through a chart.

  **The thing the screen must not do** is show one enormous number and let it be read as money.
  13.6 billion tokens, 96% of them cache reads. So the hero never appears without the composition
  strip under it, and the caveat naming cache reads is a first-class part of the readout rather than
  a footnote.

  This screen shipped with **no prices anywhere**, on the grounds that cost depends on the plan, the
  model and the cache tier, and a dollar figure derived from a table in the client would be the most
  convincing wrong number on it. Two of those three turned out to be answerable from the logs — the
  model is on every turn and the cache tier is in the usage block — so the position moved rather than
  softened: compute it, and be precise about the one thing genuinely unknown by not claiming to know
  it. `shared/pricing.ts` is the table and the whole argument; the figure is a COUNTERFACTUAL (what
  the API would have charged) and every surface that prints it says so, an unknown model prices to
  null and is counted as unpriced rather than charged zero, and `PRICES_AS_OF` rides to the UI so a
  stale rate is visible instead of silently authoritative.

  **A cached rate table is a number that rots, and it did.** Sonnet 5 was carried as an
  *introductory* $2/$10 "until 2026-08-31" over a $3/$15 base; the published list has one rate for
  it and it is $2/$10, so from 1 September every sonnet reading on both screens was half again too
  dear until the table was re-read against claude.com/pricing#api (2026-09-19). Two more things came
  out of that read and are why `Rate` is not just a pair: **Fable 5.1 reads the cache at $0.25/MTok
  against a $10 input rate** — 0.025×, where every other model is the flat 0.1× rule — and since
  cache reads are 96% of this app's tokens, the rule alone makes its dominant line four times too
  big. So `PriceEntry.cacheRead` is an override read off the list, and the entries that HAVE no such
  line keep the rule. Fast mode is the deliberate gap: Opus 5 at `speed: "fast"` bills $10/$50 and
  the conversation log does not record which speed a turn ran at, so it prices at the standard rate
  — the conservative direction, and inside what "list-price estimate" already claims.

  Form by form, each picked for its data's job rather than for variety:

  - **Hero figure** for the one number the screen is for, proportional figures (at display size
    `tabular-nums` makes "13.6B" look loose).
  - **One 100%-wide composition strip** for the four kinds — the only honest way to show a
    96/3.4/0.2/0.007 split. `compose()` gives every non-zero kind a visible sliver and pays for it
    out of the segments that can afford it, keeping the TRUE percentage beside the distorted width;
    a part-to-whole that silently omits a part is not one. Segments are absolutely positioned rather
    than flexed, because flex rounds a 1.5% sliver away again.
  - **KPI tiles**, each a number plus what it is — turns, active days, cache hit rate, the subagent
    slice, the busiest day, output.
  - **Cumulative area** — the question that was actually asked. One series, so no legend box.
  - **Per-day columns** — deliberately NOT stacked by kind: 96% of every column would be one colour
    and the other three would be slivers pretending to be information.
  - **Horizontal bars** by model and by repo, because the categories are long names and rotating the
    layout beats rotating the labels. Scaled to the LARGEST row, never the total — with this tail,
    scaling to the total makes every bar but the first a stub and the chart compares nothing.
  - **A table twin**, so no value is reachable only through a crosshair.

  Two geometry decisions worth keeping: the day axis is **linear over the calendar**, the opposite of
  `contextPlot`'s piecewise one — there a long silence is dead time worth compressing, here a quiet
  fortnight is the fact being shown; and a column is **floored at a hairline**, because with a
  hundred days in a phone's width the slot is under two pixels and a column rounded to zero is a day
  that silently did not happen. The palette is the validated four-slot set on `--panel` (worst
  adjacent CVD ΔE 8.4, normal-vision 19.8, all four ≥3:1); at four series the skill's own ladder
  makes direct labels mandatory, which the legend's exact values supply.

  **The mix stacks by MODEL as well as by kind, and the repo bars always do.** One more chip beside
  the form switch, and it changes a reading rather than the data: "96% of this was cache reads" is a
  fact about the traffic and "two thirds of it was opus" is a fact about where the money went, and
  neither can be read off the other. In the SHARE view the by-model stack is the only chart a
  migration is visible in — two bands crossing over, which in a total is nothing at all. The series
  descriptor (`MixSeries`) grew a value ACCESSOR so `stacks`/`stackAreas` are one implementation over
  both splits and over the subagent counts; the readout and the legend under the chart follow the
  split, because a chart stacked by model under a legend naming token kinds is four correct bands
  wearing four wrong names, which is the kind of wrong that looks completely finished. The chip row
  SCROLLS rather than wraps: at three decisions the last chip dropped onto a line of its own and the
  divider that tells them apart landed at the wrap.

  **The by-repo bars are split by model, in both the token and the cost view.** The bar says usmc is
  42% of the tokens and cannot say why its share of the money is different, and the answer is never
  in the total — opus is 2.5× sonnet per token and 5× haiku. The segments are laid inside the bar's
  own length, so the bar still means what it meant and the split is a second reading laid over the
  first. Folded by ALIAS (`normalizeModel`), like every other model band in the app, so a dated
  snapshot is not a second model. One `ModelLegend`, shared by the day chart, the subagent chart and
  the bars, because they already share the slot assignment and a legend rebuilt per chart is how that
  guarantee gets quietly broken.

  **And a chart for the fan-out itself** (`AgentDayChart`): subagents started per day, stacked by
  model. Its own section rather than a fourth `dayView`, because its y axis counts WHOLE AGENTS while
  every other chart here counts tokens or dollars — a fourth view whose axis is neither would make
  the tokens/cost switch above it mean nothing on one of its states. Bars always, never an area: a
  count of events must not be interpolated across the days none started on.

  **The live windows sit above the history** (`LimitWindows`). The screen is now what every usage
  readout in the app leads to — the launcher topbar chip, the session header's inline `sess % · wk %`
  and (then) the oracle's chip in Settings all `setOverlay("tokens")` instead of firing a bare
  `usage.refresh`, which was a tap whose only visible effect was a toast. The reason the panel is
  first, and outside `Empty`: everything below it is history read out of the conversation logs — true,
  cumulative, and unable to say whether the next prompt will run — while these two percentages are the
  only thing on the screen with a clock on it, and a desktop with no logs at all must still answer
  *when do my limits reset*. Both windows are stated, each with its RESET INSTANT beside the number,
  for `usageTitle`'s reason: 90% of the five-hour window with ten minutes left is a coffee and the same
  number against a week resetting Thursday is a plan change. `resetWhen` names the weekday once the
  instant is not today or tomorrow — a bare `09:00` four days out is exactly the wrong-day mistake
  `host/usage.ts` refuses to make upstream — and a window whose reset the screen never named prints
  that sentence rather than a guessed day. A percentage that did not parse is an em dash. Opening on a
  reading older than the host's own cache TTL re-scrapes ONCE, quietly (nobody tapped, so nobody is
  owed a receipt); the head's button is the hand-tapped one and goes through `liveAsk`, which is what
  says the desktop could not be asked at all. Past 80% the bar and the figure take `--limit` — the one
  at-limit colour, never a fifth red.

  **A week is a window you STEP through, not a fourth filter chip.** The three ranges the screen
  shipped with — 30 days, 90 days, all time — all END AT TODAY, so every one of them answers *how
  much lately* and not one of them can answer *what did last week look like*, which is the question
  with the obvious shape: seven columns, Monday to Sunday. `week` is a fourth range whose extent
  comes from `weekAt` rather than from a day count, and `WeekNav` moves it. Everything it needs is
  already on the phone — the scan ships every active day — so nothing was added to the wire or to
  the host.

  Five rules, each of them a way the same screen could have been plausibly wrong:

  - **A week view FILLS its gaps** (`weekDays` returns seven entries, `present` saying which were
    measured), which is the exact opposite of the rule everywhere else in `statsPlot.ts`. Over three
    months a missing day is a gap because a quiet fortnight is the fact being shown; inside ONE week
    the seven columns ARE the axis, and a Wednesday that is not there is a day off — a reading, not
    an absence. So the per-day chart draws a faint slot behind every day and labels each with its
    weekday name, and an empty column is visibly empty rather than missing.
  - **A running total is only drawn over days that have HAPPENED.** The frame runs to Sunday whether
    or not the week is over, but carrying the cumulative line flat across Thursday to Sunday states
    that nothing was used on them, which is a claim about the future. It stops at today, and the
    summary says *so far* and compares itself to *the whole week before, with this one still
    running*.
  - **Every date walk goes through `Date#setDate`, never `+ 7 * DAY_MS`.** Adding a fixed number of
    milliseconds across a DST switch lands at 23:00 of the previous day, so the window would open an
    hour before Monday and swallow Sunday's last turns into the wrong week. `statsPlot.test.mjs`
    pins it on both switches.
  - **The arrows come and go rather than grey out**, `Unavailable.tsx`'s rule: an arrow with nowhere
    to go is not rendered at all and the note under the row says why, with the space held open so the
    label does not jump as you cross an edge. The bound is the DATA behind (past the first recorded
    day every further step is an empty week, which reads as a broken screen rather than as the end of
    the record) and THIS WEEK ahead — always reachable, because *nothing yet this week* is an answer
    and a Monday morning is when it is the true one.
  - **A change from a week that recorded nothing is ABSENT** (`weekDelta` → null), not infinity and
    not "+100%": a percentage change from zero is a division by zero with a face on it.

  Two smaller ones the static render caught. `weekLabel` goes through `Intl.DateTimeFormat`'s
  `formatRange`, which collapses the shared month in the reader's own order — building the range by
  hand printed `7 – Sep 13`, which is no locale's idea of a date. And the area chart draws a DOT when
  it has one point: a line with no length and an area with no width came out blank, on the Monday
  that is exactly when a week view gets opened. The week label always carries both the ISO number and
  the dates — "Week 37" alone needs a calendar on the desk, "8–14 Sep" alone cannot be said to
  someone who thinks in week numbers — and the note states that this is a CALENDAR week in the
  device's own zone, which is not the account's rolling week in the panel above it.

  **The live windows now have a history under them** (`UsageSpark`). A percentage with a clock on it
  answers *can I run something now*; it cannot answer *am I burning this faster than usual*, and
  that is the question a person asks about one second later. `host/usagelog.ts` keeps the readings
  the daemon already takes — nothing on this screen causes a scrape for the sake of a line — so the
  series is irregular by construction and everything here is built so that cannot be mistaken for a
  feed: past 45 minutes without a reading the line is CUT and the hole left visible, a window
  rollover cuts it too (the reset instant the screen named changed, so the drop is a new window and
  not usage coming back) and the break is drawn as a dashed rule, and a reading the screen did not
  print is dropped rather than plotted at 0%. The y axis is **fixed at 0–100**, never fitted to its
  own peak: a window 15% full and a window full look identical on a rescaled axis, which is the one
  confusion a limit gauge cannot afford. The burn rate and the "full around HH:MM" projection follow
  this file's rule for every heuristic and degrade to ABSENT — no rate without two readings twenty
  minutes apart inside the CURRENT window, and none when the figure fell. Fewer than two readings
  prints a sentence, because an empty chart box reads as a broken chart.

  **It stopped being a sparkline** (2026-09-24). Forty pixels of unlabelled shape was read as
  exactly what it was: *"these charts are not useful that way. I can't read anything, I have no
  tooltips, I don't know what the gaps mean"*. Three separate faults, and only one of them was size.
  The axis was fixed at 0–100 and said so nowhere, which is indistinguishable from a fitted one, so
  it is LABELLED now at floor, half and full; a strip a day wide had no time on it at all, so there
  is a time axis, with the weekday printed only where the axis crosses midnight (printed on every
  label, the first two ran together into one unreadable word on a 390px phone); and the only way to a
  past reading's figure is now the crosshair, whose answer is a text line UNDER the chart on
  `RepoHealthTiles.tsx`'s rules — always present so the gesture announces itself, keyed on the
  reading's own TIMESTAMP because this series grows at its end and an index survives that by
  accident, cleared on leave for a mouse only, and restored on `pointercancel` so scrolling past a
  chart does not silently pick a reading in it.

  **And the marks meant nothing because most of them were noise.** The rollover rule compared the
  scraped reset instant with `!==`. That instant is a wall-clock MINUTE off a TUI which the CLI
  recomputes as the window slides, so one window is scraped as `10:59` and then as `11:00` and back:
  the real log for 24 September holds dozens of those flips, each of which cut the line and drew a
  dashed rule at a window that never ended. A mark that fires on noise teaches its reader to ignore
  it, which is the state the screenshot caught. So the comparison has a tolerance (`RESET_EPS_MS`,
  three minutes — far above a minute of rounding, far below five hours or a week), and, because the
  tolerance alone then MISSED every real rollover — the reading taken as a window rolls is `0%` with
  no reset named, there being no window in force to name, so the instants either side are only ever
  compared against an unknown — there is a second signal that needs no reset at all: inside one
  window the count only goes up, so a fall past `DROP_EPS_PCT` IS a new window. The drop is where the
  cut belongs anyway, and the segment forgets the old instant as it starts, or the first reading to
  finally name the new window would cut the line a second time. `usageMarksText` then names each mark
  ONLY on a chart that drew it: a sentence about a dashed rule where there is none sends a reader
  hunting for it.

  **The projection answers in whichever unit the window HAS an answer in** (`usageOutlook`). It used
  to be one branch: a time when the window filled before its reset, silence otherwise, on the
  argument that "full in 117 hours" about a five-hour window would alarm for no reason. True of the
  date — and it left the ordinary case, the one where the honest answer is *this window sees itself
  out*, with nothing on screen at all, which reads as a projection that could not be made. The other
  branch is a LEVEL: *on track for ~13% by the reset at that rate*. Same arithmetic, so neither half
  is more of a guess than the other, and the absences are unchanged plus one: a reading whose reset
  has already passed describes a window that ENDED and nothing may be projected from it, which is the
  rule `budget.ts` keeps about the same reading. The instant, where there is one, goes through
  `resetWhen` and never a bare wall-clock time — the weekly window's projection lands days out, and
  `15:25` for tomorrow is exactly the wrong-day reading the parse refuses to make upstream — and it
  carries the distance beside it, because a date only becomes an answer once the reader has done the
  subtraction. The read is uncached on purpose: a stale sparkline under a live
  percentage is two different instants drawn as one reading.

  **Three more time series, each answering something the first two cannot.**

  - **`mix` and `share` on the per-day chart.** The per-day columns are one series because 96% of
    every column is cache reads — that argument is about HEIGHT, and it still holds for `mix`, the
    absolute stack, which is kept beside the others with its sliver problem STATED rather than
    floor-inflated (a chart whose subject is proportion must not distort one). `share` rescales every
    column to 100% and stops being about volume at all, which is the only reading on the screen that
    can move while the total does not: cache writes climbing 3% → 12% is a week the session shape
    changed, and in the cost view that is the biggest lever there is — 3% of the tokens, 38% of the
    money. Bands keep the kinds' own order in every column, because across columns is the only
    direction anyone reads a stack. The chips live ON the section header they scope, never in the
    range row above, which scopes something else.
  - **The 7-day mean** over the per-day columns, dashed and thinner so it reads as a reading OF the
    data rather than a second series. Two rules: it is a mean over CALENDAR days, not over points —
    with weekends missing, a seven-POINT mean averages nine real days in one place and seven in
    another and nothing says which — and it is computed over the WHOLE day series then clipped to the
    window, so the line entering from the left edge carries the real average of the week before
    instead of ramping up out of the left margin. It starts seven days into the record and is absent
    before that: a partial window divided by a full one draws a trend that is an artefact of the
    edge.
  - **Per hour, and the clock face.** `host/tokenstats.ts` buckets by hour now (the day is the hour
    key's first ten characters, so the fold cannot disagree), which makes a burst at 14:00 visible
    for the first time. The intraday chart is the SAME chart an hour at a time — `makeDayPlot` takes
    a `stepMs` rather than a second module existing, because two time axes is two ways of rounding
    one. The clock face is deliberately NOT that axis: `clockColumns` is categorical, every slot the
    same width, because hour 23 sits beside hour 0 of the next day on a time axis and beside hour 22
    on a clock. All 24 slots are drawn including the empty ones — *I have never once started before
    9* is a reading, and it only exists if the hours nobody worked are visible as hours nobody
    worked. The host ships hours for a bounded recent window only and `hoursFrom` states where it
    begins, so the chart says what it cannot show rather than drawing a fortnight as the whole
    record.

  **Whether 96% cache reads is good** is the question the composition strip provokes and could not
  answer (`cacheReading` in `shared/tokens.ts`, drawn by `CacheVerdict`). A reader who sees one kind
  at 96% of the tokens and 55% of the money is asking one of two different questions — *is the cache
  carrying everything* or *is the same bloated conversation being re-read for ever* — and the share
  cannot tell them apart, so it is never asked to: a cache read bills at a tenth of the input rate,
  so a high share is the CHEAP shape of the same traffic and the only way to lower it is to re-send
  that context at full price. There is no number of cache reads that is too many in itself. Two
  ratios under it do carry a verdict, both arithmetic over counts already on the wire. **Reuse** —
  reads per written token — against what a write must earn back, which is derived from the tier mix
  actually written (`mult / (1 - CACHE_READ_MULT)`: ~1.4 reads at the 5-minute rate, ~2.2 at the
  1-hour one) rather than picked; below it the caching is losing against simply sending the tokens
  fresh, and that is sessions ending before their prefix is read back, a different failure from a
  window that is too big and worded as one. And **context per turn**, which is the pollution number:
  the measurement in `sessioncost.ts`'s header found the conversations past ~200k carrying 76% of
  every token on this desktop, so what makes a turn expensive is the size of the window and not the
  share of it served from cache. The mean is always said to be a mean — that distribution was 1.4% of
  conversations holding 76% of the tokens, and a reader who takes 190k for "my turns are 190k" has
  read a ceiling off an average; `sessionCost` is the per-conversation reading and the only one that
  can name a monster. Sentences and never a gate, same as everything else derived from this data.

  `TokenStatsBody` is exported apart from the read, so the charts can be rendered to a static page
  and looked at — the dataviz procedure's last step, and the only one that caught the "15000M" axis,
  the `Other (1 models)` label, the hand-built date range and the blank one-point area. It takes
  `initialRange` for that render alone, since a static page cannot tap a filter chip and an unviewed
  chart is an unchecked one. Cached in IndexedDB (`tokenstats`, v11) and seeded first, because
  a cold rebuild on the host is seconds and a dead link should still show the last figures with their
  age on them. [host.md](host.md#tokenstatsts) has the scanner.

  **The two time series can be drawn as areas** (`fillSeries` / `fillMix` / `areaRuns` /
  `stackAreas`, the `bars`/`area` chips on *Per day* and *Per hour*). Columns are the exact form —
  one bucket, one mark — and they are right while a column still has a width. They stop having one
  quickly: at `all time` on a phone a day's slot is under two pixels and an hour's is a twentieth of
  that, so a per-day chart is already a picket fence and the per-hour one is a grey band with spikes
  in it. A stacked bar chart at two pixels a bar IS an area chart drawn badly — the eye reads the
  envelope either way and the gaps between the bars are noise it has to read through — so the area
  is the same reading in the form the data has already taken, and the `total`/`mix`/`share` chips
  keep saying WHICH reading it is. The two controls are deliberately separate: form and question are
  different decisions, and switching from `share` back to `mix` must not silently change the shape.

  What makes it drawable at all is that **this is the one series on the screen whose holes are
  zeros.** Everywhere else in `statsPlot.ts` a gap is cut and left visible — `usageSegments` will not
  join two readings across an hour nobody observed, and the day axis keeps a quiet fortnight a
  fortnight wide — because those holes are unmeasured. The day and hour series are the opposite
  case: the scan walks every conversation log on the desktop, so a day missing from `days` is a day
  with no turns in it, which is a measurement. `fillSeries` draws those buckets in as zeros, between
  the first and last point and never beyond, and the band sits on the floor they make. Unfilled, the
  same area slopes gently across a fortnight off as if the work had tapered — the one lie an area
  chart tells that a column chart cannot.

  Three rules fall out of that, each pinned in `statsPlot.test.mjs`:

  - **The normalized stack is CUT at an empty bucket** (`areaRuns`). A day with no tokens has no mix
    to rescale, and stretching 100% of nothing across the gap would invent a split and hold it
    steady. The absolute stack joins everything, zeros included, because there the zero is the
    floor and the floor is the reading.
  - **A run of one bucket is widened to its slot.** An area through a single point has no width and
    renders as nothing — the same blank-on-a-Monday the cumulative chart's dot already fixed.
  - **A window too wide to fill is NULL, and the *area* chip is then ABSENT rather than dimmed**
    (`Unavailable.tsx`'s rule), with the sentence under the chart saying why. Half a filled series
    is a chart whose right-hand end quietly means something else.

  The day walk goes through `Date#setDate` for the week code's reason, and the hour comparison
  carries half a step of slack so a DST switch cannot drop the last bucket of the day. Bands keep
  `TOKEN_KINDS` order bottom-first so a colour holds its place across the whole width, and nothing
  is floor-inflated: at this scale the three small kinds are hairlines, which is the honest picture
  of a 96/3/0.2 split and the reason `share` exists beside `mix`.

### `WeekCard.tsx` + `RepoHourChart.tsx` + `weekBands.ts` — where the week went

`extensions/token-stats/web/`. Added 2026-10-09 after a weekly figure of 32% thirteen hours past its
reset that the screen could not explain (about $470 at list price: one ~36-repo architect-review
fan-out ≈48%, two garmin-monorepo sessions ≈41%, subagents 73%). Host half:
[host.md](host.md#costwindowts); wire `shared/wire/costwindow.ts`.

- **The cost view opens on the week since the reset** (all time when that cannot be cut), and the
  Totals box's "By repo" follows ANY window: it is the host's cost window over the cut's span, ranked
  by `rankRepos`, where it used to refuse under a live window. While the read is out, offline, or
  answered 404 by an older host, one sentence says which. The body reads the week's window ONCE
  (`weekcost:`) and the card, the repo split and the points all use that document; the usage-log read
  moved up from `LimitWindows` into the body so the limit charts and the calibration read one log.
- **`weekCut` is the one bucketing function** (`shared/costwindow.ts`): the figure on an hour and
  the list that hour opens are the same predicate over `CostConvo.byHour`, so the count and the cut
  cannot drift (a count on a control is a filter). The list says "n of N" and has a clear button.
  Rows group by repo or by launch (`foldLaunches`: a fan-out is ONE row), each expanding to its
  sessions with title, money, points, subagent share and `agentModelInsight`'s sentence.
- **Repo colours are identity, not rank.** `repoSlots` gives the top four repos the four validated
  hues (`SLOT`, never a generated fifth) and a repo that still qualifies KEEPS its slot when another
  overtakes it, so a colour does not hop between two repos on a re-read; the rest is one grey
  "other repos" band.
- **The percentage axis is fixed and labelled 0 to 100.** An unlabelled fixed axis reads as a fitted
  one. The line goes through `usageSegments` (the kit rule, now `shared/burn.ts`), so it is cut at
  every rollover and gap, never joined; the x domain is the week's own, so an hour nothing ran in is a
  gap and not a zero bar.
- **Points are one calibration per screen** (`ptsCalibration`, made in the body from the week's
  readings against its ledger). It REFUSES, in its own sentence per reason, when it has too few
  readings, stretches under 6 h or a climb under 5 points, when stretches disagree past 35%, or when
  it disagrees past 40% with the per-reading level calibration (`weekUsdPerPct`), so the two estimates
  can never print different point figures beside one dollar figure.
- **The demo answers `/api/costwindow`** by folding the SAME synthetic records as its ledger
  (`demo/host/ledger.ts` `demoCostWindow`), so a week is a cut of the fortnight; it skips the cap
  (no `rest`), launches and live rows. **Known gap**: a window's cut starts on the hour NEAREST its reset
  (`windowStartHour`), so a 5-hour live window can read up to 10% wide or narrow, said in words.
- **The fan-out hint** (`features/fanout/FanoutCostHint.tsx`, words in `logic.ts`'s `fanoutCostWords`):
  one sentence above Run, "last similar run (36 repos): $218.00, 66% subagents". `pickSimilarRun`
  (same prompt first, else the latest finished) then the cost window over that run's span, folded by
  launch with the run's id. Words only, never a gate; absent offline, on an older host or when the
  run's sessions are not in the logs. The "of week" clause is left out: the rate lives in
  `features/tokens` and `local/feature-boundary` forbids one feature importing another, and an absent
  clause beats a duplicated rate.

### `TokenInsights.tsx` + `statsInsights.ts` — the boxes, the findings, the dearest conversations

**One span, 2026-10-15 (R-usage-025, `span.ts`).** The boxes below fixed which control moved which
chart, and still left about eight time frames on one screen: a fixed seven-day headline, Totals'
live-window chips, Over time's calendar chips and calendar-week stepper, a 7-vs-7 per-request table,
an all-time costliest list and clock. Each was honest; together they could not be read against each
other, and the owner said so. Now one sticky bar picks the span for EVERY box — a live window
(stepped back by Totals' stepper and the heat grids), calendar days (calendar, not the last n
active rows, which the old slice was), or all time — and the boxes keep their borders and lose their
chips. The limit bars and the week's hour chart are the one exception, compact above the bar:
they are always now. Where a section cannot be cut (the hour record starts later, the host folds
repos over at most 35 days, insights are corpus findings), it says so instead of quietly showing all
time under the span's name. The calendar week stepper is gone from the phone; the VS Code panel
keeps its own chips through `OverTimeCard`'s `chips`/`lead`.

The paragraphs below are the history that led here.

**Why the screen is boxes now.** The all-sessions screen was one long list, and each chip row
scoped "everything below it until something else" — the live-window chips sat under the hero and
moved the hero, the tiles and the model bars but not the charts between them; the calendar chips sat
under *Cumulative* and moved three charts and a fourth only in week mode; the per-hour chart said in
a caption that the chips above did not narrow it. Which data a chip moved had to be learned by
tapping it, and that was the complaint. So a filter is now the HEAD of a bordered box
(`ScopeCard`) and everything it changes is inside the border: **Totals** (live-window chips → hero,
split, verdict, tiles, by model, by repo, and the past-window heat grids, whose tap is the same
scope) and **Over time** (calendar chips → cumulative, per day, subagents, per hour — the hours now
follow the chips). Every section repeats its span in its own head (`ScopeTag`), and the sections no
filter touches say *all time · no filter*. The two switches that reach everything — `count in` and
`show as` — are one sticky row above all of it. The values view is split the same way
(`TableView`'s `part`), so switching form never moves a table out of the box whose chips scope it.

**The charts were 24px too wide.** `useBoxWidth` measured `clientWidth`, which includes the
`.ctx-box` padding, so every chart overflowed its box and lost its right edge (the newest days —
the part anybody opens the screen to read). It measures the content box now. The screen opens on
*30 days*: all time drew four months of which the first two-thirds were an empty baseline.

**Insights** (`statsInsights.ts`, pure, `statsInsights.test.mjs`): a finding is a measured sentence
plus a *Try:* line, in lever order — cache writes' share of money against their share of tokens,
the premium paid re-caching after breaks, the subagents' share, how concentrated the spend is in the
top conversations, per-REQUEST cost against the week before (volume follows how much you worked;
the price of a request is what a habit moves), and the model whose money outruns its tokens. Each
is ABSENT unless measurable and above a floor; nothing applies itself.

**Costliest conversations** come from host `tokenstats.ts`'s `top`: each top-level log with its
`subagents/` transcripts folded in (the agents are the conversation's spend — one measured session
held 271k in its window and spent 355M in 19 agents), ranked by money, drawn in money whatever the
metric (a "costliest" list printing token counts that do not descend reads as a sorting bug), five
then *show all*. Each row offers *explain the cost* — `explainCost.ts`'s prompt, the same one the
context sheet's door sends, in a new session in that repo that measures the log and implements
nothing — and *context & cost* only when a live session holds that conversation id. The same pass
fixed the by-repo list: agent worktrees (`<repo>/.claude/worktrees/<name>`) had been counted as repos
named `agent-<id>`; `repoOfWorktree` folds them into their repo.

### `PerRequestSection.tsx` + `perRequest.ts` — what one request costs, over time and by repo

The *a request costs n% less than the week before* insight compared two numbers; asked for as a
series, it is a section in the **Over time** box (so the calendar chips scope it) with the same
rows in the values half. The host adds `TokenDay.byRepo` — requests, PRICED requests and dollars per
repo per day — off the cross key the aggregate already reads, so no rescan; it is deliberately not a
`TokenTotals` per repo, because day × repo × four kinds multiplies the document for a question that
is only ever a ratio.

- **A ratio of sums, never a mean of ratios.** Each point is the trailing 7 CALENDAR days' dollars
  over their requests. A day of three requests at $2 beside a day of three hundred at $0.05 averages
  to a price nothing had.
- **Cut, never joined**, where a window holds under `PER_REQ_MIN` (20) priced requests, and nothing
  before a whole week lies inside the record — a price off a handful is a wrong number, not a noisy
  one. Rolled over the whole record, clipped to the window afterwards (the day chart's mean rule).
- **Unpriced requests leave the denominator** (a model with no rate would read as a cheap one) and
  are COUNTED in a sentence.
- **By repo**: last 7 days, the 7 before, change, all time; ordered by this week's money. A dash is a
  week under the floor; a repo that never reached it is not listed and is counted. A row is a
  BUTTON that draws that repo's line beside the total in the second validated slot — one at a time,
  so the chart never needs a fifth colour. Eight rows, then *show all*; a drawn repo is never hidden.
- The axis is plotted in tenths of a cent and labelled in dollars: `yScale` steps in whole units.
- The file is `PerRequestSection.tsx`, not `PerRequest.tsx`: on a case-insensitive disk that
  collides with `perRequest.ts` and tsc refuses the pair.

### `usageCut.ts` — what "50% used" is 50% of

`LimitWindows` leads this screen with two percentages and a clock. They are the only numbers on it
that can say whether a prompt sent in the next minute will run, and neither of them can say what it
is a percentage OF: how many tokens went into the window, which models carried them, what the same
traffic would have cost at list prices. Every one of those answers was already on the screen, six
scroll-lengths below, **for all time** — 18.3B tokens and $15.52 since May, against a five-hour
window at 1%. The two readings never met.

So the live windows became a SCOPE for the readouts: hero, composition strip, cache verdict, tiles
and the by-model bars restate for the window, and one chip takes you back to all time.

**Two scope controls now, deliberately.** The existing `RANGES` row scopes the two TIME CHARTS and
is left exactly as it was: those are calendar windows ending at today, and the totals above them
stay all-time because "cumulative over all sessions" is the point. The new row under the hero is
the other kind of window entirely — a rolling five hours, and a week that resets on a Thursday
evening. Two decisions, two controls, each labelled with what it moves; folding them into one chip
row would mean six chips of which two rewrote the hero and four did not.

**Why the HOURS.** Neither window is a calendar day, so `TokenDay` cannot express either. `TokenHour`
can: the host keeps a bounded recent record of them (`hoursFrom`, 14 days), each with a cost — and
now with a model split, which is the one field this change added to the wire. It is the same
`hour × model` cross the host already computes to price anything at all, so it is a projection and
not a second pass.

**The edge is MOVED and NAMED, never fudged.** An hour bucket is the finest thing on record, so a
window that opened at 01:59 cannot be cut at 01:59. Rounding the edge either way produces a number
that is approximately right about the window and silent about it — on a five-hour window the edge
bucket is up to a fifth of the whole span. Instead the cut starts at the TOP of the hour the window
opened in and `cutSpan` says so in the sentence under the chips: *"the window itself opened at
01:59; the finest bucket on record is an hour, so the cut starts at the top of that hour and covers
59 minutes more than the window."* Exact about a span it states, rather than approximate about a
span it names.

**Three refusals, three sentences, and never a zero** (`cutRefusalText`):

- **no reset instant** — the `/usage` screen did not name one, so there is no instant to count from;
- **rolled** — the last reading's reset is in the past, so the window it described is not the one
  running. This is the dangerous case, because the scrape is real and its numbers are real and the
  five hours it describes are the *previous* five. A cut taken from it would be a confident answer
  about the wrong window;
- **short** — the hour record does not reach back to the start of the window, worded apart from "no
  hourly detail at all", which is the same field saying something different.

A window that cannot be cut has **no chip** — the reason is a sentence in the limit block above, and
a dead chip is the greyed control this app does not draw.

**What the cut cannot answer, it says so about.** An hour bucket carries which model ran in it and
not which repo, and it holds no conversation to count. So under a window *By repo* is ABSENT with
its reason and a pointer back to **All time** rather than an all-time list sitting under a window
heading; the hero counts TURNS where all-time counts conversations; and the unpriced-tokens and
fast-mode caveats — both whole-corpus measurements — are withheld rather than restated about a span
nobody measured them over. `modelSplit` false (an older host) is a sentence too, and **one EMPTY
split inside the cut is a quiet hour, not an old daemon** — the test is that SOME hour carries the
field.

`WindowTiles` is its own four tiles rather than `Tiles` with a filter: four of those six — active
days, busiest day, dearest day, per-active-day, the subagent slice — are facts about the corpus, and
a row keeping them under a five-hour heading would be six numbers of which four were about something
else. *Hours counted* replaces them, because 3 of 5 hours at 1% and 5 of 5 at 1% are a quiet morning
and a quiet window.

**One `windowCut` call feeds both surfaces.** The line under each limit bar (`WindowUsed`) and the
cut the chip takes come from the same map computed once in the body, with `Date.now()` read once
inside it so both windows are tested against one instant. That line is a full-width BUTTON — a
figure on a control is a filter, so tapping *9.1B tokens* scopes the readouts to exactly those
tokens instead of leaving the reader to re-derive them. Its lit state is a tint and an accent left
edge rather than `.key.active`'s accent fill: it is a sentence-wide line of running text, and a
solid fill behind one reads as a banner rather than as a control that is on.

### The windows BEFORE this one — two grids, one box per window

The scope above answers "what is in the window running now". The obvious next question — *was that a
lot?* — had no answer anywhere on the screen: 3% of a five-hour window is a number with nothing to
compare it against, and the only history either window had was `UsageSpark`, a 24-hour strip of
SCRAPED PERCENTAGES that says nothing about tokens, money or models.

So every past window is now a box, shaded by what went through it, in two grids: one per window
kind. Tapping a box scopes every readout above to that window — the same `{id, back}` the stepper
beside the chips writes, so there is exactly one idea on this screen of what is selected.

**Why the host folds them.** `TokenStatsDoc` ships a bounded fortnight of hour buckets, because the
hours are ~24× the rows of the days and a phone caches the whole document. That is enough to cut the
window running now and nothing older — a weekly window from July is four months back in a record the
wire does not carry. The store, though, keeps every hour it ever saw. So `GET /api/tokenwindows`
folds on that side and sends one small row per window that had anything in it: measured on this
desktop, 103 KB and 26 ms warm for 117 five-hour windows and 8 weeks, against the megabytes shipping
the buckets would have cost.

**The grid is the phone's, and it goes UP.** `anchor` is the reset instant off `/usage` and `lenMs`
is `LIVE_WINDOWS`', so the two windows' semantics stay in the one table at the top of `usageCut.ts`
and the host asserts nothing about what it is folding — it answers "fold these hours into this
grid". The instants are not carried per row either: cell `k` is
`[anchor − (k+1)·lenMs, anchor − k·lenMs)`, derived on both ends, so a row cannot disagree with the
grid it is in.

**The hour rule is shared, not re-decided.** Every window edge — the live cut, each grid cell, the
week card's and the Totals box's `/api/costwindow` `from` — is `windowStartHour` (shared
`costwindow.ts`): the hour boundary NEAREST the instant, so a cell is
`[windowStartHour(opened), windowStartHour(reset))` — exactly what `cutSpan` states on screen for the
live window — and neighbours tile, every hour in one box. It used to be the FLOOR of the opening
hour, which put that hour in two cells and, measured, 59 minutes of last week into a week resetting
Thu 18:59: the week card read $512 ≈ 39 pts against a 35% meter, the extra hour ≈ 4 pts. Rounding
bounds the error at 30 minutes either way, and the sentence says which way (`leadClause`: the first
hour counted whole, or the first minutes left out). Giving the grid a rule of its own would have made
cell 0 and the line under the limit bar two different numbers about the same five hours, which is
the one failure this screen cannot have.

**Only windows that RAN something are sent.** A window with no row ran nothing, which is a reading
and is drawn as a real empty box; a window the record does not reach back to is UNKNOWN and is drawn
as an outline with no fill. `oldestHour` is what tells them apart, and the grid ENDS at the record
rather than drawing unknown boxes back to the epoch. Measured here: 563 five-hour boxes of which 446
ran nothing — which is itself the answer to a question nobody could ask before.

**Each grid carries its own scale.** A weekly window holds about thirty-four five-hour ones, so a
shared maximum would paint every five-hour box at the bottom of the ramp. Each legend names its own
busiest box. The ramp is square-rooted (`heatFrac`) because the distribution is what it is — one
all-nighter is twenty times a quiet window, and on a linear ramp that single box is the only one
with any colour in it — and the caption says the scale is not linear rather than leaving a reader to
infer proportions that are not there. `heatStep` never draws a real reading as the empty box: one
token is step 1, not step 0.

**The ramp is one hue at five alphas, from `--accent-rgb`.** A sequential scale is one hue light to
dark; the four validated `--chart-*` slots mean IDENTITY and would read as four kinds of window.
Every value is a token, so the light theme re-picks the hue with everything else (`#4c9aff` in dark,
`#1564cc` in light) instead of being the dark ramp on white.

**Both ends of the stepper are sentences.** At `back: 0` there is nothing newer because it has not
happened; past the record there is nothing older because nobody has a ledger for it. Two different
facts, and a greyed arrow states neither — `Unavailable.tsx`'s rule. The stepper reads how far back
the record goes off the SAME grid the boxes are drawn from, so it can never offer a window the
heatmap does not draw.

**A past window is the same `WindowCut`**, so every readout under it is drawn by the components that
were already there. Two sentences had to learn the difference: `cutSpan` counts to the window's own
reset rather than "to now", and the tiles swap *Resets in* for *Ran until* and *Hours counted* — a
tile this side cannot fill for a window the host folded — for *Ran … for 7 days*. A host too old to
know the route answers nothing, `grids` is empty, and the screen is pixel-identical to what it was.

### The launcher list

- **The launcher is ONE list** (`repoGroups`, from `repoGroupsOf` in `core/launcher/model.ts`): a repo group header per repo, whether or
  not it has a live session, its sessions under it and its worktrees as start-point rows. There used
  to be a second section below the recent lists — "Repos & worktrees" — and between them a repo's
  verbs were split by an accident: the group header carried files/new/focus/build, the repo row
  carried camera/first-prompt/branch/hide, and WHICH half you were offered depended on whether that
  repo happened to have a session open, so closing the last session moved half a repo's affordances
  a screenful down the page under two lists whose length nobody controls — and the same repo drew
  two headers, two accents, two counts. Order is sessions-first in the live list's own order (the
  drag order owns it), then the remaining repos alphabetically; a status filter drops the sessionless
  repos, since a repo with nothing running cannot be "waiting".
- **A session row is titled by what it is ABOUT, not by `main`.** The row's first line used to be
  the branch — the repo is on the header above it, so the branch is the part the header lacks. On a
  desktop where every primary sits on `main` that made the first word of every row the same word,
  and it was the widest thing on the line: the derived name, the status tags and the age were what
  got pushed off the end. Now the branch is `shared/naming.ts`'s `branchLabel` — absent when it is
  git's own default AND the target is the primary worktree — and the space it frees goes to
  `SessionInfo.tabTitle`, the desktop's own ≤4-word name for the conversation (`.row-name`, muted
  and lighter than `.row-title`, `Sparkles`-marked because it is a machine's reading and not a name
  anybody typed). A row is never left blank: no branch and no derived name falls back to the repo.
  The name is CLIPPED here and wraps only in the session header — a list is scanned, a header is
  read. **A worktree keeps its branch even when it is called `main`**, because there its branch is
  the only thing telling it from its siblings, and `GitView`/`BranchPicker` keep theirs because a
  branch is the subject of those screens rather than a label on them. Titles already PERSISTED as
  `usmc · main` lose the word at draw time (`trimDefaultBranch`, in the session header, the reopen
  rows and `tabLabel`) — no stored title is rewritten, least of all one somebody typed.
- **The group header is DOCKED** (`position: sticky; top: 0` on `.repo-group`, `.list` being the
  scroller). A repo with twelve sessions is taller than the screen, and scrolling into its rows
  scrolled its name off the top — after which every row is titled by its own BRANCH, so three
  `main · done · 3h ago` lines in a row say nothing about which repo you are reading. The header
  stays until the next repo's header pushes it out, which is also what makes the left stripe do its
  job: the stripe means "same repo as the header", and that only reads while the header is on
  screen. Two background layers, not one — the single `transparent 70%` gradient let row text show
  straight through a pinned header, so the `--bg` it always sat on is now stated as the base layer
  under it, and a 1px `--line` bottom rule keeps the pinned header from reading as one block with
  the first row. Sticky, never fixed: fixed would outlive the launcher on every other screen.
  `.repo-group.idle` is put back to `static` — it has no rows under it to keep a name above, and
  `background: none` (deliberate, the tint is for a group that has rows) would pin it transparent.
- **What fits beside a name.** Header acts are files, untracked, `+`, **build** and close-all, with
  camera / first-prompt / focus / branch / hide behind `⋯`. Seven always-on 42px buttons need ~300px
  of a 390px row: the strip broke onto a line of its own under every header and each repo came out
  three lines tall. Build stays out front — it is the rate-limit escape hatch, the thing you reach
  for when a session cannot run, and it may not be a tap deeper. The buttons are 38px for the same
  arithmetic.
- **A repo with nothing running is ONE ROW** (`.repo-group.idle`): same markup, same accent, same
  verbs, but the chips come back onto the name line (`order`, not `flex-basis: 100%`), the tinted
  band is dropped (it is for a group that HAS rows under it) and the row carries its own divider,
  since a run of idle repos has no session rows between them. Given the full header treatment,
  sixteen idle repos were a wall in which the repo with twelve sessions read exactly like the
  fourteen with none. The chevron becomes an aligned `.repo-group-nub` — which is a `<span>`, so
  `.repo-group-toggle > span:first-of-type` (written for the NAME, since the chevron beside it is an
  `<svg>`) landed on the nub and started every idle name 98px into its own header until the nub
  claimed that selector back.
- **The local/external switch lives in the menu.** It used to be a full-width segmented bar directly
  under the topbar: two 46px buttons plus their padding, ~62px of permanent vertical space on every
  launcher paint, for a choice almost nobody makes twice a week — and on a phone that was the
  difference between the first repo group being on screen and being below the fold. It is a VIEW
  selector, so it sits with the other nine view entries behind `menu` (`.more-act`, the active one
  marked `.more-act.on`, both carrying their counts). What has to stay visible is not the choice but
  which side of it you are ON, because `external` is the one launcher state that shows none of your
  repos and "everything vanished" must not be the only clue: the closed menu button grows a
  `.nav-tab` chip for the non-default tab, and the external list's head carries a `.tab-back` pill,
  so leaving does not mean finding the menu again. The connection readout that sat above it went at
  the same time — a permanent green `open · 100.x.y.z` restating what the net-pulse strip shows live
  and what `conn-banner` says the moment it stops being true; the address is still in the Settings
  head and in the offline card's "last known host". `.segmented`/`.seg` stay in the stylesheet:
  `SendSheet` is built from them.
- **A session row opens into the READER, not only into the terminal** (`openReader` in `core/term/useTermFeed.ts`,
  the `List` button in `.row-acts`). "Where did this one get to?" is the commonest reason to tap a
  row and the most expensive way to ask it: attach, wait for a full scrollback replay to paint an
  xterm, flip to the reader, open the outline, go back — five actions, three paints, per session, and
  it is asked of six sessions in a row. The tap sets read mode BEFORE the attach (`readModeRef` is
  only re-assigned on the next render, so the ref moves by hand, or the transcript is fetched twice:
  once by `attach`'s prefetch, once by the reader) and fires the outline verb after it. That verb is
  `readerCmd`, which outlives the session it was fired in while `TranscriptView` is keyed on the
  session id — so `attach` now CLEARS it on the way in. Un-cleared, a find bar opened in one session
  re-opened itself over the next one the moment its reader mounted. The button is **absent** for a
  backend that keeps no conversation log, exactly where the header's reader toggle is absent, and
  tracked as `session.read` rather than `session.attach`: opened-to-look and opened-to-work are
  different uses of the same list, and the counters should not merge them.
- The set-level verbs (fan out, schedules, rescan) and the repo listing's AGE moved onto the one
  section head, whose label now takes a **`flex: 1 1 12em` base**: a flex line breaks on base sizes
  before it shrinks anything, so a head that cannot fit its icon row beside the text drops the ICONS
  to their own line instead of squeezing the text into a one-word-per-line column — which is what
  "Sessions & repos · 35 live in 15 repos" did once the head carried the repo verbs too.

### `vite.config.ts` — chunking is an update boundary, not a load-time tweak

`manualChunks` looks like a page-speed setting and is not one here. `webbundle.ts` ships the phone
only the files whose sha256 moved since the bundle it already has, so the chunk layout decides how
much goes over the roaming Tailscale link when anything changes.

With one monolithic chunk that mechanism did nothing: a one-line UI edit re-sent the whole ~1 MB,
every time, to every device. Split react / xterm / icons / sheets / app, an ordinary edit re-ships
~247 KB.

Nothing is lazily loaded, and that is deliberate — this only changes which file a module is packaged
in, never when it is fetched. The app shell has to be complete on first paint because the common case
is a phone opening it with the tunnel already bad.

### `costNotice.ts` — when the cost toast is allowed to fire

Extracted from the effect in `App.tsx` that watches the attached session's cost reading, for the
reason the repo keeps making: the decision is the only real logic in that effect, and inside a
`useEffect` there is no layer that can test it. The web unit layer is node type-stripping, so the
module carries type-only imports and nothing that pulls in DOM or JSX.

The rule, and why each half of it is there:

- **Once per session per level STEP UP.** `active` is a fresh object on every frame the session list
  moves, so the effect runs constantly while an expensive session is on screen. Without the rank
  compare it would toast per frame.
- **Never downward.** A conversation that compacts genuinely returns to `lean`, and announcing that
  is noise — the chip already says it.
- **Bounded at 60, oldest evicted first.** It records that a toast appeared on *this* screen, and
  sessions are per boot; an unbounded record of them is the same slow leak
  [the store sweep](host.md#the-per-session-stores-and-the-sweep-that-bounds-them) exists to stop.

`costNotice.test.mjs` pins all four branches plus the eviction order and that the input map is not
mutated — the last one matters because the caller holds the same object in a ref across renders.

### A large RUNNING subagent — the second notice, and `useCostNotices.ts`

Measured: one subagent ran 819 requests averaging 484k of context and peaked at 967k of a 1M window
— about a quarter of a week's usage in one agent — and nothing on the phone said so while it ran.
The row's `agentEnv` shows the history faintly; it does not say *now*. So the host puts the largest
CURRENT window among the agents still writing on the spark (`ContextSpark.liveAgentTok`, host
`ctxlog.ts`'s `liveAgentOf`: each agent's NEWEST request, not its peak — an agent that compacted is
re-reading what it holds now), and the phone says one sentence (`liveAgentText`, from
`AGENT_LARGE_TOK` = 500k) in three places: the `liveAgentTag` chip beside `costTag`, a panel on the
context sheet, and one toast.

- **Running means a record within `AGENT_LIVE_MS` (10 min)**, asked twice: by the host when it builds
  the spark, and by the phone against its own clock via `liveAgentAt`. The spark is rebuilt only
  when a log moves, so a finished agent's spark would otherwise say "running" until the next turn.
- **One toast per session per CROSSING** (`costNotice.ts`'s `shouldNoticeAgent`), not per level:
  the record is the agent id announced, a reading under the line CLEARS it (re-arming the next
  crossing), and a different agent crossing while one is recorded is a new crossing.
- The chip's own words carry the fact (`agent re-reads 720k`); the sentence is on the sheet the chip
  sits beside, never only in a `title`. `--warn` weight, and it refuses nothing.

Both toast effects live in `core/session/useCostNotices.ts`, one hook App calls once — lifted out
of `App.tsx` together so the file could shrink rather than grow by the second effect.

### `updateBar.ts` — the × that did nothing, and the two bars named the same thing

Two unrelated things on this phone are called an "update bar", and both bugs here came from that.

**The dead ×.** `core/Banners.tsx`'s `CliUpdateBanner` is the DESKTOP CLI strip: `claude 2.1.236 →
2.1.267 available`, the `brew upgrade` button, the brew log under it. Its dismiss was checked as
`update.available && !running && !recentResult && dismissed === sig`, with `sig` the version pair —
so a dismissal only counted while an upgrade was still *available* and no result was fresh. The two
bars people actually want gone are the ones that fail both halves: `Updated: updated to 2.1.267`
(`available` is false by then, `recentResult` is true) and a standing `lastError`. On those, the ×
was a button that recorded a string and changed nothing on screen; the bar left when its 30 seconds
ran out, which reads as the tap having worked once and not the next time.

The version pair could not have fixed it either: after an upgrade `current` and `latest` are equal
and stay equal, so "the available bar" and "the bar reporting what happened" have the same
signature. `updateBarView` names every reason the bar can be up — version pair, `lastResult.at`, and
`lastError` — and hides exactly the bar that was waved off. A newer release, a fresh `brew upgrade`
result or a new error is a different signature and comes back on its own, which is the property the
old per-version rule was reaching for. An upgrade in flight is never hidden (the × is disabled while
it runs, and the log under the bar is the only place that upgrade is visible), and `RESULT_FRESH_MS`
is now one constant rather than `30000` written three times in the same function.
`updateBar.test.mjs` pins each of those, including the reported case.

**The CSS collision.** `UpdateBanner.tsx` — the staged-WEB-BUILD bar, a different component on a
different subject — also styled itself `.update-bar`, and its rule is `position: fixed; bottom:
…; z-index: 60`, defined far below the other `.update-bar` block. So the desktop-CLI strip and the
plain-HTTP warning, both written as INLINE bars directly under the header, were silently torn out of
the flow and dropped on top of the composer, while the `<pre class="update-log">` inside the same
`.update-bar-wrap` stayed behind at the top: one bar, split across the screen, covering the send
row. It also inherited `flex-wrap: wrap`, which put the × on a line of its own.

The floating one is `.staged-bar*` now, and both blocks carry a comment saying the other exists. A
shared class name between two components is not a shortcut here — nothing in the build warns, and
the loser is whichever block the bundler emits first.

### `setupRemedy.ts` — the finding that no patch can close

The repo-setup sheet had exactly one verb: `fix`, a POST to `compliance.ts` that writes a small,
additive, idempotent edit — a `.gitignore` line, a `CLAUDE.md` section, a helper script. That is the
only kind of remedy a daemon can write blind, and it covers a minority of the checks. Everything
else shipped as a sentence with nothing under it.

**What that looked like on a real repo.** One screen, seven rows, six green and one amber: *Secrets
(.env) gitignored — tracked & not ignored: …*. `fix: null`, no preset, so the sheet drew no button
anywhere on it, not even the "Fix all" one, whose count is over fix IDs. A checklist that finds a
problem and offers nothing is a checklist that gets re-read and re-ignored; worse, the remedy here
is genuinely not a patch — untracking is `git rm --cached` plus a judgement about whether the file
was ever a real credential, and one of the two flagged files might be a template that must not be
touched at all.

So the row's second answer is the one `context-weight` already had, generalised: **the finding
becomes words for the agent that owns the repo**, sent through `SendSheet` with the repo pre-chosen.
`CHECK_REMEDY` still wins where a preset exists — that is the user's own text, and editing the
preset edits the remedy — but its absence no longer means silence.

- `agentFindings()` is the cut: not passing, no `fix`, and `scope !== "host"`. The host scope is
  excluded for the reason `summarize()` excludes it — the Gemini key is one fact about the daemon, so
  handing it to a repo's agent asks every repo on the machine to fix the same thing and none of them
  can.
- `remedyPrompt()` **quotes each check's own `detail`** rather than paraphrasing it. The detail is
  where the file names and the measured numbers are; a paraphrase of a checklist is how an agent ends
  up fixing a finding nobody made. Beside each quoted row is one line of `GUIDANCE`, keyed by check
  id, saying what closing it looks like — including the part that is a judgement. One copy of those
  words, so the bulk prompt and the single-row prompt cannot drift.
- The prompt ends by making disagreement an answer: *a finding you decide is WRONG about this repo is
  an answer, not a failure*. Without that line the agent's only way to comply with "fix this" is to
  edit something.

**One tap for everything open.** The bulk button patches what the host can patch and then hands what
is LEFT to the agent — read off the **re-run report the fix returns**, not off the list as it was
before, so nothing is described to the agent as broken after it has just been fixed. A failed patch
stops there rather than composing a prompt over the top of its error. `bulkLabel`/`bulkNote` are
pure, because the button changes meaning with what is on the list and a footnote only appears when
one tap is about to do two different things.

Nothing here sends anything: `onRemedy` opens the composer, and WHEN it runs stays a decision made
with the words on screen. `setupRemedy.test.mjs`.

**And the finding that started it was half a bug.** `compliance.ts` exempted template dotenvs with
`/^\.env\.(example|sample|template|dist)$/` — anchored on the whole name, so `.env.example` passed
and `.env.production.example` was reported as a committed secret. A template is named by its LAST
segment. That warn could not be closed by any remedy, because every remedy was the wrong thing to do
to a file that is meant to be committed. `e2e-setup.mjs` now pins both the per-environment template
and a real tracked `.env`, including that the real one still carries no `fix`.

### `backendCaps.ts` — what this backend cannot do, said in words

The phone can drive more than one binary now (`host/src/backends/`), and the second one can do
less: opencode prints no context gauge, has no account quota, keeps no per-repo conversation log,
and draws a permission prompt whose armed option is a BACKGROUND COLOUR — which `render.ts`
discards, so a text reader can see the options and cannot see which one is selected. Every one of
those is a capability the host declares as absent on `BackendInfo`.

Absent is not zero, and it is not a greyed control. `capReason`/`reasonText` turn a missing
capability into the sentence that replaces the control — `ContextSheet`'s `unmeasured` says
*nothing here is measured* rather than drawing 0%, and it does no host read at all; `SlashSheet`'s
`unsupported` does the same. That is the no-grey rule (`Unavailable.tsx`) applied to a whole class
of controls at once instead of one button at a time, and it is why the sentences live in a pure
slice a test can read rather than inline in eight components.

**The gate is the important part.** `backends` arrives as a hello message, and a phone that never
receives it is talking to an OLD host: then the picker does not render AT ALL, every capability
answers `true`, and the claude tables are the catalogue — so the UI is pixel-identical to the day
before this existed. The gate is enforced twice on purpose: once at render, and once on the wire in
`launchFor()`, which strips a stored `launch.backend` (and any `effort`/`permissionMode` the chosen
backend never declared) off EVERY `session.create`. Without the second one, a queued op written by
a new phone could reach a host that ignores the field and spawn `claude` with another binary's
model string.

"EVERY `session.create`" was, for a while, a claim rather than a fact: two of the five create sites —
the worktree start-point row and `startSessionWithPrompt`, which is the *primary offline entry
point* — sent the raw persisted `launch`, and `launch` is synced, so the bad pair arrives from
another desktop rather than being chosen on this phone. It is now structural instead of stated.
`core/launch/useLaunch.ts`'s **`createOp()` is the only place a `session.create` is built**: it applies `wireLaunch`
itself and owns `cols`/`rows`, so a sixth site inherits the gate by having nowhere else to get an op
from, and `createOp.test.mjs` reads the source and fails `test:unit` if one is written by hand
anyway. A comment could not do that job — the two sites that bypassed the rule sat directly under
three comments asserting it. `fanout.run` carries the same `launch` and is gated the same way; it is
N spawns, so an ungated one is the wrong binary N times.

**A list that exists and does not name the id is not the same case, and is NOT stripped.** That is a
described host lacking this backend — a launch synced from a desktop with more of them, a rollback
to a claude-only build, a queued create replayed across either. Deleting the field there does not
degrade to absent, it degrades to a *different binary*: a silent `claude` spawn against an account
the user deliberately routed away from. So it goes on the wire and `resolveBackend()` refuses it in
words, naming the id and the ids this host does have; `op.ack` lands that sentence on the queue row
before anything is spawned. Refusing client-side instead would be a second copy of that rule judging
an offline create against a list from a host the phone may not be talking to when the queue drains.

The list is also scoped to the connection: `backends` resets to `null` on every `welcome` (not on a
disconnect — an outage is not a downgrade, and blanking the picker under a thumb already on it is a
worse lie than a stale one). A capable host sends the frame in the same batch as the hello, so the
picker is absent for at most one paint, and the list always means "what THIS host agreed to honour".

The claude fallback tables (`CLAUDE_MODEL_ALIASES`/`_IDS`/`_EFFORTS`/`_PERM_MODES`) moved here out
of `App.tsx`. A backend whose catalogue comes back EMPTY gets a free-text field, never a guessed
list — an empty catalogue means "the host could not ask", and inventing model names there would be
the wrong-number failure this repo keeps refusing to make.

**Superseded: the app carries NO catalogue any more.** claude's list used to live here (the host
answered empty on purpose) and `modelChoices` fell back to it. That was two tables; it is now one, on
the host (`host/src/backends/claudemodels.ts`, overridable by `models.json`, see host.md), and
`modelChoices` only reads `BackendInfo.models`. Before the first `backends` frame, or on a host too
old to send one, claude too gets the typed field plus a sentence (`freeTextNote`), never a list
invented here. Demo mode's fake host sends a small fixture catalogue in its `backends` frame.

Two smaller things were wrong with those tables in the same place. The ids had drifted — the list
was missing the model the app itself was running on while still offering a `[1m]` variant the
installed binary does not name — so they are now **read off that binary's own strings** (the one-liner that
re-derives them lives in `claudemodels.ts`, whose shape `claudemodels.test.mjs` pins). And the
control offered `aliases || ids`, never both: since claude's aliases are never empty, its version
list was unreachable by construction. `ModelField.tsx` is that control now — one drop-down with
*Aliases* and *Versions* as two groups, the typed field kept for a genuinely empty catalogue, and
**a stored id the catalogue does not name shown as ITSELF**. That last one is the readout rule, not
a nicety: a `<select>` whose value matches no option renders as the first one, so a model typed on
another device would have read back as "default" — the control stating something about the launch
that is not true.

### The derived caps, and the `/compact` chip that contradicted the screen

A photograph of a live `opencode · ollama/gemma4:e4b` session settled an argument this file had
been having with itself. The strip under the toolbar said three things were absent — no reader
view, no context graph, **no slash commands** — and two rows above it, in the header, sat a
`/compact` chip. The chip was not broken in the way a dead button is broken. Its text went down
`submitInput` as `kind: "command"`, the backend's descriptor says `slash: false` and its
`isLocalCommand` is `() => false`, so the string arrived as an ordinary PROMPT: the binary was asked,
in English prose, to compact itself. The screen contradicted itself in a single glance, and the half
that won the argument was the half you could put a thumb on.

The fix is `splitHeaderCmds(cmds, canSlash)` in `headerCmds.ts` — pure, node-tested, and one call
per render feeding three consumers. What it returns is `{ shown, hiddenSlash }`, and the three rules
around it are all rules this repo already had:

- **Withheld, not deleted.** Header chips are SYNCED user data (`shared/settings.ts`): they follow
  this person onto every client they own. A session that cannot use one is not a reason to edit
  their configuration everywhere, so the manage sheet still lists every chip — it edits global
  config, not the session that happens to be open. It does say what that session is doing with
  them, as a fact about the session rather than as a reason to delete anything.
- **Withheld, not dimmed.** `Unavailable.tsx`'s rule: opacity is a verdict you have to already know
  how to read, and a `title` is invisible on a phone.
- **The count IS the cut.** The slash line in the cants strip carries "N of your header chips are
  Claude slash commands and are not offered here", and that N is `splitHeaderCmds`' own
  `hiddenSlash`, handed straight to `sessionCants`. One function, one number, one filter — the same
  rule the schedules chip and the sweep sheet hold to. A second pass over the list to count what a
  first pass removed is how a badge becomes a liar.

The predicate is `runHeaderCmd`'s own — `text.trimStart().startsWith("/")`, on the TEXT and never on
the title. The chip that is withheld has to be exactly the chip that would have been submitted as a
command, or the pair is worse than the bug.

**`canSlash: true` returns the list unchanged.** That is claude, and it is every host that never
sent a `backends` frame at all. A claude header is byte-identical, which is the acceptance rule for
the whole change and is pinned by name in `headerCmds.test.mjs` and `backendCaps.test.mjs`.

#### Three capabilities that used to be one, and why absent means "inherit"

`fork`, `resumePick` and `contextSeries` are OPTIONAL on `BackendInfo.caps`
(`shared/wire/backend.ts`) and that is not a formatting choice. They were implied by `transcript`
and `contextMeter` until a backend arrived with one and not the others:

- a conversation record this app may **read and must not rewrite** — so a transcript it cannot fork;
- a readable record with **no "pick an older conversation" list** this host knows how to drive —
  `launchArgs` refuses `"pick"` in words, so a button there offers a refusal;
- a **plottable history behind a screen that prints no gauge** — `contextMeter` is a statement about
  what the TUI PAINTS, and a series is a statement about what can be read back.

Shipped as `false`-defaulting booleans these would have deleted working controls from every desktop
one version behind: an old descriptor answers `undefined`, and `undefined` read raw is falsy.
So absent means **inherit what used to imply it** — `fork ?? transcript`, `resumePick ??
transcript`, `contextSeries ?? contextMeter` — and that resolution lives in exactly one place.
`hasCap` and `capReason` take these names alongside the plain ones; nothing else touches the
optional fields. A call site reading `b.caps.fork` itself is the bug, and **`local/no-raw-optional-cap`
(`tools/eslint/rules.js`) is what fails when somebody writes it** — `b.caps.fork`, `b?.caps?.fork`,
`b.caps["fork"]` and `const { fork } = b.caps` alike, with `backendCaps.ts` the one exempted owner.

That sentence used to name `backendCaps.test.mjs`'s `OLD_HOST_CLAUDE` case as the enforcement, and
it was wrong in the way a promised check is worst: that case exercises `backendCaps.ts`, so it pins
the RESOLUTION and cannot see a raw read written anywhere else — a `b.caps.fork` added to `App.tsx`
passed every test in the repo. A rule that is stated in a note and checked nowhere is a rule that
holds exactly as long as the next session happens to read the note, which is the same argument
`CLAUDE.md` makes about itself. The repo's own answer to this shape is a lint rule
(`local/no-storage-key-literal` for storage keys, `local/no-draft-clobber` for sheet drafts); this is
that answer for the three optional caps. `OLD_HOST_CLAUDE` stays, doing the job it always did: it
states the trap (`assert.equal(OLD_HOST_CLAUDE.caps.fork, undefined)`) and proves `hasCap` resolves
it.

`sessionCants` is the strip as ONE builder rather than four `capReason` calls at the call site,
because two of its rows are conditional on another row. The fork sentence is shown **only where a
reader exists**: with no transcript at all, the transcript sentence already says there is nothing to
fork from, and a second line makes one absence read as two. For claude it returns `[]`, so
`Unavailable` renders nothing and the session screen is unchanged.

What the caps then re-gate, each one a control the host's capability flip would otherwise have
exposed: *pick an older conversation* in **Recently closed** moves to `resumePick`; the reader's
fork/reset disclosure moves to `fork` (the whole disclosure, never a dimmed pair inside it); the
context chip splits its two questions — **whether it exists** is `contextSeries`, **whether it may
print NUMBERS** is `contextMeter`, and a backend with the first and not the second gets the chip
BARE: the icon, the word *context*, a door to the graph, and no figure. A number there would be the
measurement that never happened. `ContextSheet`'s `unmeasured` moves to `contextSeries` for the
same reason — keyed on the gauge it would have refused a graph that exists. The launcher's outline
button and the terminal corner's reader/CLI switch stay on `transcript`, which is now exactly the
right flag rather than a proxy for three.

#### Which conversation a reopen reopens

`resumeSessionId` on a `session.create` is one wire field, and the id that belongs in it lives in one
of two places on the row: `claudeSessionId` (claude's own uuid, the basename of the jsonl it keeps)
or `backendSessionId` (the backend's own id — opencode's `ses_…`). Two fields on purpose, for a
reason `shared/wire/session.ts` spells out: every log reader in the daemon turns the first into a
path under `~/.claude/projects`, so an opencode id parked there is a reader aimed at a file that will
never exist. `opencode.mts` (`packages/extensions/opencode/host/`) declined to carry an id at all rather than write one into that
field.

All four reopen/resume taps read `claudeSessionId` alone — the launcher's **Recently closed** row,
its **Resume recent** row, the hidden-recent row and the ended-session overlay's *reopen*. For an
opencode row that field is always absent, so every one of them fell through to the directory's
`--continue`: with two closed conversations in one repo, tapping the OLDER row carried on the NEWER
one. Nothing on screen was wrong. The row said *reopen*, a session opened, the title matched, and
the only thing that had happened is that you were in a different conversation than the one you
pointed at.

So there is one reader, `resumeIdOf`, and every reopen site goes through it. Not `a ?? b` at four
call sites: four hand-written copies of a two-field rule is how one of them goes back to reading a
single field, which is precisely the state this was found in. The two fields are never both set on
one row, so the `??` is a choice between a value and an absence rather than a precedence rule.
`createOp.test.mjs` pins it as a fact about the source — no `openCwd` call may read either field
directly, and at least four must go through the reader.

Three things travel with that fix, each one the same bug wearing a different hat:

- **`conversationOpen` uses the same reader.** The launcher hides a closed row whose conversation is
  already open live; built from `claudeSessionId` alone, that set said every opencode session was
  id-less and fell back to "is anything open in this directory", hiding a genuinely-closed
  conversation behind an unrelated one in the same repo.
- **The React `key` on a recent row** was `claudeSessionId ?? cwd`, so two recent opencode
  conversations in one repo were handed the same key.
- **The ended-session overlay's *reopen* built its launch override from model/effort/permissionMode
  and no `backend`**, which reopened an opencode conversation under claude — the wrong binary, not
  merely the wrong conversation.

**And the row says when it cannot be exact.** `capReason`'s `resumePick` sentence — *no
"pick an older conversation" list this desktop knows how to drive; reopening carries on the folder's
own conversation instead* — was reachable only from inside a session, which is after the decision it
describes and on another screen. It belongs on the row, and it is drawn there (`reopenCant`,
`CantInline`) under two conditions: the backend has no picker to offer instead, AND this row carries
no id to resume exactly. A row that has an id gets an exact reopen and nothing to warn about; claude
and every host that never sent a `backends` frame answer null and keep their exact pixels.

The row `title`s that said `claude --resume` / `claude --continue` are gone with it. A title is
invisible on a phone anyway, but it was asserting a command the row would not run, and naming each
backend's own flag instead would put a second copy of the host's argv table on this side —
`opencode.mts` (`packages/extensions/opencode/host/`) spells it `--session <id>`. `resumeHint` says the EFFECT, which is true for
every backend and is also the part being decided.

#### A compaction is not a blank message

`TranscriptTurn.marker: "compaction"` is the backend's own record of a conversation being
summarised: a user-role row carrying a compaction part and no text at all (measured on a real
store — exactly the rows with a compaction part are exactly the user rows with no text). Rendered
down the ordinary path it is an empty `.tr-you` quote block, which reads as a person having sent a
blank message: a claim about somebody, where the truth is a fact about the tool. So it is a labelled
DIVIDER (`.tr-mark`, built on `.tr-newmark`'s shape but muted — the unread mark is news, this is
bookkeeping), and it says what it means for what sits above it.

The other half of the new source is a non-change worth writing down: the reader's one
approximate-source test is `doc.source === "history"`, an equality and not `!== "jsonl"`. `"store"` (spelt `"opencode"`
while that was the only store reader) is a backend's own dated record read out of its store — as exact as the CLI's log — and a `!== "jsonl"`
would have libelled it as reconstructed terminal text. It also means an older phone meeting a source
it has never heard of reads it as exact, which is the correct default: the approximate one is the
one this app builds itself.

#### `windowFrom: "config"` — attributed, never measured

`contextPlot.ts`'s `axisNote` is the sentence under every chart, lifted out of `ContextSheet`'s JSX
where it was four nested ternaries about truthfulness. Every other `ContextWindowSource` is
something that was WATCHED: the TUI printed the window, or a conversation was seen to hold it, or
(weakest, and measured wrong before) the model id implied it. `"config"` is none of those — it is
opencode's `/config/providers` `limit.context`, what the tool believes it is permitted to send. A
model running locally may be holding far less than the configuration claims, answer happily, and
truncate without saying so.

So the number is still drawn — it is the best axis available and an attributed axis is the truthful
maximum here — and the sentence says **whose claim it is**: *"100% is 128k, as opencode's
configuration states it — a setting this app read, not something anybody watched happen."* It
borrows none of the vocabulary of the observed sources, and `contextPlot.test.mjs` pins that it
does not. The backend's own label comes down as a prop and falls back to a neutral noun, so a third
backend needs no edit. **No percentage is invented anywhere in this change**: the chip stays bare
for a backend with no gauge, and the graph with an attributed axis is as far as the truth goes.

### The per-session ask — `LaunchAskSheet.tsx`, `shouldAskLaunch`

The new-session defaults are a good answer for the session you are not thinking about, and the
wrong shape for someone who runs a cheap model for a quick question and an expensive one for the
work after it. Doing that against a default is three screens — change it, open, change it back —
and forgetting the last step is SILENT: the session starts, looks exactly right, and is running the
wrong binary until something about the output feels off.

So `waterplane.launchAsk` (synced, **off by default**) makes a fresh open stop and ask which backend and
model to run, starting from the defaults. Three properties carry it:

- **The answer is for that launch only.** Writing it back into the defaults would make the NEXT
  session inherit a choice made for this one, which is the same silent drift the sheet exists to
  remove. The settings screen stays the one place a default is set, and the sheet says so.
- **…but it is REMEMBERED, and that is a different claim.** Not writing the defaults back is not the
  same as forgetting, and conflating the two is what made this sheet read as broken: with the switch
  on, every launch re-posed the same question with the same wrong-for-you answer pre-filled, so the
  decision was made again by hand every time. `LS.launchLast` (per device, **not** synced) holds the
  pair last answered here and `launchAskStart` is where the two controls start — pure and tested,
  beside `shouldAskLaunch` for the same reason. Two rules make it a pair rather than two fields: a
  model id belongs to the catalogue it came from (`opus` means nothing to a local runner,
  `ollama/qwen3-coder:30b` means nothing to claude), and a remembered backend THIS host does not
  describe is dropped with its model. That second one is not about the spawn — `launchFor` lets an
  unknown id go out on purpose so the host can name it in words — it is about the control: a
  `<select>` whose value matches no option renders as the FIRST one, so a remembered `opencode` on a
  claude-only desktop would read "Claude Code" while carrying `backend: "opencode"` into the create.
  Per device because it is where a control on THIS screen starts, and because a pair synced to a
  tablet paired with another desktop can name a backend that host has never had.
- **Its two controls are `.set-row`, not bare `<label>`s.** They shipped as unstyled browser widgets
  flush against the screen edge, because the labelled-control styling in this app lives on that
  class — the settings screen's own rows — and `.form` alone has no horizontal padding at all. One
  class rather than a second rule, so the ask and the settings screen cannot drift into two looks
  for the same two controls.
- **It is never asked on a resume, and never over a caller that already decided.** Both refusals are
  in `shouldAskLaunch`, pure and tested, rather than inline in `openCwd`: a resumed conversation
  carries the launch it was recorded with, so asking there offers to continue it under a different
  binary — not a resume, a new session wearing an old conversation's id — and the archive's explicit
  claude, a relaunch and a worktree row replaying its own opts have each answered the question by
  passing a launch in.
- **The gate belongs to EVERY fresh start, and this shipped wrong once.** It was written into
  `openCwd` alone — the function whose name says "open a session" — which is not the one the
  launcher's repo rows call. `openRepo` and `startSessionWithPrompt` build their own create, because
  each carries something the others do not (a toast about what is already opening in that repo; a
  prompt chain whose `needs` ride in the same lane), so the switch was on, the sheet existed, and
  the tap people actually use started on the defaults without asking. It is the same failure
  `createOp.test.mjs` was written for — a rule true at some of the call sites — so it is pinned the
  same way: `askLaunchFirst()` is the one gate, each caller hands over the rest of its own tap as a
  thunk, and the test reads the source and fails by name when a fourth start site appears or an
  existing one stops asking. Fan-out is deliberately outside this: a sweep is ONE decision over N
  repos, made in its own sheet, not N questions.
- **Nothing is queued while it is up.** The sheet stands between a tap and a `session.create`, so
  closing it starts nothing and a reload is an answer of "not now" — which is why `launchask` is
  kept out of `PERSISTED_OVERLAYS` along with the pending open it is scoped to. Start calls back
  into `openCwd` with the answer as an override, so the create still goes through the one
  constructor and `wireLaunch` still strips a backend this host never described.

### One set of launch controls — `LaunchPicker.tsx`

- **The ask and the fan-out drew two different controls for the same decision.** The ask had the
  backend drop-down, the wheel (model × effort) and *a specific version…*; the sweep's row was a bare
  model `<select>` that could pick neither a backend nor an effort, so the owner met a second look
  for one choice and could not run a sweep on fable at `high` without changing the defaults.
- `LaunchPicker` is the ask's set lifted out whole; both sheets draw it and own the pick. What is
  REMEMBERED stays each caller's: the ask writes `LS.launchLast`, the sweep `LS.fanoutModel`, which
  is `null` while it equals the defaults (so a later default change reaches the sweep).
- The sweep's stored pick is read through `launchAskStart`, the ask's own guard — a backend this
  host no longer describes drops the pick whole. A pick stored as `{ model }` alone predates the
  backend control and meant the default backend, so it is read as that.
- A backend the host says cannot start replaces Run with the sentence, as it replaces Start on the
  ask: N launches that would fail are not offered. *Later* stays — a schedule fires when it may.

### `useVoice.ts` — two engines, one microphone

The hook was the Web Speech API and nothing else, which on Android Chrome is
Google's cloud recogniser — the same family as the Gboard microphone that was
reported as not good enough to dictate a prompt with. The desktop has a better
engine (`host/dictate.ts`, ~30× realtime, measured), so the hook now has two
and the button is unchanged.

**Which one is decided once, and nothing is ever dimmed.** `host` when the
desktop answers `available` AND this document may open a microphone at all;
`browser` when only Web Speech is there; with neither, `supported` is false and
the CALLER draws no button — `Unavailable.tsx`'s rule, since a greyed control
explains nothing on a phone where a `title` never appears. The status read is
memoized as a PROMISE at module scope: two components call this hook and both
are mounted on some screens, so a read per mount is two requests for one
unchanging fact. It is deliberately not re-read after that — nobody installs
whisper while a phone screen is open, and a stale "yes" fails as a sentence on
the next recording rather than as a wrong button.

**`getUserMedia` needs a secure context.** A plain `http://100.x` tunnel is not
one, so on the bare Tailscale IP the host engine is unreachable BY
CONSTRUCTION and the browser one is what you get. That is the same constraint
the insecure-origin banner already exists for, and the same fix:
`tailscale serve` in front of the daemon. In the APK it additionally needs
`RECORD_AUDIO` in the manifest and the WebView's permission callback, which is
a new APK rather than an over-the-air bundle.

**Four states, not two.** With the desktop engine the words arrive about a
second after you stop talking, and a button that returned straight to idle in
that second read as a tap that did nothing — so `transcribing` is held apart
from `listening`, the compose bar's `.mic` and the action bar's `.key` both
draw a `.busy` pulse in the warn hue, and the label says *reading…*. The fourth
is *held*: a recording the link was too poor to deliver, which is a wait and
not a failure (see the section below).

**The two behaviours that did not change in spirit.** Dictation APPENDS,
because typed words are the last copy of themselves. And a failure is a
SENTENCE: a refused microphone, a desktop with no model and silence are toasts,
and NOTHING is appended for any of them. The one thing this must never do is
put a guess in the box. What DID change is the base and the dead tunnel — the
box is read through `VoiceBox.read` at LANDING time rather than snapshotted
when the mic opens, and a dead link is no longer one of the failures.

**The capture graph is 16 kHz mono PCM, on purpose.** `AudioContext({
sampleRate })` asks the browser to resample, so the bytes that go up are
already the only format `whisper-cli` reads and the host needs no transcoder —
see `host/dictate.ts` for why depending on ffmpeg there was rejected.
`ScriptProcessorNode` is deprecated and used anyway: an `AudioWorklet` needs a
separate module URL, which inside the Capacitor WebView means a blob URL and
one more thing that can be blocked, and at 16 kHz mono the main-thread cost of
a 4096-frame callback is nothing. Each callback COPIES its channel data — the
graph reuses that buffer, and without the copy every chunk ends up holding
whatever the last callback wrote.

The microphone stays where it was: one `VoiceButton` over this one hook on
every surface (emitting `action:voice`, so the usage sheet counts dictation
once), and moving it into the text box's own corner would put an absolutely
positioned control over a field that GROWS as you type — the box is a viewport
onto text that scrolls, so the corner is not empty space, it is the next line.

### `dictateFallback.ts` + `DictateFallbackPill.tsx` — the fallback engine is said, not silent

Two engines share one microphone button, so nothing on screen said which one was listening. On
2026-09-26 Android Chrome's recogniser dictated "orsofixorsofixorsofix" into a prompt (its
continuous mode repeats earlier words in later results; `speechMerge.ts` now merges them), and the
person had every reason to think whisper wrote it. The fix for the fallback itself — open the app
over https — was one tap away on a banner that had been snoozed.

So while the phone's recogniser records, a warn-hued pill reading *phone recogniser* sits where the
language pill would (the two never coexist: the browser engine takes its language at the start).
Its tap toasts WHY, from `dictateFallbackWhy`: plain http (naming https as the fix), no recording
API, or the desktop's own `reason` from `/api/host/dictate`. The same sentence is toasted once per
page at the first such recording. `null` before the desktop answers — a reason is never guessed.
A "not available" status is no longer memoised: the likeliest one is a host unreachable at page
load, and holding it pinned the worse engine until a reload.

### `dictateLang.ts` + `DictateLangPill.tsx` — the language is the dictation's, not the device's

Reported: **"I talk English and I see automatically to German translated
text."** Not a transcription error — a translation, and a fluent one. The phone
handed every clip `navigator.language`, which is the phone's SYSTEM language,
and `host/dictate.ts` passes that to `whisper-cli -l`. Whisper told a language
does not transcribe another one; it TRANSLATES into the one it was told. So on
a German phone every English sentence came back as German prose: correct
grammar, plausible wording, and not what anybody said. That is the worst shape
this feature can fail in, because nothing on screen is wrong-looking — a
garbled transcription gets edited, a fluent mistranslation gets sent.

**The system language was never the right input.** It describes the person's
menus, not the sentence they are about to speak, and it cannot describe
somebody who dictates German and English in the same session — which is the
whole point of having put whisper behind this button (`host/dictate.ts` measured
both). Asking that person to change their phone's language to dictate is not a
fix.

So the language is a property of the DICTATION, chosen where dictation happens:
a pill beside the microphone, on both chromes, over one stored choice
(`dictateLang.ts`, a module-level value with subscribers for the same reason
`dictateQueue.ts` is one — two mics can be mounted at once and a language only
one of them heard about is a control that lies). The default is `auto`, which
is the answer for the bilingual case: whisper's own detection reads either
language correctly, and a pinned one is there for the short clip or the
technical sentence where detection wobbles.

**The pill is drawn only while the microphone is OPEN.** It shipped for a day
as a permanent member of the compose row and was asked back out of it: a
control needed between "I started talking" and "I stopped" is furniture either
side of that, in a six-button row that scrolls beside a live terminal. It is
also absent on the BROWSER engine, which is given its language when recognition
starts — there is nothing a pill could change about a recording already
running, and a control that cannot do what it says is worse than no control.
Which leaves the standing choice with nowhere to be made before a recording,
and that is what the Settings rows are for.

**Two rows in Writing & reading** (`dictate-lang`, `dictate-langs`), both absent
where this phone cannot dictate at all: the language itself as chips, and WHICH
languages the pill lists — `SetMulti`, the kit's first several-of-a-closed-set
control, added here because a column of switches for twenty-odd languages is
twenty rows of chrome for one decision. The offered list defaults to three
(`DICTATE_LANGS_DEFAULT`: auto, English, German) rather than the catalogue,
because the pill is tapped one-handed between two sentences and a 25-row scroll
at that moment is the control failing at its only job. `dictateLangOffered`
holds the two rules that keep it honest: an empty or unusable pick falls back
to the default rather than rendering an empty picker, and the language IN USE
is always in the list — a `<select>` whose value matches no option renders as
the first, which would re-aim the transcriber at a language nobody chose, in
the control that exists to say which one is in use.

**Read at the STOP, not at the tap and not at landing.** The tag travels with
the clip (`holdDictation`'s `lang`), so changing the pill mid-sentence applies
to the sentence being said — which is exactly when somebody notices they have
switched language — while a clip already held for a dead tunnel keeps the
language it was made in rather than being re-decided days later by a pill that
has since moved.

**Every offered code must survive `whisperLang` unchanged.** An unknown code is
not a worse transcription, it is NO transcription: whisper validates the
language before it loads the model and exits 0 having written nothing (the
`de-DE` bug this list already fixed once). The picker's list is curated —
thirteen-odd languages beat a hundred-row list on a phone — with the device's
own language appended when it is not already there, and a device tag whisper
cannot place adds nothing, because `auto` is already at the top.
`shared/test/dictate.test.mjs` pins all of that, plus the sentence the control
says: a pinned language tells you everything else will be TRANSLATED into it.

**The browser engine is a different question.** Web Speech has no auto-detect —
it takes one BCP-47 tag — so `auto` there can only mean the device's language,
which is what it always was. `speechLang()` is that one question, answered in
one place, and overridden the moment a language is pinned.

**Stored per device and not synced.** The microphone is a fact about the phone
being spoken into; a desktop browser adopting the setting would re-aim a
transcriber nobody there is talking to.

### `dictateHold.ts` + `dictateQueue.ts` — a recording is not lost to the link

Reported, with a screenshot of the activity strip reading *sending · 15s — the
connection may be down*: **"very annoying to talk for a minute and then see it
run into an error due to connection"**. That strip was the dictation itself,
and the arithmetic is the whole bug. A minute of speech is 1.9 MB of 16 kHz
PCM and five minutes is 9.6 MB; `fetch` resolves on the RESPONSE HEADERS, which
on `POST /api/host/dictate` do not exist until every byte has been uploaded AND
whisper has run. The call went out on `nfetch`, i.e. `FETCH_TIMEOUT_MS` — the
20-second fuse meant for small JSON — so a tunnel that was merely SLOW had the
request aborted, and `useVoice` showed a toast and dropped the only copy of the
audio. A prompt TYPED in that same second would have been queued, retried and
delivered minutes later. The spoken one was gone.

So the transport changed and the promise changed with it.

**The transfer is XHR, like the inbox upload, and for the same two reasons.**
It brings byte progress, so what is bounded is SILENCE (`STALL_MS`, 45 s,
re-armed on every progress event) rather than the transfer — XHR's own
`timeout` would kill a legitimate five-minute clip on a slow uplink — and an
abort that belongs to the caller. `api.dictate` REJECTS for anything that is
not the desktop's own verdict and marks whether the host `responded`, because
the queue needs that difference: a verdict is final, a dead link is a wait.

**A recording is a thing that WAITS.** The WAV goes to IndexedDB (`dictations`,
v12) before the first attempt, the index of what is waiting is in localStorage,
one clip is attempted at a time oldest-first, and a miss backs off
(`retryDelay`, 2 s doubling to a minute) and tries again — for ever. The send
queue eventually marks a delivery `failed`, because an undelivered prompt is
still on screen in full and can be sent again by hand; a recording cannot be,
since nobody re-says a sentence the same way. What is bounded instead is how
much may be waiting — `HOLD_CAP` clips and `HOLD_MAX_BYTES` of them — and the
cap REFUSES a new recording rather than shedding an old one, `addPadNote`'s
rule: a clip is old exactly because nobody has had their words back yet. A
reconnect (`subscribeLink`, `online`) clears every backoff at once, because a
link that just came back is new information.

**Where the words land is decided TWICE.** Whoever recorded the clip claims it
(`claimDictation`) and gets the words if it is still there — appended to what
its box holds AT THAT MOMENT, through `appendDictation`, never to a snapshot
from when the microphone opened. That distinction did not matter while a
transcription was one request that answered in a second; it is load-bearing the
moment a clip can be read ten minutes later, because `base + text` with a stale
base deletes every word typed in between — `local/no-draft-clobber`'s failure
reached by a different lever. `VoiceBox.key` is the second half of the same
rule: the session the compose bar was showing, the turn of the chain the caret
was in. If it has changed, the words are NOT written there — they go to the
PAD, this app's home for words with no target yet, and a toast says so.

**Nothing here is destroyed to keep the machinery tidy.** A pad that refuses
(it is capped too) leaves the clip on the ladder rather than dropping the
audio; the only unrecoverable case — the browser evicted the bytes — is said
plainly rather than silently. `installDictations()` is in `main.tsx` above
`App`, for the case the feature exists for: the app was killed with a recording
still waiting, and nobody should have to open the right screen to get their
words back. It also sweeps blobs the index no longer names, which is megabytes
of audio on a device whose storage the send queue's images compete for.

The words on the button and every decision about the ladder are
`dictateHold.ts`, pure and node-tested (`dictateHold.test.mjs`); the pump,
the stores and the toasts are `dictateQueue.ts`.

### `dictateWatch.ts` — a microphone that stops hearing says so

Reported: *"voice input seems to stop processing my audio at a certain point,
and I have no indication of it"*. A long dictation is a phone nobody touches, so
the screen times out; the WebView is paused, the `AudioContext` with it, and the
capture stops receiving frames — while the button, drawn from a React flag
nobody cleared, went on saying *listening*. A phone call, another app taking the
microphone or a Bluetooth headset dropping out end the track the same way.

The capture's own frame count is the only honest clock: it advances only while
audio actually arrives. So the button shows seconds HEARD (`Voice.heard`), which
freezes with the microphone, and `captureStall` calls a stall on any of three
facts: a gap since the last frame (`STALL_MS`), a lag of the running total
against the wall clock since the open (`LAG_MS` — a context resumed after the
screen came back counts frames again at once, so the hole is in the MIDDLE of
the clip and only the total shows it), or an ended track. A stall stops the
recording, hands over what WAS heard, vibrates and toasts WHEN it stopped.

Around it, in `useVoice.ts`: a screen wake lock while recording where the
WebView offers one (the cause, not just the symptom); the 300 s per-clip cap
ROLLS OVER into a new clip instead of closing the microphone, with a warning
`CAP_WARN_SECONDS` before; and the browser recogniser's own `onend` (Android ends
"continuous" sessions by itself) is said and felt instead of silently going idle.
The pure half is node-tested in `dictateWatch.test.mjs`.

### `SettingsKit.tsx` + `settingsIndex.ts` — eleven spellings of a boolean

Settings had grown to seventeen sections and sixty-odd controls, written one at
a time over as many months, and the drift was measurable rather than a matter of
taste. Counted on the screen before this change, **a two-state setting was
spelled eleven different ways**:

| on screen | shape |
|---|---|
| `data saver: on` / `off` | label, colon, state — the majority |
| `auto-continue on` / `auto-continue off` | the label itself mutates |
| bare `on` / `off` | no label at all; the section heading was the label |
| `Return sends` / `Return newlines` | a verb flip, no state word |
| `remote-control` | no state word at all — only the accent colour said it was set |
| `ask every time` / `use these silently` | two unrelated labels for one switch |
| `also gating Tailscale` / `gate Tailscale too` | statement ⇄ imperative |
| `auto-fire ON` / `ask me (approve each)` | label, case and meaning all flip |
| `weekly ceiling: 90%` / `weekly ceiling: off` | the value stands in for the state |
| `Background link: starting…` | a state machine wearing a switch |
| `OS push: blocked in browser` | a third state wearing a switch |

Picking one of N was four idioms — chips in a `.hint-modes` row, a `<select>`, a
−/+ stepper, and a range slider — chosen per row rather than per KIND of
question. And the one that actually cost something: **an action was drawn as a
bare `.key`, which is pixel-identical to a switch that is off.** `token
statistics` opens a whole other screen; `data saver: off` toggles in place; they
were the same rectangle. You could not tell a door from a switch without tapping
it.

So the kit is one component per kind of decision, and the kind is visible before
the row is read: `SetSwitch` (label left, `on`/`off` pinned to the right edge,
the whole row a 44px target), `SetChoice` (chips — never a `<select>`, which
hides the alternatives until you commit to opening it, which is how `localRt`'s
third mode was invisible), `SetPick` (the one place a `<select>` is right: model
ids and numeric caps, a long or open list), `SetStepper` (absent at the ends,
never dimmed), `SetSlider` (the two budget ceilings, always with its readout),
`SetAction` (never wears the accent — that colour means *on*, and an action is
never on — with a chevron **only** when the tap opens another screen).

Three rows used `disabled` to mean "not now": push-to-host with no link,
*explain them again* with nothing dismissed, the oracle key test while it runs.
The first two are now `cant` — the reason as a sentence where the button would
have been, which is `Unavailable.tsx`'s rule and also the more useful answer
(*nothing has been dismissed yet* says what the count IS). The third is `busy`:
a verb that is running says so in its own glyph. The LAN password's `disabled`
until four characters went the same way.

**Compactness was the second job and it is prose, not pixels.** Every row
carried its full argument as permanently visible text — several of them four or
five sentences — so the screen was about forty phone-heights of things you had
already read. `SetNote` keeps one line and folds the rest behind the same
`hint-more` disclosure the context sheet uses. What never folds is an ABSENCE or
a WARNING, which is why `SetWarn` is a separate component and not a flag: the
reason a control is missing, and the thing that will bite you, are the sentences
that must be read without being asked for.

**Search is `settingsIndex.ts`**, pure and node-tested: one entry per row with
the words somebody would actually type. The keywords carry the vocabulary the
labels do not — "dark" for the theme, "font" for text size, "password" for the
LAN gate, "battery" for the background link — because the failure this is
written against is a person who knows exactly what they want to change and
cannot find the word the app chose for it. Terms are **ANDed, not ORed** ("tab
order" under OR matches every row with either word and stops narrowing
anything), and matched as substrings so a query narrows while you are still
typing.

Two rules here exist because the first cut got them wrong, and both were found
by driving the real page rather than by reading it:

- **A group carries no keywords of its own.** It did, and every word in the list
  matched every row underneath: `gemini` on the Sessions group meant searching
  for it returned all fourteen session rows — the backend picker, the model,
  both budget ceilings — instead of the eight about the oracle. A group-level
  word is a word about a dozen rows at once, which is the opposite of what a
  query is for. The group's TITLE still matches its rows, because searching
  "notifications" is a person asking for the group.
- **A group never skips rendering its rows.** It did, and the rows inside a
  hidden group never counted themselves, so the filter bar's denominator
  silently became *rows in groups that survived* — it read **"1 of 8" on a
  screen holding 54**. Now every row draws and hides itself, and only the
  SECTION is hidden: `gone` for the query excluding the whole group (exact, and
  it works on a WebView with no `:has()`), with a `:has()` rule for the case the
  catalogue cannot see — every row in a group conditional on the host and absent
  right now.

The counts the filter bar prints come from the render pass itself, not from the
catalogue's length: a good third of these rows are conditional (no oracle key,
not the Android shell, tabs switched off), and a denominator counting rows the
screen cannot show is a denominator that makes the filter look broken. The rows
push their ids into a tally as they draw; `SetFilterBar` is drawn **last** in
the markup and floated to the top with `order: -1`, so it reads this render's
finished counts rather than being one render behind a `useEffect`.

`settingsIndex.test.mjs` reads `core/settings/` and every feature `*Settings.tsx` back and fails when a rendered row
carries an id the catalogue does not name, or when the catalogue names an id
nothing renders — the same shape as `claudemd.test.mjs`. The failure it guards
is silent and asymmetric: a row with no entry is on screen and unfindable, and
an entry with no row puts a heading over nothing. Neither is visible in a diff.

**The seventeen sections are seven groups**, ordered by what brings a person to
the screen: Sessions · Notifications · Appearance · Writing & reading · Offline
& data · Connection · Tools & diagnostics. Three of the old heads — "Usage",
"Usage limit", "Usage budget" — were one subject filed three ways, with the
oracle (the thing that answers questions on your behalf) three screens further
down. The three always-on strips (connection, local runner, session tabs) moved
out of "Tools" into Appearance: a strip costs a line of *this* screen, which is
the same question as the text size, not a diagnostic. And the nine diagnostics
are a rack of doors rather than nine full-width rows with a paragraph each — the
label is the only thing that tells them apart anyway.

#### A blanket rule about a class this screen did not invent

The group-hiding backstop shipped as `.set-group:not(:has(.set-item)):not(:has(.set-door))
{ display: none; }` — "a group whose rows are all absent draws nothing". True of
the settings catalogue, where `SettingsKit.tsx` writes every row as a
`.set-item` or a `.set-door`. Not true of `.set-group`, which is a SHAPE five
other sheets had been using for months with plain `.set-row`s inside it: the
per-repo download rules (`PullSheet.tsx`), the local runner, the network health
board, the speed test and the app-update panel. All five went `display: none` in
one commit — heading still there, every switch under it gone — and the report
came back as *"I can not find the auto download settings anymore"*, about
controls that were in the DOM the whole time.

Both selectors are scoped to `[data-group]` now, which `SettingsKit` writes and
nothing else does. The rule this is an instance of: **a selector whose subject is
a class the screen did not invent belongs to whoever did.** `.gone` and
`data-group` are this screen's own marks; `.set-group` is a shared one, and a
rule that reads it as "mine" is a change to five other screens that no diff of
this one shows. `theme.test.mjs` parses `styles.css` and catches a literal
colour; it cannot catch this, because the CSS is valid and the HTML it hides is
in another file.

#### Where the per-repo rules are asked for

The auto-download rules are per repo and stored with the project, and the only
door to them was the Downloads sheet's rules pane — behind a picker holding
every repo, reached from a sheet about files that have already arrived. The repo
row's `⋯` menu in the launcher is where the question is actually asked, so it
has a *download rules* entry that opens the sheet on the rules pane with that
repo already chosen (`PullSheet`'s `rulesFor`). Read at mount only, and cleared
in `App` whenever the overlay is not that sheet: an ordinary tap on *downloads*
must still open on the files, not on a repo somebody picked ten minutes ago.

### `SetupSheet.tsx` — two sheets became one, and the seam is the comparator

There were two screens about one repo. The setup checklist asked *is this repo wired the way the
app expects*; the repo-health sheet asked *what has this repo been doing to itself*. Both were
reached from the same repo row, both were readings about the same thing, and choosing between them
required knowing which of two menu entries held the answer — which is exactly the knowledge nobody
has before they look. They are now one sheet, **`Repo readings`**, with two regions.

**What separates the regions is not time and not how the numbers are gathered. It is the
comparator**, and getting that wrong is what made the merge look impossible for a while:

- **Against the conventions** (`ComplianceCheck`). A fact about the repo against a line *somebody
  chose* — the `context-weight` threshold, "the transport dirs are gitignored", "no secret is
  tracked". A fact can be on the wrong side of a chosen line, so these rows have a status, a
  stripe, a place in the badge, and where the host can write the patch blind, a `fix`.
- **Against its own past** (the series). A fact about the repo against the same fact on earlier
  commits. `tools/repohealth/` holds no threshold and no grade *on purpose* — its constants header
  argues the case: the repo went 2.8k → 143k lines in 95 days, so any absolute number chosen in
  July is absurd in September and any number chosen today was chosen after seeing the plot it is
  meant to judge. There is therefore no side to be on, and region 2 has **no stripe, no status
  colour, no fourth status and no place in any count**.

That single distinction generates every other rule in the feature. It is why region 2's wording
lives in a module whose test bans verdict words (`repoHealthWords.ts`), why its geometry lives in a
module whose test bans the arithmetic of a reading (`repoHealthPlot.ts`), and why its drawing
(`RepoHealthTiles.tsx`) may not name `--warn` or `--dead`.

**Two reads, never one state.** Two `useRemoteResource` hooks on two keys, two `Empty`s, two age
lines, two write halves. "The checklist could not be read" and "the series could not be read" are
different sentences with different next actions, and a repo whose series 500s is not a repo whose
conventions are unknown. Sharing one resource would have made each region lie about the other
exactly half the time — and the same argument, one level down, is why a failed `fix` and a refused
refresh keep separate `error` strings rather than one.

**The region switch is a `.ts-filter` row of labelled `.key` chips**, lit with `.key.active`,
directly above the first thing it changes — `ContextSheet.tsx`'s control grammar, which also
supplies the warning that `.key.on` has no rule outside `.bl-modal-seg` and that a class name is a
claim about `styles.css` nothing checks. The repo picker sits *above* the switch, because it
changes what both regions are about.

`initialRegion` decides which one opens: the badge and the checklist entry land on `setup`, the
repo action row's *repo readings* entry lands on `series`. `RepoHealthMenuItem` moved into this
file with that entry, since the sheet it opens is this one, and **`RepoHealthSheet.tsx` is
DELETED** — its read, its poll, its refresh, its refusal band and its narrative moved here whole
rather than being rewritten, so the reasoning each of them carried is still under the same
comments.

#### The context-weight row is the proof the merge is real

`context-weight` is the one subject measured *both* ways, and today the two paths agree on the
number while differing in clock: the checklist weighs the working tree as it is now, the series
reports what it weighed at the last commit measured (CLAUDE.md 11,955 + 19 skill descriptions
10,146 = 22,101 chars at `bba067c`). So the row keeps its stripe — it quotes a threshold, and the
threshold is argued with right there in `ContextLimitsEditor` — and gains, underneath, the two
halves' own sparklines and the tool's rank sentence (`WeightTwin`).

**The two figures are printed by their clock and reconciled by nothing.** An uncommitted CLAUDE.md
edit showing up as a gap between them is precisely what a reader wants to see; averaging them,
preferring one, or hiding the difference would delete the only signal that the tree has moved since
the last reading. `bothClocksWords` is that sentence, and it has one wrinkle worth recording: the
working-tree figure is **not on the wire as a number**. `compliance.ts` states it inside the row's
own prose (`Every turn here carries 22.4k chars…`) and `ComplianceReport` carries no count. Prising
a figure back out of a sentence with a regex is a parser nobody would notice breaking, so the
clause names where that figure is instead of repeating it. The function already takes the number;
the day `ComplianceReport` carries an `alwaysOnChars`, passing it prints the two side by side with
no other change.

#### `focus: "findings"` — a count on a control is a filter

The repo badge says "3" off `isSetupFinding`, so a tap on it opens **exactly those three**, never
the whole checklist for the reader to re-derive them from. The cut then wears `.filter-bar`: what
it is hiding, `n of N` against the *unfiltered* list, and a *clear* button, which is the only way
back out. It is a tap and not a setting — it lives in state that dies with the sheet.

**Region 2 is untouched by it and says nothing about it.** A finding and a reading are not the same
kind of thing, and a filter named for one appearing to have cut the other is the same lie as a
badge that counts 3 over a list of 4.

That badge/list agreement is why **`isSetupFinding` is now the only spelling of the predicate**.
There were three: the host's `summarize()`, `setupRemedy.ts`'s `agentFindings`, and
`setupRemedy.ts`'s `patchFindings` — and the third omitted the host-scope exclusion entirely, so
"Fix all" counted the daemon's one Gemini credential as a finding in whichever repo was on screen,
beside a badge that has never counted it. All three read the shared predicate now. The credential
is still patchable from its own row, where it is stated; it is simply not a repo's finding.

#### `RepoHealthRegion.tsx` — the merge, split back into two files without undoing itself

Region 2 was about to grow — the tool it draws was mid-flight on new series when this file split —
and `SetupSheet.tsx` was already carrying both regions past this repo's 900-line lint cap. The same
shape of problem already happened once to this feature's drawing half (`RepoHealthTiles.tsx` grew
past the cap and `RepoHealthTable.tsx` came out of it), so the fix here is the same move at the next
level up: cut along the seam that was already load-bearing, not along a convenient line count.

**The seam is the one the section above spent its whole argument establishing — the comparator —
so this split could only ever be a file boundary, never a design one.** `SeriesRegion` (the series,
its narrative and its charts) and `RepoHealthMenuItem` (the repo action row's door into it) moved
out whole, comments and all, the same way `RepoHealthSheet.tsx` moved into `SetupSheet.tsx` whole
when *that* merge happened — a reasoning comment rewritten during a move is a reasoning comment that
might quietly stop being checked against the code it describes. `SetupSheet.tsx` keeps the sheet
itself: the region switch, both `useRemoteResource` hooks, `WeightTwin` (region 1's own reading of
the series, not region 2's), and the "why one sheet, two regions" argument this whole section is —
because all of that is about the MERGED sheet, and stays true regardless of which file draws region
2's half of it.

**`CLAUDE_MD_KEY` and `DESC_KEY` are exported from `SetupSheet.tsx` rather than duplicated**, because
`WeightTwin` (region 1, staying) and the always-on weight stack (region 2, moving) both have to mean
the same two series keys — a second pair of string literals in the new file is a second place that
pair can drift the day the tool renames one. Everything else that crossed the boundary — `ICON`,
`POLL_MS`, the read/poll/refresh reasoning, the staleness-in-commits rule, the refusal band, the
`seriesRemedyPrompt` question — belongs to region 2 alone and carried no shared state, so it moved
outright with no seam of its own.

One consequence worth naming for the next reader who greps for `RepoHealthMenuItem` and finds it
somewhere new: the sheet it opens is still `SetupSheet.tsx`, at `initialRegion: "series"`. The
button moved; the destination did not.

#### `RepoHealthCards.tsx` + `repoHealthFoldPlot.ts` + `repohealth.css` — the region as a dashboard

The owner's verdict on region 2 (2026-10-17) was that it read and looked boring: ~8,600 px of
charts separated by hairlines, each with its own drag instruction, with a block per day of notes
under all of it. The rework (`docs/analysis/repohealth-redesign.md`) made every section a CARD,
and the frame those cards sit in is `RepoHealthCards.tsx`, apart so the region stays under the
900-line cap:

- **A sticky jump bar** (`HealthNav`): one chip per card that is DRAWN, in screen order, then the
  refresh verb, which moved there from the head so it is in reach from any card. The chips are
  navigation, so they carry no count and no lit state, and an absent section has no chip — the
  same rule as a greyed button, applied to a jump.
- **One x-axis row** (`AxisRow`): `weeks | commits`, kept per device (`healthAxis`). `weeks` folds
  every per-day series to each ISO week's last reading through ONE function over the whole plot
  (`foldPlot`, which also cuts the longest file's holder names by the same indices, so a name never
  lands on another week's length); `commits` draws them whole. The readings table is never folded:
  it prints the readings as taken. `commits` is not offered where the desktop sends no commit
  series — the index section reports that up from its own read (`onCommits`), so the document is
  not fetched twice — and the sentence saying why stands where the chip would be.
- **The drag instruction once**, under that row. A readout line that nobody has touched now says
  the latest reading instead of repeating how to use it.
- **The daily notes as ONE closed row**, newest first when opened.
- **One frame, two surfaces.** The VS Code Health view (`packages/vscode/webview/HealthView.tsx`)
  draws its region from these same pieces — `HealthNav`, `AxisRow`, `SectionCard`, and
  `shownSections`/`navKeysOf`, the ONE answer to which cards are drawn. So the frame imports no
  `api.ts` and no `Markdown`: the daily notes moved to `RepoHealthNotes.tsx` (2026-10-17), because
  the extension's webview has neither and writes no narrative. The x axis is kept in the webview's
  own state there (`loadHealthAxis`), as `healthAxis` is per device here.

The CSS lives in `repohealth.css` rather than `styles.css`, every rule scoped under `.rh-region`:
a component's stylesheet is not guaranteed to land after `main.tsx`'s in the bundle, so the
overrides of the old rules (the tile hairlines, the index box's border, the bar names' ellipsis)
win on specificity, never on order. The VS Code view imports the same file and wraps itself in the
same class.

#### `OptInRegion.tsx` — region 3, offers that are counted in nothing

`shared/optins.ts` is the catalog of advanced things a repo can turn on (a requirements list, the
health series, a weekly security review, a pre-push hook…) and its header is the design. They are
not checklist rows because a repo without them is not BROKEN: a warn nobody can close is noise, so
they became a THIRD region of `Repo readings` with no stripe, no pass/warn/fail hue and no place in
the badge. `optInCut` is the one bucketing function — the cards (`offered`), the *On* rows, and the
two folded heads (*N you said not for me*, *N don't fit this repo*) all come from one call, so the
number on a fold is the list it opens. A tap never applies anything on its own: `fix` runs the
host's existing idempotent `complianceFix` and prints what it said, `open` switches to region 2 or
opens the capture sheet (through `core().nav.openCapture`, since features never import each other),
and `agent`/`schedule` SEED the Send sheet through `optInSeed.ts` — for a schedule, the weekly rule
in the phone's own zone (`DEVICE_TZ`), the catalog's model as the repo target's `launch.model` and
`waitUntilFree` — where words, clock and model can all still be changed. *walk me through these N…*
appears only when an agent could post at least two of them, and N counts every card, because the
prompt names every one. The repo menu's `OptInMenuItem` lands on this region, as
`RepoHealthMenuItem` lands on `series`.

### `repoHealthPlot.ts` — geometry that cannot compute a reading

`contextPlot.ts` already argues why a chart's scales and paths belong in a testable module with no
DOM in it: a chart is the one kind of view where being *slightly* wrong is invisible. This module
carries a second rule that matters more.

**Every reading is the tool's.** A value is read exactly two ways — its percentile rank inside its
own trailing window, and the sign of that window's slope — and both are defined once, in
`tools/repohealth/series.mjs`, beside a frozen constants block whose changes are made loud by a
committed fixture and a two-part commit. A percentile, a median, an OLS fit or a "since when"
computed on the phone would be a second definition of "is this getting worse" living outside that
mechanism: it would agree on the day it was written and drift silently the first time
`RANK_WINDOW_DAYS` moved, with every past day re-read and nothing saying so.

So `repoHealthPlot.test.mjs` asserts it **by text** — strip the comments, then check the code cannot
name a percentile, a rank, a slope, a median, a regression, or call `.sort()`. That is the same
shape of guard `tools/repohealth.test.mjs` uses to keep `judge.mjs` off the free path, and for the
same reason: a rule that is only prose fails silently, weeks later, in a diff nobody reads as a
change. If a chart wants a number the wire does not carry, the number is added to the tool.

The module has **no imports at all**, so `node --test` runs it straight over the TypeScript, and its
inputs are structural (`(number | null)[]` and small records) rather than the wire DTOs — the same
choice `repoHealthWords.ts` makes. `RepoHealthTiles.tsx` is the one seam where `@waterplane/shared`'s
`RepoHealthPlot*` meets it, so a shape change is a type error at one call site rather than a second
copy of the model.

Four rules the geometry encodes:

- **x is the reading index, never the calendar.** This repo's history has a 57-day hole in it; a
  calendar axis leaves two thirds of every 32px tile empty and squashes the readings into a smudge.
  The caption says so out loud (`plotAxisWords`), because a reader assumes a date axis otherwise.
- **A null cuts the line.** Never interpolated (a line through a measurement nobody took) and never
  drawn at zero (a collapse that never happened) — both are wrong in the direction a reader would
  act on. A reading with holes on either side has nothing to join to and is drawn as a dot rather
  than dropped, and a lone column of a *stack* is drawn as a hairline for the same reason: in a
  gappy history, "an empty polygon" is most of the chart silently disappearing.
- **A flat series draws at mid-height.** `(v - lo) / (hi - lo)` is 0/0 for a series that never
  moved, which renders as `NaN` in a path attribute and paints nothing at all — a measurement
  vanishing rather than reading as the measurement it is.
- **Each series is fitted to its own low and high.** The six tiles carry lines, chars, a
  dimensionless rate and a count; one shared axis across them would be a claim they are comparable.
  The stack and the dumbbell are the exceptions and are **zero-based**, because those quantities
  *are* magnitudes and a fitted floor would cut the bottom band off.

Stacks accumulate **in value space** and convert once — adding pixel heights lets each band round
independently and opens hairline gaps between bands meant to touch, which the reader sees as
missing data (`contextPlot.ts`'s `stackBands` and `statsPlot.ts`'s `stacks` state the same rule).
And a stack column where *any* band is absent is a hole in *every* band: the top edge of a stack is
a total, and a total short by an unknown amount is the one mark a reader takes as the sum.

`foldParts` is the categorical-palette guard in geometry form: four validated slots, and anything
past the fourth entity folds into one band with **no hue of its own**, drawn in ink and named in
the legend. Slots follow the caller's order — the tool sorts its packages by name — so a package
that grows past another never swaps colours with it.

#### The axes, and the thing a finger lands on

The tiles shipped without either. The user's words were "the x axis needs ticks so I know that the
time scale is… Y axis also needs labels and I need tooltips", and each of the three had a trap in
it that the obvious implementation walks into.

- **`indexTicks` places labels by POSITION and reads the day back.** Not by dividing the date span:
  x is reading order, so "half way along" is the middle READING. On this history the middle reading
  is 6 Sep and the middle of the span is around 4 Aug, and date arithmetic would print a caption
  under a place on the axis that day never occupied. It takes `want` with **no default** — how many
  labels fit is a fact about the box and the font, which belongs to the caller; a default here is
  this module holding a visual decision and a second copy of it at the call site. It dedupes by
  index, so a two-reading series gets two ticks rather than the same day twice at the same x.
- **`hiY`/`loY` (and the stack's `topY`/`zeroY`) exist so a label lands ON the line it names.** They
  are `py(hi)` and `py(lo)` — the same function the curve is drawn with, not a second copy of the
  half-pixel inset. A flat series returns both at mid-height, which is the caller's cue to print
  ONE label: two identical numbers on two edges read as a span.
- **`pts` carries the INDEX back, and holes are not in it.** A crosshair that could stop between
  readings would have to print something for a day nobody measured, and the only honest something
  is a blank. Snapping to the nearest reading means the readout always names a day that was read.
  The index rather than a copy of the point is what keeps this module free of the wire's shape — a
  readout can print a field this file has never heard of.
- **`nearestPlotted` has no cut-off distance.** A finger anywhere over the box picks something,
  because a crosshair that goes blank between points reads as a broken control rather than as a
  gap.

### `RepoHealthTiles.tsx` — the visual contract, and the hue that would have claimed the wrong thing

Paint only: geometry is `repoHealthPlot.ts`, every sentence is `repoHealthWords.ts`, and there is
**no charting library**. A library brings its own axis conventions, its own palette and its own idea
of what a missing point means, and "what a missing point means" is the one thing these charts must
not delegate.

- **Six stat tiles** — `size.p95`, `retouch.rate`, `hatches.perKloc`, `context.claudeMdChars`,
  `context.descChars`, `untested.count` — because the dataviz form table gives *a current value plus
  a trend* a stat tile and not a chart. The **value** is the answer, the sparkline is the context,
  and a tile whose series cannot be drawn still prints its number: a curve alone says "rising" and
  never "rising to what". `retouch.rate` carries its denominator in the same tile, from the tool's
  own `detail` — a rate never travels alone, and 1.000 over 6 touches and 0.69 over 216 are
  different claims the bare proportion cannot tell apart.
- **The curve is ink at 0.55 opacity; the end dot is `--accent` ringed in `var(--panel)`.**
  Deliberately **not** `--ctx-series`: that blue means *this conversation's tokens* on the launcher
  rows, the context sheet and the all-sessions screen, and wearing it here would claim these curves
  are about the same entity.
- **The crosshair is an INDEX in state, and the pixels are derived at every render.** Held as
  coordinates it survives a width change — the phone rotating, the sheet resizing — and then the
  ring is painted at the previous geometry's x while the readout still names the previous day: the
  two halves of one chart describing two different points, with nothing on screen saying so.
  `ContextChart` stores the *sample* and calls `p.px(...)` at paint for the same reason, and
  `repoHealthPlot.test.mjs` pins the arithmetic that makes it matter (the same reading is x=75 in a
  100-wide box and x=225 in a 300-wide one).
- **Lifting a finger does not clear the readout; moving a mouse away does.** `pointerleave` fires
  when a touch pointer is *destroyed*, i.e. the instant you lift — so one handler for both wipes
  the answer exactly when the finger stops covering it and the reader finally looks. A mouse has
  hover, so leaving the box genuinely means "not pointing at anything"; a touch has none, so the
  last thing touched IS the selection. `clearsOnLeave` is that one-line distinction. **The three
  older crosshairs in this app (`ContextChart`, and two in `TokenStatsSheet.tsx`) still clear on
  leave regardless of pointer type and therefore still have this bug on a phone.**
- **A gesture the browser takes back must not land as a choice.** A vertical scroll beginning over a
  tile fires `pointerdown` — which picks — and then `pointercancel` once the pan is claimed. Without
  restoring the pick that existed before the gesture, scrolling past six charts silently re-picks
  all six. A second touch on the reading already chosen clears it, which is the only way back out on
  a device with no hover.
- **The readout is a line of text under the chart, never a floating box.** `ContextChart`'s rule: an
  SVG tooltip cannot wrap, and on a phone a box that follows the finger is under the finger. It
  prints the day, the value and the **sha7** — every point on these curves is one commit, and a
  reading a person can check out is a reading they can argue with. Unlike the context chart there is
  no values table beside it, so this line is the only route to a past day's figure; that is why it
  is always present and says how to use it.
- **No status colour anywhere in region 2.** No `--warn`, no `--dead`, no band, no zone, no grade.
  The slope is a lucide glyph in `currentColor` with its word beside it, because **rising LOC and
  rising escape hatches are opposite news** and a hue would choose for the reader.
- **Always-on weight as two stacked bands** in the validated `SLOT` colours from
  `TokenComposition.tsx`, top edge = the total, two-entry legend plus a line swatch for the total
  itself. This is the one chart here that prints a total, **so it prints it as a split in the same
  mark** — the rule `TokenComposition.tsx` exists to enforce one screen over.
- **A per-area `expected → ceiling` dumbbell**, latest reading only, one x scale across the rows
  because the comparison is *between* areas. Two shades of one hue, the near end hollow. A dumbbell
  and not two bars: two bars invite reading the gap as a stack, and a bar of the difference hides
  the magnitude both ends are a fraction of. An area with no sub-skills (`shared`, `subs: 0`) has
  one number, not two, and the readout says so rather than drawing a zero-length bar.
- **The magnitudes, in the open.** They were behind a `<details>` once, on the argument that a
  sense of magnitude is acquired once and then carried. That was wrong twice over: a percentile is
  unreadable without the magnitude it is a percentile *of*, so the thing that makes the six tiles
  mean anything was the one thing a reader had to press for — and the LOC tape is *why this series
  exists*, the picture that gives a feel for how much there is to handle. Lines by package is now a
  **stack over time** (top edge = the whole tree) rather than a single-day bar; source files and
  production dependencies are curves with **no rank and no slope beside them**, because nothing
  compares them to anything and a tile's clothes would invite a reading nobody took. **p95 and the
  longest file are printed as words, not drawn as rules**: a dashed line means a threshold on every
  other chart in this app, and nobody chose either number.
- **`RepoHealthTable.tsx` — the same figures as text**, last 14 readings, oldest first so a row and
  the pixels above it run the same direction. Two of the four band hues are under 3:1 on a light
  surface, so the split has to be readable without the colour; and a crosshair answers for **one**
  day, which is no help when the question is how two days differ. Its packages are folded by the
  same `foldPartSeries` the stack uses — a table quietly keeping a fifth package the chart had
  merged would be two answers to "what is in this repo".
- **There is no *open the drawn page* button any more.** `tools/repohealth.mjs html` still writes
  `.claude/outbox/repohealth.html`, and it is still the better read on a desktop, but every card on
  it — the tape, the file count, the dependencies, the per-package split, and that numbers table,
  which was the last one missing — is now on this sheet. A control that sends a reader to a second
  surface to see what they are already looking at is a control that reads as *there is more over
  there*. The file is named in a sentence instead (`drawnPageWords`), in full, as this repo's
  transport-path rule requires.
- **Every metric carries a `?`** (`HintChip.tsx`), keyed `repohealth.<series key>` into the shared
  hint catalog, so the card, the text and the long-press route are the ones `hints.ts` already had —
  never a second copy of the words. A long press is the right affordance on a toolbar, where an icon
  you cannot guess is an icon you will probe, and the wrong one on a screen of **terms**: nothing
  about "p95" or "the re-touch rate" suggests an explanation exists to hold down for. A chip whose
  id has no entry renders nothing rather than a dead tap, which is why two checks exist —
  `tools/repohealth.test.mjs` fails if a series the tool emits has no entry (a text match: the tool
  is `.mjs`, the catalog is TypeScript, and a build step would let a stale `dist` answer a question
  about source), and `scripts/e2e-hints.mjs` learned to scan `<HintChip id="…">` and the `hint="…"`
  prop a component hands down to one, since both are invisible to a `data-hint=` scan.
- **Every SVG takes a measured width**, like `ContextChart` — never a fixed viewBox stretched with
  `preserveAspectRatio="none"`, which distorts the stroke and the text along with the curve on the
  one device that rotates. `SeriesRegion` measures one box through a **callback ref**, not
  `useRef` + a mount effect: the box lives inside a conditional and the series arrives
  asynchronously, so on the first commit there is no node to observe and a `[]`-deps effect never
  looks again (`ContextSheet.tsx` shipped exactly that, and both its charts rendered nothing).

**What is deliberately not plotted**, said at the foot with its reason rather than left as an
apparent oversight: the tripwires (events on one day, not a series), the path lists (co-change
hotspots, duplicate pairs, untested modules, dead exports, re-touch offenders — their top three
already ride in the `detail` sentence under the reading they belong to, the rest are in the
narrative), and `dups.pairsPerKloc` and `cochange`, which the tool reads **without a rank**: a
sparkline under them would invite the reader to supply the reading nothing measured.

### `RepoHealthLongest.tsx` — the longest file leads, and says when it changed hands

The longest-files tape used to sit at the foot of region 2, under every tile and every stack. It is
the single clearest sign of a tree whose changes keep landing in one file, so it moved to the TOP,
and gained a curve: the length of the longest file at every reading.

A length alone cannot tell "App.tsx grew 400 lines" from "a different file took the top spot" — the
second is what a split looks like, and it can leave the number almost unchanged. So the tool now
emits `longest.paths`, the holder's path index for index with `longest.points` (parsed optional,
and dropped whole if its length differs: a list one short pins every later name on the wrong day).
`holderGeom` in `repoHealthPlot.ts` cuts the curve into one run per holder:

- **Slots go to the newest holders.** Today's file is slot 0 on every repo; past four holders the
  OLDEST fold into ink, never a generated fifth hue.
- **A handover is marked only between two NAMED readings.** A reading with no name next to one with
  a name is not evidence the file changed, so it is an ink run and never a ring.
- The handover is a solid ring in the new holder's hue plus a thin ink step from the old holder's
  last point — solid because dashes mean a threshold on this sheet.
- No `paths` on the wire (older engine) ⇒ one ink run, and the caption says a new holder cannot be
  told from growth rather than drawing one colour as if it were one file.

The crosshair line names day · length · FILE · commit; the legend lists each holder with how many
readings it held. The tape (today's distribution) sits directly under the curve.

### `repoHealthWords.ts` — every sentence, under a test that bans verdicts

The tool's own test fails the build if "good", "bad", "healthy", "grade" or "should" appears in what
it writes. A phone screen is where that discipline is easiest to lose, and none of the ways to lose
it would fail a test living in `tools/`: an amber band, a chip reading "stale", a caption saying
"getting worse". So the phone's half of the wording is a module the phone's own test holds to the
same ban — extended with "worse", "better", "improve" and "regress", the comparatives a screen
reaches for that prose does not — and the sheet is left with no string literals to slip one into.
A second assertion checks the module's source never names `--warn`, `--dead`, `--limit` or `--ok`:
region 2 has no status to carry.

Region 2 added these, and three are worth recording:

- **`rankSentence` is the ONE conversion from a rank fraction to a percentile on this side of the
  wire.** `narrate.mjs` keeps its own `pct` to a single call site and its header says what two of
  them cost: every percentile in production printed `0th` for months because a second conversion
  existed and the tests exercised the copy production did not use. The wire therefore carries the
  rank as a fraction in [0,1] and this is the only place the phone turns one into a number a person
  reads. **A null rank returns the tool's own `reason` and never a `0th percentile`** — those are
  opposite claims: too little history to place the value, versus the lowest value ever recorded.
- **`tileAbsentWords` is four sentences, not one blank box.** The family read nothing on the latest
  day (the metric's own reason, quoted), the series holds no reading at all, the history is too
  short to draw a curve, and the value stands alone. Their next actions differ.
- **Absences that are sentences, one per case**: no tool in this repo and a desktop too old to say
  (both `@waterplane/shared`'s, beside the availability helper, because they are facts about the wire);
  `plot` absent versus `plot: null` versus an object, resolved through `repoHealthPlotAvailability`
  — **three states, and the third is not a shrug**, exactly as `hasRepoHealth` already worked; a
  family absent; fewer than two readings; behind HEAD in **commits, never days**; and a mixed
  `PREREG_VERSION`, where the charts are **still drawn** over the rows on disk with
  `mixedPlotWords` saying so. Refusing to draw a mixed series would remove the only view of the
  problem the band above it describes.
- **`engineLineWords` says "nothing was recognised here" in words, and reads it off the COUNTS.**
  It had a branch for an empty pack list that cannot happen — the always-on `common` pack is in
  every census — so what a repo with no recognised language actually printed was `packs common 0`,
  a figure a reader has to decode, while the tiles beside it said it properly ("no active pack
  reads this tree's source"). The state is now detected without the phone holding a copy of which
  pack is the always-on one: a pack with extensions activates only on files ending in one, so an
  active pack the census counted at **0** claims no extension at all, and every active pack at 0
  is a tree this engine read nothing of. The pack is still named — a reader has to see what WAS
  active — and the census legend goes with the figures it explained. Verified against
  `node tools/repohealth.mjs --root=~/code/smoke status`, which is exactly one pack at zero.
- **`areaRowWords` prefers the area's OWN reason to its own guess.** Two ways to have no
  `expected` were printing as one sentence: an area nobody has committed to yet (true, and one
  commit fixes it) and an area whose router description names no source group, where no commit can
  EVER be attributed and "no commit has touched this area yet" is false and invites waiting. The
  metric states which (`RepoHealthArea.reason`); the phone only ever sees the nulls. The numbers
  the area DOES have still print beside it — `ceiling` is a real reading of the tree even where
  nothing can be attributed.
- **A band in the stack is a source GROUP, not a package.** `packageStackWords` said "package"
  four times, from when the only tree this engine could read was this one and every band was a
  workspace. The bands are the engine's source groups — the top-level boundaries it derives at
  HEAD — and on this repo they include `tools`, `deploy` and `.`; on a Flutter or Kotlin tree not
  one of them is a package. The wire field is still called `packages` and that is not worth a
  migration; the card's title and its caption are what a reader is told they are looking at, and
  that has to be true.
- **The per-area panel has three states and two of them used to draw nothing.** `AreaSpread`
  returns `null` on an empty `areas` map, so a repo with no `<router>-*` convention — which is
  most repos on this desktop — got no chart, no chip and no sentence. The family unread on the
  latest day is one caption (`context.absent`); a family that WAS read and yielded no areas is a
  different one, and the tool states which in `context.areasAbsent`. Where even that is absent the
  panel still says there are no per-area readings and that the weight above is unaffected: a chart
  that is simply not there reads as a chart that failed.

### `setupRemedy.ts` grew the other region's verb: a reading is a question, never a brief

*Hand it to the agent* keeps its scope — setup findings only. A series row gets a different verb,
*ask the agent about this…*, through the same `onRemedy` path into the same send sheet, seeded by
`seriesRemedyPrompt`.

It is a different prompt because it answers a different kind of statement. A finding has a line
behind it, so "close it" is a coherent instruction. A reading has none, so the prompt **asks for an
explanation and a proposal and authorises no change**: *change no file, run no fix, commit nothing*,
and "this is an artefact of how it is measured" is named as a valid answer. A reading that arrives
on a phone and quietly starts an edit is the "nothing applies itself" failure one step further out
than the setup half — there is not even a finding to justify it.

The tool's **rank sentence and `detail` are quoted verbatim**, for the reason `remedyPrompt` quotes
a check's own `detail`: the window size, the day it opens, the denominator and the file names are
the only part that says what is actually being claimed, and a paraphrase of a measurement is a
measurement with the evidence removed. The sentence is passed *in* rather than rebuilt, so "quotes
it verbatim" is a property the test checks against an arbitrary string rather than two wordings
kept in step by hand. Nothing is sent by the tap.

## A waiting row could not say the answer was already written

Two situations looked identical in the launcher: a session waiting for you, and
a session waiting for you **with the reply already written and on a clock**. The
second is the reason somebody is not typing, and the rows that say so live on
the desktop, in a sheet two taps away, keyed by repo — nowhere near the row that
is waiting. With fifteen repos on screen that is not a fact anybody holds in
their head.

`scheduledReply.ts` is the one reading behind all three marks: the chip on the
session row, the dot on a repo group's *N waiting* pill, and the dot on the
header's *N waiting* chip. One function, so the three cannot disagree — the
failure `clockCuts.ts` was written to end one sheet over, where three
hand-rolled copies of "this row is on a clock" said **13 · 8 · 2** about one set
of rows.

What counts is narrow on purpose: a row with a CLOCK, still expecting to run,
not archived, and aimed at THAT SESSION. A clock row aimed at the repo opens a
session of its own and never reaches the one that is waiting, so it may not mark
it; an untimed row aimed at the session is a send that has not gone yet, which
the queue already says elsewhere.

**The chip carries the count and the tap; the pills carry a dot and neither.**
*5 waiting* is already a count and already the filter for those five, so a
second number beside it would be a filter with no second tap to spend on it. The
chip's count IS a filter in the house sense — it opens exactly those rows
(`openBacklogCut` with their ids), never the repo's backlog for the reader to
find them in.

The send side of the same change is in [host.md](host.md#a-clock-may-name-a-session-because-the-conversation-outlives-it):
`scheduleReaim` / `seedReaim` / `reaimWords` are gone, `clockSessionNote` says
what a clock aimed at a session will do instead, and `whenRoute` sends that pair
to `patch`/`post` rather than `upsert` — `ScheduleEntry` cannot name a session,
so it rides `intent.post`, and posting is at-most-once by id (a re-time through
it would report success and change nothing).

## Plugins on the phone, and the decision log (`features/plugins`)

The Gemini decision oracle was core code with its own wire (`oracle.*`), its own settings rows, two
toolbar chips (`oracle`, `propose`), a row tag and a log sheet. It is a plugin now
([plugins.md](plugins.md)), and the phone side became generic: `features/plugins` draws whatever an
installed plugin DECLARES, and the phone never runs a line of plugin code — a plugin cannot break the
app, and the APK's verified bundle stays the only JS it executes.

- **`PluginsSettings.tsx` — one catalogued row, a section per plugin inside it.** A plugin's fields
  are dynamic, and `settingsIndex.test.mjs` requires every rendered row id to be in the catalogue,
  so a row id per field cannot exist. The one row `plugins` (Tools, after the rack; keywords carry
  "oracle" and "gemini" so the old search still lands) holds the plugin sections as NESTED controls
  with no id, which `SettingsKit` counts under their parent. Per plugin: name, version, description,
  the source path (so "which copy is this?" has an answer), the state — a load error VERBATIM, never
  paraphrased — the enable switch, its status line, env names with set/unset (never a value), its
  fields drawn by kind, and its global actions. `plugin.set` carries ONLY the changed key, and
  nothing when the value did not change. A typed number outside its range is refused in words
  (`parseFieldInput`), never clamped into a number nobody typed; a host refusal (`plugin.error`)
  shows in the same place. Number and text fields are drafts until *save*, and a host push does not
  overwrite a draft being typed; *reset to default* arms twice because a stored text (a system
  prompt) may be the only copy. Empty: "No plugins installed", and where they go.
- **`PluginsToolbar.tsx` — the session menu's `plugins` entry**, where the oracle's chip was, and
  `PluginBadges` on a launcher row, where its tag was. Per ACTIVE plugin: its toggles, the core's
  own "let <name> answer" switch when the manifest declared `answers` (default off, and always with
  the sentence that core still refuses permission/plan/trust/destructive boxes — the gate is
  core's, `answerGate`, and the switch is only one of its conditions), and its session actions. A
  toggle flipped back onto its default is sent as `null`, so the session follows a later change of
  default instead of pinning today's. Switches never shut the menu; an action is a choice and does.
- **`DecisionLogSheet.tsx` — the decision log** (overlay `decisions`), the old oracle log made
  generic: usage-limit rows (blocked → attempt → resumed / gave up) and plugin rows (the plugin's
  own outcome word, coloured when known, shown as itself when not). The source chips are FILTERS,
  and the cut says "n of N" with a clear button (`cutDecisions`, one function feeding both the list
  and the numbers). Reached from the launcher menu (`decisions`) and Tools' rack.
- **`suggestionBy.ts`** — a suggestion says WHO suggested (`byName`), and the model only when the
  plugin named one. It used to be the model id alone, which named no one once anything but the
  oracle could suggest.
- Legacy: sent-log rows with `source: "oracle"` still render, labelled as legacy, beside the new
  `plugin` source; the notification kind `oracle` became `plugin`.

## Modules a skill names but this file never covered

Written from the modules' own headers, same rule as [host.md](host.md#modules-claudemd-links-here-for-and-this-file-never-covered).

### `hosts.ts` + `hostBoot.ts` — several desktops, one phone

`hosts.ts` is the storage half of `shared/hosts.ts`: one host ACTIVE (bare `waterplane.*` keys), every
other PARKED under `waterplane.h.<id>.` (`storage.ts`'s `KEY_SCOPE` says which keys follow the host and
which the phone). A switch is two phases split by a reload — the asking page only writes
`waterplane.hostSwitch` and reloads, so no pagehide flush of the OLD host's memory can land in the NEW
host's bare keys. `hostBoot.ts` is a side-effect module and deliberately the FIRST import of
`main.tsx`: the park/restore has to run before any other module reads a host key into memory, and ES
modules evaluate in import order, so being first is the whole mechanism. Removing a host never
deletes its words — its row moves to `waterplane.hostsGone` so re-adding the same address restores its id
and everything parked under it. Android shell only; a browser is served BY one host and this module
is never asked anything. Screens over it: `features/hosts/` (own [README](../../packages/web/src/features/hosts/README.md)).

### `shellNet.ts` — which network the phone is on

The page's half of the Android `ShellNet` plugin (`packages/app`'s `ShellNetPlugin.java`, documented
in [`packages/app/README.md`](../../packages/app/README.md)). `current()`/`requestLocation()` resolve
a `NetState` (`shared/lanroute.ts`'s contract); the Wi-Fi name needs the location permission, so
`ssid` is `null` without it, never a guess. `window.shellNetChanged(state)` arrives as a JS
OBJECT, debounced, only on change, and is re-dispatched as the `app:shell-net` DOM event so a
listener needs no import from here. Inert in a browser: no plugin, every read resolves `null`.

### `lanRoute.ts` + `lanLink.ts` + `deviceToken.ts` + `hostRoute.ts` — taking the LAN route, and saying so

`lanRoute.ts` is the pure evidence-gathering half of `shared/lanroute.ts`'s decision: saved LAN +
auto on → matching SSID → a device token → the LAN identity → an `/api/health` probe →
`/api/lan/verify`'s HMAC, checked with WebCrypto — stopping at the first "no". `lanLink.ts` is the
runtime wiring: triggers (start, a shell net-change event, every socket reopen, a LAN failure), a
verified LAN is the only way onto the LAN, and a socket that drops while on the LAN reconnects to the
tailnet first and re-runs the ladder on that `welcome` — so the MAC is checked before every LAN
connect, not once per install. `deviceToken.ts` holds this phone's token for the active host (minted
over the tailnet, never sent to any origin but the host base, and never before the LAN address's MAC
checked out) and carries it as `Authorization: Bearer` and a `waterplane-tok.<tok>` WebSocket subprotocol.
`hostRoute.ts` is the one-writer store (`lanLink.ts` writes it) the route chips read: the connection
strip, the health sheet, and `features/hosts`' launcher menu row and switcher sheet.

### `features/hosts/` — the screens over the multi-host and pairing state

Host switcher, launcher menu row, session-header host name, Settings → Connection's "hosts" /
"pair another phone" / "paired devices" rows, the QR sheet (`HostQrSheet.tsx`, `qrcode-generator`)
and the paired-device list with revoke (`PairedDevicesSheet.tsx`). The folder documents itself —
read its own [README](../../packages/web/src/features/hosts/README.md) first, per the router's rule
that a feature folder takes the sub-skill of the module it wraps.

### `secretAsk.ts` — a password asked on a shell's screen

Reported from a phone: `sudo` printed `Password:`, the password was typed into the ordinary compose
box — in clear, with the keyboard capitalising its first letter — and then sat in the up-arrow
history (and, until acked, in the outbox and the saved draft). `secretAsk()` reads the cursor's row
up to the cursor (`Terminal`'s `onCursorLine`, at the same settle as the screen snapshot) and answers
only when that row ENDS with the ask — a program waiting on the line it just printed; a mention
mid-sentence or a prompt scrolled up a row is not one. While it answers, `useCompose` swaps the
draft box for a masked `<input type=password>` (an eye reveals it; `autocapitalize=none`, no
autocorrect) whose words are its own state: never `compose`, never `saveDraft`, never
`pushHistory`, never an outbox row. They go as raw keys through `sendInput` — the CLI pipe's path,
not a new one — because a password is the answer to a prompt that is waiting NOW: queued behind a
dead link it would be typed into whatever is on screen when the link returns, so offline refuses in
words. A false hit only masks a box, and `not a password` hides it until that ask goes. Shell
sessions only: claude's TUI draws the typed words on its own cursor line, so a prompt ending in
"password:" would read as an ask there. Shell composers also drop autocapitalize/autocorrect — a
shell takes commands, not sentences.

### `strayKeys.ts` — a desktop key typed at nothing goes to the terminal

The owner, on a 1430px window: *"if the user is on a pc with a keyboard he will expect that his key
strokes also work and not only the on screen buttons."* xterm already piped its OWN keys
(`Terminal.tsx`'s `onData` → `sendInput` → `session.input`) — measured in the demo, a click on the
grid and typing reached the CLI. What went nowhere was a key that landed on NO field: focus on
`<body>`, or on a sidebar button just clicked. That key now takes the same raw pipe (no new send
path; deliberately not durable, same as every other keystroke) and the terminal then takes focus,
so the rest of the word is xterm's.

What is never forwarded, and why: a stray **Esc** or **Ctrl+C** interrupts a running turn, and a
desktop hand presses Esc out of habit (the reason `Workspace.tsx` keeps Esc from leaving a
session) — so every Ctrl/Alt/Meta chord and Esc reach the CLI only from the FOCUSED grid. **Tab**
stays the browser's focus navigation, **Enter/Space on a button** activate it. The decision runs
after every other keydown handler (`escape.ts`'s `setTimeout(0)`), so a component that answered the
key has called `preventDefault()` by then, and it stands down while a side panel, a dialog or a
confirm is over the grid. Mounted by `TermArea.tsx` only while the grid is the view (not the
reader, not a pending session) — on a phone the session screen unmounts under a sheet, and a soft
keyboard cannot type at `<body>`, so the phone never meets it.

Two companions: the focused grid says so in words in its corner (wide CSS — a ring alone does not
say what the keys will do), and Ctrl+C over a SELECTION copies it (`attachCustomKeyEventHandler`)
instead of interrupting — what every desktop terminal does. Pure decision + listener tested in
`strayKeys.test.mjs`; the desktop journey asserts the hand-off.

## Billing profiles and dollar periods (2026-10-15, plan: docs/plans/billing-periods.md phase 3)

An API-key, Bedrock or Vertex account has no 5-hour or weekly window, so `?` chips and an empty weekly
card were a lie by omission. What the phone draws is decided by `hasScrapedWindows(profile)` (shared):
subscription, `unknown` and an older host that never sends `billing.status` keep the two windows
pixel for pixel; api/cloud draw the primary dollar period instead.

- **The chip** (`features/tokens/logic.ts` `usageFace`, `periodWords.ts` `periodChip`): `Oct $412 / $2000 ·
  on pace`, from the primary period (`primaryUsdPeriod`: capped before uncapped, then month, rolling 30
  days, week, day, span). A period nobody measured has NO chip; with none measured the chip is the bare
  gauge, a door into token statistics. Never `?`, never `$0`.
- **The card** (`PeriodCard.tsx`, token-stats extension): the host's cost window over the period (the
  host reads at most 35 days; a longer span says so in words). The hero is the document's own total, the
  composition strip is its split, and the repo and model rows fold the host's capped `rest`, so every row
  list adds up to the hero. Pacing (`pacing`, `pacingLine`) is shared's `linearPace` / `perDayLeft` /
  `projectedEnd` and is absent without a cap, without a reset edge, or in the first tenth of a period. The
  caveat that this is the local ledger at list price and not the invoice is the caption, once. On an
  api/cloud account with no configured period the card falls back to the calendar month in the phone's
  zone, uncapped, so it answers before anything is set up (the chip waits for a measured period).
  The week card and limit bars are not drawn on such an account; on a subscription host with a dollar
  period both cards show.
- **Settings** (`features/tokens/BillingSettings.tsx`): the profile (auto-detect or override; the note says
  what was detected) and the periods + caps form. Caps go out through `withLimit` / `withoutLimit` as a
  whole `budget.set`; a refusal is a sentence beside the field, never a clamp. The percent budget rows
  (session, weekly, leftovers) are absent on api/cloud. A cap holds automatic work only.


## Moved out of skill `web-config` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

### LocalRtBar.tsx + sysStat.ts — the free-memory caption

the caption **leads with AVAILABLE and still names FREE** (33 GB against the 1.1 GB that started this) with one wording per `source`

### ModelField.tsx + LaunchAskSheet.tsx — why the ask gates every fresh start

 — `openRepo` and `startSessionWithPrompt` build their own
  create, and gating only `openCwd` left the switch doing nothing for the launcher row.

### SettingsKit.tsx — the group that skipped its rows

— one did, and the rows inside never counted
  themselves, so the filter bar read **"1 of 8" on a screen holding 54**; only the SECTION hides

### HintChip.tsx — why a visible chip beside the long press

Long press is the right affordance for a
  toolbar, where an icon you cannot guess is one you will probe, and the wrong one for a screen of
  TERMS, where nothing suggests an explanation is there to hold down for. It carries

### `CliHealthChip.tsx`, `ModelWheel.tsx`, `ModelSheet.tsx` and `SettingsGroups.tsx` — files the config skill now names

- `features/cliHealth/CliHealthChip.tsx` is the launcher topbar chip over the health rollup; `healthy` and `unknown` render nothing (`chipShown`). It sits on the topbar, not beside "N at limit", because that chip lives inside a section that is absent when no session is live.
- `core/session/ModelWheel.tsx` is the live session's model + effort wheel popover (Apply lands it; `planPick` types `/model` and `/effort` through the queue where the CLI has them, `launch.relaunch` only where it does not). `core/launch/ModelSheet.tsx` is the "Switch model" overlay for the session on screen, chosen by what the backend HAS.
- `core/settings/SettingsGroups.tsx` holds the bodies of the three device-preference Settings groups (appearance, typing and reading, offline); the `<SetGroup>` tags and their ORDER stay in `SettingsSheet.tsx`, which `settingsIndex.test.mjs` reads.

### `brandMigrate.ts` — the rename's one-shot copy

`boot/brandMigrate.ts` runs first in `hostBoot.ts` (`runBrandMigration()`): every legacy-prefixed localStorage key is COPIED to the new prefix (never moved, never over a key the new name already has) and the `syncTs` stamps are rewritten to match; `copyLegacyStores()` does the same for the IndexedDB stores, awaited by `idb.ts` before it opens, and lists a target only after its copy finished so an interrupted run repeats safely. The copy itself is shared `brandmigrate.ts`.

### `pqKem.ts`, `nativeKeystore.ts` and `PairForm.tsx` — pairing and keys

`pqKem.ts` is ML-KEM-768 (FIPS 203), generic: key pair, encapsulate, decapsulate, knowing nothing about what the secret is for; the caller hybridises it with an ECDH exchange so the result holds while either holds. WebCrypto's own ML-KEM when the WebView has it (feature-detected by making a key), else `@noble/post-quantum`, evaluated lazily but packaged in the static vendor chunk so it is on the phone with the link gone. The private half stays in the closure. `nativeKeystore.ts` is the page half of `ShellKeystorePlugin`: an AES-256-GCM key in the Android Keystore bound per use to a strong biometric, wrap/unwrap bytes only; every refusal is a `KEYSTORE_CODES` word, and a browser or older APK says `unavailable`. `PairForm.tsx` is the form that redeems a pairing code (`pairRedeem.ts`) and switches to the new host.

### `askRules.ts` and `AskRulesHere.tsx` — ask rules on the phone

The list of ask rules lives on the desktop (`GET/PUT /api/askrules`; the PUT is bound to the list's `rev` and confirm-gated); the phone edits a copy and sends the whole list back. `askRules.ts` is the pure half: every function returns the NEXT list for a tap to send, and suggested rules are added only by a tap. `AskRulesHere.tsx` is the per-repo half in Repo readings (one on/off per rule, written as `offIn` with the repo's `worktreePath`). A running session keeps the rules it launched with, and a refusal is the host's sentence verbatim. Plan: docs/plans/agent-authority.md section 2.

### Second trim pass: measured numbers and incident stories cut from the skill (verbatim)

- SettingsKit.tsx (full original bullet): - `SettingsKit.tsx` + `settingsIndex.ts` — **the Settings screen: one component per KIND of   decision, and a catalogue of what is on it.** A boolean was once spelled eleven ways and picking one of N four ([web.md](web.md#moved-out-of-skill-web-config-2026-10-17)); and **an ACTION was   a bare `.key` — pixel-identical to a switch that is off**, so `token statistics` (a door) and   `data saver: off` (a switch) were the same rectangle. Now: `SetSwitch` (label left, `on`/`off`   pinned RIGHT, whole row the target) · `SetChoice` (chips, never a `<select>` — a drop-down hides   the alternatives, which is how `localRt`'s third mode was invisible) · `SetPick` (the ONE place a   `<select>` is right: a long or open list) · `SetMulti` (SEVERAL of a closed set — chips that latch; what an empty pick falls back to is in the NOTE, never a dimmed chip) · `SetStepper` (absent at the ends) · `SetSlider`   (always with its readout) · `SetCustom` (a body no kind fits; still a catalogued row) · `SetAction` (**never wears the accent** — that colour means *on* — and   a chevron ONLY when it opens another screen). `disabled` is gone from three rows: `cant` draws the   REASON where the button was (`Unavailable.tsx`), `busy` is a running verb in its own glyph.   **`SetNote` folds all but one line** into `hint-more`; **`SetWarn` never folds** — an absence and   a warning are what must be read unasked. **Search is `settingsIndex.ts`** — keywords carry the   words the LABELS do not; its matching rules (AND, substring, no group keywords, group title   matches) are pinned by `settingsIndex.test.mjs`.   **A group never skips rendering its rows** (one did, and the filter bar read "1 of 8" on a screen holding 54); only the SECTION hides   (`gone`, exact and `:has()`-free, plus a `:has()` rule for a group whose every row is absent).   **The counts are the RENDER's, never the catalogue's length** (a third of the rows are   conditional): rows push their ids into a tally, and `SetFilterBar` is drawn LAST and floated up   with `order: -1` so it reads this pass rather than trailing a `useEffect`. Screen ⇄ catalogue   ⇄ manifest group agreement is `settingsIndex.test.mjs`'s. The screen is SEVEN groups (`SETTING_GROUPS`; their ORDER is `core/settings/SettingsSheet.tsx`'s, which `settingsIndex.test.mjs` reads); the three always-on strips live in Appearance.   **`local-sessions`** (*local model sessions at once*: desktop default · 1 · 2 · 3 · no limit) writes the synced `LOCAL_SESSIONS_KEY` (`localSessionsSetting`, `""` deletes the key ⇒ the desktop's `WATERPLANE_LOCAL_SESSIONS`, else 1); the host's `localslot.ts` reads it.
- LocalRtBar.tsx (full original bullet): - `LocalRtBar.tsx` + `localRt.ts` + `sysStat.ts` —   **the local runner as a strip**, the link store's shape: one store,   one writer, **observes and never steers**. **FIVE states worded apart, never collapsed** (holding ·   up-and-holding-nothing · did-not-answer · polling-off-here · this-desktop-never-answered); **misses   DRAWN never averaged or bridged**; **ring is MEMORY-ONLY**, only the last sample persists so an   offline open says its age. **THREE modes** (`off`/`while a model is loaded`/`always on`): `always`   is its OWN choice, not a stronger `auto` — auto's vanishing act makes watching a model NOT be there   impossible, and a bar that hides for both can only report good news; auto LINGERS past an eviction;   the row SAYS auto still polls. **Strip the provider prefix at the FIRST `/`** or the resident model   looks absent and the pressure note lies. The pressure note is a SENTENCE, never a block.   **Tokens/sec absent, no placeholder.** `sysStat.ts` is the DESKTOP half of the sheet   (`host/sysstat.ts` measures it): **the memory bar always adds up to the machine** — slices against   the total, remainder as one explicit *available*, an overshoot CLAMPED never drawn past the end —   **a slice nobody measured is not drawn** (no 0-byte row standing for an absent reader), the caption   **leads with AVAILABLE and still names FREE** with one   wording per `source`, **CPU busy and the load average are BOTH drawn and worded apart** (busy names   its interval; the first sample of a watch has no delta and falls back to load), **process rows are   a FOLD** (`23 processes`, never a pid standing for one) with `rssSumText` saying the column   overlaps, the slow readers **say their age** (`slowAgeSec`), and an absent temperature is a   SENTENCE naming the helper, never a blank. `sysStat.test.mjs`.
- ModelField.tsx / LaunchAskSheet.tsx (full original bullet): - `ModelField.tsx` + `LaunchAskSheet.tsx` + `LaunchPicker.tsx` — **choosing a model, and choosing WHEN to be asked.**   (The live session's switch is `core/session/ModelWheel.tsx` and `core/launch/ModelSheet.tsx`.)   `LaunchPicker` is the backend/wheel/effort/version set, ONCE: the ask and the fan-out's sweep row   both draw it (they were two looks for one decision); the caller owns the pick and what is remembered.   `ModelField` is the one model control before a session exists (new-session defaults + the ask):   ONE drop-down with *Aliases* and *Versions*, the typed field only for a genuinely empty catalogue,   and **a stored id the catalogue does not name shown as ITSELF** — a `<select>` whose value matches   no option renders as the first, so it would otherwise read back as "default". `LaunchAskSheet` is   `waterplane.launchAsk` (synced, **off by default**): a fresh open stops and asks backend + model,   starting from the defaults. **The answer is for that launch only** — it never writes the defaults   back — **but it IS remembered**: `LS.launchLast` (per DESKTOP — class `host` in `storage.ts`, parked on a host switch — not synced) holds the last answered   pair and `launchAskStart` starts the controls on it, dropping it **as a pair** when the backend is   one this host does not describe (a `<select>` off its options renders as the FIRST, so the control   would say claude while the create carried opencode). Its controls are **`.set-row`, never a bare   `<label>`** — that class is where labelled-control styling lives and `.form` has no gutter.   **Never on a resume and never over a caller that already decided** (`shouldAskLaunch`, pure   and tested; a resumed conversation carries its recorded launch). **Nothing is queued while it is   up**, so closing starts nothing and the overlay is deliberately not reload-restored. **The gate is   EVERY fresh start's, not `openCwd`'s** (`openRepo` and `startSessionWithPrompt` build their own create). One helper   (`askLaunchFirst`), callers hand over the rest of their own tap; `createOp.test.mjs` fails by name   on a fourth start site. Fan-out is out of scope: a sweep is ONE decision over N repos.
- resumeIdOf: read as `claudeSessionId` alone (all four taps were), an opencode row names no id, falls through to the directory's `--continue` and, with two closed conversations in one repo, the OLDER row reopens the NEWER one — silently.
- PluginsSettings.tsx: a plugin's fields are dynamic, so a new catalogue row per plugin would fail `settingsIndex.test.mjs` and could never be searched.
- ModelField disclaimer: the second trigger (the current value is hosted) is the case that matters; a restated third-party data policy changes, and the app would be asserting something untrue about code already sent.

## Moved out of skill `web-files` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

### annKnobs.ts — provenance

an arrow/line wears a knob per END instead of size + turn (owner, 2026-10-15)

### installPolicy.ts — why it exists

The transport already
  put a fresh build on the phone; what was left was four taps per build, per app. **One dialog per
  app, EVER**

### installPolicy.ts — the platform mechanics

 — API 31's `USER_ACTION_NOT_REQUIRED` + `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, plus API 34's update
  OWNERSHIP, which is requested on the loud install that buys it. **A refused silence is not a
  failure** — it returns `STATUS_PENDING_USER_ACTION` carrying the same confirm intent, so asking can
  never cost an install; a confirmation that cannot be raised from the background becomes a
  NOTIFICATION and the row reads *waiting for you to confirm*, never *failed*.

### storagePlan.ts — the dead stat

`SweepSheet` for the desktop's transport dirs; this is the same question
  about the device, where `used 340 MB` was a dead stat on a screen somebody had opened looking for
  something to act on. **Two kinds

### SweepSheet.tsx — the measurement behind it

the
  bulk answer to 6.8 GB of transport files across fourteen repos. **Nothing

### SweepSheet.tsx — bytes beside counts

 — 27 of 31 files reads as "most", and was 97% of the size

### sweepfamilies.ts — the measurement

33 of
  one repo's 38 outbox files are APKs across 13 families; another holds ONE family of 72. `keep the
  newest N of each`

### `pasteImages.ts` — which pasted files are a picture someone meant to send

Ctrl+V of a screenshot on a desktop takes the picker's route (`routeFiles`): one image to the annotator, several to the combine-or-not question. Text wins: Office and many editors put a rendered PNG of the selection on the clipboard beside its text, so any non-blank `text/plain` leaves the paste to the textarea (`pastedFiles` drops the pictures, never other files). The ONE paste handler is `useFileDrop.ts`'s document listener: `ComposeBar.tsx` had a second, which routed a picture the listener then took again, and skipped the annotator-busy question so a paste into the box beside the annotator replaced the picture being marked (2026-10-19). A paste of the picture already held is a repeat: toasted, never offered as an Append.

### `GalleryViewer.tsx` and `useGalleryOpen.ts` — the gallery's viewer half

`gallery/useGalleryOpen.ts` holds the viewer's open file and its one writer (`showFile`), plus `directRef` (a viewer opened straight at a file closes the gallery on close and honours `returnTo`). `gallery/GalleryViewer.tsx` draws it; the rendered HTML branch frames the FILE in an `<iframe sandbox="allow-scripts">` with no `allow-same-origin`.

Second trim pass (2026-10-17, review): sentences with a measured number or an incident story and no imperative, moved verbatim.

- (an arc that moves the instant the finger lifts is worse than one that overhangs)
- : clamping the origin alone kept the width, so a crop dragged in from off the left GREW as it went
- (a box-like gains `Mark.angle`; a turned blur pixelates the box AROUND it, clipped), sized in screen px, working off the total delta from `base` and settling through `settleMove`
- (Office puts a PNG beside the cells)
- three repos here all build `app-debug.apk`;
- , and the count said *2 apps install themselves* with nowhere to tap
- (the thumb warmer's `queued` then refuses to refill what it just emptied, `screenlog`'s `logs` re-saves on the next beat, the dictation INDEX names blobs that are gone, the transcript prefetch thinks it is warm)
- A repo's outbox can be mostly APK families.
- (inbox photos are all-variable names ⇒ every file its own family ⇒ a control that can only select nothing)
- ("14 of 38" could be one family or nineteen)
- Not a policy control: prune is already on by default, so the recurrence lever is the scaffold `CLAUDE.md` line, not a switch.
- Warm push, cold push and the row all take the same path; closing returns to the feed.
- (a 4h listing may never answer "all time")
- the text cache is keyed on `(repo, relPath, mtime)` and a seed with no mtime is 0, so every rewrite of one path files under one key —
- (those return early when the page is not visible, which is exactly this case)
- Replaces a hidden `<a download>` that did **nothing at all in the APK**.
- — small text survives the mark and not the upload shrink, which is the whole reason
- : a browser tab and the APK on one phone each have their own, so both fetched every build
- ; an `.html` deck was written to be looked at, not read as tags
- , because a thumb starting a box on the edge of a phone-sized image taps the edge instead of dragging from it
- (a finger cannot land on them anyway)
- `ImageAnnotator.tsx` is a 40-line composer.
- — a WebView drops a `blob:` anchor download SILENTLY
- (API 31 `USER_ACTION_NOT_REQUIRED`, API 34 update OWNERSHIP requested on the loud install)
- , and `failureText` turns Play Protect's `VERIFICATION_FAILURE` and an abandoned session into sentences
- — that verb lives on the queue screen with the words in front of you
- : the service still runs and the queue still drains, there is simply nowhere for alerts to appear
- `27 · 3.9 GB` opens exactly those 27;
- Lifted out of `Gallery.tsx` because the notification feed decides before any viewer exists — a notification
- Decodes ONCE; paranoid encode (size ladder, `toDataURL` fallback, canvases zeroed).
- It is attached in `main.tsx` (`startInstallLog`); there is no `App.tsx` branch.
- **Chromium freezes the DOCUMENT on its own, 300 s after `visibilitychange`**, so
- A browser is told NOTHING (`installIntroText` → null);

## Moved out of skill `web-send` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

### sendConfirm.ts — the red row


  It went red seven seconds after Send while the host still had four re-sends to spend.

### useVoice.ts — why the fallback is said

 — Android's recogniser dictated garbage nobody could tell was not whisper's

### useVoice.ts — the language incident

 — it was `navigator.language`, and whisper told a language TRANSLATES every other one into it, so English spoken into a German phone arrived as fluent German prose

### SendSheet.tsx — why one surface

Four orthogonal decisions — WHAT, WHERE, WHEN, HOW MANY AT ONCE — that twelve sheets each hard-coded a different combination of.

### composeSend.ts — the .send-more CSS aside

 **`.send-more` restates `flex: 0 0 auto`**: `.row-more`'s
  `flex: 0 0 100%` is a WIDTH in the launcher's row parent and a HEIGHT inside the compose COLUMN,
  where it made every menu button as tall as the composer.

### composeSend.ts — the sendMode post-mortem

 The deleted
  `waterplane.sendMode` armed this button with a wall CLOCK and said so nowhere: only `now`/`idle` are
  ever recalled onto it

### `ComposeBar.tsx`, `NextPromptStrip.tsx`, `useFileDrop.ts` and `SendSheetEntry.tsx` — the compose bar and the send overlay

All four were lifted out of App unchanged. `ComposeBar.tsx` is the aim line, upload row, attach strip, split Send button's menu, snippet popover, the box and the button row (or CLI mode's bar in its place); everything it acts with is `useCompose`'s return. `NextPromptStrip.tsx` mounts `NextPrompt` above the queue bar on the session screen, reading both queues. `useFileDrop.ts` takes a desktop paste or drag onto the compose box through the paperclip's route and swallows a drop next to the box (the browser's default would navigate the tab to the file). `core/send/SendSheetEntry.tsx` is the `send` overlay over the one send surface: a `repair` seed turns on the file check, a `scheduleId` makes the save an upsert; what the sheet decides goes through `useSend`'s `dispatchIntent` and nowhere else.

### `sendChain.ts` and the `sendIntent/` modules

`sendIntent.ts` is a 39-line facade; the rules are `sendIntent/sendChain.ts` (the chain picker, `chainCandidates`, `ruleRecurs`), `sendClock.ts`, `sendRule.ts`, `sendRetime.ts`, `sendLead.ts`, `sendLaunch.ts`, `sendFlag.ts`, `sendLabels.ts` and `sendTypes.ts`. `sendIntent.test.mjs` pins every string.

Second trim pass (2026-10-17, review): sentences with a measured number or an incident story and no imperative, moved verbatim.

- (Web Speech — Google's cloud, the engine that was not good enough)
- , toasted once per page too
- The status read is ONE memoized promise per page.
- Capture is 16 kHz mono PCM via `AudioContext({sampleRate})` so the host needs no transcoder, `ScriptProcessorNode` on purpose (an `AudioWorklet` needs a blob URL in the WebView), each callback COPYING its channel data.
- , defaulting to three languages (`DICTATE_LANGS_DEFAULT`) because the pill is tapped one-handed mid-sentence
- A long dictation is an untouched phone: the screen timed out, the WebView paused the `AudioContext`, and the button went on saying *listening* over audio that was never recorded.
- : a minute of speech is 1.9 MB uploaded before the first response header, so a slow tunnel ABORTED it and the only copy was dropped
- `seed.scheduleId` was read by the `at` arm alone, so choosing *now* / *when it's free* / *after…* on a live timed row posted a second row beside the armed one and the words ran twice.
- — it was a dimmed segment whose reason lived in a `title`, and tapping it answered a REPO target (`firstSession` on an empty list), i.e. silently a different question
- — a schedule set before attaching a picture silently reverted to *now*
- and unrefused it dropped turns 2..n on the desktop silently
- (the fields are 07:00–22:00 and the host reads them as the hours it MAY run, so the old labels made "not while I'm asleep" produce the opposite)
- — queueing five prompts *when it's free* was five taps on the chevron
- (the deleted `waterplane.sendMode` armed it with a wall CLOCK)
- , which put the phone back in the holder's chair two taps from the composer that had just stopped doing it
- , and hidden it left the whole screen silent about words that were certainly going to run
- (`focusRef`, written on focus and read by `AttachButtons`, which is mounted in the action bar and cannot see focus itself)
- , because the clipboard route needs a secure context and a plain `http://100.x` tunnel is not one
- : while the phone's recogniser listens, a warn pill sits where the language pill would, its tap toasting WHY (plain http, no recording API, or the desktop's own `reason`)
- (the words land ~1 s after you stop, and a button back at idle reads as a tap that did nothing)
- ; a held clip lands minutes later and a stale base is a delete
- — whisper told a language TRANSLATES every other one into it
- — furniture the rest of the time, and the browser recogniser is given its language at the start, so there is nothing to change about a running one
- (both chromes, one stored choice)
- The button's clock (`Voice.heard`) counts FRAMES that arrived, so it freezes with the mic;
- (a gap since the last frame, a lag against the wall clock since the open — a resumed context hides a hole in the middle — or an ended track)
- (Android ends "continuous" sessions itself)
- (a rescue that could not happen must not also be a delete)
- — "held" when the PHONE is holding it is a promise about a locked screen it cannot keep
- (plus `phoneHold`, because the two phone-held cases are two different promises)
- so it does not wear the same two nouns as the anchor control ten lines above
- (which METER the headroom condition reads, so *right after the session window resets, only if 30% of the week is left* is sayable)
- Shell composers also drop autocapitalize/autocorrect.
- : one phone has them, the source is read once and then marked
- : `/usage` opens a VIEW and starts no turn, so a pinned item watching for one never settles
- Pure half node-tested (`dictateHold.test.mjs`);
- Pure half node-tested.
- ; the phone's own lane goes first (it is the one a tap can still change)
- Only `now`/`idle` are ever recalled onto it and `sendModeLabel` spells both out on the face,
- (`SendResume` + `onDecide`, in `core/send`'s `sendResumeRef`, cleared with the seed)
- `core/queue/pending.ts` holds the pending-create path of the queue: `retryPendingCreate` and `queueSessionPrompt`, two of the ten ackId mint sites `queue.test.mjs` pins (`QUEUE_SITES`).

## Moved out of skill `web` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

Prose cut from `.claude/skills/web/SKILL.md` when it was groomed; the rule stays there, the story is here. Verbatim.

### `Sheet.tsx` — the old back-button count

`SheetHead`: 33 files hand-rolling a back button is 33 chances to get CLOSE wrong. (Today 49 `.tsx` files import `SheetHead`.)

### `useRemoteResource.ts` — the `inflight` story

`inflight` is a SIXTH fact, not a sixth state; the story is in [`useRemoteResource.ts` — one host read, told honestly](#useremoteresourcets--one-host-read-told-honestly).

### `App.tsx` — chatty pushes and toasts

**A chatty push nothing on screen reads keeps `prev`** — `build.output`, `capture.output` and `assess.state`'s 1.5 s progress frames all guard on the overlay, or a 20-minute run is ~800 whole-App renders on every phone; a status TRANSITION, a new id or a `null` is NEVER swallowed.

**A toast's clock is the LENGTH of its words** (`toastMs`) and **every toast is also a ROW** in a bounded log (`ToastLog.tsx`, *On this phone*) apart from the host's alerts, and NEVER counted into the unread badge.

### Sheets inventory (cut: no rule)

Full-screen overlays with a `track()`ed entry point: `Backlog` `Gallery` `GitView` `SlashSheet` `NewMenu` `ImageAnnotator` `QueueSheet` `SendSheet` `ActivitySheet` `PadSheet` `FanoutSheet` `QuestionsSheet` `SnippetSheet` `BranchPicker` `HistorySheet` `SearchSheet` `OutlineSheet` `SecretSheet` `SetupSheet` `SentLogSheet` `BuildSheet` `UsageSheet` `SpeedTestSheet` `NetHealthSheet` `AppUpdate` `HostSetup` `PullSheet` `ImageSwiper` `ScheduleSheet` `ScrollbackSheet` `FilesSheet` `ArchiveSheet` `CliHealthSheet` `AssessSheet`. The live list is the `overlayViews` table.


## Moved out of skill `web-chrome` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

Prose cut from `.claude/skills/web-chrome/SKILL.md` when it was groomed. Verbatim; the rules stay in the skill.

### `link.ts` — it was six modules

It was six modules with four independent derivations of "am I online". (`link.ts` is now a facade over `link/`; the store is `link/linkStatus.ts`.)

### `giveups.ts` — the tombstone

**`giveups.ts` — DELETED**, its localStorage key deliberately NOT: `migrateGiveUps` converts every
  un-retried row into a `failed` queue row exactly once, with a **FRESH ackId always**. Its three jobs
  are Activity's now, "have I dealt with this" included (`activityDismiss.ts` files a row without
  deleting it).

The queue's one-shot migrations (`migrateGiveUps` among them) are `core/queue/migrate.ts`; the rule's owner is `web-send`.

### `SessionTabsBar.tsx` — the design-iteration prose

`SessionTabsBar.tsx` + `sessionTabs.ts` — **the open sessions as a strip**, the THIRD always-on bar
  and `link.ts`'s shape again: one store, ONE writer (`noteSessionTabs`, fed by `App`'s own render
  data), taps leaving as EVENTS because the bar is mounted beside `App` and cannot call its setters —
  the two verbs are `attach` and `closeSession`, unchanged, and **no new send path**. **The colour is
  the repo's own** (`repoHue`) as a TINT under `--fg`, never repo-hued text on a repo-hued ground
  (the one pairing the palette cannot hold at 4.5:1 across 360 hues); the selected tab is a STRONGER
  MIX OF THE SAME HUE plus a cap of it on its top edge and three more pixels of HEIGHT (brightness
  alone cannot say "front tab" — a vivid repo looks that way anyway), never the accent. **The tint is
  the LAUNCHER's token over the LAUNCHER's surface** — `--repo-fill`/`--repo-fill-on` as ALPHAS, the
  strip's ground `--bg` not `--panel` — so a tab and its group header are the same COLOUR, not the
  same hue in two mixes tuned apart (`--tab-veil`/`--repo-veil`, which is what "the colours nearly
  match" was). **Those three shapes are declared on the ELEMENTS carrying `--repo-accent`, NEVER at
  `:root`**: a custom property resolves its `var()`s where it is DECLARED, so a root `--repo-fill`
  computes to flat transparent and inherits colourlessness into every tab, with nothing in the
  stylesheet looking wrong. **Light FILLS harder and WASHES lighter than dark** (46/10 against
  40/18, the wash exactly where it shipped — it sits behind text of its own hue), the fill's ceiling measured in `theme.test.mjs`, never chosen. **`TAB_STRIP_H` and
  `.sess-tabs`'s height are one number in two files**, pinned by `sessionTabs.test.mjs`.
  **What a tab is DOING is `sessionStatus()`**, never booleans of the strip's own — the same five
  buckets and the same five colours (`--accent`/`--dead`/`--limit`/`--muted`/`--dead`) the row badge,
  the roll-up and the filter share, words from `STATUS_LABEL`; the two booleans it replaced drew
  *waiting on you* and *at the limit* as the same grey dot as *nothing left to do*. **A running turn
  SPINS** — `statusPill`'s own `Loader`, only while a turn runs, only on tabs running one, stilled by
  `prefers-reduced-motion` into a spoked RING that is still not a dot.
  **How many fit is a setting and NOT a limit** (`--stab-n` is a tab's floor, `1/N`; fewer open, a tab is as wide as its name; the rest scroll,
  the active one is scrolled into view) — per device with `netPulse`'s argument, because three tabs
  is a measurement of THIS screen; **default 3 because the names are up to FOUR words**. **How many
  are DRAWN is a second setting that IS a limit** (`tabsLimit`, default 10, `limitTabs` pure/tested):
  the open session is always drawn, and the cut is COUNTED at the strip's end (`+N`, words not a
  control). **THREE orders** (`open` / `frequent` = the habit / `recent` = where was I, the only one
  that MOVES under you — and the DEFAULT, by the owner's ask), and **the tie-break is always the open sequence** or tabs swap places on a publish that
  changed nothing. The store is `{n, at}` per session, ONE store for both orders, `migrateOpens`
  converting the old bare count rather than dropping it (**no instant reads as longest-ago, never as
  just-now**); bumped when a session COMES ON SCREEN (`openOwed`, off the published active id — Back, hash, `session.focus` and a create all skip `attach`), **pruned on publish but NEVER
  against an empty session list** (a cold start and a dead tunnel look identical). **The × asks**
  (`Confirm.tsx`) and archives. **Nothing to show ⇒ nothing drawn**, height
  published as 0. `tabLabel` is the one label rule: the host's ≤4-word `tabTitle`, else the title with
  the repo prefix cut, never blank and never invented — and the SESSION HEADER draws that name in
  FULL (`.brand-name`, wrapping, `Sparkles`), INLINE beside the branch, which is what four words are
  for.

### `repoColors.ts` — the golden-angle history

`repoColors.ts` + `RepoColorSheet.tsx` (+ `shared/repocolor.ts`) — **which repo is which colour, as
  a decision a person may take.** The hue was `hash * 137.508 % 360`, a golden-angle spread that
  spreads CONSECUTIVE inputs and nothing else: two of sixteen repos here measured 9° apart — one
  colour, twice. Now a RING of hues ≥24° apart indexed by the same hash, four rings to choose from
  (one measured under simulated CVD in `theme.test.mjs`, because a hue GAP says nothing about that),
  and **a hue a person may pin per repo — which SURVIVES a change of ring** (you chose a colour, not
  a slot). **`format.ts`'s `repoHue` reads a MODULE value**, never a hook: ~30 call sites are a
  `style=` mid-render and what a change needs is the RE-RENDER — `App` and the strip subscribe for
  exactly that. **The count IS the filter** (*12 repos share a colour* opens those twelve);
  **nothing applies itself** — *give them separate colours* moves only what collides, keeps a repo
  already alone on its hue, and **NEVER moves a pinned one**; more repos than hues is a SENTENCE,
  never a dimmed button. **Synced** (`waterplane.repoColors`) where `waterplane.theme` is not: the theme is a
  fact about the device, which colour `waterplane` is, is a fact about the person. Only the HUE is ever
  decided here — `--repo-sat`/`--repo-lit` per theme are swept over all 360 hues, so nothing
  pickable can make a name unreadable.

### The session header — the four-row history

**The session header is TWO rows and the break is STATED** (`.hdr-row2`). It was four — title,
  derived name, chips, and the five icon buttons that could not fit beside the chips — and that last
  one is not a sizing accident: **a wrapping flex row breaks on BASE sizes before it shrinks
  anything**, so a chip list wider than the row pushes the controls onto their own line however well
  it scrolls. One child at a 100% basis can only ever start a line; `.hdr-cmds` sits at basis ZERO
  inside it so a long list eats its OWN row; `.hdr-ctl` groups the buttons so the break never lands
  between two of them. **The typing keeps stay DIRECT children** — `.screen.typing .topbar >
  *:not(.hdr-typing-keep)` hides a nested one with its group. A header button is 40px, not `.key`'s
  46×44: in a bar that already wraps, 4px is measured against a whole ROW. The header wears the
  repo's hue as `.row-wrap`'s own 3px stripe — and drops it in typing room, where the bar is gone.

### Typing room and the corner group — measurements and bug stories

**Typing room** (`chromeMode.ts`, `uiScaleSteps.ts`) — while the caret is in the compose box the chrome ABOVE it is hidden and the
  terminal keeps the rows (measured: all of it together left TWO lines). **The signal is FOCUS, not a
  keyboard measurement** — but LEAVING is: Android's back gesture keeps the caret, so `trackKeyboard` blurs the box only when the viewport returns to its height AT FOCUS after provably dropping a keyboard's worth, held still `KEYBOARD_SETTLE_MS` ("grew back from the shortest" fired on the opening animation and shut the keyboard). CLI mode is excluded. What survives is the output and two buttons —
  **outline** (which does not end typing mode) and **menu** (`typingPeek`, which brings the chrome back
  without giving up the caret). The strip is absolute, never `fixed`. **Full screen is the same layout
  asked for BY HAND** (`fullMode`, the terminal's own corner button, not persisted): same class so the
  two never drift, drawn on BOTH surfaces (the exit must exist wherever the mode can be entered), and
  the **special-key row STAYS** — with no keyboard those keys are the only way to answer the CLI.
  **`chromeMode.ts` is the whole conjunction, pure and node-tested** — every bug here was a bug in
  the conjunction. Three rules: **`onSessionScreen` gates BOTH hiders** (the strips it hides —
  `.net-pulse`, `.localrt-bar` — are mounted OUTSIDE `App` and hidden by an attribute on `<html>`, so
  an ungated mode took them off the launcher and every sheet; `composeFocused` survives the back
  button, no blur fires on unmount) · **`fullScreen` resets on leaving the session** (a hidden header
  you never asked for is the state bug, not its symptom) · **the peek suspends full screen too**, or
  the ☰ asks one hider to let go while the other holds on and reads as dead. The corner button
  carries `keepFocus`: without it the pointerdown blurs the box and the button moves out from under
  the finger before its own click lands.
- **The corner group** (`.term-zoom`, top right of the TERMINAL *and* the READER, floating for the
  `conn-banner` reason — a strip in flow refits the grid and SIGWINCHes the PTY): the **reader/CLI
  switch** (moved OFF the header — full screen hides that row, and this is the control you want most
  in the layout you read a long turn in), the zoom pair, then **full screen LAST** — the group is
  anchored RIGHT and grows leftward, so the right-most button is the only one that never moves when a
  zoom button drops off its ladder. **It draws and toggles what is ON SCREEN (`chromeHidden`), never either switch**: drawn from `fullMode` it said *enter* while typing room hid the chrome; drawn from `fullScreen` it said *leave* over a header the ☰ peek had brought back — a dead tap both times. `fullScreenTap` (pure, tested) asks for the opposite of what is visible and moves BOTH the switch and the peek to agree. **Two stored zooms, one per surface** (`waterplane.termZoom` / `waterplane.readerZoom`): the
  terminal is told to xterm as PIXELS, the reader is ONE `--ui-font` override on its subtree
  (`readerScale`, clamped as a PRODUCT), wrapper `display: contents` so `.tr`'s height still resolves
  (`uiScaleSteps.ts`'s `termFontPx`/`nextTermZoom`, a multiplier ON the text size — smaller font is a
  BIGGER grid, and the refit's report is what resizes the PTY). **No px readout** over live output;
  at an end of the ladder that button is ABSENT with the end named, never dimmed.

### Second trim pass: measured numbers and incident stories cut from the skill (verbatim)

- theme.test.mjs checks token parity, 4.5:1 text, 3:1 charts, CVD separability and all 360 repo hues.
- routing.ts: unwinding INTO a transient overlay (hash) landed on the screen underneath (the annotator's return from `SendSheet`, prompt stranded in its draft); depth is pushed because Android 13+ asks at the START of a predictive-back swipe.
- resumeRoute.ts: Every ordinary reload keeps the hash; the APK's update does not — Capacitor's `setServerBasePath` ends in `loadUrl(appUrl)`, the bare start URL, and so does the cold launch after a merely STAGED build.
- resumeRoute.ts: storing `location.href` would carry a `dlPath` and re-open a download on the next restart.
- Bundle chunking: one monolithic chunk re-sent ~1 MB for a one-line change.
- Markdown.tsx: a relative href in the WebView replaces the whole app with a blank 404.
- SessionTabsBar: repo-hued text on a repo-hued ground is a pairing the palette cannot hold at 4.5:1 across 360 hues; the selected tab also gets three more pixels of height.
- SessionTabsBar: a root `--repo-fill` computed to flat transparent and inherited colourlessness into every tab with nothing in the stylesheet looking wrong.
- SessionTabsBar: sessionStatus has five buckets and colours; the spinner is `statusPill`'s `Loader`, a spoked ring under `prefers-reduced-motion`.
- Header: a chip list wider than the row pushes the controls onto their own line however well it scrolls; one child at a 100% basis can only ever start a line.
- Header: in a bar that already wraps, 4px is measured against a whole ROW.
- Typing room: every bug here was a bug in the conjunction.
- Typing room: an ungated mode took `.net-pulse` and `.localrt-bar` off the launcher and every sheet.
- Corner group: drawn from `fullMode` or `fullScreen` it said the wrong verb whenever typing room or the ☰ peek had changed what is visible — a dead tap.
- LauncherScreen: with a second section below, WHICH half of a repo's verbs you got depended on whether it happened to have a session open.
- Corner group zooms: the terminal is told to xterm as PIXELS, the reader is ONE `--ui-font` override on its subtree (`readerScale`, clamped as a PRODUCT), wrapper `display: contents` so `.tr`'s height still resolves.
- ZoomableImage.tsx: clamped pan, GPU-derived scale ceiling, `will-change` only during a gesture.
- themeOverlay.ts: the overlay style is cached and injected pre-bundle by `index.html` like the theme attribute.
- ArchiveSheet.tsx: `session.kill` leaves the row `exited`, which then suppresses the "Recently closed" entry.
- ArchiveSheet.tsx: its entry point is deliberately not the section header, which disappears when the shortlist empties.
- repoColors.ts: `--repo-sat`/`--repo-lit` per theme are swept over all 360 hues.
- headerCmds.ts: a `/compact` chip rendered beside "no slash commands" typed Claude's vocabulary at a backend that reads it as PROSE.
- SessionTabsBar.tsx (full original bullet): - `SessionTabsBar.tsx` + `sessionTabs.ts` — **the open sessions as a strip**, the third always-on bar, in the link store's shape:   one store, ONE writer (`noteSessionTabs`, fed by `App`'s render data); taps leave as EVENTS (the bar is   mounted beside `App` and cannot call its setters) — `attach` and `closeSession`, **no new send path**.   **The colour is the repo's own** (`repoHue`) as a TINT under `--fg`, never repo-hued text on a repo-hued   ground; the selected tab is a stronger mix of the same hue plus a cap of it on its top edge, never the accent.   **The tint is the LAUNCHER's token over the LAUNCHER's surface** (`--repo-fill`/`--repo-fill-on` as   alphas, the strip's ground `--bg`), so a tab and its group header are the same colour.   **Declare those shapes on the ELEMENTS carrying `--repo-accent`, NEVER at `:root`**: a custom property   resolves its `var()`s where it is DECLARED, so a root `--repo-fill` computes to flat transparent. **Light FILLS   harder and WASHES lighter than dark** (ceiling measured in `theme.test.mjs`).   **`TAB_STRIP_H` and `.sess-tabs`'s height are one number in two files**, pinned by `sessionTabs.test.mjs`.   **What a tab is DOING is `sessionStatus()`** (`sessionFacts.tsx`), never booleans of the strip's own — the   row badge, the roll-up and the filter share it; words from `STATUS_LABEL`; a running turn SPINS (still under `prefers-reduced-motion`).   **How many FIT is a setting, not a limit** (`--stab-n`, per device, default 3); **how many are DRAWN is a limit** (`tabsLimit`, default 10, `limitTabs` pure/tested): the open   session is always drawn, the cut is COUNTED at the strip's end (`+N`, words not a control). **THREE   orders** (`open` / `frequent` / `recent` — the DEFAULT and the only one that MOVES under you), and   **the tie-break is always the open sequence**. The store is `{n, at}` per session; `migrateOpens` converts   the old bare count (**no instant reads as longest-ago**); bumped when a session COMES ON SCREEN   (`openOwed`, off the published active id), **pruned on publish but NEVER against an empty session list**   (a cold start and a dead tunnel look identical). **The × asks** (`Confirm.tsx`) and archives. **Nothing   to show ⇒ nothing drawn**, height published as 0. `tabLabel` is the one label rule: the host's ≤4-word   `tabTitle`, else the title with the repo prefix cut, never blank and never invented; the session header   draws that name in full.
- Typing room (full original bullet): - **Typing room** (`chromeMode.ts`, `uiScaleSteps.ts`;   state in `core/session/useSessionChrome.ts`) — while the caret is in the compose box the chrome ABOVE it is hidden and the   terminal keeps the rows. **The signal is FOCUS, not a   keyboard measurement** — but LEAVING is: Android's back gesture keeps the caret, so `trackKeyboard` blurs the box only when the viewport returns to its height AT FOCUS after provably dropping a keyboard's worth, held still `KEYBOARD_SETTLE_MS`. CLI mode is excluded. What survives is the output and two buttons —   **outline** (which does not end typing mode) and **menu** (`typingPeek`, which brings the chrome back   without giving up the caret). The strip is absolute, never `fixed`. **Full screen is the same layout   asked for BY HAND** (`fullMode`, the terminal's own corner button, not persisted): same class so the   two never drift, drawn on BOTH surfaces (the exit must exist wherever the mode can be entered), and   the **special-key row STAYS** — with no keyboard those keys are the only way to answer the CLI.   **`chromeMode.ts` is the whole conjunction, pure and node-tested** . Three rules: **`onSessionScreen` gates BOTH hiders** (the strips it hides —   `.net-pulse`, `.localrt-bar` — are mounted OUTSIDE `App`, hidden by an attribute on `<html>`; `composeFocused` survives the back   button, no blur fires on unmount) · **`fullScreen` resets on leaving the session** (a hidden header you never asked for) · **the peek suspends full screen too**, or   the ☰ reads as dead. The corner button   carries `keepFocus`: without it the pointerdown blurs the box and the button moves out from under   the finger before its own click lands.
- Corner group (full original bullet): - **The corner group** (drawn by the terminal area, web-term's `core/session/` file; `.term-zoom`, top right of the TERMINAL *and* the READER, floating for the   `conn-banner` reason — a strip in flow refits the grid and SIGWINCHes the PTY): the **reader/CLI   switch** (moved OFF the header — full screen hides that row), the zoom pair, then **full screen LAST** — anchored RIGHT, growing leftward, so the right-most button never moves. **It draws and toggles what is ON SCREEN (`chromeHidden`), never either switch**. `fullScreenTap` (pure, tested) asks for the opposite of what is visible and moves BOTH the switch and the peek to agree. **Two stored zooms, one per surface** (`waterplane.termZoom` / `waterplane.readerZoom`): (`uiScaleSteps.ts`'s `termFontPx`/`nextTermZoom`, a multiplier ON the text size — smaller font is a   BIGGER grid, and the refit's report is what resizes the PTY). **No px readout** over live output;   at an end of the ladder that button is ABSENT with the end named, never dimmed.
- LauncherScreen.tsx (full original bullet): - `LauncherScreen.tsx` (`core/launcher/`) — **the launcher is ONE list**   (`repoGroups`, a memo in `useLauncherModel.ts` over `repoGroupsOf` in `model.ts`): a repo group header per repo whether or not it has a   live session, its sessions under it and its worktrees as start-point rows . A repo with nothing running is ONE ROW. **Launcher state is module stores: the screen unmounts under every sheet**, and a filter must survive the round trip. Session rows sort strictly by `createdAt` (status never enters the key), with a manual per-device   order, same-repo rows kept contiguous and a companion shell glued under its session (`glueCompanions`, applied in `model.ts`). The local/external switch is a menu entry, not   a segmented bar, but WHICH view is showing stays on screen. **A row opens into the READER too**   (`openReader`): read mode set BEFORE the attach (the ref moves by hand or the transcript is fetched   twice), outline fired after — and `attach` CLEARS `readerCmd`, or a verb fired in one session   re-fires over the next reader that mounts. (the reader ref moves by hand or the transcript is fetched twice)
- CloseSheet.tsx (full original bullet): - **`CloseSheet.tsx` + `closeModel.ts`** (`core/launcher`, replacing the old single-cut close dialog) — the bulk   close as seven combinable FACETS (state, idle-for, open-for, underneath, words at stake, conversation,   repo) instead of five single-cut buttons: facets AND, options within one OR, every chip cross-counted   against the OTHER active facets (`facetCounts`'s `withoutFacet`, as `backlogFilter.ts`'s age/status pair). A full `Sheet` reached via `useBackStep`, never a route of   its own. The list under the chips is the actual rows (`SessionFacts`) with a per-row "keep" toggle; the   foot sends `session.remove` once per row still in and says `close N · stops M background shells`   before it stops them — "closing a session stops its shells, fully" (web.md; not in CLAUDE.md). `N = 0` is a sentence,   never a dimmed button. A session a TIMED prompt is aimed at starts KEPT (`isKept`) and `timedKeptNote` says so — never silently spared. Reasoning: [web.md](web.md#the-close-sheet-facets-that-combine-replacing-five-single-cut-buttons).


## Moved out of skill `web-term` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

Prose cut from `.claude/skills/web-term/SKILL.md` when it was groomed. Verbatim.

### `PromptAnswer.tsx` — the approve bar and the trust box

`PromptAnswer.tsx` — **the one card a choice box is answered by tapping**, drawn by the reader's
  `tr-ask` and by `QuestionsSheet`. The `approve` BAR under the terminal is GONE: it took its height
  from the PTY, so it was capped, clamped and three-sized — and on a six-option box with a paragraph
  each it still showed TWO, with four inside a scroll region Android draws no scrollbar on. In the
  terminal view a box is answered the terminal's way (press the digit); a card there only covers the
  CLI drawing the same question. So the surfaces that draw it are the two with a scroll of their own,
  and nothing here is capped or clamped. **One exception, the trust box** (`termAnswers.ts`, kind
  `trust` only): the terminal view draws this card as an OVERLAY at the grid's bottom (`.term-answer`,
  its own scroll, never a PTY resize), because it is a new person's first box, before they know the
  key bar, and 2.1.293 draws it unnumbered with the cursor on "No, exit". Widen that predicate only
  for a box with the same argument. **The commit row is never inside the option list** (on a
  multi-select Submit is the only control that answers). Every tap is still `answerPrompt` — durable,
  fingerprinted, refused host-side once the box is gone — **no new send path**; sharing one body is
  what stopped the sheet's copy sending a DIGIT at a `nav` box.

### `screenlog.ts` — the scrollback sheet's zoom mechanism

write. **It has the corner pair's zoom as a THIRD stored value** (`waterplane.scrollZoom`) — its lines
  were wrapped once by an 80-column grid and a narrower phone wraps them again, so smaller text is
  what puts a terminal line back on one line; never the CONSOLE's zoom (that reports new cols/rows
  and resizes the live PTY — reading history must not reshape the session) and never the READER's
  (prose that reflows is a different size question). Mechanism IS the reader's: one `--ui-font`
  override on `.sb-body` over `nextReaderZoom`'s ladder, the pair anchored right on `margin-left:
  auto` so the hits group appearing with a query cannot walk it under your finger.

### `useLinger.ts` — where it is used

`useLinger.ts` ("stay true for `ms` after `active` goes false") is used only by `core/queue/useQueue.ts` and `uploads.ts`, for the transient strips that are siblings of the terminal in one flex column: a mounted or unmounted strip changes the terminal's height, which refits the grid, SIGWINCHes the PTY and repaints the whole screen. `Terminal.tsx` itself reports geometry only when cols/rows changed.

### Second trim pass: measured numbers and incident stories cut from the skill (verbatim)

- TranscriptView.tsx / shared/working.ts: the old "esc to interrupt" anchor went stale and the reader said "working" for nine minutes with no sign it had stopped matching.

## Modules named by the groomed web skills (2026-10-17)

One short section per module that `web`, `web-chrome` or `web-term` now names and no note described before; the header comment of each file is the long form.

### `layout.ts` — phone or wide

`packages/web/src/core/layout/layout.ts`. The one store for "phone or wide", written only by the media-query listener `startLayout` installs and mirrored once to `<html data-layout="wide"|"phone">`, so CSS and the strips mounted beside `App` read the same fact. `WIDE_MIN_PX` is 1024 (a 300px sidebar plus an 80-column terminal); width only, pointer and hover decide affordances, never structure. No hysteresis: everything that must survive a crossing lives outside the frame. `layoutOf` is the query as a pure function, node-tested (`layout.test.mjs`); components read `useLayout()`/`useWide()`.

### `Workspace.tsx` — the frame, phone or wide

`core/layout/Workspace.tsx`. What `App` puts on screen: below 1024px exactly what App returned (sheet, else session, else launcher); at or above it a two-pane workspace with the launcher in `aside.ws-side`. Both layouts return the same two-slot fragment `[sidebar | null, main]`, so a crossing is a reflow and one debounced fit, never a new xterm.

### `LauncherScreen.tsx` — the screen with no session

`core/launcher/LauncherScreen.tsx`. Topbar, queue bars and banners, the ONE repo-grouped list, then recently-closed, recent and hidden lists, or the external `claude` processes when that view is chosen. Props are what App owns (`types.ts`); its own state is `useLauncherModel`'s module stores, which is why a filter survives the screen unmounting under every sheet.

### `ToolbarMenu.tsx` — the burger's menu

`core/session/ToolbarMenu.tsx`. How the terminal toolbar's items are DRAWN (stateful ones, a feature's own via `featureToolbarItem`, the generic labelled button) and the menu they make up. What a tap DOES stays App's `runToolbar`; a feature's command falls through it to `runFeatureCommand`.

### `PassiveScreen.tsx` and `passiveMode.ts` — the kids' phone

The one screen a passive device gets: its apps and how each update is going, when the desktop was last asked, and a small Unlock; no menu, no settings, no sessions, no socket. `passiveMode.ts`'s `bootMode` is pure: the host's answer when there is one, else the remembered mark (`LS.passive`), so a cold start with the desktop out of reach still opens passive. The host is the boundary (`host/passive.ts`); this is a courtesy (R-connection-011…014).

### `chips.ts` — what a count chip says

`kit/chips.ts`. `chipText(label, bucket)` is "label · 27 · 3.9 GB", `toggleChip` clears or moves the cut, `chipRows` makes one bucketing call per key. The number a chip shows and the cut a tap opens come from that one call (CLAUDE.md: a count on a control is a filter).
### `ptyTail.ts` — the attached session's PTY tail

`ptyTail.ts` holds the attached session's recent PTY bytes: `PTY_TAIL` (in memory) is what the reader's live status line reads, and `savePtyTail`/`loadPtyTails` persist it in IndexedDB so a cold start with no host paints the session instead of a black rectangle. It is IndexedDB and not localStorage because localStorage's quota belongs to the send outbox, which must never be evicted by our own growth. The stored `seq` is the load-bearing half: handed back as `resumeSeq` on the next `session.attach`, it lets a live host stitch only the delta onto the restored output; without it the attach goes out with `resumeSeq: undefined`, the host answers `full: true` and a whole scrollback is re-sent for nothing.

### `resetKeys.ts` — what a reset forgets

`resetKeys.ts` holds the two lists a RESET reads: what "reset UI settings to default" forgets (device keys only — how THIS phone draws the app) and what `BootGuard`'s hard reset keeps. A reset of the look must not delete anything a person wrote or chose for every device (header commands, pins, hint dismissals), and `storage.test.mjs` holds the list to that.

### `CliPeek.tsx` — the reader's empty state

`core/session/CliPeek.tsx` fills the reader's empty state with the TOP rows of the live screen (a fresh session opened in read mode has no turns, and "No turns recorded yet." over a blank screen read as broken while the CLI sat there with its welcome header). It is a DISPLAY, never a second terminal: no input, no fit and NO geometry report (the grid is sized to the geometry the PTY was last told, scaled with CSS to the column width — reporting a size from here would SIGWINCH the PTY). The first turn makes it fly into the CLI toggle.

### `useReaderPick.tsx` + `useTermPick.tsx` — pick lines

`core/session/useTermPick.tsx` picks lines ON the live terminal (ticks drawn over the CLI's own rows, the gutter inside the terminal's element so a pan still scrolls the TUI); `useReaderPick.tsx` is the same pick for the reader, whose lines are blocks (paragraph, list item, heading, quote, code block). Picks are held by their TEXT, not their row: after each repaint a pick is found again, and one that scrolled away is still picked and still quoted, the bar counting it as out of sight.

## Moved out of skill `web-work` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

The long form of rules the skill now states in a line each. Text marked *full original* is the skill's prior wording,
kept verbatim; the skill keeps the rule, this keeps the story and the measurements.

### `BuildSheet.tsx` + `buildPrompt.ts` — the three answers to an empty field (full original)

- `BuildSheet.tsx` + `buildPrompt.ts` — build buttons for one repo, and **three** answers to an empty field:
  `set up` spends an agent turn on the whole repo; the EDITOR's suggest list is free
  (`build.scan` → `shared/buildscan.ts`) — a rate-limited Claude is why you are here.
  **A tap FILLS THE FIELDS and saves nothing.** The query is what you already typed, and only for a
  NEW build. **The count on the control counts the FILTERED list.** One scroll region
  (`.build-body`), because a build log is unbounded.
  The third is the EDITOR's **`work it out`** (`buildPrompt.ts`, pinned): ONE agent turn on
  ONE entry, seeded with what is typed — **the brief is asked for ON THE PHONE first**, nothing
  sent until the button under it, and with nothing said the verb is a sentence not a dimmed
  button. An existing entry names its id (*edit
  that one in place*), and both prompts share ONE copy of the builds.json schema. **A parameterised build opens its form, never runs on a tap**
  (`BuildRunAsk`): nothing is picked for you (a missing value REPLACES Run with the sentence, never
  a dimmed button), a list that could not be read falls back to a typed field WITH the reason, and
  the `optionsCmd` is shown because it RAN when the form opened. Seeded from the stored defaults and
  **nothing else** — a remembered last value would make the form lie. The values ride into the queue
  row's name (`buildRunTitle`) and onto the run row.
  **What a build LEAVES BEHIND is a row here** (`ArtifactPolicyRow`, `shared/artifacts.ts`): collect
  + name, remove older, keep N, per repo, ON BY DEFAULT; **`undefined` draws NO row**; both prompts
  carry `ARTIFACT_RULES`.

### `Backlog.tsx` + `backlogFilter.ts` — the list, the schedule seam, titles and kinds (full original)

- `Backlog.tsx` + `backlogFilter.ts` — **a repo's waiting work: the LIST, never a place words are
  "sent to".** Every item opens its own session when it fires — the shared `backlog · <repo>`
  conversation is retired (`shared/sessioncost.ts` is why) — so group heads read *Each in a new
  session* / *In <session title>* / *Aimed at a session that closed*. **That third group is not a
  queue**: a `{kind:"session"}` row whose session went is held on `sessionGone` for ever, nothing
  re-aims it, so it is out of `nextFireIds` and its chip reads *target closed — held* (it used to say
  *"it runs in a new one instead"*, which the host has never done). **One WHEN, one name**: the row
  verb is `when <session> is free` / `waits for <session>` with the composer's `Hourglass` — it was
  `queue here`, a fourth spelling of the composer's `When free`, needing a paragraph and a dedicated
  `open a session here` to give it a target; both are gone, the reason the verb is ABSENT stays. **It writes no prompts**: its add form was a fifth prompt
  textarea and is now `send…` into `SendSheet` (seeded to this repo, WHEN = *when it's free*); the
  leftover `waterplane.backlogDraft` is RESCUED and said, never dropped. **No phone-side batch runner**
  (`queue mode` and the `⊕` staging buttons): the intent store serializes per repo on the HOST.
  **`fire` is never gated on a session existing** — firing opens one; only the link refuses, in
  words. A row shows its own TEXT (clamped to three lines), never `label`, which `add()` fills with
  `text.slice(0, 40)`; `realLabel` tells a typed label from that truncation. Status + age chips are
  a FILTER, cross-counted (`backlogCounts`): with an age on, the status chips count only that
  window, and vice versa; the age windows NEST (one `ageBucket`/`withinAge`: `backlogpins` P2). Drag
  works in any cut: `onReorder` sends the rows ON SCREEN and the host makes them trade their OWN
  slots (`reorder`), so a hidden row keeps its seat — never renumber a subset 0..n. The filter
  is the tap, not a setting. Ages tick (`useNow.ts`, shared with `ActivitySheet`).
  **Schedules and this list are TWO sheets with the seam drawn in both directions** — a rule is a
  clock listing every repo, an item is words waiting in ONE; the join was what was missing, not the
  separation. A row a rule wrote wears `from the schedule “x”`; a schedule card's `backlog · 1 item`
  opens that row. The link is `lastResult.childId` and therefore the LAST item per rule only —
  never matched on the label, which a child inherits. Its three sentences are `backlogFilter.ts`'s
  (`fromScheduleWords` / `scheduleRuleLabel` / `scheduleItemsLabel`), and `focusIds` is how any cut
  opens this sheet from outside.
  **A `running` row is never hidden by the archived cut** (`hiddenByArchive`, one predicate for the
  sheet's base, the repo counts and the composer's badge). Nothing re-sorts rows on its own; a row
  a drag (or a pinned assessment rank) placed is marked `handOrdered` and says so. `auto off` carries a sentence (it pauses every
  deferred send in the app, not just this list) and the check/validate verdicts wear `CHECK_ICON`,
  never the `⏳ ⚠ ✓ ✗` that were glued to their labels.
  **A row's TITLE and its KIND are `shared/naming.ts`'s, and `label` (the person's) is never
  replaced by `headline` (the machine's)** — `itemHeadline` is the ONE display rule on both ends and
  `realLabel` is only its typed half; a derived title wears `Sparkles` and, expanded, says whose it
  is (`HEADLINE_BY_WORDS`, TEXT never a `title`). **Absent category = NOBODY SAID**: no chip, no
  default bucket; `categoryBucket` (`none` its own chip) is cross-counted with status and age. **No colour per kind** — a red `bug`
  beside a red `failed` reads as a failure; `CATEGORY_ICON` is the difference. `name these N`
  (`backlog.name`, DURABLE, `nameableInCut`/`nameNote`/`NAME_COST_NOTE`) is the one bulk verb here
  that is not a `ConfirmButton`; while `naming` holds a row the button is ABSENT with
  `NAME_RUNNING_NOTE` and the row wears `naming…`. Editing a suggestion SAVES IT AS YOURS (`hand`,
  never overwritten again); clearing it puts the row back in reach of a pass. The edit form's two
  hints are `headlineEditHint`'s, pinned — a promise about the host's `hand` stamp is not an inline
  literal.

### `clockDirectory.tsx` + `clockCuts.ts` — recurrence decides the list (full original)

- `clockDirectory.tsx` + `clockCuts.ts` — **recurrence decides the list.** A one-off aimed at ONE
  place (`isTimedWorkRow`) is a BACKLOG row wearing a clock, never a Schedules card: it is spent by
  its one run, so there is nothing to arm, pause or skip — and filing it under Schedules took it off
  the backlog list (measured: 9 live `at` rows, all one-off, 7 `failed`, in no
  backlog). A recurring rule, and a one-off SWEEP (no single backlog to live in), stay cards. What
  Schedules keeps is a read-only DIRECTORY, `On a clock · N`, one line per timed item with **exactly
  ONE affordance** — open it where it lives; a line with verbs would be the second home this change
  removes, which is why it is its own module. **`clockCuts()` is ONE call producing every list and
  every number on this subject** — cards, lines, the spent foot, the horizon and the two kind counts
  — and the launcher chip makes the SAME call over the same two lists as the sheet it opens, so
  `horizon.total` IS the sheet's `standingTotal` rather than a second count that has to agree. Three
  hand-rolled copies of the standing test said **13 · 8 · 2** about one set of rows (chip, chip's own
  title, sheet): `isStandingClock` is the one predicate now — has a clock, not archived, **not
  settled**, and not spent read **WITH `lastOccurrence`** (`isSpentOnce`'s `window`/`oneShot` branch
  is only that field, so dropping it means no such row can ever read as spent). `horizonBucket` stays
  the only home of the hour/day/week edges. **No cards but clocks ⇒ the directory IS the body**,
  headed *Nothing repeats*; the `Empty` stays keyed on both together.

### `drop the clock` and `run it again` — the `backlogFilter/` verbs (full original)

- **`drop the clock`** (`backlogFilter.ts`: `clockWords`/`dropClockNote`/`dropClocksLabel`/
  `dropClocksToast`/`holdChipWords`) — the verb that answers "run the ones that were skipped":
  `intent.update` carrying a `trigger` of `idle`, a plain `liveSend`, taking the instant off and
  leaving the words. A one-off cannot be re-armed, and `re-fire` beside it runs it THIS SECOND in a
  session of its own (`runNow` skips the ladder) instead of putting it back in the queue. Two states, two different offers, never one sentence; the receipt names the CLOCK and never
  a state (the host kicks synchronously — the row may already be `blocked` or firing).
  **`holdForHost` survives it** — and that, plus *auto takes it from there*, are
  **TEXT on the row, never a `title`** (invisible on a phone, the `Unavailable.tsx` rule): the hold
  chip carries `· survives a dropped clock` where the verb is offered, `dropClockNote` is drawn under
  the chips AND used as the button's title, so there is one string and not two copies of a claim.
  `when` is the Send sheet, never an inline field. On the `failed` cut the bar grows `drop the clocks
  on these N` (`ConfirmButton`): **the count is the cut on screen**, the note says what it left alone
  (and says nothing about a rest when there is none), and **one tap is ONE receipt** — the wire has
  no batch `intent.update`, so `liveSendAll` sends N frames and `dropClocksToast(n)` is said once;
  the per-row loop toasted seven times and named the count never. `▶ next` skips a row whose instant
  is still ahead — it is not next, its clock is. **Its sibling for the row with NO clock is `run it
  again`** (`RUN_AGAIN_LABEL`/`runAgainRowNote`/`runAgainState`/`runAgainEligible`/`runAgainIds`/
  `runAgainLabel`/`runAgainNote`/`runAgainAimedCount`/`runAgainClosedNote`/`runAgainToast`/
  `requeuedWords`): a `failed` row is terminal, so nothing ever looks at it again
  (measured: 0 queued, 19 failed) — `intent.requeue` puts it back with its words, its place and its
  failure, and it is **the one backlog mutation that is DURABLE** (queued offline through `queueOp`
  on an `intent:<id>` lane). **`failed` is a STATE, not an event**, so the tap carries the row's own
  `finishedAt` as `failedAt` and the host refuses a row that settled AGAIN since — and **that refusal
  is TOASTED** (`op.ack`'s `ok:false`, this op alone: its tap is on a row that does not change, so
  silence read as yes). **ONE eligibility edge** (`runAgainState` → `offered`/`held-closed`/`none`,
  never restated in the component): failed, no clock (that verb is *drop the clock*), not archived,
  and **not aimed at a session that CLOSED** — nothing re-aims one, so a re-queue makes it wait for
  ever; the verb is ABSENT and `runAgainClosedNote()` says why in TEXT, never a dimmed button.
  **The promise is worded OFF THE ROW** (`targetSessionId`, the field the group heads read, never the
  optional `fresh`): *a new session of its own* is true only of a fresh row, and the bulk note takes
  `aimed` so a mixed cut is two clauses — only an all-fresh cut may say *one at a time in this repo*.
  `re-fire` beside it is the other promise: this second, not in turn. The row's TEXT and the button's
  title are ONE string, the bulk `run these N again` (`ConfirmButton`) counts the cut on screen with
  one receipt for one tap, and a revived row draws `requeuedWords` — worded apart per state,
  **`by:"run"` reads *started again*** (it was fired, not queued), `(2nd time)` **only when the host
  sent a count** (`n` is optional; absent ⇒ NO ordinal, never `requeues.length`), the old failure
  quoted only where the entry carried one.

### The schedules chip's count (full original)

- **The schedules chip's count** (`horizonBucket`/`horizonLead`/`HORIZON_LABEL` in
  `shared/schedule.ts`, `ScheduleSheet`'s `focus`) follows CLAUDE.md's count-is-a-filter rule; the
  filtered view is `.filter-bar`. **Empty states stay keyed on the unfiltered count** (a filter matching nothing must
  not claim nothing is scheduled). **The filter is the tap, not a setting** — cleared when the
  overlay closes. **The pool is two kinds and the chip's sentence says which** (`N rules · N on a
  clock in a backlog`) — one `horizonBucket` over both, so the tap opens what it counted whichever
  kind those rows are. **A spent one-off is not a schedule at all** (`isStandingSchedule`, same
  function for the chip's count and `ScheduleSheet`'s list): it cannot be re-armed, so "not armed" named a
  state with no way out. It is Activity's row, and the sheet's foot says how many and opens exactly
  those. The one sentence both surfaces say about such a row is `SPENT_ONCE_TEXT`, and *run it now*
  still WORKS on it (the host revives and fires it) — Activity used to refuse the tap the schedule
  sheet offered.

### `SetupSheet.tsx` + `setupRemedy.ts` — `Repo readings` (full original, written when it had two regions)

- `SetupSheet.tsx` + `setupRemedy.ts` — **`Repo readings`: ONE sheet, two
  regions, and the seam is the COMPARATOR, never time.** Against the conventions
  (`ComplianceCheck`) = a fact against a line somebody chose, so it can be on the wrong side of it:
  stripe, pass/warn/fail, counted in the badge, sometimes a `fix`. Against its own past (the
  series, drawn in `RepoHealthRegion.tsx`) = no side to be on. **TWO
  `useRemoteResource`s, two `Empty`s, two age lines, two write halves** — "the checklist could not
  be read" and "the series could not be read" are different sentences.
  The region switch is `ContextSheet.tsx`'s grammar (`.ts-filter` row, labelled `.key` chips lit
  `.key.active`, above what it changes; the repo picker above THAT). `initialRegion` picks the
  landing region.
  **`context-weight` is the proof the merge is real** — the one subject measured both ways, agreeing
  on the number and differing in CLOCK (working tree now vs last commit measured). It keeps its
  stripe (it quotes a threshold, argued with in `ContextLimits.tsx`) and gains `WeightTwin`: both
  halves' sparklines and the rank sentence. **Both figures are named by their clock and RECONCILED
  BY NOTHING** (`bothClocksWords`) — an uncommitted CLAUDE.md edit is the gap a reader wants. The
  working-tree figure is not a wire FIELD (it sits inside the check's prose), so the clause points
  at the sentence above rather than regexing a number out of it.
  Region 1 keeps its two answers: the host's idempotent `fix`, and for what a patch cannot close
  **the finding as words for that repo's agent** via `SendSheet` — `remedyPrompt` **quotes the
  check's own `detail`** (a paraphrase loses the file names) plus one line of guidance per id; the
  bulk button hands over **what the RE-RUN report still shows**; a `CHECK_REMEDY` preset wins where
  one exists. **`isSetupFinding` (`@waterplane/shared`) is the ONE spelling of the predicate** — there
  were three, and `patchFindings` omitted host scope, so "Fix all" counted the daemon's Gemini row
  beside a badge that never has. `focus: "findings"` cuts region 1 to those rows with a
  `.filter-bar` saying `n of N` against the UNFILTERED list and a *clear*; **region 2 is untouched
  and says nothing about it.**

### `AssessSheet.tsx` + `assessRows.ts` + `assessPicks.ts` — the assessment as a diff (full original)

- `AssessSheet.tsx` + `assessRows.ts` + `assessPicks.ts` — the assessment as a diff a person approves. Words IN FULL, **never clipped**; a merge is ONE decision about all N; confirms on the
  BULK buttons. **A RUNNING run says what it is doing** (`assessWatch`; quiet is an AGE never
  "stuck"). **`accept` names its EFFECT** (`assessAcceptWords`, per verdict AND store), TEXT never a
  title. **A verb that does nothing is not drawn** — `unclear`, pad notes and merge members get a
  `CantInline` sentence, never a greyed accept; ticks read FUTURE tense: only Apply acts.
  **A `wanted` PAD NOTE is OFFERED, not just judged** — `cleanAssessment` copies the note's own text
  into `proposal.news` with `AssessNew.fromNote` (verbatim by CONSTRUCTION, not by asking the CLI),
  APPENDED after every CLI-written item so `choices.news` indices keep their meaning, ticked through
  the same `pickedNews`. The row's refusal then POINTS at the offer (`ASSESS_NOTE_OFFERED`) instead
  of closing. **It must not look like a new item**: `NotebookPen` + *from your pad*, `NOTE_ITEM_WORDS`
  (*file it* / *will be filed*), `assessNoteItemNote`, `.asr-offer` — a person has to tell their own
  words from the run's. **The note comes off the pad on the RECEIPT, never the tap** — and only on
  PROOF: `assessBusy` is a **ref-authoritative** `Map<ackId, noteIds>`, `!ok` moves nothing, and
  `ok` clears exactly `ticked ∩ msg.filed` (`assessFiledSplit`/`assessFiledWords`, one sentence per
  outcome). `ok` is NOT proof a row posted — the host's loop carries on past a refusal and still
  counts it — `[]` is the claim *nothing landed*, and `filed` ABSENT clears NOTHING and says the
  notes were left on the pad, never worded as a failure. A socket dying in the gap leaves the row AND the note
  — two visible copies, one tap to clear. Never a loss, never a silent one.
  **A `still wanted` verdict on a FAILED row PUTS IT BACK IN THE QUEUE** (`AssessDisplayRow.failed`
  off `AssessItem.state`, the host's own field): `assessRowPosition` replaces the inline *position N
  in the order* literal, which on a terminal row named a place in a queue it is not in; the verb
  becomes `put it back`; `assessApplySummary.requeue` is a fourth count DISJOINT from `keep` and
  `assessApplyLabel` says *put N back in the queue* in full; `assessApplyNote(requeue)` drops the
  flat *nothing is built or sent* it can no longer keep; and the bulk `keep all N` is the one place
  this sheet ADDS a confirm, naming both numbers (*Keep N — put K back?*). **WHERE a put-back row
  runs is `requeueWhereWords(one)`, ONE clause for the four strings that said it** (accept title,
  `assessBulkLines`, bulk-keep title, `assessApplyNote`): *each in a session of its own* is false for
  a row aimed at a session, `AssessItem` does not carry the target, so it names both outcomes and
  lets the row decide rather than asserting the wrong one.
  **The run's TITLES are a proposal like everything else** — the head draws the kind chip and the
  title (`Sparkles` only when it is the run's, `assessRowHead`), and ONE switch BESIDE pin-ranks —
  side by side, LAST IN THE SCROLL, never a band in the fixed footer (ONE measurement, 320×780 at
  `--ui-font` 1: the list keeps 399 px, the pair is 314 px; at 400×850, 520/250) — decides whether
  any of it is written (`assessNameQuestion`/`ASSESS_NAME_WRITE`/
  `ASSESS_NAME_SKIP`/`assessNameNote`, default WRITE, kept in `assessPicks.ts`). A posted row's name
  rides with its prompt regardless — it has no words of anybody's to sit on.
  `AssessApplySummary.name` counts EXISTING rows only, un-gated by the switch and by the ticks.
  **The scroll is where a question can be MISSED, so the footer restates BOTH answers**: with
  `rankedN > 0` `assessApplyLabel` says `· order pinned`/`· order free` (unconditional on the
  answer), and with the naming switch on, `· title N`. **The guide grows ONE line**, never a
  paragraph — the head must not grow.
  **`read the plan` OPENS `.waterplane/plan.md` in the viewer**, never the composer (`backlog.ts` retired
  the one-session-per-plan shape; `news` is the route to work, no parser), **carrying
  `run.planMtime`**: one path rewritten per run, un-versioned, is A's plan under B's verdicts;
  absent stays absent. **A file the words name is DRAWN** (`AttachStrip compact`). Ticks survive a
  side trip (`assessPicks.ts`).
  **A COLUMN BASIS IN PIXELS IS A CLAIM ABOUT HOW WIDE WORDS ARE** — `.asr-asks > .asr-pin` is
  `flex: 1 1 18ch` and `.asr-answer > .key` is `flex: 1 1 12ch; min-width: 0; white-space: normal`,
  never the annotator's `.annot-tools tri` (`overflow: visible` over `flex: 0 0 auto` `.key`s, and a
  36 px floor): a fixed `118px` column at a larger `--ui-font` painted a sentence over the question beside it and `leave the rows as they are` 347 px off the screen. `ch`
  scales with the text, so the pair drops to ONE column where two would be narrower than the words,
  with no media query — the threshold is the comfort, the no-overflow/no-overlap is `min-width: 0`
  plus wrapping and holds past the 1.45 ceiling. **`18ch` is measured in `.form-hint`'s 13px sans,
  NOT the `.key`'s 14px mono the overflowing words are in** — say what a basis is measured in or it
  reads as a promise; and cite the SELECTOR of the 36px exception, never a line number.
  **1.45 IS NOT THE CEILING** — Android multiplies px text by the SYSTEM font scale on top of
  `--ui-font`, so ~1.9 is reachable: `.act-bulk .key`, **and `.assess-sheet`'s `.act-acts` /
  `.section-head` / `.sheet-head` `.key`s**, are `flex: 0 1 auto; min-width: 0; max-width: 100%;
  white-space: normal` with the icon `flex: none` — `approve the merge` and the step-log toggle were
  each wider than a 320px screen in an `overflow: visible` strip.
  **AFTER an apply the sheet has a ROUTE** — `open the backlog — N waiting in <repo>`
  (`assessOpenBacklogLabel`), a count that IS the filter (`assessReadyCut` → ids → `openBacklogCut`,
  bar labelled `assessCutLabel`). **The cut is EVERY non-archived `queued`/`blocked` row in the
  repo** — that IS the groomed backlog. It was this run's share (`origin`/`wanted`) and said *4
  waiting in usmc* over a repo with 7 waiting, because an `unclear` row is queued and excluded by
  construction; the fix was the cut, never the wording. LIVE `backlogItems`, never the ticks
  (`dropPicks` runs ON apply) and never `intents` (builds/launches/schedules are not backlog rows);
  gated on `run.applied` IN the pure module; a ZERO count is dropped and its sentence is about the
  REPO. **A route never clears `assessRepo`** — the cut is pushed OVER the sheet's history entry, so
  nulling it made Back paint the launcher under `overlay === "assess"` and the next Back do nothing.
  The cut it lands in says whether anything will run it — `focusRunWords(breakdown, auto)`,
  fed a `FocusRunBreakdown` built off `nextFireIds`' own predicates, **never a count**: an ids base
  holds ARCHIVED rows on purpose, so a cut of 3 was told "3" and claimed all four clauses. It
  returns **`null` when nothing in the cut starts**; *a session of its own* only for FRESH rows,
  *in <session>* for aimed; *one at a time in this repo* only with `aimed === 0` (one per GROUP
  fires); *in the order you see*; what is not starting is COUNTED, not
  diagnosed. **ONE COPY of "auto is off"** — the head banner is drawn exactly when that sentence is
  not (keyed on the sentence, not on `filter.ids`), and the switch's title is `FOCUS_AUTO_ON_TITLE`.

### `ScheduleWeekBar.tsx` + `scheduleWeekPlot.ts` — the schedule sheet's week bar

The next seven days with the two usage windows on them and a numbered pin wherever a rule fires next. It computes no edge
of its own: every fire instant is the host's `ScheduleEntry.nextAt` (the same `nextFireAt` the tick arms with) and every
reset is the one usage reading through `windowResetAt`. A window that has not been read is ABSENT, never placed at a guess,
and a later session window is never extrapolated (it opens whenever the next prompt is sent, which no clock knows).
Read-only: the pins are pictures, the list under them says the same in words, every verb stays on the cards.

### `fanoutKickoff.ts` — how far a sweep got

Pure strip for `FanoutSheet.tsx` (`fanoutKickoff.test.mjs`): one sentence and one fraction over a run's targets, counting
`pending` (not yet picked up), starting (spawning / typing), sent (turn still going) and kicked off (everything past
starting, failures included, the bar's fill). A sweep is ONE prompt: the host's fan-out executor reads `steps[0]` and
nothing else, so `sendIntent/sendLabels.ts` refuses a chain into several repos in words.

### `buildScope.ts` + `BuildScopeChoice.tsx` — where a build entry lives

The build editor's two-way choice: the committed `builds.json` every checkout shares, or this desktop's own file.
`build.save`'s `local` lists which ids stay in THIS desktop's file after an edit (`localIds` from `build.list`; undefined =
an older host with no such file: send nothing, draw nothing). The control is drawn only for a host that sent `localIds`.

## Moved out of skill `web-numbers` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

Same convention as above: *full original* is the skill's prior wording, verbatim.

### `ContextSheet.tsx` + `ContextGraph.tsx` + `contextPlot.ts` — the context window as a shape (full original)

- `ContextSheet.tsx` + `ContextGraph.tsx` + `contextPlot.ts` — the context window as a SHAPE, geometry
  and sentences pure and node-tested. **One y axis for every graph: 0 to 100% of the model's window**,
  never re-fitted to the data, falling back to tokens **while saying so**. Row spark: top =
  `autoCompactSetTok`. The TIME axis is piecewise
  and the break is DRAWN. Colours are VALIDATED, not chosen; there is a table twin.
  **ONE CONTROL GRAMMAR, shared with the all-sessions screen and written above both returns**: the
  head holds chrome only (back, re-read) · a body-changing choice is a `.ts-filter` row of LABELLED
  `.key` chips lit `.key.active`, directly above the first thing it changes · a
  section-scoped choice is `.ts-seg-chips` in that `.section-head` · a running verb says so in its own
  glyph, never `disabled`.
  **The context sheet has NO `show as` / `stack by` rows**: one
  chart view, areas ALWAYS stacked by token kind (flat only where the host sends no kinds), subagent
  lanes and the agents' spend band unchanged. The by-model stack lives on the all-sessions screen.
  **Long method prose FOLDS into `details.hint-more`; an ABSENCE never does** — a mean that is not
  drawn, a chip that is not offered, a section that cannot be answered, an outlined box standing for
  *nobody measured this*: `Unavailable.tsx`'s rule applied to prose. Restatements and reassurances are
  cut. `axisNote` is the
  caption, one per `windowFrom`: **`"config"` is ATTRIBUTED, never presented as a measurement** — it
  is what the backend's configuration STATES, not something anybody watched, and a local runner may
  hold less. The sheet is gated on derived `contextSeries`, not on the live gauge.
  **CHARTS TOGETHER, then panels, then captions** — name → spend chart → context chart + summary + legends →
  agent lanes + readout + legend →
  composition strip → cost panel (one door) → expired cache → compactions → captions (truncated,
  `axisNote`, gaps, *where these numbers come from*). The three charts share one `makePlot` x axis,
  so a step in the grey band lines up with the agent bar that caused it; the
  panels used to be interleaved under "their" chart, which put prose between charts read together.
  Charts are NAMED (`.ctx-chart-title`).
  Every sheet prose `.empty` also carries
  `.ctx-note` — `.empty` sets no size, so a bare one rendered at the body's 15px between 12px lines.
  **`/compact` is ONE door, on the context chart's name**: it keeps the conversation
  and re-reads a summary of it, a fresh session keeps nothing, and the ledger six lines below already
  prices the last one at 168× what it cost. Drawn ONLY where `sessionCan(subject, "slash")` —
  `headerCmds.ts`'s bug verbatim — absent with its reason in TEXT, and **`costDoorsText(false)` is
  NULL**: a sentence naming a door that is not on the screen is the same lie in prose. Sent through
  `submitInput` with an ackId, aimed at the SUBJECT and never at the attached session.
  **TWO doors, one subject** (`ctxSid`; null = the attached session, cleared on close and by the
  header chip): a launcher row's cost tile is a CONTROL — `role="button"` + the stopPropagation
  PAIR (click AND the `pointerdown` that arms the row drag; a nested `<button>` is invalid inside
  the row) — and opens the graph for THAT row **without attaching it**, the series being read by id
  over HTTP. Its affordance is the tile's own EDGE: never the dotted underline (that mark is for a
  line of text, not a stack of two SVGs) and never a `title`.
  **A TOTAL IS NEVER PRINTED WITHOUT ITS SPLIT** — 96% of every token here is a cache read, so
  "16M spent" alone is out by two orders of magnitude on what somebody typed. `ContextSeriesDoc`'s
  `split`/`agentSplit` are `TokenTotals` from host `ctxlog.ts`'s SAME pass (`tokenTotal(split)` IS
  `usageTok`, tested — never a second tally), drawn by the SHARED `TokenComposition.tsx` so a kind
  cannot change hue between this screen and the all-sessions one. **`split.turns` is REQUESTS, not
  prompts** (the outline's `turns` stays what it is): `cacheReading` divides by it on both screens.
  The bar folds the agents IN and says how much (`splitNote().lead`). Absent, never
  zeros. `cacheReading(t, "session")` re-words the mean's caveat and drops the advice — the corpus
  wording points at this very screen, and the cost panel above already has the buttons.
  **The all-sessions screen stacks by model too, and its repo bars always do.** `MixSeries` grew a
  value ACCESSOR so `stacks`/`stackAreas` serve kinds, models and agent COUNTS from one
  implementation; **the readout and the legend follow the split** (a model stack under a kind legend
  is four correct bands wearing four wrong names). Repo bars carry their model split inside their own
  length — the answer to why equal-token repos differ in cost. One `ModelLegend` for all three, and
  the chip row SCROLLS rather than wraps.
  **The row's spend chip is MONEY, the sheet's headline leads with the same figure** (why, and
  `costChip`/`costText`'s rules: `shared`'s `sessioncost.ts`): the chip is
  `costChip(spark.costUsd) ?? usageChip(spark.usageTok) ?? fmtTokensFine(end)`, every rung ABSENT
  rather than zero, so an unpriced model or an older host lands on the row that shipped before.
  Tokens move into the title with `costText`. The curve stays in tokens — a second axis in dollars is the same shape twice.
  **The two areas STACK by token kind, and a third chart counts the fan-out.** `stackBands` is the
  geometry, and four rules hold it: the LINE stays and the stack's top edge IS it · the context chart stacks only the three
  kinds that ARE context (output is not in the window until the turn after) · the spend chart stacks
  `cum`, never a cumsum of `kinds` over THINNED samples · bands in palette order, bottom first,
  accumulated in VALUE space. **A model's hue is FIXED app-wide by family** (`modelHue.ts`; the tail
  is ONE grey band), never a volume rank. **A band with nothing in it is dropped, and so is its legend entry**
  (the table spans the conversation AND its agents). **Subagents are SWIM LANES on the same axis**
  (`agentLanes`): one bar per agent from `at` to `endAt`, first-fit packed in PIXELS (the axis is
  piecewise) into the fewest lanes, coloured by `modelSlots`, dearest outlined in ink and the PICKED bar ringed in `--accent`
  (two ink outlines read as two dearest), a tap answering in a
  TEXT line under the strip (`agentReadout`). A `running` agent (host: the live session's own
  running-agent list, never the log's last write) runs to the right edge and FADES there, is out of
  the median, and is concurrent with everything after it. Their SPEND is the grey band on the spend chart
  (`agentSpendBand` over the host's `agentCum`, step-held, top edge = the dashed total; absent ⇒ the
  gap as before), and the row spark draws `agentEnv` as a faint area BEHIND the line, clamped at the
  axis top. An undated agent is in the totals and off the chart, and `agentUndatedText` SAYS so in
  the open. **Prose splits `{lead, more}`** (`spendNote`, `splitNote`): the lead is only absences
  and where-the-agents-are; method folds.
  **The `Expired cache` panel is what the GAPS cost** — beside the compaction panel because the two
  are the same kind of fact (money no prompt asked for) and easy to confuse: compacting rebuilds a
  window somebody threw away, this rebuilds one that went cold. One sentence from
  `shared/sessioncost.ts`, drawn only when it happened (there is no zero row — "you never left this
  session overnight" is not news), and the same wording appears on the all-sessions screen under the
  whole-corpus cut ONLY, beside the unpriced and fast-mode clauses. **A rebuild is not drawn on any
  chart** (the window does not move, and the two event colours are a validated pair) — in the values
  view it wears the INK dot, never the usage-limit red, which would claim the account refused a
  request.
  **`CompactionPanel` is what the ticks DID** — two rows split by trigger, tokens AND money on each
  side (a cache read against a cache write differ up to 20× in price, so the counts alone are not a
  ratio). **`compactionMethodText()` FOLDS** into a `hint-more` disclosure — four sentences of method
  under two numbers already on the rows — kept, never deleted: it is why the ratio errs against
  compacting. The sentences' own rules (never-spent saving, `saved 0` refused, `compactionWindowText`,
  `unmeasured`) are `shared`'s `sessioncost.ts`; here `compactionWindowText` sits DIRECTLY under the
  multiple.

### `RepoHealthTiles.tsx` + `RepoHealthLongest.tsx` + `repoHealthPlot.ts` + `repoHealthWords.ts` — the series as charts (full original)

- `RepoHealthTiles.tsx` + `RepoHealthLongest.tsx` + `RepoHealthTable.tsx` + `repoHealthPlot.ts` + `repoHealthWords.ts` — **the repo-health series as
  charts, in `SetupSheet.tsx`'s region 2** (the sheet itself ⇒ `web-work`). Hand-rolled SVG on
  the `ContextGraph`/`contextPlot` pattern, **no charting library**: geometry pure in the `.ts`,
  paint in the `.tsx`, every sentence in the words module. **The TOOL states, you draw** —
  `repoHealthPlot.ts` has NO imports and `repoHealthPlot.test.mjs` asserts BY TEXT that it cannot
  name a percentile, rank, slope, median, regression or `.sort()` (the guard shape
  `tools/repohealth.test.mjs` uses on `judge.mjs`); a number a chart wants is added to the TOOL.
  **Six stat tiles** (`size.p95`, `retouch.rate` **with its denominator beside it**,
  `hatches.perKloc`, `context.claudeMdChars`, `context.descChars`, `untested.count`) — so the VALUE is the answer and a tile whose curve cannot
  be drawn still prints its number. Full-width ~32px sparkline, **ink at reduced opacity, end dot in
  `--accent` ringed in `var(--panel)` — never `--ctx-series`**, which means "this conversation's
  tokens" everywhere else and would claim the wrong entity. **x is the READING INDEX, not the
  calendar** (a 57-day hole would empty two thirds of every tile) and the caption says so — the
  **day ticks are the days AT three positions in reading order** (`indexTicks`, `want` with NO
  default: how many labels fit is the caller's fact), so the middle label is the middle READING and
  not the middle of the span; **a null
  CUTS the line** — never interpolated, never at zero — a lone reading is a dot and a lone stack
  column a hairline; **a flat series draws at MID-height**, because `(v-lo)/(hi-lo)` is 0/0 and
  paints `NaN`; **y is fitted per series** (six units, no shared axis) except the stack and the
  dumbbell, which are zero-based magnitudes — and **both fitted bounds are PRINTED up the left**
  (`hiY`/`loY` = `py(hi)`/`py(lo)`, so a label lands on the line it names; one label for a flat
  series, since two identical numbers on two edges read as a span), because an unlabelled fitted
  axis reads as a zero-based one and every rise on it looks like a doubling. **Crosshair: the
  INDEX is state and the pixels are derived each render** — held as coordinates it outlives a
  rotation and the ring then marks a different point than the words name; it snaps only to drawn
  readings (holes are not in `pts`), and **its answer is a TEXT LINE under the chart** carrying day
  · value · `sha7`, never a floating box. **On touch, lifting does not clear it** (`pointerleave`
  fires when a touch pointer is destroyed, so one handler for both wipes the answer as the finger
  moves off it) — `clearsOnLeave` is mouse-only, `pointercancel` RESTORES the pick the gesture
  began with (a vertical scroll over a tile fires down-then-cancel and would otherwise re-pick
  every chart it passed), and a second touch on the chosen reading lets go. This line is the ONLY
  route to a past day's figure here — there is no values table as `ContextChart` has — so it is
  always present and says how to use it. **Always-on weight = two stacked bands** in
  `TokenComposition.tsx`'s validated `SLOT`, top edge = the total, two-entry legend: the one chart
  here that prints a total, so it prints the split in the same mark; bands accumulate in VALUE space
  and a column any band is missing is a hole in EVERY band. **Per-area `expected → ceiling`
  dumbbell**, latest reading, ONE x scale (the comparison is between areas); `subs: 0` is one
  number, not a zero-length bar. **Magnitudes in the OPEN, never behind a fold** — lines by package
  as a STACK over time (top edge = the whole tree), source files and production deps as curves with
  **no rank and no slope beside them** (nothing compares them to anything, and a tile's clothes
  invite a reading nobody took), the longest-files tape as columns in the tool's order; **p95 and
  the longest file are WORDS, not rules**, since a dash means a threshold on every other chart
  here. `RepoHealthTable.tsx` prints the same figures as TEXT — last 14 readings, oldest first so a
  row runs the direction the pixels above it do, packages folded by the same `foldPartSeries` the
  stack uses — because two band hues are under 3:1 on light and a crosshair answers for ONE day.
  **No *open the drawn page* button**: `.claude/outbox/repohealth.html` is still written and still
  the better read on a desktop, but every card on it is on this sheet, so it is a SENTENCE naming
  the full path (`drawnPageWords`) and not a control offering a second surface. **Every metric
  carries a `?`** (`HintChip.tsx` → `showHint`, ids `repohealth.<series key>` in the shared
  catalog): one explanation per subject, reachable by chip and by long press, never a second copy of
  the words — and a missing entry is a failing test in `tools/repohealth.test.mjs` (text match) plus
  a scan for `<HintChip id="…">` / `hint="…"` in `scripts/e2e-hints.mjs`, because a chip with no def
  renders NOTHING and five explained tiles beside a bare sixth read as "that one is obvious". **No
  coloured band, zone, grade or red region anywhere, and no `--warn`/`--dead`**: the slope is a
  glyph in `currentColor` with its word beside it, because rising LOC and rising hatches are
  opposite news. Four validated slots, **never a generated fifth** — `foldParts` folds the tail into
  one hueless band, and a slot follows the ENTITY, not its size today. **Measured width prop**, like
  `ContextChart`, via a CALLBACK ref (the box is conditional and the read async, so a `[]`-deps
  effect leaves width at 0 for the life of the sheet). **Not plotted, and said so with the reason**:
  tripwires (events, not series), the path lists (top three ride in the row's `detail`), and
  `dups.pairsPerKloc`/`cochange`, which the tool reads with NO rank — a curve would invite one.
  **The longest file LEADS the region** (`RepoHealthLongest.tsx`): its length over the series with
  the tool's per-reading `longest.paths`, one run per HOLDER via `holderGeom` — **slots go to the
  NEWEST holders** (today's file is always slot 0; past four the oldest fold to ink), a hole cuts a
  run, and a handover is a solid ring in the new hue plus a thin ink step, **only between two NAMED
  readings** (a missing name is not the file changing). No `paths` on the wire ⇒ one ink run and the
  caption says a new holder cannot be told from growth. Today's tape sits under it.
  `repoHealthWords.ts` is under a test banning verdict words AND status tokens: **`rankSentence` is
  the ONE fraction→percentile conversion on this side** and **a null rank returns the tool's own reason, never a `0th`**; absences are a sentence
  each — a family absent, under 2 readings, `plot` absent vs `null` vs an object
  (`repoHealthPlotAvailability`, three states), and a mixed `PREREG_VERSION`, where the charts are
  **still drawn** over the rows on disk while saying so, because refusing removes the only view of
  the problem. **Every reading says WHOSE it is, once per group as a heading, never a badge per
  tile**: the engine's (`source: "central"`, worded with `BRAND.displayName`) and the repo's own
  (`plot.own`, `RepoHealthOwn.tsx`, `ownShow`'s three states): the repo's `means` on its tile, its
  direction ATTRIBUTED to the repo, never the sheet's verdict; no `own` block on the wire says
  nothing (absent ≠ declares none); a repo declaring nothing gets ONE line naming the file.

### `TokenStatsSheet.tsx` + `usageCut.ts` — the token ledger screen (full original)

- `TokenStatsSheet.tsx` + `TokenInsights.tsx` + `statsInsights.ts` + `statsPlot.ts` + `usageCut.ts` + `guests.ts` — **now `extensions/token-stats/web/`** (token-stats-architecture.md; plot + strip in `kit/chart/`). **SEVERAL ledgers, never one number.** A SOURCE PICKER (not a
  filter ⇒ **no counts on the chips**): Claude's, plus one chip per CONTRIBUTED ledger view — an
  extension's `ledgerViews` (`LedgerViewDef`, `@waterplane/sdk`; `guests.ts`), each drawn only when
  its `hasData` says the host answered with something in it, else pixel-identical; never greyed;
  resets each open. The sheet reads `/api/tokenstats/<id>`, caches it under the id, and LENDS the
  view its widgets (`LedgerViewParts`); the guest's "All backends" card is its `summary`, totalled
  and split HERE. **The docs never meet in one reducer** — different accounting, so a merged total
  is the most convincing wrong number here.
  **ONE STICKY SPAN for every box** (`span.ts`, R-usage-025, web.md); only the compact NOW block
  above it is unfiltered. Calendar spans are CALENDAR days; what cannot be cut says so. Charts
  measure the CONTENT box.
  Insights (`statsInsights.ts`) are ABSENT unless measured and large, never a control; costliest
  conversations are drawn IN MONEY. `LimitWindows`' refresh carries the WORD *re-read*. **`TableView` takes the
  window CUT** — the twin once printed ALL-TIME lists under a live-window heading.
  A contributed view owns its document's rules (its README); the sheet's rule it inherits is **no
  price it cannot source** — `pricing.ts` is claude's table. The limit windows carry a CHART of the kept readings (`UsageSpark`) —
  not a sparkline: 40px of unlabelled shape was read as one, its breaks meaningless. So the 0–100 axis is **fixed,
  never fitted** AND **labelled on all three rules** (an unlabelled fixed axis reads as a fitted
  one), there is a **time axis** under it (weekday only where it crosses midnight, or the labels
  collide), and the reading under your finger is a **text line under the chart** on
  `RepoHealthTiles.tsx`'s crosshair rules — the selection is the reading's own TIMESTAMP, since this
  series grows at its end. **A gap is CUT, a rollover is CUT and drawn, and `usageMarksText` names
  each mark ONLY where it was drawn.** A rollover is two signals, never the scraped reset alone:
  the instant moved past `RESET_EPS_MS` (now `shared/burn.ts`; the CLI prints a wall-clock MINUTE and recomputes it as the
  window slides, so `!==` marked dozens of rollovers that never happened), **or the figure FELL past
  `DROP_EPS_PCT`** — the reading taken as a window rolls names no reset at all, so the instants
  either side are compared against an unknown, and inside one window the count only goes up. The
  burn rate / "full around" projection is **absent** rather than approximate. The per-day chart has
  `total` / `mix` / `share` — `share` is the only reading that moves when the total does not — plus a
  **7-day mean over CALENDAR days, computed over the whole series then clipped**. The time series
  are **columns or an area** (separate chips): an area is drawn only over the GAP-FILLED series
  (`fillSeries`/`fillMix`; measured zeros), a normalized stack stays **cut** at an empty bucket, and a
  window too wide loses the chip rather than dimming it (web.md). `Per hour` is the
  same chart with `stepMs`; the clock face is **categorical, all 24 slots drawn**. `LimitWindows` leads because only those two percentages have a CLOCK on them.
  **The hero never appears without the split.** Prices exist on the CLAUDE view
  ONLY and always as a labelled COUNTERFACTUAL off one dated table. A week is a WINDOW you step
  through; inside one week gaps are FILLED, and the cumulative line stops at TODAY.
  **Two KINDS of span, one control**: a live rate-limit window or calendar days. `usageCut.ts` is
  the live cut, pure and
  node-tested: a window is `resetAt − len`, and because the finest bucket on record is a `TokenHour`
  the cut **starts at the NEAREST hour to the instant the window opened (`windowStartHour`, shared —
  ONE helper for every window edge, host fold and phone alike) and SAYS which way it errs** (`cutSpan`,
  `leadClause`: first hour counted whole / first minutes left out) — exact about a stated span, never
  approximate about the window. The floor it replaced counted 59 min of last week into a Thu 18:59
  week (≈ 4 pts on a 35% meter).
  **Three refusals, three sentences, never a zero** (`cutRefusalText`): no reset instant · the
  reading's window ALREADY RESET (a real scrape describing the previous five hours is the dangerous
  one) · the hour record does not reach back. A refused window has **no chip**. The cut carries
  tokens, cost and a model split (host `TokenHour.byModel`, `modelSplit` false on an older host ⇒ a
  sentence, and **one EMPTY split is a quiet hour, not an old daemon**); it carries **no repos and no
  conversation count** — an hour bucket has neither — so under a window *By repo* is the host's cost
  window (a sentence while unread or 404) and the hero counts TURNS. `WindowTiles` is its own four tiles, not `Tiles` filtered: four of
  those six are facts about the corpus. **One `windowCut` call feeds both** the figure under the
  limit bar (`WindowUsed`, a full-width button — a figure on a control is a filter) and the chip's
  cut.
  **And every window BEFORE this one is a BOX** (`WindowHeats`/`WindowHeat`/`WindowStep`,
  `usageCut.ts`'s `windowSpecs`/`windowGrid`/`seriesCut`/`heatFrac`/`heatStep`, host
  `GET /api/tokenwindows`): 3% of a window has nothing to compare it against; the
  only history was a 24-hour strip of scraped PERCENTAGES. **The host folds them**
  — the document ships a fortnight of hours, so this side can cut the window running now and nothing
  older — but **the GRID goes UP** (`anchor` is the scraped reset, `lenMs` is `LIVE_WINDOWS`'), so the
  two windows' semantics stay in one table here. **The hour rule is repeated, never re-decided**: a
  cell is `[windowStartHour(opened), windowStartHour(reset))`, so cell 0 and the line under the limit
  bar cannot be two numbers about one five hours, and neighbours TILE — every hour in one box. **A window that ran nothing is a real empty box; one the
  record does not reach is an OUTLINE** (`oldestHour` tells them apart, and the grid ENDS at the
  record rather than drawing unknowns back to the epoch). **TWO grids, never one scale** (a week holds
  ~34 five-hour windows), each legend naming its own busiest box; the ramp is **one hue at five
  alphas off `--accent-rgb`**, never the categorical `--chart-*` slots (those mean identity), and
  **square-rooted** with the caption saying so. A tap is the same `{id, back}` the stepper writes —
  ONE idea of what is selected — and **both ends of the stepper are SENTENCES** (nothing newer has
  happened · the record stops here), never a dimmed arrow. A past window is the SAME `WindowCut`, so
  `cutSpan` counts to its own reset rather than "to now" and the tiles swap *Resets in* for *Ran
  until*; **`hours` is OPTIONAL on a cut now** (absent = the host folded it, never "there were none")
  and `isCut` keys on `openedAt`. An older host answers nothing and the screen is pixel-identical.

### `RepoHealthMags.tsx` + `RepoHealthOwn.tsx` — magnitudes and the repo's own readings

`RepoHealthMags.tsx` was split out of `RepoHealthTiles.tsx` past the 900-line cap along the line the sheet draws: the tiles are
READINGS (a value against its own past, with a percentile and a slope), the magnitudes are not (a size, a split of a whole,
a distribution of one day). Captions split the same way, `repoHealthWords.ts` and `repoHealthStackWords.ts`. The geometry is
still `repoHealthPlot.ts` and the stack is still the tiles' `StackChart`: two implementations of "a stack whose top edge is the
total" would disagree about a hole in a band. `RepoHealthOwn.tsx` draws a repo's OWN readings under the engine's, with the
provenance said once in the heading (`ownShow`'s three states), using the same `SeriesTile`.

`RepoHealthTiles.tsx` was split again: `RepoHealthChartKit.tsx` holds the shared marks (curve ink, `XAxis`, `Crosshair`, `gutterFor`, `plotX`; the tiles re-export them), `RepoHealthStack.tsx` the one `StackChart` and `WeightStack` (a stack whose top edge is the total), and `RepoHealthWeight.tsx` the per-area `AreaSpread` dumbbell and the `WeightCard`.

### `HealthIndexChart.tsx` + `HealthIndexSection.tsx` + `healthIndexWords.ts` — the health score on the phone

One weekly number out of 100 against fixed good values (`shared/healthindex.ts` is the one layer that takes a side and owns
the arithmetic, the cap and the alerts), its trend, its line over weeks and the picked week's five entry scores with what
each added — always in the open. `healthIndexWords.ts` is pure (`healthIndexWords.test.mjs`): it rounds what the wire carries,
turns it into pixels and words it; it computes no index, move or percentile. `HealthIndexChart.tsx` paints a handed
`HealthIndexResponse` and reaches no socket (the phone fetches it in `HealthIndexSection.tsx`, the VS Code panel derives it
from the series file). Ink curve, accent end dot ringed in the panel colour, fixed 0-100 axis labelled on every rule; the one
colour is the alerts' (`--dead` severe, `--warn` warn) with icon and level in words. `onAsk` is a slot for the week's subject,
not a send path. Absent `healthIndex` on a RepoTarget draws NO chip, never `Health 0`.

### `TurnCostCard.tsx` + `TermCostStrip.tsx` + `lastTurnCost.ts` + `turnMix.ts` + `NextTurnCost.tsx` — per-turn cost

`TurnCostCard.tsx` is ONE component for both views: `CostFold` (one-line head, which prompt, chevron, the card under it) and
`TurnCost` (the card). The reader draws a fold under every turn; `TermCostStrip.tsx` draws the newest turn WITH figures under
the terminal in exactly two fixed heights (a resize repaints the whole PTY screen), found once stays found for the session,
and it reads the same IndexedDB transcript copy the reader seeds from, refreshed by the turn-end `prefetchTranscript`, never
per PTY byte. `lastTurnCost.ts` (pure) picks which turn the strip speaks for and says which prompt; a turn has FIGURES when
there is a price, a context reading, a token split or a model, else the strip is absent, never a row of zeros. `turnMix.ts`
makes the model donut and subagent chips as data; a model's hue is FIXED app-wide (`modelHue.ts`: four family slots and one
grey tail). `NextTurnCost.tsx` (the next turn against a fresh session: a reading, never a gate) is shared with the VS Code
session view; a shell with no doors passes `noDoors`.

### `BudgetField.tsx` + `SessionBudgetSheet.tsx` + `budgetInput.ts` — the session budget

`budgetInput.ts` (pure, `budgetInput.test.mjs`) is top-level because three screens that are not the feature draw the field
(Send sheet, launch ask, context sheet panel) and a top-level module may not import a feature. It owns only what the host
cannot say: how a typed string becomes a cap (four units, dollars first, with presets) and the calibration as a sentence;
every verdict figure is `@waterplane/shared`'s (`sessionBudgetText`, `sessionBudgetChip`, `sessionBudgetLabel`,
`sessionBudgetUnknownText`). `features/sessionBudget/SessionBudgetSheet.tsx` sets, changes or clears ONE session's cap in the
Settings screen's layout: with no valid cap typed the set button is ABSENT and a sentence stands in its place, clear is a
`ConfirmButton`, and "Set" is said only when the desktop answers with the cap (`budgetConfirmed`).

### `kit/chart/chartWords.ts` — one line under every scrubbable chart

The text under a chart before a finger is on it. It was spelled three ways on screens read one after another ("touch the chart
for the reading under your finger", "drag across the curve for a day's reading", "drag across the chart to read a value"),
which reads as three gestures for one; `SCRUB_HINT` is now the one wording. Pure and import-free so the repo-health words can
re-export it under `node --test`, and an extension reaches it through `@waterplane/kit`.

## Modules the `web-work` skill names that this file never covered (2026-10-17)

### `backlogFilter/runAgain.ts` — the `run it again` verb and `requeuedWords`

Part of the `backlogFilter.ts` barrel (pure, `.ts` specifiers so `node --test` loads it off the source). It holds the
`runAgain*` family (`runAgainState`, `runAgainEligible`, `runAgainIds`, the label/note/toast words) and `requeuedWords`.
A backlog has two kinds of dead row: a one-off stuck on its CLOCK (*drop the clock* takes the instant off) and a row that
simply FAILED, which is terminal and has no clock; `run it again` is the second verb. The full rules are in the
*`drop the clock` and `run it again`* section above.

### `shared/schedule/schedfire.ts` + `schedhorizon.ts` — fire instant and horizon buckets

Slices of the shared `schedule.ts` barrel (import the barrel, never a slice). `schedfire.ts`: `nextFireAt` (the next instant
a rule fires, strictly after `after`, null when it never will again; the weekly search walks candidate anchor days, not fire
days, because a negative offset lands the fire on the previous evening) and `isStandingSchedule` / `SPENT_ONCE_TEXT`.
`schedhorizon.ts`: `horizonBucket` / `horizonLead` / `HORIZON_LABEL`, the schedules chip's count bucketed by how far out it
is ("7 scheduled" means opposite things whether all seven fire tonight or the next is a fortnight away); the chip and the
sheet's list call the same function so the tap opens what the number counted.
