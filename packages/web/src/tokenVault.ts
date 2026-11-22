/**
 * The sealed sign-ins, the pure half: which keys hold a device token, the exact write order of
 * sealing and unsealing, and what a boot does with a migration that was cut off. Node-tested over
 * a KV like `hosts.ts`. The prompts, the Keystore calls and the words are `features/appLock`'s.
 *
 * **What decides.** Flag off: plaintext is the truth, a blob is leftover. Flag on with a blob: the
 * blob is the truth, plaintext of a desktop it lists is leftover. Both directions write so that
 * every prefix of their steps is one of those two (`tokenVault.test.mjs` cuts every step):
 *
 * - seal: blob, read back, flag, read back, THEN the deletes.
 * - unseal: every plaintext key, read back, flag cleared, THEN the blob.
 *
 * **Plaintext is deleted only for ids the blob lists.** A token the blob cannot have (a passive
 * one, one that landed later) has no other copy, and the ciphertext cannot be read to compare.
 *
 * **What "verified" means.** The stored bytes read back equal and parse. Decrypting too would be a
 * second fingerprint on the per-use key, and sealing is one prompt; the ciphertext comes straight
 * from AES-GCM in the Keystore.
 *
 * **Callers.** `collectTokens` before the prompt and `commitSeal` after it: a token that lands
 * while the sheet is up refuses the commit (`changed`), since the blob would lack it. Re-wrap with
 * the existing key, never `generate`. Unseal `heldTokens()`, not the blob alone: it carries what
 * arrived this run. Leave the key in the Keystore on unseal and let the next `generate` with
 * `replace` retire it: a kill can lose the last moments of localStorage writes but not a Keystore
 * delete, and that pairing is flag and blob back on disk with no key to open them.
 *
 * **The LAN identity goes with its token** (`deviceToken.ts` says why). It is sealed only for a
 * desktop whose token is, in the same ciphertext under the one field `lan` (three letters, so never
 * a host id), and the blob names those desktops in `lan` beside `hosts`: that list bounds the
 * deletes of plain identities exactly as `hosts` bounds the tokens'. Seal deletes them after the
 * token copies, unseal writes them before the flag, a re-wrap takes in a plain one the blob lacked
 * and then deletes it. The identity never decides anything: a flag-off blob goes when the TOKENS
 * are covered, because an identity can be read over the tailnet again and an unseal leaves one out
 * on purpose (a desktop now passive). Both ways stay readable across builds: a build from before
 * this drops the `lan` field as a junk row and ignores the list, and a blob from before it simply
 * has neither, so its plain identities stay where they are until the next re-wrap.
 *
 * Which keys: `hosts.ts` leaves the parked copy of the ACTIVE desktop in place, and a removed
 * desktop's parked keys stay for a re-add, so the scan is over the keys and not the host list.
 * The aad carries no `deviceId`: the hard reset drops that key, which would orphan the blob.
 */
import { BRAND, HOST_PARK_PREFIX, isHostId, parkedKeyFor } from "@waterplane/shared";
import { isDeviceToken, parseLanIdentity, type LanIdentity } from "./deviceToken.ts";
import { activeHostId, allKeys, type KV } from "./hosts.ts";
import { LS } from "./storage.ts";

export const TOKEN_ALIAS = `${BRAND.slug}.tokens`;
/** Bound into the ciphertext, like the app lock's: this blob opens as tokens or not at all. */
export const TOKEN_AAD = "tokens";

/** What `wrap` gave back, in the shape the blob stores it. */
export interface WrappedTokens { ct: string; nonce: string }
/** `hosts` is not secret: it names the desktops without a prompt, and bounds the deletes. `lan`:
 *  those of them whose LAN identity is in the ciphertext too; absent when none is. */
export interface SealBlob extends WrappedTokens { v: 1; hosts: string[]; lan?: string[] }
export type TokenMap = Record<string, string>;
/** LAN identities by ROW id (an identity's own `hostId` is the desktop's, another thing). */
export type LanMap = Record<string, LanIdentity>;
/** The plaintext's one non-token field. Too short to be a host id, and its value is no token. */
const LAN_FIELD = "lan";
export type SealOp = { op: "set"; key: string; value: string } | { op: "remove"; key: string };
export type CommitResult = { ok: true } | { ok: false; why: "changed" | "storage" | "badBlob" };
export type Settled =
  | "plain" | "sealed"
  /** An interrupted seal finished, or a blob that held a last copy was put back in force. */
  | "repair-finished-seal"
  /** The leftover blob of a finished unseal, or of a seal that never reached its flag, deleted. */
  | "repair-finished-unseal"
  /** Flag on with no blob: the flag cleared, plaintext (if any) left as it was. */
  | "repair-no-blob"
  /** Flag on over bytes this build cannot read, perhaps a newer one's: nothing touched. */
  | "blob-unreadable";

