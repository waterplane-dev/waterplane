/**
 * Two discovered repos with one name (`repotwins.ts`) — the 2026-10-28 week-end
 * burn went to a history-rewrite leftover that read exactly like the real repo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { repoLabel, twinWheres } from "../dist/index.js";

test("twins get the shortest parent tail that tells them apart; a lone name gets nothing", () => {
  const w = twinWheres([
    { name: "ciqkit", dir: "/Users/j/dev/garmin/ciqkit" },
    { name: "ciqkit", dir: "/Users/j/dev/waterplane-rewrite/out-ciqkit/ciqkit" },
    { name: "door-bell", dir: "/Users/j/dev/door-bell" },
  ]);
  assert.equal(w.get("/Users/j/dev/garmin/ciqkit"), "garmin/");
  assert.equal(w.get("/Users/j/dev/waterplane-rewrite/out-ciqkit/ciqkit"), "out-ciqkit/");
  assert.equal(w.has("/Users/j/dev/door-bell"), false);
});

test("a shared last parent reaches one segment further back", () => {
  const w = twinWheres([
    { name: "app", dir: "/a/work/app" },
    { name: "app", dir: "/b/work/app" },
  ]);
  assert.equal(w.get("/a/work/app"), "a/work/");
  assert.equal(w.get("/b/work/app"), "b/work/");
});

test("one parent ending the other: the short one says its whole path, never a label that repeats", () => {
  const w = twinWheres([
    { name: "x", dir: "/dev/x" },
    { name: "x", dir: "/home/dev/x" },
  ]);
  assert.equal(w.get("/home/dev/x"), "home/dev/");
  assert.equal(w.get("/dev/x"), "/dev/");
  assert.notEqual(w.get("/dev/x"), w.get("/home/dev/x"));
});

test("the same dir listed twice is one clone, not a twin", () => {
  assert.equal(twinWheres([{ name: "x", dir: "/a/x" }, { name: "x", dir: "/a/x" }]).size, 0);
});

test("repoLabel: bare name without `where`, name · where with it", () => {
  assert.equal(repoLabel({ repoName: "door-bell" }), "door-bell");
  assert.equal(repoLabel({ repoName: "ciqkit", where: "garmin/" }), "ciqkit · garmin/");
});
