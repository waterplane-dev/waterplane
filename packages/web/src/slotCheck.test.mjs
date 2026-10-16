/**
 * The slot check on the phone (`slotCheck.ts`): the ask after a timed send,
 * the backlog's *check these N*, and what an apply carries.
 *
 * The rules pinned, each silent when broken:
 *   • the count on a control IS the ids the run is sent with (a count is a filter);
 *   • the ask appears only with ≥1 mate, never when switched off in that repo,
 *     and never on a clock the tap did not set;
 *   • approved splits ride in `choices.splits`; a conflict produces no choice.
 *
 *     node --test packages/web/src/slotCheck.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyAssessment, slotMates, slotRowOfItem } from "@waterplane/shared";
import {
  SLOT_ASK_WAIT_MS, assessChoicesOf, assessConflictCards, assessSlotIntro, assessSplitCards, clockStamp,
  resolveSlotAsk, slotAskFor, slotAskOffToast, slotAskText, slotCheckLabel, slotCheckStart, slotChecks, SLOT_ASK_ON_LABEL,
} from "./slotCheck.ts";

const MIN = 60_000;
const RESET = Date.UTC(2026, 9, 16, 18, 0);
const NOW = RESET - 5 * 60 * MIN;
const REPO = "/r/app";

/** A one-off backlog row `offsetMin` from the session reset. */
const win = (id, offsetMin, extra = {}) => ({
  id, text: `do ${id}`, status: "queued", repoDir: REPO, createdAt: 0,
  at: { rule: { kind: "window", window: "session", edge: offsetMin < 0 ? "before" : "after", offsetMin, oneShot: true }, graceMin: 60, nextAt: RESET + offsetMin * MIN },
  ...extra,
});
const once = (id, at, extra = {}) => ({
  id, text: `do ${id}`, status: "queued", repoDir: REPO, createdAt: 0,
  at: { rule: { kind: "once", at }, graceMin: 60, nextAt: at }, ...extra,
});

test("the backlog's check these N: N is exactly the ids the run is sent with", () => {
  const items = [win("a", -60), win("b", -30), win("c", 0), once("lone", RESET + 600 * MIN), { id: "untimed", text: "x", status: "queued", repoDir: REPO, createdAt: 0 },
    win("other-repo", -30, { repoDir: "/r/else" })];
  const checks = slotChecks(items, REPO);
  assert.equal(checks.length, 1, "a slot of one is not offered");
  const c = checks[0];
  assert.deepEqual(c.ids, ["a", "b", "c"]);
  assert.match(slotCheckLabel(c, NOW), /^check these 3 · in 5h$/);
  // The number on the button is the length of what is sent — nothing else.
  assert.equal(Number(/check these (\d+)/.exec(slotCheckLabel(c, NOW))[1]), c.ids.length);
  assert.deepEqual(c.scope, { kind: "slot", key: `reset:session:${RESET}` });
  // And it is the shared bucketing function's cut, not a second walk.
  const rows = items.filter((it) => it.repoDir === REPO).map(slotRowOfItem).filter(Boolean);
  assert.deepEqual([...slotMates(rows, "a"), "a"].sort(), [...c.ids].sort());
});

test("archived and settled rows are in no slot, so they are not counted", () => {
  const items = [win("a", -60), win("b", -30, { archived: true }), win("c", -10, { status: "done" })];
  assert.deepEqual(slotChecks(items, REPO), []);
});

test("the ask: only with ≥1 mate, and its count is slotMates' length", () => {
  const items = [win("new", -30), win("x", -60), win("y", 0)];
  const ask = slotAskFor(items, REPO, "new", false);
  assert.ok(ask);
  assert.equal(ask.others, 2);
  assert.deepEqual(ask.check.ids, ["new", "x", "y"], "the check sends the whole slot, the new row included");
  assert.equal(slotAskText(ask), "2 others run at this reset — check them together?");
  // Alone on its clock: no ask.
  assert.equal(slotAskFor([win("new", -30), once("far", RESET + 900 * MIN)], REPO, "new", false), null);
  // An instant slot says "at this time".
  const t = RESET + 600 * MIN;
  assert.equal(slotAskText(slotAskFor([once("n", t), once("m", t + MIN)], REPO, "n", false)), "1 other runs at this time — check them together?");
});

test("the ask never appears when it is switched off in that repo", () => {
  const items = [win("new", -30), win("x", -60)];
  assert.equal(slotAskFor(items, REPO, "new", true), null);
  const p = { id: "new", repoDir: REPO, was: null, since: NOW };
  assert.deepEqual(resolveSlotAsk(p, items, NOW, true), { kind: "drop" });
  // The toast that switches it off names the control that brings it back.
  assert.ok(slotAskOffToast("app").includes(SLOT_ASK_ON_LABEL));
});

