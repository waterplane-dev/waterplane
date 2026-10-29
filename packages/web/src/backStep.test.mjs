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
