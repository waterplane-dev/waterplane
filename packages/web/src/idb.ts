/**
 * Tiny promise wrapper over IndexedDB — the offline read cache's storage
 * layer. Transcripts run to multiple MB for a long session, well past what
 * localStorage's ~5MB quota (shared with the send outbox — see outbox.ts)
 * can absorb, so they live here instead.
 *
 * DB `<brand>-cache` — per HOST in the Android shell (`dbNameFor`: the migrated
 * first host keeps `<brand>-cache`, every later one `<brand>-cache.<id>`), because
 * every store below is about one desktop's sessions, queue and files. Decided
 * once per document: a host switch is a reload. Each store names its own key below — sessionId for the two
 * per-session caches, a queue/pull id for the transfer stores:
 *  - `transcripts` — the reader view's last-known-good document.
 *  - `pty` (v2) — the last 64 KB of a session's raw terminal output, so a cold
 *    start with no host reachable can paint the scrollback it had rather than a
 *    black rectangle. Raw bytes, not a DTO: the shape and the trim rule live
 *    with the writer (App.tsx), this file only owns the store.
 *  - `uploads` (v3) — keyed by an outbox ackId instead: the image bytes of a
 *    queued inbox upload, i.e. the one thing in this DB that cannot be re-read
 *    from the host if it is dropped.
 *  - `pulls` (v4) — keyed by a pull id: the (possibly partial) bytes of an
 *    auto-downloaded artifact, plus how many of them are there. The resume
 *    offset lives WITH the bytes so the two can never disagree.
 *  - `tooldetail` (v5) — keyed `<sessionId>:<turnId>`: the tool inputs/results
 *    a `lite` transcript leaves on the host, for the turns someone actually
 *    opened. Cached so a tool call you expanded once still expands offline.
 *  - `screenlog` (v6) — keyed by sessionId: the lines that scrolled off the
 *    alt-screen grid, reconstructed client-side (screenlog.ts). The one cache
 *    here that CANNOT be re-fetched — the TUI's scrollback is not on the wire —
 *    which is exactly why panning up works with the tunnel down.
 *  - `gallery` (v7) — keyed by tab + coverage: the last listing the grid
 *    painted, so "Images & documents" opens on files instead of a spinner when
 *    the tunnel is down. Re-filtered locally, never re-derived (shared/gallery.ts).
 *  - `artifacttext` (v7) — keyed path + mtime: the text of a document someone
 *    opened in the viewer. An outbox report is the thing you take on a train.
 *  - `ctxseries` (v10) — keyed by sessionId: how full the context window has
 *    been over time, as the host read it off the CLI's conversation log.
 *  - `tokenstats` (v11) — one row: how many tokens every conversation on the
 *    desktop has ever used.
 *  - `dictations` (v12) — keyed by a held-clip id: the WAV of something that was
 *    SAID and not yet read by the desktop. The second store here that is not a
 *    cache — nobody can re-say a sentence, so losing these bytes loses words.
 *  - `thumbs` / `thumbmeta` (v8) — keyed by a thumbnail's versioned URL: the
 *    picture bytes of the gallery grid, and the small record eviction ranks
 *    them by. The service worker caches these too, but it is never registered
 *    inside the Android shell — so in the APK this store IS the offline grid
 *    (thumbCache.ts).
 *
 * Everything here is store-agnostic on purpose — a third store is a DB_VERSION
 * bump plus one more `createObjectStore` call in `upgrade()` and nothing else.
 *
 * Every operation is best-effort: IndexedDB can be unavailable (private
 * browsing in some browsers, storage disabled by policy) or a request can
 * fail (quota, corruption). Callers get `null` / a no-op, never a thrown
 * error — a broken read cache must never break the app that already works
 * fine from the live socket.
 */
import { dbNameFor, legacyDbNames } from "@waterplane/shared";
import { copyLegacyStores } from "./boot/brandMigrate.ts";
import { activeHost } from "./hosts.ts";
import { isNativeShell } from "./hostUrl.ts";

let dbName: string | null = null;
/** This document's DB. A removed host's DB is never deleted — re-adding the
 *  address reuses the id and so the name (`hosts.ts`). */
function thisDbName(): string {
  if (dbName === null) dbName = dbNameFor(isNativeShell() ? activeHost() : null);
  return dbName;
}
/** The same database under every older brand's name (`boot/brandMigrate.ts`). */
function thisLegacyDbNames(): string[] {
  return legacyDbNames(isNativeShell() ? activeHost() : null);
}

