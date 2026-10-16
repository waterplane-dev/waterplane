/**
 * The public snapshot leaves the PRIVATE extensions out — the allow-list's whole-folder carve-outs,
 * `!packages/extensions/<id>/**` (`deploy/public-allowlist.txt`; read by `privateExtensions`, so this
 * file names none of them) — so nothing PUBLIC may need one or name one. Three cheap halves here, on
 * every `npm run test:unit`:
 *
 *  1. every tracked file under a private extension's folder is private by the allow-list (a later
 *     include line cannot re-publish one file of it);
 *  2. no public file REACHES into one — no import, require or dynamic import whose specifier names
 *     `extensions/<id>/` (a module there, its compiled `dist/extensions/<id>/`, its stubs);
 *  3. no public file's CODE names one: the patterns each private extension lists in its own
 *     `publictree.json` (`names`, regex sources — its id, its identifier prefixes, its CSS classes),
 *     matched with comments stripped, outside the explicit `NAMED_OK` list below. The patterns live
 *     in the private folder on purpose: the public tree carries neither the extension nor its names,
 *     and this check runs where both are (the repository the snapshot is cut from).
 *
 * Core finds extensions by folder (`packages/host/src/plugins/builtin.ts`, `features/registry.ts`'s
 * glob, `scripts/run-e2e.mjs`, the `packages/extensions/*\/test` glob in `test:host`), and reaches
 * what one contributes only through a seam (`shared/plugin.ts` on the host, `FeatureManifest` on the
 * phone — a backend's token ledger is a `LedgerViewDef`), so absence needs no edit. The expensive
 * half — the allow-listed tree copied out, built, type-checked and tested on its own — is
 * `node scripts/verify-public-tree.mjs`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, parseAllowlist, privateExtensions } from "../scripts/release/public-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const ALLOW = readFileSync(join(ROOT, "deploy/public-allowlist.txt"), "utf8");
const rules = parseAllowlist(ALLOW);
const PRIVATE = privateExtensions(ALLOW);
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const isPublic = (p) => classify(p, rules).included && !PRIVATE.some((id) => p.startsWith(`packages/extensions/${id}/`));
const SRC = /\.(?:[cm]?[jt]sx?|mts)$/;

/**
 * Public files allowed to match a private extension's `names`, each with the reason. A path here is
 * a decision somebody can read, never a way to make the check pass: fix the file first.
 */
const NAMED_OK = {
  "package-lock.json": "generated; base64 integrity hashes contain any two-letter prefix by chance",
  "tools/repohealth/fixture.json": "a recorded snapshot of this repository's own history (paths as they were), replayed by the repo-health tests",
};

test("every private-extension carve-out is written the way the guards read it", () => {
  // A carve-out spelt any other way (`!packages/extensions/x/` or a file glob) is not read by
  // `privateExtensions` and would silently drop out of every check below.
  for (const line of ALLOW.split("\n")) {
    const m = /^!packages\/extensions\/([^/\s]+)(\/.*)?$/.exec(line.trim());
    if (m) assert.equal(m[2], "/**", `write the carve-out as \`!packages/extensions/${m[1]}/**\` so the guards read it`);
  }
});

test("every file of a private extension is private by the allow-list", () => {
  const leaked = [];
  for (const id of PRIVATE) {
    const dir = `packages/extensions/${id}/`;
    // The folder itself, whether or not this checkout carries it (the public one does not).
    const mine = [...tracked.filter((p) => p.startsWith(dir)), `${dir}waterplane-plugin.json`, `${dir}web/index.ts`, `${dir}host/index.mts`];
    leaked.push(...mine.filter((p) => classify(p, rules).included));
  }
  assert.deepEqual(leaked, [], "deploy/public-allowlist.txt must exclude a private extension's whole folder");
});

