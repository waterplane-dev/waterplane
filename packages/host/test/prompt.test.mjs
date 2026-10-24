/**
 * The two-stage choice-box detector.
 *
 * Every failure in `prompt.ts` is one silent nothing — no approve bar, no push,
 * a live box the phone cannot see. The cases below are the specific ways a
 * screen it can only half-read has broken it before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPrompt, dialogStillUp, hasDialogFooter, mergeBox, navToSubmit, sameBox, samePrompt, stripAnsi } from "../dist/prompt.js";
import { promptFingerprint } from "@waterplane/shared";

/** A well-formed two-option box, as the TUI draws one. */
const BOX = [
  "Do you want to make this edit to api.ts?",
  "",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");

test("a well-formed box is detected, with its options in order", () => {
  const p = detectPrompt(BOX);
  assert.ok(p, "a box with a cursor and a footer must be detected");
  assert.deepEqual(p.options.map((o) => o.index), [1, 2]);
  assert.equal(p.options[0].label, "Yes");
  assert.match(p.question, /make this edit/);
  assert.ok(!p.truncated, "a run starting at 1 is not truncated");
  assert.ok(!p.questionTruncated, "a short question is not text-truncated");
});

test("a long screen question says its displayed text was truncated", () => {
  const p = detectPrompt([
    `Do you want to make this edit? ${"x".repeat(400)}`,
    "",
    "❯ 1. Yes",
    "  2. No",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n"));
  assert.ok(p);
  assert.equal(p.question.length, 300);
  assert.equal(p.questionTruncated, true);
});

test("a repaint that swallowed the spaces still reads as a dialog footer", () => {
  // The TUI repaints a row by ERASING a cell and stepping over it rather than
  // writing the space back, so an ANSI-stripped byte window reads
  // "Entertoselect". Matching only the spaced form meant a real box never
  // bought the render that would have published it.
  assert.equal(hasDialogFooter("Enter to select · Esc to cancel"), true);
  assert.equal(hasDialogFooter("Entertoselect·Esctocancel"), true);
  assert.equal(hasDialogFooter("nothing here"), false);
});

test("'esc to interrupt' is the working line, not a dialog", () => {
  // Printed by every busy session. Treating it as a box is how a working
  // session grows a phantom approve bar.
  assert.equal(hasDialogFooter("· Thinking… (esc to interrupt)"), false);
});

test("the strict pass needs its evidence; the lenient gate does not", () => {
  const bare = ["Pick one:", "", "  1. Yes", "  2. No"].join("\n");
  assert.equal(detectPrompt(bare), null,
    "without a cursor or a footer nothing may be published");
  assert.ok(detectPrompt(bare, { lenient: true }),
    "the cheap gate must still buy a render — a repaint can lose both");
});

test("an unrecognized marker costs the cursor, not the whole box", () => {
  // Only the real cursor glyph is PROOF of a selection. A marker we do not
  // recognise must not take the option row with it.
  const p = detectPrompt(BOX.replace("❯ 1.", "> 1."));
  assert.ok(p, "a one-character marker before the index is tolerated");
  assert.deepEqual(p.options.map((o) => o.index), [1, 2]);
});

test("prose numbered from 2 under a working line is not a box", () => {
  // The lenient gate has no footer or cursor to lean on, so it keeps the
  // anchor: a run that never reaches 1 is text, not a dialog.
  const prose = [
    "I'll do this in steps.",
    "  2. rename the module",
    "  3. update the imports",
  ].join("\n");
  assert.equal(detectPrompt(prose, { lenient: true }), null);
});

test("a box taller than the terminal publishes what is legible, marked truncated", () => {
  // The strict pass no longer anchors on index 1. Publishing null unmounted the
  // approve panel, the terminal grew, the PTY resized, claude repainted a box
  // that now fit, and the panel came back — about once a second.
  const tall = [
    "  3. Berlin",
    "❯ 4. Hamburg",
    "  5. Munich",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  const p = detectPrompt(tall);
  assert.ok(p, "a visible run that starts above 1 is still a box");
  assert.equal(p.truncated, true);
  assert.deepEqual(p.options.map((o) => o.index), [3, 4, 5],
    "the indices published are what a keystroke actually means");
});

test("stripAnsi leaves the text a human would have read", () => {
  assert.equal(stripAnsi("[1;32mYes[0m"), "Yes");
});

// ── Placing the cursor on a checkbox box's Submit row ──────────────────────
// A bare Return is a TOGGLE everywhere except that row, so a wrong distance
// here un-picks the option the user chose and leaves the box open.
const CHECKBOX_BOX = (cursorOn, commit = "Submit") => {
  const rows = [
    "1. [✔] Host notification + push",
    "   A real notification kind, gated in notifyprefs.",
    "2. [ ] Launcher badge",
    "   A persistent count chip on the launcher header.",
    "3. [ ] Standing banner",
    "4. [ ] Type something",
    commit,
    "─────────────────────────────",
    "5. Chat about this",
  ];
  return [
    "How should a give-up announce itself proactively?",
    "",
    ...rows.map((r) => (r.trim() === cursorOn ? "❯  " + r : "  " + r)),
    "",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");
};

test("the Submit row is measured in selectable ROWS, not screen lines", () => {
  // Cursor on option 1, three options and their description lines below it.
  assert.deepEqual(navToSubmit(CHECKBOX_BOX("1. [✔] Host notification + push")), { steps: 4, label: "Submit" });
});

test("a cursor already on Submit needs no move", () => {
  assert.deepEqual(navToSubmit(CHECKBOX_BOX("Submit")), { steps: 0, label: "Submit" });
});

test("a cursor below Submit walks back UP", () => {
  assert.deepEqual(navToSubmit(CHECKBOX_BOX("5. Chat about this")), { steps: -1, label: "Submit" });
});

test("the commit row says Next on every question of an ask but the last", () => {
  // Read off the installed binary: the multi-select list is handed
  // `submitButtonText: <last question> ? "Submit" : "Next"`. Matching "Submit"
  // alone found no commit row at all on a multi-question ask, so every phone
  // Submit fell back to a bare Return — which re-toggles whatever row the
  // cursor sits on and leaves the box open. That is the health board's
  // "Placing the cursor on a multi-select Submit row" going red.
  assert.deepEqual(
    navToSubmit(CHECKBOX_BOX("1. [✔] Host notification + push", "Next")),
    { steps: 4, label: "Next" },
    "the row is found, and the word it was drawn with travels",
  );
  assert.deepEqual(navToSubmit(CHECKBOX_BOX("Next", "Next")), { steps: 0, label: "Next" });
});

test("a numbered option whose label is the commit word is not the commit row", () => {
  // "1. Next" must parse as an option: the marker slot is ONE character, so
  // "1." can never fill it, and the row is anchored at both ends.
  const box = [
    "Pick one",
    "",
    "❯ 1. Next",
    "  2. Back",
    "",
    "Enter to select · Esc to cancel",
  ].join("\n");
  assert.equal(navToSubmit(box), null, "no commit row here — a bare Return is the honest fallback");
  assert.equal(detectPrompt(box).options[0].label, "Next");
});

test("no Submit row, or no cursor, is null — never a guessed direction", () => {
  assert.equal(navToSubmit(BOX), null, "a single-choice box has no Submit row");
  const noCursor = CHECKBOX_BOX("nothing is selected");
  assert.equal(navToSubmit(noCursor), null, "a box whose cursor scrolled off is not navigable");
});

test("the cursor of an OLDER box on the same screen is not measured against", () => {
  const stale = ["❯ 1. Yes", "  2. No", ""].join("\n");
  const nav = navToSubmit(stale + "\n".repeat(50) + CHECKBOX_BOX("2. [ ] Launcher badge"));
  assert.deepEqual(nav, { steps: 3, label: "Submit" });
});

// ── A box that has scrolled up is a box that was answered ──────────────────
// This CLI does not repaint an alt screen; it scrolls, and the strict pass reads
// the last 60 rendered LINES. So an answered box sits in that window with the
// conversation drawn under it and was re-detected on every check — a published
// approve bar for a question nobody is being asked, an `awaitingInput` interlock
// on an idle session, and a panel over a live console. Ground truth for the
// shapes below: real captures off claude v2.1.236.

/** The composer, as the CLI actually draws it under a finished turn. */
const COMPOSER = [
  "  ⎿  Compaction canceled.",
  "",
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

test("a box with the composer drawn under it is gone, not open", () => {
  assert.equal(detectPrompt(BOX + "\n" + COMPOSER), null,
    "the conversation moved on — publishing this is a question nobody is being asked");
  assert.equal(dialogStillUp(BOX + "\n" + COMPOSER), false,
    "and the interlock must not park an idle session on it either");
});

test("a live box is the LAST thing on the screen", () => {
  // Every real capture ends on the footer: the CLI draws no composer under an
  // open dialog. Trailing blank rows are not rows.
  assert.ok(detectPrompt("some earlier turn\n\n" + BOX + "\n\n"),
    "a box at the bottom is still published");
  assert.equal(dialogStillUp(BOX + "\n\n"), true);
});

test("rows that are not a composer do not retire a box", () => {
  // The rule is "has the CLI started taking typing again", not "is anything
  // drawn below". A row count was tried first and could not tell a real
  // composer from a shell stub echoing its prompt once per Return — which is a
  // live box in every e2e that drives one.
  const noise = BOX + "\nbash-3.2$\nbash-3.2$\nbash-3.2$\nbash-3.2$";
  assert.ok(detectPrompt(noise), "a box with no composer under it is still open");
  assert.equal(dialogStillUp(noise), true);
});

test("each half of the composer is enough on its own", () => {
  // Upstream can drop any one of them; recognising only the full set would put
  // the stale box back. (Not recognising a composer at all is the safe
  // direction — the box lingers, which is what it did before.)
  for (const row of ["────────────────────────────────────────", "❯ 11", "  ⏵⏵ auto mode on (shift+tab to cycle)"]) {
    assert.equal(detectPrompt(BOX + "\n" + row), null, `retired by: ${row}`);
    assert.equal(dialogStillUp(BOX + "\n" + row), false, `interlock cleared by: ${row}`);
  }
});

test("the lenient gate keeps no bottom anchor", () => {
  // It reads a BYTE window whose bottom is wherever a repaint stopped, so
  // "how far from the end" means nothing there — and a gate that refuses buys
  // no render, i.e. a real box is never published at all.
  assert.ok(detectPrompt(BOX + "\n" + COMPOSER, { lenient: true }),
    "the cheap gate must still buy the render that decides");
});

// ── The multi-select box the phone could not answer ────────────────────────
//
// Reported with two screenshots taken in the same second: one showing the
// session `coding` with no answer panel, the next showing it `waiting` with the
// panel up. The box was a six-option multi-select with wrapped descriptions —
// tall enough that the phone's answer panel took a third of the screen, which
// shrank the terminal, which resized the PTY, which SIGWINCHed claude into
// repainting everything. The captures across that repaint were counted as
// failed parses, three of them retired the box, the panel unmounted, the grid
// grew back, and round it went at about 2 Hz.
//
// The screen itself was never the problem, which is what these pin: it parses
// cleanly at a phone width, footer wrapped and all. The fix is that the host no
// longer spends its miss budget on a repaint it asked for.

const MULTI = (footer) => [
  "What's wrong with them on mobile?",
  "",
  " 1. [ ] Cramped / overflowing rows",
  "    Text truncated, horizontal overflow, buttons",
  "    squeezed off the row edge.",
  " 2. [_] Tap targets too small",
  "    Icon buttons and chips too small or too close to hit",
  "    reliably with a thumb.",
  " 3. [_] Bad hierarchy / noisy",
  "    Too much info per row, unclear what's primary, walls",
  "    of small muted text.",
  " 4. [_] Unreachable / bottom-cut",
  "    Controls under the home indicator or keyboard, sheet",
  "    doesn't scroll fully.",
  " 5. [ ] Type something",
  "_    Submit",
  "────────────────────────────────────────────",
  "  6. Chat about this",
  "",
  ...footer,
].join("\n");

test("a tall multi-select parses with its footer WRAPPED, as a phone wraps it", () => {
  // The desktop draws this footer on one line and a 52-column phone does not.
  // If the wrap cost the parse, the panel would be flickering for a second
  // reason and the host fix would hide it rather than fix it.
  const wrapped = MULTI([
    "Enter to select · Tab/Arrow keys to navigate · ctrl+g",
    "to edit in Vim · Esc to cancel",
  ]);
  const p = detectPrompt(wrapped);
  assert.ok(p, "a box whose footer wrapped is still a box");
  assert.deepEqual(p.options.map((o) => o.index), [1, 2, 3, 4, 5, 6]);
  assert.ok(dialogStillUp(wrapped), "and the interlock still sees it");
});

test("the same box on one line parses identically — width changes nothing", () => {
  const oneLine = MULTI(["Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel"]);
  const wide = detectPrompt(oneLine);
  const narrow = detectPrompt(MULTI([
    "Enter to select · Tab/Arrow keys to navigate · ctrl+g",
    "to edit in Vim · Esc to cancel",
  ]));
  assert.deepEqual(
    wide.options.map((o) => o.index),
    narrow.options.map((o) => o.index),
    "a resize must not change what the detector says is on screen",
  );
});

// ── One box stays ONE box while the TUI repaints under it ─────────────────
// The strict pass runs about twice a second while a dialog is up and reads
// whatever is legible RIGHT NOW. The console refreshing itself, a pan, or a box
// taller than the terminal all change that — and every change re-published the
// question under a new fingerprint, which re-opened a card the user had
// collapsed or hidden to answer at the desk, made queued answers stale and
// fired a push per repaint.
const PUB = {
  kind: "select",
  question: "Which mixing strategies should exist?",
  multi: true,
  options: [
    { index: 1, label: "All three", desc: "Per speaker, blocks of N, fully random." },
    { index: 2, label: "Per speaker only" },
    { index: 3, label: "Blocks of N clips" },
  ],
};
/** The same box after its top scrolled away: placeholder question, tail only. */
const SCROLLED = {
  kind: "select",
  question: "Claude is waiting for a choice",
  multi: true,
  truncated: true,
  options: [
    { index: 2, label: "Per speaker only" },
    { index: 3, label: "Blocks of N clips" },
  ],
};

test("a box whose top scrolled away is the same box", () => {
  assert.equal(sameBox(PUB, SCROLLED), true);
  assert.equal(sameBox(SCROLLED, PUB), true);
});

test("the merge keeps the options that scrolled off, and the real question", () => {
  const m = mergeBox(PUB, SCROLLED);
  assert.deepEqual(m.options.map((o) => o.index), [1, 2, 3], "option 1 is not lost with its row");
  assert.equal(m.question, PUB.question, "the placeholder never overwrites a question somebody read");
  assert.equal(m.options[0].desc, PUB.options[0].desc, "enrichment survives a repaint");
  assert.ok(!m.truncated, "nothing is unreachable from the card any more");
});

test("the merge keeps the truncation marker with the question it keeps", () => {
  const clipped = { ...PUB, questionTruncated: true };
  assert.equal(mergeBox(clipped, PUB).questionTruncated, true);
});

test("a description that arrives a pass late is added, and changes no fingerprint", () => {
  const bare = { ...PUB, options: PUB.options.map(({ desc, ...o }) => o) };
  const m = mergeBox(bare, PUB);
  assert.deepEqual(m.options.map((o) => o.desc), PUB.options.map((o) => o.desc), "the late enrichment reaches the card");
  assert.equal(promptFingerprint(m), promptFingerprint(bare), "a queued answer stays valid");
  const other = { ...PUB, options: PUB.options.map((o) => ({ ...o, desc: "something else" })) };
  assert.equal(mergeBox(PUB, other).options[0].desc, PUB.options[0].desc, "a description already shown is kept");
});

test("the merge is STABLE — a second identical pass changes nothing", () => {
  const once = mergeBox(PUB, SCROLLED);
  assert.deepEqual(mergeBox(once, SCROLLED), once, "a repaint must not re-publish the card");
});

test("a published label is never rewritten, in EITHER direction", () => {
  // The labels ARE the fingerprint, so replacing one restarts the card and
  // makes an answer queued against it stale — the exact thing this merge
  // exists to stop. "The longer read is the truer one" was tried and fails the
  // other way too: a garbled read that happens to be longer (a panel border
  // the side-panel cut missed) would win permanently, since the correct
  // shorter read could never take it back. What makes a cut label readable is
  // `desc`/`ask`, which carry the CLI's own words.
  const cut = { ...PUB, options: [{ index: 1, label: "All th" }, { index: 2, label: "Per speaker only" }] };
  assert.equal(mergeBox(PUB, cut).options[0].label, "All three", "a narrow repaint must not rewrite a label an answer named");
  assert.equal(mergeBox(cut, PUB).options[0].label, "All th", "…and neither may a wide one");
});

test("a different question with the same shape is a different box", () => {
  const other = { ...PUB, question: "Which output formats should exist?" };
  assert.equal(sameBox(PUB, other), false);
});

test("a disagreeing label at a shared index is a different box", () => {
  const other = { ...PUB, options: [{ index: 1, label: "Something else entirely" }, { index: 2, label: "Per speaker only" }] };
  assert.equal(sameBox(PUB, other), false);
});

test("no shared index is no evidence, so not the same box", () => {
  const later = { ...PUB, question: "Claude is waiting for a choice", options: [{ index: 7, label: "Other" }, { index: 8, label: "Chat about this" }] };
  assert.equal(sameBox(PUB, later), false);
});

test("kind and shape are part of identity", () => {
  assert.equal(sameBox(PUB, { ...PUB, kind: "tool" }), false);
  assert.equal(sameBox(PUB, { ...PUB, multi: undefined }), false, "a digit TOGGLES in a checkbox box");
});

test("the commit word survives a pass that could not read the row", () => {
  const withWord = mergeBox({ ...PUB, submitLabel: "Next" }, SCROLLED);
  assert.equal(withWord.submitLabel, "Next");
});

test("where the CLI names the box, that is the identity — not the scraped question", () => {
  // Measured on a live shell: the detector joins up to four lines above option
  // 1, and on a screen that scrolls those lines are whatever is there. One box
  // published its question three ways in four seconds — "Do you want to
  // proceed?", then "1. Yes 2. No bash-3.2$ for i in …", then a third. `askId`
  // is the CLI's own handle on that box (the pending tool call plus which of
  // its questions this is) and no repaint can move it.
  const a = { ...PUB, askId: "toolu_01#0" };
  const b = { ...PUB, askId: "toolu_01#0", question: "1. All three 2. Per speaker only lorem ipsum" };
  assert.equal(sameBox(a, b), true, "two spellings of one question are still one box");
  assert.equal(mergeBox(a, b).question, PUB.question, "and the card keeps the reading that made sense");
});

test("two questions of ONE ask are two boxes", () => {
  // A single `AskUserQuestion` may carry several questions and the TUI draws
  // them one at a time with Tab between them, so the tool_use id alone would
  // call two different boxes one box — hence the `#n`.
  assert.equal(sameBox({ ...PUB, askId: "toolu_01#0" }, { ...PUB, askId: "toolu_01#1" }), false);
});

test("a box the log could not be asked about falls back to the strict rule", () => {
  // Only one side named: nothing to compare ids with, so the conservative
  // structural test decides. A tool approval never has an id at all.
  assert.equal(sameBox({ ...PUB, askId: "toolu_01#0" }, PUB), true, "same question, same labels");
  assert.equal(sameBox({ ...PUB, askId: "toolu_01#0" }, { ...PUB, question: "Something else?" }), false);
});

test("the merge takes the FRESHEST askId — an unreadable log says nothing, not something older", () => {
  assert.equal(mergeBox({ ...PUB, askId: "toolu_01#0" }, PUB).askId, "toolu_01#0", "a pass that could not read the log keeps what we had");
  assert.equal(mergeBox({ ...PUB, askId: "toolu_01#0" }, { ...PUB, askId: "toolu_02#0" }).askId, "toolu_02#0");
});

test("a published box is BOUNDED, and what gives way is the tail", () => {
  // The strict parse caps its own run at 8; recovery and the merge can both add
  // to it, so the union needs a bound of its own or the wire message has none.
  // The head is the half that scrolled off the screen, so it is the tail that
  // goes — the tail is the part somebody can still read in the terminal.
  const many = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ index: from + i, label: `option ${from + i}` }));
  const a = { kind: "select", question: "Pick", multi: true, options: many(10) };
  const b = { kind: "select", question: "Pick", multi: true, options: many(10, 8) };
  const m = mergeBox(a, b);
  assert.equal(m.options.length, 14);
  assert.equal(m.options[0].index, 1);
  assert.equal(m.options.at(-1).index, 14);
});

// ── The ways one box was mistaken for another ─────────────────────────────
// Found in review, each one a wrong question over live buttons.

test("a matching askId is not enough — the rows still have to agree", () => {
  // Q1 and Q2 of one ask that share two labels get the SAME id from a matcher
  // working on a handful of words, so the id alone let question 1's card stand
  // over question 2's buttons: index 3 read "Not sure" while a 3 keystroke
  // would have picked "Later".
  const q1 = { kind: "select", question: "First?", multi: true, askId: "toolu#0",
    options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }, { index: 3, label: "Not sure" }] };
  const q2 = { ...q1, question: "Second?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }, { index: 3, label: "Later" }] };
  assert.equal(sameBox(q1, q2), false);
});

test("agreeing on the TUI's own rows is agreeing on nothing", () => {
  // "Other" and "Chat about this" are drawn under every question the TUI
  // draws. A new box taller than the terminal can present nothing else — and
  // that used to glue the previous box's question AND its labels onto it,
  // with `truncated` cleared, permanently.
  const live = { kind: "select", question: "Which strategy?", multi: true,
    options: [{ index: 1, label: "A" }, { index: 2, label: "B" }, { index: 5, label: "Other" }, { index: 6, label: "Chat about this" }] };
  const tail = { kind: "select", question: "Claude is waiting for a choice", multi: true, truncated: true,
    options: [{ index: 5, label: "Other" }, { index: 6, label: "Chat about this" }] };
  assert.equal(sameBox(live, tail), false);
  // …while one row of the box's OWN is evidence.
  const withOwn = { ...tail, options: [{ index: 2, label: "B" }, ...tail.options] };
  assert.equal(sameBox(live, withOwn), true);
});

test("a named box survives its kind being re-derived", () => {
  // `kind` comes from the question and the labels, and a truncated pass has no
  // question — so an ask whose words contain "proceed" flips tool→select and,
  // since `kind` is in the fingerprint, the card changed identity on every pan.
  const a = { kind: "tool", question: "Proceed with the plan?", multi: true, askId: "toolu#0",
    options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }] };
  const b = { ...a, kind: "select", question: "Claude is waiting for a choice" };
  assert.equal(sameBox(a, b), true);
  assert.equal(mergeBox(a, b).kind, "tool", "and it keeps the kind it was published with");
  // Unnamed, the kind still decides: a "2" at a trust dialog and a "2" at a
  // tool-approval box are different acts.
  assert.equal(sameBox({ ...a, askId: undefined }, { ...b, askId: undefined }), false);
});