/**
 * A freshly opened handle, after the irreplaceable stores of an older brand's
 * database have been copied into it — so the first reader of `uploads` finds
 * the photo a queued send names. Bounded: a copy that hangs must not hang
 * every cache read behind it, so past `MIGRATE_WAIT_MS` the handle is handed
 * out and the copy finishes on its own (copy-if-absent, so a late row lands
 * beside whatever was written meanwhile, never over it).
 */
const MIGRATE_WAIT_MS = 8_000;
function afterMigration(db: IDBDatabase): Promise<IDBDatabase> {
  const copy = copyLegacyStores(db, thisLegacyDbNames()).catch(() => { /* best-effort */ });
  return Promise.race([copy, new Promise((r) => setTimeout(r, MIGRATE_WAIT_MS))]).then(() => db);
}
const DB_VERSION = 12;

function upgrade(db: IDBDatabase) {
  if (!db.objectStoreNames.contains("transcripts")) db.createObjectStore("transcripts");
  // v2 — offline PTY scrollback. `contains` guards keep this idempotent whether
  // the browser is coming from v0 (fresh install) or v1 (transcripts only).
  if (!db.objectStoreNames.contains("pty")) db.createObjectStore("pty");
  // v3 — the send queue's IMAGE bytes, keyed by the entry's ackId. The only
  // WRITE-side cache here: everything else in this DB can be re-fetched from the
  // host, an image queued while offline exists nowhere else. It is in IndexedDB
  // rather than localStorage for the obvious reason (a photo is megabytes) and
  // the load-bearing one: localStorage is where the send outbox lives, and a
  // blob evicting the queue would lose the prompts too.
  if (!db.objectStoreNames.contains("uploads")) db.createObjectStore("uploads");
  // v4 — auto-downloaded artifacts (pull.ts), keyed by pull id. The bytes of a
  // partially-fetched APK: the whole point is that they survive the app being
  // closed and the link dying, so a resume costs only what is left. Written as a
  // Blob, which the browser backs by disk rather than holding in the JS heap.
  if (!db.objectStoreNames.contains("pulls")) db.createObjectStore("pulls");
  // v5 — on-demand tool details. Written only for turns that were expanded, so
  // it stays small; losing it costs a re-fetch, never content (the host holds
  // the conversation log). See offlineCache.ts for the eviction rule.
  if (!db.objectStoreNames.contains("tooldetail")) db.createObjectStore("tooldetail");
  // v6 — reconstructed alt-screen scrollback, keyed by sessionId. Text lines,
  // not bytes: it is read by a plain DOM list, never written back into xterm.
  if (!db.objectStoreNames.contains("screenlog")) db.createObjectStore("screenlog");
  // v7 — the gallery's offline half: listings (what files exist) and the text of
  // documents that were opened. Both are re-fetchable, so losing them costs a
  // request; holding them is what makes the grid and an outbox report readable
  // with no host.
  if (!db.objectStoreNames.contains("gallery")) db.createObjectStore("gallery");
  if (!db.objectStoreNames.contains("artifacttext")) db.createObjectStore("artifacttext");
  // v8 — the gallery's PICTURES, keyed by the mtime-versioned thumbnail URL.
  // The service worker caches the same responses (public/sw.js `THUMBS`)
  // and would make this redundant — except that the Android shell registers no
  // service worker at all, which is precisely where an offline grid is the point
  // (main.tsx, thumbCache.ts). Blob and metadata are split so eviction can rank
  // 400 entries by age without reading 400 blobs out of the DB.
  if (!db.objectStoreNames.contains("thumbs")) db.createObjectStore("thumbs");
  if (!db.objectStoreNames.contains("thumbmeta")) db.createObjectStore("thumbmeta");
  // v9 — the file BROWSER's directory listings, keyed repo + directory path.
  // The gallery cache above answers "what deliverables exist"; this answers
  // "what is in this folder", which is the question a tree browser asks on
  // every tap. Re-fetchable, so losing it costs a request — but a phone in a
  // tunnel that can still walk the repo it was reading is the whole point.
  if (!db.objectStoreNames.contains("tree")) db.createObjectStore("tree");
  // v10 — the context-window series, keyed by sessionId. Re-fetchable, but the
  // graph is read at exactly the moment you are wondering whether a session is
  // about to compact again, and a spinner is a worse answer than a curve
  // labelled with its own age.
  if (!db.objectStoreNames.contains("ctxseries")) db.createObjectStore("ctxseries");
  // v11 — the token-statistics document, one row. Small (a few KB: 76 day
  // buckets, a handful of models and repos) but expensive for the HOST to
  // rebuild, so a phone that opens the screen offline shows the last scan
  // labelled with its age rather than nothing.
  if (!db.objectStoreNames.contains("tokenstats")) db.createObjectStore("tokenstats");
  // v12 — dictation audio waiting to be transcribed, keyed by clip id. Like
  // `uploads` and unlike everything else in this DB, it CANNOT be re-fetched:
  // the recording exists here and nowhere else until the host has read it. It
  // is why a dictation into a dead tunnel is now a wait instead of a loss
  // (dictateHold.ts).
  if (!db.objectStoreNames.contains("dictations")) db.createObjectStore("dictations");
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/**
 * Open the cache DB — and NEVER remember a failure.
 *
 * A failed open used to be cached in `dbPromise` for the life of the page, so
 * one transient condition disabled IndexedDB until a reload. That is fatal for
 * the ONE store here that is not a cache: an inbox upload parks its bytes in
 * `uploads` before it is queued, and `queueImageUpload` refuses to promise a
 * path it cannot back with bytes — so a stuck-null DB reads to the user as
 * "Upload failed", on every picture, for ever.
 *
 * The blocked case makes that worse and is not rare: another page of this app
 * on the same device (installed PWA + browser tab, WebView + browser) holding
 * an OLDER version blocks the upgrade, and every DB_VERSION bump ships that
 * state to whoever has two of them open. So a blocked upgrade falls back to
 * opening the EXISTING version instead: the older schema still has `uploads`
 * (v3) and every other store this build asks for degrades to "no cache" on its
 * own. Writing into last version's DB is right — the stores here are
 * append-only caches keyed by strings, never migrated in place.
 */
function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    const attempt = new Promise<IDBDatabase | null>((resolve) => {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      let settled = false;
      const done = (db: IDBDatabase | null) => { if (!settled) { settled = true; resolve(db); } };
      try {
        const req = indexedDB.open(thisDbName(), DB_VERSION);
        req.onupgradeneeded = () => upgrade(req.result);
        req.onsuccess = () => { void afterMigration(ready(req.result)).then(done); };
        req.onerror = () => done(null);
        // Another page holds an older version open, so the upgrade can't run.
        // An unsettled promise here means every caller awaits for ever
        // (`ptyRestored` never flips, the attach effect never fires), so this
        // must settle — with whatever DB already exists, not with nothing.
        req.onblocked = () => { void openExisting().then((db) => (db ? afterMigration(db) : null)).then(done); };
      } catch { done(null); }
    });
    // Only a working handle is remembered. Anything else is forgotten
    // immediately, so the NEXT call retries — the other tab closes, the storage
    // hiccup passes, and uploads start working again without a reload.
    dbPromise = attempt.then((db) => { if (!db) dbPromise = null; return db; });
  }
  return dbPromise;
}

