#!/usr/bin/env bash
# Remove the launchd LaunchAgent installed by install-service.sh and stop the
# daemon. The counterpart matters: with KeepAlive set, launchd relaunches the
# host every time you kill it, so without this there is no obvious way to make
# it stop.
#
# Leaves your code, your repos and the host's state dir alone — this only removes
# the "start it automatically" wiring.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# Labels and names come from the built brand table: the current service and
# every older one (an install made before a rename is still ours to remove).
brand() { ( cd "$REPO" && node --input-type=module -e "import { BRAND, LEGACY } from './packages/shared/dist/brand.js'; $1" ); }
if ! LABELS="$(brand 'console.log([BRAND.launchdLabel, ...LEGACY.map((l) => l.launchdLabel)].join(" "))' 2>/dev/null)"; then
  echo "[uninstall] packages/shared/dist is missing — run: npm run build:shared" >&2; exit 1
fi
SLUG="$(brand 'console.log(BRAND.slug)')"

for LABEL in $LABELS; do
  DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  if [ ! -f "$DEST" ]; then
    echo "[uninstall] no LaunchAgent at $DEST — nothing to uninstall."
  else
    echo "[uninstall] unloading $LABEL"
    launchctl unload -w "$DEST" 2>/dev/null || launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    rm -f "$DEST"
    echo "[uninstall] removed $DEST"
  fi
done

# launchd may have already stopped it; make sure nothing is left running.
if pgrep -f "packages/host/dist/main.js" >/dev/null 2>&1; then
  echo "[uninstall] stopping the running host"
  pkill -f "packages/host/dist/main.js" || true
fi

echo "[uninstall] done. Logs remain at ~/Library/Logs/${SLUG}-host.{out,err}.log — delete them if you want."
echo "[uninstall] To run the host by hand again: npm start"
