/**
 * What this desktop adds to every session whatever the repo — the per-desktop half of the
 * always-on list. Every row is `scope: "desktop"`; an input the caller could not read is a row
 * that says so, never a silent nothing and never a 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_KINDS, MANAGED_SKILLS, MCP_DECLINED, PLUGIN_DISABLED, alwaysOnTotalsWords, claudeWeightInput, desktopInventory, desktopSources, hookUnsized, instructionInventory, repoRowsOnThisDesktop, weighContext } from "../dist/index.js";

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

const cmd = (command) => ({ type: "command", command });
const hookSources = (userSettings, projectSettings = []) => desktopSources({ installed: "missing", userSettings, projectSettings, claudeJson: "missing", projectKey: "/repo", relToConfig });
const hookRows = (rows) => rows.filter((r) => r.kind.startsWith(DESKTOP_KINDS.hook));

test("hooks: a missing or non-object `hooks`, and a missing file, are no rows", () => {
  for (const settings of [{}, { hooks: null }, { hooks: [] }, { hooks: "x" }, "missing"]) {
    assert.deepEqual(hookSources(settings).hooks, [], JSON.stringify(settings));
  }
  const s = hookSources({ hooks: { SessionStart: "x", UserPromptSubmit: [null, { hooks: "x" }, { hooks: [{ type: "command" }, { type: "prompt", prompt: "p" }] }] } });
  assert.deepEqual(s.hooks, [], "nothing here runs a command");
});

test("hooks: two commands on one event are one row; events that inject nothing are none", () => {
  const s = hookSources({ hooks: {
    SessionStart: [{ matcher: "startup", hooks: [cmd("a")] }, { hooks: [cmd("b")] }],
    UserPromptSubmit: [{ hooks: [cmd("c")] }],
    PreToolUse: [{ hooks: [cmd("d")] }],
    Stop: [{ hooks: [cmd("e")] }],
  } });
  assert.deepEqual(s.hooks, [
    { event: "SessionStart", path: "settings.json", commands: 2 },
    { event: "UserPromptSubmit", path: "settings.json", commands: 1 },
  ]);
  const rows = hookRows(desktopInventory({ fs: fsOf({}), memoryRel: null, plugins: [], userMcp: [], hooks: s.hooks }));
  assert.deepEqual(rows.map((r) => [r.path, r.kind, r.scope, r.parts.length]), [
    ["settings.json", "context hook SessionStart (2 commands)", "desktop", 0],
    ["settings.json", "context hook UserPromptSubmit (1 command)", "desktop", 0],
  ]);
  assert.equal(rows[0].unsized, 'runs commands whose output the CLI adds to every session; a session\'s context view measures the size as "hook context", and /hooks lists them');
  assert.equal(rows[1].unsized, 'runs a command whose output the CLI adds to every prompt; a session\'s context view measures the size as "hook context", and /hooks lists it');
  assert.ok(!JSON.stringify(rows).includes('"a"'), "a command's text never rides a row");
});

test("hooks: an unreadable settings file is a row that says so, never an empty list", () => {
  for (const settings of [null, ["not", "an", "object"]]) assert.equal(hookSources(settings).hooks, null);
  const rows = hookRows(desktopInventory({ fs: fsOf({}), memoryRel: null, plugins: [], userMcp: [], hooks: null }));
  assert.deepEqual(rows.map((r) => [r.path, r.kind, r.unsized, r.scope]), [["settings.json", "context hooks", "settings.json could not be read", "desktop"]]);
  assert.deepEqual(hookRows(desktopInventory({ fs: fsOf({}), memoryRel: null, plugins: [], userMcp: [] })), [], "a caller that passes none claims none");
});

test("hooks: the repo's settings files are repo rows, one per file and event, and an unreadable one says so", () => {
  const s = hookSources("missing", [
    { path: ".claude/settings.json", json: { hooks: { UserPromptSubmit: [{ hooks: [cmd("a")] }], PostToolUse: [{ hooks: [cmd("b")] }] } } },
    { path: ".claude/settings.local.json", json: { hooks: { UserPromptSubmit: [{ hooks: [cmd("c"), cmd("d")] }] } } },
  ]);
  assert.deepEqual(s.hooks, [], "project hooks are not this desktop's");
  const here = repoRowsOnThisDesktop([], s);
  assert.deepEqual(here.map((r) => [r.path, r.kind, r.scope]), [
    [".claude/settings.json", "context hook UserPromptSubmit (1 command)", undefined],
    [".claude/settings.local.json", "context hook UserPromptSubmit (2 commands)", undefined],
  ]);
  assert.equal(here[0].unsized, hookUnsized({ event: "UserPromptSubmit", commands: 1 }));
  const bad = hookSources("missing", [{ path: ".claude/settings.json", json: null }, { path: ".claude/settings.local.json", json: "missing" }]);
  assert.deepEqual(repoRowsOnThisDesktop([], bad).map((r) => [r.path, r.kind, r.unsized]), [[".claude/settings.json", "context hooks", ".claude/settings.json could not be read"]]);
});

test("hooks: an enabled plugin's hooks.json is rows under its name; a disabled plugin's is never read", () => {
  const hooksJson = JSON.stringify({ description: "d", hooks: { SessionStart: [{ hooks: [cmd("a")] }], Stop: [{ hooks: [cmd("b")] }] } });
  const s = desktopSources({ installed: INSTALLED, userSettings: { enabledPlugins: { "off@m": false } }, projectSettings: [], claudeJson: "missing", projectKey: "/repo", relToConfig });
  const fs = fsOf({ "plugins/cache/kit/hooks/hooks.json": hooksJson, "plugins/cache/off/hooks/hooks.json": hooksJson });
  const rows = desktopInventory({ fs, memoryRel: null, plugins: s.plugins, userMcp: [], disabledPlugins: s.disabledPlugins, hooks: s.hooks });
  assert.deepEqual(hookRows(rows).map((r) => [r.path, r.kind, r.scope]), [["plugins/cache/kit/hooks/hooks.json", "context hook SessionStart (1 command, plugin kit)", "desktop"]]);
  assert.ok(rows.some((r) => r.kind === "plugin off" && r.unsized === PLUGIN_DISABLED), "the plugin itself still says it is off");
  const broken = desktopInventory({ fs: fsOf({ "plugins/cache/kit/hooks/hooks.json": "{" }), memoryRel: null, plugins: [{ name: "kit", rel: "plugins/cache/kit" }], userMcp: [] });
  assert.deepEqual(hookRows(broken).map((r) => r.unsized), ["plugins/cache/kit/hooks/hooks.json could not be read"]);
});

test("hooks: a hook row moves no threshold figure and is counted as a row with no size", () => {
  const { files } = instructionInventory(fsOf({ "CLAUDE.md": "c".repeat(400) }));
  const s = hookSources("missing", [{ path: ".claude/settings.json", json: { hooks: { SessionStart: [{ hooks: [cmd("a")] }] } } }]);
  const here = repoRowsOnThisDesktop(files, s);
  assert.deepEqual(weighContext(claudeWeightInput(here)), weighContext(claudeWeightInput(files)));
  assert.match(alwaysOnTotalsWords(here), /1 more row has no size here/);
});
