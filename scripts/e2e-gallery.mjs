// The gallery with no host: which cached listing may answer which question.
//
// "Images & documents" is four filters over an HTTP listing, so with the tunnel
// down it used to be eight skeleton tiles that never filled in — while the
// phone held the answer twice over (it painted that listing minutes ago, and
// the thumbnail bytes are on the device — service worker in the browser,
// IndexedDB in the APK; see web/src/thumbCache.ts).
//
// The cache is only safe because of the rules pinned here, and both failure
// directions are silent on the device you aren't holding:
//  - too generous, and a stored listing answers a question it does not cover:
//    the grid then HIDES files that exist (a 4h listing serving "all time") or
//    SHOWS files that were filtered out on purpose (an image listing serving
//    "docs"). Either reads as data loss, not as a stale cache.
//  - too strict, and nothing ever matches: the offline gallery is empty again,
//    which is the bug this exists to fix.
// The local filter must also mean exactly what the host's own filter means
// (files.ts `discoverArtifacts`): window cut on mtime, `image` including video.
import { readFileSync, readdirSync } from "node:fs";
import { coversQuery, filterGalleryRows, galleryCacheKey, galleryScopeKey, pickCoveringListing } from "../packages/shared/dist/gallery.js";

let failed = false;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failed = true; };
const eq = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), `${label}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` — got ${JSON.stringify(a)}`}`);

// ── Coverage: what a stored listing is allowed to answer ────────────
const ALL = { kind: "all" };                  // no `since` = all time

check(coversQuery(ALL, { kind: "image", since: 600 }),
  "an all-kinds, all-time listing answers every narrower question");
check(coversQuery({ kind: "all", since: 86400 }, { kind: "doc", since: 14400 }),
  "a wider window covers a narrower one");
check(!coversQuery({ kind: "all", since: 14400 }, { kind: "all", since: 86400 }),
  "a 4h listing must NOT answer 24h — the missing rows exist, they were just never fetched");
check(!coversQuery({ kind: "all", since: 14400 }, ALL),
  "no window covers all time");
check(!coversQuery({ kind: "image" }, { kind: "doc" }),
  "an images listing can never answer docs, however wide its window");
check(coversQuery({ kind: "image" }, { kind: "image", since: 600 }),
  "same kind, wider window: covered");
check(coversQuery({ kind: "all", since: 600 }, { kind: "all", since: 600 }),
  "identical coverage covers itself (the common case: same tab, link now down)");

// ── Picking among what is stored ────────────────────────────────────
const entries = [
  { kind: "all", since: undefined, savedAt: 1_000, tag: "broad-old" },
  { kind: "all", since: 14400, savedAt: 9_000, tag: "exact-new" },
  { kind: "image", since: undefined, savedAt: 8_000, tag: "images" },
];
eq(pickCoveringListing(entries, { kind: "all", since: 14400 })?.tag, "exact-new",
  "an exact coverage match wins — fewest rows discarded, and its truncated flag still means what it said");
eq(pickCoveringListing(entries, { kind: "doc", since: 86400 })?.tag, "broad-old",
  "no exact match ⇒ a wider listing answers, filtered down locally (the 4h one cannot: 24h is outside it)");
eq(pickCoveringListing(entries, { kind: "image", since: 86400 })?.tag, "images",
  "among covering listings the freshest wins — 'saved a minute ago' beats 'broader, saved long before'");
eq(pickCoveringListing(entries, { kind: "all", since: 600 })?.tag, "exact-new",
  "a 4h listing answers a 10m question; the all-time one is older, so it loses the tie-break");
eq(pickCoveringListing([{ kind: "all", since: 600, savedAt: 5 }], ALL), null,
  "nothing covering ⇒ null, never a best-effort guess");
eq(pickCoveringListing([], { kind: "all" }), null, "an empty cache is not an empty listing");

// ── Local filtering must mean what the host's filter means ──────────
const isImageKind = (p) => /\.(png|jpe?g|gif|webp|svg|heic)$/i.test(p) || /\.(mp4|webm|mov)$/i.test(p);
const NOW = 1_000_000_000;
const rows = [
  { name: "shot.png", relPath: ".claude/outbox/shot.png", mtime: NOW - 60_000 },
  { name: "clip.mp4", relPath: ".claude/outbox/clip.mp4", mtime: NOW - 60_000 },
  { name: "report.md", relPath: ".claude/outbox/report.md", mtime: NOW - 60_000 },
  { name: "old-report.md", relPath: ".claude/outbox/old-report.md", mtime: NOW - 90_000_000 },
];
const names = (r) => r.map((f) => f.name);

