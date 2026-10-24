# Installing waterplane

The README's [Install](../README.md#install) is the short route: the installer or a source
checkout, then HTTPS or the Android app. This page is the rest: Windows, the npm package and Docker,
installing with an agent, what the doctor says and where the host keeps things, notifications, the
Android app, a second phone or desktop, the background service, updating, and every environment
variable.

> **Read this before you install it.**
>
> The daemon spawns `claude`, which can **read, edit, and execute files** on your
> machine. There is **no app-level login by default**: the security boundary is
> the network. Anyone who can reach the daemon can, in effect, use your computer.
>
> By default it binds only **loopback and your Tailscale IP**, and refuses to bind
> LAN or public addresses unless you explicitly set `WATERPLANE_ALLOW_PUBLIC=1` (which
> then requires a password for LAN devices). Keep it that way. Point it only at
> code you trust. [SECURITY.md](../SECURITY.md) has the full threat model, and
> [DISCLAIMER.md](../DISCLAIMER.md) covers what else you are agreeing to: arbitrary code
> execution, what leaves the machine when you pick a hosted model, and what a free tier
> is actually paid with.

## Requirements, in detail

The README lists the four things you need: Claude Code installed with something to run on, a way
for the phone to reach the desktop (Tailscale recommended;
[without it](#without-tailscale-same-wi-fi-or-your-own-vpn)), tmux and, for a source checkout, Node.
The rest of the detail:

- **Claude Code:** install it with Anthropic's installer, `curl -fsSL https://claude.ai/install.sh
  | bash` (or `npm install -g @anthropic-ai/claude-code`). It needs one of: a **paid Claude plan**
  (Pro, Max, Team), an **Anthropic API key** (pay per use), or — no account at all — a **local
  model through Ollama** (`WATERPLANE_OLLAMA_URL`) or an endpoint of your own
  (`WATERPLANE_CLAUDE_ENDPOINT_URL`); both run the same `claude` binary. Sign in by running `claude`
  once, or later from the phone. The installer stops when `claude` is missing (with a terminal it
  asks first); **GitHub Copilot** instead of Claude: `install.sh --with copilot`, which needs no
  `claude`.

- **macOS is first-class** (developed and used daily on a Mac); Linux works. Windows works through
  WSL2: the host always runs inside it, from a WSL clone or driven from a Windows checkout
  ([below](#windows)).
- **tmux:** any recent version; 3.3 or newer. Every session runs inside it so it survives a host
  restart; without it the host refuses to start sessions. `brew install tmux` on macOS,
  `sudo apt-get install -y tmux` on Debian/Ubuntu/WSL (or your distribution's package manager). The
  installer offers to install it for you.
- **npm:** any npm runs `npm ci`; an npm older than 11.10 prints "Unknown project config
  min-release-age", which is harmless for `npm ci` (it installs the lockfile exactly). Upgrade npm
  only if you will `npm install` new dependencies yourself.

### On a Mac without admin rights

waterplane itself installs without admin: the installer puts its Node, the program and the
`waterplane` command in your home folder and the background service is a per-user LaunchAgent. Three
of its requirements are not like that — tmux (through Homebrew), the **Xcode Command Line Tools**
(which `git` needs: until they are installed, `/usr/bin/git` is only Apple's offer to install them)
and **Tailscale**. An account outside the admin group cannot install any of them, and a Homebrew set
up by another account refuses its `brew install`. The installer and `waterplane doctor` both say
which of the three are missing and that an administrator has to install them, so: ask whoever
administers the Mac for exactly that list.

Without an administrator, tmux can come from conda-forge into your home folder:
`pixi global install tmux` ([pixi](https://pixi.sh) installs without admin) — not yet tested here.
There is no supported way around the Command Line Tools or Tailscale. On a company-managed Mac,
check the policy too: this daemon runs `claude` on that machine for whoever reaches it.

## Windows

The host runs inside WSL2 (sessions need tmux, which has no Windows build). Either clone inside the
WSL shell and follow the Linux steps, or keep a Windows checkout under `C:\` and let it drive WSL
for you: after `npm ci` and `npm run build` in PowerShell, `node scripts/windows/host.mjs setup`
turns on WSL mirrored networking (so the host sees the Tailscale IP), installs a missing tmux and git
with apt (as WSL's root, so no password prompt), and the pinned Node, a Linux `claude` and GitHub's
`gh` into your WSL home. No WSL yet? It tells you the one command first: `wsl --install -d
Ubuntu-24.04` in an admin PowerShell, then open Ubuntu once. Sign `claude` in once inside WSL, and
`gh auth login` if you push or open PRs from there. `sudo` inside WSL wants your **Linux** password
(the one Ubuntu asked for on first launch), not your Windows one; forgot it? `wsl -u root passwd
<your-linux-user>` in PowerShell sets a new one.

Then `npm run restart`, `stop`, `doctor` and `dev` work from PowerShell as on a Mac — the host runs
in WSL straight from the same checkout — and `node scripts/windows/host.mjs autostart` starts it at
every logon, not at boot (a crashed host is restarted). `WATERPLANE_ROOT=c:/dev` in `.env` means `/mnt/c/dev`
there; repos on the Windows drive work, but are slower than ones in the Linux filesystem. For HTTPS,
run the `tailscale serve` line [below](#notifications-and-the-install-prompt) in Windows, then
`npm run restart`. Use the pinned Node (`winget install OpenJS.NodeJS.LTS`) on Windows too: the unit
tests import TypeScript directly, which an older Node cannot.

Without a checkout: `npm i -g waterplane` in PowerShell, then `waterplane setup`, `waterplane start`
and `waterplane autostart` do the same from the installed package (`waterplane update` updates it;
nothing is built on your machine). Details:
[docs/notes/distribution.md](notes/distribution.md#windows-the-launcher-drives-the-host-in-wsl).

## The npm package, and Docker

The npm package (`npm i -g waterplane`) is built and published by GitHub Actions in this repo and
carries an [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestation:
the package page, `npm view waterplane dist.attestations` and `npm audit signatures` link the
published bytes to the commit and the workflow run that built them. How a release is made, signed
and published: [docs/notes/distribution.md](notes/distribution.md).

`npm i -g` fails with `EACCES` when Node came from the nodejs.org installer or another account's
Homebrew (its global folder is not yours). Either use a Node in your home folder (nvm, fnm, volta),
or point npm's global folder there once: `npm config set prefix ~/.npm-global`, then add
`~/.npm-global/bin` to your PATH. The package runs no install script, so it does not check for tmux,
git or Tailscale — run `waterplane doctor` after installing; it does.

On a home server or a VPS, the host also runs in Docker, joining the tailnet as its own machine:
[deploy/docker/README.md](../deploy/docker/README.md).

## Installing with an agent

An agent (Claude Code, OpenClaw, …) can do almost all of this on macOS, Linux and Windows. Paste
this into it, in the folder you want the checkout in:

```text
Install waterplane on this computer so I can drive Claude Code from my phone.
1. git clone https://github.com/waterplane-dev/waterplane.git and read
   deploy/agent/waterplane/SKILL.md from the clone, not from the web. Follow it.
2. Before installing anything, ask me two things: native or Docker (with the
   trade-off in two lines), and which folder my phone may reach.
3. Never set WATERPLANE_ALLOW_PUBLIC, never bind 0.0.0.0, never publish or open
   port 8770, never use `tailscale funnel`. Show me every sudo or admin command
   instead of running it.
4. Loop on the doctor until it is ok, then pair my phone.
```

It will hand you the steps only you can do: signing `claude` in, Tailscale on the phone, HTTPS +
MagicDNS in the tailnet admin console, and on Windows installing WSL2 and the packages that need
`sudo`. Keep its permission prompts on while it works. The full instructions are
[deploy/agent/waterplane/SKILL.md](../deploy/agent/waterplane/SKILL.md); OpenClaw loads that same
file as a skill (copy the `waterplane` folder into `~/.openclaw/skills/`).

## The doctor, the root, and where it keeps things

`npm run doctor` (or `waterplane doctor`) is the first thing to run and the first thing to re-run
when something misbehaves. `npm run --silent doctor -- --json` (or `waterplane doctor --json`)
prints the same checks as one JSON document for a script or an agent. It names which silent failure
you are in (logged-out `claude`, no tailnet, a missing native module, a busy port) and what to type
to fix it:

```
  [ok  ] claude-binary   /opt/homebrew/bin/claude (2.1.224 (Claude Code))
  [fail] claude-login    claude is not signed in
                         → Sign in from the phone: open any session on this desktop, tap its
                           sign-in button, sign in in the browser, then tap paste code. (Or run
                           `claude` once in a terminal here.) Sessions stop at the sign-in
                           screen until then. …
```

A signed-out `claude` is only a warning once this desktop runs a local or endpoint model
(a recent session on one, or `WATERPLANE_CLAUDE_ENDPOINT_URL` set): those need no Claude account.

The host prints the URL it is listening on. Plain `http://100.x.y.z:8770` over Tailscale works for
a first look but is not a secure context (no install, push or clipboard), so set up the HTTPS
address ([next section](#notifications-and-the-install-prompt)) and open **that** on your phone to
add it to your home screen.

By default it scans `~/dev` for git repos and worktrees, or, if that does not exist, the first usual
code folder that does (`~/code`, `~/src`, `~/projects`, `~/repos`, …; the doctor says which). Set
`WATERPLANE_ROOT` to choose. **Everything under that directory is reachable from the phone**, so
choose it deliberately.

**Where it keeps things.** Your repos stay where they are (`WATERPLANE_ROOT`, default `~/dev`), and
the host keeps none of its own state there. That state — the delivery ledger, sessions,
settings, schedules, push keys, LAN password, device tokens — lives in `~/.local/state/waterplane`
(`$XDG_STATE_HOME/waterplane` when that is set, or wherever `WATERPLANE_STATE_DIR` points); config
and secrets in `~/.config/waterplane`; downloaded models in `~/.local/share/waterplane`. A host that
used to keep its state in `<root>/.waterplane` moves it there on its first start and leaves a
symlink behind; `npm run doctor`'s `state` row says where it is. What belongs to one repo (its build
commands, capture targets, …) stays in that repo's own `.waterplane/`. Uninstalling removes the
program and the service and none of these: delete the three directories by hand to remove every
trace.

## Notifications and the install prompt

Web Push, service workers, "add to home screen" and clipboard access need a **secure context**:
HTTPS or localhost. Plain `http://100.x.y.z` over Tailscale is not one, so those features do nothing
there. Everything else works without it. To get them, front the daemon with Tailscale's HTTPS:

```bash
# one-time: enable HTTPS + MagicDNS in the tailnet admin console, then
tailscale serve --bg --https=443 http://127.0.0.1:8770
```

Then browse `https://<machine>.<tailnet>.ts.net` on the phone. `npm run doctor` stops warning once
it is in place. The [Android app](#the-android-app) needs none of this.

## The Android app

Download the APK from the [latest release](https://github.com/waterplane-dev/waterplane/releases/latest)
(the pairing page links it too) and allow the install. It carries the same UI inside itself. Its
origin is `http://localhost`, a secure context, so it needs no `tailscale serve`; and its interface is
not on the network at all, so a reload or cold start while the tunnel is down lands in the working
app, with the send queue and drafts intact.

The app talks to one address: your desktop. It has no server of ours, no Google Play Services and no
analytics, and it asks for each runtime permission only when you turn on the feature that needs it.
Every permission is listed with its reason in
[packages/app/README.md](../packages/app/README.md#permissions-and-what-each-one-is-for). The browser
version above needs no install at all if you would rather not sideload anything.

To build it yourself instead ([`packages/app`](../packages/app/README.md)):

```bash
cd packages/app && npm install && npm run install-apk   # needs JDK 21 + Android SDK
```

It updates its own UI from the desktop: after a `npm run build` the app picks up the new bundle on its
next launch.

## Another phone, another desktop: with or without the app

Every phone needs a way to the desktop: Tailscale signed in to the same tailnet (recommended), or
the LAN setup [below](#without-tailscale-same-wi-fi-or-your-own-vpn). To add another phone,
**Settings → pair another phone** shows a QR code; on a desktop with no screen, `waterplane pair`
prints the link and code instead. After that:

| | In a browser (no app, iPhone too) | In the Android app |
|---|---|---|
| **A new phone** | Open the desktop's address, or scan **Settings → pair another phone** on a phone already connected and tap *use web version*. On your tailnet the address is the sign-in: no code to type. | Scan the same QR, install the app from the page, then *pair with code*, which comes filled in. |
| **A second desktop** | It has its own address. Open it and add it to the home screen too: one icon per desktop. There is no list to switch between. | **Settings → add a desktop** lists the waterplane desktops on your tailnet; one tap adds one. With two or more, the launcher bar shows a split key: the left half switches to the next desktop, the chevron opens the list. |
| **A desktop with a LAN password** | The browser asks for the password. | The pairing code gives the app its own sign-in; revoke it under **Settings → paired devices**. |

Home-screen install needs the HTTPS address (`tailscale serve`, above). The app does not.

## Without Tailscale: same Wi-Fi or your own VPN

Tailscale is the recommended way for the phone to reach the desktop, not a requirement. If you only
drive the desktop from the next room, or already run another VPN, use the LAN mode instead:

1. Set `WATERPLANE_ALLOW_PUBLIC=1` (in `.env` or the service's env) and restart. The daemon then also
   binds the desktop's other network interfaces, a VPN's included.
2. On the desktop, open `http://127.0.0.1:8770` and set **Settings → LAN password**. Until one is set,
   every LAN device is refused; a LAN device can never set or change it.
3. On the phone, open `http://<desktop's address>:8770` and sign in with that password, or pair the
   app from **Settings → pair another phone**.

What you give up: plain HTTP on a LAN is not a secure context, so no push, no home-screen install and
no clipboard in the browser (the Android app is unaffected), and nothing defends it against a man in
the middle on that network. Use it on a network you trust. [SECURITY.md](../SECURITY.md) has the
detail.

## Run it as a background service

With the installer, `waterplane service install|uninstall|status` registers a launchd agent
(macOS) or a systemd user unit (Linux); the installer does it for you unless `--no-service`. From a
source checkout on macOS:

```bash
bash deploy/install-service.sh      # installs a launchd agent, starts on login
npm run restart                     # rebuild + hand off to the service cleanly
bash deploy/uninstall-service.sh    # remove it again and stop the daemon
```

Always use `npm run restart` rather than killing the process by hand: it builds first (so a broken
build never takes the host down) and lets launchd hand off cleanly. Sessions run inside tmux, so
they survive the restart. Logs land in `~/Library/Logs/waterplane-host.{out,err}.log`.

## Update

With the `curl | sh` installer, all of this is `waterplane update`. From the folder you cloned into
(on Windows: inside the WSL shell, not `C:\`):

```bash
git pull --ff-only   # the latest release
npm ci               # the lockfile exactly, as on install; also drops removed packages
npm run doctor       # new checks arrive with new releases; re-read what it says
npm run restart      # builds, then restarts the host (the service if installed, else detached)
```

- **Or tap Update** in Settings → Tools → updates (the `curl | sh` installer's install only; other
  installs show the command above).
- **Sessions survive it.** They run inside tmux; the phone reconnects and carries on.
- **The phone updates itself.** The new UI is served by the host; the web app and the Android app
  pick it up on their next launch. A new APK is needed only when the native shell changed:
  `git diff --stat ORIG_HEAD -- packages/app/android` after the pull lists it if so.
- **Started with `npm start` in a terminal instead?** `npm run restart` still works (it stops that
  one and starts a detached copy); or Ctrl+C, then `npm run build && npm start`.
- **A failed build leaves the running host alone.** Fix it (usually `npm ci` was skipped), re-run
  `npm run restart`.

## Configuration

Everything is optional. Copy [.env.example](../.env.example) to `.env` and edit, or export the
variables. The most useful ones:

| Variable | Default | What |
| --- | --- | --- |
| `WATERPLANE_ROOT` | `~/dev`, else the first of `~/code`, `~/src`, `~/projects`, `~/repos`, … that exists | Directory scanned for repos. **This is the blast radius.** |
| `WATERPLANE_STATE_DIR` | `~/.local/state/waterplane` | The host's own state, outside the code root. Read from the environment, not a `.env` file. |
| `WATERPLANE_PORT` | `8770` | HTTP + WebSocket port. |
| `WATERPLANE_HOST` | Tailscale IP, then loopback | Bind address override. |
| `WATERPLANE_CLAUDE_BIN` | `claude` | Path to the Claude Code binary. |
| `WATERPLANE_ALLOW_PUBLIC` | off | Also bind LAN interfaces. **Requires a password for LAN devices.** |
| `GEMINI_API_KEY` | unset | Lets the highlighter read text out of a screenshot crop (the crop is sent to Google's Gemini API). Off without it; `WATERPLANE_OCR=0` turns it off even with a key. |

[.env.example](../.env.example) is the complete list, including the usage-limit timings, dictation,
the sidecar models for the daemon's own small calls, and the origin allowlist escape hatch.
