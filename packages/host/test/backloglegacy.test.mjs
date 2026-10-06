/**
 * A repo's backlog under a LEGACY state-dir name is still read after the
 * brand rename. Per-repo state dirs are never moved without a tap
 * (`branddirs.ts`), so a repo that still has `<old>/backlog.json` must have it
 * converted from there — reading only the current name would make that
 * backlog look empty after the restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, LEGACY } from "@waterplane/shared";

const { BacklogManager } = await import("../dist/backlog.js");
const { repoStateDir } = await import("../dist/branddirs.js");

test("a backlog.json under the legacy per-repo state dir is converted, and kept as .migrated", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "backloglegacy-")));
  const repo = join(root, "demo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const legacyDir = join(repo, LEGACY[0].stateDirName);
  mkdirSync(legacyDir);
  writeFileSync(join(legacyDir, "backlog.json"), JSON.stringify({ items: [{ id: "b1", prompt: "fix the flaky test" }] }));

  const seen = [];
  const intents = {
    kick: () => {}, emitChanged: () => {}, list: () => [],
    migrateFileAt: (src) => { seen.push(src); },
  };
  const reviews = { importAll: () => {} };
  const b = new BacklogManager(root, {}, intents, reviews);
  await b.init();

  assert.ok(seen.includes(join(legacyDir, "backlog.json")), `the legacy file was offered to the intent store: ${seen.join(", ")}`);
  assert.equal(repoStateDir(repo), legacyDir, "and the repo's state dir was not moved by reading it");
  assert.ok(!existsSync(join(repo, BRAND.stateDirName)));
  rmSync(root, { recursive: true, force: true });
});
