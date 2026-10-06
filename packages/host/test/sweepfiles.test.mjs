/**
 * The bulk half of clearing a transport directory: `listTransport` (what is in
 * there) and `sweepTransport` (delete exactly these paths).
 *
 * `artifactdelete.test.mjs` pins the one-file guard. This pins the two things
 * the BULK path adds on top of it, both of which are silent when wrong:
 *
 *  - **A sweep lists more than the gallery does.** `discoverArtifacts` filters
 *    by extension because it answers "what can the phone paint". A cleanup that
 *    inherited that filter would report a directory clean while leaving every
 *    `.zip` and `.log` in it — bytes the reader was told were gone.
 *  - **"Already gone" is not "could not be removed".** The first is the sweep
 *    succeeding by another route; the second is bytes still on disk under a
 *    message that says done. They were the same outcome once, because
 *    `resolveInTree` folds "escapes the tree" and "is not there" into one null.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, symlinkSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { listTransport, sweepTransport } = await import("../dist/files.js");

const DAY = 86_400;

/** A worktree with both transport directories populated, plus a source file
 *  and a `.seen` marker that must survive every sweep. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-sweep-"));
  mkdirSync(join(dir, ".claude/inbox"), { recursive: true });
  mkdirSync(join(dir, ".claude/outbox/nested"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, ".claude/outbox/report.md"), "md");
  writeFileSync(join(dir, ".claude/outbox/build.zip"), "zipzip");      // not paintable
  writeFileSync(join(dir, ".claude/outbox/run.log"), "log");           // not paintable
  writeFileSync(join(dir, ".claude/outbox/nested/deep.png"), "png");   // one level down
  writeFileSync(join(dir, ".claude/outbox/.seen"), "");                // bookkeeping
  writeFileSync(join(dir, ".claude/inbox/shot.png"), "png");
  writeFileSync(join(dir, "src/main.ts"), "source");
  return dir;
}

/** Backdate a file so an age cut can see it. */
function age(dir, rel, days) {
  const t = Date.now() / 1000 - days * DAY;
  utimesSync(join(dir, rel), t, t);
}

test("a sweep lists EVERY file in the transport dir, not the paintable subset", () => {
  const dir = repo();
  try {
    const rows = listTransport(dir, "outbox").map((r) => r.relPath).sort();
    // The `.zip` and the `.log` are the point: neither is a gallery artifact,
    // both are bytes.
    assert.deepEqual(rows, [
      ".claude/outbox/build.zip",
      ".claude/outbox/nested/deep.png",
      ".claude/outbox/report.md",
      ".claude/outbox/run.log",
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the .seen marker is never listed, so a sweep cannot un-read a repo", () => {
  const dir = repo();
  try {
    // Deleting it would silently reset the outbox badge to "everything is new".
    for (const scope of ["outbox", "inbox"]) {
      assert.ok(!listTransport(dir, scope).some((r) => r.name.startsWith(".")), scope);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the two directions are listed apart — an inbox sweep never sees the outbox", () => {
  const dir = repo();
  try {
    // The outbox is re-derivable (an agent wrote it); the inbox may hold the
    // only copy of a photo. Keeping them apart is the whole reason `scope` is
    // not a convenience.
    assert.deepEqual(listTransport(dir, "inbox").map((r) => r.relPath), [".claude/inbox/shot.png"]);
    assert.ok(!listTransport(dir, "outbox").some((r) => r.relPath.includes("/inbox/")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rows carry the size and mtime the plan is cut on, newest first", () => {
  const dir = repo();
  try {
    age(dir, ".claude/outbox/report.md", 100);
    age(dir, ".claude/outbox/run.log", 2);
    const rows = listTransport(dir, "outbox");
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].mtime >= rows[i].mtime);
    const zip = rows.find((r) => r.name === "build.zip");
    assert.equal(zip.size, 6);
    assert.ok(zip.mtime > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a sweep deletes exactly the paths it was given and reports the bytes", () => {
  const dir = repo();
  try {
    const res = sweepTransport(dir, [".claude/outbox/build.zip", ".claude/outbox/run.log"]);
    assert.deepEqual(res, { deleted: 2, bytes: 9, missing: [], failed: [] });
    assert.equal(existsSync(join(dir, ".claude/outbox/build.zip")), false);
    // Everything NOT named survives. A sweep that took an age and re-cut it
    // here could not promise this.
    assert.equal(existsSync(join(dir, ".claude/outbox/report.md")), true);
    assert.equal(existsSync(join(dir, ".claude/outbox/nested/deep.png")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a path already gone is MISSING; a path that escapes is FAILED", () => {
  const dir = repo();
  try {
    const res = sweepTransport(dir, [
      ".claude/outbox/report.md",              // deleted
      ".claude/outbox/never-was-here.png",     // missing — an agent got there first
      ".claude/outbox/../../src/main.ts",      // failed — refused by the guard
      "/etc/hosts",                            // failed — leaves the worktree
    ]);
    assert.equal(res.deleted, 1);
    assert.deepEqual(res.missing, [".claude/outbox/never-was-here.png"]);
    assert.deepEqual(res.failed, [".claude/outbox/../../src/main.ts", "/etc/hosts"]);
    // The refusals refused: this is `artifactdelete.test.mjs`'s guarantee,
    // re-asserted through the bulk path because that is the one reached with a
    // client-supplied LIST of paths.
    assert.equal(existsSync(join(dir, "src/main.ts")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bytes are read BEFORE the unlink, or the total is always zero", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, ".claude/outbox/big.bin"), "x".repeat(4096));
    const res = sweepTransport(dir, [".claude/outbox/big.bin"]);
    assert.equal(res.deleted, 1);
    assert.equal(res.bytes, 4096);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an empty path list is a no-op, not an error", () => {
  const dir = repo();
  try {
    assert.deepEqual(sweepTransport(dir, []), { deleted: 0, bytes: 0, missing: [], failed: [] });
    assert.equal(listTransport(dir, "outbox").length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing transport directory lists empty rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-sweep-bare-"));
  try {
    assert.deepEqual(listTransport(dir, "outbox"), []);
    assert.deepEqual(listTransport(dir, "inbox"), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a symlinked directory inside a transport dir is NOT walked", () => {
  // Planting one already needs code execution on this machine (DISCLAIMER.md
  // §1 owns that), but a bulk sweep would turn it into a bulk delete OUTSIDE
  // the worktree — `deleteArtifact`'s containment is lexical once resolved, so
  // the walk is where it has to be stopped.
  const dir = repo();
  const outside = mkdtempSync(join(tmpdir(), "waterplane-outside-"));
  try {
    writeFileSync(join(outside, "precious.md"), "do not delete");
    symlinkSync(outside, join(dir, ".claude/outbox/link"), "dir");
    const rows = listTransport(dir, "outbox").map((r) => r.relPath);
    assert.ok(!rows.some((p) => p.includes("link")), `walked the symlink: ${rows.join(", ")}`);
    assert.equal(existsSync(join(outside, "precious.md")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked FILE in a transport dir is skipped too", () => {
  const dir = repo();
  const outside = mkdtempSync(join(tmpdir(), "waterplane-outside2-"));
  try {
    writeFileSync(join(outside, "target.png"), "png");
    symlinkSync(join(outside, "target.png"), join(dir, ".claude/outbox/alias.png"));
    assert.ok(!listTransport(dir, "outbox").some((r) => r.name === "alias.png"));
    assert.equal(existsSync(join(outside, "target.png")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
