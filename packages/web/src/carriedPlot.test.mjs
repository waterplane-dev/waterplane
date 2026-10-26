// The "What every turn carries" strip: geometry and words (carriedPlot.ts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  carriedStrip, carriedOrder, segAt, shareWords, carriedReadout, scaleNote, carriedLegend,
  tildePath, namesInline,
} from "./carriedPlot.ts";

const fmt = (n) => `${Math.round(n / 100) / 10}k`;
const row = (key, tok, extra = {}) => ({ key, label: key, chars: tok * 4, tok, words: `~${tok} tokens`, ...extra });
const REQ = [
  row("instructions", 6300), row("skill_listing", 7500), row("hook_context", 30),
  row("system_prompt", 3200, { undocumented: true }), row("tool_schemas", 19600, { undocumented: true }),
  { key: "remainder", label: "rest", chars: null, tok: 23370, words: "≈23k tokens" },
];
const FIRST = 60000;

test("strip is the first request: segments sum to 100, largest part first, remainder last", () => {
  const s = carriedStrip(REQ, FIRST);
  assert.equal(s.scale, "request");
  assert.equal(s.whole, FIRST);
  assert.deepEqual(s.segs.map((x) => x.key), ["tool_schemas", "skill_listing", "instructions", "system_prompt", "hook_context", "remainder"]);
  const last = s.segs.at(-1);
  assert.ok(Math.abs(last.x + last.w - 100) < 1e-9);
  for (let i = 1; i < s.segs.length; i++) assert.ok(Math.abs(s.segs[i].x - (s.segs[i - 1].x + s.segs[i - 1].w)) < 1e-9);
  assert.deepEqual(s.segs.map((x) => x.cls), ["undoc", "doc", "doc", "undoc", "doc", "rest"]);
});

test("no remainder (unplaced or unanswered) ⇒ the parts' own sum, and the caption says why", () => {
  const parts = REQ.filter((r) => r.key !== "remainder");
  const sum = parts.reduce((n, r) => n + r.tok, 0);
  const a = carriedStrip(parts, null);
  assert.equal(a.scale, "parts");
  assert.equal(a.whole, sum);
  assert.match(scaleNote(a, null, fmt), /not been answered/);
  const b = carriedStrip(parts, 30000);
  assert.equal(b.scale, "parts");
  assert.match(scaleNote(b, 30000, fmt), /exceeds the first request's 30k tokens/);
  assert.equal(scaleNote(carriedStrip(REQ, FIRST), FIRST, fmt), null);
});

test("nothing to draw ⇒ null, never an empty bar", () => {
  assert.equal(carriedStrip([], null), null);
  assert.equal(carriedStrip([row("hook_context", 0)], null), null);
});

test("segAt picks the segment under the finger and clamps to the ends", () => {
  const s = carriedStrip(REQ, FIRST);
  assert.equal(segAt(s.segs, 0).key, "tool_schemas");
  assert.equal(segAt(s.segs, -1).key, "tool_schemas");
  assert.equal(segAt(s.segs, 0.99).key, "remainder");
  assert.equal(segAt(s.segs, 2).key, "remainder");
  assert.equal(segAt(s.segs, 19600 / FIRST + 0.001).key, "skill_listing");
  assert.equal(segAt([], 0.5), null);
});

test("shares are whole percents, a sliver is <1%, never a decimal", () => {
  assert.equal(shareWords(19600, FIRST), "33%");
  assert.equal(shareWords(30, FIRST), "<1%");
  assert.equal(shareWords(0, FIRST), "0%");
  assert.equal(shareWords(5, 0), "");
  const s = carriedStrip(REQ, FIRST);
  assert.equal(carriedReadout(s.segs[0], s), "tool_schemas · ~19600 tokens · about 33% of the first request");
  assert.doesNotMatch(carriedReadout(s.segs.at(-1), s), /\d\.\d%/);
});

test("legend names only the classes drawn", () => {
  assert.deepEqual(carriedLegend(carriedStrip(REQ, FIRST)), ["doc", "undoc", "rest"]);
  assert.deepEqual(carriedLegend(carriedStrip([row("instructions", 10)], null)), ["doc"]);
});

test("carriedOrder keeps the remainder last whatever its size", () => {
  assert.deepEqual(carriedOrder([row("remainder", 9e9), row("a", 1), row("b", 2)]).map((r) => r.key), ["b", "a", "remainder"]);
});

test("tildePath: home becomes ~ on macOS, Linux, root and Windows; anything else unchanged", () => {
  assert.equal(tildePath("/Users/jo/.claude/CLAUDE.md"), "~/.claude/CLAUDE.md");
  assert.equal(tildePath("/home/jo/dev/x/CLAUDE.md"), "~/dev/x/CLAUDE.md");
  assert.equal(tildePath("/root/CLAUDE.md"), "~/CLAUDE.md");
  assert.equal(tildePath("C:\\Users\\jo\\dev\\CLAUDE.md"), "~\\dev\\CLAUDE.md");
  assert.equal(tildePath("/Users/jo"), "~");
  assert.equal(tildePath("/opt/repo/CLAUDE.md"), "/opt/repo/CLAUDE.md");
  assert.equal(tildePath("/Usersx/a/b"), "/Usersx/a/b");
  assert.equal(tildePath("CLAUDE.md"), "CLAUDE.md");
});

test("names inline only when few and complete", () => {
  assert.equal(namesInline(["SessionStart"], 1), true);
  assert.equal(namesInline(["a", "b", "c"], undefined), true);
  assert.equal(namesInline(["a", "b", "c", "d"], 4), false);
  assert.equal(namesInline(["a", "b"], 10), false);
  assert.equal(namesInline([], 0), false);
});