test("samePrompt compares FIELDS, so a merge does not look like a change", () => {
  // `applyPrompt` used `JSON.stringify`, which also compares key order — and
  // the merge builds its object in its own order. The pass after every merge
  // therefore bought a broadcast, a push and an oracle call for a card that
  // had not moved.
  const fresh = { kind: "select", question: "Q", options: [{ index: 1, label: "A" }, { index: 2, label: "B" }], multi: true, submitLabel: "Submit", ask: "Q really", askId: "toolu#0" };
  const merged = mergeBox(fresh, fresh);
  assert.notEqual(JSON.stringify(fresh), JSON.stringify(merged), "the key order genuinely differs — that is the trap");
  assert.equal(samePrompt(fresh, merged), true);
  assert.equal(samePrompt(fresh, { ...merged, questionTruncated: true }), false,
    "a change in whether the displayed text is complete must reach the card");
  assert.equal(samePrompt(fresh, { ...fresh, options: [{ index: 1, label: "A" }] }), false);
  assert.equal(samePrompt(null, null), true);
  assert.equal(samePrompt(fresh, null), false);
});

test("a prose bullet reading “Next” is not a commit row", () => {
  // The row is two common words, so a permissive marker slot would make the
  // agent's own bullet list a target once the real row scrolled off.
  const prose = [
    "  - Next",
    "  • Next",
    "  # Next",
    "",
    "Enter to select · Esc to cancel",
  ].join("\n");
  assert.equal(navToSubmit(prose), null);
});

test("a Bash box framed in dashed rules is a tool box, its question free of the rules (v2.1.293)", () => {
  // Captured off the binary with tmux, 2026-10-07: the command sits between two
  // rows of U+254C, which used to fill the question and cut off its last line.
  const rule = "╌".repeat(100);
  const screen = [
    "────────────────────────────────────────────────────────────────────────────────────────────────────",
    " Bash command",
    " Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below",
    " Create wp-smoke directory and echo hi",
    rule,
    " mkdir -p wp-smoke && echo hi",
    rule,
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to",
    "      /private/var/folders/7_/zb4jhm2x0j18kgjwfpmh_97h0000gn/T/tmp.euvw0wRdxE from this project",
    "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
    "   4. No",
    " Esc to cancel · Tab to amend",
  ].join("\n");
  const p = detectPrompt(screen);
  assert.ok(p, "the box must be detected");
  assert.equal(p.kind, "tool");
  assert.match(p.question, /Do you want to proceed\?/);
  assert.doesNotMatch(p.question, /╌/);
  assert.deepEqual(p.options.map((o) => o.index), [1, 2, 3, 4]);
});
