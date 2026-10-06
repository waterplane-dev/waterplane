// Traffic-volume optimisations: server-made thumbnails, conditional GETs and
// response compression. The point of all three is bytes on a slow link, so the
// assertions are about SIZE and STATUS, not just "did it 200".
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8799;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-root-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const base = `http://127.0.0.1:${PORT}`;
const j = (p, opts) => fetch(base + p, opts).then((r) => r.json());
let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const skip = (label) => console.log(`SKIP: ${label}`);
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

// ── a real PNG, big enough that thumbnailing is worth it ───────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = -1; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}
/** A W×H truecolour PNG of deterministic noise — incompressible, so the file is
 *  genuinely large (a flat-colour PNG would compress to nothing and the host
 *  would correctly decline to thumbnail it). */
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
  const raw = Buffer.alloc(h * (1 + w * 3));
  const noise = randomBytes(w * 3);
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0; // filter: none
    randomBytes(w * 3).copy(raw, off + 1);
  }
  void noise;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

bootWait(PORT, 1800, async () => {
  try {
    const repo = await j("/api/repo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "shots" }) });
    const id = (await j("/api/repos")).targets[0].id;

    const png = makePng(500, 500);
    const rel = ".claude/outbox/big.png";
    writeFileSync(join(repo.path, rel), png);
    const mtime = Math.floor(statSync(join(repo.path, rel)).mtimeMs);
    check(png.length > 300_000, `test image is genuinely large (${Math.round(png.length / 1024)} KB)`);

    const art = (q = "") => `${base}/api/repos/${id}/artifact?path=${encodeURIComponent(rel)}${q}`;

    // ── the original, and its validator ──────────────────────────────
    const full = await fetch(art());
    const fullBytes = Buffer.from(await full.arrayBuffer()).length;
    check(full.status === 200 && fullBytes === png.length, "original served whole");
    const etag = full.headers.get("etag");
    check(!!etag, "original carries an ETag");
    const revalidate = await fetch(art(), { headers: { "if-none-match": etag } });
    check(revalidate.status === 304, "unchanged original revalidates to 304 (no bytes)");

    // ── the thumbnail ────────────────────────────────────────────────
    const th = await fetch(art(`&thumb=320&v=${mtime}`));
    const thBytes = Buffer.from(await th.arrayBuffer()).length;
    const thumbed = th.headers.get("content-type") === "image/jpeg";
    if (!thumbed) {
      // No sips/ImageMagick/ffmpeg on this machine: the host must fall back to
      // the original rather than serving something broken.
      check(th.status === 200 && thBytes === png.length, "no converter here → original served (documented fallback)");
      skip("thumbnail size + cache assertions (no image converter on this host)");
    } else {
      check(thBytes * 5 < fullBytes, `thumbnail is far smaller (${Math.round(thBytes / 1024)} KB vs ${Math.round(fullBytes / 1024)} KB)`);
      check(/immutable/.test(th.headers.get("cache-control") || ""), "versioned thumb is immutable-cacheable");
      const tTag = th.headers.get("etag");
      const t304 = await fetch(art(`&thumb=320&v=${mtime}`), { headers: { "if-none-match": tTag } });
      check(t304.status === 304, "thumbnail revalidates to 304");
      // A second, different width must not collide with the first in the cache.
      const wide = await fetch(art(`&thumb=960&v=${mtime}`));
      const wideBytes = Buffer.from(await wide.arrayBuffer()).length;
      check(wideBytes > thBytes, "a wider thumb is a distinct, larger image");
      // No `v` → still cacheable, but not immutable (the URL can go stale).
      const noV = await fetch(art("&thumb=320"));
      check(noV.status === 200 && !/immutable/.test(noV.headers.get("cache-control") || ""), "unversioned thumb is not marked immutable");
      // download must always mean the real file.
      const dl = await fetch(art(`&thumb=320&download=1`));
      const dlBytes = Buffer.from(await dl.arrayBuffer()).length;
      check(dlBytes === png.length && /attachment/.test(dl.headers.get("content-disposition") || ""), "download=1 overrides thumb — the real file is sent");
    }

    // ── stat: the mtime a path-only caller needs ─────────────────────
    //
    // A file mentioned in a transcript is just a path, and a thumb URL without
    // `&v=<mtime>` is cacheable by nobody — which is what made those pictures
    // vanish offline (web/fileMtime.ts). This is where the client gets the
    // missing half, so it builds the SAME versioned URL the gallery does.
    const st = await fetch(art("&stat=1"));
    const stJson = await st.json();
    check(st.status === 200 && Math.floor(stJson.mtime) === mtime && stJson.size === png.length,
      "stat=1 answers the file's mtime + size");
    check((await fetch(art(`&thumb=320&v=${Math.floor(stJson.mtime)}`))).status === 200,
      "the mtime it reports builds a servable versioned thumb URL");
    // Read-only, and gated exactly like the byte path: no bytes, no traversal,
    // and no confirming the existence of a file this route would refuse.
    const stEscape = await fetch(`${base}/api/repos/${id}/artifact?path=${encodeURIComponent("../../../../etc/passwd")}&stat=1`);
    check(stEscape.status === 404, "stat=1 refuses a traversal path");
    writeFileSync(join(repo.path, ".claude/outbox/.env"), "SECRET=1\n");
    const stSecret = await fetch(`${base}/api/repos/${id}/artifact?path=${encodeURIComponent(".claude/outbox/.env")}&stat=1`);
    check(stSecret.status === 404, "stat=1 will not confirm a secret file");
    const stGone = await fetch(`${base}/api/repos/${id}/artifact?path=${encodeURIComponent(".claude/outbox/nope.png")}&stat=1`);
    check(stGone.status === 404, "stat=1 on a missing file is a 404");

    // A width outside the allow-list is ignored (it can't be used to fill the cache).
    const bogus = await fetch(art("&thumb=333"));
    check(Buffer.from(await bogus.arrayBuffer()).length === png.length, "unknown thumb width falls back to the original");

    // The containment guard still holds with a thumb request attached.
    const escape = await fetch(`${base}/api/repos/${id}/artifact?path=${encodeURIComponent("../../../../etc/passwd")}&thumb=320`);
    check(escape.status === 404, "traversal is still refused on the thumb path");

    // A doc is not thumbnailable — asking for one is harmless.
    writeFileSync(join(repo.path, ".claude/outbox/note.md"), "# hi\n");
    const md = await fetch(`${base}/api/repos/${id}/artifact?path=${encodeURIComponent(".claude/outbox/note.md")}&thumb=320`);
    check(md.status === 200 && (await md.text()).startsWith("# hi"), "non-image ignores thumb and serves the file");

    // ── compression ──────────────────────────────────────────────────
    // Make the listing big enough to clear the min-compress threshold.
    for (let i = 0; i < 200; i++) writeFileSync(join(repo.path, `.claude/outbox/report-${i}-with-a-longish-name.md`), "x");
    const listUrl = `${base}/api/repos/${id}/artifacts?scope=outbox&limit=1000`;
    const plain = await fetch(listUrl, { headers: { "accept-encoding": "identity" } });
    const plainLen = (await plain.text()).length;
    const gz = await fetch(listUrl, { headers: { "accept-encoding": "gzip" } });
    check(gz.headers.get("content-encoding") === "gzip", "JSON listing is gzipped when offered");
    check(Number(gz.headers.get("content-length")) * 2 < plainLen, `gzip actually shrinks it (${gz.headers.get("content-length")} vs ${plainLen})`);
    const br = await fetch(listUrl, { headers: { "accept-encoding": "br" } });
    check(br.headers.get("content-encoding") === "br", "brotli preferred when offered");
    check(/accept-encoding/i.test(br.headers.get("vary") || ""), "compressed responses Vary on Accept-Encoding");
    // The decoded body must still be the same JSON (fetch decodes for us).
    const decoded = await br.json();
    check(Array.isArray(decoded.files) && decoded.files.length > 100, "compressed listing decodes back to the same JSON");

    // ── paging ───────────────────────────────────────────────────────
    const page = await j(`/api/repos/${id}/artifacts?scope=outbox&limit=10`);
    check(page.files.length === 10 && page.truncated === true, "limit pages the listing and reports more exist");
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  done();
});
