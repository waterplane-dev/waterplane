/**
 * The hand-drawn architecture diagrams cannot name things that are gone.
 *
 * docs/assets/architecture*.svg are drawn by hand, so nothing regenerates them when a module is
 * renamed. Every `<text>` that looks like a repo path or module file is resolved against a small,
 * explicit list of search roots; a token passes if it exists under any root. Also: the
 * architecture note links every picture, every link resolves, and the README links the note.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...a) => join(ROOT, ...a);

const extDirs = readdirSync(p("packages/extensions"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `packages/extensions/${d.name}`);

const SEARCH_ROOTS = [
  "",
  "packages/host/src",
  "packages/host/src/plugins",
  "packages/host/src/sessions",
  "packages/host/src/intents",
  "packages/host/src/backends",
  "packages/web/src",
  "packages/web/src/core",
  "packages/shared/src",
  "packages/shared/src/wire",
  "deploy",
  ...extDirs,
].map((r) => p(r));

/** Tokens that are not repo files at a searchable path. Each needs a reason. */
const ALLOW = new Map([
  // Checked 2026-10: none of these exists as a file at a searchable path in this repo.
  ["host.mjs", "the entry file an EXTERNAL plugin ships in its own repo (contract: shared/plugin.ts); in-repo extensions use host/ dirs"],
  ["release.json", "written into a release bundle by scripts/release/build.mjs, not committed"],
  [".waterplane/plugins.json", "a per-repo file in the DRIVEN repo, not this one"],
  ["plugin-paths.json", "a file in the person's config dir (pluginloader.ts), not this repo"],
]);

const FAIL =
  "a diagram names something that is gone — update the picture in the same commit as the code (docs/notes/architecture.md)";

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const FILE_EXT = /\.(?:ts|tsx|mjs|mts|json)$/;
const DIR_TOKENS = new Set(["server", "sessions", "intents", "backends", "plugins", "capture", "routes", "core", "sdk", "features", "kit", "wire"]);

function tokensOf(text) {
  const out = [];
  for (const raw of text.split(/[\s,;()]+/)) {
    const t = raw.replace(/^[`'"]+|[`'".:]+$/g, "");
    if (!t || t.startsWith("~")) continue;
    if (FILE_EXT.test(t) || t.startsWith("packages/")) out.push(t);
    else if (t.endsWith("/") && DIR_TOKENS.has(t.slice(0, -1))) out.push(t);
  }
  return out;
}

/** Fixed prefix of a path with placeholders (`<id>`, `<name>`, `*`). */
function fixedPrefix(t) {
  const i = t.search(/[<*]/);
  if (i < 0) return t;
  return t.slice(0, i).replace(/[^/]*$/, "").replace(/\/$/, "");
}

function resolves(token) {
  const fixed = fixedPrefix(token);
  if (fixed === "") return true;
  return SEARCH_ROOTS.some((r) => existsSync(join(r, fixed)));
}

const svgs = readdirSync(p("docs/assets")).filter((f) => /^architecture.*\.svg$/.test(f));

test("there are architecture diagrams to check", () => {
  assert.ok(svgs.length >= 3, `expected the three architecture svgs, found ${svgs.join(", ")}`);
});

for (const svg of svgs) {
  test(`${svg}: every path/module it names exists`, () => {
    const src = readFileSync(p("docs/assets", svg), "utf8");
    const texts = [...src.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
      unescape(m[1].replace(/<[^>]+>/g, "")),
    );
    const missing = [];
    for (const t of texts)
      for (const tok of tokensOf(t)) {
        if (ALLOW.has(tok) || resolves(tok)) continue;
        missing.push(tok);
      }
    assert.deepEqual(missing, [], `${svg} names ${missing.map((m) => `"${m}"`).join(", ")}: ${FAIL}`);
  });
}

test("docs/notes/architecture.md links every architecture svg, and each link exists", () => {
  const md = readFileSync(p("docs/notes/architecture.md"), "utf8");
  const linked = [...md.matchAll(/\]\(([^)\s]*assets\/architecture[^)\s]*\.svg)\)/g)].map((m) => m[1]);
  for (const svg of svgs)
    assert.ok(linked.some((l) => l.endsWith(`assets/${svg}`)), `docs/notes/architecture.md does not link docs/assets/${svg}`);
  for (const l of linked) assert.ok(existsSync(p("docs/notes", l)), `docs/notes/architecture.md links ${l}, which does not exist`);
});

test("README.md links docs/notes/architecture.md", () => {
  assert.match(readFileSync(p("README.md"), "utf8"), /\]\(docs\/notes\/architecture\.md\)/);
});
