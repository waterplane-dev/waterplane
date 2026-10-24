---
name: host-core
description: waterplane host — a live session and how words reach it (packages/host/src): `backends/` (`claude.ts`, claude-local, claude-endpoint, `shell.ts`), `ptyenv.ts`, `sessions.ts` + its `sessions/` slices, `deliver.ts` + `echo.ts` + `composer.ts` + `settle.ts`, `agents.ts` + `shells.ts`, `screenlog.ts`, `halt.ts`, `answergate.ts` + `askrules.ts`, the plugin host. Load BEFORE adding a backend, spawning or resizing a PTY, changing how a prompt is typed into a live session and confirmed, letting anything but a person's tap answer a box (or forcing a tap before a command), touching what a plugin may see or do, halting, or reading back the screen, the scrollback or what runs under a session. Never fork `deliver.ts`.
---

# waterplane host — a live session and how words reach it

One live PTY session, end to end: which binary it drives, how words get typed into it and proven to have landed, and what can be read back off the screen afterwards. Router: `host`. Reasoning: [host.md](../../../docs/notes/host.md), [host-architecture.md](../../../docs/notes/host-architecture.md), [plugins.md](../../../docs/notes/plugins.md).
- `backends/` + `claude.ts` + `claude-local.ts` + `claude-endpoint.ts` + `overhead.ts` + `shell.ts` + `claudemodels.ts` + `claudebin.ts` (src root, not in `backends/`) + `derive.ts` (+ `packages/extensions/opencode/`) — WHICH binary a session drives, as data. `types.ts` is the descriptor
  (`bin`/`prepare`/`delivery`/`caps`/`facts`/`models`/`healthScope`; `prepare` may be async for a plugin and `create()` awaits it before the spawn); `caps` is binary facts only, `facts` the provider table (`{source}`/`{screen}`/`{store}` per fact, first that answers wins), and **`derive.ts` is the ONE reader of it** — every gate asks `derive(b).screen/store/askSource/hooksInBand/keepsClaudeLog`, the wire caps are `wireCaps()` (byte-pinned, `backendinfos.pin.test.mjs`), never a `caps.<reader>` string; `backends/claude.ts` is today's
  behaviour moved verbatim and **the ONE place `WATERPLANE_CLAUDE_BIN` is read**, plus the
  four-mode argv and the `--settings` hook blob. `claudebin.ts` resolves it: knob > PATH > the usual install dirs > bare `claude`; under WSL a Windows-side install is reported, never used. `resolveBackend(id?)`: absent ⇒ claude; an
  **unknown id THROWS, naming it and the known ids** — never `?? claude`, which would spawn
  something other than what was asked for and say nothing. **`facts` gates whether a reader RUNS,
  never what it ANSWERS**, so fewer capabilities can only mean absent facts; `healthScope:false`
  files NOTHING with `noteHealth`. An empty `models()` means a free-text field, never a guess. **An unavailable backend is LISTED with a sentence, never hidden.**
  `claude-endpoint.ts`: the KEY never travels in argv, env, a log or the wire (`apiKeyHelper` inside the `--settings` blob; no key ⇒ `ANTHROPIC_AUTH_TOKEN=none`, so the claude.ai credential never reaches a third party; `claudeendpoint.test.mjs`).
  `claude-local.ts`: ABSENT beats borrowed (a 0/failed probe ⇒ absent window and cost, never claude's table); LEAN tools by default (`WATERPLANE_CLAUDE_LOCAL_LEAN`). `overhead.ts`: no entry rather than a neighbour's.
  **A launch plan must say `instructionsVia` and `askRulesVia`** (`SessionInfo.told`/`askRulesVia`: the phone says "not told"; `gate` ⇒ `answergate.ts`'s `holdAskRules`, refusing a plugin's answer to a box matching a launch-time rule). The repo text is `reposkill.ts`'s `repoInstructions`, handed in as `req.instructions`, never a plugin's own. **`launchfiles.ts` writes the plan's `files`** (`session:<n>` ⇒ `<state dir>/launch/<hostSessionId>/<n>`; absolute only inside the plugin's `dataDir`; all checked before byte one; never the repo or `~/.<cli>`; boot sweep at 7 days). Slots beyond turns/dialogs: `questions`, `usage` (+`wall` as the `limits` fact), `agents`, `conversations`; `plan` is consumed (`sidechannel.ts` publishes claude's plan box from it, `plan.path` EMPTY — no file; answered by `sourceanswer.ts`'s `answerSourcePlan`: a person's tap only, one verb at most once per plan) and so is `mode` (2.2, `livemode.ts`); `conversations.fork` is consumed by `session.create` (`convfork.ts`), `commands` by `/api/slash?backend=` and `slash.ts`'s `deliveryCommandFacts` (the SESSION's descriptor rule, never claude's list; a listed `local` beats it). `deliver.ts`/`echo.ts` literals are DECLARED here and still owned there — pinned equal by
  `packages/host/test/backendargs.test.mjs`. opencode (IN-REPO EXTENSION on `api.backend()`; readers `api.screenReader`/`api.storeReader` in `backends/readers.ts`; toolkit `plugins/plugintoolkit/`; rules in its private README) fills 2.2 slots `context.sample().window`, `context.compactions`, `tokens.session`, `commands`, `conversations.remove`; `mode` is absent by measurement.
- `ptyenv.ts` — the env floor every PTY starts from: launchd inherits almost nothing, so a UTF-8 `LANG` is supplied when the environment has none (a tmux client that cannot conclude UTF-8 flattens `❯` to `_` and prompt detection reads nothing — the `protocol` skill's locale trap) and `USER`/`LOGNAME` are filled (without `USER` a `/usage` scrape never paints the account rows); a value already set is never overwritten; never spawn a PTY from raw `process.env`.
- `sessions.ts` — `SessionManager`, the facade: the constructor and hub, `create`/`fork`/`register`
  (the ONE PTY wiring), `rediscover`, the lookups and one-line delegations; the rules below live in
  the slice each sentence names. **Every claude-shaped reader is armed only where the session's
  descriptor says the backend HAS the thing** (`backends/`), and an absent capability makes the
  FIELD absent — no `limit` object rather than an unblocked one, no `contextLeft` rather than 0%, no
  `lastTurnAt` rather than a stamped clock; a hook event for a session with no hook pipe is DROPPED
  (`claudeHookWatched`; `routeHook` never offers a hookless session to the cwd fallback,
  `turn.ts`); and one private
  `noteFor` (`health.ts`) gates every `noteHealth` on `healthScope`. Its `--settings` hooks curl `POST /api/hook` (the positive turn-boundary signal; no pipe ⇒ silence heuristics; meaning: `backends/claude-sources.ts`). Limit-exit resurrection is `resume.ts`. **`drive.ts`'s `resize()` and the facade's `create()` FLOOR the
  client's geometry** (rule: `shared` skill, `ptysize.ts`). Clamped, never refused.
- `sessions/core.ts` + `sessions/knobs.ts` + `sessions/tmux.ts` + `sessions/convid.ts` + `sessions/health.ts` + `sessions/ctxseries.ts` (also RECORDS a source's series; [host.md](../../../docs/notes/host.md)) + `sessions/roster.ts` + `sessions/wall.ts` + `sessions/resume.ts` + `sessions/turn.ts` + `sessions/idlewatch.ts` + `sessions/boxes.ts` + `sessions/drive.ts` + `sessions/record.ts` + `sessions/links.ts` + `sessions/livemode.ts` — the first cut of `sessions.ts` into slices
  ([host-architecture.md](../../../docs/notes/host-architecture.md); the per-slice ownership inventory: [host.md](../../../docs/notes/host.md#sessions-slices--the-per-slice-ownership-inventory)). `core.ts` is TYPES ONLY: `Session`,
  `LiveMeta`, `ClosedRow`/`RecentRow`, and **`SessionCore` — the one way a `sessions/` slice reaches
  shared state or another slice**. The facade implements it as a PRIVATE object literal whose every
  member is an arrow delegating at CALL time (another slice's state is an accessor, never a captured
  field — `resumeWaiting` and `recentlyClosed` are reassigned); a slice never imports a slice or the
  facade, and a missing member is added to `core.ts` in review. `knobs.ts` is every module constant and `WATERPLANE_*` read (safe because nothing assigns `process.env` at import — `hostshape` checks that).
  `tmux.ts` is the substrate (the only one): spawn inside tmux, re-attach, `tmux.conf`, the `live/`
  records and the orphan sweep. `rediscover()` deletes a `live/` record only past a SUCCESSFUL `tmux ls` (`staleLiveIds`: absent
  from it, stamped with THIS server, older than 1 h, not held) — a failed listing is never an empty one.
  `convid.ts` finds which conversation a session is in (exactly one candidate or none); `health.ts` holds `noteFor`,
  the ONE direct `noteHealth` under `sessions/`, gated on `healthScope`.
  `roster.ts`: **`closedBy` is named by whoever calls `remove`/`kill` (`s.closeBy`); the exit path
  only infers `limit`/`exited` for a session nobody killed; every fact optional, absent = unknown.** The per-session plugin state (toggles, the "let <plugin> answer" switch) is memory only, so a restart puts it back OFF. **File read order: roster's files, then `revived.json`, `limit.json` LAST** (`resume.ts`, then `wall.ts` — `limit.json` LAST; the resume queue's state is reached only through `core`).
  `wall.ts` + `resume.ts`: the auto-continue config, reading a block off screen + log (`checkLimit`), the continue ladder, resurrection of a limit-exited session and `revivedSessionFor`.
  `boxes.ts`: the two answer walks (`choosePromptBox`, `submitPromptBox`) and the earliest-wins `armPromptCheck`. `turn.ts`: the hook lifecycle and turn flag. `idlewatch.ts`: output ends idle only when the working line is on the grid (a redraw is not work).
  `record.ts`: the prompt history, the reader's transcript, search, the tab name, `lastTurnOf`. **There is NO per-turn AI
  summary**. **`nameTab()` is the ≤4-word
  name a phone TAB wears** (`SessionInfo.tabTitle`): its ONLY
  input is the session's FIRST PROMPT (`firstPromptOf`, ≤1000 chars) — never the
  screen, a summary or a later prompt. Gated on the field being ABSENT so it fires
  once per session ever (the first `idle` after a prompt exists; `s.nameAsked` stops a refusal being
  re-bought), persisted as `{tab}` in
  `<state dir>/summaries/<id>.json` (a restart must never rename every
  tab), refusing through `shared/naming.ts`'s `cleanTabTitle` rather than guessing; its flags and wording are `host-spenders`'.
  **`nameNow()` is `nameTab` asked BY HAND** (`session.name`): the first prompt PLUS the last 4 non-command prompts,
  holding `s.naming` so the automatic pass cannot land behind it; no prompt yet ⇒ a sentence, and
  every failure is a SENTENCE and the existing name STAYS.
  `lastTurnAt` (`lastTurnOf`) is read from the CLI's own OUTPUT, never the log's mtime and never
  `idleSince`. Both per-session stores (`history/`, `summaries/`) are unwritten by `remove()` and
  otherwise ONLY by `tmux.ts`'s `sweepSessionStores`: orphans **older than 7 days**, armed once off
  `rediscover()`.
  `links.ts`: a SHELL session's `links` merged in ONE place (`addBrowserLink`, which lives 10 min; `setScreenLinks`, which keeps `at` per URL); only for `caps.turns === false`, emit on a
  change only, absent when empty. A shell (`backends/shell.ts`, `caps.turns: false`) gets ONE Return per delivery. Before
  typing, `deliverrun.ts` asks `shellLineFacts` (tmux `pane_current_command`, by NAME — the PTY's
  `?2004h` is tmux's own, never the pane's): a program in front ⇒ `retry` naming it (unless
  `awaitingCode`); a newline ⇒ one bracketed paste for zsh/fish, refused for anything else. A
  shell's create needs `origin.kind: "hand"` (`shellOpenRefusal`), its pane drops the daemon's
  `*_API_KEY`/`*_KEY_FILE`/`*_KEYCHAIN` (`LaunchPlan.dropEnv`), and it writes no prompt history.
  `livemode.ts`: `SessionInfo.liveMode`/`.ultracode` off `permmode.ts`
  (a null reading DELETES `liveMode`, `ultracode` is sticky;
  memory only) and `setMode` (`session.mode`): one shift+tab via `write`, re-read the LIVE grid until
  the footer changes, stop on the target / a repeat (not in the cycle) / 6 presses; refused in words
  with a box open or the footer unreadable; serialised per session (`modeChain`). Never counts positions.
  A backend whose `mode` fact is a source never reaches the footer: `liveMode` = `current()` checked by
  `sourceModeProblem`, `setMode` asks `set()` per step on the same ladder ([plugins.md](../../../docs/notes/plugins.md)).
- `deliver.ts` + `deliver/deliverrun.ts` + `deliver/deliverreturn.ts` + `deliver/deliverknobs.ts` + `deliver/delivertypes.ts` + `deliver/deliverscreen.ts` + `deliver/deliverproof.ts` + `echo.ts` + `composer.ts` — **the one implementation** of "type into a live session like a human, and confirm".
  `echo.ts` is the text rule ("is THIS text in that string", probes, paste chits, the log); `composer.ts` finds the box on rendered rows and hands what it holds to `echo.ts`'s `screenEcho` — it imports `echo.ts`, never the reverse. `deliver.ts` is the facade and the ONLY way in (`local/host-boundary` refuses a `deliver/*` import from outside the folder); `deliver/` holds its halves, MOVED, never copied — `runDelivery` to the echo verdict, its submit tail, the knobs, the types, the composer reader, the log/hook proof ([host-architecture.md](../../../docs/notes/host-architecture.md), "The deliver slices").
  `ok` / `retry` (nothing typed) / `unconfirmed` (written, never seen — never auto-retry) /
  `unsubmitted` (Return swallowed — say so, never retype). Echo is checked by POLLING the RENDERED
  screen and by PLACING the match **structurally** — inside the `❯` box (`composer.ts`'s
  `composerEcho`, shared with `settle.ts`), never by distance from the bottom of the render: the
  replay TEARS mid-turn and strands the live composer above stale rows. No box found ⇒ the old distance rule, never a brick — at the OLD DEPTH (`FALLBACK_ROWS` 40, not the anchor's `ROW_WINDOW` 100). After our write, a no-box proof is HELD `FALLBACK_HOLD_MS` (1 s) for a framed one — 2.1.304 draws the text bare between frames ([why](../../../docs/notes/host.md#deliverts)). Two frames that DISAGREE — a live empty
  box under a stale one holding submitted words — are not a composer either
  (`composerFramesAmbiguous` ⇒ `retry`, never a Return at nothing). **The miss sweep sends no Esc
  and no ctrl-U while a turn is active**. **ONE health observation per delivery**: a rescue records the
  `fallback`, and the trailing `good` is gated on the echo having been seen. **A multi-line write IS a
  paste** and collapses to `[Pasted text #1 +N lines]` — **and so is any write past 800 chars,
  whatever its shape, where the placeholder is BARE (`[Pasted text #5]`, no clause, because the
  clause counts NEWLINES and a phone message has none). **The composer is a VIEWPORT, not a field**: a box whose WHOLE contents are a window onto a long prompt's tail is an echo (`composer.ts`'s `scrolled`, `SLICE_MIN` 40), asked as a SUBSTRING not a suffix (`settle.ts` asks minutes later at any scroll).
  `e2e-scrollcomposer.mjs`. An absent clause is "zero newlines", never
  "no information" (`echo.ts`'s `PASTE_CHIT` / `pasteCollapsible`).** A TUI-local command (`slash.ts`) fires no
  `UserPromptSubmit`, so the proof is the screen MOVING and the sweep sends NO Esc. **A probe is a
  PREFIX, so a match is evidence only if nothing else could have produced it** (`echo.ts`:
  `screenEcho` says WHICH rule matched, `echoAmbiguous` asks whether another open delivery shares the
  head; ambiguous ⇒ `retry` saying so, and NO health observation — nothing was typed, so no echo
  was owed).
- `settle.ts` — what became of an unconfirmable delivery, asked LATER, from the CLI's log + screen:
  `landed` / `composer` / `absent` / `unknown`. **Read-only: it types nothing, ever.** **`absent`
  REQUIRES the log** and authorises a re-send, so a log turn is evidence for exactly ONE delivery
  (`spendTurn`). `composer` matches INSIDE the composer box only (`composerEcho`, the same rule and
  the same `ROW_WINDOW` as `deliver.ts`). **The LOG is compared WHOLE** (`echo.ts`'s
  `logEcho`), never on the screen's 14-char head. **A backend that keeps no claude log is asked
  NOTHING** (`sessions.keepsClaudeLog`, BEFORE `getTranscript`): only `source:"jsonl"` was ever proof.
- `agents.ts` — what is running UNDER a session: the Task/Agent tool, read off the CLI's own logs
  (`subagents/agent-*.jsonl` + its `.meta.json`). **The END is the parent's
  own `<task-id>` task-notification, not silence** — and it is compared against the agent's last
  write, since a notification fires each time an agent stops and `SendMessage` resumes one.
  Freshness (`WATERPLANE_AGENT_STALE_MS`, 10 min) is only the backstop for an ending nobody wrote down.
  **Polled, never evented**, armed ONLY while agents exist or a turn runs (agents launched mid-turn feed the phone's parallel count), and broadcast on a CHANGE — elapsed is counted on the phone
  off `startedAt`. **A signal, never an interlock**: `laneBusy`/`sessionWall`/auto-fire untouched,
  the same line `question.ts` draws. Degrades to an EMPTY LIST, never to a count nobody can see.
  **Background shells** come from the CLI's `~/.claude/sessions/<pid>.json` `status:"shell"`
  (`readCliRecord`, matched by tmux target, else a UNIQUE live conversation id) → `SessionInfo.shells`;
  `readCliRecord` also hands
  back the pid `shells.ts` needs to find the wrapper shells running under it. **Its per-session-id file cache is consulted ONLY on a tmux-target match**; a `tmuxName`-less lookup
  always rescans the whole directory (a cached record cannot re-prove "exactly one live process
  claims this conversation id").
  The footer's `← N agents` is machine-wide busy sessions, NOT subagents.
  `packages/host/test/agents.test.mjs`.
- `shells.ts` — what each background shell is actually DOING, off `ps -axo
  pid=,ppid=,pgid=,etime=,time=,command=` (memoised 2s). **The discriminator**
  (`isShellWrapper`): a direct child of the CLI's pid, in its OWN process
  group, running the CLI's own shell-snapshot wrapper — `pgid !== cliPid`
  alone keeps MCP servers and `caffeinate` out. `workers` is the wrapper's group minus the
  sleep/pipeline utilities — zero means the shell is, right now, only waiting; `workers === 0` wins
  over the CPU-moved check in `shared`'s `shellBucket`. The transcript join matches a wrapper's command against a Bash tool call's own to recover
  `description`/`taskId`/`launch` — no match ⇒ those stay absent, never guessed. `cpuMovedAt` is absent on a shell's first reading ("can't tell yet").
  **A `ps` failure or an uncaught throw in `readShellList` ⇒ the whole list absent**, never a partial one; a transcript-read failure only drops the join facts. Set `outputAt`/`outputBytes` only past 0 bytes — an empty output file is silence by design.
  **The wrapper's shape also matches a LIVE FOREGROUND Bash call**, so `SessionShell.foreground` is set whenever the join could not
  PROVE a background launch and the CLI's own record still says `"busy"`.
  `killShellGroup` (the `shell.kill` route and `drive.ts`'s close path) **re-checks ppid, own pgid and start time** (still a direct child of this cli, still its own group leader, start
  time within 2s of the one the caller saw) before signalling: SIGTERM, then SIGKILL after 3s, re-checking `ppid` before it; **a survivor
  is `ok: false, reason: "that shell did not stop"`**, never a false `ok: true`. `KillShellDeps` is injectable. `packages/host/test/shells.test.mjs`.
- `screenlog.ts` — **the desktop's scrollback, RECORDED, because it cannot be read back.** The CLI draws in
  the ALTERNATE screen, which keeps no scrollback. One live headless
  VT per session, fed as the bytes arrive, its grid diffed on a settle with `@waterplane/shared`'s
  `absorbScreen` — the SAME rule the phone uses; what differs is the vantage point, and that IS the
  fix. **`history` is the honest half**:
  false means nothing beyond the current grid yet, and the phone must then keep its own archive.
  `e2e-screenrec.mjs`.
- `sessions/budgetwatch.ts` — **a session's OWN budget, judged** (`BudgetSlice`, owns only the latest
  calibration; rule: `shared/sessionbudget.ts`; reasoning: [host.md](../../../docs/notes/host.md#sessionbudgetts--a-sessions-own-budget)).
  The cap and verdict live on `info.budget` (the ONE copy, persisted to `live/` by `persistLive`
  off the LIVE session); `Session.budgetTripped` is the
  interrupt-once latch. Judged at the end of every `refreshSpark`, on `setSessionBudget`, and on
  `setBudgetCal`. **Only the crossing into `over` emits `budgetTripped`**; the latch clears on `ok`
  or a new cap, never on `unknown`, and **unknown never trips**. The crossing's notify + ONE Esc is
  `server/sessionEvents.ts`'s, gated by `budgetEscBlocker` (interrupt on, env knob, running, no box,
  no unconfirmed delivery) and then `budgetEscScreenBlocker`
  on the LIVE grid in the write's own tick (`workingLine` now, no box on it) — a raw
  `sessions.write`, never a `deliver.ts` fork. Flipping only `interrupt` keeps the latch.
  **The Esc is OWED** (`budgetEscOwed`, persisted): retried on every judge while over
  (`budgetEscDue`) until sent; a person's send, `interrupt` off, a new cap or `ok` settles it.
  A backend with no claude log is judged from its own `tokens.session` (`readSourceSpend`, `SessionInfo.sourceSpend`); `budgetSparkOf` reads both ends; percent ⇒ `notClaude`, no figure ⇒ `unstated`, both unknown.
  `packages/host/test/sessionbudget.test.mjs`.
- `limitretry.ts` — the pure retry cadence for a limit-blocked session (`wall.ts`/`resume.ts` ask it): **a weekly wall's cadence must REACH the reset**. A DATED reset is trusted, a bare scraped clock is not. Reasoning: [host.md](../../../docs/notes/host.md#a-weekly-wall-gave-up-the-same-afternoon-it-started).
- `halt.ts` + `sessions/haltall.ts` — the emergency halt: latch first, then kill. New spawn path ⇒ ask `haltRefusal()`.
- `sessionSearch.ts` — a decision core lifted OUT of `SessionManager` so it can be asserted without a
  PTY. Hits are capped but keep being COUNTED.
- `answergate.ts` — **the one way anything but a person's tap answers a choice box**
  ([plugins.md](../../../docs/notes/plugins.md), "The answer gate"). `gateRefusal` is pure: manifest
  `answers`, the session's "let <plugin> answer" switch (default OFF, only `plugin.sessionAnswer`
  flips it), the SAME `promptFingerprint` the plugin was told about, never `trust`/`tool`/`plan`,
  never `isBlocked` wording, never a checkbox box, and
  `choice` among the options — each refusal a sentence, nothing typed. Accepted ⇒ the phone tap's own
  dispatcher, `sessions.answerBox` (`GateDeps.sessions` is `get` + `answerBox`, no typing verb —
  never `sessions.write`), a `sent.json` row `source: "plugin"`, a decision row, an `autofire` note.
  `packages/host/test/answergate.test.mjs` · `scripts/e2e-plugin.mjs`.
- `askrules.ts` — the inverse of the gate: the irreversible-action list injected into every spawned claude forces a TAP. Store behind `PUT /api/askrules` (a consent route: the `host` skill's confirm gate); corrupt ⇒ an EMPTY list, but `lost()` says so until a save lands; read per LAUNCH by `SessionManager.create`, so a running session keeps the rules it started with. Reasoning: [host.md](../../../docs/notes/host.md#askrulests-host--shared--ask-rules-a-box-before-an-irreversible-command).
- `sessions/sidechannel.ts` — **a backend's own channel, consumed** (`ChannelSlice`; state on
  `Session.channel`; one ladder per fact, source → screen reader → absent: `docs/notes/architecture.md`). Attached on `register()` ONLY for
  a descriptor with `sources` (none ⇒ today's session, `sideChannel` absent). Health →
  `SessionInfo.sideChannel` ("down" until it says up). `sources.turns` → `turn.ts`'s `sourceTurn` →
  the one `settleStop` (believed outright, idempotent: one turn, one `stopCount`), `hooked` true while
  up. `sources.dialogs` → `applyPrompt` with `askId` = the CLI's id, `nav: true`, oldest first,
  `pending()` reconcile on up; the screen reader stands down meanwhile (`boxes.ts`'s
  `screenReaderOff`) and so does the screen turn watch. **Down ⇒ everything handed back at once**
  (`hooked` false, its box retired, a prompt check armed now). **`boxes.ts`'s `answerBox` is the ONE
  answer dispatcher** — phone digit, `promptChoice`, gated plugin: the CLI's channel for its own box,
  else the walk (`nav`/`promptChoice`), else `"<n>\r"`; while the channel owns the dialogs a box it no
  longer knows is refused in words, never typed at. The slice INSTALLS `livesources.ts`'s lookup, adopts
  `SourceHandle.backendSessionId`, `suspend()`s rather than closes on a tmux detach, and answers
  `sendHold` (`delivery.requiresChannel` + channel not up ⇒ `deliver.ts` returns `retry` with the
  sentence, waiting ≤30 s only while still connecting). `packages/host/test/sidechannel.test.mjs`.
  `sources.questions` (2.0) publishes the same way as `kind:"question"` (`freeText`, options may be
  empty), oldest first ACROSS dialogs and questions (`posedAt`); `answerBox` takes `{text}` (phone
  `promptText` only — the gate never carries words). **`sourceanswer.ts` is the ONE place words reach
  a session outside `deliver.ts`**: a source's `SourceTyped` (≤1000 chars, no control char, Return
  only as a second write) typed only while the source holds that question open, a `sent.json` row
  each (`phone`/`plugin`), no `closed` in 5 s ⇒ `prompt.answerNote`. A `takesText` row answers keys, 500 ms, words, Return apart (2.1, `supports.dialogKeysThenTyped`). A source turn's `ended(at)` waits ≤`CONTEXT_FRESH_MS` for a context sample stamped ≥`at`. `packages/host/test/questions.test.mjs`.
- `plugins/pluginregistry.ts` + `plugins/pluginloader.ts` + `plugins/pluginapi.ts` + `plugins/pluginfiles.ts` + `plugins/pluginroutes.ts` + `plugins/pluginrpc.ts` + `plugins/pluginstreams.ts` + `plugins/builtin.ts` + `plugins/setupcontrib.ts` — the plugin host.
  Loader: `<config dir>/plugins/*/` + `plugin-paths.json`, `manifestProblems`, host module CONTAINED in its dir. Registry: **a broken plugin is LISTED
  (`state: "error"`, reason verbatim), never skipped, never fatal** — bad manifest, duplicate id,
  import failure, `activate()` throwing or over 10 s; a throwing handler becomes its status line.
  A `plugin.set` is refused WHOLE in words (enabled flags: `<state dir>/plugins.json`, absent ⇒ on). Loaded once at boot,
  never in `--doctor`. `firePrompt` records the fingerprint the gate checks. The API: every
  side-effecting call is dead once that activation is switched off (`gen`); `env()` only declared
  names; `readRepoFile` through `contained` and never a `.env`; `meter()` as `kind: "plugin:<id>"`.
  `repo(id)` reads through `contained` + `inRoot`, never a secret. `setupCheck`/`setupFix` are the
  ONLY way a setup row gets in (`compliance.ts` asks `setupcontrib.ts`); a core fix id is refused.
  **`api.stream` (1.4, `pluginstreams.ts`) is live binary on the ONE socket**: frames only to the socket
  that sent `stream.open`, never durable/acked/retried, a dead socket or a plugin switched off ends its
  subs; droppable frames skip past the backlog line, the key ask (and the key ending an episode) waits for the drain, and EVERY frame
  waits while that socket's PTY is held (`liveness.ts`'s `ptyHoldsStreams`). `pluginstreams.test.mjs` · `e2e-stream.mjs`.
  **`handToAgent()` is the backlog add (`agentintents.ts`'s `handToAgentVia`), never a side door**:
  waits for a tap unless `fire`. In-repo extensions (`packages/extensions/<id>/`, `builtin.ts`) get
  the same API, load first, always on, compiled by `tsconfig.extensions.json` into `dist/extensions/`
  `requirementsrow.test.mjs` pins the requirements row byte for byte.
  `packages/host/test/plugins.test.mjs` · `pluginseam.test.mjs`.
  `pluginfiles.ts` (`api.offerFile`): the file must resolve by realpath INSIDE the plugin's `dataDir`, no symlink; the 24-byte token is memory-only. `pluginroutes.ts` (`api.route`, `/api/plugin/:id/*`): served by `handleApi` behind the origin + token gates, matched with core `matchSegs`; `pluginRouteProblem` refuses methods outside GET/POST/PUT/DELETE, a `hook` path and duplicates. `pluginrpc.ts`: `plugin.call` is not durable; a repeat joins the in-flight promise. Plugin DTOs: `shared/plugin.ts`, `pluginfile.ts`, `pluginreadings.ts`, `backendsources.ts` ⇒ [plugins.md](../../../docs/notes/plugins.md).
