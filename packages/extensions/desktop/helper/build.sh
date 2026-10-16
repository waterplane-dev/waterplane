#!/bin/bash
# Build wp-desktop. Usage:
#   build.sh [OUT]     compile to OUT (default: $OUT, else $TMPDIR/wp-desktop/wp-desktop), ad-hoc sign
#   build.sh --hash    print the source hash only (the host rebuilds only when it changes)
#
# A TCC grant is bound to the binary's code signature. An ad-hoc signature is
# its cdhash, so EVERY rebuild means granting Screen Recording and
# Accessibility again: rebuild only when --hash changes. The identifier is
# stable and the Info.plist is embedded so the System Settings row reads
# "wp-desktop", not a hash.
#
# The product's name is not spelled here: the host (helperbin.mts) reads it from
# the brand table and passes it in the environment, for --hash and for a build
# alike (the identifier is part of the hash):
#   WP_DESKTOP_ID    the code-signing identifier / CFBundleIdentifier (TCC keys the grant on it)
#   WP_DESKTOP_NAME  CFBundleDisplayName
# A hand build (selftest.sh) gets a neutral local identifier; the host then sees
# a different hash and builds its own.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCES=(main.swift Protocol.swift Params.swift Server.swift Capture.swift Synthetic.swift H264.swift Jpeg.swift Input.swift Probe.swift Request.swift Responsibility.swift)

ID="${WP_DESKTOP_ID:-local.wp-desktop}"
NAME="${WP_DESKTOP_NAME:-wp-desktop helper}"

srchash() {
  { (cd "$HERE" && cat "${SOURCES[@]}" Info.plist build.sh); printf '%s\n%s\n' "$ID" "$NAME"; } | shasum -a 256 | cut -c1-16
}

if [ "${1:-}" = "--hash" ]; then
  srchash
  exit 0
fi

OUT="${1:-${OUT:-${TMPDIR:-/tmp}/wp-desktop/wp-desktop}}"
SWIFTC="${SWIFTC:-$(command -v swiftc || true)}"
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
if [ -z "$SWIFTC" ] || [ -z "$SDK" ]; then
  echo "build.sh: no swiftc or macOS SDK. Install the command line tools: xcode-select --install" >&2
  exit 3
fi
mkdir -p "$(dirname "$OUT")"
TMP_OUT="$OUT.build.$$"
PLIST="$OUT.plist.$$"
trap 'rm -f "$TMP_OUT" "$PLIST"' EXIT
sed -e "s|@WP_DESKTOP_ID@|$ID|" -e "s|@WP_DESKTOP_NAME@|$NAME|" "$HERE/Info.plist" > "$PLIST"
(cd "$HERE" && "$SWIFTC" -O -swift-version 5 -target arm64-apple-macos14 -sdk "$SDK" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
  "${SOURCES[@]}" -o "$TMP_OUT")
codesign -s - --force --identifier "$ID" "$TMP_OUT"
mv -f "$TMP_OUT" "$OUT"
srchash > "$OUT.srchash"
echo "built $OUT ($(cat "$OUT.srchash"))" >&2
