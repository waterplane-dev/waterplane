#!/usr/bin/env bash
# Restart the host the RIGHT way for the current setup:
#  - If the launchd service is installed → build, then ask launchd to restart it
#    (clean handoff, no detached copy fighting KeepAlive for the port).
#  - Otherwise → kill old instance, wait for the port, start detached.
# Either way: build first, fail loudly on a broken build (don't take the host
# down), then health-check.
set -uo pipefail
# Native Windows has no tmux, so no session could run here. `npm run restart` on Windows never gets
# here (scripts/oswrap.mjs sends it to scripts/windows/host.mjs, which runs the host in WSL); this
# is for someone running the script by hand from Git Bash/MSYS: say the route that works instead of
# failing halfway through a launchd/kill dance that cannot exist here.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "[restart] refused: native Windows cannot run the host. From PowerShell: npm run restart (it runs the host in WSL2 from this checkout; first time: node scripts/windows/host.mjs setup)." >&2
    exit 1;;
esac
ORIG_PWD="$PWD"
cd "$(dirname "$0")/.."
# A delegated peer job's worktree never restarts or installs the daemon (peers/serve.ts writes the
# marker): `npm run restart` kills whatever listens on the port and relaunches from THIS tree.
# (the marker sits in the brand's dot-dir; a glob keeps this script from spelling the name)
if compgen -G "$PWD/.*/peer-job.json" >/dev/null || compgen -G "$ORIG_PWD/.*/peer-job.json" >/dev/null; then
  echo "[restart] refused: this is a delegated job's worktree; it never restarts or installs the peer's daemon." >&2
  exit 1
fi

