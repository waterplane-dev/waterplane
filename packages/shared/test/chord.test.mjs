/**
 * `chord.ts`: a key with modifiers held, as xterm's bytes — or a sentence,
 * never a different key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chordBytes, chordName, hasMods } from "../dist/chord.js";

const b = (m, k) => {
  const r = chordBytes(m, k);
  return "bytes" in r ? r.bytes : null;
};

test("ctrl + a letter is its control byte, either case", () => {
  assert.equal(b({ ctrl: true }, "o"), "\x0f");
  assert.equal(b({ ctrl: true }, "O"), "\x0f");
  assert.equal(b({ ctrl: true }, "c"), "\x03");
  assert.equal(b({ ctrl: true }, "_"), "\x1f");
  assert.equal(b({ ctrl: true }, "-"), "\x1f");
  assert.equal(b({ ctrl: true }, "space"), "\x00");
  assert.equal(b({ ctrl: true }, "["), "\x1b");
});

test("alt is an ESC prefix (claude's meta+ bindings)", () => {
  assert.equal(b({ alt: true }, "p"), "\x1bp");
  assert.equal(b({ alt: true }, "enter"), "\x1b\r");
  assert.equal(b({ alt: true }, "backspace"), "\x1b\x7f");
  assert.equal(b({ alt: true, ctrl: true }, "x"), "\x1b\x18");
});

test("shift: capitals, back-tab", () => {
  assert.equal(b({ shift: true }, "g"), "G");
  assert.equal(b({ shift: true }, "tab"), "\x1b[Z");
});

test("cursor keys carry the modifier parameter", () => {
  assert.equal(b({}, "up"), "\x1b[A");
  assert.equal(b({ ctrl: true }, "up"), "\x1b[1;5A");
  assert.equal(b({ shift: true }, "left"), "\x1b[1;2D");
  assert.equal(b({ alt: true }, "down"), "\x1b[1;3B");
  assert.equal(b({ ctrl: true }, "end"), "\x1b[1;5F");
  assert.equal(b({ shift: true }, "pgdn"), "\x1b[6;2~");
});

test("combinations a terminal has no bytes for are refused in words", () => {
  for (const [m, k] of [[{ ctrl: true }, "1"], [{ ctrl: true }, "tab"], [{ shift: true }, "enter"], [{ ctrl: true, shift: true }, "b"], [{ alt: true, ctrl: true }, "tab"]]) {
    const r = chordBytes(m, k);
    assert.ok("refused" in r, chordName(m, k));
    assert.match(r.refused, new RegExp(`^${chordName(m, k).replace(/\+/g, "\\+")} has no terminal bytes — \\S`));
  }
});

test("names in the CLI's spelling", () => {
  assert.equal(chordName({ ctrl: true, shift: true }, "tab"), "ctrl+shift+tab");
  assert.equal(chordName({ alt: true }, " "), "alt+space");
  assert.ok(!hasMods({}));
  assert.ok(hasMods({ alt: true }));
});
