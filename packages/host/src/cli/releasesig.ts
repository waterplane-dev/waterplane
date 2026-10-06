/**
 * Who published a release: the host's half of the publisher signature
 * (`scripts/release/sign-lib.mjs` is the signer's half, `deploy/install.sh.tmpl`
 * `verify_sig` the installer's). A release carries `<file>.sig` beside
 * `release.json` and the tarball's `.sha256`: one line, the base64 Ed25519
 * signature over that file's EXACT bytes. The `.sha256` then binds the tarball.
 *
 * Pure: no network, no disk, no env. The host cannot import `scripts/`, so the
 * verify is restated here in the same few lines as `sign-lib.verifyBytes`;
 * `packages/host/test/releasesig.test.mjs` signs with sign-lib and verifies
 * with this, and pins RELEASE_PUBKEY to `deploy/release-pubkey.pem`, so the two
 * halves and the key cannot drift apart.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * `deploy/release-pubkey.pem` as one line: the base64 of its SPKI DER (what
 * `sign-lib.pubkeyLine` prints, and what the installer embeds). Rotating the
 * key means changing this AND that file; the drift test fails until both move.
 */
export const RELEASE_PUBKEY = "MCowBQYDK2VwAyEAJ0/wZZFczT6F3/UdCpuBDC0lhVnNpSwxc1j+4GxoVCI=";

/** A public key from the one-line SPKI form, refused unless it is Ed25519. */
export function releaseKey(line: string = RELEASE_PUBKEY): KeyObject {
  const key = createPublicKey({ key: Buffer.from(line, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`the release key is ${key.asymmetricKeyType}, not ed25519`);
  return key;
}

/** True only when `sigText` (base64, surrounding whitespace ignored) is `key`'s signature of `bytes`. */
export function verifySig(key: KeyObject, bytes: Uint8Array, sigText: string | null | undefined): boolean {
  const s = String(sigText ?? "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  const sig = Buffer.from(s, "base64");
  if (sig.length !== 64) return false;
  try { return verify(null, Buffer.from(bytes), key, sig); } catch { return false; }
}

/**
 * How a download is checked: against a key, or — only when the person set
 * `<PREFIX>INSECURE_SKIP_SIG=1` — not at all, said loudly by the caller.
 */
export type SigPolicy = { kind: "verify"; key: KeyObject } | { kind: "skip" };

/** The policy for an env value: exactly `"1"` skips; anything else verifies against `key`. */
export function sigPolicy(skipValue: string | undefined, key: KeyObject = releaseKey()): SigPolicy {
  return skipValue === "1" ? { kind: "skip" } : { kind: "verify", key };
}

/**
 * Why `name` must not be trusted, or null when its signature checks out.
 * `sigText` null = the `.sig` could not be fetched. The sentence says what was
 * refused; the caller adds that nothing was installed.
 */
export function sigRefusal(name: string, bytes: Uint8Array, sigText: string | null, key: KeyObject): string | null {
  if (sigText === null) return `could not download ${name}.sig — refusing a release whose publisher cannot be checked`;
  if (!verifySig(key, bytes, sigText)) {
    return `the signature on ${name} does not match this install's release key: it was not published by the release key, or it was altered — refusing`;
  }
  return null;
}
