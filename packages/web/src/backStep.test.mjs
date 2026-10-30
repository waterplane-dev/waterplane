// Back returns to a sheet as it was left: what a covered sheet showed is kept
// for the pop that lands on it again, and forgotten by a tap that re-opens it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetKept, keepCovered, restoreKept, routeStack, setSheetKeeper } from "./backStep.ts";
import { routeKey } from "./routing.ts";

function setup() {
  let cut = "the 10 waiting";
  setSheetKeeper((key) => key === routeKey(null, "backlog") ? ((v) => () => { cut = v; })(cut) : null);
  routeStack.keys = [routeKey(null, null), routeKey(null, "backlog")];
  routeStack.depth = 1;
  return { get: () => cut, clear: () => { cut = null; } };
}

test("a sheet covered by a pushed screen gets its cut back on the pop that returns to it", () => {
  const s = setup();
  keepCovered(1); // the session is pushed over the backlog…
  s.clear();      // …and the backlog's onLeave drops the cut
  restoreKept(1, routeKey(null, "backlog"));
  assert.equal(s.get(), "the 10 waiting");
});

test("a tap that re-opens the same entry keeps what the tap set", () => {
  const s = setup();
  keepCovered(1);
  s.clear();
  forgetKept(1);
  restoreKept(1, routeKey(null, "backlog"));
  assert.equal(s.get(), null);
});

test("a pop onto a different entry at that depth restores nothing", () => {
  const s = setup();
  keepCovered(1);
  s.clear();
  restoreKept(1, routeKey("s1", null));
  assert.equal(s.get(), null);
  // …and the kept closure is spent either way
  restoreKept(1, routeKey(null, "backlog"));
  assert.equal(s.get(), null);
});

test("a screen without a keeper keeps nothing", () => {
  setup();
  routeStack.keys = [routeKey(null, null)];
  routeStack.depth = 0;
  keepCovered(0);
  restoreKept(0, routeKey(null, null)); // no throw, nothing to put back
});

// ── What a screen was opened ON lives in its route entry (bughunt 2026-10-29, review A3d) ──
// The git view's repo and tapped failure sat in App state beside the route, so a Back that
// closed the view kept them and the toolbar's "diff" re-opened the PREVIOUS repo.

const S = (a, o) => routeKey(a, o);
async function on(keys) {
  const m = await import("./backStep.ts");
  routeStack.keys = keys.slice();
  routeStack.depth = keys.length - 1;
  return m;
}

test("a screen opened ON something holds it in its entry; Back off it drops it", async () => {
  const m = await on([S(null, null), S("s1", null)]);
  m.openOn("git", { repoId: "r1", failureId: "A" });
  routeStack.keys[2] = S("s1", "git"); routeStack.depth = 2;
  m.routeLanded(2, S("s1", "git"), "push");
  assert.deepEqual(m.screenParams("git"), { repoId: "r1", failureId: "A" });
  // Back (popstate): the session entry holds nothing
  routeStack.depth = 1;
  m.routeLanded(1, S("s1", null), "return");
  assert.equal(m.screenParams("git"), null);
  // a plain open (the toolbar's diff) pushes an entry that holds nothing either
  routeStack.keys[2] = S("s1", "git"); routeStack.depth = 2;
  m.routeLanded(2, S("s1", "git"), "push");
  assert.equal(m.screenParams("git"), null, "never the previous repo");
});

test("a sheet pushed over it and popped gives it back what it was opened on", async () => {
  const m = await on([S(null, null), S("s1", null), S("s1", "git")]);
  m.openOn("git", { repoId: "r2", failureId: "B" });
  m.routeLanded(2, S("s1", "git"), "push");
  routeStack.keys[3] = S("s1", "send"); routeStack.depth = 3;
  m.routeLanded(3, S("s1", "send"), "push");
  assert.equal(m.screenParams("git"), null);
  routeStack.depth = 2;
  m.routeLanded(2, S("s1", "git"), "return");
  assert.deepEqual(m.screenParams("git"), { repoId: "r2", failureId: "B" });
});

