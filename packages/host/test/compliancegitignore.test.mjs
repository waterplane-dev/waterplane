/**
 * The "inbox/outbox gitignored" row and its fix must agree. The row asks
 * `git check-ignore` about the bare paths; a `.claude/inbox/` line does not
 * match while the dir is absent, so the row fails — and the fix used to read
 * that same line as "already covered" and write nothing, leaving a fix button
 * that did nothing forever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { inspectRepo, fixRepoCompliance } = await import("../dist/compliance.js");

const target = (dir) => ({ id: "t", repoName: "demo", branch: "main", isPrimary: true, worktreePath: dir, outboxCount: 0, changedCount: 0 });
const row = (dir) => inspectRepo(dir).find((c) => c.id === "gitignore-transport");

test("trailing-slash lines for absent dirs: the fix adds bare paths and the row passes", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gitignore-")));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, ".gitignore"), ".claude/outbox/\n.claude/inbox/\n.outbox/\n");
  assert.equal(row(dir)?.status, "fail");

  const out = fixRepoCompliance(target(dir), ["gitignore"]);
  assert.ok(out.ok, out.error);
  assert.deepEqual(out.applied, ["gitignore"]);
  assert.ok(readFileSync(join(dir, ".gitignore"), "utf8").startsWith(".claude/outbox/\n"), "lines are only ever ADDED");
  assert.equal(row(dir)?.status, "pass", "the row the fix was offered on now passes");

  const again = fixRepoCompliance(target(dir), ["gitignore"]);
  assert.deepEqual(again.applied, [], "a second tap changes nothing");
});
