/**
 * A solid accent fill means ONLY "tap here next" (`.key.primary`, at most one
 * per screen). A chosen option is a radio row (`kit/RadioRows.tsx`), a toggle
 * that is on is light green (`--pick-fill`/`--pick-edge`). Owner decision
 * 2026-10-13.
 *
 * ── Why this is a test and not a sentence ───────────────────────────────────
 *
 * Every "selected" style in the app was once `background: var(--accent)`, so
 * a filter row read as three primary verbs and the person could not tell the
 * option they had picked from the button they should press. The fix touched a
 * dozen rules; the next new picker copies whichever one it finds first.
 *
 * Read as TEXT: every innermost CSS rule whose selector names a chosen state
 * (`.on`, `.active`, `[aria-pressed]`, `[aria-checked]`, `:checked`) must not
 * paint its background with the solid accent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname;

/** Pre-existing chosen-state fills that are NOT a choice among options, each with why. */
const ALLOWED = new Map([
  [".tr-hit.on", "the search hit the reader is scrolled to — a position marker, not a choice"],
  [".tpick-row.on .tpick-box", "the tick box of a multi-select row — a checkbox, not a choice among options"],
  [".set-sw.on .set-state", "a single on/off switch's state word; kept until the owner decides (radio-rows report)"],
]);

function sheets() {
  const out = [join(ROOT, "packages/web/src/styles.css")];
  const ext = join(ROOT, "packages/extensions");
  for (const name of readdirSync(ext)) {
    const web = join(ext, name, "web");
    if (!existsSync(web)) continue;
    for (const f of readdirSync(web)) if (f.endsWith(".css")) out.push(join(web, f));
  }
  return out;
}

const CHOSEN = /\.(?:on|active)\b|aria-(?:pressed|checked)|:checked/;
const SOLID_ACCENT = /background(?:-color)?\s*:\s*var\(--accent\)\s*(?:;|!|$)/;

test("no chosen state paints the solid accent fill", () => {
  const bad = [];
  for (const file of sheets()) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2].trim();
      if (!SOLID_ACCENT.test(body)) continue;
      for (const sel of m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "))) {
        if (CHOSEN.test(sel) && !ALLOWED.has(sel)) bad.push(`${relative(ROOT, file)}: ${sel}`);
      }
    }
  }
  assert.deepEqual(bad, [], "a chosen option is a radio row (kit/RadioRows) or --pick-fill, never background: var(--accent)");
});

test("the allow-list names only rules that still exist", () => {
  const css = sheets().map((f) => readFileSync(f, "utf8")).join("\n");
  for (const sel of ALLOWED.keys()) assert.ok(css.includes(sel), `${sel} is gone — drop it from ALLOWED`);
});
