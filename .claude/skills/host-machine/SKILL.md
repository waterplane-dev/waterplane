---
name: host-machine
description: waterplane host as the machine the phone drives (packages/host/src): files.ts (inbox uploads, the outbox gallery, sweep, traversal guards), tree.ts (the worktree, and the one place a file is written back), builds.ts + buildscan.ts + artifacts.ts (sessionless build commands, their parameters, what a repo can already build, and what a run leaves behind), capture.ts (the verified screenshot loop), sysstat.ts + localrt.ts (CPU, memory, thermals, ollama's loaded models), dictate.ts (recorded speech, words back), installlog.ts, autopull.ts, readtext.ts (the highlighter's text reader). Load BEFORE touching uploads, artifacts, file writes, builds, screenshots, machine telemetry or dictation.
---

# waterplane host — the machine

This desktop as a resource the phone reaches: its files and worktrees, its build commands, its screens, its hardware readings and its microphone — host-side plumbing that acts on the machine rather than on a session. Router: `host`. Reasoning: [host.md](docs/notes/host.md).

- `files.ts` — inbox uploads, artifact gallery, traversal guards. **`DISCOVERABLE` ≠ `VIEWABLE`**;
  `.env` refused everywhere. The repo badge is `countOutbox()` — UNSEEN OUTBOX files, never the inbox.
  **`listTransport`/`sweepTransport` are the BULK cleanup** (`GET`/`POST /api/repos/:id/sweep`):
  listing is EVERY file in the transport dir, not the paintable subset (a `.zip` is bytes), `.seen`
  never listed (deleting it un-reads the repo), containment is **`deleteArtifact`'s, never a second
  `rmSync`**, and it takes **PATHS never an age** — a set re-cut here is a set nobody approved.
  `missing` (already gone) is split from `failed` (still on disk), which needs `contained()` not
  `resolveInTree()`. `sweepfiles.test.mjs`.
- `transportsurvey.ts` + `hoststore.ts` — **what the DESKTOP is holding, one level above the sweep.**
  The survey is every discovered worktree ranked by its two transport dirs (7.5 GB over 14 repos was
  the measurement) and it **walks nothing of its own** — every tally is `listTransport`, the same
  function the per-repo sweep serves, because the row is what a person TAPS to open that sweep and
  two sources would make the row and the sheet disagree (`e2e-storage.mjs` asserts byte-equality).
  Past an entry budget a repo's tally is **`null`, never a partial count**, plus a yield between
  repos (this runs on the loop pumping every PTY); the budget is NOT an env knob. No host-side cache.
  `hoststore.ts` reports the state dir (`<state dir>`) by owner and by BOUND — almost every row carries a `cant`
  naming the ring/row-cap/rotation that already holds it, which is what identifies `tokenstats.json`
  as the one with none. Only two things are ever cleared: `thumbs/` (via its OWNER, `thumbs.ts`'
  `clearThumbCache` — a foreign `rmSync` races the rename-in) and `*.json.{bak,migrated}`. A file the
  catalogue does not name is `unknown`: counted, shown, never touched, and the FALLBACK is `unknown`
  so a new store is never deleted by default. **Containment is NOT `contained()`** — this dir is
  outside every worktree: no path arrives from the client, names are **matched never sanitised**
  (`..json.bak` is a non-match), symlinks skipped, plus `inRoot()` as the realpath belt. **`at` is
  the contract** (the sweep sends rows because rows ARE the decision; nobody chooses which thumbnails
  to keep). `GET /api/storage/transport` · `GET /api/storage/host` · `POST …/host/clear`, outside the
  `/api/repos/` prefix, clear **200 even when it refuses**. `hoststore.test.mjs` ·
  `transportsurvey.test.mjs` · `e2e-storage.mjs`.
