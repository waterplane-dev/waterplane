/** R-input-021: Alt+G toggles full screen — which presses count, and when. */
import test from "node:test";
import assert from "node:assert/strict";

import { fullScreenKeyLabel, installFullScreenKey, isFullScreenPress } from "./fullScreenKey.ts";
import { registeredShortcuts, shortcutsFor } from "../../shortcuts.ts";

const press = (o) => ({
  key: "g", code: "KeyG", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false,
  isComposing: false, repeat: false, ...o,
});

test("R-input-021: Alt+G, and Option+G which types ©", () => {
  assert.equal(isFullScreenPress(press({})), true);
  assert.equal(isFullScreenPress(press({ key: "G" })), true); // caps lock
  assert.equal(isFullScreenPress(press({ key: "©" })), true);
});

test("a letter is believed as printed, on any layout", () => {
  assert.equal(isFullScreenPress(press({ key: "g", code: "KeyU" })), true);
  assert.equal(isFullScreenPress(press({ key: "i", code: "KeyG" })), false);
});

test("no other modifier, AltGr included, no composition, no auto-repeat", () => {
  for (const o of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { repeat: true }]) {
    assert.equal(isFullScreenPress(press(o)), false, JSON.stringify(o));
  }
});

function rig() {
  const s = { on: true, dialog: null, hidden: false, toggles: 0, stopped: 0 };
  let handler = null;
  const win = {
    document: { querySelector: () => s.dialog },
    addEventListener: (_t, h, capture) => { assert.equal(capture, true); handler = h; },
    removeEventListener: () => { handler = null; },
  };
  const off = installFullScreenKey({
    onSessionScreen: () => s.on, hidden: () => s.hidden,
    toggle: () => { s.toggles++; s.hidden = !s.hidden; },
  }, win);
  const hit = (o) => handler({ ...press(o), preventDefault() {}, stopPropagation() { s.stopped++; } });
  return { s, hit, off, gone: () => handler === null };
}
const rows = () => shortcutsFor(registeredShortcuts(), "alt", { mac: false, tab: true }).map((r) => `${r.key} ${r.what}`);

test("R-input-021: a press toggles both ways and never reaches the terminal", () => {
  const r = rig();
  assert.deepEqual(rows(), ["G full screen"]);
  r.hit({});
  assert.deepEqual(rows(), ["G leave full screen"]);
  r.hit({});
  assert.deepEqual([r.s.toggles, r.s.stopped, r.s.hidden], [2, 2, false]);
  r.hit({ repeat: true }); // swallowed, toggles nothing
  assert.deepEqual([r.s.toggles, r.s.stopped], [2, 3]);
  r.off();
  assert.equal(r.gone(), true);
  assert.deepEqual(rows(), []);
});

test("off the session screen or under a dialog it stands down, card row included", () => {
  const r = rig();
  r.s.on = false;
  r.hit({});
  assert.deepEqual(rows(), []);
  r.s.on = true; r.s.dialog = {};
  r.hit({});
  assert.deepEqual(rows(), []);
  assert.deepEqual([r.s.toggles, r.s.stopped], [0, 0]);
  r.off();
});

test("the label is the keyboard's own", () => {
  assert.deepEqual([fullScreenKeyLabel(true), fullScreenKeyLabel(false)], ["⌥G", "Alt+G"]);
});
