/**
 * Ask rules on the phone, the pure half.
 *
 *     node --test packages/web/src/askRules.test.mjs
 *
 * What is pinned: a typed rule is refused IN WORDS (never silently repaired), the
 * suggested rules are added exactly as the missing ones and only by a call, a per-repo
 * off/on touches that one rule and that one path, and the save receipt says that a
 * running session keeps the rules it launched with.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ASK_RULES_MAX, cleanAskRules } from "@waterplane/shared";
import {
  addRefusal, hereWords, isOffIn, lostWords, missingSuggested, offInWords, putBody, repoLabel, savedReceipt,
  suggestedAddable, withOffIn, withoutRule, withRule, withSuggested,
} from "./askRules.ts";

const R = (rule, extra = {}) => ({ id: `id-${rule.length}-${rule.slice(5, 9)}`, rule, ...extra });

test("a typed rule is refused in words, never repaired", () => {
  assert.match(addRefusal([], "   "), /Type a rule first/);
  assert.match(addRefusal([], "git push origin main"), /not a permission rule/);
  assert.match(addRefusal([], "x".repeat(300)), /at most 200 characters/);
  assert.match(addRefusal([R("Bash(npm publish*)")], " Bash(npm publish*) "), /already on the list/);
  assert.equal(addRefusal([], " Bash(git push * main) "), null);
  // A refused rule leaves the list as it was.
  assert.deepEqual(withRule([], "nope nope"), []);
});

test("withRule trims and appends with an id the list does not hold", () => {
  const one = withRule([], "  Bash(git push * main) ");
  assert.equal(one.length, 1);
  assert.equal(one[0].rule, "Bash(git push * main)");
  assert.match(one[0].id, /^[A-Za-z0-9_-]{1,64}$/);
  // The host keeps a repeated id's FIRST row only — so a clash must never be sent.
  const clash = withRule([{ id: one[0].id, rule: "Bash(other)" }], "Bash(git push * main)");
  assert.notEqual(clash[1].id, clash[0].id);
  assert.equal(cleanAskRules(putBody(clash)).rules.length, 2);
});

test("the cap is a sentence", () => {
  const full = Array.from({ length: ASK_RULES_MAX }, (_, i) => ({ id: `r${i}`, rule: `Bash(cmd${i})` }));
  assert.match(addRefusal(full, "Bash(one more)"), /at most 64 rules/);
});

test("the suggested rules: exactly the missing ones, in order, only on a call", () => {
  const suggested = ["Bash(a*)", "Bash(b*)", "Bash(c*)"];
  const have = [R("Bash(b*)"), R("Bash(mine)")];
  assert.deepEqual(missingSuggested(have, suggested), ["Bash(a*)", "Bash(c*)"]);
  const next = withSuggested(have, suggested);
  assert.deepEqual(next.map((r) => r.rule), ["Bash(b*)", "Bash(mine)", "Bash(a*)", "Bash(c*)"]);
  // The rows already there are untouched (their offIn survives).
  const off = [R("Bash(b*)", { offIn: ["/r"] })];
  assert.deepEqual(withSuggested(off, suggested)[0].offIn, ["/r"]);
  assert.equal(suggestedAddable(have, suggested), 2);
  assert.deepEqual(missingSuggested(next, suggested), []);
});

test("the cap cuts what one tap adds, and the count says so", () => {
  const nearly = Array.from({ length: ASK_RULES_MAX - 1 }, (_, i) => ({ id: `r${i}`, rule: `Bash(cmd${i})` }));
  assert.equal(suggestedAddable(nearly, ["Bash(a*)", "Bash(b*)"]), 1);
});

test("off here touches one rule and one path", () => {
  const rules = [R("Bash(git push * main)"), R("Bash(npm publish*)", { offIn: ["/other"] })];
  const a = withOffIn(rules, rules[0].id, "/repo", true);
  assert.equal(isOffIn(a[0], "/repo"), true);
  assert.equal(isOffIn(a[1], "/repo"), false);
  assert.deepEqual(a[1].offIn, ["/other"]);
  // Twice off is still one entry; back on removes the key when nothing is left.
  const twice = withOffIn(a, rules[0].id, "/repo", true);
  assert.deepEqual(twice[0].offIn, ["/repo"]);
  const back = withOffIn(twice, rules[0].id, "/repo", false);
  assert.equal("offIn" in back[0], false);
  // The original is not mutated.
  assert.equal(rules[0].offIn, undefined);
});

test("removing a rule removes only that rule", () => {
  const rules = [R("Bash(a*)"), R("Bash(bb*)")];
  assert.deepEqual(withoutRule(rules, rules[0].id).map((r) => r.rule), ["Bash(bb*)"]);
});

test("words: where a rule is off, and how many ask here", () => {
  const repos = [
    { worktreePath: "/code/app", repoName: "app", branch: "main", isPrimary: true },
    { worktreePath: "/code/app-wt", repoName: "app", branch: "feature", isPrimary: false },
  ];
  assert.equal(repoLabel("/code/app", repos), "app");
  assert.equal(repoLabel("/code/app-wt", repos), "app (feature)");
  assert.equal(repoLabel("/gone/elsewhere/", repos), "elsewhere");
  assert.equal(offInWords(R("Bash(a*)"), repos), null);
  assert.equal(offInWords(R("Bash(a*)", { offIn: ["/code/app", "/x/y"] }), repos), "off in app, y");
  assert.match(hereWords([], "/code/app"), /Settings › Sessions › ask before/);
  const rules = [R("Bash(a*)", { offIn: ["/code/app"] }), R("Bash(bb*)")];
  assert.equal(hereWords(rules, "/code/app"), "1 of 2 ask here; 1 switched off in this repo.");
  assert.equal(hereWords(rules, "/code/other"), "All 2 ask here.");
});

test("the save receipt says a running session keeps its rules", () => {
  assert.match(savedReceipt(), /running session keeps the rules it launched with/);
  assert.doesNotMatch(savedReceipt(0), /dropped/);
  assert.match(savedReceipt(2), /dropped 2/);
});

test("the PUT body is what the host's strict cleaner keeps whole", () => {
  const rules = withOffIn(withRule(withRule([], "Bash(a*)"), "Bash(bb*)"), "", "/x", true);
  const body = putBody(withOffIn(rules, rules[1].id, "/code/app", true));
  assert.deepEqual(cleanAskRules(body), body);
});

test("lostWords: a list the desktop could not read is said, never shown as no rules", () => {
  assert.equal(lostWords(undefined), null);
  const w = lostWords({ movedTo: "/s/askrules.json.corrupt-x", error: "Unexpected token" });
  assert.match(w, /ran with none/);
  assert.match(w, /askrules\.json\.corrupt-x/);
  assert.doesNotMatch(lostWords({ movedTo: null, error: "EACCES" }), /kept as/);
});
