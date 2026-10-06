/**
 * The per-repo send memory, pinned by the bug it is allowed to bring back and
 * the one it is not.
 *
 * A persisted per-repo send mode was deleted from this app once: a repo left in
 * *later* turned the primary button into a schedule editor days after anybody
 * chose that. The memory is back because making the same four taps ten times to
 * queue ten prompts is its own defect — but every rule that keeps it from being
 * the old bug again is invisible to a type-checker, so they are all here.
 *
 *     node --test packages/web/src/sendMemory.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  reusableWhen, reusableMode, reusableWhere, rememberSend, recallMode, recallWhen,
  recallWhere, recalledWhenNote, SEND_MEMORY_CAP,
} from "./sendMemory.ts";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

test("the split button is only ever recalled to a mode it can SAY", () => {
  assert.equal(reusableMode("now"), "now");
  assert.equal(reusableMode("idle"), "idle");
  // Nothing else reaches the compose bar's primary button — a clock recalled
  // onto it is precisely the schedule-editor bug.
  assert.equal(reusableMode(undefined), null);
  assert.equal(reusableMode("at"), null);
  assert.equal(recallMode({}, "/dev/myapp"), "now");
  assert.equal(recallMode({ "/dev/myapp": { mode: "idle", at: NOW } }, "/dev/myapp"), "idle");
  // No repo in hand ⇒ the plain answer, never the last repo's.
  assert.equal(recallMode({ "/dev/myapp": { mode: "idle", at: NOW } }, null), "now");
});

test("a chain is never remembered — it names ONE row", () => {
  // Reused, every later prompt would park behind a predecessor that settled
  // long ago, and nothing on screen would say so.
  assert.equal(reusableWhen({ kind: "after", id: "i1", title: "the migration" }, NOW), null);
});

test("a one-off expires itself; a weekly rule does not", () => {
  const once = (at) => ({ kind: "at", rule: { kind: "once", at }, graceMin: 30 });
  assert.ok(reusableWhen(once(NOW + HOUR), NOW), "still ahead — that is the 'same time tonight' case");
  assert.equal(reusableWhen(once(NOW - HOUR), NOW), null, "already come round");
  assert.equal(reusableWhen(once(NOW), NOW), null, "this instant is not ahead");
  assert.equal(reusableWhen({ kind: "at", rule: { kind: "once" }, graceMin: 0 }, NOW), null, "no instant at all");
  const weekly = { kind: "at", rule: { kind: "weekly", days: [1], hour: 9, minute: 0 }, graceMin: 30 };
  assert.deepEqual(reusableWhen(weekly, NOW), weekly);
});

test("the schedule's NAME is dropped — ten rows with one name is a list nobody reads", () => {
  const w = reusableWhen({ kind: "at", rule: { kind: "weekly", hour: 3, minute: 0 }, graceMin: 5, name: "nightly sweep" }, NOW);
  assert.equal(w.name, undefined);
  assert.equal(w.graceMin, 5, "everything else about the rule survives");
});

test("`now` is remembered too — it is how a recalled schedule is undone", () => {
  let m = rememberSend({}, "/dev/myapp", { when: { kind: "at", rule: { kind: "weekly", hour: 3, minute: 0 }, graceMin: 5 } }, NOW);
  assert.equal(recallWhen(m, "/dev/myapp", NOW).kind, "at");
  m = rememberSend(m, "/dev/myapp", { when: { kind: "now" } }, NOW);
  assert.deepEqual(recallWhen(m, "/dev/myapp", NOW), { kind: "now" });
});

test("the two writers merge — the composer's mode and the sheet's when", () => {
  // They are decided on different screens; either one erasing the other would
  // make the memory depend on which surface you used last.
  let m = rememberSend({}, "/dev/myapp", { mode: "idle" }, NOW);
  m = rememberSend(m, "/dev/myapp", { when: { kind: "idle" } }, NOW + 1);
  assert.equal(m["/dev/myapp"].mode, "idle");
  assert.equal(m["/dev/myapp"].when.kind, "idle");
});

test("an unusable answer CLEARS what was there, never leaves the old one standing", () => {
  let m = rememberSend({}, "/dev/myapp", { when: { kind: "at", rule: { kind: "weekly", hour: 3, minute: 0 }, graceMin: 5 } }, NOW);
  m = rememberSend(m, "/dev/myapp", { when: { kind: "after", id: "i1" } }, NOW);
  assert.equal(m["/dev/myapp"].when, undefined, "the chain is not stored — and neither is the stale weekly it replaced");
  assert.equal(recallWhen(m, "/dev/myapp", NOW), null);
});

test("staleness is re-checked when it is READ, not only when it is written", () => {
  // Remembered this morning, opened this evening: the instant is behind now.
  const m = rememberSend({}, "/dev/myapp", { when: { kind: "at", rule: { kind: "once", at: NOW + HOUR }, graceMin: 0 } }, NOW);
  assert.ok(recallWhen(m, "/dev/myapp", NOW));
  assert.equal(recallWhen(m, "/dev/myapp", NOW + 2 * HOUR), null);
});

test("it is bounded, and the oldest decision is what falls off", () => {
  let m = {};
  for (let i = 0; i < SEND_MEMORY_CAP + 5; i++) m = rememberSend(m, `/dev/r${i}`, { mode: "idle" }, NOW + i);
  const keys = Object.keys(m);
  assert.equal(keys.length, SEND_MEMORY_CAP);
  assert.ok(!keys.includes("/dev/r0"), "oldest gone");
  assert.ok(keys.includes(`/dev/r${SEND_MEMORY_CAP + 4}`), "newest kept");
});

test("a write with no repo changes nothing", () => {
  const m = { "/dev/myapp": { mode: "idle", at: NOW } };
  assert.equal(rememberSend(m, null, { mode: "now" }, NOW), m);
});

test("the recalled sheet SAYS it was recalled, and names the repo", () => {
  // The WHEN row opens collapsed, so without this sentence a schedule set last
  // week is the invisible state the old per-repo mode was deleted for.
  const s = recalledWhenNote("myapp");
  assert.match(s, /myapp/);
  assert.match(s, /When/);
});

// ── the AIM, under the same rule as the mode ───────────────────────────────

test("the aim is only ever recalled to an answer the strip can SAY", () => {
  assert.equal(reusableWhere("this"), "this");
  assert.equal(reusableWhere("new"), "new");
  // `other` names ONE session by a per-boot id. Recalled a day later it is
  // either gone — a refusal on a send nobody meant to aim anywhere odd — or,
  // worse, a session somebody else's tap opened into that slot. Same rule as
  // the chain, and for the same reason.
  assert.equal(reusableWhere("other"), null);
  assert.equal(reusableWhere(undefined), null);
  assert.equal(reusableWhere("elsewhere"), null);
});

test("with nothing remembered the strip opens on the session you are looking at", () => {
  assert.equal(recallWhere({}, "/r"), "this");
  assert.equal(recallWhere({}, null), "this");
  // And a stored `other` reads back as `this`, not as an aim at a dead id.
  assert.equal(recallWhere({ "/r": { where: "other", at: NOW } }, "/r"), "this");
});

test("the aim is remembered per repo, and one repo's aim is not another's", () => {
  let mem = rememberSend({}, "/a", { where: "new" }, NOW);
  mem = rememberSend(mem, "/b", { where: "this" }, NOW);
  assert.equal(recallWhere(mem, "/a"), "new");
  assert.equal(recallWhere(mem, "/b"), "this");
  assert.equal(recallWhere(mem, "/c"), "this");
});

test("the composer writes the aim without erasing the sheet's WHEN", () => {
  // The merge rule this file is built on, applied to the third field: the
  // composer decides `mode` and `where`, the sheet decides `when`, and none of
  // them may blank what another last said.
  let mem = rememberSend({}, "/r", { when: { kind: "idle" } }, NOW);
  mem = rememberSend(mem, "/r", { mode: "idle", where: "new" }, NOW + HOUR);
  assert.deepEqual(recallWhen(mem, "/r", NOW + HOUR), { kind: "idle" });
  assert.equal(recallMode(mem, "/r"), "idle");
  assert.equal(recallWhere(mem, "/r"), "new");
});

test("aiming back at this session is a real decision and sticks", () => {
  // The same reason `now` is remembered: if the way OUT of an armed answer is
  // the one choice that never sticks, the memory is a trap rather than a
  // convenience.
  let mem = rememberSend({}, "/r", { where: "new" }, NOW);
  mem = rememberSend(mem, "/r", { where: "this" }, NOW + HOUR);
  assert.equal(recallWhere(mem, "/r"), "this");
  assert.equal(mem["/r"].where, "this");
});

test("an `other` aim leaves no trace to recall", () => {
  let mem = rememberSend({}, "/r", { where: "new" }, NOW);
  mem = rememberSend(mem, "/r", { where: "other" }, NOW + HOUR);
  assert.equal(mem["/r"].where, undefined, "dropped on the way IN, not only on the way out");
  assert.equal(recallWhere(mem, "/r"), "this");
});
