/**
 * Where the product's name may be spelled, and how much of the old one is left.
 *
 * `packages/shared/src/brand.ts` holds every brand-bearing value; the lint rule
 * `no-brand-literal` keeps TS sources reading it. What cannot import it — JSON,
 * XML, Java, shell, html, markdown — is checked here, by `git grep` over the
 * tracked tree, so the next rename is: edit `brand.ts`, run this, fix what it
 * lists. Three checks:
 *
 *  1. the lint rule's `words` option in `eslint.config.js` equals the built
 *     `BRAND_WORDS` (lint runs before `build:shared`, so the config cannot import
 *     it and must spell it — this is what keeps the two from drifting);
 *  2. the CURRENT name appears only in `brand.ts` and the enumerated places that
 *     cannot import it. A COMMENT in a code file is prose, like `*.md`, and is
 *     not counted: the lint rule (at `error`) is what keeps the VALUES in code
 *     reading `BRAND`, and a comment saying `<PREFIX>PORT` the long way is
 *     the next rename's sed, not a value it could miss;
 *     The Android shell's files are generated from BRAND by `scripts/brand-android.mjs`
 *     (`npm run brand:android`); a test here runs it with `--check`, so drift fails;
 *  3. the LEGACY words are a RATCHET: the number of lines carrying one, outside
 *     history (`*.md`, `docs/**`) and `brand.ts`, may only go down — comments
 *     included, because an old name in prose is stale prose. Lower
 *     `LEGACY_BASELINE` when it does. What is left is legitimate: readers of
 *     the old names (migration, fallbacks, the deprecated plugin alias), test
 *     fixtures whose sample repo is called by the old name, and machine paths
 *     that change only when the checkout itself moves.
 *
 * No literal of any brand word is written in this file: every word is read
 * from the built `brand.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rules from "./eslint/rules.js";
import { BRAND, LEGACY, BRAND_WORDS } from "../packages/shared/dist/index.js";

const ROOT = new URL("..", import.meta.url).pathname;

/** Lines carrying a legacy word outside history and `brand.ts`. Measured
 *  2026-10-01 at the foundation commit (1201), then at the rename's flip.
 *  May only go DOWN. 48 -> 51 on 2026-10-12 is not new spelling: the build
 *  buttons moved from the untracked per-desktop builds.json into the tracked
 *  `.waterplane-shared/builds.json`, and three of their lines (the CLI
 *  fallback's machine path, the web zip's file name, the mirror's echo) became
 *  visible to `git grep`. */
const LEGACY_BASELINE = 51;

const BRAND_FILE = "packages/shared/src/brand.ts";

/** Places that cannot import `brand.ts` and may spell the CURRENT name. Each is
 *  a checklist item for the next rename. */
