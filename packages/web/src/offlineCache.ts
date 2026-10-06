/**
 * Offline READ cache — lets the phone keep showing transcript / slash /
 * prompt-history / backlog / gallery content while the tunnel to the host is
 * down.
 * Nothing here is a source of truth: every value is last-known-good, always
 * overwritten by the next live fetch, and safe to lose (worst case is falling
 * back to fetch-only, same as before this existed).
 *
 * Storage tiers, split by size and by who writes them:
 *  - Transcripts are MBs for a long session → IndexedDB (idb.ts), which has
 *    no meaningful size cap.
 *  - Slash commands and prompt history are small → localStorage, BUT that
 *    quota (~5MB) is shared with the send outbox (outbox.ts), the one store
 *    that must never be evicted by our own growth. History therefore strips
 *    the bulky `output` field before it's ever written here.
 *  - Tool inputs/results are NOT in the transcript at all (the document is
 *    `lite` — see the host's transcript.ts); the sets a reader actually opened
 *    are cached separately, also in IndexedDB.
 *  - Gallery listings and the text of documents someone opened → IndexedDB for
 *    the same reason (a repo listing is thousands of rows), with the rules for
 *    re-filtering a cached listing in `shared/gallery.ts`. The PICTURES are not
 *    here: thumbnails are cached by the service worker under their versioned
 *    URLs (public/sw.js), and a downloaded original is in the `pulls` store.
 */
import { galleryCacheKey, pickCoveringListing, type GalleryCoverage, type GalleryRow } from "@waterplane/shared";
import type { ContextSeriesDoc, HistoryEntry, TokenStatsDoc, TranscriptDoc, TranscriptToolDetail } from "@waterplane/shared";
import { api, type SlashCommand } from "./api";
import { dataSaver } from "./media";
import { idbClear, idbDel, idbGet, idbGetAll, idbSet } from "./idb";
import { wantedDetail } from "./transcriptUtil";
import { LS, lsJson, lsSetJson } from "./storage";

// ── Transcripts (IndexedDB) ───────────────────────────────────────────────

const TRANSCRIPT_STORE = "transcripts";
/** Kept to the newest N sessions by `savedAt` — an abandoned session's cached
 *  transcript would otherwise sit in IndexedDB forever. Falling out of the
 *  cache just means that session goes back to fetch-only; nothing breaks. */
const MAX_TRANSCRIPTS = 12;

interface CachedTranscript { sessionId: string; savedAt: number; doc: TranscriptDoc; }

export async function putTranscript(doc: TranscriptDoc): Promise<void> {
  const entry: CachedTranscript = { sessionId: doc.sessionId, savedAt: Date.now(), doc };
  await idbSet(TRANSCRIPT_STORE, doc.sessionId, entry);
  void pruneTranscripts();
}

export async function getTranscript(sessionId: string): Promise<TranscriptDoc | null> {
  const cached = await idbGet<CachedTranscript>(TRANSCRIPT_STORE, sessionId);
  return cached?.doc ?? null;
}

/**
 * The same document WITH the moment this phone wrote it down.
 *
 * `doc.updatedAt` is when the CONVERSATION last moved, which is a different
 * fact and the one the reader was labelling its cached copy with: a session
 * that went quiet at 14:00 and was cached at 18:00 read as "as of 14:00", so
 * the number said nothing about how out of date the copy is. `savedAt` is the
 * one a staleness sentence needs.
 */
export async function getTranscriptAt(sessionId: string): Promise<{ value: TranscriptDoc; savedAt: number } | null> {
  const cached = await idbGet<CachedTranscript>(TRANSCRIPT_STORE, sessionId);
  return cached ? { value: cached.doc, savedAt: cached.savedAt } : null;
}

