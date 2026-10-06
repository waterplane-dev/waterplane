// The side-by-side layout of a unified diff (`diffSplit.ts`): what pairs with
// what, and which line numbers each side wears.
import test from "node:test";
import assert from "node:assert/strict";

import { splitDiff } from "./diffSplit.ts";

const DIFF = [
  "diff --git a/x.md b/x.md",
  "index 1111111..2222222 100644",
  "--- a/x.md",
  "+++ b/x.md",
  "@@ -10,4 +10,5 @@ heading",
  " same",
  "-old one",
  "-old two",
  "+new one",
  "+new two",
  "+new three",
  " tail",
  "",
].join("\n");

test("drops the file header, keeps the hunk head", () => {
  const rows = splitDiff(DIFF);
  assert.deepEqual(rows[0], { kind: "hunk", text: "@@ -10,4 +10,5 @@ heading" });
});

test("context sits on both sides with each side's own number", () => {
  const rows = splitDiff(DIFF);
  assert.deepEqual(rows[1], { kind: "line", left: { n: 10, text: "same", kind: "ctx" }, right: { n: 10, text: "same", kind: "ctx" } });
  const tail = rows.at(-1);
  assert.deepEqual(tail, { kind: "line", left: { n: 13, text: "tail", kind: "ctx" }, right: { n: 14, text: "tail", kind: "ctx" } });
});

test("a removal run pairs row by row with the addition run after it, the short side padded", () => {
  const lines = splitDiff(DIFF).filter((r) => r.kind === "line").slice(1, 4);
  assert.deepEqual(lines.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [
    ["old one", "new one"],
    ["old two", "new two"],
    [null, "new three"],
  ]);
});

test("a diff with no hunks says what git said", () => {
  const rows = splitDiff("diff --git a/a.bin b/a.bin\nindex 1..2 100644\nBinary files a/a.bin and b/a.bin differ\n");
  assert.deepEqual(rows, [{ kind: "note", text: "Binary files a/a.bin and b/a.bin differ" }]);
});

test("an untracked file's host sentence is a note, not dropped", () => {
  assert.deepEqual(splitDiff("(no textual diff)"), [{ kind: "note", text: "(no textual diff)" }]);
});
