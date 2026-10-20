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
node scripts/e2e-usagesources.mjs # usage readings per source: readings list (claude first), null probe absent, throw keeps until reset, plugin off drops it, /api/usagelog/:source
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
node scripts/e2e-resurrect-item.mjs # a backlog item whose own session exits at the usage limit FOLLOWS the revival instead of being requeued — the words run exactly once, and the row says what it is following while it waits
node scripts/e2e-secret.mjs     # write-only secret setter: host + repo scope, gitignore gate (auto-add, refuse-on-tracked), masking, no read path
node scripts/e2e-setup.mjs      # repo compliance checklist + idempotent auto-fixes (gitignore inbox/outbox, CLAUDE.md section); no gemini row any more
node scripts/e2e-plugin.mjs     # plugins end to end: the fixture (scripts/fixtures/plugin-echo) listed active from a temp plugin-paths.json and a broken one listed with its reason, an out-of-range setting refused in words, an action answered, the plugin's suggestion on SessionInfo, and its answers held to the core's gate — refused with the session switch off, typed through the tap's path once on, refused for a blocked box
node scripts/e2e-stream.mjs     # plugin streams (api.stream, 1.4): the fixture (scripts/fixtures/plugin-stream) opened over a real ws — binary frames decode, seq increases, params re-steer and one input reach the plugin once, a refusal in its words, close stops frames, a killed socket ends the sub (cause socket), and a socket that never opened one gets zero binary frames
node scripts/e2e-desktop.mjs    # the live desktop (packages/extensions/desktop) end to end, SYNTHETIC only (WATERPLANE_DESKTOP_SYNTHETIC=1: test pattern, --no-capture, --dry-input): the first probe builds the real helper, an H.264 key decodes, a params change shrinks the picture, a crop brings a key, input is dropped with control off and logged as dry-input with it on, Auto reports its pick, close stops the helper. SKIPs off a Mac or without swiftc. Details: [desktop.md](desktop.md)
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
node scripts/e2e-livereclaim.mjs # a `live/` record whose tmux session died while the host was down is deleted at the next boot — old, stamped with this server, absent from a SUCCESSFUL `tmux ls` — while a record whose session is alive, one younger than the age gate (30 s here via `WATERPLANE_STALE_LIVE_MIN_AGE_MS`) and an UNSTAMPED old one on a non-default socket are all kept, the live one is still rediscovered, and the host says so in one line
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
node scripts/e2e-trustbox.mjs    # claude 2.1.293's first-launch trust box (`STUB_MODE=welcome STUB_TRUST=1`): UNNUMBERED rows, cursor on "No, exit" — once read as nothing, so a new user's first session sat waiting with no buttons. Published as a `nav` trust box; the phone's `promptChoice` walks the cursor Down onto "Yes" against the rendered screen (`chooseClaudeNavBox`) and presses Return only there; the session is let in and the box retires. Detection and the walk's refusals: `packages/host/test/trustbox.test.mjs`
node scripts/e2e-permmode.mjs    # the phone's mode picker, host half (`STUB_MODE=permmode` draws 2.1.293's footer and cycles it on shift+tab): `session.mode` reaches its target in exactly the presses the cycle needs, presses NOTHING when already there, goes round once and says so in words for a mode the cycle lacks, serialises two quick taps, and `liveMode` follows a raw shift+tab on the quiet tick — presses counted off the stub's input log
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