/**
 * Keep a session's transcript cached WITHOUT the reader being open.
 *
 * The cache used to be written only by `TranscriptView`, which means it only
 * ever held sessions someone had already read in reader view. Watch a session
 * in the terminal for an hour, lose the tunnel, then open the reader — the one
 * thing you want, "what did it do before the link died", was never saved, and
 * the reader had nothing to show. The output was on the phone the whole time
 * (the socket delivered every frame); nobody had written it down.
 *
 * Cheap by construction: `since` makes an unchanged log a 204, so a quiet
 * session costs one conditional request. The throttle exists for the opposite
 * case — a busy session ends a turn every few seconds and the document is MBs.
 *
 * Best-effort everywhere: a failure leaves the previous cache entry alone and
 * lets the next turn-end try again (the caller only fires this over a live
 * socket, so a retry is not a retry into a dead link).
 */
const PREFETCH_MIN_MS = 90_000;
const lastPrefetch = new Map<string, number>();

/** One read per session at a time. The terminal's cost strip (`TermCostStrip`)
 *  forces a read on the same turn end `useTermFeed` prefetches on, and two
 *  concurrent reads of one moved log would download the document twice; the
 *  second caller joins the first instead. */
const inflightPrefetch = new Map<string, Promise<void>>();

export function prefetchTranscript(sessionId: string, force = false): Promise<void> {
  const running = inflightPrefetch.get(sessionId);
  if (running) return running;
  const p = prefetchOnce(sessionId, force).finally(() => {
    if (inflightPrefetch.get(sessionId) === p) inflightPrefetch.delete(sessionId);
  });
  inflightPrefetch.set(sessionId, p);
  return p;
}

async function prefetchOnce(sessionId: string, force: boolean): Promise<void> {
  const now = Date.now();
  const prev = lastPrefetch.get(sessionId) ?? 0;
  // Data saver multiplies the gap rather than disabling the prefetch: the point
  // of the cache is the link being GONE, which is exactly when a metered
  // connection stops mattering.
  if (!force && now - prev < PREFETCH_MIN_MS * (dataSaver() ? 4 : 1)) return;
  lastPrefetch.set(sessionId, now);
  try {
    const have = await getTranscript(sessionId);
    const want = wantedDetail();
    // `since` only when what we hold is the shape we now want: after a switch to
    // "full details" an unchanged log would answer 204 and leave the cache
    // holding a lite document forever, i.e. the setting would appear to do
    // nothing until the session next moved.
    const since = have && (have.detail ?? "full") === want ? have.updatedAt : undefined;
    const next = await api.transcript(sessionId, since, want);
    if (next) await putTranscript(next);   // null = 204, what we hold is current
  } catch {
    lastPrefetch.set(sessionId, prev);     // unthrottle, so the next turn-end retries
  }
}

/** Forget the throttle for a session (it went away, or the user asked for a
 *  refresh) so the next call fetches instead of no-oping. */
export function resetTranscriptPrefetch(sessionId?: string): void {
  if (sessionId) lastPrefetch.delete(sessionId); else lastPrefetch.clear();
}

/**
 * Cache the transcript of EVERY session, not only the one on screen.
 *
 * The per-session prefetch above only ever fired for the session you had
 * attached, which means the phone went offline holding one document and a list
 * of eleven sessions whose reader said "loading transcript…" forever. Offline
 * has to mean the whole list, because which session you want to read is exactly
 * the thing you don't know until the link is already gone.
 *
 * Affordable now that transcripts are `lite` (tool inputs/results stay on the
 * host — see the host's transcript.ts): a document is KBs, `since` makes an
 * unmoved session a 204, and the per-session throttle still applies. Runs
 * strictly SEQUENTIALLY — a dozen parallel fetches over a tunnel that is
 * already the bottleneck would slow the session you are actually reading.
 *
 * `ids` should arrive newest-first; only the first `MAX_TRANSCRIPTS` are swept,
 * since anything past that would be evicted by `pruneTranscripts` anyway.
 */
export async function sweepTranscripts(ids: string[]): Promise<void> {
  if (sweeping) return;              // one sweep at a time; the next tick retries
  sweeping = true;
  try {
    for (const id of ids.slice(0, MAX_TRANSCRIPTS)) {
      // Sequential on purpose (see above) — and best-effort per session: one
      // that 404s (never produced a log) must not abort the rest of the sweep.
      await prefetchTranscript(id).catch(() => undefined);
    }
  } finally {
    sweeping = false;
  }
}
let sweeping = false;

