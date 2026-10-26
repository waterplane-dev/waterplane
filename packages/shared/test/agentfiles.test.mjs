/**
 * Who reads which instruction file, and when — one inventory for the host's context-weight row
 * and the VS Code extension. The case this exists for: a repo that moved from Copilot to Claude
 * Code, copied AGENTS.md into a new CLAUDE.md, and now sends the same lines twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { claudeWeightInput, copilotWeightWords, countedByThreshold, instructionInventory, instructionTotals, overlapWords, sharedChars } from "../dist/index.js";

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

test("instructionFileWeight: a skill splits description (every turn) from body (when used)", async () => {
  const { instructionFileWeight, instructionFileWeightWords } = await import("../dist/index.js");
  const text = `---\nname: x\ndescription: ${"d".repeat(400)}\n---\n${"b".repeat(3600)}`;
  const w = instructionFileWeight("tools/skill/SKILL.md", text);
  assert.equal(w.kind, "skill");
  assert.equal(w.always, 400);
  assert.equal(w.always + w.onDemand, text.length);
  assert.equal(instructionFileWeightWords(w), `~${Math.round(text.length / 4)} tokens · ${text.length} chars (~100 tokens every turn, ~${Math.round((text.length - 400) / 4)} tokens only when used)`);
});

test("instructionFileWeight: CLAUDE.md is all always-on; a plain markdown file is not weighed", async () => {
  const { instructionFileWeight, instructionFileWeightWords } = await import("../dist/index.js");
  const w = instructionFileWeight("packages/x/CLAUDE.md", "a".repeat(800));
  assert.equal(instructionFileWeightWords(w), "~200 tokens · 800 chars, all of it every turn");
  assert.equal(instructionFileWeight("docs/README.md", "a".repeat(800)), null);
  assert.equal(instructionFileWeight(".claude/rules/web.md", "---\npaths: \"src/**\"\n---\nbody").scoped > 0, true);
});

test("a skill with no description says so; chat.useAgentSkills off drops Copilot from skills", () => {
  const fs = fsOf({
    ".github/copilot-instructions.md": "x",
    ".github/skills/a/SKILL.md": "# no frontmatter\nbody",
    ".github/skills/b/SKILL.md": "---\ndescription: does b\n---\nbody",
  });
  const on = instructionInventory(fs).files;
  assert.equal(on.find((f) => f.path.includes("/a/")).kind, "skill — no description found in its frontmatter");
  assert.equal(on.find((f) => f.path.includes("/b/")).kind, "skill");
  const off = instructionInventory(fs, { skills: false }).files.find((f) => f.path.includes("/b/"));
  assert.deepEqual(off.parts.map((p) => p.readers), [[], []]);
  assert.equal(off.off, "chat.useAgentSkills");
});

test("chat.includeApplyingInstructions off drops Copilot from applyTo instructions only", () => {
  const fs = fsOf({
    ".github/instructions/ts.instructions.md": "---\napplyTo: \"src/**\"\n---\nuse strict",
    ".github/instructions/d.instructions.md": "---\ndescription: when asked\n---\nbody",
  });
  const files = instructionInventory(fs, { applyingInstructions: false }).files;
  const ts = files.find((f) => f.path.endsWith("ts.instructions.md"));
  assert.deepEqual(ts.parts[0].readers, []);
  assert.equal(ts.off, "chat.includeApplyingInstructions");
  assert.deepEqual(files.find((f) => f.path.endsWith("d.instructions.md")).parts[0].readers, ["copilot"]);
});

// ── the widened inventory (always-on plan P1): CLAUDE.local.md, subagents, .mcp.json — LISTED, never in the threshold (D1) ──

const SKILL = "---\nname: s\ndescription: does a thing when asked to\n---\nbody text here";

test("CLAUDE.local.md is Claude's every turn, its import pulled in, and the threshold ignores both", () => {
  const base = { "CLAUDE.md": "# project\n", ".claude/skills/s/SKILL.md": SKILL };
  const inv = instructionInventory(fsOf({ ...base, "CLAUDE.local.md": "mine\n@notes.md\n", "notes.md": "n".repeat(50) }));
  const local = inv.files.find((f) => f.path === "CLAUDE.local.md");
  assert.equal(local.kind, "CLAUDE.local.md");
  assert.deepEqual(local.parts, [{ readers: ["claude"], when: { kind: "always" }, chars: "mine\n@notes.md\n".length }]);
  const imp = inv.files.find((f) => f.path === "notes.md");
  assert.equal(imp.kind, "imported by CLAUDE.local.md");
  assert.equal(countedByThreshold(local), false);
  assert.equal(countedByThreshold(imp), false);
  assert.deepEqual(claudeWeightInput(inv.files), claudeWeightInput(instructionInventory(fsOf(base)).files));
});

test("a file CLAUDE.md imports stays counted even when CLAUDE.local.md imports it too", () => {
  const inv = instructionInventory(fsOf({ "CLAUDE.md": "@a.md\n", "CLAUDE.local.md": "@a.md\n", "a.md": "a".repeat(40) }));
  assert.equal(inv.files.find((f) => f.path === "a.md").kind, "imported by CLAUDE.md");
});

test(".claude/agents/*.md is a subagent: description every turn, body on demand, not in the threshold", () => {
  const base = { "CLAUDE.md": "# project\n" };
  const inv = instructionInventory(fsOf({ ...base, ".claude/agents/x.md": SKILL, ".claude/agents/deep/y.md": SKILL }));
  const subs = inv.files.filter((f) => f.kind === "subagent");
  assert.deepEqual(subs.map((f) => f.path), [".claude/agents/x.md"], "depth 1 only");
  assert.deepEqual(subs[0].parts.map((p) => p.when.kind), ["always", "on-demand"]);
  assert.deepEqual(subs[0].parts[0].readers, ["claude"]);
  assert.deepEqual(claudeWeightInput(inv.files), claudeWeightInput(instructionInventory(fsOf(base)).files));
});

test(".mcp.json servers are unsized rows: no chars, no totals, no threshold", () => {
  const base = { "CLAUDE.md": "# project\n" };
  const inv = instructionInventory(fsOf({ ...base, ".mcp.json": JSON.stringify({ mcpServers: { a: {}, b: {} } }) }));
  const mcp = inv.files.filter((f) => f.path === ".mcp.json");
  assert.deepEqual(mcp.map((f) => f.kind), ["MCP server a", "MCP server b"]);
  for (const f of mcp) { assert.deepEqual(f.parts, []); assert.match(f.unsized, /when it connects/); }
  assert.deepEqual(instructionTotals(inv.files, "claude"), instructionTotals(instructionInventory(fsOf(base)).files, "claude"));
  assert.deepEqual(claudeWeightInput(inv.files), claudeWeightInput(instructionInventory(fsOf(base)).files));
  assert.equal(inv.overlaps.length, 0);
});

test("a malformed .mcp.json is one row that says so", () => {
  const inv = instructionInventory(fsOf({ ".mcp.json": "{ nope" }));
  assert.equal(inv.files.length, 1);
  assert.equal(inv.files[0].kind, ".mcp.json (unreadable)");
  assert.match(inv.files[0].unsized, /not valid JSON/);
});
