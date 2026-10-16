/** The terminal view's one tap-answered box (`termAnswers.ts`): the trust box, nothing else. */
import test from "node:test";
import assert from "node:assert/strict";

import { termAnswersBox } from "./termAnswers.ts";

const box = (kind, extra = {}) => ({
  kind, question: "Do you trust the files in this folder?", fingerprint: "f",
  options: [{ index: 1, label: "No, exit" }, { index: 2, label: "Yes, I trust this folder" }], ...extra,
});

test("the trust box on a running session gets the tap card", () => {
  assert.equal(termAnswersBox(box("trust", { nav: true }), true), true);
});

test("every other box stays the terminal's", () => {
  for (const k of ["tool", "plan", "select"]) assert.equal(termAnswersBox(box(k), true), false, k);
});

test("no box, an ended session, or a box with nothing to tap: no card", () => {
  assert.equal(termAnswersBox(undefined, true), false);
  assert.equal(termAnswersBox(box("trust"), false), false);
  assert.equal(termAnswersBox(box("trust", { options: [] }), true), false);
});
