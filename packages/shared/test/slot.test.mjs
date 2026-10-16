// Which waiting timed rows fire TOGETHER (`shared/src/intent/slot.ts`) — the
// one bucketing function behind the slot check's count and its cut.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RESET_MATCH_MS, findSlot, latestClock, parseSlotKey, slotMates, slotOf, slotOthersText,
  slotRowOfIntent, slotRowOfItem, slotsOf,
} from "../dist/index.js";

const MIN = 60_000;
const RESET = Date.UTC(2026, 9, 16, 18, 0);

const win = (id, offsetMin, edge, opts = {}) => {
  const off = offsetMin * MIN;
  const reset = opts.reset ?? RESET;
  const nextAt = reset + (edge === "after" ? Math.max(0, off) : off);
  return { id, waiting: true, nextAt, rule: { kind: "window", window: opts.window ?? "session", edge, offsetMin, oneShot: true, ...(opts.periodId ? { periodId: opts.periodId } : {}) } };
};
const once = (id, at, extra = {}) => ({ id, waiting: true, nextAt: at, rule: { kind: "once", at }, ...extra });

test("both edges of one reset are one slot; the reset is read back off each row's own clock", () => {
  const rows = [win("a", -60, "before"), win("b", -30, "before"), win("c", 0, "after"), win("d", 15, "after")];
  const s = slotsOf(rows);
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "reset");
  assert.equal(s[0].period, "session");
  assert.equal(s[0].at, RESET);
  assert.deepEqual(s[0].ids, ["a", "b", "c", "d"]);
  assert.deepEqual(slotMates(rows, "b"), ["a", "c", "d"]);
});

test("a reset read a minute apart is still the same reset; past the tolerance it is another", () => {
  const rows = [win("a", -60, "before"), win("b", -60, "before", { reset: RESET + MIN })];
  assert.deepEqual(slotMates(rows, "a"), ["b"]);
  const far = [win("a", -60, "before"), win("b", -60, "before", { reset: RESET + RESET_MATCH_MS + 1 })];
  assert.deepEqual(slotMates(far, "a"), []);
  // Exactly at the tolerance is inclusive, as `budgetHold` reads it.
  const edge = [win("a", -60, "before"), win("b", -60, "before", { reset: RESET + RESET_MATCH_MS })];
  assert.deepEqual(slotMates(edge, "a"), ["b"]);
});

test("the session and the weekly reset at the same instant are different slots", () => {
  const rows = [win("s", -30, "before"), win("w", -30, "before", { window: "weekly" })];
  assert.equal(slotsOf(rows).length, 2);
  assert.deepEqual(slotMates(rows, "s"), []);
});

test("one-off instants within tolerance are one slot, and never chain past it", () => {
  const t = RESET + 600 * MIN;
  const rows = [once("a", t), once("b", t + 2 * MIN), once("c", t + 4 * MIN), once("d", t + 8 * MIN)];
  const s = slotsOf(rows);
  assert.deepEqual(s.map((x) => x.ids), [["a", "b", "c"], ["d"]]);
  assert.equal(s[0].kind, "instant");
  assert.equal(s[0].key, `at:${t}`);
});

test("a once at the reset, or at a member's own fire instant, joins the window slot", () => {
  const rows = [win("w1", -60, "before"), win("w2", 0, "after"), once("atReset", RESET + MIN), once("withW1", RESET - 60 * MIN)];
  const s = slotsOf(rows);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].ids, ["w1", "w2", "atReset", "withW1"]);
  assert.equal(slotOf(rows, "withW1").key, `reset:session:${RESET}`);
});

test("recurring, untimed-shaped, unarmed and non-waiting rows are in no slot", () => {
  const recurring = { ...win("r", -30, "before"), rule: { kind: "window", window: "session", edge: "before", offsetMin: -30 } };
  const unarmed = { ...win("u", -30, "before"), nextAt: null };
  const done = { ...win("x", -30, "before"), waiting: false };
  const rows = [win("a", -30, "before"), recurring, unarmed, done, win("b", -10, "before")];
  assert.deepEqual(slotMates(rows, "a"), ["b"]);
  for (const id of ["r", "u", "x"]) assert.equal(slotOf(rows, id), null);
  assert.deepEqual(slotMates(rows, "r"), []);
});