test("an open is FRESH: it holds what it asked for, and with no ask nothing (a return is a close)", async () => {
  const m = await on([S(null, null), S("s1", null), S("s1", "git"), S("s1", "browse")]);
  routeStack.depth = 2;
  m.openOn("git", { repoId: "r1", failureId: null });
  m.routeLanded(2, S("s1", "git"), "push");
  routeStack.depth = 3;
  m.routeLanded(3, S("s1", "browse"), "push");
  // a bare open unwinding onto git is a fresh open: it never inherits r1 (review R2-2 b)
  routeStack.depth = 2;
  m.routeLanded(2, S("s1", "git"), "open");
  assert.equal(m.screenParams("git"), null);
  // a tap re-targets the open view: the entry takes it, and a pop gives it back
  m.openOn("git", { repoId: "r1", failureId: "C" });
  m.routeLanded(2, S("s1", "git"), "stay");
  routeStack.depth = 1;
  m.routeLanded(1, S("s1", null), "return");
  routeStack.depth = 2;
  m.routeLanded(2, S("s1", "git"), "return");
  assert.deepEqual(m.screenParams("git"), { repoId: "r1", failureId: "C" });
  // the effect re-running on the entry on top with no ask (a known entry, a pop's echo) keeps it
  m.routeLanded(2, S("s1", "git"), "stay");
  assert.deepEqual(m.screenParams("git"), { repoId: "r1", failureId: "C" });
});

test("the file tree's close back to git{r1} is a RETURN: one close, and the pop reads r1", async () => {
  const m = await on([S(null, null), S("s1", null), S("s1", "git"), S("s1", "browse")]);
  routeStack.depth = 2;
  m.openOn("git", { repoId: "r1", failureId: null });
  m.routeLanded(2, S("s1", "git"), "push");
  routeStack.depth = 3;
  m.routeLanded(3, S("s1", "browse"), "push");
  assert.equal(m.returnVerb("git", "browse"), "close");
  routeStack.depth = 2;
  m.routeLanded(2, S("s1", "git"), "return");
  assert.deepEqual(m.screenParams("git"), { repoId: "r1", failureId: null });
});

test("a pop onto a step over the screen reads the screen's own", async () => {
  const { stepKey } = await import("./routing.ts");
  const m = await on([S(null, null), S("s1", null)]);
  m.openOn("git", { repoId: "r1", failureId: null });
  routeStack.keys[2] = S("s1", "git"); routeStack.depth = 2;
  m.routeLanded(2, S("s1", "git"), "push");
  routeStack.keys[3] = stepKey(S("s1", "git"), 9);
  routeStack.keys[4] = S("s1", "send"); routeStack.depth = 4;
  m.routeLanded(4, S("s1", "send"), "push");
  routeStack.depth = 3;
  m.routeLanded(3, routeStack.keys[3], "return");
  assert.deepEqual(m.screenParams("git"), { repoId: "r1", failureId: null });
});

// ── A return to the sheet a screen covered is a Back, not a fresh open (bughunt 2026-10-29, review E2) ──
// The annotator came back to the backlog through `nav.open("backlog")`: the route unwound onto the
// backlog's own key, which is a FRESH open (`forgetKept`), so the kept cut and search were dropped.

test("closeLandsOn: the sheet ONE close of the top screen lands on", async () => {
  const m = await import("./backStep.ts");
  routeStack.keys = [S(null, null), S(null, "backlog"), S(null, "image")];
  routeStack.depth = 2;
  assert.equal(m.closeLandsOn("backlog"), true, "the annotator over the backlog closes onto it");
  assert.equal(m.closeLandsOn("send"), false);
  routeStack.keys = [S(null, null), S(null, "image")];
  routeStack.depth = 1;
  assert.equal(m.closeLandsOn("backlog"), false, "nothing of the backlog under it: the caller opens it");
  routeStack.keys = [S(null, null), S("s1", null), S("s1", "backlog"), S("s1", "image")];
  routeStack.depth = 3;
  assert.equal(m.closeLandsOn("backlog"), true, "over a session too");
});

