/**
 * Where the app IS, as a URL.
 *
 * The whole route is one hash: which session is open (`a`) and which overlay is
 * on top of it (`o`), plus the single file a notification cold-tap can name.
 * Living in the hash rather than in state is what makes a reload — the thing a
 * flaky tunnel provokes constantly — land back where the user was.
 *
 * Only SOME overlays are persisted, and that split is the load-bearing part:
 * the transient ones ("image", "collage", "slash", "text") are driven by in-memory state
 * that a reload cannot reconstruct, so restoring them from a URL would paint an
 * overlay with nothing in it. `parseHash` therefore filters on the way IN as
 * well as `routeToHash` filtering on the way out — a hand-edited or stale URL is
 * as much a source of an unrestorable overlay as our own writer is.
 */

/** A sheet an in-repo extension owns: `feature:<manifest id>/<sheet>`. No `|` or `#`, so `routeKey`,
 *  `overlayFromKey` and the step keys carry it unchanged. NEVER persisted (see `PERSISTED_OVERLAYS`). */
export type FeatureSheetId = `feature:${string}/${string}`;
export const FEATURE_SHEET_RE = /^feature:([a-z][a-z0-9-]{1,39})\/([a-z][a-z0-9-]{0,39})$/;
export function featureSheetId(feature: string, sheet: string): FeatureSheetId {
  const id = `feature:${feature}/${sheet}`;
  if (!FEATURE_SHEET_RE.test(id)) throw new Error(`"${id}" is not a feature sheet id — feature:<id>/<sheet>, lower-case letters, digits and -`);
  return id as FeatureSheetId;
}
export const isFeatureSheetId = (o: unknown): o is FeatureSheetId => typeof o === "string" && FEATURE_SHEET_RE.test(o);

export type Overlay = null | "slash" | "image" | "swipe" | "gallery" | "new" | "send" | "backlog" | "git" | "model" | "text" | "toolbar" | "history" | "secret" | "setup" | "speedtest" | "branches" | "decisions" | "updates" | "settings" | "notifications" | "snippets" | "build" | "capture" | "search" | "features" | "nethealth" | "fanout" | "queue" | "pad" | "pull" | "hdrcmd" | "sentlog" | "questions" | "outline" | "limits" | "schedule" | "clip" | "scrollback" | "browse" | "collage" | "archive" | "activity" | "clihealth" | "assess" | "context" | "tokens" | "launchask" | "hostedack" | "localrt" | "sweep" | "repocolor" | "apps" | "repohealth" | "storage" | "hosts" | "pairqr" | "devices" | "shells" | "logins" | "answers" | "sessionBudget" | "phonesetup" | "codefolder" | "onboard" | "demotour" | "share" | FeatureSheetId;

// Overlays worth putting in the URL (reload-stable; the transient ones —
// "image"/"collage"/"slash"/"text" — need in-memory state, so they're never
// restored; "collage" holds picked File objects a reload cannot get back).
// "clihealth" is in here because it paints from a HOST READ seeded off a
// snapshot, so a reload lands on a board with rows in it rather than an empty
// sheet — the same property that qualifies the archive and the gallery.
// "capture" is deliberately NOT in here, for "build"'s reason: it is scoped to a
// repo held in memory (`captureRepo`), and the hash carries the overlay name and
// not the repo.
// "assess" is deliberately NOT in here, for "build"'s reason: it is scoped to a
// repo held in memory (`assessRepo`), and the hash carries the overlay name and
// not the repo — so a restored route would paint a sheet with no repo, which is
// the empty-sheet-on-reload case this list exists to avoid.
// "context" IS in here, and the distinction is exactly the one "assess" fails:
// it is scoped to the ACTIVE SESSION, which the hash already carries, and it
// reads through a cache seeded first — so a restored route paints the curve
// this phone last saw rather than an empty sheet.
// "launchask" is deliberately NOT in here, and for the strongest version of the
// reason: it is the pending OPEN held in memory (`App.launchAsk` — which cwd,
// which title), and a restored route would paint a Start button with nothing to
// start. It is also a question standing between a tap and a `session.create`, so
// a reload is an answer of "not now" and must not re-pose it.
// "hostedack" is deliberately NOT in here, for "launchask"'s reason and one
// more of its own. It is the same pending launch held in memory
// (`App.hostedAskFor` — which title, which opts), so a restored route paints an
// "I understand — start …" button with nothing to start. And it is a CONSENT
// SHEET standing between a tap and a `session.create`: nothing is queued while
// it is up, so a reload is an answer of "not now" and must not be re-posed as
// though the tap were still live.
// "localrt" is deliberately NOT in here, for "nethealth"'s reason: it is a live
// readout of the desktop's runner, and a restored route would paint it with no
// samples at all.
// "pull" is in here because the Downloads queue is THIS DEVICE's own state
// (localStorage + IndexedDB), so a restored route paints the real rows with no
// host at all — and because the service worker's Background Fetch notification
// has to be able to open it from a COLD start, which is exactly when the app
// was closed and the transfer finished.
// "apps" is in here for "repocolor"'s reason: it is a settings sheet over this
// device's own stored answers (the allow-list) and this phone's own download
// records, so a restored route paints the real rows with no host at all.
// "repocolor" is in here for "toolbar"'s reason: it is a SETTINGS sheet over
// this device's own stored answers, so a restored route paints the real rows
// with no host at all — the repo list only decides which names are listed, and
// the ring and every pinned colour are readable offline.
// "storage" is in here for "apps"' reason, doubled: it measures THIS DEVICE's
// own IndexedDB and download records and asks the host nothing, so a restored
// route paints the real figures offline — and the moment it is opened in is a
// phone that is out of space, which is also when a reload is most likely to be
// the browser's own doing rather than a tap.
// "repohealth" is deliberately NOT in here, for "assess"'s reason: it is
// scoped to a repo held in memory (`healthRepo`) and the hash carries the
// overlay name and not the repo, so a restored route would paint a sheet with
// no repo at all.
// "sessionBudget" is deliberately NOT in here, for "context"'s opposite reason: it is scoped to a
// session held in memory (`budgetSid` — a launcher row's chip or the context panel's door), and the
// hash carries the overlay name and not which session, so a restored route would paint the attached
// session's budget under a chip that was tapped on another.
// `feature:<id>/<sheet>` is never in here either, for "assess"'s reason: an extension's sheet is
// scoped to state held in memory, and the hash carries the overlay name and not that state.
export const PERSISTED_OVERLAYS = new Set<Overlay>(["gallery", "new", "backlog", "git", "model", "toolbar", "browse", "archive", "activity", "clihealth", "context", "pull", "tokens", "repocolor", "apps", "storage"]);

