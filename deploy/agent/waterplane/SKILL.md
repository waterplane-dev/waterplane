---
name: waterplane
description: Install, check and pair waterplane — drive the real Claude Code terminal on this machine from the user's phone over Tailscale. Use when the user asks to install, set up, update, repair or pair waterplane, or asks whether it is worth installing.
homepage: https://github.com/waterplane-dev/waterplane
user-invocable: true
metadata: {"openclaw":{"os":["darwin","linux","win32"],"install":[{"id":"tmux","kind":"brew","os":["darwin"],"formula":"tmux","bins":["tmux"],"label":"Install tmux (waterplane runs every session inside it)"}]}}
---

# waterplane

waterplane is a daemon on this machine that runs the **real `claude` CLI in a PTY** and serves it to
the user's phone (Android app, or the web app on any phone) over Tailscale. It is not a chat bridge.

This file is the one set of install instructions for any agent: OpenClaw loads it as a skill, Claude
Code and others read it from a clone because the paste-in prompt in `docs/install.md` says to.

## When the user asks "is it worth it?"

Answer honestly, from this split:

- **An agent alone is enough** when they want to delegate a task and hear back: OpenClaw and similar
  can already run Claude Code headless and report in chat.
- **waterplane is worth it** when they want to **watch and steer a Claude Code session themselves**
  from the phone: the live terminal and a reader view, permission and choice boxes answered by tap,
  the context meter, screenshots and builds landing in a phone gallery, prompts queued for after a
  usage-limit reset, and what each turn cost.
- **Not for them yet** if they are on iPhone and want a native app (iPhone gets the web app only), or
  unwilling to run Tailscale. It is v0.1 from one maintainer, and it reads the CLI's screen, so a
  `claude` update can break parts of it until waterplane updates.
- Anthropic's own Remote Control continues one running session in the Claude app with no setup; say
  so if that is all they want.

## Security — say this before installing

The daemon spawns `claude`, which reads, edits and executes files. There is no app login: **the
network is the boundary**. It binds only loopback and the Tailscale IP by default.

- **Never** set `WATERPLANE_ALLOW_PUBLIC=1`, never set `WATERPLANE_HOST=0.0.0.0` (never bind
  `0.0.0.0`), never publish or open port 8770 (no firewall rule, no `ports:` in compose), never put it
  behind a public tunnel or reverse proxy. Only `tailscale serve` (tailnet-only), never
  `tailscale funnel`.
- **Never run `sudo`, an elevated/admin shell, or a command that reboots or restarts WSL yourself.**
  Show the person the exact command, say what it does, and wait for them to say it ran.
- The person should not run you with permission checks bypassed for this. If you are, say so once.

## Ask first — two questions, in one message

Before installing anything, ask both and wait for the answers:

1. **Native or Docker?** Recommend native on a desktop or laptop. Give the trade-off in two lines:
   - *Native*: uses the repos already on disk and the `claude` login already here; screenshots and
     dictation work.
   - *Docker*: the container joins the tailnet as its own machine with its own home volume, so repos
     are cloned into it (or bind-mounted), `claude` is signed in again inside it, screenshot capture
     and dictation are not available, and Android builds want 4–8 GB of RAM (slow under emulation on
     ARM). It is a convenience, not a sandbox. Suits a home server, NAS or VPS.
2. **Which folder may the phone reach?** (`WATERPLANE_ROOT`.) Everything under it can be opened, read
   and edited from the phone. Default `~/dev`, else the first of `~/code`, `~/src`, `~/projects`,
   `~/repos`. Do not guess.

## Check what is there — report it in one message

```bash
claude --version            # must exist, and the person must be signed in
tmux -V                     # required (macOS/Linux; on Windows it lives in WSL)
tailscale status            # the phone must be on the same tailnet
```

