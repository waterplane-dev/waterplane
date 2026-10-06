// Publisher signing for release artifacts: Ed25519 through Node's own `crypto`, so neither the
// person releasing nor the person installing needs minisign/cosign. Pure apart from the two
// file helpers at the bottom; the build (`build.mjs`), the key generator (`keygen.mjs`) and the
// installer renderer (`render-install.mjs`) all go through here. Why: SECURITY.md, the installer.
//
// What is signed is the EXACT bytes of a small file (the tarball's `.sha256`, `release.json`),
// written beside it as `<file>.sig`: one line, the base64 signature. The `.sha256` then binds the
// tarball, so one signature over 90 bytes vouches for the whole archive.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the private key lives unless `<ENV_PREFIX>RELEASE_KEY` says otherwise. Never in a repo. */
export const defaultKeyPath = (slug, home = homedir()) => join(home, ".config", `${slug}-release`, "release-ed25519.pem");

/** The committed public key, relative to the repo root. */
export const PUBKEY_PATH = "deploy/release-pubkey.pem";

/** A fresh keypair as PEM: private pkcs8, public spki. */
export function generateKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

/** A private key from PEM, refused unless it is Ed25519. The message never carries the key. */
export function loadPrivateKey(pem) {
  let key;
  try { key = createPrivateKey(pem); } catch { throw new Error("the release key is not a readable PEM private key"); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`the release key is ${key.asymmetricKeyType}, not ed25519`);
  return key;
}

/** A public key from PEM (spki), refused unless it is Ed25519. */
export function loadPublicKey(pem) {
  let key;
  try { key = createPublicKey(pem); } catch { throw new Error("the public key is not a readable PEM public key"); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`the public key is ${key.asymmetricKeyType}, not ed25519`);
  return key;
}

/** The SPKI PEM a private key's public half exports as — the form `deploy/release-pubkey.pem` holds. */
export const publicPemOf = (privateKey) => createPublicKey(privateKey).export({ type: "spki", format: "pem" });

/**
 * Throw unless `privateKey` is the half of the committed public key. Compared as DER, so a PEM
 * that differs only in line endings or a trailing newline still matches. This is what stops a
 * release signed with the wrong key: every installer already out there would refuse it.
 */
export function assertKeyMatches(privateKey, committedPubPem) {
  const want = loadPublicKey(committedPubPem).export({ type: "spki", format: "der" });
  const got = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (!want.equals(got)) throw new Error(`the release key's public half is not ${PUBKEY_PATH} — wrong key, or the committed one was rotated without this one`);
}

/** The base64 Ed25519 signature of `bytes`, one line, no newline. */
export const signBytes = (privateKey, bytes) => sign(null, Buffer.from(bytes), privateKey).toString("base64");

/** True only when `sigText` (base64, surrounding whitespace ignored) is `publicKey`'s signature of `bytes`. */
export function verifyBytes(publicKey, bytes, sigText) {
  const s = String(sigText ?? "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  const sig = Buffer.from(s, "base64");
  if (sig.length !== 64) return false;
  try { return verify(null, Buffer.from(bytes), publicKey, sig); } catch { return false; }
}

/**
 * The public key as ONE line the installer can carry inside single quotes: the base64 of its
 * SPKI DER (the PEM body without its armour and line breaks). The installer rebuilds the key
 * with `createPublicKey({ key, format: "der", type: "spki" })`.
 */
export const pubkeyLine = (pem) => loadPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");

// ── files ──────────────────────────────────────────────────────────────────

/** Sign `file`'s exact bytes into `<file>.sig`. Returns the .sig path. */
export function signFile(privateKey, file) {
  const out = `${file}.sig`;
  writeFileSync(out, signBytes(privateKey, readFileSync(file)) + "\n");
  return out;
}

/** True only when `<file>.sig` is a valid signature of `file` under `publicKey`. */
export function verifyFile(publicKey, file) {
  let sig;
  try { sig = readFileSync(`${file}.sig`, "utf8"); } catch { return false; }
  return verifyBytes(publicKey, readFileSync(file), sig);
}
