/**
 * Who reads which instruction file, and when — one inventory for the host's context-weight row
 * and the VS Code extension. The case this exists for: a repo that moved from Copilot to Claude
 * Code, copied AGENTS.md into a new CLAUDE.md, and now sends the same lines twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { claudeWeightInput, copilotWeightWords, instructionInventory, instructionTotals, overlapWords, sharedChars } from "../dist/index.js";

/** A folder as a map of relative path → text. */
function fsOf(files) {
  return {
    read: (rel) => (rel in files ? files[rel] : null),
    list: (dir) => {
      const names = new Map();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(`${dir}/`)) continue;
        const rest = p.slice(dir.length + 1).split("/");
        names.set(rest[0], rest.length > 1);
      }
      return [...names].map(([name, isDir]) => ({ name, dir: isDir }));
    },
  };
}

const body = Array.from({ length: 12 }, (_, i) => `- Rule number ${i}: always run the tests before committing.`).join("\n");

test("AGENTS.md is Copilot's alone, unless CLAUDE.md imports it", () => {
  const solo = instructionInventory(fsOf({ "AGENTS.md": "x".repeat(400) }));
  assert.equal(instructionTotals(solo.files, "copilot").always, 400);
  assert.equal(instructionTotals(solo.files, "claude").files, 0);
  const imp = instructionInventory(fsOf({ "AGENTS.md": "x".repeat(400), "CLAUDE.md": "@AGENTS.md\n" }));
  assert.equal(claudeWeightInput(imp.files).claudeMdChars, 400 + "@AGENTS.md\n".length);
});

test("a CLAUDE.md copied from AGENTS.md is a repeat Copilot carries; an import is not", () => {
  const copied = instructionInventory(fsOf({ "AGENTS.md": body, "CLAUDE.md": `# Claude\n${body}\n` }));
  assert.equal(copied.overlaps.length, 1);
  assert.deepEqual(copied.overlaps[0].readers, ["copilot"]);
  assert.match(overlapWords(copied.overlaps[0]), /CLAUDE\.md and AGENTS\.md repeat \d+ characters .* Copilot carries both .* @AGENTS\.md/);
  assert.deepEqual(instructionInventory(fsOf({ "AGENTS.md": body, "CLAUDE.md": "@AGENTS.md\n" })).overlaps, []);
  const both = instructionInventory(fsOf({ "AGENTS.md": body, "CLAUDE.md": `@AGENTS.md\n${body}\n` }));
  assert.deepEqual(both.overlaps[0].readers, ["claude", "copilot"]);
});

test("a Copilot setting turned off drops Copilot and says which", () => {
  const inv = instructionInventory(fsOf({ "CLAUDE.md": "z".repeat(50) }), { claudeMd: false });
  assert.deepEqual(inv.files[0].parts[0].readers, ["claude"]);
  assert.equal(inv.files[0].off, "chat.useClaudeMdFile");
});

test("skills: .claude/skills feed Claude's weighContext input, .github/skills only Copilot's total", () => {
  const skill = "---\nname: s\ndescription: does a thing\n---\nlong body";
  const inv = instructionInventory(fsOf({ ".claude/skills/c/SKILL.md": skill, ".github/skills/g/SKILL.md": skill }));
  const input = claudeWeightInput(inv.files);
  assert.deepEqual(input.skills, [{ name: "c", descChars: "does a thing".length, bodyChars: skill.length }]);
  assert.equal(input.claudeMdChars, 0);
  assert.equal(instructionTotals(inv.files, "copilot").always, 2 * "does a thing".length);
});

test("nested instruction files are walked, scoped by applyTo", () => {
  const inv = instructionInventory(fsOf({ ".github/instructions/api/ts.instructions.md": "---\napplyTo: \"src/**/*.ts\"\n---\nbody" }));
  assert.deepEqual(inv.files[0].parts[0].when, { kind: "scoped", globs: ["src/**/*.ts"] });
  assert.equal(inv.files[0].path, ".github/instructions/api/ts.instructions.md");
});

test("short shared lines are not a repeat", () => {
  assert.equal(sharedChars("# Rules\n\n- yes\n", "# Rules\n\n- yes\n"), 0);
});

test("a Claude-only repo is not weighed for Copilot; one Copilot file brings CLAUDE.md into Copilot's count", () => {
  const claudeOnly = instructionInventory(fsOf({ "CLAUDE.md": "z".repeat(50), ".claude/skills/c/SKILL.md": "---\ndescription: d\n---\nb" }));
  assert.equal(instructionTotals(claudeOnly.files, "copilot").files, 0);
  assert.equal(copilotWeightWords(instructionTotals(claudeOnly.files, "copilot")), null);
  const withAgents = instructionInventory(fsOf({ "CLAUDE.md": "z".repeat(50), "AGENTS.md": "y".repeat(10) }));
  assert.equal(instructionTotals(withAgents.files, "copilot").always, 60);
});