test("no public file imports from a private extension", () => {
  if (!PRIVATE.length) return;
  const ids = PRIVATE.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const SPEC = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)(?:["'\`])([^"'\`]*extensions\\/(?:${ids})\\/[^"'\`]*)["'\`]`, "g");
  const JOINED = new RegExp(`\\bimport\\s*\\(\\s*join\\([^)]*["'\`][^"'\`]*extensions\\/(?:${ids})\\/`);
  const bad = [];
  for (const p of tracked) {
    if (!SRC.test(p) || !isPublic(p)) continue;
    let text;
    try { text = readFileSync(join(ROOT, p), "utf8"); } catch { continue; }
    for (const m of text.matchAll(SPEC)) bad.push(`${p}: ${m[1]}`);
    if (JOINED.test(text)) bad.push(`${p}: a joined path into a private extension`);
  }
  assert.deepEqual(bad, [], "a public file needs a private extension — reach it through a seam (plugin.ts, FeatureManifest) instead");
});

/**
 * Comments and nothing else blanked out of JS/TS/CSS, string literals kept — a string is code (a
 * wire value, a class name, a backend id); a comment naming an example is prose. Line structure is
 * kept so a hit can say where it is. Rough by design: a regex literal holding `//` can blank the
 * rest of its line, which can only HIDE a hit, never invent one.
 */
function stripComments(text, css = false) {
  let out = "", i = 0, q = null;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (q) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === q || (c === "\n" && q !== "`")) q = null;
      i++; continue;
    }
    if (c === "/" && n === "*") {
      const j = text.indexOf("*/", i + 2);
      const end = j < 0 ? text.length : j + 2;
      out += text.slice(i, end).replace(/[^\n]/g, " ");
      i = end; continue;
    }
    if (!css && c === "/" && n === "/") { const j = text.indexOf("\n", i); i = j < 0 ? text.length : j; continue; }
    if (c === '"' || c === "'" || (!css && c === "`")) q = c;
    out += c; i++;
  }
  return out;
}

const CODE = /\.(?:[cm]?[jt]sx?|mts|css|json|sh|tmpl)$|(?:^|\/)\.env\.example$/;

test("no public file's code names a private extension", () => {
  const pats = [];
  for (const id of PRIVATE) {
    // The names live in the private folder, so a public copy (scripts/verify-public-tree.mjs) has
    // nothing to check against; the bare id is no stand-in, an id like `links` is an English word.
    // The full tree's run checks the real names.
    if (!existsSync(join(ROOT, "packages/extensions", id))) continue;
    const f = join(ROOT, "packages/extensions", id, "publictree.json");
    const names = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).names : [`\\b${id}\\b`];
    for (const n of names) pats.push({ id, re: new RegExp(n, "g") });
  }
  if (!pats.length) return;
  const bad = [];
  for (const p of tracked) {
    if (!CODE.test(p) || !isPublic(p) || Object.hasOwn(NAMED_OK, p)) continue;
    let text;
    try { text = readFileSync(join(ROOT, p), "utf8"); } catch { continue; }
    if (SRC.test(p)) text = stripComments(text);
    else if (p.endsWith(".css")) text = stripComments(text, true);
    text.split("\n").forEach((line, k) => {
      for (const { id, re } of pats) for (const m of line.matchAll(re)) bad.push(`${p}:${k + 1}: ${m[0]}  (${id})`);
    });
  }
  assert.deepEqual(bad, [], "public code names a private extension — move it into the extension, reach it through a seam, or (with a reason) list the file in NAMED_OK");
});

test("every NAMED_OK exception is a file that still exists", () => {
  for (const p of Object.keys(NAMED_OK)) assert.ok(existsSync(join(ROOT, p)), `${p} is listed in NAMED_OK but gone — drop the entry`);
});

test("the comment stripper keeps strings and blanks comments", () => {
  const s = stripComments('const k = "// not a comment"; // gone\n/* gone\ntoo */ const j = `x/*y*/`;');
  assert.match(s, /"\/\/ not a comment"/);
  assert.doesNotMatch(s, /gone/);
  assert.match(s, /`x\/\*y\*\/`/);
  assert.equal(s.split("\n").length, 3, "line structure is kept");
});
