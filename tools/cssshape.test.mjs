/**
 * The main stylesheet's SHAPE: `styles.css` is an index, the rules live in numbered slices.
 *
 * One 8,000-line file was the cascade AND the thing nobody could open. The split is by line range in the
 * original order (never by feature: the same family recurs in distant places and moving a rule changes
 * what wins), so order is behaviour and the index is where it is written down. This pins what keeps it so:
 * the index holds `@import` lines and comments only, the import order is the sorted `NN-` prefix, every
 * slice is under the cap, and the wide layout (which overrides everything above it) stays last.
 * Tests that read "the CSS" go through `csssource.mjs`, never one slice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { STYLES_INDEX, cssFiles } from "./csssource.mjs";

const MAX_SLICE_LINES = 650;
const MAX_INDEX_LINES = 40;
const dir = join(dirname(STYLES_INDEX), "styles");
const lines = (f) => readFileSync(f, "utf8").split("\n").length - 1;

test("styles.css is an index: @import lines and comments only, and small", () => {
  const text = readFileSync(STYLES_INDEX, "utf8");
  const rest = text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of rest) assert.match(l, /^@import "\.\/styles\/\d\d-[a-z-]+\.css";$/, `not an import: ${l}`);
  assert.ok(lines(STYLES_INDEX) <= MAX_INDEX_LINES, "the index grew: rules belong in a slice");
});

test("the import order is the sorted NN- prefix and covers every slice on disk", () => {
  const imported = cssFiles().map((f) => basename(f));
  const onDisk = readdirSync(dir).filter((n) => n.endsWith(".css")).sort();
  assert.deepEqual(imported, onDisk, "styles/ and the @import list must agree, in order");
  imported.forEach((n, i) => assert.equal(n.slice(0, 2), String(i).padStart(2, "0"), `${n} is out of sequence`));
  assert.match(imported[imported.length - 1], /^\d\d-wide-layout\.css$/, "the wide layout overrides everything: it stays last");
  assert.match(imported[0], /^00-tokens\.css$/, "the palette and token scale come first");
});

test(`every slice is at most ${MAX_SLICE_LINES} lines`, () => {
  for (const f of cssFiles()) assert.ok(lines(f) <= MAX_SLICE_LINES, `${basename(f)}: ${lines(f)} lines — start a new slice at a rule boundary`);
});