// ── Tool details (IndexedDB) ──────────────────────────────────────────────
//
// A `lite` transcript carries no tool inputs/results; the reader fetches a
// turn's set when someone opens one. Caching what was opened is what makes a
// tool call you already looked at still open with the tunnel down. Nothing here
// is ever the only copy — the host holds the conversation log.

const TOOLS_STORE = "tooldetail";
/** Turn-sets kept. A few dozen expanded turns is far more than anyone reads in
 *  one session, and each set is a handful of KB. */
const MAX_TOOL_TURNS = 60;

interface CachedTools { key: string; savedAt: number; tools: Record<string, TranscriptToolDetail>; }
const toolsKey = (sessionId: string, turnId: string) => `${sessionId}:${turnId}`;

export async function putToolDetails(
  sessionId: string, turnId: string, tools: Record<string, TranscriptToolDetail>,
): Promise<void> {
  const key = toolsKey(sessionId, turnId);
  await idbSet(TOOLS_STORE, key, { key, savedAt: Date.now(), tools } satisfies CachedTools);
  void pruneToolDetails();
}

export async function getToolDetails(
  sessionId: string, turnId: string,
): Promise<Record<string, TranscriptToolDetail> | null> {
  return (await idbGet<CachedTools>(TOOLS_STORE, toolsKey(sessionId, turnId)))?.tools ?? null;
}

async function pruneToolDetails(): Promise<void> {
  const all = await idbGetAll<CachedTools>(TOOLS_STORE);
  if (all.length <= MAX_TOOL_TURNS) return;
  const stale = [...all].sort((a, b) => b.savedAt - a.savedAt).slice(MAX_TOOL_TURNS);
  for (const c of stale) await idbDel(TOOLS_STORE, c.key);
}

async function pruneTranscripts(): Promise<void> {
  const all = await idbGetAll<CachedTranscript>(TRANSCRIPT_STORE);
  if (all.length <= MAX_TRANSCRIPTS) return;
  const stale = [...all].sort((a, b) => b.savedAt - a.savedAt).slice(MAX_TRANSCRIPTS);
  for (const c of stale) await idbDel(TRANSCRIPT_STORE, c.sessionId);
}

// ── Context-window series (IndexedDB) ─────────────────────────────────────
//
// The graph's last-known-good curve. Re-fetchable from the host, so losing it
// costs a request — but it is looked at precisely when the link is the thing
// misbehaving, and a curve labelled "from 20 min ago" is a far better answer
// than a spinner. Kept beside the transcripts because it is the same document
// read a second way, and evicted on the same rule.

const CTX_STORE = "ctxseries";
/** Series kept, by `savedAt`. Matches the transcript cache: the same handful of
 *  sessions is what a phone actually works with. */
const MAX_CTX_SERIES = 12;

interface CachedCtxSeries { sessionId: string; savedAt: number; doc: ContextSeriesDoc; }

export async function putContextSeries(doc: ContextSeriesDoc): Promise<void> {
  await idbSet(CTX_STORE, doc.sessionId, { sessionId: doc.sessionId, savedAt: Date.now(), doc } satisfies CachedCtxSeries);
  void pruneContextSeries();
}

/**
 * The cached series WITH the moment this phone wrote it down.
 *
 * `savedAt`, not `doc.updatedAt` — the latter is when the CONVERSATION last
 * moved, which is a different fact and the one a staleness label must not use:
 * a session that went quiet at 14:00 and was cached at 18:00 would read as "as
 * of 14:00" and say nothing about how out of date the copy is.
 */
export async function getContextSeriesAt(sessionId: string): Promise<{ value: ContextSeriesDoc; savedAt: number } | null> {
  const c = await idbGet<CachedCtxSeries>(CTX_STORE, sessionId);
  return c ? { value: c.doc, savedAt: c.savedAt } : null;
}

