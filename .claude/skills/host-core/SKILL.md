---
name: host-core
description: waterplane host — a live session and how words reach it (packages/host/src): `backends/` (`claude.ts`, `resolveBackend` and its caps; opencode = `packages/extensions/opencode/`), `sessions.ts`, `deliver.ts` + `echo.ts`, `settle.ts`, `agents.ts`, `screenlog.ts`, `sessionSearch.ts`, `budgetwatch.ts` (a session's own budget), `answergate.ts` and the plugin host (`pluginregistry.ts`, `pluginloader.ts`, `pluginapi.ts`). Load BEFORE adding a backend, spawning or resizing a PTY, changing how a prompt is typed into a live session and confirmed, letting anything but a person's tap answer a box, touching what a plugin may see or do, asking later what became of one, or reading back the screen, the scrollback or what is running under a session. Never fork `deliver.ts`.
---

# waterplane host — a live session and how words reach it

One live PTY session, end to end: which binary it drives, how words get typed into it and proven to have landed, and what can be read back off the screen afterwards. Router: `host`. Reasoning: [host.md](docs/notes/host.md).

- `backends/` + `claude.ts` (+ `packages/extensions/opencode/`) — WHICH binary a session drives, as data. `types.ts` is the descriptor
  (`bin`/`launchArgs`/`delivery`/`caps`/`models`/`healthScope`); `backends/claude.ts` is today's
  behaviour moved verbatim and **the ONE place `WATERPLANE_CLAUDE_BIN` is read** (it was six), plus the
  four-mode argv and the `--settings` hook blob. `resolveBackend(id?)`: absent ⇒ claude; an
  **unknown id THROWS, naming it and the known ids** — never `?? claude`, which would spawn
  something other than what was asked for and say nothing. **`caps` gates whether a reader RUNS,
  never what it ANSWERS**, so fewer capabilities can only mean absent facts; `healthScope:false`
  files NOTHING with `noteHealth`. An empty `models()` means a free-text field, never a guess.
  `deliver.ts`/`echo.ts` literals are DECLARED here and still owned there — pinned equal by
  `packages/host/test/backendargs.test.mjs`. A second backend (opencode) is an IN-REPO EXTENSION on `api.backend()`, with its readers on
  `api.screenReader`/`api.storeReader` (`backends/readers.ts`); its measured rules — the autoupdate
  SAFETY env, the id that only rides `backendSessionId`, the catalogue filter, `providerHosting()`,
  the hybrid — are in the opencode extension's README (`packages/extensions/opencode/`, private, not
  in the public tree).
