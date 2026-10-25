// A schedule that runs a build: the `build` arm of `ScheduleAction`, its
// cleaning, the one line it is described by, and the cue's count = cut helper.
import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanAction, scheduleActionText, scheduleActionDirs, schedulesForBuild,
  scheduleIdFromOrigin, scheduleItemOrigin, ORIGIN_SCHEDULE_BUILD,
} from "../dist/index.js";

test("cleanAction keeps a build arm: repo, id and one-line values — no text needed", () => {
  assert.deepEqual(
    cleanAction({ kind: "build", repoDir: "/r/app", buildId: " apk ", params: { flavour: "debug", app: "a" } }),
    { kind: "build", repoDir: "/r/app", buildId: "apk", params: { flavour: "debug", app: "a" } },
  );
  // Absent params stay absent; a stray `text` is not carried.
  assert.deepEqual(cleanAction({ kind: "build", repoDir: "/r", buildId: "b", text: "x" }), { kind: "build", repoDir: "/r", buildId: "b" });
});

test("cleanAction drops what a build cannot run with", () => {
  assert.equal(cleanAction({ kind: "build", repoDir: "/r" }), null, "no build id");
  assert.equal(cleanAction({ kind: "build", buildId: "b" }), null, "no repo");
  assert.equal(cleanAction({ kind: "build", repoDir: "/r", buildId: "  " }), null);
  const c = cleanAction({
    kind: "build", repoDir: "/r", buildId: "b",
    params: { ok: "v", "bad key": "x", "9x": "y", empty: "", nl: "one\ntwo", n: 5 },
  });
  // Key shape enforced; an empty value is NOT GIVEN (falls to the default or
  // the refusal), never an empty string on a command line; one line only.
  assert.equal(c.params.ok, "v");
  assert.equal("bad key" in c.params, false);
  assert.equal("9x" in c.params, false);
  assert.equal("empty" in c.params, false);
  assert.equal(c.params.nl.includes("\n"), false);
  assert.equal(cleanAction({ kind: "build", repoDir: "/r", buildId: "b", params: { e: "" } }).params, undefined);
  assert.equal(cleanAction({ kind: "build", repoDir: "/r", buildId: "b", params: ["a"] }).params, undefined);
});

test("cleanAction is idempotent on a build arm", () => {
  const once = cleanAction({ kind: "build", repoDir: "/r", buildId: "b", params: { a: "1" } });
  assert.deepEqual(cleanAction(once), once);
});

test("scheduleActionText / scheduleActionDirs answer for every arm", () => {
  assert.equal(scheduleActionText({ kind: "build", repoDir: "/r", buildId: "apk" }), "run build apk");
  assert.equal(scheduleActionText({ kind: "backlog", repoDir: "/r", text: "hi" }), "hi");
  assert.equal(scheduleActionText({ kind: "fanout", dirs: ["/a"], text: "sweep" }), "sweep");
  assert.deepEqual(scheduleActionDirs({ kind: "build", repoDir: "/r", buildId: "apk" }), ["/r"]);
  assert.deepEqual(scheduleActionDirs({ kind: "fanout", dirs: ["/a", "/b"], text: "s" }), ["/a", "/b"]);
});

test("schedulesForBuild: exactly the rules running that build in that repo", () => {
  const e = (id, action) => ({ id, action });
  const entries = [
    e("a", { kind: "build", repoDir: "/r", buildId: "apk" }),
    e("b", { kind: "build", repoDir: "/r", buildId: "web" }),
    e("c", { kind: "build", repoDir: "/other", buildId: "apk" }),
    e("d", { kind: "backlog", repoDir: "/r", text: "apk" }),
    e("f", { kind: "build", repoDir: "/r", buildId: "apk", params: { x: "1" } }),
  ];
  assert.deepEqual(schedulesForBuild(entries, "/r", "apk").map((x) => x.id), ["a", "f"]);
  assert.deepEqual(schedulesForBuild(entries, "/r", "none"), []);
  assert.deepEqual(schedulesForBuild([], "/r", "apk"), []);
});

test("the build rule's own row origin is reserved — never read as an entry id", () => {
  assert.equal(ORIGIN_SCHEDULE_BUILD, "schedule:build");
  assert.equal(scheduleIdFromOrigin(ORIGIN_SCHEDULE_BUILD), undefined);
  assert.equal(scheduleIdFromOrigin(scheduleItemOrigin("nightly")), "nightly");
});
