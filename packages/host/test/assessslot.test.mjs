/**
 * **The slot check, host half** — an assessment scoped to rows that fire
 * together, and the three things its apply does that a repo-wide one did not.
 *
 *  1. **The slot is re-derived from the LIVE rows.** The run's ids are the
 *     slot's members as this host sees them; a key that names nothing any more,
 *     or a slot down to one row, is refused in a sentence and no run is posted.
 *  2. **A split posts both halves on the original's clock, THEN archives the
 *     original** — never cancels it. A failed post leaves the original
 *     untouched; a replayed apply finds the rows it already posted (the ids are
 *     a hash of run + split) and posts nothing twice.
 *  3. **A conflict mutates nothing**, and a merge carries the LATEST member's
 *     clock — or is refused in words when that cannot be told.
 *  …and a slot's approved order goes through the drag's own `reorder`.
 *
 *     node --test packages/host/test/assessslot.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProposal, assessPrompt, buildAssessInput, startAssessment } from "../dist/assess.js";
import { splitIds } from "../dist/assess/hassapply.js";

const CWD = "/repo/myapp";
const MIN = 60_000;
const AT = Date.UTC(2026, 9, 16, 18, 0);
const KEY = `at:${AT}`;

const timed = (id, at, extra = {}) => ({
  id, cwd: CWD, state: "queued",
  payload: { kind: "prompt", steps: [`do ${id}`] },
  target: { kind: "repo", fresh: true },
  trigger: { kind: "at", rule: { kind: "once", at }, graceMin: 30 },
  nextAt: at, createdAt: 1000, order: 1000 + id.charCodeAt(0),
  ...extra,
});

function fakeIntents(rows, opts = {}) {
  const by = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls = [];
  return {
    calls, rows: by,
    get: (id) => by.get(id),
    list: () => [...by.values()],
    post: (draft) => {
      const had = by.get(draft.id);
      if (had) { calls.push(`post-existing:${draft.id}`); return { ok: true, intent: had, existing: true }; }
      if (opts.refusePost?.(draft)) { calls.push(`post-refused:${draft.id}`); return { ok: false, reason: "too many are already waiting" }; }
      calls.push(`post:${draft.id}`);
      const row = { ...draft, state: "queued", nextAt: draft.trigger?.kind === "at" ? draft.trigger.rule.at : undefined };
      by.set(draft.id, row);
      return { ok: true, intent: row };
    },
    cancel: (id) => { calls.push(`cancel:${id}`); return true; },
    dismiss: (id) => { calls.push(`dismiss:${id}`); return true; },
    edit: (id, patch) => {
      const row = by.get(id);
      if (!row) return { ok: false };
      if (patch.archived === true) { calls.push(`archive:${id}`); row.archived = true; }
      if (typeof patch.order === "number") { calls.push(`order:${id}:${patch.order}${patch.handOrdered ? ":hand" : ""}`); row.order = patch.order; }
      if (patch.handOrdered) row.handOrdered = true;
      return { ok: true };
    },
    requeueFailed: () => ({ ok: false, reason: "not failed" }),
    name: () => ({ headline: false, category: false }),
    kick: () => { calls.push("kick"); },
  };
}

/** A store holding one finished run over these rows. */
function storeWith(runId, rows, proposal, scope = { kind: "slot", key: KEY }) {
  const input = buildAssessInput(CWD, rows, [], AT - 60 * MIN, rows.map((r) => r.id), scope);
  const run = { runId, repoDir: CWD, status: "done", input, proposal, scope };
  const applied = [];
  return {
    applied,
    get: (id) => (id === runId ? run : undefined),
    recordApplied: (id, counts) => { applied.push(counts); run.status = "applied"; run.applied = counts; },
  };
}
const empty = { rows: [], merges: [], news: [], notes: [] };

// ── 1. Resolving the slot ────────────────────────────────────────────────────

const postsInto = (rows) => {
  const ints = fakeIntents(rows);
  const posted = [];
  ints.post = (d) => { posted.push(d); return { ok: true, intent: d }; };
  return { ints, posted };
};

test("a slot run judges exactly the caller's ids, confirmed against the live slot", () => {
  const rows = [timed("a", AT), timed("b", AT + MIN), timed("c", AT + 3 * 60 * MIN), timed("z", AT, { cwd: "/elsewhere" })];
  const { ints, posted } = postsInto(rows);
  // The phone read the time a minute apart: the key is matched with tolerance.
  const r = startAssessment(ints, { running: () => null }, CWD, ["a", "b"], { kind: "slot", key: `at:${AT + MIN}` });
  assert.ok("runId" in r, JSON.stringify(r));
  assert.deepEqual(posted[0].payload, { kind: "assess", ids: ["a", "b"], scope: { kind: "slot", key: `at:${AT + MIN}` } });
});

