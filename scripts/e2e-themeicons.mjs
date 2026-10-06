// A fork's icons from `<config dir>/theme.json` (`host/themeoverlay.ts`), over
// a real host: served by slot at /theme-icon/<slot> with a CSP, linked from the
// served index.html and manifest, never served for a slot the file does not
// name or a path that leaves the config dir.
import "./lib-tmuxiso.mjs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E, SLUG } from "./lib-brand.mjs";
import { bootHost } from "./lib-e2e.mjs";

const cfg = mkdtempSync(join(tmpdir(), `${SLUG}-ti-cfg-`));
const outside = mkdtempSync(join(tmpdir(), `${SLUG}-ti-out-`));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
mkdirSync(join(cfg, "icons"));
writeFileSync(join(cfg, "icons", "mark.svg"), SVG);
writeFileSync(join(outside, "secret.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
symlinkSync(join(outside, "secret.png"), join(cfg, "icons", "escape.png"));
writeFileSync(join(cfg, "theme.json"), JSON.stringify({ icons: { favicon: "icons/mark.svg", 192: "icons/escape.png" } }));

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const h = await bootHost({ env: { [E.CONFIG_DIR]: cfg }, quiet: true, tag: "ti" });
try {
  const fav = await fetch(`${h.base}/theme-icon/favicon`);
  check(fav.status === 200 && (await fav.text()) === SVG, "favicon served by slot");
  check(fav.headers.get("content-type") === "image/svg+xml", "as image/svg+xml");
  check(/default-src 'none'/.test(fav.headers.get("content-security-policy") ?? ""), "under a default-src 'none' CSP");
  check(fav.headers.get("x-content-type-options") === "nosniff", "with nosniff");
  check((await fetch(`${h.base}/theme-icon/192`)).status === 404, "a symlink out of the config dir is refused");
  check((await fetch(`${h.base}/theme-icon/512`)).status === 404, "a slot the file does not name is 404");
  check((await fetch(`${h.base}/theme-icon/..%2Ftheme.json`)).status !== 200, "a path in the URL is never a path");
  const theme = await fetch(`${h.base}/api/theme`).then((r) => r.json());
  check(theme.overlay.icons === undefined, "/api/theme never carries the paths");
  const html = await fetch(`${h.base}/`).then((r) => (r.status === 200 ? r.text() : ""));
  if (html.includes("<link")) {
    check(/<link rel="icon" type="image\/svg\+xml" href="\/theme-icon\/favicon\?v=\w+" \/>/.test(html), "index.html links the fork's favicon");
    check((html.match(/rel="icon"/g) ?? []).length === 1, "and only it");
    const man = await fetch(`${h.base}/manifest.webmanifest`).then((r) => r.json());
    check(man.icons.some((i) => i.src.startsWith("/theme-icon/favicon?v=")), "the manifest's SVG entry is the fork's");
    check(man.icons.some((i) => i.src === "/assets/icon-192.png"), "a refused slot keeps the built-in icon");
  } else console.log("SKIP: no web build — the shell rewrites are unit-tested in packages/host/test/themeoverlay.test.mjs");
} finally {
  await h.stop();
  rmSync(cfg, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
