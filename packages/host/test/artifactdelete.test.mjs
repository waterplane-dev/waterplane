/**
 * `deleteArtifact` — the only DELETE the phone can aim at a worktree.
 *
 * Its whole safety argument is one sentence in its own doc comment: "restricted
 * to the inbox + outbox dirs so the phone can't delete arbitrary repo files".
 * That sentence was false. The prefix test was made on the STRING the client
 * sent, so `.claude/inbox/../../src/main.ts` starts with the inbox, and
 * `contained()` — which refuses an escape from the WORKTREE, and that path
 * never leaves it — waved it through.
 *
 * Pinned here rather than in e2e because the failure is silent and one-way: a
 * deleted source file produces no error anywhere, and by the time anyone
 * notices, the request that did it is long gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { deleteArtifact } = await import("../dist/files.js");

/** A worktree with one file in the inbox, one in the outbox, and one in src. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-del-"));
  mkdirSync(join(dir, ".claude/inbox"), { recursive: true });
  mkdirSync(join(dir, ".claude/outbox"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, ".claude/inbox/shot.png"), "png");
  writeFileSync(join(dir, ".claude/outbox/report.md"), "md");
  writeFileSync(join(dir, "src/main.ts"), "source");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  return dir;
}

test("an inbox or outbox file is deletable — the feature still works", () => {
  const dir = repo();
  try {
    assert.equal(deleteArtifact(dir, ".claude/inbox/shot.png"), true);
    assert.equal(existsSync(join(dir, ".claude/inbox/shot.png")), false);
    assert.equal(deleteArtifact(dir, ".claude/outbox/report.md"), true);
    assert.equal(existsSync(join(dir, ".claude/outbox/report.md")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a path that traverses OUT of the inbox is refused, and deletes nothing", () => {
  const dir = repo();
  try {
    // The bug: each of these passes a `startsWith(".claude/inbox/")` test and
    // resolves to a real file inside the worktree.
    for (const rel of [
      ".claude/inbox/../../src/main.ts",
      ".claude/inbox/../../.env",
      ".claude/outbox/../../src/main.ts",
      ".claude/inbox/./../../src/main.ts",
      ".claude\\..\\..\\src\\main.ts",
    ]) {
      assert.equal(deleteArtifact(dir, rel), false, rel);
    }
    assert.equal(existsSync(join(dir, "src/main.ts")), true);
    assert.equal(existsSync(join(dir, ".env")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a sibling directory whose name merely STARTS with an allowed root is not inside it", () => {
  const dir = repo();
  try {
    // `.claude/inboxes/` is not `.claude/inbox/`. A prefix compare without the
    // separator says otherwise, which is the same class of bug one level down.
    mkdirSync(join(dir, ".claude/inboxes"), { recursive: true });
    writeFileSync(join(dir, ".claude/inboxes/keep.txt"), "keep");
    assert.equal(deleteArtifact(dir, ".claude/inboxes/keep.txt"), false);
    assert.equal(existsSync(join(dir, ".claude/inboxes/keep.txt")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a path that leaves the worktree entirely is still refused", () => {
  const dir = repo();
  try {
    assert.equal(deleteArtifact(dir, ".claude/inbox/../../../../../../etc/hosts"), false);
    assert.equal(deleteArtifact(dir, "/etc/hosts"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a directory is not a file — the inbox itself is not deletable", () => {
  const dir = repo();
  try {
    assert.equal(deleteArtifact(dir, ".claude/inbox"), false);
    assert.equal(existsSync(join(dir, ".claude/inbox")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