eq(names(filterGalleryRows(rows, { kind: "image" }, isImageKind, NOW)), ["shot.png", "clip.mp4"],
  "kind=image includes VIDEO, exactly as the host's kindExt does");
eq(names(filterGalleryRows(rows, { kind: "doc" }, isImageKind, NOW)), ["report.md", "old-report.md"],
  "kind=doc is everything the image kind is not");
eq(names(filterGalleryRows(rows, { kind: "all", since: 14400 }, isImageKind, NOW)),
  ["shot.png", "clip.mp4", "report.md"],
  "the window cuts on mtime (the host's cutoff field), so the day-old report drops out");
eq(names(filterGalleryRows(rows, { kind: "all", query: "REPORT" }, isImageKind, NOW)),
  ["report.md", "old-report.md"],
  "the name search is case-insensitive substring, same as the host's q");
eq(names(filterGalleryRows(rows, { kind: "doc", since: 14400, query: "report" }, isImageKind, NOW)), ["report.md"],
  "kind + window + query compose");
eq(names(filterGalleryRows(rows, { kind: "all", query: "   " }, isImageKind, NOW)), names(rows),
  "a blank search is no search — a whitespace query must not empty the grid");

// ── Cache identity ──────────────────────────────────────────────────
eq(galleryScopeKey("outbox", "repo-1"), "repo-1|outbox", "a repo tab keys on the repo");
check(galleryScopeKey("all", undefined, "a,b") !== galleryScopeKey("all", undefined, "a,b,c"),
  "the all-repos tab keys on the repo SET — adding a repo genuinely changes the listing");
check(galleryCacheKey("repo-1|outbox", { kind: "all", since: 14400 })
  !== galleryCacheKey("repo-1|outbox", { kind: "all" }),
  "two coverages of one tab are two cache entries, so an incomparable pair (images-all-time, everything-4h) both survive");
eq(galleryCacheKey("repo-1|outbox", { kind: "image" }), "repo-1|outbox|image|all",
  "all time is spelled out in the key, never left undefined");

// ── The client half ─────────────────────────────────────────────────
// Static, because the interesting states (link down, cache warm) are a browser
// away from a node script — and every one of these is silent when it regresses:
// the gallery keeps working perfectly on the desk.
// Gallery.tsx is a thin composer over gallery/ (docs/notes/webclient-architecture.md): read them all.
const gallery = ["Gallery.tsx", ...readdirSync("packages/web/src/gallery").filter((f) => /\.tsx?$/.test(f)).map((f) => `gallery/${f}`)]
  .map((f) => readFileSync(`packages/web/src/${f}`, "utf8")).join("\n");
check(/void showCached\(false\)/.test(gallery),
  "the grid is SEEDED from the cache before the live listing lands — offline, that seed is the whole answer");
check(/if \(cancelled \|\| live\) return false;/.test(gallery),
  "a cache read that resolves after the live listing must not paint over it");
