/**
 * What this device knows about a repo file's mtime — the missing ingredient in
 * every thumbnail URL built from a PATH alone.
 *
 * A thumbnail is only cacheable if its URL is VERSIONED: `?thumb=<w>&v=<mtime>`
 * (media.ts `sized()`). That is the rule the host marks the response
 * `immutable` on, the rule the service worker's `<slug>-thumbs-v1` gates on, and
 * the rule `thumbCache.ts` stores blobs under. The gallery satisfies it for
 * free — its rows carry `mtime`. Everything else that shows the same picture
 * does not:
 *
 *  - a file mentioned in a transcript (`fileRefs.ts` → the reader's inline
 *    thumbnail),
 *  - the image a backlog item references,
 *  - the viewer opened from either of those.
 *
 * Those asked for `?thumb=<w>` with no `v`, which no cache here may keep, so
 * they fell through to the network and were served only by the browser's own
 * HTTP cache (`max-age=86400`). Offline that works until the entry ages out or
 * gets evicted, and then the picture is simply gone — the "why is this image
 * broken again" report, and intermittent for a reason that has nothing to do
 * with the file.
 *
 * So mtimes are remembered here, from every source that already knows one:
 * a gallery/search listing that landed, an upload the host just acknowledged,
 * or a one-off `stat` for a path nothing has covered yet. With one in hand the
 * reader builds the SAME URL the gallery builds — so the two share one cache
 * entry, and a picture warmed by the grid paints in the reader with no request
 * at all.
 *
 * localStorage rather than IndexedDB, deliberately: the value has to be
 * available SYNCHRONOUSLY at render time (the URL is built inside the render
 * that draws the `<img>`), and an async read would mean pointing the image at
 * the un-versioned URL first and swapping it a moment later — two decodes and a
 * flash per thumbnail. Entries are ~60 bytes and capped; the quota this shares
 * with the send queue (outbox.ts) is not meaningfully touched.
 *
 * Nothing here is a source of truth. A stale mtime costs one wasted request
 * (the host answers the current bytes under an old `v`, and the next listing
 * corrects it); a missing one costs exactly the un-versioned behaviour that
 * existed before.
 */
import { useEffect, useState } from "react";
import { isOffline, timedFetch } from "@waterplane/shared";
import { abs } from "./hostUrl";
import { LS, lsGet, lsSetJson } from "./storage";

const KEY = LS.fileMtimes;
/** Paths remembered. A phone works a handful of repos and the same screenshots
 *  come back again and again; past this the oldest WRITE is dropped, which
 *  costs one `stat` when the link is up and nothing else. */
const MAX_PATHS = 400;
/** A stat is a few dozen bytes of JSON. Longer than this and the link has
 *  bigger problems than a thumbnail URL. */
const STAT_MS = 8000;

type Map_ = Record<string, number>;

const cacheKey = (repoId: string, relPath: string) => `${repoId}:${relPath}`;

let mem: Map_ | null = null;

function load(): Map_ {
  if (mem) return mem;
  try { mem = JSON.parse(lsGet(KEY) || "{}") as Map_; }
  catch { mem = {}; }
  return mem;
}

function save(): void {
  // quota / private mode — the in-memory copy still serves this session
  lsSetJson(KEY, mem ?? {});
}

// ── Subscribers ───────────────────────────────────────────────────────────
// A `stat` that lands after the first paint has to reach the component that
// drew the picture, and only that component (an App-wide re-render per learned
// mtime would be a re-render per file mentioned in a transcript).
const subs = new Map<string, Set<() => void>>();

function notify(key: string): void {
  for (const fn of subs.get(key) ?? []) fn();
}

/** The mtime this device last saw for a file, or undefined. Synchronous. */
export function knownMtime(repoId: string, relPath: string): number | undefined {
  return load()[cacheKey(repoId, relPath)];
}

/** Record an mtime somebody already knows (a listing row, an upload receipt). */
export function rememberMtime(repoId: string, relPath: string, mtime: number): void {
  if (!repoId || !relPath || !mtime) return;
  const m = load();
  const key = cacheKey(repoId, relPath);
  if (m[key] === mtime) return;
  // Re-insert at the end so the eviction below is oldest-write-first (object
  // key order is insertion order for string keys).
  delete m[key];
  m[key] = mtime;
  const keys = Object.keys(m);
  if (keys.length > MAX_PATHS) for (const k of keys.slice(0, keys.length - MAX_PATHS)) delete m[k];
  save();
  notify(key);
}

/** Record every row of a listing that just landed. The gallery is the cheapest
 *  source there is — it already fetched exactly this. */
export function learnMtimes(
  rows: { relPath: string; mtime: number; repoId?: string }[],
  fallbackRepoId?: string,
): void {
  for (const r of rows) {
    const id = r.repoId ?? fallbackRepoId;
    if (id) rememberMtime(id, r.relPath, r.mtime);
  }
}

/** Paths already asked about, so a transcript that mentions the same screenshot
 *  forty times asks the host once — and a 404 (deleted file) is not re-asked
 *  on every scroll. */
const asked = new Set<string>();

/**
 * Learn a path's mtime from the host, at most once per path per page.
 *
 * Fire-and-forget by design: the caller has already drawn something, and this
 * either improves the next render or does nothing at all. Safe to call from a
 * render (it never sets state synchronously) though the hook below is the
 * normal way in.
 */
export function ensureMtime(repoId: string, relPath: string): void {
  if (!repoId || !relPath) return;
  const key = cacheKey(repoId, relPath);
  if (asked.has(key) || load()[key]) return;
  asked.add(key);
  void (async () => {
    try {
      const url = abs(`/api/repos/${repoId}/artifact?path=${encodeURIComponent(relPath)}&stat=1`);
      // Raw `timedFetch`, not `nfetch`: this is a background nicety and must not
      // blink the NetActivity bar (same rule as the transcript poll). The FUSE
      // is not optional — a hung host must not leave the path marked "asked".
      const r = await timedFetch(url, undefined, STAT_MS);
      if (!r.ok) return; // deleted, refused, or a gate — leave it un-versioned
      const d = (await r.json()) as { mtime?: number };
      if (d?.mtime) rememberMtime(repoId, relPath, d.mtime);
    } catch (e) {
      // Offline is the normal case here (the whole point is the picture that
      // has to survive it) and re-asking costs nothing once the link is back.
      if (isOffline(e)) asked.delete(key);
    }
  })();
}

/**
 * The mtime for a file, learned in the background if this device doesn't have
 * one yet. Re-renders only the component that asked.
 */
export function useFileMtime(repoId: string | null | undefined, relPath: string): number | undefined {
  const key = repoId ? cacheKey(repoId, relPath) : "";
  const [, bump] = useState(0);
  useEffect(() => {
    if (!repoId) return;
    const fn = () => bump((n) => n + 1);
    const set = subs.get(key) ?? new Set<() => void>();
    subs.set(key, set);
    set.add(fn);
    ensureMtime(repoId, relPath);
    return () => {
      set.delete(fn);
      if (!set.size) subs.delete(key);
    };
  }, [key, repoId, relPath]);
  return repoId ? knownMtime(repoId, relPath) : undefined;
}
