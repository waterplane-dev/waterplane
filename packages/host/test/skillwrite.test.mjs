// Skills and plugins switch, write side (PLAN.md P3): fixed target table, raw merge, refusals, rev, symlinks, modes.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wp-skillwrite-"));
const cfg = join(root, "cfg");
const wt = join(root, "repo");
const outside = join(root, "elsewhere");
mkdirSync(join(cfg, "skills", "mine"), { recursive: true });
mkdirSync(join(wt, ".claude"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(cfg, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: x\n---\nb\n");
const plugDir = join(root, "plug");
mkdirSync(join(plugDir, "skills", "s1"), { recursive: true });
writeFileSync(join(plugDir, "skills", "s1", "SKILL.md"), "---\nname: s1\ndescription: y\n---\nb\n");
const stub = join(root, "claude-stub.sh");
writeFileSync(stub, `#!/bin/sh\necho '${JSON.stringify([{ id: "plug@synced", scope: "synced", enabled: true, installPath: plugDir }])}'\n`);
chmodSync(stub, 0o755);
execFileSync("git", ["init", "-q"], { cwd: wt });
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.WATERPLANE_CLAUDE_BIN = stub;
process.env.XDG_CONFIG_HOME = join(root, "xdg"); process.env.GIT_CONFIG_GLOBAL = "/dev/null"; // a machine-wide excludes file must not decide the ignore answer

const { buildInventory, resetPluginListCache } = await import("../dist/skills/skillinventory.js");
const { applySkillWrite, revOf } = await import("../dist/skills/skillwrite.js");

const run = async (level, changes, extra = {}) => {
  resetPluginListCache();
  const { doc } = await buildInventory({ worktree: wt });
  const layer = doc.layers.find((l) => l.level === level);
  return applySkillWrite({ level, revs: { [level]: layer.rev }, changes, allowed: ["global", "repo-local", "repo-shared"], worktree: wt, doc, ...extra });
};
const glob = join(cfg, "settings.json");
const local = join(wt, ".claude", "settings.local.json");

test("global: merges, keeps other keys and the 0600 mode, writes THROUGH a symlink", async () => {
  const real = join(root, "real-settings.json");
  writeFileSync(real, JSON.stringify({ theme: "dark", skillOverrides: { old: "off" } }, null, 2) + "\n");
  chmodSync(real, 0o600);
  symlinkSync(real, glob);
  const r = await run("global", [{ kind: "skill", id: "mine", to: "name-only" }, { kind: "plugin", id: "plug@synced", to: false }]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(lstatSync(glob).isSymbolicLink(), "still a link");
  const o = JSON.parse(readFileSync(real, "utf8"));
  assert.equal(o.theme, "dark");
  assert.deepEqual(o.skillOverrides, { old: "off", mine: "name-only" });
  assert.deepEqual(o.enabledPlugins, { "plug@synced": false });
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.equal(r.changed.length, 2);
});

test("a stale rev is a 409 and nothing is written", async () => {
  const before = readFileSync(glob, "utf8");
  resetPluginListCache();
  const { doc } = await buildInventory({ worktree: wt });
  const r = applySkillWrite({ level: "global", revs: { global: "0".repeat(40) }, changes: [{ kind: "skill", id: "mine", to: "off" }], allowed: ["global"], doc });
  assert.equal(r.ok, false); assert.equal(r.status, 409);
  assert.equal(readFileSync(glob, "utf8"), before);
});

test("an unknown id is 400; stale inherit of a key already in the file is allowed", async () => {
  const r = await run("global", [{ kind: "skill", id: "ghost", to: "off" }]);
  assert.equal(r.ok, false); assert.equal(r.status, 400);
  const ok = await run("global", [{ kind: "skill", id: "old", to: "inherit" }]);
  assert.equal(ok.ok, true);
  assert.equal("old" in JSON.parse(readFileSync(glob, "utf8")).skillOverrides, false);
});

test("plugin skills are refused while the CLI ignores them; a plugin takes no skill state", async () => {
  const r = await run("global", [{ kind: "skill", id: "plug:s1", to: "off" }]);
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.match(r.error, /plugin/);
  const r2 = await run("global", [{ kind: "plugin", id: "plug@synced", to: "off" }]);
  assert.equal(r2.ok, false); assert.equal(r2.status, 400);
});

test("repo-local: creates the file, says whether git ignores it; the level comes from the fixed table", async () => {
  writeFileSync(join(wt, ".gitignore"), ".claude/settings.local.json\n");
  const r = await run("repo-local", [{ kind: "skill", id: "mine", to: "off" }]);
  assert.equal(r.ok, true); assert.equal(r.gitignored, true); assert.equal(r.file, ".claude/settings.local.json");
  assert.deepEqual(JSON.parse(readFileSync(local, "utf8")).skillOverrides, { mine: "off" });
  assert.equal(existsSync(join(wt, ".claude", "settings.json")), false, "other repo file untouched");
  writeFileSync(join(wt, ".gitignore"), "");
  const r2 = await run("repo-local", [{ kind: "skill", id: "mine", to: "on" }]);
  assert.equal(r2.gitignored, false); assert.match(r2.ignoredNote, /gitignore/);
});

test("a level this route may not write is refused (host route = global only)", async () => {
  const r = await run("repo-shared", [{ kind: "skill", id: "mine", to: "off" }], { allowed: ["global"] });
  assert.equal(r.ok, false); assert.equal(r.status, 400);
  assert.equal(existsSync(join(wt, ".claude", "settings.json")), false);
});

test("a comment-bearing or non-object file is 422, untouched, never moved aside", async () => {
  const f = join(wt, ".claude", "settings.json");
  for (const body of ['{\n // c\n "a": 1\n}\n', "[1]", "{ nope"]) {
    writeFileSync(f, body);
    const r = await run("repo-shared", [{ kind: "skill", id: "mine", to: "off" }]);
    assert.equal(r.ok, false, body); assert.equal(r.status, 422);
    assert.equal(readFileSync(f, "utf8"), body);
  }
  writeFileSync(f, JSON.stringify({ skillOverrides: [] }));
  const r = await run("repo-shared", [{ kind: "skill", id: "mine", to: "off" }]);
  assert.equal(r.ok, false);
  assert.equal(readFileSync(f, "utf8"), '{"skillOverrides":[]}');
});

test("a repo settings file linked out of the repo is refused and the target untouched", async () => {
  const f = join(wt, ".claude", "settings.json");
  const t = join(outside, "victim.json");
  writeFileSync(t, "{}\n");
  execFileSync("rm", ["-f", f]);
  symlinkSync(t, f);
  resetPluginListCache();
  const { doc } = await buildInventory({ worktree: wt });
  const r = applySkillWrite({ level: "repo-shared", revs: { "repo-shared": revOf("{}\n") }, changes: [{ kind: "skill", id: "mine", to: "off" }], allowed: ["repo-shared"], worktree: wt, doc });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(t, "utf8"), "{}\n");
});

test("global with no config dir is 422 and creates nothing", async () => {
  const { doc } = await buildInventory({ worktree: wt });
  process.env.CLAUDE_CONFIG_DIR = join(root, "nonexistent");
  const r = applySkillWrite({ level: "global", revs: { global: "absent" }, changes: [{ kind: "skill", id: "mine", to: "off" }], allowed: ["global"], doc });
  process.env.CLAUDE_CONFIG_DIR = cfg;
  assert.equal(r.ok, false); assert.equal(r.status, 422);
  assert.equal(existsSync(join(root, "nonexistent")), false);
});

test("the save record: one JSON line per successful write, append-only; a refusal and an unwritable log change nothing", async () => {
  const { readFileSync: rf, rmSync } = await import("node:fs");
  const logFile = join(root, "state", "skillswitch-log.jsonl");
  const { doc } = await buildInventory({ worktree: wt });
  const layer = doc.layers.find((l) => l.level === "repo-local");
  const ok = applySkillWrite({ level: "repo-local", revs: { "repo-local": layer.rev }, changes: [{ kind: "skill", id: "mine", to: "off" }], allowed: ["repo-local"], worktree: wt, doc, logFile, repoId: "r1" });
  assert.equal(ok.ok, true);
  // a stale write is refused and records nothing
  const stale = applySkillWrite({ level: "repo-local", revs: { "repo-local": "nope" }, changes: [{ kind: "skill", id: "mine", to: "on" }], allowed: ["repo-local"], worktree: wt, doc, logFile, repoId: "r1" });
  assert.equal(stale.ok, false);
  let lines = rf(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  const [l] = lines;
  assert.match(l.ts, /^\d{4}-\d\d-\d\dT/);
  assert.equal(l.repoId, "r1");
  assert.equal(l.level, "repo-local");
  assert.equal(l.file, ".claude/settings.local.json");
  assert.deepEqual(l.changes.map((c) => [c.kind, c.id, c.to]), [["skill", "mine", "off"]]);
  assert.equal(typeof l.listingCharsBefore, "number");
  assert.ok(l.listingCharsAfter <= l.listingCharsBefore);
  // a second write appends, never rewrites the first
  resetPluginListCache();
  const d2 = (await buildInventory({ worktree: wt })).doc;
  const l2 = d2.layers.find((x) => x.level === "repo-local");
  applySkillWrite({ level: "repo-local", revs: { "repo-local": l2.rev }, changes: [{ kind: "skill", id: "mine", to: "on" }], allowed: ["repo-local"], worktree: wt, doc: d2, logFile });
  lines = rf(logFile, "utf8").trim().split("\n").map((x) => JSON.parse(x));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], l);
  assert.equal(lines[1].repoId, null);
  // an unwritable log (a directory where the file should be) never fails the write
  rmSync(logFile);
  mkdirSync(logFile);
  resetPluginListCache();
  const d3 = (await buildInventory({ worktree: wt })).doc;
  const l3 = d3.layers.find((x) => x.level === "repo-local");
  const r3 = applySkillWrite({ level: "repo-local", revs: { "repo-local": l3.rev }, changes: [{ kind: "skill", id: "mine", to: "name-only" }], allowed: ["repo-local"], worktree: wt, doc: d3, logFile });
  assert.equal(r3.ok, true);
});

test("a global settings.json that is a dangling symlink is refused, the link survives", async () => {
  execFileSync("rm", ["-f", glob]);
  const gone = join(outside, "absent-target.json");
  symlinkSync(gone, glob);
  const r = await run("global", [{ kind: "skill", id: "mine", to: "off" }]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.match(r.error, /link/);
  assert.equal(lstatSync(glob).isSymbolicLink(), true, "the link is still a link");
  assert.equal(existsSync(gone), false, "and nothing was made at its target");
  execFileSync("rm", ["-f", glob]);
});

test("use the default on a synced skill also removes its bare key", async () => {
  const sdir = join(cfg, "skills", "synced", "acct", "xlsx");
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, "SKILL.md"), "---\nname: xlsx\ndescription: sheets\n---\nb\n");
  writeFileSync(glob, JSON.stringify({ skillOverrides: { xlsx: "off", other: "off" } }, null, 2) + "\n");
  const r = await run("global", [{ kind: "skill", id: "anthropic-skills:xlsx", to: "inherit" }]);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(glob, "utf8")).skillOverrides, { other: "off" });
  assert.ok(r.changed.length >= 1, "the receipt counts a removal");
});
