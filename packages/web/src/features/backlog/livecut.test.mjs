// NAV-1: Back restores the backlog cut that was ON SCREEN, not the one the
// sheet was opened on. The cut (repo, typed search, status/age/kind/clock/ids
// chips, ids label) is ONE store outside the sheet: the doors write it, the
// sheet reads and writes it, `onLeave` clears it, `keep` puts it back.
//
// The store itself (`store.ts`) and the manifest import the SDK barrel, which
// node cannot load; so these drive the same pieces the manifest wires — the
// pure transitions in `logic.ts`, `keepStores` over a store made by the SDK's
// own `createStore`, the real route stack in `backStep.ts`, and the real hook.
// `tools/backlogpins.test.mjs` pins the two wiring lines (keep ⇔ onLeave).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { forgetKept, keepCovered, restoreKept, routeStack, setSheetKeeper } from "../../backStep.ts";
import { routeKey } from "../../routing.ts";
import { createStore, keepStores } from "../../sdk/store.ts";
import { NO_BACKLOG_FILTER } from "../../backlogFilter.ts";
import { useBacklogFilters } from "../../backlog/useBacklogFilters.ts";
import { NO_CUT, cutForRepo, cutInRepo, cutLeft, cutOpenedOn } from "./logic.ts";
import { scopedRepo } from "../../backlog/scopedRepo.ts";
import { readFileSync } from "node:fs";

const KEY = routeKey(null, "backlog");
const A = { worktreePath: "/r/a" };
const B = { worktreePath: "/r/b" };

/** One render of the real hook over a store, as `BacklogSheet` wires it:
 *  `cut` read from the store, `setCut` an updater applied to it. */
function render(store, extra = {}) {
  let seen;
  const p = { repos: [A, B], items: [], defaultRepoDir: "/r/a", cut: store.get(), setCut: (f) => store.set(f), ...extra };
  const C = () => { seen = useBacklogFilters(p); return null; };
  renderToString(createElement(C));
  return seen;
}

test("open on A with ids, re-scope to B, type, tap chips, leave, Back: B and all of it come back on the first frame", () => {
  const cut = createStore(NO_CUT);
  setSheetKeeper((k) => (k === KEY ? keepStores(cut)() : null));
  routeStack.keys = [routeKey(null, null), KEY];
  routeStack.depth = 1;
  try {
    cut.set((c) => cutOpenedOn(c, "/r/a", ["x"], "opened on x")); // openBacklogCut
    let f = render(cut);
    assert.equal(f.repoDir, "/r/a");
    assert.deepEqual(f.filter.ids, ["x"]);
    // The person works the sheet — through the hook's own verbs.
    f.selectRepo("/r/b");
    f = render(cut);
    f.setText("typed words");
    f.pickStatus("failed");
    f.pickAge("week");
    f.pickClock();
    keepCovered(1); // a session is pushed over the backlog
    cut.set(cutLeft); // its onLeave
    assert.equal(render(cut).text, "", "leaving drops the cut — it was the tap, not a setting");
    restoreKept(1, KEY); // Back, before the sheet remounts
    // The open-time repo is still the session's (defaultRepoDir): the cut wins.
    f = render(cut);
    assert.equal(f.repoDir, "/r/b");
    assert.equal(f.text, "typed words");
    assert.deepEqual({ ...f.filter }, { ...NO_BACKLOG_FILTER, status: "failed", age: "week", clock: true });
    assert.equal(f.idsLabel, undefined);
  } finally {
    forgetKept(1);
    setSheetKeeper(() => null);
  }
});

test("the hook draws the cut it is handed on its first render, over the session's repo", () => {
  const cut = createStore({ repoDir: "/r/b", text: "login", filter: { ...NO_BACKLOG_FILTER, status: "failed" }, idsLabel: undefined });
  const f = render(cut, { defaultRepoDir: "/r/a" });
  assert.equal(f.repoDir, "/r/b");
  assert.equal(f.text, "login");
  assert.equal(f.filter.status, "failed");
});

test("every tap on the sheet lands in the store — there is no second copy", () => {
  const cut = createStore({ ...NO_CUT, repoDir: "/r/a" });
  const f = render(cut);
  f.showIds(["m1", "m2"], "merged into “x”");
  assert.deepEqual(cut.get().filter.ids, ["m1", "m2"]);
  assert.equal(cut.get().idsLabel, "merged into “x”");
  f.pickCategory("fix");
  assert.equal(cut.get().filter.category, "fix");
  f.selectRepo("/r/b");
  assert.equal(cut.get().repoDir, "/r/b");
  assert.equal(cut.get().filter.ids, null, "an ids cut names rows of the repo it came from");
  assert.equal(cut.get().filter.category, "fix", "a kind means the same in every repo");
  f.clearFilter();
  assert.deepEqual({ ...cut.get().filter }, { ...NO_BACKLOG_FILTER });
});

