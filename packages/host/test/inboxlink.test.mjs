/**
 * A cloned repo can COMMIT `.claude/inbox -> ~/.ssh` (or `.env -> somewhere`).
 * Nothing the phone does may then read, write or delete through that link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = await import("../dist/files.js");
const { setSecret } = await import("../dist/secrets.js");

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

for (const sub of ["inbox", "outbox"]) {
  test(`${sub} linked outside the worktree is refused everywhere`, () => {
    const wt = tmp("wp-link-wt-");
    const out = tmp("wp-link-out-");
    writeFileSync(join(out, "victim.txt"), "keep");
    mkdirSync(join(wt, ".claude"));
    symlinkSync(out, join(wt, ".claude", sub));
    if (sub === "inbox") {
      const r = files.saveInboxFile(wt, "a.txt", Buffer.from("x"));
      assert.deepEqual(r, { error: "inbox is not a plain folder in this repo" });
      assert.deepEqual(files.listInbox(wt), []);
      assert.equal(files.deleteInboxFile(wt, "victim.txt"), false);
      files.markInboxSeen(wt);
    } else {
      assert.throws(() => files.newOutboxPath(wt, "shot", ".png"), /not a plain folder/);
      files.markOutboxSeen(wt);
      assert.equal(files.countOutbox(wt), 0);
      assert.deepEqual(files.listTransport(wt, "outbox"), []);
    }
    assert.deepEqual(readdirSync(out), ["victim.txt"]);
    assert.equal(readFileSync(join(out, "victim.txt"), "utf8"), "keep");
  });
}

test("plain inbox and outbox still work", () => {
  const wt = tmp("wp-plain-wt-");
  const r = files.saveInboxFile(wt, "a.txt", Buffer.from("x"));
  assert.equal(r.name, "a.txt");
  assert.equal(files.listInbox(wt).length, 1);
  assert.equal(files.deleteInboxFile(wt, "a.txt"), true);
  const o = files.newOutboxPath(wt, "shot", ".png");
  writeFileSync(o.full, "p");
  assert.equal(existsSync(o.full), true);
});

test("an in-repo link for the inbox keeps working", () => {
  const wt = tmp("wp-inrepo-wt-");
  mkdirSync(join(wt, "real"));
  mkdirSync(join(wt, ".claude"));
  symlinkSync(join(wt, "real"), join(wt, ".claude", "inbox"));
  assert.equal(files.saveInboxFile(wt, "a.txt", Buffer.from("x")).name, "a.txt");
});

test("setSecret refuses a .env that is a link and leaves its target untouched", () => {
  const wt = tmp("wp-env-wt-");
  const out = tmp("wp-env-out-");
  execFileSync("git", ["init", "-q"], { cwd: wt });
  writeFileSync(join(out, "target"), "A=1\n");
  symlinkSync(join(out, "target"), join(wt, ".env"));
  const r = setSecret({ root: wt, scope: "repo", worktree: wt, file: ".env", key: "K", value: "v" });
  assert.deepEqual(r, { ok: false, error: ".env is a link, not a file" });
  assert.equal(readFileSync(join(out, "target"), "utf8"), "A=1\n");
});
