/**
 * A fork's `<config dir>/theme.json` on the host (`themeoverlay.ts`): the read
 * and its reload, the route, the manifest name, the tmux colours, and the
 * doctor's `overlays` row. The config dir is a temp dir (`WATERPLANE_CONFIG_DIR`).
 */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "theme-cfg-"));
process.env.WATERPLANE_CONFIG_DIR = dir;
const theme = join(dir, "theme.json");

const { themeOverlayState, hostTermColors, brandManifest, brandIndexHtml, overlaysCheck, themeIconFile, themeIconUrls } = await import("../dist/themeoverlay.js");
const { handleApi } = await import("../dist/api.js");
const { TERM_COLORS } = await import("@waterplane/shared");

const quiet = async (fn) => {
  const w = console.warn; const log = [];
  console.warn = (...a) => log.push(a.join(" "));
  try { return [await fn(), log]; } finally { console.warn = w; }
};
let tick = 1;
const write = (text) => { writeFileSync(theme, text); const t = Date.now() / 1000 + tick++; utimesSync(theme, t, t); };

async function get(path) {
  const server = createServer((req, res) => { handleApi(req, res, {}).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

test("absent: nothing, said nowhere; the tmux answer is TERM_COLORS.dark itself", async () => {
  rmSync(theme, { force: true });
  const [s, log] = await quiet(() => themeOverlayState());
  assert.deepEqual({ present: s.present, overlay: s.overlay, notes: s.notes }, { present: false, overlay: {}, notes: [] });
  assert.deepEqual(log, []);
  assert.equal(hostTermColors(), TERM_COLORS.dark);
  const r = await get("/api/theme");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { overlay: {} });
});

test("a valid file is served cleaned, re-read after an edit, and feeds the tmux colours", async () => {
  write(JSON.stringify({ displayName: "acme", colors: { dark: { accent: "#f70" } }, terminal: { dark: { background: "#101214" } } }));
  const r = await get("/api/theme");
  assert.deepEqual(r.body.overlay, { displayName: "acme", colors: { dark: { "--accent": "#ff7700" } }, terminal: { dark: { background: "#101214" } } });
  assert.deepEqual(hostTermColors(), { background: "#101214", foreground: TERM_COLORS.dark.foreground });
  write(JSON.stringify({ displayName: "acme two" }));
  assert.equal(themeOverlayState().overlay.displayName, "acme two");
  assert.equal(hostTermColors(), TERM_COLORS.dark);
});

test("a broken file is ignored whole with one log line, and the route answers {}", async () => {
  write("{ not json");
  const [s, log] = await quiet(() => themeOverlayState());
  assert.match(s.error, /not valid JSON/);
  assert.equal(log.length, 1);
  const [again, log2] = await quiet(() => themeOverlayState());
  assert.equal(again, s, "cached until the file changes");
  assert.deepEqual(log2, []);
  assert.deepEqual((await get("/api/theme")).body, { overlay: {} });
});

test("the manifest takes the display name; without one it is the same bytes", () => {
  const body = Buffer.from(JSON.stringify({ name: "waterplane", short_name: "waterplane", start_url: "/" }));
  assert.equal(brandManifest(body, undefined), body);
  const j = JSON.parse(brandManifest(body, "acme").toString());
  assert.deepEqual([j.name, j.short_name, j.start_url], ["acme", "acme", "/"]);
  const junk = Buffer.from("not json");
  assert.equal(brandManifest(junk, "acme"), junk);
});

test("doctor overlays: none, then every kind listed, then a warning per refused entry", async () => {
  rmSync(theme, { force: true });
  let c = overlaysCheck();
  assert.equal(c.status, "ok");
  assert.match(c.detail, /^none in .* upstream defaults$/);

  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "prompts", "assess.md"), "Our own words.\n");
  writeFileSync(join(dir, "models.json"), JSON.stringify({ add: { ids: ["claude-x"] }, hide: ["haiku"] }));
  write(JSON.stringify({ displayName: "acme", colors: { light: { "--bg": "#fff" } } }));
  c = overlaysCheck();
  assert.equal(c.status, "ok", c.detail);
  assert.match(c.detail, /prompts\/ \(assess\)/);
  assert.match(c.detail, /models\.json \(\+1 \/ −1\)/);
  assert.match(c.detail, /theme\.json \(name "acme", 1 colour\)/);

  const [w] = await quiet(() => {
    write(JSON.stringify({ colors: { dark: { "--nope": "#fff" } } }));
    writeFileSync(join(dir, "models.json"), "[");
    return overlaysCheck();
  });
  assert.equal(w.status, "warn");
  assert.match(w.detail, /models\.json ignored/);
  assert.match(w.detail, /theme\.json: 1 entry ignored — "colors\.dark\.--nope"/);
  assert.ok(w.fix);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

test("icons: a contained, sniffed file is served by slot; anything else is refused in words", async () => {
  const outside = mkdtempSync(join(tmpdir(), "theme-out-"));
  try {
    mkdirSync(join(dir, "icons"), { recursive: true });
    writeFileSync(join(dir, "icons", "mark.svg"), SVG);
    writeFileSync(join(dir, "icons", "192.png"), PNG);
    writeFileSync(join(dir, "icons", "fake.png"), "not a png");
    writeFileSync(join(outside, "x.png"), PNG);
    symlinkSync(join(outside, "x.png"), join(dir, "icons", "link.png"));
    symlinkSync(outside, join(dir, "icons", "out"));
    write(JSON.stringify({ icons: { favicon: "icons/mark.svg", 192: "icons/192.png", 512: "../x.png", maskable: "/etc/x.png", "apple-touch": "icons/fake.png", nope: "a.png" } }));
    const [s] = await quiet(() => themeOverlayState());
    assert.deepEqual(s.overlay.icons, { favicon: "icons/mark.svg", 192: "icons/192.png", "apple-touch": "icons/fake.png" });
    assert.equal(s.notes.length, 3, s.notes.join("\n"));

    const f = themeIconFile("favicon");
    assert.equal(f.mime, "image/svg+xml");
    assert.equal(f.body.toString(), SVG);
    assert.match(themeIconFile("apple-touch").error, /is not a PNG/);
    assert.match(themeIconFile("512").error, /no "512" icon set/);
    assert.match(themeIconFile("../theme.json").error, /unknown icon slot/);
    // Symlinks are followed on both sides: out of the config dir is out, however it is spelled.
    for (const rel of ["icons/link.png", "icons/out/x.png"]) {
      assert.match(themeIconFile("192", { icons: { 192: rel } }).error, /outside the config dir/);
    }
    // An overlay that never went through the cleaner is shape-checked again.
    assert.match(themeIconFile("192", { icons: { 192: "../outside.png" } }).error, /not a .png\/.svg path/);

    const urls = themeIconUrls();
    assert.deepEqual(Object.keys(urls).sort(), ["192", "favicon"]);
    assert.match(urls.favicon.url, /^\/theme-icon\/favicon\?v=\w+$/);

    // The wire never carries the desktop's paths.
    assert.equal((await get("/api/theme")).body.overlay.icons, undefined);

    const man = Buffer.from(JSON.stringify({ name: "w", icons: [
      { src: "/assets/icon-dark.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
    ] }));
    const j = JSON.parse(brandManifest(man, undefined, urls).toString());
    assert.deepEqual(j.icons.map((e) => e.src), [urls.favicon.url, urls["192"].url, "/assets/icon-512.png"]);

    const html = Buffer.from('<head>\n    <link rel="icon" type="image/svg+xml" href="/assets/icon.svg" />\n    <link rel="icon" type="image/png" sizes="32x32" href="/assets/icon-32.png" />\n    <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />\n</head>');
    assert.equal(brandIndexHtml(html, {}), html);
    const out = brandIndexHtml(html, { favicon: urls.favicon, "apple-touch": { url: "/theme-icon/apple-touch?v=1", mime: "image/png" } }).toString();
    assert.equal(out.match(/rel="icon"/g).length, 1);
    assert.ok(out.includes(`<link rel="icon" type="image/svg+xml" href="${urls.favicon.url}" />`));
    assert.ok(out.includes('<link rel="apple-touch-icon" href="/theme-icon/apple-touch?v=1" />'));

    const c = overlaysCheck();
    assert.equal(c.status, "warn");
    assert.match(c.detail, /icons favicon\+apple-touch\+192/);
    assert.match(c.detail, /theme\.json icon "apple-touch": icons\/fake\.png is not a PNG/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(join(dir, "icons"), { recursive: true, force: true });
  }
});
