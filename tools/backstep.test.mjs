/**
 * Back from a step inside a sheet returns to the sheet — the gesture as much
 * as the arrow.
 *
 * ── Why this is a test and not a sentence ───────────────────────────────────
 *
 * The file browser opened a file as a second `SheetHead` held in `useState`.
 * Its arrow went back to the folder; the Android swipe, which pops ONE history
 * entry, popped the whole sheet and landed on the main view. Eight sheets had
 * the same shape, each written before the next, none of them wrong in review:
 * the arrow works, and the gesture is not something a diff shows. So the shape
 * is checked instead.
 *
 * A file that draws MORE THAN ONE sheet head whose `onClose` differ has a
 * sub-view with a back arrow of its own (a file, an editor, a detail pane). It
 * must also call `useBackStep` (`backStep.ts`), which gives that sub-view the
 * history entry the gesture pops — or be listed below with the reason it may
 * not. Heads that all close the same way (`SlashSheet`'s unsupported branch)
 * are one screen drawn two ways, not a step.
 *
 * ONE head whose `onClose` is itself a choice (`cut ? closeVault : goBack`)
 * is the same shape folded into one tag: the arrow does two different things,
 * so some screen behind it is not a route — the vault's sub-screens shipped
 * exactly that way, arrow fine and swipe out of the whole vault. The
 * extensions' web halves are scanned too; they are sheets like any other.
 *
 * Read as TEXT: no build, no import, no DOM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "packages", "web", "src");
const EXT = join(ROOT, "packages", "extensions");
/** packages/web/src, then every extension's web half — keyed relative to `packages/`. */
const ROOTS = [SRC, ...readdirSync(EXT).map((d) => join(EXT, d, "web")).filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })];
const PKGS = join(ROOT, "packages");

/** Files whose sub-view Back deliberately does NOT step out of — with why. */
const EXEMPT = {
  // The note editor's arrow DISCARDS the unsaved text (`closeEditor` clears
  // the draft). Wiring the gesture to it would turn a swipe into a delete of
  // typed words; as it is, the swipe leaves the sheet and the stashed draft
  // re-opens the editor next time (`local/no-draft-clobber`).
  "web/src/PadSheet.tsx": "arrow discards the draft",
};

function tsxFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** The `onClose` expression of every `<Sheet …>` / `<SheetHead …>` in `src`. */
function headCloses(src) {
  const closes = [];
  for (const m of src.matchAll(/<Sheet(?:Head)?\b(?:(?!<Sheet)[\s\S]){0,400}?onClose=\{([^}]*)\}/g)) closes.push(m[1].trim());
  return closes;
}

/** Two heads that close differently, or one whose close is a choice. */
const hasSubView = (closes) => new Set(closes).size >= 2 || closes.some((c) => /\?[^?]*:/.test(c.replace(/\?\./g, "")));

test("a sheet with a sub-view of its own gives it a Back step", () => {
  const missing = [];
  for (const f of ROOTS.flatMap(tsxFiles)) {
    const rel = relative(PKGS, f);
    const src = readFileSync(f, "utf8");
    const closes = headCloses(src);
    if (!hasSubView(closes)) continue;
    if (/\buseBackStep\(/.test(src) || EXEMPT[rel]) continue;
    missing.push(`${rel} (${closes.join(" | ")})`);
  }
  assert.deepEqual(missing, [], "these draw a sub-view with its own back arrow but no useBackStep — the swipe will close the whole sheet");
});

test("every exemption still names a file that would otherwise fail", () => {
  for (const rel of Object.keys(EXEMPT)) {
    const src = readFileSync(join(PKGS, rel), "utf8");
    const closes = headCloses(src);
    assert.ok(hasSubView(closes), `${rel} no longer has a sub-view head — drop its exemption`);
    assert.ok(!/\buseBackStep\(/.test(src), `${rel} uses useBackStep now — drop its exemption`);
  }
});
