/**
 * The reader's scrape of the CLI's own working line.
 *
 * Every `tail` below is bytes a real `claude` printed, captured from a node-pty
 * at 46 columns (a phone) — including the partial redraws, because the tail the
 * reader scans is raw PTY output, not a rendered screen.
 *
 * This exists because the previous anchor ("esc to interrupt") was a string the
 * TUI stopped printing. Nothing failed: the reader simply showed "working ·
 * output appears here as claude writes it" for nine minutes while the terminal
 * two taps away counted seconds and tokens. A heuristic that silently stops
 * matching is invisible in review and invisible on screen — so the shape it
 * keys on is pinned here against real bytes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { scrollPanelOpen, workingLine } from "../dist/index.js";

const ESC = "";

test("the current TUI spinner, which carries no interrupt hint", () => {
  const w = workingLine("✽Bloviating… (2s · ↓125 tokens)\r\n");
  assert.equal(w.phrase, "Bloviating…");
  assert.equal(w.elapsed, "2s");
  assert.equal(w.tokens, "↓125 tokens");
  assert.equal(w.text, "Bloviating… · ↓125 tokens");
});

test("a multi-minute turn keeps its elapsed for the strip's fallback", () => {
  const w = workingLine("✳ Clauding… (9m 20s · ↓ 9.7k tokens)");
  assert.equal(w.elapsed, "9m 20s");
  assert.equal(w.tokens, "↓ 9.7k tokens");
});

test("the older hinted spinner still reads, minus the terminal affordance", () => {
  const w = workingLine("✻ Cogitating… (17s · ↑ 2.1k tokens · esc to interrupt)");
  assert.equal(w.phrase, "Cogitating…");
  assert.equal(w.text, "Cogitating… · ↑ 2.1k tokens");
});

test("what the parenthetical says beyond time and tokens is kept", () => {
  const w = workingLine("✢ Considering… (1s · ↓ 25 tokens · thinking)");
  assert.deepEqual(w.extra, ["thinking"]);
  assert.equal(w.text, "Considering… · ↓ 25 tokens · thinking");
});

test("ANSI and box-drawing are stripped, and the NEWEST line wins", () => {
  const tail =
    `${ESC}[2K✻ Vibing… (1s · ↑ 10 tokens)\r\n` +
    `│ ${ESC}[38;5;208m✽ Bloviating… (2s · ↓ 125 tokens)${ESC}[39m │\r\n`;
  assert.equal(workingLine(tail).phrase, "Bloviating…");
});

test("a truncated warning banner is not an activity", () => {
  // Real bytes, and the reason a bare ellipsis cannot be the anchor: rendering
  // this as "working on: inherited CL…" would be the app inventing a fact.
  assert.equal(workingLine("⚠ Transcript saving is off — inherited CL…"), null);
});

test("a bare gerund is a fallback, never preferred to a measured line", () => {
  // Both are real: the TUI repaints the phrase alone before the counter, and a
  // split redraw leaves the parenthetical on a line of its own.
  assert.equal(workingLine("Bloviating… \r\n↓ 25 tokens · thinking)").text, "Bloviating…");
  assert.equal(
    workingLine("✻ Vibing… (3s · ↑ 40 tokens)\r\nBloviating… ").tokens,
    "↑ 40 tokens",
  );
});

test("the finished line is not a working line", () => {
  assert.equal(workingLine("✻ Cooked for 2s"), null);
  assert.equal(workingLine("⏺ Bash(npm test)"), null);
});

test("absent, never wrong", () => {
  assert.equal(workingLine(undefined), null);
  assert.equal(workingLine(""), null);
  assert.equal(workingLine("❯ count slowly from 1 to 20"), null);
});

test("a scrollable panel is only open while the CLI is still drawing its footer", () => {
  // The reader hands you over to the terminal on the strength of this. Wrong in
  // one direction costs a button that was owed; wrong in the other sends you to
  // a terminal with nothing to scroll, so it reads the freshest bytes only.
  assert.equal(scrollPanelOpen("\x1b[2m  ↑/↓ to scroll · Esc to close\x1b[0m\r\n❯ "), true);
  // Painted over, and far enough back that the footer is history.
  assert.equal(scrollPanelOpen("  ↑/↓ to scroll · Esc to close\r\n" + "x".repeat(4000)), false);
  assert.equal(scrollPanelOpen("✻ Vibing… (3s · ↑ 40 tokens)"), false);
  assert.equal(scrollPanelOpen(undefined), false);
  assert.equal(scrollPanelOpen(""), false);
});

test("`/compact` says what it is doing with the object between the gerund and the ellipsis", () => {
  // The one activity that fires NO hook — no UserPromptSubmit, no Stop — and
  // runs for minutes. The host reads this line to know the CLI is busy at all,
  // so a session mid-compaction stops reading as "idle — nothing running".
  const w = workingLine(`${ESC}[2K  · Compacting conversation… (35s)\r`);
  assert.equal(w.phrase, "Compacting conversation…");
  assert.equal(w.elapsed, "35s");
});

test("...and that relaxed shape is refused without a measured parenthetical", () => {
  // Which is the whole reason it is conditional: the TUI truncates ordinary
  // prose with an ellipsis too, and a warning read as an activity is this app
  // inventing one.
  assert.equal(workingLine("⚠ Transcript saving is off — inherited CL…"), null);
  assert.equal(workingLine("… saving your work — inherited CL… (see above)"), null);
});

/**
 * **A compaction's first half-minute has no parenthetical at all.**
 *
 * Both shapes below are verbatim from this desktop's own turn captures
 * (`.myapp/history/*.json`). The parenthetical rule was written off the second
 * one, and the first is what the CLI draws when a compaction STARTS — which is
 * precisely the window `deliver.ts` watches for a submit proof. Reading it as
 * "nothing is running" made the reader say *idle* over a live compaction and
 * left a `/compact` that was visibly 15% done reported as "typed, but Return
 * was swallowed".
 */