test("the backlog the annotator covered comes back with its cut: close + pop restores, open forgets", () => {
  const s = setup();
  routeStack.keys.push(routeKey(null, "image"));
  keepCovered(1); s.clear();
  // the Back path: the pop lands on the backlog's entry and restores
  restoreKept(1, routeKey(null, "backlog"));
  assert.equal(s.get(), "the 10 waiting");
});

// ── A RETURN is its own verb (review R2-2 d): the images feature's goTo closes when ONE close
// lands on the sheet it names, so the pop restores that sheet's kept stores and params; only a
// sheet nothing covered is opened, fresh.

test("returnVerb: close when one close lands on the named sheet, open otherwise, close for null", async () => {
  const m = await import("./backStep.ts");
  routeStack.keys = [S(null, null), S(null, "backlog"), S(null, "browse")];
  routeStack.depth = 2;
  assert.equal(m.returnVerb("backlog", "browse"), "close", "closeBrowse back to the backlog keeps its cut");
  assert.equal(m.returnVerb("schedule", "browse"), "open", "nothing of it under the tree: open it");
  assert.equal(m.returnVerb(null, "browse"), "close");
  assert.equal(m.returnVerb(null, null), null, "nothing on top, nothing to do");
  assert.equal(m.returnVerb("backlog", null), "open");
});

// review R2-2b L2: driven through the routing effect and the popstate handler's own bodies
// (landRoute, landPop) against a history with real entries — never restoreKept by hand.
test("the backlog a file tree covered comes back with its cut through the return verb", async () => {
  const m = await import("./backStep.ts");
  const { landPop, landRoute } = await import("./core/route/landRoute.ts");
  const h = browserHistory();
  const s = setup();
  routeStack.keys = []; routeStack.depth = 0;
  landRoute(null, null, null, true);
  landRoute(null, "backlog", null, false);
  landRoute(null, "browse", null, false); // pushed over the backlog: its cut is kept…
  s.clear();                              // …and its onLeave drops it
  assert.equal(m.returnVerb("backlog", "browse"), "close");
  // goTo's close: the browse sheet closes itself, the route unwinds ONE entry, and its popstate lands
  landRoute(null, null, null, false);
  assert.equal(h.state.navRoute, routeKey(null, "backlog"), "history.go(-1) went to the backlog's entry");
  assert.equal(landPop()?.overlay, "backlog");
  assert.equal(s.get(), "the 10 waiting");
  delete globalThis.history; delete globalThis.location;
});

test("an OPEN of the backlog from the file tree is fresh: its kept cut is forgotten", async () => {
  const { landPop, landRoute } = await import("./core/route/landRoute.ts");
  browserHistory();
  const s = setup();
  routeStack.keys = []; routeStack.depth = 0;
  landRoute(null, null, null, true);
  landRoute(null, "backlog", null, false);
  landRoute(null, "browse", null, false);
  s.clear();
  landRoute(null, "backlog", null, false); // nav.open("backlog"): unwinds onto it, forgetting
  assert.equal(landPop()?.overlay, "backlog");
  assert.equal(s.get(), null);
  delete globalThis.history; delete globalThis.location;
});

