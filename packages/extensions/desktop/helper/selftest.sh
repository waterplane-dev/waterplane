#!/bin/bash
# wp-desktop selftest. Builds into a scratch dir under $TMPDIR (never the repo),
# then drives the binary with the SYNTHETIC source and DRY-RUN input only:
# nothing here captures the real screen, posts an event, or can raise a
# permission prompt. ffmpeg/ffprobe are test-only (decode check); the helper
# itself never needs them. KEEP=1 keeps the scratch dir (streams, JPEGs).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
for t in python3 ffmpeg ffprobe sips; do
  command -v "$t" >/dev/null || { echo "selftest: needs $t on PATH" >&2; exit 2; }
done
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wp-desktop-selftest.XXXXXX")"
if [ "${KEEP:-0}" != "1" ]; then trap 'rm -rf "$WORK"' EXIT; else echo "selftest: keeping $WORK"; fi
"$HERE/build.sh" "$WORK/bin/wp-desktop"
python3 -I "$HERE/selftest-driver" "$WORK/bin/wp-desktop" "$WORK"
