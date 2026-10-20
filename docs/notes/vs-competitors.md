# The feature list, and waterplane vs everything people compare it to

Written 2026-09-13; Paseo added 2026-09-30; Anthropic's own options, SSH+tmux, VibeTunnel, Omnara, Orca and CloudCLI added 2026-10-02. Not a subsystem note — this is the *outside* view:
everything waterplane does, in one place, and an honest comparison against the two projects that occupy
genuinely adjacent ground, and (since 2026-10-02) the other things a person would reach for first. (Renamed from `vs-happy.md` when the second one arrived.)

Two rules for reading it:

- **Everything in Part 1 was read out of this repo** — the module maps in `docs/notes/host.md` and
  `docs/notes/web.md`, and the source where a claim was load-bearing. Where a line is a plan rather
  than shipped code, it says so.
- **Everything in Part 2 about Happy was read off its public repo and docs**, not its source. Lines
  marked **?** are inferred from marketing copy and were not verified in code. Treat them as the
  weakest claims in the document.
- **Paseo (Part 2b) was read from source**, a shallow clone of `github.com/getpaseo/paseo` on
  2026-09-30 (release v0.10.2); paths cite that repo. Its absences are "not found by grep", not proof.

- **Parts 2c-2h were read on 2026-10-02 from official docs, repos, release pages and store listings**,
  by fetching pages, not by reading source. Each claim carries its link. **?** = inferred or not
  established; "(not found)" / `—` = looked for in the pages read and absent, which is weaker than
  absent. Docs for first-party features change weekly: re-read before quoting.
- Where a competitor wins, it says so.

The companion to this file is [what-waterplane-is.md](what-waterplane-is.md), which asks *what is worth
building next*. This one asks *what exists, and how does it compare*.

---

## Part 0 — a correction worth making first

