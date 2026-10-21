/**
 * "Is THIS text in that?" — the rule three places depend on, in isolation.
 *
 * `deliver.ts` asks it of the rendered screen while it types, `settle.ts` asks
 * it of the screen and of the CLI's conversation log minutes later, and the
 * open-question sweep asks it of the log for as long as it takes. Every failure
 * of this rule is silent and expensive in one of two directions: a false NO
 * files a running prompt as a gravestone (the 67-row bug), and a false YES on
 * the log side reports a prompt as landed when nothing ran.
 *
 * Pinned here rather than only through a booted host because a fixture is where
 * you can state the awkward cases — a placeholder that swallowed the whole
 * text, one that swallowed somebody else's — in one line each.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collapsedPasteEcho, echoAmbiguous, echoProbe, isSlashText, logEcho, screenEcho, squash, tailProbe, textEcho } from "../dist/echo.js";
import { composerEcho, composerSpans, composerText } from "../dist/composer.js";

test("the comparison view removes the spaces a TUI loses", () => {
  // The real symptom: a rendered claude screen reads "Isthisaprojectyou…"
  // because the TUI positions every character itself.
  assert.equal(squash("Is this a project"), "isthisaproject");
  assert.equal(squash("MIXED\tCase\nText"), "mixedcasetext");
});

test("the probe is the head, the tail probe is the tail", () => {
  const text = "please rewrite the flaky retry test and explain the fix";
  assert.equal(echoProbe(text), squash(text).slice(0, 14));
  assert.equal(tailProbe(text), squash(text).slice(-14));
  assert.equal(echoProbe(""), "", "empty text has no needle at all");
});

test("a screen holding the text matches, whitespace or not", () => {
  const text = "fix the failing retry test";
  assert.equal(textEcho(squash("  > fix   the failing retry test"), text), true);
  assert.equal(textEcho(squash("> something else entirely"), text), false);
});

test("empty text never matches anything", () => {
  // A delivery of nothing is not something we may claim to have seen — and an
  // empty needle is contained in every string.
  assert.equal(textEcho(squash("anything at all"), ""), false);
});

test("a collapsed paste counts as an echo when it is tied to THIS text", () => {
  const text = ["line one of the instruction", "line two", "line three", "line four", "the final line"].join("\n");
  // The TUI hides the head and draws the tail: the placeholder plus the two
  // lines it did not swallow.
  const screen = squash("> [Pasted text #1 +3 lines]line four\n  the final line");
  assert.equal(textEcho(screen, text), true, "hidden count plus the tail on screen");
});

test("a placeholder that swallowed the lot needs no tail", () => {
  const text = ["a", "b", "c", "d", "e"].join("\n");
  assert.equal(collapsedPasteEcho(squash("> [Pasted text #1 +5 lines]"), text), true);
});

test("somebody else's placeholder is not our echo", () => {
  const text = ["one", "two", "three", "four"].join("\n");
  // 40 hidden lines cannot be our 4-line text — this is a stale chit from an
  // earlier, different paste, and accepting it would confirm a delivery that
  // never happened.
  assert.equal(collapsedPasteEcho(squash("> [Pasted text #1 +40 lines]"), text), false);
  // The right count but the wrong tail is the same story.
  assert.equal(collapsedPasteEcho(squash("> [Pasted text #1 +2 lines] a completely different tail"), text), false);
});

test("a SHORT one-liner is never collapsed, so a placeholder proves nothing about it", () => {
  assert.equal(collapsedPasteEcho(squash("> [Pasted text #1 +9 lines]"), "a single line prompt"), false);
  assert.equal(collapsedPasteEcho(squash("> [Pasted text #5]"), "a single line prompt"), false);
});

test("a LONG one-liner is collapsed, and the placeholder carries no line clause", () => {
  // The composer collapses on length as well as on shape (>800 chars), and it
  // omits the `+N lines` clause when the text holds no newline. Requiring the
  // clause matched none of these: every long one-line send read as never typed
  // and came back `unconfirmed` with the prompt sitting in the box.
  const text = "please rewrite the flaky retry test and explain the fix. ".repeat(20);
  assert.ok(text.length > 800 && !text.includes("\n"));
  assert.equal(collapsedPasteEcho(squash("> [Pasted text #5]"), text), true);
  assert.equal(screenEcho(squash("> [Pasted text #5]"), text), "paste");
  // …and the absent clause is a STATEMENT — zero newlines — so it is evidence
  // against a prompt that has some.
  const many = ["one", "two", "three", "four", "five"].join("\n");
  assert.equal(collapsedPasteEcho(squash("> [Pasted text #5]"), many), false);
  // A clause that cannot describe a one-liner is not our echo either.
  assert.equal(collapsedPasteEcho(squash("> [Pasted text #5 +9 lines]"), text), false);
});

test("two long one-liners are indistinguishable behind a bare placeholder", () => {
  // The bare chit says only "a paste with no newlines happened here", so a
  // rival that is also a collapsible one-liner would have produced it equally
  // well — `unknown`, never a Return at somebody else's words.
  const mine = "please rewrite the flaky retry test and explain the fix. ".repeat(20);
  const theirs = "please rewrite the docs index so it links the new notes. ".repeat(20);
  assert.equal(echoAmbiguous("paste", mine, [theirs]), true);
  // A short rival could never have been collapsed, so it is no rival at all.
  assert.equal(echoAmbiguous("paste", mine, ["yes"]), false);
});

test("slash commands are the case the conversation log cannot report", () => {
  // The CLI writes them as a <command-name> envelope and transcript.ts drops
  // exactly those, so log ABSENCE says nothing — and `absent` is the verdict
  // that authorises a re-send.
  assert.equal(isSlashText("/cost"), true);
  assert.equal(isSlashText("   /review the diff"), true);
  assert.equal(isSlashText("run /cost for me"), false);
  assert.equal(isSlashText(""), false);
});

// ── The 14-character collision ───────────────────────────────────────────────
//
// Found live on 2026-09-05, not hypothesised. Every comparison in this
// subsystem — the composer echo, the screen half of `settle`, and the CLI's own
// conversation log — ran on `squash(text).slice(0, 14)`, so two prompts sharing
// a fourteen-character head were one prompt as far as this app could tell. It
// paid out three ways in one session: a prompt that never ran settled `landed`
// on a different prompt's log entry (the row retires and the words are gone),
// two prompts that were nowhere settled `composer` ("press Return there") on a
// stranger's echo, and `deliverPrompt` returned `ok` — the verdict nothing ever
// revisits — for a prompt that never ran.
//
// The trigger shape is the user's most common one: A RE-SEND SHARES ITS ENTIRE
// HEAD WITH THE ORIGINAL, and re-sending is precisely what a person does when
// this app tells them their prompt did not run.

/** Two real prompts, fourteen squashed characters apart from nobody. */
const A = "please rewrite the flaky retry test and explain the fix";
const B = "please rewrite the docs index so it links the new notes";