/**
 * On a wide window (`core/layout`), which sheets take the MAIN pane instead of
 * the side panel (docs/analysis/desktop-workspace-plan.md §3). Every other
 * overlay — feature sheets included — opens as a panel over the right edge,
 * leaving the session and its terminal width untouched. These need the width:
 * a canvas (`image`, `clip`, `collage`, `swipe`), a chart (`tokens`,
 * `context`, `repohealth`), an 80-col archive (`scrollback`), a split of its
 * own (`git`), a reading surface (`text`, `outline`). Phone ignores it.
 */
export const WIDE_FULL = new Set<Overlay>(["swipe", "image", "clip", "collage", "tokens", "context", "repohealth", "scrollback", "git", "text", "outline"]);

/** Does this overlay take the main pane on a wide window? Null is no sheet. */
export const isWideFull = (o: Overlay): boolean => o !== null && WIDE_FULL.has(o);

/** Parse the current location hash into a navigable route. */
export function parseHash(): {
  activeId: string | null;
  overlay: Overlay;
  image?: { repoId: string; relPath: string };
  file?: { repoId: string; relPath: string; name?: string; mtime?: number };
  /** A cold plugin-alert tap (`sw.js`): open this plugin's screen. */
  plugin?: string;
} {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  const o = p.get("o") as Overlay;
  // A notification cold-tap encodes the produced image; open it in the VIEWER
  // (see `viewImage`) — marking is a button away inside it.
  const imgRepo = p.get("imgRepo"), imgPath = p.get("imgPath");
  const image = imgRepo && imgPath ? { repoId: imgRepo, relPath: imgPath } : undefined;
  // ...and an artifact notification encodes the FILE. It used to navigate the
  // tab straight at `…&download=1`, which is the browser's own download and
  // nothing at all in the APK; the app fetches it through the one download path
  // instead (`download.ts`), so the cold start has to carry it in.
  const dlRepo = p.get("dlRepo"), dlPath = p.get("dlPath");
  const mtime = Number(p.get("dlMtime") || 0);
  const file = dlRepo && dlPath
    ? { repoId: dlRepo, relPath: dlPath, name: p.get("dlName") || undefined, mtime: mtime || undefined }
    : undefined;
  return { activeId: p.get("a") || null, overlay: o && PERSISTED_OVERLAYS.has(o) ? o : null, image, file, plugin: p.get("plugin") || undefined };
}

/** Serialize route → hash string ("" when at the session list root). */
export function routeToHash(activeId: string | null, overlay: Overlay): string {
  const persist = overlay && PERSISTED_OVERLAYS.has(overlay) ? overlay : null;
  const p = new URLSearchParams();
  if (activeId) p.set("a", activeId);
  if (persist) p.set("o", persist);
  const s = p.toString();
  return s ? `#${s}` : "";
}