test("a repo list that lands after mount scopes to the cut's repo; a gone repo falls back to the session's", () => {
  const cut = createStore({ ...NO_CUT, repoDir: "/r/b" });
  assert.equal(render(cut, { repos: [] }).repoDir, "");
  assert.equal(render(cut).repoDir, "/r/b");
  cut.set((c) => ({ ...c, repoDir: "/r/gone" }));
  assert.equal(render(cut).repoDir, "/r/a");
});

test("the doors: each keeps its documented cut, and none touches the typed search", () => {
  const onScreen = { repoDir: "/r/a", text: "typed", filter: { ...NO_BACKLOG_FILTER, status: "failed", ids: ["x"] }, idsLabel: "opened on x" };
  // openBacklogIn: the repo, without touching any cut — unless it moves repo.
  assert.equal(cutInRepo(onScreen, null), onScreen);
  assert.equal(cutInRepo(onScreen, "/r/a"), onScreen);
  assert.deepEqual(cutInRepo(onScreen, "/r/b"),
    { repoDir: "/r/b", text: "typed", filter: { ...NO_BACKLOG_FILTER, status: "failed" }, idsLabel: undefined });
  // openBacklogFor: the launcher's repo and no ids cut, even in the same repo.
  assert.deepEqual(cutForRepo(onScreen, "/r/a"),
    { repoDir: "/r/a", text: "typed", filter: { ...NO_BACKLOG_FILTER, status: "failed" }, idsLabel: undefined });
  // openBacklogCut: exactly the tap, never merged with the chips left on screen.
  assert.deepEqual(cutOpenedOn(onScreen, "/r/a", ["y"], "the 2 waiting"),
    { repoDir: "/r/a", text: "typed", filter: { ...NO_BACKLOG_FILTER, ids: ["y"] }, idsLabel: "the 2 waiting" });
  assert.deepEqual(cutOpenedOn(onScreen, "/r/b"), { repoDir: "/r/b", text: "typed", filter: NO_BACKLOG_FILTER, idsLabel: undefined });
  assert.equal(cutOpenedOn(NO_CUT, "/r/a", ["y"]).idsLabel, "made from these");
  // onLeave: the cut goes, the repo stays for the next plain open.
  assert.deepEqual(cutLeft(onScreen), { ...NO_CUT, repoDir: "/r/a" });
});

test("after Back restores repo B, a cut opened on repo A while the sheet is up shows A's rows in A, not on B's list", () => {
  // Open-time scope A (the session's), the person picked B, Back put B back.
  const cut = createStore({ ...NO_CUT, repoDir: "/r/b", text: "typed" });
  assert.equal(render(cut, { defaultRepoDir: "/r/a" }).repoDir, "/r/b");
  // A second notification lands: openBacklogCut("/r/a", ids) with the sheet on top.
  cut.set((c) => cutOpenedOn(c, "/r/a", ["a1"], "the 1 waiting in a"));
  const f = render(cut, { defaultRepoDir: "/r/a" });
  assert.equal(f.repoDir, "/r/a", "the cut re-scopes even though the session's repo never changed");
  assert.deepEqual(f.filter.ids, ["a1"]);
  assert.equal(f.idsLabel, "the 1 waiting in a");
  assert.equal(f.text, "typed", "the typed search is never overwritten");
});

const repos = [{ worktreePath: "/r/a" }, { worktreePath: "/r/b" }];
const item = (repoDir) => ({ repoDir, archived: false });

test("scopedRepo: cut, then session, then saved, then a repo with items; only the last is `derived`", () => {
  assert.deepEqual(scopedRepo({ repos, items: [], cutRepo: "/r/b", sessionRepo: "/r/a", saved: null }), { repoDir: "/r/b", derived: false });
  assert.deepEqual(scopedRepo({ repos, items: [], cutRepo: null, sessionRepo: "/r/a", saved: null }), { repoDir: "/r/a", derived: false });
  assert.deepEqual(scopedRepo({ repos, items: [], cutRepo: null, sessionRepo: null, saved: "/r/b" }), { repoDir: "/r/b", derived: false });
  assert.deepEqual(scopedRepo({ repos, items: [item("/r/b")], cutRepo: null, sessionRepo: null, saved: null }), { repoDir: "/r/b", derived: true });
  assert.deepEqual(scopedRepo({ repos, items: [], cutRepo: null, sessionRepo: null, saved: null }), { repoDir: "/r/a", derived: false });
});

test("the hook pins a repo derived from items into the cut (an effect, so the source is read)", () => {
  const hook = readFileSync(new URL("../../backlog/useBacklogFilters.ts", import.meta.url), "utf8");
  assert.match(hook, /useEffect\(/);
  assert.match(hook, /derived/);
});
