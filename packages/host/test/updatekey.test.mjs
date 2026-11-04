/**
 * The update signing key and the signature a phone checks a web bundle against.
 *
 * Verified here with plain `node:crypto` over the decoded bytes, the way the phone
 * does, never through the signing code: a wrong encoding in both would pass.
 * `update-signature-vector.json` is the fixed answer the Java verifier reads too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify, webcrypto } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isHostId } from "@waterplane/shared";

const { forgetUpdateKey, signUpdate, updateKeyFile, updatePublicKey } = await import("../dist/updatekey.js");
const { signedManifest, webBundleManifest } = await import("../dist/webbundle.js");
const { lanIdentity } = await import("../dist/lanid.js");

const VECTOR = new URL("../../shared/test/fixtures/update-signature-vector.json", import.meta.url);

const scratch = () => mkdtempSync(join(tmpdir(), "updatekey-"));
const FILES = [{ path: "index.html", size: 5, sha256: "a".repeat(64) }];
const body = (buildId) => ({ buildId, total: 5, files: FILES });
const manifest = (buildId) => ({ ok: true, ...body(buildId) });
const bytesOf = (b64) => Buffer.from(b64, "base64");
const readBody = (s) => JSON.parse(bytesOf(s.signed).toString("utf8"));
const spki = (b64) => createPublicKey({ key: bytesOf(b64), format: "der", type: "spki" });
const verifies = (key, s) => verify("sha256", bytesOf(s.signed), { key: spki(key), dsaEncoding: "ieee-p1363" }, bytesOf(s.sig));
const restart = (root) => forgetUpdateKey(root);

/** Runs `fn` with console.error captured, so a degrade can be asserted to have SAID so. */
function quietly(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try { return { value: fn(), lines }; } finally { console.error = real; }
}

test("a signature verifies over the decoded bytes, as 64-byte P1363", () => {
  const root = scratch();
  const key = updatePublicKey(root);
  const s = signUpdate(root, body("build-a"));
  assert.equal(spki(key).asymmetricKeyDetails.namedCurve, "prime256v1");
  assert.equal(bytesOf(s.sig).length, 64);
  assert.ok(verifies(key, s));
});

test("signed says exactly what the contract says, and nothing else", () => {
  const root = scratch();
  const extra = [{ ...FILES[0], mtimeMs: 1 }];
  const got = readBody(signUpdate(root, { buildId: "build-a", total: 5, files: extra }));
  assert.deepEqual(got, { v: 1, hostId: lanIdentity(root).hostId, buildId: "build-a", gen: 1, total: 5, files: FILES });
  assert.ok(isHostId(got.hostId));
});

test("a changed byte in signed fails, and another desktop's key fails", () => {
  const root = scratch();
  const key = updatePublicKey(root);
  const s = signUpdate(root, body("build-a"));
  const bad = bytesOf(s.signed);
  bad[bad.length - 3] ^= 1;
  assert.equal(verifies(key, { signed: bad.toString("base64"), sig: s.sig }), false);
  assert.equal(verifies(updatePublicKey(scratch()), s), false);
});

test("gen moves only when the build changes, and a revert still rises", () => {
  const root = scratch();
  const gen = (id) => readBody(signUpdate(root, body(id))).gen;
  assert.equal(gen("build-a"), 1);
  assert.equal(gen("build-a"), 1);
  assert.equal(gen("build-b"), 2);
  assert.equal(gen("build-a"), 3);
});

test("the key and gen survive a restart, and the same build keeps its gen", () => {
  const root = scratch();
  const key = updatePublicKey(root);
  signUpdate(root, body("build-a"));
  signUpdate(root, body("build-b"));
  restart(root);
  assert.equal(updatePublicKey(root), key);
  assert.equal(readBody(signUpdate(root, body("build-b"))).gen, 2);
  restart(root);
  const s = signUpdate(root, body("build-c"));
  assert.equal(readBody(s).gen, 3);
  assert.ok(verifies(key, s));
});

test("gen is on disk by the time a signature exists", () => {
  const root = scratch();
  signUpdate(root, body("build-a"));
  const j = JSON.parse(readFileSync(updateKeyFile(root), "utf8"));
  assert.equal(j.gen, 1);
  assert.equal(j.lastBuildId, "build-a");
});

test("the key file is 0600 when made, and a looser one is tightened on load", () => {
  const root = scratch();
  updatePublicKey(root);
  const file = updateKeyFile(root);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  signUpdate(root, body("build-a"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  chmodSync(file, 0o644);
  restart(root);
  updatePublicKey(root);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

for (const [name, bytes] of [
  ["half a document", "{\"key\":\"abc"],
  ["a key that is not a key", JSON.stringify({ key: "bm90IGEga2V5", gen: 1, lastBuildId: null })],
  ["a gen that went negative", null],
]) {
  test(`a corrupt file (${name}) is kept aside, a new key is made, and the console says so`, () => {
    const root = scratch();
    const old = updatePublicKey(root);
    const file = updateKeyFile(root);
    const original = bytes ?? JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), gen: -1 });
    writeFileSync(file, original);
    restart(root);
    const { value: key, lines } = quietly(() => updatePublicKey(root));
    assert.ok(key);
    assert.notEqual(key, old);
    assert.ok(lines.some((l) => /new key/.test(l)), lines.join("\n"));
    const aside = readdirSync(dirname(file)).filter((n) => n.startsWith("update-key.json.corrupt-"));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dirname(file), aside[0]), "utf8"), original);
    assert.equal(readBody(signUpdate(root, body("build-a"))).gen, 1);
  });
}

