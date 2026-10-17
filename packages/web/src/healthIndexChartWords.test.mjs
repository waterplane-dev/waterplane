/** The Score card's short words, pure (`node --test`). */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BAR_DOWN_WORDS, BAR_UP_WORDS, FIRST_SCORED_WEEK_WORDS, HOW_SCORED_SUMMARY, OUT_OF_100,
  COMMIT_GAP_NOTE, carriedNoMovesWords, commitGapWords, commitSpendClause, heldDownWords, scoreChartAria, spendStepNote,
} from "./healthIndexChartWords.ts";

test("the cap is one line, only when the score is capped", () => {
  assert.equal(heldDownWords({ value: 46, mean: 66, cappedBy: "size" }), "held down by file length, at 16 of 100");
  assert.equal(heldDownWords({ value: 70, mean: 70, cappedBy: "size" }), null, "not under the mean: not capped");
  assert.equal(heldDownWords({ value: 40, mean: 66, cappedBy: null }), null);
});

test("readout and aria words", () => {
  assert.equal(commitSpendClause("84k tokens per Claude request", true), "84k tokens per Claude request that week");
  assert.equal(commitSpendClause("no Claude request on record", false), "no Claude request on record");
  assert.equal(scoreChartAria("weeks", 35, 46.2, 100), "Health score over 35 weeks, from 46 to 100, on a 0 to 100 axis");
  assert.equal(scoreChartAria("commits", 1, 50, 50), "Health score over 1 commit, from 50 to 50, on a 0 to 100 axis");
  assert.equal(carriedNoMovesWords("move not compared with the week before"), "Move not compared with the week before; there are no moves to show.");
});

test("no verdict words (the index's ban)", () => {
  const all = [
    OUT_OF_100, HOW_SCORED_SUMMARY, BAR_UP_WORDS, BAR_DOWN_WORDS, FIRST_SCORED_WEEK_WORDS,
    heldDownWords({ value: 46, mean: 66, cappedBy: "context" }), carriedNoMovesWords("x"),
    scoreChartAria("commits", 3, 1, 2), spendStepNote("x"), commitGapWords(1), commitGapWords(4), COMMIT_GAP_NOTE,
  ].join("\n");
  assert.equal(commitGapWords(0), null);
  for (const word of ["grade", "healthy", "unhealthy", "bad", "should", "worse", "better"]) {
    assert.doesNotMatch(all, new RegExp(`\\b${word}\\b`, "i"), word);
  }
});
