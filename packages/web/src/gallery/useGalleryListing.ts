import { useEffect, useState } from "react";
import { filterGalleryRows, galleryScopeKey, type GalleryCoverage } from "@waterplane/shared";
import { api, isOffline, type ArtifactKind } from "../api";
import { getGalleryListing, putGalleryListing } from "../offlineCache";
import { isImage, isImageKind, isVideo } from "../docKind";
import { prefetchThumbs } from "../thumbCache";
import { learnMtimes } from "../fileMtime";
import { PAGE, THUMB_WARM, defaultSince, type GalleryProps, type Row, type Scope } from "./galleryTypes";
import { thumbForRow } from "./galleryUrls";

/** The grid's listing: which tab, which cut, the rows, and every honest state of the fetch. */
export function useGalleryListing({ repoId, repos, initialScope, initialAllTime, initialNew }: Pick<GalleryProps, "repoId" | "repos" | "initialScope" | "initialAllTime" | "initialNew">) {
  const singleRepo = !!repoId;
  const initScope = initialScope ?? (singleRepo ? "outbox" : "all");
  const [scope, setScope] = useState<Scope>(initScope);
  // Per-scope default time window. Outbox is a curated, phone-facing drop — the
  // recent files are what you want, so it defaults to 2h. Every other tab
  // defaults to All time (a global 2h default made them look empty; inbox
  // ignores `since` entirely). Switching tabs resets to the new tab's default;
  // a manual 10m/2h/24h/all pick sticks until you switch scope.
  /** The badge's cut, as the seconds-ago window the listing API speaks. Rounded
   *  UP, so the boundary file itself is never the one left out. */
  const newSecs = initialNew ? Math.max(1, Math.ceil((Date.now() - initialNew.since) / 1000)) : undefined;
  const [since, setSince] = useState<number | undefined>(
    newSecs ?? (initialAllTime ? undefined : defaultSince(initScope)));
  /** Still showing the cut we were opened on. Cleared by any other chip or tab,
   *  because from then on the list is the user's question and not the badge's. */
  const [onNewCut, setOnNewCut] = useState(!!newSecs);
  // Switch scope AND reset the time filter to that scope's default in one go.
  const changeScope = (s: Scope) => { setScope(s); setSince(defaultSince(s)); setLimit(PAGE); setOnNewCut(false); };
  const [kind, setKind] = useState<ArtifactKind>("all");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<Row[]>([]);
  const [truncated, setTruncated] = useState(false);
  // A listing fetch is on the wire. On a good link this is a flicker; on a
  // roaming one it is ten seconds during which the grid kept showing the PREVIOUS
  // tab's files and the chip you tapped un-highlighted itself on release — so
  // the honest reading of the screen was "that button does nothing".
  const [loading, setLoading] = useState(true);
  // A FAILED listing is not an empty one. Both used to render "Nothing here
  // yet.", which is a lie that costs a real trip to the desktop to disprove.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // The rows on screen came from this device's cache, saved at this instant —
  // set while a live listing is still on the wire (a seed) and, more
  // importantly, kept when the listing never arrives. Null = live rows.
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  // Why the live listing didn't land. Null while it is merely still in flight:
  // "old, and here is why" and "old, for another second" are different claims.
  const [staleWhy, setStaleWhy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Grid paging — "load more" raises the cap rather than fetching everything.
  const [limit, setLimit] = useState(PAGE);

  // A stable key for the repo set — `repos` is a fresh array on every App render
  // (sessions/PTY stream re-render it constantly), so depending on it directly
  // refired this effect many times/sec.
  const repoKey = (repos ?? []).map((r) => r.id).join(",");

  // What this tab is, and what is being asked of it — the two halves of the
  // offline cache's identity (shared/gallery.ts). `since` is dropped for the
  // inbox because the HOST ignores it there: pretending that listing is
  // windowed would make a 10m chip hide rows the live view keeps.
  const coverage: GalleryCoverage = { kind, since: scope === "inbox" ? undefined : since };
  const scopeKey = galleryScopeKey(scope, repoId, repoKey);

  useEffect(() => {
    // Guard against overlapping fetches resolving out of order: without this, a
    // stale in-flight fetch (e.g. inbox) could land AFTER a newer one (outbox)
    // and overwrite the grid — switching tabs looked like it did nothing.
    let cancelled = false;
    // Whether the LIVE listing has landed. The cache read races it (IndexedDB is
    // fast, but it is not ordered against fetch), and a cached listing painting
    // over the fresh one would be the same bug in a new place.
    let live = false;
    setLoading(true);
    setLoadErr(null);
    setStaleWhy(null);
    /** A live listing. `cacheAs` overrides what gets written when the rows on
     *  screen are a client-side subset (the inbox pages and filters locally) —
     *  the cache always holds the SUPERSET an offline filter runs over. */
    const apply = (rows: Row[], trunc: boolean, cacheAs?: { rows: Row[]; cov: GalleryCoverage; truncated: boolean }) => {
      if (cancelled) return;
      live = true;
      setFiles(rows); setTruncated(trunc); setLoading(false); setLoadErr(null); setCachedAt(null);
      // Every row carries the mtime that makes a thumbnail URL cacheable, and
      // the same files get mentioned in transcripts and backlog items where
      // nothing knows it. Cheapest source there is — this listing is already
      // here (fileMtime.ts).
      learnMtimes(rows, repoId);
      // Only an UNFILTERED listing is cached: caching "the four rows matching
      // 'apk'" would answer the next question by luck rather than by coverage.
      if (!query.trim()) {
        const c = cacheAs ?? { rows, cov: coverage, truncated: trunc };
        void putGalleryListing(scopeKey, c.cov, c.rows, c.truncated);
      }
    };
    /** Paint the newest listing this device holds that COVERS this question,
     *  re-filtered locally. Returns whether there was one. `final` is set by the
     *  failure path — a seed must leave `loading` alone so the chips keep saying
     *  the live listing is still on the wire. */
    const showCached = async (final: boolean): Promise<boolean> => {
      const hit = await getGalleryListing<Row>(scopeKey, coverage);
      if (cancelled || live) return false;
      if (!hit) { if (final) setLoading(false); return false; }
      const rows = filterGalleryRows(hit.rows, { ...coverage, query }, isImageKind, Date.now());
      // Cached rows too: the listing outlives the mtime map's cap, and a reader
      // opened offline can still build a versioned URL for what it holds.
      learnMtimes(rows, repoId);
      setFiles(rows.slice(0, limit));
      // Honest both ways: more rows than this page shows, or a listing the host
      // had already truncated when it was saved.
      setTruncated(rows.length > limit || (hit.exact && hit.truncated));
      setCachedAt(hit.savedAt);
      if (final) setLoading(false);
      return true;
    };
    // Seed immediately. On a good link this is invisible (the live rows replace
    // it a moment later); on a dead one it IS the answer, and it is the
    // difference between eight skeleton tiles for ever and the files you came
    // for — their thumbnails still in the service worker's cache.
    void showCached(false);
    // Keep whatever is on screen: a dropped link should not also wipe the rows
    // you were looking at. The banner says the list is stale; the rows stay usable.
    const fail = (e: unknown) => {
      if (cancelled) return;
      void showCached(true).then((had) => {
        if (cancelled) return;
        setLoading(false);
        const why = isOffline(e) ? "the host didn't answer" : String((e as Error)?.message || e || "request failed");
        // With a cached listing the failure is a footnote on rows that are
        // already useful; with nothing cached it is the headline, because a
        // failed listing is not an empty one.
        setStaleWhy(had ? why : null);
        setLoadErr(had ? null : why);
      });
    };
    if (scope === "all") {
      api.search({
        query,
        kind,
        scope: "repo",
        sinceSeconds: since,
        repoIds: repoKey ? repoKey.split(",") : undefined,
        limit,
      }).then((d) => apply(d.hits, d.truncated)).catch(fail);
    } else if (scope === "inbox") {
      // Opening the inbox marks it read. Separate from the listing GET because
      // it writes — the host only accepts it as a POST.
      api.markInboxSeen(repoId!);
      api.inbox(repoId!).then((f) => {
        // The inbox listing is one small dir: the host sends all of it and the
        // filtering/paging is client-side — through the same rules the offline
        // path uses, so a chip can't mean two different things.
        const matched = filterGalleryRows(f as Row[], { kind, query }, isImageKind, Date.now());
        apply(matched.slice(0, limit), matched.length > limit,
          { rows: f as Row[], cov: { kind: "all" }, truncated: false });
      }).catch(fail);
    } else {
      // Opening the outbox marks it read — same split as the inbox: the badge
      // reset is a POST, not a side effect of the listing GET.
      if (scope === "outbox") api.markOutboxSeen(repoId!);
      api.artifacts(repoId!, scope, since, { query, kind, limit }).then((d) => apply(d.files, d.truncated)).catch(fail);
    }
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the listing's own key parts; `coverage` and `scopeKey` are derived from them
  }, [repoId, repoKey, scope, since, kind, query, reload, limit]);

  // Warm a screenful of pictures onto this device the moment a LIVE listing
  // lands. Only then: with the rows coming out of the cache we already know the
  // host is not answering, and firing two dozen requests at a dead tunnel warms
  // nothing and delays whatever else is queued behind them.
  useEffect(() => {
    if (cachedAt != null || loadErr) return;
    prefetchThumbs(
      files.filter((f) => isImage(f.relPath) || isVideo(f.relPath)).slice(0, THUMB_WARM).map((f) => thumbForRow(scope, repoId, f)),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- warm only when the listed files change; scope and repo are already reflected in them
  }, [files, cachedAt, loadErr]);

  // A narrower filter should start over at page 1, not keep a deep page open.
  useEffect(() => { setLimit(PAGE); }, [since, kind, query, repoId]);
  return {
    singleRepo, scope, changeScope, since, setSince, newSecs, onNewCut, setOnNewCut, kind, setKind, query, setQuery,
    files, truncated, loading, loadErr, cachedAt, staleWhy, setReload, setLimit,
  };
}
