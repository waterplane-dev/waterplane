/** The efficiency-rules block: generic words and the write plan. node --test packages/shared/test/efficiencyrules.test.mjs (R-instructions-014) */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  BRAND, EFFICIENCY_END, EFFICIENCY_RULES, EFFICIENCY_RULES_VERSION, SHIPPED_EFFICIENCY_INSIDES,
  efficiencyBlock, efficiencyStart, efficiencyTargetOf, hasEfficiencyBlock, planEfficiencyWrite, readEfficiencyBlock,
} from "../dist/index.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("the rules are generic: no product name, route or environment variable", () => {
  const all = EFFICIENCY_RULES.map((r) => `${r.lead} ${r.body}`).join("\n");
  for (const name of [BRAND.displayName, BRAND.slug, ...BRAND.promptAliases]) {
    assert.ok(!all.toLowerCase().includes(String(name).toLowerCase()), `names ${name}`);
  }
  assert.doesNotMatch(all, /\/api\//);
  assert.doesNotMatch(all, /\$[A-Z_]{3,}|\b[A-Z]+_[A-Z_]+\b/);
  assert.doesNotMatch(all, /outbox|phone/i);
  assert.deepEqual(EFFICIENCY_RULES.map((r) => r.id), ["terse", "batch", "resumable", "subagents", "max-turns"]);
});

test("v1's shipped inside is frozen: changing the rules needs a new version", () => {
  // If this fails you changed EFFICIENCY_RULES: freeze the old inside as a literal under v1,
  // bump EFFICIENCY_RULES_VERSION, and add the new inside. Otherwise every repo's v1 block reads as hand-edited.
  assert.equal(EFFICIENCY_RULES_VERSION, 1);
  assert.equal(sha(SHIPPED_EFFICIENCY_INSIDES[1]), V1_SHA);
  assert.ok(efficiencyBlock().startsWith(efficiencyStart(1)));
  assert.ok(efficiencyBlock().endsWith(EFFICIENCY_END));
});
const V1_SHA = "95ce52b4069dfe5f797972402ae578ccdb761b93856c79b006148ad79c8a3c02";

test("no file: append and create", () => {
  const p = planEfficiencyWrite(null);
  assert.equal(p.kind, "append");
  assert.equal(p.created, true);
  assert.equal(p.next, `${efficiencyBlock()}\n`);
});

test("a file without the block: append at the end, a blank line between", () => {
  for (const [text, sep] of [["# Repo\n", "\n"], ["# Repo", "\n\n"], ["# Repo\n\n", ""], ["", ""]]) {
    const p = planEfficiencyWrite(text);
    assert.equal(p.kind, "append");
    assert.equal(p.created, false);
    assert.equal(p.next, `${text}${sep}${efficiencyBlock()}\n`);
    assert.ok(p.next.startsWith(text), "the person's words are kept as they were");
  }
});

test("CRLF files get a CRLF block, and read back as up to date", () => {
  const text = "# Repo\r\nrules\r\n";
  const p = planEfficiencyWrite(text);
  assert.equal(p.kind, "append");
  assert.ok(!/[^\r]\n/.test(p.next), "no bare LF in a CRLF file");
  assert.equal(planEfficiencyWrite(p.next).kind, "upToDate");
});

test("the current block, untouched: up to date, nothing to write", () => {
  const text = planEfficiencyWrite("# Repo\n").next;
  assert.deepEqual(planEfficiencyWrite(text), { kind: "upToDate" });
  assert.equal(hasEfficiencyBlock(text), true);
  assert.equal(hasEfficiencyBlock(null), false);
});

test("an edited block is refused with a sentence: typed words are never overwritten", () => {
  const text = planEfficiencyWrite("# Repo\n").next.replace("Keep output short.", "Keep output VERY short.");
  const p = planEfficiencyWrite(text);
  assert.equal(p.kind, "refuse");
  assert.match(p.why, /changed by hand/);
  assert.match(p.why, /delete the block/);
  // A single added space is an edit too.
  const t2 = planEfficiencyWrite("# Repo\n").next.replace("\n## Working", "\n ## Working");
  assert.equal(planEfficiencyWrite(t2).kind, "refuse");
});

test("an older shipped block, untouched, is replaced in place", (t) => {
  // Simulate a v0 the code once shipped: same plan rule, an older version number.
  const old = "\nold rules\n";
  const shipped = { ...SHIPPED_EFFICIENCY_INSIDES };
  SHIPPED_EFFICIENCY_INSIDES[0] = old;
  t.after(() => { delete SHIPPED_EFFICIENCY_INSIDES[0]; });
  const text = `# Repo\n\n${efficiencyStart(0)}${old}${EFFICIENCY_END}\n\nafter\n`;
  const p = planEfficiencyWrite(text);
  assert.equal(p.kind, "replace");
  assert.equal(p.from, 0);
  assert.equal(p.next, `# Repo\n\n${efficiencyBlock()}\n\nafter\n`);
  delete SHIPPED_EFFICIENCY_INSIDES[0];
  assert.deepEqual({ ...SHIPPED_EFFICIENCY_INSIDES }, shipped);
  // The same old block with one character changed is somebody's edit.
  SHIPPED_EFFICIENCY_INSIDES[0] = old;
  assert.equal(planEfficiencyWrite(text.replace("old rules", "old rules!")).kind, "refuse");
});

test("an older version whose inside is not what shipped is refused", () => {
  const text = `${efficiencyStart(0)}\nanything\n${EFFICIENCY_END}\n`;
  assert.equal(planEfficiencyWrite(text).kind, "refuse");
});

test("a newer version than this code knows is refused", () => {
  const text = `${efficiencyStart(EFFICIENCY_RULES_VERSION + 1)}${SHIPPED_EFFICIENCY_INSIDES[1]}${EFFICIENCY_END}\n`;
  const p = planEfficiencyWrite(text);
  assert.equal(p.kind, "refuse");
  assert.match(p.why, /newer/);
});

test("broken markers are refused, never guessed at", () => {
  const block = efficiencyBlock();
  for (const text of [
    `${block}\n${block}\n`,                                     // two blocks
    `${efficiencyStart(1)}\nno end\n`,                           // start alone
    `stray ${EFFICIENCY_END}\n`,                                 // end alone
    `${EFFICIENCY_END}\n${efficiencyStart(1)}\n`,                // reversed
    `<!-- efficiency-rules:start vX -->\n${EFFICIENCY_END}\n`,   // unreadable version
  ]) {
    const p = planEfficiencyWrite(text);
    assert.equal(p.kind, "refuse", text);
    assert.notEqual(readEfficiencyBlock(text).kind, "none");
  }
});

test("the suggested target is the file that exists, CLAUDE.md first", () => {
  assert.equal(efficiencyTargetOf({ "CLAUDE.md": true, "AGENTS.md": true }), "CLAUDE.md");
  assert.equal(efficiencyTargetOf({ "CLAUDE.md": false, "AGENTS.md": true }), "AGENTS.md");
  assert.equal(efficiencyTargetOf({ "CLAUDE.md": false, "AGENTS.md": false }), "CLAUDE.md");
});
