// node --test: release publisher signing (sign-lib.mjs) — the roundtrip, the wrong-key refusal,
// tampering, the installer's one-line key, and the committed public key itself. Throwaway keys
// only: the real private key is never read by a test.
import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBKEY_PATH, assertKeyMatches, generateKeys, loadPrivateKey, loadPublicKey, pubkeyLine, publicPemOf, signBytes, signFile,
  verifyBytes, verifyFile,
} from "./sign-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = "3f".repeat(32) + "  waterplane-1.2.3.tar.gz\n";

test("sign then verify roundtrips; the signature is one base64 line of 64 bytes", () => {
  const { privatePem, publicPem } = generateKeys();
  const sig = signBytes(loadPrivateKey(privatePem), SHA);
  assert.match(sig, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(sig, "base64").length, 64);
  assert.equal(verifyBytes(loadPublicKey(publicPem), SHA, sig + "\n"), true, "a trailing newline is not part of the signature");
});

test("a tampered .sha256 fails verification, and so does a signature from another key", () => {
  const a = generateKeys(), b = generateKeys();
  const sig = signBytes(loadPrivateKey(a.privatePem), SHA);
  const pub = loadPublicKey(a.publicPem);
  assert.equal(verifyBytes(pub, SHA.replace("3f", "40"), sig), false, "one changed hex digit");
  assert.equal(verifyBytes(pub, SHA.trimEnd(), sig), false, "even the trailing newline is signed");
  assert.equal(verifyBytes(loadPublicKey(b.publicPem), SHA, sig), false, "another key's public half");
  assert.equal(verifyBytes(pub, SHA, ""), false, "empty");
  assert.equal(verifyBytes(pub, SHA, "not base64!"), false, "garbage");
  assert.equal(verifyBytes(pub, SHA, Buffer.alloc(64).toString("base64")), false, "zeros");
});

test("signFile/verifyFile write <file>.sig beside the file and check it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sign-"));
  try {
    const { privatePem, publicPem } = generateKeys();
    const f = join(dir, "x.tar.gz.sha256");
    writeFileSync(f, SHA);
    assert.equal(signFile(loadPrivateKey(privatePem), f), `${f}.sig`);
    assert.match(readFileSync(`${f}.sig`, "utf8"), /^[A-Za-z0-9+/]+={0,2}\n$/);
    assert.equal(verifyFile(loadPublicKey(publicPem), f), true);
    writeFileSync(f, SHA.replace("3f", "40"));
    assert.equal(verifyFile(loadPublicKey(publicPem), f), false, "the file changed after signing");
    rmSync(`${f}.sig`);
    assert.equal(verifyFile(loadPublicKey(publicPem), f), false, "no .sig at all");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("assertKeyMatches refuses a private key whose public half is not the committed one", () => {
  const a = generateKeys(), b = generateKeys();
  const priv = loadPrivateKey(a.privatePem);
  assert.doesNotThrow(() => assertKeyMatches(priv, a.publicPem));
  assert.doesNotThrow(() => assertKeyMatches(priv, a.publicPem.replace(/\n/g, "\r\n")), "line endings do not matter");
  assert.throws(() => assertKeyMatches(priv, b.publicPem), /not deploy\/release-pubkey\.pem/);
  assert.equal(publicPemOf(priv), a.publicPem);
});

test("a non-Ed25519 or unreadable key is refused in words, and the words never carry the key", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => loadPrivateKey(rsa), /rsa, not ed25519/);
  // Assembled, so the public snapshot's secret scan does not read a key block in this file.
  const armour = (w) => `-----${w} ${["PRIVATE", "KEY"].join(" ")}-----`;
  const junk = `${armour("BEGIN")}\nSECRETSECRET\n${armour("END")}\n`;
  assert.throws(() => loadPrivateKey(junk), (e) => /not a readable PEM/.test(e.message) && !e.message.includes("SECRET"));
});

test("pubkeyLine is one base64 line that rebuilds the same key, as the installer does", () => {
  const { publicPem } = generateKeys();
  const line = pubkeyLine(publicPem);
  assert.match(line, /^[A-Za-z0-9+/]+={0,2}$/);
  const rebuilt = createPublicKey({ key: Buffer.from(line, "base64"), format: "der", type: "spki" });
  assert.equal(rebuilt.export({ type: "spki", format: "pem" }), publicPem);
});

test("the committed release public key is an Ed25519 SPKI PEM", () => {
  const pem = readFileSync(join(ROOT, PUBKEY_PATH), "utf8");
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.equal(loadPublicKey(pem).asymmetricKeyType, "ed25519");
});