test("a file that cannot even be opened is moved aside, never written over", () => {
  const root = scratch();
  updatePublicKey(root);
  const file = updateKeyFile(root);
  rmSync(file);
  mkdirSync(file); // EISDIR: the read fails for any user, root included
  writeFileSync(join(file, "evidence"), "x");
  restart(root);
  const { value: key } = quietly(() => updatePublicKey(root));
  assert.ok(key);
  assert.ok(statSync(file).isFile());
  const aside = readdirSync(dirname(file)).filter((n) => n.startsWith("update-key.json.corrupt-"));
  assert.ok(existsSync(join(dirname(file), aside[0], "evidence")));
});

test("a state dir that cannot exist answers undefined, says so once, and heals", () => {
  const root = join(scratch(), "root");
  writeFileSync(root, "not a directory");
  const first = quietly(() => [updatePublicKey(root), signUpdate(root, body("build-a"))]);
  assert.deepEqual(first.value, [undefined, undefined]);
  assert.ok(first.lines.some((l) => /unsigned/.test(l)), first.lines.join("\n"));
  const again = quietly(() => [updatePublicKey(root), signUpdate(root, body("build-a"))]);
  assert.deepEqual(again.lines, []);
  rmSync(root);
  mkdirSync(root);
  assert.equal(readBody(signUpdate(root, body("build-a"))).gen, 1);
});

test("a gen that cannot reach the disk is never signed with", () => {
  const root = scratch();
  signUpdate(root, body("build-a"));
  const state = dirname(updateKeyFile(root));
  // Held key, gone directory: the write of the next gen fails for any user.
  rmSync(state, { recursive: true });
  writeFileSync(state, "in the way");
  const { value } = quietly(() => signUpdate(root, body("build-b")));
  assert.equal(value, undefined);
  rmSync(state);
  mkdirSync(state);
  assert.equal(readBody(signUpdate(root, body("build-b"))).gen, 2);
});

test("the manifest is signed once, not once per poll", () => {
  const root = scratch();
  const base = manifest("build-a");
  const first = signedManifest(base, root);
  const second = signedManifest(base, root);
  assert.ok(first.sig);
  assert.equal(second, first); // ECDSA signs differently each time, so one object is the proof
  assert.ok(verifies(updatePublicKey(root), first));
  assert.deepEqual(readBody(first).files, FILES);
  assert.equal(base.signed, undefined);
});

test("a new manifest object of the same build keeps its gen", () => {
  const root = scratch();
  const a = signedManifest(manifest("build-a"), root);
  const b = signedManifest(manifest("build-a"), root);
  assert.equal(readBody(b).gen, readBody(a).gen);
});

test("the manifest still works unsigned on a key failure, and signs once it can", () => {
  const root = join(scratch(), "root");
  writeFileSync(root, "not a directory");
  const base = manifest("build-a");
  const { value, lines } = quietly(() => signedManifest(base, root));
  assert.equal(value, base);
  assert.equal(value.ok, true);
  assert.equal(value.signed, undefined);
  assert.equal(value.sig, undefined);
  assert.ok(lines.length > 0);
  rmSync(root);
  mkdirSync(root);
  assert.ok(signedManifest(base, root).sig);
});

test("a refused manifest touches no key", () => {
  const root = scratch();
  const refused = { ok: false, buildId: null, files: [], total: 0, reason: "no web build on the host" };
  assert.equal(signedManifest(refused, root), refused);
  assert.equal(existsSync(updateKeyFile(root)), false);
});

test("with no root the manifest is unsigned and makes no key", () => {
  const m = webBundleManifest();
  assert.equal(typeof m.ok, "boolean");
  assert.equal(m.signed, undefined);
  assert.equal(m.sig, undefined);
});

test("the fixed vector: signed verifies, the tampered copy does not", async () => {
  const v = JSON.parse(readFileSync(VECTOR, "utf8"));
  assert.equal(createHash("sha256").update(bytesOf(v.updateKey)).digest("hex"), v.fingerprint);
  assert.equal(bytesOf(v.sig).length, 64);
  assert.ok(verifies(v.updateKey, v));
  assert.equal(verifies(v.updateKey, v.tampered), false);
  assert.notEqual(v.tampered.signed, v.signed);
  const b = readBody(v);
  assert.deepEqual(Object.keys(b), ["v", "hostId", "buildId", "gen", "total", "files"]);
  assert.equal(b.total, b.files.reduce((n, f) => n + f.size, 0));
  // The phone's page checks with WebCrypto, which takes P1363 as it comes.
  const key = await webcrypto.subtle.importKey("spki", bytesOf(v.updateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = (s) => webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytesOf(s.sig), bytesOf(s.signed));
  assert.equal(await ok(v), true);
  assert.equal(await ok(v.tampered), false);
});
