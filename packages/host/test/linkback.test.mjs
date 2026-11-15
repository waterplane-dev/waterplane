import test from "node:test";
import assert from "node:assert/strict";
import { createLinkBack, linkStep, parseSelfOnline } from "../dist/linkback.js";

function rig(minOfflineMs) {
  let t = 0; let reading = true; const sent = [];
  const lb = createLinkBack({ notify: (k, p) => sent.push([k, p]), read: async () => reading, now: () => t, label: () => "Mac", minOfflineMs });
  return { lb, sent, at: (ms) => { t = ms; }, set: (r) => { reading = r; } };
}

test("one push per outage after >= 2 min, with the payload fields", async () => {
  const r = rig();
  await r.lb.check();
  r.set(false); r.at(10_000); await r.lb.check();
  r.at(70_000); await r.lb.check();
  assert.equal(r.sent.length, 0, "nothing while offline");
  r.set(true); r.at(130_000); await r.lb.check();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0][0], "link.back");
  assert.deepEqual(r.sent[0][1].linkBack, { hostLabel: "Mac", offlineMs: 120_000 });
  assert.match(r.sent[0][1].body, /Mac is reachable again/);
  r.at(190_000); await r.lb.check();
  assert.equal(r.sent.length, 1, "staying online sends nothing");
});

test("an outage under 2 min is silent", async () => {
  const r = rig();
  r.set(false); r.at(0); await r.lb.check();
  r.set(true); r.at(119_999); await r.lb.check();
  assert.equal(r.sent.length, 0);
});

test("unknown never fires and never ends an outage", async () => {
  const r = rig();
  r.set(null); r.at(0); await r.lb.check();
  r.set(true); r.at(500_000); await r.lb.check();
  assert.equal(r.sent.length, 0, "unknown then online is not a transition");
  r.set(false); r.at(600_000); await r.lb.check();
  r.set(null); r.at(900_000); await r.lb.check();
  assert.equal(r.sent.length, 0);
  r.set(true); r.at(1_000_000); await r.lb.check();
  assert.equal(r.sent.length, 1, "offline start survives an unknown gap");
  assert.equal(r.sent[0][1].linkBack.offlineMs, 400_000);
});

test("two outages, two pushes", async () => {
  const r = rig();
  for (const [off, on] of [[0, 200_000], [300_000, 700_000]]) {
    r.set(false); r.at(off); await r.lb.check(); r.set(true); r.at(on); await r.lb.check();
  }
  assert.equal(r.sent.length, 2);
});

test("linkStep and parseSelfOnline", () => {
  assert.deepEqual(linkStep({ offlineSince: null }, null, 5).state, { offlineSince: null });
  assert.equal(parseSelfOnline('{"Self":{"Online":true}}'), true);
  assert.equal(parseSelfOnline('{"Self":{}}'), null);
  assert.equal(parseSelfOnline("nope"), null);
});
