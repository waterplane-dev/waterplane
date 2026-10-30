/**
 * **Landing back where you were when a new bundle replaces the running one.**
 *
 * The route is a URL (`routing.ts`), which is what makes an ordinary reload —
 * the watchdog's, a pull-to-refresh, a crash recovery — land on the same screen:
 * `location.reload()` keeps the hash. The Android shell's update is the one
 * restart that does not, and it is not ours to fix in JavaScript: Capacitor
 * swaps bundles with `Bridge.setServerBasePath`, whose last line is
 * `webView.loadUrl(appUrl)` — the bare start URL, no search, no hash. The same
 * is true of the cold launch after a build is merely *staged*: the activity
 * boots the WebView at `appUrl` and nothing carries the route across.
 *
 * So the route is remembered on this device and put back by hand, and the two
 * rules below are the whole design:
 *
 *  - **Only when a version change was expected.** The arm is set where an
 *    update is staged, applied or reverted (`webUpdate.ts`) and CONSUMED on the
 *    next boot, so an ordinary launch still opens the launcher — being dropped
 *    into yesterday's sheet every morning is not the feature — and a bundle that
 *    crashes on the restored screen cannot restore it a second time.
 *  - **Only onto a bare URL.** A document that booted with a route of its own —
 *    a tapped notification carrying an image or a file, a `?repo=` link — has
 *    already been told where to go, and that beats what this phone was looking
 *    at before.
 *
 * What is remembered is what `routeToUrl` produces, never `location.href`: the
 * hash a notification cold-tap arrives on carries `dlPath`/`imgPath`, and
 * replaying one of those on the next restart would re-open a viewer, or a
 * download, that nobody asked for twice.
 *
 * The decision is pure and tested here; the two lines that touch storage are at
 * the bottom.
 */
import { LS, lsDel, lsGet, lsSet, lsSetJson } from "./storage.ts";

/**
 * How stale a remembered route may be and still be worth restoring.
 *
 * Generous on purpose: a build stages while the phone is in a pocket on Friday
 * and the app is next opened on Monday, and "where I was" is still where you
 * were. It is a sanity bound against a clock that jumped, not a policy — the arm
 * is what decides whether to restore at all.
 */
export const RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A URL longer than this is not one we wrote. */
const MAX_URL = 2048;

/**
 * What the screen on top was opened on (`backStep.ts`'s `navParams`: the git view's repo and
 * failure), in the SAME shape its own `history.state` holds it — `{ navRoute, navParams }`.
 *
 * A screen's params have two carriers across a reload: its entry's `history.state` (an ordinary
 * reload keeps it) and this record (a bundle swap reloads a BARE URL, with no state at all). The
 * record used to hold the URL alone, so the git view came back on the session's repo, or the
 * no-repo sheet, instead of the repo it was open on (design round 4). Restoring puts this back
 * as the booted entry's `history.state`, and the seed takes it from there (`adoptCarried`) —
 * one seed path, not a second reader.
 */
export type CarriedState = { navRoute: string; navParams: { overlay: string; params: Record<string, string | null> } };

export type SavedRoute = { url: string; ts: number; carried?: CarriedState };

/** Larger than this, as JSON, is not params a screen was opened on: dropped, the URL kept. */
const MAX_CARRIED = 2048;

/** A well-formed, bounded `CarriedState`, or null. Older records have none and land as before. */
export function parseCarried(v: unknown): CarriedState | null {
  if (!v || typeof v !== "object") return null;
  const { navRoute, navParams } = v as { navRoute?: unknown; navParams?: unknown };
  if (typeof navRoute !== "string" || navRoute.length > MAX_URL) return null;
  if (!navParams || typeof navParams !== "object") return null;
  const { overlay, params } = navParams as { overlay?: unknown; params?: unknown };
  if (typeof overlay !== "string" || !params || typeof params !== "object" || Array.isArray(params)) return null;
  const out: Record<string, string | null> = {};
  for (const [k, x] of Object.entries(params as Record<string, unknown>)) {
    if (x !== null && typeof x !== "string") return null;
    out[k] = x;
  }
  const c = { navRoute, navParams: { overlay, params: out } };
  return JSON.stringify(c).length <= MAX_CARRIED ? c : null;
}

