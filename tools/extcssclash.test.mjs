/**
 * An extension's stylesheet must not define a BARE class rule (`.x { … }`) that the main stylesheet or another
 * extension also defines bare: both load into one page, so whichever comes later in the cascade silently wins.
 * 2026-11-22: the scorecard's score head `.sc-head { padding: 8px 14px }` lost to Setup check's
 * `.sc-head { padding: 6px 0 }` and the score sat on the screen's left edge. Scoped rules (`.sc-hist .section-head`)
 * are how an extension adjusts a shared class, and stay allowed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cssFiles } from "./csssource.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "packages", "extensions");

/** The classes a stylesheet styles with a selector that is that class alone. */
export function bareClasses(text) {
  const out = new Set();
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]+)\{/g)) {
    for (const sel of m[1].split(",")) { const k = sel.trim().match(/^\.([\w-]+)$/); if (k) out.add(k[1]); }
  }
  return out;
}

const extCss = () => readdirSync(EXT).flatMap((e) => {
  const d = join(EXT, e, "web");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".css")).map((f) => join(d, f)) : [];
});

test("bareClasses picks only lone-class selectors", () => {
  assert.deepEqual([...bareClasses(".a { x: 1 } .b .c { } .d, .e:hover, .f { } /* .g { } */")], ["a", "d", "f"]);
});

test("no extension stylesheet redefines a bare class from the main stylesheet or another extension", () => {
  const owner = new Map();
  for (const f of cssFiles()) for (const c of bareClasses(readFileSync(f, "utf8"))) owner.set(c, f);
  const clashes = [];
  for (const f of extCss()) for (const c of bareClasses(readFileSync(f, "utf8"))) {
    if (owner.has(c) && owner.get(c) !== f) clashes.push(`.${c} in ${relative(ROOT, f)} — also bare in ${relative(ROOT, owner.get(c))}`);
    else owner.set(c, f);
  }
  assert.deepEqual(clashes, [], "rename the extension's class (give it the extension's own prefix), or scope the rule under the extension's root");
});
