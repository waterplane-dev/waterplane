# Build, test & ops notes

_Full rationale split out of CLAUDE.md (which is char-capped). Index: [docs/notes/README.md](README.md)._

## Commands

```bash
npm ci                      # exact lockfile, no install scripts (.npmrc); see Supply chain
npm run build:shared        # must run before host/web type-check against @waterplane/shared
npm run dev                 # host on :8770 + vite dev (proxies /api + /ws)
npm run build               # shared → host → web; web/dist served by host on :8770
npm run lint                # eslint — the repo-specific rules are the point (tools/eslint/rules.js)
npm run test:host           # node --test over packages/host/test — the regex heuristics, no daemon
npm run restart             # ALWAYS restart the running host with this (never `pkill; node ...`)
npm run doctor              # preflight checks only (claude login, Tailscale, secure context), report and exit
npm run stop                # kill the daemon

# E2E smoke tests — run individually, no test framework
node scripts/e2e-smoke.mjs      # PTY round-trip
node scripts/e2e-api.mjs        # scaffold, files, slash, artifacts, traversal guard
node scripts/e2e-backlog.mjs    # backlog auto-fire → worktree + session → done; archive is not a delete; items are rows in the ONE intent store (no per-repo backlog.json is written any more); an item in a repo with NOTHING open gets a session of its own and runs, rather than dying on a missing one
node scripts/e2e-backlog-prompt.mjs # non-hooked session parked on a choice prompt is NOT falsely completed on idle; clearing the prompt lets it finish
node scripts/e2e-backlog-wait.mjs   # a queued item SAYS why it is still queued: auto-fire off, then one-at-a-time-in-this-repo behind the item ahead of it — each reason checked against the item's real fate in the same run, so the explanation cannot drift from the ladder that decides; and the item that runs is in a session of its OWN, never the hand-driven one open beside it
node scripts/e2e-tier12.mjs     # prompt detection, rename, recent, push key, upload cap
node scripts/e2e-git.mjs        # status, diff, stage, commit, push, traversal guard
node scripts/e2e-launch.mjs     # model/effort/permission flags reach the claude process
node scripts/e2e-fork.mjs       # session.fork → parallel session forking EXACTLY the source conversation
node scripts/e2e-forkfrom.mjs   # fork from a TURN, the wire + route half (the file operation itself is `convfork.test.mjs`): a `session.create` carrying `forkAtTurn` writes the prefix and RESUMES it (`--resume <newId>`, and NOT `--fork-session` on top, which would open a third conversation), the SOURCE log is byte-untouched, a refusal is a refusal rather than a session quietly opened on the whole conversation, and a replayed ackId spawns nothing — `session.create`'s at-most-once promise, which matters more here because the side effect is a file. `WATERPLANE_CLAUDE_HOME` points `transcriptPath` at a temp tree, so the fixture conversation is the only one this host can see
node scripts/e2e-clihealth.mjs  # the CLI-integration health board, end to end, in two phases that only mean something as a pair — each on its own host and temp ROOT so neither poisons the real record nor reads the other's. A: `STUB_MODE=unreadable`, a dialog the detector genuinely cannot read (real footer, option rows numbered `1)`) — the app knows it is blind, the miss lands on `prompt.box` and reaches `degraded`, and the captured sample keeps the line that stopped matching while dropping the account name and credential beside it. B: `STUB_MODE=prose`, a session that asks nothing and merely SAYS the footer's words (what a claude working on `prompt.ts` puts on a screen) — the interlock still fires, and the health record stays EMPTY of `prompt.box`: not a miss, and not a `good` either, because nothing was seen to work. B also carries `hook.pipe`, where merely lacking a pipe records nothing and only the silence heuristic being USED to decide a turn boundary is a fallback. 24 assertions
node scripts/e2e-ctxgraph.mjs   # the context-window graph, end to end. Fabricates the CLI's own record under a throwaway `WATERPLANE_CLAUDE_HOME` — one climb, an auto-compaction, a usage wall, a second climb — and asks both joins the unit tests cannot reach. `GET /api/context`: the duplicated streaming turn collapses to one point, the rejection's `<synthetic>` zero-usage turn is NOT a cliff to zero, both event kinds come out in time order with the compaction's two sides and the wall's reset as an INSTANT, an unchanged log answers 204 and an unknown session 404. Then the socket: `SessionInfo.contextSpark` reaches the client at all, carries the FULL series' peak rather than its own, and carries the WINDOW and where it came from — a spark arriving `windowFrom: "none"` still draws a curve, it just draws one that cannot be compared with any other session's and nothing on the row says so. Finally that the compaction tick sits ON the cliff, not beside it. 22 assertions
node scripts/e2e-tokenstats.mjs # token usage across every conversation on disk. Boots on a throwaway `WATERPLANE_CLAUDE_HOME` holding a hand-built corpus, so the totals are known by hand rather than asserted to be plausible. Pins the five ways the scanner is silently wrong: counting a STREAMING turn's duplicate records (70% inflation on the real corpus), counting the usage-limit REJECTION's `<synthetic>` zero-usage turn, missing SUBAGENTS one directory deeper (a quarter of the real total — the first version's headline was a third too small), bucketing a 23:30 LOCAL turn on the next UTC day, and the incremental path (a grown file re-read WHOLE so a cross-pass duplicate still collapses; a deleted log stops counting; only what changed is re-read). Ends on an emptied corpus, which must be an empty document rather than a 404 or a stale total. 21 assertions
# `e2e-assess.mjs` (in flight) — the repo assessment: a proposal is a diff, and nothing applies itself
node scripts/e2e-images.mjs     # new image in a session's worktree → session.images broadcast
node scripts/e2e-restore.mjs    # several same-repo conversations restore individually after a host restart
node scripts/e2e-limit.mjs      # usage-limit detection → auto-continue at reset + global/per-session toggles
node scripts/e2e-outbox.mjs     # new outbox file → artifact notification with a working download link
node scripts/e2e-hook.mjs       # claude hook events → `hooked` flag, turn-active gates auto-fire over silence, Stop completes the item
node scripts/e2e-limitqueue.mjs # the RESUME QUEUE when more than one session is blocked: resumes are serialized (never two at once), the order is steerable (`limit.first` beats blocked-longest), a resume that comes back STILL BLOCKED arms a host-wide hold-off so the others don't each burn an attempt on the same wall, an explicit `limit.resume` overrules that hold-off, and auto-continue off takes a session out of the queue entirely
node scripts/e2e-resurrect.mjs  # a session that EXITS at the usage limit auto-reopens (--continue) at reset; clean/killed exits don't
node scripts/e2e-resume.mjs     # reconnect with resumeSeq → delta-only PTY replay (not full scrollback); fresh attach → flagged full replay
node scripts/e2e-speedtest.mjs  # download stream (exact size, no-store, 256 MB ceiling), upload byte-count + server timing, debug client classification
node scripts/e2e-star.mjs        # prima-interest star toggle → persists to .waterplane/stars.json; turn-end while unwatched raises newActivity, attach clears it
node scripts/e2e-build.mjs       # build buttons: save a repo build config, run a shell build (no session), stream output, detect + download the produced artifact
node scripts/e2e-ptyleak.mjs     # `main.js --doctor` exits on its own; stub sessions ended by exit AND by session.kill return /api/health's `ptys` gauge (this process's ptmx masters + slave fds) to baseline. Needs free PTYs
node scripts/e2e-pin.mjs         # overview label: recorded prompts fill firstPrompt/lastPrompt; session.pin overrides the "last" slot + persists to .waterplane/pins.json
node scripts/e2e-transcript.mjs  # reader view: /api/transcript parses the claude conversation log into turns/blocks (tools, results, thinking), outline fields, 204-on-unchanged, history fallback. A LOCAL command (`/context` + its `<local-command-stdout>`) is a turn of its own, `local: "log"`, its answer a `screen` block — while genuinely synthetic records still open nothing
node scripts/e2e-search.mjs      # session.search: recent-scope (rendered PTY output) + history-scope (recorded prompts, turn-labelled) find; per-session vs all-sessions scoping
node scripts/e2e-uiusage.mjs     # UI feature-usage counters: POSTed deltas merge + persist to .waterplane/ui-usage.json, junk ids/counts rejected, GET/DELETE
node scripts/e2e-scaffold.mjs   # new project: repo on main + first commit, gitignore/README/CLAUDE.md, inbox+outbox+.waterplane dirs, setup:false stays bare, name traversal contained
node scripts/e2e-backlog-echo.mjs # backlog delivery types the instruction EXACTLY ONCE: repaint-heavy TUI (composer buried behind trailing bytes) still delivers; an unreadable screen fails the item instead of re-hammering it; a TUI that echoes the text but SWALLOWS Return (hooked, so the missing turn is provable) fails saying the prompt is sitting unsent
node scripts/e2e-echo-stream.mjs # the echo is placed by the BOX it sits in, not by its distance from the bottom of the render: `STUB_MODE=stream` draws a real `❯`-plus-rules composer with a DUPLICATED footer and twelve rows of streaming turn output under it (the tear a fixed 50-row replay leaves mid-turn), which the old “within ~11 rows of the bottom” rule found and then refused — `unconfirmed` for a prompt in plain sight, an Esc into the running turn, six ctrl-Us over text that had landed, and a re-send minutes later. Asserts the verdict, a `deliver.echo` good with no fallback on it, and that neither Esc nor ctrl-U ever reached the session
node scripts/e2e-fanout.mjs     # fan-out: one prompt → a fresh session per selected repo, typed exactly once, unknown dirs dropped; follow-up re-drives only the selected EXISTING sessions and spawns nothing; and the run SURVIVES a daemon restart mid-sweep — it comes back with its targets, their sessions and its follow-up, reconciled to `failed` (their sessions died with the PTY host — never `done`) rather than re-typed (the in-memory runs ring lost the record outright)
node scripts/e2e-origin.mjs      # same-origin guard: foreign Origin/Host refused on /api and /ws (403 / close 1008), own origin reflected in CORS, WATERPLANE_ALLOWED_HOSTS escape hatch
node scripts/e2e-ack.mjs        # session.input delivery receipts: ack ok for a live session, not-ok for a gone one (so the phone can recover the text)
node scripts/e2e-manualfire.mjs # a hand fire opens a session FOR the item — never the one already open in that repo, even though a tap is the one case allowed to adopt one
node scripts/e2e-onesession.mjs # the INVERSION its name predates: two items for the same repo get TWO conversations, one at a time, in order (`sessioncost.ts` is why — see the script's own header)
node scripts/e2e-backlog-keepopen.mjs # close-when-done OFF (the default): with one slot, a finished item's session is NOT closed by the linger or the reap, the next item waits saying "1 automatic session open (close one to make room)", backlog.list carries the open id as a fact, and a person's session.remove lets it run
node scripts/e2e-backlog-slots.mjs # (with close-when-done switched ON) WATERPLANE_BACKLOG_SESSIONS as a RUNG: with one slot, three items in three repos run one at a time, each in its own session, the blocked ones say they are waiting for a slot, and a finished session is reaped to make room
node scripts/e2e-smartpick.mjs  # the per-repo *smart pick*, the one feature in the backlog that APPLIES ITSELF — so what it pins is mostly the promises it makes to somebody who is asleep. Six repos groomed six different ways off one booted host, through a stub `claude` that dispatches on its own argv (a bash shell for the sessions the fired items run in, `e2e-assess.mjs`'s node answerer for the `-p` pass) and counts, per repo, how many completions it was asked for. An un-ticked repo buys ZERO — counted, not asserted to be small, and the counter deliberately ignores every `-p` that is not the pass (a fired item's own per-turn `summarize()` runs one too, in the same worktree; `--thinking disabled` is the flag only the pass carries). EVERY FAILURE FIRES THE ORDER THE REPO ALREADY HAD: an answer that is not JSON records `failed` and the item runs anyway, a pass that outlives its 800 ms watchdog records `timeout` and the item runs anyway, and NEITHER is bought a second time on the next tick — the fingerprint of the state the failure was recorded against is what makes a failure terminal. The answer that then arrives two seconds late is recorded `late` and applied to nothing, which is checked against a list it proposed to REVERSE. NOTHING IS DESTROYED: a merge's originals are archived, still listed, with their own words, each saying what replaced it; the merged text still names both `.claude/inbox/` paths its members pointed at; `undo` puts them back at the positions they had, re-points the row chained behind one of them, and the same merge is never proposed again. A DRAG IS NEVER RE-PLACED — the pass picks the third item, the second one stays where the person put it and runs first, and the strip says so. And a restart with an unchanged backlog re-derives NOTHING: the item fires off a fingerprint read from disk, having bought no second look. Under all of it, the pass types into nothing: the interactive half of the stub is counted separately, and it is at zero while the repo is being looked at. Found one thing nothing else could have: `intents.post()` kicks the tick SYNCHRONOUSLY, so posting a merged row re-entered the guard ladder between that post and the archive of its originals and bought a second pass against a half-applied list — two merged rows for one pair (`SmartPick.applying`)
node scripts/e2e-resurrect-item.mjs # a backlog item whose own session exits at the usage limit FOLLOWS the revival instead of being requeued — the words run exactly once, and the row says what it is following while it waits
node scripts/e2e-secret.mjs     # write-only secret setter: host + repo scope, gitignore gate (auto-add, refuse-on-tracked), masking, no read path
node scripts/e2e-setup.mjs      # repo compliance checklist + idempotent auto-fixes (gitignore inbox/outbox, CLAUDE.md section); no gemini row any more
node scripts/e2e-plugin.mjs     # plugins end to end: the fixture (scripts/fixtures/plugin-echo) listed active from a temp plugin-paths.json and a broken one listed with its reason, an out-of-range setting refused in words, an action answered, the plugin's suggestion on SessionInfo, and its answers held to the core's gate — refused with the session switch off, typed through the tap's path once on, refused for a blocked box
node scripts/e2e-intentnodrop.mjs # the complaint's pin: post ten intents, kill the host, wind every clock this design deleted past its limit on disk (the phone's 30-minute TTL, its hour-long retire, the ack ledger's 45 minutes — that file is DELETED, which is what its own expiry does to a verdict), reboot, and assert all ten rows are still there with their prompts byte-identical, that none was given up on for waiting, that nothing in the store says "queued too long", and that re-posting the same intent ids past the wiped ledger UPSERTS onto the same ten rows rather than making ten more — the guard that made deleting the client TTL safe. Then fires one of them by hand, because "nothing was lost" has to mean the work still runs and not merely that the bytes are on disk
node scripts/e2e-queue.mjs      # offline send queue: the per-session lane rules (one delivery in flight per session, queue order within a lane, an expired head doesn't block what's behind it, reorder stays inside the lane), a re-sent ackId is re-ACKed but NOT retyped (dedupe is per-ackId, not per-text), a gone session stays ok:false on retry, the full offline → reconnect → deliver → ack-gated Return path actually SUBMITS, and a re-sent `backlog.add` ackId adds the work item exactly once, plus the ANSWER rules: where a tapped answer is inserted (ahead of the lane's prose so it is not typed into the open dialog, behind an answer already queued so a checkbox box's toggles keep their order, never overtaking a pending entry) and that an answer can never be re-aimed at another session, plus the SERIAL rules (one member of a repo's group leaves per pass, an open still on the wire holds its group and not just its lane, and `busySerialGroups`: a repo is busy on the same three `laneBusy` facts, a just-created session holds it through `SERIAL_STARTUP_MS` before it reports anything, and a session that never came up stops holding it). **And the deletion this suite exists to guard**: nothing expires for waiting. A message ten hours old is still the head of its lane, a week down a dead tunnel changes nothing, a serial or budget hold that lasts all day is still a hold — the only give-up left is `maxAttempts`, i.e. a host that answered and said no
node scripts/e2e-opqueue.mjs    # durable OPS: `session.create` (plain and in its `replaceSessionId` relaunch form)/`fanout.run`/`fanout.followup`/`build.run` carrying an ackId execute EXACTLY ONCE — a duplicate racing the first delivery (in-flight map) and a duplicate after it settled (persisted ledger) both re-ack without re-executing, a follow-up for an unknown run is refused instead of spawning, a relaunch kills the replaced session exactly once (and succeeds when its target is already gone), and the dedupe survives a host RESTART
node scripts/e2e-thumbs.mjs     # bandwidth: server-made thumbnails (far smaller, immutable-cacheable, download=1 still gets the real file), ETag/304 on artifacts, br/gzip on JSON, listing pagination
node scripts/e2e-startprompt.mjs # `session.create` carrying a `prompt`: typed EXACTLY once into the new session, a duplicate ackId (racing and settled) neither re-creates nor retypes, a prompt-less create still types nothing; plus the queued-upload `x-dedupe` rule (a re-POST answers with the file already on disk, an ordinary upload still uniquifies)
node scripts/e2e-launchwait.mjs  # the handover: a `session.create` carrying `needs` for a file that has not arrived spawns NOTHING and is acked `ok` with a `launchId` and no `sessionId`; the row says which file it is short of; a replayed ackId parks nothing twice; the file LANDING opens the session and types the prompt exactly once with no client action, and `launch.opened` names the session the phone's queued prompts bind to; a create whose files are already there is not parked at all; a cancel settles the row and never opens anything; the whole thing is persisted to `.waterplane/launches.json` (pins `WATERPLANE_LAUNCH_TICK_MS=300` alongside the mandatory `WATERPLANE_PREFLIGHT=0`)
node scripts/e2e-autopull.mjs # auto-download: the per-repo rule (glob patterns, scope, size cap, build outputs) round-trips + persists to `.waterplane/autopull.json` and a malformed one is sanitized; a matching new outbox file is queued on its own while a non-match and an over-cap file are not; a manual `pull.add` bypasses the rule but not the traversal guard; the queue survives a host RESTART and a re-add doesn't duplicate; and the STREAMING artifact serve returns exact bytes for a full GET, a tail range, a bounded slice, 416 (never 200) past the end, and honours `if-range` — a STALE validator gets the whole body back (200) instead of a 206 of a rebuilt file the client would append to its old prefix — with 416 + `if-range` pinned on the BUFFERED (small-file) path too, since a resuming client cannot tell which path served it
node scripts/e2e-docs.mjs      # any-KIND file transport: pdf/zip/docx/audio/unknown-extension uploads round-trip byte-exact with the right content-type, a percent-encoded umlaut filename decodes back, `.env` is refused on both transport routes, and widening the SERVE gate did not widen DISCOVERY (a repo walk still skips source/config files while the curated outbox lists them)
node scripts/e2e-limitrepaint.mjs # a REPAINT after a resume is not a new wall: blocked at boot, one continue resumes it, then a resize (a full tmux redraw with the old banner still on screen above the echo) and several idle passes — still not blocked, attempts still 1. Fails on the byte-stream rule: "after the last continue echo" is asked of the rendered grid, and still after the block cleared
node scripts/e2e-tmux.mjs       # tmux sessions survive a HARD-KILLED host: rediscovered on boot, same id, still alive; and a row delivered before the kill whose turn is still running (a busy loop, its words in a fabricated conversation log) is RE-ADOPTED `running`, settles `done` only after the loop ends and the 3 s silence passes, and is never typed again
node scripts/e2e-termqueries.mjs # the tmux client's start-up terminal queries are the HOST's to answer (`termqueries.ts`): with NO phone a session draws no full repaint at the client's ~5 s timeout and an Esc reaches the CLI at once; with a fake phone attached from the first byte no query reaches it, so nothing answers twice, and no reply leaks into the pane as text
node packages/extensions/opencode/e2e/e2e-tmuxenv.mjs    # a backend's `spawnEnv` reaches the BINARY when the tmux server ALREADY EXISTS — the normal case, and the one the first version got wrong: merged into the tmux CLIENT's environment the variable is dropped, because tmux builds a pane's environment from the SERVER's plus `update-environment` once the server is up. For opencode that variable is `OPENCODE_DISABLE_AUTOUPDATE=1`, without which the CLI opens an update modal that swallows typed text and whose FOCUSED button is `Confirm` — so a blind "type, press Return" delivery upgrades the user's install. The script starts the server FIRST from an environment with the guard explicitly unset, then boots the daemon onto that socket, and reads the value back off the SPAWNED PROCESS's own screen; the control is a claude session, whose empty `spawnEnv` must leave its argv byte-identical (private socket, throwaway root)
node scripts/e2e-webbundle.mjs  # the bundle the Android shell updates itself from: the manifest describes exactly the tree the daemon serves (build id = dist/build-id.txt, per-file sha256, sizes that add up), every file comes back byte-identical to its advertised hash, and a path from the phone cannot climb out of the bundle (`..`, absolute, a directory) — what these routes hand over becomes the app the phone RUNS
node scripts/e2e-hosturl.mjs    # Android shell address rules: what a typed host address normalises to (scheme allowlist, default port, IPv6 brackets, path stripped), that ONLY /api + /ws are re-aimed at the daemon while the shell (`/assets`, `/sw.js`) stays local, that a protocol-relative `//evil/api` is never spliced behind the base, and that an empty base leaves the browser client byte-identical
node scripts/e2e-submit.mjs      # VERIFIED compose delivery (`session.input` + `submit`): the prompt is typed exactly once, the Return is pressed HOST-side and the receipt only comes back once the turn provably started; a duplicate ackId racing the delivery joins it (never a second copy) and one arriving after it settled is re-acked from the ledger; a swallowed Return is `unsubmitted` (text is in the composer — say so, never retype), an unreadable screen is `unconfirmed` and never auto-retried; a human interjecting into a WORKING session is delivered immediately instead of waiting out the automation path's 45 s idle timeout; and `submit` is opt-in, so a plain ackId'd input still takes the raw write path
node scripts/e2e-slashlocal.mjs  # TUI-LOCAL slash commands (`/cost`, `/usage`, `/context`): the completion menu draws under the composer, so the echo is ~17 rows off the bottom — it must still be found (a bottom-rows window read it as never typed, returned `unconfirmed`, and swept the composer with an Esc that closed the menu); and because a local command fires no `UserPromptSubmit`, exactly ONE Return is written and no Esc at all, so the view it opened is still on screen. A turn-starting slash command (`/init`) keeps the ordinary contract — the list is positive
node scripts/e2e-settle.mjs      # SETTLING a delivery that could not be confirmed AT THE TIME (`input.settle` → `settle.ts`): `unconfirmed`/`unsubmitted` are honest about a 4 s echo window and useless afterwards, so the phone asks again and the host answers from evidence — the CLI's conversation log HAS the prompt ⇒ `landed` (it ran; the queue row was a lie), the text is on the rendered screen ⇒ `composer` (unsent, the user's Return to press), a READABLE log without it ⇒ `absent` (never ran, nothing holding it — the verdict that makes a re-send provably safe), and NO log ⇒ `unknown`, never `absent`, because a screen is 40 rows and "not on screen" would call a delivered prompt absent. Settling types nothing into the session whatever it answers, and an ackId the host never heard of is still answered
node scripts/e2e-netstats.mjs    # connectivity + delivery telemetry: socket opens/closes counted with their CLOSE CODE and peer tier and the closed socket's lifetime priced, verified deliveries counted by outcome, a duplicate ackId counted as an ack REPLAY (= a receipt the tunnel ate), a client roll-up round-tripping per device with junk (NaN, negatives, out-of-range share, runaway string, traversal-y device id) sanitised rather than stored, and DELETE resetting the window
node scripts/e2e-answer.mjs      # answering a question OFFLINE: the fingerprint rules (a changed label, a reordered option, a different kind or a multi-select box are all different questions — the digit that gets typed means something else in each), and the host guard against a real PTY — an answer whose box is still up is written, the same ackId re-sent is re-acked and NOT typed twice, an answer whose box is GONE is refused `stale` with nothing written (and the refusal is replayed from the ledger), an answer for the PREVIOUS question is refused even though a different dialog is up, and the answer minted against the current box still goes through
node scripts/e2e-sent.mjs       # sent-command audit log: a `session.create` prompt is logged ONCE (one entry per command, not per PTY write — delivery presses Return separately and re-presses it), a compose `session.input` is `compose`/`user` while a fan-out is `fanout`/`auto`, `sent.get` filters to one session, the log survives a host RESTART, and `sent.clear` empties it
node scripts/e2e-netfuse.mjs    # the HTTP fuse: a host that accepts the connection and then says NOTHING (the dead-tunnel shape, not a refusal) rejects at the budget instead of hanging, a timeout classifies as "offline" while a 404 does not, a caller's own abort stays an AbortError, a slow-but-answering host is not cut off, and the reader's polling budget stays below the generic one while git push/checkout stay far above it
node scripts/e2e-settings.mjs   # settings that follow the USER, not the browser: a fresh client gets the document unprompted on hello, a `settings.set` is stored and broadcast to every socket (the writer's included — the echo is the confirmation), last-write-wins on the CLIENT's timestamp with the loser sent the winning value back rather than ignored, an equal timestamp is a re-push and does NOT re-broadcast, a key outside the allow-list (`waterplane.outbox` — replaying another device's send queue is a prompt typed twice) is refused with a reason, an over-cap value is refused rather than truncated, and the document survives a host RESTART
node scripts/e2e-screenlog.mjs  # local scrollback: what counts as "scrolled off" an alt screen (anchored on the TOP of the new grid, because the composer/spinner at the bottom redraws every frame), a churning composer archiving nothing, a full repaint keeping the screen it replaced, the cap dropping the OLDEST, and the round trip — a document walked through a scrolling window comes back whole, in order, once. Plus the client half: an upward pan goes somewhere with the link down, a flick is one wheel write not one per line, the sheet imports no host at all, and the archive has an IndexedDB store
node scripts/e2e-gallery.mjs    # the file grid with no host: which cached listing may answer which question (strict containment, so a 4h listing never answers "all time" and an images one never answers "docs" — getting this wrong hides files that exist or shows files that were filtered out, and both read as data loss), the pick among what is stored (exact coverage first, then the freshest that covers), and a local filter that means exactly what the host's does (window cut on mtime, `kind=image` including video). Plus the client half: the grid is SEEDED from the cache before the live listing lands, a late cache read never paints over fresh rows, only UNFILTERED listings are cached, cached rows are labelled with their age, an opened document and a finished auto-download are read from this device, and the thumbnail cache survives a deploy
node scripts/e2e-archive.mjs    # the conversation archive, and the reopen stack that survives a restart. Listing: every log on disk for the repo, newest first by mtime, titled by its FIRST REAL prompt — a slash-command envelope, a hook echo, an `isMeta` record and a tool-result record must never become a row's name, and a conversation that was opened but never typed into gets an empty title rather than a crash. Search filters on that title, case-insensitively, and still reports `scanned` so the UI can say "N of M"; paging splits the same order without overlap. A LIVE session's conversation is listed too (the phone marks it "open now" — hiding it would make the archive disagree with the session list). Delete refuses a traversal id and a missing one with 400, and really removes the file. Then the archive claim itself: killing a session puts it on the recently-closed stack naming its conversation, does NOT delete the log, writes `.waterplane/closed.json` — and after a genuine host restart the entry is still there, still naming the conversation, and no longer claiming to be `alive`
node scripts/e2e-tree.mjs       # browsing the worktree, and the rules a file SAVE obeys. Browse: directories before files, dotfiles and `node_modules` SHOWN (listing one is a single readdir) but never WALKED by the recursive name search, a gitignored file flagged rather than hidden, a file marked "new" even though porcelain collapsed its whole directory into one `?? src/` line, a path escaping the worktree refused, `.env` refused both ways. Save: the right base lands and hands back the NEXT base, a save against a base already replaced is refused 409 `stale` with NOTHING written and names the base actually on disk, a missing path is refused (an editor, not a file creator), an executable file survives the tmp+rename with its +x — and a binary or over-cap read carries no `sha` at all, which is what stops a shown prefix from being written back over the whole file
node scripts/e2e-attach.mjs     # whether the FILES a queued prompt names will be there: the host's listing outranks the send queue outranks bytes still on the phone outranks a local "that upload died" record, and `unknown` (host unasked) is never collapsed into `missing` (host asked, hasn't got it) — one is a dead tunnel, the other is a lost photo, and reporting the first as the second gets a second copy uploaded. Plus what may be sent as written, and blockers listed fixable-first
node scripts/e2e-hints.mjs      # button hints: the one rule that decides whether a tap is spent on an explanation (curated actions interrupt ONCE, an uncurated one never does, explain mode outranks even "off" because it is the way out of it), that every hint which interrupts a tap earns it, that every `data-hint` written into the UI names a hint that exists (a typo is silent — the button keeps working and falls back to the `title` a phone never renders), and that dismissals are on the synced allow-list
node scripts/e2e-schedule.mjs   # scheduled prompts, both halves: the pure clock (a weekly anchor in a NAMED zone keeps its wall-clock hour across DST, a lead time that crosses midnight moves the fire to the previous day, a spent one-shot never re-arms, an unknown zone is dropped rather than silently becoming host-local) and the host (fires ONCE per occurrence, a fire missed while the host was down runs late and says so, one missed by a week is not caught up, a weekly rule survives a restart still armed at the same instant)
node scripts/e2e-prompt.mjs      # the choice-box detector against a REAL screen the phone published nothing for: the cheap pre-gate matches the footer with its spaces ERASED (`Entertoselect` — a repaint clears a cell and steps over it) and scans a window several repaints wide, an option row survives a one-character marker it does not recognise (that costs the cursor, never the whole box), a label is cut before the preview pane drawn to the RIGHT of the options on the same rows, and a box TALLER than the terminal publishes the run it can see plus `truncated` instead of failing the "first index is 1" anchor
node scripts/e2e-promptlive.mjs  # a box being REDRAWN stays published: only the strict verifier retires a prompt, never output — dropping prompt state on every byte and rebuilding after 600 ms of quiet made the answer panel blink in and out about once a second, too briefly to read and impossible to tap. A box that really goes away still clears, under the same repaint stream
node scripts/e2e-askprose.mjs  # a turn that ENDS ON A QUESTION is published as one, with no GEMINI_API_KEY set — the heuristic used to live inside the oracle's gate, so without a key nothing ever read the tail and a decision handed back in prose ("Want 2 implemented, or leave it at 1?") reached the phone as "Turn finished" on a row badged `done`. Pins that `session.asking` carries the agent's own words, that it is NOT a dialog (`prompt`/`awaitingInput` stay empty — nothing is blocked in the CLI), that a re-idle on the same unanswered question does not restart its clock, and that typing retires it. 6 assertions
node scripts/e2e-checkbox.mjs    # the Submit row of a MULTI-SELECT box, which is not a keystroke: a bare Return TOGGLES whatever the cursor sits on (option 1, where it starts and where a digit does not move it), so the phone's Submit button re-flipped the user's first pick and left the box open, looking like it worked. `promptSubmit` walks the cursor onto the unnumbered `Submit` row against the RENDERED screen, and the SET submitted is the one that was ticked
node scripts/e2e-login.mjs       # `/login` from a phone: the CLI's 300-character OAuth URL, hard-wrapped by the GRID into six rows with nothing joining them — untappable, unselectable, untypeable. The host REJOINS it and publishes it on the session (one string, right down to the last row), says separately that the CLI is waiting for the code (a different next action), takes the code on the RAW path (text and Return as two writes — the verified path would wait for a turn a login never starts), and RETIRES the link once it is used, because a stale sign-in URL opens a page that refuses for no stated reason. Stub `STUB_MODE=login`
node scripts/e2e-askbox.mjs      # the question as the CLI WROTE it, not as the terminal cut it: `AskUserQuestion` is a tool call, so its question and full per-option descriptions are in the conversation jsonl before anyone answers, while the screen's copy is truncated at the right edge, cut again by the preview pane and scrolled off on a tall box. Only a PENDING call counts (a `tool_result` means that box is gone), matching is by LABEL and never by index (the TUI appends its own rows and a truncated box starts above 1), a cut label is a PREFIX so containment runs one way only, and an unrecognised box is never claimed
node scripts/e2e-pastechit.mjs   # a long prompt the TUI COLLAPSES is still confirmed AND fired, in BOTH of the collapse's shapes — by newlines, and by LENGTH alone (>800 chars), where the placeholder is bare `[Pasted text #1]` with no clause, no head and no tail, which is what every long message typed on a phone draws: the host writes it in one chunk, which is a paste, and the composer shows `[Pasted text #1 +11 lines]` — hiding exactly the head `echoProbe` looks for, so the Build sheet's 15-line "set up" prompt echoed perfectly, came back `unconfirmed` (the verdict that is never auto-retried) and sat one keypress from running behind a gravestone. The placeholder counts as the echo when it can be tied to THIS text; the whole contract is pinned at once — written exactly ONCE, Return after it, item completes
node scripts/e2e-scrollcomposer.mjs # a prompt longer than the COMPOSER is still confirmed AND fired. The composer is a viewport: the CLI sizes it off the terminal's height and scrolls the text inside it, so after a write the cursor is at the end and the only rows drawn are the TAIL. Measured on 2.1.267 at 56 columns, a 632-character prompt draws 3 rows at a terminal height of 12, 5 at 20 and all 14 at 40 — a phone gets the small ones. The fourteen-character head every screen rule asks for is off the top of the box, and under 800 characters the CLI collapses nothing, so the placeholder rule cannot speak about it either: the live host filed `unconfirmed` for 45% of every delivery between 300 and 800 characters against 17% of the short ones. `STUB_MODE=scroll` draws a real `❯`-plus-rules composer holding only its last three wrapped rows; the whole contract is pinned at once — written exactly ONCE, Return after it, item completes
node scripts/e2e-limitparallel.mjs # the resume queue's RELEASE MODE (`one`/`repo`/`all`): the probe is alone whatever the mode says — no second session spends an attempt until one has come back working — `repo` mode resumes two sessions in DIFFERENT worktrees together and two in the SAME worktree never, and the mode rides on `limit.config` so every client agrees on it
node scripts/e2e-limitreset.mjs  # a limit that RESETS must produce a typed `continue`, not a badge that removes itself: the block here comes from the LOG alone (the stub prints no banner), and when the rejection's own `resetsAt` passes, the minute sweep used to read that as a CLEAR and cancel the pending attempt (`clearLimitBlock` kills `limitTimer`) — measured 2026-09-10, reset 00:00, two sessions cleared at 00:00:38 with attempts due at 00:02, so nothing was ever typed. A clock-only clear now waits for the attempt it would cancel; being SERVED again still lifts a block on its own
node scripts/e2e-limitstuck.mjs  # a block must NOT clear because the banner merely left the screen: the gate used to accept `lastRealInputAt`, i.e. ANY non-passive byte — an arrow pressed while looking at the session — so a blocked session waiting in the resume queue left it with attempts still 0, no `continue` was ever typed, and the prompt that hit the wall sat at an empty composer for three hours. Recovery is a TURN STARTING or an attempt, never the absence of text
node scripts/e2e-budget.mjs      # the ceiling BEFORE the wall: `hello` carries the budget and its verdict unprompted, an unreadable usage scrape FAILS OPEN (a parse broken upstream must not freeze every queue on every host), a real `/usage` scrape over the ceiling flips the verdict and BROADCASTS it, backlog auto-fire stops and `waiting()` says why in the host's own words, and the block lifts on the CLOCK at a known reset with no fresh scrape needed; and a one-off timed BEFORE the session reset (`schedule.save`, the Send sheet's op) is held with *lifted for this row at its time* until its instant and then runs PAST the session ceiling, while its before-WEEKLY sibling stays held by the session cap in words naming it
node scripts/e2e-notifyprefs.mjs # which notification KINDS may fire at all: a fresh client is told the prefs on `hello`, a mute is BROADCAST to every socket (not just the writer's — the mute follows the account), a muted kind then produces NO feed row and NO push (muting only the display still buzzes the phone), the mute survives a host restart, and unmuting brings the kind straight back
node scripts/e2e-rootguard.mjs   # where a client may make the daemon RUN something: `session.create` handed its `cwd` straight to a spawned `claude` and `build.run` its `repoDir` to a shell command, while every other client-named path was already contained. A directory outside `WATERPLANE_ROOT` is refused and opens NO session — realpath-compared, so `/var` vs `/private/var` is not a hole
node scripts/e2e-setupwatch.mjs  # the setup checklist run WITHOUT being asked: the host sweeps discovered repos on its own, stamps the verdict onto `/api/repos` so a row can badge it, keeps it across a restart and re-stamps it the moment a fix lands — and host-scope rows (the Gemini key) never count, or one unset env var would flag every repo. It never writes into a repo
node scripts/e2e-outboxbadge.mjs # the "things to look at" badge counts the OUTBOX (what an agent left you), never the inbox (what this phone uploaded), is unread-since-you-last-looked, and counts exactly the files the tab it opens would list — the bug being a badge saying 42 that opened on an empty grid
```

`npm test` runs all of them via `scripts/run-e2e.mjs`.

The e2e scripts are the SLOWEST of four layers, and the only ones that need a daemon: `npm test` runs
`npm run lint`, then `npm run test:unit` (`packages/shared/test` plus `packages/web/src/*.test.mjs`, run over the TypeScript itself, ~250 ms, no host), then
`npm run test:host` (`packages/host/test`, the regex heuristics and the two decision cores lifted out
of `SessionManager`, no daemon), and only then `run-e2e.mjs`. The e2e layer requires `npm run build`
first; the other three do not need `packages/host/dist` to exist.

**E2E runner:** `npm test` runs `scripts/run-e2e.mjs`, which DISCOVERS every `scripts/e2e-*.mjs` and runs them sequentially with a per-script timeout. A new script needs no registration — the old hand-maintained list in `package.json` silently drifted until two thirds of the suite never ran in CI. `node scripts/run-e2e.mjs git origin` filters by substring.

**Stub TUI modes** (`scripts/claude-stub-tui.mjs`, `STUB_MODE`): `repaint` (composer visible behind KBs of repaint churn), `blind` (input never echoes), `deaf` (text echoes, every Return swallowed), `login` (the `/login` screen: an OAuth URL hard-wrapped into fixed-width ROWS the way a grid wraps one, the paste-the-code input, the dialog footer — and a code that signs in and clears the screen, so a test can also assert the published link retires). `STUB_HOOKS=1` makes the stub POST a `SessionStart` hook so the session counts as `hooked` — the tests that want the silence fallback leave it off, and only `deaf` needs it (a swallowed Return is only provable with the hook pipe live).

**E2E isolation:** every host-spawning e2e script takes TWO precautions.
- **A private tmux socket directory** — `import "./lib-tmuxiso.mjs"` (or boot through `bootHost`, which imports it). Sessions always run inside tmux: the direct-PTY substrate every script used to pin with `WATERPLANE_TMUX: "0"` is gone, so the suite now tests the substrate people run. The module sets a fresh `TMUX_TMPDIR`, deletes `TMUX` (inside a pane it points a bare `tmux` at that pane's server), and on exit, failure or ctrl-C kills every server in the directory and removes it — a tmux server daemonizes out of the process group, so nothing else would reach it. `run-e2e.mjs` hands each script its own directory and empties it afterwards, so even a SIGKILLed script leaks no pane. A NAME (`-L`) is only a name; a DIRECTORY is a boundary — no `-L` a test or its host picks can resolve to the owner's live server. A host on a temp root still derives its own `-L` name (`sessions/knobs.ts`, both spellings of the temp dir), so two hosts in one script do not share a server and its environment. A script that hands its host a MINIMAL env carries `TMUX_TMPDIR` across (`e2e-tmux.mjs`, `e2e-tmuxenv.mjs`). The host tests that start sessions import the same module.
- `WATERPLANE_PREFLIGHT: "0"` — otherwise the boot preflight (`doctor.ts`) probes the REAL `claude` binary and prints warnings into the host output the scripts assert on.

New host-spawning e2e scripts MUST keep both.

**Restarting the host:** ALWAYS use `npm run restart` — never `pkill; node …` by hand. It builds first (fails loudly without taking the host down), then:
- If the **launchd** service is installed (`deploy/install-service.sh`): it `launchctl kickstart -k`s the service after a short delay (`WATERPLANE_RESTART_DELAY`, default 2s) so launchd does a clean handoff with the freshly-built `dist`. Killing the process by hand instead just makes launchd's KeepAlive race a relaunch (SIGTERM churn → brief downtime).
- Otherwise: kills old instances, *waits for :8770 to free*, starts detached.

The host also exits cleanly on `EADDRINUSE` (no half-bound zombie). After editing host/shared code, `npm run restart` is what loads the new build into the launchd service.

Env knobs: `WATERPLANE_ROOT` (repo scan dir, default `~/dev`), `WATERPLANE_STATE_DIR` (the daemon's own global state — acks, sessions, settings, intents, keys, ledgers — default `$XDG_STATE_HOME/waterplane`, else `~/.local/state/waterplane`; outside the code root, moved there once at boot from `<ROOT>/.waterplane`; read from the process env only. **Every e2e host pins it to `<root>/.waterplane` through `lib-brand.mjs`' `rootEnv(root)`**, and `run-e2e.mjs` gives each script its own `XDG_STATE_HOME` as the belt, so no test host can touch the developer's real state), `WATERPLANE_PORT` (8770), `WATERPLANE_HOST` (bind addr; default Tailscale IP then loopback), `WATERPLANE_CLAUDE_BIN` (`claude`), `WATERPLANE_IDLE_MS` (backlog idle threshold, 10000), `WATERPLANE_IDLE_PING_MS` (turn-finished notification threshold, 4000), `WATERPLANE_STOP_VERIFY_MS` (how long a `Stop` hook is settled against the screen before it is believed, 1200 — `0` believes it at once), `WATERPLANE_AGENT_POLL_MS` (how often a session's running-agent list is re-read while any agent is running, 5 s — armed only while there is one) / `WATERPLANE_AGENT_STALE_MS` (how long an agent log may be quiet and still count as running when no task-notification has retired it, 10 min), `WATERPLANE_MAX_UPLOAD` (bytes, 64 MB default), `WATERPLANE_LIMIT_RETRY_MS` (auto-continue retry cadence when the banner has no reset time, 10 min), `WATERPLANE_LIMIT_RESET_BUFFER_MS` (delay after a parsed reset before continuing, 2 min), `WATERPLANE_LIMIT_MAX_ATTEMPTS` (24), `WATERPLANE_LIMIT_SWEEP_MS` (silent-session limit sweep, 60 s), `WATERPLANE_LIMIT_RESUME_GAP_MS` (breath between two queued resumes, 8 s) / `WATERPLANE_LIMIT_RESUME_SETTLE_MS` (how long the queue waits for a resumed session's verdict before releasing anyway, 90 s), `WATERPLANE_ALLOWED_HOSTS` / `WATERPLANE_ALLOWED_ORIGINS` (extra names/origins for the same-origin guard — a reverse proxy or custom alias), `WATERPLANE_SETUP_WATCH` / `WATERPLANE_SETUP_SWEEP_MS` (10 min) / `WATERPLANE_SETUP_RECHECK_MS` (6 h) / `WATERPLANE_SETUP_SWEEP_BATCH` (12) (the host-side repo setup sweep — `0` on the first stops it), `WATERPLANE_FANOUT_CONCURRENCY` (repos started+fed concurrently in a fan-out, 6), `WATERPLANE_PREFLIGHT` (`0` disables the boot doctor run), `WATERPLANE_VAPID_CONTACT` (VAPID subject for Web Push), `WATERPLANE_TMUX_SERVER` (tmux `-L` socket name; sessions always run inside tmux, a missing binary refuses every session in words (`tmuxreq.ts`) and fails the doctor's `tmux` row; the old `WATERPLANE_TMUX` knob is ignored and the doctor's `tmux-knob` row says so), `WATERPLANE_ALLOW_PUBLIC` (`1` binds the LAN interface — turns on the password gate), `WATERPLANE_THUMBS` / `WATERPLANE_COMPRESS` / `WATERPLANE_WS_COMPRESS` (`0` disables image thumbnails / HTTP br+gzip / WebSocket permessage-deflate — all on by default), `WATERPLANE_MAX_DEPTH` (repo-scan recursion depth), `WATERPLANE_CONFIG_DIR` (host-scope secret store; tests override it), `WATERPLANE_USAGE_TTL_MS` (`/usage` scrape cache, 8 min), `WATERPLANE_METER` (`0` stops recording LLM cost), `GEMINI_API_KEY` + `WATERPLANE_ORACLE` (`0` off) / `WATERPLANE_ORACLE_MODEL` / `WATERPLANE_ORACLE_AUTOFIRE` / `WATERPLANE_ORACLE_CONFIDENCE` / `WATERPLANE_ORACLE_SESSION_MAX` / `WATERPLANE_ORACLE_WEEKLY_MAX` (decision oracle), `WATERPLANE_OCR` (`0` off) / `WATERPLANE_OCR_MODEL` (the phone highlighter's image-text reader — same key, hand-asked, decides nothing). `.env.example` is the complete, user-facing list — keep it current when adding a knob.

**Older names (waterplane was formerly USMC).** Every knob is also read under its old `USMC_` prefix: `env()` prefers `WATERPLANE_X`, falls back to `USMC_X`, and the host reports a legacy-named knob once at boot with the name to use instead. The same fallback applies to the config dir (`~/.config/usmc` → `~/.config/waterplane`, renamed at boot with a symlink left behind), the state dir (`<root>/.usmc` → `.waterplane`; a repo's own `.usmc/` is read as-is until its setup row is tapped), the plugin manifest (`usmc-plugin.json`), the LAN cookie and WebSocket subprotocol, the `usmc://` pairing scheme, and the phone's `usmc.*` storage keys (copied, never moved). All of it comes from `LEGACY` in `packages/shared/src/brand.ts`; the cleanup release that drops a legacy entry removes the fallbacks with it.


## Supply chain

What stops a compromised npm package (or a tampered release) from running on a contributor's
machine or a user's desktop. Each line is a check, not a promise:

- **`.npmrc` `ignore-scripts=true`** (root and `packages/app`): no dependency runs code at install
  time. Measured: `node-pty` and `esbuild` work from their shipped prebuilds with scripts off; the one
  fix-up we relied on a postinstall for (node-pty's `spawn-helper` exec bit) now runs at the front of
  `npm run build:shared`, idempotent and silent. A platform without a node-pty prebuild needs
  `npm rebuild --ignore-scripts=false node-pty` once — `doctor` prints exactly that.
- **`.npmrc` `min-release-age=7`**: `npm install` will not pick a version younger than a week (npm
  ≥ 11.10; turns into `--before`). Most hijacked releases are pulled within days. `npm ci` installs
  the lockfile and is unaffected. Dependabot does not read `.npmrc`, so `.github/dependabot.yml` has
  its own `cooldown`.
- **`npm ci`, not `npm install`**, everywhere a tree is built from scratch.
- **`tools/lockfile.test.mjs`** (in `test:unit`): every lockfile entry resolves from
  `https://registry.npmjs.org/` and carries a sha512 `integrity`. A git/tarball/other-registry dep or
  a stripped hash fails the suite.
- **`npm run audit:prod`** (`npm audit --omit=dev`) runs in the pre-push hook; dev-only advisories
  don't block a push.
- **Actions are pinned to a commit SHA**, not a tag (a tag can be moved).
- **The npm tarball ships `npm-shrinkwrap.json`** generated from the lockfile, so `npm i -g` installs
  the same transitive versions we tested. **The release tarball ships `node_modules`** and needs no
  registry at all.
- **Releases are signed** (Ed25519, public key in `deploy/release-pubkey.pem`, embedded in
  `install.sh`); the installer verifies the signature with the Node it has just checksum-verified.
- **The APK's Gradle deps are hash-verified** (`packages/app/android/gradle/verification-metadata.xml`).

Not covered, by design: a plugin in `~/.config/waterplane/plugins/` runs as you (you installed it),
and the `claude` CLI comes from your own global npm.

## The lint layer (`eslint.config.js`, `tools/eslint/rules.js`)

Added because a large share of this project's invariants existed only as prose in `CLAUDE.md`, and a
prose rule is one a future session obeys only if it happened to read the right paragraph. That is not
a hypothetical: the reason `settings.ts` PATCHES `localStorage.setItem` rather than exporting a
`syncedSet()` helper is stated in that file as "a rule that only holds where somebody remembered to
call it is a rule that breaks silently three edits later, on the device you are not holding". The
lint config is the build-time half of the same argument.

Deliberately NOT a generic preset. `tsc` already runs `strict` with `noUnusedLocals`,
`noUnusedParameters` and `noFallthroughCasesInSwitch`, and it is clean — a style preset on top of
that adds noise and no information. What is configured is the set of things a type-checker cannot
see:

- **`local/no-cors-wildcard`** — `access-control-allow-origin: *` is the thing `origin.ts` replaced.
  Reintroducing it lets any web page drive a daemon that spawns `claude`.
- **`local/no-second-socket`** — one WebSocket per tab carries everything. A second one has its own
  attach state, its own `seq`, and its own idea of when the link died. `ws.ts` is exempt; it owns it.
- **`local/no-functional-setoutbox`** — the send queue is ref-authoritative. The flusher runs
  synchronously after `writeOutbox()`, so a functional updater reads a queue it has already passed.
- **`local/no-storage-key-literal`** — a `waterplane.*` string outside `web/storage.ts`. The registry is
  where a key's group, its shape and whether it SYNCS are stated together.
- **`no-restricted-globals: fetch`** in `web/` outside `api.ts` and the three transport patchers. The
  distinction `api.ts` draws is between the SPINNER and the FUSE, and only the first is optional: a
  raw `fetch` opts out of both, and opting out of the fuse is the bug — a host that accepts the
  connection and then never answers leaves the caller pending for ever, which is exactly the state
  every offline fallback in this client exists to replace, and exactly what a half-open Tailscale
  path produces. Silent background reads have `bgFetch`/`bgJson`, which keep the fuse and skip the
  activity bar.
- **`no-restricted-syntax`** on `dangerouslySetInnerHTML` — transcript text is whatever an agent
  wrote and whatever a tool returned.
- **`max-lines`** at 900, as a WARNING. The point is noticing growth, not blocking a module that is
  large because its problem is.

A genuinely special case takes an inline `eslint-disable-next-line … -- reason`, never a file-level
exemption, so the carve-out is visible where it is taken. There are five, all in `web/`: two object
URLs (`blob:` from this page — no host, no auth, nothing that can hang), `HostSetup`'s pairing probe
(it DECIDES the host, so it cannot resolve against the one already paired), `ws.ts`'s watchdog probe
(must not count as activity; owns its own timeout), and `pull.ts`'s resumable Range loop (its stall
watchdog is a stricter fuse than the shared one, which would cut a slow but healthy download short).

## Where the pure-logic coverage came from

`packages/shared/test/*.test.mjs` did not start as its own layer. Several e2e scripts still assert
the same functions in-process, which is where that coverage began; the difference is that the unit
tests run without `packages/host/dist` existing, so a rule can be pinned before there is anything
to boot.

## Host unit tests (`packages/host/test/*.test.mjs`)

`npm run test:host`. Same idea as the shared layer, aimed at the daemon's **regex heuristics** —
`prompt.ts`, `limit.ts`, `context.ts`, `slash.ts`, `origin.ts`, plus `sessionSearch.ts`, the
decision core lifted out of `SessionManager` so it could be asserted at all. `answergate.test.mjs`
(every gate refusal in words; an accepted answer is the tap's keystrokes), `plugins.test.mjs` (every
broken plugin LISTED with its reason; settings refused whole) and `decisionlog.test.mjs` (the one-time
`oracle-log.json` migration) pin the plugin seam ([plugins.md](plugins.md)).

Two of them are not heuristics and are here for the same reason anyway — the state they pin cannot be
produced on demand by a booted host. **`convfork.test.mjs`** is the fork file operation as pure fs:
fixture in, prefix out, `sessionId` rewritten and `session_id` left naming the parent, stranded
forward references pruned, and the SOURCE sha256 identical afterwards including on the malformed
inputs. **`deliversubmit.test.mjs`** pins what a delivery is entitled to SAY about the submit proof,
against a fake session manager: hooks live with a turn ALREADY running records nothing (a person
interjecting — there is no turn-start to observe, which `DeliverOpts.interactive` already documents),
a pipe that speaks 677 ms INTO the loop is the primary rule answering late and records `good`, and
only no pipe at all is the fallback. Both states are ones a real host cannot be asked for.

These are all pinned by e2e already, so the question is what a second layer buys. It is the SENTENCE
the failure comes with. `CLAUDE.md` describes these as "regex heuristics over TUI output — fragile to
upstream changes", and when upstream changes its wording the e2e failure reads "the session never
published a prompt" after a booted host, a stub binary and a timeout. Here the same change reads
"this line no longer matches", in 60 ms, with the fixture next to it. Fixture in, verdict out.

`limit.test.mjs` holds real banner phrases. That is the carve-out `scripts/claude-stub-limit.mjs`
already takes: the repo-wide rule is about the daemon PRINTING one onto a session's screen, where it
would false-positive its own detector. A test fixture is never rendered into a terminal.

Writing them found one thing worth recording: `parseResetTime` has a **6-hour past grace**, and it is
deliberate. A banner outlives the reset it announces — on screen, and across host restarts — so a
stale "resets 9am" read at noon means the window already reopened and the caller should catch up NOW,
not a day later. Only past that grace does a clock time roll to tomorrow. Session windows are 5h,
which is where the 6 comes from.

## The runner reaps each script's PROCESS GROUP, and why that is not tidiness

`run-e2e.mjs` spawns every script `detached: true` and, when the script closes, kills `-pid` — the
whole group. Without it the suite is unreliable in a way that reads as a broken feature.

Seventy of these scripts stop their host with a bare `host.kill()` (SIGTERM) and do not wait for it
to die. Three escalate to SIGKILL, which is the fossil of somebody hitting this before. A host that
does not exit on SIGTERM — and the `deaf` stub swallows Return, so a shutdown can sit in a pty
write — gets reparented to init and **keeps its port**. The next run of that script then prints

```
[waterplane] port 8814 already in use — exiting (run `npm run restart`)
FAIL: swallowed Return: instruction still written exactly once (copies: 0)
```

`copies: 0` is what a genuinely broken delivery path also looks like, so the failure is
indistinguishable from the bug the assertion exists to catch. It is self-perpetuating: every run
leaves one more orphan, so a script passes the first time and fails for ever after — measured, three
consecutive runs of `e2e-backlog-echo.mjs` failed on ports 8812/8813/8814 in turn, each held by the
previous run's host, while the same script passed the moment the ports were cleared by hand.

The alternative was a wait-then-SIGKILL helper threaded through all seventy scripts, i.e. seventy
chances for script seventy-one to forget. One reap in the runner covers every script and needs no
edit to any of them. The kill is best effort: a group that has already gone throws `ESRCH`, which is
the good case.

**And the runner CLEARS each script's declared ports before starting it.** Reaping plus waiting still
left three scripts a run failing on `port … already in use`, always a different three — the suite was
flaky in a way that reads as a broken feature, since a host that never bound produces `copies: 0` and
`ECONNREFUSED`, not an assertion about behaviour. So `portsOf()` reads the 8xxx literals out of the
script's own source (that is where the numbers are; a table here would be a second copy to keep in
step) and `freePort()` kills whatever holds them — **but only a process whose command is
`packages/host/dist/main.js`**, and never `WATERPLANE_PORT`/8770, so the runner can never take down the
daemon the developer is using or a stranger's process that happens to hold 8813.

**Reaping is not enough on its own — the runner WAITS for the group to be gone.** Killing is
asynchronous, and the e2e ports are hand-assigned and SHARED: five scripts sit on 8796
(`uiusage`, `hook`, `images`, `backlog-prompt`, `tmux`). That is fine for a sequential runner, and
fine only for as long as each host is provably dead before its successor binds — otherwise the next
script boots into `port 8796 already in use`, exits, and its assertions fail against a host that
never existed. `groupGone()` polls signal 0 against the group until `ESRCH`, with a 3 s ceiling: past
that it gives up rather than failing the run, because the next script's own bind error is a better
message than one invented here.

**Detaching has an other side, and the runner has to close it**: the child is no longer in the
runner's group either, so a ctrl-C or an external kill of `run-e2e` no longer reaches the script or
the hosts it spawned. They survive holding their ports — the very failure the detaching exists to
fix, arriving through the other door, and it was observed within minutes of the change. Hence
`liveGroups` and the `SIGINT`/`SIGTERM`/`SIGHUP` handlers: interrupting the runner reaps every group
it still has open.

## The rough map, and the three scripts described nowhere else

### The rough map

CLAUDE.md carried a one-line-per-script index of the e2e suite for a long time. It is here verbatim.
**The script NAMES have since moved out of CLAUDE.md too** — they are the suite list at the foot of
the `testing` SKILL, which is where a name is checked against what is on disk, and CLAUDE.md now
carries only `node scripts/run-e2e.mjs <filter>` and a pointer to that skill. The per-script detail
above is the long form of the same thing.

What each pins: the per-script sections above. Rough map —
`smoke` PTY round-trip · `statedir` the boot move of the daemon's state out of the code root (moved byte for byte, symlink left, stores really open there, idempotent, both-present MERGED with the collision left in the old dir, a live host for the same root blocks the move) · `api`/`docs`/`thumbs` HTTP transport, any-kind files, thumbnails, ETag ·
`scaffold`/`setup`/`secret` project init, compliance, write-only secrets ·
`setupwatch` the compliance sweep nobody asks for (repo-scope only, never writes) ·
`backlog*`/`manualfire`/`onesession`/`fanout` work delivery · `agentintent` an agent's loopback post for later (one row per key, the mark, browsers/proxies refused) · `queue`/`opqueue`/`ack`/`submit`/
`answer`/`startprompt` the offline send queue and at-most-once rules ·
`autopull`/`netfuse`/`netstats` download queue + link telemetry ·
`hook`/`limit`/`limitqueue`/`resurrect`/`resume`/`restore`/`tmux` session lifecycle ·
`fanout` also pins that a sweep SURVIVES a restart mid-run and reconciles, rather than losing its
run record entirely ·
`notifyprefs` which alert kinds may fire at all ·
`budget` the ceiling that pauses automatic work short of the usage wall, and lifts itself ·
`prompt` the choice-box detector on a screen it can only half-read ·
`clihealth` the board that says when a heuristic has gone blind — and the pair that keeps it
honest: an unreadable box IS a miss, prose that merely says the footer's words records nothing ·
`login` the sign-in link the terminal GRID broke into six rows, and the code going back the other way ·
`checkbox` a multi-select box submitted on its own row, not wherever the cursor sat ·
`pastechit` a long multi-line prompt the TUI COLLAPSES is still confirmed, and still fired ·
`scrollcomposer` a prompt LONGER THAN THE COMPOSER — which is a viewport, not a field — is confirmed off the rows the box is actually drawing ·
`askbox` the CLI's own words for a box the terminal cut ·
`promptlive` a box that is being REDRAWN stays published (output never retires a prompt) ·
`schedule` the wall-clock rules + fire-once-per-occurrence ·
`origin` same-origin guard · `rootguard` where a client may make the daemon RUN something · `webbundle`/`hosturl` Android shell ·
`slashlocal` view-opening commands (`/cost`) delivered without an Esc or a Return storm ·
`echo-stream` the composer found by its BOX through a torn render, with no Esc into the live turn ·
`settle` re-deciding a delivery whose verdict was ambiguous, from the CLI's own log ·
`transcript`/`search`/`pin`/`star`/`sent`/`settings`/`hints`/`uiusage` UI-facing state ·
`screenlog` the locally rebuilt terminal scrollback (the pan that needs no socket) ·
`gallery` which cached file listing may answer which question with the link down ·
`tree` browsing the worktree and the rules a file SAVE obeys (base-sha or nothing) ·
`archive` every conversation on disk, and the reopen stack that survives a restart ·
`forkfrom` a conversation cut at a TURN: the prefix written under a new id and RESUMED (never
`--fork-session` on top, which opens a third conversation), the source log untouched, a refusal that
is a refusal rather than a session on the whole conversation, and a replayed ackId spawning nothing ·
`assess` (in flight) the repo assessment: a proposal is a diff, and nothing applies itself ·
`smartpick` the look a repo takes before its next item fires — the one thing here that APPLIES
ITSELF, so: un-ticked costs zero completions (counted), every failure fires the order that was
already there and is not retried, a merge archives its originals and `undo` puts them back, a drag
is never re-placed, and a restart re-derives nothing ·
`capture` the verified capture loop, driven through `scripts/capture-stub.mjs` (a fake ciqkit — the
only backend of the four a build machine can run): the frame AND its sidecar under
`.claude/outbox/`, both served by the artifact route; the verdict line asserted as a GRAMMAR rather
than one frozen string; a backend this desktop cannot drive settling `failed` with a SENTENCE naming
what is missing; a traversal-shaped working dir refused and never offered as a button; and ciqkit's
exit 3 downgrading the claim from `verified:anchor` to `settled:stable` while KEEPING the frame as
evidence — plus the one that is cheapest to get wrong, an unscored capture leaving `score` ABSENT
instead of writing a 0 nobody measured ·
`launchwait` a session the host holds until the files its prompt names arrive ·
`intent` what "the host has it" is worth: the ack that outran the disk (read the file on the
receipt, then `kill -9`), the replay past a WIPED ack ledger, and the crash between an occurrence
being spent and its executor running ·
`intentnodrop` **the complaint's pin**: ten prompts posted, the host taken away for longer than
every clock this design deleted (the phone's 30-minute TTL, its hour-long retire, the ack ledger's
45 minutes), and on reconnect all ten still there, byte-identical, none given up on for waiting ·
`attach` whether the files a queued prompt names will actually be there ·
`offlinelists` the two host-pushed lists READ with no socket (build commands, schedules): seeded from
the device cache, saying their age, and never printing "none" for "this device has not seen them".
### `e2e-intent.mjs`, `e2e-offlinelists.mjs`, `e2e-settlesweep.mjs`

The three the per-script sections above never picked up.

**`e2e-intent.mjs` — what "the host has it" is worth.** The complaint the whole intent rework answers
is prompts that were lost, and the promise made in exchange is narrow and checkable: `op.ack ok`
means the words are on the desktop's DISK, and nothing after that may lose them. That promise has
exactly three ways to break, and the script is one assertion per way: the ack going out before the
write (pinned by reading `.waterplane/intents.json` the instant the receipt lands, then by `kill -9` — not
SIGTERM, which would let a flush handler paper over a store that only persists on exit); the second
delivery (the ack ledger forgets after 45 minutes and a parked create may wait six hours, so
at-most-once has to survive the ledger being gone entirely — the ledger file is DELETED and the same
intent id replayed); and the crash between an occurrence being spent and its executor running.

**`e2e-offlinelists.mjs` — two host-pushed lists READ offline.** A repo's build commands and the
schedules. Both are host state, both were kept in socket-fed React state only, and both are looked at
almost exclusively when the link is bad — the build sheet is the escape hatch for a rate-limited or
unreachable desktop, and "what runs tonight" is asked from a train. With no socket they rendered
EMPTY, and an empty list is a claim: the build sheet told a repo with five commands that it had none
and offered to spend tokens working them out again. The failure is silent in both directions, which
is what makes it worth a script — nothing throws, nothing logs, and a future edit that
re-initialises either piece of state to `new Map()` / `[]`, the obvious-looking thing to write, puts
the lie straight back on the screen with no test going red.

**`e2e-settlesweep.mjs` — the host settles its own open questions, with nobody watching.**
`e2e-settle.mjs` covers the PHONE asking (`input.settle`), a path that needs a phone, a live socket
and a client that remembered to ask at most three times before its row retires — i.e. it works on
exactly the days it is not needed. This covers the other half: `deliver.ts` writes an unconfirmable
verdict down as an open QUESTION, the host re-asks it against the CLI's own conversation log on a
sweep, and the answer exists whether or not anyone was connected when it arrived. Asserts that an
`unconfirmed` delivery becomes an open row carrying its FULL text (not a 200-character clipping, not
a toast); that the host resolves it with the socket CLOSED and a client reconnecting an hour later
finds the answer in the hello snapshot with no request; that an attached client is PUSHED the
resolution (`delivery.settled`) so it can retire the row it is showing; and that `absent` — a
readable log that does not contain the prompt — is re-sent by the host up to `RESEND_TRIES` times
and not once more, however many sweeps run. The script pins the budget at two (`WATERPLANE_RESEND_TRIES`)
so both halves are proved without sitting through the default four: a second attempt is allowed
because each one is preceded by its OWN fresh `absent` verdict and so has no copy to stack on, and
the budget is a wall, which is what keeps the failure that made `unconfirmed` un-retryable — one
prompt typed five times — from coming back as a poller that never stops.

### Why these rules are lint rules and not paragraphs

CLAUDE.md's Invariants section carried this argument; it belongs beside the rules themselves.

Some of these are now checked. `tools/eslint/rules.js` holds the repo-specific rules —
`no-cors-wildcard`, `no-second-socket`, `no-functional-setoutbox`, `no-storage-key-literal`,
**`no-silent-send`** (a socket write in an `on*` JSX handler must end in a toast or a queue entry —
`ws.ts` RAM-queues what it can't deliver and the watchdog reload discards it, so a bare send in a tap
is a button that sometimes does nothing and never says so; `liveSend`/`liveAsk` (`core/conn/useConnection.ts`) are
the receipt. **In `features/**` every bare `conn.send` answers for itself**, in the function it is
written in, because the JSX half was bypassed by one level of indirection — `onScan={() =>
scanRepo(dir)}` in a view, the bare send in `features/build/store.ts`. It passes inside a
`messages` handler or `boot` (nobody tapped), or when the same function also calls a receipt
(`toast`/`say.toast`, `liveSend`, `liveAsk`, `queueOp`), opens the sheet that answers (`nav.open`)
or reads `conn.status` — the offline case decided in code. Pinned in `tools/nosilentsend.test.mjs`) — plus the `fetch` ban outside `api.ts`. They are not style: each is a rule stated in prose here that a
future edit only obeys if it happened to read the right paragraph, and the project's own stated
preference is a rule enforced by patching a global rather than a helper every call site must
remember (`settings.ts`, `hostUrl.ts`, `hints.ts`). This is the build-time half of that argument.
A genuinely special case takes an inline `eslint-disable-next-line … -- reason`, so the exemption is
visible where it is taken. Count them, don't remember them: `grep -rn
'eslint-disable.*no-silent-send' packages/` gave five on 2026-09-24 — App's `onResize`, and in
`features/build` + `features/capture` the two forms that are their own receipt (`askOptions`,
`scanRepo`) and the two welcome-only re-syncs — and eight on 2026-09-25, after the web refactor:
`onResize` moved with the terminal into `core/session/TermArea.tsx`, `build` gained a third (its
repo scan's editor), and `backlog` (a welcome-only re-sync), `search` (the sheet is the receipt)
and `hostTools` (the Return half of a code `liveSend` just receipted) one each. The `fetch` ban (`no-restricted-globals`) has five
more (two object URLs, the pairing probe, the watchdog probe, the streaming Range loop). Generic presets are deliberately NOT pulled in — `tsc`
already runs strict with `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`.

`tools/diagrams.test.mjs` keeps the hand-drawn `docs/assets/architecture*.svg` honest: every path or module file a `<text>` names must exist under an explicit list of search roots (a few non-repo names are allowed, each with a reason), the architecture note links every picture, and the README links the note. A diagram that names something gone fails with "update the picture in the same commit as the code".

### CLAUDE.md has a budget because it had a sentence

`tools/claudemd.test.mjs` checks three things about `CLAUDE.md`: total size, per-entry size, and that
every module it names is described here in `docs/notes/`. All three were already written in the file
itself, in its own first paragraph, and all three failed.

The numbers: the file said *keep this under ~120k chars* and *add a subsystem ⇒ one line here, the
why in the notes*. It reached **148,582 chars** — ~37k tokens, re-read on every turn of every session
and every subagent, measured at **21% of every token this repo spent in a week**. A fresh session's
first turn cost 65,728 tokens; after the groom that set the budget, 46,829. The file was worth about
**19k tokens on every turn anyone ran**.

Nobody ignored the rule. Each edit added a clause to one entry, every clause was worth writing, and
none of them was the one that broke it — which is the exact failure mode
[the lint rules](#why-these-rules-are-lint-rules-and-not-paragraphs) exist for, one document over.
A budget is the only form of this rule that cannot be satisfied by writing more.

Two exemptions are deliberate, because the rule is "one MODULE, one line" and not "no long bullets":
only `## Architecture` is measured (Invariants and Heuristics are rule prose by design, and capping a
paragraph there would push a hard-won rule into a footnote), and a bullet naming four or more modules
is an INDEX, which is the compression the rule wants rather than a violation.

The third check is the one that makes the other two safe. If the only description of a module is its
CLAUDE.md entry, then meeting the budget means deleting knowledge; requiring the note first means
trimming the entry is always lossless. It caught `vite.config.ts` on its first run — named in
CLAUDE.md as an update boundary, documented nowhere.

### …and the skills got the same treatment, one level down

The budget worked on `CLAUDE.md` — 148,582 chars down to ~11.7k — and the weight moved rather than
left. `web` grew to 109,036 chars and `host` to 76,979, and the CLI's own `/usage`
breakdown named the result: **21% of a fortnight's usage attributed to `/web`**. This is the
same arithmetic as before, one indirection later. A skill body is not re-read per turn the way
`CLAUDE.md` is, but it stays in the window once loaded, and every turn after it re-sends the whole
conversation. The routing table said "load BEFORE reading anything under `packages/web`", so for
any web task those 27k tokens were not on-demand — they were a prerequisite, by rule.

The obvious lever is not the one that works. Skill frontmatter accepts `model:`, and the CLI's own
hint suggests it ("Heavy skills can be scoped down or run with a cheaper model via skill
frontmatter"), but the override is TURN-SCOPED: it changes the model for the turn that invokes the
skill, which is precisely the turn that most needs to understand the rules, and leaves every
editing turn afterwards paying full price for the body. `context: fork` does remove the body from
the window — the skill runs as a subagent and returns a result — but these skills are a reference
the editor must hold while editing, not a task to delegate, and a fork returns a summary of exactly
the one-sentence rules that are dangerous to miss.

So: scope down. Each of the two became a ROUTER — a generated module→skill map, a symptom index,
and the conventions every slice needs — plus area sub-skills (`web-chrome/-send/-term/-work/`
`-files/-config/-numbers`, `host-core/-work/-spenders/-ledgers/-machine`). Bullets moved
byte-exact; nothing was reworded in the move. Nine host bullets folded into `heuristics`
instead, which already claimed those modules — and that fold turned up the defect that duplication
always eventually produces: both files stated `deliver.ts`'s submit proof, and the older wording
("reads hook-announced turns ONLY") was already false against `shared/slash.ts`'s live
`worksUnannounced`, which admits `turnFromScreen()` for `/compact`. The first merge kept BOTH — a
sentence reading "ONLY … EXCEPT" — and a review caught it; the "ONLY" is now gone. Worth keeping as
the record of how a dedup goes wrong: the reviewer of a merge has to check what SURVIVED, not only
what was dropped.

What it cost and what it bought, measured: always-on (`CLAUDE.md` + every description) went from
14,972 to 22,115 chars, because 19 descriptions are listed every turn instead of 7. The worst-case
web task went from 124k to 55k, the worst-case host task from ~93k to 43k. The number that
actually describes a day's work is the history-weighted one the `context` row now reports: the
median non-batch web commit would load **58,818** against 122,662 before, p90 **83,607** — and 36%
of web commits touch three or more sub-skills, which is where that p90 comes from. The trade pays
as long as web/host turns are more than about a tenth of all turns; `/usage` says they are a fifth.
Two costs stay on the record: every turn that touches NEITHER package pays the +7,143 anyway, and
19 skills is over the `maxSkills: 12` in `shared/contextweight.ts`, so this repo's own
context-weight row now reads heavy. That is the row doing its job, and the answer is a per-repo
threshold — a setting, argued once, not a default anyone should move.

Three checks hold the shape, because each of them is a failure that is invisible in a diff:
`tools/skillmap.mjs` GENERATES the router's map from the sub-skills' bullet heads and
`claudemd.test.mjs` regenerates it to catch drift (a map pointing at the wrong skill reads exactly
like "there is no rule here"); sub-skill descriptions must claim disjoint modules, since a
description is all the agent sees when choosing; and a router has its own char budget, because a
router that grows back into a reference is this whole problem again. A review added three more: a
sub-skill has a budget too (without one, every bullet could migrate into `web-misc` and the
other checks would all stay green), a description may not name a module no bullet is ABOUT (a
promise the router cannot route to — and one the repo-health metric meters at zero forever, since
it charges a commit only for head-claimed modules), and the map may not name a module that has left
the tree unless the bullet says DELETED, the way the `giveups.ts` tombstone does.

One piece of debt recorded rather than fixed: `entries()` above measures per-entry length only
under a `## ` heading, and every skill file uses a single `#`, so the 1,000-char entry cap does not
currently apply to them. **37 bullets across all skills, 70,811 chars, would fail it if it did** —
`ctxlog.ts` at 6.2k, `smartpick.ts` at 5.0k, `SendSheet.tsx` at 3.7k. That is a real backlog of
entries that have started explaining themselves, and the fix is to move the story to these notes,
not to add the headings and then argue for exemptions. (An earlier draft of this paragraph said 32
and 62k: it had counted only the two split skills, and counted them before the fold. Regenerate the
number with `entries()`'s own filter before quoting it.)

## Publishing the public repo

**Decision.** This private repo stays the working repo and its `main` the daily trunk. The public
repo is a FRESH repo with no private history: first commit "Initial public release", then ONE
squashed commit per release, built from an allow-listed snapshot of a release TAG. Contributions
come back as patches (`git format-patch` here is `git am` there), which works because the directory
layout is identical in both.

**The two pieces.**
- `deploy/public-allowlist.txt`: what is public; everything else is private by default.
  gitignore-style, but the LAST matching line wins, so a `!` carve-out goes after the include it
  narrows. `docs/notes`, `docs/analysis`, `docs/prompts` and the code-quality review are excluded
  pending review; `.claude/` ships only `skills/`.
- `scripts/release/publish-public.mjs` (`npm run release:public --`), pure parts in
  `public-lib.mjs` (tests: `scripts/release/public-lib.test.mjs`, in `test:unit`).

**Usage.**

```bash
git tag v0.2.0
npm run release:public -- --tag v0.2.0 --to ../public-clone --report /tmp/snapshot.md   # dry run
npm run release:public -- --tag v0.2.0 --to ../public-clone --accept reviewed.txt --commit
git -C ../public-clone push origin main                                                  # by hand
```

The default is a DRY RUN. The snapshot is `git archive <tag>` (tracked files only, never the working
tree), filtered by the allow-list read FROM THE TAG (so a run is reproducible). `--write` makes the
target's working tree equal the snapshot (deleting what is gone, never touching its `.git`);
`--commit` also commits ("Release <version>" plus that CHANGELOG section as body, or "Initial public
release" for an empty target). **It never pushes.** Set a public git identity in the target first:
the script warns if the author email is one from the private history.

**Scans gate the release** (any unaccepted hit exits 1 and writes nothing): gitleaks when on PATH,
plus a built-in pass (private keys, AWS/GCP/GitHub/npm/Anthropic/OpenAI/Google/Slack key shapes,
JWTs, `password =` in config files, `.p8/.p12/.jks/.keystore/.pfx` present at all), plus personal
data: every author and committer email in the history, the home path, the hostname, Tailscale
`100.64/10` addresses and `*.ts.net` names that are not obvious placeholders. LAN addresses and files
over 5 MB are warnings only. Secrets are masked in the report (it lands in a phone gallery).

**Accepting a false positive.** Each hit prints a token `path:line:hash`; the hash covers the rule
and the trimmed line, so editing the line un-accepts it. Put reviewed tokens in a file (`#` comments
allowed) and pass `--accept`. Stale entries are listed. A hit that is real is fixed in the source,
never accepted.

**Dangling links.** `CLAUDE.md` and the skills link into `docs/notes`. The report lists every
markdown link, and every backticked `path/x.md` mention, in published markdown that points at a
tracked-but-unpublished file (separately: links that were already broken). It does not fail: the
owner decides whether to publish the target or rewrite the link.
