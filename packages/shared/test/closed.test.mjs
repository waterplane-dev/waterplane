/**
 * What a *Recently closed* row may say (`closed.ts`): every string clipped,
 * every new fact optional, an old row read back unchanged, and the item's
 * outcome only once it has settled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSED_TEXT_CAP, clipClosedText, cleanClosedRow, closedItemFacts, sessionOriginOfIntent,
} from "../dist/index.js";

const OLD = { id: "a1b2c3d4", cwd: "/r", title: "myapp", closedAt: 1_700_000_000_000, claudeSessionId: "uuid-1", alive: false };

test("a row from before these fields existed reads back exactly as it was", () => {
  assert.deepEqual(cleanClosedRow(OLD), OLD);
});

test("a row missing a required field is dropped, not half-read", () => {
  assert.equal(cleanClosedRow({ ...OLD, closedAt: "yesterday" }), null);
  assert.equal(cleanClosedRow(null), null);
});

test("unknown reasons and kinds are dropped — absent, never rounded to a near word", () => {
  const r = cleanClosedRow({ ...OLD, closedBy: "crashed", kind: "manual", itemState: "running", turns: 0, exitCode: "1" });
  for (const k of ["closedBy", "kind", "itemState", "turns", "exitCode"]) assert.equal(k in r, false, k);
  const ok = cleanClosedRow({ ...OLD, closedBy: "auto-slot", kind: "backlog", itemState: "done", turns: 4, exitCode: 0 });
  assert.equal(ok.closedBy, "auto-slot"); assert.equal(ok.kind, "backlog"); assert.equal(ok.turns, 4); assert.equal(ok.exitCode, 0);
});

test("every text field is one line and clipped to the cap", () => {
  const long = "word ".repeat(200);
  const r = cleanClosedRow({ ...OLD, tabTitle: long, firstPrompt: "two\nlines", itemLabel: "   " });
  assert.equal(r.tabTitle.length, CLOSED_TEXT_CAP);
  assert.equal(r.tabTitle.endsWith("…"), true);
  assert.equal(r.firstPrompt, "two lines");
  assert.equal("itemLabel" in r, false, "blank is absent, not an empty label");
  assert.equal(clipClosedText(42), undefined);
});

test("an item's outcome is carried only once it has settled", () => {
  assert.deepEqual(closedItemFacts({ state: "running" }), {});
  assert.deepEqual(closedItemFacts(undefined), {});
  assert.deepEqual(closedItemFacts({ state: "failed", result: { at: 1, ok: false, detail: "its session was lost" } }),
    { itemState: "failed", itemOk: false, itemDetail: "its session was lost" });
});

test("the origin of an intent's session: agent, schedule, fanout, else backlog — with the item's name", () => {
  const base = { id: "i1", trigger: { kind: "now" }, payload: { kind: "prompt", steps: ["fix the flaky test please"] } };
  assert.deepEqual(sessionOriginOfIntent(base), { kind: "backlog", itemId: "i1", itemLabel: "fix the flaky test please" });
  assert.equal(sessionOriginOfIntent({ ...base, origin: "agent" }).kind, "agent");
  assert.equal(sessionOriginOfIntent({ ...base, origin: "schedule:work" }).kind, "schedule");
  assert.equal(sessionOriginOfIntent({ ...base, trigger: { kind: "at", rule: { kind: "once", at: 1 }, graceMin: 5 } }).kind, "schedule");
  assert.equal(sessionOriginOfIntent({ ...base, origin: "fanout", groupId: "g1" }).kind, "fanout");
  assert.equal(sessionOriginOfIntent({ ...base, label: "Flaky test" }).itemLabel, "Flaky test", "a typed label wins");
});

test("a row persisted with the retired per-turn summary still parses, minus the summary", () => {
  const r = cleanClosedRow({ ...OLD, summary: "was a summary", tabTitle: "kept" });
  assert.ok(r);
  assert.equal("summary" in r, false);
  assert.equal(r.tabTitle, "kept");
});
