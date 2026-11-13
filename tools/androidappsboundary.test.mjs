/**
 * Core no longer names the Android Apps surface -- a SHRINKING allowlist.
 *
 * `docs/notes/android-apps-architecture.md` section 7 (package P0). The Apps
 * screen is moving out of core into the optional `android-apps` extension; this
 * guard records who names it TODAY and only ever lets that list get shorter.
 *
 * Scanned: every non-test .ts/.tsx under packages/{web,host,shared}/src, with
 * comments stripped (a comment may keep telling the history). Two scans:
 *   1. identifiers and ids: AppsSheet, appsPane, AppsHistory, "android-apps",
 *      and the literal overlay "apps";
 *   2. case-insensitive, so a reworded sentence cannot dodge it: "apps screen",
 *      "app list", "apps sheet", "android apps" (and the `app` singular).
 *
 * Each allowlist entry is `file: hits`. A file over its count fails (a NEW
 * mention); a file at zero hits with an entry fails (delete the entry: the
 * list must shrink); fewer hits than listed logs a note to lower it. Later
 * packages remove entries; nobody adds one without a decision.
 * `"android-apps"` has no entry: nothing in core may name the extension's id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = ["web", "host", "shared"].map((p) => join(ROOT, "packages", p, "src"));

const IDS = /\bAppsSheet\b|\bappsPane\b|\bAppsHistory\b|"android-apps"|"apps"/g;
const WORDS = /apps? (screen|list|sheet)|android apps/gi;

/** Allowed hits per file (P0 list, shrunk by P4). Shrinks with P5/P6; never grows. */
const ALLOW = {
  // after P4: the Downloads sheet's two door buttons ("android apps", drawn only while the
  // extension owns the screen: the files pane's hint, and the rules pane's pointer, which moved
  // with the shell-settings rows into PullShellSettings.tsx) and four false positives / P6 words.
  "packages/web/src/PullSheet.tsx": 1,
  "packages/web/src/PullShellSettings.tsx": 1,
  "packages/web/src/settingsIndex.ts": 1,
  "packages/host/src/appready.ts": 1,
  "packages/host/src/doctor.ts": 1,
  "packages/host/src/reposkilltext.ts": 2,
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out); continue; }
    if (!/\.tsx?$/.test(name) || /\.test\.|\.d\.ts$/.test(name)) continue;
    out.push(p);
  }
  return out;
}

/** Remove // and block comments without touching string/template contents. */
export function stripComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const k = e < 0 ? src.length : e + 2; out += src.slice(i, k).replace(/[^\n]/g, ""); i = k; continue; }
    out += c; i++;
  }
  return out;
}

const count = (re, s) => (s.match(re) ?? []).length;

function scan() {
  const hits = {};
  for (const f of DIRS.flatMap((d) => walk(d))) {
    const s = stripComments(readFileSync(f, "utf8"));
    const n = count(IDS, s) + count(WORDS, s);
    if (n) hits[relative(ROOT, f)] = n;
  }
  return hits;
}

test("the stripper keeps strings and drops comments", () => {
  const s = stripComments('const a = "// not a comment"; // AppsSheet\n/* "apps" */ const b = `x`;');
  assert.ok(s.includes('"// not a comment"'));
  assert.ok(!s.includes("AppsSheet") && !s.includes('"apps" */'));
});

test("core names the Apps surface only where the allowlist says, and the list only shrinks", () => {
  const hits = scan();
  const over = [], stale = [], lower = [];
  for (const [f, n] of Object.entries(hits)) {
    const max = ALLOW[f] ?? 0;
    if (n > max) over.push(`${f}: ${n} hits, allowed ${max}`);
    else if (n < max) lower.push(`${f}: ${n} < ${max}`);
  }
  for (const f of Object.keys(ALLOW)) if (!hits[f]) stale.push(f);
  assert.deepEqual(over, [], "core names the Apps surface (AppsSheet/appsPane/AppsHistory/\"android-apps\"/overlay \"apps\"/'apps screen' wording) where it must not -- the Apps screen belongs to the android-apps extension (docs/notes/android-apps-architecture.md)");
  assert.deepEqual(stale, [], "allowlist entry with no hits left: delete it, the list must shrink");
  for (const l of lower) console.log(`# ${l} -- lower ALLOW in tools/androidappsboundary.test.mjs to lock that in`);
});

test("\"android-apps\" has no allowlist entry: core never names the extension id", () => {
  for (const f of DIRS.flatMap((d) => walk(d))) {
    assert.ok(!stripComments(readFileSync(f, "utf8")).includes('"android-apps"'), relative(ROOT, f));
  }
});

// Line ratchet (section 7): installPolicy.ts holds the row half that P2a splits out; the split must LOWER this.
const RATCHET = { "packages/web/src/installPolicy.ts": 63 };
test("installPolicy.ts only gets shorter", () => {
  for (const [rel, max] of Object.entries(RATCHET)) {
    const n = readFileSync(join(ROOT, rel), "utf8").split("\n").length - 1;
    assert.ok(n <= max, `${rel} is ${n} lines, over its ${max} ratchet`);
    if (n < max - 50) console.log(`# ${rel} is ${n} lines -- lower RATCHET in tools/androidappsboundary.test.mjs to lock that in`);
  }
});
