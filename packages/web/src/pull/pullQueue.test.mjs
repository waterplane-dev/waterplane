// A row deleted by hand must not come back from a host list that still names it: the host answers each
// dismiss with its list, so a "delete all" reads lists naming the rows it has not dismissed yet.
import "../../../../scripts/lib-tsload.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { pullAdd, pullSync } = await import("./pullQueue.ts");

const item = (id) => ({ id, repoId: "r", repoDir: "", repoName: "", name: `${id}.apk`, relPath: `${id}.apk`, size: 1, mtime: 1, ts: 1, source: "auto" });
const manager = (removed) => ({
  records: {}, removed: new Set(removed), active: null,
  list() { return Object.values(this.records); },
  dropSuperseded() {}, shadowed: () => false, persist() {}, evictOld: async () => {}, pump() {},
});

test("sync leaves out a row removed by hand and takes the others", () => {
  const m = manager(["a"]);
  pullSync.call(m, [item("a"), item("b")]);
  assert.deepEqual(Object.keys(m.records), ["b"]);
});

test("a file queued afresh on the desktop is wanted again", () => {
  const m = manager(["a"]);
  pullAdd.call(m, item("a"));
  pullSync.call(m, [item("a")]);
  assert.deepEqual(Object.keys(m.records), ["a"]);
});
