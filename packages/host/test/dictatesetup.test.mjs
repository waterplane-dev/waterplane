/**
 * The model download verifier and the disk check of `dictatesetup.ts`, against a
 * local server: size mismatch, hash mismatch, success rename, `.part` removed on
 * failure, and the disk refusal naming both numbers. No daemon, no brew.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadVerified, diskRefusal, startDictateSetup, dictateSetupState, canSetupDictation, setupRefusal, sweepStaleParts, SetupFailure } from "../dist/dictatesetup.js";

const body = Buffer.from("pretend these are whisper weights".repeat(100));
const sha = createHash("sha256").update(body).digest("hex");

async function serve(payload) {
  const srv = createServer((_req, res) => { res.end(payload); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}/m.bin`, close: () => srv.close() };
}
const tmp = () => join(mkdtempSync(join(tmpdir(), "wp-dsetup-")), "models", "ggml-x.bin");

test("success renames the .part onto the file and reports progress", async () => {
  const s = await serve(body); const dest = tmp(); let last = 0;
  await downloadVerified({ url: s.url, dest, bytes: body.length, sha256: sha, onProgress: (n) => { last = n; } });
  s.close();
  assert.equal(readFileSync(dest).length, body.length);
  assert.equal(existsSync(`${dest}.part`), false);
  assert.equal(last, body.length);
});

test("a short file is refused and the .part removed", async () => {
  const s = await serve(body.subarray(0, 100)); const dest = tmp();
  await assert.rejects(downloadVerified({ url: s.url, dest, bytes: body.length, sha256: sha }), (e) => e instanceof SetupFailure && e.step === "verify" && /expected/.test(e.message));
  s.close();
  assert.equal(existsSync(dest), false); assert.equal(existsSync(`${dest}.part`), false);
});

test("a file larger than pinned is refused", async () => {
  const s = await serve(Buffer.concat([body, body])); const dest = tmp();
  await assert.rejects(downloadVerified({ url: s.url, dest, bytes: body.length, sha256: sha }), SetupFailure);
  s.close();
  assert.equal(existsSync(dest), false); assert.equal(existsSync(`${dest}.part`), false);
});

test("a hash mismatch at the right size is refused and nothing is left", async () => {
  const s = await serve(Buffer.from("x".repeat(body.length))); const dest = tmp();
  await assert.rejects(downloadVerified({ url: s.url, dest, bytes: body.length, sha256: sha }), (e) => /checksum/.test(e.message));
  s.close();
  assert.equal(existsSync(dest), false); assert.equal(existsSync(`${dest}.part`), false);
});

test("a disk with too little room is refused with both numbers", () => {
  const GB = 1024 ** 3;
  const msg = diskRefusal(2.5 * GB, 0.9e9);
  assert.match(msg, /needs 0\.9 GB/);
  assert.match(msg, /2\.1 GB kept free|2\.1 GB/);
  assert.match(msg, /2\.7 GB is free/);
  assert.equal(diskRefusal(10 * GB, 0.9e9), null);
});

test("an unknown model is refused before any job starts", () => {
  const r = startDictateSetup("nope");
  assert.equal(r.ok, false);
  assert.equal(dictateSetupState().state, "idle");
});

const partsOf = (dest) => { try { return readdirSync(join(dest, "..")).filter((n) => n.endsWith(".part")); } catch { return []; } };

test("a write target that errors mid-stream ends as failed and leaves no temp file", async () => {
  const s = await serve(body); const dest = tmp();
  const createOut = () => new Writable({ highWaterMark: 1, write(_c, _e, cb) { setTimeout(() => cb(new Error("ENOSPC")), 5); } });
  await assert.rejects(
    downloadVerified({ url: s.url, dest, bytes: body.length, sha256: sha, createOut, idleMs: 5000 }),
    (e) => e instanceof SetupFailure && e.step === "download" && /ENOSPC/.test(e.message),
  );
  s.close();
  assert.deepEqual(partsOf(dest), []);
  assert.equal(existsSync(dest), false);
});

test("a stalled server ends the job with the idle timeout named", async () => {
  const srv = createServer((_req, res) => { res.write(body.subarray(0, 10)); /* then nothing */ });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const dest = tmp();
  await assert.rejects(
    downloadVerified({ url: `http://127.0.0.1:${srv.address().port}/m.bin`, dest, bytes: body.length, sha256: sha, idleMs: 150, deadlineMs: 5000 }),
    (e) => e instanceof SetupFailure && e.step === "download" && /stalled: no data for/.test(e.message),
  );
  srv.closeAllConnections?.(); srv.close();
  assert.deepEqual(partsOf(dest), []);
});

test("the host's temp name never collides with install.sh's .part, and the sweep takes only its own", async () => {
  const dest = tmp(); const dir = join(dest, ".."); mkdirSync(dir, { recursive: true });
  const mine = join(dir, "ggml-large-v3-turbo.bin.123.abcd1234.part");
  const installers = join(dir, "ggml-large-v3-turbo.bin.part");
  const other = join(dir, "notes.123.abcd1234.part");
  for (const p of [mine, installers, other]) writeFileSync(p, "x");
  await sweepStaleParts(dir);
  assert.equal(existsSync(mine), false);
  assert.equal(existsSync(installers), true);
  assert.equal(existsSync(other), true);
});

test("setup is refused where it cannot help, naming the setting", () => {
  const keep = { ...process.env };
  try {
    process.env.WATERPLANE_DICTATE = "0";
    assert.match(setupRefusal(), /WATERPLANE_DICTATE=0/);
    assert.equal(canSetupDictation(), false);
    const r = startDictateSetup("small");
    assert.equal(r.ok, false);
    delete process.env.WATERPLANE_DICTATE;
    process.env.WATERPLANE_WHISPER_MODEL = "/nonexistent/ggml-x.bin";
    assert.match(setupRefusal(), /WATERPLANE_WHISPER_MODEL/);
    assert.equal(canSetupDictation(), false);
    delete process.env.WATERPLANE_WHISPER_MODEL;
    process.env.WATERPLANE_WHISPER_BIN = "/nonexistent/my-whisper";
    assert.match(setupRefusal(), /WATERPLANE_WHISPER_BIN/);
    assert.equal(canSetupDictation(), false);
  } finally {
    for (const k of ["WATERPLANE_DICTATE", "WATERPLANE_WHISPER_MODEL", "WATERPLANE_WHISPER_BIN"]) { if (k in keep) process.env[k] = keep[k]; else delete process.env[k]; }
  }
});