const CURRENT_NAME_ALLOWED = [
  (p) => p === BRAND_FILE,
  (p) => p === "eslint.config.js",                 // the lint rule's words (check 1)
  (p) => p.endsWith(".md"),                        // prose, CHANGELOG, skills
  (p) => p === "package.json" || p.endsWith("/package.json"),
  (p) => p === "package-lock.json" || p.endsWith("/package-lock.json"),
  // The Android shell's identity: written by scripts/brand-android.mjs, whose --check the test below runs.
  // Dependency-free so another repo can copy it as it is (the versions.jsonl record writer).
  (p) => p === "scripts/build-record.mjs",
  (p) => p === "packages/app/capacitor.config.ts",
  (p) => p === "packages/app/android/app/build.gradle",
  (p) => p.startsWith("packages/app/android/app/src/") && /\/(strings\.xml|AndroidManifest\.xml)$|\.java$/.test(p),
  // The iOS shell's identity (bundle id, display name, scheme, the simulator script). No
  // generator yet like brand-android.mjs: until there is one, these are the rename checklist.
  (p) => p === "packages/app/ios/App/App.xcodeproj/project.pbxproj",
  (p) => /^packages\/app\/ios\/App\/App\/[^/]+\.(plist|swift)$/.test(p),
  (p) => p === "packages/app/scripts/ios-sim.sh",
  // The Play Store listing: plain text release:play uploads verbatim as the store page.
  (p) => p.startsWith("packages/app/play/listings/"),
  (p) => p.startsWith(".github/"),
  (p) => p.startsWith("deploy/"),                  // plist template, npm placeholder
  (p) => p === ".env.example",                     // the documented list of every knob, by its full name
  (p) => p === ".gitignore",                       // the state dir, current and legacy
  (p) => p.endsWith("/waterplane-plugin.json"),     // a plugin manifest's "env" names the knobs api.env() may read; JSON cannot import BRAND
  (p) => p === ".waterplane-shared/builds.json",   // build buttons: shell commands in JSON, cannot import BRAND
  (p) => p.startsWith("brand/"),                   // the logo kit's sources (wordmark text, hero)
  (p) => p.startsWith("site/"),                    // waterplane.dev: static HTML generated from the README (scripts/site), plus CNAME; cannot import BRAND
  (p) => /^docs\/assets\/.*\.svg$/.test(p),
  // A parked diff under docs/plans: a snapshot of code that is not in the tree yet. It is
  // history like a CHANGELOG, and when it lands its hunks are linted as code like any other.
  (p) => /^docs\/plans\/.*\.(?:patch|diff)$/.test(p),
  (p) => /^scripts\/ui\/snapshots\/.*\.aria\.txt$/.test(p), // what the screen says, logo alt text included
  // An extension's standalone, dependency-free CLI symlinked into ~/.local/bin (and the
  // modules under its cli/ dir): it cannot import the TS BRAND and finds the state dir by
  // the same rule as branddirs.ts. The vault's vendored Python client (cli/client/*.py) likewise.
  (p) => /^packages\/extensions\/[^/]+\/cli\/(?:[^/]+\/)*[^/]+\.(?:mjs|py)$/.test(p),
  (p) => p.startsWith("packages/host/templates/"), // copied verbatim into a person's new repo; cannot import BRAND        // diagrams: prose drawn as a picture, cannot import BRAND
  // Test fixtures: a test pins a name as a person would type it or find it on
  // disk; one that derived its expectation from BRAND could not catch BRAND
  // itself going wrong.
  (p) => /(^|\/)test\//.test(p) || p.endsWith(".test.mjs"),
];

/** Code files and stylesheets: their comments are prose (see the header, check 2). */
const CODE = /\.(m?[jt]sx?|cjs|css)$/;

/** The part of a code line that is code — "" for a whole-line comment, the
 *  text before a trailing ` // ` comment otherwise. Other files: the line. */
function codePart(path, text) {
  if (!CODE.test(path)) return text;
  const t = text.trimStart();
  if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return "";
  const i = text.search(/\s\/\/\s/);
  return i >= 0 ? text.slice(0, i) : text;
}

/** History and the source of truth: never counted against the ratchet. */
const isHistory = (p) => p === BRAND_FILE || p.endsWith(".md") || p.startsWith("docs/");

/** `path:line` for every tracked line matching any of `words`, case-insensitive. */
function grepLines(words) {
  const args = ["grep", "-n", "-I", "-i", "-F"];
  for (const w of words) args.push("-e", w);
  let out;
  try {
    out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e) {
    if (e.status === 1) return []; // no match
    throw e;
  }
  return out.split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf(":");
    const j = l.indexOf(":", i + 1);
    return { path: l.slice(0, i), line: Number(l.slice(i + 1, j)), text: l.slice(j + 1) };
  });
}

test("the lint rule's words are exactly BRAND_WORDS", () => {
  const cfg = readFileSync(join(ROOT, "eslint.config.js"), "utf8");
  const m = cfg.match(/const BRAND_WORDS = (\[[^\]]*\]);/);
  assert.ok(m, "eslint.config.js must declare `const BRAND_WORDS = [...]` for no-brand-literal");
  assert.deepEqual(JSON.parse(m[1]), [...BRAND_WORDS],
    "eslint.config.js BRAND_WORDS has drifted from shared/src/brand.ts — copy the built list");
  assert.match(cfg, /"[a-z]+\/no-brand-literal": \["error", \{ words: BRAND_WORDS \}\]/,
    "eslint.config.js must register no-brand-literal with the BRAND_WORDS option");
});