async function pruneContextSeries(): Promise<void> {
  const all = await idbGetAll<CachedCtxSeries>(CTX_STORE);
  if (all.length <= MAX_CTX_SERIES) return;
  const stale = [...all].sort((a, b) => b.savedAt - a.savedAt).slice(MAX_CTX_SERIES);
  for (const c of stale) await idbDel(CTX_STORE, c.sessionId);
}

// ── Token statistics (IndexedDB) ──────────────────────────────────────────
//
// One row. Cheap to hold and expensive for the host to rebuild — a cold scan
// walks ~10k conversation logs — so the screen opens on the last figures this
// phone saw, labelled with their age, instead of a spinner on a dead link.

const TOKENS_STORE = "tokenstats";
const TOKENS_KEY = "all";

/**
 * The cached document's SHAPE, bumped whenever a field the screen reads without
 * guarding is added to `TokenStatsDoc`.
 *
 * This is not bookkeeping for its own sake — it is the fix for a boot crash.
 * The cache is seeded BEFORE the live read (that is the whole point of
 * `useRemoteResource`), the tokens overlay is in `PERSISTED_OVERLAYS`, and a
 * reload restores it. So a document this phone wrote down last week, rendered
 * by a bundle that has since gained a required field, does not fail on one
 * screen: it throws inside the restored overlay on every boot, and the app
 * comes up as `BootGuard`'s "waterplane couldn't start" with a `TypeError` naming a
 * property nobody can connect to a cache. Measured exactly that with `cost`.
 *
 * A stale record is a cache MISS, deliberately, rather than something to patch
 * up with zeros: a zero cost and "this desktop was never priced" are the same
 * number on screen, and the whole file refuses that trade elsewhere.
 */
const TOKENS_SHAPE = 3;

interface CachedTokenStats { v?: number; savedAt: number; doc: TokenStatsDoc }

export async function putTokenStats(doc: TokenStatsDoc): Promise<void> {
  await idbSet(TOKENS_STORE, TOKENS_KEY, { v: TOKENS_SHAPE, savedAt: Date.now(), doc } satisfies CachedTokenStats);
}

/** With the moment this phone wrote it down — `savedAt`, not the host's own
 *  `scannedAt`, for the reason the transcript cache states: they are different
 *  facts and only the first can carry a staleness sentence. */
export async function getTokenStatsAt(): Promise<{ value: TokenStatsDoc; savedAt: number } | null> {
  const c = await idbGet<CachedTokenStats>(TOKENS_STORE, TOKENS_KEY);
  if (!c || c.v !== TOKENS_SHAPE || !usableTokenStats(c.doc)) return null;
  return { value: c.doc, savedAt: c.savedAt };
}

/**
 * The version stamp catches every future addition; this catches the one that
 * has already happened, and anything a truncated write left behind. Belt and
 * braces on purpose — the failure mode being guarded is not "this screen is
 * empty", it is "the app does not start".
 */
function usableTokenStats(doc: TokenStatsDoc | undefined): boolean {
  if (!doc || typeof doc !== "object") return false;
  if (!doc.cost || typeof doc.cost.total !== "number") return false;
  if (!doc.subagentCost || !doc.unpriced) return false;
  if (!Array.isArray(doc.days) || !Array.isArray(doc.models) || !Array.isArray(doc.repos)) return false;
  return doc.days.every((d) => !!d.cost) && doc.models.every((g) => !!g.cost) && doc.repos.every((g) => !!g.cost);
}

// ── a contributed ledger view's document (IndexedDB) ───────────────────────
//
// A backend's own ledger behind the same screen (`LedgerViewDef`, sdk), cached the same way and in
// the SAME object store under the backend's id — a second key is free, a new store is a
// `DB_VERSION` bump every open device pays for. (`opencode` is the key its copy has always had.)
//
// Kept apart from the row above rather than merged into it: two ledgers are different accounting
// for the same word and must never be summed. One row holding both would be one write where the
// host answered twice, and a phone that had read one source and not the other would have no way to
// say which half was stale. The view supplies the SHAPE (see `TOKENS_SHAPE` for why it exists at all:
// a required field added to a document a phone wrote down last week is a boot crash, not an empty
// screen, because this sheet is restored on boot) and what may come back out (`usable`).

