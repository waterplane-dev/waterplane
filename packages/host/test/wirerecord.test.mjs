/**
 * The record file (`wirerecord.ts`, `WATERPLANE_WIRE_RECORD`) is RAW — every prompt,
 * root and token the host saw — so how it is WRITTEN is a security property:
 * owner-only, never through a symlink or into a file someone else owns, with a
 * size cap, and with what a person typed as a password never on disk at all.
 * Each case runs in a child (the knob is read once at import) with HOME and the
 * root pointed at a scratch dir so importing `env.js` touches nothing real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist/wirerecord.js", import.meta.url));
const CAP_BYTES = 256 * 1024 * 1024; // wirerecord.ts CAP_BYTES

function record(file, body, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "waterplane-wirerec-home-"));
  const code = `const w = await import(${JSON.stringify(DIST)}); ${body}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), WATERPLANE_ROOT: home, WATERPLANE_WIRE_RECORD: file, ...extraEnv },
  });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

test("the record file is created owner-only (0600) and says so loudly on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-wirerec-"));
  const file = join(dir, "wire.jsonl");
  const r = record(file, `w.recordWireFrame("out", { t: "x" });`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(r.stderr, /WIRE_RECORD/);
});

test("an existing record file is tightened to 0600 before anything is appended", () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-wirerec-"));
  const file = join(dir, "wire.jsonl");
  writeFileSync(file, "", { mode: 0o644 });
  record(file, `w.recordWireFrame("out", { t: "x" });`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a symlink at the record path is refused, its target untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-wirerec-"));
  const target = join(dir, "victim");
  writeFileSync(target, "keep\n");
  const file = join(dir, "wire.jsonl");
  symlinkSync(target, file);
  record(file, `w.recordWireFrame("out", { t: "x" });`);
  assert.equal(readFileSync(target, "utf8"), "keep\n");
  assert.ok(lstatSync(file).isSymbolicLink());
});

test("a password a client sends is never written, not even to the raw file", () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-wirerec-"));
  const file = join(dir, "wire.jsonl");
  record(file, `w.recordWireFrame("in", { t: "auth.set", password: "hunter2-plain" });
    w.recordWireFrame("in", { t: "settings.set", key: "k", value: "v", ts: 1 });
    w.recordWireHttp("GET", "/api/auth/token?token=abc123secret&x=1", 200, Buffer.from(JSON.stringify({ token: "tok-value-xyz", ok: true })));`);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes("hunter2-plain"), "password on disk");
  assert.ok(!text.includes("tok-value-xyz"), "token in a response body on disk");
  assert.ok(!text.includes("abc123secret"), "token in a query string on disk");
  assert.ok(text.includes('"settings.set"'), "an ordinary frame is still recorded");
});

test("recording stops at the size cap instead of filling the disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-wirerec-"));
  const file = join(dir, "wire.jsonl");
  // a sparse file already AT the cap: no disk is used to stand one up
  writeFileSync(file, "", { mode: 0o600 });
  truncateSync(file, CAP_BYTES);
  const r = record(file, `for (let i = 0; i < 50; i++) w.recordWireFrame("out", { t: "x", pad: "y".repeat(1000) });`);
  assert.equal(statSync(file).size, CAP_BYTES, "appended past the cap");
  assert.match(r.stderr, /cap/);
});
