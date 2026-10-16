# Design notes

CLAUDE.md is capped at **12k chars** by `tools/claudemd.test.mjs` and is the *rules* file: short,
load-bearing, always in context. (It was ~150k when these notes were split out of it, which is the
size this sentence used to quote — the cap has been tightened by more than ten times since, and
raising it is a decision about cost rather than a way to make the check pass.)
These notes are the *why*: the full prose that used to live in CLAUDE.md, kept verbatim so no
hard-won reasoning is lost. Read the relevant one before changing that area — every paragraph here
is a bug someone already paid for.

| File | Covers |
| --- | --- |
| [architecture.md](architecture.md) | **start here** — three pictures: the system (phone, tailnet, host, CLIs), the components (the four packages and their import rules) and the plugin mechanism (found, loaded, what a plugin may do, a plugin backend's dialog end to end) |
| [testing-and-ops.md](testing-and-ops.md) | every `scripts/e2e-*.mjs` and what it pins, the e2e runner, stub TUI modes, env pins, restart mechanics, full env-knob list, and why the repo-specific rules are lint rules |
| [host.md](host.md) | workspaces, `packages/app` (Android shell), and one entry per `packages/host/src/*.ts` |
| [web.md](web.md) | one entry per `packages/web/src/*` — send queue, pull queue, offline caches, gallery, reader view, hints, settings sync |
| [web-architecture.md](web-architecture.md) | the web client's `core/` + `sdk/` + `features/` split: `CoreApi` and why it is a singleton, the manifest and registry, `local/feature-boundary`, the `App.tsx` line ratchet, and adding a feature step by step |
| [refactoring.md](refactoring.md) | how a big file is split here without changing behaviour: target doc first, ratchets and pins before moves, parallel builders with serial integration, clean-worktree verification (`scripts/verify-rev.sh`), and what went wrong splitting `App.tsx` |
| [host-architecture.md](host-architecture.md) | the host's target shape: `sessions.ts` / `intents/manager.ts` / `main.ts` as facades over `sessions/`, `intents/`, `server/` slices, `SessionCore`/`IntentCore`/`ServerCtx`, the `local/host-boundary` rule, the `hostshape` ratchets and `hostpins` counts, and the region-by-region inventory with cut order and hazards |
| [send-architecture.md](send-architecture.md) | the send sheet's split: `SendSheet.tsx` as a thin composer over `send/` (one state hook, region components) and `sendIntent.ts` as a barrel over `sendIntent/`, the `webshape` ratchets and caps, `sendpins` (export surface via the type checker, side-effect counts), and the byte-identical server-render proof |
| [transcript-architecture.md](transcript-architecture.md) | the reader's split: `TranscriptView.tsx` as a thin composer over `transcript/` (one state hook, region components, pure `tv*` helpers), the `webshape` ratchet and caps, `transcriptpins`, and the byte-identical server-render proof |
| [assess-architecture.md](assess-architecture.md) | the assessment's split: `assessRows.ts` as a barrel over `assess/arows*.ts`, `AssessSheet.tsx` as a thin composer over `assess/` (one state hook, region components), the `webshape` ratchets and caps, `assesspins`, and the byte-identical golden and server-render proofs |
| [spender-split.md](spender-split.md) | the unattended spenders' split: `assess.ts` (host and shared) as a barrel over `assess/`, and the `spenderssplit` pins |
| [app-architecture.md](app-architecture.md) | the `App.tsx` split: the host lists, the frame switch, the launcher cuts and the boot effects as hooks under `core/`, the overlay table as a function, why effect ORDER is the rule (contiguous runs moved verbatim), `apppins` (export surface, the inlined effect order, one subscription), and the server-render proof |
| [charts-architecture.md](charts-architecture.md) | the two chart geometries and the annotator: shared `kit/chart/` primitives (`chartFmt`/`chartScale`/`chartPath`), `contextPlot.ts` and `statsPlot.ts` as facades over `contextPlot/` and `kit/chart/stats/`, `ImageAnnotator.tsx` as a composer over `annotator/`, the `plotpins` golden and the server-render proof |
| [backlog-architecture.md](backlog-architecture.md) | the backlog sheet's split: `Backlog.tsx` as a thin composer over `backlog/` (state hooks, region components, grouped props) and `backlogFilter.ts` as a barrel over `backlogFilter/`, the `webshape` ratchets and per-file caps, `backlogpins` counts, and the region inventory with cut order and hazards |
| [webclient-architecture.md](webclient-architecture.md) | the HTTP client, the gallery and the repo-health words split into `webapi/`, `gallery/`, `repoHealthWords/` behind their original paths; `webclientpins` and the `webshape` caps |
| [activity-architecture.md](activity-architecture.md) | the activity sheet's split: `activityRows.ts` as a barrel over `activity/` (pure row builders per source, selector, triage, bulk) and `ActivitySheet.tsx` as a facade over a model hook and region components, the `activitypins` surface and golden digests, and the webshape caps |
| [pulllink-architecture.md](pulllink-architecture.md) | the split of `pull.ts` (the download manager, methods as `this`-typed functions behind one class) and `link.ts` (the link store, one slice per section) into `pull/` and `link/` behind their original paths, the `pulllinkpins` surface pins and the webshape caps |
| [token-stats-architecture.md](token-stats-architecture.md) | the token statistics screen leaving core: `extensions/token-stats/`, the `sdk/ledgers.ts` read API, `kit/chart`, the adopted core sheet id `tokens`, the 900-line cap with the `TokenStatsSheet` ratchet, `tokenstatspins` hook-order pins, and the region inventory with cut order |
| [shared-architecture.md](shared-architecture.md) | `packages/shared/src/intent.ts` as a barrel over `intent/` slices (types, row, facts, words, budgetpass, kind, target, verdict, clean): the import DAG, the barrel as the one door, the `sharedshape` ratchet and 600-line slice cap, the `intentsurface` export pin, and the region inventory |
| [distribution.md](distribution.md) | the release artifacts: the `scripts/release/build.mjs` tarball layout, the npm tarball, the pinned Node, the `<slug>` CLI (`packages/host/src/cli`) and what in the host assumes a checkout; then the `curl \| sh` installer (pinned Node, checksums, the data-dir layout, upgrade and uninstall, its template and renderer) and `waterplane service` (launchd / systemd user unit / WSL, the dev-checkout conflict, what env a service may carry); and Windows: a Windows checkout running its host in WSL2 (`scripts/windows/`: setup, the keeper, logon autostart, mirrored networking, `tailscale serve`) |
| [capture.md](capture.md) | the verified screenshot loop — `capture.ts` and its backends, why the loop is verify → settle → diff → emit, why the default output is a text verdict rather than an image, the sidecar schema, and the `visual-check` preset `visualskill.ts` writes into a repo |
| [desktop.md](desktop.md) | the live desktop extension: the Swift helper `wp-desktop` (built on first use, why a rebuild forgets the Screen Recording and Accessibility grants, the brand-derived signing identity, the TCC attribution and the `request` command that asks), the stream path, the Auto bitrate controller, the control gate, the presets with their measured numbers, and what is unverified until someone is at the Mac |
| [protocol-and-security.md](protocol-and-security.md) | the tmux substrate, wire-protocol invariants, security model, secure-context caveats, heuristics |
| [what-waterplane-is.md](what-waterplane-is.md) | not a subsystem note — the strategic read: what is actually differentiated here, who it is for, what caps adoption, and what to build next |
| [vs-competitors.md](vs-competitors.md) | not a subsystem note — the outside view: the full feature list in one place, an honest three-way comparison against Happy and Paseo (SDK vs real-CLI-in-PTY), and why the relay it suggests is not being built |

Each per-module entry CLAUDE.md was trimmed of is kept **verbatim** under a `###` heading named for
the module, in *CLAUDE.md entries in full* ([host](host.md#claudemd-entries-in-full),
[web](web.md#claudemd-entries-in-full)); CLAUDE.md's per-entry links point straight at them. The
same holds for the passages that were not per-module:

- [the rough map of the e2e suite](testing-and-ops.md#the-rough-map), plus the three scripts
  nothing else described (`e2e-intent`, `e2e-offlinelists`, `e2e-settlesweep`)
- [why the repo-specific rules are lint rules and not paragraphs](testing-and-ops.md#why-these-rules-are-lint-rules-and-not-paragraphs)
- [the tmux substrate and the locale that broke prompt detection](protocol-and-security.md#the-tmux-substrate-and-the-locale-that-broke-prompt-detection)
- [what counts as a miss, in full](protocol-and-security.md#what-counts-as-a-miss-in-full) — the CLI
  health record's two false alarms
- [`convfork.ts`, `assess.ts` and `clihealth.ts`](host.md#modules-claudemd-links-here-for-and-this-file-never-covered),
  written from the modules' own headers

Grep them (`grep -n 'holdUntilIdle' docs/notes/*.md`) rather than reading whole files — `web.md` and
`host.md` are past 150k chars each.

When you add a subsystem: one line in CLAUDE.md, the reasoning here. When you trim one: the rule
stays in CLAUDE.md with a link, and the prose it lost lands here whole.
