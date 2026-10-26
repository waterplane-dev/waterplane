/**
 * What this desktop adds to every session whatever the repo — the per-desktop half of the
 * always-on list. Every row is `scope: "desktop"`; an input the caller could not read is a row
 * that says so, never a silent nothing and never a 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_KINDS, MANAGED_SKILLS, MCP_DECLINED, PLUGIN_DISABLED, desktopInventory, desktopSources, instructionInventory, repoRowsOnThisDesktop } from "../dist/index.js";

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

const SKILL = "---\nname: s\ndescription: does a thing when asked to\n---\nbody";
const MEM = "projects/-Users-me-repo/memory/MEMORY.md";

test("each row kind, all scope desktop, Claude only", () => {
  const rows = desktopInventory({
    fs: fsOf({ "CLAUDE.md": "u".repeat(30), [MEM]: "m".repeat(20), "skills/a/SKILL.md": SKILL, "plugins/cache/p1/skills/b/SKILL.md": SKILL }),
    memoryRel: MEM,
    plugins: [{ name: "p1", rel: "plugins/cache/p1" }],
    userMcp: ["gh"],
  });
  assert.deepEqual(rows.map((r) => r.kind), [DESKTOP_KINDS.userClaudeMd, DESKTOP_KINDS.memory, DESKTOP_KINDS.userSkill, "plugin skill (p1)", "user MCP server gh", DESKTOP_KINDS.managedSkills]);
  assert.ok(rows.every((r) => r.scope === "desktop"));
  assert.ok(rows.every((r) => r.parts.every((p) => p.readers.join() === "claude")));
  assert.equal(rows[0].parts[0].chars, 30);
  assert.equal(rows[1].path, MEM);
  assert.deepEqual(rows[2].parts.map((p) => p.when.kind), ["always", "on-demand"]);
  assert.equal(rows[3].path, "plugins/cache/p1/skills/b/SKILL.md");
  assert.deepEqual(rows[4].parts, []);
  assert.match(rows[4].unsized, /when it connects/);
});

test("null inputs become rows that say what could not be read", () => {
  const rows = desktopInventory({ fs: fsOf({}), memoryRel: null, plugins: null, userMcp: null });
  assert.deepEqual(rows.map((r) => r.kind), [DESKTOP_KINDS.pluginSkills, DESKTOP_KINDS.userMcpServers, DESKTOP_KINDS.managedSkills]);
  assert.match(rows[0].unsized, /installed_plugins\.json could not be read/);
  assert.match(rows[1].unsized, /\.claude\.json could not be read/);
});

test("an empty config dir with nothing configured is only the managed-packs row, unsized, no path", () => {
  const rows = desktopInventory({ fs: fsOf({}), memoryRel: MEM, plugins: [], userMcp: [] });
  assert.deepEqual(rows.map((r) => [r.path, r.kind, r.unsized, r.parts.length]), [["", DESKTOP_KINDS.managedSkills, MANAGED_SKILLS, 0]]);
  assert.match(MANAGED_SKILLS, /skill listing/);
});

const INSTALLED = { version: 2, plugins: {
  "kit@m": [{ scope: "user", installPath: "/cfg/plugins/cache/kit" }],
  "off@m": [{ scope: "user", installPath: "/cfg/plugins/cache/off" }],
  "far@m": [{ scope: "user", installPath: "/elsewhere/far" }],
  "proj@m": [{ scope: "project", installPath: "/cfg/plugins/cache/proj" }],
} };
const relToConfig = (abs) => (abs.startsWith("/cfg/") ? abs.slice(5) : null);

test("sources: enabledPlugins false drops a plugin's skills (user < project < local), true with no install is listed", () => {
  const s = desktopSources({
    installed: INSTALLED,
    userSettings: { enabledPlugins: { "off@m": false, "kit@m": false, "synced@m": true } },
    projectSettings: [
      { path: ".claude/settings.json", json: { enabledPlugins: { "kit@m": true, "proj@m": true } } },
      { path: ".claude/settings.local.json", json: "missing" },
    ],
    claudeJson: "missing", projectKey: "/repo", relToConfig,
  });
  assert.deepEqual(s.plugins, [{ name: "kit", rel: "plugins/cache/kit" }], "the project's true beats the user's false");
  assert.deepEqual(s.disabledPlugins, ["off"]);
  assert.deepEqual(s.outside, [{ name: "far", path: "/elsewhere/far" }]);
  assert.deepEqual(s.userOnlyPlugins, ["synced@m"]);
  assert.deepEqual(s.projectPlugins, [{ key: "proj@m", path: ".claude/settings.json" }]);
  const rows = desktopInventory({ fs: fsOf({}), memoryRel: null, plugins: s.plugins, userMcp: s.userMcp, disabledPlugins: s.disabledPlugins, userOnlyPlugins: s.userOnlyPlugins, localMcp: s.localMcp });
  const off = rows.find((r) => r.kind === "plugin off");
  assert.equal(off.unsized, PLUGIN_DISABLED);
  assert.deepEqual(off.parts, []);
  assert.ok(rows.some((r) => r.kind === "plugin synced@m" && r.unsized));
});

test("sources: local-scope MCP servers of this cwd, and .mcp.json servers declined here", () => {
  const claudeJson = {
    mcpServers: { u: {} },
    projects: {
      "/repo": { mcpServers: { zed: {}, loc: {} }, enabledMcpjsonServers: [], disabledMcpjsonServers: ["b"] },
      "/other": { mcpServers: { nope: {} } },
    },
  };
  const s = desktopSources({ installed: "missing", userSettings: "missing", projectSettings: [{ path: ".claude/settings.json", json: { disabledMcpjsonServers: ["c"] } }], claudeJson, projectKey: "/repo", relToConfig });
  assert.deepEqual(s.userMcp, ["u"]);
  assert.deepEqual(s.localMcp, ["loc", "zed"]);
  assert.deepEqual(s.mcpjsonDeclined, ["b", "c"]);
  const rows = desktopInventory({ fs: fsOf({}), memoryRel: null, plugins: [], userMcp: s.userMcp, localMcp: s.localMcp });
  assert.deepEqual(rows.filter((r) => /MCP/.test(r.kind)).map((r) => [r.path, r.kind]), [
    ["~/.claude.json", "user MCP server u"], ["~/.claude.json", "local MCP server loc"], ["~/.claude.json", "local MCP server zed"],
  ]);
  const repo = instructionInventory(fsOf({ ".mcp.json": JSON.stringify({ mcpServers: { a: {}, b: {} } }) })).files;
  const here = repoRowsOnThisDesktop(repo, { mcpjsonDeclined: s.mcpjsonDeclined, projectPlugins: [{ key: "p@m", path: ".claude/settings.json" }] });
  assert.deepEqual(here.map((r) => [r.kind, r.unsized === MCP_DECLINED]), [["MCP server a", false], ["MCP server b", true], ["project plugin p@m", false]]);
  assert.ok(here[2].unsized && here[2].scope === undefined);
});

test("sources: an unreadable installed_plugins.json or .claude.json is null, never an empty list", () => {
  const s = desktopSources({ installed: null, userSettings: null, projectSettings: [], claudeJson: null, projectKey: "/repo", relToConfig });
  assert.equal(s.plugins, null);
  assert.equal(s.userMcp, null);
  assert.deepEqual(s.localMcp, []);
});