test("a pending send waits for the list to hold it — on the NEW clock", () => {
  const before = [win("r", -120), win("x", -30)];
  // A re-time: the list at the tap still shows the old clock.
  const p = { id: "r", repoDir: REPO, was: clockStamp(before[0]), since: NOW };
  assert.deepEqual(resolveSlotAsk(p, before, NOW + 1000, false), { kind: "wait" }, "old clock: no ask yet");
  const after = [win("r", -30), win("x", -30)];
  const step = resolveSlotAsk(p, after, NOW + 2000, false);
  assert.equal(step.kind, "ask");
  assert.equal(step.ask.others, 1);
  // A new row not on the list yet waits; given up after the wait.
  const fresh = { id: "n", repoDir: REPO, was: null, since: NOW };
  assert.deepEqual(resolveSlotAsk(fresh, after, NOW + 1000, false), { kind: "wait" });
  assert.deepEqual(resolveSlotAsk(fresh, after, NOW + SLOT_ASK_WAIT_MS + 1, false), { kind: "drop" });
  // On the list, alone: dropped, nothing asked.
  assert.deepEqual(resolveSlotAsk(fresh, [win("n", -30)], NOW + 1000, false), { kind: "drop" });
});

test("check never replaces an undecided proposal nor runs beside a running one", () => {
  const c = { ids: ["a", "b"], scope: { kind: "slot", key: "reset:session:1" } };
  assert.equal(slotCheckStart(null, c), "run");
  assert.equal(slotCheckStart({ status: "applied" }, c), "run");
  assert.equal(slotCheckStart({ status: "failed" }, c), "run");
  assert.equal(slotCheckStart({ status: "running" }, c), "busy");
  assert.equal(slotCheckStart({ status: "done" }, c), "waiting");
  assert.equal(slotCheckStart({ status: "done", scope: c.scope, scopedIds: ["b", "a"] }, c), "same");
  assert.equal(slotCheckStart({ status: "done", scope: c.scope, scopedIds: ["a"] }, c), "waiting", "the slot grew: a different question");
});

test("choices carry split ids; a conflict produces no choice", () => {
  const items = [
    { id: "a", source: "intent", text: "fix login and also redo the README", state: "queued" },
    { id: "b", source: "intent", text: "make login use tokens", state: "queued" },
    { id: "c", source: "intent", text: "make login use cookies", state: "queued" },
  ];
  const proposal = {
    rows: [], merges: [], news: [], notes: [],
    conflicts: [{ cid: "c1", ids: ["b", "c"], why: "tokens vs cookies" }],
    splits: [{ sid: "s1", id: "a", texts: ["fix login", "redo the README"], rationale: "two jobs" }],
  };
  const choices = assessChoicesOf({ rows: new Set(), merges: new Set(), news: new Set(), splits: new Set(["s1"]) });
  assert.deepEqual(choices.splits, ["s1"]);
  assert.ok(!Object.keys(choices).some((k) => /conflict/i.test(k)), "no field for a conflict");
  assert.equal("splits" in assessChoicesOf({ rows: [], merges: [], news: [], splits: [] }), false, "absent when none approved");
  // The host's own arithmetic over those choices: the split, and nothing for the conflict.
  const m = applyAssessment(proposal, choices, { runId: "as_test", items });
  assert.deepEqual(m.split.map((s) => s.sid), ["s1"]);
  assert.deepEqual(m.dismiss, []);
  assert.deepEqual(m.post, []);
  // The cards say every row and both texts.
  const cc = assessConflictCards(proposal, items);
  assert.deepEqual(cc[0].rows.map((r) => r.text), ["make login use tokens", "make login use cookies"]);
  const sc = assessSplitCards(proposal, items);
  assert.deepEqual(sc[0].texts, ["fix login", "redo the README"]);
  assert.equal(sc[0].original.text, "fix login and also redo the README");
  // A row this phone does not hold is said, not dropped.
  assert.equal(assessConflictCards({ ...proposal, conflicts: [{ cid: "x", ids: ["b", "zz"], why: "w" }] }, items)[0].rows[1].text, null);
});

test("a slot run says it is one, and when it fires", () => {
  const s = assessSlotIntro({ kind: "slot", key: `reset:session:${RESET}` }, 3, NOW);
  assert.match(s, /^A slot check: these 3 run together at the session reset, .* \(in 5h\)\./);
  assert.equal(assessSlotIntro(undefined, 3, NOW), null);
});
