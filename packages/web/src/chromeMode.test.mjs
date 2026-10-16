import test from "node:test";
import assert from "node:assert/strict";

import { chromeMode, fullScreenTap, trackKeyboard } from "./chromeMode.ts";

const base = {
  onSessionScreen: true, typingRoom: true, composeFocused: false,
  cliMode: false, typingPeek: false, fullScreen: false,
};
const mode = (over) => chromeMode({ ...base, ...over });

test("nothing is hidden on a session screen with the caret elsewhere", () => {
  assert.deepEqual(mode({}), {
    typingMode: false, typingPeeking: false, fullMode: false, chromeHidden: false,
  });
});

test("the caret in the box hides the chrome; full screen does too", () => {
  assert.equal(mode({ composeFocused: true }).typingMode, true);
  assert.equal(mode({ fullScreen: true }).fullMode, true);
  assert.equal(mode({ fullScreen: true }).chromeHidden, true);
});

test("OFF the session screen neither mode hides anything", () => {
  // The launcher's two status strips are hidden by an attribute on <html>, so
  // a mode that outlives the screen it was entered on takes them off a view
  // with no control to switch it back on.
  const off = { onSessionScreen: false };
  assert.equal(mode({ ...off, fullScreen: true }).chromeHidden, false);
  // `composeFocused` survives the back button: no blur fires on unmount.
  assert.equal(mode({ ...off, composeFocused: true }).chromeHidden, false);
  assert.equal(mode({ ...off, composeFocused: true }).typingMode, false);
});

test("typing room owns the caret, so full screen waits behind it", () => {
  const m = mode({ composeFocused: true, fullScreen: true });
  assert.equal(m.typingMode, true);
  assert.equal(m.fullMode, false);
  // …and the chrome is still hidden, so the switch flipping under it changes
  // no pixels — which is why the button draws from `fullScreen`, not from this.
  assert.equal(m.chromeHidden, true);
});

test("the peek suspends BOTH hiders, and leaving it resumes them", () => {
  const peek = mode({ composeFocused: true, fullScreen: true, typingPeek: true });
  assert.equal(peek.typingPeeking, true);
  assert.equal(peek.typingMode, false);
  assert.equal(peek.fullMode, false);
  // The ☰ used to leave full screen holding on here: the chrome never came
  // back and the button read as dead.
  assert.equal(peek.chromeHidden, false);
  assert.equal(mode({ composeFocused: true, fullScreen: true, typingPeek: false }).chromeHidden, true);
});

test("CLI mode is not typing room, but full screen still works there", () => {
  const m = mode({ composeFocused: true, cliMode: true, fullScreen: true });
  assert.equal(m.typingMode, false);
  assert.equal(m.fullMode, true);
});

test("CLI mode with the caret in the box is full screen, and the button brings the chrome back", () => {
  const m = mode({ composeFocused: true, cliMode: true });
  assert.equal(m.typingMode, false);
  assert.equal(m.fullMode, true, "the key row stays: full screen keeps it");
  assert.equal(mode({ composeFocused: false, cliMode: true }).chromeHidden, false, "keyboard down, header back");
  assert.equal(mode({ composeFocused: true, cliMode: true, typingRoom: false }).chromeHidden, false);
  const s = { ...base, composeFocused: true, cliMode: true };
  const shown = { ...s, ...fullScreenTap(s) };
  assert.equal(chromeMode(shown).chromeHidden, false, "never a dead tap");
  assert.equal(chromeMode({ ...shown, ...fullScreenTap(shown) }).chromeHidden, true);
});

test("typing room switched off leaves full screen the only hider", () => {
  assert.equal(mode({ typingRoom: false, composeFocused: true }).chromeHidden, false);
  assert.equal(mode({ typingRoom: false, composeFocused: true, fullScreen: true }).fullMode, true);
});

test("the keyboard closing with the caret still in the box is detected", () => {
  let t = trackKeyboard(null, 800, 400);        // focus, keyboard not up yet
  assert.equal(t.closed, false);
  t = trackKeyboard(t.next, 450, 400);          // keyboard opens
  assert.equal(t.closed, false);
  t = trackKeyboard(t.next, 800, 400);          // back gesture: keyboard gone
  assert.equal(t.closed, true);
});

test("the keyboard OPENING never reads as closing, however it wobbles", () => {
  // Shipped bug: "grew 120px from the shortest seen" fired on the opening
  // animation's overshoot (800 → 300 → 450), blurred the box and shut the
  // keyboard — nothing could be typed.
  let t = trackKeyboard(null, 800, 400);
  for (const h of [700, 300, 450, 400, 460, 420]) {
    t = trackKeyboard(t.next, h, 400);
    assert.equal(t.closed, false, `closed at ${h}`);
  }
  t = trackKeyboard(t.next, 795, 400);
  assert.equal(t.closed, true);
});

test("focus with the keyboard already up, a rotation, a hardware keyboard: never closed", () => {
  // Baseline taken with the keyboard up: no opening is ever proven.
  let t = trackKeyboard(null, 450, 400);
  t = trackKeyboard(t.next, 800, 400);
  assert.equal(t.closed, false);
  // Rotation restarts the tracker.
  t = trackKeyboard(trackKeyboard(trackKeyboard(null, 800, 400).next, 450, 400).next, 400, 800);
  assert.equal(t.closed, false);
  // A hardware keyboard never shrinks the viewport.
  t = trackKeyboard(trackKeyboard(null, 800, 400).next, 800, 400);
  assert.equal(t.closed, false);
});

test("the full-screen button is never a dead tap while typing room is in play", () => {
  const tap = (over) => {
    const s = { ...base, ...over };
    const w = fullScreenTap(s);
    return chromeMode({ ...s, ...w });
  };
  // Peeking (keyboard up, header back): "enter" must hide the chrome.
  assert.equal(tap({ composeFocused: true, typingPeek: true }).chromeHidden, true);
  // Typing room hiding with full screen on: "leave" must bring it back.
  assert.equal(tap({ composeFocused: true, fullScreen: true }).chromeHidden, false);
  // Typing room hiding, full screen off: the button says "leave" (the chrome
  // IS hidden), and its tap brings the chrome back.
  assert.equal(tap({ composeFocused: true }).chromeHidden, false);
  // Switch on, then ☰ peeked the header back (the reported screen): the
  // chrome is VISIBLE, so the tap must hide it, not "leave" into the same view.
  assert.equal(tap({ composeFocused: true, fullScreen: true, typingPeek: true }).chromeHidden, true);
  // Plain full screen, caret elsewhere: toggles as before, peek untouched.
  assert.deepEqual(fullScreenTap(base), { fullScreen: true, typingPeek: false });
  assert.deepEqual(fullScreenTap({ ...base, fullScreen: true }), { fullScreen: false, typingPeek: false });
});
