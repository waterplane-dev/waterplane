/**
 * The Activity screen says each fact once.
 *
 * A reviewer read the demo's Activity screen and found the same fact drawn several times over:
 * six chips reading 0, a finished download with a full bar and "31 kB of 31 kB" under
 * "downloaded", and a run row whose verdict came back a second time as "last run 2d ago — …".
 * These pin the shapes that replaced them, without a browser.
 *
 *     node --test packages/web/src/activity/saidOnce.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { activityChips } from "./activityChips.ts";
import { activityCounts, activityRows } from "../activityRows.ts";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const deps = {
  isEditableEntry: () => false,
  isCreateOp: () => false,
  laneLabel: (e) => e.sessionId,
  repoName: (cwd) => cwd.split("/").pop(),
};
const input = (over = {}) => ({ now: NOW, online: true, hostSeenAt: NOW - 1000, deps, ...over });
const counts = (over = {}) => ({ open: 0, all: 0, needsYou: 0, failed: 0, running: 0, waiting: 0, scheduled: 0, done: 0, dismissed: 0, ...over });

// ── The chip row ────────────────────────────────────────────────────────────

test("a bucket with rows is a chip; every empty one is named in ONE line, so 'nothing failed' is still said", () => {
  const { chips, none } = activityChips(counts({ all: 4, scheduled: 3, done: 1 }), "all", false);
  assert.deepEqual(chips.map((c) => c.text), ["all · 4", "scheduled · 3", "done · 1"]);
  assert.equal(none, "nothing needs you, failed, running, waiting or dismissed");
});

test("exactly one chip is lit, and `all` is always there to be the way back and the N of 'n of N'", () => {
  const { chips } = activityChips(counts({ all: 12, failed: 3, done: 9 }), "failed", false);
  assert.deepEqual(chips.filter((c) => c.on).map((c) => c.id), ["failed"]);
  assert.ok(chips.some((c) => c.id === "all" && c.text === "all · 12"));
});

test("the lit chip stays drawn at 0 — a cut whose rows moved on still says what it is", () => {
  const { chips, none } = activityChips(counts({ all: 2, done: 2 }), "failed", false);
  assert.ok(chips.some((c) => c.id === "failed" && c.on && c.text === "failed · 0"));
  assert.ok(!/failed/.test(none), "the lit chip is not also named as empty");
});

test("the caller's shortlist lights no chip: it is not 'all'", () => {
  const { chips } = activityChips(counts({ all: 5, failed: 5 }), "all", true);
  assert.equal(chips.some((c) => c.on), false);
});

test("nothing posted at all draws no chips and no line — the list's own sentence says it", () => {
  assert.deepEqual(activityChips(counts(), "all", false), { chips: [], none: null });
});

test("every bucket holding a row: no 'nothing' line at all", () => {
  const all = counts({ all: 6, needsYou: 1, failed: 1, running: 1, waiting: 1, scheduled: 1, done: 1, dismissed: 1 });
  assert.equal(activityChips(all, "all", false).none, null);
});

test("a bucket holding EVERY row is no chip — its tap opens the list on screen; the line says it", () => {
  const { chips, none } = activityChips(counts({ all: 4, done: 4 }), "all", false);
  assert.deepEqual(chips.map((c) => c.text), ["all · 4"]);
  assert.equal(none, "all done · nothing needs you, failed, running, waiting, scheduled or dismissed");
  assert.match(activityChips(counts({ all: 2, needsYou: 2 }), "all", false).none, /^all need you · /);
});

test("…but lit it stays drawn — the chip you are on never goes — and `dismissed` is outside all's pool", () => {
  const lit = activityChips(counts({ all: 4, done: 4 }), "done", false);
  assert.deepEqual(lit.chips.map((c) => [c.text, c.on]), [["all · 4", false], ["done · 4", true]]);
  assert.doesNotMatch(lit.none, /^all done/);
  const filed = activityChips(counts({ dismissed: 3 }), "all", false);
  assert.deepEqual(filed.chips.map((c) => c.text), ["all · 0", "dismissed · 3"]);
});

test("the chip counts and the rows they open come from the same counter", () => {
  const rows = activityRows(input({ pulls: [pull({ state: "done" }), pull({ id: "p2", state: "failed", error: "gone" })] }));
  const { chips } = activityChips(activityCounts(rows), "all", false);
  assert.deepEqual(chips.map((c) => c.text), ["open · 1", "all · 2", "failed · 1", "done · 1"]);
});

// ── A download ──────────────────────────────────────────────────────────────

function pull(over = {}) {
  const { id = "p1", size = 31_000, ...rest } = over;
  return {
    item: { id, repoId: "myapp", repoDir: "/dev/myapp", repoName: "myapp", name: "notes.md", relPath: "out/notes.md", size, mtime: NOW, ts: NOW - 1000, source: "outbox" },
    state: "done", received: size, attempts: 1, updatedAt: NOW, ...rest,
  };
}

test("a finished download says its size in the verdict and draws no bar", () => {
  const [r] = activityRows(input({ pulls: [pull()] }));
  assert.equal(r.verdict, "downloaded · 31 kB · on this phone");
  assert.equal(r.progress, null);
});

test("saved or handed on, the size leads the same way", () => {
  assert.equal(activityRows(input({ pulls: [pull({ savedTo: "Downloads" })] }))[0].verdict, "downloaded · 31 kB · saved to Downloads");
  assert.equal(activityRows(input({ pulls: [pull({ savedTo: "Chrome", saveVia: "browser" })] }))[0].verdict, "downloaded · 31 kB · handed to Chrome");
});

test("the bar is drawn while bytes are moving, and while paused part-way", () => {
  const running = activityRows(input({ pulls: [pull({ state: "downloading", received: 10_000, rate: 2_500_000 })] }))[0];
  assert.deepEqual(running.progress, { done: 10_000, total: 31_000, label: "bytes" });
  assert.equal(running.verdict, "32% — 2.5 MB/s");
  const paused = activityRows(input({ pulls: [pull({ state: "paused", received: 10_000 })] }))[0];
  assert.ok(paused.progress);
});

test("a queued download says its earlier progress in words, not a bar under them", () => {
  const r = activityRows(input({ pulls: [pull({ state: "queued", received: 15_500 })] }))[0];
  assert.match(r.verdict, /50% already here/);
  assert.equal(r.progress, null);
});

// ── A run's result ──────────────────────────────────────────────────────────

const ran = (over = {}) => ({
  id: "i1", cwd: "/dev/todo-garden", payload: { kind: "prompt", steps: ["rename Tasks to Beds"] },
  target: { kind: "repo", fresh: true }, trigger: { kind: "now" }, state: "done",
  createdAt: NOW - 2 * DAY - 3600e3, startedAt: NOW - 2 * DAY - 600e3, settledAt: NOW - 2 * DAY,
  result: { at: NOW - 2 * DAY, ok: true, detail: "ran in todo-garden · a session of its own" }, ...over,
});

test("a finished row's result is its verdict, said once — no 'last run … — <the same words>' under it", () => {
  const [r] = activityRows(input({ intents: [ran()] }));
  assert.equal(r.verdict, "ran in todo-garden · a session of its own");
  assert.equal(r.lastRun, null);
  // …nor "it reached the session" under it: `done` already is that.
  assert.equal(r.delivery, null);
});

test("an old failure is quoted, framed, in the verdict — the line under it does not re-issue the errand unframed", () => {
  const errand = "Session never became ready for input. Open the session, clear whatever is blocking it, and re-fire.";
  const [r] = activityRows(input({ intents: [ran({ state: "failed", result: { at: NOW - 2 * DAY, ok: false, detail: errand } })] }));
  assert.match(r.verdict, /^recorded when this failed/);
  assert.equal(r.lastRun, null);
});

test("…unless the run was late: that is news, so the line stays, without the words again", () => {
  const [r] = activityRows(input({ intents: [ran({ result: { at: NOW - 2 * DAY, ok: true, detail: "ran in todo-garden · a session of its own", late: true } })] }));
  assert.deepEqual(r.lastRun, { at: NOW - 2 * DAY, ok: true, detail: "", late: true });
});

test("a standing row's last run says what happened when its verdict is about the next one", () => {
  const [r] = activityRows(input({ intents: [ran({
    label: "weekly sweep", trigger: { kind: "at", rule: { kind: "weekly" }, graceMin: 30 }, nextAt: NOW + 3600e3,
    state: "blocked", blockReason: "notYet", blockDetail: "not due yet", settledAt: undefined,
  })] }));
  assert.equal(r.lastRun.detail, "ran in todo-garden · a session of its own");
});

// ── Where it ran, said once ─────────────────────────────────────────────────

test("once the result names the repo and the session, the meta line does not — host wording and demo wording", () => {
  for (const detail of ["ran in todo-garden · a session of its own", "opened a session in todo-garden", "ran in a new todo-garden session"]) {
    const [r] = activityRows(input({ intents: [ran({ result: { at: NOW - 2 * DAY, ok: true, detail } })] }));
    assert.equal(r.where, "", detail);
  }
});

test("…a result naming no place, or another repo, leaves the line whole", () => {
  const [quiet] = activityRows(input({ intents: [ran({ result: { at: NOW - 2 * DAY, ok: true, detail: "its turn finished" } })] }));
  assert.equal(quiet.where, "todo-garden · in a new session");
  // `garden` is inside `todo-garden`, and is not the repo that sentence names.
  const [other] = activityRows(input({ intents: [ran({ cwd: "/dev/garden" })] }));
  assert.equal(other.where, "garden · in a new session");
  const [waiting] = activityRows(input({ intents: [ran({ state: "queued", result: undefined, settledAt: undefined })] }));
  assert.equal(waiting.where, "todo-garden · in a new session");
});

test("…and *picking up the last conversation* stays: no result sentence says it", () => {
  const [r] = activityRows(input({ intents: [ran({ resume: true })] }));
  assert.equal(r.where, "picking up the last conversation");
});

test("'open' is the to-do cut: a chip while it is a real subset or lit, never a word in the 'nothing' line", () => {
  const mixed = activityChips(counts({ all: 38, open: 1, needsYou: 1, scheduled: 6, done: 31 }), "open", false);
  assert.deepEqual(mixed.chips.map((c) => [c.id, c.on]).slice(0, 2), [["open", true], ["all", false]]);
  assert.doesNotMatch(mixed.none ?? "", /\bopen\b/);
  // nothing open and not lit: no chip, and the buckets name their own empties
  const settled = activityChips(counts({ all: 4, done: 4 }), "all", false);
  assert.ok(!settled.chips.some((c) => c.id === "open"));
  // lit at 0 (the last open row was just dealt with): still drawn, so the cut says what it is
  const emptied = activityChips(counts({ all: 4, done: 4 }), "open", false);
  assert.ok(emptied.chips.some((c) => c.id === "open" && c.on));
});
