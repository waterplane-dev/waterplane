---
name: waterplane
description: Install, check and pair waterplane — drive the real Claude Code terminal on this machine from the user's phone over Tailscale. Use when the user asks to install, set up, update, repair or pair waterplane, or asks whether it is worth installing.
homepage: https://github.com/waterplane-dev/waterplane
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "os": ["darwin", "linux"],
        "requires": { "bins": ["claude"] },
        "install":
          [
            { "id": "tmux", "kind": "brew", "formula": "tmux", "bins": ["tmux"], "label": "Install tmux (waterplane runs every session inside it)" }
          ]
      }
  }
---

# waterplane

waterplane is a daemon on this machine that runs the **real `claude` CLI in a PTY** and serves it to
the user's phone (Android app, or the web app on any phone) over Tailscale. It is not a chat bridge.

## When the user asks "is it worth it?"

Answer honestly, from this split:

- **You (the claw) are enough** when they want to delegate a task and hear back: you can already run
  Claude Code headless and report in chat.
- **waterplane is worth it** when they want to **watch and steer a Claude Code session themselves**
  from the phone: the live terminal and a reader view, permission and choice boxes answered by tap,
  the context meter, screenshots and builds landing in a phone gallery, prompts queued for after a
  usage-limit reset, and what each turn cost.
- **Not for them yet** if they are on iPhone and want a native app (iPhone gets the web app only), on
  native Windows (WSL2 only), or unwilling to run Tailscale. It is v0.1 from one maintainer, and it
  reads the CLI's screen, so a `claude` update can break parts of it until waterplane updates.
- Anthropic's own Remote Control continues one running session in the Claude app with no setup; say
  so if that is all they want.

## Security — say this before installing

The daemon spawns `claude`, which reads, edits and executes files. There is no app login: **the
network is the boundary**. It binds only loopback and the Tailscale IP by default.

- **Never** set `WATERPLANE_ALLOW_PUBLIC=1`, `WATERPLANE_HOST=0.0.0.0`, open port 8770 in a firewall,
  or put it behind a public tunnel/reverse proxy. Only `tailscale serve` (tailnet-only), never
  `tailscale funnel`.
- `WATERPLANE_ROOT` (default `~/dev`, else the first of `~/code`, `~/src`, `~/projects`, `~/repos`)
  is everything the phone can reach. **Ask the user which folder** before installing; do not guess.

## Install

Before anything, check and report in one message what is missing:

```bash
claude --version            # must exist, and the user must be signed in
tmux -V                     # required; install it first (the installer can only offer it on a TTY)
tailscale status            # the phone must be on the same tailnet
```

Pick ONE route:

1. **Release installer (preferred)** — pinned Node, verified checksums and signature, no sudo, adds a
   `waterplane` command and a launchd/systemd login service:
   ```bash
   curl -fsSL https://github.com/waterplane-dev/waterplane/releases/latest/download/install.sh -o /tmp/waterplane-install.sh
   sh /tmp/waterplane-install.sh
   ```
   Offer the user the script to read first. For a root other than the default, run it as
   `WATERPLANE_ROOT=<folder> sh /tmp/waterplane-install.sh`: the service records the root it was
   installed with.
2. **A VPS or home server where the claw itself lives in Docker** — use the repo's
   `deploy/docker/README.md`: the host joins the tailnet as its own machine.
3. **From source** (no release yet, or the user wants to hack on it) — Node ≥ 20.12:
   ```bash
   git clone https://github.com/waterplane-dev/waterplane.git && cd waterplane
   npm ci && npm run build
   ```
   Do not leave `npm start` running in a foreground exec. On macOS register the service with
   `bash deploy/install-service.sh`; restart only with `npm run restart`.

## Check — loop on the doctor, not on guesses

```bash
waterplane doctor --json                     # installer route
npm run --silent doctor -- --json            # source route (from the clone)
```

stdout is one JSON document: `{ ok, fails, warns, checks: [{ id, status, detail, fix? }] }`.
Exit 1 means at least one `fail`. For each `fail`, do the `fix` yourself when it is a command on
this machine; when it needs the person, send them that ONE step and wait. Re-run until `ok`.
Warnings are optional improvements: list them once, do not chase them.

Steps only the person can do — never pretend to have done them:

- Sign `claude` in (or later from the phone: any session's sign-in button).
- Install Tailscale on the phone and log in to the same tailnet.
- For the web app's install/push/clipboard: enable **HTTPS certificates and MagicDNS** in the Tailscale
  admin console (https://login.tailscale.com/admin/dns). Then you run
  `tailscale serve --bg --https=443 http://127.0.0.1:8770`. The Android app does not need this.

## Pair the phone — send it to the chat

```bash
waterplane pair --json
```

Returns `{ code, expiresAt, landingUrl, deepLink, base }`. Send the user `landingUrl` and the `code`
in the chat, and tell them it expires (`expiresAt`, ms epoch). The landing page offers the Android
app from the latest release, or the web app. Never post the code anywhere but the user's own chat.

## Update and remove

- Update: `waterplane update` (installer) — or in a clone `git pull --ff-only && npm ci && npm run restart`.
  Sessions run in tmux and survive it; the phone picks up the new UI on its next launch.
- Remove: `sh /tmp/waterplane-install.sh --uninstall`. It keeps `~/.config/waterplane`,
  `~/.local/state/waterplane` and `~/.local/share/waterplane`; delete those only if the user asks.

## Hand-off

When paired, tell the user: open a repo on the phone, start a session, and that `waterplane doctor`
is the first thing to run if something misbehaves. Bug reports go to the GitHub issues with OS,
`node --version`, `claude --version` and the install route.