export function parseSealBlob(raw: string | null): SealBlob | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SealBlob> | null;
    if (!v || v.v !== 1 || !v.ct || !v.nonce || typeof v.ct !== "string" || typeof v.nonce !== "string") return null;
    if (!Array.isArray(v.hosts) || !v.hosts.every(isHostId)) return null;
    const hosts = v.hosts;
    // A list that is not one deletes nothing: the identities it would have named stay plain.
    const lan = Array.isArray(v.lan) ? v.lan.filter((id): id is string => isHostId(id) && hosts.includes(id)) : [];
    return { v: 1, ct: v.ct, nonce: v.nonce, hosts, ...(lan.length ? { lan } : {}) };
  } catch { return null; }
}

/** The desktops in the blob, for a row that names them without a prompt. */
export function sealedHostIds(kv: KV): string[] {
  return parseSealBlob(kv.getItem(LS.tokenSeal))?.hosts ?? [];
}

/** `lan` cut to the desktops `tokens` has: an identity is sealed with its token or not at all. */
function lanOf(tokens: TokenMap, lan: LanMap): LanMap {
  return Object.fromEntries(Object.keys(lan).filter((id) => id in tokens).sort().map((id) => [id, lan[id]!]));
}

/** What goes into `wrap`. With no identity it is the token map alone, as it always was. */
export function sealPlaintext(tokens: TokenMap, lan: LanMap = {}): string {
  const mine = lanOf(tokens, lan);
  return JSON.stringify(Object.keys(mine).length ? { ...tokens, [LAN_FIELD]: mine } : tokens);
}

/** What came out of `unwrap`, or null when it is not a token map (then nothing may be deleted). */
export function readSealPlaintext(text: string): TokenMap | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return Object.fromEntries(Object.entries(v).filter(([id, t]) => isHostId(id) && isDeviceToken(t))) as TokenMap;
  } catch { return null; }
}

/** The identities that came out of `unwrap` beside the tokens; none for a text without them. */
export function readSealLan(text: string): LanMap {
  try {
    const lan = (JSON.parse(text) as Record<string, unknown> | null)?.[LAN_FIELD];
    if (!lan || typeof lan !== "object" || Array.isArray(lan)) return {};
    const out: LanMap = {};
    for (const [id, v] of Object.entries(lan)) {
      const got = isHostId(id) ? parseLanIdentity(v) : null;
      if (got) out[id] = got;
    }
    return out;
  } catch { return {}; }
}

function isPassive(kv: KV, id: string, active: string | null): boolean {
  return kv.getItem(id === active ? LS.passive : parkedKeyFor(LS.passive, id)) === "1";
}

/** Every host id with a parked token key, saved or removed. */
function parkedTokenIds(kv: KV): string[] {
  return allKeys(kv).flatMap((k) => {
    if (!k.startsWith(HOST_PARK_PREFIX)) return [];
    const id = k.slice(HOST_PARK_PREFIX.length).split(".", 1)[0] ?? "";
    return isHostId(id) && parkedKeyFor(LS.deviceToken, id) === k ? [id] : [];
  });
}

/**
 * Every full token in plain storage, by host id. The bare key is the active desktop's, and beats
 * that desktop's parked copy. A passive token stays out: the passive screen never opens a seal. A
 * bare token with no active host belongs to no desktop, so it stays out too.
 */
export function collectTokens(kv: KV): TokenMap {
  const active = activeHostId(kv);
  const out: TokenMap = {};
  for (const id of parkedTokenIds(kv)) {
    const t = kv.getItem(parkedKeyFor(LS.deviceToken, id));
    if (isDeviceToken(t) && !isPassive(kv, id, active)) out[id] = t;
  }
  const bare = kv.getItem(LS.deviceToken);
  if (active && isDeviceToken(bare) && !isPassive(kv, active, active)) out[active] = bare;
  return out;
}

function plainIdentity(raw: string | null): LanIdentity | null {
  if (!raw) return null;
  try { return parseLanIdentity(JSON.parse(raw)); } catch { return null; }
}

/**
 * The LAN identities in plain storage for `ids` (the desktops being sealed), by the tokens' rule:
 * the bare key is the active desktop's and beats its parked copy; a passive desktop has none.
 */
