/**
 * The prose-question heuristic: "the turn ended and it is asking YOU something".
 *
 * The failure this covers is not a wrong answer, it is silence — a turn that
 * ends on "Want 2 implemented, or leave it at 1?" used to publish nothing at
 * all unless a Gemini key happened to be configured, so the phone said "Turn
 * finished" and the decision sat there. The cases below are the shapes that
 * reach the detector off a real pane: the question wrapped above the composer,
 * the composer's own chrome under it, and ordinary output that must NOT trip it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { askLine, looksLikeQuestion, questionText, sameAsk } from "../dist/question.js";

/** The tail of a real pane: the agent's closing lines, then the CLI's composer. */
const CHROME = [
  "",
  "─────────────────────────────────────────",
  "> ",
  "─────────────────────────────────────────",
  "  auto mode on (shift+tab to cycle) · ⏵⏵ 2 agents",
].join("\n");

test("a turn ending on a question is detected, and the ASK is the line published", () => {
  const tail = [
    "2. Renderer-side: resolve a bare name.ext code span against the repo's outbox listing.",
    "",
    "Want 2 implemented, or leave it at 1?",
  ].join("\n") + CHROME;
  assert.ok(looksLikeQuestion(tail));
  assert.equal(askLine(tail), "Want 2 implemented, or leave it at 1?");
});

test("the ask is the QUESTION line, not whatever the agent printed last", () => {
  // `questionText` joins the closing lines for the audit log; a push body and a
  // launcher row get one sentence, and it must be the one with the "?" in it.
  const tail = ["Want me to wire the badge too?", "Both are small.", "✻ Churned for 1m 46s"].join("\n") + CHROME;
  assert.equal(askLine(tail), "Want me to wire the badge too?");
  assert.match(questionText(tail), /Want me to wire the badge too\?/);
});

test("question phrasing without a question mark still counts", () => {
  assert.ok(looksLikeQuestion("Tests pass.\nShould I push this" + CHROME));
});

test("ordinary output is not a question", () => {
  const tail = ["Ran 1 shell command", "Build OK, edits compile.", "✻ Churned for 12s"].join("\n") + CHROME;
  assert.ok(!looksLikeQuestion(tail), "a finished turn with no ask must publish nothing");
});

test("a relative 'which' in a report is not a question", () => {
  // Measured: a status report badged "asked you" because "which" appeared
  // mid-paragraph three lines above the end, with no ask anywhere.
  const tail = [
    "I cancelled those two and re-posted them timed relative to the",
    "weekly reset instead (179 min before 18:59), which is how the onboarding row is set up.",
    "All three runs share the remaining budget.",
    "The plan is in docs/analysis/demo-mode-plan.md, committed as 41bfae8. Both",
    "rows show in the phone backlog, where you can edit or delete them.",
  ].join("\n") + CHROME;
  assert.ok(!looksLikeQuestion(tail));
  assert.ok(looksLikeQuestion("Two ways to do it.\nWhich one" + CHROME), "an opening 'which' still asks");
});

test("a long ask is capped rather than sent whole to a phone", () => {
  const long = "Do you want " + "the very long option ".repeat(20) + "?";
  const out = askLine(long + CHROME);
  assert.ok(out.length <= 180, `capped, got ${out.length}`);
  assert.ok(out.endsWith("…"));
});

test("an empty tail asks nothing", () => {
  assert.ok(!looksLikeQuestion(""));
  assert.equal(askLine(""), "");
});

// A question marked handled came straight back: the dismissal compared bytes,
// and the next repaint of the same question read back with its words glued
// (cursor moves where the spaces were) and the 180-char cap cutting elsewhere.
test("the same question survives a repaint that re-glues its words", () => {
  const spaced = "12 are currently blocked on paused, which is why they read as waiting rather than firing.";
  const glued = "12 are currently blocked on paused,whichiswhytheyreadaswaitingratherthanfiring.";
  assert.ok(sameAsk(spaced, glued));
  assert.ok(sameAsk("Go?", "Go?"));
  // a capped reading matches the longer reading it was cut from
  assert.ok(sameAsk("Installs never cared about the file…", "Installsnevercaredaboutthefilename — it keys on the package."));
  // but an uncapped short question never swallows a longer one
  assert.ok(!sameAsk("Go?", "Going to delete it, ok?"));
  assert.ok(!sameAsk("Want 2 implemented?", "Want 3 implemented?"));
  assert.ok(!sameAsk("", ""));
});

test("a question WRAPPED over grid rows is read back whole, with its spaces", () => {
  // The rendered grid at phone width, as the "waiting for your answer" card
  // read it: the raw bytes had glued this into "TheUIisstillwronghere".
  const grid = [
    "● Setup is fine. The 4h time filter is hiding",
    "  everything.",
    "",
    "  - The newest files are .claude/outbox/architecture.svg",
    "    and the two other architecture SVGs.",
    "",
    "  The UI is still wrong here. \"Outbox is empty\" is",
    "  false: it's filtered to 0 of 126. Want me to fix it so",
    "  it reads something like \"0 of 126 in the last 4h,",
    "  show all\"?",
    "",
    "✻ Baked for 30s · done 2:28 PM",
    "",
    "──────────────────────────────",
    "❯ yes fix the empty state",
    "──────────────────────────────",
    "  [CAVEMAN]",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents",
  ].join("\n");
  assert.ok(looksLikeQuestion(grid));
  assert.equal(askLine(grid, 400),
    "The UI is still wrong here. \"Outbox is empty\" is false: it's filtered to 0 of 126. Want me to fix it so it reads something like \"0 of 126 in the last 4h, show all\"?");
});