**E2E runner:** `npm test` runs `scripts/run-e2e.mjs`, which DISCOVERS every `scripts/e2e-*.mjs` and runs them in a worker pool (`--jobs N` / `E2E_JOBS`, default 60% of the cores capped at 10; `--jobs 1` is the old one-at-a-time run with live output) with a per-script timeout. A new script needs no registration — the old hand-maintained list in `package.json` silently drifted until two thirds of the suite never ran in CI. `node scripts/run-e2e.mjs git origin` filters by substring. Why the pool is safe, and the serial list: [Parallel e2e](#parallel-e2e).

**Stub TUI modes** (`scripts/claude-stub-tui.mjs`, `STUB_MODE`): `repaint` (composer visible behind KBs of repaint churn), `blind` (input never echoes), `deaf` (text echoes, every Return swallowed), `login` (the `/login` screen: an OAuth URL hard-wrapped into fixed-width ROWS the way a grid wraps one, the paste-the-code input, the dialog footer — and a code that signs in and clears the screen, so a test can also assert the published link retires). `STUB_HOOKS=1` makes the stub POST a `SessionStart` hook so the session counts as `hooked` — the tests that want the silence fallback leave it off, and only `deaf` needs it (a swallowed Return is only provable with the hook pipe live).

**E2E isolation:** every host-spawning e2e script takes TWO precautions.
- **A private tmux socket directory** — `import "./lib-tmuxiso.mjs"` (or boot through `bootHost`, which imports it). Sessions always run inside tmux: the direct-PTY substrate every script used to pin with `WATERPLANE_TMUX: "0"` is gone, so the suite now tests the substrate people run. The module sets a fresh `TMUX_TMPDIR`, deletes `TMUX` (inside a pane it points a bare `tmux` at that pane's server), and on exit, failure or ctrl-C kills every server in the directory and removes it — a tmux server daemonizes out of the process group, so nothing else would reach it. `run-e2e.mjs` hands each script its own directory and empties it afterwards, so even a SIGKILLed script leaks no pane. A NAME (`-L`) is only a name; a DIRECTORY is a boundary — no `-L` a test or its host picks can resolve to the owner's live server. A host on a temp root still derives its own `-L` name (`sessions/knobs.ts`, both spellings of the temp dir), so two hosts in one script do not share a server and its environment. A script that hands its host a MINIMAL env carries `TMUX_TMPDIR` across (`e2e-tmux.mjs`, `e2e-tmuxenv.mjs`). The host tests that start sessions import the same module.
- `WATERPLANE_PREFLIGHT: "0"` — otherwise the boot preflight (`doctor.ts`) probes the REAL `claude` binary and prints warnings into the host output the scripts assert on.

New host-spawning e2e scripts MUST keep both.

**Restarting the host:** ALWAYS use `npm run restart` — never `pkill; node …` by hand. It builds first (fails loudly without taking the host down), then:
- If the **launchd** service is installed (`deploy/install-service.sh`): it `launchctl kickstart -k`s the service after a short delay (`WATERPLANE_RESTART_DELAY`, default 2s) so launchd does a clean handoff with the freshly-built `dist`. Killing the process by hand instead just makes launchd's KeepAlive race a relaunch (SIGTERM churn → brief downtime).
- Otherwise: kills old instances, *waits for :8770 to free*, starts detached.

The host also exits cleanly on `EADDRINUSE` (no half-bound zombie). After editing host/shared code, `npm run restart` is what loads the new build into the launchd service.

Env knobs: `WATERPLANE_ROOT` (repo scan dir, default `~/dev`), `WATERPLANE_STATE_DIR` (the daemon's own global state — acks, sessions, settings, intents, keys, ledgers — default `$XDG_STATE_HOME/waterplane`, else `~/.local/state/waterplane`; outside the code root, moved there once at boot from `<ROOT>/.waterplane`; read from the process env, the repo `.env` or the per-user `.env`, never the state dir's own — so an e2e host must pin it in its env, which beats every file. **Every e2e host pins it to `<root>/.waterplane` through `lib-brand.mjs`' `rootEnv(root)`**, and `run-e2e.mjs` gives each script its own `XDG_STATE_HOME` as the belt, so no test host can touch the developer's real state), `WATERPLANE_WSL_DISTRO` (Windows launcher only: the distro the host runs in, default WSL's default), `WATERPLANE_PORT` (8770), `WATERPLANE_HOST` (bind addr; default Tailscale IP then loopback), `WATERPLANE_CLAUDE_BIN` (`claude`), `WATERPLANE_IDLE_MS` (backlog idle threshold, 10000), `WATERPLANE_IDLE_PING_MS` (turn-finished notification threshold, 4000), `WATERPLANE_STOP_VERIFY_MS` (how long a `Stop` hook is settled against the screen before it is believed, 1200 — `0` believes it at once), `WATERPLANE_AGENT_POLL_MS` (how often a session's running-agent list is re-read while any agent is running, 5 s — armed only while there is one) / `WATERPLANE_AGENT_STALE_MS` (how long an agent log may be quiet and still count as running when no task-notification has retired it, 10 min), `WATERPLANE_MAX_UPLOAD` (bytes, 64 MB default), `WATERPLANE_LIMIT_RETRY_MS` (auto-continue retry cadence when the banner has no reset time, 10 min), `WATERPLANE_LIMIT_RESET_BUFFER_MS` (delay after a parsed reset before continuing, 2 min), `WATERPLANE_LIMIT_MAX_ATTEMPTS` (24), `WATERPLANE_LIMIT_SWEEP_MS` (silent-session limit sweep, 60 s), `WATERPLANE_LIMIT_RESUME_GAP_MS` (breath between two queued resumes, 8 s) / `WATERPLANE_LIMIT_RESUME_SETTLE_MS` (how long the queue waits for a resumed session's verdict before releasing anyway, 90 s), `WATERPLANE_ALLOWED_HOSTS` / `WATERPLANE_ALLOWED_ORIGINS` (extra names/origins for the same-origin guard — a reverse proxy or custom alias), `WATERPLANE_SETUP_WATCH` / `WATERPLANE_SETUP_SWEEP_MS` (10 min) / `WATERPLANE_SETUP_RECHECK_MS` (6 h) / `WATERPLANE_SETUP_SWEEP_BATCH` (12) (the host-side repo setup sweep — `0` on the first stops it), `WATERPLANE_FANOUT_CONCURRENCY` (repos started+fed concurrently in a fan-out, 6), `WATERPLANE_PREFLIGHT` (`0` disables the boot doctor run), `WATERPLANE_VAPID_CONTACT` (VAPID subject for Web Push), `WATERPLANE_TMUX_SERVER` (tmux `-L` socket name; sessions always run inside tmux, a missing binary refuses every session in words (`tmuxreq.ts`) and fails the doctor's `tmux` row; the old `WATERPLANE_TMUX` knob is ignored and the doctor's `tmux-knob` row says so), `WATERPLANE_ALLOW_PUBLIC` (`1` binds the LAN interface — turns on the password gate), `WATERPLANE_THUMBS` / `WATERPLANE_COMPRESS` / `WATERPLANE_WS_COMPRESS` (`0` disables image thumbnails / HTTP br+gzip / WebSocket permessage-deflate — all on by default), `WATERPLANE_MAX_DEPTH` (repo-scan recursion depth), `WATERPLANE_CONFIG_DIR` (host-scope secret store; tests override it), `WATERPLANE_USAGE_TTL_MS` (`/usage` scrape cache, 8 min), `WATERPLANE_METER` (`0` stops recording LLM cost), `GEMINI_API_KEY` + `WATERPLANE_ORACLE` (`0` off) / `WATERPLANE_ORACLE_MODEL` / `WATERPLANE_ORACLE_AUTOFIRE` / `WATERPLANE_ORACLE_CONFIDENCE` / `WATERPLANE_ORACLE_SESSION_MAX` / `WATERPLANE_ORACLE_WEEKLY_MAX` (decision oracle). `.env.example` is the complete, user-facing list — keep it current when adding a knob.

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
- **`npm run audit`** runs in the pre-push hook and `ci.yml`: any advisory in what ships
  (`audit:prod`), **high+ in dev tooling too**, and high+ in `packages/app`'s own lockfile (the
  Capacitor shell, outside the workspaces). Dev deps used to be exempt; that let 8 advisories (one
  critical, `shell-quote` under `concurrently`) and a critical in `@capacitor/android` — which
  ships inside the APK — sit unseen until a fresh `npm ci` printed them on a first install
  (2026-10-07). Dev tooling runs on the contributor's machine; it is not harmless.
- **Fixing one: `npm audit fix`, then `overrides`** in the root `package.json` for a transitive dep
  whose parent pins an exact vulnerable version (`concurrently` pins `shell-quote`). Neither path
  bypasses `min-release-age`: a fix published under a week ago is not installable yet, and the gate
  stays red until it is — wait it out rather than lowering the age.
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

**…and it may clear a port only once it OWNS it.** `freePort()` cannot tell a stale host of this run
from a LIVE host of another run — both are `dist/main.js` on the port — and two `git push`es run two
full suites at once. Suite B starting `e2e-submit` (8836) SIGKILLed suite A's host mid
`e2e-smartpick` (8836 too; since removed): A reported 123/124, B passed, and it read as that script being flaky under
load. So each script first takes `/tmp/<slug>-e2e-ports/<port>.lock` (pid inside, `wx`) for every
declared port, ascending, and releases them all before the next script asks — no run holds a port
while waiting for another, so two runs cannot deadlock. The other run is WAITED for, never killed; a
lock whose pid is no longer a `run-e2e` is taken over, so a crashed run never wedges the next.

**…and a takeover has exactly one winner** (`scripts/lib-portlock.mjs`, pinned by
`tools/portlock.test.mjs`). The first version unlinked a stale lock and retried `wx`: two runs reading
the same dead pid both unlinked — the second one removing the FIRST one's fresh, live lock — and both
held the port. And `wx` is create-then-write, so a reader in between read an empty file as "no owner"
and removed a lock a microsecond old. Now a lock is created only by `link(tmp, lock)` (the pid is in it
before the name exists), and a stale one is removed only inside an exclusive `mkdir` takeover mutex,
after its owner is read again there — nothing else ever removes another run's lock, so the file that
re-read judged is the file the unlink removes. `ps` failing to spawn (a machine out of processes)
reads as ALIVE: a wrong "dead" is a live host killed, a wrong "alive" is a wait. The test forces both
interleavings through hooks and then has eight processes take over a dead run's lock at once, three
rounds; the old algorithm fails that in round 0.

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

## Parallel e2e

The suite ran one script at a time: 125 scripts, 1317 s of a 1420 s pre-push. Almost all of that is
WAITING (a host booting, a settle window, a stub's turn), not CPU, so `run-e2e.mjs` now runs a pool.
Measured 2026-10-08 on the 16-core desktop with other sessions loading it (load average ~15–20):
**219–223 s at `--jobs 6`** for all 125 (two runs on `1a470120`; 250–390 s in runs where something
else spiked the load past 140). The default went from 6 to 10 on 2026-10-16: the gate showed 20%
CPU at 6, and a simulation off `e2e-times.json` put 10 at ~150 s against ~220 s. Wider buys
nothing until two scripts stop sharing a port — `e2e-settle` and `e2e-settlesweep` both own 8861,
~140 s back to back. What makes running side by side safe:

- **Ports serialize inside a run.** The port lock is owned by a PID, and every worker of one run is
  the same PID — `tryAcquire` hands a port back to its own owner, so the lock cannot keep two workers
  apart. The scheduler does: `nextRunnable` starts a queued script only when none of its declared
  ports (`portsOf`, the same 8xxx literals) is held by a running sibling, and skips ahead to one
  that is free. The five scripts on 8796 still run one after another, never into each other's bind.
  **So every port is a LITERAL**: `hiddenPortsOf` refuses a script that derives one (`PORT + 1`).
  `e2e-backlog-echo` booted hosts on 8812+1 and +2, the scheduler knew only 8812, and its retrying
  bind took 8813 in `e2e-restore`'s restart gap — restore's second host locked out, its requests
  answered by the wrong host ("recent list … got 0", 2 of 16 under load, 2026-10-16).
  Across RUNS the lock files work as before, and each script still takes them ascending, so two
  pools cannot deadlock either.
- Scripts that boot through `bootHost`/`freePort()` get an OS-assigned ephemeral port (49152+),
  outside the 8790–8960 range the literals live in.
- **Every per-user dir is per SCRIPT now**: config dir, `XDG_DATA_HOME` and `XDG_STATE_HOME` under
  the run's sandbox, named after the script. The config dir used to be one for the whole run — fine
  serially, one script's secrets and plugins in another's host in parallel.
- tmux was already per script (`TMUX_TMPDIR`, `lib-tmuxiso.mjs`); TMPDIR is the run's one
  `with-tmp.mjs` dir, inside which every script `mkdtemp`s its own names. The scripts that read
  `~/.claude/projects` build a scratch HOME of their own. A full run was checked for writes under
  the real `$HOME` outside the runner's own `~/.cache/<slug>/e2e-times.json`: none.
- **Output stays readable**: each script's stdout+stderr go into ONE buffer in arrival order and are
  printed whole, with the verdict, when it ends. The child's `exit` (not `close`) ends a script: a
  host spawned with inherited stdio holds the pipe until the reap kills it, so `close` would wait
  for the timeout.
- **Longest first.** `~/.cache/<slug>/e2e-times.json` keeps each script's last duration and the
  pool starts the slowest first (`intentnodrop` 140 s, `intent` 92 s, `settle` 88 s), so a long
  script never starts last with five idle workers. It only orders; `E2E_TIMES=0` turns it off.

**The serial list** (`SERIAL` in `run-e2e.mjs`) is for a script that cannot share the machine for a
reason its own source cannot fix without weakening an assertion; each entry carries its reason and
they run alone after the pool drains. **It is empty.** `e2e-restore` and `e2e-backlog-echo` were in it
for one day: they booted a second (and third) host and sent it a request after a fixed `sleep(900)`,
and beside five other boots that host had not bound yet — `ECONNREFUSED` in most parallel runs, a
pass every time alone. That is the race `bootWait` removed from 47 scripts, and its fix is in the
script (`waitForHost(port)`, landed for 33 scripts in `1a470120`), so they came back out. Nothing
has ever been in the list for a CONCURRENCY reason: no script failed on a port, a dir or a tmux
server another one held. And a flake is not a reason either: `e2e-search` ("a token only in the
turn's OUTPUT is found", one search after a fixed 1600 ms sleep for an async render) failed once in
six parallel runs — and twice in five runs ALONE, so the pool did not cause it and `SERIAL` would
not cure it; the fix is to poll that search to a deadline.

**A load throttle, for the same race arriving from outside.** One run was made while something
else drove the machine to a load average of 159: 14 scripts failed, every one on `ECONNREFUSED`
against a host booted with a fixed sleep. So the pool starts no NEW script while the 1-minute load
average is above twice the cores (`E2E_MAX_LOAD`, `0` = off) — one always keeps running, so it
degrades toward serial, never to a stop — and says so when it throttles and when it resumes.

**A failure says which kind it is, and why, at the bottom.** 2026-10-20: a push refused from the
phone showed e2e-halt and e2e-setup failing; both passed alone, and the phone's last-lines view held
neither script's FAIL line, only a 4 kB temp-dir tally. Three changes. (1) Up to three failed scripts
run once more ALONE after the pool, and the summary says "passes alone" (a timing window load
stretched) or "fails alone too" (`E2E_RETRY_ALONE=0` turns the re-run off). A pass alone first
still FAILED the run (e2e-search's was a real race in the test that load exposed); the same day the
owner made it a LOAD FLAKE that does not block — about ten pushes in five days had each been refused
by a different one — named in the summary and appended to `~/.cache/<slug>/e2e-flakes.jsonl` so it
is fixed later, not lost. Every script also runs with no locale, as the launchd service does: a phone
push runs in the service's env, and e2e-halt failed only there (tmux with no locale printed a
format's `\t` as `_`). Later that day: up to TEN failed scripts are re-run alone (was three — a run beside
another project's build failed four that each passed alone, and "more than three" read it as a
break), and only one FULL suite runs on this machine at a time (`run-e2e.mjs`, lock key `suite`
beside the port locks): a session's own full run had been doubling a push's load. The pre-push
hook itself (`~/.local-ci`) now runs one gate per code version — a push waiting on a run of the
same tree takes its verdict, pass or fail, and a push whose tip contains the commit being tested
supersedes that run (the old push aborts saying so; its commits go out with the new one). (2) The summary repeats each failure's FAIL lines with
the indented lines under them, so the cause sits in the last screen. (3) `with-tmp`'s leftover tally
names the six biggest kinds only. And the whole-script hang guard is `watchdog()` from
`scripts/lib-watchdog.mjs` with a 45 s floor, never an inline `setTimeout`: e2e-setup's 15 s one
fired on a run still passing every check, with eleven more scripts on the same 15 s
(`tools/e2ewatchdog.test.mjs`).

## The pre-push gate

The hook is local CI generated from `~/.local-ci/` (`prelude.sh` + `steps/usmc.steps`, concatenated
into `.git/hooks/pre-push` by `install.sh usmc`; shared with other repos, whose hooks call none of
the helpers below). What it does for this repo:

- **It tests the PUSHED commit, in a clean detached worktree under `/tmp`** with this clone's
  `node_modules` symlinked in (as `scripts/verify-rev.sh` does) — never the working tree. It used
  to run `npm run build` and `npm test` in `~/dev/usmc` itself, i.e. on whatever several sessions
  had half-edited at that moment, and it rebuilt `packages/web/dist` (the bundle phones pull over
  the air) from that tree. `GIT_DIR` & co. are unset first: from a linked worktree git exports an
  absolute one, and tests that `git init` a temp dir then write into the real repo.
- **A result cache keyed on the tree**: `sha256(git rev-parse <sha>^{tree}, the installed hook's
  own bytes, node -v, tmux -V, node_modules/.package-lock.json)`. The deps are the INSTALLED
  lockfile because the run borrows `node_modules`; the tree's lockfile is already in the tree hash;
  the hook's bytes cover the prelude and the steps. A green run appends its mode to
  `~/.local-ci/cache/usmc/pass/<key>`; a push whose tree already passed in a mode at least as strong
  (`full` ⊇ `fast` ⊇ `docs`) prints one line and skips. `LOCAL_CI_NOCACHE=1` runs anyway.
- **One suite per repo at a time**: a `flock` held by a small perl process that exits when the hook
  does (even on `kill -9`). A second push waits, then usually hits the cache the first one wrote.
- **Scoping**: the files `git diff --name-only <remote sha> <pushed sha>` lists. When every one is
  docs — `docs/**`, top-level `*.md`, `.claude/skills/**/*.md`, any `README*` — the run is
  `npm run build` (~15 s: `tools/hostrestpins.test.mjs` in `test:unit` imports `packages/host/dist`),
  lint, `test:unit` and `test:host`: no audit, no e2e. `test:host`
  stays because `packages/host/test/nodepin.test.mjs` reads README/CONTRIBUTING/SECURITY/
  `docs/guide.md`; `tools/claudemd.test.mjs` (CLAUDE.md and the skills) and the diagram/brand/
  release tests are in `test:unit`. Skills count as docs because nothing builds or ships them and
  every check over them is in `tools/`. Markdown that is NOT docs: `packages/*/templates/**`
  (scaffolded into new repos, asserted by host tests and e2e), `packages/web/public/**` (ships),
  `**/fixtures/**`, `deploy/**`. A new branch (no remote ref), a remote sha this clone does not
  have, or an empty diff gets the full run. The chosen mode and its reason are printed.
- **The checks between the build and e2e run AT ONCE** (`usmc_checks` → `step_group` in
  `prelude.sh`): lint, `test:unit`, `test:host`, audit and the VS Code leg. One after another they
  were ~107 s; together `test:host` (~67 s) is the whole wait. They call `test:unit:only` and
  `test:host:only` — the same tests without their own rebuild of shared/host, which the build step
  just did, and which two at once would race on one `dist/`. Each step's output goes to a file and
  prints as ONE block in `step()`'s exact format when it ends (finish order), because
  `packages/host/src/pushprogress.ts` reads `> name` … `ok (Ns)` line by line; every step runs to the
  end so one push reports every failure. Each job has its own process group, so Ctrl-C kills them
  all (a non-interactive shell's background jobs ignore SIGINT). A tree without the `:only` scripts
  (an old branch) gets the old serial run.
- **The VS Code extension leg** (`npm run test:vscode` → `scripts/vscode-check.mjs` →
  `packages/vscode`'s `check`: typecheck, tests, `.vsix` package check; ~8 s) runs on every
  non-docs push, beside `test:host`. The extension bundles host and web modules from SOURCE — one
  copy of the code, no shared npm package — so a change to `tokenscan`, `ctxlog/*`, a chart
  component or `tools/repohealth*` can break it while every root test is green: esbuild does not
  typecheck. It runs on every non-docs push rather than on a list of watched paths, because that
  list is exactly what would go stale. Its deps are its own lockfile (`npm ci --prefix
  packages/vscode`), symlinked into the worktree like the root's; when they are not installed the
  leg is skipped loudly, and their lockfile is in the cache key.
- `LOCAL_CI_FAST=1` (no e2e), `SKIP_LOCAL_CI=1` and `--no-verify` work as before.

## Guards before the push

The pre-push gate is the net, and it was the only place the cheap guards ran. On 2026-10-09 a
commit added a `web-work` skill bullet naming `gitFailPrompt.ts`: the skill went 407 chars over its
cap and the module was described nowhere in `docs/notes/`. Both are `tools/claudemd.test.mjs`
checks that take 0.3 s — and they were reported at a push three commits and one other session's
commit later, on a phone, as the tail of a 45-second log. The session that wrote the bullet had
long moved on. So every guard in `tools/*.test.mjs` now also runs at the EARLIEST moment its cost
and inputs allow, and `scripts/guards/guards.mjs` says which (`GUARDS`, one row per guard file;
`tools/guards.test.mjs` fails on a guard file with no row, so a new guard is a decision about
when it runs, never a default):

| tier | when | may | measured (16 cores) |
|---|---|---|---|
| `edit` | Claude `PostToolUse` on Edit/Write/MultiEdit (`.claude/settings.json` → `edit-hook.mjs`) | read files only — no npm deps, no build, no git | 0.2–0.4 s per file; the whole tier in parallel 0.4 s; an edit matching no guard 0.07 s |
| `commit` | git `pre-commit` (`precommit.mjs`, installed from `~/.local-ci/steps/usmc.pre-commit`) | + `typescript`/`eslint`, spawn node | every edit+commit guard 3.5 s; the replayed skill commit 0.6 s with the export |
| `push` | the pre-push gate only | needs a built `dist/` or git history | — (activitypins, plotpins, annotatorpins, webclientpins, hostrestpins, demo-scenario, repohealth*, brand, publictree) |

Each row lists the repo paths its guard reads, and only guards whose paths the edit (or the staged
change) touches run.

**A guard the allow-list keeps private is absent from the public tree, and that is fine.** `GUARDS`
lists every `tools/*.test.mjs`, including those `deploy/public-allowlist.txt` withholds
(`uicaptions`, `uipace`, `uiteaser`, `uiencode`, `uifilm`, `stublogo`). `tools/guards.test.mjs` tolerates a listed but
missing guard only when `classify()` (`scripts/release/public-lib.mjs`) says its path is not public —
the allow-list stays the one record of what is private, and a public guard that goes missing still
fails; "every guard on disk has a row" stays strict. `guardsFor(changed, tier, root)` drops a guard
whose file is not under `root`, so an edit in the public tree never hands `node --test` a missing file. A Bash-tool edit (sed, a heredoc) is not an Edit and is not seen at edit time;
the commit tier catches it.

**The working tree is shared, so a failure is blamed, not just reported.** A guard reads the whole
tree, so it also fails on another session's half-written file — and an agent told "your edit broke
this" would go and fix a file somebody else is in the middle of writing. The edit hook BLOCKS (exit
2, stderr to the agent) only when the failure names this edit (`blames` / `editTokens`): its path,
its file name, its skill (`web-work:`, how the claudemd guards list one), or a module the NEW text
names — which is how the bullet naming `gitFailPrompt.ts` owns "gitFailPrompt.ts is described
nowhere" though that failure never mentions SKILL.md. An offender list (`actual`, what the
deepEqual guards fail with) is matched on its own, because the prose around it names `CLAUDE.md`
in every message. Any other failure is said ONCE per session as context, explicitly as probably
someone else's. The pre-commit side needs no blame: it never reads the working tree. It exports the
index (`git checkout-index` honours the `GIT_INDEX_FILE` git sets for `commit -a` and partial
commits) to a temp dir, borrows `node_modules`, and strips every `GIT_*` variable so nothing inside
can reach the real repo — the same reason the pre-push gate unsets them.

**Room before the cap.** Editing `CLAUDE.md` or a capped skill within 5% of its cap says how much
room is left, once per session, with the caps read out of `claudemd.test.mjs` (one copy of each
number). The fix for the failure above landed `web-work` at exactly 28,000 of 28,000; the next
bullet fails, and now the agent adding it hears that before writing it rather than after.

**Output is context, so it is short.** A hook's words are re-sent on every later turn: a pass
prints nothing, a failure prints the test name and its message (capped), never a stack.
`WATERPLANE_EDIT_GUARDS=0` (read through `envName`, so a rebrand renames it) turns the edit tier off for a session; `--no-verify` / `SKIP_LOCAL_CI=1`
skip the commit tier. Two traps found building it: `node --test` with NO files discovers every test
under cwd (so an empty list returns before spawning), and a `node --test` started from inside a
test run inherits `NODE_TEST_CONTEXT` and streams to the parent runner instead of to the reporter
(`scripts/guards/reporter.mjs`, one JSON line per failure).

## The real-CLI smoke (`scripts/smoke-real-cli.mjs`)

Every e2e script drives `claude-stub-tui.mjs`, so a CLI release that moves a box, renames a flag
or reshapes its log passes `npm test` untouched — the stub is the one thing guaranteed not to have
changed. `smoke-real-cli.mjs` is the opposite test: the built daemon driving the REAL binary (real
HOME for the login; temp root, own state dir, private tmux socket dir) through one Haiku session —
boot under our flags, `cliVersion`, the trust box detected and tapped, a Bash permission box
(`mkdir`, because a read-only `echo` is approved without asking) detected and tapped, the tool
result read back off the transcript, hooks, the context ledger, the `clihealth` rollup. A step the
detector misses is stepped past with the keys a person would press, so one run names every broken
step. `--json <file>` writes the report. Opt-in, not in `run-e2e`: it spends a few cents and needs
a signed-in `claude`.

First run, 2026-10-07 on 2.1.293, found two regressions the stub suite could not: the Bash box's
command framed in `╌` rules that filled the question and lost "Do you want to proceed?" (fixed in
`prompt.ts`, pinned in `prompt.test.mjs`), and a trust box drawn with NO numbers and the cursor on
"No, exit" (fixed: `readNavBox`, answered by walking — `trustbox.test.mjs`, `e2e-trustbox.mjs`).
The smoke answers each box as the phone does: the option that says yes, by `promptChoice` on a
`nav` box (a digit there types nothing), its digit otherwise. The same box broke the usage probe
(`usage.ts`, `trustKeys`): its `1⏎` pressed "No, exit" and the gauge read `? / ? wk`.

`E2E_BOOT_MS` lengthens `waitForHost`'s 20 s (every `bootHost`): a host booted from a Windows
checkout inside WSL loads its modules over 9P and needs 28–44 s.

## Harvested screen fixtures (`clifixtures.ts`, `tools/harvestfixtures.mjs`)

The heuristics' host tests are fixture in, verdict out, and a fixture is only as good as the CLI
build that drew it. On 2026-10-19 `tools/screenfixtures.mjs` showed four of the ten health signals
with no real capture at all and the other six two patches behind the installed CLI, hand-captured
three days earlier — the reading was 0, and it will be 0 again after every release somebody does
not sit down and re-capture.

So the host captures as it goes. The first time a signal is seen to WORK on a CLI version, the
call site's `fixture` thunk (passed beside `good` — `noteHealth`, `noteFor`) is asked for its
input, and `clifixtures.ts`'s `FixtureShelf` keeps that one sample under
`<state>/clifixtures/<version>/<signal>.txt|json`: at most one per signal per version, the thunk
never asked once a file exists (a capture costs a screen or log read; it is paid per release, not
per observation), a failed or empty capture leaving the slot open for the next good.

What is kept is what may go into a PUBLIC repo, which is a higher bar than the health record's own
sample. A `line` signal keeps a GRID, because the readers work by row and column: rows the host
recognises as the CLI's chrome (dialog footers and key-hint rows, the constant `Type
something`/`Chat about this` options, the Submit/Next row, the meter row, a local command, the
version banner) stay verbatim under the health sample's redactions; every other row has each letter
masked to `x`/`X` and each digit to `0` (`maskRow`), so the layout survives and no word does. A
`shape` signal keeps a SKELETON (`skeletonOf`): keys and record/event/tool names, every value
replaced by its kind, an array by its distinct element shapes — `deliver.submit`'s is the
`UserPromptSubmit` hook that proved the turn, its prompt gone with every other value. Two signals
have a form of their own (`FIXTURE_FORMS`). `deliver.echo`'s evidence is the composer holding the
person's prompt: kept as the prompt and the screen the echo rule PROVED on, masked by the same
character-for-character rule so one is still found in the other, with paste chits protected as
spans (`chromeSpans`) because the composer wraps them across rows. `limit.reset`'s evidence is the
block notice itself, and a file carrying it in plain bytes is one `cat` away from false-positiving
the detector on a live screen — so the notice rows are kept verbatim and the whole file ROT13'd;
`decodeFixture` undoes it for the readers and the leak check.

The real-CLI smoke is the harvest's cheap source: it drives the trust box, a Bash permission box, a
multi-select `AskUserQuestion` (ticked by digit, submitted by `promptSubmit`) and `/context`, which
yields every signal but two. `context.meter` needs the CLI's gated meter row, drawn only near the
window's end, and `limit.reset` a real wall — both are left to the live host. Its first runs found
three things the stub suite could not, all on 2.1.304: submitting a single-question checkbox opens
a second box (`Review your answers` — 1. Submit answers / 2. Cancel); the `AskUserQuestion` call
reaches the log only once answered (two runs in three), so the enrichment now also reads the
`PreToolUse` hook matched to that tool — and `mergeBox` had been dropping a description that
arrived a pass late; and the CLI slugs its log folder off the cwd's REALPATH, which
`claudeProjectDir` now falls back to (a repo under `/tmp` or `/var` read no log at all).

`tools/harvestfixtures.mjs` lists the captures and, with `--write`, copies each new one to
`packages/host/test/fixtures/screens/harvest-<signal>-<version>.<ext>` and appends its
`signals.json` entry with `cli` (the capture dir's version) and `role` from running the signal's
reader over it (`packages/host/test/signalreaders.mjs` — the same table `harvested.test.mjs` holds
each entry to). A sample that still carries a home path, an address or an opaque run is refused.
A GOOD capture that reads as a non-match is filed as a guard and SAID: it means the cut or the mask
lost what the reader needs. Nothing stages or commits; a person reads the diff. `--dir` takes
another capture dir — `smoke-real-cli.mjs`'s state dir is one.

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
`hook`/`limit`/`limitqueue`/`resurrect`/`resume`/`restore`/`tmux`/`livereclaim` session lifecycle ·
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
`usagesources` one usage reading per source (claude first, Copilot's quota off a stub gh, a plugin's `api.usageProbe`): null = absent, a throw keeps the last reading until its reset, a switched-off plugin loses its source, `/api/usagelog/:source` ·
`screenlog` the locally rebuilt terminal scrollback (the pan that needs no socket) ·
`gallery` which cached file listing may answer which question with the link down ·
`tree` browsing the worktree and the rules a file SAVE obeys (base-sha or nothing) ·
`archive` every conversation on disk, and the reopen stack that survives a restart ·
`forkfrom` a conversation cut at a TURN: the prefix written under a new id and RESUMED (never
`--fork-session` on top, which opens a third conversation), the source log untouched, a refusal that
is a refusal rather than a session on the whole conversation, and a replayed ackId spawning nothing ·
`assess` (in flight) the repo assessment: a proposal is a diff, and nothing applies itself ·
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

`tools/importcycles.test.mjs` holds `packages/{shared,host,web}/src` to ZERO runtime import cycles
(Tarjan's SCCs over the TypeScript parser's imports; `import type`, `export type` and all-`type`
brace lists are erased and skipped, web's `@waterplane/sdk`/`kit` aliases resolved). In an ESM ring the
module evaluated first depends on which file was ENTERED first, so a top-level read of an import — a
cache, a store, a table built at load — works from `main` and is `undefined` from a test that enters
mid-ring. Six rings were cut when it landed: the ledger readers (`agents.ts` reads `claudeconfig.ts`,
`ctxlog/ctxupdate.ts` reads `transcript/transcriptlog.ts`, not the barrel), the HTTP client ↔ link
store (`webapiFetch.ts` reads `link/linkOps.ts`), the link store's slices (emit/invalidate in the leaf
`link/linkBus.ts`, the snapshot builder handed in), the activity selector ↔ row builders
(`activity/activityBucket.ts`), `Repo readings`' two regions (the weight-stack keys in
`repoHealthPlot.ts`) and `SetupSheet` ↔ the registry reader (`setupRemedy.ts`'s `bindSetupRows`,
`sdk/ledgers.ts`'s shape). A new ring is cut, never exempted: a leaf both sides import, the slice
instead of its barrel, or a dependency handed in.

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
19 skills was over the `maxSkills: 12` then in `shared/contextweight.ts`, so this repo's own
context-weight row read heavy (the default is 30 since 2026-10-17). That is the row doing its job, and the answer is a per-repo
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
`ctxlog.ts` at 6.2k, `smartpick.ts` (since removed) at 5.0k, `SendSheet.tsx` at 3.7k. That is a real backlog of
entries that have started explaining themselves, and the fix is to move the story to these notes,
not to add the headings and then argue for exemptions. (An earlier draft of this paragraph said 32
and 62k: it had counted only the two split skills, and counted them before the fold. Regenerate the
number with `entries()`'s own filter before quoting it.)

## The traffic archive (`scripts/traffic-archive.mjs`)

GitHub keeps clones and views for 14 days and release downloads only as a running total, and
plugins mean the fork count undersells adoption anyway. `node scripts/traffic-archive.mjs` appends
`gh api repos/waterplane-dev/waterplane/traffic/{clones,views}` and every release asset's
`download_count` to `<state dir>/traffic/github.jsonl` (default
`~/.local/state/waterplane/traffic/github.jsonl`) — outside the repo, so it is never committed or
mirrored. One row per repo, kind and UTC day (per asset for downloads); a traffic day is written
only once it is over, and a day already in the file is never rewritten, so a re-run adds nothing.
`--repo o/r` (repeatable) archives other repos, `--out` moves the file. Pinned by
`tools/trafficarchive.test.mjs`.

**Weekly, by launchd, never by GitHub Actions** (off repo-wide): `node scripts/traffic-archive.mjs
--install-launchd` writes `~/Library/LaunchAgents/dev.waterplane.traffic-archive.plist` (Mondays
10:00, `StartCalendarInterval` so a sleeping Mac runs it after wake, with `gh`'s directory on an
explicit `PATH`) and bootstraps it; logs go to `~/Library/Logs/waterplane/`. It runs this checkout's
copy of the script, so moving the checkout means installing again. Weekly sits well inside the
14 days, so a missed week or two loses nothing. Needs `gh` signed in with push access: the traffic
API answers nobody else.

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
npm run release:public -- --tag v0.2.0 --to ../public-clone --media-to ../media-clone --accept reviewed.txt --commit
git -C ../media-clone push origin main     # by hand, FIRST when the run hosted videos
git -C ../public-clone push origin main    # by hand
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

**Rewritten on the way out** (`public-lib.mjs` "rewriting", before the scans, so they judge what is
published; the report has a section for it). Two things the private tree needs and the public one
must not carry:

- **Claude session ids.** The requirements record `asked: <prompt ref>, <date> (session <id>)` so the
  owner can find the prompt and the conversation behind an item; `docs/notes` cites a session as
  evidence now and then. Nobody else can open either, and together they are a log of how the owner
  works, so `stripSessionIds` drops them from every published `.md` (an `asked:` line left empty goes
  too). The private tree keeps them. Anything in a new phrasing is a `session-id` scan hit, and a
  `claude.ai/code/session_…` link in any file is a `session-url` hit.
- **Videos.** The README and guide link a full walkthrough video next to each gif, for pause and seek.
  The mp4s stay out of the public repo (every re-recording would sit in every clone's history for
  ever) and are served from their own repo instead, named in `deploy/public-media.json` (`repo`,
  `urlBase`, `hosted` globs; `{org}` is `BRAND.githubOrg`). Each linked file is renamed
  `<stem>-<sha256:10>.<ext>`, copied into a clone of that repo (`--media-to`, committed with
  `--commit`, never deleted from, with a `.nojekyll`), and every `](…)` to it in published markdown
  is re-pointed at `urlBase/<name>`. A re-recording is a new name, so an older release's README keeps
  the bytes it was written against. **Why not release assets:** GitHub serves those as
  `content-disposition: attachment`, so a click downloads the file instead of playing it. `urlBase`
  is GitHub Pages on the media repo (plays in the browser, with seek); `https://cdn.jsdelivr.net/gh/
  <org>/media@main` serves the same files if Pages is ever unavailable, a one-line change. `--write`
  with a hosted link and no `--media-to` stops before anything is written. `release:publish` takes
  `--media-clone`, checks its origin in preflight, and pushes it before the public repo.

## Demo mode and the fake host

Demo mode (`?demo=<scenario>`, or the "Try the demo" button) runs the phone app against `DemoHost`
(`packages/web/src/demo/host/`), an in-memory fake of the desktop. One fake serves four readers: a
Play reviewer who will not install a daemon, Tailscale and `claude`; a first-time visitor; the docs
gifs; and the tests, for which it is the only host double. The rules it keeps:

- **No DOM, no storage, no timers, no `Date.now()`** in `demo/host/` (eslint holds it), so it runs
  in node without a build and the clock is injected.
- **Exhaustive by type.** `HANDLERS satisfies HandlerTable`, a mapped type over
  `ClientMessage["t"]`: a new client message fails `tsc` until the fake answers it.
  `packages/host/test/demoparity.test.mjs` pins the host side; `demo/contract.test.mjs` pins the
  other direction, with reasoned exceptions in `contract-accept.json`.
- **A refusal is a wire verdict** (`demo/host/verdict.ts`): every message whose sender waits gets its
  receipt with `ok:false` and a sentence, never a toast, because the queue retries anything else with
  the same ackId for ever. Never `retryable`: "not in the demo" does not change with time.
- **Zero requests off the bundle's origin.** `isDemo()` is what is RUNNING (only `demo/transport.ts`
  turns it on), not what was asked, so every guard (push, OTA, LAN probes, native workers) follows
  the transport. `?demo=` writes nothing, so a journey run on a real host's origin cannot leave it
  stuck in the demo; the button's choice is stored per device so a cold APK start returns to it.
- **A plugin brings its own demo data** through the SDK seam `registerDemoPlugin(id, { calls, pushes })`
  (`packages/web/src/sdk`): `pluginClient(id).call` consults it when `isDemo()`, and `demo/transport.ts`
  replays the pushes of every registered plugin when the fake socket opens. No per-plugin code lives in
  `demo/`; a build without the plugin registers nothing and replays nothing. The fixture and its pictures
  live in the extension's own folder.
- **Scenarios are recorded from the real host driving the stub TUI** (`WATERPLANE_WIRE_RECORD`,
  `scripts/e2e-demorecord.mjs`), never from a real `claude`, whose output drifts per version and
  carries real paths; the scrub fails closed.

## The demo terminal is drawn like the real CLI

The docs gifs film the in-app demo, whose "PTY" is a string the fake host writes. Scenarios used to
write that string as the screen itself — `> prompt`, `● text`, 80-column lines — and on a phone it
read as a sketch of Claude Code: lines broken mid-word by xterm, no input box, the wrong glyphs. The
owner's verdict on the first README gif (2026-10-06): the real CLI looks different.

`packages/web/src/demo/host/cli.ts` is now the one place that turns the scenarios' short source form
into what a real `claude` v2.1 prints, measured against one in tmux: a prompt is `❯ text` on a grey
band, an answer `⏺ text`, a tool a green `⏺ Tool(arg)` over its dim `⎿` result, blocks set off by a
blank line, text wrapped at words to the grid with a hanging indent. Under the transcript sits the
CLI's own input box (rule, `❯ `, rule, `? for shortcuts`) and, while a turn runs, the spinner line
above it. The box is redrawn the way Ink redraws its live region: cursor up to its first row, erase
down, the new transcript lines, the box again. The source stays in `DemoScreen.log` so a resize
repaints at the new width — the CLI lays its transcript out to the PTY's width, and so does the demo.

Scenarios keep writing the source form on purpose: one renderer means the next CLI restyle is one
file, not six scenarios. The transcript reader's live turn splits on `❯ ` lines but not on a choice
box's selected `❯ 1.` row, which uses the same glyph.

Films also seed the console one zoom step down (`scripts/ui/lib.mjs`, only under `--media`) and run
at a Pixel 8 Pro's 448 x 998 viewport — the APK film's emulators are Pixel 8 Pro AVDs too — so the
grid is ~60 columns rather than ~45 columns of oversized text.

## Docs gifs are sized in HTML

R-demo-028. Markdown cannot say how wide to show a picture, and a 540 x 1280 phone film at its
natural size is taller than a laptop screen — the owner could not see one whole. So the README and
the guide embed each film as `<a href="x.mp4"><img src="x.gif" width="270" alt="…"></a>`: 270 is
half its pixels, so it stays sharp on a 2x display (the 768-wide APK film gets 490). The tap still
opens the whole video, on GitHub and in the phone's reader.

That one HTML shape is a contract with two readers. The phone's markdown reader finds it with
`fileRefs.ts` `linkedImages` (which also still reads the older `[![alt](x.gif)](x.mp4)` spelling)
and draws it with `Markdown.tsx` `inlineDoc`, ignoring the width — the phone draws the picture its
own size. The public release's link checker and hosted-link rewriter (`scripts/release/public-lib.mjs`)
read the `href`/`src` inside `<a>`/`<img>` tags. Any other HTML in those lines, `<sub>` included, the
phone prints as text.

## Moved out of CLAUDE.md (2026-10-17)

_Verbatim from CLAUDE.md as of 2026-10-17; CLAUDE.md is the rule — where this text disagrees, CLAUDE.md wins._

### Token discipline — the measurement behind the rules

Measured on this desktop: 124 conversations out of 8,968 in a fortnight grew past 200k of context,
and those 124 were **76% of every token spent**. Turns at index 80+ were 54% of the total at an
average of 312k per turn, and a 1M window never compacts itself.

### `sessions/record.ts` `nameTab` — the automatic spender, in full

`sessions/record.ts`'s tab-name call
  (`nameTab`, once per session, off the first prompt only) runs on `SUMMARY_MODEL` with
  `--setting-sources user --tools ""` and its own system prompt (83k tokens → 1.9k), and its result
  is persisted so a restart re-derives nothing. Any new
  unattended `claude -p` starts from those flags and justifies every one it drops.

## Moved out of skill `testing` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

### Host heuristics tests — the file-by-file enumeration

**`packages/host/test/*.test.mjs`** (`npm run test:host`, over `host/dist`) is the same idea for the
daemon's **regex heuristics** — `prompt` (the choice-box detector), `limit` (banner + reset parsing), `usage` (the `/usage` screen's two windows, resets included),
`context` (the meter), `slash` (`isLocalCommand`), `origin` (the browser half of the security
boundary), `login` (the sign-in link, rejoined off a wrapped screen), `ptycap` (what a failed pty spawn may
SAY), `headlesslimit` (the same banner read off a `claude -p` ENVELOPE), the two decision cores lifted
out of `SessionManager` (`sessionSearch`), `answergate` (every gate refusal in words, and the tap's keystrokes when accepted), `plugins` (every broken plugin LISTED with its reason, settings refused whole), `decisionlog` (the one-time `oracle-log.json` migration), `intentsched` (what a schedule may CLAIM
about itself — armed vs spent, a hand run that must not consume it — and where automatic work with
no session goes, both over a real store with fake deps), `convfork` (the cut-and-rewrite as pure fs:
fixture in, prefix out, source byte-identical afterwards) and `lastturn` (what a conversation log may be asked about its last real TURN, against bookkeeping rows that move the file's mtime without being one), `ptyleak` (an ended PTY leaves no ptmx master or slave fd in this process — over node-pty and `ownPtys()`, SKIPPING in words when the table is already full), `sweepstores` (which per-session files a boot sweep may delete: never a live id, never before the age gate, never a traversal-shaped name), `deliversubmit` (what a delivery is
entitled to SAY about the submit proof) and `deliverecho` (what it may DO when it thinks the screen
never showed the text — never an Esc into a live turn, never a bare Return at a box it only
believes is full — and what it may RECORD: one health observation per delivery, counted not
last-read). Fixture in, verdict out: when upstream changes its wording,
"this line no longer matches" is the sentence worth having, where e2e can only report "the session
never published a prompt".

### The e2e suite — the name list the skill used to carry

The suite, so a name here is a name on disk: `ack` `agentintent` `answer` `api` `archive` `askbox` `askprose` `attach`
`autopull` `backlog` `backlog-echo` `backlog-keepopen` `backlog-prompt` `backlog-slots` `backlog-wait` `budget` `build` `capture` `checkbox`
`buildparams` `clihealth` `ctxgraph` `echo-stream` `docs` `fanout` `fork` `forkfrom` `gallery` `git` `hints` `hook` `hosturl` `images`
`intent` `intentnodrop` `launch` `launchwait` `livereclaim` `limit` `limitbusy` `limitparallel` `limitrepaint` `limitqueue` `limitreset` `limitstuck`
`login` `manualfire` `netfuse` `netstats` `notifyprefs` `offlinelists` `onesession` `opqueue`
`origin` `outbox` `outboxbadge` `pastechit` `permmode` `pin` `plugin` `prompt` `promptlive` `ptyleak` `queue` `restore`
`resume` `resurrect` `resurrect-item` `rootguard` `scaffold` `schedule` `screenlog` `scrollcomposer` `search` `secret` `sent`
`settings` `settle` `settlesweep` `setup` `setupwatch` `statedir` `sidecar` `slashlocal` `smoke` `speedtest` `star` `stophook`
`termqueries` `tokenstats` `trustbox`
`startprompt` `submit` `thumbs` `tier12` `tmux` `transcript` `tree` `uiusage` `webbundle` `assess`
(opencode's `backend` `ocserve` `ocservetmux` `tmuxenv`: `packages/extensions/opencode/e2e/`).

## Moved out of skill `docs-media` (2026-10-17)

_Verbatim from the skill as of 2026-10-17; the skill is the rule — where this text disagrees, the skill wins._

### Filmed sharp, encoded once (R-demo-022)

- **Filmed sharp, encoded once** (R-demo-022): a journey is filmed by CDP screencast at 2x
  (896 x 1996 PNG frames — a Pixel 8 Pro's 448 x 998 viewport), never Playwright's `recordVideo` (VP8 ~1 Mbit — the old blur).
  `scripts/ui/encode.mjs`: frames → lossless master → captioned master → gif AND mp4 (H.264 crf 18,
  full size, uncapped). No blank frames: the flat ones a film opens on are dropped, a flat one after
  its first picture is a cut that landed on nothing (a WARNING naming its time until
  `STRICT.flatFrames`, then a failed run), and `loopFilm` refuses a stretch that opens on one.
  Around a reload or a `goto`, `await j.holdPaint(go, drawn)` (lib.mjs) keeps the screen that was up until the new document has drawn — not a render-blocking init script: Chromium paints past it (measured).

### The gif is a short loop, the mp4 the whole film (R-demo-025)

- **The gif is a short loop, the mp4 the whole film** (R-demo-025): a gif has no controls, so a
  minute-long one is watched from wherever the viewer lands. A journey's `export const teaser`
  (`{ from, to }` caption prefixes, or a list joined in order — `first-look` loops exactly its seven beats,
  R-demo-033) picks the stretch; `loopFilm` adds the orange progress bar along the bottom and holds the
  last picture 1.5 s. A reworded caption FAILS the media run (`teaserWindows`), never teases the wrong
  bit; so does a caption whose screen is not in the stretch (WARNING until `STRICT.teaserReferents`). Docs embed `<a href="x.mp4"><img src="x.gif" width="270" alt="…"></a>` (APK film: 490) + an
  italic line linking the video; the alt says what the LOOP shows. Only that HTML shape: the phone
  (`linkedImages`) and the release (`public-lib.mjs`) read no other, and print `<sub>` as text.
  [Why the width](testing-and-ops.md#docs-gifs-are-sized-in-html).

### Paced after the run (R-demo-023)

- **Paced after the run, by one rule** (R-demo-023, `scripts/ui/pace.mjs`): motion at real speed, a
  settled picture held 1.2–2.5 s, a caption's last picture held for its reading time (1.5 s + 15
  chars/s, at most 4 s: `PACE.readMax`), no lead: a caption snaps to the first visible change at or after its mark, so it arrives
  WITH the screen it describes (`snapMarks`; none before the next caption = it stays put). A blinking
  cursor or spinner is not a change (thumbnail diff in `encode.mjs`). So a journey's `beat()`s only need to let the app settle — never tune pace
  there; tune `PACE`. Longer caption = longer screen, so keep captions short.