# WSL running a Windows checkout (/mnt/<drive>/…): that host is built on Windows (node_modules holds
# the Windows esbuild/rollup) and kept up by scripts/windows/keeper.ps1. A restart from in here — a
# session on the phone, say — hands the whole job to the Windows side: building here would fail, and
# a copy started with nohup would be one the keeper does not hold, so nothing keeps WSL itself up.
if grep -qi microsoft /proc/version 2>/dev/null; then
  case "$PWD" in
    /mnt/[a-z]/*)
      # RUN it, not `command -v`: with interop gone from the running distro cmd.exe is still on PATH,
      # and the `exec` below then died with "Exec format error".
      if ! cmd.exe /d /c exit 0 >/dev/null 2>&1; then
        echo "[restart] refused: this checkout's host is run from Windows, and WSL interop is off here (Windows programs cannot be run from this distro). From PowerShell in the checkout: npm run restart. To get interop back: \`wsl --shutdown\` from Windows (every WSL session stops), or as root in this distro: sudo sh -c 'echo :WSLInterop:M::MZ::/init:PF > /proc/sys/fs/binfmt_misc/register'" >&2
        exit 1
      fi
      echo "[restart] Windows checkout — handing the restart to Windows (scripts/windows/host.mjs)…"
      exec cmd.exe /d /c "npm run restart"
      ;;
  esac
fi

UID_NUM="$(id -u)"

echo "[restart] building…"
BUILD_LOG="${TMPDIR:-/tmp}/host-build.log"
if ! npm run build >"$BUILD_LOG" 2>&1; then
  echo "[restart] BUILD FAILED — host left as-is. See $BUILD_LOG" >&2
  tail -5 "$BUILD_LOG" >&2
  exit 1
fi

# Names come from the built brand table (nothing here spells the product), so
# they exist only now. The current label first, then every past one: a service
# installed under an older identity is still ours to restart until the installer
# has moved it (it runs this checkout's dist either way).
brand() { node --input-type=module -e "import { BRAND, LEGACY } from './packages/shared/dist/brand.js'; $1"; }
ENVP="$(brand 'console.log(BRAND.envPrefix)')"
LEGACY_ENVP="$(brand 'console.log(LEGACY.map((l) => l.envPrefix).join(" "))')"
SLUG="$(brand 'console.log(BRAND.slug)')"
LABELS="$(brand 'console.log([BRAND.launchdLabel, ...LEGACY.map((l) => l.launchdLabel)].join(" "))')"
# getenv KEY DEFAULT — the current knob, else a legacy spelling, else DEFAULT.
getenv() {
  local n="${ENVP}$1" l
  if [ -n "${!n:-}" ]; then printf '%s' "${!n}"; return; fi
  for l in $LEGACY_ENVP; do n="${l}$1"; if [ -n "${!n:-}" ]; then printf '%s' "${!n}"; return; fi; done
  printf '%s' "$2"
}
PORT="$(getenv PORT 8770)"
DELAY="$(getenv RESTART_DELAY 2)"   # pause before the restart actually fires
HOST_LOG="${TMPDIR:-/tmp}/${SLUG}-host.log"
# The service's stderr log: under the current name, else the newest older one.
SLUGS="$(brand 'console.log([BRAND.slug, ...LEGACY.map((l) => l.slug)].join(" "))')"
ERR_LOG="$HOME/Library/Logs/${SLUG}-host.err.log"
for sl in $SLUGS; do [ -f "$HOME/Library/Logs/${sl}-host.err.log" ] && { ERR_LOG="$HOME/Library/Logs/${sl}-host.err.log"; break; }; done

LABEL=""
for l in $LABELS; do
  if launchctl print "gui/$UID_NUM/$l" >/dev/null 2>&1; then LABEL="$l"; break; fi
done
is_launchd() { [ -n "$LABEL" ]; }

health() {
  for _ in $(seq 1 25); do
    sleep 0.4
    [ "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)" = "200" ] && return 0
  done
  return 1
}

# Tell the running host WHY it is about to go (packages/host/src/restartnote.ts): its SIGTERM
# handler passes the line on to every phone with `host.restarting`. Best effort — no host, an older
# host or a refusal changes nothing. Override the words with <PREFIX>RESTART_REASON.
REASON="$(getenv RESTART_REASON "")"
if [ -z "$REASON" ]; then
  REASON="npm run restart · new build $(git log -1 --format='%h %s' 2>/dev/null | cut -c1-90)"
  [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] && REASON="$REASON (+ uncommitted edits)"
fi
REASON="$REASON" node -e 'process.stdout.write(JSON.stringify({ reason: process.env.REASON }))' \
  | curl -s -m 2 -o /dev/null -X POST -H 'content-type: application/json' --data-binary @- \
      "http://127.0.0.1:$PORT/api/host/restart-note" 2>/dev/null || true

if is_launchd; then
  echo "[restart] launchd service detected — reloading via launchctl in ${DELAY}s…"
  sleep "$DELAY"
  # -k: SIGTERM the running job then start it again with the freshly-built dist.
  launchctl kickstart -k "gui/$UID_NUM/$LABEL"
  if health; then echo "[restart] up (launchd) · http://127.0.0.1:$PORT (200)"; exit 0; fi
  echo "[restart] launchd restart didn't reach 200 — see $ERR_LOG" >&2
  tail -8 "$ERR_LOG" 2>/dev/null >&2
  exit 1
fi

echo "[restart] no launchd service — stopping old host(s)…"
pkill -f "packages/host/dist/main.js" 2>/dev/null || true
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
echo "[restart] waiting for :$PORT to free…"
for _ in $(seq 1 40); do lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done

echo "[restart] starting detached in ${DELAY}s…"
sleep "$DELAY"
nohup node packages/host/dist/main.js >"$HOST_LOG" 2>&1 &
disown 2>/dev/null || true
if health; then echo "[restart] up (detached) · http://127.0.0.1:$PORT (200)"; exit 0; fi
echo "[restart] started but health never hit 200 — see $HOST_LOG" >&2
tail -8 "$HOST_LOG" 2>/dev/null >&2
exit 1