/** Open whatever version is on disk, without asking for an upgrade. */
function openExisting(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(thisDbName());
      req.onsuccess = () => resolve(ready(req.result));
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** Wire a handle up so it is dropped the moment it stops being usable. */
function ready(db: IDBDatabase): IDBDatabase {
  const drop = () => { if (dbPromise) dbPromise = null; };
  // A LATER page wanting a newer version must not be blocked by this one: close
  // on request, which turns its `onblocked` into a normal open. `onclose` is the
  // same rule for a handle the browser killed under us (storage reclaimed, a
  // forced close) — without it every later call transacts on a dead handle.
  db.onversionchange = () => { db.close(); drop(); };
  db.onclose = drop;
  return db;
}

/** Run one request against `store` and resolve its result, or `null` on any
 *  failure (missing DB, blocked, quota, …) — every failure mode reads the
 *  same to a caller: "no cache". */
async function run<T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(store, mode);
      const req = op(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
    });
  } catch (err) {
    // `transaction()` throws on a handle that is closing or already closed
    // (`InvalidStateError`) — the state a version change or a browser-forced
    // close leaves behind. Drop the cached handle so the next call re-opens
    // instead of failing every write from here on; a store this build knows
    // about but the on-disk version does not (`NotFoundError`, the fallback
    // open above) is a real "no cache" and keeps the handle.
    if ((err as DOMException)?.name !== "NotFoundError") dbPromise = null;
    return null;
  }
}

export const idbGet = <T,>(store: string, key: string): Promise<T | null> =>
  run<T>(store, "readonly", (s) => s.get(key));

export const idbSet = async (store: string, key: string, value: unknown): Promise<void> => {
  await run(store, "readwrite", (s) => s.put(value, key));
};

export const idbDel = async (store: string, key: string): Promise<void> => {
  await run(store, "readwrite", (s) => s.delete(key));
};

