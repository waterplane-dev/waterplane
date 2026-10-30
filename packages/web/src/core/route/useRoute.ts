/**
 * Where the app is: the session on screen, the sheet on top, the repo focus —
 * and the history STACK that makes Back (the Android gesture included) step
 * back through them.
 *
 * Lifted out of `App.tsx` unchanged. Every name App used is a member of the
 * return, so the ~190 `setOverlay(` call sites keep their spelling. The pure
 * decisions are where they were — `routing.ts` (`routeKey`, `routeToUrl`,
 * `routeFromPop`, `parseHash`, `parseFocus`) and `resumeRoute.ts`
 * (`rememberRoute`, called from `landRoute`), both node-tested; this hook is only the effects and refs
 * that drive them.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { parseFocus, parseHash, type Overlay } from "../../routing.ts";
import { pushBackDepth, routeStack, screenAsks, subscribeScreenParams } from "../../backStep.ts";
import { landPop, landRoute } from "./landRoute.ts";
import { defineShellGlobal } from "../../shellBridge.ts";
import { viewerHandles } from "../../docKind.ts";
import { useLatest } from "../../sdk/hooks.ts";

// `pushBackDepth` and the stack itself live in `backStep.ts`, shared with the
// in-screen steps (`useBackStep`) so the two agree on one depth.
export { pushBackDepth };

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
  // What a screen was opened ON (the git view's repo and failure) is filed with the entry the
  // effect below lands on, and read back by the pop (`routeLanded`, `backStep.ts`). A re-target
  // of the screen already on top changes no route, so the effect re-runs on the ask itself.
  const asks = useSyncExternalStore(subscribeScreenParams, screenAsks);

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
  // Remember the screen — and what it was opened on — for the ONE restart that cannot carry it
  // (a bundle swap reloads the bare start URL): `landRoute` does it after each landing, and the
  // restore is armed by `webUpdate.ts`, not by every boot (`resumeRoute.ts`).
  useEffect(() => {
    const first = !routeInitRef.current;
    routeInitRef.current = true;
    // Seed, known, stay, go or push — and what each files with the entry landed on (`landRoute.ts`).
    landRoute(activeId, overlay, focusRepo, first);
  }, [activeId, overlay, focusRepo, asks]);
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
      // The pop's bookkeeping and what it reads back (`landPop`); null = it kept going back.
      const r = landPop();
      if (!r) return;
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
