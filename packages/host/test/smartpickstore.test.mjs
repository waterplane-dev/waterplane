/**
 * The smart pick as the host runs it: the guard ladder, the apply, the undo and
 * the record on disk.
 *
 * `packages/shared/test/smartpick.test.mjs` pins what a proposal may CONCLUDE.
 * This file pins what the host may DO about one, and almost every case below is
 * a way the feature could quietly cost somebody something:
 *
 *  • **An un-ticked repo must cost exactly zero.** Not "nearly nothing" — no git
 *    spawn, no fingerprint, no file read, no completion. It is the first rung
 *    and it is asserted by counting fakes that were never called, because a
 *    cost that only shows up on somebody's bill is a cost no test would catch.
 *  • **Every failure fires the order the repo already had.** Timeout, failure,
 *    an account block, an unreadable answer, an answer that arrives after the
 *    watchdog let the row go: each records itself against the fingerprint the
 *    pass started on, so the next tick reads "nothing changed" and the item
 *    fires exactly as it would have with the feature off. A pass that could hold
 *    a fire for ever is the one bug this design cannot tolerate.
 *  • **Nothing is ever destroyed.** A merge ARCHIVES its originals. The fakes
 *    below have no `cancel`, no `markDone` and no `dismiss` at all — the slice
 *    the feature is handed is the assertion — and `remove` is asserted to be
 *    called for exactly one row ever: the merged row, on an undo, whose words
 *    are machine-written and kept in the record anyway.
 *  • **The pass never types.** There is no executor here to call, which is the
 *    point: `pickhold.test.mjs` pins that at the manager, and the shape of
 *    `SmartPickIntents` pins it here.
 *
 * A fake store and an injected clock, the way `intentsched.test.mjs` does it —
 * no git, no daemon, no `claude`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The watchdog is read once at module load, so it is set before the import. 300
// ms is long enough that a fake resolving in a microtask is never racing it, and
// short enough that the one test which WANTS the watchdog does not sleep.
process.env.WATERPLANE_SMARTPICK_TIMEOUT_MS = "300";

const { SmartPick, SmartPickStore, mergedRowId } = await import("../dist/smartpick.js");
const { backlogDraft } = await import("../dist/intents/adapters.js");

const REPO = "/tmp/waterplane-sp-repo";
const FACTS = { branch: "main", dirty: ["M src/a.ts"], commits: ["one", "two"] };

/**
 * The intent store, faked down to the seven verbs the feature is allowed.
 *
 * Deliberately no `cancel`, `markDone` or `dismiss`: if the implementation ever
 * reached for one it would fail here with "is not a function", which is the
 * loudest possible way to be told that a merge had started retiring rows instead
 * of setting them aside.
 */
function fakeIntents() {
  const rows = new Map();
  const log = [];
  const api = {
    rows,
    log,
    get: (id) => rows.get(id),
    list: () => [...rows.values()],
    post: (d) => {
      if (rows.has(d.id)) return { ok: true, intent: rows.get(d.id), existing: true };
      const row = { ...d, state: "queued", createdAt: d.order ?? 0 };
      rows.set(d.id, row);
      log.push(`post:${d.id}`);
      return { ok: true, intent: row };
    },
    edit: (id, p) => {
      const r = rows.get(id);
      if (!r) return { ok: false };
      if (typeof p.order === "number") r.order = p.order;
      if (typeof p.archived === "boolean") r.archived = p.archived || undefined;
      if (typeof p.handOrdered === "boolean") r.handOrdered = p.handOrdered ? true : undefined;
      if (typeof p.label === "string") r.label = p.label || undefined;
      log.push(`edit:${id}:${JSON.stringify(p)}`);
      return { ok: true };
    },
    update: (id, patch) => {
      const r = rows.get(id);
      if (!r) return { ok: false, reason: "that intent is gone" };
      if (r.state === "running") return { ok: false, reason: "it is already running" };
      Object.assign(r, patch);
      log.push(`update:${id}`);
      return { ok: true };
    },
    remove: (id) => { log.push(`remove:${id}`); return rows.delete(id); },
    kick: () => { log.push("kick"); },
  };
  return api;
}

/** An ordinary automatic work item, as `backlogDraft` writes one. */
function item(intents, id, { text = `do ${id}`, order = 0, label, ...over } = {}) {
  const d = backlogDraft({ id, cwd: REPO, text, label, order });
  intents.post({ ...d, ...over });
  const row = intents.get(id);
  row.createdAt = order;
  Object.assign(row, over);
  return row;
}

/** A SmartPick over a temp root, with every outside fact faked and counted. */
function makePick({ on: onInit = true, answer = '{"pick":"a","order":["a","b"],"why":"ok"}', usage, usd, run, facts = FACTS } = {}) {
  const root = mkdtempSync(join(tmpdir(), "waterplane-sp-"));
  const intents = fakeIntents();
  const state = { gitCalls: 0, runCalls: 0, now: 1_000_000, applied: [], changed: 0, prompts: [], on: onInit };
  const pick = new SmartPick({
    root,
    intents,
    isOn: () => state.on,
    now: () => state.now,
    facts: async () => { state.gitCalls++; return facts; },
    run: async (req) => {
      state.runCalls++;
      state.prompts.push(req.prompt);
      if (run) return run(req, state);
      // Resolved on a MACROTASK, not a microtask. The second row of a repo
      // reaches `hold()` in the same tick as the first, and a pass that settled
      // in between would make the in-flight rung untestable — which is the one
      // rung that stops a repo paying twice for one look.
      await new Promise((r) => setTimeout(r, 0));
      return { text: answer, failed: false, limited: false, usage, usd, durationMs: 12 };
    },
    onApplied: (e) => state.applied.push(e),
    onChange: () => { state.changed++; },
  });
  return { pick, intents, state, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** The fake `run` resolves on a `setTimeout(0)` and `whileApplying` releases on another, so the
 *  pass is a CHAIN of timer hops. A fixed wall-clock wait races that chain: under load (a parallel
 *  suite, a cold public-tree copy) one hop can stall past it. Timers fire in order, so rounds of
 *  `setTimeout(0)`, each scheduled after the last fired, always run after every hop the chain
 *  had already queued — the wait counts hops, not milliseconds. `ms` is kept for the callers that
 *  mean "this much real time" (a watchdog test) and is spent after the hops. */
const settle = async (ms = 0) => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
  if (ms > 20) await new Promise((r) => setTimeout(r, ms));
};

// ── 1. what an un-ticked repo costs ─────────────────────────────────────────

test("an un-ticked repo costs EXACTLY zero — no git, no fingerprint, no pass", async () => {
  const { pick, intents, state, done } = makePick({ on: false });
  item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });

  assert.equal(await pick.hold(intents.get("a")), null);
  await settle();
  assert.equal(state.gitCalls, 0, "rung 1 returns before any repo fact is read");
  assert.equal(state.runCalls, 0, "…and before anything is bought");
  assert.deepEqual(pick.summaries(), {}, "and it leaves no record of having thought about it");
  done();
});

