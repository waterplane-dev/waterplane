// What a folder's agent instructions cost on every turn: CLAUDE.md plus the
// skills' DESCRIPTIONS, never their bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, data, tmp } from "./helpers.mjs";

const REPO = join(FIXTURES, "repo");

test("a description wrapped over three lines is measured whole", async () => {
  const doc = await data.weighFolder(REPO);
  const a = doc.skills.find((s) => s.name === "a");
  const whole = "First line of a wrapped description that carries on to a second line and ends on a third.";
  assert.equal(a.descChars, whole.length);
  assert.equal(a.bodyChars, readFileSync(join(REPO, ".claude/skills/a/SKILL.md"), "utf8").length);
});

test("always-on = CLAUDE.md + descriptions, not bodies", async () => {
  const doc = await data.weighFolder(REPO);
  const md = readFileSync(join(REPO, "CLAUDE.md"), "utf8").length;
  assert.equal(doc.claudeMdChars, md);
  assert.deepEqual(doc.skills.map((s) => s.name), ["a", "b"]);
  const descs = doc.skills.reduce((n, s) => n + s.descChars, 0);
  assert.equal(doc.reading.alwaysOnChars, md + descs);
  assert.ok(doc.reading.alwaysOnChars < md + doc.skills.reduce((n, s) => n + s.bodyChars, 0));
  assert.equal(doc.reading.skillCount, 2);
  assert.equal(doc.reading.verdict, "lean");
  assert.equal(doc.folder, REPO);
});

test("a folder with no instructions carries nothing", async () => {
  const doc = await data.weighFolder(tmp("bare"));
  assert.equal(doc.claudeMdChars, 0);
  assert.deepEqual(doc.skills, []);
  assert.equal(doc.reading.alwaysOnChars, 0);
});

// Copilot and Claude Code read overlapping sets of files; every row names its readers and when.
import { mkdirSync, writeFileSync } from "node:fs";

function tree(name, files) {
  const dir = tmp(name);
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  return dir;
}

test("AGENTS.md is Copilot's alone, unless CLAUDE.md imports it", async () => {
  const solo = await data.weighFolder(tree("agents-solo", { "AGENTS.md": "x".repeat(400) }));
  assert.equal(solo.agents.copilot.always, 400);
  assert.equal(solo.agents.claude.files, 0);
  const both = await data.weighFolder(tree("agents-imported", { "AGENTS.md": "x".repeat(400), "CLAUDE.md": "@AGENTS.md\n" }));
  assert.equal(both.agents.claude.always, 400 + "@AGENTS.md\n".length);
  assert.equal(both.reading.alwaysOnChars, both.agents.claude.always);
  assert.deepEqual(both.files.find((f) => f.path === "AGENTS.md").parts[0].readers, ["claude", "copilot"]);
});

test("Copilot reads copilot-instructions.md and CLAUDE.md every request; a setting turned off drops it", async () => {
  const dir = tree("copilot-on", { ".github/copilot-instructions.md": "y".repeat(100), "CLAUDE.md": "z".repeat(50) });
  const on = await data.weighFolder(dir);
  assert.equal(on.agents.copilot.always, 150);
  assert.equal(on.agents.claude.always, 50);
  const off = await data.weighFolder(dir, { claudeMd: false });
  assert.equal(off.agents.copilot.always, 100);
  assert.equal(off.files.find((f) => f.path === "CLAUDE.md").off, "chat.useClaudeMdFile");
});

test("an instructions file is every request at applyTo **, scoped at a narrower glob, description-carried without one", () => {
  const all = data.classifyInstructions("---\napplyTo: \"**\"\n---\nbody", ["copilot"]);
  assert.equal(all[0].when.kind, "always");
  const ts = data.classifyInstructions("---\napplyTo: \"src/**/*.ts, test/**\"\n---\nbody", ["copilot"]);
  assert.deepEqual(ts[0].when, { kind: "scoped", globs: ["src/**/*.ts", "test/**"] });
  const desc = data.classifyInstructions("---\ndescription: When writing tests\n---\nbody text", ["copilot"]);
  assert.equal(desc[0].when.kind, "always");
  assert.equal(desc[0].chars, "When writing tests".length);
  assert.equal(desc[1].when.kind, "on-demand");
  assert.equal(data.classifyInstructions("no frontmatter", ["copilot"])[0].when.kind, "on-demand");
});

