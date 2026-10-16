// Ask rules (`shared/src/askrules.ts`, docs/plans/agent-authority.md §2): what the host may
// hand a claude launch as `permissions.ask`. Strict on the way in — a row that does not look
// like a permission rule is dropped, never repaired.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanAskRules, cleanAskRule, askRulesFor, askRuleId, askRulesHonoured,
  SUGGESTED_ASK_RULES, ASK_RULES_MAX, ASK_RULE_MAX_CHARS,
} from "../dist/index.js";

test("a permission rule is Tool(spec) or a bare tool name", () => {
  assert.equal(cleanAskRule("Bash(git push * main)"), "Bash(git push * main)");
  assert.equal(cleanAskRule("  WebFetch  "), "WebFetch");
  assert.equal(cleanAskRule("mcp__github__create_pull_request"), "mcp__github__create_pull_request");
  for (const bad of ["", "git push", "Bash(", "Bash()", "(x)", "Bash(a)\nBash(b)", "Bash(a\u0007)", 42, null,
    `Bash(${"x".repeat(ASK_RULE_MAX_CHARS)})`]) {
    assert.equal(cleanAskRule(bad), null, String(bad));
  }
});

test("clean drops invalid rows, dedupes by rule and id, keeps offIn paths only", () => {
  const doc = cleanAskRules({
    rules: [
      { id: "a", rule: "Bash(npm publish*)", offIn: ["/r/one", "/r/one", "relative", 7, "/r/two"] },
      { id: "b", rule: "Bash(npm publish*)" },
      { id: "a", rule: "Bash(fly deploy*)" },
      { id: "c", rule: "not a rule" },
      { id: "bad id!", rule: "Bash(gh pr merge*)" },
      "Bash(terraform apply*)",
      42,
    ],
  });
  assert.deepEqual(doc.rules, [
    { id: "a", rule: "Bash(npm publish*)", offIn: ["/r/one", "/r/two"] },
    { id: askRuleId("Bash(gh pr merge*)"), rule: "Bash(gh pr merge*)" },
    { id: askRuleId("Bash(terraform apply*)"), rule: "Bash(terraform apply*)" },
  ]);
  assert.deepEqual(cleanAskRules(null), { rules: [] });
  assert.deepEqual(cleanAskRules("Bash(x)"), { rules: [] });
  assert.equal(cleanAskRules(["Bash(x)"]).rules.length, 1, "a bare array is the list");
});

test("the count is capped", () => {
  const many = Array.from({ length: ASK_RULES_MAX + 10 }, (_, i) => `Bash(cmd${i} *)`);
  assert.equal(cleanAskRules({ rules: many }).rules.length, ASK_RULES_MAX);
});

test("askRulesFor leaves out the rules switched off for that repo", () => {
  const doc = cleanAskRules({ rules: [
    { id: "main", rule: "Bash(git push * main)", offIn: ["/dev/repo"] },
    { id: "pub", rule: "Bash(npm publish*)" },
  ] });
  assert.deepEqual(askRulesFor(doc, "/dev/repo"), ["Bash(npm publish*)"]);
  assert.deepEqual(askRulesFor(doc, "/dev/other"), ["Bash(git push * main)", "Bash(npm publish*)"]);
  assert.deepEqual(askRulesFor({ rules: [] }, "/x"), []);
});

test("the suggested list is the plan's eighteen, each a valid rule", () => {
  assert.equal(SUGGESTED_ASK_RULES.length, 18);
  for (const r of SUGGESTED_ASK_RULES) assert.equal(cleanAskRule(r), r);
  assert.ok(SUGGESTED_ASK_RULES.includes("Bash(git push * main)"));
});

test("only the claude CLI backends honour ask rules", () => {
  assert.equal(askRulesHonoured(undefined), true);
  assert.equal(askRulesHonoured("claude"), true);
  assert.equal(askRulesHonoured("claude-endpoint"), true);
  assert.equal(askRulesHonoured("another-backend"), false);
  assert.equal(askRulesHonoured("shell"), false);
});
