/**
 * The shortcuts the CLI names on screen (`keyhints.ts`), read off the same
 * real claude 2.1.293 grids the mode reader is pinned by (`fixtures/permmode/`).
 *
 * The rule under test: a key the footer or the open picker names, or nothing —
 * never a key the screen did not offer, never one the phone's row already has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readKeyHints } from "../dist/keyhints.js";
import { keyHintBytes, keyHintLabel, sameKeyHints } from "@waterplane/shared";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "permmode");
const SCREENS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "screens");
const grid = (f) => readFileSync(join(DIR, f), "utf8");
const keys = (s) => readKeyHints(s).map((h) => `${h.key}=${h.verb}`);

test("footer: shift+tab to cycle, in every mode that draws it", () => {
  for (const f of ["auto.txt", "plan.txt", "accept-edits.txt", "accept-edits-typing.txt", "bypass.txt", "dont-ask.txt", "plan-46col.txt"]) {
    assert.deepEqual(keys(grid(f)), ["shift+tab=cycle"], f);
  }
});

test("footer with no hint (manual mode, a narrow grid that cut it) offers nothing", () => {
  for (const f of ["manual.txt", "manual-no-statusline.txt", "manual-28col.txt", "auto-28col.txt", "ultracode-on.txt"]) {
    assert.deepEqual(keys(grid(f)), [], f);
  }
});

test("pickers: the bare letter on their key line, never Enter/Esc/Tab/arrows", () => {
  assert.deepEqual(keys(grid("model-picker.txt")), ["s=use this session only"]);
  assert.deepEqual(keys(grid("effort-picker.txt")), ["s=this session only"]);
  // `Esc to cancel · Tab to amend`: both already on the row.
  assert.deepEqual(keys(grid("permission-box.txt")), []);
});

test("the transcript above the composer is never read", () => {
  const rule = "─".repeat(40);
  const s = ["press ctrl+o to expand · s for something", "(ctrl+t to show todos)", rule, "❯ ", rule, "  ⏸ manual mode on"].join("\n");
  assert.deepEqual(keys(s), []);
});

test("a bare letter needs a key line; a capital is a word; a cut verb is dropped", () => {
  assert.deepEqual(keys("a to b is the plan"), []);
  assert.deepEqual(keys("I to do · s to save"), ["s=save"]);
  assert.deepEqual(keys("x to close · ctrl+r to resume…"), ["x=close"]);
  assert.deepEqual(keys("x to close · ctrl+r to resume"), ["x=close", "ctrl+r=resume"]);
});

test("bytes and labels", () => {
  assert.equal(keyHintBytes("shift+tab"), "\x1b[Z");
  assert.equal(keyHintBytes("ctrl+o"), "\x0f");
  assert.equal(keyHintBytes("s"), "s");
  assert.equal(keyHintBytes("esc"), null);
  assert.equal(keyHintBytes("tab"), null);
  // On the fixed row as ^C; and ctrl+g hands the PTY to an editor.
  assert.equal(keyHintBytes("ctrl+c"), null);
  assert.equal(keyHintBytes("ctrl+g"), null);
  assert.equal(keyHintLabel("shift+tab"), "⇧Tab");
  assert.equal(keyHintLabel("ctrl+o"), "^O");
});

test("AskUserQuestion's key line: `ctrl+g to edit in Vim` is never offered, wrapped or not", () => {
  for (const f of ["checkbox-on-submit.txt", "checkbox-46col.txt"]) {
    assert.deepEqual(keys(readFileSync(join(SCREENS, f), "utf8")), [], f);
  }
});

test("a key line wrapped by a narrow grid drops the hint the wrap cut", () => {
  assert.deepEqual(keys("Enter to set as default · s to use this\n   session only · Esc to cancel"), []);
  // The next row being a hint of its own is not a continuation.
  assert.deepEqual(keys("x to close · s to save\n   ctrl+r to resume · y to yank"), ["x=close", "s=save", "ctrl+r=resume"]);
  // A closed parenthetical cannot have been cut.
  const rule = "─".repeat(40);
  assert.deepEqual(keys([rule, "❯ ", rule, "  ⏵⏵ auto mode on (shift+tab to cycle)", "  agents running"].join("\n")), ["shift+tab=cycle"]);
});

test("a digit is a key on a key line", () => {
  assert.deepEqual(keys("(ctrl+o to expand) · 3 to three"), ["ctrl+o=expand", "3=three"]);
});

test("sameKeyHints: order and words both count; absent is empty", () => {
  const a = [{ key: "s", verb: "save" }, { key: "x", verb: "close" }];
  assert.ok(sameKeyHints(a, [...a]));
  assert.ok(!sameKeyHints(a, [...a].reverse()));
  assert.ok(!sameKeyHints(a, [{ key: "s", verb: "save" }, { key: "x", verb: "exit" }]));
  assert.ok(sameKeyHints(undefined, []));
});
