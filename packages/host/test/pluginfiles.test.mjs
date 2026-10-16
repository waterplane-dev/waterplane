// `api.offerFile` (plugin API 1.5, `plugins/pluginfiles.ts`): a file is offered only from inside the
// plugin's own dataDir (never a symlink, never a path for a name), served at an unguessable token, and
// DELETED by the core once a response delivered its last byte, at its TTL, or on withdraw — `onGone`
// says which. Plus the range arithmetic that decides "the last byte went out".
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PluginFiles, rangeLastByte } = await import("../dist/plugins/pluginfiles.js");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wp-offers-"));
  const data = join(root, "plugins", "demo");
  mkdirSync(data, { recursive: true });
  const file = join(data, "backup.kdbx");
  writeFileSync(file, Buffer.alloc(100, 7));
  return { root, data, file };
}

test("an offered file is served under its token and deleted once delivered, saying so", () => {
  const { data, file } = fixture();
  const books = new PluginFiles();
  const gone = [];
  const o = books.offer("demo", "demo", data, file, { name: "backup.kdbx", onGone: (w) => gone.push(w) });
  assert.match(o.path, /^\/api\/plugin-file\/demo\/[A-Za-z0-9_-]{32}$/);
  assert.equal(o.size, 100);
  const token = o.path.split("/").pop();
  const f = books.get("demo", token);
  assert.ok(f);
  assert.equal(f.name, "backup.kdbx");
  assert.equal(books.get("other", token), null, "another plugin's id never reaches it");
  assert.equal(books.get("demo", "x".repeat(32)), null, "an unknown token is gone");
  f.delivered();
  assert.equal(existsSync(file), false, "the core deleted the file");
  assert.deepEqual(gone, ["fetched"]);
  assert.equal(books.get("demo", token), null);
});

test("refused in words: outside dataDir, a symlink, a path for a name", () => {
  const { root, data, file } = fixture();
  const books = new PluginFiles();
  const outside = join(root, "elsewhere.txt");
  writeFileSync(outside, "x");
  assert.throws(() => books.offer("demo", "demo", data, outside, { name: "x.txt" }), /only files inside its own data directory/);
  const link = join(data, "link.txt");
  symlinkSync(outside, link);
  assert.throws(() => books.offer("demo", "demo", data, link, { name: "x.txt" }), /refuses a symlink/);
  assert.throws(() => books.offer("demo", "demo", data, file, { name: "../x" }), /plain file name/);
  assert.throws(() => books.offer("demo", "demo", data, file, { name: "a/b" }), /plain file name/);
  assert.throws(() => books.offer("demo", "demo", data, join(data, "missing"), { name: "m" }), /does not exist/);
  assert.equal(books.count(), 0);
});

test("the TTL ends an offer and deletes the file; withdraw and dropPlugin do too", () => {
  const { data, file } = fixture();
  let now = 1000;
  const books = new PluginFiles(() => now);
  const gone = [];
  const o = books.offer("demo", "demo", data, file, { name: "b.kdbx", ttlMs: 5000, onGone: (w) => gone.push(w) });
  now += 5001;
  assert.equal(books.get("demo", o.path.split("/").pop()), null);
  assert.equal(existsSync(file), false);
  assert.deepEqual(gone, ["expired"]);

  writeFileSync(file, "again");
  const o2 = books.offer("demo", "demo", data, file, { name: "b.kdbx", onGone: (w) => gone.push(w) });
  o2.withdraw();
  assert.equal(existsSync(file), false);
  writeFileSync(file, "third");
  books.offer("demo", "demo", data, file, { name: "b.kdbx", onGone: (w) => gone.push(w) });
  books.dropPlugin("demo");
  assert.equal(existsSync(file), false);
  assert.deepEqual(gone, ["expired", "withdrawn", "withdrawn"]);
  assert.ok(o2.expiresAt <= now + 10 * 60_000);
});

test("rangeLastByte: whole file, a resumed tail, an open range, unsatisfiable", () => {
  assert.equal(rangeLastByte(undefined, 100), 99);
  assert.equal(rangeLastByte("bytes=40-", 100), 99);
  assert.equal(rangeLastByte("bytes=0-49", 100), 49);
  assert.equal(rangeLastByte("bytes=-10", 100), 99);
  assert.equal(rangeLastByte("bytes=0-500", 100), 99);
  assert.equal(rangeLastByte("bytes=100-", 100), null);
});
