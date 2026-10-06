#!/usr/bin/env node
// Make the release signing keypair. Run once per key (and again only to ROTATE it).
//
//   node scripts/release/keygen.mjs [--key <path>]
//
// Private key (pkcs8 PEM, mode 0600): `<ENV_PREFIX>RELEASE_KEY`, else
// ~/.config/<slug>-release/release-ed25519.pem. An existing private key is NEVER overwritten.
// Public key (spki PEM): deploy/release-pubkey.pem — commit it; render-install.mjs embeds it in
// install.sh and build.mjs refuses to sign with any key that does not match it.
//
// A rotation is a new install.sh: every installer already downloaded trusts only the old key.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E, SLUG } from "../lib-brand.mjs";
import { PUBKEY_PATH, defaultKeyPath, generateKeys } from "./sign-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const at = argv.indexOf("--key");
const keyPath = resolve(at >= 0 ? argv[at + 1] ?? "" : process.env[E.RELEASE_KEY] || defaultKeyPath(SLUG));
for (const [i, a] of argv.entries()) if (a !== "--key" && argv[i - 1] !== "--key") { console.error(`keygen: unknown argument ${a}`); process.exit(2); }

if (existsSync(keyPath)) {
  console.error(`keygen: ${keyPath} already exists; refusing to overwrite a signing key. Move it away first if you really mean to rotate.`);
  process.exit(1);
}
const { privatePem, publicPem } = generateKeys();
mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
writeFileSync(keyPath, privatePem, { mode: 0o600, flag: "wx" });
chmodSync(keyPath, 0o600);

const pubFile = join(ROOT, PUBKEY_PATH);
const rotated = existsSync(pubFile) && readFileSync(pubFile, "utf8") !== publicPem;
writeFileSync(pubFile, publicPem);

console.log(`keygen: private key -> ${keyPath} (0600)`);
console.log(`keygen: public key  -> ${PUBKEY_PATH}${rotated ? " (REPLACED the previous one: this is a rotation)" : ""}`);
console.log("");
console.log("Back the private key up OFFLINE now (a password manager entry or an encrypted USB stick),");
console.log("never into a repo or a synced folder. Lose it and no further release can be signed for the");
console.log("installers already out there; leak it and anyone can publish a release they will accept.");
console.log(`Then commit ${PUBKEY_PATH}.`);
