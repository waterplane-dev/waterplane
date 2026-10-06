# waterplane

**The CLI wasn't built for your phone. waterplane lands it anyway.**

waterplane drives the real **Claude Code** CLI on your own desktop from your phone, over Tailscale:
the actual terminal, a reader view of the same session, and what the desktop builds and screenshots
sent back to the phone. No waterplane server, no account, no telemetry; waterplane keeps nothing of yours anywhere but your machine.

![The real claude terminal on a phone, flipped to the reader and back; a screenshot arrives, is marked up and sent back; what the prompt cost](docs/media/first-look.gif)

- **The real CLI, not a re-implementation.** Every slash command, plan and trust prompt and the
  context meter work as at the desk; choice boxes come up as buttons.
- **The loop comes back to the phone.** Screenshots and builds land in a gallery; mark one up and it
  goes back into the prompt. Build an APK from the phone without spending a token.
- **Work around the usage limits.** Queue prompts for after the reset, give a session a budget, and
  see what every turn cost and what the next one will.

[Try the demo](https://waterplane-dev.github.io/demo/) · [Install](#quickstart) ·
[How it compares](#how-it-compares) · [Security](SECURITY.md) · MIT

**Desktop:** macOS first (it is built and used daily on a Mac), Linux, Windows through WSL2.
**Phone:** the Android app, or the web app added to the home screen of any phone browser. iPhone
runs the web app; there is no native iOS app yet, and iPhone is the least-tested phone.

**Why not Anthropic's Remote Control?** Use both: it puts a running session in the Claude app.
waterplane starts sessions on any repo, brings builds and screenshots back, schedules against the
usage windows and shows the cost. [The honest comparison](#how-it-compares).

## How it works

![Your phone talks to your own desktop over Tailscale: the waterplane daemon runs the real claude CLI in a terminal on your repos, and sends the screen, screenshots and builds back](docs/assets/flow.svg)

A small Node daemon on your machine spawns the real `claude` binary in a pseudo-terminal and bridges
it to a phone app (a web app you add to the home screen, or an Android app). Because it drives the
actual binary rather than re-implementing it, every slash command, `/btw`, the context meter, plan
and trust prompts and `--continue` work as they do at the desk. It is the same session, rendered
somewhere else.

It drives Claude Code first and foremost (opencode support is experimental), and it needs the
`claude` CLI installed and signed in on the desktop. waterplane does not bring its own.

**The daemon runs `claude`, which can run code on your machine, and the network is the only lock:**
it binds loopback and your Tailscale IP, never a public interface. Read
[the warning at the start of the Quickstart](#quickstart).

## Try it without a desktop

**[Open the demo in your browser](https://waterplane-dev.github.io/demo/)**, best on a phone. It
runs entirely in the page: no install, no account, no network requests.

The app also has the same demo built in: a pretend desktop with three fictional repos and a session already at
work. Nothing connects and nothing runs. In the Android app tap **Try the demo** on the first
screen; in a browser add `?demo=first-look` to the app's address, or open Settings, search "demo"
and tap **try the demo**. A line at the top says it is a demo, how to leave, and has a **What to
try** list of the headline features.

For each feature one screen at a time, with a short film of each, see
[A tour of waterplane](docs/guide.md). Every gif here is made by a script from that demo, with
fictional data, and redrawn from the current code.

## Highlights

### The real CLI, and a reader for the same session

The terminal is the real `claude` TUI, streamed both ways. One tap turns the same session into a
reader: markdown rendered, thinking and tool calls folded, a find bar, a per-turn outline, and a
"N new since you left" mark. Scrolling, selection and find behave like a web page instead of a
terminal grid. When Claude stops on a choice box (Yes/No, tool approval, plan, trust), the options
come up as buttons. *(gif at the top of this page)*

### Screenshot, mark it up, send it back

![A screenshot Claude saved appears on the phone; open it, mark it up, send the note back](docs/media/gallery-and-files.gif)

What Claude leaves in `.claude/outbox/` appears on the phone as a picture or a file, with a badge on
the repo and a notification. Open it full size, draw a circle or a box on it, type what to change,
and the marked-up image goes back into the prompt (it lands in `.claude/inbox/`). Swipe a
highlighter over a line of text in a screenshot and, if you have set a Gemini key, the words are read
out of the crop so the prompt carries them verbatim.

### Build an APK, and other phones install it by themselves

*Android app developers only (optional).*

![Phone one circles a spot on a screenshot of the app, Claude Code adds a logo there, the build runs, phone two's notifications say the build succeeded and the update is ready to install, one tap on Install updates it, and it opens with the logo in the circled spot](docs/media/apk-install.gif)

Save a build command per repo and run it from the phone without a Claude session, so it spends no
tokens; it is the way out when you are rate limited and still need a build. Produced files are
detected and downloadable. With the developer build of the Android app, a phone you opt in installs
each new APK of your app by itself, and the build sheet says on which phones it landed.

### Schedule against the weekly window

![A prompt waits behind a running turn, then runs; schedules and the backlog at a glance](docs/media/queue-and-schedule.gif)

Post a prompt for later: at a time, when the session goes quiet, after another one finishes, or
anchored to a usage-limit reset ("right after the weekly window comes back", "two hours before the
reset, spend what is left"). A prompt sent while you are offline or while the session is busy waits
in a queue and is typed in exactly once. The Backlog holds a repo's work that nobody has started.

### Know what it costs

![The usage windows, what the budget says about them, a session's context window, the token ledger](docs/media/numbers.gif)

Every finished turn says what it cost: tokens in, out and cached, and dollars at list price, plus
what the *next* turn will cost compared with a fresh session. The token ledger splits every total by
day, repo and model; the header carries the 5-hour and weekly usage windows with their resets; each
session has a context sheet showing how full the window was over time and where it compacted. A
per-repo check weighs `CLAUDE.md` and skill descriptions, the part every turn pays for again. All
read off the CLI's own logs and screens; where there is nothing to read, nothing is shown rather
than a guess.

### Repo health

A repo's health tiles track, commit by commit: the p95 file length, how often the same files are
touched again, escape hatches (suppressions such as `eslint-disable` or `as any`), untested modules and the `CLAUDE.md`
weight, each with its trend. The numbers are only readings: nothing changes code on its own.

### Usage limit and session budget

![A session budget holds the next send before the usage wall; at the reset the session continues](docs/media/limit-and-budget.gif)

Give a session a budget (tokens, dollars, or a share of the 5-hour or weekly window) and the next send is held when it is reached, before the
usage wall, with your words kept and the reason said. When a session does hit a Claude usage limit,
the host notices, waits for the reset and continues it, reopening the conversation with
`--continue` if the CLI exited. Bounded retries, and an off switch per session and for the desktop.

## Everything else

| Area | Feature |
| --- | --- |
| Drive | Every slash command (built in and your own `.claude/commands`), plan and trust prompts, `/btw`: it is the CLI. |
| Drive | One-tap answers to choice boxes. |
| Drive | Push-to-talk dictation. The desktop transcribes it with whisper.cpp when installed (no audio leaves your machine); otherwise the phone's speech recogniser. |
| Drive | Fork a session from any turn; fan out one prompt to several repos, a fresh session in each. |
| Drive | Model, effort and permission mode per session. Approval-free modes ask for an explicit confirmation. |
| Drive | Remote Control on by default if you like: every session waterplane starts also runs with `--remote-control`, so it shows up in the Claude app in parallel. |
| Drive | Sessions on any repo, worktree or branch; sessions started in your own terminal are listed too. Every session runs inside tmux, so it survives a host restart or an update live. |
| Away | Backlog items that fire when a session goes quiet, in one session or each in its own worktree. |
| Away | Offline send queue: sent exactly once, never lost. |
| Away | Builds without a session (no tokens). |
| Away | Notifications when a session needs you, finishes, or leaves a file: Web Push over HTTPS in the browser, a background link in the Android app. No account. |
| See | Gallery with pinch-zoom; markdown and text rendered in place; pull any file to the phone. |
| See | Search a session's output and prompt history; an archive of past conversations; a log of everything sent. |
| Ship | Git: coloured diffs, stage, commit, branch create/switch/delete, push. |
| Ship | New folder, project or worktree from the phone. A new project starts with `git init` on `main`, a `CLAUDE.md` that tells the agent to put what you should see in `.claude/outbox/`, and the inbox and outbox. |
| Machine | Several desktops in one app; a paired peer desktop can take a delegated job and report back. |
| Machine | The app's UI updates over the air from your desktop; a new APK is needed only when the native shell changes. |
| Machine | CLI health: says when a screen-reading heuristic missed after a Claude Code update. |
| Machine | Speed test that tells you whether Tailscale gives you a direct link or a relay. |
| Machine | Secrets written from the phone into a gitignored `.env`, never shown back (plaintext on disk: convenience, not a vault). |
| Safety | Tailscale only (end-to-end encrypted, even when it falls back to its own relays). No waterplane server, no account. |

## How it compares

Anthropic's own Remote Control now drives a local Claude Code session from the Claude app, and Happy,
Paseo and Orca put coding agents on a phone too. Reaching your agent from a phone is not what is
different here. What is: the real terminal plus a reader, no vendor or relay in the path, the build
and artifact loop back to the phone, schedules against usage windows with an exactly-once queue, and
token and cost history with the next turn's price.

It is not either/or with Remote Control. Turn on the launch option "Remote Control" and every session
waterplane starts is also reachable from the Claude app: waterplane to start sessions on any repo,
read, build and schedule; the Claude app for a quick look when it is the app already open.

The short table is [docs/notes/compare-table.md](docs/notes/compare-table.md); the long, cited
version is [docs/notes/vs-competitors.md](docs/notes/vs-competitors.md). Where waterplane loses,
plainly:

- **No native iOS app yet.** iPhone gets the web app (not yet tested on a real iPhone); Android gets
  a native app as well.
- **One user.** No team, no shared sessions.
- **It needs a tailnet.** Tailscale on both ends is the security boundary and the first setup step.
- **Anthropic ships more of the phone surface every release**, and the TUI it reads can change.

## Built with waterplane

**ciqkit** is developer tooling for Garmin Connect IQ watch apps: a broker that makes the Connect IQ
simulator usable from scripts, CI and coding agents, plus static checks for watch screens. It and
the watch apps it serves were developed largely from a phone with waterplane: build on the desktop,
run it in the simulator, and get the verified screenshot in the phone's gallery. waterplane shells out
to ciqkit for those watch screenshots (`packages/host/src/capture/garmin.ts`) and never imports it.
It is an independent project, unofficial for Garmin, as waterplane is for Anthropic.

**[Boulder Tracker](https://apps.garmin.com/apps/337ab19f-3e57-476d-8a93-f1c414ac260e)** is a
Garmin watch app on the Connect IQ store that counts indoor boulder problems by itself from heart
rate and the accelerometer, with a companion web app for live sessions. It is closed source; it was
built, tested on the simulator and shipped to the store with waterplane, mostly from a phone.

**Little Painter** is a small Android app for children: brush, shapes that stay movable after the
finger lifts, a paint bucket, and a parent mode. It was written with waterplane, with the APK built
from the phone's build sheet.

## Quickstart

> ### ⚠️ Read this before you install it
>
> The daemon spawns `claude`, which can **read, edit, and execute files** on your
> machine. There is **no app-level login by default**: the security boundary is
> the network. Anyone who can reach the daemon can, in effect, use your computer.
>
> By default it binds only **loopback and your Tailscale IP**, and refuses to bind
> LAN or public addresses unless you explicitly set `WATERPLANE_ALLOW_PUBLIC=1` (which
> then requires a password for LAN devices). Keep it that way. Point it only at
> code you trust. [SECURITY.md](SECURITY.md) has the full threat model, and
> [DISCLAIMER.md](DISCLAIMER.md) covers what else you are agreeing to: arbitrary code
> execution, what leaves the machine when you pick a hosted model, and what a free tier
> is actually paid with.

> ### ℹ️ Unofficial
>
> Not affiliated with, endorsed by, or supported by Anthropic. This project ships
> no Anthropic code: it invokes the `claude` CLI you installed and are logged
> into. It works by wrapping that CLI's terminal, which means it reads TUI output
> with regexes and uses flags that **change between Claude Code versions**. Expect
> it to need updates when `claude` updates. Currently tested against `claude`
> **2.1.x**.
>
> waterplane is unrelated to any organisation of a similar name.

### Requirements

- **[Claude Code](https://claude.com/claude-code) installed and signed in.** Run `claude` once in a
  terminal and complete the login first.
- **[Tailscale](https://tailscale.com)** on the desktop and the phone, on the same tailnet. Without
  it the daemon binds loopback only and is reachable just from the desktop.
- **macOS (first-class: developed and used daily on a Mac) or Linux.** Windows only inside WSL2
  (native Windows is not supported).
- **tmux** (any recent version; 3.3 or newer). Every session runs inside it so it survives a host
  restart; without it the host refuses to start sessions. `brew install tmux` on macOS,
  `sudo apt-get install -y tmux` on Debian/Ubuntu/WSL (or your distribution's package manager). The
  installer offers to install it for you.
- **Node ≥ 20.12** for a source checkout.

### Install

A `curl | sh` installer (it brings its own pinned Node, verifies checksums, and adds a `waterplane`
command with `start`, `doctor`, `service`, `update` and `pair`) ships with the first public release;
see [docs/notes/distribution.md](docs/notes/distribution.md). Until then, from source:

```bash
git clone https://github.com/waterplane-dev/waterplane.git
cd waterplane
npm ci             # installs the lockfile exactly; runs no dependency install scripts
npm run doctor     # checks claude login, node-pty, tmux, Tailscale, HTTPS, port
npm run build
npm start
```

`npm run doctor` is the first thing to run and the first thing to re-run when something misbehaves.

**Where it keeps things.** Your repos stay where they are (`WATERPLANE_ROOT`, default `~/dev`), and
the host keeps none of its own state there. That state — the delivery ledger, sessions,
settings, schedules, push keys, LAN password, device tokens — lives in `~/.local/state/waterplane`
(`$XDG_STATE_HOME/waterplane` when that is set, or wherever `WATERPLANE_STATE_DIR` points); config and
secrets in `~/.config/waterplane`; downloaded models in `~/.local/share/waterplane`. A host that used to
keep its state in `<root>/.waterplane` moves it there on its first start and leaves a symlink behind;
`npm run doctor`'s `state` row says where it is. What belongs to one repo (its build commands, capture
targets, …) stays in that repo's own `.waterplane/`. Uninstalling removes the program and the service
and none of these: delete the three directories by hand to remove every trace.
It names which silent failure you are in (logged-out `claude`, no tailnet, a missing native module,
a busy port) and what to type to fix it:

```
  [ok  ] claude-binary   /opt/homebrew/bin/claude (2.1.224 (Claude Code))
  [fail] claude-login    claude is not signed in
                         → Sign in from the phone: open any session on this desktop, tap its
                           sign-in button, sign in in the browser, then tap paste code. (Or run
                           `claude` once in a terminal here.) Sessions stop at the sign-in
                           screen until then.
```

The host prints the URL it is listening on. Plain `http://100.x.y.z:8770` over Tailscale works for a
first look but is not a secure context (no install, push or clipboard), so set up the HTTPS address in
the next section and open **that** on your phone to add it to your home screen. To add another phone, **Settings → pair another phone** shows a
QR code; on a desktop with no screen, `waterplane pair` prints the link and code instead.

By default it scans `~/dev` for git repos and worktrees. Set `WATERPLANE_ROOT` if your code lives
elsewhere. **Everything under that directory is reachable from the phone**, so choose it deliberately.

### Notifications and the install prompt (recommended)

Web Push, service workers, "add to home screen" and clipboard access need a **secure context**:
HTTPS or localhost. Plain `http://100.x.y.z` over Tailscale is not one, so those features do nothing
there. Everything else works without it. To get them, front the daemon with Tailscale's HTTPS:

```bash
# one-time: enable HTTPS + MagicDNS in the tailnet admin console, then
tailscale serve --bg --https=443 http://127.0.0.1:8770
```

Then browse `https://<machine>.<tailnet>.ts.net` on the phone. `npm run doctor` stops warning once
it is in place.

### Or the Android app

[`packages/app`](packages/app/README.md) builds an APK that carries the same UI inside itself. Its
origin is `http://localhost`, a secure context, so it needs no `tailscale serve`; and its interface is
not on the network at all, so a reload or cold start while the tunnel is down lands in the working
app, with the send queue and drafts intact.

```bash
cd packages/app && npm install && npm run install-apk   # needs JDK 21 + Android SDK
```

It updates its own UI from the desktop: after a `npm run build` the app picks up the new bundle on its
next launch.

### Run it as a background service (macOS)

```bash
bash deploy/install-service.sh      # installs a launchd agent, starts on login
npm run restart                     # rebuild + hand off to the service cleanly
bash deploy/uninstall-service.sh    # remove it again and stop the daemon
```

Always use `npm run restart` rather than killing the process by hand: it builds first (so a broken
build never takes the host down) and lets launchd hand off cleanly. Sessions run inside tmux, so
they survive the restart. Logs land in `~/Library/Logs/waterplane-host.{out,err}.log`.

## Configuration

Everything is optional. Copy [.env.example](.env.example) to `.env` and edit, or export the
variables. The most useful ones:

| Variable | Default | What |
| --- | --- | --- |
| `WATERPLANE_ROOT` | `~/dev` | Directory scanned for repos. **This is the blast radius.** |
| `WATERPLANE_STATE_DIR` | `~/.local/state/waterplane` | The host's own state, outside the code root. Read from the environment, not a `.env` file. |
| `WATERPLANE_PORT` | `8770` | HTTP + WebSocket port. |
| `WATERPLANE_HOST` | Tailscale IP, then loopback | Bind address override. |
| `WATERPLANE_CLAUDE_BIN` | `claude` | Path to the Claude Code binary. |
| `WATERPLANE_ALLOW_PUBLIC` | off | Also bind LAN interfaces. **Requires a password for LAN devices.** |
| `GEMINI_API_KEY` | unset | Lets the highlighter read text out of a screenshot crop (the crop is sent to Google's Gemini API). Off without it; `WATERPLANE_OCR=0` turns it off even with a key. |

[.env.example](.env.example) is the complete list, including the usage-limit timings, dictation,
the sidecar models for the daemon's own small calls, and the origin allowlist escape hatch.

## Architecture

![waterplane architecture: the phone talks over Tailscale to a host daemon, which drives real CLI binaries in PTYs](docs/assets/architecture.svg)

- **The phone never runs a model.** Everything goes over one WebSocket per tab, inside your tailnet.
  What you type sits in a send queue until the host confirms it landed in the terminal: once, never
  twice.
- **The host drives the real CLI.** Each tab is a pseudo-terminal running the actual binary. A side
  channel per CLI (hooks, a local server, an event log) says when a turn ended, what a permission
  dialog asks and what it cost. When the side channel can't say, the screen is read; when neither
  can, the value is shown as unknown, never guessed.
- **Backends are descriptors.** Claude Code, Claude Code on a local Ollama model and Claude Code on a
  custom endpoint are built in; opencode is an in-repo extension you can switch off. Other CLIs can be
  added as external plugins from outside this repo (the picture shows Copilot and Codex as examples;
  they are separate projects and not part of waterplane). See
  [docs/notes/plugins.md](docs/notes/plugins.md).
- **Token numbers stay per backend.** Claude's ledger is read from its own logs and priced in
  dollars; any other backend reports in its own unit on its own tab. They are never summed.

Two more views are in [docs/notes/architecture.md](docs/notes/architecture.md):
[inside the code](docs/assets/architecture-components.svg) and
[the plugin mechanism](docs/assets/architecture-plugins.svg).

| Package | What |
| --- | --- |
| `packages/shared` | Wire types and the pure logic host and phone must agree on |
| `packages/host` | Node daemon: PTY sessions, WS bridge, git, builds, schedules, serves the web bundle |
| `packages/web` | React PWA: terminal, reader view, compose bar, feature sheets |
| `packages/app` | Android shell (Capacitor): the same web bundle inside an APK, see [packages/app/README.md](packages/app/README.md) |
| `packages/extensions` | Features built as plugins but shipped inside waterplane: `requirements`, `token-stats`, `opencode` |

[CLAUDE.md](CLAUDE.md) holds the rules an agent must know before editing; the reasoning behind them,
module by module, is in [docs/notes/](docs/notes/README.md).

## Known limits

- **It scrapes a TUI.** Prompt detection, usage-limit detection and parts of the usage meter are
  regexes against Claude Code's terminal output. Tests pin them, but a CLI update can still break
  them; the CLI-health sheet says when one missed. Turn boundaries come from Claude's hooks when
  available.
- **Backlog auto-fire is a heuristic without hooks**: it falls back to "no output for
  `WATERPLANE_IDLE_MS`", which can fire early if the agent pauses mid-task. It is opt-in, and every
  item can be advanced by hand.
- **No app-level auth on the trusted path.** Tailscale network identity is the boundary, by design;
  see [SECURITY.md](SECURITY.md).
- **Push, install-to-homescreen and clipboard need HTTPS** in the browser. `npm run doctor` tells
  you which side of that line you are on. The [Android app](packages/app/README.md) sidesteps it, but
  the LAN password gate does not reach the app yet.
- **No native iOS app yet** (iPhone uses the web app), and Windows only through WSL2.
- **It is version 0.1.** One person built it for their own use. It is tested, but it has not run on
  many machines other than the author's.

## Tests

Three layers: `npm run test:unit` (pure logic, `node --test`, no host), `npm run test:host` (the
screen heuristics, no daemon), and the `scripts/e2e-*.mjs` scripts, each of which spawns a real host
against a throwaway root, drives it over the real wire protocol, and uses a stub shell as the
`claude` binary (no login, no API access).

```bash
npm run build
npm test                        # lint + all three layers
node scripts/run-e2e.mjs git    # just the e2e scripts whose name contains "git"
```

The gifs in this README and the guide are filmed by the maintainer's own UI journeys against the
demo; that tooling is not part of this repository.

## Contributing

Open source, not open contribution: features arrive as **intent requests** (an issue describing the
problem and the end state, drafted with the repo's `feature-request` skill) and the owner builds
accepted ones, crediting the requester. Code PRs are merged only for a failing test that reproduces a
bug, or a docs/typo fix. The how and the why are in [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports
want your OS, `node --version`, `claude --version`, how you installed it, and host logs.

## License

[MIT](LICENSE) © Johannes Hoh. Third-party dependency licenses are listed in [NOTICES.md](NOTICES.md).
