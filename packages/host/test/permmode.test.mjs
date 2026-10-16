/**
 * The permission mode and ultracode, read off the claude TUI's rendered grid
 * (`permmode.ts`).
 *
 * Every fixture under `fixtures/permmode/` is a real `tmux capture-pane -p` of
 * claude 2.1.293, taken by pressing shift+tab (`BTab`) through the cycle in a
 * private tmux server — only the scratch directory's path was replaced. The
 * `[CAVEMAN]` row is a status line a user's own settings draw: kept, because
 * a footer with somebody's status line in it is the footer the reader meets.
 *
 * The rule under test: a mode or null, never a wrong mode.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composerFrame, readPermMode, readUltracode, ultracodeVerdict, permModeWords } from "../dist/permmode.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "permmode");
const fx = (name) => readFileSync(join(DIR, `${name}.txt`), "utf8").replace(/\n$/, "");

test("every mode in the 2.1.293 cycle reads as itself", () => {
  const want = {
    "auto": "auto",
    "manual": "default",
    "accept-edits": "acceptEdits",
    "plan": "plan",
    "bypass": "bypassPermissions",
    "dont-ask": "dontAsk",
  };
  for (const [name, mode] of Object.entries(want)) {
    assert.equal(readPermMode(fx(name)), mode, name);
  }
});

test("the default mode's own label is `manual mode on` on this binary", () => {
  // Measured: wherever auto mode is available the default mode is LABELLED.
  // The task brief expected no label; the binary disagrees.
  assert.match(fx("manual"), /⏸ manual mode on/);
  assert.equal(readPermMode(fx("manual")), "default");
  // …with no status line drawn above it, and the shortcut hint beside it.
  assert.equal(readPermMode(fx("manual-no-statusline")), "default");
});

test("a narrow phone-width grid still reads, including a padded or cut row", () => {
  assert.equal(readPermMode(fx("plan-46col")), "plan");
  assert.equal(readPermMode(fx("auto-28col")), "auto");        // `⏵⏵ auto mode on      · …`
  assert.equal(readPermMode(fx("manual-28col")), "default");
});

test("words in the composer do not move the reading", () => {
  assert.equal(readPermMode(fx("accept-edits-typing")), "acceptEdits");
});

test("the ultracode label on the composer's top rule does not blind the reader", () => {
  // `──── ultracode ─` is not a bare rule — delivery's composer anchor
  // (`echo.ts`) does not accept it; this reader must.
  const f = composerFrame(fx("ultracode-on").split("\n"));
  assert.ok(f);
  assert.equal(f.label, "ultracode");
  assert.equal(readPermMode(fx("ultracode-on")), "default");
});

test("a box over the footer reads as null — never a mode", () => {
  for (const name of ["permission-box", "trust-box", "model-picker", "effort-picker"]) {
    assert.equal(readPermMode(fx(name)), null, name);
  }
});

test("no label is `default` only beside the shortcut hint — else null", () => {
  // Synthesised from a real grid (the 2.1.293 binary always labels): an
  // older binary, or an account without auto mode, draws no label.
  const base = fx("manual-no-statusline");
  const unlabelled = base.replace("⏸ manual mode on · ", "");
  assert.match(unlabelled, /\? for shortcuts/);
  assert.equal(readPermMode(unlabelled), "default");
  // A footer that is neither a label nor the hint (a transient message) is
  // not evidence of anything.
  const transient = base.replace(/⏸ manual mode on.*$/m, "  Press Ctrl-C again to exit");
  assert.equal(readPermMode(transient), null);
});

test("two mode rows under one composer are a torn frame, not a mode", () => {
  const torn = fx("plan") + "\n  ⏵⏵ auto mode on (shift+tab to cycle)";
  assert.equal(readPermMode(torn), null);
});

test("text that SAYS a mode is not the footer", () => {
  // The words in the transcript, not under a composer.
  assert.equal(readPermMode("  ⏸ plan mode on (shift+tab to cycle)"), null);
  // A status line that merely mentions it, mid-row.
  const said = fx("manual").replace("[CAVEMAN]", "[x] plan mode on soon");
  assert.equal(readPermMode(said), "default");
});

test("nothing on screen, or garbage, is null", () => {
  assert.equal(readPermMode(""), null);
  assert.equal(readPermMode("just output\nmore output"), null);
});

test("a slash menu (too many rows under the box) is null", () => {
  const menu = Array.from({ length: 8 }, (_, i) => `  /cmd${i}   does a thing`).join("\n");
  const grid = fx("plan").replace(/\n  \[CAVEMAN\][\s\S]*$/, "\n" + menu);
  assert.equal(readPermMode(grid), null);
});

test("ultracode: the confirmation lines and the composer label", () => {
  assert.deepEqual(readUltracode(fx("ultracode-on")), { border: "label", line: true });
  assert.deepEqual(readUltracode(fx("ultracode-off")), { border: "plain", line: false });
  // The effort picker's Tab then `s`: the same two lines.
  assert.deepEqual(readUltracode(fx("ultracode-on-picker")), { border: "label", line: true });
  assert.deepEqual(readUltracode(fx("ultracode-off-picker")), { border: "plain", line: false });
});

test("ultracode: a picker's `Ultracode on` is not a confirmation", () => {
  // The model picker draws `· Ultracode on (/effort)`, the effort picker
  // `Ultracode  on` — mid-row, so neither may count.
  assert.deepEqual(readUltracode("   ● High effort ←/→ to adjust · Ultracode on (/effort)"), { border: null, line: null });
  assert.deepEqual(readUltracode("   ────▲───      Ultracode  on"), { border: null, line: null });
  // The real model picker fixture DOES carry a real confirmation above it — the newest one wins.
  assert.equal(readUltracode(fx("model-picker")).line, true);
});

test("ultracode: refusals read as off; a wrapped confirmation still reads", () => {
  assert.equal(readUltracode("  ⎿  Ultracode needs dynamic workflows enabled (see /config).").line, false);
  assert.equal(readUltracode("  ⎿  Ultracode isn't available on Haiku 4.5").line, false);
  assert.equal(readUltracode("  ⎿  Ultracode on\n  (this session only): dynamic").line, true);
  assert.equal(readUltracode("  ⎿  Ultracode on\n  something else").line, null);
});

test("ultracode verdict: label beats lines; a bare rule says off only once the label was ever seen", () => {
  assert.equal(ultracodeVerdict({ border: "label", line: false }, false), true);
  assert.equal(ultracodeVerdict({ border: "plain", line: true }, true), false);
  assert.equal(ultracodeVerdict({ border: "plain", line: true }, false), true);
  assert.equal(ultracodeVerdict({ border: "plain", line: null }, false), null);
  assert.equal(ultracodeVerdict({ border: null, line: null }, true), null);
});

test("the words for a mode are the CLI's own", () => {
  assert.equal(permModeWords("default"), "manual");
  assert.equal(permModeWords("bypassPermissions"), "bypass permissions");
});