- `localrt.ts` — **what the LOCAL model runner is holding**, off ollama's `/api/ps` + the OS.
  **`reachable:false` is NOT an empty model list** — "answered, holding nothing" and "nobody
  answered" are opposite facts. Every `parsePs` field degrades alone (no name ⇒ dropped, bad size ⇒
  0 never NaN, bad `expires_at` ⇒ ABSENT). Watching is a **LEASE not a subscription** (no
  socket-close hook, so watch state must not outlive its socket); polls only while a lease is live,
  **stops with its last watcher**; `WATERPLANE_LOCAL_RUNTIME=0` ⇒ one-shot `disabled` frame, a different
  sentence from unreachable. 5 s because the events are load/evict (`keep_alive` 5 min) and memory
  pressure. **Host keeps NO ring** — the phone does. **Tokens/sec ABSENT and stays absent.**
  `localrt.test.mjs`.
- `sysstat.ts` — **the machine, the way `top` would have told you**, sampled inside that same poll:
  the CPU split, where the memory went, which programs hold it, temperature and fans. Every reader is
  independent and every failure is an ABSENT field. **CPU is a DELTA** (`cpuBusyFrom`, pure): `nice`
  goes in with user and `irq` with system, a changed core count or a counter that went backwards is
  `null`, and the FIRST reading of a process has no interval and so no split — the load average is a
  QUEUE LENGTH and never stands in for it. **`vm_stat`'s page size is READ, never assumed** (4096
  Intel / 16384 Apple silicon — a 4× error on half the fleet) and `used` is app + wired + what the
  compressor OCCUPIES, never what is STORED in it. Linux gets `MemAvailable` and **no invented
  app/wired split**. Processes are **FOLDED BY PROGRAM** (23 `claude` processes holding 11.7 GB is
  the answer; 23 rows is not), a `pid` survives only a fold of one, and `rssSumBytes` ships because
  RSS counts a shared page once per process. **macOS temperature is ABSENT with a sentence**:
  `powermetrics` is root-only, this daemon must never prompt for a password; **a PLUGIN contributes
  the reader** (`api.thermalReader` → `registerThermalReader`) and core names no helper tool, only
  checks figures (`cleanThermal`: outside 1..149 °C or non-finite ⇒ DROPPED); none ⇒
  `MAC_THERMAL_NOTE` — an absence a person cannot explain reads as a bug. The
  two expensive readers run on `WATERPLANE_SYSSTAT_SLOW_MS` (15 s, floored) and **carry their own
  timestamp** so a repeat is visibly a repeat; `WATERPLANE_SYSSTAT_PROCS=0` stops sending program names and
  the section SAYS so. `sysstat.test.mjs`.
- `localusage.ts` — **what the local runner DID, kept** (`GET /api/localusage`): compute time,
  tokens and memory per model per day, read PASSIVELY off ollama's `server.log` (`print_timing` +
  the `[GIN]` access line) and `/api/ps` — never a request path. **Runner time and time to answer
  are never one number**; the log names no model, so a request is tied to one only by the ps
  samples around it, else `model: null` with its sentence — never the last-loaded guess, and no
  back-fill. Commit-point parsing + the cursor saved with the data (restart neither loses nor
  re-counts). `localusage.test.mjs`, real lines in `test/fixtures/ollama-server-log.txt`.
- `tree.ts` — the worktree as a tree, and the one place that WRITES a file back. **A save must present
  `baseSha`** (the second writer is an AGENT in the same repo); mismatch ⇒ `stale` (409), nothing
  written. **A body we could not show in full carries NO `sha`.** Creates nothing, refuses `.env` both
  ways, tmp+rename carrying the original mode.
