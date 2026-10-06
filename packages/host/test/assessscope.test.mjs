/**
 * **What an assessment is allowed to be asked about.**
 *
 * `assess.run` grew an `ids` field so the backlog's filter can scope the run —
 * the button was the one control on that screen whose number was not its own
 * tap, sitting under a bar reading *6 of 62* while meaning the 62. The field is
 * additive and `PROTOCOL_VERSION` did not move for it: absent is the whole repo, which is
 * what every run before it was and what an older client still sends.
 *
 * Three things here can go wrong silently, which is why they are pinned rather
 * than described:
 *
 *  1. **A scope must never widen.** The run is a durable intent: it is on disk
 *     before the tap returns and its executor may not run until after a
 *     restart. A scope that lived only in the message would be gone by then and
 *     the run would read a whole repo somebody asked about seven rows of —
 *     an unattended spender doing nine times the work it was told to, with
 *     nothing on the row to show why. So the scope is on the PAYLOAD and has to
 *     survive the payload's own reviver.
 *  2. **A scope that cannot be honoured is refused, not ignored.** Ids naming
 *     another repo's rows, or rows that are finished, leave nothing to judge.
 *     Widening to the repo there is the single most expensive wrong answer this
 *     feature can give, so `startAssessment` refuses with a sentence while
 *     there is still a socket to say it on.
 *  3. **The scope narrows CANDIDATES, never the evidence.** Finished rows stay
 *     in as context — they are how the CLI tells that the item next to them was
 *     already built — and `cleanAssessment` already refuses any verdict naming
 *     one. Narrowing them too would make the scoped run a worse judge of the
 *     very rows it was pointed at.
 *
 *     node --test packages/host/test/assessscope.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAssessInput, startAssessment } from "../dist/assess.js";
import { cleanIntentRow } from "@waterplane/shared";

const CWD = "/repo/myapp";
const NOW = 1_700_000_000_000;

const row = (id, state, cwd = CWD) => ({
  id, cwd, state,
  payload: { kind: "prompt", steps: [`do ${id}`] },
  target: { kind: "repo" }, trigger: { kind: "idle" },
  createdAt: NOW - 1000,
});

/** Enough of `AssessIntents` for `startAssessment`; `post` records the draft. */
function fakeIntents(rows) {
  const by = new Map(rows.map((r) => [r.id, r]));
  const posted = [];
  return {
    posted,
    get: (id) => by.get(id),
    post: (draft) => { posted.push(draft); return { ok: true, intent: { ...draft, state: "queued" } }; },
    cancel: () => true, dismiss: () => true, edit: () => ({ ok: true }),
  };
}
const idleStore = { running: () => null };

test("a scope narrows what may be judged and leaves the evidence alone", () => {
  const rows = [
    row("a", "queued"), row("b", "failed"), row("c", "queued"),
    row("done1", "done"), row("run1", "running"),
  ];
  const all = buildAssessInput(CWD, rows, [], NOW);
  const scoped = buildAssessInput(CWD, rows, [], NOW, ["a", "b"]);

  const judged = (input) => input.items.filter((i) => !i.context).map((i) => i.id).sort();
  const context = (input) => input.items.filter((i) => i.context).map((i) => i.id).sort();

  assert.deepEqual(judged(all), ["a", "b", "c"]);
  assert.deepEqual(judged(scoped), ["a", "b"], "only the named rows are candidates");
  // **The evidence is identical.** This is the assertion that stops a later
  // edit from "tidying" the context down to the scope, which would quietly make
  // every scoped run a worse judge than the unscoped one it replaced.
  assert.deepEqual(context(scoped), context(all));
  assert.deepEqual(context(scoped), ["done1", "run1"]);
  // The document says what it was scoped to, so a proposal read back a week
  // later can still say which rows it judged — the run row it came from may
  // have been evicted by then.
  assert.deepEqual(scoped.scopedIds, ["a", "b"]);
  assert.equal(all.scopedIds, undefined, "no scope is ABSENT, never an empty array");
});

