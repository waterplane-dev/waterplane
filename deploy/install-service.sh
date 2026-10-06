#!/usr/bin/env bash
# Install the host as a launchd LaunchAgent so macOS keeps it running and
# relaunches it on login/crash. The plist is generated from THIS machine's paths
# (no hardcoded user dirs), so it works on any Mac. Re-run after code changes.
#
# LEGACY: this is the DEV-CHECKOUT path (macOS only). A release install uses
# `<slug> service install` (packages/host/src/cli/service.ts), which bakes the
# same knobs. tmux is required (every session runs inside it); there is no knob.
set -euo pipefail

ORIG_PWD="$PWD"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# A delegated peer job's worktree never restarts or installs the daemon (peers/serve.ts writes the
# marker): `npm run restart` kills whatever listens on the port and relaunches from THIS tree.
# (the marker sits in the brand's dot-dir; a glob keeps this script from spelling the name)
if compgen -G "$REPO/.*/peer-job.json" >/dev/null || compgen -G "$ORIG_PWD/.*/peer-job.json" >/dev/null; then
  echo "[install] refused: this is a delegated job's worktree; it never restarts or installs the peer's daemon." >&2
  exit 1
fi
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "[install] node not found on PATH" >&2; exit 1; fi

# Build first: every name below (label, env prefix, log names) is read from the
# built brand table, so this script spells none of them and a rename edits one
# file. Shared builds before the host, as everywhere.
echo "[install] building host…"
( cd "$REPO" && npm run build:shared >/dev/null && npm run build -w @waterplane/host >/dev/null )

brand() { ( cd "$REPO" && node --input-type=module -e "import { BRAND, LEGACY } from './packages/shared/dist/brand.js'; $1" ); }
LABEL="$(brand 'console.log(BRAND.launchdLabel)')"
SLUG="$(brand 'console.log(BRAND.slug)')"
ENVP="$(brand 'console.log(BRAND.envPrefix)')"
LEGACY_LABELS="$(brand 'console.log(LEGACY.map((l) => l.launchdLabel).join(" "))')"
LEGACY_ENVP="$(brand 'console.log(LEGACY.map((l) => l.envPrefix).join(" "))')"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
# getenv KEY DEFAULT — the current knob, else a legacy spelling, else DEFAULT.
getenv() {
  local n="${ENVP}$1" l
  if [ -n "${!n:-}" ]; then printf '%s' "${!n}"; return; fi
  for l in $LEGACY_ENVP; do n="${l}$1"; if [ -n "${!n:-}" ]; then printf '%s' "${!n}"; return; fi; done
  printf '%s' "$2"
}
PORT="$(getenv PORT 8770)"
ROOT_DIR="$(getenv ROOT "")"
# Optional keys, baked only when this shell NAMES them (cli/service.ts' bakedDirs,
# the same rule): an unnamed root re-derives to ~/dev from HOME, and baking the
# default would make the daemon believe someone chose it (the doctor's
# missing-root hint never shows). CLAUDE_CONFIG_DIR is the claude CLI's own dir:
# without it the service reads ~/.claude while your shell's claude signs in
# elsewhere, and every session opens on the sign-in screen.
# sed, not ${s//&/…}: bash 5.2's patsub_replacement makes & in the replacement the match.
xmlesc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
abspath() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$ORIG_PWD/$1" ;; esac; }
OPT_KEYS=""
if [ -n "$ROOT_DIR" ]; then
  OPT_KEYS+="    <key>${ENVP}ROOT</key>
    <string>$(xmlesc "$(abspath "$ROOT_DIR")")</string>
"
fi
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  OPT_KEYS+="    <key>CLAUDE_CONFIG_DIR</key>
    <string>$(xmlesc "$(abspath "$CLAUDE_CONFIG_DIR")")</string>
"
fi
# The host's global state dir, resolved HERE and baked in (the daemon's own
# precedence: <PREFIX>STATE_DIR, $XDG_STATE_HOME/<name>, ~/.local/state/<name>),
# so the service and a doctor run from this shell agree on where it lives.
STATE_DIR_VAL="$(getenv STATE_DIR "${XDG_STATE_HOME:-$HOME/.local/state}/$(brand 'console.log(BRAND.configDirName)')")"
if ! command -v tmux >/dev/null 2>&1; then
  echo "[install] warning: tmux not found — the host refuses to start sessions without it. Install it: brew install tmux" >&2
fi
ALLOW_PUBLIC="$(getenv ALLOW_PUBLIC 0)"

# This bakes the CURRENT shell's env into a service that then runs on every
# login. Getting ALLOW_PUBLIC=1 in there by accident means the daemon
# binds your LAN forever, so say so loudly rather than silently persisting it.
if [ "$ALLOW_PUBLIC" = "1" ]; then
  echo ""
  echo "[install] WARNING: ${ENVP}ALLOW_PUBLIC=1 is set in this shell and will be baked"
  echo "[install] into the service, so the daemon binds your LAN on every login."
  echo "[install] LAN devices still need the password you set in Settings -> LAN access;"
  echo "[install] with no password set they are refused outright."
  echo "[install] Ctrl-C now and re-run without it if that is not what you want."
  echo ""
  sleep 5
fi
# Bin dirs to expose to launchd's minimal PATH (so `claude`/`node` resolve).
NODE_BIN_DIR="$(dirname "$NODE")"
CLAUDE_BIN_DIR="$(dirname "$(command -v claude || echo /opt/homebrew/bin/claude)")"

# An install made under an older identity is a second job on the same port, and
# KeepAlive would fight this one for it for ever. Boot out every past label and
# remove its plist (the file is regenerated here under the current label; the
# old logs stay where they are).
for OLD in $LEGACY_LABELS; do
  OLD_PLIST="$HOME/Library/LaunchAgents/${OLD}.plist"
  if launchctl print "gui/$(id -u)/${OLD}" >/dev/null 2>&1 || [ -f "$OLD_PLIST" ]; then
    echo "[install] retiring the older service ${OLD}"
    launchctl bootout "gui/$(id -u)/${OLD}" 2>/dev/null || { [ -f "$OLD_PLIST" ] && launchctl unload -w "$OLD_PLIST" 2>/dev/null; } || true
    rm -f "$OLD_PLIST"
  fi
done

echo "[install] freeing port ${PORT} (stop any manual host)…"
pkill -f "packages/host/dist/main.js" 2>/dev/null || true

echo "[install] writing $DEST"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${REPO}/packages/host/dist/main.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${CLAUDE_BIN_DIR}:${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
${OPT_KEYS}    <key>${ENVP}STATE_DIR</key>
    <string>${STATE_DIR_VAL}</string>
    <key>${ENVP}ALLOW_PUBLIC</key>
    <string>${ALLOW_PUBLIC}</string>
    <key>${ENVP}PORT</key>
    <string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/${SLUG}-host.out.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/${SLUG}-host.err.log</string>
</dict>
</plist>
PLIST

# Reload cleanly.
launchctl unload "$DEST" 2>/dev/null || true
launchctl load -w "$DEST"

sleep 2
echo "[install] health check:"
curl -s -o /dev/null -w "  127.0.0.1:${PORT} -> %{http_code}\n" "http://127.0.0.1:${PORT}/api/health" || true
echo "[install] done. logs: ~/Library/Logs/${SLUG}-host.{out,err}.log"
echo "[install] manage: launchctl unload/load -w \"$DEST\" ; launchctl list | grep ${LABEL}"
echo "[install] uninstall: bash deploy/uninstall-service.sh"
