---
name: testing
description: waterplane's three test layers and how to add to them: node --test over packages/shared and packages/web (pure logic, no host), packages/host/test (the regex heuristics, no daemon), and the scripts/e2e-*.mjs suite that needs a real host. Load BEFORE writing or changing a test, and when deciding which layer a new rule belongs in. Includes what every e2e script must pin (WATERPLANE_PREFLIGHT=0, a private tmux socket dir via lib-tmuxiso) and the stub TUI modes.
---

# waterplane testing


Three layers. **`packages/shared/test/*.test.mjs`** (`npm run test:unit`, `node --test` over
`shared/dist`) covers the pure logic — queue, schedule, gallery, attach, launch, screenlog, promptid,
hosturl, collage, budget, urls, intent, clihealth, assess — in ~90 ms with no host and no build of
one, so a rule can be pinned before there is anything to boot. The same command also runs
**`packages/web/src/**/*.test.mjs`** (recursive) over the TypeScript itself (node's type stripping)
for the web's own pure slices — `activityRows`, `assessRows`, `contextPlot`, `downloadState`,
`ptyTail`, `fmtMeter`, `theme`, …; `sdk/sdk.test.mjs` (stores, `mapWith`, `cachedList`,
`repoRunStore`); `core/core.test.mjs` (the feature runner over a fake registry: isolation, the
once-per-key failure toast); `core/queue/queue.test.mjs` (where an ackId may be minted — every `newAckId` identifier, every
`mintAckId(`, every `queueOp` handed an `ackId` — counted per file, and `writeOutbox` as the store's
one writer) with the queue's pure half in `core/queue/logic.test.mjs`;
`core/compose/compose.test.mjs` (every `setCompose("")` in the tree, each after the accept that took
the words, and one textarea); `core/term/tail.test.mjs` (the PTY feed's pure half: frames, the
cold-start seed, the offline sweep's order);
`core/prefs.test.mjs` (the device-preference store: a default is never written back, the ref moves
with the write, an adopted key re-reads only the prefs naming it, and every pref reaching a synced
key lists it); `core/launcher/model.test.mjs` (the
launcher's order, cuts and every count a control carries);
and each feature's own `features/<x>/logic.test.mjs` — which have no
DOM in them and therefore need no browser. A test imports siblings WITH `.ts`. And
**`tools/*.test.mjs`**, which is the REPO rather than the code: `claudemd` holds this file to its
budget, its one-line-per-subsystem rule and its write-the-note-first rule (see the top);
`webshape` holds `App.tsx`'s ratchet and every feature folder's shape and layout;
`featureboundary` and `nosilentsend` pin the two lint rules the feature split leans on, both ways.

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

The `scripts/e2e-*.mjs` scripts are the only tests that need a **host**.
`run-e2e.mjs` DISCOVERS them, so a new script needs no registration (a hand-maintained list once
drifted until two thirds never ran).

**Every host-spawning e2e script MUST pin `WATERPLANE_PREFLIGHT: "0"` and import `./lib-tmuxiso.mjs`**
(or boot through `bootHost`, which does both) — else the boot doctor prints into output the scripts
assert on, and stubs leak onto the shared tmux server. **Sessions always run inside tmux** (there is
no direct-PTY mode to pin any more), so isolation is by socket DIRECTORY: `lib-tmuxiso.mjs` sets a
private `TMUX_TMPDIR`, deletes `TMUX`, and kills every server in that dir on exit, failure or
ctrl-C; `run-e2e.mjs` hands each script its own dir and kills what is in it afterwards (a tmux server
daemonizes out of the process group, so the group kill never reaches it). A host on a temp root
also derives its own `-L` name (`sessions/knobs.ts`), so two hosts in one script do not share a
server's environment. A script that builds a MINIMAL env for its host must carry `TMUX_TMPDIR`
across (`e2e-tmux.mjs`, `e2e-tmuxenv.mjs`). Host tests that start sessions import the same module.
`e2e-tmuxenv.mjs` is the only test of what the tmux PANE's environment actually contains: a backend's
`spawnEnv` (opencode's auto-update guard) is exactly what a `-L` server that ALREADY EXISTS drops, so
it names its own server and starts it itself from an environment with the guard unset, because a
fresh-server run passes while the bug is still there. `e2e-tmux.mjs` and `e2e-ocservetmux.mjs` name
their OWN `-L` server too: a pane outliving the daemon is their subject.
Stub TUI modes (`scripts/claude-stub-tui.mjs`, `STUB_MODE`, default `repaint`): `repaint` (echo far
from the end of the raw bytes) / `blind` (input accepted, never displayed) / `menu` (a slash
command's completion menu under the composer, Return opening a VIEW and starting no turn) / `paste`
(a multi-line write collapsed to `[Pasted text #1 +N lines]`, head nowhere on screen) / `scroll`
(a real `❯`-plus-rules composer drawing only its last three WRAPPED rows — the box is a
viewport sized off the terminal, so a long prompt shows its tail and the head the probe is cut from
is off the top) / `stream`
(a real `❯`-plus-rules composer with a duplicated footer and streaming turn output BELOW it — the
torn render the echo must place by its BOX, never by distance from the bottom) / `checkbox` (a
multi-select box where a digit toggles without moving the cursor and Return submits only on the
Submit row) / `unreadable` (a dialog the detector genuinely cannot read — real footer, options
numbered `1)`, redaction bait in the rows) / `prose` (text that merely SAYS a footer's words — with
`unreadable`, the two halves `clihealth` needs to tell a blind detector from a working one) /
`login` (a 300-character OAuth URL hard-wrapped across six grid rows, plus the code input) /
`goal` (a keep-going loop: `UserPromptSubmit`, then a `Stop` the hook REFUSES while the working line
keeps painting, and the real `Stop` only when the spinner stops — `STUB_GOAL_MS`) / `deaf`
(text echoes, Return SWALLOWED) / `ext` (another CLI's geometry from OUTSIDE the stub:
`STUB_MODE_MODULE=<path>` exports `paint({buf, blind})` and optionally `submit(prompt)` — a backend
extension's own stub draws its screen shape against this file's input handling, so the no-box
delivery path is exercised against a second shape; `STUB_VARIANT=blind|deaf` re-uses those two
failures against it) / `logo`
(the apk-install gif's turn: reads a marked image's circle off the annotator note and really edits the
sample app in the cwd — `scripts/media/tide-tables.mjs`, pinned by `tools/stublogo.test.mjs`). `STUB_HOOKS=1` makes the session count as `hooked`;
`STUB_USAGE=<sess>,<week>` renders a `/usage` screen the budget scraper can parse.
**A script whose subject is an unattended `claude -p` writes its own stub**, because
`claude-stub.sh` `exec`s a shell and cannot answer one. The pattern is `e2e-assess.mjs`'s: a node
script GENERATED by the script itself, spawned as `claude` through `WATERPLANE_CLAUDE_BIN`, reading its
mode from a FILE on every invocation so one booted host can be driven through every answer — and
answering on stdout with the real `--output-format json` envelope (`result`, plus `usage` /
`total_cost_usd` where the caller reads them). `e2e-smartpick.mjs` needs BOTH halves at once (its
fired items run in a terminal, its grooming pass does not), so its stub is a bash dispatcher that
`exec`s the node answerer when it sees `-p` and `bash --norc` otherwise; it also LOGS each
invocation, which is how "an un-ticked repo spends nothing" is a counted number — and why the count
filters on `--thinking disabled`, since a fired item's own `summarize()` is a `claude -p` in the
same worktree.

The capture suite has its own stub instead: `scripts/capture-stub.mjs` is a fake `ciqkit` — argv and,
mainly, its EXIT CODES (0 captured / 1 failed / **3 captured but OCR contradicted the anchor**, the
downgrade nothing else can produce). `WATERPLANE_CAPTURE_STUB_EXIT3` / `_FAIL` / `_SCORE` each take a
number-or-flag PATH rather than a fixed value, because a spawned daemon's env cannot be changed and
one script needs both outcomes; `shot-score` answers only about a frame REALLY at the path it is
handed, so asking it about a scratch dir the run already emptied fails the suite instead of
answering `n/a` for ever — which is indistinguishable from an honest "nobody measured".

What each pins, in full: [testing-and-ops.md](docs/notes/testing-and-ops.md), whose
[rough map](docs/notes/testing-and-ops.md#the-rough-map) is the one-line-per-script index this file
used to carry, and where the three it never described (`intent`, `offlinelists`, `settlesweep`) now
are. The suite, so a name here is a name on disk: `ack` `agentintent` `answer` `api` `archive` `askbox` `askprose` `attach`
`autopull` `backend` `backlog` `backlog-echo` `backlog-keepopen` `backlog-prompt` `backlog-slots` `backlog-wait` `budget` `build` `capture` `checkbox`
`buildparams` `clihealth` `ctxgraph` `echo-stream` `docs` `fanout` `fork` `forkfrom` `gallery` `git` `hints` `hook` `hosturl` `images`
`intent` `intentnodrop` `launch` `launchwait` `limit` `limitbusy` `limitparallel` `limitrepaint` `limitqueue` `limitreset` `limitstuck`
`login` `manualfire` `netfuse` `netstats` `notifyprefs` `offlinelists` `onesession` `opqueue`
`origin` `outbox` `outboxbadge` `pastechit` `pin` `plugin` `prompt` `promptlive` `ptyleak` `queue` `restore`
`resume` `resurrect` `resurrect-item` `rootguard` `scaffold` `schedule` `screenlog` `scrollcomposer` `search` `secret` `sent`
`settings` `settle` `settlesweep` `setup` `setupwatch` `statedir` `sidecar` `slashlocal` `smartpick` `smoke` `speedtest` `star` `stophook`
`termqueries` `tmuxenv` `tokenstats`
`startprompt` `submit` `thumbs` `tier12` `tmux` `transcript` `tree` `uiusage` `webbundle`
(`assess` is in flight).