test("the two fixtures really do collide on the old probe", () => {
  // If this ever stops being true the cases below stop testing anything.
  assert.equal(echoProbe(A), echoProbe(B));
  assert.notEqual(squash(A), squash(B));
});

test("the LOG tells them apart — it holds the whole turn, so it is compared whole", () => {
  // The false `landed` is the failure that destroys words, and this is the line
  // that kills it: the jsonl has no truncation to work around.
  assert.equal(logEcho(A, A), true);
  assert.equal(logEcho(A, B), false, "one prompt's turn is not proof another ran");
  assert.equal(logEcho(B, A), false);
  // Whitespace is still blind — a prompt re-wrapped by the composer, typed with
  // a trailing newline or written with CRLF is still itself.
  assert.equal(logEcho("please rewrite  the flaky\nretry test and explain the fix\n", A), true);
  // And a turn that CONTAINS the prompt (the CLI appending its own trailer)
  // still counts: containment runs one way, and only one way.
  assert.equal(logEcho(A + "\n\n<some-envelope-the-cli-adds/>", A), true);
});

test("the LOG unwraps a paste: 2.1.291 logs it tagged and cut into chunks mid-word", () => {
  // Measured: a 2,966-char phone prompt with newlines landed and ran, and the
  // log held it as three `<pasted_content>` chunks, the first seam splitting
  // "au|to]". Compared raw that read `absent` — "nothing ran" about a prompt
  // that was running.
  const text = "App crashed several times today. Fix it.\n" + "[12:58:48.46] [FavSync auto] imported 0, pendingPush 0\n".repeat(60);
  const cut = 1000;
  const chunks = [];
  for (let i = 0; i < text.length; i += cut) chunks.push(text.slice(i, i + cut));
  const logged = "\n\n" + chunks.map((c) => `<pasted_content id="893a">\n${c}\n</pasted_content id="893a">\n`).join("\n\n");
  assert.equal(logEcho(logged, text), true);
  assert.equal(logEcho(logged, B), false, "unwrapping must not make another prompt match");
});