test("slotRowOfIntent: timed one-off work only, waiting = queued/blocked and not archived", () => {
  const base = {
    id: "i1", origin: "send", createdAt: 1, state: "queued", attempts: 0,
    target: { kind: "repo", dir: "/r", fresh: true },
    payload: { kind: "prompt", steps: ["do it"] },
    trigger: { kind: "at", rule: { kind: "once", at: RESET }, graceMin: 120 },
    nextAt: RESET,
  };
  assert.deepEqual(slotRowOfIntent(base), { id: "i1", rule: { kind: "once", at: RESET }, nextAt: RESET, waiting: true });
  assert.equal(slotRowOfIntent({ ...base, state: "running" }).waiting, false);
  assert.equal(slotRowOfIntent({ ...base, archived: true }).waiting, false);
  assert.equal(slotRowOfIntent({ ...base, state: "blocked" }).waiting, true);
  // A standing rule is a schedule, not a slot member.
  assert.equal(slotRowOfIntent({ ...base, trigger: { kind: "at", rule: { kind: "weekly", days: [1], hour: 9, minute: 0 }, graceMin: 120 } }), null);
  assert.equal(slotRowOfIntent({ ...base, trigger: { kind: "now" } }), null);
});

test("slotRowOfItem: the phone's BacklogItem reduces to the same shape", () => {
  const item = { id: "b1", status: "queued", at: { rule: { kind: "once", at: RESET }, graceMin: 120, nextAt: RESET } };
  assert.deepEqual(slotRowOfItem(item), { id: "b1", rule: { kind: "once", at: RESET }, nextAt: RESET, waiting: true });
  assert.equal(slotRowOfItem({ ...item, status: "done" }).waiting, false);
  assert.equal(slotRowOfItem({ ...item, archived: true }).waiting, false);
  assert.equal(slotRowOfItem({ id: "b2", status: "queued" }), null);
});

test("findSlot matches a key read a minute apart, and nothing past the tolerance", () => {
  const rows = [win("a", -60, "before"), win("b", -30, "before")];
  assert.deepEqual(findSlot(rows, `reset:session:${RESET + MIN}`)?.ids, ["a", "b"]);
  assert.equal(findSlot(rows, `reset:session:${RESET + RESET_MATCH_MS + MIN}`), null);
  assert.equal(findSlot(rows, `reset:weekly:${RESET}`), null);
  assert.equal(findSlot(rows, "nonsense"), null);
  const t = RESET + 900 * MIN;
  assert.deepEqual(findSlot([once("x", t), once("y", t)], `at:${t - MIN}`)?.ids, ["x", "y"]);
});

test("parseSlotKey reads both shapes, a period with a colon in it, and refuses the rest", () => {
  assert.deepEqual(parseSlotKey("at:123"), { kind: "instant", at: 123 });
  assert.deepEqual(parseSlotKey("reset:weekly:456"), { kind: "reset", period: "weekly", at: 456 });
  assert.deepEqual(parseSlotKey("reset:span:a:7"), { kind: "reset", period: "span:a", at: 7 });
  for (const k of ["", "at:", "at:x", "reset::5", "foo:5", "reset:session:-1"]) assert.equal(parseSlotKey(k), null, k);
});

test("latestClock: the member that fires last, so a merge never runs earlier than anyone asked", () => {
  const a = { ...win("a", -60, "before"), graceMin: 30 };
  const b = { ...win("b", -30, "before"), graceMin: 90 };
  assert.equal(latestClock([a, b]), b);
  assert.equal(latestClock([b, a]), b);
  // Identical clocks: that clock.
  const b2 = { ...b, id: "b2" };
  assert.equal(latestClock([b, b2]).rule, b.rule);
  assert.equal(latestClock([a]), a);
});

test("latestClock degrades to null: empty, an unarmed member, or a near-tie across anchors", () => {
  assert.equal(latestClock([]), null);
  assert.equal(latestClock([win("a", -60, "before"), { ...win("b", -30, "before"), nextAt: null }]), null);
  // A once at the reset and an `after` row on it: which is later flips with the scrape.
  assert.equal(latestClock([once("o", RESET + MIN), win("w", 0, "after")]), null);
  // Two one-offs, or two offsets of one reset, are ordered as read even when close.
  const o1 = once("o1", RESET), o2 = once("o2", RESET + 2 * MIN);
  assert.equal(latestClock([o2, o1]), o2);
  const w1 = win("w1", -30, "before"), w2 = win("w2", -28, "before");
  assert.equal(latestClock([w1, w2]), w2);
  // Far enough apart, the different rules are not ambiguous.
  assert.equal(latestClock([once("o", RESET - 60 * MIN), win("w", 0, "after")]).id, "w");
});

test("slotOthersText counts and names the slot kind", () => {
  assert.equal(slotOthersText(3, "reset"), "3 others run at this reset");
  assert.equal(slotOthersText(1, "instant"), "1 other runs at this time");
});
