/**
 * Remarks on a text file (`fileRemarks.ts`), pinned without a browser.
 *
 *     node --test packages/web/src/fileRemarks.test.mjs
 *
 * The cases are the ways a remark could end up saying something about the
 * wrong lines: a range that will not close, numbering that differs between
 * the badge and the message, a remark re-pointed at whatever now occupies its
 * old line numbers after an agent edited the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextSel, lineSpan, lineSpanText, orderRemarks, remarksAt, relocate, quoteLines, remarksBlock,
  QUOTE_MAX_LINES,
} from "./fileRemarks.ts";

const r = (id, from, to, quote, text) => ({ id, from, to, quote, text });

test("two taps make a range, either direction; a third starts again", () => {
  let s = nextSel(null, 12);
  assert.deepEqual(s, { from: 12, to: 12, open: true });
  s = nextSel(s, 9);
  assert.deepEqual(s, { from: 9, to: 12, open: false });
  s = nextSel(s, 30);
  assert.deepEqual(s, { from: 30, to: 30, open: true });
});

test("a second tap on the same line takes the mark away", () => {
  assert.equal(nextSel(nextSel(null, 4), 4), null);
});

test("a rendered block is a range of its own, and a range stretches to cover the next block", () => {
  let s = nextSel(null, 5, 8);
  assert.deepEqual(s, { from: 5, to: 8, open: true });
  s = nextSel(s, 12, 14);
  assert.deepEqual(s, { from: 5, to: 14, open: false });
  assert.equal(nextSel(nextSel(null, 5, 8), 5, 8), null);
});

test("spans read the same in the message and on screen", () => {
  assert.equal(lineSpan(3, 3), "3");
  assert.equal(lineSpan(3, 7), "3-7");
  assert.equal(lineSpanText(3, 3), "line 3");
  assert.equal(lineSpanText(3, 7), "lines 3–7");
});

test("one ordering numbers the badges and the message", () => {
  const rs = [r("a", 40, 40, ["x"], "late"), r("b", 2, 3, ["p", "q"], "early")];
  const o = orderRemarks(rs);
  assert.deepEqual(o.map((x) => x.id), ["b", "a"]);
  assert.deepEqual(remarksAt(o, 3), [1]);
  assert.deepEqual(remarksAt(o, 40), [2]);
  assert.deepEqual(remarksAt(o, 1, 50), [1, 2]);
  const msg = remarksBlock("README.md", rs);
  assert.ok(msg.indexOf("1. README.md:2-3") < msg.indexOf("2. README.md:40"));
});

test("relocate: lines still in place keep their place", () => {
  const lines = ["a", "b", "c"];
  const rs = [r("x", 2, 2, ["b"], "t")];
  assert.equal(relocate(rs, lines)[0], rs[0]);
});

test("relocate: lines that moved are followed, to the nearest copy", () => {
  const lines = ["new", "new", "b", "c", "z", "z", "z", "z", "b", "c"];
  const [x] = relocate([r("x", 2, 3, ["b", "c"], "t")], lines);
  assert.equal(x.from, 3);
  assert.equal(x.to, 4);
  assert.ok(!x.moved);
});

test("relocate: lines that are gone stay put and SAY so — never re-pointed", () => {
  const lines = ["a", "rewritten", "c"];
  const [x] = relocate([r("x", 2, 2, ["b"], "t")], lines);
  assert.equal(x.from, 2);
  assert.equal(x.moved, true);
  assert.match(remarksBlock("f.md", [x]), /changed since/);
  // and once the line is back, the flag goes
  assert.equal(relocate([x], ["a", "b"])[0].moved, false);
});

test("a long quote is elided in the middle; the words are never clipped", () => {
  const quote = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  const q = quoteLines(quote);
  assert.equal(q.length, QUOTE_MAX_LINES + 1);
  assert.equal(q[0], "> line 1");
  assert.equal(q[q.length - 1], "> line 10");
  assert.match(q[QUOTE_MAX_LINES - 1], /6 more lines/);
  const long = "w".repeat(2000);
  const msg = remarksBlock("f.md", [r("x", 1, 10, quote, long)]);
  assert.ok(msg.includes(long));
});

test("blank lines quote as a bare marker, not trailing spaces", () => {
  assert.deepEqual(quoteLines(["a", "", "b"]), ["> a", ">", "> b"]);
});

test("remarks with no words are not sent; none at all is null", () => {
  assert.equal(remarksBlock("f.md", []), null);
  assert.equal(remarksBlock("f.md", [r("x", 1, 1, ["a"], "  ")]), null);
  const msg = remarksBlock("f.md", [r("x", 1, 1, ["a"], " "), r("y", 2, 2, ["b"], "fix")]);
  assert.match(msg, /^Remarks on f\.md \(1\):/);
  assert.match(msg, /1\. f\.md:2\n> b\nfix/);
});
