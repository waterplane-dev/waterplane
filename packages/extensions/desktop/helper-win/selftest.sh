#!/bin/bash
# Selftest for wp-desktop.exe, run in WSL on the Windows desktop: build into a temp dir, probe,
# then serve the SYNTHETIC source (never the screen) with dry input, as JPEG and as H.264, and
# check the records. Posts no event, reads no screen pixel.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/wp-desktop-selftest/wp-desktop.exe"
bash "$HERE/build.sh" "$OUT"
echo "== probe"; "$OUT" probe
echo "== whoami"; "$OUT" whoami
for codec in jpeg h264; do
  echo "== serve synthetic $codec"
  {
    echo "{\"t\":\"config\",\"codec\":\"$codec\",\"maxWidth\":1280,\"fps\":15,\"bitrateKbps\":800,\"source\":{\"kind\":\"synthetic\"}}"
    sleep 2.5
    echo '{"t":"config","codec":"'$codec'","maxWidth":1280,"fps":15,"bitrateKbps":800,"crop":{"x":0.5,"y":0.5,"w":0.5,"h":0.5},"source":{"kind":"synthetic"}}'
    echo '{"t":"bitrate","kbps":300}'
    echo '{"t":"input","ev":{"k":"click","x":0.5,"y":0.5,"n":2}}'
    echo '{"t":"input","ev":{"k":"text","s":"hi"}}'
    sleep 2.5
  } | "$OUT" serve --source synthetic --dry-input > "$OUT.$codec.bin"
  node - "$OUT.$codec.bin" "$codec" <<'EOF'
const b = require("fs").readFileSync(process.argv[2]), want = process.argv[3] === "h264" ? 1 : 2;
let off = 0, video = 0, keys = 0, sizes = new Set(), seqs = [], avc = null, last = 0n, bad = [];
while (off + 4 <= b.length) {
  const len = b.readUInt32LE(off), kind = b[off + 4], key = b[off + 5] & 1, pts = b.readBigUInt64LE(off + 6), p = b.subarray(off + 14, off + 4 + len);
  if (kind === 4) { const o = JSON.parse(p); if (o.t === "status") { sizes.add(`${o.width}x${o.height}`); if (o.regionSeq) seqs.push(o.regionSeq); if (o.avc) avc = o.avc; if (o.reason) console.log("reason:", o.reason); } }
  else { video++; if (key) keys++; if (kind !== want) bad.push(`kind ${kind}`); if (pts <= last) bad.push("pts"); last = pts;
    if (kind === 1 && key && !p.includes(Buffer.from([0, 0, 1, 0x67])) && !p.includes(Buffer.from([0, 0, 1, 0x27]))) bad.push("key without SPS"); }
  off += 4 + len;
}
console.log({ video, keys, sizes: [...sizes], regions: [...new Set(seqs)], avc, bad: bad.slice(0, 5) });
if (!video || bad.length || !seqs.includes(2) || (want === 1 && !avc)) { console.log("FAIL"); process.exit(1); }
console.log("ok");
EOF
done