interface CachedLedgerDoc { v?: number; savedAt: number; doc: unknown }

/** A view id is a backend id (`^[a-z]`); the claude row's key is not one. */
const ledgerKey = (id: string): string | null => (/^[a-z][\w.-]*$/.test(id) && id !== TOKENS_KEY ? id : null);

export async function putLedgerDoc(id: string, shape: number, doc: unknown): Promise<void> {
  const key = ledgerKey(id);
  if (!key) return;
  await idbSet(TOKENS_STORE, key, { v: shape, savedAt: Date.now(), doc } satisfies CachedLedgerDoc);
}

/** With the moment this phone wrote it down — `savedAt`, not the host's own `scannedAt`, for the
 *  reason the transcript cache states. A record of another shape, or one `usable` refuses, is a miss. */
export async function getLedgerDocAt<D>(id: string, shape: number, usable: (doc: unknown) => doc is D): Promise<{ value: D; savedAt: number } | null> {
  const key = ledgerKey(id);
  if (!key) return null;
  const c = await idbGet<CachedLedgerDoc>(TOKENS_STORE, key);
  if (!c || c.v !== shape || !usable(c.doc)) return null;
  return { value: c.doc, savedAt: c.savedAt };
}

// ── Gallery listings (IndexedDB) ──────────────────────────────────────────
//
// What files exist, per tab and per coverage (see shared/gallery.ts). A grid
// with the tunnel down used to be eight skeleton tiles for ever; now it paints
// the last listing this phone saw, labelled with when it saw it, and the
// service worker's thumbnail cache fills most of the pictures in for free.
//
// Written only for an UNFILTERED listing (no search text): the cached rows are
// the superset a local filter runs over, so caching "the four files matching
// 'apk'" would make the next question answerable only by luck.

const GALLERY_STORE = "gallery";
/** Listings kept. A tab holds a few coverages (all-time, 4h, images-only) and a
 *  phone works a handful of repos — past this the oldest are dropped, which
 *  costs one request when the link is up and nothing else. */
const MAX_LISTINGS = 24;

interface CachedListing extends GalleryCoverage {
  key: string;
  scopeKey: string;
  savedAt: number;
  rows: GalleryRow[];
  /** The host's own flag: there were more rows than the page asked for. */
  truncated: boolean;
}

export async function putGalleryListing<T extends GalleryRow>(
  scopeKey: string, cov: GalleryCoverage, rows: T[], truncated: boolean,
): Promise<void> {
  const key = galleryCacheKey(scopeKey, cov);
  await idbSet(GALLERY_STORE, key, {
    key, scopeKey, savedAt: Date.now(), rows, truncated, kind: cov.kind, since: cov.since,
  } satisfies CachedListing);
  void pruneListings();
}

/** The best cached listing for `want`, or null. `savedAt` comes back because the
 *  caller MUST say how old the rows are — see the header of shared/gallery.ts. */
export async function getGalleryListing<T extends GalleryRow>(
  scopeKey: string, want: GalleryCoverage,
): Promise<{ rows: T[]; truncated: boolean; savedAt: number; exact: boolean } | null> {
  const all = await idbGetAll<CachedListing>(GALLERY_STORE);
  const hit = pickCoveringListing(all.filter((e) => e.scopeKey === scopeKey), want);
  if (!hit) return null;
  const exact = hit.kind === want.kind && hit.since === want.since;
  return { rows: hit.rows as T[], truncated: hit.truncated, savedAt: hit.savedAt, exact };
}

async function pruneListings(): Promise<void> {
  const all = await idbGetAll<CachedListing>(GALLERY_STORE);
  if (all.length <= MAX_LISTINGS) return;
  const stale = [...all].sort((a, b) => b.savedAt - a.savedAt).slice(MAX_LISTINGS);
  for (const c of stale) await idbDel(GALLERY_STORE, c.key);
}

