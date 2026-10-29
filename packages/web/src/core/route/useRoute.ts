/**
 * Where the app is: the session on screen, the sheet on top, the repo focus —
 * and the history STACK that makes Back (the Android gesture included) step
 * back through them.
 *
 * Lifted out of `App.tsx` unchanged. Every name App used is a member of the
 * return, so the ~190 `setOverlay(` call sites keep their spelling. The pure
 * decisions are where they were — `routing.ts` (`routeKey`, `routeToUrl`,
 * `routeFromPop`, `parseHash`, `parseFocus`) and `resumeRoute.ts`
 * (`rememberRoute`), both node-tested; this hook is only the effects and refs
 * that drive them.
 */
import { useEffect, useRef, useState } from "react";
import { parseFocus, parseHash, routeFromPop, routeKey, routeStep, routeToUrl, type Overlay } from "../../routing.ts";
import { forgetKept, keepCovered, popStepsTo, pushBackDepth, restoreKept, routeStack } from "../../backStep.ts";
import { defineShellGlobal } from "../../shellBridge.ts";
import { rememberRoute } from "../../resumeRoute.ts";
import { viewerHandles } from "../../docKind.ts";
import { useLatest } from "../../sdk/hooks.ts";

// `pushBackDepth` and the stack itself live in `backStep.ts`, shared with the
// in-screen steps (`useBackStep`) so the two agree on one depth.
export { pushBackDepth };

/**
 * The screens BELOW the one the document BOOTED on.
 *
 * A cold tap on a notification, a hash restored after the watchdog's reload, a
 * `?repo=` link: the document starts on a session — or on a sheet over one —
 * that the user never walked into, so nothing of ours is under it. That entry
 * used to be adopted at depth 0, and depth 0 is the app SAYING "the next Back
 * is not mine": the shell disables its callback ahead of the gesture and
 * Android's swipe takes the whole app away from a screen that plainly had one
 * behind it. (The button did the same thing; the gesture is only where it gets
 * noticed, because it cannot be half-pressed.)
 *
 * So the ancestors are synthesized — launcher, then focus, then session, then
 * the sheet — and pushed for REAL entries, oldest first. Back then lands
 * inside our own document, which is the point: the WebView's history also
 * holds the documents an over-the-air bundle swap loaded, so "just let the
 * platform go back" would reload a retired build.
 */
export function seedRouteStack(id: string | null, ov: Overlay, repo: string | null): void {
  const chain: Array<[string | null, Overlay, string | null]> = [[null, null, null]];
  if (repo) chain.push([null, null, repo]);
  if (id) chain.push([id, null, repo]);
  if (ov) chain.push([id, ov, repo]);
  chain.forEach(([a, o, r], i) => {
    const k = routeKey(a, o, r);
    const state = { navRoute: k, navDepth: i };
    const url = routeToUrl(a, o, r);
    // The entry we booted into is REPLACED by the root; the rest are pushed on
    // top of it, so the URL we end on is the one we started with.
    if (i === 0) history.replaceState(state, "", url);
    else history.pushState(state, "", url);
    routeStack.keys[i] = k;
  });
  routeStack.depth = chain.length - 1;
  routeStack.keys.length = chain.length;
  pushBackDepth();
}

