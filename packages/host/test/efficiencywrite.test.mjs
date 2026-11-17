/**
 * The efficiency-rules write into a repo's own instruction file (R-instructions-014): containment,
 * the refusal on an edited block, the mode kept, no second instruction file, the stale check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const { efficiencyFact, efficiencyState, writeEfficiencyRules } = await import("../dist/efficiencywrite.js");
const { efficiencyBlock } = await import("@waterplane/shared");

const sha = (s) => createHash("sha256").update(s).digest("hex");
const repo = () => mkdtempSync(join(tmpdir(), "wp-eff-"));
const stateOf = (wt, t) => efficiencyState(wt).targets.find((x) => x.target === t);

test("appends to an existing CLAUDE.md, keeps its mode, leaves no tmp file", () => {
  const wt = repo();
  writeFileSync(join(wt, "CLAUDE.md"), "# Mine\n");
  chmodSync(join(wt, "CLAUDE.md"), 0o640);
  const s = stateOf(wt, "CLAUDE.md");
  assert.equal(s.plan, "append");
  const r = writeEfficiencyRules(wt, "CLAUDE.md", s.sha);
  assert.deepEqual(r, { ok: true, written: true, plan: "append", created: false });
  const body = readFileSync(join(wt, "CLAUDE.md"), "utf8");
  assert.ok(body.startsWith("# Mine\n"));
  assert.ok(body.includes(efficiencyBlock()));
  assert.equal(statSync(join(wt, "CLAUDE.md")).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(wt), ["CLAUDE.md"]);
  assert.equal(stateOf(wt, "CLAUDE.md").plan, "upToDate");
  assert.deepEqual(efficiencyFact(wt), { present: true, target: "CLAUDE.md" });
  // A second write is a no-op, not a second block.
  const again = writeEfficiencyRules(wt, "CLAUDE.md", stateOf(wt, "CLAUDE.md").sha);
  assert.deepEqual(again, { ok: true, written: false, plan: "upToDate" });
  assert.equal(readFileSync(join(wt, "CLAUDE.md"), "utf8"), body);
});

test("an edited block is refused and the file is left byte for byte", () => {
  const wt = repo();
  const edited = `# Mine\n\n${efficiencyBlock().replace("Keep output short.", "Keep output short, please.")}\n`;
  writeFileSync(join(wt, "CLAUDE.md"), edited);
  const s = stateOf(wt, "CLAUDE.md");
  assert.equal(s.plan, "refuse");
  assert.match(s.why, /changed by hand/);
  const r = writeEfficiencyRules(wt, "CLAUDE.md", s.sha);
  assert.equal(r.ok, false);
  assert.equal(r.code, "refused");
  assert.equal(readFileSync(join(wt, "CLAUDE.md"), "utf8"), edited);
  // The person still carries the rules: the finding does not nag.
  assert.equal(efficiencyFact(wt).present, true);
});

test("a file changed since the screen was drawn is stale: nothing is written", () => {
  const wt = repo();
  writeFileSync(join(wt, "CLAUDE.md"), "# Mine\n");
  const s = stateOf(wt, "CLAUDE.md");
  writeFileSync(join(wt, "CLAUDE.md"), "# Mine, edited by an agent\n");
  const r = writeEfficiencyRules(wt, "CLAUDE.md", s.sha);
  assert.equal(r.code, "stale");
  assert.equal(readFileSync(join(wt, "CLAUDE.md"), "utf8"), "# Mine, edited by an agent\n");
  assert.equal(writeEfficiencyRules(wt, "CLAUDE.md", undefined).code, "stale");
});

test("never creates a second instruction file beside an existing one", () => {
  const wt = repo();
  writeFileSync(join(wt, "AGENTS.md"), "# Agents\n");
  const s = stateOf(wt, "CLAUDE.md");
  assert.equal(s.plan, "refuse");
  assert.match(s.why, /AGENTS\.md/);
  assert.equal(writeEfficiencyRules(wt, "CLAUDE.md", "").code, "refused");
  assert.deepEqual(readdirSync(wt), ["AGENTS.md"]);
  assert.equal(efficiencyState(wt).suggested, "AGENTS.md");
  assert.deepEqual(efficiencyFact(wt), { present: false, target: "AGENTS.md" });
});

test("creates CLAUDE.md when the repo has no instruction file", () => {
  const wt = repo();
  const s = stateOf(wt, "CLAUDE.md");
  assert.equal(s.exists, false);
  assert.equal(s.sha, "");
  const r = writeEfficiencyRules(wt, "CLAUDE.md", "");
  assert.equal(r.created, true);
  assert.equal(readFileSync(join(wt, "CLAUDE.md"), "utf8"), `${efficiencyBlock()}\n`);
});

test("containment: a link out of the worktree, and a link at all, are refused", () => {
  const wt = repo();
  const outside = mkdtempSync(join(tmpdir(), "wp-eff-out-"));
  writeFileSync(join(outside, "CLAUDE.md"), "# Not yours\n");
  symlinkSync(join(outside, "CLAUDE.md"), join(wt, "CLAUDE.md"));
  const s = stateOf(wt, "CLAUDE.md");
  assert.equal(s.plan, "refuse");
  assert.match(s.why, /outside this worktree/);
  assert.equal(writeEfficiencyRules(wt, "CLAUDE.md", sha("# Not yours\n")).code, "refused");
  assert.equal(readFileSync(join(outside, "CLAUDE.md"), "utf8"), "# Not yours\n");

  // An in-repo link (AGENTS.md -> CLAUDE.md) is refused too: a rename would replace the link.
  const wt2 = repo();
  writeFileSync(join(wt2, "CLAUDE.md"), "# Mine\n");
  symlinkSync("CLAUDE.md", join(wt2, "AGENTS.md"));
  const a = stateOf(wt2, "AGENTS.md");
  assert.equal(a.plan, "refuse");
  assert.match(a.why, /link/);
  assert.equal(writeEfficiencyRules(wt2, "AGENTS.md", sha("# Mine\n")).code, "refused");
  assert.equal(readFileSync(join(wt2, "CLAUDE.md"), "utf8"), "# Mine\n");
});

test("a directory where the file should be is refused", () => {
  const wt = repo();
  mkdirSync(join(wt, "CLAUDE.md"));
  assert.equal(stateOf(wt, "CLAUDE.md").plan, "refuse");
});

test("a CLAUDE.md that links to AGENTS.md suggests AGENTS.md, the file that can take the write", () => {
  const wt = repo();
  writeFileSync(join(wt, "AGENTS.md"), "# a\n");
  symlinkSync("AGENTS.md", join(wt, "CLAUDE.md"));
  assert.equal(efficiencyState(wt).suggested, "AGENTS.md");
});

test("a file that is not valid UTF-8 is refused, never rewritten with replacement characters", () => {
  const wt = repo();
  writeFileSync(join(wt, "CLAUDE.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  const s = stateOf(wt, "CLAUDE.md");
  assert.equal(s.plan, "refuse");
  const r = writeEfficiencyRules(wt, "CLAUDE.md", s.sha);
  assert.equal(r.ok, false);
  assert.deepEqual([...readFileSync(join(wt, "CLAUDE.md"))], [0x23, 0x20, 0xff, 0xfe, 0x0a]);
});

test(".claude/CLAUDE.md counts: no second instruction file beside it, and a block in it is seen", () => {
  const wt = repo();
  mkdirSync(join(wt, ".claude"));
  writeFileSync(join(wt, ".claude", "CLAUDE.md"), "# nested\n");
  assert.equal(stateOf(wt, "CLAUDE.md").plan, "refuse");
  assert.equal(efficiencyState(wt).present, false);
  writeFileSync(join(wt, ".claude", "CLAUDE.md"), `# nested\n${efficiencyBlock()}`);
  assert.equal(efficiencyState(wt).present, true);
});