// navActions/actions.ts import the sdk barrel by extensionless paths and cannot load under node: SOURCE pin.
test("wiring: the images feature has ONE return path, and the annotator and collage take it", async () => {
  const { readFileSync } = await import("node:fs");
  const nav = readFileSync(new URL("./features/images/navActions.ts", import.meta.url), "utf8");
  assert.match(nav, /const how = returnVerb\(o, nav\.overlay\);/);
  assert.match(nav, /if \(how === "close" && nav\.overlay\) nav\.close\(nav\.overlay\);\s*else if \(how === "open" && o\) nav\.open\(o\);/);
  const a = readFileSync(new URL("./features/images/actions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(a, /nav\.open\("backlog"\)/, "a fresh open forgets the kept cut");
  assert.doesNotMatch(a, /returnFromAnnotator|closeLandsOn/, "one return path: goTo");
  assert.equal((a.match(/ann\.set\(null\); goTo\(back\);/g) || []).length, 2, "afterUpload, closeAnnotator");
  assert.equal((a.match(/ann\.set\(null\); goTo\("backlog"\);/g) || []).length, 2, "afterText, skipImage");
  assert.match(a, /collage\.set\(null\);\n  goTo\(back\);/, "collageClose");
});

// ── What the routing effect files, as ONE pure decision (review R2-2 e, ML1) ──
// useRoute's effect called routeLanded from five branches with a hand-picked `how` each, and three
// of them were free to be reverted with every test green. The decision is now routeLanding's.

test("routeLanding: every branch of the routing effect and what it files", async () => {
  const { routeLanding } = await import("./backStep.ts");
  const L = S(null, null), s = S("s1", null), g = S("s1", "git"), send = S("s1", "send");
  assert.deepEqual(routeLanding([L], 0, g, true, -1), { kind: "seed", how: "push" }, "a document booting deep invents its ancestors");
  assert.deepEqual(routeLanding([L], 0, g, true, 0), { kind: "seed", how: "push" }, "an entry adopted at depth 0 too");
  assert.deepEqual(routeLanding([L, s, g], 2, g, true, 2), { kind: "known", depth: 2, how: "stay" }, "a reload on our own entry keeps what it holds");
  assert.deepEqual(routeLanding([L, s, g], 2, g, false, 2), { kind: "known", depth: 2, how: "stay" }, "the effect's echo of a pop");
  // ML1: a notification re-targeting the open git view files its ask with THAT entry
  assert.deepEqual(routeLanding([L, s, g], 2, g, false, -1), { kind: "stay", how: "stay" });
  // a tap naming a screen below unwinds to it: a FRESH open, its kept stores forgotten
  assert.deepEqual(routeLanding([L, s, g, send], 3, g, false, -1), { kind: "go", delta: -1, forget: true, how: "open" });
  // a close of Send lands ONE step down, on git: a return, the pop reads the entry back
  assert.deepEqual(routeLanding([L, s, g, send], 3, s, false, -1), { kind: "go", delta: -1, forget: false, how: "return" });
  assert.deepEqual(routeLanding([L, s], 1, g, false, -1), { kind: "push", how: "push" });
});

test("wiring: the routing effect files through routeLanding, once", async () => {
  const { readFileSync } = await import("node:fs");
  const r = readFileSync(new URL("./core/route/landRoute.ts", import.meta.url), "utf8");
  assert.match(r, /const plan = routeLanding\(routeStack\.keys, routeStack\.depth, key, first, known\);/);
  assert.match(r, /routeLanded\(routeStack\.depth, routeStack\.keys\[routeStack\.depth\] \?\? "", plan\.how\);/);
  assert.equal((r.match(/routeLanded\(/g) || []).length, 2, "the effect's one call and the pop's (landPop)");
  const u = readFileSync(new URL("./core/route/useRoute.ts", import.meta.url), "utf8");
  assert.equal((u.match(/routeLanded\(/g) || []).length, 0, "useRoute files nothing itself");
  assert.equal((u.match(/landRoute\(/g) || []).length, 1, "the effect runs landRoute once");
  assert.match(u, /const r = landPop\(\);\n      if \(!r\) return;/, "and popstate runs landPop");
});

// ── What a screen was opened ON survives a reload (review R2-2 a) ──
// `held` was a module Map only: a reload on git{X} came back on the session's repo, or — over the
// launcher — on nothing. The params are filed into the entry's own history.state (`navParams`)
// and read back from it when memory holds nothing for that entry.

function fakeHistory(state) {
  const h = { state, replaceState(s) { h.state = s; } };
  globalThis.history = h;
  return h;
}

test("a git entry's params are written into its history.state and read back after a reload", async () => {
  const m = await on([S(null, null), S("s1", null)]);
  const h = fakeHistory(null);
  m.openOn("git", { repoId: "X", failureId: "A" });
  routeStack.keys[2] = S("s1", "git"); routeStack.depth = 2;
  h.state = { navRoute: S("s1", "git"), navDepth: 2 }; // the routing effect's pushState
  m.routeLanded(2, S("s1", "git"), "push");
  assert.deepEqual(h.state.navParams, { overlay: "git", params: { repoId: "X", failureId: "A" } });
  assert.equal(h.state.navRoute, S("s1", "git"), "the entry's own fields stay");
  // the reload: a new document (a fresh module), nothing in memory; the entry is KNOWN (routeLanding: stay)
  const r = await import("./backStep.ts?reload");
  r.routeStack.keys[2] = S("s1", "git"); r.routeStack.depth = 2;
  r.routeLanded(2, S("s1", "git"), "stay");
  assert.deepEqual(r.screenParams("git"), { repoId: "X", failureId: "A" });
  delete globalThis.history;
});

test("a fresh open of an entry clears what its history.state held, so a later pop never resurrects it", async () => {
  const m = await import("./backStep.ts?fresh");
  m.routeStack.keys = [S(null, null), S("s1", null), S("s1", "git"), S("s1", "send")];
  const h = fakeHistory({ navRoute: S("s1", "git"), navDepth: 2, navParams: { overlay: "git", params: { repoId: "X", failureId: null } } });
  m.routeStack.depth = 2;
  m.routeLanded(2, S("s1", "git"), "open"); // a bare open unwinding onto it (state already that entry)
  assert.equal(m.screenParams("git"), null);
  assert.equal(h.state.navParams, undefined);
  // …and when the unwind's popstate arrives later, the "return" reads the fresh nothing
  h.state = { navRoute: S("s1", "git"), navDepth: 2, navParams: { overlay: "git", params: { repoId: "X", failureId: null } } };
  m.routeLanded(2, S("s1", "git"), "return");
  assert.equal(m.screenParams("git"), null, "memory says fresh: the stale state is not adopted");
  assert.equal(h.state.navParams, undefined, "and the entry is corrected");
  delete globalThis.history;
});

test("a state for another entry (another screen, another depth) is neither read nor written", async () => {
  const m = await import("./backStep.ts?other");
  m.routeStack.keys = [S(null, null), S("s1", null), S("s1", "git")];
  const h = fakeHistory({ navRoute: S("s1", "send"), navDepth: 3, navParams: { overlay: "git", params: { repoId: "Y", failureId: null } } });
  m.routeStack.depth = 2;
  m.routeLanded(2, S("s1", "git"), "stay");
  assert.equal(m.screenParams("git"), null);
  assert.equal(h.state.navParams.params.repoId, "Y");
  delete globalThis.history;
});

// ── review R2-2b M1: a reload with a STEP on top (the explain pane, an open file, the log focus) ──
// The browser's current entry is the step's, so the params on the git entry alone were out of reach:
// the seed re-created git with nothing and the view fell back to the session's repo. A step carries
// a copy of its screen's params, and the seed takes them. Driven through landRoute — the routing
// effect's body — against a history with real entries.

function browserHistory() {
  const h = {
    entries: [{ state: null }], at: 0,
    get state() { return h.entries[h.at].state; },
    pushState(s) { h.entries.length = h.at + 1; h.entries.push({ state: s }); h.at++; },
    replaceState(s) { h.entries[h.at] = { state: s }; },
    go(n) { h.at += n; },
    back() { h.at -= 1; },
  };
  globalThis.history = h;
  globalThis.location = { pathname: "/", search: "", hash: "" };
  return h;
}

test("a reload with the explain pane on top of git{X} comes back on X, through the seed", async () => {
  const b = await import("./backStep.ts");
  const { landRoute } = await import("./core/route/landRoute.ts");
  const h = browserHistory();
  b.routeStack.keys = []; b.routeStack.depth = 0;
  landRoute("s1", null, null, true); // the document boots on the session
  b.openOn("git", { repoId: "X", failureId: "F" }); // a notification tap
  landRoute("s1", "git", null, false);
  assert.deepEqual(b.screenParams("git"), { repoId: "X", failureId: "F" });
  b.pushStep(); // GitView's explain pane: useBackStep
  assert.deepEqual(h.state.navParams, { overlay: "git", params: { repoId: "X", failureId: "F" } }, "the step carries its screen's params");
  assert.equal(h.entries[h.at - 1].state.navRoute, S("s1", "git"), "the git entry under it is its own, untouched");
  // the reload: memory forgets everything this document filed (a push at depth 1 drops it), and
  // the stack is empty; history keeps the step's state
  b.routeLanded(1, S("s1", null), "push");
  b.routeStack.keys = []; b.routeStack.depth = 0;
  landRoute("s1", "git", null, true); // known = -1: the seed path
  assert.deepEqual(b.screenParams("git"), { repoId: "X", failureId: "F" });
  assert.deepEqual(h.state, { navRoute: S("s1", "git"), navDepth: 2, navParams: { overlay: "git", params: { repoId: "X", failureId: "F" } } }, "the seeded git entry holds them, for the next reload");
  delete globalThis.history; delete globalThis.location;
});

test("the seed takes nothing from a step over ANOTHER screen", async () => {
  const b = await import("./backStep.ts");
  const { landRoute } = await import("./core/route/landRoute.ts");
  const { stepKey } = await import("./routing.ts");
  const h = browserHistory();
  h.replaceState({ navRoute: stepKey(S("s1", "backlog"), 3), navDepth: 3, navParams: { overlay: "git", params: { repoId: "Y", failureId: null } } });
  b.routeStack.keys = []; b.routeStack.depth = 0;
  b.routeLanded(0, S(null, null), "push");
  landRoute("s1", "git", null, true);
  assert.equal(b.screenParams("git"), null);
  delete globalThis.history; delete globalThis.location;
});

// ── design round 4: onLeave is told WHY — "cover" (pushed over; Back returns) or "close" (gone) ──
// Driven through the routing effect's and popstate's own bodies; the ROUTE LAYER dispatches the
// leaves itself (`setSheetLeave`, registered by `core/sheets.ts` with the sheet table), off the
// stack before and after it moved — no React effect, so no effect order, is involved.
async function leaveRig(ids = ["backlog", "browse", "git"]) {
  const b = await import("./backStep.ts");
  const { landPop, landRoute } = await import("./core/route/landRoute.ts");
  const { createSheetTable } = await import("./core/featureRun.ts");
  const h = browserHistory();
  setSheetKeeper(() => null);
  routeStack.keys = []; routeStack.depth = 0;
  const got = [];
  const t = createSheetTable([{ id: "f", sheets: ids.map((id) => ({ id, persisted: false, render: () => null, onLeave: (r) => got.push(`${id}:${r}`) })) }]);
  b.setSheetLeave((id, reason) => t.leave(id, reason));
  const land = (next, id = "s1") => landRoute(id, next, null, false);
  // A Back: the pop, and — on a dead step — the further pop it asks for, as the browser would.
  const pop = () => { h.back(); let r = landPop(); while (!r) r = landPop(); return r; };
  landRoute("s1", null, null, true);
  const done = () => { b.setSheetLeave(() => {}); delete globalThis.history; delete globalThis.location; };
  return { b, h, got, land, pop, done };
}

test("onLeave gets the route's reason: cover on a push over it, close on ×, Back and an unwind past it", async () => {
  const { got, land, pop, done } = await leaveRig();
  land("backlog");
  land("browse");               // pushed over the backlog
  assert.deepEqual(got, ["backlog:cover"]);
  pop();                        // Back off the file tree
  assert.deepEqual(got.slice(1), ["browse:close"]);
  pop();                        // Back off the backlog
  assert.deepEqual(got.slice(2), ["backlog:close"]);
  land("backlog");
  land("git");                  // covered again…
  land(null, null);             // …then the launcher tapped: an unwind past both closes BOTH (review r4-7 M1)
  assert.deepEqual(got.slice(3), ["backlog:cover", "git:close", "backlog:close"]);
  done();
});

test("each removed sheet is told close exactly once; a step over a sheet covers nothing", async () => {
  const { b, got, land, pop, done } = await leaveRig();
  land("backlog");
  land("browse");
  b.pushStep();                 // an opened file inside the file tree: a step, not a screen
  assert.deepEqual(got, ["backlog:cover"]);
  land(null, null);             // the launcher tapped from under the step
  assert.deepEqual(got.slice(1), ["browse:close", "backlog:close"]);
  land(null, "s1");
  land("git");
  pop();
  assert.deepEqual(got.slice(3), ["git:close"], "the sheets closed before are not told again");
  done();
});

test("a Back that skips a dead step: the sheet it closed is told once, the one it lands on nothing", async () => {
  const { b, got, land, pop, done } = await leaveRig();
  const { VACANT } = await import("./routing.ts");
  land("backlog");
  const { depth } = b.pushStep();  // an item's detail pane over the backlog…
  land("git");                     // …git pushed over it: the backlog is covered
  routeStack.keys[depth] = VACANT; // the pane unmounted with its sheet: a dead step under git
  assert.deepEqual(got, ["backlog:cover"]);
  pop();                           // Back off git: lands on the dead step, goes on to the backlog
  assert.deepEqual(got.slice(1), ["git:close"]);
  assert.equal(routeStack.keys[routeStack.depth], S("s1", "backlog"));
  pop();
  assert.deepEqual(got.slice(2), ["backlog:close"]);
  done();
});

test("the same sheet over another session lower down: a Back off the top one is a CLOSE (review r4-7 L2)", async () => {
  const { got, land, pop, done } = await leaveRig();
  land("backlog", "s1");        // backlog over session 1
  land(null, "s2");             // session 2 tapped from it: the backlog is covered
  land("backlog", "s2");        // backlog over session 2
  assert.deepEqual(got, ["backlog:cover"]);
  pop();                        // Back off session 2's backlog: that entry is gone
  assert.deepEqual(got.slice(1), ["backlog:close"]);
  done();
});

test("re-targeting the sheet on top (same sheet, new entry) is no leave for it, either way", async () => {
  const { got, land, pop, done } = await leaveRig();
  land("backlog", "s1");
  land("backlog", "s2");        // the same sheet opened on another session, over the first
  pop();                        // Back to the first: the sheet never stopped being on top
  assert.deepEqual(got, []);
  land(null, "s1");             // the session itself
  assert.deepEqual(got, ["backlog:close"]);
  done();
});

test("wiring: the sheet table is the route layer's leave dispatcher; App holds no leave effect", async () => {
  const { readFileSync } = await import("node:fs");
  const s = readFileSync(new URL("./core/sheets.ts", import.meta.url), "utf8");
  assert.match(s, /setSheetLeave\(\(id, reason\) => TABLE\.leave\(id, reason\)\)/);
  const f = readFileSync(new URL("./core/featureRun.ts", import.meta.url), "utf8");
  assert.match(f, /\?\.onLeave\?\.\(reason\)/);
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /runSheetLeave|onLeave|leaveReason/, "a leave is the route's, never an App effect's");
});