// ── File-browser directory listings (IndexedDB) ───────────────────────────
//
// One record per repo + directory. Unlike the gallery's coverage-keyed cache
// there is nothing to re-filter and nothing to reason about: a directory
// listing either is the one you asked for or it isn't. It comes back with
// `savedAt` for the same reason the gallery's does — a stale listing must SAY
// it is stale, because a file someone deleted an hour ago still shows here.

const TREE_STORE = "tree";
/** Directories kept. Walking down five levels of three repos is well under this. */
const MAX_DIRS = 120;

interface CachedDir { key: string; savedAt: number; listing: unknown }
const dirKey = (repoId: string, path: string) => `${repoId}:${path}`;

export async function putTreeListing(repoId: string, path: string, listing: unknown): Promise<void> {
  const key = dirKey(repoId, path);
  await idbSet(TREE_STORE, key, { key, savedAt: Date.now(), listing } satisfies CachedDir);
  void pruneDirs();
}

export async function getTreeListing<T>(repoId: string, path: string): Promise<{ listing: T; savedAt: number } | null> {
  const hit = await idbGet<CachedDir>(TREE_STORE, dirKey(repoId, path));
  return hit ? { listing: hit.listing as T, savedAt: hit.savedAt } : null;
}

async function pruneDirs(): Promise<void> {
  const all = await idbGetAll<CachedDir>(TREE_STORE);
  if (all.length <= MAX_DIRS) return;
  const stale = [...all].sort((a, b) => b.savedAt - a.savedAt).slice(MAX_DIRS);
  for (const c of stale) await idbDel(TREE_STORE, c.key);
}

// ── Opened documents (IndexedDB) ──────────────────────────────────────────
//
// The gallery renders text and markdown in place, which is the whole reason an
// agent drops a report in the outbox: it is meant to be READ on the phone. That
// read was a live fetch of the file every time, so the report you opened on
// wifi was gone on the train. Cached per path AND mtime — a regenerated report
// at the same path is a different document, and showing yesterday's under
// today's name is the one wrong answer here (same rule as artifactMarks).

const TEXT_STORE = "artifacttext";
/** Documents kept. These are capped at the viewer's own preview size, so a few
 *  dozen is a couple of MB at worst. */
const MAX_TEXT_DOCS = 40;

interface CachedText { key: string; savedAt: number; text: string; truncated: boolean }
const textKey = (repoId: string, relPath: string, mtime: number) =>
  `${repoId}:${relPath}:${Math.round(mtime)}`;

export async function putArtifactText(
  repoId: string, relPath: string, mtime: number, text: string, truncated: boolean,
): Promise<void> {
  const key = textKey(repoId, relPath, mtime);
  await idbSet(TEXT_STORE, key, { key, savedAt: Date.now(), text, truncated } satisfies CachedText);
  void pruneTexts();
}

export async function getArtifactText(
  repoId: string, relPath: string, mtime: number,
): Promise<{ text: string; truncated: boolean; savedAt: number } | null> {
  const hit = await idbGet<CachedText>(TEXT_STORE, textKey(repoId, relPath, mtime));
  return hit ? { text: hit.text, truncated: hit.truncated, savedAt: hit.savedAt } : null;
}

async function pruneTexts(): Promise<void> {
  const all = await idbGetAll<CachedText>(TEXT_STORE);
  if (all.length <= MAX_TEXT_DOCS) return;
  const stale = [...all].sort((a, b) => b.savedAt - a.savedAt).slice(MAX_TEXT_DOCS);
  for (const c of stale) await idbDel(TEXT_STORE, c.key);
}

// ── Slash commands (localStorage) ─────────────────────────────────────────

const SLASH_KEY = LS.slashCache;
/** Repos, not entries — a phone works a handful of repos regularly; a cache
 *  that grows with every repo ever opened is just quota pressure for no gain. */
const MAX_SLASH_REPOS = 20;