check(/if \(!query\.trim\(\)\) \{/.test(gallery),
  "only an UNFILTERED listing is cached — cached search hits would answer the next question by luck");
check(/cachedAt != null/.test(gallery) && /last saw/.test(gallery),
  "rows from the cache are LABELLED with their age — a stale list presented as live is the only real failure mode here");
check(/localUrl \?\? viewFor/.test(gallery) && /state === "done"/.test(gallery),
  "a finished auto-download is rendered from the bytes on the phone, not re-fetched (and only when it is complete)");
check(/putArtifactText/.test(gallery) && /getArtifactText/.test(gallery),
  "an opened document is kept, so the outbox report you read on wifi is still readable on the train");
check(/isOffline\(e\)/.test(gallery),
  "a failed WRITE (delete) says the host didn't answer instead of leaving a dead-looking button");

const cache = readFileSync("packages/web/src/offlineCache.ts", "utf8");
check(/pickCoveringListing/.test(cache),
  "the web cache picks a listing through the shared coverage rule, not a hand-rolled match");

const idb = readFileSync("packages/web/src/idb.ts", "utf8");
check(/createObjectStore\("gallery"\)/.test(idb) && /createObjectStore\("artifacttext"\)/.test(idb),
  "listings and opened documents survive a reload — a cold start with the tunnel down is exactly when they are wanted");

const sw = readFileSync("packages/web/public/sw.js", "utf8");
check(/const THUMBS = /.test(sw) && /n !== THUMBS/.test(sw),
  "the thumbnail cache is exempt from the per-build purge — an offline grid with no pictures is half a gallery");

// ── Thumbnails the PAGE keeps ───────────────────────────────────────
// The worker cache above does not exist in the Android shell (main.tsx
// registers no service worker there), which is the build where an offline
// gallery is the point. These are the rules that make the page's own copy
// sound, and each is silent when it breaks: the grid still works on the desk.
const thumbs = readFileSync("packages/web/src/thumbCache.ts", "utf8");
const main = readFileSync("packages/web/src/main.tsx", "utf8");
check(/serviceWorker" in navigator && !isNativeShell\(\)/.test(main),
  "the APK registers no service worker — so its thumbnails can only come from the page's own cache");
check(/createObjectStore\("thumbs"\)/.test(idb) && /createObjectStore\("thumbmeta"\)/.test(idb),
  "thumbnail bytes and the record eviction ranks them by are separate stores — ranking 400 entries must not read 400 blobs");
check(/blob\.size > MAX_ENTRY_BYTES/.test(thumbs),
  "a 'thumb' over the cap is the host serving the ORIGINAL (thumbs.ts returns null) — storing it is the very cost this cache avoids");
check(/blob\.size/.test(thumbs) && !/headers\.get\("content-length"\)/.test(thumbs),
  "the size is measured on the BLOB, never on a content-length header: a compressed or chunked reply arrives without one, and 'no header' must not mean 'store whatever came back'");
check(/MAX_THUMBS/.test(thumbs) && /MAX_TOTAL_BYTES/.test(thumbs),
  "both ceilings — an entry count says nothing about bytes");
const thumbSrc = readFileSync("packages/web/src/thumbSrc.ts", "utf8");
check(/getThumbBlob\(url\)/.test(thumbSrc) && !/getThumbBlob/.test(gallery),
  "cache-first resolution has ONE implementation — two would drift into two answers to 'may this picture come from the phone'");
check(/useThumbSrc\(/.test(gallery) && /loading="lazy"/.test(gallery),
  "the grid resolves the stored copy BEFORE pointing an <img> anywhere (offline paints with no doomed request), and still loads lazily");
check(/if \(live\) cacheThumb\(url\)/.test(gallery),
  "only a picture that came from the host is worth remembering — re-storing the cached one is a write per painted tile");

// ── The same picture, named by PATH ─────────────────────────────────
// A file mentioned in a transcript, or referenced by a backlog item, is a path
// and nothing more — and a thumb URL without `&v=<mtime>` is cacheable by
// nobody, which made exactly those pictures broken images offline while the
// gallery painted them fine. fileMtime.ts is the missing half.
const md = readFileSync("packages/web/src/Markdown.tsx", "utf8");
const mtimes = readFileSync("packages/web/src/fileMtime.ts", "utf8");
check(/useThumbSrc\(/.test(md) && /useFileMtime\(/.test(md),
  "the reader's inline thumbnails go through the same cache-first path as the grid, at a VERSIONED url");
check(/if \(live && mtime(?: && [^)]*)?\) cacheThumb\(url\)/.test(md),
  "an un-versioned thumbnail is never stored by the page — the key would not change when the file does");
check(/localStorage/.test(mtimes) && !/idbGet|idbSet/.test(mtimes),
  "mtimes are readable SYNCHRONOUSLY: an async lookup means loading the un-versioned url first and swapping it (two decodes and a flash)");
check(/asked\.has\(key\)/.test(mtimes),
  "a path is stat-ed at most once per page — a transcript mentioning one screenshot forty times must ask once");
check(/learnMtimes\(rows, repoId\)/.test(gallery),
  "every listing that lands teaches the map — the gallery is the cheapest source of an mtime there is");
check(/searchParams\.has\("v"\) \? thumbFirst\(event\.request\) : thumbNetworkFirst\(event\.request\)/.test(sw),
  "in the worker `v` decides HOW, not WHETHER: un-versioned thumbnails are network-first, so they are cached at all");
check(/return \(await cache\.match\(request\)\) \|\| Response\.error\(\)/.test(sw),
  "…and the stored copy answers only when the network could not answer at all — never over a live host");
check(/prefetchThumbs\(/.test(gallery) && /cachedAt != null \|\| loadErr/.test(gallery),
  "a LIVE listing warms a screenful, so a gallery you glanced at and closed still has pictures offline — and a failed one warms nothing");
check(/revokeObjectURL/.test(gallery),
  "object URLs are released on unmount — a long scroll must not leak every blob it painted");

console.log(failed ? "\nFAIL" : "\nOK");
process.exit(failed ? 1 : 0);
