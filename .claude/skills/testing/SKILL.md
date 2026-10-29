---
name: testing
description: waterplane's test layers and how to add to them: node --test over packages/shared, packages/web, packages/extensions/*/web and tools/ (pure logic and repo shape, no host), packages/host/test (the regex heuristics, no daemon), the scripts/e2e-*.mjs suite that needs a real host, plus test:contract, test:ui (Playwright journeys) and test:vscode. Load BEFORE writing or changing a test, deciding which layer a new rule belongs in, or adding a tools/*.test.mjs guard (it needs a tier in scripts/guards/guards.mjs); includes what every e2e script must pin and the stub TUI modes.
---

# waterplane testing

Layers, cheapest first. Pin a rule in the cheapest layer that can fail on it.

1. **`npm run test:unit`** — `node --test` over `packages/shared/test/*.test.mjs` (on `shared/dist`),
   `packages/web/src/**/*.test.mjs` (the TypeScript itself via node's type stripping — a test imports
   siblings WITH `.ts`), `packages/extensions/*/web/**/*.test.mjs`, `scripts/release/*.test.mjs`,
   `packages/plugin-testkit/test/*.test.mjs` and **`tools/*.test.mjs`**. No host, no DOM, no browser: a rule can be pinned before there is anything to
   boot. Web examples: `sdk/sdk.test.mjs`, `core/core.test.mjs`, `core/queue/queue.test.mjs` (where an
   ackId may be minted — counted per file — and `writeOutbox` as the store's one writer),
   `core/compose/compose.test.mjs`, `core/prefs.test.mjs`, `core/launcher/model.test.mjs`, and each
   feature's `features/<x>/logic.test.mjs`. `tools/*.test.mjs` is the REPO rather than the code:
   `claudemd` (CLAUDE.md's budget, the skill and router rules, reasoning-in-docs), `webshape`/`hostshape` (ratchets and
   layout), `featureboundary`/`nosilentsend` (the two lint rules, both ways), `guards`.
2. **`npm run test:host`** — `packages/host/test/*.test.mjs` (+ `packages/extensions/*/test/*.test.mjs`)
   over `host/dist`, through `scripts/run-node-tests.mjs` (re-runs up to 5 failing files alone; a
   pass-alone is logged as a load flake; `TEST_RETRY_ALONE=0` turns that off): the daemon's **regex heuristics** and pure decision cores, no daemon. **Fixture in,
   verdict out**: when upstream changes its wording, "this line no longer matches" is the sentence
   worth having, where e2e can only report "the session never published a prompt". Examples: `prompt`
   (choice-box detector), `limit`, `usage`, `context`, `login`, `origin` (the browser half of the
   security boundary), `answergate`, `convfork`, `ptyleak`, `deliversubmit`/`deliverecho`. The full
   file-by-file list: [testing-and-ops.md](../../../docs/notes/testing-and-ops.md#moved-out-of-skill-testing-2026-10-17).
3. **`node scripts/run-e2e.mjs [filter]`** — `scripts/e2e-*.mjs`, the only layer that boots a real
   **host** (in-repo extensions' live in `packages/extensions/<id>/e2e/`). It DISCOVERS scripts, so a new one
   needs no registration (a hand-kept list once drifted until two thirds never ran) and
   `scripts/e2e-*.mjs` plus `packages/extensions/*/e2e/e2e-*.mjs` is the list; what each pins is the [rough map](../../../docs/notes/testing-and-ops.md#the-rough-map).
4. Beside them: **`npm run test:contract`** (`scripts/run-contract.mjs`, checks in `scripts/contract/`:
   the same protocol checks against the real host and the demo's fake, not yet in `npm test`),
   **`npm run test:ui`** (`scripts/ui/run.mjs`: Playwright journeys with aria snapshots, scratch web build,
   never `packages/web/dist`; the `journey-fault-*` ones are fault tests, not docs gifs),
   **`npm run test:vscode`**, and **`scripts/smoke-real-cli.mjs`** (opt-in, spends cents: the daemon
   against the REAL `claude`, since every e2e runs the stub). `npm test` = lint, `test:unit`, `test:host`,
   `run-e2e.mjs`. `scripts/with-tmp.mjs` + `lib-testtmp.mjs` wrap every unit/host run in a private tmp dir.

`run-e2e.mjs` runs scripts in a POOL (`--jobs N` / `E2E_JOBS`, default 60% of cores capped at 10;
`--jobs 1` streams live): **a new script must survive running beside others**. A failed script is
re-run alone (up to 10 per run, `E2E_RETRY_ALONE=0` off); a pass-alone is reported as LOAD FLAKE,
logged to `e2e-flakes.jsonl`, and does not fail the run — **but a load flake is a bug to fix, not a
pass** (`npm run flakes` lists the open ones; the pre-push gate prints them). A full unfiltered run
waits for any other on the machine, and `LANG`/`LC_ALL`/`LC_CTYPE` are stripped from each script's
env. **Every whole-script watchdog goes through `watchdog()` in `scripts/lib-watchdog.mjs`** (45 s
floor; `tools/e2ewatchdog.test.mjs` refuses an inline one). Its fixed 8xxx ports are
read from its source and two scripts sharing one never overlap, but anything it writes must be under its
own `mkdtemp`, and a host it boots must be WAITED for (`waitForHost`/`bootWait`), never slept for: a fixed
`sleep(900)` before the first request was the one failure the parallel runs found. A script that truly
cannot share the machine goes in `SERIAL` in `run-e2e.mjs` with its reason. A new `tools/*.test.mjs`
needs a tier row in `scripts/guards/guards.mjs` (`tools/guards.test.mjs` fails and says which); the edit
hook and the pre-commit run the earlier tiers, and a failure the edit hook says is NOT yours is another
session's: leave it ([guards before the push](../../../docs/notes/testing-and-ops.md#guards-before-the-push)).
The pre-push hook tests the PUSHED tree in a clean worktree, caches a green tree, and runs only
build+lint+unit+host for a docs-only push: [the pre-push gate](../../../docs/notes/testing-and-ops.md#the-pre-push-gate).

**Every host-spawning e2e script MUST pin `WATERPLANE_PREFLIGHT: "0"` and import `./lib-tmuxiso.mjs`**
(or boot through `bootHost`, which does both) — else the boot doctor prints into output the scripts
assert on, and stubs leak onto the shared tmux server. **Sessions always run inside tmux** (there is
no direct-PTY mode to pin any more), so isolation is by socket DIRECTORY: `lib-tmuxiso.mjs` sets a
private `TMUX_TMPDIR`, deletes `TMUX`, and kills every server in that dir on exit, failure or
ctrl-C; `run-e2e.mjs` hands each script its own dir and kills what is in it afterwards (a tmux server
daemonizes out of the process group, so the group kill never reaches it). A host on a temp root
also derives its own `-L` name (`sessions/knobs.ts`), so two hosts in one script do not share a
server's environment. A script that builds a MINIMAL env for its host must carry `TMUX_TMPDIR`
across (`e2e-tmux.mjs`, opencode's `e2e-tmuxenv.mjs`). Host tests that start sessions import the same module.
`packages/extensions/opencode/e2e/e2e-tmuxenv.mjs` is the only test of what the tmux PANE's
environment actually contains: a backend's `spawnEnv` (opencode's auto-update guard) is exactly what a `-L` server that ALREADY EXISTS drops, so
it names its own server and starts it itself from an environment with the guard unset, because a
fresh-server run passes while the bug is still there. `e2e-tmux.mjs` and opencode's `e2e-ocservetmux.mjs` name
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
keeps painting, and the real `Stop` only when the spinner stops — `STUB_GOAL_MS`) / `permmode` (2.1.293's permission-mode footer under a real composer, cycled by
shift+tab) / `deaf`
(text echoes, Return SWALLOWED) / `ext` (another CLI's geometry from OUTSIDE the stub:
`STUB_MODE_MODULE=<path>` exports `paint({buf, blind})` and optionally `submit(prompt)` — a backend
extension's own stub draws its screen shape against this file's input handling, so the no-box
delivery path is exercised against a second shape; `STUB_VARIANT=blind|deaf` re-uses those two
failures against it) / `logo`
(the apk-install gif's turn: reads a marked image's circle off the annotator note and really edits the
sample app in the cwd — `scripts/media/tide-tables.mjs`, pinned by `tools/stublogo.test.mjs`) / `demo` (the showcase script the demo scenarios are recorded from) / `welcome` (Claude Code's welcome header + an idle composer, scripted turns on `logo`'s pace: the `first-app` and `setup` gifs; `STUB_TRUST=1` opens on the workspace-trust box) / `answer` (a turn that really ANSWERS for `e2e-peer.mjs`: writes the conversation log, obeys `STUB_WRITE <relpath>` (under the cwd) / `STUB_RUN <cmd>` / `STUB_SAY <text>` lines in the prompt; needs `STUB_HOOKS=1`). `STUB_HOOKS=1` makes the session count as `hooked`; `STUB_USAGE=<sess>,<week>` renders a `/usage` screen the budget scraper can parse. The header comments of `claude-stub-tui.mjs` are the full catalogue.

**A script whose subject is an unattended `claude -p` writes its own stub**, because
`claude-stub.sh` `exec`s a shell and cannot answer one. The pattern is `e2e-assess.mjs`'s: a node
script GENERATED by the script itself, spawned as `claude` through `WATERPLANE_CLAUDE_BIN`, reading its
mode from a FILE on every invocation so one booted host can be driven through every answer — and
answering on stdout with the real `--output-format json` envelope (`result`, plus `usage` /
`total_cost_usd` where the caller reads them).

The capture suite has its own stub instead: `scripts/capture-stub.mjs` is a fake `ciqkit` — argv and,
mainly, its EXIT CODES (0 captured / 1 failed / **3 captured but OCR contradicted the anchor**, the
downgrade nothing else can produce). `WATERPLANE_CAPTURE_STUB_EXIT3` / `_FAIL` / `_SCORE` each take a
number-or-flag PATH rather than a fixed value, because a spawned daemon's env cannot be changed and
one script needs both outcomes; `shot-score` answers only about a frame REALLY at the path it is
handed, so asking it about a scratch dir the run already emptied fails the suite instead of
answering `n/a` for ever — which is indistinguishable from an honest "nobody measured".

What each script pins, in full: [testing-and-ops.md](../../../docs/notes/testing-and-ops.md), whose
[rough map](../../../docs/notes/testing-and-ops.md#the-rough-map) is the one-line-per-script index.

## A hang is a failure, never a wait

- **Close what a test opens on EVERY path.** A server, socket or child closed only on the line after
  the assertions stays open when an assertion throws, and the file's process never exits. Register
  the close in `after()`/`t.after()` or a `finally` (`vault/test/cli.test.mjs`'s `open` set). That
  leak hung `npm run test:host` — and every pre-push with it — for over a day.
- `test:unit` and `test:host` run with `--test-timeout=120000` (slowest real test ~10 s): a test
  that never settles goes RED after two minutes. **Never add `--test-force-exit`**: it
  silently dropped 27 of 3514 unit tests, all green. A count that shrinks with no failure is worse
  than a hang, so a leaked handle is still a hang.
- Prove a timing fix UNDER LOAD (`yes > /dev/null` on every core, several copies in parallel):
  passing alone says nothing about a race. an e2e script once failed 5/5 that way and passed alone.
