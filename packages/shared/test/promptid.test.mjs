// The safety interlock for answering a question box OFFLINE
// (`shared/src/promptid.ts`). Text sent late is stale; a CHOICE sent late is
// wrong, and nothing downstream can tell the difference — so an answer names
// the question it answers.
import test from "node:test";
import assert from "node:assert/strict";
import { ANSWER_TEXT_MAX, answerTextProblem, promptFingerprint, promptStillCurrent } from "../dist/index.js";

const box = (over = {}) => ({
  kind: "select",
  question: "Use the existing branch?",
  options: [{ index: 1, label: "Create a new one" }, { index: 2, label: "Use the existing branch" }],
  ...over,
});

test("the fingerprint of a fixed box is pinned (NUL/SOH separators are escapes now, same bytes)", () => {
  const b = box({ options: [{ index: 1, label: "Create a new one" }, { index: 2, label: "Use  the existing\tbranch" }] });
  assert.equal(promptFingerprint(b), "af6746a2");
  assert.equal(promptFingerprint({ ...b, multi: true, nav: true, freeText: true }), "822a86b1");
});

test("the same box fingerprints the same, every time", () => {
  assert.equal(promptFingerprint(box()), promptFingerprint(box()));
  assert.match(promptFingerprint(box()), /^[0-9a-f]{8}$/);
});

test("a repaint that only changes whitespace does not refuse a valid answer", () => {
  assert.equal(
    promptFingerprint(box()),
    promptFingerprint(box({
      question: "  Use the   existing branch?  ",
      options: [{ index: 1, label: "Create a new one " }, { index: 2, label: "Use  the existing branch" }],
    })),
  );
});

test("every field that changes what an answer MEANS changes the id", () => {
  const base = promptFingerprint(box());
  assert.notEqual(base, promptFingerprint(box({ kind: "trust" })));
  assert.notEqual(base, promptFingerprint(box({ question: "Delete the branch?" })));
  assert.notEqual(base, promptFingerprint(box({ multi: true })));   // a digit TOGGLES in a checkbox box
  assert.notEqual(base, promptFingerprint(box({
    options: [{ index: 1, label: "Use the existing branch" }, { index: 2, label: "Create a new one" }],
  })));                                                              // order is what gets typed
  assert.notEqual(base, promptFingerprint(box({
    options: [{ index: 1, label: "Create a new one" }, { index: 2, label: "Use the existing branch" }, { index: 3, label: "Cancel" }],
  })));
});

test("no question on screen is a mismatch, not a pass", () => {
  const fp = promptFingerprint(box());
  assert.equal(promptStillCurrent(box(), fp), true);
  assert.equal(promptStillCurrent(null, fp), false);       // answered at the desk, or the agent moved on
  assert.equal(promptStillCurrent(undefined, fp), false);
  assert.equal(promptStillCurrent(box({ question: "Something else?" }), fp), false);
});

test("a question that takes typed words is a different question from one that does not", () => {
  const q = box({ kind: "question", options: [] });
  assert.notEqual(promptFingerprint(q), promptFingerprint({ ...q, freeText: true }));
  // Appended only when SET (`nav`'s rule): every id minted before the field existed stays the same.
  assert.equal(promptFingerprint(box()), promptFingerprint(box({ freeText: false })));
});

test("a typed answer: one line of words, at most ANSWER_TEXT_MAX, never a keystroke", () => {
  assert.equal(answerTextProblem("blue"), null);
  assert.equal(answerTextProblem("x".repeat(ANSWER_TEXT_MAX)), null);
  assert.match(answerTextProblem("x".repeat(ANSWER_TEXT_MAX + 1)), /at most 1000/);
  assert.match(answerTextProblem("   "), /no words/);
  assert.match(answerTextProblem(""), /no words/);
  assert.match(answerTextProblem(42), /no words/);
  assert.match(answerTextProblem("yes\rno"), /control character/);
  assert.match(answerTextProblem("a\nb"), /control character/);
  assert.match(answerTextProblem("\x1b[A"), /control character/);
});
