/**
 * The shortcut card's hold (`shortcutHold.ts`): when it comes up, when it goes,
 * and what counts as a physical keyboard.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { IDLE, hasKeyboard, holdStep, isHardwareKey, modOfKey } from "./shortcutHold.ts";

const k = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
const ctrl = (key = "Control", o = {}) => k(key, { ctrlKey: true, ...o });
const run = (events, s = IDLE) => events.reduce((st, ev) => holdStep(st, ev), s);

test("modifier alone → armed → timer → shown", () => {
  const armed = run([{ type: "down", e: ctrl() }]);
  assert.deepEqual(armed, { phase: "armed", mod: "ctrl" });
  assert.deepEqual(holdStep(armed, { type: "timer", mod: "ctrl" }), { phase: "shown", mod: "ctrl" });
});

test("auto-repeat of the held modifier keeps the hold going", () => {
  const armed = run([{ type: "down", e: ctrl() }]);
  assert.equal(holdStep(armed, { type: "down", e: ctrl("Control", { repeat: true }) }), armed);
});

test("quick Ctrl+C never shows: the C spends the hold before the timer", () => {
  let s = run([{ type: "down", e: ctrl() }, { type: "down", e: ctrl("c") }]);
  assert.equal(s.phase, "spent");
  s = holdStep(s, { type: "timer", mod: "ctrl" });
  assert.equal(s.phase, "spent");
  s = run([{ type: "up", e: ctrl("c") }, { type: "up", e: k("Control") }], s);
  assert.equal(s, IDLE);
});

test("still holding Ctrl after a copy does not bring the card up", () => {
  const s = run([{ type: "down", e: ctrl() }, { type: "down", e: ctrl("c") }, { type: "up", e: ctrl("c") }, { type: "timer", mod: "ctrl" }]);
  assert.equal(s.phase, "spent");
});

test("shown → any key, release, blur hides it", () => {
  const shown = { phase: "shown", mod: "ctrl" };
  assert.equal(holdStep(shown, { type: "down", e: ctrl("n") }).phase, "spent");
  assert.equal(holdStep(shown, { type: "up", e: k("Control") }), IDLE);
  assert.equal(holdStep(shown, { type: "blur" }), IDLE);
  assert.equal(holdStep(shown, { type: "down", e: k("Shift", { ctrlKey: true, shiftKey: true }) }).phase, "spent");
});

test("a modifier under another one is not a hold; a stale timer does nothing", () => {
  assert.equal(holdStep(IDLE, { type: "down", e: k("Control", { ctrlKey: true, shiftKey: true }) }), IDLE);
  assert.equal(holdStep(IDLE, { type: "down", e: k("Alt", { altKey: true, metaKey: true }) }), IDLE);
  assert.equal(holdStep(IDLE, { type: "timer", mod: "ctrl" }), IDLE);
  const armedAlt = run([{ type: "down", e: k("Alt", { altKey: true }) }]);
  assert.equal(holdStep(armedAlt, { type: "timer", mod: "ctrl" }), armedAlt);
});

test("plain typing leaves it idle", () => {
  assert.equal(run([{ type: "down", e: k("a") }, { type: "up", e: k("a") }]), IDLE);
});

test("modOfKey", () => {
  assert.equal(modOfKey("Control"), "ctrl");
  assert.equal(modOfKey("Meta"), "meta");
  assert.equal(modOfKey("Alt"), "alt");
  assert.equal(modOfKey("Shift"), null);
  assert.equal(modOfKey("n"), null);
});

test("isHardwareKey: a soft keyboard's 229 never counts; printable or modifier does", () => {
  assert.equal(isHardwareKey({ key: "a", keyCode: 229 }), false);
  assert.equal(isHardwareKey({ key: "Unidentified", keyCode: 229 }), false);
  assert.equal(isHardwareKey({ key: "a", keyCode: 65, isComposing: true }), false);
  assert.equal(isHardwareKey({ key: "a", keyCode: 65 }), true);
  assert.equal(isHardwareKey({ key: "Control", keyCode: 17 }), true);
  assert.equal(isHardwareKey({ key: "Backspace", keyCode: 8 }), false);
  assert.equal(isHardwareKey({ key: "Enter", keyCode: 13 }), false);
});

test("hasKeyboard: fine pointer or a hardware key seen", () => {
  assert.equal(hasKeyboard(false, false), false);
  assert.equal(hasKeyboard(true, false), true);
  assert.equal(hasKeyboard(false, true), true);
});