export function useRoute() {
  const initRoute = useRef(parseHash()).current;
  // History bookkeeping for the routing effects below: whether the boot entry
  // has been adopted yet, and how deep in our own stack the current entry is.
  const routeInitRef = useRef(false);
  // The depth and the keys of the entries we pushed are `routeStack`
  // (`backStep.ts`) — so closing a sheet can UNWIND to the screen underneath
  // instead of stacking a copy of it on top.
  const [activeId, setActiveId] = useState<string | null>(initRoute.activeId);
  const [overlay, setOverlay] = useState<Overlay>(
    initRoute.image ? "swipe"
      : initRoute.file && viewerHandles(initRoute.file.relPath) ? "gallery"
      : initRoute.overlay,
  );
  /**
   * **A sheet may only close ITSELF.**
   *
   * A bare `setOverlay(null)` in a close handler is a close of whatever is on
   * top, which is the same thing right up until the sheet's own action opened
   * the next one. `SendSheet.go` calls `onSend` and then `onClose`, and the
   * repo arm of `dispatchIntent` can raise the per-launch model ask or the
   * hosted-model notice inside that `onSend` — so the close that followed
   * unmounted the question a frame after it appeared, left `launchAskFor` set
   * and invisible, and queued nothing at all. What the phone showed was the
   * main view with no new session and no toast, and the desktop never heard
   * about the prompt: the reported "ask the agent about this… starts nothing".
   *
   * Functional, so it reads the state the batch has ALREADY moved on to rather
   * than the render's stale copy.
   */
  const closeSheet = (self: Overlay) => setOverlay((o) => (o === self ? null : o));
  // Mirror of `overlay` for the ws message handler (empty-deps closure can't read state).
  const overlayRef = useLatest(overlay);
  // Repo-focused window: `?repo=<name>` scopes the whole launcher (sessions,
  // recent, closed, repos, backlog, external) to one repo incl. its worktrees.
  // Lives in the query string (not the hash — the hash is the route and gets
  // rewritten), so it survives reloads and in-app navigation: a window opened
  // via the focus button stays pinned to its repo for its lifetime.
  const [focusRepo, setFocusRepo] = useState<string | null>(() => parseFocus());

  // ── URL routing ──────────────────────────────────────────────────────
  // Mirror {activeId, overlay} into the location hash so a reload lands on the
  // same screen, and push one history ENTRY per screen so Back — the Android
  // gesture included — steps back through the app.
  //
  // The entry is keyed on `history.state`, not on the URL: a sheet the hash
  // deliberately cannot restore ("queue", "pad", …) serializes to the SAME hash
  // as the session under it, so a URL comparison opened no entry for it at all
  // and the first Back out of one went past the app entirely. Each entry also
  // carries its depth, which is the only way `shellBack` below can know whether
  // there is anything left to go back to (`history.length` counts forward
  // entries too, and a WebView's own history includes documents we never
  // navigated — an OTA bundle swap reloads it).
  // Remember the screen, for the ONE restart that cannot carry it: the Android
  // shell swapping bundles reloads the WebView at its bare start URL (no search,
  // no hash), and so does the cold launch after a build has merely been staged.
  // An ordinary reload needs none of this — it keeps the hash — which is why the
  // restore is armed by `webUpdate.ts` and not by every boot (`resumeRoute.ts`).
  // What is stored is what `routeToUrl` builds, never `location.href`: the hash a
  // notification cold-tap arrives on names a file, and replaying it on the next
  // restart would re-open a viewer nobody asked for twice.
  useEffect(() => {
    rememberRoute(routeToUrl(activeId, overlay, focusRepo), Date.now());
  }, [activeId, overlay, focusRepo]);
  useEffect(() => {
    const key = routeKey(activeId, overlay, focusRepo);
    const first = !routeInitRef.current;
    routeInitRef.current = true;
    const st = history.state as { navRoute?: string; navDepth?: number } | null;
    const known = st?.navRoute === key ? (st.navDepth || 0) : -1;
    // Booting on a screen with nothing of ours under it — a fresh document on a
    // deep route, or a reloaded entry an older build adopted at depth 0 — is the
    // one case where the stack has to be INVENTED rather than adopted.
    if (first && known <= 0) { seedRouteStack(activeId, overlay, focusRepo); return; }
    if (known >= 0) { routeStack.depth = known; routeStack.keys[known] = key; pushBackDepth(); return; }
    // Closing a sheet is a step BACK, not a new screen — ONE step, the same one
    // the gesture takes (`routeStep`): a sheet opened from another sheet closes
    // to that sheet, never past it to the session. A screen already further
    // down the stack is UNWOUND to rather than pushed again, which keeps the
    // stack a path of DISTINCT screens: pushing a duplicate once left a sheet's
    // own key stranded a level down, so the next tap that opened it unwound
    // into it and popstate re-derived a null overlay — the sheet mounted and
    // vanished on the following frame ("clicking download just flashes the
    // screen open and hides it again").
    const step = routeStep(routeStack.keys, routeStack.depth, key);
    if (step.kind === "stay") return;
    if (step.kind === "go") {
      // Moved NOW, not when popstate arrives: a step retiring in this same
      // commit (`backStep.ts`) reads the depth in a microtask and must see
      // that this unwind already took its entry with it.
      routeStack.depth += step.delta;
      // Landing on the very screen the tap named is a fresh open — its own
      // focus is already set. Landing on one BELOW it (a close, a leave) is a
      // Back, and the pop restores what that sheet showed (`restoreKept`).
      if (routeStack.keys[routeStack.depth] === key) forgetKept(routeStack.depth);
      history.go(step.delta);
      return;
    }
    // The sheet underneath is being covered, not closed: keep its cut for the
    // Back that returns to it, before its `onLeave` (App's effect) drops it.
    keepCovered(routeStack.depth);
    const url = routeToUrl(activeId, overlay, focusRepo);
    const depth = routeStack.depth + 1;
    const state = { navRoute: key, navDepth: depth };
    history.pushState(state, "", url);
    routeStack.depth = depth;
    routeStack.keys[depth] = key;
    routeStack.keys.length = depth + 1;
    pushBackDepth();
  }, [activeId, overlay, focusRepo]);
  // Back/forward (or any external hash edit) → re-derive state from the URL —
  // EXCEPT the overlay, which the URL is allowed to be missing.
  //
  // A transient overlay ("send", "pad", "image", "collage") serializes to the
  // same hash as the screen under it, so `parseHash` reads null for it. That is
  // right for a reload and wrong for a POP: unwinding back into the Send sheet
  // (which is exactly what the annotator's return does — `setOverlay("send")`
  // finds that screen already in the stack and `history.go`s to it) fired
  // popstate, which then re-derived "no overlay" and dropped the user on the
  // launcher with the typed prompt stranded in its draft and no way back to it.
  // The routeKey this document pushed for that depth still names the overlay,
  // so read it from there and keep the hash for the rest.
  //
  // `routeStack` is per-document and rebuilt by `seedRouteStack` after a
  // reload, so a key that only survived in `history.state` is never adopted —
  // restoring a transient overlay with nothing in memory behind it is the case
  // `PERSISTED_OVERLAYS` exists to refuse.
  useEffect(() => {
    const onPop = () => {
      const st = history.state as { navRoute?: string; navDepth?: number } | null;
      const r = routeFromPop(st, { ...parseHash(), focusRepo: parseFocus() }, routeStack.keys, routeStack.depth);
      // Steps above where we landed were closed by this very Back. Landing on
      // a DEAD one — its view went away with no Back of ours — is not a screen:
      // keep going, or the press looks like it did nothing.
      if (!r.adopt && popStepsTo(r.depth) && r.depth > 0) { routeStack.depth = r.depth; history.back(); return; }
      routeStack.depth = r.depth;
      if (r.key) routeStack.keys[r.depth] = r.key;
      // A hand-edited hash made an entry with no key of ours: stamp it, so the
      // routing effect finds it KNOWN rather than pushing a twin on top — the
      // twin is what made the sheet's back button unwind onto an entry whose
      // hash re-opened the sheet. A new entry discards anything forward of it.
      if (r.adopt && r.key) {
        history.replaceState({ navRoute: r.key, navDepth: r.depth }, "");
        routeStack.keys.length = r.depth + 1;
      }
      pushBackDepth();
      // Before the sheet renders, so it opens on its cut rather than flashing the whole list.
      if (!r.adopt) restoreKept(r.depth, r.key);
      setActiveId(r.activeId); setOverlay(r.overlay); setFocusRepo(parseFocus());
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => { window.removeEventListener("popstate", onPop); window.removeEventListener("hashchange", onPop); };
  }, []);
  // The native shell's Back handler asks US whether there is a screen to go back
  // to, rather than reading the WebView's history: that history also holds the
  // documents an over-the-air bundle swap loaded, and going "back" into one of
  // those reloads a retired build instead of leaving the app. Answering false is
  // what lets the app close — see MainActivity.registerBackNavigation().
  useEffect(() => {
    // `shellBack` (and each older shell's spelling — `shellBridge.ts`).
    return defineShellGlobal("Back", () => {
      if (routeStack.depth <= 0) return false;
      history.back();
      return true;
    }, "");
  }, []);

  return {
    initRoute,
    activeId, setActiveId,
    overlay, setOverlay, closeSheet, overlayRef,
    focusRepo, setFocusRepo,
  };
}

export type Route = ReturnType<typeof useRoute>;