- `builds.ts` — per-repo build commands without a session; the rate-limit escape hatch. **Two files, one
  list**: `.waterplane-shared/builds.json` is COMMITTED (every checkout), `.waterplane/builds.json` is this
  desktop's own; `list()` = shared then local, local REPLACING a shared id in place; `save(repo, list, local?)`
  partitions back (no `local` ⇒ where it lives, new ⇒ shared), keeps a shadowed shared entry untouched,
  writes a file ONLY when its content changed (git), never overwrites one that does not parse. A desktop
  path (JAVA_HOME) is always a LOCAL override. `buildsmerge.test.mjs`. The config is
  SNAPSHOTTED onto the row at fire time. Artifacts are "written since the run started", so a run that
  touched nothing falls back to the newest deliverables **flagged `stale`**.
  **An entry may ASK before it runs** (rules: `shared` skill, `buildparams.ts`, one implementation
  for the form and the shell): `dir` is substituted BEFORE `contained()`, so the guard still holds,
  and the missing-value refusal is synchronous, beside "unknown build" — what an unattended fire and
  an older bundle hit. A choice's options may be
  READ (`optionsCmd`, `build.options`, repo ROOT never the parameterised `dir`, **async** — it runs on
  the loop pumping every PTY); a failure is a SENTENCE per parameter, never an empty list. Values are
  snapshotted onto the payload (the executor still needs the env after a restart) and into the TITLE.
  `scripts/e2e-buildparams.mjs`.
  A benchmark a backend extension ships (its own `scripts/`, run as a build) is a build command in
  exactly this sense: measured, no session, nothing applies itself — the rules live with it.
- `appready.ts` + `apkcheck.ts`' `apkRepoFacts` — **the repo half of every app's quiet install, as
  DATA** (`GET /api/apps/readiness`): package (+ suffix variants), key kind, targetSdk, outbox APKs,
  APK-ish build commands (a LABEL, never a filter), and whether the auto-download rule takes the
  newest APK. Primary checkouts only, one repo at a time; a package-less module beside a named one is
  a root `apply false` line or a template and is dropped. Facts, never a verdict — the phone words them.
