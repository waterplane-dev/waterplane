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
