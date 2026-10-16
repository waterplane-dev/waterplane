/**
 * The cost window: the ledger folded over an arbitrary span, and the titles
 * and launches joined onto it.
 *
 *     node --test packages/host/test/costwindow.test.mjs
 *
 * The fold is a sum, so every way it can be wrong is a bucket landing in the
 * wrong place: an edge hour in or out, an agent counted as a conversation of
 * its own, a repo named by the wrong file, an unpriced model charged zero.
 * Pinned over a hand-built store, no files and no clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { costOf, tokenTotal } from "@waterplane/shared";
import { costMeta, foldCostWindow } from "../dist/costwindow.js";

const CROSS = "\u0000";
const p = (n) => String(n).padStart(2, "0");
/** A local hour key and its top, for 2026-10-08 at `h`. */
const hk = (h) => `2026-10-08T${p(h)}`;
const at = (h, m = 0) => new Date(2026, 9, 8, h, m, 0, 0).getTime();
const tally = (input, output, turns = 1) => [input, output, 0, 0, 0, turns];
const x = (...rows) => Object.fromEntries(rows.map(([h, model, t]) => [`${hk(h)}${CROSS}${model}`, t]));

const SONNET = "claude-sonnet-4-5";
const OPUS = "claude-opus-4-5";
const UNKNOWN = "made-up-model";

/**
 * Two slugs. Conversation A (repo /r/alpha) has turns at 09 (before the
 * window), 10 (the hour `from` falls in), 11, and 13 (the hour `to` sits on —
 * out), plus one opus agent at 11. Its agent file is read FIRST and names an
 * agent worktree, which must not become the conversation's repo. Conversation
 * B has no worktree and one unpriced turn at 12.
 */