test("a collapsed paste is still a log match, in case the CLI ever records one", () => {
  const text = ["line one of the instruction", "line two", "line three", "line four", "the final line"].join("\n");
  assert.equal(logEcho("[Pasted text #1 +5 lines]", text), true);
  // …and it is still tied to THIS text, exactly as on a screen.
  assert.equal(logEcho("[Pasted text #1 +40 lines]", text), false);
});

test("the SCREEN says which rule matched, because the rules are not equal evidence", () => {
  const composer = squash("> please rewrite the flaky retry test and explain the fix");
  assert.equal(screenEcho(composer, A), "exact", "the whole text is there — nothing else can produce that");
  // The head alone: a truncated composer, or somebody else's prompt.
  assert.equal(screenEcho(squash("> please rewrite the fl"), A), "head");
  assert.equal(screenEcho(squash("> please rewrite the docs index so it links the new notes"), A), "head",
    "B's echo matches A's probe — which is the whole bug");
  assert.equal(screenEcho(squash("> something else entirely"), A), "none");
});

test("a head match with a rival that shares the head is NOT evidence", () => {
  // The rule this codebase states everywhere else: degrade to "I cannot tell",
  // never to a confident wrong answer. `unknown` costs one more sweep; a wrong
  // `composer` points the user at somebody else's prompt.
  assert.equal(echoAmbiguous("head", A, [B]), true);
  assert.equal(echoAmbiguous("head", A, ["a completely unrelated prompt"]), false);
  assert.equal(echoAmbiguous("head", A, []), false, "no rival, no ambiguity");
  // An EXACT match is never ambiguous — the whole text being on screen is an
  // identification, not a prefix.
  assert.equal(echoAmbiguous("exact", A, [B]), false);
  assert.equal(echoAmbiguous("none", A, [B]), false);
});

test("a re-send of the SAME words is not a rival", () => {
  // The important exemption, and not an optimisation. The common rival is a
  // second copy of the same prompt, and if the composer holds our own words
  // then submitting them runs our own words. Which ROW gets the credit is a
  // different question, and `settle.ts` answers it by claiming the log turn.
  assert.equal(echoAmbiguous("head", A, [A]), false);
  assert.equal(echoAmbiguous("head", A, ["please rewrite the flaky retry test and explain the fix\n"]), false,
    "whitespace does not make it a different prompt");
});

test("a collapsed paste is confusable only with something the same placeholder could describe", () => {
  const mine = ["step one of the plan", "step two", "step three", "step four"].join("\n");
  const sameTail = ["a different opening line", "and another", "and one more", "step four"].join("\n");
  const sameLength = ["nothing alike", "at all", "really", "nope"].join("\n");
  const oneLiner = "a single line prompt";
  assert.equal(echoAmbiguous("paste", mine, [sameTail]), true, "the tail is the tie, so a shared tail is a rival");
  assert.equal(echoAmbiguous("paste", mine, [sameLength]), true, "…and so is a line count the same chit could be reporting");
  assert.equal(echoAmbiguous("paste", mine, [oneLiner]), false, "a one-liner is never collapsed, so it is never behind that chit");
  assert.equal(echoAmbiguous("paste", mine, [mine]), false);
});