export function collectIdentities(kv: KV, ids: readonly string[]): LanMap {
  const active = activeHostId(kv);
  const out: LanMap = {};
  for (const id of ids) {
    if (isPassive(kv, id, active)) continue;
    const got = (id === active ? plainIdentity(kv.getItem(LS.lanIdentity)) : null) ?? plainIdentity(kv.getItem(parkedKeyFor(LS.lanIdentity, id)));
    if (got) out[id] = got;
  }
  return out;
}

/**
 * The plain keys sealing `ids` makes redundant, for the token or (`bareKey`) the identity. The bare key comes FIRST: with no active host it
 * goes only as a twin of a parked copy (`scopedKeys` writes both), which must still be there to
 * compare against if a cut pass is repeated.
 */
function plainKeysOf(kv: KV, ids: readonly string[], bareKey: string = LS.deviceToken): string[] {
  const active = activeHostId(kv);
  const mine = ids.filter((id) => !isPassive(kv, id, active));
  const parked = mine.map((id) => parkedKeyFor(bareKey, id)).filter((k) => kv.getItem(k) !== null);
  const bare = kv.getItem(bareKey);
  if (bare === null) return parked;
  const covered = active ? mine.includes(active) : parked.some((k) => kv.getItem(k) === bare);
  return covered ? [bareKey, ...parked] : parked;
}

/** Every plain copy a blob makes leftover: the tokens of `hosts`, then the identities of `lan`. */
function leftoverKeys(kv: KV, blob: SealBlob): string[] {
  return [...plainKeysOf(kv, blob.hosts), ...plainKeysOf(kv, blob.lan ?? [], LS.lanIdentity)];
}

/** Seal: the blob, the flag, and only then the deletes. */
export function sealWritePlan(kv: KV, blob: SealBlob): SealOp[] {
  return [
    { op: "set", key: LS.tokenSeal, value: JSON.stringify(blob) },
    { op: "set", key: LS.tokenSealOn, value: "1" },
    ...leftoverKeys(kv, blob).map((key): SealOp => ({ op: "remove", key })),
  ];
}

/**
 * Unseal: each token back where `hosts.ts` expects it, then the flag, then the blob. With no
 * active host every token goes parked, since one bare key cannot hold them; a later activation
 * restores it. A desktop now passive keeps the plain token it has. The identities follow the
 * tokens onto the same kind of key, and a passive desktop gets none.
 */
export function unsealWritePlan(kv: KV, tokens: TokenMap, lan: LanMap = {}): SealOp[] {
  const active = activeHostId(kv);
  const sets = Object.entries(tokens).filter(([id, t]) => isDeviceToken(t) && !isPassive(kv, id, active)).map(([id, value]): SealOp => (
    { op: "set", key: id === active ? LS.deviceToken : parkedKeyFor(LS.deviceToken, id), value }
  ));
  const identities = Object.entries(lan).filter(([id, v]) => isHostId(id) && !!parseLanIdentity(v) && !isPassive(kv, id, active)).map(([id, v]): SealOp => (
    { op: "set", key: id === active ? LS.lanIdentity : parkedKeyFor(LS.lanIdentity, id), value: JSON.stringify({ hostId: v.hostId, secret: v.secret }) }
  ));
  return [...sets, ...identities, { op: "remove", key: LS.tokenSealOn }, { op: "remove", key: LS.tokenSeal }];
}

/** Carry out `ops` in order, reading each back. False at the first that did not land. */
function run(kv: KV, ops: readonly SealOp[]): boolean {
  try {
    for (const o of ops) {
      if (o.op === "set") kv.setItem(o.key, o.value); else kv.removeItem(o.key);
      if (kv.getItem(o.key) !== (o.op === "set" ? o.value : null)) return false;
    }
    return true;
  } catch { return false; }
}

const flagOn = (kv: KV): boolean => kv.getItem(LS.tokenSealOn) === "1";

function sameTokens(a: TokenMap, b: TokenMap): boolean {
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every((id) => a[id] === b[id]);
}

function sameLan(a: LanMap, b: LanMap): boolean {
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every((id) => a[id]?.hostId === b[id]?.hostId && a[id]?.secret === b[id]?.secret);
}

function blobOf(wrapped: WrappedTokens, tokens: TokenMap, lan: LanMap): SealBlob | null {
  const blob: SealBlob = { v: 1, ct: wrapped.ct, nonce: wrapped.nonce, hosts: Object.keys(tokens).sort(), lan: Object.keys(lanOf(tokens, lan)) };
  return parseSealBlob(JSON.stringify(blob));
}