- `sessions.ts` — `SessionManager`, the facade: the constructor and hub, `create`/`fork`/`register`
  (the ONE PTY wiring), `rediscover`, the lookups and one-line delegations; the rules below live in
  the slice each sentence names. **Every claude-shaped reader is armed only where the session's
  descriptor says the backend HAS the thing** (`backends/`), and an absent capability makes the
  FIELD absent — no `limit` object rather than an unblocked one, no `contextLeft` rather than 0%, no
  `lastTurnAt` rather than a stamped clock; a hook event that routed to a hookless backend
  (`turn.ts`'s `routeHook` falls back to the newest session in the cwd) is DROPPED; and one private
  `noteFor` (`health.ts`) gates every `noteHealth` on `healthScope`. Injects
  `SessionStart`/`UserPromptSubmit`/`Stop`/`Notification`/`SessionEnd` hooks that curl
  `POST /api/hook` — the positive turn-boundary signal; no pipe ⇒ silence heuristics. Meaning: `backends/claude-sources.ts`. Limit-exit
  resurrection is `resume.ts`. **`drive.ts`'s `resize()` and the facade's `create()` FLOOR the
  client's geometry** (rule: `shared` skill, `ptysize.ts`). Clamped, never refused, and the
  clamp is what heals a session already stuck small.
- `sessions/core.ts` + `sessions/knobs.ts` + `sessions/tmux.ts` + `sessions/convid.ts` + `sessions/health.ts` + `sessions/ctxseries.ts` + `sessions/roster.ts` + `sessions/wall.ts` + `sessions/resume.ts` + `sessions/turn.ts` + `sessions/boxes.ts` + `sessions/drive.ts` + `sessions/record.ts` + `sessions/links.ts` + `sessions/livemode.ts` — the first cut of `sessions.ts` into slices
  ([host-architecture.md](docs/notes/host-architecture.md)). `core.ts` is TYPES ONLY: `Session`,
  `LiveMeta`, `ClosedRow`/`RecentRow`, and **`SessionCore` — the one way a `sessions/` slice reaches
  shared state or another slice**. The facade implements it as a PRIVATE object literal whose every
  member is an arrow delegating at CALL time (another slice's state is an accessor, never a captured
  field — `resumeWaiting` and `recentlyClosed` are reassigned); a slice never imports a slice or the
  facade, and a missing member is added to `core.ts` in review. `knobs.ts` is every module constant
  and `WATERPLANE_*` read, imported after the facade's own flat imports and before the modules only slices
  import; safe because nothing assigns `process.env` at import — `hostshape` checks that.
  `tmux.ts` (S2) is the substrate (the only one): spawn inside tmux, re-attach, `tmux.conf`, the `live/`
  records and the orphan sweep; the tmux server/name constants are knobs so any slice may use them.
  `rediscover()` deletes a `live/` record only past a SUCCESSFUL `tmux ls` (`staleLiveIds`: absent
  from it, stamped with THIS server, older than 1 h, not held) — a failed listing is never an empty one.
  `convid.ts` (S3) finds which conversation a session is in (claude's project dir, opencode's
  store — exactly one candidate or none) and the running model; `health.ts` (S3) holds `noteFor`,
  the ONE direct `noteHealth` under `sessions/`, gated on `healthScope`.
  `ctxseries.ts` (S8) is a CLASS (`CtxSlice`, owns `ctxWindows`): the context gauge, the row's
  spark, the per-model window, and the context-series/tool-detail documents (`host-ledgers`).
  `roster.ts` (S9) is a CLASS (`RosterSlice`): the recent shortlist, the reopen stack (each row built by
  `closedRowOf` — **`closedBy` is named by whoever calls `remove`/`kill` (`s.closeBy`), the exit path
  only infers `limit`/`exited` for a session nobody killed; every fact optional, absent = unknown**), stars, pins and
  the prompt labels, the watched ids and the per-session plugin state (toggles, the "let <plugin> answer" switch — memory only, so a restart puts it back OFF — and badges), `rename`; it reads its four files
  in the constructor, which is why the hub exists before it (the closed rows ask `hasLiveTmux`).
  `wall.ts` (S6) is a CLASS (`WallSlice`, owns `autoContinueOn`, `limitCfgPath`, `resumeMode`): the
  auto-continue config, reading a block off screen + log (`checkLimit`) and the continue ladder; the
  resume queue's state is reached only through `core`. It reads `limit.json` LAST of the files.
  `resume.ts` (S7) is a CLASS (`ResumeSlice`, owns the `resume*` state bar `resumeMode`, the guard and
  gap timers, and the revived pairings): the resume queue, resurrection of a limit-exited session and
  `revivedSessionFor`. It reads `revived.json` after the roster's files and before `limit.json`.
  `turn.ts` (S5) is stateless functions over the `Session` record: the turn flag (`setTurn`/`markIdle`),
  the hook lifecycle (`onHookEvent`, `routeHook`, the turn watch and Stop verify), the prose
  question and the agents underneath, the submits ring and the turn queries.
  `boxes.ts` (S4) is stateless functions: the choice box — when to look (`scheduleChecks`, the
  earliest-wins `armPromptCheck`), reading it (claude's and opencode's), publishing it, the
  sign-in link, `awaitingInput`, and the two answer walks (`choosePromptBox`, `submitPromptBox`).
  `drive.ts` (S10) is stateless functions: the public verbs — typing in (`input`, `write`, the tmux
  pan and copy-mode exit), readiness for automation (`waitReady`, `autoFireBlocker`), `resize`,
  `kill`/`detach`/`reattachById`/`remove`, and reading the screen back (`scrollback`…`idleMs`).
  `record.ts` (S11) is stateless functions: the prompt history and its capture, the reader's
  transcript, search, the tab name (`nameTab`/`nameNow` — the one unattended `claude -p` spend here,
  `host-spenders`), the `history/`+`summaries/` files, `lastTurnOf`. **There is NO per-turn AI
  summary** (removed 2026-10-01: it was the biggest unattended cost). **`nameTab()` is the ≤4-word
  name a phone TAB wears** (and the session header shows in FULL) (`SessionInfo.tabTitle`): its ONLY
  input is the session's FIRST PROMPT (`firstPromptOf`, `history[0].text`, ≤1000 chars) — never the
  screen, a summary or a later prompt. Its flags are CLAUDE.md's (no thinking too), gated on the field being ABSENT so it fires
  once per session ever (the first `idle` after a prompt exists; `s.nameAsked` stops a refusal being
  re-bought) — a tab that renames itself cannot be learned — persisted as `{tab}` in
  `<state dir>/summaries/<id>.json` (old files' `text`/`len` ignored; a restart must never rename every
  tab), and refusing through `shared/naming.ts`'s `cleanTabTitle` rather than guessing.
  **`nameNow()` is `nameTab` asked BY HAND** (`session.name`): one call off the first prompt PLUS the last 4 non-command prompts (`recentPromptsOf`; the automatic pass stays first-prompt-only),
  holding `s.naming` so the automatic pass cannot land behind it; no prompt yet ⇒ a sentence, and
  every failure is a SENTENCE and the existing name STAYS.
  `lastTurnAt` (`lastTurnOf`) is read from the CLI's own OUTPUT, never the log's mtime and never
  `idleSince`. Both per-session stores (`history/`, `summaries/`) are unwritten by `remove()` and
  otherwise ONLY by `tmux.ts`'s `sweepSessionStores`: orphans **older than 7 days**, armed once off
  `rediscover()`.
  `links.ts` is stateless functions: a SHELL session's `links` (`ShellLink`) — `addBrowserLink`
  (the `$BROWSER` shim via `POST /api/shell/open`, kept 10 min) and `setScreenLinks` (the screen
  reader's list, `at` kept per URL; `armLinksCheck` reads `shelllinks.ts` on the quiet tick) merged in ONE place; only for `caps.turns === false`, emit on a
  change only, absent when empty. A shell (`backends/shell.ts`, `caps.turns: false`) has no idle
  ping, no model-made tab name (static `shell · <repo>`) and gets ONE Return per delivery. Before
  typing, `deliverrun.ts` asks `shellLineFacts` (tmux `pane_current_command`, by NAME — the PTY's
  `?2004h` is tmux's own, never the pane's): a program in front ⇒ `retry` naming it (unless
  `awaitingCode`); a newline ⇒ one bracketed paste for zsh/fish, refused for anything else. A
  shell's create needs `origin.kind: "hand"` (`shellOpenRefusal`), its pane drops the daemon's
  `*_API_KEY`/`*_KEY_FILE`/`*_KEYCHAIN` (`LaunchPlan.dropEnv`), and it writes no prompt history.
  `livemode.ts` is stateless functions: `SessionInfo.liveMode`/`.ultracode` off `permmode.ts`
  (`checkMode` on `markIdle`'s quiet tick; a null reading DELETES `liveMode`, `ultracode` is sticky;
  memory only) and `setMode` (`session.mode`): one shift+tab via `write`, re-read the LIVE grid until
  the footer changes, stop on the target / a repeat (not in the cycle) / 6 presses; refused in words
  with a box open or the footer unreadable; serialised per session (`modeChain`). Never counts positions.
  Stateful slices are built right after the hub, which is built first in the constructor.
- `deliver.ts` + `deliver/deliverrun.ts` + `deliver/deliverreturn.ts` + `deliver/deliverknobs.ts` + `deliver/delivertypes.ts` + `deliver/deliverscreen.ts` + `deliver/deliverproof.ts` + `echo.ts` — **the one implementation** of "type into a live session like a human, and confirm".
  `deliver.ts` is the facade and the ONLY way in (`local/host-boundary` refuses a `deliver/*` import from outside the folder); `deliver/` holds its halves, MOVED, never copied — `runDelivery` to the echo verdict, its submit tail, the knobs, the types, the composer reader, the log/hook proof ([host-architecture.md](docs/notes/host-architecture.md), "The deliver slices").
  `ok` / `retry` (nothing typed) / `unconfirmed` (written, never seen — never auto-retry) /
  `unsubmitted` (Return swallowed — say so, never retype). Echo is checked by POLLING the RENDERED
  screen and by PLACING the match **structurally** — inside the `❯` box (`echo.ts`'s
  `composerEcho`, shared with `settle.ts`), never by distance from the bottom of the render: the
  replay TEARS mid-turn and strands the live composer above stale rows, which cost ~30% of
  deliveries. No box found ⇒ the old distance rule, never a brick — at the OLD DEPTH
  (`FALLBACK_ROWS` 40, not the anchor's `ROW_WINDOW` 100: its slash allowance accepts a hit at any
  height, and `/` starts every path in every tool result). Two frames that DISAGREE — a live empty
  box under a stale one holding submitted words — are not a composer either
  (`composerFramesAmbiguous` ⇒ `retry`, never a Return at nothing). **The miss sweep sends no Esc
  and no ctrl-U while a turn is active** — it was interrupting the turn and deleting the
  interjection that had landed. **ONE health observation per delivery**: a rescue records the
  `fallback`, and the trailing `good` is gated on the echo having been seen. **A multi-line write IS a
  paste** and collapses to `[Pasted text #1 +N lines]` — **and so is any write past 800 chars,
  whatever its shape, where the placeholder is BARE (`[Pasted text #5]`, no clause, because the
  clause counts NEWLINES and a phone message has none). **The composer is a VIEWPORT, not a field**: it is
  sized off the TERMINAL's height and the text scrolls inside it, so a prompt longer than the box
  draws only its TAIL (measured on 2.1.267 at 56 cols: 3 rows at a terminal height of 12, 5 at 20,
  all 14 at 40) and the head every rule asks for is off the top — 45% of every delivery between 300
  and 800 chars came back `unconfirmed` against 17% of the short ones, and under 800 there is no
  placeholder to rescue it. A box whose WHOLE contents are a window onto the text is an echo
  (`echo.ts`'s `scrolled`, `SLICE_MIN` 40), asked as a SUBSTRING not a suffix because `settle.ts`
  asks minutes later at whatever scroll the reader left. `e2e-scrollcomposer.mjs`. An absent clause is "zero newlines", never
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
  the same `ROW_WINDOW` as `deliver.ts` — a narrower one here made a tear confirmable there and
  invisible here) — this CLI scrolls, so a prompt that already RAN sits in the visible tail verbatim. **The LOG is compared WHOLE** (`echo.ts`'s
  `logEcho`), never on the screen's 14-char head. **A backend that keeps no claude log is asked
  NOTHING** (`sessions.keepsClaudeLog`, BEFORE `getTranscript`): only `source:"jsonl"` was ever
  proof, but reaching that verdict after a full opencode store read is a fold per settled session on
  the loop that pumps every PTY.
- `agents.ts` — what is running UNDER a session: the Task/Agent tool, read off the CLI's own logs
  (`subagents/agent-*.jsonl` + its `.meta.json`), because a BACKGROUND agent outlives the turn that
  launched it and the reader called that state "idle — nothing running". **The END is the parent's
  own `<task-id>` task-notification, not silence** — and it is compared against the agent's last
  write, since a notification fires each time an agent stops and `SendMessage` resumes one.
  Freshness (`WATERPLANE_AGENT_STALE_MS`, 10 min) is only the backstop for an ending nobody wrote down.
  **Polled, never evented** (no hook fires for an agent, and the parent log is asleep while one
  runs), armed ONLY while agents exist, and broadcast on a CHANGE — elapsed is counted on the phone
  off `startedAt`. **A signal, never an interlock**: `laneBusy`/`sessionWall`/auto-fire untouched,
  the same line `question.ts` draws. Degrades to an EMPTY LIST, never to a count nobody can see.
  **Background shells** come from the CLI's `~/.claude/sessions/<pid>.json` `status:"shell"`
  (`readCliRecord`, matched by tmux target, else a UNIQUE live conversation id) → `SessionInfo.shells`;
  `readCliStatus` is a thin wrapper over it kept for its existing callers. `readCliRecord` also hands
  back the pid `shells.ts` needs to find the wrapper shells running under it. **Its per-session-id file
  cache is populated, and consulted, ONLY on a tmux-target match** — exact by construction, so
  re-validating the one cached file against itself is a real check; a `tmuxName`-less lookup always
  rescans the whole directory, because re-validating a single cached record against `pickCliSession`'s
  "exactly one live process claims this conversation id" guard is trivially true every time and lets a
  second `--resume` of the same conversation go unseen.
  The footer's `← N agents` is machine-wide busy sessions, NOT subagents.
  `packages/host/test/agents.test.mjs`.
- `shells.ts` — what each background shell is actually DOING, off `ps -axo
  pid=,ppid=,pgid=,etime=,time=,command=` (memoised 2s). **The discriminator**
  (`isShellWrapper`): a direct child of the CLI's pid, in its OWN process
  group, running the CLI's own shell-snapshot wrapper — `pgid !== cliPid`
  alone is what keeps MCP servers and `caffeinate` out, since both are CLI
  children too but share its pgid. `shellsUnder` walks each wrapper's
  descendants that stay inside its OWN pgid; `workers` is that group minus the
  sleep/pipeline utilities (`sleep`, `tail`, `head`, `zsh`, `sh`, `bash`,
  `cat`, `grep`, `wc`, `cut`) — zero means the shell is, right now, only
  waiting on something. `evalText` unescapes and caps the eval'd command at
  240 chars; the transcript join (`shellTranscriptFacts`/`joinShellFact`,
  reusing `agents.ts`'s `readTail` over the tail 512 KB of the conversation
  log) matches a wrapper's command against a Bash tool call's own by
  whitespace-normalised equality to recover `description`/`taskId`/`launch` —
  no match ⇒ those fields stay absent, never guessed. `shellOutputStat` only
  fills `outputAt`/`outputBytes` past 0 bytes: most of these commands redirect
  their own output, so an empty file is silence by design. CPU movement is
  tracked per WRAPPER pid across polls (`trackCpu`/`pruneCpuTrack`) —
  `cpuMovedAt` is absent on a shell's first ever reading, the honest "can't
  tell yet" `@waterplane/shared`'s `shellBucket` reads off it (`workers === 0` wins
  there BEFORE the CPU-moved check, or a real wait loop's own `sleep`/`pgrep`
  tick reads `working` for the whole quiet window). **Any throw anywhere
  in `readShellList` degrades the WHOLE list to absent**, never a partial one
  with a wrong-looking row. **`isShellWrapper`'s shape also matches a LIVE
  FOREGROUND Bash call** — same ppid, same own-pgid, same wrapper — so
  `SessionShell.foreground` is set whenever the transcript join could not
  PROVE this was ever launched to the background and the CLI's own record
  still says `"busy"` (idle, `"shell"`, means every wrapper left is a
  survivor); `foregroundWrapperPids` is the same call without the
  CPU-tracking/output-stat/cap work, for a KILL pass that only needs the
  pids. `killShellGroup` (driven by WP3's `shell.kill` route and by
  `drive.ts`'s close path) takes an injectable `KillShellDeps`
  (`rows`/`readPs`/`kill`/`sleep` — real `ps`/`process.kill` by default) so a
  test can drive its whole refusal ladder with no OS process tree, and so
  `stopShellsUnder` can share ONE fresh precondition read across a whole
  close pass instead of one per group; it re-checks every precondition
  (still a wrapper under this cli, still its own group leader, its start
  time still within 2s of the one the caller last saw) before signalling:
  SIGTERM, then SIGKILL after 3s for whatever in the group is still alive —
  re-checking `ppid` again right before that SIGKILL — and **a survivor
  after the SIGKILL is `ok: false, reason: "that shell did not stop"`**,
  never a false `ok: true`. `packages/host/test/shells.test.mjs`.
- `screenlog.ts` — **the desktop's scrollback, RECORDED, because it cannot be read back.** Measured
  on 2.1.267: every pane is `history_size=0 alternate_on=1`, so the CLI draws in the ALTERNATE
  screen, which keeps no scrollback — a replay of the whole ring answers with ONE SCREEN (a session
  of hours came back as 31 lines), and tmux's `capture-pane -S -` says the same. One live headless
  VT per session, fed as the bytes arrive, its grid diffed on a settle with `@waterplane/shared`'s
  `absorbScreen` — the SAME rule the phone uses; what differs is the vantage point, and that IS the
  fix (no gaps ⇒ no unanchorable jumps ⇒ no screens archived twice). **`history` is the honest half**:
  false means nothing beyond the current grid yet, and the phone must then keep its own archive.
  `e2e-screenrec.mjs`.
- `sessions/budgetwatch.ts` — **a session's OWN budget, judged** (`BudgetSlice`, owns only the latest
  calibration; rule: `shared/sessionbudget.ts`; reasoning: [host.md](docs/notes/host.md#sessionbudgetts--a-sessions-own-budget)).
  The cap and verdict live on `info.budget` (the ONE copy, persisted to `live/` by `persistLive`
  off the LIVE session so a field-by-field rewrite cannot drop it); `Session.budgetTripped` is the
  interrupt-once latch. Judged at the end of every `refreshSpark`, on `setSessionBudget`, and on
  `setBudgetCal`. **Only the crossing into `over` emits `budgetTripped`**; the latch clears on `ok`
  or a new cap, never on `unknown`, and **unknown never trips**. The crossing's notify + ONE Esc is
  `server/sessionEvents.ts`'s, gated by `budgetEscBlocker` (interrupt on, env knob, running, no box,
  no unconfirmed delivery — NOT the hooks: agent-driven and post-restart turns never have a hook
  turn) and then `budgetEscScreenBlocker`
  on the LIVE grid in the write's own tick (`workingLine` now, no box on it) — a raw
  `sessions.write`, never a `deliver.ts` fork. Flipping only `interrupt` keeps the latch.
  **The Esc is OWED** (`budgetEscOwed`, persisted): retried on every judge while over
  (`budgetEscDue`) until sent; a person's send, `interrupt` off, a new cap or `ok` settles it.
  `packages/host/test/sessionbudget.test.mjs`.
- `halt.ts` + `sessions/haltall.ts` — the emergency halt: latch first, then kill. New spawn path ⇒ ask `haltRefusal()`.
- `sessionSearch.ts` — a decision core lifted OUT of `SessionManager` so it can be asserted without a
  PTY. Hits are capped but keep being COUNTED.
- `answergate.ts` — **the one way anything but a person's tap answers a choice box**
  ([plugins.md](docs/notes/plugins.md), "The answer gate"). `gateRefusal` is pure: manifest
  `answers`, the session's "let <plugin> answer" switch (default OFF, only `plugin.sessionAnswer`
  flips it), the SAME `promptFingerprint` the plugin was told about, never `trust`/`tool`/`plan`,
  never `isBlocked` wording (the retired oracle's blocklist, core's now), never a checkbox box, and
  `choice` among the options — each refusal a sentence, nothing typed. Accepted ⇒ the phone tap's own
  dispatcher, `sessions.answerBox` (`GateDeps.sessions` is `get` + `answerBox`, no typing verb —
  never `sessions.write`), a `sent.json` row `source: "plugin"`, a decision row, an `autofire` note.
  `packages/host/test/answergate.test.mjs` · `scripts/e2e-plugin.mjs`.
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
- `plugins/pluginregistry.ts` + `plugins/pluginloader.ts` + `plugins/pluginapi.ts` + `plugins/builtin.ts` + `plugins/setupcontrib.ts` — the plugin host.
  Loader: `<config dir>/plugins/*/` + `plugin-paths.json` `{paths}` (`~` expanded, deduped by realpath),
  `manifestProblems`, host module CONTAINED in its dir. Registry: **a broken plugin is LISTED
  (`state: "error"`, reason verbatim), never skipped, never fatal** — bad manifest, duplicate id,
  import failure, `activate()` throwing or over 10 s; a throwing handler becomes its status line.
  Enabled flags in `<state dir>/plugins.json` (absent ⇒ on), values in
  `<state dir>/plugins/<id>/settings.json`, a `plugin.set` refused WHOLE in words. Loaded once at boot,
  never in `--doctor`. `firePrompt` records the fingerprint the gate checks. The API: every
  side-effecting call is dead once that activation is switched off (`gen`); `env()` only declared
  names; `readRepoFile` through `contained` and never a `.env`; `meter()` as `kind: "plugin:<id>"`.
  `repo(id)` reads through `contained` + `inRoot`, never a secret. `setupCheck`/`setupFix` are the
  ONLY way a setup row gets in (`compliance.ts` asks `setupcontrib.ts`); a core fix id is refused.
  `handle()` answers the registry's `call()` — what the generic `plugin.call` will route to.
  **`api.stream` (1.4, `pluginstreams.ts`) is live binary on the ONE socket**: frames only to the socket
  that sent `stream.open`, never durable/acked/retried, a dead socket or a plugin switched off ends its
  subs; droppable frames skip past the backlog line, the key ask (and the key ending an episode) waits for the drain, and EVERY frame
  waits while that socket's PTY is held (`liveness.ts`'s `ptyHoldsStreams`). `pluginstreams.test.mjs` · `e2e-stream.mjs`.
  **`handToAgent()` is the backlog add (`agentintents.ts`'s `handToAgentVia`), never a side door**:
  waits for a tap unless `fire`. In-repo extensions (`packages/extensions/<id>/`, `builtin.ts`) get
  the same API, load first, always on, compiled by `tsconfig.extensions.json` into `dist/extensions/`
  so `dist/main.js` never moves; `requirementsrow.test.mjs` pins the requirements row byte for byte.
  `packages/host/test/plugins.test.mjs` · `pluginseam.test.mjs`.