// ── The composer is a BOX, not a distance from the bottom ────────────────────
//
// Captured live on 2026-09-11, from a delivery that was declared a miss with
// its text plainly in the composer. `deliver.ts` accepted an echo only within
// ~11 rows of the last row of the rendered capture, which is a fine rule for an
// idle TUI and a measurement of the TEAR on a working one: `render.ts` replays
// the whole buffer into a fixed 50-row VT, so a repaint caught half-done leaves
// a DUPLICATED footer and rows of streaming turn output sitting UNDER the
// newest composer frame. The echo was found, refused for sitting sixteen rows
// up, and the delivery came back `unconfirmed` — after which the miss sweep
// sent an Esc into the running turn and ctrl-U'd away text that had landed.
// ~30% of deliveries, which is what took `deliver.echo` amber and kept it there.
//
// So the question moved: not "how far from the bottom is it" but "is it inside
// the box the CLI draws to take typing".

/**
 * The live capture, as faithfully as a fixture can hold it.
 *
 * The NBSP after the `❯` is the TUI's own padding of the cursor row —
 * `renderCapture` trims spaces and tabs and leaves that one alone, so the row
 * test has to accept it. The footer really is drawn twice, and the streaming
 * rows really are below the box.
 */
const TORN = [
  "  ⎿  Read packages/host/src/deliver.ts (898 lines)",
  "",
  "✻ Sautéed for 40s (esc to interrupt · ctrl+t to show todos)",
  "",
  "────────────────────────────────────────────────────────────",
  "❯\u00a0Yes all 3",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
  "  …/clear to save 102.6k tokens",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
  "  …/clear to save 102.6k tokens",
  "  ⏺ Update(packages/host/src/settle.ts)",
  "  ⎿  Updated packages/host/src/settle.ts with 14 additions",
  "     372    const info = sessions.get(sessionId);",
  "     373    const alive = info?.running === true;",
  "     374    const probe = echoProbe(text);",
  "  ⏺ Bash(npm run build:shared)",
  "  ⎿  > @waterplane/shared@0.0.0 build",
  "     > tsc -p tsconfig.json",
  "  ⏺ Read(packages/host/src/echo.ts)",
  "  ⎿  Read 375 lines",
  "✻ Sautéing… (esc to interrupt)",
];

test("the torn capture: the text IS in the box, however far the render has torn", () => {
  // The regression. Both questions must answer, because the delivery asks it
  // both ways: after our own write any frame will do, and before typing it is
  // a claim about the live box.
  assert.equal(composerEcho(TORN, "Yes all 3"), "exact");
  assert.equal(composerEcho(TORN, "Yes all 3", { newestOnly: true }), "exact");
});

test("…and the fixture really is outside the window that refused it", () => {
  // If the streaming rows ever get trimmed out of TORN, the test above stops
  // testing the bug it was written for.
  const [span] = composerSpans(TORN);
  assert.equal(composerText(span), "yesall3", "one frame, holding exactly the typed text");
  assert.ok(TORN.length - 1 - span.at > 11,
    `the hit sits ${TORN.length - 1 - span.at} rows up — the old rule accepted 11`);
});

