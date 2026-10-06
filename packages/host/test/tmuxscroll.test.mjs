// The wheel parser (`tmuxscroll.ts`). Fixture in, verdict out: when the client's
// pan encoding or upstream's mouse reporting changes, "this write is no longer
// read as a scroll" is the sentence worth having — the alternative symptom is a
// finger pan that silently does nothing, which is the bug this replaced.
import test from "node:test";
import assert from "node:assert/strict";
import { MOUSE_FLAGS_FMT, parseWheel, wantsMouse } from "../dist/tmuxscroll.js";

const UP = "\x1b[<64;1;1M";
const DOWN = "\x1b[<65;1;1M";

test("one wheel report", () => {
  assert.deepEqual(parseWheel(UP), { dir: "up", n: 1 });
  assert.deepEqual(parseWheel(DOWN), { dir: "down", n: 1 });
});

test("a flick is N reports in ONE write", () => {
  // sendWheel() collapses a whole pan into a single session.input.
  assert.deepEqual(parseWheel(UP.repeat(12)), { dir: "up", n: 12 });
});

test("column/row are whatever the client used", () => {
  assert.deepEqual(parseWheel("\x1b[<64;37;12M"), { dir: "up", n: 1 });
});

test("nothing else is a scroll", () => {
  assert.equal(parseWheel(""), null);
  assert.equal(parseWheel("hello"), null);
  assert.equal(parseWheel("\r"), null);
  assert.equal(parseWheel("\x1b[A"), null);              // arrow key
  assert.equal(parseWheel("\x1b[I"), null);              // focus in
  assert.equal(parseWheel("\x1b[<0;1;1M"), null);        // a CLICK, not the wheel
  assert.equal(parseWheel("\x1b[<64;1;1m"), null);       // release, not press
});

test("a write that is only PARTLY wheel is left to the ordinary path", () => {
  // Mis-reading one costs a keystroke into a live TUI; a missed scroll costs a
  // gesture. Refuse the ambiguous case in the cheap direction.
  assert.equal(parseWheel(UP + "y"), null);
  assert.equal(parseWheel("y" + UP), null);
  assert.equal(parseWheel(UP + "\r"), null);
});

test("a flick that reversed mid-write is not one scroll", () => {
  assert.equal(parseWheel(UP + DOWN), null);
});

// Where a pan GOES (`wantsMouse`). The pane's own program decides: claude 2.1.x
// asks for the mouse and scrolls itself, a shell does not and gets tmux's
// copy-mode scroll. Read wrong in the first direction, the wheel is translated
// into a command an alternate-screen pane cannot obey and the gesture does
// nothing — the failure this reading exists to end.

test("a flag set means the pane asked for the mouse", () => {
  assert.equal(wantsMouse("100"), true);   // any-motion (claude: ?1003h)
  assert.equal(wantsMouse("010"), true);   // button
  assert.equal(wantsMouse("001"), true);   // standard
  assert.equal(wantsMouse("110\n"), true); // tmux ends the report with a newline
});

test("no flag set is the translation this module has always done", () => {
  assert.equal(wantsMouse("000"), false);
  assert.equal(wantsMouse("000\n"), false);
});

test("an answer that is not one degrades to the old behaviour, never to a write", () => {
  // A pane that went away, a tmux that does not know the format, a failed
  // query: the wheel must not be written into a program that never asked for
  // it, so anything unreadable reads as "no".
  assert.equal(wantsMouse(""), false);
  assert.equal(wantsMouse("   "), false);
  assert.equal(wantsMouse("can't find pane: myapp_deadbeef"), false);
});

test("the format asks tmux for all three mouse flags", () => {
  // Naming only `mouse_any_flag` would miss a program that enables ?1000 alone.
  for (const f of ["#{mouse_any_flag}", "#{mouse_button_flag}", "#{mouse_standard_flag}"]) {
    assert.ok(MOUSE_FLAGS_FMT.includes(f), f);
  }
});