test("BRAND_WORDS covers the current name and every legacy word", () => {
  for (const w of [BRAND.name, BRAND.slug, ...LEGACY.flatMap((l) => l.words)]) {
    assert.ok(BRAND_WORDS.includes(w.toLowerCase()), `BRAND_WORDS is missing ${w}`);
  }
});

test("the current name is spelled only in brand.ts and the enumerated places", () => {
  const words = [...new Set([BRAND.name, BRAND.slug].map((w) => w.toLowerCase()))];
  // A package specifier (`@<slug>/shared`, bare `@<slug>`) is the npm scope, not a spelling of the name.
  const scope = new RegExp(`@${BRAND.slug}(?![A-Za-z0-9-])`, "gi");
  const stray = grepLines(words)
    .filter((h) => words.some((w) => codePart(h.path, h.text).toLowerCase().replace(scope, "").includes(w)))
    .filter((h) => !CURRENT_NAME_ALLOWED.some((ok) => ok(h.path)));
  assert.deepEqual(stray.map((h) => `${h.path}:${h.line}`), [],
    "read these from BRAND in shared/src/brand.ts (or, for a file that cannot import it, " +
    "add it to CURRENT_NAME_ALLOWED in tools/brand.test.mjs with the reason)");
});

test("the Android shell's identity is exactly what BRAND generates (scripts/brand-android.mjs --check)", () => {
  try {
    execFileSync("node", ["scripts/brand-android.mjs", "--check"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    assert.fail(`${e.stderr || e.stdout || e.message}`);
  }
});

test("the legacy name only ever shrinks (ratchet)", () => {
  const words = [...new Set(LEGACY.flatMap((l) => l.words))];
  const live = grepLines(words).filter((h) => !isHistory(h.path));
  // The lint config must spell every word, legacy included, to find them.
  const counted = live.filter((h) => !(h.path === "eslint.config.js" && /const BRAND_WORDS =/.test(h.text)));
  const n = counted.length;
  assert.ok(n <= LEGACY_BASELINE,
    `${n} lines outside history still carry a legacy brand word — ${n - LEGACY_BASELINE} more than ` +
    `the ratchet allows (${LEGACY_BASELINE}). Read the value from BRAND/LEGACY in ` +
    `shared/src/brand.ts (env("X"), lsKey("x"), logTag, …) instead of spelling it.`);
  if (n < LEGACY_BASELINE) {
    console.log(`# brand ratchet: ${n} < baseline ${LEGACY_BASELINE} — lower LEGACY_BASELINE in tools/brand.test.mjs`);
  }
});

test("no-brand-literal flags strings, templates and JSX text, never an import source", () => {
  const linter = new Linter({ configType: "flat" });
  const config = [{
    files: ["**/*.tsx"], plugins: { local: rules },
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { "local/no-brand-literal": ["error", { words: [...BRAND_WORDS] }] },
  }];
  const lint = (code) => linter.verify(code, config, { filename: "x.tsx" });
  const old = LEGACY[0].slug, cur = BRAND.slug;
  const up = (w) => w.toUpperCase();
  assert.equal(lint(`const a = "${old}.pad";`).length, 1);
  assert.equal(lint(`const a = "${up(cur)}_PORT";`).length, 1, "case-insensitive");
  assert.equal(lint("const a = `[" + old + "] ${x}`;").length, 1);
  assert.equal(lint(`const a = <b>about ${cur}</b>;`).length, 1);
  assert.match(lint(`const a = "${old}";`)[0].message, /brand\.ts/);
  assert.deepEqual(lint(`import { x } from "@${old}/shared"; export * from "@${old}/kit"; const y = import("@${old}/sdk");`), []);
  assert.deepEqual(lint(`const a = "plain";`), []);
  // No words configured, nothing flagged.
  const bare = [{ ...config[0], rules: { "local/no-brand-literal": "error" } }];
  assert.deepEqual(linter.verify(`const a = "${old}";`, bare, { filename: "x.tsx" }), []);
});