test("a past user turn in the scrollback is NOT the composer", () => {
  // This CLI scrolls rather than repainting, so a prompt that RAN twenty
  // minutes ago is still on screen verbatim, rendered `> yes all 3`. Reading
  // that as the composer is how "press Return there, never retype it" gets
  // aimed at an empty box — which is why `COMPOSER_CURSOR_RE` is `❯` only.
  const rows = [
    "  ⏺ I'll do all three.",
    "> yes all 3",
    "  ⏺ Starting on the first one.",
    "────────────────────────────────────────────────────────────",
    "❯\u00a0",
    "────────────────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ];
  assert.equal(composerEcho(rows, "Yes all 3"), "none",
    "the box is right there and it is EMPTY — a `>` row may never stand in for it");
  assert.equal(composerEcho(rows, "Yes all 3", { newestOnly: true }), "none");
});

test("no box on the screen at all is `null` — the caller must fall back", () => {
  // `null` and `"none"` are different statements and callers keep them apart:
  // `null` is "this rule cannot speak about that screen", which is what an
  // upstream redraw we stop recognising must degrade to. Folding them together
  // turns every delivery into a gravestone.
  const rows = [
    "  ⏺ I'll do all three.",
    "> yes all 3",
    "  ⏺ Starting on the first one.",
  ];
  assert.equal(composerEcho(rows, "Yes all 3"), null);
  assert.equal(composerSpans(rows).length, 0);
});

test("a `❯` cursor with no rule above it is a picker, not a composer", () => {
  // The rule row above the cursor is load-bearing: the CLI draws `❯` as its
  // selection cursor inside dialogs too, and a dialog is not somewhere text
  // was typed.
  const rows = [
    "Do you want to proceed?",
    "❯ 1) Yes",
    "  2) No, and tell Claude what to do differently",
    "",
    "Enter to confirm · Esc to cancel",
  ];
  assert.equal(composerEcho(rows, "1) Yes"), null, "no frame here, so no opinion");
});

test("a long prompt wrapped over several rows is still one box holding one text", () => {
  const rows = [
    "  ⏺ ready when you are",
    "────────────────────────────────────────────────────────────",
    "❯\u00a0please rewrite the flaky retry test and",
    "  explain the fix properly",
    "────────────────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ];
  assert.equal(composerEcho(rows, "please rewrite the flaky retry test and explain the fix properly"), "exact",
    "the frame is joined before it is compared — a wrap is not a different prompt");
});

test("a collapsed paste inside the box is the paste rule, not a miss", () => {
  const text = ["line one of the instruction", "line two", "line three", "line four", "the final line"].join("\n");
  const rows = [
    "  ⏺ ready when you are",
    "────────────────────────────────────────────────────────────",
    "❯\u00a0[Pasted text #1 +3 lines]line four",
    "  the final line",
    "────────────────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ];
  assert.equal(composerEcho(rows, text), "paste",
    "the head is hidden behind the placeholder, so the tail is what ties it to this text");
});

test("only the head visible in the box is `head` — the weaker evidence, said so", () => {
  const rows = [
    "────────────────────────────────────────────────────────────",
    "❯\u00a0please rewrite the",
    "────────────────────────────────────────────────────────────",
  ];
  assert.equal(composerEcho(rows, A), "head",
    "fourteen characters is a prefix, and a prefix is what `echoAmbiguous` exists to police");
});

test("a stale EMPTY frame below the live one does not hide the live one", () => {
  // The other half of the tear: the replay can leave an older frame further
  // DOWN the buffer than the one that is live. Bottom-up scanning finds the
  // text wherever the repaint left it…
  const rows = [
    "────────────────────────────────────────────────────────────",
    "❯\u00a0Yes all 3",
    "────────────────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
    "  …/clear to save 102.6k tokens",
    "────────────────────────────────────────────────────────────",
    "❯\u00a0",
    "────────────────────────────────────────────────────────────",
  ];
  assert.equal(composerSpans(rows).length, 2, "two frames drawn, one of them stale");
  assert.equal(composerEcho(rows, "Yes all 3"), "exact");
  // …and `newestOnly` picks the bottom-most frame that is HOLDING something,
  // because an empty frame says nothing about which box is live.
  assert.equal(composerEcho(rows, "Yes all 3", { newestOnly: true }), "exact");
});

test("`newestOnly` is a claim about the LIVE box, and answers about that one only", () => {
  // The question asked BEFORE typing: "does this composer already hold my
  // text". Our words are in an older frame that has since been submitted; the
  // frame that is live holds somebody else's.
  const rows = [
    "────────────────────────────────────────────────────────────",
    "❯\u00a0please rewrite the flaky retry test and explain the fix",
    "────────────────────────────────────────────────────────────",
    "  ⏺ working on it",
    "────────────────────────────────────────────────────────────",
    "❯\u00a0a completely different instruction",
    "────────────────────────────────────────────────────────────",
  ];
  assert.equal(composerEcho(rows, A, { newestOnly: true }), "none",
    "the live box does not hold it, so nothing was already typed");
  assert.equal(composerEcho(rows, A), "exact", "…while the after-write question finds it either way");
});

/**
 * The composer is a VIEWPORT, and on a phone it is a small one.
 *
 * Measured against the 2.1.267 binary at 56 columns: a 632-character prompt
 * written into a live session draws 3 composer rows at a terminal height of 12,
 * 5 at 20, and all 14 at 40 — the box is sized off the terminal and the text
 * SCROLLS inside it. After a write the cursor is at the end, so what is drawn
 * is the tail and the head is off the top. Every screen rule above asks for the
 * head, and under 800 characters the CLI does not collapse the text either, so
 * the placeholder rule cannot speak about it: 45% of every delivery between 300
 * and 800 characters came back `unconfirmed` — the verdict that is never
 * auto-retried — with the prompt sitting in plain sight in the box.
 */
const LONG = "Can we have this run in the background automatically to bring the time"
  + " to a minimum that images take to show up in the gallery? If yes make this an"
  + " option in the user settings. Next independent request: I want to be able to"
  + " rotate more than one image at once with the already existing multi selection"
  + " option from the gallery. Spawn sub agents for implementation. Plan with opus.";

test("a composer scrolled past the head is the `scrolled` rule, not a miss", () => {
  // The box as the live capture drew it: the last rows of the prompt, wrapped,
  // with everything before them off the top of the viewport.
  const rows = [
    "  ⏺ ready when you are",
    "────────────────────────────────────────────────────────────",
    "❯ rotate more than one image at once with the already",
    "  existing multi selection option from the gallery. Spawn sub",
    "  agents for implementation. Plan with opus.",
    "────────────────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ];
  assert.equal(screenEcho(squash(rows.join("")), LONG), "none",
    "the head is nowhere on this screen — which is the whole reason the old rule missed it");
  assert.equal(composerEcho(rows, LONG), "scrolled",
    "everything the box is drawing is a window onto this text, and nothing else is");
});

test("the box may be scrolled to the HEAD as easily as to the tail", () => {
  // `settle.ts` asks the same question minutes later, and by then the box has
  // been scrolled wherever the user left it. The live capture that started this
  // showed the head of a 632-character prompt, hours after it was typed — so
  // the window is asked for as a substring, never as a suffix.
  const rows = [
    "────────────────────────────────────────────────────────────",
    "❯ Can we have this run in the background automatically to",
    "  bring the time to a minimum that images take to show up in",
    "  the gallery? If yes make this an option in the user",
    "────────────────────────────────────────────────────────────",
  ];
  assert.equal(composerEcho(rows, LONG), "scrolled",
    "a window that happens to start at the head is still a window, and it is more evidence than `head`");
});

test("a window shorter than `SLICE_MIN` is not an identification", () => {
  const rows = [
    "────────────────────────────────────────────────────────────",
    "❯ with opus.",
    "────────────────────────────────────────────────────────────",
  ];
  assert.equal(composerEcho(rows, LONG), "none",
    "ten characters of a common phrase is a coincidence, not a prompt");
});

test("the box holding a stranger's words is still `none`", () => {
  const rows = [
    "────────────────────────────────────────────────────────────",
    "❯ please rewrite the flaky retry test and explain the fix",
    "  properly, and then run the whole suite twice over",
    "────────────────────────────────────────────────────────────",
  ];
  assert.equal(composerEcho(rows, LONG), "none",
    "a viewport onto somebody else's prompt is not a viewport onto ours");
});

test("`scrolled` is confusable with a rival that holds the same window", () => {
  // Same policing as every other prefix rule: the match says "SOME text with
  // this window in it is in that box". A rival that also contains the window
  // would have produced it identically, and pressing Return on that is how a
  // turn runs somebody else's words under our `ok`.
  const overlapping = "Next independent request: I want to be able to"
    + " rotate more than one image at once with the already existing multi selection"
    + " option from the gallery — do that one first.";
  assert.equal(echoAmbiguous("scrolled", LONG, [overlapping]), true);
  assert.equal(echoAmbiguous("scrolled", LONG, ["a completely unrelated prompt about the build script"]), false,
    "sharing no window at all is not a rival");
  assert.equal(echoAmbiguous("scrolled", LONG, [LONG]), false,
    "our own words submitted are our own words — the standing exemption");
  assert.equal(echoAmbiguous("scrolled", LONG, []), false, "no rival, no ambiguity");
});
