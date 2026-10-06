/**
 * The setup row for a per-repo state dir still under a legacy brand name, and
 * its fix. Per-repo dirs are never moved without a tap (`branddirs.ts`), so this
 * row is the only way one moves: a warn while the legacy dir is there, a fix
 * that renames it, ignores the new name (and the symlink left at the old one),
 * and never offers itself when git tracks files under the legacy dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, LEGACY } from "@waterplane/shared";

const { inspectRepo, fixRepoCompliance } = await import("../dist/compliance.js");

const OLD = LEGACY[0].stateDirName;
const NEW = BRAND.stateDirName;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "statedir-")));
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), `${OLD}/\n`);
  mkdirSync(join(dir, OLD));
  writeFileSync(join(dir, OLD, "builds.json"), "[]");
  return dir;
}
const target = (dir) => ({ id: "t", repoName: "demo", branch: "main", isPrimary: true, worktreePath: dir, outboxCount: 0, changedCount: 0 });
const row = (dir) => inspectRepo(dir).find((c) => c.id === "state-dir");

test("a legacy state dir is a warn with a fix; the fix renames it and ignores both names", () => {
  const dir = repo();
  const r = row(dir);
  assert.equal(r?.status, "warn");
  assert.equal(r.fix, "state-dir");

  const out = fixRepoCompliance(target(dir), ["state-dir"]);
  assert.ok(out.ok, out.error);
  assert.deepEqual(out.applied, ["state-dir"]);
  assert.equal(readFileSync(join(dir, NEW, "builds.json"), "utf8"), "[]", "the file moved with its dir");
  assert.ok(lstatSync(join(dir, OLD)).isSymbolicLink(), "a symlink stands at the old name");
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.match(gi, new RegExp(`^${NEW.replace(".", "\\.")}$`, "m"), "the new name is ignored");
  assert.match(gi, new RegExp(`^${OLD.replace(".", "\\.")}$`, "m"), "and the symlink at the old one (a dir/ pattern misses it)");
  assert.ok(gi.startsWith(`${OLD}/\n`), "lines are only ever ADDED");
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  assert.doesNotMatch(status, new RegExp(`${NEW.replace(".", "\\.")}|${OLD.replace(".", "\\.")}`), "nothing new shows as untracked");

  assert.equal(row(dir), undefined, "the row is gone once the dir moved");
  const again = fixRepoCompliance(target(dir), ["state-dir"]);
  assert.deepEqual(again.applied, [], "a second tap changes nothing");
});

test("a legacy dir git tracks files in is reported but never offered a fix", () => {
  const dir = repo();
  writeFileSync(join(dir, ".gitignore"), "");
  git(dir, "add", join(OLD, "builds.json"));
  const r = row(dir);
  assert.equal(r?.status, "warn");
  assert.equal(r.fix, null);
  const out = fixRepoCompliance(target(dir), ["state-dir"]);
  assert.deepEqual(out.applied, []);
  assert.ok(existsSync(join(dir, OLD, "builds.json")) && !existsSync(join(dir, NEW)), "nothing moved");
});

test("a repo already on the current name has no row", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "statedir-new-")));
  git(dir, "init", "-q");
  mkdirSync(join(dir, NEW));
  assert.equal(row(dir), undefined);
});