interface SlashCacheEntry { ts: number; commands: SlashCommand[]; }
type SlashCache = Record<string, SlashCacheEntry>;

function loadSlashCache(): SlashCache {
  return lsJson(SLASH_KEY, {});
}
function saveSlashCache(cache: SlashCache): void {
  lsSetJson(SLASH_KEY, cache);
}

/** The same list WITH the moment it was written — what `useRemoteResource`
 *  needs to be able to say how old a cached palette is. A cached list that
 *  cannot state its age is the failure that hook exists to prevent. */
export function getSlashCacheEntry(cwd: string): { value: SlashCommand[]; savedAt: number } | null {
  const hit = loadSlashCache()[cwd];
  return hit ? { value: hit.commands, savedAt: hit.ts } : null;
}

export function putSlashCache(cwd: string, commands: SlashCommand[]): void {
  const cache = loadSlashCache();
  delete cache[cwd]; // reinsert at the end so the eviction below is LRU-by-write-order
  cache[cwd] = { ts: Date.now(), commands };
  const keys = Object.keys(cache);
  if (keys.length > MAX_SLASH_REPOS) for (const k of keys.slice(0, keys.length - MAX_SLASH_REPOS)) delete cache[k];
  saveSlashCache(cache);
}

// ── Prompt history (localStorage) ─────────────────────────────────────────

const HISTORY_KEY = LS.snapHistory;
const MAX_HISTORY_SESSIONS = 20;
const MAX_HISTORY_ENTRIES = 50;

/** Same shape as HistoryEntry, minus the captured-output field — see the file
 *  header for why. `output` absent reads identically to `output: undefined`,
 *  so this is drop-in compatible with anything typed `HistoryEntry[]`. */
type StrippedEntry = Omit<HistoryEntry, "output">;
type HistorySnap = Record<string, StrippedEntry[]>;

function loadHistoryCache(): HistorySnap {
  return lsJson(HISTORY_KEY, {});
}
function saveHistoryCache(snap: HistorySnap): void {
  lsSetJson(HISTORY_KEY, snap);
}

/** Seed a `Map<sessionId, HistoryEntry[]>` for a useState initializer — sync
 *  (localStorage), so it can render before the WS handshake completes. */
export function loadHistorySnap(): Map<string, HistoryEntry[]> {
  return new Map(Object.entries(loadHistoryCache()));
}

/** Cache one session's recorded prompts, output stripped and capped to the
 *  newest `MAX_HISTORY_ENTRIES`. Call this whenever a live `session.history`
 *  reply arrives so the HistorySheet still has something to show offline. */
export function saveHistoryEntries(sessionId: string, entries: HistoryEntry[]): void {
  const snap = loadHistoryCache();
  delete snap[sessionId]; // reinsert at the end — see the slash cache's eviction comment
  snap[sessionId] = entries.slice(-MAX_HISTORY_ENTRIES).map(({ output: _output, ...rest }) => rest);
  const keys = Object.keys(snap);
  if (keys.length > MAX_HISTORY_SESSIONS) for (const k of keys.slice(0, keys.length - MAX_HISTORY_SESSIONS)) delete snap[k];
  saveHistoryCache(snap);
}

// ── Letting go of it ────────────────────────────────────────────────────────

/**
 * Empty one of the read caches this file owns — the storage screen's per-row
 * button (`storageAudit.ts`).
 *
 * Here rather than in `storageAudit.ts` calling `idbClear` itself because of
 * the throttle: `prefetchTranscript` keeps a per-session "asked recently" map
 * in memory, and a transcript store cleared behind its back would not be
 * re-fetched until that throttle expired — the reader would sit on an empty
 * cache it believes is warm. Every other store here is disk-only, and passing
 * them through one door keeps it that way visibly.
 */
export async function forgetCacheStore(store: "transcripts" | "tooldetail" | "gallery" | "artifacttext" | "tree" | "ctxseries" | "tokenstats"): Promise<boolean> {
  const ok = await idbClear(store);
  if (store === TRANSCRIPT_STORE) resetTranscriptPrefetch();
  return ok;
}
