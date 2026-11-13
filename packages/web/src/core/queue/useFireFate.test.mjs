/**
 * `useFireFate(ackId)` — the hook a sheet reads a tracked fire's fate through. `fireFate.test.mjs` pins the
 * decision; this pins the WIRING: the hook reads the live receipts store AND the live queue rows, so a fire
 * whose row failed, was dismissed, was refused or was acked reads as that, and an untracked fire as nothing.
 * Swap the stores, read one of them only, or drop the ackId, and a case below changes its answer.
 *
 *     node --test packages/web/src/core/queue/useFireFate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useFireFate } from "./useFireFate.ts";
import { fireAcksStore, trackFire, fireAckIn } from "./fireFate.ts";
import { outboxStore } from "./store.ts";

/** What a component calling the hook sees, server-rendered (the stores' server snapshot is their value). */
function fateOf(ackId) {
  function Probe() { return createElement("i", null, JSON.stringify(useFireFate(ackId))); }
  const html = renderToStaticMarkup(createElement(Probe));
  return JSON.parse(html.replace(/^<i>|<\/i>$/g, "").replaceAll("&quot;", '"'));
}

const row = (ackId, status, reason) => ({ ackId, status, ...(reason ? { reason } : {}) });

test.afterEach(() => { fireAcksStore.set(new Map()); outboxStore.set([]); });

test("no fire, or one this tab did not track, has no fate", () => {
  outboxStore.set([row("a1", "queued")]);
  assert.equal(fateOf(null), null);
  assert.equal(fateOf("a1"), null, "a row in the queue is not a tracked fire");
});

test("a tracked fire waits while its row is queued or in flight", () => {
  fireAcksStore.set(trackFire(new Map(), "a1"));
  outboxStore.set([row("a1", "queued")]);
  assert.deepEqual(fateOf("a1"), { kind: "pending" });
  outboxStore.set([row("a1", "pending")]);
  assert.deepEqual(fateOf("a1"), { kind: "pending" });
});

test("the receipt decides: acked carries the run, refused carries the host's reason", () => {
  fireAcksStore.set(fireAckIn(trackFire(new Map(), "a1"), "a1", true, "run-7"));
  assert.deepEqual(fateOf("a1"), { kind: "acked", runId: "run-7" });
  fireAcksStore.set(fireAckIn(trackFire(new Map(), "a2"), "a2", false, undefined, "no known repos selected"));
  assert.deepEqual(fateOf("a2"), { kind: "refused", reason: "no known repos selected" });
});

test("a row that failed or was dismissed is dropped — it will never get a receipt", () => {
  fireAcksStore.set(trackFire(trackFire(new Map(), "a1"), "a2"));
  outboxStore.set([row("a1", "failed", "queue full"), row("other", "queued")]);
  assert.deepEqual(fateOf("a1"), { kind: "dropped", reason: "queue full" }, "read off the LIVE queue rows");
  assert.deepEqual(fateOf("a2"), { kind: "dropped" }, "tracked, and its row is gone");
});

test("each fire reads its own row and receipt, never a neighbour's", () => {
  fireAcksStore.set(fireAckIn(trackFire(trackFire(new Map(), "a1"), "a2"), "a2", true, "r2"));
  outboxStore.set([row("a1", "queued"), row("a2", "failed", "x")]);
  assert.deepEqual(fateOf("a1"), { kind: "pending" });
  assert.deepEqual(fateOf("a2"), { kind: "acked", runId: "r2" }, "a receipt wins over a failed row");
});
