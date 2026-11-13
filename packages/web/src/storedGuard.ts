/**
 * A stored value is in one of three states, never two: READ (it parsed and has the
 * shape), ABSENT (nothing there), or UNREADABLE (something is there and we cannot
 * use it). The last used to collapse into "empty" — `JSON.parse` threw, the caller
 * got `[]`, and the next save wrote over the only copy of what somebody typed.
 *
 * Takes the storage as an argument so a node test can hand it a stub; the screens
 * never import this, `outbox.ts` does.
 *
 * **Where the raw bytes go:** `<key>.unreadable`, written once and never
 * overwritten. If that slot already holds a DIFFERENT value, the new one goes to
 * `<key>.unreadable-<hash of the value>` — a fixed slot alone would let a second
 * corruption destroy the first, and a timestamp would pile up a copy per read; a
 * content-addressed key is found again by the next read, so each distinct corrupt
 * value is copied exactly once. All are unregistered prefixed keys, so a host switch parks them with their host
 * (`isDeviceKey`), and nothing reads them back on its own: a person (or a later
 * recovery screen) decides what they are worth.
 */
export type StoreLike = Pick<Storage, "getItem" | "setItem">;

export interface Reading<T> {
  value: T;
  /** Something was stored and could not be used. `value` is the fallback. */
  unreadable: boolean;
}

export const UNREADABLE_SUFFIX = ".unreadable";

/** FNV-1a over the string plus its length: a stable name for a value, not a security hash. */
function fingerprint(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 0x01000193) >>> 0;
  return `${h.toString(36)}${raw.length.toString(36)}`;
}

/**
 * Keep `raw` beside `key`, never over anything. True = a copy of exactly `raw`
 * now exists; false = even that failed (quota, private mode).
 */
export function keepAside(st: StoreLike, key: string, raw: string, now = Date.now()): boolean {
  try {
    const slot = key + UNREADABLE_SUFFIX;
    const held = st.getItem(slot);
    if (held === raw) return true;
    if (held === null) { st.setItem(slot, raw); return true; }
    const own = `${slot}-${fingerprint(raw)}`;
    const ownHeld = st.getItem(own);
    if (ownHeld === raw) return true;
    // Same fingerprint, different value (a collision): never overwrite it.
    st.setItem(ownHeld === null ? own : `${own}-${now}`, raw);
    return true;
  } catch { return false; }
}

export function readGuarded<T>(st: StoreLike, key: string, fallback: T, valid: (v: unknown) => boolean): Reading<T> {
  let raw: string | null;
  try { raw = st.getItem(key); } catch { return { value: fallback, unreadable: true }; }
  if (raw === null || raw === "") return { value: fallback, unreadable: false };
  try {
    const v: unknown = JSON.parse(raw);
    if (valid(v)) return { value: v as T, unreadable: false };
  } catch { /* falls through: unreadable */ }
  keepAside(st, key, raw);
  return { value: fallback, unreadable: true };
}

/**
 * `false` = the store refused it (quota, private mode); nothing was written.
 *
 * With `valid`, the write also refuses to replace a value that is stored but
 * unreadable unless a copy of it is held aside: the read-time copy can have failed
 * (a corrupt value that fills the quota), and replacing it with a small list would
 * then succeed and destroy the only copy.
 */
export function writeChecked(st: StoreLike, key: string, val: unknown, valid?: (v: unknown) => boolean): boolean {
  try {
    if (valid) {
      const raw = st.getItem(key);
      if (raw !== null && raw !== "" && !parses(raw, valid) && !keepAside(st, key, raw)) return false;
    }
    st.setItem(key, JSON.stringify(val));
    return true;
  } catch { return false; }
}

function parses(raw: string, valid: (v: unknown) => boolean): boolean {
  try { return valid(JSON.parse(raw)); } catch { return false; }
}
