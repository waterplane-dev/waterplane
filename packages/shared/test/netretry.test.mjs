/** The one wording of the host's retry after a transient API give-up (`netretry.ts`). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { netRetryLine, netRetryWait } from "../dist/index.js";

const base = { attempt: 1, max: 8, error: "Connection dropped (ECONNRESET)", at: 0 };

test("waiting says when and which try", () => {
  assert.equal(netRetryLine({ ...base, state: "waiting", nextAt: 40_000 }, 0), "Network error — retrying in 40s (2/8)");
  assert.equal(netRetryLine({ ...base, state: "waiting", nextAt: 90_000, why: "waiting for the open box to be answered" }, 0),
    "Network error — retrying in 1m 30s (2/8) · waiting for the open box to be answered");
});

test("sent and gave up", () => {
  assert.equal(netRetryLine({ ...base, state: "sent", attempt: 2, nextAt: null }, 0), "Network error — retried (2/8), waiting for the reply");
  assert.equal(netRetryLine({ ...base, state: "gaveup", attempt: 8, nextAt: null, why: "after 8 tries" }, 0), "Network error — stopped retrying: after 8 tries. Type to try again.");
});

test("absent is null, a past instant is 0s, never negative", () => {
  assert.equal(netRetryLine(null, 0), null);
  assert.equal(netRetryLine(undefined, 0), null);
  assert.equal(netRetryWait(-5000), "0s");
  assert.equal(netRetryWait(120_000), "2m");
});

test("netGaveUpDetail: the sentence a waiting item is failed with says the API was unreachable and the work did not run", async () => {
  const { netGaveUpDetail } = await import("../dist/index.js");
  const d = netGaveUpDetail("Can't reach the API server (ENOTFOUND)", "after 8 tries");
  assert.match(d, /could not be reached \(Can't reach the API server \(ENOTFOUND\)\)/);
  assert.match(d, /stopped retrying after 8 tries/);
  assert.match(d, /did not run/);
});

test("netStalledOf: a RUNNING row whose session gave up is stalled — derived, never stored", async () => {
  const { netStalledOf, netStalledText } = await import("../dist/index.js");
  const g = { ...base, state: "gaveup", attempt: 8, nextAt: null, why: "after 8 tries" };
  const sessions = [{ id: "s1", netRetry: g }, { id: "s2", netRetry: { ...base, state: "waiting", nextAt: 1 } }, { id: "s3" }];
  assert.equal(netStalledOf({ state: "running", sessionId: "s1" }, sessions), g);
  assert.equal(netStalledOf({ state: "done", sessionId: "s1" }, sessions), null, "settled work is never stalled");
  assert.equal(netStalledOf({ state: "running", sessionId: "s2" }, sessions), null, "a retry still going is not a stall");
  assert.equal(netStalledOf({ state: "running", sessionId: "s3" }, sessions), null);
  assert.equal(netStalledOf({ state: "running", sessionId: "gone" }, sessions), null);
  assert.equal(netStalledOf({ state: "running" }, sessions), null);
  assert.equal(netStalledText(g), "Stalled — API unreachable, 8 retries used");
  assert.equal(netStalledText({ ...g, attempt: 1, why: "after 1 try" }), "Stalled — API unreachable, 1 retry used");
  assert.equal(netStalledText({ ...g, attempt: 3, why: "the emergency halt is on" }), "Stalled — API unreachable, 3 retries used (the emergency halt is on)");
  assert.equal(netStalledText({ ...g, attempt: 1, why: "after 1 try — automatic retry is off" }), "Stalled — API unreachable, 1 retry used (automatic retry is off)");
});

test("a DISMISSED gave-up and a stall PROBE are still stalls; the note says when the next probe runs", async () => {
  const { netStalledOf, netStalledText, netRetryStalls, netRetryLine } = await import("../dist/index.js");
  const g = { ...base, state: "gaveup", attempt: 8, nextAt: null, why: "after 8 tries" };
  const row = { state: "running", sessionId: "s1" };
  const d = { ...g, dismissed: true };
  assert.equal(netStalledOf(row, [{ id: "s1", netRetry: d }]), d, "dismissing hides the line, never the stall");
  const p = { ...g, state: "sent", attempt: 9, probe: true };
  assert.equal(netStalledOf(row, [{ id: "s1", netRetry: p }]), p);
  assert.equal(netRetryStalls({ ...base, state: "waiting", nextAt: 1 }), false, "a ladder rung is not a stall");
  assert.equal(netRetryStalls(null), false);
  const now = 1_000_000;
  assert.equal(netStalledText({ ...g, nextAt: now + 23 * 60_000 - 5000 }, now), "Stalled — API unreachable, 8 retries used · next try in 23m");
  assert.equal(netStalledText({ ...g, nextAt: now + 23 * 60_000 }), "Stalled — API unreachable, 8 retries used", "no clock ⇒ no guessed wait");
  assert.equal(netStalledText(p, now), "Stalled — API unreachable, 9 retries used · trying again now");
  assert.equal(netRetryLine(p, now), "Network error — tried once more (try 9), waiting for the reply");
  assert.match(netRetryLine({ ...g, nextAt: now + 30 * 60_000 }, now), /stopped retrying: after 8 tries; one more try in 30m\. Type to try again\.$/);
});
