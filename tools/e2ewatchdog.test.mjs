// Every e2e script's whole-script hang guard goes through `watchdog()`
// (`scripts/lib-watchdog.mjs`), never an inline `setTimeout`.
//
// An inline one carries a number picked off the script's solo run, and the
// full suite runs two to three times slower: e2e-setup's 15 s line fired on a
// run that was still passing every check and blocked a push, with eleven more
// scripts sitting on the same 15 s. The helper holds the floor; this keeps a
// new script from writing its own.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { watchdog, WATCHDOG_FLOOR_MS } from "../scripts/lib-watchdog.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const e2eIn = (dir) => readdirSync(dir).filter((f) => /^e2e-.*\.mjs$/.test(f)).map((f) => join(dir, f));
const scripts = () => {
  const ext = join(ROOT, "packages", "extensions");
  const own = readdirSync(ext).flatMap((x) => { try { return e2eIn(join(ext, x, "e2e")); } catch { return []; } });
  return [...e2eIn(join(ROOT, "scripts")), ...own];
};

// Top level, as a statement or a `const bail = …`, and saying it timed out:
// the shape every inline watchdog in the suite had. A `setTimeout` that exits
// after a short flush is not one and is left alone.
const INLINE = /^(?:(?:const|let) \w+ = )?setTimeout\(.*time[sd]? ?out/i;

test("no e2e script arms its own inline watchdog", () => {
  const found = scripts().flatMap((f) => readFileSync(f, "utf8").split("\n")
    .flatMap((l, i) => (INLINE.test(l) ? [`${relative(ROOT, f)}:${i + 1}`] : [])));
  assert.deepEqual(found, [], `use watchdog() from scripts/lib-watchdog.mjs instead:\n${found.join("\n")}`);
});

test("a watchdog never fires before the floor, however short it was asked to be", () => {
  // `_idleTimeout` is node's own record of the delay; read it before clearing, which resets it.
  const t = watchdog(() => {}, 1);
  const longer = watchdog(() => {}, WATCHDOG_FLOOR_MS * 2);
  const [short, long] = [t._idleTimeout, longer._idleTimeout];
  clearTimeout(t);
  clearTimeout(longer);
  assert.equal(short, WATCHDOG_FLOOR_MS);
  assert.equal(long, WATCHDOG_FLOOR_MS * 2);
});
