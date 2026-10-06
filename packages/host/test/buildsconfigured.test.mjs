/**
 * The `builds-configured` setup row and its fix: a buildable repo with no builds.json warns and
 * the fix writes the file from `buildscan`; an existing file passes and is never overwritten;
 * a repo with nothing buildable has no row (absent, not an agent remedy: there is nothing to
 * configure); an unparsable file is a fix-less warn, an agent's job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRAND } from "@waterplane/shared";

const { inspectRepo, fixRepoCompliance } = await import("../dist/compliance.js");
const { CORE_FIX_IDS } = await import("../dist/plugins/pluginregistry.js");

function repo(files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "builds-cfg-")));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}
const GRADLE = { "app/build.gradle": "plugins { id 'com.android.application' }\n", "gradlew": "#!/bin/sh\n" };
const target = (dir) => ({ id: "t", repoName: "demo", branch: "main", isPrimary: true, worktreePath: dir, outboxCount: 0, changedCount: 0 });
const row = (dir) => inspectRepo(dir).find((c) => c.id === "builds-configured");
const file = (dir) => join(dir, BRAND.stateDirName, "builds.json");

test("the fix id is a core id", () => assert.ok(CORE_FIX_IDS.includes("builds-configured")));

test("gradle repo without builds.json: warn naming what was found; the fix writes the file; then pass", () => {
  const dir = repo(GRADLE);
  const r = row(dir);
  assert.equal(r?.status, "warn");
  assert.equal(r.fix, "builds-configured");
  assert.match(r.detail, /app\/build\.gradle/);

  const out = fixRepoCompliance(target(dir), ["builds-configured"]);
  assert.ok(out.ok, out.error);
  assert.deepEqual(out.applied, ["builds-configured"]);
  const list = JSON.parse(readFileSync(file(dir), "utf8"));
  assert.ok(Array.isArray(list) && list.length > 0);
  assert.ok(list.every((b) => b.cmd && b.name && b.id));
  assert.ok(list.some((b) => /gradle(w)? assembleDebug$/.test(b.cmd) &&b.dir === "app"));
  assert.equal(row(dir).status, "pass");
});

test("with a parsable builds.json: pass, and the fix never overwrites it", () => {
  const dir = repo(GRADLE);
  mkdirSync(join(dir, BRAND.stateDirName), { recursive: true });
  const mine = '[{"id":"mine","name":"Mine","cmd":"echo hi"}]';
  writeFileSync(file(dir), mine);
  assert.equal(row(dir).status, "pass");
  const out = fixRepoCompliance(target(dir), ["builds-configured"]);
  assert.deepEqual(out.applied, []);
  assert.equal(readFileSync(file(dir), "utf8"), mine);
});

test("an unparsable builds.json: warn with no fix (an agent's job), file untouched even if the fix is forced", () => {
  const dir = repo(GRADLE);
  mkdirSync(join(dir, BRAND.stateDirName), { recursive: true });
  writeFileSync(file(dir), "{ not json");
  const r = row(dir);
  assert.equal(r.status, "warn");
  assert.equal(r.fix, null);
  fixRepoCompliance(target(dir), ["builds-configured"]);
  assert.equal(readFileSync(file(dir), "utf8"), "{ not json");
});

test("nothing buildable: no row at all, and a forced fix writes nothing", () => {
  const dir = repo({ "README.md": "hello\n" });
  assert.equal(row(dir), undefined);
  const out = fixRepoCompliance(target(dir), ["builds-configured"]);
  assert.deepEqual(out.applied, []);
  assert.ok(!existsSync(file(dir)));
});
