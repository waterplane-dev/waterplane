#!/usr/bin/env bash
# Build the iOS shell and run it in the iOS Simulator.
#
#   packages/app/scripts/ios-sim.sh            build, install, launch
#   IOS_SIM_DEVICE="iPhone 17" …/ios-sim.sh    pick the simulator by name
#   IOS_SIM_SKIP_BUILD=1 …/ios-sim.sh          reinstall + relaunch the last build
#
# Simulator only: there is no paid Apple Developer account, so nothing here
# signs, archives or uploads (packages/app/README.md, "iOS shell").
#
# The web bundle is built into ios/App/build/web, NEVER packages/web/dist —
# that directory is what the host serves to every phone over the air, and a
# shell build from a half-edited tree would ship to all of them.
set -euo pipefail

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
app_dir="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$app_dir/../.." && pwd)"
build_dir="$app_dir/ios/App/build"
web_out="$build_dir/web"
bundle_id="dev.waterplane.app"

say() { printf '[ios-sim] %s\n' "$*"; }
die() { printf '[ios-sim] %s\n' "$*" >&2; exit "${2:-1}"; }

# ── Preflight: the two things only the owner can fix ────────────────────────
[ -d "$DEVELOPER_DIR" ] || die "no Xcode at $DEVELOPER_DIR (set DEVELOPER_DIR)"
if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  die "Xcode's first-launch setup has not run (no CoreSimulator). Run once:
    sudo xcodebuild -runFirstLaunch" 2
fi
if ! xcrun simctl list runtimes 2>/dev/null | grep -q '^iOS'; then
  die "no iOS simulator runtime installed. Run:
    xcodebuild -downloadPlatform iOS" 2
fi

# ── Pick (and boot) a simulator ─────────────────────────────────────────────
udid="$(xcrun simctl list devices available -j | node -e '
  const want = process.argv[1];
  const all = Object.entries(JSON.parse(require("fs").readFileSync(0, "utf8")).devices)
    .filter(([rt]) => /SimRuntime\.iOS/.test(rt)).flatMap(([, ds]) => ds)
    .filter((d) => /^iPhone/.test(d.name));
  const hit = (want && all.find((d) => d.name === want))
    || all.find((d) => d.state === "Booted") || all[all.length - 1];
  if (hit) console.log(hit.udid);
' "${IOS_SIM_DEVICE:-}")"
[ -n "$udid" ] || die "no available iPhone simulator (Xcode → Settings → Components)"
if ! xcrun simctl list devices | grep "$udid" | grep -q Booted; then
  say "booting $udid"
  xcrun simctl boot "$udid"
fi
# The window, by path: Xcode 27 replaced Simulator.app with DeviceHub.app, and
# with DEVELOPER_DIR instead of xcode-select LaunchServices may know neither by
# name. Headless is fine too — install, launch and screenshots need no window.
if [ "${IOS_SIM_HEADLESS:-0}" != 1 ]; then
  for gui in "$DEVELOPER_DIR/Applications/Simulator.app" "$DEVELOPER_DIR/../Applications/DeviceHub.app"; do
    [ -d "$gui" ] && { open "$gui" || true; break; }
  done
fi

# ── Build: shared → web (scratch outDir) → cap sync → xcodebuild ────────────
app_path="$build_dir/dd/Build/Products/Debug-iphonesimulator/App.app"
if [ "${IOS_SIM_SKIP_BUILD:-0}" != 1 ]; then
  say "building @waterplane/shared"
  (cd "$root" && npm run --silent build:shared)
  say "building packages/web → $web_out"
  (cd "$root/packages/web" && npx vite build --outDir "$web_out" --emptyOutDir --logLevel warn)
  [ -f "$web_out/index.html" ] || die "web build produced no index.html"
  say "cap sync ios"
  (cd "$app_dir" && WATERPLANE_APP_WEBDIR="$web_out" npx cap sync ios)
  say "xcodebuild (simulator, unsigned)"
  xcodebuild -project "$app_dir/ios/App/App.xcodeproj" -scheme App -configuration Debug \
    -sdk iphonesimulator -destination "id=$udid" -derivedDataPath "$build_dir/dd" \
    CODE_SIGNING_ALLOWED=NO build -quiet
fi
[ -d "$app_path" ] || die "no build at $app_path"

# ── Install + launch ─────────────────────────────────────────────────────────
say "installing on $udid"
xcrun simctl install "$udid" "$app_path"
xcrun simctl launch --terminate-running-process "$udid" "$bundle_id"
say "running — screenshot: xcrun simctl io $udid screenshot shot.png"