test("a row posted since the phone looked never joins the run, and a shifted cut is refused", () => {
  // The phone saw a@T and b@T+4m together. An agent then posted new@T-2m:
  // greedy from the earliest row, the host's slot is now [new, a] and b fires alone.
  const rows = [timed("a", AT), timed("b", AT + 4 * MIN), timed("new", AT - 2 * MIN)];
  const { ints, posted } = postsInto(rows);
  const r = startAssessment(ints, { running: () => null }, CWD, ["a", "b"], { kind: "slot", key: KEY });
  assert.equal(r.error, "the slot changed since you looked — it now holds 2; open the check again. Nothing was run");
  assert.equal(posted.length, 0, "no run, so no model call");
  // A slot that GREW around the rows sent runs over the rows sent and nothing else.
  const grown = postsInto([timed("a", AT), timed("b", AT + MIN), timed("new", AT + 2 * MIN)]);
  const ok = startAssessment(grown.ints, { running: () => null }, CWD, ["b", "a"], { kind: "slot", key: KEY });
  assert.ok("runId" in ok, JSON.stringify(ok));
  assert.deepEqual(grown.posted[0].payload.ids, ["b", "a"]);
  // One id left, or one that stopped waiting, is the same refusal.
  const one = postsInto([timed("a", AT), timed("b", AT)]);
  assert.match(startAssessment(one.ints, { running: () => null }, CWD, ["a"], { kind: "slot", key: KEY }).error, /slot changed since you looked/);
  const ran = postsInto([timed("a", AT), timed("b", AT), timed("c", AT, { state: "running" })]);
  assert.match(startAssessment(ran.ints, { running: () => null }, CWD, ["a", "b", "c"], { kind: "slot", key: KEY }).error, /it now holds 2/);
  assert.equal(one.posted.length + ran.posted.length, 0);
});

test("a key that names no slot any more, or a slot of one, is refused in words with no run", () => {
  const posted = [];
  const mk = (rows) => { const i = fakeIntents(rows); i.post = (d) => { posted.push(d); return { ok: true, intent: d }; }; return i; };
  const gone = startAssessment(mk([timed("a", AT + 60 * MIN)]), { running: () => null }, CWD, [], { kind: "slot", key: KEY });
  assert.match(gone.error, /no longer fire together/);
  const lone = startAssessment(mk([timed("a", AT), timed("b", AT, { state: "running" })]), { running: () => null }, CWD, [], { kind: "slot", key: KEY });
  assert.match(lone.error, /only one row/);
  const junk = startAssessment(mk([timed("a", AT), timed("b", AT)]), { running: () => null }, CWD, [], { kind: "slot", key: "" });
  assert.match(junk.error, /names no slot/);
  assert.equal(posted.length, 0, "nothing was posted, so nothing was bought");
});

