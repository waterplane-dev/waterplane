#!/bin/bash
# Build wp-desktop.exe, the Windows helper, from WSL. Usage:
#   build.sh [OUT]     compile to OUT (default: $OUT, else /tmp/wp-desktop-win/wp-desktop.exe)
#   build.sh --hash    print the source hash only (the host rebuilds only when it changes)
#
# The compiler is the C# 5 csc.exe every Windows 10/11 carries in its .NET Framework directory,
# reached through WSL's interop: nothing to install. It compiles in a Windows temp directory
# (csc and the build are Windows processes; a Linux path would reach them as a slow UNC share)
# and the result is copied to OUT.
#
# Windows keys no permission on the binary, so a rebuild forgets nothing; it still rebuilds only
# when the hash changes, because a build takes a few seconds the person waits through.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCES=(Main.cs Protocol.cs Params.cs Server.cs Capture.cs Synthetic.cs H264.cs Jpeg.cs Input.cs Native.cs)

srchash() {
  (cd "$HERE" && cat "${SOURCES[@]}" build.sh) | sha256sum | cut -c1-16
}

if [ "${1:-}" = "--hash" ]; then
  srchash
  exit 0
fi

OUT="${1:-${OUT:-/tmp/wp-desktop-win/wp-desktop.exe}}"
no_toolchain() {
  echo "build.sh: $1. The Windows helper is compiled by the .NET Framework's csc.exe through WSL interop." >&2
  exit 3
}
command -v wslpath >/dev/null 2>&1 || no_toolchain "not running under WSL (no wslpath)"
# cmd.exe warns about a UNC working directory; run it from the Windows drive.
WINC="$(wslpath -u 'C:\' 2>/dev/null || echo /mnt/c/)"
wincmd() { (cd "$WINC" && cmd.exe /d /c "$1" 2>/dev/null | tr -d '\r'); }
SYSROOT="$(wincmd 'echo %SystemRoot%' || true)"
[ -n "$SYSROOT" ] && [ "$SYSROOT" != "%SystemRoot%" ] || no_toolchain "WSL interop is off (cmd.exe does not run)"
CSC="$(wslpath -u "$SYSROOT")/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
[ -f "$CSC" ] || no_toolchain "no $CSC"
WTEMP="$(wincmd 'echo %TEMP%')"
[ -n "$WTEMP" ] || no_toolchain "no Windows %TEMP%"
BUILD="$(wslpath -u "$WTEMP")/wp-desktop-build.$$"
mkdir -p "$BUILD"
trap 'rm -rf "$BUILD"' EXIT
(cd "$HERE" && cp "${SOURCES[@]}" "$BUILD/")
LOG="$BUILD/csc.log"
if ! (cd "$BUILD" && "$CSC" /nologo /utf8output /optimize+ /unsafe+ /platform:x64 /target:exe /out:wp-desktop.exe \
  /r:System.Drawing.dll /r:System.Web.Extensions.dll "${SOURCES[@]}" > "$LOG" 2>&1); then
  echo "build.sh: csc.exe failed:" >&2
  tr -d '\r' < "$LOG" | grep -v '^\s*$' | tail -n 20 >&2
  exit 1
fi
mkdir -p "$(dirname "$OUT")"
cp -f "$BUILD/wp-desktop.exe" "$OUT.build.$$"
chmod +x "$OUT.build.$$"
mv -f "$OUT.build.$$" "$OUT"
srchash > "$OUT.srchash"
echo "built $OUT ($(cat "$OUT.srchash"))" >&2
