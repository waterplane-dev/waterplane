/**
 * The two builds files and the one list the phone sees.
 *
 * `<repo>/<shared dir>/builds.json` is committed with the repo; `<repo>/<state dir>/builds.json`
 * is this desktop's own. `list()` is shared then local, a local entry with a shared id replacing
 * it IN PLACE (a machine override, never a second button). `save()` partitions the whole list back:
 * the ids named in `local` go local, absent `local` an id stays where it lives and a new one goes
 * SHARED — and a file is written only when its content changes, because the shared one is in git
 * and a no-op save must not dirty the tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";

const { BuildManager, mergeBuilds, partitionBuilds } = await import("../dist/builds.js");

/** `list`/`save`/`localIds` never touch the intent store. */
const mgr = () => new BuildManager(/** @type {any} */ ({}));
const sharedFile = (d) => join(d, BRAND.sharedDirName, "builds.json");
const localFile = (d) => join(d, BRAND.stateDirName, "builds.json");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const put = (p, v) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(v)); };
const b = (id, cmd = `echo ${id}`) => ({ id, name: id.toUpperCase(), cmd });

function withRepo(fn) {
  const d = mkdtempSync(join(tmpdir(), `${BRAND.slug}-buildsmerge-`));
  try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
}

test("merge: shared then local; a local entry with a shared id replaces it in place", () => {
  const out = mergeBuilds([b("a"), b("b"), b("c")], [b("b", "local b"), b("z")]);
  assert.deepEqual(out.map((x) => x.id), ["a", "b", "c", "z"]);
  assert.equal(out[1].cmd, "local b");
});

test("partition: a shadowed shared entry is kept as it is; an id missing from the list is gone from both", () => {
  const p = partitionBuilds([b("a", "new a"), b("b", "override")], [b("a"), b("b"), b("gone")], [], ["b"]);
  assert.deepEqual(p.shared, [b("a", "new a"), b("b")]);
  assert.deepEqual(p.local, [b("b", "override")]);
});

test("list reads both files, local winning by id; localIds names only the local file's", () => withRepo((d) => {
  put(sharedFile(d), [b("release"), b("debug")]);
  put(localFile(d), [b("debug", "JAVA_HOME=/x ./gradlew assembleDebug"), b("mine")]);
  const m = mgr();
  const list = m.list(d);
  assert.deepEqual(list.map((x) => x.id), ["release", "debug", "mine"]);
  assert.match(list[1].cmd, /^JAVA_HOME=/);
  assert.deepEqual(m.localIds(d), ["debug", "mine"]);
}));

test("save without `local`: a new entry goes SHARED, an existing local one stays local", () => withRepo((d) => {
  put(localFile(d), [b("mine")]);
  const m = mgr();
  const out = m.save(d, [b("mine", "edited"), b("fresh")]);
  assert.deepEqual(out.map((x) => x.id), ["fresh", "mine"]);
  assert.deepEqual(read(sharedFile(d)), [b("fresh")]);
  assert.deepEqual(read(localFile(d)), [b("mine", "edited")]);
}));

test("save with `local`: entries move between files as named; an emptied local file is deleted", () => withRepo((d) => {
  const m = mgr();
  m.save(d, [b("a"), b("b")], ["b"]);
  assert.deepEqual(read(sharedFile(d)), [b("a")]);
  assert.deepEqual(read(localFile(d)), [b("b")]);
  m.save(d, [b("a"), b("b")], []);
  assert.deepEqual(read(sharedFile(d)), [b("a"), b("b")]);
  assert.ok(!existsSync(localFile(d)), "an emptied local file is removed");
}));

test("a local override of a shared id never edits the shared file", () => withRepo((d) => {
  put(sharedFile(d), [b("release")]);
  const before = readFileSync(sharedFile(d), "utf8");
  const m = mgr();
  m.save(d, [b("release", "JAVA_HOME=/x ./gradlew assembleRelease")], ["release"]);
  assert.equal(readFileSync(sharedFile(d), "utf8"), before);
  assert.equal(m.list(d)[0].cmd, "JAVA_HOME=/x ./gradlew assembleRelease");
}));

test("a no-op save writes nothing — not even the same bytes", () => withRepo((d) => {
  put(sharedFile(d), [b("a"), b("b")]);
  put(localFile(d), [b("c")]);
  const sharedBefore = readFileSync(sharedFile(d), "utf8");
  // Backdated, so a rewrite would show as a newer mtime.
  const t = (Date.now() - 3600_000) / 1000;
  for (const p of [sharedFile(d), localFile(d)]) utimesSync(p, t, t);
  const ms = () => [statSync(sharedFile(d)).mtimeMs, statSync(localFile(d)).mtimeMs];
  const before = ms();
  const m = mgr();
  m.save(d, m.list(d));
  m.save(d, m.list(d), m.localIds(d));
  assert.deepEqual(ms(), before);
  assert.equal(readFileSync(sharedFile(d), "utf8"), sharedBefore, "the shared file is left byte-for-byte");
}));

test("no shared file is created to hold nothing, and an unreadable file is never overwritten", () => withRepo((d) => {
  const m = mgr();
  m.save(d, [b("a")], ["a"]);
  assert.ok(!existsSync(sharedFile(d)));
  mkdirSync(join(d, BRAND.sharedDirName), { recursive: true });
  writeFileSync(sharedFile(d), "{ half an edit");
  m.save(d, [b("a"), b("new")], ["a"]);
  assert.equal(readFileSync(sharedFile(d), "utf8"), "{ half an edit");
}));

