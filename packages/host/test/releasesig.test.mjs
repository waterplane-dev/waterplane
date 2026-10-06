/**
 * `update`'s publisher check: the host verifies what scripts/release/sign-lib.mjs signs,
 * against the key in deploy/release-pubkey.pem, BEFORE it reads release.json or the
 * tarball's .sha256. Signed here with sign-lib itself, so signer and verifier cannot drift;
 * read from a temp dir through the same `fetchSigned`/`latestRelease` the CLI uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, loadPrivateKey, pubkeyLine, signBytes } from "../../../scripts/release/sign-lib.mjs";
import { RELEASE_PUBKEY, releaseKey, sigPolicy, sigRefusal, verifySig } from "../dist/cli/releasesig.js";
import { fetchSigned, latestRelease, SignatureRefused } from "../dist/cli/selfupdate.js";

const repoPem = readFileSync(new URL("../../../deploy/release-pubkey.pem", import.meta.url), "utf8");

function keypair() {
  const { privatePem, publicPem } = generateKeys();
  return { priv: loadPrivateKey(privatePem), pub: releaseKey(pubkeyLine(publicPem)) };
}

/** A release dir: release.json (+ .sig unless `sign` is false), signed by `priv`. */
function releaseDir(priv, { version = "9.9.9", sign = true, tamper = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relsig-"));
  const body = Buffer.from(JSON.stringify({ name: "x", version }) + "\n");
  writeFileSync(join(dir, "release.json"), tamper ? Buffer.from(JSON.stringify({ name: "x", version: "99.0.0" }) + "\n") : body);
  if (sign) writeFileSync(join(dir, "release.json.sig"), signBytes(priv, body) + "\n");
  return dir;
}

test("drift: the embedded key IS deploy/release-pubkey.pem", () => {
  assert.equal(RELEASE_PUBKEY, pubkeyLine(repoPem));
  assert.equal(releaseKey().asymmetricKeyType, "ed25519");
});

test("verifySig agrees with sign-lib: valid, tampered, wrong key, junk", () => {
  const a = keypair(), b = keypair();
  const bytes = Buffer.from("abc  x-1.0.0.tar.gz\n");
  const sig = signBytes(a.priv, bytes);
  assert.equal(verifySig(a.pub, bytes, sig), true);
  assert.equal(verifySig(a.pub, bytes, `  ${sig}\n`), true);
  assert.equal(verifySig(a.pub, Buffer.from("abd  x-1.0.0.tar.gz\n"), sig), false);
  assert.equal(verifySig(b.pub, bytes, sig), false);
  assert.equal(verifySig(a.pub, bytes, ""), false);
  assert.equal(verifySig(a.pub, bytes, "not base64!"), false);
  assert.equal(verifySig(a.pub, bytes, Buffer.alloc(32).toString("base64")), false);
});

test("refusal sentences: missing sig and bad sig each say why, a good one says nothing", () => {
  const a = keypair(), b = keypair();
  const bytes = Buffer.from("x");
  assert.equal(sigRefusal("f", bytes, signBytes(a.priv, bytes), a.pub), null);
  assert.match(sigRefusal("f", bytes, null, a.pub), /could not download f\.sig/);
  assert.match(sigRefusal("f", bytes, signBytes(b.priv, bytes), a.pub), /signature on f does not match/);
});

test("skip env: exactly '1' skips, anything else verifies", () => {
  const { pub } = keypair();
  assert.equal(sigPolicy("1", pub).kind, "skip");
  for (const v of [undefined, "", "0", "true", "yes", " 1"]) assert.equal(sigPolicy(v, pub).kind, "verify", String(v));
});

test("release.json: valid signature is read", async () => {
  const k = keypair();
  const dir = releaseDir(k.priv);
  try {
    const r = await latestRelease(dir, 1000, { kind: "verify", key: k.pub });
    assert.equal(r.version, "9.9.9");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release.json: missing signature is refused, not read", async () => {
  const k = keypair();
  const dir = releaseDir(k.priv, { sign: false });
  try {
    await assert.rejects(latestRelease(dir, 1000, { kind: "verify", key: k.pub }),
      (e) => e instanceof SignatureRefused && /could not download release\.json\.sig/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release.json: signed by another key is refused", async () => {
  const k = keypair(), other = keypair();
  const dir = releaseDir(other.priv);
  try {
    await assert.rejects(latestRelease(dir, 1000, { kind: "verify", key: k.pub }),
      (e) => e instanceof SignatureRefused && /does not match/.test(e.message));
    // …and the real embedded key refuses it too.
    await assert.rejects(latestRelease(dir, 1000), SignatureRefused);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release.json: tampered content (version bumped after signing) is refused", async () => {
  const k = keypair();
  const dir = releaseDir(k.priv, { tamper: true });
  try {
    await assert.rejects(latestRelease(dir, 1000, { kind: "verify", key: k.pub }), SignatureRefused);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skip policy reads an unsigned release.json (the caller warns loudly)", async () => {
  const k = keypair();
  const dir = releaseDir(k.priv, { sign: false });
  try {
    assert.equal((await latestRelease(dir, 1000, { kind: "skip" })).version, "9.9.9");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tarball .sha256: verified the same way — valid, missing, wrong key, tampered", async () => {
  const k = keypair(), other = keypair();
  const dir = mkdtempSync(join(tmpdir(), "relsig-"));
  const name = "x-9.9.9.tar.gz.sha256";
  const body = Buffer.from(`${"a".repeat(64)}  x-9.9.9.tar.gz\n`);
  const policy = { kind: "verify", key: k.pub };
  try {
    writeFileSync(join(dir, name), body);
    await assert.rejects(fetchSigned(dir, name, 1000, policy), /could not download/);
    writeFileSync(join(dir, `${name}.sig`), signBytes(k.priv, body));
    assert.deepEqual(await fetchSigned(dir, name, 1000, policy), body);
    writeFileSync(join(dir, `${name}.sig`), signBytes(other.priv, body));
    await assert.rejects(fetchSigned(dir, name, 1000, policy), SignatureRefused);
    writeFileSync(join(dir, `${name}.sig`), signBytes(k.priv, body));
    writeFileSync(join(dir, name), Buffer.from(`${"b".repeat(64)}  x-9.9.9.tar.gz\n`));
    await assert.rejects(fetchSigned(dir, name, 1000, policy), SignatureRefused);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
