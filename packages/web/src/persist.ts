/**
 * Ask the browser to stop evicting the caches that hold the only copy of
 * something.
 *
 * IndexedDB and Cache Storage are BEST-EFFORT by default: under storage
 * pressure the browser may drop a whole origin's data without asking, and it
 * does so on exactly the device this app targets — a phone with a full camera
 * roll. Most of what `idb.ts` holds is re-fetchable and losing it costs a
 * request, which is why nobody noticed. Three stores are not:
 *
 *  - `uploads` — the bytes of a queued inbox image. `attachments.ts` goes to
 *    real trouble to MOVE these aside rather than delete them when an upload
 *    dies (`keepUploadBytes`), on the stated grounds that erasing the only copy
 *    on the only device that had it is what made a failed upload
 *    unrecoverable. An eviction does precisely that, silently.
 *  - `pulls` — the partial bytes of an artifact download, whose entire purpose
 *    is surviving the app being closed and the link dying.
 *  - `screenlog` — the lines that scrolled off the TUI. Not on the wire and not
 *    on the host: if this goes, that history is simply gone.
 *
 * `navigator.storage.persist()` promotes the origin to "persistent", which the
 * browser then evicts only on an explicit user action. It is a request, not a
 * command — Chrome grants it on an installed PWA or a sufficiently engaged
 * origin and silently declines otherwise — so this reports what actually
 * happened rather than assuming, and the app behaves exactly as before either
 * way.
 *
 * Called once at boot (`main.tsx`) and surfaced in `NetHealthSheet`, because
 * "your queued photo may be deleted without warning" is a fact the user can act
 * on: installing the PWA is usually what flips it.
 */

export interface StorageState {
  /** The API exists at all (false on http://100.x — not a secure context). */
  supported: boolean;
  /** The origin is exempt from automatic eviction. */
  persisted: boolean;
  /** Bytes in use / available, when the browser will say. */
  usage?: number;
  quota?: number;
}

let last: StorageState = { supported: false, persisted: false };

/** What we last learned, for a synchronous render. Never fetches. */
export function storageState(): StorageState {
  return last;
}

/** Re-read usage/quota and the persisted flag without re-requesting. */
export async function readStorageState(): Promise<StorageState> {
  const s = navigator.storage;
  if (!s?.estimate) return (last = { supported: false, persisted: false });
  const next: StorageState = {
    supported: typeof s.persist === "function",
    persisted: s.persisted ? await s.persisted().catch(() => false) : false,
  };
  const est = await s.estimate().catch(() => null);
  if (est) { next.usage = est.usage; next.quota = est.quota; }
  return (last = next);
}

/**
 * Request persistence once per load. Idempotent and best-effort: an origin that
 * is already persistent is not re-asked, and a refusal is recorded rather than
 * retried in a loop — the browser's answer does not change within a session,
 * and a repeated prompt is worse than the default it would replace.
 */
export async function requestPersistence(): Promise<StorageState> {
  const s = navigator.storage;
  if (!s || typeof s.persist !== "function") return (last = { supported: false, persisted: false });
  try {
    const already = s.persisted ? await s.persisted() : false;
    if (!already) await s.persist();
  } catch {
    // Storage disabled by policy, or private browsing. The caches still work;
    // they are simply as evictable as they were before this file existed.
  }
  return readStorageState();
}

