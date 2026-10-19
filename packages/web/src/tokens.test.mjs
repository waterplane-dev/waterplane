/**
 * The theme-independent scale at the top of `styles.css`: spacing, radius,
 * type size, weight, line height, shadow, duration.
 *
 * Before it existed the file spelled out 26 type sizes and 14 radii by hand
 * (12.5px beside 12px, 7px corners beside 8px, weights of 620 and 650), and
 * every new rule picked its own. The 2026-10-19 pass snapped them to the scale;
 * what stopped the drift last time was nothing, so this pins two things:
 *
 * 1. the scale is its OWN `:root {` block — never folded into a palette block,
 *    which `theme.test.mjs` parses as light/dark pairs;
 * 2. a raw px font-size or border-radius, or a numeric font-weight, is a
 *    ratchet: today's leftovers (hero numerals, a 21px half-height corner,
 *    1px hairline corners) are counted, and the count may only go DOWN. A new
 *    one is a decision — use a token, or raise the cap here and say why.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readAllCss } from "../../../tools/csssource.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readAllCss();
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/** The `:root { … }` block that holds the scale (not `:root, [data-theme="dark"]`). */
function scaleBlock() {
  const m = /(?:^|\n):root \{([^}]*)\}/.exec(css);
  assert.ok(m, "no bare `:root {` block: the scale has been folded into another block");
  return m[1];
}

/** Values of every (non-custom-property) declaration of `prop`. */
function values(propRe) {
  return [...css.matchAll(new RegExp(`(?:^|[;{\\s])(${propRe.source})\\s*:\\s*([^;}]+)`, "g"))].map((m) => m[2]);
}
const pxCount = (vs) => vs.reduce((n, v) => n + (v.match(/(?<![\w.-])\d*\.?\d+px/g) ?? []).length, 0);

test("the scale is its own :root block, separate from both palettes", () => {
  const body = scaleBlock();
  for (const fam of ["--sp-", "--r-", "--fs-", "--fw-", "--lh-", "--elev-", "--dur-"]) {
    assert.ok(body.includes(fam), `the scale block has no ${fam}* tokens`);
  }
  assert.match(body, /--focus-ring:/);
  // A palette block is found by its exact opening line; the scale must not be it.
  assert.ok(raw.includes(':root, [data-theme="dark"] {'), "the dark palette block moved");
  assert.ok(raw.includes('[data-theme="light"] {'), "the light palette block moved");
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, "a colour in the theme-independent scale");
});

test("font sizes are bare px tokens, so a subtree's --ui-font still scales them", () => {
  // `calc(12px * var(--ui-font))` resolved at :root would ignore the reader's
  // own --ui-font (ScrollbackSheet.tsx): the token holds the size, the call
  // site does the multiply.
  for (const m of scaleBlock().matchAll(/(--fs-\d+):\s*([^;]+);/g)) {
    assert.match(m[2].trim(), /^\d+px$/, `${m[1]} is not a bare px size`);
  }
});

test("every token a rule names is defined", () => {
  const defined = new Set([...scaleBlock().matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
  for (const m of css.matchAll(/var\((--(?:sp|r|fs|fw|lh|elev|dur)-[a-z0-9-]+)\)/g)) {
    assert.ok(defined.has(m[1]), `${m[1]} is used but not in the scale`);
  }
});

// Ratchet: lower these when a literal goes; raising one is a decision.
const MAX_RAW_FONT_SIZE_PX = 6;
const MAX_RAW_RADIUS_PX = 3;
const MAX_NUMERIC_FONT_WEIGHT = 0;

test("raw px font-sizes do not grow back", () => {
  const n = pxCount(values(/font-size/));
  assert.ok(n <= MAX_RAW_FONT_SIZE_PX, `${n} raw px font-sizes (cap ${MAX_RAW_FONT_SIZE_PX}): use calc(var(--fs-N) * var(--ui-font, 1))`);
});

test("raw px border radii do not grow back", () => {
  const n = pxCount(values(/border(?:-[a-z]+)*-radius/));
  assert.ok(n <= MAX_RAW_RADIUS_PX, `${n} raw px radii (cap ${MAX_RAW_RADIUS_PX}): use var(--r-N)`);
});

test("font weights are tokens", () => {
  const n = values(/font-weight/).filter((v) => /^\s*\d+\s*$/.test(v)).length;
  assert.ok(n <= MAX_NUMERIC_FONT_WEIGHT, `${n} numeric font-weights: use var(--fw-*)`);
});