test("a compaction is working before it has an elapsed to print", () => {
  const w = workingLine("Compacting conversation…\n  ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 2%\n  ⎿  Tip: Use ctrl+v to paste images");
  assert.equal(w?.phrase, "Compacting conversation…");
  assert.equal(w?.elapsed, null, "there is no elapsed yet — inventing one is the failure this file names");
  assert.deepEqual(w?.extra, ["2%"], "the percentage IS the measurement, so it is also what the reader shows");
});

test("…and keeps working once it has one", () => {
  const w = workingLine("✳ Compacting conversation… (32s)\n  ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 30%");
  assert.equal(w?.phrase, "Compacting conversation…");
  assert.equal(w?.elapsed, "32s");
});

test("a gerund with an object and NOTHING measured is still not an activity", () => {
  // The whole reason the relaxed form is gated. A truncation ellipsis is not a
  // spinner, and a box rule under one is not a progress bar — the line cleaner
  // turns rules into whitespace, which is why `─` is not in the glyph class.
  assert.equal(workingLine("Compacting conversation…"), null);
  assert.equal(workingLine("⚠ Transcript saving is off — inherited CL…"), null);
  assert.equal(workingLine("⚠ Transcript saving is off — inherited CL…\n ──────────────────────────"), null);
  assert.equal(workingLine("Reviewing the open changes…\n  ▰▰▰▰▰▰▰▰ nearly there"), null,
    "a bar with no percentage measures nothing");
});

test("an idle composer over background agents is not a working line — it must not set turnActive", () => {
  // `checkTurnWatch` sets `turnActive` from the SCREEN when this matches, and
  // `turnActive` holds the repo's `serial` group. When the main loop has ended
  // and only background agents run, the CLI hands the composer back and says
  // so in these words (`sessions/turn.ts`, `question.test.mjs`'s capture). If
  // any of them matched, the repo would read busy under a composer a person
  // can see is free. The agents are `info.agents`' business, not the turn's.
  const idleOverAgents = [
    "Waiting for 2 background agents to finish",
    "  ⎿  Waiting for 1 background agent to finish",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents",
    "  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)",
    "  ⎿  Running in the background (↓ to manage)",
    [
      "✻ Baked for 30s · done 2:28 PM",
      "",
      "──────────────────────────────",
      "❯ ",
      "──────────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents",
    ].join("\n"),
  ];
  for (const tail of idleOverAgents) assert.equal(workingLine(tail), null, tail);
});

test("the background-agent tray under an idle composer is not a turn — the repo must not read busy", () => {
  // Captured off the orchestrating session's grid on 2026-10-06: its main loop
  // had ended, it sat at the composer for ten minutes, and the tray row's
  // gerund ("Investigating…" et al.) matched the weak spinner shape, so the
  // host's screen watch set `turnActive` and the repo's serial group held an
  // agent-posted row the whole time.
  const idle = [
    "✻ Waiting for 1 background agent to finish",
    "",
    "──────────────────────────────────────────────────────────────────────",
    "❯ I fired it from the phone",
    "──────────────────────────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on · 1 shell · ← 3 agents",
    "",
    "  ⏺ main",
    "  ◯ general-purpose  Investigating… 11m 17s · ↓ 159.4k tokens",
    "  ◯ Explore  Searching… 2m 3s · ↓ 12k tokens",
  ].join("\n");
  assert.equal(workingLine(idle), null);
  // Each shape alone: the glyph+column row, and the unparenthesised stats.
  assert.equal(workingLine("  ◯ general-purpose  Investigating…"), null);
  assert.equal(workingLine("  Reviewing… 4m 2s · ↓ 30.1k tokens"), null);
  // …and a REAL turn above the tray is still read, tray or no tray.
  const working = idle.replace("✻ Waiting for 1 background agent to finish", "✻ Clauding… (9m 20s · ↓ 9.7k tokens)");
  assert.equal(workingLine(working)?.phrase, "Clauding…");
  assert.equal(workingLine(working)?.tokens, "↓ 9.7k tokens");
});