/**
 * The identity of a SCREEN, for history purposes — which is not the URL.
 *
 * The hash carries only what a reload can restore, so a sheet like the queue or
 * the pad serializes to the same hash as the session underneath it. Back must
 * still close it, so what a history entry is compared against is this key, kept
 * in `history.state`; comparing URLs meant a transient overlay pushed no entry
 * at all and the first Back out of one left the app.
 */
export function routeKey(activeId: string | null, overlay: Overlay, focusRepo: string | null = null): string {
  return `${activeId || ""}|${overlay || ""}|${focusRepo || ""}`;
}

/**
 * Which repo the view is FOCUSED on, off the query string (`?repo=<name>`).
 *
 * Focus is a search param and not part of the hash because it predates the hash
 * router: a focused view on the desktop is its own window, opened with this URL.
 * In the native shell there is no second window to open (Capacitor's WebView has
 * multiple windows off, so `window.open("_blank")` no-ops), so focus is a SCREEN
 * there — which means Back has to unwind it, which means it belongs in the route
 * key and in the URL the routing effect writes. Hence a reader for it here
 * rather than a second `URLSearchParams` at every call site.
 */
export function parseFocus(): string | null {
  return new URLSearchParams(location.search).get("repo") || null;
}

/**
 * The full URL for a route: path + focus + hash.
 *
 * Written whole rather than as a bare `#…` because focus lives in the search
 * half — a relative hash would preserve whatever `?repo=` was already there,
 * which is exactly wrong when the change being routed IS the focus.
 */
export function routeToUrl(activeId: string | null, overlay: Overlay, focusRepo: string | null): string {
  const q: string[] = [];
  // `?demo=<scenario>` (demo/mode.ts `DEMO_PARAM`) is not a route but it is
  // what keeps a page in a URL-entered demo, which writes nothing else: drop it
  // here and the first reload — the watchdog's included — leaves the demo.
  let demo: string | null = null;
  try { demo = new URLSearchParams(location.search).get("demo"); } catch { /* no location */ }
  if (demo) q.push(`demo=${encodeURIComponent(demo)}`);
  if (focusRepo) q.push(`repo=${encodeURIComponent(focusRepo)}`);
  return location.pathname + (q.length ? `?${q.join("&")}` : "") + routeToHash(activeId, overlay);
}

/**
 * The overlay a `routeKey` names — the half of a route the hash cannot carry.
 *
 * `routeToHash` drops every overlay outside `PERSISTED_OVERLAYS`, on purpose: a
 * transient one restored from a URL paints an empty sheet. But the history
 * ENTRY for such a screen still exists, keyed on `history.state`, and unwinding
 * into it (`history.go`) fires popstate — where re-deriving the overlay from the
 * hash alone reads "no overlay" for a screen that plainly had one. That is how
 * the annotator's return from the Send sheet landed on the launcher with the
 * typed prompt stranded in its draft. The key remembers what the hash forgot,
 * so a pop within this document reads it from there.
 *
 * Only ever applied to a key THIS document pushed — a key that survived a
 * reload in `history.state` has no in-memory state behind it, which is the case
 * `PERSISTED_OVERLAYS` exists to refuse.
 */
export function overlayFromKey(key: string): Overlay {
  return (key.split("|")[1] || null) as Overlay;
}

/**
 * The key of a STEP inside a screen — a file opened in the file browser, a
 * detail pane opened from a list — pushed by `useBackStep` one entry above the
 * screen that owns it. It extends the screen's own key, so `overlayFromKey`
 * still reads the right sheet off it, and it never equals a `routeKey`, so the
 * routing effect's search can never unwind INTO one.
 */
export function stepKey(screen: string, n: number): string {
  return `${screen}#step${n}`;
}

/** The screen a key belongs to: the key itself, or the one a step was pushed over. */
export function screenOfKey(key: string): string {
  const i = key.indexOf("#step");
  return i < 0 ? key : key.slice(0, i);
}

/**
 * A stack slot a step left when its view went away without a Back of ours —
 * unmounted with the sheet that held it, say. The history entry is still
 * there; nothing is behind it, so a pop landing on one keeps going.
 */
export const VACANT = "\u0000vacant";

/**
 * What the routing effect does when the screen changes by a TAP rather than a
 * pop — the whole decision, pure, over the keys this document pushed.
 *
 * **Closing a sheet is exactly one Back.** The in-app back arrow and the
 * Android gesture must land in the same place, and the gesture pops ONE entry.
 * A close used to search the stack for the bare screen and unwind to it, so a
 * sheet opened from another sheet (Settings → Auto-download, the backlog → a
 * send) closed straight past the sheet it came from to the session or the
 * launcher. So a close — same session and focus, no sheet — returns to the
 * entry below when that entry is on the same session and focus, sheet and all.
 *
 * Otherwise the old rules: a screen already in the stack is UNWOUND to (the
 * stack stays a path of distinct screens), anything else is pushed. Steps and
 * `VACANT` slots over the current screen are not screens: the decision is taken
 * from the screen under them, and a close or an unwind takes them with it.
 *
 * @returns `stay` (already there), `go` (history.go by that delta) or `push`.
 */
