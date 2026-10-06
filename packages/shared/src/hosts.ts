/**
 * The desktops this phone knows — the multi-host list of the Android shell.
 *
 * One host used to be one `<prefix>hostBase` string. Now it is a list of
 * `SavedHost` rows, and exactly one of them is ACTIVE: its keys live bare in
 * localStorage, every other host's keys are PARKED under `<prefix>h.<id>.` until it
 * is switched back to. The web client owns the storage; this module owns the
 * rules both the store and its tests must agree on, so they are pure:
 *
 * - what a saved host IS (`cleanSavedHost` — anything unreadable is dropped,
 *   never defaulted into a host nobody added);
 * - how the one legacy `hostBase` becomes the first entry (`planHostMigration`,
 *   idempotent: run twice, the second run writes nothing);
 * - which keys a host switch copies, and in what order (`planHostSwitch` —
 *   every copy lands BEFORE the bare key it came from is removed, so a switch
 *   interrupted at any step has lost nothing);
 * - which IndexedDB a host's caches live in (`dbNameFor`).
 */

import { normalizeHostBase } from "./hosturl.js";
import { BRAND, LEGACY } from "./brand.js";

/** A host's LAN side: the plain-HTTP address on the home network, the Wi-Fi
 *  names it is reachable on, and whether the phone may switch to it by itself
 *  (off by default — `lanroute.ts` decides, this is only the setting). */
export interface HostLan {
  base: string;
  ssids: string[];
  auto: boolean;
}

export interface SavedHost {
  /** Stable id: parking prefix, IDB name, and the key every per-host record hangs off. */
  id: string;
  /** What the person calls it. Never empty. */
  name: string;
  /** The tailnet address (`normalizeHostBase` form) — the route that always works. */
  base: string;
  /** The host migrated from the single-`hostBase` era: keeps the old IDB name. */
  legacy?: true;
  lan?: HostLan;
}

/** The migrated host's id. Deterministic so the migration is idempotent even
 *  when its write is lost halfway. */
export const LEGACY_HOST_ID = "legacy";
export const HOST_ID_LEN = 8;
const HOST_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const HOST_NAME_MAX = 40;
/** An SSID is at most 32 octets; the cap is on characters, so a little room. */
export const SSID_MAX = 64;
export const HOST_SSIDS_MAX = 16;
export const HOSTS_MAX = 32;

/** Prefix all parked keys share. Namespace: `<prefix>h.<hostId>.<rest>`.
 *  These two are NAMESPACES, not keys: which keys exist, and which of them
 *  follow the device, stays `storage.ts`'s registry (its `DEVICE_KEYS` is the
 *  predicate `planHostSwitch` is handed). */
export const HOST_PARK_PREFIX = `${BRAND.storagePrefix}h.`;
const BARE_PREFIX = BRAND.storagePrefix;
/** Every past identity's bare prefix, newest first. */
export const LEGACY_STORAGE_PREFIXES: readonly string[] = LEGACY.map((l) => l.storagePrefix);

export type RandomBytes = (n: number) => Uint8Array;

/** Random bytes from WebCrypto (browser and node both have it as a global). */
export const defaultRandomBytes: RandomBytes = (n) => {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error("no crypto.getRandomValues in this runtime");
  return c.getRandomValues(new Uint8Array(n));
};

/** Draw `len` characters from `alphabet` (length must divide 256 for no bias,
 *  or rejection sampling keeps it uniform). */
export function randomFromAlphabet(alphabet: string, len: number, rand: RandomBytes = defaultRandomBytes): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < len) {
    for (const b of rand(len * 2)) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}

/** A host id: lowercase letters and digits. The legacy id is one too. */
export function isHostId(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9]{4,16}$/.test(s);
}

/** A fresh id that collides with none in `taken`. */
export function newHostId(taken: Iterable<string> = [], rand: RandomBytes = defaultRandomBytes): string {
  const used = new Set(taken);
  for (;;) {
    const id = randomFromAlphabet(HOST_ID_ALPHABET, HOST_ID_LEN, rand);
    if (!used.has(id) && id !== LEGACY_HOST_ID) return id;
  }
}

/** A person-typed label: control characters gone, whitespace collapsed, capped.
 *  `null` when nothing is left — never an invented name. */
export function cleanLabel(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
   
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return [...s].slice(0, max).join("").trim();
}

export function normalizeHostName(raw: unknown): string | null {
  return cleanLabel(raw, HOST_NAME_MAX);
}

/** The name a host gets when nobody typed one: the first DNS label of a
 *  MagicDNS name (`desk.tail1234.ts.net` → `desk`), the whole address for an IP. */
