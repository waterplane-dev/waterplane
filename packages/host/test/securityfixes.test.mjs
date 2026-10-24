/** Symlink containment on file reads/writes, transcriptPath ids, git checkout `--`, PowerShell quoting. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { containedReal } from "../dist/paths.js";
import { readInTree, statInTree, resolveInTree, discoverArtifacts, discoverArtifactsAsync } from "../dist/files.js";
import { readTreeFile, writeTreeFile, listDir, searchTree } from "../dist/tree.js";
import { writeTextAtomicKeepMode } from "../dist/jsonstore.js";
import { readTextFile, gitCheckout } from "../dist/git.js";
import { transcriptPath } from "../dist/transcript/transcriptlog.js";
import { psQuote } from "../dist/ocrlocal.js";

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wp-sec-")));
  const wt = join(base, "wt"); const out = join(base, "outside");
  mkdirSync(wt); mkdirSync(out); mkdirSync(join(wt, "sub"));
  writeFileSync(join(out, "secret.txt"), "TOPSECRET");
  writeFileSync(join(wt, "sub", "real.txt"), "hello");
  symlinkSync(join(out, "secret.txt"), join(wt, "evil"));
  symlinkSync(out, join(wt, "evildir"));
  symlinkSync(join(wt, "sub", "real.txt"), join(wt, "good"));
  return { base, wt, out };
}

test("a symlink out of the worktree is refused by every read and write helper; in-repo links work", async (t) => {
  const { base, wt, out } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(containedReal(wt, "evil"), null);
  assert.equal(containedReal(wt, "evildir/secret.txt"), null);
  assert.equal(containedReal(wt, "nothere.txt"), join(wt, "nothere.txt"));
  assert.ok(containedReal(wt, "good"));
  assert.equal(resolveInTree(wt, "evil"), null);
  assert.equal(statInTree(wt, "evil", { anyType: true }), null);
  assert.equal(readInTree(wt, "evildir/secret.txt", { anyType: true }), null);
  assert.equal(readTreeFile(wt, "evil"), null);
  assert.equal(await readTextFile(wt, "evil"), null);
  const w = writeTreeFile(wt, "evil", "x", "deadbeef");
  assert.equal(w.ok, false);
  assert.equal(w.code, "refused");
  assert.ok(readTreeFile(wt, "good"));
  assert.equal(await readTextFile(wt, "good"), "hello");
});

test("transcriptPath never builds a path out of a non-id", () => {
  const ok = transcriptPath("/tmp/x", "abc-123_DEF");
  assert.ok(ok.endsWith("abc-123_DEF.jsonl"));
  for (const bad of ["../../x", "a/b", "", "..", "x\0y"]) {
    const p = transcriptPath("/tmp/x", bad);
    assert.ok(!p.includes(".."), bad);
    assert.ok(p.endsWith("invalid-conversation-id.jsonl"), bad);
  }
});

test("gitCheckout of a name that is also a tracked path switches branch, not the file", async (t) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "wp-co-")));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "a@b.c"); g("config", "user.name", "t");
  writeFileSync(join(d, "foo"), "committed");
  g("add", "foo"); g("commit", "-qm", "i");
  g("branch", "foo");
  writeFileSync(join(d, "foo"), "dirty");
  const r = await gitCheckout(d, "foo");
  assert.equal(r.ok, true, r.error);
  assert.equal(g("rev-parse", "--abbrev-ref", "HEAD").trim(), "foo");
  const bad = await gitCheckout(d, "nope");
  assert.equal(bad.ok, false);
});

test("psQuote doubles every character PowerShell reads as a single quote", () => {
  assert.equal(psQuote("a'b"), "'a''b'");
  for (const q of ["‘", "’", "‚", "‛"]) assert.equal(psQuote(`x${q}y`), `'x${q}${q}y'`);
});

test("containedReal refuses a not-yet-existing target under a symlinked dir that leaves the tree", (t) => {
  const { base, wt } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(containedReal(wt, "evildir/new.txt"), null);
  assert.equal(containedReal(wt, "evildir/deeper/new.txt"), null);
  assert.equal(containedReal(wt, "sub/new.txt"), join(wt, "sub", "new.txt"));
  assert.equal(containedReal(wt, "nodir/new.txt"), join(wt, "nodir", "new.txt"));
});

test("rateKey keys on X-Forwarded-For only for a loopback socket with a proxy header", async () => {
  const { rateKey } = await import("../dist/ratelimit.js");
  const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
  assert.equal(rateKey(req("127.0.0.1")), "127.0.0.1");
  assert.equal(rateKey(req("127.0.0.1", { "x-forwarded-for": "100.64.1.2" })), "100.64.1.2");
  assert.equal(rateKey(req("::ffff:127.0.0.1", { "x-forwarded-for": "evil, 100.64.1.9" })), "100.64.1.9");
  assert.equal(rateKey(req("127.0.0.1", { "x-forwarded-for": "not-an-ip" })), "127.0.0.1");
  assert.equal(rateKey(req("127.0.0.1", { "tailscale-user-login": "a@b" })), "127.0.0.1");
  assert.equal(rateKey(req("192.168.1.5", { "x-forwarded-for": "100.64.1.2" })), "192.168.1.5");
});

test("a funnel request on loopback is refused by /api/peer/hello before any token is tried", async () => {
  const { handlePeerRoutes } = await import("../dist/peers/routes.js");
  const run = async (headers) => {
    let tried = 0, reply = null;
    const deps = {
      canManage: (k) => k === "loopback" || k === "tailscale",
      json: (_r, body, status = 200) => { reply = { status, body }; },
      readJson: async () => ({}),
      warn: () => {},
      store: { authenticate: () => { tried++; return null; } },
    };
    const req = { method: "GET", headers: { authorization: "Bearer abc", ...headers }, socket: { remoteAddress: "127.0.0.1" } };
    await handlePeerRoutes(req, {}, "/api/peer/hello", new URL("http://x/api/peer/hello"), deps);
    return { tried, reply };
  };
  const funnel = await run({ "tailscale-funnel-request": "?1" });
  assert.equal(funnel.tried, 0, "a funnel request must not reach the peer-token check");
  assert.equal(funnel.reply.status, 403);
  assert.equal((await run({})).tried, 1, "a plain loopback request still may try a token");
});

test("writeTextAtomicKeepMode: a link that leaves `within` is refused in words and its target untouched; in-tree links are written through; a new file is made", (t) => {
  const { base, wt, out } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // `evil -> outside/secret.txt`: the shape of a committed `.gitignore -> ~/.gitconfig`.
  assert.throws(() => writeTextAtomicKeepMode(join(wt, "evil"), "pwned\n", wt), /link out of the repo/);
  assert.equal(readFileSync(join(out, "secret.txt"), "utf8"), "TOPSECRET");
  // `good -> sub/real.txt` stays a link and its target gets the bytes.
  writeTextAtomicKeepMode(join(wt, "good"), "changed\n", wt);
  assert.equal(readFileSync(join(wt, "sub", "real.txt"), "utf8"), "changed\n");
  assert.ok(lstatSync(join(wt, "good")).isSymbolicLink());
  writeTextAtomicKeepMode(join(wt, "fresh.txt"), "new\n", wt);
  assert.equal(readFileSync(join(wt, "fresh.txt"), "utf8"), "new\n");
  // Without `within` (a path the caller already contained) the old behaviour stands.
  writeTextAtomicKeepMode(join(wt, "sub", "real.txt"), "again\n");
  assert.equal(readFileSync(join(wt, "sub", "real.txt"), "utf8"), "again\n");
});

test("repo walks neither descend into nor list a link that leaves the worktree; in-tree files are found", async (t) => {
  const { base, wt, out } = fixture();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(out, "pic.png"), "png");
  writeFileSync(join(wt, "sub", "mine.png"), "png");
  // `evildir -> outside`: a committed `docs/home -> ~`.
  const found = await searchTree(wt, "", "secret");
  assert.deepEqual(found.entries.map((e) => e.path), [], "the search does not walk the link");
  assert.deepEqual((await searchTree(wt, "", "mine")).entries.map((e) => e.path), ["sub/mine.png"]);
  const syncWalk = discoverArtifacts(wt, { scope: "repo", kind: "image" }).files.map((f) => f.relPath).sort();
  assert.deepEqual(syncWalk, ["sub/mine.png"]);
  const asyncWalk = (await discoverArtifactsAsync(wt, { scope: "repo", kind: "image" })).files.map((f) => f.relPath).sort();
  assert.deepEqual(asyncWalk, ["sub/mine.png"]);
  const listing = await listDir(wt, "");
  const evildir = listing.entries.find((e) => e.name === "evildir");
  assert.equal(evildir?.link, true, "the link is still shown as a link");
  assert.equal(evildir.dir, false);
  assert.equal(evildir.count, undefined, "its target's entries are not counted");
  assert.equal(listing.entries.find((e) => e.name === "evil")?.size, 0, "a linked-out file reports no size");
});
