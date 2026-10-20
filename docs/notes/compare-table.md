# Comparison table (README-ready)

A short cut of [vs-competitors.md](vs-competitors.md), read 2026-10-02. Every cell is backed by the
section of that file named in the first column; **?** means not established, "not documented" means
looked for in the vendor's pages and not found.

| Tool | Real `claude` in a terminal | Runs on your machine | Build on the desktop, APK or files back on the phone | iOS | Account / relay |
|---|---|---|---|---|---|
| **waterplane** | Yes, real PTY | Yes | Yes: build runner, outbox gallery, APK install | Web app in Safari (untested on a real iPhone); no native app | None; Tailscale only |
| [Claude Remote Control](vs-competitors.md#2c1-remote-control--a-local-session-driven-from-the-claude-app) | Real local process, claude.ai chat UI; terminal-only commands unavailable | Yes | Builds run locally; no documented way back to the phone | Yes | claude.ai account, via Anthropic's servers |
| [Claude Code on the web](vs-competitors.md#2c2-claude-code-on-the-web--cloud-sessions) | Cloud VM, chat UI | No | Cloud VM; no Android SDK pre-installed | Yes | claude.ai account + GitHub |
| [Happy](vs-competitors.md#part-2--happy) | ? | Yes | Not a feature | Yes | Relay server (self-hostable) |
| [Paseo](vs-competitors.md#part-2b--paseo) | No: Agent SDK, no PTY | Yes | Not a feature | Yes | Optional relay |
| [Orca](vs-competitors.md#part-2g--orca) | Terminal view and chat UI | Yes | Not documented | Yes | Orca Relay (sign-in) or local network |
| [SSH + tmux](vs-competitors.md#part-2d--ssh--tmux-from-a-phone-terminal-app-the-diy-baseline) | Yes, exact | Yes | By hand (SFTP) | Yes | None beyond SSH |

Where waterplane loses, plainly: **no native iOS app** (iPhone gets the web app, not yet tested on a real one), one user, and it needs a tailnet. Beyond these columns it
also schedules against usage-limit resets, keeps token and cost history, and queues sends offline
exactly once; the long document says where each of those was and was not found in the others.

**Remote Control is a complement, not only an alternative.** With the launch option "Remote Control"
on, every session waterplane starts also runs with `--remote-control`, so it shows up in the Claude
app in parallel: waterplane to launch sessions on any repo, read, build and schedule; the Claude app
for a quick look. ([detail](vs-competitors.md#2c1-remote-control--a-local-session-driven-from-the-claude-app))

