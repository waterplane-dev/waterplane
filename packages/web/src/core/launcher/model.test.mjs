/**
 * The launcher's pure half (`core/launcher/model.ts`): the order, the cut, the
 * roll-ups and every number a launcher control carries and the rows its tap
 * opens. The bulk-close facet engine has its own test file (`closeModel.test.mjs`).
 *
 *     node --test packages/web/src/core/launcher/model.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  closeScope, dragOrder, filterSessions, nextSessionOrder, openingText, openingTitle,
  queuedChipCut, queuedKeysByRepo, repoGroupsOf, rollupByRepo, rollupTotal, sessionRowTitleIn, setupMenuLabel, sortSessions, starredByRepoOf,
  starredSpared,
} from "./model.ts";

const repoOf = (s) => s.cwd.split("/").pop();
const ses = (id, cwd, createdAt, o = {}) => ({ id, cwd, createdAt, title: id, running: true, ...o });
const repo = (repoName, worktreePath, o = {}) => ({ id: worktreePath, repoName, worktreePath, branch: "main", isPrimary: true, ...o });

test("rows sort by creation time and a repo's rows stay contiguous at its oldest session", () => {
  const list = [ses("b1", "/r/b", 2), ses("a1", "/r/a", 1), ses("b2", "/r/b", 4), ses("a2", "/r/a", 3)];
  // Interleaved by time (a1 b1 a2 b2) — grouped, repo `a` first because its oldest is oldest.
  assert.deepEqual(sortSessions(list, [], repoOf).map((s) => s.id), ["a1", "a2", "b1", "b2"]);
});

test("a manual order wins, and a session it does not know yet is appended", () => {
  const list = [ses("a1", "/r/a", 1), ses("a2", "/r/a", 2), ses("a3", "/r/a", 3)];
  assert.deepEqual(sortSessions(list, ["a2", "a1"], repoOf).map((s) => s.id), ["a2", "a1", "a3"]);
});

test("saving an order keeps hidden-but-alive ids and drops dead ones", () => {
  assert.deepEqual(nextSessionOrder(["x", "dead", "a"], ["a", "b"], new Set(["a", "b", "x"])), ["a", "b", "x"]);
});

test("a drag moves within a repo and refuses a cross-repo drop", () => {
  const sorted = [ses("a1", "/r/a", 1), ses("a2", "/r/a", 2), ses("b1", "/r/b", 3)];
  assert.deepEqual(dragOrder(sorted, "a2", "a1", repoOf), ["a2", "a1", "b1"]);
  assert.equal(dragOrder(sorted, "a2", "b1", repoOf), null);
  assert.equal(dragOrder(sorted, "a2", "a2", repoOf), null);
});

test("the status filter cuts the rows; a repo-scoped one only that repo's", () => {
  const sorted = [ses("a1", "/r/a", 1, { st: "wait" }), ses("b1", "/r/b", 2, { st: "wait" }), ses("a2", "/r/a", 3, { st: "done" })];
  const matches = (s, f) => s.st === f;
  assert.deepEqual(filterSessions(sorted, null, matches, repoOf).map((s) => s.id), ["a1", "b1", "a2"]);
  assert.deepEqual(filterSessions(sorted, { status: "wait" }, matches, repoOf).map((s) => s.id), ["a1", "b1"]);
  assert.deepEqual(filterSessions(sorted, { status: "wait", repo: "b" }, matches, repoOf).map((s) => s.id), ["b1"]);
});

test("a repo's roll-up buckets sum to its row count, and the total is the sum over repos", () => {
  const sorted = [ses("a1", "/r/a", 1, { st: "wait" }), ses("a2", "/r/a", 2, { st: "coding" }), ses("b1", "/r/b", 3, { st: "wait" })];
  const m = rollupByRepo(sorted, (s) => s.st, repoOf);
  const a = m.get("a");
  assert.equal(a.wait + a.limit + a.coding + a.done + a.exited, 2);
  assert.equal(rollupTotal(m, "wait"), 2);
  assert.equal(rollupTotal(m, "limit"), 0);
});

test("stars are their own count, never a roll-up bucket", () => {
  const sorted = [ses("a1", "/r/a", 1, { starred: true }), ses("a2", "/r/a", 2), ses("b1", "/r/b", 3, { starred: true })];
  const m = starredByRepoOf(sorted, repoOf);
  assert.equal(m.get("a"), 1);
  assert.equal(m.get("b"), 1);
});

test("the one list: live repos first, then the idle ones — and a filter drops the idle ones", () => {
  const shown = [ses("b1", "/r/b", 1)];
  const repos = [repo("a", "/r/a"), repo("b", "/r/b"), repo("c", "/r/c")];
  assert.deepEqual(repoGroupsOf(shown, repos, false, repoOf).map((g) => `${g.repoName}:${g.sessions.length}`), ["b:1", "a:0", "c:0"]);
  assert.deepEqual(repoGroupsOf(shown, repos, true, repoOf).map((g) => g.repoName), ["b"]);
});

test("the worktree cut keeps its repo's group even when no session runs in a worktree", () => {
  const repos = [repo("a", "/r/a"), repo("b", "/r/b")];
  // The rows the chip counted are the worktree rows under `a`'s header.
  assert.deepEqual(repoGroupsOf([], repos, true, repoOf, ["a"]).map((g) => `${g.repoName}:${g.sessions.length}`), ["a:0"]);
});

test("the queued chip counts waiting work, not failures, archived rows, standing rules or filed rows", () => {
  const outbox = [
    { ackId: "q1", cwd: "/r/a", status: "queued" },
    { ackId: "q2", cwd: "/r/a", status: "failed" },
    { ackId: "q3", cwd: "/r/a", status: "pending" },
  ];
  const work = (id, o = {}) => ({ id, cwd: "/r/a", state: "queued", trigger: { kind: "idle" }, payload: { kind: "prompt" }, target: { kind: "repo" }, ...o });
  const intents = [
    work("i1"),
    work("i2", { state: "blocked" }),
    work("i3", { state: "done" }),
    work("i4", { archived: true }),
    // A standing weekly rule — the schedules chip's, not this one's.
    work("i5", { trigger: { kind: "at", rule: { kind: "weekly" } } }),
    // A one-off with a clock IS this repo's waiting work.
    work("i6", { trigger: { kind: "at", rule: { kind: "once" } } }),
  ];
  const keys = queuedKeysByRepo(outbox, intents, new Set(["queue:q3"]), (cwd) => cwd.split("/").pop());
  assert.deepEqual(keys.get("a"), ["queue:q1", "intent:i1", "intent:i2", "intent:i6"]);
});

test("the waiting chip opens the Backlog only on rows the Backlog has; anything else opens Activity", () => {
  const work = (id, o = {}) => ({ id, cwd: "/r/a", state: "queued", trigger: { kind: "idle" }, payload: { kind: "prompt" }, target: { kind: "repo" }, ...o });
  const run = (outbox, intents) => {
    const keys = queuedKeysByRepo(outbox, intents, new Set(), (cwd) => cwd.split("/").pop()).get("a") ?? [];
    return { keys, cut: queuedChipCut(keys, intents) };
  };
  // two backlog rows, one checkout: the Backlog, on exactly the ids the number counted
  const two = run([], [work("i1"), work("i2", { state: "blocked" })]);
  assert.equal(two.keys.length, 2);
  assert.deepEqual(two.cut, { kind: "backlog", cwd: "/r/a", ids: ["i1", "i2"] });
  // a queued build is counted by the chip but is not a Backlog row: Activity, which lists it
  const build = run([], [work("i1"), work("b1", { payload: { kind: "build" } })]);
  assert.equal(build.keys.length, 2);
  assert.deepEqual(build.cut, { kind: "activity" });
  // a phone-side send is counted too and is no intent at all
  assert.deepEqual(run([{ ackId: "q1", cwd: "/r/a", status: "queued" }], [work("i1")]).cut, { kind: "activity" });
  // a queued parked launch is not a Backlog row either
  assert.deepEqual(run([], [work("l1", { trigger: { kind: "files" } })]).cut, { kind: "activity" });
});

test("bulk close: a star is a SCOPE — every count and the spared number read one list", () => {
  const visible = [ses("a1", "/r/a", 1, { starred: true }), ses("a2", "/r/a", 2), ses("b1", "/r/b", 3)];
  assert.deepEqual(closeScope(visible, "a", true, repoOf).map((s) => s.id), ["a2"]);
  assert.deepEqual(closeScope(visible, "a", false, repoOf).map((s) => s.id), ["a1", "a2"]);
  assert.equal(starredSpared(visible, "a", true, repoOf), 1);
  assert.equal(starredSpared(visible, "a", false, repoOf), 0);
  assert.equal(closeScope(visible, undefined, true, repoOf).length, 2);
});

test("an in-flight open always says how many, one included", () => {
  assert.equal(openingText({ status: "queued", n: 1 }), "queued 1");
  assert.equal(openingText({ status: "pending", n: 2 }), "opening… 2");
  assert.match(openingTitle({ status: "pending", n: 2 }), /^2 sessions opening/);
});

test("the setup menu entry is always a door, with its count only when there are findings", () => {
  assert.equal(setupMenuLabel(undefined), "repo readings");
  assert.equal(setupMenuLabel({ ok: true, issues: 0, fixable: 0 }), "repo readings");
  assert.equal(setupMenuLabel({ ok: false, issues: 3, fixable: 1 }), "repo readings · 3");
});

test("a row title outside the list is never empty", () => {
  const repos = [repo("myapp", "/r/myapp")];
  assert.equal(sessionRowTitleIn(repos, ses("x", "/r/myapp", 1, { tabTitle: "fix the tabs" })), "fix the tabs");
  assert.equal(sessionRowTitleIn([], ses("x", "/r/elsewhere", 1)), "elsewhere");
});