export function defaultHostName(base: string): string {
  let host = base;
  try {
    host = new URL(base).hostname;
  } catch {
    /* keep the raw string */
  }
  host = host.replace(/^\[|\]$/g, "");
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return host;
  return host.split(".")[0] || host;
}

/** A Wi-Fi name as Android hands it over: `"Home"` in quotes, or the
 *  `<unknown ssid>` placeholder when the location permission is missing — that
 *  one is NOT a network name and comes back `null`. */
export function normalizeSsid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (!s || s === "<unknown ssid>") return null;
   
  if (/[\u0000-\u001f]/.test(s)) return null;
  return [...s].slice(0, SSID_MAX).join("");
}

/** Normalised, de-duplicated (exact match — SSIDs are case-sensitive), capped. */
export function normalizeSsids(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    const s = normalizeSsid(r);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= HOST_SSIDS_MAX) break;
  }
  return out;
}

export function cleanHostLan(raw: unknown): HostLan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const base = typeof r.base === "string" ? normalizeHostBase(r.base) : null;
  if (!base) return null;
  return { base, ssids: normalizeSsids(r.ssids), auto: r.auto === true };
}

/** One stored row, or `null` if it cannot be one. A name that cleans to
 *  nothing falls back to the address's own name, never to a placeholder. */
export function cleanSavedHost(raw: unknown): SavedHost | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isHostId(r.id)) return null;
  const base = typeof r.base === "string" ? normalizeHostBase(r.base) : null;
  if (!base) return null;
  const host: SavedHost = { id: r.id, name: normalizeHostName(r.name) ?? defaultHostName(base), base };
  if (r.legacy === true) host.legacy = true;
  const lan = cleanHostLan(r.lan);
  if (lan) host.lan = lan;
  return host;
}

/** A stored list: unreadable rows dropped, the first of a duplicate id kept,
 *  at most one `legacy`, capped. */
export function cleanHostList(raw: unknown): SavedHost[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedHost[] = [];
  let legacySeen = false;
  for (const r of raw) {
    const h = cleanSavedHost(r);
    if (!h || out.some((o) => o.id === h.id)) continue;
    if (h.legacy) {
      if (legacySeen) delete h.legacy;
      legacySeen = true;
    }
    out.push(h);
    if (out.length >= HOSTS_MAX) break;
  }
  return out;
}

/** Parse the `<prefix>hosts` JSON. `null` = absent or unreadable (so the caller
 *  can tell "no list yet" from "an empty list"). */
export function parseHostList(json: string | null | undefined): SavedHost[] | null {
  if (json == null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? cleanHostList(v) : null;
  } catch {
    return null;
  }
}

export function serializeHostList(hosts: readonly SavedHost[]): string {
  return JSON.stringify(hosts);
}

/** The IndexedDB a host's caches live in. The migrated host keeps the name
 *  the single-host app always used, so its caches survive the upgrade. */
export function dbNameFor(host: Pick<SavedHost, "id" | "legacy"> | null | undefined): string {
  if (!host || host.legacy) return BRAND.cacheName;
  return `${BRAND.cacheName}.${host.id}`;
}

/** The same database under every past identity, newest first (the copy-migration
 *  reads these; nothing else may open one). */
export function legacyDbNames(host: Pick<SavedHost, "id" | "legacy"> | null | undefined): string[] {
  return LEGACY.map((l) => (!host || host.legacy ? l.cacheName : `${l.cacheName}.${host.id}`));
}

// ── Migration ─────────────────────────────────────────────────────────

export interface HostMigrationInput {
  /** Raw `<prefix>hosts` (JSON), `null` when absent. */
  hosts: string | null;
  /** Raw `<prefix>hostActive`, `null` when absent. */
  active: string | null;
  /** Raw `<prefix>hostBase`, `null` when absent. */
  hostBase: string | null;
}

export interface HostMigration {
  hosts: SavedHost[];
  activeId: string | null;
  /** Values to write back; empty when storage already says this. */
  writes: { hosts?: string; active?: string; hostBase?: string };
}

/**
 * From whatever storage holds to a consistent list + active id.
 *
 * - no list, a `hostBase` ⇒ one `legacy` host, active. No key is copied: the
 *   legacy host's keys are already bare, which is where the active host's are.
 * - a list whose active id is missing or unknown ⇒ the first host.
 * - `hostBase` always ends up the active host's base (it is what the request
 *   shim reads), so a stale one is corrected rather than obeyed.
 *
 * Idempotent: applying `writes` and running again yields no writes.
 */
