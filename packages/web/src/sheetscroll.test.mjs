/**
 * A sheet can always be scrolled.
 *
 * `.sheet` is a viewport-high flex column; its own scroll region (`.list`, `.build-body`, …) takes
 * `min-height: 0` and scrolls. Everything ELSE in the column keeps its content height — so a long
 * failure text above the Build sheet's body, a wrapped head or an extra hint pushed the rest past
 * the bottom edge with nothing to scroll. That recurred sheet by sheet, each fixed locally. The bare
 * `.sheet` rule's `overflow-y: auto` is the one fallback for all of them; nothing may take it back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readAllCss } from "../../../tools/csssource.mjs";

const css = readAllCss().replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

test("the bare .sheet rule scrolls when its fixed children outgrow the screen", () => {
  const bare = rules.filter((r) => r.sel.split(",").some((s) => s.trim() === ".sheet"));
  assert.ok(bare.length, "no bare .sheet rule found");
  assert.ok(bare.some((r) => /(^|;)\s*overflow(-y)?\s*:\s*auto/.test(r.body)), ".sheet lost overflow-y: auto");
});

test("no rule on a .sheet itself turns its overflow off", () => {
  for (const r of rules) {
    const onSheet = r.sel.split(",").some((s) => /\.sheet(?![\w-])(?:[.:[][^\s>+~]*)?$/.test(s.trim()));
    if (onSheet) assert.doesNotMatch(r.body, /(^|;)\s*overflow(-y)?\s*:\s*(hidden|clip|visible)/, `${r.sel} turns the sheet's fallback scroll off`);
  }
});
