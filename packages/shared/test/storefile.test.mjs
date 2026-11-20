/** The extension store helper: core's read rule (never over, never empty) with an fs seam. */
import test from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdtempSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStore, writeStore } from "../dist/index.js";

const dir = () => mkdtempSync(join(tmpdir(), "storefile-"));
const failing = (code) => ({ ...realFs, readFileSync: () => { throw Object.assign(new Error(code), { code }); } });

test("absent file is absent; write then read round-trips with no tmp left", () => {
  const d = dir(), p = join(d, "s.json");
  assert.deepEqual(readStore(realFs, p), { kind: "absent" });
  writeStore(realFs, p, { a: 1 });
  assert.deepEqual(readStore(realFs, p), { kind: "ok", value: { a: 1 } });
  assert.deepEqual(readdirSync(d), ["s.json"]);
});

test("a write that fails leaves the old file whole and no tmp", () => {
  const d = dir(), p = join(d, "s.json");
  writeStore(realFs, p, { a: 1 });
  assert.throws(() => writeStore({ ...realFs, renameSync: () => { throw new Error("boom"); } }, p, { a: 2 }));
  assert.deepEqual(readStore(realFs, p), { kind: "ok", value: { a: 1 } });
  assert.deepEqual(readdirSync(d), ["s.json"]);
});

for (const code of ["EMFILE", "ENFILE", "ENOMEM", "EAGAIN", "EINTR"]) {
  test(`${code} is a process error: unreadable, file left, nothing renamed`, () => {
    const d = dir(), p = join(d, "s.json");
    writeFileSync(p, '{"a":1}');
    const renames = [];
    const r = readStore({ ...failing(code), renameSync: (...a) => renames.push(a) }, p);
    assert.equal(r.kind, "unreadable");
    assert.equal(r.process, true);
    assert.deepEqual(renames, []);
    assert.deepEqual(readStore(realFs, p), { kind: "ok", value: { a: 1 } });
  });
}

test("EIO is unreadable, not process, and never moved aside", () => {
  const d = dir(), p = join(d, "s.json");
  writeFileSync(p, "{}");
  const r = readStore(failing("EIO"), p);
  assert.equal(r.kind, "unreadable");
  assert.equal(r.process, false);
  assert.equal(r.corrupt, undefined);
  assert.deepEqual(readdirSync(d), ["s.json"]);
});

test("EACCES leaves the file in place", { skip: process.getuid?.() === 0 }, () => {
  const d = dir(), p = join(d, "s.json");
  writeFileSync(p, '{"a":1}');
  chmodSync(p, 0o000);
  try {
    const r = readStore(realFs, p);
    assert.equal(r.kind, "unreadable");
    assert.equal(r.process, false);
    assert.deepEqual(readdirSync(d), ["s.json"]);
  } finally { chmodSync(p, 0o600); }
});

test("invalid JSON is moved aside (only then); the next read is absent", () => {
  const d = dir(), p = join(d, "s.json");
  writeFileSync(p, "{not json");
  const r = readStore(realFs, p);
  assert.equal(r.kind, "unreadable");
  assert.equal(r.corrupt, true);
  assert.match(r.movedTo, /s\.json\.corrupt-/);
  assert.deepEqual(readStore(realFs, p), { kind: "absent" });
  assert.equal(readdirSync(d).length, 1);
});
