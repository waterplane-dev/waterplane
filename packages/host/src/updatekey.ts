/**
 * This desktop's update signing key: what lets a phone tell a web bundle this
 * desktop published from one a relay on the Wi-Fi made up.
 *
 * The manifest's hashes arrive in the same answer as the rest of it, so whoever
 * can change the files can change the hashes. A phone that pinned `updateKey`
 * over a protected route can check `sig` over `signed` instead, and a relay has
 * no way to produce one. The key is per desktop, not per project, because people
 * build their own bundles and a private key shipped to every desktop is no key.
 * P-256, not Ed25519: `minSdk` is 24 and old WebViews lack Ed25519.
 *
 * `<state dir>/update-key.json`, mode 0600, created the first time anything asks:
 * the private key (PKCS#8 DER, base64), `gen` and `lastBuildId`.
 *
 * `gen` is what stops an old signed bundle being replayed: it moves up by one
 * only when the served build id differs from `lastBuildId`, so a poll or a
 * restart leaves it alone, and a real revert to an older build gets a higher
 * number than the build it replaces. It reaches the disk before anything is
 * signed with it, so a crash can never hand out the same number twice.
 *
 * Degrade, never break. A file that cannot be read is moved aside and a new key
 * made, which each phone asks about once. When the disk refuses, `signUpdate`
 * and `updatePublicKey` answer undefined, the reason goes to the console once,
 * and the bundle is served unsigned.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { logTag } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { corruptPathFor, readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";
import { lanIdentity } from "./lanid.js";

/** What the signature covers, beside `hostId` and `gen`, which this file adds. */
export interface UpdateBody {
  buildId: string;
  total: number;
  files: { path: string; size: number; sha256: string }[];
}

/** `signed`: base64 of the JSON a phone reads. `sig`: base64 P1363 `r‖s` over those decoded bytes. */
export interface UpdateSignature {
  signed: string;
  sig: string;
}

interface StoredKey {
  key: string;
  gen: number;
  lastBuildId: string | null;
}

interface HeldKey extends StoredKey {
  privateKey: KeyObject;
  /** base64 of the public key's SPKI DER: `welcome.updateKey`. */
  publicKey: string;
}

const held = new Map<string, HeldKey>();
/** Reasons already on the console, so a phone polling a broken disk logs each one once. */
const said = new Set<string>();

export function updateKeyFile(root: string): string {
  return join(hostStateDir(root), "update-key.json");
}

function privateKeyOf(key: string): KeyObject | null {
  try {
    const k = createPrivateKey({ key: Buffer.from(key, "base64"), format: "der", type: "pkcs8" });
    return k.asymmetricKeyDetails?.namedCurve === "prime256v1" ? k : null;
  } catch {
    return null;
  }
}

function isStoredKey(v: unknown): boolean {
  const j = v as Partial<StoredKey> | null;
  return typeof j?.key === "string" && privateKeyOf(j.key) !== null
    && Number.isSafeInteger(j.gen) && (j.gen as number) >= 0
    && (j.lastBuildId === null || typeof j.lastBuildId === "string");
}

function hold(s: StoredKey): HeldKey {
  const privateKey = privateKeyOf(s.key);
  if (!privateKey) throw new Error("update key is not a P-256 key");
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
  return { key: s.key, gen: s.gen, lastBuildId: s.lastBuildId, privateKey, publicKey };
}

function save(file: string, s: StoredKey): void {
  writeJsonAtomic(file, { key: s.key, gen: s.gen, lastBuildId: s.lastBuildId }, { mode: 0o600 });
}

/** The key of `root`: held, else read, else made. Throws only when the disk refuses a new one. */
function load(root: string): HeldKey {
  const hit = held.get(root);
  if (hit) return hit;
  const file = updateKeyFile(root);
  const read = readJsonGuardedDetail<StoredKey | null>(file, null, isStoredKey);
  if (read.value) {
    try { chmodSync(file, 0o600); } catch { /* best effort on odd filesystems */ }
    const k = hold(read.value);
    held.set(root, k);
    return k;
  }
  if (read.corrupt) {
    // jsonstore leaves a file it could not open where it is. A rename needs no
    // read access, and the next write must never land on the only copy.
    const movedTo = read.corrupt.movedTo ?? corruptPathFor(file);
    if (!read.corrupt.movedTo) renameSync(file, movedTo);
    console.error(`${logTag} update signing key could not be read (${read.corrupt.error}); kept as ${movedTo}. Making a new key: each phone asks once before it trusts it.`);
  }
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const k = hold({ key, gen: 0, lastBuildId: null });
  save(file, k);
  held.set(root, k);
  return k;
}

/** `gen` for this build: the same one for the same build, and on disk before it is returned. */
function advance(root: string, k: HeldKey, buildId: string): number {
  if (k.lastBuildId === buildId) return k.gen;
  save(updateKeyFile(root), { key: k.key, gen: k.gen + 1, lastBuildId: buildId });
  k.gen += 1;
  k.lastBuildId = buildId;
  return k.gen;
}

function refused(root: string, what: string, e: unknown): undefined {
  const why = `${what}: ${(e as Error)?.message ?? e}`;
  if (!said.has(`${root}\0${why}`)) console.error(`${logTag} ${why}`);
  said.add(`${root}\0${why}`);
  return undefined;
}

/** base64 SPKI DER of this desktop's update key, or undefined when there is none to give. */
export function updatePublicKey(root: string): string | undefined {
  try {
    return load(root).publicKey;
  } catch (e) {
    return refused(root, "no update signing key", e);
  }
}

/** Sign one build. Undefined means serve it unsigned: never throws, the reason is logged. */
export function signUpdate(root: string, body: UpdateBody): UpdateSignature | undefined {
  try {
    const { hostId } = lanIdentity(root);
    const k = load(root);
    const gen = advance(root, k, body.buildId);
    const files = body.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    const bytes = Buffer.from(JSON.stringify({ v: 1, hostId, buildId: body.buildId, gen, total: body.total, files }), "utf8");
    const sig = sign("sha256", bytes, { key: k.privateKey, dsaEncoding: "ieee-p1363" });
    said.clear();
    return { signed: bytes.toString("base64"), sig: sig.toString("base64") };
  } catch (e) {
    return refused(root, "web bundle served unsigned", e);
  }
}

/** For tests: forget what is held for `root`, as a restart would. */
export function forgetUpdateKey(root: string): void {
  held.delete(root);
  said.clear();
}
