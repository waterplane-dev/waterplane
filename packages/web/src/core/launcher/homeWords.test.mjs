import { test } from "node:test";
import assert from "node:assert/strict";
import { capFirst, counted, gitWords, newFilesWords, questionsWords, setupLine } from "./homeWords.ts";

const NOW = 1_800_000_000_000;

test("every count carries its noun, singular at one (spec D2)", () => {
  assert.equal(newFilesWords(1), "1 modified file");
  assert.equal(newFilesWords(6), "6 modified files");
  assert.equal(questionsWords(2), "2 questions");
  assert.equal(counted(1, "branch copy", "branch copies"), "1 branch copy");
});

test("the git badge words what waits, and is empty when nothing does", () => {
  assert.equal(gitWords({ changedCount: 2, ahead: 1, behind: 0, fetchedAt: NOW }, NOW), "2 to commit · 1 to push");
  assert.equal(gitWords({ changedCount: 0, ahead: 0, behind: 3, fetchedAt: NOW }, NOW), "3 to pull");
  assert.equal(gitWords({ changedCount: 0 }, NOW), "");
  // A zero nobody fetched says nothing (never "0 to pull", never "? to pull").
  assert.equal(gitWords({ changedCount: 0, behind: 0 }, NOW), "");
});

test("the setup line says the screen's title first, the findings after", () => {
  assert.equal(setupLine(undefined), "Setup & health");
  assert.equal(setupLine({ issues: 0 }), "Setup & health");
  assert.equal(setupLine({ issues: 3 }), "Setup & health · 3 to fix");
});

test("an extension's label reads as a menu line", () => {
  assert.equal(capFirst("permission rules"), "Permission rules");
  assert.equal(capFirst("Vault: this repo"), "Vault: this repo");
  assert.equal(capFirst(""), "");
});
