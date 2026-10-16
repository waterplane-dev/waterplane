/**
 * A desktop key typed at no field goes to the terminal (`strayKeys.ts`) — and
 * the keys that would interrupt a turn, move focus or activate a button never do.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { strayKeyBytes, startStrayKeys } from "./strayKeys.ts";

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, ...mods });
const BODY = { editable: false, inTerminal: false, activatable: false };
const BUTTON = { editable: false, inTerminal: false, activatable: true };

test("printable keys, Enter, Backspace and arrows typed at nothing reach the CLI", () => {
  assert.equal(strayKeyBytes(key("h"), BODY), "h");
  assert.equal(strayKeyBytes(key("H"), BODY), "H");
  assert.equal(strayKeyBytes(key(" "), BODY), " ");
  assert.equal(strayKeyBytes(key("Enter"), BODY), "\r");
  assert.equal(strayKeyBytes(key("Backspace"), BODY), "\x7f");
  assert.equal(strayKeyBytes(key("ArrowUp"), BODY), "\x1b[A");
});

test("a letter typed after clicking a sidebar button still reaches the CLI", () => {
  assert.equal(strayKeyBytes(key("a"), BUTTON), "a");
});

test("Enter and Space on a button activate it, they are not sent", () => {
  assert.equal(strayKeyBytes(key("Enter"), BUTTON), null);
  assert.equal(strayKeyBytes(key(" "), BUTTON), null);
});

test("a stray Esc or ^C never interrupts a turn; chords stay the browser's", () => {
  assert.equal(strayKeyBytes(key("Escape"), BODY), null);
  assert.equal(strayKeyBytes(key("c", { ctrlKey: true }), BODY), null);
  assert.equal(strayKeyBytes(key("t", { metaKey: true }), BODY), null);
  assert.equal(strayKeyBytes(key("x", { altKey: true }), BODY), null);
  assert.equal(strayKeyBytes(key("Tab"), BODY), null);
});

test("fields and the terminal own their keys", () => {
  assert.equal(strayKeyBytes(key("a"), { ...BODY, editable: true }), null);
  assert.equal(strayKeyBytes(key("a"), { ...BODY, inTerminal: true }), null);
  assert.equal(strayKeyBytes(key("a", { defaultPrevented: true }), BODY), null);
  assert.equal(strayKeyBytes(key("a", { isComposing: true }), BODY), null);
  assert.equal(strayKeyBytes(key("F5"), BODY), null);
});

function fakeWin() {
  const fns = [], timers = [];
  return {
    addEventListener: (_t, fn) => fns.push(fn),
    removeEventListener: (_t, fn) => fns.splice(fns.indexOf(fn), 1),
    setTimeout: (fn) => timers.push(fn),
    press(e) { for (const f of fns) f(e); for (const t of timers.splice(0)) t(); },
    fns,
  };
}
const ev = (k, extra = {}) => ({ ...key(k), target: null, defaultPrevented: false, ...extra });

test("startStrayKeys sends, then hands the terminal the keyboard", () => {
  const w = fakeWin(), sent = [];
  let focused = 0;
  const stop = startStrayKeys(w, (b) => sent.push(b), () => focused++, () => false);
  w.press(ev("l"));
  assert.deepEqual(sent, ["l"]);
  assert.equal(focused, 1);
  stop();
  assert.equal(w.fns.length, 0);
});

test("startStrayKeys stays out while something is over the terminal, or a handler took the key", () => {
  const w = fakeWin(), sent = [];
  startStrayKeys(w, (b) => sent.push(b), () => {}, () => true);
  w.press(ev("l"));
  const w2 = fakeWin();
  startStrayKeys(w2, (b) => sent.push(b), () => {}, () => false);
  const e = ev("l");
  w2.fns.unshift(() => {}); // registered first, but answers later:
  w2.addEventListener("keydown", (x) => { x.defaultPrevented = true; });
  w2.press(e);
  assert.deepEqual(sent, []);
});