test("the slot prompt says when they fire and asks for order, splits and conflicts; a repo-wide one does not", () => {
  const rows = [timed("a", AT), timed("b", AT)];
  const slot = assessPrompt(buildAssessInput(CWD, rows, [], AT, ["a", "b"], { kind: "slot", key: KEY }));
  assert.match(slot, /SLOT CHECK: every open item above fires TOGETHER, at 2026-10-16 18:00 UTC/);
  assert.match(slot, /WITHIN this slot/);
  assert.match(slot, /"conflicts":\[\{"cid"/);
  assert.match(slot, /"splits":\[\{"sid"/);
  const wide = assessPrompt(buildAssessInput(CWD, rows, [], AT));
  assert.doesNotMatch(wide, /SLOT CHECK|"conflicts"|"splits"/);
  assert.match(wide, /"new":\[.*\]\}$/m, "the repo-wide JSON shape still closes on the new line");
});

// ── 2. Splits ────────────────────────────────────────────────────────────────

const splitProposal = { ...empty, splits: [{ sid: "s1", id: "a", texts: ["do the first half", "do the second half"], rationale: "two jobs" }] };

test("a split posts both halves on the original's clock, then ARCHIVES the original", () => {
  const rows = [timed("a", AT, { holdForHost: true }), timed("b", AT)];
  const ints = fakeIntents(rows);
  const out = applyProposal(ints, storeWith("as_1", rows, splitProposal), "as_1", { splits: ["s1"] });
  const [p1, p2] = splitIds("as_1", "s1");
  assert.ok(out.ok);
  assert.deepEqual(ints.calls.filter((c) => !c.startsWith("order") && c !== "kick"), [`post:${p1}`, `post:${p2}`, "archive:a"]);
  for (const id of [p1, p2]) {
    const r = ints.rows.get(id);
    assert.deepEqual(r.trigger, rows[0].trigger, "the same clock, grace included");
    assert.equal(r.holdForHost, true);
    assert.equal(r.origin, "assess:as_1");
  }
  assert.deepEqual(ints.rows.get(p1).payload.steps, ["do the first half"]);
  assert.ok(!ints.calls.some((c) => c.startsWith("cancel") || c.startsWith("dismiss")), "never cancelled");
  assert.match(out.detail, /1 split in two/);
});

test("a failed post leaves the original untouched and says so", () => {
  const rows = [timed("a", AT), timed("b", AT)];
  const [, p2] = splitIds("as_2", "s1");
  const ints = fakeIntents(rows, { refusePost: (d) => d.id === p2 });
  const out = applyProposal(ints, storeWith("as_2", rows, splitProposal), "as_2", { splits: ["s1"] });
  assert.ok(!ints.rows.get("a").archived, "the original is not archived");
  assert.ok(ints.calls.includes(`archive:${splitIds("as_2", "s1")[0]}`), "the half that landed is set aside, not left running alone");
  assert.match(out.detail, /split “s1” was not applied: too many are already waiting — the original item was left as it was/);
});

test("a replay that finds half 1 and is refused half 2 sets half 1 aside — the job never runs twice", () => {
  const rows = [timed("a", AT), timed("b", AT)];
  const [p1, p2] = splitIds("as_2b", "s1");
  // An earlier, interrupted apply left half 1 on disk.
  const ints = fakeIntents([...rows, { ...timed(p1, AT), id: p1 }], { refusePost: (d) => d.id === p2 });
  const out = applyProposal(ints, storeWith("as_2b", rows, splitProposal), "as_2b", { splits: ["s1"] });
  assert.equal(ints.rows.get(p1).archived, true, "the stray half is set aside");
  assert.ok(!ints.rows.get("a").archived, "the original is the one copy left");
  assert.match(out.detail, /split “s1” was not applied: too many are already waiting/);
});

test("an original whose archive is refused sets both halves aside and says so", () => {
  const rows = [timed("a", AT), timed("b", AT)];
  const [p1, p2] = splitIds("as_2c", "s1");
  const ints = fakeIntents(rows);
  const edit = ints.edit;
  ints.edit = (id, patch) => (id === "a" && patch.archived ? { ok: false, refused: "it is running" } : edit(id, patch));
  const out = applyProposal(ints, storeWith("as_2c", rows, splitProposal), "as_2c", { splits: ["s1"] });
  assert.equal(ints.rows.get(p1).archived, true);
  assert.equal(ints.rows.get(p2).archived, true);
  assert.ok(!ints.rows.get("a").archived);
  assert.doesNotMatch(out.detail, /split in two/);
  assert.match(out.detail, /the original could not be set aside \(it is running\), so both halves were set aside instead/);
});

test("a split of a row another row chains after is refused in words, nothing posted", () => {
  const rows = [timed("a", AT), timed("b", AT),
    { ...timed("c", AT), label: "deploy after a", trigger: { kind: "after", id: "a" }, nextAt: undefined }];
  const ints = fakeIntents(rows);
  const out = applyProposal(ints, storeWith("as_2d", rows.slice(0, 2), splitProposal), "as_2d", { splits: ["s1"] });
  assert.ok(!ints.calls.some((c) => c.startsWith("post") || c.startsWith("archive")), ints.calls.join());
  assert.match(out.detail, /split “s1” was not applied: it is waited on by “deploy after a”.* — split refused — the original item was left as it was/);
});

test("a replayed split posts nothing twice", () => {
  const rows = [timed("a", AT), timed("b", AT)];
  const ints = fakeIntents(rows);
  const store = storeWith("as_3", rows, splitProposal);
  applyProposal(ints, store, "as_3", { splits: ["s1"] });
  // A crash before `recordApplied`: the run is still `done` on disk.
  store.get("as_3").status = "done";
  const before = ints.calls.filter((c) => c.startsWith("post:")).length;
  const again = applyProposal(ints, store, "as_3", { splits: ["s1"] });
  assert.ok(again.ok);
  assert.equal(ints.calls.filter((c) => c.startsWith("post:")).length, before, "no new post");
  assert.equal(ints.calls.filter((c) => c.startsWith("post-existing:")).length, 2);
});

// ── 3. Conflicts, merges, order ──────────────────────────────────────────────

test("a conflict mutates nothing, whatever the choices say", () => {
  const rows = [timed("a", AT), timed("b", AT)];
  const ints = fakeIntents(rows);
  const p = { ...empty, conflicts: [{ cid: "c1", ids: ["a", "b"], why: "a adds the flag b removes" }] };
  const out = applyProposal(ints, storeWith("as_4", rows, p), "as_4", { conflicts: ["c1"], splits: ["c1"], rows: ["a", "b"] });
  assert.ok(out.ok);
  assert.deepEqual(ints.calls, ["kick"]);
});

const merge = (ids) => ({ ...empty, merges: [{ gid: "g1", ids, prompt: "do both", rationale: "one job", rank: 1 }] });

test("a merge across clocks carries the LATEST member's clock", () => {
  const rows = [timed("a", AT - 30 * MIN), timed("b", AT, { holdForHost: true })];
  const ints = fakeIntents(rows);
  applyProposal(ints, storeWith("as_5", rows, merge(["a", "b"])), "as_5", { merges: ["g1"] });
  const posted = [...ints.rows.values()].find((r) => r.id.startsWith("ai_"));
  assert.deepEqual(posted.trigger, rows[1].trigger);
  assert.equal(posted.holdForHost, true);
  assert.ok(ints.calls.includes("cancel:a") && ints.calls.includes("cancel:b"), "members retire as every merge's do");
});

test("a merge whose latest clock is a near-tie across anchors is refused in words, members untouched", () => {
  // A reset-relative row moves with the scraped reset, a one-off does not: a minute apart, which is later is unknown.
  const rows = [timed("a", AT), timed("b", AT + MIN)];
  rows[0].trigger = { kind: "at", rule: { kind: "window", window: "weekly", edge: "after", offsetMin: 0, oneShot: true }, graceMin: 30 };
  const ints = fakeIntents(rows);
  const out = applyProposal(ints, storeWith("as_6", rows, merge(["a", "b"])), "as_6", { merges: ["g1"] });
  assert.ok(!ints.calls.some((c) => c.startsWith("post") || c.startsWith("cancel")));
  assert.match(out.detail, /merge “g1” was not applied: its rows run on clocks too close to tell which is later/);
});

test("a merge of untimed rows is posted untimed, as it always was", () => {
  const rows = [timed("a", AT), timed("b", AT)].map((r) => ({ ...r, trigger: { kind: "idle" }, nextAt: undefined }));
  const ints = fakeIntents(rows);
  applyProposal(ints, storeWith("as_7", rows, merge(["a", "b"]), undefined), "as_7", { merges: ["g1"] });
  const posted = [...ints.rows.values()].find((r) => r.id.startsWith("ai_"));
  assert.deepEqual(posted.trigger, { kind: "idle" });
});

test("a slot's approved order goes through reorder: the rows trade their own seats, marked as the person's", () => {
  const rows = [timed("a", AT, { order: 10 }), timed("b", AT, { order: 20 }), timed("c", AT, { order: 30 })];
  const ints = fakeIntents(rows);
  const p = { ...empty, rows: ["a", "b", "c"].map((id, n) => ({ id, verdict: "wanted", evidence: "", rank: 3 - n })) };
  const out = applyProposal(ints, storeWith("as_8", rows, p), "as_8", { rows: ["a", "b", "c"] });
  assert.equal(out.counts.ranked, 3);
  assert.equal(ints.rows.get("c").order, 10);
  assert.equal(ints.rows.get("b").order, 20);
  assert.equal(ints.rows.get("a").order, 30);
  for (const id of ["a", "b", "c"]) assert.equal(ints.rows.get(id).handOrdered, true);
});

test("a slot merge takes its members' lowest seat: a row outside the slot keeps its place", () => {
  // x sits AHEAD of the slot in the backlog and is not in it: it must stay ahead.
  const rows = [timed("a", AT, { order: 100 }), timed("b", AT, { order: 300 }), timed("c", AT, { order: 400 }),
    { ...timed("x", AT + 9 * 60 * MIN), order: 50 }];
  const ints = fakeIntents(rows);
  const p = { ...merge(["a", "b"]), rows: [{ id: "c", verdict: "wanted", evidence: "", rank: 2 }] };
  applyProposal(ints, storeWith("as_9", rows.slice(0, 3), p), "as_9", { merges: ["g1"], rows: ["c"] });
  const m = [...ints.rows.values()].find((r) => r.id.startsWith("ai_"));
  const live = [...ints.rows.values()].filter((r) => !["a", "b"].includes(r.id)).sort((u, v) => u.order - v.order).map((r) => r.id);
  assert.deepEqual(live, ["x", m.id, "c"], "the merge ranked first takes the slot's first seat — never the backlog's");
  assert.ok(m.order >= 100, `merge seat ${m.order}`);
});
