// The history behind the git sheet's ↑N ↓M: incoming only appears after a
// fetch, the three lists are disjoint, and a tapped row's `sha` is never an
// option `git show` would act on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitFetch, gitLog, gitShow } from "../dist/gitlog.js";

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, stdio: "pipe" }).toString();
function commit(cwd, name) {
  writeFileSync(join(cwd, name), name);
  g(cwd, "add", name);
  g(cwd, "commit", "-m", `add ${name}`);
}

test("incoming waits for a fetch; outgoing, incoming and shared are disjoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-gitlog-"));
  try {
    const bare = join(root, "origin.git"), a = join(root, "a"), b = join(root, "b");
    g(root, "init", "--bare", "-b", "main", bare);
    g(root, "clone", bare, a);
    g(a, "checkout", "-b", "main");
    commit(a, "one"); commit(a, "two");
    g(a, "push", "-u", "origin", "main");
    g(root, "clone", bare, b);
    commit(b, "theirs"); g(b, "push");
    commit(a, "mine");

    let l = await gitLog(a);
    assert.equal(l.upstream, "origin/main");
    assert.equal(l.outgoingTotal, 1);
    assert.equal(l.incomingTotal, 0, "nothing incoming before a fetch");
    assert.deepEqual(l.shared.map((c) => c.subject), ["add two", "add one"]);

    assert.deepEqual(await gitFetch(a), { ok: true });
    l = await gitLog(a);
    assert.deepEqual(l.incoming.map((c) => c.subject), ["add theirs"]);
    assert.deepEqual(l.outgoing.map((c) => c.subject), ["add mine"]);
    assert.ok(l.fetchedAt && Date.now() - l.fetchedAt < 60_000);
    assert.match(await gitShow(a, l.outgoing[0].short), /add mine[\s\S]*mine \| 1 \+/);
    assert.equal(await gitShow(a, "--output=/tmp/x"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no upstream: own history, fetch refused in words", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-gitlog-"));
  try {
    g(root, "init", "-b", "main");
    commit(root, "solo");
    const l = await gitLog(root);
    assert.equal(l.upstream, undefined);
    assert.equal(l.outgoingTotal, 0);
    assert.deepEqual(l.shared.map((c) => c.subject), ["add solo"]);
    const f = await gitFetch(root);
    assert.equal(f.ok, false);
    assert.match(f.error, /no upstream/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