export function routeStep(
  stack: readonly (string | undefined)[],
  depth: number,
  key: string,
): { kind: "stay" } | { kind: "go"; delta: number } | { kind: "push" } {
  const live = (k: string | undefined) => k !== undefined && k !== VACANT;
  const isStep = (k: string | undefined) => k === VACANT || (k !== undefined && k !== screenOfKey(k));
  // The SCREEN we are on: under any step (live or vacant) pushed over it.
  let top = depth;
  while (top > 0 && isStep(stack[top])) top--;
  if (stack[top] === key) return top === depth ? { kind: "stay" } : { kind: "go", delta: top - depth };
  const cur = stack[top];
  const [a, o, r] = key.split("|");
  const onSame = (k: string | undefined) => {
    if (!live(k)) return false;
    const [ka, , kr] = screenOfKey(k!).split("|");
    return ka === a && kr === r;
  };
  if (!o && live(cur) && overlayFromKey(cur!) && onSame(cur)) {
    let below = top - 1;
    while (below > 0 && stack[below] === VACANT) below--;
    if (below >= 0 && onSame(stack[below])) return { kind: "go", delta: below - depth };
  }
  for (let i = top - 1; i >= 0; i--) {
    if (stack[i] === key) return { kind: "go", delta: i - depth };
  }
  return { kind: "push" };
}

/**
 * What a POP means — the whole decision, with no `history` and no `location` in
 * it.
 *
 * Back, forward, a predictive-back swipe and every `history.go` the routing
 * effect fires all land here, and the decision is not "read the URL": the hash
 * carries only what a reload can restore, so it says *no overlay* for every
 * transient one. The entry still knows — `routeKey` is in `history.state` — and
 * the stack this document pushed knows. Getting that precedence wrong is how
 * the annotator's return from the Send sheet dropped the user on the launcher
 * with a typed prompt stranded in a draft nothing opens.
 *
 * Pure because it is the third time this decision has been wrong in a way no
 * test could see: it lived inline in an effect, next to four `set…` calls, and
 * the only way to exercise it was a phone and a gesture.
 *
 * **An entry with NO key at all is a hand-edited or linked hash** — typing
 * `#o=clihealth` into the address bar while the app runs. The browser made
 * that entry, not us, so it carries no `history.state`; it used to be read as
 * depth 0 with no key, the routing effect then PUSHED a stamped copy of the
 * same screen on top of it, and the sheet's back button unwound to that
 * stateless entry — where the hash still names the sheet, so it re-opened
 * (and browser Back did the same). Such an entry is a navigation FORWARD from
 * where we were, so it is ADOPTED one above the current depth under the key
 * its own URL names, and the caller stamps it with `replaceState` — after
 * which it is an ordinary entry of ours, and the effect finds it already
 * known instead of pushing a twin.
 *
 * @param state  `history.state` for the entry landed on.
 * @param hash   what `parseHash()` + `parseFocus()` read off the URL.
 * @param stack  the keys THIS document pushed, by depth (`routeStackRef`).
 * @param from   the depth we were at before this pop (`routeDepthRef`).
 */
export function routeFromPop(
  state: { navRoute?: string; navDepth?: number } | null | undefined,
  hash: { activeId: string | null; overlay: Overlay; focusRepo?: string | null },
  stack: readonly (string | undefined)[],
  from = 0,
): { depth: number; key: string | null; activeId: string | null; overlay: Overlay; adopt: boolean } {
  if (!state?.navRoute) {
    return {
      depth: from + 1,
      key: routeKey(hash.activeId, hash.overlay, hash.focusRepo ?? null),
      activeId: hash.activeId,
      overlay: hash.overlay,
      adopt: true,
    };
  }
  const depth = state.navDepth || 0;
  // Trust the key only where BOTH halves agree: the entry carries one (every
  // entry we push does) and this document pushed the same one at that depth.
  // A key that merely SURVIVED a reload in `history.state` has no in-memory
  // state behind it — exactly what `PERSISTED_OVERLAYS` refuses to restore —
  // so there the URL is the only honest answer.
  const ours = state.navRoute === stack[depth] ? state.navRoute : null;
  return {
    depth,
    key: state.navRoute,
    // The hash is lossless for these two — it is only the overlay it drops.
    activeId: hash.activeId,
    overlay: ours ? overlayFromKey(ours) : hash.overlay,
    adopt: false,
  };
}