/** All values currently in `store` — used by prune sweeps that need to rank
 *  everything by a field of their own (e.g. `savedAt`) before evicting. */
export const idbGetAll = async <T,>(store: string): Promise<T[]> =>
  (await run<T[]>(store, "readonly", (s) => s.getAll())) ?? [];

/** The keys in `store`. Used where the key IS the fact — the retained upload
 *  bytes are keyed by the path a prompt names, so "which files could still be
 *  re-attached" is a key listing and not a scan of megabytes of blobs. */
export const idbKeys = async (store: string): Promise<string[]> =>
  ((await run<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys())) ?? []).map(String);

/**
 * How much is in `store`, without pulling it all into memory.
 *
 * A cursor rather than `getAll()`: the two biggest stores here are blobs
 * (`pulls` can hold a 90 MB APK, `thumbs` up to 400 pictures), and the one
 * moment anybody asks this question is when the phone is already short of
 * space. Reading a Blob out of a cursor hands back a HANDLE — the bytes stay
 * on disk — so `sizeOf` may ask a blob its `.size` for free.
 *
 * `sizeOf` is the caller's (`storageAudit.ts`) because what a record weighs is
 * a fact about its shape, not about IndexedDB. It must be synchronous: an
 * `await` inside the loop ends the transaction under us.
 *
 * `include` narrows the walk to part of a store. One store here genuinely
 * holds two different things under two key shapes — `uploads` has the bytes of
 * a queued send under its ackId and the bytes of a send that DIED under a
 * `keep:` path — and they are not the same row on a screen that asks whether
 * something may be deleted. Filtering by key inside the cursor keeps it one
 * pass, and keeps the count honest: an excluded entry is not counted either.
 *
 * **Null is not zero.** A store the browser refused to open answers null, and
 * an empty one answers `{ count: 0, bytes: 0 }` — the difference is the whole
 * reason `StoreUse.bytes` is nullable (`storagePlan.ts`).
 */
export const idbMeasure = async (
  store: string,
  sizeOf: (value: unknown) => number,
  include?: (key: string) => boolean,
): Promise<{ count: number; bytes: number } | null> => {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      let count = 0;
      let bytes = 0;
      try {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).openCursor();
        req.onsuccess = () => {
          const cur = req.result as IDBCursorWithValue | null;
          if (!cur) return;           // walked off the end; `tx.oncomplete` settles
          if (!include || include(String(cur.key))) {
            count++;
            try { bytes += sizeOf(cur.value) || 0; } catch { /* a shape we don't know weighs nothing we can claim */ }
          }
          cur.continue();
        };
        req.onerror = () => resolve(null);
        tx.oncomplete = () => resolve({ count, bytes });
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch { resolve(null); }
    });
  } catch (err) {
    if ((err as DOMException)?.name !== "NotFoundError") dbPromise = null;
    return null;
  }
};

/**
 * Empty `store`, and say whether it actually emptied.
 *
 * Not `run()`: `clear()` resolves with `undefined`, which that helper cannot
 * tell from its own "no cache" null — and "cleared" printed over a store that
 * is still full is the one sentence the storage screen must never say. This
 * waits for `tx.oncomplete`, which is the only event that means the bytes are
 * gone.
 */
export const idbClear = async (store: string): Promise<boolean> => {
  try {
    const db = await openDb();
    if (!db) return false;
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch { resolve(false); }
    });
  } catch (err) {
    if ((err as DOMException)?.name !== "NotFoundError") dbPromise = null;
    return false;
  }
};

/**
 * Delete the entries of `store` whose KEY the predicate accepts.
 *
 * The companion to `idbMeasure`'s `include`, and it must take the same
 * predicate the measurement used or a screen deletes a different set from the
 * one it counted. Used for `uploads`, where a `keep:`-prefixed orphan and a
 * live queued send share a store and must never share a button.
 *
 * Answers false on any failure, like `idbClear` — and, unlike it, false also
 * when the walk was interrupted part way, because a partial delete is not the
 * clear the caller is about to report.
 */
export const idbClearWhere = async (store: string, pred: (key: string) => boolean): Promise<boolean> => {
  try {
    const db = await openDb();
    if (!db) return false;
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(store, "readwrite");
        const req = tx.objectStore(store).openCursor();
        req.onsuccess = () => {
          const cur = req.result as IDBCursorWithValue | null;
          if (!cur) return;
          if (pred(String(cur.key))) cur.delete();
          cur.continue();
        };
        req.onerror = () => resolve(false);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch { resolve(false); }
    });
  } catch (err) {
    if ((err as DOMException)?.name !== "NotFoundError") dbPromise = null;
    return false;
  }
};