test("a row a PERSON aimed is never held — the pass does not reconsider a tap", async () => {
  const { pick, intents, state, done } = makePick();
  item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });
  // Queued for one named session (`queue here`), and the same row pinned.
  const aimed = item(intents, "c", { order: 3, target: { kind: "session", sessionId: "s1" }, pinned: true });

  assert.equal(await pick.hold(aimed), null);
  await settle();
  assert.equal(state.runCalls, 0);
  done();
});

test("fewer than two waiting items is nothing to decide, and nothing to spend", async () => {
  const { pick, intents, state, done } = makePick();
  const only = item(intents, "a", { order: 1 });
  assert.equal(await pick.hold(only), null);
  await settle();
  assert.equal(state.gitCalls, 0);
  assert.equal(state.runCalls, 0);
  done();
});

// ── 2. one look per repo ────────────────────────────────────────────────────

test("the second row of the same repo joins the look — one pass, no second git", async () => {
  // `serial` bites only once something is CLAIMED and a held row claims nothing,
  // so both rows reach the hook in the same tick. The dep is what de-dupes.
  const { pick, intents, state, done } = makePick();
  const a = item(intents, "a", { order: 1 });
  const b = item(intents, "b", { order: 2 });

  const first = await pick.hold(a);
  const second = await pick.hold(b);
  assert.match(first, /looking over this repo's waiting items/);
  assert.equal(second, first, "the same sentence, out of the in-flight entry");
  assert.equal(state.gitCalls, 1, "rung 4 answers before any repo fact is read a second time");
  assert.equal(state.runCalls, 1, "one look, not two");
  await settle();
  done();
});

test("once the pass has applied, an unchanged backlog buys nothing at all", async () => {
  const { pick, intents, state, done } = makePick({ answer: '{"pick":"b","order":["b","a"],"why":"b first"}' });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });

  await pick.hold(a);
  await settle();
  assert.equal(state.runCalls, 1);
  assert.equal(pick.summary(REPO).outcome, "applied");

  // The clock moves past the churn floor, so only the fingerprint can be what
  // stops a second pass — which is exactly the claim.
  state.now += 60_000;
  assert.equal(await pick.hold(intents.get("b")), null, "nothing changed ⇒ it fires");
  await settle();
  assert.equal(state.runCalls, 1, "and no second completion was bought");
  done();
});

test("a pass records the state it LEFT BEHIND, not the one it found", async () => {
  // Without this every applied pass looks changed again on the confirming tick
  // and the repo buys a completion per tick, for ever.
  const { pick, intents, state, done } = makePick({ answer: '{"pick":"b","order":["b","a"],"why":"b first"}' });
  const a = item(intents, "a", { order: 1 });
  await pick.hold(a);       // 1 candidate — no pass
  item(intents, "b", { order: 2 });
  await pick.hold(a);
  await settle();
  assert.equal(intents.get("b").order, 1, "b took the earlier slot");
  assert.equal(intents.get("a").order, 2);
  state.now += 60_000;
  assert.equal(await pick.hold(intents.get("b")), null);
  assert.equal(state.runCalls, 1);
  done();
});

test("the churn floor skips with a SENTENCE rather than quietly", async () => {
  const { pick, intents, state, done } = makePick({ answer: '{"pick":"a","order":["a","b"],"why":"x"}' });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });
  await pick.hold(a);
  await settle();

  // Something really did change — but it changed 3 s after the last look.
  intents.get("b").payload = { kind: "prompt", steps: ["do b, differently"] };
  state.now += 3_000;
  assert.equal(await pick.hold(a), null, "it fires rather than waiting");
  const s = pick.summary(REPO);
  assert.equal(s.outcome, "skipped");
  assert.equal(s.sinceMs, 3_000, "the gap is reported, because a guard that should never fire must be visible when it does");
  assert.equal(state.runCalls, 1, "and nothing was bought");
  done();
});

// ── 3. every failure fires the order you had ────────────────────────────────

test("a watchdog expiry releases the row, records against the SAME fingerprint, and the item fires", async () => {
  const { pick, intents, state, done } = makePick({ run: () => new Promise(() => {}) });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });

  assert.ok(await pick.hold(a), "held while it looks");
  await settle(420);
  const s = pick.summary(REPO);
  assert.equal(s.outcome, "timeout");
  assert.equal(s.durationMs, 300);
  // The point of recording against the fingerprint the pass STARTED on: the
  // very next tick reads "nothing has changed" and the row fires as it was.
  assert.equal(await pick.hold(a), null, "the next tick fires it");
  // …and it is RUNG 5 answering, not the churn floor. Both answer `null`, so
  // without this the pin would pass just as happily if the timeout had recorded
  // a different fingerprint and the floor were quietly covering for it.
  assert.equal(pick.summary(REPO).outcome, "timeout", "no second record was written to get that answer");
  assert.equal(intents.get("a").order, 1, "and nothing about the order moved");
  assert.equal(intents.get("b").order, 2);
  done();
});

test("an answer that arrives after the watchdog is `late` and applies NOTHING", async () => {
  let release;
  const { pick, intents, state, done } = makePick({
    run: () => new Promise((r) => { release = () => r({ text: '{"pick":"b","order":["b","a"]}', failed: false, limited: false, durationMs: 900 }); }),
  });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });

  await pick.hold(a);
  await settle(420);
  assert.equal(pick.summary(REPO).outcome, "timeout");
  release();
  await settle();
  assert.equal(pick.summary(REPO).outcome, "late");
  assert.equal(intents.get("a").order, 1, "a reorder after the item has started is the one thing this may not do");
  assert.equal(intents.get("b").order, 2);
  done();
});

test("an unreadable answer is `failed` in the shared module's own words, and moves nothing", async () => {
  const { pick, intents, done } = makePick({ answer: "sorry, I can't help with that" });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });
  await pick.hold(a);
  await settle();
  const s = pick.summary(REPO);
  assert.equal(s.outcome, "failed");
  assert.equal(s.detail, "the model answered nothing readable");
  assert.equal(intents.get("a").order, 1);
  done();
});

