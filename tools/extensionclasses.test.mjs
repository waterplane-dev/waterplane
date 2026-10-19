/**
 * Every class an in-repo extension's web code names in a literal `className`
 * is one a stylesheet defines.
 *
 * ── Why this is a test and not a sentence ───────────────────────────────────
 *
 * Extensions draw with `packages/web/src/styles.css`'s vocabulary but live
 * outside it, so a made-up class name type-checks, lints and renders — as bare
 * unstyled text. The token-stats backend ledger tab shipped with `.ts-card`,
 * `.ts-kinds` and `.ts-kind-row` (none exist) and was fixed; the All backends
 * and Local runner views, written beside it, shipped the same three a day later
 * and were caught off a phone screenshot. A review cannot see a missing rule.
 *
 * Read as TEXT: only literal `className="…"` strings are checked; computed
 * class names are not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cssFiles } from "./csssource.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = join(ROOT, "packages", "extensions");

/** Named on purpose with no rule of their own — a hook, not a style. */
const UNSTYLED = new Map([
  ["ts-barrow", "the wrapper of one bar; its head and track carry the styles"],
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(EXT);
const css = [...cssFiles(), ...files.filter((f) => f.endsWith(".css"))]
  .map((f) => readFileSync(f, "utf8")).join("\n");
const defined = new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));

test("every literal className in an extension's web code is defined in a stylesheet", () => {
  const missing = [];
  for (const f of files.filter((p) => /\/web\/.*\.tsx$/.test(p))) {
    for (const m of readFileSync(f, "utf8").matchAll(/className="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/).filter(Boolean)) {
        if (!defined.has(c) && !UNSTYLED.has(c)) missing.push(`${relative(ROOT, f)}: .${c}`);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [], "use a class styles.css defines (see token-stats/web/LedgerParts.tsx), or add the rule");
});
