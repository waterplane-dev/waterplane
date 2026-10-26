/**
 * What this desktop adds to every session whatever the repo — the per-desktop half of the
 * always-on list. Every row is `scope: "desktop"`; an input the caller could not read is a row
 * that says so, never a silent nothing and never a 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_KINDS, desktopInventory } from "../dist/index.js";

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
  assert.deepEqual(rows.map((r) => r.kind), [DESKTOP_KINDS.userClaudeMd, DESKTOP_KINDS.memory, DESKTOP_KINDS.userSkill, "plugin skill (p1)", "user MCP server gh"]);
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
  assert.deepEqual(rows.map((r) => r.kind), [DESKTOP_KINDS.pluginSkills, DESKTOP_KINDS.userMcpServers]);
  assert.match(rows[0].unsized, /installed_plugins\.json could not be read/);
  assert.match(rows[1].unsized, /\.claude\.json could not be read/);
});

test("an empty config dir with nothing configured is no rows", () => {
  assert.deepEqual(desktopInventory({ fs: fsOf({}), memoryRel: MEM, plugins: [], userMcp: [] }), []);
});