- `installlog.ts` — **which version of what is on which phone.** The one asymmetric question in the download path: one host, many devices, and an install that happens with the app closed. `settings.ts`' storage posture (`.waterplane/installs.json`, tmp+rename, debounced, flushed, re-cleaned on the way IN). **RECORDS, never decides.** A report is a RE-STATEMENT (whole history per `hello`), so the merge is keyed — `<deviceId>:<pullId>:<at>`, the `at` in it so a re-install is a second entry — and the route is QUIET when nothing changed, or every handshake broadcasts the whole log for no news. **The host stamps only `reportedAt`**; an absent `at` stays absent. Devices are DERIVED per read. Rules in `@waterplane/shared`'s `installlog.ts`; `installlog.test.mjs` both sides.
- `artifacts.ts` — **what a build LEAVES BEHIND, and what it is called.** Rules (naming, `familyKey`,
  policy defaults): `shared` skill, `artifacts.ts`; disk here. After every run: FOLD the same bytes under two names into one
  artifact (size **and** a head+tail fingerprint — two ABI splits are bytes apart), COLLECT what is
  not already in `.claude/outbox/` under `<repo>-<variant>-<version|sha|stamp>`, PRUNE older builds
  of **exactly what this run produced** (newest `keep`, `deleteArtifact` never a second `rmSync`).
  **A COW clone, never a hard link** — the
  next build rewrites its output in place and a link puts those bytes inside the PREVIOUS build's
  collected copy. Per-repo policy in `<repoDir>/.waterplane/artifacts.json`, on by default, `artifacts.get`/
  `.save` → `artifacts.config` (broadcast, contained, `pull.save`'s shape). **Never fails a build**,
  never touches what the build wrote, and every action is a LINE in the run's output.
  `artifactcollect.test.mjs` · `e2e-artifacts.mjs`.
- `buildscan.ts` — **what a repo can already build, read off its own manifests** — the free half of
  the Build sheet's "set up", for adding one command without spending a turn on it. The walk is here
  (bounded: depth 3, 400 dirs, 256 KB/file, `SKIP_DIRS` pruned BEFORE descending — this runs on a
  phone's frame in the process pumping every PTY); every RULE is `@waterplane/shared`'s `buildscan.ts`, so
  it is pinned with no disk (what may be offered, flagged or marked: `shared` skill). A failed scan
  answers an EMPTY list, never silence.
- `capture.ts` (a facade: the manager, over `capture/capturekit.ts` the knobs and backend table, `capture/captureverdict.ts` the pure ladder/verdict/emit gate, `capture/captureconfig.ts` target cleaning + overlay + probe, `capture/capturehelpers.ts` anchors/lease/sidecar/run rendering, `capture/capturesettle.ts` SETTLE, `capture/capturepass.ts` one run's passes + watch loop) — the verified screenshot loop: targets in `<repo>/.waterplane/capture.json` (`builds.ts`'
  shape), a run IS an intent, and it goes **verify → settle → diff → emit**. **Settle is
  frame-stability, `settleMs` a CAP not a sleep**; the diff gate is TOKEN hygiene, not disk — an
  emitted frame is one an agent may pay for on every later turn — and with no tool it emits every
  frame, capped, and SAYS so. **Default output is the ~50-token verdict line, not the image.**
  **`verified:*` is the ANCHOR level only**: `capture/window.ts` has no oracle ⇒ ceiling
  `settled:stable`. `capture/types.ts` is the seam; `capture/web.ts` resolves Playwright at RUNTIME
  (`thumbs.ts`' model, never a root dep); `capture/android.ts` adb+uiautomator; `capture/garmin.ts`
  SHELLS OUT to ciqkit, never imports/vendors it (exit 3 ⇒ downgrade, not fail); `capture/pixels.ts`
  degrades to `null`. Overlay frames are KEPT. `visualskill.ts` writes the `visual-check` preset
  where a target exists.
- `reposkill.ts` + `reposkilltext.ts` — **making a driven repo waterplane-aware**: the `waterplane` skill,
  generated into `<config dir>/claude-plugin/` and passed to every spawned `claude` with
  `--plugin-dir` — never written into a repo, so never stale (the rule itself: CLAUDE.md).
  `tools/reposkill.test.mjs` fails on a per-repo `.waterplane/` file the text never names.
- `autopull.ts` · `readtext.ts`: `readImageText` + `POST /api/host/readtext` (**the phone highlighter's text reader** — `GEMINI_API_KEY`, the `postGemini` transport; the decision oracle that shared them is now a plugin outside this repo; it **decides nothing**: hand-asked, one crop per mark, transcription only, a long answer REFUSED, every failure its own sentence at **200**. Off without a key or with `WATERPLANE_OCR=0`; metered `kind: "ocr"`) · `meter.ts` /
  `usage.ts` (**the `/usage` capture is RENDERED before it is parsed** — the TUI's gaps are cursor
  jumps, not spaces) · `render.ts` (**the ONE headless VT replay**) · `context.ts` ·
  `compliance.ts` (fixes only ever ADD; plugin rows via `setupcontrib.ts`) · the requirements row, now an in-repo extension (`packages/extensions/requirements/host/requirements.mts`, pinned by `requirementsrow.test.mjs`): not set up
  is NO ROW (the offer is the Opt-ins region's, which runs the same `requirements` fix), never a warn on every repo; counts prompts by reading
  only the bytes appended since the last sweep; **never runs the build** — it quotes
  `scripts/requirements/update.mjs` for the phone to hand to the repo's agent) · `setupwatch.ts` (**never writes into a repo**; **absent ≠
  clean**; host-scope checks excluded) · `compliance.ts`'s **`context-weight`** row (what a repo costs
  to have OPEN: `CLAUDE.md` + skill DESCRIPTIONS, since skill BODIES are on-demand and must never
  count against a repo that did the split — the rule is `@waterplane/shared`'s `contextweight.ts`, and it
  carries **no `fix`**: which half is reference is a judgement only the author can make, so it names
  the *groom CLAUDE.md* fan-out preset instead) · `compliance.ts`'s **`auto-compact`** row (the `autoCompactWindow` a spawned claude would see: env > repo local > repo > user > unset=auto, rules and the key-preserving write in `@waterplane/shared`'s `autocompact.ts`; pass ≤ 500k, else WARN, never fail; its `fix` writes 400k into `.claude/settings.json` only where that file would win, and is `CONFIRM_GATED_FIXES` — two taps, never in *Fix all*, never counted one-tap fixable) · `contextlimits.ts` (**the per-repo threshold
  override**, `<state dir>/contextlimits.json` keyed by REALPATH — a host store, never a file
  written into a repo, because `setupwatch.ts` inspects repos nobody has opened. Resolution is
  **repo > env > default, per FIELD** (`resolveContextLimits`): an unset field keeps inheriting, and
  freezing all three would hide a later change to a shipped default. A settable singleton like
  `clihealth.ts` — **unset is a silent no-op**, so `inspectRepo()` still answers with env+defaults.
  **The quoted number is ATTRIBUTED** — the row used to say "the 16k you asked to be warned at" about
  a default nobody was offered. **Out of range is refused in words, never stored repaired**) ·
  `paths.ts` (**two guards, deliberately** — `inRoot` is
  REALPATH-resolving for a directory a client NAMES, `contained` is LEXICAL for a path joined onto a
  trusted worktree) · `ptycap.ts` (why a PTY could not be allocated, as a sentence; degrades to the
  raw message, never to a wrong number) · `secrets.ts` (**write-only**, gitignore gate) ·
  `push.ts` · `notifyprefs.ts` (a payload carrying `pull` bypasses the gate) · `decisionlog.ts` (limit auto-continues + plugin decisions, `<state dir>/decision-log.json`; migrates `oracle-log.json` once and renames it `.migrated`, never deletes it) ·
  `sentlog.ts` (verdict CORRECTED later **beside `result`, never instead of it**) · `settings.ts` ·
  `scaffold.ts` · `repos.ts` / `discover.ts` · `git.ts` · `transcript.ts` (default document is
  **lite**; a TUI-local command is a TURN — `local: "log"` from the log's own
  `<command-name>`/`<local-command-stdout>` pair, `local: "screen"` rebuilt from the PTY capture for the
  ones the CLI never writes down, e.g. `/btw` — and merging RENUMBERS) · `slash.ts` · `thumbs.ts` (**null ⇒ serve original**) · `httpio.ts` (never on 206) ·
  `update.ts` · `host.ts` · `auth.ts` · `webbundle.ts` · `net.ts` · `origin.ts` · `doctor.ts` ·
  `speedtest.ts` · `uistats.ts` · `netstats.ts`.
- `optins.ts` + `setupprefs.ts`' `optInChoices` — **offers, not findings**: one row per shared `OPT_INS` entry, answered by filesystem + local-repo probes only (never paid, never the network, never the repo's code), `unknown` rather than a guess, and never in the setup checklist, its badge or `summarize()`. `GET`/`POST /api/repos/:id/optins[/choice]`. `optins.test.mjs`.
- `dictate.ts` — **speech the phone recorded, words back, on this desktop** (whisperd first, `whisper-cli` fallback; `WATERPLANE_DICTATE_KEEP=1` is the opt-in exception that keeps clips). `readImageText`'s posture: it DECIDES nothing, writes nothing, has no repo, and the audio lives only in a buffer plus a `tmpdir()` file removed in a `finally` — and the failure log carries the duration, NEVER the words. Local because it was MEASURED first (28.6 s of German in 0.95 s, `large-v3-turbo`, Metal; 5.6 s CPU-only), not because it is cheap — the paid APIs are pennies a month at this volume and still lose on latency and on a prompt full of source code leaving the machine. **The phone writes 16 kHz mono WAV so the host needs NO transcoder** (ffmpeg was broken here while everything else worked). `dictateStatus()` is asked BEFORE the mic opens, and every no-engine case is its own SENTENCE at a 200; `doctor.ts`'s line is always `ok` for `checkCapture`'s reason. Model in XDG, turbo preferred, `WATERPLANE_WHISPER_MODEL` taken as said including its absence; language `auto` or whisper TRANSLATES the other one. `dictate.test.mjs`.
- `repohealth.ts` — **the zero-token metric series over git history, reached from the phone**
  (`GET /api/repos/:id/repohealth`, `POST …/repohealth/refresh`, running `update` → `narrate` →
  `html`). Its own module because a build is a CONFIGURED command in a PTY with guessed artifacts
  and this is three FIXED subcommands with known output paths — and because it must be **provably
  unable to spend**: it imports nothing from `sidecar.ts`, and the tool's one paid branch (`judge`)
  never appears in the argv log. **SINGLE-FLIGHT PER WORKTREE** — `.waterplane/repohealth.jsonl` is
  append-only and two concurrent `update`s both read before either writes, appending a duplicate
  row PERMANENTLY. **A plain POST, not a durable op with an ackId**: it types into no session, the
  tool is idempotent by construction, and a refresh delivered an hour late measures a tree nobody
  is looking at. **Both routes ALWAYS 200 with an `ok`** — exit 3 is a REFUSAL, not an error
  (stderr relayed VERBATIM in `refused.text`, `narrate` skipped), and a non-2xx collapses the
  tool's own remedy line into the phone's generic error state. **Staleness in COMMITS, never
  wall-clock** — the series is per commit, and a repo is not worked on every day. **WHICH ENGINE:
  the worktree's own `tools/repohealth.mjs` when it has one (argv WITHOUT `--root=`, because a repo
  shipping the tool is the authority on its own root), else the bundled engine with
  `--root=<worktree>`** (`WATERPLANE_REPOHEALTH_ENGINE`, else this checkout's copy three hops up — the
  rule `main.ts` uses for `.env`). Neither ⇒ the sentence blames THE DESKTOP, never the repo, and
  containment is unchanged: the worktree arrives as an id matched against `discoverTargets`, no
  path in the request is read, `--root=` is that worktree verbatim, no shell, fixed argv.
  **`status` carries what a phone needs before a repo has ever been measured** — commit count,
  engine version, active language packs, derived source groups, the exact re-cut command — parsed
  LENIENTLY, because a repo carrying an older copy of the tool prints none of them.
  **The GET is TWO reads — `status` then `plot`, in that order and nothing else in its argv.** A
  status is what the series IS (every caller needs it, drawing or not); a plot is what it LOOKS
  like, and it carries the TOOL'S OWN reading of each series — rank, slope, n, window start, reason
  — plus its detail sentence, because that definition lives once beside the pre-registered
  constants and the fixture that re-derives them, and a second copy on the phone would drift
  silently. **A failed `plot` is `plot: null` with `series` intact** — one reader falling over is an
  absent field, never a failed view — and neither read may appear in a refresh's three steps.
  **A repo's OWN readings run the repo's code** (`.waterplane-shared/health.json`, `tools/repohealth/own.mjs`,
  the trust paragraph in this module's header): the same trust a repo's own engine already gets —
  declaration read out of the COMMIT, argv only, cwd the worktree, minimal env, HEAD only, absent
  with a reason never 0, and nothing from a request ever reaches the argv. They never enter the index. The same file's
  `central` may DISABLE or OVERRIDE one of the five index readings (`tools/repohealth/central.mjs`,
  same trust, override HEAD-only, `why` required); a change of it is a CARRIED index week (`central.fp`),
  and the phone gets it as each series' `variant` — the host adds nothing.
  `scripts/e2e-repohealth.mjs`.
