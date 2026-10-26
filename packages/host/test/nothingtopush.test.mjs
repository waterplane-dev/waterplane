// What clears a failed push the host did not see fixed: `nothingToPush` is
// true only once every local commit is on the upstream — however it got
// there — and never a made-up yes when there is no upstream to compare with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nothingToPush } from "../dist/git.js";

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, stdio: "pipe" }).toString();
function commit(cwd, name) {
  writeFileSync(join(cwd, name), name);
  g(cwd, "add", name);
  g(cwd, "commit", "-m", `add ${name}`);
}

test("a commit waiting to go up is something to push; pushed from a terminal, it is not", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-nothingtopush-"));
  try {
    const bare = join(root, "origin.git"), a = join(root, "a");
    g(root, "init", "--bare", "-b", "main", bare);
    g(root, "clone", bare, a);
    g(a, "checkout", "-b", "main");
    commit(a, "one");
    g(a, "push", "-u", "origin", "main");
    assert.equal(await nothingToPush(a), true);
    commit(a, "two");
    assert.equal(await nothingToPush(a), false, "the commit a failed push was carrying");
    g(a, "push");
    assert.equal(await nothingToPush(a), true, "pushed outside the host — the failure is moot");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no upstream is unknown, never “nothing to push”", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-nothingtopush-"));
  try {
    g(root, "init", "-b", "main");
    commit(root, "one");
    assert.equal(await nothingToPush(root), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