test("an account block is `limited` and keeps its own sentence", async () => {
  const { pick, intents, done } = makePick({
    run: async () => ({ text: "", failed: false, limited: true, detail: "quota, back at five", durationMs: 30 }),
  });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });
  await pick.hold(a);
  await settle();
  assert.equal(pick.summary(REPO).outcome, "limited");
  assert.equal(pick.summary(REPO).detail, "quota, back at five");
  done();
});

test("tokens and dollars are ABSENT when the envelope carried none", async () => {
  const bare = makePick({ answer: '{"pick":"a","order":["a","b"]}' });
  item(bare.intents, "a", { order: 1 });
  item(bare.intents, "b", { order: 2 });
  await bare.pick.hold(bare.intents.get("a"));
  await settle();
  const s = bare.pick.summary(REPO);
  assert.equal("tokens" in s, false, "a 0 here is a wrong number wearing a true number's clothes");
  assert.equal("usd" in s, false);
  bare.done();

  const paid = makePick({
    answer: '{"pick":"a","order":["a","b"]}',
    usage: { inTok: 4, outTok: 12, cacheRead: 2170, cacheWrite: 331 },
    usd: 0.0049,
  });
  item(paid.intents, "a", { order: 1 });
  item(paid.intents, "b", { order: 2 });
  await paid.pick.hold(paid.intents.get("a"));
  await settle();
  assert.deepEqual(paid.pick.summary(REPO).tokens, { inTok: 4, outTok: 12, cacheRead: 2170, cacheWrite: 331 });
  assert.equal(paid.pick.summary(REPO).usd, 0.0049);
  paid.done();
});

// ── 4. the merge, non-destructively ─────────────────────────────────────────

const MERGE_ANSWER = JSON.stringify({
  pick: "a",
  order: ["a", "b", "c"],
  merges: [{ ids: ["a", "b"], text: "do a and b together", why: "one job" }],
  why: "a and b are the same change",
});

test("a merge posts ONE row, archives the originals, and destroys nothing", async () => {
  const { pick, intents, state, done } = makePick({ answer: MERGE_ANSWER });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });
  item(intents, "c", { order: 3 });

  await pick.hold(a);
  await settle();

  const merged = [...intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:"));
  assert.ok(merged, "the merged row exists");
  assert.match(merged.id, /^mg[0-9a-f]{6}$/, "an 8-character id, minted from the pass id and the members");
  assert.equal(merged.payload.steps[0], "do a and b together");
  assert.equal(merged.order, 1, "it takes the earliest member's slot, and is posted there once");

  for (const id of ["a", "b"]) {
    const row = intents.get(id);
    assert.ok(row, `${id} is still in the store`);
    assert.equal(row.archived, true, `${id} is set ASIDE`);
    assert.equal(row.payload.steps[0], `do ${id}`, "with its own words untouched");
  }
  assert.equal(intents.log.filter((l) => l.startsWith("remove:")).length, 0, "nothing was removed");

  const s = pick.summary(REPO);
  assert.equal(s.outcome, "applied");
  assert.equal(s.merged, 2);
  assert.equal(s.mergedInto, 1, "both numbers, because “merged 2 → 1” is derivable from neither alone");
  assert.equal(state.applied.length, 1, "and exactly one notification, because it merged");
  done();
});

test("the row says what it is, both ways", async () => {
  const { pick, intents, done } = makePick({ answer: MERGE_ANSWER });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });
  item(intents, "c", { order: 3 });
  await pick.hold(a);
  await settle();

  const merged = [...intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:"));
  assert.deepEqual(pick.rowFacts(merged.id), { mergedFrom: ["a", "b"] });
  assert.deepEqual(pick.rowFacts("a"), { mergedInto: merged.id });
  assert.deepEqual(pick.rowFacts("c"), undefined, "a row nothing happened to says nothing");
  done();
});

test("a hand-placed member makes the merged row hand-placed too", async () => {
  const { pick, intents, done } = makePick({ answer: MERGE_ANSWER });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2, handOrdered: true });
  item(intents, "c", { order: 3 });
  await pick.hold(a);
  await settle();
  const merged = [...intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:"));
  assert.equal(merged.handOrdered, true, "a merge must never free a hand-placed job to be sorted again");
  done();
});