/** Tolerant like every other reader of a key an older build may have written:
 *  half-written, hand-edited or absent all read as "nothing remembered". */
export function parseSavedRoute(raw: string | null): SavedRoute | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const { url, ts, carried } = v as { url?: unknown; ts?: unknown; carried?: unknown };
    if (typeof url !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) return null;
    const c = parseCarried(carried);
    return c ? { url, ts, carried: c } : { url, ts };
  } catch { return null; }
}

/**
 * Is this a URL we may hand to `history.replaceState`, and is there anything in
 * it worth restoring?
 *
 * Same-document only: a stored value that starts a scheme, a protocol-relative
 * `//host/…` or a backslash the parser folds into one is a navigation away from
 * the app, and this runs before React mounts with no screen to report it on. And
 * a bare `/` is the launcher, which is where a fresh document already is — so it
 * is "nothing remembered", not a restore that does nothing.
 */
export function routeWorthResuming(url: string): boolean {
  if (!url || url.length > MAX_URL) return false;
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  // Backslashes, whitespace and control characters: none of them occur in a
  // URL `routeToUrl` built, and each is a way a parser is surprised into a
  // navigation (a WebView folds `/\evil` into `//evil`).
  if (/[\\\s\u0000-\u001f\u007f]/.test(url)) return false;
  return url.includes("#") || url.includes("?");
}

/** Where the document currently is, as the two halves that decide this. */
export type Here = { search: string; hash: string };

/** Has this document already been told where to go? */
export function bootedOnARoute(here: Here): boolean {
  return here.hash.replace(/^#/, "") !== "" || here.search.replace(/^\?/, "") !== "";
}

/**
 * The URL to restore, or null to leave the document where it booted.
 *
 * `armed` is the caller's answer to "was a version change expected?"; everything
 * else here is a reason NOT to act on it.
 */
export function resumeTarget(saved: SavedRoute | null, armed: boolean, here: Here, now: number): string | null {
  if (!armed || !saved) return null;
  if (bootedOnARoute(here)) return null;
  if (!routeWorthResuming(saved.url)) return null;
  const age = now - saved.ts;
  // A negative age is a clock that moved backwards, not a route from the future.
  if (age < 0 || age > RESUME_MAX_AGE_MS) return null;
  return saved.url;
}

// ── the impure half ──────────────────────────────────────────────────────
/** Called on every landing (`landRoute`). Cheap: one small JSON write per screen. `carried` is
 *  what the screen on top was opened on, when it was opened on anything. */
export function rememberRoute(url: string, now: number, carried: CarriedState | null = null): void {
  const c = parseCarried(carried);
  lsSetJson(LS.routeLast, (c ? { url, ts: now, carried: c } : { url, ts: now }) satisfies SavedRoute);
}

/** "The next start is a different bundle" — set wherever one is staged, applied
 *  or reverted. Not per build id: what it guards is the NEXT boot, whichever
 *  bundle that turns out to be, including the built-in one a revert lands on. */
export function armRouteResume(): void {
  lsSet(LS.routeResume, "1");
}

/**
 * Take the arm and answer with the URL to land on, and the `history.state` that entry carries
 * (null for a record that holds no params). Clears the arm whatever the answer is — one
 * restart, one restore.
 */
export function takeResumeRoute(here: Here, now: number): { url: string; state: CarriedState | null } | null {
  const armed = lsGet(LS.routeResume) === "1";
  if (armed) lsDel(LS.routeResume);
  const saved = parseSavedRoute(lsGet(LS.routeLast));
  const url = resumeTarget(saved, armed, here, now);
  return url ? { url, state: saved?.carried ?? null } : null;
}

/**
 * The resume landing, before React mounts (`main.tsx`): the URL AND the params the screen was
 * opened on, put back as the booted entry — so the routing effect's seed adopts them exactly as
 * it does after an ordinary reload (`adoptCarried`).
 */
export function resumeLanding(here: Here, now: number): void {
  const r = takeResumeRoute(here, now);
  if (r) history.replaceState(r.state, "", r.url);
}