waterplane has been described in this repo's own orbit as a first-of-its-kind mobile coding client. **That
claim is false and should not be made.** Happy shipped a mobile client for Claude Code, publicly,
before this one existed, with iOS support waterplane still does not have. Paseo (created 2025-10-13)
ships native iOS, Android and desktop apps too. **And Anthropic itself ships it**: since early 2026
[Remote Control](https://code.claude.com/docs/en/remote-control) drives a *local* Claude Code session
from the Claude app on iOS and Android (Part 2c) — real local process, your filesystem, photos in,
push, slash-command subset, no VPN. Any pitch that implies "nobody lets you steer your own desktop's
Claude from a phone" is wrong, and the vendor's version is free with the plan.

The defensible claim is narrower and stronger, and it is about *what the phone can do*, not about
*being able to reach the agent from a phone*:

> waterplane drives the real binary on **your** machine, so it can build things a cloud agent physically
> cannot — APKs, Garmin simulator runs, licensed toolchains — and it treats context tokens as a
> metered cost instead of pretending they are free.

**Re-checked 2026-10-02 against Anthropic's Remote Control and Orca; the claim survives, narrower.**
"Runs on your machine" is no longer a differentiator against Remote Control: it also runs the local
process and local builds. What is left, each backed by a "not found" in the vendor's pages (Part 2c)
rather than a proof:

- the **round trip** for a build — result detected, delivered to the phone, APK installed — which
  Remote Control does not document, where waterplane's build runner, outbox and installer do it;
- **usage-limit-aware scheduling and resume**, and **token/cost history**, where the vendor's phone
  surface offers `/usage` as text;
- the **durable, exactly-once send queue** and an **offline reader**;
- a **real PTY** (the terminal and every TUI feature) as against claude.ai's chat rendering, which
  drops terminal-only commands;
- **no vendor in the path** — Tailscale only, no account, no transcript stored elsewhere.

"Nobody else has token economics" is also too strong: Paseo shows per-turn cost, Remote Control shows
`/usage`, Orca shows usage and rate limits. The claim that holds is *history, per-repo weight and the
next-turn price*.

---

## Part 1 — the feature list

### 1.1 Transport and delivery

- **One WebSocket per tab.** Everything rides it. A second socket is a lint failure
  (`local/no-second-socket`).
- **The offline send queue is the single send path** (`web/src/outbox.ts`). Nothing reaches the
  socket that is not in the queue, so there is exactly one thing to retry. Four lanes:
  `input` / `backlog` / `op` / `upload`.
- **Durable from the first keystroke.** Drafts persist per keystroke; the queue lives in
  localStorage; upload bytes are parked in IndexedDB before they can be lost.
- **At-most-once delivery, host-side.** An ackId ledger (`host/src/acks.ts`) persisted with a 45-min
  TTL and flushed on SIGTERM, so a retry that races the original is re-acked rather than re-typed.
  Retrying without an ackId is forbidden.
- **Four honest delivery verdicts** (`host/src/deliver.ts`): `ok` / `retry` (nothing typed) /
  `unconfirmed` (written, never seen — never auto-retried) / `unsubmitted` (Return swallowed — said
  out loud, never retyped).
- **Ambiguous deliveries are settled later** (`host/src/settle.ts`) against the CLI's own
  conversation log — read-only, types nothing, and `absent` requires the log before it will
  authorise a re-send.
- **Echo is verified structurally**, inside the CLI's composer box, not by distance from the bottom
  of the render — the replay tears mid-turn, and the distance rule was costing ~30% of deliveries.
- **`OUTBOX_CAP` is 500** and enforced on the way in; overflow *fails* the oldest row rather than
  dropping it. A failed row keeps its full text and its repo for ever. Nothing expires.
- **Queue depth is pushed to the APK's background service**, so the shell knows there is work.

### 1.2 Sessions and the CLI

- **A real PTY running the real binary.** Slash commands, the context meter, plan and trust prompts
  all work because nothing is re-implemented.
- **Multiple backends as data** (`host/src/backends/`): `claude` today, `opencode` as the second,
  each a descriptor of `bin` / `launchArgs` / `delivery` / `caps` / `models`. An unknown backend id
  throws by name rather than silently falling back to something else.
- **Capability gating that produces absence, never a wrong number.** A backend without a context
  meter reports no `contextLeft`, not 0%.
- **Hook-driven turn boundaries.** `SessionStart` / `UserPromptSubmit` / `Stop` / `Notification` /
  `SessionEnd` curl a loopback endpoint — the positive signal. Silence heuristics are the fallback.
- **A `Stop` hook can be answered "no"** (keep-going loops, `/goal` hooks), so a Stop is held
  against the screen for 1.2 s and only the CLI's own working line may contradict it.
- **`/compact` announces nothing** and can grind for minutes — a working line with no believed turn
  publishes one, retired quietly.
- **Choice-box detection in two stages** (`host/src/prompt.ts`): lenient scan, strict re-detect.
  A box that scrolled up is a box that was answered. Unparsable dialog ⇒ `awaitingInput`.
- **The question with no box** (`host/src/question.ts`) — a turn that ended on "which do you want?"
  used to read as done.
- **`AskUserQuestion` read as a tool call** (`host/src/askbox.ts`) — the full text is in the log
  before anyone answers. Matching by label, never index.
- **Subagents surfaced** (`host/src/agents.ts`): one row per running agent, read off the CLI's own
  subagent logs, because a background agent outlives the turn that launched it.
- **Usage-limit handling**: banner and reset parsed, sessions blocked as a group on one reset
  instant (it is an account fact, not a session fact), and the CLI now *exits* on limit — so the
  session is resurrected with `--continue` at reset.
- **Login from a phone** (`host/src/login.ts`): the OAuth URL is rejoined off the rendered screen,
  because at phone width the grid breaks a 300-char URL across six rows.
- **PTY geometry is floored.** A phone that measured a collapsed container once reported `54x3`, and
  the CLI could not draw a composer in it — 28 straight echo misses and five stacked copies of one
  prompt.
- **tmux substrate, required** — every session survives a host restart live; there is no direct-PTY mode.

### 1.3 Reading and understanding

- **Reader view** beside the terminal — the transcript as a document, not a scrollback.
- **The reader works offline** for sessions you have not opened yet: transcripts are prefetched and
  swept every 5 min into IndexedDB. The spinner waits for the *cache*, never for the host.
- **Scrollback archive.** Scrolling the TUI is a remote operation, so lines that scrolled off are
  archived per session and an upward pan with the socket down opens that archive — labelled as a
  reconstruction of what *this device* displayed.
- **Fork and reset.** *Fork from here* branches; *reset to here* rewinds in place, kills the running
  session, and goes through a confirm. Both are one durable `session.create`. A cut is refused
  rather than approximated when the anchor cannot be named exactly.
- **Full conversation archive** (`host/src/archive.ts`) — closing a session was never a delete.
  There is exactly one way to lose a conversation in this app, and it is per-row confirmed.
- **A short tab name** per session, generated once off the first prompt on the cheapest possible
  call and persisted. (The per-turn AI summary was removed 2026-10-01: the biggest unattended cost.)
- **Search, outline, history, slash-command sheets.**

### 1.4 Work that is not a chat turn

This is the part with no equivalent found anywhere else compared in Part 3 (each absence is a "not found", see 2c-2h).

- **Builds without a session** (`host/src/builds.ts`) — per-repo commands, run in a PTY with `CI=1`,
  output ring-buffered, artifacts detected as "written since the run started". **The rate-limit
  escape hatch**: a build costs zero model tokens. `.apk`, `.aab`, `.ipa`, `.iq` and `.prg` are all
  recognised deliverables.
- **Build discovery** (`host/src/buildscan.ts`) — what a repo can already build, read off its own
  manifests, so adding a command costs no turn. It invents nothing: a gradle task is offered only
  where the build file gives evidence for it.
- **The verified capture loop** (`host/src/capture.ts`, landing) — screenshots with a verdict.
  `verify → settle → diff → emit`; settle is frame-stability, never a sleep; the default output is a
  ~50-token verdict line rather than an image; backends are web (Playwright, resolved at runtime),
  android (adb), garmin (shells out to `ciqkit`, never vendors it) and window.
- **The durable intent store** (`host/src/intents/`) — one lifecycle for every piece of deferred
  work: scheduled prompts, launches, sweeps, builds, assessments, captures. Nothing is armed with a
  timer, so restart, sleep and DST cannot mis-fire it. At-most-once by intent id, for ever.
- **Fan-out** (`host/src/fanout.ts`) — one prompt across N repos, fresh session each, rebuilt from
  rows so it survives the daemon.
- **Backlog** — a queue of work per repo, delivered into a session the host opens itself, recognised
  by title rather than a map (a restart orphans a map, not a title).
- **Assess** (`host/src/assess.ts`) — "of the work still standing, what is still worth doing?" The
  contract is a file both ways. **Nothing applies itself**: the result is a diff a person approves.
- **Review verbs** (`host/src/review.ts`) — check / validate / next step / continue, on work that
  has settled.
- **A local sidecar engine** (`host/src/sidecar.ts`) — unattended completions may be routed to a
  local OpenAI-compatible server instead of spending account tokens, but only for tasks whose
  contract already forbids tools. Assess and review refuse it *in words naming the variable*.

### 1.5 Files, artifacts and the phone as a device

- **`.claude/outbox/` is the artifact channel** — the gallery and the repo badge read it. Files from
  the phone land in `.claude/inbox/`. Pictures reach your eyes at zero model tokens.
- **The gallery**: four filters over an HTTP listing, cached per tab with coverage, thumbnail bytes
  cached by the page (the service worker is never registered in the APK).
- **One download button, app-wide.** It replaced a hidden `<a download>` that did nothing at all in
  the APK. A second one is a lint failure.
- **Three download engines**: Background Fetch, a native Android foreground service, and a chunked
  Range loop. Chromium freezes the document 300 s after it is hidden, so the transfer moves to a
  service that keeps its backoff on disk.
- **Range-correct artifact serving**: piped not buffered past a threshold, `accept-ranges`, correct
  `content-range`, 416 rather than 200 past the end, `if-range`.
- **Image annotator** with a highlighter — marks numbered from one list in the words and in the
  pixels, and the highlighted band read back as text on the host from the *clean* image, shown and
  editable before anything is sent.
- **Collage** — several picked images become one, so everything downstream is the single-image path.
  Falling back is reported, never silent.
- **Uploads** — the inbox path is written into the prompt before the bytes move, and bytes of a
  dying upload are moved aside, not deleted.
- **The file browser and the rare edit** — a save must present a `baseSha` (the second writer is an
  agent in the same repo), and saving is *never* queued.
- **Repo discovery, worktrees, git status/diff/branch/push.**
- **Light and dark as a setting**, with the palette validated by a test that parses the stylesheet —
  token parity, 4.5:1 text contrast, 3:1 charts, CVD separability, across all 360 repo hues.
- **The APK** (Capacitor, deliberately not Ionic) ships the same Vite bundle, so the app shell is
  never on the network, and the UI updates over the air — only Java/manifest/icon changes need a new
  APK.
- **Back is a history stack**, not a URL diff, and its depth is pushed to the shell because Android
  13+ asks at the *start* of a predictive-back swipe.
- **Typing room** — while the caret is in the compose box the chrome above it hides and the terminal
  keeps its rows.
- **CLI mode** — the compose box becomes a raw key pipe, because Android soft keyboards report no
  `keydown` for letters.

### 1.6 Token economics — the part few others have (see Part 0 for who has pieces of it)

- **`sessioncost.ts`** — what the *next* turn costs against a fresh one, said out loud. Deliberately
  not folded into the context meter: that says how much window is left; this says what the next turn
  prices at.
- **`tokenstats.ts`** — every token every conversation on this desktop ever used. Dedupe by
  `message.id` (70% inflation otherwise), skip synthetic turns, keep the four kinds apart for ever,
  subagents counted. Yields to the event loop every 64 reads.
- **Usage windows with history** (`usagelog.ts`) — nothing is ever scraped for it; it records what
  was already fetched, so the series is irregular and a gap stays a gap.
- **Context history off the log** (`ctxlog.ts`), which refuses three plausible-and-wrong charts.
- **A per-repo context-weight budget** — what a repo costs merely to have open (`CLAUDE.md` + skill
  *descriptions*; skill bodies are on-demand and never counted). Thresholds are overridable per
  repo, and the row carries no automatic fix, because which half is reference is a judgement only
  the author can make.
- **A budget ceiling before the wall** — but an explicit send, an answer to a live box, and uploads
  are never held.
- **No prices anywhere.** Cost depends on plan, model and cache tier, none of which is in the logs.

### 1.7 Honesty as a feature

The rules that are unusual enough to be worth listing as features:

- **Heuristics degrade to null or absent, never to a wrong number.**
- **Nothing applies itself.** An assessment, a review verdict or a cost reading produces sentences a
  person acts on — never a mutation, never a refusal.
- **Never grey out a button to mean "not clickable"** — a blocked verb is not rendered as a control
  at all, it becomes a sentence (`Unavailable.tsx`). A `title` is invisible on a phone.
- **A count on a control is a filter.** A tap on "2 within the hour" opens exactly those two, and
  the filtered view says what it is hiding, "n of N", with a clear button — from one bucketing
  function, never two copies of the edge.
- **An empty list is a claim**, so lists cache their *reading* and say how old it is.
- **`offline` and `error` are deliberately different states**, and `offline` takes the socket
  signal, not `navigator.onLine`.
- **The CLI's own health is tracked** — when a heuristic misses, that is recorded and surfaced
  unprompted, because a silently broken detector is worse than an absent one.
- **The link is one store** — it was six modules with four independent derivations of "am I online".
- **Setup compliance** with idempotent fixes that only ever *add*, plus the findings as words for
  that repo's own agent where a patch cannot close them.

### 1.8 Security

- **Tailscale network identity is the boundary.** The daemon spawns `claude`, so it never binds a
  public interface. `WATERPLANE_HOST` defaults to the Tailscale IP, then loopback.
- **Network identity does not cover browsers.** Every `/api/*` request and WS upgrade is checked on
  `Origin` *and* `Host` (DNS rebinding), with `Sec-Fetch-Site` as the backstop. That backstop exempts
  exactly two read-only routes, because the Android shell loads them as `<img src>` / `<a download>`.
- **Path containment guards** asserted by e2e, realpath-resolving where a client names a directory.
- **`POST /api/hook` is loopback-only** and no-ops on unknown sessions.
- **A LAN password gate** when `WATERPLANE_ALLOW_PUBLIC=1`: deny-until-set, and LAN can never set the
  password.
- **Secrets are write-only** and gated on gitignore.
- **`.env` is refused everywhere**, both directions.

---

## Part 2 — Happy

MIT-licensed, `github.com/slopus/happy` (app) + `happy-cli` + `happy-server`. Forks exist that add
more agents (`happier-dev/happier`).

**Architecture**: a wrapper. You run `happy` instead of `claude`. When you pick the session up on
the phone it restarts in remote mode and syncs through a backend server. Traffic is end-to-end
encrypted; the server relays ciphertext. The server is self-hostable, though the documented path is
their hosted one.

**What it has that waterplane does not:**

- iOS, Android, web and a macOS desktop app — in app stores.
- Realtime voice, hands-free.
- Several agents: Claude Code, Codex, Gemini, OpenCode, Qwen.
- Device handoff: one keypress moves the live session between desktop and phone.
- Works from any network with no VPN, because the relay is in the middle.
- Actual users, contributors and a community.

---

## Part 2b — Paseo

Apache-2.0, `github.com/getpaseo/paseo`. ~19k stars, created 2025-10-13, v0.10.2 on 2026-09-29,
effectively one maintainer plus bots. Read from source (2026-09-30).

**Architecture**: a daemon that drives agents through their *structured* interfaces and renders its
own chat UI from normalised events.

- **Claude Code via `@anthropic-ai/claude-agent-sdk`** (`packages/server/package.json`,
  `agent/providers/claude/query.ts`, `agent.ts`). `pathToClaudeCodeExecutable` runs the installed
  `claude`, but there is **no PTY and no TUI** — the SDK's message stream is the whole interface.
  - Permissions: SDK `canUseTool` → a structured tap-to-approve. Plan mode = SDK permission modes,
    with `ExitPlanMode` mapped to a plan request.
  - Slash commands: the SDK's `supportedCommands()` list, with `/rewind` special-cased. Resume via
    SDK `resume`.
  - Known SDK gaps, from Paseo's own `agent/agent-sdk-capabilities.md`: `query()` is per-call, not a
    long-lived session object, so Paseo wraps its own state; no session manifest, so persistence is
    Paseo's job (it keeps the `session_id`); no sandbox/approval tiers, only `permissionMode` plus
    rules. (Notes written against SDK 0.1.37 — the file may lag the SDK.)
- **Other agents**: Codex via `codex app-server` JSON-RPC, OpenCode via `@opencode-ai/sdk`, ACP
  adapters for Copilot, Cursor, Kimi, Kiro and Trae, and a Pi provider.
- **Phone UI**: its own chat UI. xterm.js appears only for separate shell terminals, never for the
  agent.
- **Transport**: WebSocket direct, or a Paseo-hosted relay with E2E encryption (Curve25519 + NaCl
  box) paired by QR; SSH tunnel and Tailscale are documented alternatives. `SECURITY.md` states that
  replay protection **within a live session is not implemented** (random nonces, no counters). By
  default anyone who can reach the listen address can connect; a password is optional.
- **Also**: native iOS/Android/desktop apps, web, CLI, voice, plugins, schedules, git worktrees,
  push notifications.
- **Cost and limits**: per-turn usage is real — `AgentUsage` carries input/cached/output tokens,
  `totalCostUsd` and context-window used/max (`agent/agent-sdk-types.ts`), straight from the SDK's
  result message. Not found in a grep of the clone: any Claude *usage-limit* handling (banner,
  reset, resume) — an account-level fact the SDK stream does not obviously hand over — or any
  cross-conversation history like `tokenstats.ts`. Unverified beyond grep.

**What it has that waterplane does not**: everything on the platform list above (iOS, native desktop,
voice, plugins), many more agents, a relay that works with no VPN, and a permission dialog that is
data rather than a screen scrape.

**What structured costs**: nothing the CLI draws is free. A TUI feature that is not in the SDK's
event stream (a new dialog, `/context`, a hook-driven loop, a plugin's own UI) either arrives late,
arrives re-implemented, or does not arrive; that is the "re-implement it" road CLAUDE.md rules out.
**What structured gains**: no heuristics. waterplane's choice-box, question and limit detectors
(`heuristics`) exist only because the truth is on a rendered screen; Paseo reads it as a typed
event and cannot mis-detect it.

## Part 2c — Anthropic's own options

Added 2026-10-02. Read from Anthropic's Claude Code docs on that date (the docs move weekly; every claim
below is the page as fetched, not source code). This is the competitor that matters most: it is the
vendor, it is included in the plan, and **it closes more of the gap than the earlier parts of this file
admitted.**

### 2c.1 Remote Control — a local session, driven from the Claude app

[Remote Control](https://code.claude.com/docs/en/remote-control) connects claude.ai/code or the Claude
app on iOS and Android to a Claude Code session running on your machine; "Claude keeps running locally
the entire time, so your code execution and filesystem access stay on your machine."

- **What it is**: the real local `claude` process with a remote window onto it. Started with
  `claude remote-control`, `claude --remote-control` or `/remote-control` (CLI, Desktop app, VS Code).
  Server mode runs several sessions from one process. A web search summary of the same docs mentions a
  September 2026 "device card" in the app's Code tab that starts a session on a chosen machine; not
  verified on the page itself.
- **Transport**: outbound HTTPS only, no inbound port; the session "registers with the Anthropic API
  and polls for work", over TLS through Anthropic ([docs](https://code.claude.com/docs/en/remote-control)).
  It is a relay, but the vendor's: **"the session transcript … is stored on Anthropic servers"** while
  connected. No VPN or tailnet needed. Optional Trusted Devices (biometric step-up, 18 h sign-in age).
- **Trust surface**: Anthropic, which already sees your prompts. Needs a claude.ai login on Pro, Max,
  Team or Enterprise; **API keys, Bedrock/Vertex/Foundry and any `ANTHROPIC_BASE_URL` gateway are not
  supported**; Team/Enterprise need an owner to switch it on.
- **Agent view**: claude.ai's own chat UI, not a terminal. Permission prompts and `AskUserQuestion` are
  forwarded and held open; other forwarded dialogs expire after five minutes by default. Terminal-only
  commands (`/plugin`, `/resume`) do not work from the phone; `/compact`, `/clear`, `/context`,
  `/usage`, `/mcp`, `/config` and a few more do, with pickers reduced to text or arguments
  ([limitations](https://code.claude.com/docs/en/remote-control)). Permission modes from the app are
  Manual, Accept edits and Plan; no Bypass, no Auto ([mobile page](https://code.claude.com/docs/en/mobile)).
- **Images in**: yes — "attach a photo or file … Claude sees attached photos directly"; photos are also
  saved under `~/.claude/uploads/`, other files are downloaded and passed as `@` references
  ([mobile page](https://code.claude.com/docs/en/mobile)). **Images out** (a screenshot the agent made,
  shown on the phone): not found in the pages read **?**.
- **Local builds**: yes, in the sense that it is your machine and your toolchain. **Getting the result
  back to the phone** (an APK to install, a file to download): no documented path in the pages read.
- **Scheduling**: separate features. `/loop` is session-scoped, fires only while Claude Code is running
  and idle, and recurring tasks expire after seven days; Desktop scheduled tasks fire only while the app
  is open and the machine awake, and a run slept through is skipped with one catch-up on wake
  ([scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks),
  [desktop](https://code.claude.com/docs/en/desktop-scheduled-tasks)). Nothing in those pages ties a run
  to a usage-limit reset (not found).
- **Cost visibility**: `/usage` and `/context` work from the phone as text. No cross-session history or
  per-turn cost surface is described (not found).
- **Offline**: "Claude Code reconnects automatically when your machine comes back online." What the
  phone does with words typed while offline, and any exactly-once guarantee: not described **?**.
  Server mode gives up after roughly ten minutes of network outage and the process exits.
- **Push**: yes, through the Claude app, "when Claude decides" or when action is required.
- **Platforms**: iOS, Android (the Claude app), any browser. Host side: CLI, Desktop, VS Code.
- **Price**: included in the plan; no extra charge described.
- **Maturity**: first-party and moving fast (server mode, trusted devices, `--chrome` on one page).

- **Hands-on (the author, 2026-10-02)**: usable, but not pleasant for long work, and simple things are
  missing — starting a NEW session on a repo from the phone was not possible in the author's use (the
  "device card" above, if it exists, would change that; unverified).

**Not either/or.** waterplane can launch every session it spawns with `--remote-control` — the launch
option "Remote Control" in Settings (`SettingsSheet.tsx`), passed as the flag by `backends/claude.ts`;
the host captures the claude.ai session link when it appears (`sessions.ts`). Switched on, the same
local session is reachable from waterplane *and* from the Claude app at once: start sessions, read,
build and schedule from waterplane; glance or answer from the Claude app when that is the app already
open. waterplane's own path still needs no Anthropic relay; the Remote Control path, when on, goes
through Anthropic as described above.

Also first-party and adjacent: **Dispatch** (message a task from the app to the Desktop app, Pro/Max
only) and **Channels** (Telegram, Discord or iMessage into a local CLI session), both on the
[mobile page](https://code.claude.com/docs/en/mobile).

### 2c.2 Claude Code on the web — cloud sessions

[Cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web) run on Anthropic's
infrastructure (or an organisation's self-hosted runners on Team/Enterprise), started from claude.ai/code,
the Claude app's Code tab, the Desktop app, `claude --cloud` or routines.

- **Transport / trust**: nothing of yours runs locally; a repo is cloned from GitHub (or uploaded as a
  bundle under 100 MB); credentials stay behind an Anthropic proxy. Needs a claude.ai account plus
  GitHub; **no API key, no Bedrock/Vertex, nothing under Zero Data Retention**.
- **Agent view**: claude.ai's chat UI; text-output commands only (`/compact`, `/context` yes;
  `/clear`, `/plugin`, `/resume` no).
- **What it can build**: an Ubuntu 24.04 x86_64 VM with Java 21, Gradle, Node, Docker, Python and more
  ([installed tools](https://code.claude.com/docs/en/cloud-environments)). **No Android SDK is in the
  pre-installed list**; a setup script could add one **?** (developer.android.com is on the default
  allowed domains). Not your Garmin SDK, not a licensed or hardware-attached toolchain. A foreground
  command waits 2 minutes by default, 10 at most, before moving to the background.
- **Scheduling**: [routines](https://code.claude.com/docs/en/scheduled-tasks) — cloud, one-hour minimum
  interval, fresh clone, no local files. Not usage-window-aware in anything read.
- **Cost**: "cloud sessions share rate limits with all other Claude and Claude Code usage … There is no
  separate compute charge for the cloud VM" ([limitations](https://code.claude.com/docs/en/claude-code-on-the-web)).
- **Platforms**: web, iOS, Android, Desktop, terminal. Pro, Max, Team, Enterprise with seats.
- **Where it wins**: runs with your laptop shut, parallel tasks, PR auto-fix, sharing, no setup beyond
  GitHub. It is the right answer for a GitHub repo whose build runs on a stock Linux box.

## Part 2d — SSH + tmux from a phone terminal app (the DIY baseline)

What most people do first, and the honest benchmark for "real CLI fidelity": Tailscale, a terminal app
and tmux, optionally Mosh ([walk-through](https://dev.to/shimo4228/running-claude-code-from-iphone-via-ssh-tmux-4c10),
[another](https://redock.dev/blog/run-claude-code-phone-ssh-tailscale-tmux/)).

- **Transport**: SSH, usually over Tailscale; Mosh in Blink keeps the connection across network changes
  ([Blink](https://blink.sh/), [Blink + Tailscale + Mosh](https://docs.blink.sh/integrations/tailscale+mosh)).
  tmux keeps `claude` alive when the phone disconnects.
- **Trust surface**: your own SSH keys and host; no account beyond the terminal app and Tailscale. An
  sshd reachable from the tailnet is a full shell, not a scoped API.
- **Agent view**: the raw TUI, as exact as it gets — on a phone keyboard. Nothing is detected, queued,
  summarised or notified: no tap-to-answer boxes, no reader, no push when it finishes, no send queue.
- **Images**: no built-in path; file transfer is SFTP in the app ([Blink](https://blink.sh/),
  [Termius](https://termius.com/pricing)), by hand.
- **Platforms and price**: [Blink Shell](https://blink.sh/) is iOS/iPadOS, open source, 2-week trial then
  $19.99/yr. [Termius](https://termius.com/pricing) is iOS, Android, macOS, Windows, Linux; free Starter
  tier (local vault, SSH, SFTP), Pro $10/month billed annually.
- **Where it beats waterplane**: nothing to trust beyond sshd and tmux, works on iOS today, exact
  fidelity with no heuristics. **Where it loses**: everything in Parts 1.3–1.6 — and a prompt typed
  into a TUI when the link drops mid-send has no ledger behind it.

## Part 2e — VibeTunnel

MIT, [github.com/amantus-ai/vibetunnel](https://github.com/amantus-ai/vibetunnel), ~4.7k stars, read
2026-10-02. Latest release read: 1.0.0 Beta 18, 2026-07-11 ([releases](https://github.com/amantus-ai/vibetunnel/releases))
— a quarter old and still beta, though the repo shows 2,000+ commits and no archive notice.

- **What it is**: "turn any browser into your terminal" — a macOS app or npm server that proxies
  terminal sessions into a browser (ghostty-web). **Agent-agnostic**: the docs page read has nothing
  Claude-specific ([intro](https://docs.vibetunnel.sh/docs/introduction)).
- **Transport / trust**: Tailscale recommended; ngrok, Cloudflare tunnels, Pinggy and Pangolin also
  documented; auth by system login, SSH keys or env settings. The docs claim end-to-end encrypted
  sessions **?** (marketing copy, not checked).
- **Platforms**: macOS (Apple Silicon), Linux/Docker via npm, any browser. The README calls an iOS app
  work in progress; no store listing found.
- **Agent view**: a terminal in a tab — SSH-level fidelity, none of waterplane's detection, queue,
  reader, builds or cost layer.
- **Price**: free.

## Part 2f — Omnara

[github.com/omnara-ai/omnara](https://github.com/omnara-ai/omnara), Apache-2.0, ~2.9k stars; last
release read 2026-10-01 (omnarad v0.1.32). Read 2026-10-02.

- **It has moved.** The repo and [omnara.com](https://www.omnara.com/) now describe an open-source
  platform for running agents on any model and machine — "the open-source alternative to Claude Managed
  Agents": a Go backend, Postgres state, React dashboard, Slack connector, sandbox providers (Blaxel,
  Daytona, Modal …), cloud or self-hosted. The "Claude Code in your pocket" wrapper people remember
  (`pip install omnara`, [Show HN](https://news.ycombinator.com/item?id=44878650)) is not what the front
  page now describes.
- **Mobile**: an [iOS app](https://apps.apple.com/app/id6748426727) is listed — "Omnara: Claude & Codex
  Mobile", free, v2.0.5 on April 7, with cloud sync, local handoff, live localhost previews and voice —
  and an [Android listing](https://play.google.com/store/apps/details?id=com.omnara.app) exists (title
  only; the page was not readable). Whether it still drives a *local* session, and over what transport,
  is **?** — the release notes read do not mention it.
- **Trust surface**: Omnara Cloud (account, hosted state) or self-hosted Docker Compose.
- **Price**: platform free; model usage and compute are credits on Omnara Cloud; self-hosting has no
  platform fee ([omnara.com](https://www.omnara.com/)).
- **Do not cite it as like-for-like** without re-checking what the app connects to: what the repo now
  describes is a hosted agent platform, not a window onto your own desktop.

## Part 2g — Orca

MIT, [github.com/stablyai/orca](https://github.com/stablyai/orca); the page read shows ~83.8k stars and
"we ship daily". Read 2026-10-02. **The closest new neighbour found.**

- **What it is**: a desktop "agent development environment" (macOS, Windows, Linux) that runs many
  coding agents — Claude Code, Codex, Cursor and others — in parallel git worktrees on your own
  subscriptions, plus a mobile companion.
- **Mobile** ([docs](https://www.onorca.dev/docs/mobile)): iOS on the App Store, Android as a GitHub
  Releases APK (0.0.50); beta; "a remote control for the desktop you already have running". It offers a
  **raw terminal view with scrollback and a chat UI** for Claude, Codex and recognised agents, a file
  tree, a source-control view (stage and commit), replies by typing or dictation, **attached
  photos/files**, saved Quick Commands, **account switching with usage and rate limits**, and push
  notifications. It deliberately excludes full editing.
- **Transport / trust**: pairing by a one-time code from the desktop, then **Orca Relay (needs sign-in)
  or the local network**. Encryption and the relay's trust model: not stated in the page read **?**.
- **Agent view**: both a terminal and a parsed chat; how the chat is derived (SDK, log or screen) **?**.
- **Not found** (two docs pages, not source): a build runner, artifact gallery or APK install,
  usage-window scheduling, token history, an offline send queue.
- **Price**: free and open source; agents on your own subscriptions.

## Part 2h — CloudCLI (Claude Code UI)

AGPL-3.0, [github.com/siteboon/claudecodeui](https://github.com/siteboon/claudecodeui), ~13.9k stars,
last updated 2026-09-08 per a web search; read 2026-10-02.

- **What it is**: a responsive web UI over `~/.claude` for Claude Code, Cursor CLI, Codex and OpenCode:
  sessions, file editing, git, plugins. Self-hosted via npm or Docker (Node 22+), or hosted CloudCLI Cloud
  "from €7/month". Claude's tools are disabled by default until enabled.
- **Transport / trust**: self-hosted means opening `ip:port` on your network; no auth boundary is
  documented in the page read **?**. The hosted tier works without a VPN. This is the opposite bet from
  "Tailscale identity is the boundary" and should be compared as such.
- **Agent view**: "reads from and writes to the same `~/.claude`"; whether it drives the CLI in a PTY or
  the Agent SDK **?**.
- **Platforms**: any browser; no native app found.
- **Not found**: builds, artifacts, scheduling, cost history, an offline queue.

---

## Part 3 — the comparison

### 3a — Happy vs Paseo vs waterplane (detail)

| | **Happy** | **Paseo** | **waterplane** |
|---|---|---|---|
| **Transport** | Relay server, E2E encrypted. Works on cellular, no VPN | Direct WS, or hosted relay with E2E (NaCl box), QR pairing; SSH/Tailscale possible. No in-session replay protection | Tailscale direct; no third party ever sees bytes. Needs a tailnet |
| **Trust surface** | Their server (or self-host it) + an account | Their relay (optional) or direct; default is open to anyone reaching the port, password optional | Your machine only. Network identity is the auth boundary |
| **Agent view** | Structured message stream from the agent SDK **?** | Structured: Claude Agent SDK events into Paseo's own chat UI. No PTY (`providers/claude/`) | Real PTY, xterm.js — slash commands, context meter, plan/trust prompts native |
| **Permissions / plan mode** | ? | SDK `canUseTool` and permission modes: typed, no detection | Choice boxes read off the screen and answered by tap; heuristic, tracked by `clihealth.ts` |
| **Slash commands** | ? | `supportedCommands()` list; `/rewind` special-cased | All of them, because it is the CLI |
| **Platforms** | iOS + Android + web + macOS | iOS + Android + web + desktop + CLI | Android APK + PWA (the PWA is the iPhone route, untested on a real one). **No native iOS app** |
| **Agents** | Five-ish | Claude, Codex, OpenCode, Copilot, Cursor, Kimi, Kiro, Trae, Pi | Claude + opencode |
| **Voice** | Yes | Yes | Dictation only (`dictate.ts`, `useVoice.ts`) — not hands-free |
| **Device handoff** | One keypress, state carried | Not a concept found | Not a concept — sessions live host-side and are always live |
| **Offline queue** | Unknown **?** | Not found | Single send path, durable, at-most-once, 500-row cap, failed rows kept for ever |
| **Builds** | Not a feature | Not a feature (worktrees, schedules yes) | Token-free build runner, artifact detection, build discovery off manifests |
| **Screenshots / artifacts** | Not a feature | Not found | `.claude/outbox/` gallery, thumbnails, annotator, collage, verified capture loop |
| **Token / context cost** | Not surfaced | Per-turn tokens, `totalCostUsd`, context window from the SDK result; no history found | First-class: per-turn cost, per-desktop history, per-repo context weight |
| **Usage-limit handling** | Not surfaced | Not found | Banner + reset parsed, group-blocked, resurrected with `--continue` |
| **Repo tooling** | — | Git worktrees, plugins | Discovery, git, worktrees, file browser, setup compliance with remedies |
| **Scheduling / fan-out** | — | Schedules | Durable intents: run later, run across N repos, sweeps |
| **Notifications** | Push, cross-platform | Push | Web Push (VAPID, no account) in the browser; a foreground service in the APK |
| **Maturity** | Public, contributors, forks | Public, ~19k stars, v0.10.2, one maintainer + bots | One user |
| **Licence** | MIT | Apache-2.0 | (not released) |

### 3b — the matrix across everything compared (2026-10-02)

Rows are the ones the demo plan §4 asked for. Every cell is backed by the section named in its column
header; **?** means not established, `—` means looked for and not found (a statement about the pages
or grep, not proof of absence). Omnara is left as mostly **?** on purpose: see 2f.

| | **waterplane** | **Claude Remote Control** (2c.1) | **Claude on the web** (2c.2) | **Happy** (2) | **Paseo** (2b) | **Orca** (2g) | **SSH + tmux** (2d) | **VibeTunnel** (2e) | **Omnara** (2f) | **CloudCLI** (2h) |
|---|---|---|---|---|---|---|---|---|---|---|
| **Real CLI fidelity** | Real PTY, real TUI | Real local process, claude.ai chat UI; terminal-only commands unavailable | Real CLI in a cloud VM; chat UI, text commands only | ? (SDK, unverified) | No: Agent SDK events, no PTY | Terminal view and a chat UI; how chat is derived ? | Exact (raw TTY) | Exact (browser terminal) | ? | ? (web UI over `~/.claude`) |
| **Runs on your machine** | Yes | Yes | No (Anthropic VM, or org self-hosted) | Yes (wrapper) | Yes (daemon) | Yes (desktop host) | Yes | Yes | ? (platform now hosted or self-hosted) | Yes if self-hosted |
| **Images in / out** | In and out: upload, outbox gallery, annotator | In: yes. Out: ? | ? | ? | ? | In: attach photos/files. Out: ? | No built-in path (SFTP by hand) | — | ? | ? |
| **Read mode** | Yes, offline-cached reader | — | — (chat UI only) | ? | Chat UI | Chat UI beside terminal | No | No | ? | Web UI |
| **Build + install an APK** | Yes: token-free build runner, artifact detection, install | Builds run locally; no documented way back to the phone | No Android SDK pre-installed; ? via setup script | — | — | — | By hand | — | — | — |
| **Schedules against usage windows** | Yes (limit reset parsed, resume at reset) | Scheduling exists; no usage-window link found | Routines exist (1 h minimum); no link found | — | Schedules exist; limit handling — | Shows usage and rate limits; scheduling ? | No | No | ? | — |
| **Token / cost history** | Yes: per-turn, per-desktop history | `/usage`, `/context` as text; no history found | Shared rate limits; no history found | Not surfaced | Per-turn tokens and cost; no history found | Usage and rate limits in app; history ? | No | No | ? | — |
| **Repo health** | Yes (context weight, setup compliance) | — | — | — | — | Source-control view; health — | No | No | ? | Git UI |
| **Offline exactly-once queue** | Yes (ackIds, 500-row cap) | Reconnects after sleep; queue ? | ? | ? | — | ? | No (Mosh keeps the link, not a ledger) | — | ? | — |
| **iOS** | Web app only (untested on a real iPhone) | Yes | Yes | Yes | Yes | Yes | Yes (Blink iOS; Termius iOS and Android) | WIP, none listed | Yes (App Store) | Browser only |
| **Relay / account needed** | None; Tailscale only | claude.ai account (not API key); Anthropic relay; transcript stored there | claude.ai account + GitHub | Relay server (self-hostable) + account | Optional relay; direct possible | Orca Relay (sign-in) or local network | None beyond SSH (+ Tailscale) | None; Tailscale or tunnels | Omnara Cloud or self-host | None self-hosted; account for Cloud |
| **Price / licence** | One user, not released | Included in plan | Included in plan | MIT, free | Apache-2.0, free | MIT, free | Blink $19.99/yr (open source); Termius free tier, Pro $10/mo | MIT, free | Apache-2.0; credits on Cloud | AGPL-3.0; Cloud from €7/mo |

What the matrix says in one breath: the row nobody else fills is **build + install an APK**, and the
cluster of **usage-window scheduling, cost history and the offline queue** is where waterplane is alone
in everything read. The rows where waterplane stands alone are fewer than Part 1's heading claimed
(see Part 0); the rows where it loses (iOS, relay-free reach, polish, users) are real.

---

## Part 4 — where each one wins

**Happy solves access.** Reach your agent from anywhere, safely, on any phone, with your voice.
Broad, polished, and the correct choice for most people.

**Paseo solves breadth.** Every agent, every device, one app, with a permission dialog that is
typed data. It is the strongest of the three if you want many agents behind one UI and are content
that the agent is whatever the SDK's event stream can express.

**waterplane solves working.** Build the APK, look at the screenshot, see what the session costs, push the
branch. It bets that the phone is a workstation, not a remote control.

**Anthropic solves it for free, first-party.** Remote Control is the baseline every other row is now
measured against: the real local session, photos in, push, no VPN, no install beyond the Claude app.
Choose it if you have a Pro/Max plan, want a chat window onto a running session, and do not need an
artifact back or a limit-aware queue. Cloud sessions win when the repo is on GitHub and its build runs
on stock Ubuntu: it keeps going with your laptop shut.

**SSH + tmux solves it with nothing new to trust**, on iOS today, at exact fidelity — and with no help
at all once a phone keyboard, a flaky link and a three-hour build are involved.

**Orca is the nearest in shape** (terminal plus chat, files, source control, photos, usage, relay or LAN,
both phone OSes) and has the scale (~84k stars) waterplane lacks. What was not found there is the build
and artifact loop, limit-aware scheduling and the offline ledger. VibeTunnel is a good terminal-in-a-tab;
CloudCLI is a web UI with a different security stance (open port or hosted); Omnara has moved to a
hosted agent platform.

The overlap in the parts that matter is close to zero. Paseo is nearer than Happy — it has worktrees
and schedules, and per-turn cost — but it is still a chat client over an SDK: no build runner, no
artifact channel, no limit-aware resume. Neither would help with a Garmin monorepo
or an APK loop at all — there is no build path and no artifact channel. That is a category gap, not
a feature gap.

**The fidelity trade, stated once.** Paseo (SDK/structured) and waterplane (real CLI in a PTY) are opposite
bets on the same risk. The SDK bet is robust to screen changes and blind to anything the SDK does
not emit; the PTY bet sees everything the CLI shows and pays for it in detectors that can miss. If
Anthropic's SDK grows to cover the TUI, Paseo's side of the bet gets cheaper; if the TUI keeps
gaining surface faster than the SDK, waterplane's does.

**waterplane's honest weak spots**, in order:

1. **No native iOS app** — iPhone gets the web app only, not yet tested on a real one. Happy's Expo choice is why they have it; Paseo has it too.
2. **Single-user, single-machine.** No team story, no handoff, no shared session.
3. **Tailscale is both the moat and the onboarding cliff.**
4. **Distribution is zero.** No landing page, no store listing, no community.
5. **Platform risk — no longer hypothetical.** Anthropic already ships the phone surface for a local
   session (Remote Control: photos in, push, `/usage`, permission prompts, scheduled tasks). PTY
   fidelity and the build/artifact/limit loop are defensible; "notify me when it's done" and "answer a
   prompt from the phone" are not.
6. **Reach.** The vendor's, Happy's and Orca's relays work with no tailnet; waterplane needs one.
7. **Scale.** Orca ~84k stars, Happy ~24k, Paseo ~19k, CloudCLI ~14k; waterplane is one user.

---

## Part 5 — the relay question, and why the answer is no

*(Written against Happy; Paseo offers the same choice, with a direct/relay switch. Its `SECURITY.md`
admits no in-session replay protection — the very item on the list below that a relay must have.)*

The obvious lesson to take from Happy is "add a relay so the app works when the tunnel does not".
Working through it, that is wrong, and the reasoning is worth keeping.

**A relay only wins one narrow band.** Phone offline entirely — the most common case — a relay does
not help, because it needs internet too. UDP blocked on hotel wifi — already solved, Tailscale's
DERP falls back to TCP:443. Node key expired, Tailscale killed by the battery optimizer, host asleep
— a relay fixes none of those. What is left is: phone online, host online, tailnet will not form.
Rare, because DERP *is* a relay and already ships.

**And that band is mostly absorbed already.** The offline queue means a bad tunnel costs you
latency, not work: you keep typing, it flushes on reconnect. The APK keeps its shell locally. The
reader still works from the offline cache. The link store already says which failure it is.

**Against that, the cost is the one sentence the security model rests on.** Today a mistake in the
auth path is reachable only from your own tailnet. With a relay, a mistake is reachable from the
internet, and the thing behind it spawns `claude`. That is remote code execution on the laptop, not
a UI glitch.

**If it is ever built anyway**, these are non-negotiable and are recorded here so the reasoning does
not have to be redone:

1. The host dials out and never listens — "never bind a public interface" stays literally true.
2. The relay carries ciphertext only. AEAD with a monotonic counter for replay protection. It is
   treated as hostile, not honest-but-curious: it may drop and reorder, it must never inject.
3. No default relay host. Blank until set — shipping a default URL is shipping a default trust
   decision.
4. Pairing is out-of-band and one-shot: a QR on the desktop terminal, yielding a long-lived keypair.
   Never a password, never a pasteable URL.
5. It is not a second socket. Same protocol, same queue, same ackIds, different carrier.
6. `origin.ts` is not loosened to accommodate it. Over a relay there is no meaningful `Origin`; the
   session key *is* the identity, and that is a separate branch in `auth.ts`.
7. Off by default, explicit env, and the UI says when it is on.

**The push beacon needs no new service either.** `host/src/push.ts` is Web Push over VAPID: keys
generated by this host into `.waterplane/vapid.json`, no account anywhere, payloads encrypted end-to-end
so the vendor's push service sees an endpoint, a ciphertext and a timestamp. It is one-way and
outbound-only, so it adds no listener and no auth surface — and its delivery path is host → vendor →
phone, which needs the *host* to have internet, not the tunnel to form. It already survives the
failure a relay was being considered for.

### What shipped instead (2026-09-13)

**1. `doctor.ts` now checks the Tailscale node key.** Keys are good for 180 days by default, and
when one lapses the machine simply drops off the tailnet — from the phone that is indistinguishable
from the host being asleep, the daemon being dead, or bad wifi. Every other symptom the report
covers announces itself somewhere; this one announces itself six months after the decision that
caused it. The check reads `tailscale status --json`, warns at 14 days or on an already-expired key,
and returns **null** — an absent row, not a green one — when there is no tailnet, no CLI or an
unparsable answer. It can only speak for this machine, so the fix names the phone too.

**2. The APK now says it has no OS push of its own — and a dead control was removed.** This was a
real bug, not a wording gap. `main.tsx` deliberately registers no service worker in the native shell,
but the WebView still exposes `navigator.serviceWorker`, so every feature test in `push.ts` passed
and `await navigator.serviceWorker.ready` then waited on a registration that was never coming — a
promise that never settles, not a rejection. The settings row therefore sat at its initial `off`,
which reads as an invitation, and tapping it hung in the same place: no toast, no change, no error.

`pushStatus()` now returns `"native"` in the shell, ahead of the secure-context test (which the
shell *passes* — so `"insecure"` would have been a wrong reason for a right refusal, offering a fix
that does nothing). The row is now a sentence rather than a switch, and it says the thing that
actually matters: alerts in the APK come from the background link, which talks to the desktop over
Tailscale, so a tunnel that is down is a phone that says nothing — **and quiet here does not mean
nothing happened**. Anything sent meanwhile arrives when the link returns. For alerts that survive a
dead tunnel, install the PWA from the host's HTTPS name; the desktop posts those out over ordinary
internet.

**What was deliberately not built:** the relay (above), and FCM in the APK. FCM would mean a
Firebase project, a Google account and a config file in the build — exactly the account-and-trust
cost that VAPID exists to avoid, and worse, because without web-push encryption the payloads would
be readable by the vendor.
