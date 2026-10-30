/**
 * What the routing effect DOES when the route becomes `{activeId, overlay, focusRepo}` — lifted out
 * of `useRoute`'s effect unchanged, so the whole landing (seed, known, stay, go, push and what each
 * files with the entry) runs under node against a fake `history` (review R2-2b M1: the seed path,
 * where a reload with a step on top lost the git view's repo, had no test). `landPop` is the
 * popstate handler's body the same way: the restore of a covered sheet's cut runs through it in
 * tests, not by hand (review R2-2b L2).
 */
import { parseFocus, parseHash, routeFromPop, routeKey, routeToUrl, type Overlay } from "../../routing.ts";
import { adoptCarried, announceLeaves, forgetKept, keepCovered, popStepsTo, pushBackDepth, restoreKept, routeLanded, routeLanding, routeStack, screenParams, stackView } from "../../backStep.ts";
import { rememberRoute } from "../../resumeRoute.ts";

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

/** The routing effect's body. `first` is true once per document. */
export function landRoute(activeId: string | null, overlay: Overlay, focusRepo: string | null, first: boolean): void {
  const before = stackView();
  const key = routeKey(activeId, overlay, focusRepo);
  const st = history.state as { navRoute?: string; navDepth?: number } | null;
  const known = st?.navRoute === key ? (st.navDepth || 0) : -1;
  // What happens, and what is filed with the entry landed on, is ONE pure decision
  // (`routeLanding`, node-tested); this applies its moves.
  const plan = routeLanding(routeStack.keys, routeStack.depth, key, first, known);
  // Booting on a screen with nothing of ours under it — a fresh document on a
  // deep route, or a reloaded entry an older build adopted at depth 0 — is the
  // one case where the stack has to be INVENTED rather than adopted. The entry
  // booted on may be a STEP over that screen (an open file, the explain pane): it
  // carries the screen's params, which the seeded screen entry takes (`adoptCarried`).
  if (plan.kind === "seed") { adoptCarried(key); seedRouteStack(activeId, overlay, focusRepo); }
  else if (plan.kind === "known") { routeStack.depth = plan.depth; routeStack.keys[plan.depth] = key; pushBackDepth(); }
  // Closing a sheet is a step BACK, not a new screen — ONE step, the same one
  // the gesture takes (`routeStep`): a sheet opened from another sheet closes
  // to that sheet, never past it to the session. A screen already further
  // down the stack is UNWOUND to rather than pushed again, which keeps the
  // stack a path of DISTINCT screens: pushing a duplicate once left a sheet's
  // own key stranded a level down, so the next tap that opened it unwound
  // into it and popstate re-derived a null overlay — the sheet mounted and
  // vanished on the following frame ("clicking download just flashes the
  // screen open and hides it again").
  else if (plan.kind === "go") {
    // Moved NOW, not when popstate arrives: a step retiring in this same
    // commit (`backStep.ts`) reads the depth in a microtask and must see
    // that this unwind already took its entry with it.
    routeStack.depth += plan.delta;
    // Landing on the very screen the tap named is a fresh open — its own
    // focus is already set. Landing on one BELOW it (a close, a leave) is a
    // Back, and the pop restores what that sheet showed (`restoreKept`).
    if (plan.forget) forgetKept(routeStack.depth);
  } else if (plan.kind === "push") {
    // The sheet underneath is being covered, not closed: keep its cut for the
    // Back that returns to it, before its `onLeave` (`announceLeaves`, below) drops it.
    keepCovered(routeStack.depth);
    const url = routeToUrl(activeId, overlay, focusRepo);
    const depth = routeStack.depth + 1;
    const state = { navRoute: key, navDepth: depth };
    history.pushState(state, "", url);
    routeStack.depth = depth;
    routeStack.keys[depth] = key;
    routeStack.keys.length = depth + 1;
    pushBackDepth();
  }
  routeLanded(routeStack.depth, routeStack.keys[routeStack.depth] ?? "", plan.how);
  if (plan.kind === "go") history.go(plan.delta);
  // Every sheet this landing removed or covered gets its `onLeave` — here, after the move (the
  // popstate a `go` becomes lands later and finds the stack already moved), never from an effect
  // that would have to run after this one.
  announceLeaves(before);
  // Remember the screen — and what it was opened on — for the ONE restart that carries neither:
  // a bundle swap reloads the bare start URL with no `history.state` (`resumeRoute.ts`). The
  // params go in the same `{ navRoute, navParams }` shape the entry holds, and the resume puts
  // them back as the booted entry's state, where the seed above adopts them (design round 4).
  // After `routeLanded`, so a re-target (`screenAsks`) is remembered with what it filed.
  const p = overlay ? screenParams(overlay) : null;
  rememberRoute(routeToUrl(activeId, overlay, focusRepo), Date.now(),
    p && overlay ? { navRoute: key, navParams: { overlay, params: { ...p } } } : null);
}

/**
 * A popstate (Back, or the pop a close's `history.go` becomes): the stack bookkeeping, the covered
 * sheet's cut put back, what the entry was opened on read back — and the route to set. Null when
 * it landed on a DEAD step and went back again instead.
 */
export function landPop(): { activeId: string | null; overlay: Overlay } | null {
  const before = stackView();
  const st = history.state as { navRoute?: string; navDepth?: number } | null;
  const r = routeFromPop(st, { ...parseHash(), focusRepo: parseFocus() }, routeStack.keys, routeStack.depth);
  // Steps above where we landed were closed by this very Back. Landing on
  // a DEAD one — its view went away with no Back of ours — is not a screen:
  // keep going, or the press looks like it did nothing.
  if (!r.adopt && popStepsTo(r.depth) && r.depth > 0) { routeStack.depth = r.depth; announceLeaves(before); history.back(); return null; }
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
  routeLanded(r.depth, routeStack.keys[r.depth] ?? "", r.adopt ? "push" : "return");
  announceLeaves(before);
  return { activeId: r.activeId, overlay: r.overlay };
}