test("a scoped run drops pad notes, because they are not rows the caller could have named", () => {
  const rows = [row("a", "queued")];
  const notes = [{ id: "n1", text: "a note on the pad", createdAt: NOW }];
  const all = buildAssessInput(CWD, rows, notes, NOW);
  const scoped = buildAssessInput(CWD, rows, notes, NOW, ["a"]);
  assert.ok(all.items.some((i) => i.id === "n1"), "an unscoped run still judges notes");
  // A count on a control has to equal the set the tap acts on. A scoped run
  // that also judged notes nobody can see on that screen would be a button
  // saying 1 and a proposal about 2.
  assert.ok(!scoped.items.some((i) => i.id === "n1"));
});

test("an empty array is the whole repo, never a scope of nothing", () => {
  const rows = [row("a", "queued"), row("b", "failed")];
  // The one reading that must never be "judge nothing": `[]` reaches here from
  // a caller that built a list and found none, and silently assessing zero rows
  // after spending an agent on the repo is the worst of both answers. The
  // refusal for that case lives at the tap (`startAssessment`), so by the time
  // the document is built an empty array can only mean the whole repo.
  const input = buildAssessInput(CWD, rows, [], NOW, []);
  assert.deepEqual(input.items.filter((i) => !i.context).map((i) => i.id).sort(), ["a", "b"]);
  assert.equal(input.scopedIds, undefined);
});

test("the scope survives the row reviver, or a restart widens the run", () => {
  // Through `cleanIntentRow`, which is what reads `.myapp/intents.json` back on
  // boot — the actual path a scope has to survive, not a helper beside it.
  const revive = (ids) => cleanIntentRow({
    id: "as_1", cwd: CWD, state: "queued",
    payload: ids === undefined ? { kind: "assess" } : { kind: "assess", ids },
    target: { kind: "shell" }, trigger: { kind: "now" }, createdAt: NOW,
  }, NOW)?.payload;

  assert.deepEqual(revive(["a", "b"]), { kind: "assess", ids: ["a", "b"] });
  // Absent, empty and junk all read as "the whole repo" — the shape every row
  // written before this field has.
  assert.deepEqual(revive(undefined), { kind: "assess" });
  assert.deepEqual(revive([]), { kind: "assess" });
  assert.deepEqual(revive("a"), { kind: "assess" });
  assert.deepEqual(revive([1, "", "  ", "b"]), { kind: "assess", ids: ["b"] });
});

test("a scope with nothing assessable in it is refused, never widened to the repo", () => {
  // Finished rows: the cut exists, but an assessment judges what is still open.
  const finished = fakeIntents([row("c", "done")]);
  const r1 = startAssessment(finished, idleStore, CWD, ["c"]);
  assert.ok("error" in r1);
  assert.match(r1.error, /nothing in that cut can be assessed/);
  assert.equal(finished.posted.length, 0, "nothing is written down for a run that cannot run");

  // Another repo's rows. This is the containment half: `buildAssessInput`
  // filters on `cwd` anyway, so without this the run would start, find nothing
  // it was asked about, and assess the whole of a repo the caller never named a
  // row in.
  const elsewhere = fakeIntents([row("x", "queued", "/repo/other")]);
  const r2 = startAssessment(elsewhere, idleStore, CWD, ["x"]);
  assert.ok("error" in r2);
  assert.equal(elsewhere.posted.length, 0);

  // An id nobody has ever heard of.
  const empty = fakeIntents([]);
  assert.ok("error" in startAssessment(empty, idleStore, CWD, ["ghost"]));
});

test("a scope that CAN be honoured is written onto the row, filtered to what is real", () => {
  const intents = fakeIntents([row("a", "queued"), row("b", "failed"), row("c", "done")]);
  const r = startAssessment(intents, idleStore, CWD, ["a", "b", "c", "ghost"]);
  assert.ok(!("error" in r));
  assert.equal(intents.posted.length, 1);
  // `c` is finished and `ghost` does not exist: neither reaches the payload, so
  // the row records the scope the run will actually honour rather than the one
  // it was handed. A count drawn from this later would otherwise say 4.
  assert.deepEqual(intents.posted[0].payload, { kind: "assess", ids: ["a", "b"] });
});

test("no ids is byte-identical to what this message always meant", () => {
  const intents = fakeIntents([row("a", "queued")]);
  const r = startAssessment(intents, idleStore, CWD);
  assert.ok(!("error" in r));
  assert.deepEqual(intents.posted[0].payload, { kind: "assess" }, "absent scope puts NO field on the row");
});
