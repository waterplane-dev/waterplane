/**
 * The default cache behind `useRemoteResource`: pure rules, no IndexedDB.
 *
 * Every host read gets its last copy kept (store `rescache`, `offlineCache.ts`
 * writes it) so a screen opens on rows labelled with their age, offline too.
 * Three rules live here so they can be pinned without a browser:
 *  - the KEY names the desktop as well as the resource (a switched or removed
 *    desktop never paints another one's rows — the DB is per host in the shell
 *    already, this is the belt to that brace);
 *  - a value past `MAX_VALUE_BYTES` of JSON is not kept (a cache that holds one
 *    huge document evicts a hundred small ones for nothing);
 *  - the store holds at most `MAX_ENTRIES`, newest `savedAt` first out of the sweep.
 * A `shape` number discards entries written under another DTO shape.
 */

export const MAX_ENTRIES = 200;
export const MAX_VALUE_BYTES = 1_000_000;

export interface ResCacheEntry {
  key: string;
  host: string;
  /** The caller's `shape`: a changed DTO discards old entries. */
  v: number;
  savedAt: number;
  value: unknown;
}

/** `<host id>|<resource key>` — `|` cannot appear in a host id (hosts.ts ids are slugs). */
export function resCacheKey(host: string | null, key: string): string {
  return `${host ?? "local"}|${key}`;
}

/** The entry to store, or null when the value is not worth keeping (unserialisable,
 *  `undefined`/`null`, or past the size cap). Size is the JSON length, an upper
 *  bound on bytes for the mostly-ASCII documents this holds. */
export function makeEntry(host: string | null, key: string, shape: number, value: unknown, now: number): ResCacheEntry | null {
  if (value === undefined || value === null) return null;
  let json: string;
  try { json = JSON.stringify(value); } catch { return null; }
  if (typeof json !== "string" || json.length > MAX_VALUE_BYTES) return null;
  return { key: resCacheKey(host, key), host: host ?? "local", v: shape, savedAt: now, value };
}

/** Whether a stored row may be shown: same shape, same desktop. */
export function entryUsable(e: ResCacheEntry | null | undefined, host: string | null, key: string, shape: number): e is ResCacheEntry {
  return !!e && e.key === resCacheKey(host, key) && e.v === shape && typeof e.savedAt === "number";
}

/** Keys to delete so at most `max` rows remain: the oldest by `savedAt`. */
export function sweepVictims(all: readonly Pick<ResCacheEntry, "key" | "savedAt">[], max = MAX_ENTRIES): string[] {
  if (all.length <= max) return [];
  return [...all].sort((a, b) => b.savedAt - a.savedAt).slice(max).map((e) => e.key);
}

/**
 * The consent tokens a cached copy must not keep (`confirmgate.ts`: one-shot, minted per read, so a
 * stored one is spent or expired by the time it is painted — and a tap on it only earns "this
 * confirm has expired"). A token says `cache: false`; where the rest of the DTO is worth keeping
 * offline, the token alone is dropped before the copy is written. A screen opened on such a copy
 * has NO token until its live read answers, and says so rather than sending an old one.
 * ComplianceReport.confirm, AskRulesReply.confirm, RepoHealthView.engine.approveToken.
 */
export function withoutConfirm<T>(v: T): T {
  if (!v || typeof v !== "object" || !("confirm" in (v as object))) return v;
  const { confirm: _c, ...rest } = v as T & { confirm?: unknown };
  return rest as T;
}
export function withoutApproveToken<T>(v: T): T {
  const engine = (v as { engine?: { approveToken?: string } | null } | null)?.engine;
  if (!engine || typeof engine !== "object" || !("approveToken" in engine)) return v;
  const { approveToken: _a, ...rest } = engine;
  return { ...(v as object), engine: rest } as T;
}
