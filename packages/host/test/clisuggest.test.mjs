/**
 * The CLI's own next-prompt proposal (`clisuggest.ts`): the dim words claude
 * draws in an EMPTY composer after a turn, the ones Tab accepts.
 *
 * The rows are a real `tmux capture-pane -p` off 2.1.x (the composer of a
 * finished turn); with `-e` the proposal is `❯ \e[2mwatch CI…\e[0m`, the whole
 * proposal dim — so the "undimmed" grid is the same rows with it blanked.
 *
 * The false-positive half matters as much as the hit: typed words survive the
 * dim blanking, and claude's generic `Try "…"` example is dim too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cliSuggestionOf, composerPlain, CLI_SUGGESTION_MAX } from "../dist/clisuggest.js";

const RULE = "─".repeat(58);
const grid = (composer) => [
  "",
  "✻ Crunched for 40s · done 8:44 PM",
  "",
  RULE,
  composer,
  RULE,
  "  [CAVEMAN]",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents",
];

test("a dim proposal in an empty composer is published verbatim", () => {
  const plain = grid("❯ watch CI and report when it finishes");
  const undimmed = grid("❯");
  assert.equal(composerPlain(plain), "watch CI and report when it finishes");
  assert.equal(cliSuggestionOf(plain, undimmed), "watch CI and report when it finishes");
});

test("typed words are never a proposal", () => {
  const typed = grid("❯ watch CI and report when it finishes");
  assert.equal(cliSuggestionOf(typed, typed), null);
});

test("an empty composer proposes nothing", () => {
  const empty = grid("❯");
  assert.equal(composerPlain(empty), null);
  assert.equal(cliSuggestionOf(empty, empty), null);
});

test("claude's generic first-run example is not a proposal", () => {
  assert.equal(cliSuggestionOf(grid('❯ Try "how does <filepath> work?"'), grid("❯")), null);
});

test("no composer in the dim-blanked read proves nothing", () => {
  assert.equal(cliSuggestionOf(grid("❯ push it"), ["", "✻ Working…"]), null);
});

test("a screen with no composer at all is null, not a guess", () => {
  const prose = ["Pushed: main now matches GitHub", "", "❯ 1. Yes", "  2. No"];
  assert.equal(cliSuggestionOf(prose, prose), null);
});

test("an over-long read is refused, never published as one tap", () => {
  const long = "x".repeat(CLI_SUGGESTION_MAX + 1);
  assert.equal(cliSuggestionOf(grid(`❯ ${long}`), grid("❯")), null);
});
