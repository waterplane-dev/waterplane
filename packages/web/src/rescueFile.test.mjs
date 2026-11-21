/**
 * Where words the app rescues by itself go: the repo's backlog, marked — the pad
 * only where no repo is known, no filer is bound, or the filing was refused.
 *
 *     node --test packages/web/src/rescueFile.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rescueRoute, rescueWords, RESCUE_WHY } from "./rescueFile.ts";

const deps = (over = {}) => {
  const calls = { filed: [], padded: [] };
  return {
    calls,
    deps: {
      file: (f) => { calls.filed.push(f); return false; },
      fallbackCwd: () => "/r/last",
      addPad: (n) => { calls.padded.push(n); return null; },
      ...over,
    },
  };
};

test("the route: the rescue's own repo, else the last session's, else the pad", () => {
  assert.deepEqual(rescueRoute({ cwd: "/r/a", fallbackCwd: "/r/b", canFile: true }), { to: "backlog", cwd: "/r/a" });
  assert.deepEqual(rescueRoute({ cwd: undefined, fallbackCwd: "/r/b", canFile: true }), { to: "backlog", cwd: "/r/b" });
  assert.deepEqual(rescueRoute({ cwd: null, fallbackCwd: null, canFile: true }), { to: "pad", because: "no-repo" });
  assert.deepEqual(rescueRoute({ cwd: "/r/a", canFile: false }), { to: "pad", because: "no-filer" });
});

test("a rescue is filed held, marked with its reason, never auto-fired, chain kept", () => {
  const { calls, deps: d } = deps();
  const out = rescueWords(d, { text: "one", steps: ["two"], cwd: "/r/a", why: RESCUE_WHY.neverOpened }, 99);
  assert.deepEqual(out, { where: "backlog", cwd: "/r/a", offline: false });
  assert.equal(calls.padded.length, 0, "nothing lands on the pad");
  const f = calls.filed[0];
  assert.equal(f.repoDir, "/r/a");
  assert.equal(f.hold, true);
  assert.equal("autoFire" in f, false);
  assert.deepEqual(f.steps, ["one", "two"], "steps[0] repeats text, as fileNote does");
  assert.deepEqual(f.rescued, { why: RESCUE_WHY.neverOpened, at: 99 });
});

test("offline filing is reported, not refused", () => {
  const { deps: d } = deps({ file: () => true });
  assert.deepEqual(rescueWords(d, { text: "x", cwd: "/r/a", why: "w" }), { where: "backlog", cwd: "/r/a", offline: true });
});

test("no repo known: the pad takes them (the one remaining automatic pad use)", () => {
  const { calls, deps: d } = deps({ fallbackCwd: () => null });
  const out = rescueWords(d, { text: "x", why: "w" });
  assert.deepEqual(out, { where: "pad", because: "no-repo", refusal: null });
  assert.equal(calls.filed.length, 0);
  assert.deepEqual(calls.padded, [{ text: "x" }]);
});

test("a refused filing never deletes the words: they go to the pad, and the outcome says why", () => {
  const { calls, deps: d } = deps({ file: () => null });
  const out = rescueWords(d, { text: "x", steps: ["y"], cwd: "/r/a", why: "w" });
  assert.deepEqual(out, { where: "pad", because: "refused", refusal: null });
  assert.deepEqual(calls.padded, [{ text: "x", steps: ["y"], cwd: "/r/a" }]);
});

test("a pad that refuses too is reported, so the caller keeps its source", () => {
  const { deps: d } = deps({ file: () => null, addPad: () => "the pad is full" });
  assert.deepEqual(rescueWords(d, { text: "x", cwd: "/r/a", why: "w" }), { where: "pad", because: "refused", refusal: "the pad is full" });
});

test("no filer bound yet: pad, never a throw", () => {
  const { deps: d } = deps({ file: null });
  assert.equal(rescueWords(d, { text: "x", cwd: "/r/a", why: "w" }).where, "pad");
});
