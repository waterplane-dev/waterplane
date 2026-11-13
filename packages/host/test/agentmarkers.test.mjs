/**
 * Instruction markers (`agentmarkers.ts`): commits on the repo's instruction
 * paths and `instr/*` tags off a temp git repo, a global CLAUDE.md followed
 * through its symlink into another repo, an unversioned global skills dir
 * giving a sentence instead of markers, and the switch hook point.
 *
 *     node --test packages/host/test/agentmarkers.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instructionMarkers, readSwitchLog, switchMarkers } from "../dist/agentmarkers.js";

const root = mkdtempSync(join(tmpdir(), "agentmarkers-"));
after(() => rmSync(root, { recursive: true, force: true }));

const DAY1 = Date.UTC(2026, 9, 5, 10) / 1000; // seconds
const DAY2 = DAY1 + 86_400;

function sh(cwd, args, at) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  if (at) { env.GIT_AUTHOR_DATE = `@${at} +0000`; env.GIT_COMMITTER_DATE = `@${at} +0000`; }
  return execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
}
function commit(cwd, file, text, msg, at) {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
  sh(cwd, ["add", file]);
  sh(cwd, ["commit", "-q", "-m", msg], at);
}

test("repo instruction commits, instr/* tags and a symlinked global CLAUDE.md", async () => {
  const repo = join(root, "proj");
  mkdirSync(repo);
  sh(repo, ["init", "-q"]);
  commit(repo, "src/a.ts", "x", "code only", DAY1 - 86_400 * 30);       // before since, and not instructions
  commit(repo, "CLAUDE.md", "a", "trim CLAUDE.md", DAY1);
  commit(repo, ".claude/skills/x/SKILL.md", "b", "skill x", DAY1 + 60);
  commit(repo, "src/b.ts", "y", "more code", DAY1 + 120);
  commit(repo, ".claude/settings.json", "{}", "settings", DAY2);
  sh(repo, ["tag", "instr/2026-10-06-trim"]);
  sh(repo, ["tag", "v1.0"]);

  const home = join(root, "home");
  mkdirSync(home);
  sh(home, ["init", "-q"]);
  commit(home, "global/CLAUDE.md", "g", "global rules", DAY2 + 30);
  const cfg = join(root, "cfg");
  mkdirSync(join(cfg, "skills"), { recursive: true });                  // not in git
  symlinkSync(join(home, "global", "CLAUDE.md"), join(cfg, "CLAUDE.md"));

  const { markers, absent } = await instructionMarkers(repo, (DAY1 - 86_400) * 1000, { configDir: cfg, repo: "proj" });
  const instr = markers.filter((m) => m.kind === "instructions");
  const day1 = instr.find((m) => m.repo === "proj" && m.count === 2);
  assert.ok(day1, JSON.stringify(markers));
  assert.equal(day1.detail, "trim CLAUDE.md; skill x");
  assert.ok(instr.some((m) => m.repo === "proj" && m.label === "settings" && m.detail === ".claude/settings.json"));
  const global = instr.find((m) => m.repo === undefined);
  assert.equal(global.label, "global rules");
  assert.match(global.detail, /^global: global\/CLAUDE\.md$/);
  assert.ok(!instr.some((m) => /code/.test(m.label)), "code-only commits are no markers");
  const tags = markers.filter((m) => m.kind === "tag");
  assert.deepEqual(tags.map((m) => m.label), ["2026-10-06-trim"]);
  assert.equal(absent.length, 1);
  assert.match(absent[0], /skills is in no git repository/);
});

test("a plain skills directory of per-skill symlinks is followed entry by entry, and an unversioned entry is said", async () => {
  const home = join(root, "home2");
  mkdirSync(home);
  sh(home, ["init", "-q"]);
  commit(home, "skills/alpha/SKILL.md", "a", "alpha skill", DAY1);
  commit(home, "skills/beta/SKILL.md", "b", "beta skill", DAY2);
  const loose = join(root, "loose-skill");
  mkdirSync(loose);
  writeFileSync(join(loose, "SKILL.md"), "l");
  const cfg = join(root, "cfg2");
  mkdirSync(join(cfg, "skills"), { recursive: true });                  // a real directory, not a symlink
  symlinkSync(join(home, "skills", "alpha"), join(cfg, "skills", "alpha"));
  symlinkSync(join(home, "skills", "beta"), join(cfg, "skills", "beta"));
  symlinkSync(loose, join(cfg, "skills", "loose"));
  const plain = join(root, "plain2");
  mkdirSync(plain);
  const { markers, absent } = await instructionMarkers(plain, (DAY1 - 86_400) * 1000, { configDir: cfg, repo: "p" });
  assert.deepEqual(markers.filter((m) => m.kind === "instructions").map((m) => m.label).sort(), ["alpha skill", "beta skill"]);
  assert.ok(absent.some((a) => /1 of 3 entries in .*skills are in no git repository/.test(a)), JSON.stringify(absent));
  assert.ok(!absent.some((a) => /^[^ ]*skills is in no git repository/.test(a)));
});

test("a git failure that is not 'not a git repository' says could not be read, never 'no git repository'", async () => {
  const cfg = join(root, "cfg3");
  mkdirSync(cfg, { recursive: true });
  const real = join(root, "cfg3-real");
  mkdirSync(real);
  sh(real, ["init", "-q"]);
  commit(real, "CLAUDE.md", "g", "g", DAY1);
  symlinkSync(join(real, "CLAUDE.md"), join(cfg, "CLAUDE.md"));
  const prev = process.env.PATH;
  process.env.PATH = "/nonexistent";                                    // git cannot even start
  try {
    const { absent } = await instructionMarkers(real, 0, { configDir: cfg, repo: "r" });
    assert.ok(absent.length >= 1 && absent.every((a) => /could not be read/.test(a)), JSON.stringify(absent));
  } finally { process.env.PATH = prev; }
});

test("a directory outside git is a sentence, not markers", async () => {
  const plain = join(root, "plain");
  mkdirSync(plain);
  const { markers, absent } = await instructionMarkers(plain, 0, { configDir: join(root, "nocfg") });
  assert.deepEqual(markers, []);
  assert.match(absent[0], /plain is not a git repository/);
});

test("switch markers read the save log: this repo plus host-wide, torn lines and a missing file tolerated", async () => {
  const t = Date.UTC(2026, 9, 5, 10);
  const iso = (ms) => new Date(ms).toISOString();
  const ch = (kind, id, from, to) => ({ kind, id, from, to });
  const file = join(root, "skillswitch-log.jsonl");
  writeFileSync(file, [
    JSON.stringify({ ts: iso(t), repoId: "r1", changes: [ch("plugin", "a", "on", "off"), ch("plugin", "b", "on", "off"), ch("plugin", "c", "on", "off"), ch("skill", "s", "off", "on")], listingCharsBefore: 5000, listingCharsAfter: 4200 }),
    "{not json",
    JSON.stringify({ ts: iso(t + 1000), repoId: null, changes: [ch("skill", "g", "on", "off")] }),
    JSON.stringify({ ts: iso(t + 2000), repoId: "other", changes: [ch("skill", "x", "on", "off")] }),
    JSON.stringify({ ts: iso(t - 86_400_000 * 40), repoId: "r1", changes: [ch("skill", "old", "on", "off")] }),
    "",
  ].join("\n"));
  const entries = await readSwitchLog(file);
  assert.equal(entries.length, 4);
  const m = switchMarkers(entries, t - 86_400_000, { repoId: "r1", repo: "demo" });
  assert.equal(m.length, 2); // repo-scoped and all-repos are different folds
  const mine = m.find((x) => x.repo === "demo");
  assert.equal(mine.label, "Skills switch: 3 plugins off, 1 skill on");
  assert.match(mine.detail, /plugin a on \u2192 off/);
  assert.match(mine.detail, /about \u2212800 chars \(estimated by the skills screen, not measured\)/);
  const all = m.find((x) => x.repo === undefined);
  assert.equal(all.label, "Skills switch (all repos): 1 skill off");
  assert.ok(!/estimated/.test(all.detail));
  assert.deepEqual(await readSwitchLog(join(root, "nope.jsonl")), []);
});