const files = {
  "-r-alpha": {
    "aaaa1111/subagents/agent-x": { sub: 1, m: 0, s: 0, w: "/r/alpha/.claude/worktrees/agent-x", x: x([11, OPUS, tally(1000, 500)]) },
    "aaaa1111": {
      m: 0, s: 0, w: "/r/alpha",
      x: x([9, SONNET, tally(9_000_000, 0)], [10, SONNET, tally(2000, 100)], [11, SONNET, tally(3000, 200)], [13, SONNET, tally(7_000_000, 0)]),
    },
  },
  "-r-other": {
    "bbbb2222": { m: 0, s: 0, x: x([12, SONNET, tally(100, 10)], [12, UNKNOWN, tally(50_000, 5000)]) },
  },
};
const from = at(10, 30);
const to = at(13);
const noMeta = { byConv: new Map() };
const usd = (input, output, model) => costOf({ input, output, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, model, "2026-10-08").total;

test("the hour `from` falls in is counted whole, and the hour `to` sits on is out", () => {
  const doc = foldCostWindow(files, from, to, noMeta, 42);
  assert.equal(doc.fromHour, at(10));
  assert.equal(doc.from, from);
  assert.equal(doc.scannedAt, 42);
  assert.deepEqual(doc.hours.map((h) => h.hour), [hk(10), hk(11), hk(12)]);
  assert.deepEqual(doc.hours.map((h) => h.t), [at(10), at(11), at(12)]);
  // Neither the 9M at 09 nor the 7M at 13.
  assert.equal(tokenTotal(doc.totals), 2100 + 3200 + 1500 + 110 + 55_000);
});

test("an agent folds into its parent: agentTotals, agentByModel and the agent count", () => {
  const doc = foldCostWindow(files, from, to, noMeta, 0);
  assert.equal(doc.convos.length, 2);
  const a = doc.convos.find((c) => c.id === "aaaa1111");
  assert.equal(a.agents, 1);
  assert.equal(a.repo, "/r/alpha", "the parent's worktree names the repo, not the agent's");
  assert.equal(a.label, "alpha");
  assert.equal(tokenTotal(a.agentTotals), 1500);
  assert.equal(tokenTotal(a.totals), 2100 + 3200 + 1500);
  assert.deepEqual(a.agentByModel.map((s) => s.model), [OPUS]);
  assert.ok(Math.abs(a.agentCost.total - usd(1000, 500, OPUS)) < 1e-9);
  assert.ok(Math.abs(doc.agentCost.total - a.agentCost.total) < 1e-9);
  assert.deepEqual(a.byModel.map((s) => s.model), [SONNET, OPUS], "descending by tokens");
  assert.equal(a.firstAt, at(10));
  assert.equal(a.lastAt, at(11));
});

test("conversations are sorted by cost, and a conversation's hours sum to its cost", () => {
  const doc = foldCostWindow(files, from, to, noMeta, 0);
  for (let i = 1; i < doc.convos.length; i++) assert.ok(doc.convos[i - 1].cost.total >= doc.convos[i].cost.total);
  for (const c of doc.convos) {
    const sum = c.byHour.reduce((s, h) => s + h.usd, 0);
    assert.ok(Math.abs(sum - c.cost.total) < 1e-9, `${c.id}: ${sum} vs ${c.cost.total}`);
    assert.equal(c.byHour.reduce((s, h) => s + h.tok, 0), tokenTotal(c.totals));
  }
  const total = doc.convos.reduce((s, c) => s + c.cost.total, 0);
  assert.ok(Math.abs(total - doc.cost.total) < 1e-9);
  const hourTotal = doc.hours.reduce((s, h) => s + h.cost.total, 0);
  assert.ok(Math.abs(hourTotal - doc.cost.total) < 1e-9);
});

test("a log with no worktree is the unknown repo, and an unpriced model is counted, never charged zero", () => {
  const doc = foldCostWindow(files, from, to, noMeta, 0);
  const b = doc.convos.find((c) => c.id === "bbbb2222");
  assert.equal(b.repo, "");
  assert.equal(b.label, "unknown repo");
  assert.equal(tokenTotal(doc.unpriced), 55_000);
  const slice = b.byModel.find((s) => s.model === UNKNOWN);
  assert.equal(slice.cost.total, 0);
  assert.equal(tokenTotal(slice.totals), 55_000);
  assert.ok(Math.abs(b.cost.total - usd(100, 10, SONNET)) < 1e-9);
  const h12 = doc.hours.find((h) => h.hour === hk(12));
  assert.deepEqual(h12.byRepo.map((r) => [r.repo, r.label]), [["", "unknown repo"]]);
});

test("an hour's repo split names the conversation's repo, descending by cost", () => {
  const doc = foldCostWindow(files, from, to, noMeta, 0);
  const h11 = doc.hours.find((h) => h.hour === hk(11));
  assert.deepEqual(h11.byRepo.map((r) => r.repo), ["/r/alpha"], "the agent worktree is its repo's spend");
  assert.equal(tokenTotal(h11.byRepo[0].totals), 3200 + 1500);
});

test("a span with nothing in it is an empty document, not an error", () => {
  const doc = foldCostWindow(files, at(20), at(22), noMeta, 0);
  assert.deepEqual(doc.hours, []);
  assert.deepEqual(doc.convos, []);
  assert.equal(doc.cost.total, 0);
});

test("costMeta: live beats closed, a fan-out target names its run, the run's label is joined", () => {
  const sessions = {
    list: () => [{ id: "s1", claudeSessionId: "aaaa1111", tabTitle: "Live tab", title: "alpha", model: "opus" }],
    originOf: (id) => (id === "s1" ? { kind: "fanout", itemId: "run9#3", itemLabel: "the shared prompt" } : undefined),
    listClosed: () => [
      { id: "c1", cwd: "/r/alpha", title: "old", closedAt: 2, claudeSessionId: "aaaa1111", tabTitle: "Closed tab" },
      { id: "c2", cwd: "/r/other", title: "other", closedAt: 1, claudeSessionId: "bbbb2222", kind: "backlog", itemId: "it7", itemLabel: "fix the thing", launch: { model: "sonnet" } },
      { id: "c3", cwd: "/r/other", title: "older", closedAt: 0, claudeSessionId: "bbbb2222", tabTitle: "Older row" },
    ],
  };
  const intents = { get: (id) => (id === "run9" ? { id, label: "senior architect top 5", payload: { kind: "prompt", steps: ["x"] } } : undefined) };
  const meta = costMeta(sessions, intents);
  const a = meta.byConv.get("aaaa1111");
  assert.equal(a.live, true);
  assert.equal(a.title, "Live tab");
  assert.deepEqual(a.launch, { kind: "fanout", runId: "run9", itemId: "run9#3", label: "senior architect top 5", model: "opus" });
  const b = meta.byConv.get("bbbb2222");
  assert.equal(b.live, false);
  assert.equal(b.title, "other", "the newest closed row wins");
  assert.deepEqual(b.launch, { kind: "backlog", itemId: "it7", label: "fix the thing", model: "sonnet" });

  const doc = foldCostWindow(files, from, to, meta, 0);
  const row = doc.convos.find((c) => c.id === "aaaa1111");
  assert.equal(row.live, true);
  assert.equal(row.launch.runId, "run9");
});

test("costMeta: a scheduled sweep's occurrence is labelled by its standing row; a throwing lookup leaves the label absent", () => {
  const sessions = {
    list: () => [
      { id: "s1", claudeSessionId: "c-sweep", title: "x" },
      { id: "s2", claudeSessionId: "c-throw", title: "y" },
    ],
    originOf: (id) => (id === "s1" ? { kind: "fanout", itemId: "weekly@1700#0" } : { kind: "fanout", itemId: "boom#1" }),
    listClosed: () => { throw new Error("disk"); },
  };
  const intents = {
    get: (id) => {
      if (id === "boom") throw new Error("store");
      return id === "weekly" ? { id, headline: "weekly sweep", payload: { kind: "prompt", steps: ["s"] } } : undefined;
    },
  };
  const meta = costMeta(sessions, intents);
  assert.deepEqual(meta.byConv.get("c-sweep").launch, { kind: "fanout", runId: "weekly@1700", itemId: "weekly@1700#0", label: "weekly sweep" });
  const t = meta.byConv.get("c-throw");
  assert.equal(t.launch.runId, "boom");
  assert.equal(t.launch.label, undefined);
  assert.equal("label" in t.launch, false);
});

// ── the cap: the dearest ship whole, the rest fold, every total stays whole ──

test("under the cap nothing is folded and the document says nothing about folding", () => {
  const doc = foldCostWindow(files, from, to, noMeta, 0);
  assert.equal("rest" in doc, false);
  assert.equal("convosTotal" in doc, false);
  assert.ok(doc.hours.every((h) => !("restConvos" in h)));
});

test("past the cap: the dearest carried, the rest folded by repo and launch, totals whole", () => {
  const whole = foldCostWindow(files, from, to, noMeta, 0);
  const doc = foldCostWindow(files, from, to, noMeta, 0, 1);
  assert.deepEqual(doc.convos.map((c) => c.id), [whole.convos[0].id], "the dearest one");
  assert.equal(doc.convosTotal, 2);
  assert.equal(doc.rest.length, 1);
  const r = doc.rest[0];
  const b = whole.convos.find((c) => c.id === "bbbb2222");
  assert.equal(r.repo, "");
  assert.equal(r.label, "unknown repo");
  assert.equal(r.count, 1);
  assert.equal("launch" in r, false, "no launch record: absent, never guessed");
  assert.ok(Math.abs(r.cost.total - b.cost.total) < 1e-9);
  assert.equal(tokenTotal(r.totals), tokenTotal(b.totals));
  assert.deepEqual(r.byModel.map((s) => s.model).sort(), b.byModel.map((s) => s.model).sort());
  assert.equal(r.firstAt, at(12));
  // The document's totals, hours and every hour's repo split still hold the folded conversation.
  assert.deepEqual(doc.totals, whole.totals);
  assert.deepEqual(doc.cost, whole.cost);
  assert.deepEqual(doc.hours.map((h) => [h.hour, h.byRepo.map((x) => x.repo)]), whole.hours.map((h) => [h.hour, h.byRepo.map((x) => x.repo)]));
  assert.equal(doc.hours.find((h) => h.hour === hk(12)).restConvos, 1, "the hour says one of its sessions is folded");
  assert.equal("restConvos" in doc.hours.find((h) => h.hour === hk(11)), false);
  // No carried row names a folded id.
  assert.ok(!doc.convos.some((c) => c.id === "bbbb2222"));
});

test("a folded fan-out is ONE group, named by its run and not by one target", () => {
  const conv = (id, n) => ({ [id]: { m: 0, s: 0, w: `/r/${id}`, x: x([11, SONNET, tally(1000 * n, 10)]) } });
  const store = { "-r": { ...conv("big", 100), ...conv("t1", 1), ...conv("t2", 2), ...conv("t3", 3) } };
  const byConv = new Map([
    ["t1", { live: false, launch: { kind: "fanout", runId: "run5", itemId: "run5#1", label: "lint sweep", model: "haiku" } }],
    ["t2", { live: false, launch: { kind: "fanout", runId: "run5", itemId: "run5#2", label: "lint sweep" } }],
    ["t3", { live: false, launch: { kind: "resurrect", runId: "run5", itemId: "run5#3", label: "lint sweep" } }],
  ]);
  const doc = foldCostWindow(store, at(11), at(12), { byConv }, 0, 1);
  assert.deepEqual(doc.convos.map((c) => c.id), ["big"]);
  // Three repos, so three groups — each carries the run, none a target's itemId or model.
  assert.equal(doc.rest.length, 3);
  for (const g of doc.rest) {
    assert.equal(g.launch.runId, "run5");
    assert.equal("itemId" in g.launch, false);
    assert.equal("model" in g.launch, false);
    assert.equal(g.launch.label, "lint sweep");
  }
  assert.equal(doc.rest.reduce((n, g) => n + g.count, 0), 3);
  assert.equal(doc.convosTotal, 4);
});