/**
 * Turn sealing on with what `wrap` returned for `tokens` (`collectTokens`, read before the prompt)
 * and `lan` (`collectIdentities` of those desktops, read with them): an identity that landed or
 * left while the sheet was up refuses like a token does, or it would stay plain beside the blob.
 * A refusal leaves every plaintext key in place. Once the flag is on the seal stands, and a
 * delete that failed is finished by the next boot.
 */
export function commitSeal(kv: KV, wrapped: WrappedTokens, tokens: TokenMap, lan: LanMap = {}): CommitResult {
  const blob = blobOf(wrapped, tokens, lan);
  if (!blob) return { ok: false, why: "badBlob" };
  if (flagOn(kv) || !sameTokens(collectTokens(kv), tokens)) return { ok: false, why: "changed" };
  if (!sameLan(collectIdentities(kv, Object.keys(tokens)), lanOf(tokens, lan))) return { ok: false, why: "changed" };
  if (run(kv, sealWritePlan(kv, blob)) || flagOn(kv)) return { ok: true };
  try { settleAtBoot(kv); } catch { /* the next boot's */ }
  return { ok: false, why: "storage" };
}

/**
 * Replace the blob while sealed (`heldTokens()`, never a partial map; `lan` what is held, plus any
 * plain identity of those desktops the old blob lacked). A refusal leaves the blob that was there.
 * Once the new blob stands, the plain identities it now holds go; one that would not go is the
 * next boot's, like a seal's deletes.
 */
export function commitRewrap(kv: KV, wrapped: WrappedTokens, tokens: TokenMap, lan: LanMap = {}): CommitResult {
  const blob = blobOf(wrapped, tokens, lan);
  if (!blob) return { ok: false, why: "badBlob" };
  if (!flagOn(kv)) return { ok: false, why: "changed" };
  const was = kv.getItem(LS.tokenSeal);
  if (run(kv, [{ op: "set", key: LS.tokenSeal, value: JSON.stringify(blob) }])) {
    run(kv, plainKeysOf(kv, blob.lan ?? [], LS.lanIdentity).map((key): SealOp => ({ op: "remove", key })));
    return { ok: true };
  }
  try { if (was !== null) kv.setItem(LS.tokenSeal, was); } catch { /* it refused the new bytes too */ }
  return { ok: false, why: "storage" };
}

/**
 * Turn sealing off with what `unwrap` gave back. A refusal stays sealed, and takes back the keys
 * it wrote. Once the flag is cleared every token and every identity of `lan` is in plain storage,
 * and a blob that would not go is the next boot's.
 */
export function commitUnseal(kv: KV, tokens: TokenMap, lan: LanMap = {}): CommitResult {
  if (!flagOn(kv)) return { ok: false, why: "changed" };
  const ops = unsealWritePlan(kv, tokens, lan);
  if (run(kv, ops) || !flagOn(kv)) return { ok: true };
  try { for (const o of ops) if (o.op === "set") kv.removeItem(o.key); } catch { /* the next boot's */ }
  return { ok: false, why: "storage" };
}

function hasPlain(kv: KV, id: string, active: string | null): boolean {
  return isDeviceToken(id === active ? kv.getItem(LS.deviceToken) : null) || isDeviceToken(kv.getItem(parkedKeyFor(LS.deviceToken, id)));
}

/**
 * Put storage back on one side of the line. Runs at boot after `bootHosts`, before any token is
 * read, and repeats safely. A flag-off blob goes only when plaintext covers every desktop it
 * lists: no order of these writes leaves that uncovered, but if something else has, the blob is a
 * last copy, and turning the mode back on is the only way it can still be opened.
 */
export function settleAtBoot(kv: KV): Settled {
  const on = flagOn(kv);
  const raw = kv.getItem(LS.tokenSeal);
  const blob = parseSealBlob(raw);
  if (raw !== null && !blob) return on ? "blob-unreadable" : "plain";
  if (!blob) {
    if (!on) return "plain";
    kv.removeItem(LS.tokenSealOn);
    return "repair-no-blob";
  }
  if (!on) {
    const active = activeHostId(kv);
    if (blob.hosts.every((id) => hasPlain(kv, id, active))) {
      kv.removeItem(LS.tokenSeal);
      return "repair-finished-unseal";
    }
    kv.setItem(LS.tokenSealOn, "1");
  }
  const leftovers = leftoverKeys(kv, blob);
  for (const k of leftovers) kv.removeItem(k);
  return on && leftovers.length === 0 ? "sealed" : "repair-finished-seal";
}