test("a row chained behind a merged-away item is re-pointed at the row that will finish", async () => {
  const { pick, intents, done } = makePick({ answer: MERGE_ANSWER });
  const a = item(intents, "a", { order: 1 });
  item(intents, "b", { order: 2 });
  item(intents, "c", { order: 3 });
  // A chained row is NOT a candidate (it has its own clock) and is exactly the
  // row that would wait for ever: an archived predecessor is live and
  // non-terminal, so it never settles.
  item(intents, "z", { order: 9, trigger: { kind: "after", id: "b", title: "do b" } });

  await pick.hold(a);
  await settle();
  const merged = [...intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:"));
  assert.equal(intents.get("z").trigger.id, merged.id);
  assert.equal(intents.get("z").trigger.title, "do a and b together", "and the snapshot names something real");
  done();
});

// ── 5. undo ─────────────────────────────────────────────────────────────────

async function merged(opts = {}) {
  const h = makePick({ answer: MERGE_ANSWER, ...opts });
  item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  item(h.intents, "c", { order: 3 });
  await h.pick.hold(h.intents.get("a"));
  // Polled, not slept: the pass persists its store through jsonstore (fsync), whose
  // cost is the disk's, and a fixed 20 ms guess at it is a flake waiting for a slow disk.
  const mergedRow = () => [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:"));
  for (let i = 0; i < 100 && !mergedRow(); i++) await settle(20);
  // …and until the pass has finished announcing itself, or the next hold() meets it in flight.
  for (let seen = -1; seen !== h.state.changed;) { seen = h.state.changed; await settle(40); }
  h.mergedId = mergedRow().id;
  return h;
}

test("undo puts every original back exactly as it was, and takes the merged row away", async () => {
  const h = await merged();
  const res = h.pick.undo(h.mergedId);
  assert.equal(res.ok, true);
  assert.equal(res.ran, false, "nothing had run, so this is the plain inverse");
  assert.match(res.detail, /put back/);
  assert.equal(h.intents.get(h.mergedId), undefined, "the machine-written row is gone — and its text is in the record");
  assert.equal(h.intents.get("a").archived, undefined);
  assert.equal(h.intents.get("a").order, 1, "its previous slot, not a renumbering");
  assert.equal(h.intents.get("b").order, 2);
  assert.deepEqual(h.pick.rowFacts("a"), undefined, "an undone merge is not a fact about any row any more");
  h.done();
});

test("undo restores the state each member HAD, which is not always un-archived", async () => {
  const h = makePick({ answer: MERGE_ANSWER });
  item(h.intents, "a", { order: 1 });
  const b = item(h.intents, "b", { order: 2 });
  item(h.intents, "c", { order: 3 });
  await h.pick.hold(h.intents.get("a"));
  await settle();
  // …and now pretend b had been set aside by hand before the merge folded it.
  const id = [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:")).id;
  const rec = JSON.parse(readFileSync(join(h.root, ".waterplane", "smartpick.json"), "utf8"));
  assert.equal(rec.merges[id].prevArchived.b, false, "the record keeps each member's previous state");
  assert.equal(rec.merges[id].state, "applied");
  h.pick.undo(id);
  assert.equal(b.archived, undefined);
  h.done();
});

test("a second undo is a no-op, not a second restoration", async () => {
  const h = await merged();
  h.pick.undo(h.mergedId);
  const before = JSON.stringify([...h.intents.rows.values()]);
  const again = h.pick.undo(h.mergedId);
  assert.equal(again.ok, true);
  assert.match(again.detail, /already put back/);
  assert.equal(JSON.stringify([...h.intents.rows.values()]), before);
  h.done();
});

test("`put them back` WORKS after the merged row has run — and says the originals will run", () => {
  // REVIEW1-ux finding 1. The old shape refused this in words ("it has already
  // run — the 2 it was made from are under archived; bring one back by hand"),
  // and that was the sentence a person who had been ASLEEP almost always met:
  // the pass applies and picks in the same breath, so the pre-run window was one
  // tick wide. The merged row is ARCHIVED rather than removed — a row that ran
  // is the only account of the session that ran it — and the answer says, in
  // words, that the originals are going to run again, because whether the work
  // is about to be done twice is the one thing nobody may be left to guess. It
  // says "will run", never "will run AGAIN": the originals never ran — what ran
  // was the merged text, once — so "again" would tell a person their work has
  // already been done when it has not.
  const h = makePick({ answer: MERGE_ANSWER });
  return (async () => {
    item(h.intents, "a", { order: 1 });
    item(h.intents, "b", { order: 2 });
    item(h.intents, "c", { order: 3 });
    await h.pick.hold(h.intents.get("a"));
    await settle();
    const id = [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:")).id;
    h.intents.get(id).state = "done";

    const res = h.pick.undo(id);
    assert.equal(res.ok, true);
    assert.equal(res.ran, true);
    assert.match(res.detail, /already ran/);
    assert.match(res.detail, /will run as they were/, "the duplicate is STATED, never discovered");
    assert.doesNotMatch(res.detail, /run again/, "and never “again” — the originals have not run");
    assert.ok(h.intents.get(id), "the row that ran is kept — it is the only account of the session that ran it");
    assert.equal(h.intents.get(id).archived, true, "…filed under archived, not deleted");
    assert.equal(h.intents.get("a").archived, undefined, "and both originals are back in the list");
    assert.equal(h.intents.get("a").order, 1);
    assert.equal(h.intents.get("b").order, 2);
    assert.deepEqual(h.pick.rowFacts("a"), undefined);
    h.done();
  })();
});

test("…and a merged row that is STILL RUNNING is not stopped, which the answer says too", () => {
  const h = makePick({ answer: MERGE_ANSWER });
  return (async () => {
    item(h.intents, "a", { order: 1 });
    item(h.intents, "b", { order: 2 });
    item(h.intents, "c", { order: 3 });
    await h.pick.hold(h.intents.get("a"));
    await settle();
    const id = [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:")).id;
    h.intents.get(id).state = "running";
    const res = h.pick.undo(id);
    assert.equal(res.ok, true);
    assert.match(res.detail, /still running and has not been stopped/);
    assert.equal(h.intents.get(id).archived, true);
    h.done();
  })();
});

test("a chain rewired by the merge is put back on undo", async () => {
  const h = makePick({ answer: MERGE_ANSWER });
  item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  item(h.intents, "c", { order: 3 });
  item(h.intents, "z", { order: 9, trigger: { kind: "after", id: "b", title: "do b" } });
  await h.pick.hold(h.intents.get("a"));
  await settle();
  const id = [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:")).id;
  h.pick.undo(id);
  assert.equal(h.intents.get("z").trigger.id, "b");
  assert.equal(h.intents.get("z").trigger.title, "do b", "the edge goes back exactly, title and all");
  h.done();
});

test("a merge somebody undid is not proposed again — unless one of the items is edited", async () => {
  const h = await merged();
  h.pick.undo(h.mergedId);
  // One turn of the loop, because an undo holds this repo's ladder for exactly
  // that long (`SmartPick.applying`): the store's verbs kick the tick
  // synchronously, so a pass asked for in the same breath as the undo would be
  // deciding about a backlog that is still being put back. Nothing in
  // production notices — the release kicks the tick itself — but a test that
  // calls `hold()` on the next statement does.
  await settle();

  // The next pass proposes the very same group.
  h.state.now += 60_000;
  await h.pick.hold(h.intents.get("a"));
  await settle();
  assert.equal(h.state.runCalls, 2, "a fresh pass did run — the backlog changed");
  assert.equal([...h.intents.rows.values()].some((r) => r.origin?.startsWith("smartpick:")), false, "…and it was refused");
  assert.ok(h.pick.summary(REPO).notes.some((n) => /already undid/.test(n)), "with a note, because a silent refusal is invisible");

  // Edit one of them, and it is a genuinely new proposal.
  h.intents.get("b").payload = { kind: "prompt", steps: ["do b, but properly this time"] };
  h.state.now += 60_000;
  await h.pick.hold(h.intents.get("a"));
  await settle();
  assert.equal([...h.intents.rows.values()].some((r) => r.origin?.startsWith("smartpick:")), true);
  h.done();
});

// ── 6. the record on disk ───────────────────────────────────────────────────

test("an apply interrupted mid-flight is finished on boot, and finishing it twice is finishing it once", async () => {
  const h = await merged();
  // Exactly the state a crash between the record and the archive leaves.
  const rec = h.pick.store.merge(h.mergedId);
  rec.state = "applying";
  h.pick.store.putMerge(rec);
  h.intents.rows.delete(h.mergedId);
  h.intents.get("a").archived = undefined;

  h.pick.finishApplying();
  assert.ok(h.intents.get(h.mergedId), "the merged row is back");
  assert.equal(h.intents.get("a").archived, true);
  assert.equal(h.pick.store.merge(h.mergedId).state, "applied");

  const before = JSON.stringify([...h.intents.rows.values()]);
  h.pick.finishApplying();
  assert.equal(JSON.stringify([...h.intents.rows.values()]), before, "idempotent — a replay makes no second row");
  h.done();
});

test("the record survives a reload, and is capped per repo", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-sp-store-"));
  const store = new SmartPickStore(root);
  for (let i = 0; i < 14; i++) {
    store.recordPass(REPO, { fp: `fp${i}`, summary: { passId: `p${i}`, at: i, outcome: "noop", looked: 2, notes: [], merged: 0, sorted: 0, durationMs: 1, engine: "claude-p" } });
  }
  assert.equal(store.lastPass(REPO).fp, "fp13", "newest first");

  const reloaded = new SmartPickStore(root);
  assert.equal(reloaded.lastPass(REPO).fp, "fp13", "a restart re-derives nothing");
  assert.equal(reloaded.summaries()[REPO].passId, "p13");
  const raw = JSON.parse(readFileSync(join(root, ".waterplane", "smartpick.json"), "utf8"));
  assert.equal(raw.passes[REPO].length, 10, "ten passes per repo — this is a strip, not an audit trail");
  assert.equal(raw.version, 1);
  rmSync(root, { recursive: true, force: true });
});

test("an unreadable record is no record, never a crash", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-sp-bad-"));
  const store = new SmartPickStore(root);
  store.recordPass(REPO, { fp: "x", summary: { passId: "p", at: 1, outcome: "noop", looked: 2, notes: [], merged: 0, sorted: 0, durationMs: 1, engine: "claude-p" } });
  // Half a JSON document — the exact failure tmp+rename exists to prevent, read
  // from the other side.
  const path = join(root, ".waterplane", "smartpick.json");
  const half = readFileSync(path, "utf8").slice(0, 40);
  writeFileSync(path, half);
  assert.equal(new SmartPickStore(root).lastPass(REPO), undefined);
  rmSync(root, { recursive: true, force: true });
});

test("the merged id is deterministic in the pass and the members, and in nothing else", () => {
  assert.equal(mergedRowId("p1", ["a", "b"]), mergedRowId("p1", ["b", "a"]), "order of the members is not part of the identity");
  assert.notEqual(mergedRowId("p1", ["a", "b"]), mergedRowId("p2", ["a", "b"]));
  assert.notEqual(mergedRowId("p1", ["a", "b"]), mergedRowId("p1", ["a", "c"]));
  assert.match(mergedRowId("p1", ["a", "b"]), /^mg[0-9a-f]{6}$/);
});

test("un-ticking the repo mid-pass is `late` — a pass never applies itself after being switched off", async () => {
  // Turning the tick off releases the held row, so the row starts, so the answer
  // really IS late; the same sentence is the true one. A pass that applied
  // itself after somebody switched it off would be the feature's one
  // unanswerable surprise.
  let release;
  const h = makePick({ run: () => new Promise((r) => { release = () => r({ text: MERGE_ANSWER, failed: false, limited: false, durationMs: 10 }); }) });
  item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  item(h.intents, "c", { order: 3 });
  await h.pick.hold(h.intents.get("a"));

  h.state.on = false;
  assert.equal(await h.pick.hold(h.intents.get("a")), null, "the held row is free the moment the tick goes off");
  release();
  await settle();
  assert.equal(h.pick.summary(REPO).outcome, "late");
  assert.equal([...h.intents.rows.values()].some((r) => r.origin?.startsWith("smartpick:")), false, "and nothing was merged");
  h.done();
});

// ── 7. the answer is about a list that may have moved under it ──────────────
//
// Nothing is held while a pass thinks — the row is `blocked`, so the phone is
// free, and in those ~3 s every editing verb is allowed on a `queued` row. Each
// of the four below was reproduced against the real store before it was fixed.

test("a member EDITED mid-pass is not overwritten by the merge of the old words", async () => {
  // CLAUDE.md's cardinal rule, and the sharpest of the four: the merge of the
  // OLD words used to be posted while the words somebody had just typed were
  // archived underneath it. "Never overwrite typed words with words nobody
  // typed" — a machine folding them out of sight is exactly that.
  let release;
  const h = makePick({ run: () => new Promise((r) => { release = () => r({ text: MERGE_ANSWER, failed: false, limited: false, durationMs: 10 }); }) });
  item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  item(h.intents, "c", { order: 3 });
  await h.pick.hold(h.intents.get("a"));

  h.intents.get("b").payload = { kind: "prompt", steps: ["do b — and ALSO the thing I just remembered"] };
  release();
  await settle();

  assert.equal(h.pick.summary(REPO).outcome, "late");
  assert.match(h.pick.summary(REPO).detail, /list changed while the pass was thinking/);
  assert.equal([...h.intents.rows.values()].some((r) => r.origin?.startsWith("smartpick:")), false, "no merged row was posted");
  assert.equal(h.intents.get("b").archived, undefined, "and the words are still in the list, un-archived");
  assert.match(h.intents.get("b").payload.steps[0], /just remembered/);
  h.done();
});

test("a member CANCELLED mid-pass takes the whole answer with it, and nothing is archived", async () => {
  // The other half: `apply()` found both rows (a cancelled row is still in the
  // list), the member count matched, and it posted a merged row whose words
  // would have run a second time while archiving a row that was already going.
  let release;
  const h = makePick({ run: () => new Promise((r) => { release = () => r({ text: MERGE_ANSWER, failed: false, limited: false, durationMs: 10 }); }) });
  item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  item(h.intents, "c", { order: 3 });
  await h.pick.hold(h.intents.get("a"));

  h.intents.get("b").state = "canceled";
  release();
  await settle();

  assert.equal(h.pick.summary(REPO).outcome, "late");
  assert.equal([...h.intents.rows.values()].some((r) => r.origin?.startsWith("smartpick:")), false);
  assert.equal(h.intents.get("a").archived, undefined, "the row that was about to run was not archived under a merge");
  h.done();
});

test("a `late` answer is recorded against the CURRENT list, so the next tick fires the order you have now", async () => {
  // The property every failure in this file keeps, applied to this one: the
  // record goes against the fingerprint of the list as it IS, so the very next
  // tick reads "nothing has changed" and the item goes. Recorded against the
  // list the pass was bought on, the repo would buy another pass instead.
  let release;
  const h = makePick({ run: () => new Promise((r) => { release = () => r({ text: MERGE_ANSWER, failed: false, limited: false, durationMs: 10 }); }) });
  item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  item(h.intents, "c", { order: 3 });
  await h.pick.hold(h.intents.get("a"));
  h.intents.get("c").payload = { kind: "prompt", steps: ["c, rewritten"] };
  release();
  await settle();

  assert.equal(h.pick.summary(REPO).outcome, "late", "the answer was about a list that no longer exists");
  h.state.now += 60_000; // past the churn floor, so only the fingerprint can answer
  assert.equal(await h.pick.hold(h.intents.get("a")), null, "the next tick fires it");
  assert.equal(h.state.runCalls, 1, "…and buys nothing to do it");
  h.done();
});

test("a sibling leaving the list mid-pass does NOT release the held row", async () => {
  // Rung order. "Fewer than two candidates" used to be asked before "already in
  // flight", so cancelling, removing, archiving or hand-firing the other row
  // dropped the repo to one candidate, which answered `null` — and the held row
  // started with its own pass still running. The answer then landed against a
  // backlog whose next item was RUNNING. A cwd with a pass in flight holds,
  // whatever the list has since become; the watchdog is what bounds it.
  const h = makePick({ run: () => new Promise(() => {}) });
  const a = item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  assert.ok(await h.pick.hold(a), "held while it looks");

  h.intents.get("b").state = "canceled";
  assert.ok(await h.pick.hold(a), "still held — one candidate left, but the pass is still out");
  assert.equal(h.state.runCalls, 1, "and no second pass was bought to find that out");
  h.done();
});

// ── 8. a row nobody typed does not fire in the breath that wrote it ─────────

test("the row a merge just wrote is HELD, so the pick is one a person wrote", async () => {
  // REVIEW1-ux finding 1. `applySmartPick` may name the merged row as the pick
  // and put it at the front, the apply kicks the tick, and the next tick fired
  // it — so the undo window was one tick wide and the notification's promise
  // ("undo is on the row") was false by the time a phone was picked up.
  const h = await merged();
  const held = await h.pick.hold(h.intents.get(h.mergedId));
  assert.ok(held, "the machine-written row waits");
  assert.match(held, /merged from 2 of your items/);
  // `undo`, and not "put them back": during the hold the button on the row reads
  // *undo* — *put them back* is what it becomes once the row has run. A sentence
  // naming the other one sends somebody looking for a button that is not drawn.
  assert.match(held, /“undo” is there before it runs/, "and it says why, because a wait a person cannot read is a stall");
  assert.doesNotMatch(held, /put them back/);

  // The row BEHIND it is free — the whole point is that something a person
  // wrote goes instead, not that the repo stops.
  assert.equal(await h.pick.hold(h.intents.get("c")), null);
  h.done();
});

test("…and the hold expires by the clock, so nothing is stuck behind it", async () => {
  const h = await merged();
  assert.ok(await h.pick.hold(h.intents.get(h.mergedId)));
  h.state.now += 31_000;
  assert.equal(await h.pick.hold(h.intents.get(h.mergedId)), null);
  h.done();
});

// ── 9. the two ways an apply can end badly ─────────────────────────────────

test("a merge the store REFUSES closes its own record instead of staying `applying` for ever", async () => {
  // The record is written `applying` BEFORE the post, which is what makes an
  // apply crash-safe — and left that way by a refused post it became a to-do
  // list item boot retried on every start, for ever, while `reindex()` told both
  // originals they had been merged into a row that does not exist.
  const h = makePick({ answer: MERGE_ANSWER });
  item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  item(h.intents, "c", { order: 3 });
  h.intents.post = () => ({ ok: false, reason: "this host is already holding 500 intents" });

  await h.pick.hold(h.intents.get("a"));
  await settle();

  assert.equal(h.pick.store.applying().length, 0, "nothing is left half-applied");
  assert.equal(h.pick.rowFacts("a"), undefined, "and no row claims to have been merged into a row that was never written");
  assert.equal(h.intents.get("a").archived, undefined, "the originals kept their own words, as the note says");
  h.pick.finishApplying();
  assert.equal(h.pick.store.applying().length, 0, "boot does not retry it");
  h.done();
});

test("a throw while the answer is being applied still leaves a record — or the pass is bought again every tick", async () => {
  // The `.catch` behind `start()` begins `if (!release()) return`, and a pass
  // that has already been released returns from it having written NOTHING. No
  // record means the fingerprint never moves, so the next tick reads the backlog
  // as changed and buys the same doomed pass again: measured at four completions
  // over four ticks, capped only by the churn floor, for ever.
  const h = makePick({ answer: MERGE_ANSWER });
  item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  h.pick.store.refusedFor = () => { throw new Error("boom in finish"); };

  for (let i = 0; i < 4; i++) {
    await h.pick.hold(h.intents.get("a"));
    await settle();
    h.state.now += 60_000; // past the churn floor: only a RECORD can stop this
  }
  assert.equal(h.state.runCalls, 1, "one pass, not one per tick");
  assert.equal(h.pick.summary(REPO).outcome, "failed");
  assert.equal(h.pick.summary(REPO).detail, "boom in finish");
  h.done();
});

test("the merge records are capped, so a desktop that runs for months does not grow a store", () => {
  // `passes` (10 per repo) and `refused` (50 per repo) were capped from the
  // start and this was not: one record per merge, for ever. Oldest first, and
  // never one that is still `applying` — that state is boot's to-do list.
  const h = makePick();
  for (let i = 0; i < 260; i++) {
    h.pick.store.putMerge({
      mergedId: `mg${i.toString(16).padStart(6, "0")}`, passId: `p${i}`, cwd: REPO, at: 1000 + i,
      state: i === 0 ? "applying" : "applied", ids: ["a", "b"], text: "t", why: "w", order: 0,
      title: "t", prevOrders: {}, prevArchived: {}, rewired: [],
    });
  }
  const file = JSON.parse(readFileSync(join(h.root, ".waterplane", "smartpick.json"), "utf8"));
  const kept = Object.values(file.merges);
  assert.equal(kept.length, 200);
  assert.ok(kept.some((m) => m.state === "applying"), "a half-applied merge is never the one evicted");
  assert.ok(h.pick.store.merge("mg0000ff"), "the newest are the ones that survive");
  h.done();
});

test("a throw mid-apply finishes the merge it started rather than leaving it half done", async () => {
  // `performMerge` is `putMerge(applying)` → `post(mg)` → `edit(archived)` × n →
  // `update(chain)` × n → `applied`. Every step is idempotent, which is what lets
  // `finishApplying()` complete an interrupted one at boot — but boot is a long
  // way off. A throw between the post and the last archive used to leave the
  // merged row AND all of its members waiting, with the record stuck `applying`:
  // the next tick would then see a fingerprint that no longer matched the start
  // one, take a fresh pass over `[mg, a, b]`, and be offered a merge of the
  // merged row with its own members under a different id — a second merged row,
  // and an undo that unwinds only one of them.
  //
  // So the catch does what boot would do, at the one moment the process still
  // knows a merge was in flight.
  const h = makePick({ answer: MERGE_ANSWER });
  item(h.intents, "a", { order: 1 });
  item(h.intents, "b", { order: 2 });
  item(h.intents, "c", { order: 3 });

  // Throw once, on the first archive — after `post(mg)` has already run.
  const realEdit = h.intents.edit;
  let thrown = false;
  h.intents.edit = (id, p) => {
    if (!thrown && p.archived === true) { thrown = true; throw new Error("disk went away"); }
    return realEdit(id, p);
  };

  await h.pick.hold(h.intents.get("a"));
  await settle();

  // The failure is recorded (against the fingerprint the pass STARTED on, so the
  // next tick fires the order the repo had)…
  assert.equal(h.pick.summary(REPO).outcome, "failed");
  // …and the merge is nonetheless COMPLETE, not half applied.
  const merged = [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:"));
  assert.ok(merged, "the merged row was posted");
  assert.equal(h.intents.get("a").archived, true, "and both members were set aside after all");
  assert.equal(h.intents.get("b").archived, true);
  // Nothing is left for a later pass to fold a second time.
  assert.deepEqual(h.pick.rowFacts(merged.id), { mergedFrom: ["a", "b"] });
  h.done();
});

// ── 12. the rows that carry a clock ─────────────────────────────────────────
//
// Recurrence, not trigger kind, decides which list a row lives in, so a one-off
// aimed at one repo is an ordinary backlog row and an ordinary candidate — which
// is the whole of what the user asked for ("items in the scheduler … I would
// want to run them with the new smart picker"). What the pass may DO with one is
// three refusals, and the two halves of the merge rule are here: the clock is
// carried through the record onto the row, and a clock that moved underneath the
// pass applies nothing at all.

const CLOCK = { kind: "at", rule: { kind: "once", at: 9_000_000 }, graceMin: 120 };
const OTHER_CLOCK = { kind: "at", rule: { kind: "once", at: 12_000_000 }, graceMin: 120 };

/** Two twins on one clock and one ordinary item, merged by the usual answer. */
async function timedMerge(opts = {}) {
  const h = makePick({ answer: MERGE_ANSWER, ...opts });
  item(h.intents, "a", { order: 1, trigger: CLOCK, holdForHost: true, serial: true });
  item(h.intents, "b", { order: 2, trigger: CLOCK, holdForHost: true, serial: true });
  item(h.intents, "c", { order: 3 });
  return h;
}

test("a row with a clock is a candidate — the pass sees the item somebody scheduled", async () => {
  const h = await timedMerge();
  const seen = h.pick.candidates(REPO);
  assert.deepEqual(seen.map((c) => c.id), ["a", "b", "c"], "all three, in the order they would run");
  assert.equal(seen[0].atKey, seen[1].atKey, "twins on one clock compare equal");
  assert.ok(seen[0].atKey, "…and the key is the store's own `timedWorkKey`, not a rendering");
  assert.match(seen[0].at, /once/, "the sentence goes in the prompt so the model's `why` is about something real");
  assert.equal(seen[2].atKey, undefined, "and a row with no clock says nothing about one");
  h.done();
});

test("twins on one clock become one row that CARRIES the clock, and the record says so", async () => {
  const h = await timedMerge();
  await h.pick.hold(h.intents.get("c"));
  await settle();

  const merged = [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:"));
  assert.ok(merged, "the merge went through — identical clocks are the case that may");
  assert.deepEqual(merged.trigger, CLOCK, "the merged row waits on the same instant its members did");
  assert.equal(merged.holdForHost, true, "…and on the same *wait until it's free*, which nothing else carries");
  assert.equal(h.intents.get("a").archived, true, "the originals are set aside, clocks and all");
  // The record is what a boot replay rebuilds from, so the clock has to be ON
  // it — a replay that posted an untimed row would have rescheduled somebody's
  // work to "as soon as the repo is free" and said nothing.
  const rec = h.pick.store.merge(merged.id);
  assert.deepEqual(rec.trigger, CLOCK);
  assert.equal(rec.holdForHost, true);
  assert.ok(rec.atKey, "and the equality the merge was ALLOWED on is kept with it");
  h.done();
});

test("…and a boot replay posts the same row, clock and all", async () => {
  const h = await timedMerge();
  await h.pick.hold(h.intents.get("c"));
  await settle();
  const mergedId = [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:")).id;

  // Exactly the state a crash between the record and the post leaves.
  const rec = h.pick.store.merge(mergedId);
  rec.state = "applying";
  h.pick.store.putMerge(rec);
  h.intents.rows.delete(mergedId);

  h.pick.finishApplying();
  assert.deepEqual(h.intents.get(mergedId)?.trigger, CLOCK, "the row comes back on its clock, not on `idle`");
  assert.equal(h.intents.get(mergedId)?.holdForHost, true);
  h.done();
});

test("a clock that moved while the pass was thinking applies NOTHING", async () => {
  // *drop the clock*, a re-time through the Send sheet, an edit to *every week*:
  // all of them are allowed on a queued row and all of them take about a tap,
  // which is well inside the ~3 s a pass spends thinking. The answer is then
  // about a merge that is no longer permitted — two rows on one clock became one
  // on a clock and one somewhere else — so the fingerprint carries `atKey` and
  // this is what that buys. Without it the pass applied, and the merged row
  // wore whichever clock the apply happened to read.
  let release;
  const h = await timedMerge({
    run: () => new Promise((r) => { release = () => r({ text: MERGE_ANSWER, failed: false, limited: false, durationMs: 10 }); }),
  });
  await h.pick.hold(h.intents.get("c"));

  h.intents.get("b").trigger = OTHER_CLOCK;
  release();
  await settle();

  assert.equal(h.pick.summary(REPO).outcome, "late");
  assert.match(h.pick.summary(REPO).detail, /list changed while the pass was thinking/);
  assert.equal([...h.intents.rows.values()].some((r) => r.origin?.startsWith("smartpick:")), false,
    "no merged row was posted — which of the two clocks it would carry is a guess");
  assert.equal(h.intents.get("a").archived, undefined, "and both are still waiting, on the clocks they have now");
  assert.equal(h.intents.get("b").archived, undefined);
  h.done();
});

// ── 13. the hold, which is NOT the clock ────────────────────────────────────
//
// `timedWorkKey` folds `holdForHost` into `atKey` — but only for a row that HAS
// a clock, and the rows this pass meets most are the ones *drop the clock* made:
// untimed, and still holding, because the hold is deliberately kept (the chip on
// the row says so). Two of those compare `atKey`-equal at `""`, so the clock
// rule waved the merge straight through and `MergeRecord.holdForHost` — which
// was recorded only inside the timed branch — came out absent. The row that
// replaced two held rows held nothing, and fired while another repo's item was
// mid-turn. The documented 6-tap journey walks into this on its very next tick.

/** Two rows that both wait for the desktop to be free, and neither has a clock
 *  — exactly what *drop the clocks on these 7* leaves behind. */
async function heldMerge(opts = {}) {
  const h = makePick({ answer: MERGE_ANSWER, ...opts });
  item(h.intents, "a", { order: 1, holdForHost: true, serial: true });
  item(h.intents, "b", { order: 2, holdForHost: true, serial: true });
  item(h.intents, "c", { order: 3 });
  return h;
}

test("the hold travels to the pass even when there is no clock to carry it", async () => {
  const h = await heldMerge();
  const seen = h.pick.candidates(REPO);
  assert.equal(seen[0].holdForHost, true);
  assert.equal(seen[0].atKey, undefined, "…with no clock anywhere near it — which is the whole hole");
  assert.equal(seen[2].holdForHost, undefined, "and a row that does not hold says nothing");
  h.done();
});

test("a merge of two UNTIMED rows that hold comes out still holding", async () => {
  const h = await heldMerge();
  await h.pick.hold(h.intents.get("c"));
  await settle();

  const merged = [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:"));
  assert.ok(merged, "the merge is allowed — they agree, which is all the rule asks");
  assert.equal(merged.holdForHost, true, "and the hold its members had is on the row that replaced them");
  assert.equal(merged.trigger.kind, "idle", "no clock was invented on the way");
  // The record is what a boot replay rebuilds from, so the hold has to be on it
  // — a replay that posted an unheld row would drop it a second time.
  const rec = h.pick.store.merge(merged.id);
  assert.equal(rec.holdForHost, true);
  assert.equal(rec.atKey, undefined);
  assert.equal(rec.trigger, undefined);

  h.intents.rows.delete(merged.id);
  rec.state = "applying";
  h.pick.store.putMerge(rec);
  h.pick.finishApplying();
  assert.equal(h.intents.get(merged.id)?.holdForHost, true, "and the replay posts the same held row");
  h.done();
});

test("a hold that CHANGED while the pass was thinking applies nothing", async () => {
  // The clock's own guard, one field over: nothing is held while a pass thinks,
  // so a tap on *wait until the desktop is free* in those ~3 s makes the answer
  // about a group the rule would no longer allow. Dropped whole and said out
  // loud, never repaired by taking whichever hold the apply happened to read.
  let release;
  const h = await heldMerge({
    run: () => new Promise((r) => { release = () => r({ text: MERGE_ANSWER, failed: false, limited: false, durationMs: 10 }); }),
  });
  await h.pick.hold(h.intents.get("c"));

  h.intents.get("b").holdForHost = undefined;
  release();
  await settle();

  assert.equal([...h.intents.rows.values()].some((r) => r.origin?.startsWith("smartpick:")), false,
    "no merged row — which of the two answers about when it may run is the person's is not the pass's to guess");
  assert.equal(h.intents.get("a").archived, undefined, "and both are still waiting, as they are");
  assert.equal(h.intents.get("b").archived, undefined);
  h.done();
});

// ── 14. the budget waiver: carried only when EVERY member had one ───────────
//
// `pastBudget` is a person's permission to go past the usage budget, scoped to
// the window it was granted in (`{ until }`). A merge must not let words past
// it that nobody let past, nor drop one somebody gave — so a MIXED group is
// refused whole and said out loud, like the hold; an all-waived group carries
// the EARLIEST `until`, so no member is stretched past its own window.

const LATER = Date.now() + 3_600_000;
const SOONER = Date.now() + 1_800_000;

async function waivedMerge(waivers) {
  const h = makePick({ answer: MERGE_ANSWER });
  item(h.intents, "a", { order: 1, ...(waivers.a ? { pastBudget: { until: waivers.a } } : {}) });
  item(h.intents, "b", { order: 2, ...(waivers.b ? { pastBudget: { until: waivers.b } } : {}) });
  item(h.intents, "c", { order: 3 });
  await h.pick.hold(h.intents.get("c"));
  await settle();
  const merged = [...h.intents.rows.values()].find((r) => r.origin?.startsWith("smartpick:"));
  return { h, merged };
}

test("two waived members make a waived merged row, and a replay rebuilds it identically", async () => {
  const { h, merged } = await waivedMerge({ a: LATER, b: SOONER });
  assert.ok(merged);
  assert.deepEqual(merged.pastBudget, { until: SOONER }, "the earliest window among the members");
  const rec = h.pick.store.merge(merged.id);
  assert.deepEqual(rec.pastBudget, { until: SOONER }, "on the record, which is all a boot replay reads");
  h.intents.rows.delete(merged.id);
  rec.state = "applying";
  h.pick.store.putMerge(rec);
  h.pick.finishApplying();
  assert.deepEqual(h.intents.get(merged.id)?.pastBudget, { until: SOONER }, "the replay posts the same waived row");
  h.done();
});

test("a mixed merge is refused in words — both rows stay as they are", async () => {
  const { h, merged } = await waivedMerge({ a: LATER });
  assert.equal(merged, undefined, "no merged row: which budget answer is the person's is not the pass's to decide");
  assert.equal(h.intents.get("a").archived, undefined);
  assert.equal(h.intents.get("b").archived, undefined);
  assert.ok(h.pick.summary(REPO).notes.some((n) => /let past the budget/.test(n) && /never decides a budget/.test(n)),
    h.pick.summary(REPO).notes.join(" | "));
  h.done();
});

test("an EXPIRED waiver counts as none — merged with an unwaived row, the pair merges waiting for the budget", async () => {
  // `until: 1` is long past on the pick's own (injected) clock.
  const { h, merged } = await waivedMerge({ a: 1 });
  assert.ok(merged, JSON.stringify(h.pick.summary(REPO)));
  assert.equal(merged.pastBudget, undefined);
  h.done();
});