export function planHostMigration(input: HostMigrationInput): HostMigration {
  const writes: HostMigration["writes"] = {};
  let hosts = parseHostList(input.hosts);
  if (!hosts || hosts.length === 0) {
    const base = input.hostBase ? normalizeHostBase(input.hostBase) : null;
    if (!base) {
      // Nothing configured yet — and an unreadable list is left alone rather
      // than overwritten with an empty one.
      return { hosts: hosts ?? [], activeId: null, writes };
    }
    hosts = [{ id: LEGACY_HOST_ID, name: defaultHostName(base), base, legacy: true }];
    writes.hosts = serializeHostList(hosts);
  }
  const active = hosts.find((h) => h.id === input.active) ?? hosts[0]!;
  if (input.active !== active.id) writes.active = active.id;
  if (input.hostBase !== active.base) writes.hostBase = active.base;
  return { hosts, activeId: active.id, writes };
}

// ── Parking ───────────────────────────────────────────────────────────

export function parkPrefix(hostId: string): string {
  return `${HOST_PARK_PREFIX}${hostId}.`;
}

export function isParkedKey(key: string): boolean {
  return key.startsWith(HOST_PARK_PREFIX);
}

/** `<prefix>outbox` parked for `abc` ⇒ `<prefix>h.abc.outbox`. */
export function parkedKeyFor(bareKey: string, hostId: string): string {
  return parkPrefix(hostId) + bareKey.slice(BARE_PREFIX.length);
}

/** The inverse, or `null` when `key` is not parked under `hostId`. */
export function bareKeyFor(parkedKey: string, hostId: string): string | null {
  const p = parkPrefix(hostId);
  return parkedKey.startsWith(p) && parkedKey.length > p.length ? BARE_PREFIX + parkedKey.slice(p.length) : null;
}

/** Does this key follow the ACTIVE host (and so get parked on a switch)? */
export function isHostScopedKey(key: string, isDeviceKey: (k: string) => boolean): boolean {
  return key.startsWith(BARE_PREFIX) && !isParkedKey(key) && !isDeviceKey(key);
}

export type ParkOp = { op: "copy"; from: string; to: string } | { op: "remove"; key: string };

/**
 * The ordered storage operations that switch the active host from `fromId` to
 * `toId`, given every key in storage now.
 *
 * 1. PARK: every bare host-scoped key is copied to `<prefix>h.<fromId>.`.
 *    Parked keys of `fromId` with no bare key any more are removed — the park
 *    is a mirror, or a key deleted while active would come back on return.
 *    Never with an EMPTY bare set: that is a park already cleared by an
 *    interrupted switch, and mirroring it would delete every parked copy.
 * 2. CLEAR: the bare host-scoped keys are removed, only after every copy.
 * 3. RESTORE: `<prefix>h.<toId>.*` is copied to bare. The parked copy is KEPT
 *    (parked namespaces are never deleted; the next park overwrites them).
 *
 * Device keys and keys outside the prefix are never touched. Every op is a copy or a
 * remove the caller performs in order; an interruption at any point leaves
 * each value in at least one place.
 */
export function planHostSwitch(
  keys: readonly string[],
  isDeviceKey: (k: string) => boolean,
  fromId: string,
  toId: string,
): ParkOp[] {
  const ops: ParkOp[] = [];
  const bare = keys.filter((k) => isHostScopedKey(k, isDeviceKey));
  const bareSet = new Set(bare);
  const fromPrefix = parkPrefix(fromId);
  for (const k of bare) ops.push({ op: "copy", from: k, to: parkedKeyFor(k, fromId) });
  // Belt: with NO bare host key at all there is nothing to mirror — that is a
  // park already cleared (an interrupted switch), not a host whose every key
  // the app deleted, and mirroring it would delete every parked copy.
  if (fromId !== toId && bare.length > 0) {
    for (const k of keys) {
      if (!k.startsWith(fromPrefix)) continue;
      const b = bareKeyFor(k, fromId);
      if (b && !bareSet.has(b)) ops.push({ op: "remove", key: k });
    }
  }
  if (fromId === toId) return ops;
  for (const k of bare) ops.push({ op: "remove", key: k });
  for (const k of keys) {
    const b = bareKeyFor(k, toId);
    // A parked key that would restore onto a DEVICE key is ignored: device
    // keys belong to the phone, not to whichever host was active.
    if (b && !isDeviceKey(b)) ops.push({ op: "copy", from: k, to: b });
  }
  return ops;
}

/** The parked keys of one host — what "remove host" would leave behind (and
 *  keeps: the archive is never deleted with the row). */
export function parkedKeysOf(keys: readonly string[], hostId: string): string[] {
  const p = parkPrefix(hostId);
  return keys.filter((k) => k.startsWith(p));
}