test("the lens is asked for every kind of file the inventory reads, and saving one re-weighs", () => {
  const yes = ["CLAUDE.md", "/r/.claude/CLAUDE.md", "/r/AGENTS.md", "/r/.github/copilot-instructions.md",
    "/r/.github/instructions/api.instructions.md", "/r/.claude/rules/style.md", "/r/.claude/rules/deep/x.md",
    "C:\\r\\.claude\\rules\\style.md", "/r/.claude/skills/s/SKILL.md"];
  for (const p of yes) assert.ok(data.isInstructionPath(p), p);
  for (const p of ["/r/README.md", "/r/.claude/rules/notes.txt", "/r/docs/CLAUDE.md.bak"]) assert.ok(!data.isInstructionPath(p), p);
  const pats = data.LENS_PATTERNS.join(" ");
  assert.match(pats, /\*\.instructions\.md/);
  assert.match(pats, /\.claude\/rules\/\*\*\/\*\.md/);
});

test("a .claude/rules file without paths is every turn, with paths is scoped", () => {
  assert.equal(data.classifyRule("plain rule", ["claude"])[0].when.kind, "always");
  const scoped = data.classifyRule("---\npaths:\n  - \"src/api/**\"\n---\nrule", ["claude"]);
  assert.deepEqual(scoped[0].when, { kind: "scoped", globs: ["src/api/**"] });
});

test("CLAUDE.md imports skip code spans, fences and home paths", () => {
  const md = "See @AGENTS.md and @docs/style.md.\n`@not/this.md`\n```\n@nor/this.md\n```\n@~/.claude/mine.md";
  assert.deepEqual(data.claudeImports(md), ["AGENTS.md", "docs/style.md"]);
});

test("skills in .github/skills are Copilot's, in .claude/skills both agents'", async () => {
  const skill = "---\nname: s\ndescription: does a thing\n---\nlong body";
  const doc = await data.weighFolder(tree("skills-both", { ".github/skills/g/SKILL.md": skill, ".claude/skills/c/SKILL.md": skill }));
  assert.equal(doc.agents.copilot.always, 2 * "does a thing".length);
  assert.equal(doc.agents.claude.always, "does a thing".length);
});

test("a CLAUDE.md copied from AGENTS.md is named as a repeat both agents carry; an import is not", async () => {
  const body = Array.from({ length: 12 }, (_, i) => `- Rule number ${i}: always run the tests before committing.`).join("\n");
  const copied = await data.weighFolder(tree("copied", { "AGENTS.md": body, "CLAUDE.md": `# Claude\n${body}\n` }));
  assert.equal(copied.overlaps.length, 1);
  const o = copied.overlaps[0];
  assert.deepEqual([o.a, o.b], ["CLAUDE.md", "AGENTS.md"]);
  assert.deepEqual(o.readers, ["copilot"]);
  assert.ok(o.ofSmaller > 0.9);
  const imported = await data.weighFolder(tree("imported", { "AGENTS.md": body, "CLAUDE.md": "@AGENTS.md\n" }));
  assert.deepEqual(imported.overlaps, []);
  const both = await data.weighFolder(tree("imported-and-copied", { "AGENTS.md": body, "CLAUDE.md": `@AGENTS.md\n${body}\n` }));
  assert.deepEqual(both.overlaps[0].readers, ["claude", "copilot"]);
});

test("short shared lines are not a repeat", () => {
  assert.equal(data.sharedChars("# Rules\n\n- yes\n", "# Rules\n\n- yes\n"), 0);
});

// The CodeLens above an instruction file says what the Always-on view's row for it says.
test("lensWords: one line per file kind, from the file's own inventory row", async () => {
  const doc = await data.weighFolder(REPO);
  const row = (p) => doc.files.find((f) => f.path === p);
  const md = readFileSync(join(REPO, "CLAUDE.md"), "utf8").length;
  const words = data.lensWords(row("CLAUDE.md"));
  assert.match(words, /^~\d+(\.\d)?k? tokens every request · Claude Code/);
  const skill = data.lensWords(row(".claude/skills/a/SKILL.md"));
  assert.match(skill, /^description ~\d+ tokens every request · body ~\d+ on demand · Claude Code$/);
  assert.equal(data.lensWords(row("CLAUDE.local.md")), null);
  assert.equal(data.lensWords(undefined), null);
});

