// One wording for the always-on remedies: measure first, stop under the repo's own line, keep rules,
// move reference, propose and never commit.
import test from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_CLOCK, remedyPrompt } from "../dist/index.js";

const IDS = ["groom", "groom-global", "shrink-skill-descs", "other-agents", "dedupe-instructions"];

test("every remedy measures against the line it is given, never a literal", () => {
  for (const id of IDS) {
    const t = remedyPrompt(id, { warnChars: 23_456, warnSource: "repo" }).join("\n");
    assert.match(t, /23,456 characters, the line this repo set for itself/, id);
    assert.doesNotMatch(t, /12,000|16,000/, id);
  }
});

test("every remedy proposes and does not commit", () => {
  for (const id of IDS) {
    const t = remedyPrompt(id, { warnChars: 16_000 }).join("\n");
    assert.match(t, /do not commit/i, id);
  }
});

test("groom stops when under the line and keeps rules", () => {
  const t = remedyPrompt("groom", { warnChars: 16_000, out: ".claude/outbox" }).join("\n\n");
  assert.match(t, /change nothing/);
  assert.match(t, /stays/);
  assert.match(t, /\.claude\/outbox\/claudemd\.md/);
  assert.match(t, /Delete nothing/);
});

test("measured facts are quoted when present, and the default source says so", () => {
  const t = remedyPrompt("groom", { warnChars: 16_000, alwaysOnChars: 22_100, alwaysOnTokens: 5_525, claudeMdChars: 12_000, skillCount: 9 }).join("\n");
  assert.match(t, /22,100 characters always on/);
  assert.match(t, /shipped default/);
});

test("shrink lists the longest descriptions it was given, dedupe the repeats", () => {
  const s = remedyPrompt("shrink-skill-descs", { warnChars: 16_000, skills: [{ name: "host", descChars: 900 }] });
  assert.match(s.join("\n"), /host: 900 characters/);
  const d = remedyPrompt("dedupe-instructions", { warnChars: 16_000, overlaps: ["AGENTS.md repeats CLAUDE.md."] });
  assert.match(d.join("\n"), /AGENTS\.md repeats CLAUDE\.md\./);
});

test("the three clocks have distinct labels", () => {
  assert.equal(new Set(Object.values(CONTEXT_CLOCK)).size, 3);
});
