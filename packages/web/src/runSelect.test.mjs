import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectRun, drawnRuns, startedRun, startingSel, ackOfFate, fireNote, RUN_STARTING_NOTE, RUN_UNNAMED_NOTE } from "./runSelect.ts";

const runs = [{ runId: "c" }, { runId: "b" }, { runId: "a" }];
test("null selects the newest, empty string none, an id that run", () => {
  assert.equal(selectRun(runs, null).run.runId, "c");
  assert.equal(selectRun(runs, "").run, null);
  assert.equal(selectRun(runs, "a").run.runId, "a");
  assert.equal(selectRun([], null).run, null);
});
test("an id that left the list selects nothing and says gone", () => {
  assert.deepEqual(selectRun(runs, "old"), { run: null, gone: true });
});
test("a miss before the list was read is not yet gone", () => {
  assert.deepEqual(selectRun(runs, "old", false), { run: null, gone: false });
  assert.deepEqual(selectRun(runs, "old", true), { run: null, gone: true });
});
test("the selected run beyond the cap is drawn too", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ runId: "r" + i }));
  const sel = selectRun(many, "r10").run;
  const drawn = drawnRuns(many, sel);
  assert.equal(drawn.length, 9);
  assert.equal(drawn[8].runId, "r10");
  assert.equal(drawnRuns(many, many[2]).length, 8);
  assert.equal(drawnRuns(many, null).length, 8);
});
test("a run that left a status cut but is still in the list stays open, not gone", () => {
  const all = [{ runId: "c", status: "done" }, { runId: "b", status: "running" }];
  const cut = all.filter((r) => r.status === "running");
  assert.deepEqual(selectRun(cut, "c", true, all), { run: all[0], gone: false });
  // gone only when absent from the whole list
  assert.deepEqual(selectRun(cut, "zz", true, all), { run: null, gone: true });
  // the default (null) still follows the cut, never a run the cut hides
  assert.equal(selectRun(cut, null, true, all).run.runId, "b");
});
test("after a fire nothing is open until ITS run is named, then it is", () => {
  const known = new Set(["c", "b", "a"]);
  // no receipt yet: the previous newest run must NOT be selected
  const waiting = { known };
  assert.equal(startingSel(runs, waiting, null), "");
  assert.equal(selectRun(runs, startingSel(runs, waiting, null)).run, null);
  // the receipt names the run; once listed, that run is open
  const named = { known, ack: { ok: true, runId: "d" } };
  assert.equal(startingSel(runs, named, null), "");   // named but not listed yet: nothing, never "gone"
  const next = [{ runId: "d" }, ...runs];
  assert.equal(startedRun(next, named).runId, "d");
  assert.equal(selectRun(next, startingSel(next, named, null)).run.runId, "d");
  // not firing: sel passes through
  assert.equal(startingSel(runs, null, "b"), "b");
  assert.equal(startingSel(runs, null, null), null);
});
test("a different new run appearing first is never taken for the fired one (design round 4)", () => {
  const known = new Set(["c", "b", "a"]);
  // a scheduled build / another device's fire lands at the head before ours
  const other = [{ runId: "x" }, ...runs];
  // before the receipt: nothing, not the stranger
  assert.equal(startedRun(other, { known }), null);
  assert.equal(startingSel(other, { known }, null), "");
  // the receipt names ours: the stranger is never selected, ours is once listed
  const ack = { ok: true, runId: "d" };
  assert.equal(startingSel(other, { known, ack }, null), "");
  const both = [{ runId: "x" }, { runId: "d" }, ...runs];
  assert.equal(startingSel(both, { known, ack }, null), "d");
});
test("a receipt with no runId never adopts a run, and the note says so", () => {
  const known = new Set(["c", "b", "a"]);
  const ack = { ok: true };
  // one new run, two new runs: neither is taken for the fired one
  assert.equal(startedRun([{ runId: "d" }, ...runs], { known, ack }), null);
  assert.equal(startingSel([{ runId: "d" }, ...runs], { known, ack }, null), "");
  assert.equal(startingSel([{ runId: "x" }, { runId: "d" }, ...runs], { known, ack }, null), "");
  // a refused fire opens nothing
  assert.equal(startingSel([{ runId: "d" }, ...runs], { known, ack: { ok: false } }, null), "");
  // and the sheet says so in words, not a spinner
  const n = fireNote({ kind: "acked" }, false);
  assert.equal(n, RUN_UNNAMED_NOTE);
  assert.match(n, /did not say which run/);
  assert.doesNotMatch(n, /Starting/);
  // a receipt naming a run the list has not shown yet still says Starting — never silence
  // (after a reconnect that gap lasts until the welcome re-sync lands)
  assert.equal(fireNote({ kind: "acked", runId: "d" }, false), RUN_STARTING_NOTE);
  assert.equal(fireNote({ kind: "acked", runId: "d" }, true), null);
});
test("the receipt startedRun reads is the fate's: acked names its run, refused opens nothing", () => {
  assert.equal(ackOfFate(null), undefined);
  assert.equal(ackOfFate({ kind: "pending" }), undefined);
  assert.equal(ackOfFate({ kind: "dropped" }), undefined);
  assert.deepEqual(ackOfFate({ kind: "acked", runId: "d" }), { ok: true, runId: "d" });
  assert.deepEqual(ackOfFate({ kind: "acked" }), { ok: true });
  assert.deepEqual(ackOfFate({ kind: "refused", reason: "x" }), { ok: false });
});
test("the note: starting while pending (or acked) with no run open; refused gives the reason; dropped says not sent, never ran", () => {
  assert.equal(fireNote({ kind: "pending" }, false), RUN_STARTING_NOTE);
  assert.equal(fireNote({ kind: "pending" }, true), null);
  // a refusal is said in the sheet, with the desktop's reason: the toast is not always there
  // (a replayed verdict after a reconnect, a lost ledger, a thrown exec)
  assert.equal(fireNote({ kind: "refused", reason: "no such build" }, false), "The desktop refused the build — no such build.");
  assert.match(fireNote({ kind: "refused" }, false), /^The desktop refused the build — it gave no reason\./);
  assert.equal(fireNote({ kind: "refused", reason: "the desktop restarted." }, false), "The desktop refused the build — the desktop restarted.");
  assert.doesNotMatch(fireNote({ kind: "refused", reason: "x" }, false), /\b(started|running|ran|Starting)\b/);
  const n = fireNote({ kind: "dropped", reason: "queue full" }, false);
  assert.match(n, /^The build was not sent — queue full/);
  assert.doesNotMatch(n, /\b(started|running|ran)\b/i);
  assert.match(fireNote({ kind: "dropped" }, false), /not sent — its queue row is gone/);
});
test("the build sheet reads its fire's fate from the queue core, not a row-seen ref of its own", () => {
  const src = readFileSync(new URL("./BuildSheet.tsx", import.meta.url), "utf8");
  assert.match(src, /useFireFate\(starting\?\.ackId \?\? null\)/);
  assert.doesNotMatch(src, /rowSeen/);
  const act = readFileSync(new URL("./features/build/actions.ts", import.meta.url), "utf8");
  assert.match(act, /\{ cwd: repoDir, ackId, track: true \}/);
});
// A fire's note is about the tap, not the list: the first build in a repo has no runs yet, and a
// "starting", "not sent" or "did not say which run" note hidden inside the Runs block left that
// tap saying nothing at all.
test("the fire note is drawn whether or not any run is listed yet", () => {
  const src = readFileSync(new URL("./BuildSheet.tsx", import.meta.url), "utf8");
  const note = src.indexOf("fireNote(fate, !!selRun)");
  const runsBlock = src.indexOf("{runs.length > 0 && (");
  assert.ok(note > 0 && runsBlock > 0, "both found");
  assert.ok(note < runsBlock, "the note sits before the runs-only block");
});
test("the build feature's README describes the receipt as it is: no older-host guess, the unnamed note", () => {
  const md = readFileSync(new URL("./features/build/README.md", import.meta.url), "utf8");
  assert.doesNotMatch(md, /older host|infers only when/);
  assert.match(md, /RUN_UNNAMED_NOTE/);
});