test("lensWords: scoped, off and unknown", () => {
  const part = (readers, when, chars) => ({ readers, when, chars });
  const f = (parts, extra = {}) => ({ path: "x.md", kind: "k", parts, ...extra });
  assert.equal(data.lensWords(f([part(["copilot"], { kind: "scoped", globs: ["src/**", "*.ts", "lib/**"] }, 800)])),
    "~200 tokens when a file matches src/**, *.ts +1 more · Copilot");
  assert.equal(data.lensWords(f([part([], { kind: "always" }, 800)], { off: "chat.useAgentsMdFile" })), "nobody reads this: chat.useAgentsMdFile is off");
  assert.equal(data.lensWords(f([part([], { kind: "always" }, 800)])), null);
  assert.equal(data.lensWords(f([part(["claude", "copilot"], { kind: "always" }, 12400)])), "~3.1k tokens every request · Claude Code + Copilot");
});

// The widened inventory: subagents and MCP servers are listed beside the counted rows (D1).
test("subagent descriptions and MCP servers are listed, not counted by the threshold", async () => {
  const doc = await data.weighFolder(REPO);
  const agent = doc.files.find((f) => f.kind === "subagent");
  assert.ok(agent && agent.path.endsWith(".claude/agents/a.md"));
  const mcp = doc.files.find((f) => f.kind.startsWith("MCP server"));
  assert.ok(mcp && mcp.parts.length === 0 && typeof mcp.unsized === "string");
  const md = readFileSync(join(REPO, "CLAUDE.md"), "utf8").length;
  const descs = doc.skills.reduce((n, s) => n + s.descChars, 0);
  assert.equal(doc.reading.alwaysOnChars, md + descs);
});

test("CLAUDE.local.md and .claude/agents get a lens and trigger a re-weigh", () => {
  assert.ok(data.isInstructionPath("/w/CLAUDE.local.md"));
  assert.ok(data.isInstructionPath("/w/.claude/agents/a.md"));
  assert.ok(!data.isInstructionPath("/w/docs/agents/a.md"));
  assert.ok(data.LENS_PATTERNS.some((p) => p.includes("CLAUDE.local.md")));
  assert.ok(data.LENS_PATTERNS.some((p) => p.includes(".claude/agents")));
});

// This desktop: the config dir's own files, from a temp dir so the test never reads the real one.
test("this desktop: user CLAUDE.md, user skill, memory and plugin skills from the config dir", async () => {
  const cfg = tree("cfg", {
    "CLAUDE.md": "u".repeat(120),
    "skills/mine/SKILL.md": "---\nname: mine\ndescription: Does a thing.\n---\nBody.\n",
    "plugins/installed_plugins.json": JSON.stringify({ plugins: { "p@m": [{ scope: "user", installPath: "" }] } }),
  });
  const doc = await data.weighFolder(REPO, {}, cfg);
  assert.ok(Array.isArray(doc.desktop));
  assert.ok(doc.desktop.every((f) => f.scope === "desktop"));
  assert.equal(doc.desktop.find((f) => f.kind === "user CLAUDE.md").parts[0].chars, 120);
  assert.ok(doc.desktop.some((f) => f.kind === "user skill"));
  assert.match(doc.memoryPath, /^projects\/.+\/memory\/MEMORY\.md$/);
  // The folder's own reading is untouched by any of it.
  assert.equal((await data.weighFolder(REPO, {}, tmp("empty-cfg"))).reading.alwaysOnChars, doc.reading.alwaysOnChars);
});

test("this desktop: an unreadable plugins file is a row that says so, never a silent nothing", async () => {
  const cfg = tree("cfg-bad", { "plugins/installed_plugins.json": "{not json" });
  const doc = await data.weighFolder(REPO, {}, cfg);
  const row = doc.desktop.find((f) => f.unsized && /installed_plugins/.test(f.unsized));
  assert.ok(row && row.parts.length === 0);
});
