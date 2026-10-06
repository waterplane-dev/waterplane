// What a marked image says in words (`annNote.ts`). Every assertion here is a
// sentence an agent acts on, and each one is pinned because the alternative
// shipped once: the real prompt log has a message whose six marks were
// summarised as six identical copies of "red circle at left", which names
// nothing and can be replied to with nothing.
import test from "node:test";
import assert from "node:assert/strict";

import { markNote, visibleMarks, withUploadSize, quoteText } from "./annNote.ts";

const W = 1000, H = 1000;
const at = (tool, x0, y0, x1 = x0, y1 = y0, extra = {}) =>
  ({ tool, x0, y0, x1, y1, color: "#ff2d2d", ...extra });

test("a single mark carries no number — there is nothing to tell it apart from", () => {
  const s = markNote([at("circle", 100, 100, 300, 300)], W, H);
  assert.equal(s, "circle at top-left (x 10%-30%, y 10%-30%)");
});

test("several marks are numbered, and the numbers are the ones drawn on the image", () => {
  const s = markNote([
    at("circle", 100, 100, 300, 300),
    at("arrow", 900, 900, 500, 500),
  ], W, H);
  assert.match(s, /^#1 circle at top-left/);
  assert.match(s, /#2 arrow pointing to center/);
});

test("one colour across every mark is said nowhere — the badges already tell them apart", () => {
  const s = markNote([at("circle", 0, 0, 100, 100), at("rect", 0, 0, 100, 100)], W, H);
  assert.doesNotMatch(s, /red/);
});

test("mixed colours keep theirs, because there the colour IS the distinction", () => {
  const s = markNote([
    at("circle", 0, 0, 100, 100),
    { ...at("rect", 500, 500, 700, 700), color: "#4c9aff" },
  ], W, H);
  assert.match(s, /#1 red circle/);
  assert.match(s, /#2 blue box/);
});

test("a twin mark collapses — a double tap is one mark to whoever looks at it", () => {
  const marks = [at("circle", 100, 100, 300, 300), at("circle", 100, 100, 300, 300)];
  assert.equal(visibleMarks(marks, W, H).length, 1);
  assert.equal(markNote(marks, W, H), "circle at top-left (x 10%-30%, y 10%-30%)");
});

test("a near-twin is NOT collapsed — two circles a person can see apart stay two", () => {
  const marks = [at("circle", 100, 100, 300, 300), at("circle", 400, 100, 600, 300)];
  assert.equal(visibleMarks(marks, W, H).length, 2);
});

test("a highlight with text read back quotes it in full, verbatim", () => {
  const s = markNote([at("marker", 100, 300, 700, 340, { read: "TypeError: cannot read x of undefined" })], W, H);
  assert.equal(s, 'highlight over "TypeError: cannot read x of undefined" at top (x 10%-70%, y 30%-34%)');
});

test("a highlight with nothing read still says WHERE — it degrades to geometry, never to a guess", () => {
  const s = markNote([at("marker", 100, 300, 700, 340)], W, H);
  assert.equal(s, "highlight at top (x 10%-70%, y 30%-34%)");
});

test("typed words are never clipped — a label is the instruction, not a caption", () => {
  const long = "this button does nothing at all when the tunnel is down and the queue is full";
  const s = markNote([at("text", 500, 500, 500, 500, { text: long })], W, H);
  assert.ok(s.includes(long));
});

test("a quote inside the words cannot make one mark read as two", () => {
  assert.equal(quoteText('say "hi"'), `"say ''hi''"`);
});

test("blur is never given a colour — the colour would describe the frame, not the mark", () => {
  const s = markNote([
    { ...at("blur", 0, 0, 100, 100), color: "#3fb950" },
    { ...at("circle", 500, 500, 600, 600), color: "#ff2d2d" },
  ], W, H);
  assert.match(s, /#1 blurred\/redacted region/);
  assert.doesNotMatch(s, /green/);
});

test("the collage arrangement leads, because it says what the image IS", () => {
  const s = markNote([at("circle", 0, 0, 100, 100)], W, H, "collage of 3 panels in one row, left to right, numbered 1-3 in that order");
  assert.match(s, /^collage of 3 panels/);
  assert.match(s, /; circle at top-left/);
});

test("no marks and no facts is an empty clause — a bare path beats a sentence saying nothing", () => {
  assert.equal(markNote([], W, H), "");
});

test("the uploaded pixel size is appended only when it is known", () => {
  const note = "circle at center (x 40%-60%, y 40%-60%)";
  assert.equal(withUploadSize(note, { w: 1080, h: 2400 }), `${note}; image 1080x2400`);
  assert.equal(withUploadSize(note, null), note);
  assert.equal(withUploadSize(note, { w: 0, h: 2400 }), note);
  assert.equal(withUploadSize("", { w: 1080, h: 2400 }), "");
});
