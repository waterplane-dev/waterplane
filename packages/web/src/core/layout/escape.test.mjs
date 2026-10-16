/**
 * Esc on a wide window (`escape.ts`): one Back, never in the CLI's pipe box or
 * xterm's own input, never with nothing pushed, and never on top of a handler
 * that already answered the key. Docs: docs/analysis/desktop-workspace-plan.md §3.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { escapeStep, startEscape } from "./escape.ts";

const ta = (className) => ({ tagName: "TEXTAREA", className });

test("escapeStep: depth 0 is ignored whatever has focus", () => {
  assert.equal(escapeStep(0, null), "ignore");
  assert.equal(escapeStep(0, { tagName: "BUTTON", className: "back" }), "ignore");
  assert.equal(escapeStep(NaN, null), "ignore");
});

test("escapeStep: the CLI-mode compose box and xterm's textarea keep their Esc", () => {
  assert.equal(escapeStep(2, ta("pipe")), "ignore");
  assert.equal(escapeStep(2, ta("xterm-helper-textarea")), "ignore");
  assert.equal(escapeStep(2, { tagName: "textarea", className: "a pipe b" }), "ignore");
});

test("escapeStep: anything else with a route pushed is one Back", () => {
  assert.equal(escapeStep(1, null), "back");
  assert.equal(escapeStep(1, ta("")), "back", "the compose box when NOT in CLI mode");
  assert.equal(escapeStep(1, { tagName: "INPUT", className: "pipe" }), "back", "pipe only means the textarea");
  assert.equal(escapeStep(1, { tagName: "svg", className: { baseVal: "pipe" } }), "back");
  assert.equal(escapeStep(3, { tagName: "BUTTON", className: "back" }), "back");
});

/** A fake window: keydown listeners plus a timer queue run by hand. */
function fakeWin() {
  const fns = new Set();
  const timers = [];
  return {
    addEventListener: (_t, fn) => fns.add(fn),
    removeEventListener: (_t, fn) => fns.delete(fn),
    setTimeout: (fn) => timers.push(fn),
    press(e) { for (const f of fns) f(e); },
    flush() { while (timers.length) timers.shift()(); },
    size: () => fns.size,
  };
}
const key = (k, target = null, extra = {}) => ({ key: k, target, isComposing: false, defaultPrevented: false, ...extra });

test("startEscape: one Esc is one back, after the other handlers", () => {
  const win = fakeWin();
  let backs = 0;
  const stop = startEscape(win, () => 1, () => backs++);
  win.press(key("Escape"));
  assert.equal(backs, 0, "deferred past this press's other handlers");
  win.flush();
  assert.equal(backs, 1);
  win.press(key("Enter"));
  win.press(key("Escape", null, { isComposing: true }));
  win.press(key("Escape", ta("pipe")));
  win.flush();
  assert.equal(backs, 1);
  stop();
  assert.equal(win.size(), 0);
});

test("startEscape: a handler that answered Esc itself (preventDefault) wins", () => {
  const win = fakeWin();
  let backs = 0;
  startEscape(win, () => 2, () => backs++);
  const e = key("Escape");
  win.press(e);
  e.defaultPrevented = true; // the swiper's own listener, registered later
  win.flush();
  assert.equal(backs, 0);
});

test("startEscape: depth that drained to 0 before the timer fired is not a Back", () => {
  const win = fakeWin();
  let depth = 1, backs = 0;
  startEscape(win, () => depth, () => backs++);
  win.press(key("Escape"));
  depth = 0;
  win.flush();
  assert.equal(backs, 0);
});
