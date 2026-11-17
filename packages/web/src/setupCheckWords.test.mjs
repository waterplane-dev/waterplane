import { test } from "node:test";
import assert from "node:assert/strict";
import { repoCutWords, repoRowWords, cutBarWords, doorOffered, evidenceLabel, installHead, notCheckedHead, passedHead, savingLine, waivedHead, writePlanWords } from "./setupCheckWords.ts";

test("the saving line says what it rests on and labels an estimate", () => {
  const s = { usd: 4.1, tokens: 1_200_000, per: "week", basis: "estimate", errs: "low", sessions: 31, repos: 4 };
  const t = savingLine(s, "subscription");
  assert.match(t, /≈\$4\.1/);
  assert.match(t, /not a bill/);
  assert.match(t, /31 sessions in 4 repos/);
  assert.equal(savingLine(undefined), "");
  assert.equal(savingLine({ per: "week", basis: "estimate", errs: "low" }), "");
});

test("the folds name their counts", () => {
  assert.equal(installHead(2), "waterplane install · 2");
  assert.equal(waivedHead(1), "waived · 1");
  assert.match(passedHead(3), /3/);
  assert.match(notCheckedHead(4), /not checked · 4/);
  assert.equal(cutBarWords(2, 5), "2 of 5 shown — only what the badge counts");
});

test("a write plan says what the tap does, with the count", () => {
  assert.equal(writePlanWords("append", "CLAUDE.md", 14), "append to CLAUDE.md, 14 lines");
  assert.match(writePlanWords("replace", "AGENTS.md", 14), /replace the older block/);
  assert.equal(writePlanWords("refuse", "CLAUDE.md", 14, "left alone because"), "left alone because");
});

test("a door is drawn only where this build can land; permissions waits for its cut", () => {
  assert.equal(doorOffered({ screen: "permissions", ruleKeys: [] }), false);
  assert.equal(doorOffered({ screen: "permissions", ruleKeys: [] }, true), true);
  assert.equal(doorOffered({ screen: "tokens", box: "cold" }), true);
  assert.equal(evidenceLabel({ screen: "skills", ids: [] }), "skills & plugins");
});

test("the all-repos bar reads as a sentence and says plainly when it hides nothing", () => {
  const w = "The instruction file does not carry the efficiency rules.";
  assert.equal(repoCutWords(35, 35, w), w);
  assert.equal(repoCutWords(3, 35, w), "3 of 35 repos · only repos where the instruction file does not carry the efficiency rules");
  assert.equal(repoCutWords(3, 35, "exposure watch"), "3 of 35 repos · only repos with an open exposure watch finding");
  assert.equal(repoRowWords("", 1), "");
  assert.equal(repoRowWords("", 4), "4 findings");
  assert.equal(repoRowWords("5k tokens a week", 4), "5k tokens a week");
});