On Windows also: `wsl --status` (WSL2 must exist), `node --version` (the pinned `deploy/node-version`
for the checkout's own tooling).

## Install — the route the answers pick

### Native, macOS or Linux

1. **Release installer (preferred)** — pinned Node, verified checksums and signature, no sudo, adds a
   `waterplane` command and a launchd/systemd login service:
   ```bash
   curl -fsSL https://github.com/waterplane-dev/waterplane/releases/latest/download/install.sh -o /tmp/waterplane-install.sh
   WATERPLANE_ROOT=<folder> sh /tmp/waterplane-install.sh
   ```
   Offer the person the script to read first. The service records the root it was installed with. If
   the download 404s there is no public release yet: use the source route.
2. **From source** (no release yet, or they want to hack on it) — Node ≥ 22.12, tmux installed first
   (`brew install tmux`; on Linux hand the person `sudo apt-get install -y tmux` or their distro's
   equivalent):
   ```bash
   cd <the clone> && npm ci && npm run build
   echo 'WATERPLANE_ROOT=<folder>' >> .env
   ```
   Never leave `npm start` running in a foreground exec. On macOS register the service with
   `bash deploy/install-service.sh`. On Linux there is no service for a checkout: `npm run restart`
   starts it detached, and tell the person it does not come back after a reboot. Restart only with
   `npm run restart`.

### Native, Windows

The host runs inside WSL2 (sessions need tmux, which has no Windows build), driven from a Windows
checkout. Tell the person up front which steps are theirs:

- **Theirs:** `wsl --install` in an admin PowerShell, then a reboot (only if WSL2 is missing);
  `winget install OpenJS.NodeJS.LTS` (asks for UAC); `sudo apt-get install -y tmux git` inside WSL;
  signing `claude` in **inside WSL** — a Windows `claude` login does not carry over.
- **Yours**, from PowerShell in the clone (keep it under `C:\`, e.g. `C:\dev\waterplane`):
  ```powershell
  npm ci; npm run build
  Add-Content .env 'WATERPLANE_ROOT=c:/dev'        # the folder they chose; WSL reads it as /mnt/c/dev
  node scripts/windows/host.mjs setup             # mirrored networking + Node and claude in the distro
  npm run restart
  node scripts/windows/host.mjs autostart         # start it at every logon
  ```
  **Before `setup`, warn the person:** it turns on WSL mirrored networking and runs `wsl --shutdown`,
  which stops every running WSL distro (Docker Desktop's included). Wait for their go.
- Repos on `C:\` work but are slower than ones in the Linux filesystem; the doctor's `wsl-root` row
  says so. HTTPS: run the `tailscale serve` line below in Windows, then `npm run restart`.

### Docker

From the clone, follow `deploy/docker/README.md` — it is complete. Every `docker compose exec` takes
`-u wp`. Never add `ports:` to the compose file. Until the first public release the image is built
from a release made locally (that README's "Until the first public release" paragraph).

## Check — loop on the doctor, not on guesses

```bash
waterplane doctor --json                                       # installer route
npm run --silent doctor -- --json                              # source route, Windows included
docker compose exec -u wp waterplane waterplane doctor --json  # Docker route
```

stdout is one JSON document: `{ ok, fails, warns, checks: [{ id, status, detail, fix? }] }`.
Exit 1 means at least one `fail`. For each `fail`, do the `fix` yourself when it is a command on
this machine that needs no sudo/admin; otherwise send the person that ONE step and wait. Re-run
until `ok`. Warnings are optional improvements: list them once, do not chase them.

Steps only the person can do — never pretend to have done them:

- Sign `claude` in (or later from the phone: any session's sign-in button).
- Install Tailscale on the phone and log in to the same tailnet.
- For the web app's install/push/clipboard: enable **HTTPS certificates and MagicDNS** in the Tailscale
  admin console (https://login.tailscale.com/admin/dns). Then you run
  `tailscale serve --bg --https=443 http://127.0.0.1:8770`. The Android app does not need this.

## Pair the phone — send it to the chat

```bash
waterplane pair --json                                    # installer route
node packages/host/dist/cli/index.js pair --json          # source route, from the clone
docker compose exec -u wp waterplane waterplane pair --json
```

Returns `{ code, expiresAt, landingUrl, deepLink, base }`. Send the person `landingUrl` and the `code`
in the chat, and tell them it expires (`expiresAt`, ms epoch). The landing page offers the Android
app from the latest release, or the web app. Never post the code anywhere but the person's own chat.

## Update and remove

- Update: `waterplane update` (installer) — or in a clone `git pull --ff-only && npm ci && npm run restart`.
  Sessions run in tmux and survive it; the phone picks up the new UI on its next launch.
- Remove: `sh /tmp/waterplane-install.sh --uninstall` (installer); `bash deploy/uninstall-service.sh`
  (macOS checkout); `node scripts/windows/host.mjs autostart --remove` then `npm run stop` (Windows).
  None of them delete `~/.config/waterplane`, `~/.local/state/waterplane` or
  `~/.local/share/waterplane`; delete those only if the person asks.

## Hand-off

When paired, tell the person: open a repo on the phone, start a session, and that the doctor is the
first thing to run if something misbehaves. Bug reports go to the GitHub issues with OS,
`node --version`, `claude --version` and the install route.
