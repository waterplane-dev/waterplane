// This desktop's always-on rows (`alwayson.ts`): read off a fake config dir via
// the test home knob, every input that is there but unreadable a row that SAYS
// so, every input that is not there a measured empty.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "waterplane-alwayson-")));
after(() => rmSync(ROOT, { recursive: true, force: true }));
delete process.env.CLAUDE_CONFIG_DIR;

const { desktopInstructionRows, repoInstructionsDoc } = await import("../dist/alwayson.js");

const put = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const skill = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody of ${name}.\n`;

function home(name) {
  const h = join(ROOT, name);
  mkdirSync(join(h, ".claude"), { recursive: true });
  process.env.WATERPLANE_CLAUDE_HOME = h;
  return h;
}

test("a populated desktop: user CLAUDE.md, the repo's memory, user and plugin skills, user MCP names", () => {
  const h = home("full");
  const cfg = join(h, ".claude");
  const repo = join(ROOT, "repo-a");
  mkdirSync(repo, { recursive: true });
  put(join(repo, "CLAUDE.md"), "# repo\n");
  put(join(cfg, "CLAUDE.md"), "user rules\n");
  const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
  put(join(cfg, "projects", slug, "memory", "MEMORY.md"), "- memory line\n");
  put(join(cfg, "skills", "mine", "SKILL.md"), skill("mine", "my own skill"));
  const plug = join(cfg, "plugins", "cache", "kit", "1");
  put(join(plug, "skills", "tool", "SKILL.md"), skill("tool", "a plugin skill"));
  put(join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "kit@market": [{ scope: "user", installPath: plug }],
    "proj@market": [{ scope: "project", installPath: join(cfg, "plugins", "cache", "proj") }],
    "far@market": [{ scope: "user", installPath: join(ROOT, "elsewhere") }],
  } }));
  put(join(h, ".claude.json"), JSON.stringify({ mcpServers: { zeta: {}, alpha: {} } }));

  const d = desktopInstructionRows(repo);
  assert.equal(d.memoryPath, `projects/${slug}/memory/MEMORY.md`);
  const rows = d.rows.map((r) => [r.path, r.kind, r.scope]);
  assert.deepEqual(rows, [
    ["CLAUDE.md", "user CLAUDE.md", "desktop"],
    [`projects/${slug}/memory/MEMORY.md`, "auto-memory", "desktop"],
    ["skills/mine/SKILL.md", "user skill", "desktop"],
    ["plugins/cache/kit/1/skills/tool/SKILL.md", "plugin skill (kit)", "desktop"],
    ["~/.claude.json", "user MCP server alpha", "desktop"],
    ["~/.claude.json", "user MCP server zeta", "desktop"],
    ["", "managed plugin skills", "desktop"],
    [join(ROOT, "elsewhere"), "plugin skills (far)", "desktop"],
  ]);
  assert.equal(d.rows[0].parts[0].chars, "user rules\n".length);
  assert.ok(d.rows[4].unsized && d.rows[4].parts.length === 0, "an MCP server is never sized");
  assert.ok(d.rows[6].unsized && d.rows[7].unsized);

  const doc = repoInstructionsDoc(repo);
  assert.ok(doc.files.some((f) => f.path === "CLAUDE.md" && f.scope === undefined));
  assert.equal(doc.desktop.length, 8);
  assert.equal(doc.configDir, cfg, "a config dir outside the home dir is worded as its path");
});

test("this desktop's settings decide: a disabled plugin, local-scope MCP, a declined .mcp.json server, a project plugin", () => {
  const h = home("settings");
  const cfg = join(h, ".claude");
  const repo = join(ROOT, "repo-s");
  put(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { keep: {}, gone: {} } }));
  put(join(repo, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "team@m": true } }));
  const plug = join(cfg, "plugins", "cache", "off", "1");
  put(join(plug, "skills", "t", "SKILL.md"), skill("t", "a skill of a disabled plugin"));
  put(join(cfg, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "off@m": [{ scope: "user", installPath: plug }] } }));
  put(join(cfg, "settings.json"), JSON.stringify({ enabledPlugins: { "off@m": false } }));
  put(join(h, ".claude.json"), JSON.stringify({ projects: { [realpathSync(repo)]: { mcpServers: { loc: {} }, disabledMcpjsonServers: ["gone"] } } }));

  const doc = repoInstructionsDoc(repo);
  const desk = doc.desktop.map((r) => r.kind);
  assert.ok(!desk.some((k) => k.startsWith("plugin skill (off)")), "a disabled plugin's skills are not listed as carried");
  assert.ok(desk.includes("plugin off") && desk.includes("local MCP server loc"));
  const mcp = doc.files.filter((f) => f.path === ".mcp.json").map((f) => [f.kind, /declined/.test(f.unsized)]);
  assert.deepEqual(mcp, [["MCP server keep", false], ["MCP server gone", true]]);
  assert.ok(doc.files.some((f) => f.kind === "project plugin team@m" && f.path === ".claude/settings.json" && f.unsized));
});

test("an empty config dir is a measured empty, not an unreadable one", () => {
  home("empty");
  const repo = join(ROOT, "repo-b");
  mkdirSync(repo, { recursive: true });
  assert.deepEqual(desktopInstructionRows(repo).rows.map((r) => r.kind), ["managed plugin skills"]);
});

test("an installed_plugins.json or .claude.json that will not parse is a row that says so", () => {
  const h = home("broken");
  put(join(h, ".claude", "plugins", "installed_plugins.json"), "{not json");
  put(join(h, ".claude.json"), "[1,");
  const rows = desktopInstructionRows(join(ROOT, "repo-b")).rows;
  assert.deepEqual(rows.map((r) => [r.kind, !!r.unsized]), [["plugin skills", true], ["user MCP servers", true], ["managed plugin skills", true]]);
  assert.match(rows[0].unsized, /could not be read/);
});

test("CLAUDE_CONFIG_DIR keeps .claude.json inside that dir", () => {
  const dir = join(ROOT, "cfgdir");
  put(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { inside: {} } }));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const rows = desktopInstructionRows(join(ROOT, "repo-b")).rows;
    assert.deepEqual(rows.map((r) => r.kind), ["user MCP server inside", "managed plugin skills"]);
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});
