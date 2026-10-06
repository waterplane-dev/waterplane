/**
 * Recovering the options a TALL box scrolled off its own top.
 *
 * A box with six options and a description each does not fit a phone's
 * terminal, so the CLI scrolls its top away and the strict pass publishes a run
 * starting at 4. The card then offered three buttons for a six-option question
 * and said "options above 4 are off the screen" — a question you cannot
 * honestly answer from the phone.
 *
 * The log has the whole list, and its order IS the TUI's numbering (measured on
 * claude 2.1.267: the drawn list is `[...the tool's options, "Other",
 * ("Chat about this")]`, numbered from 1). So the recovery is exact — but only
 * where the two lists can be PROVED to line up, because the alternative to
 * absent here is a button that types the wrong digit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAsk, recoverHead } from "../dist/askbox.js";

const ASK = {
  question: "Which mixing strategies should exist?",
  multi: true,
  options: [
    { label: "All three", desc: "Per speaker, blocks of N, and fully random." },
    { label: "Per speaker only", desc: "One language per character for the whole book." },
    { label: "Blocks of N clips", desc: "Alternate every N clips by media index." },
    { label: "Fully random per clip" },
  ],
};

test("the head comes back with the words the tool wrote", () => {
  const scraped = [{ index: 3, label: "Blocks of N clips" }, { index: 4, label: "Fully random per clip" }];
  const head = recoverHead(ASK, scraped);
  assert.deepEqual(head?.map((o) => o.label), ["All three", "Per speaker only"]);
  assert.equal(head?.[0].desc, ASK.options[0].desc, "the description rides with it");
});

test("a label the terminal cut still proves the alignment", () => {
  const head = recoverHead(ASK, [{ index: 3, label: "Blocks of N cl" }]);
  assert.deepEqual(head?.map((o) => o.label), ["All three", "Per speaker only"]);
});

test("a run already starting at 1 has nothing to recover", () => {
  assert.equal(recoverHead(ASK, [{ index: 1, label: "All three" }, { index: 2, label: "Per speaker only" }]), null);
});

test("a disagreeing shared index refuses — absent, never a wrong number", () => {
  const head = recoverHead(ASK, [{ index: 3, label: "Something the tool never sent" }]);
  assert.equal(head, null);
});

test("a run made only of the TUI's own appended rows overlaps nothing", () => {
  // "Other" and "Chat about this" are drawn after the tool's options and are
  // numbered with them, so a badly scrolled screen can show only those. There
  // is then no shared index to check the alignment against.
  const head = recoverHead(ASK, [{ index: 5, label: "Other" }, { index: 6, label: "Chat about this" }]);
  assert.equal(head, null);
});

test("a log that cannot reach up to this run refuses", () => {
  // The visible run starts at 6 but the tool only ever sent four options, so
  // rows 1..5 are not all the log's to speak for.
  assert.equal(recoverHead(ASK, [{ index: 6, label: "Chat about this" }]), null);
});


// ── WHICH logged question is the box on screen ───────────────────────────
// One `AskUserQuestion` may carry several. Taking the first that overlaps gave
// question 1 for a screen showing question 2, and with it question 1's id (so
// the card never changed), its descriptions, and its first options as the
// "recovered" head a digit would select.
const Q1 = { id: "toolu#0", question: "First?", options: [{ label: "Yes" }, { label: "No" }, { label: "Not sure" }] };
const Q2 = { id: "toolu#1", question: "Second?", options: [{ label: "Yes" }, { label: "No" }, { label: "Later" }] };

test("the unique best match wins", () => {
  assert.equal(pickAsk([Q1, Q2], ["Yes", "No", "Later", "Other"])?.id, "toolu#1");
  assert.equal(pickAsk([Q1, Q2], ["Yes", "No", "Not sure", "Other"])?.id, "toolu#0");
});

test("a tie enriches NOTHING — absent, never the first one that overlapped", () => {
  // The screen shows only the two labels both questions have. It does not say
  // which question it is, and neither may we.
  assert.equal(pickAsk([Q1, Q2], ["Yes", "No", "Other", "Chat about this"]), null);
});

test("a call with one question is unaffected", () => {
  assert.equal(pickAsk([Q1], ["Yes", "No"])?.id, "toolu#0");
  assert.equal(pickAsk([], ["Yes", "No"]), null);
  assert.equal(pickAsk([Q1], ["Totally", "Unrelated"]), null);
});
