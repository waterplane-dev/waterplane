/**
 * The PWA background relay (PLAN bg-link-send WP8): the worker core `public/swRelay.js` and the
 * page's store mutations `swRelayStore.ts`, run against ONE in-memory store — ordering per lane,
 * verdicts, pending, release, claim, ownership, sealed sign-ins and the notification words. Then
 * `sw.js` itself in a `vm` with the relay loaded: a `link.back` push always shows ONE notification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  CLAIM_KEYS, OWN_KEYS, RELAY_KEYS, claimMutation, handMutation, heartbeatMutation, releaseMutation,
} from "./swRelayStore.ts";

await import("../../../public/swRelay.js");
const R = globalThis.WPRelay;

/** One transaction at a time, like IndexedDB's readwrite on one store. */
function memStore() {
  const m = new Map();
  return {
    m,
    async update(keys, mutate) {
      const vals = {};
      for (const k of keys) vals[k] = m.has(k) ? structuredClone(m.get(k)) : undefined;
      const r = mutate(vals);
      for (const [k, v] of Object.entries(r.put ?? {})) m.set(k, structuredClone(v));
      for (const k of r.del ?? []) m.delete(k);
      return r.result;
    },
  };
}

const HOST = "origin:https://desk.ts.net";
const input = (ackId, extra = {}) => ({ ackId, frame: { t: "session.input", id: "s1", ackId, data: `hi ${ackId}`, submit: true, ...extra.frame }, ...(extra.needsRelease ? { needsRelease: true } : {}) });
const plan = (lanes) => ({ hostId: HOST, v: 1, issuedAt: 1, depth: lanes.reduce((n, l) => n + l.items.length, 0), lanes });
const ok = (ackId) => ({ ack: { t: "input.ack", id: "s1", ackId, ok: true, state: "ok" } });

function rig({ answer, visible = false, sealed = false, start = 1_000_000 } = {}) {
  const store = memStore();
  let now = start;
  const sent = [];
  const env = {
    store,
    now: () => now,
    pageVisible: async () => visible,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ url, body, headers: init.headers });
      const a = await answer(body.frame, sent.length);
      if (a instanceof Error) throw a;
      const status = a.status ?? 200;
      return { status, ok: status >= 200 && status < 300, json: async () => a.body ?? a };
    },
  };
  const page = {
    hand: (p) => store.update([], handMutation(p, { hostId: HOST, label: "desk", sealed, ...(sealed ? {} : { token: "t".repeat(20) }) })),
    release: () => store.update(OWN_KEYS, releaseMutation(now)),
    beat: () => store.update(OWN_KEYS, heartbeatMutation(now)),
    claim: () => store.update(CLAIM_KEYS, claimMutation(now)),
  };
  return { store, env, sent, page, tick: (ms) => { now += ms; }, get now() { return now; } };
}

test("the page's store keys are the worker's", () => {
  assert.deepEqual({ ...RELAY_KEYS }, R.KEYS);
});

test("ownership: a beating page owns; a release or 150 s of silence hands it over; a claim takes it back", async () => {
  const r = rig({ answer: (f) => ok(f.ackId) });
  assert.equal(R.swOwns(undefined, r.now), false, "no record: nothing was ever handed");
  await r.page.beat();
  assert.equal(R.swOwns(r.store.m.get("own"), r.now), false);
  r.tick(R.OWN_STALE_MS + 1);
  assert.equal(R.swOwns(r.store.m.get("own"), r.now), true, "a silent page is taken for frozen");
  await r.page.claim();
  assert.equal(R.swOwns(r.store.m.get("own"), r.now), false);
  r.tick(1);
  await r.page.release();
  assert.equal(R.swOwns(r.store.m.get("own"), r.now), true);
  r.tick(1);
  await r.page.claim();
  assert.equal(R.swOwns(r.store.m.get("own"), r.now), false, "a claim after the release wins");
});

test("one row per lane per wake, in lane order; firstSentAt stamped at the first write, sentAt at each", async () => {
  const r = rig({ answer: (f) => ok(f.ackId) });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1"), input("a2")] }, { lane: "s2", items: [input("b1")] }]));
  await r.page.release();
  r.tick(5);
  const w1 = await R.runRelay(r.env);
  assert.deepEqual(r.sent.map((s) => s.body.frame.ackId), ["a1", "b1"]);
  assert.equal(w1.sent, 2);
  assert.equal(w1.more, true, "a2 is ready for another wake");
  for (const s of r.sent) {
    assert.equal(s.url, "/api/relay");
    assert.equal(s.body.waitMs, R.WAIT_MS);
    assert.equal(s.body.frame.firstSentAt, r.now);
    assert.equal(s.body.frame.sentAt, r.now);
    assert.match(s.headers.authorization, /^Bearer t+$/);
  }
  assert.deepEqual(Object.keys(r.store.m.get("written")).sort(), ["a1", "b1"]);
  r.tick(5);
  const w2 = await R.runRelay(r.env);
  assert.deepEqual(r.sent.map((s) => s.body.frame.ackId), ["a1", "b1", "a2"]);
  assert.equal(w2.more, false);
  const w3 = await R.runRelay(r.env);
  assert.equal(w3.reason, "empty");
  assert.equal(r.sent.length, 3, "answered rows are never sent again");
});

test("a row the page already attempted keeps its own firstSentAt", async () => {
  const r = rig({ answer: (f) => ok(f.ackId) });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1", { frame: { firstSentAt: 42 } })] }]));
  await r.page.release();
  await R.runRelay(r.env);
  assert.equal(r.sent[0].body.frame.firstSentAt, 42);
  assert.equal(r.store.m.get("written").a1, 42);
  assert.equal(r.sent[0].body.firstByRelay, undefined, "the page's stamp is an age the host may judge");
});

test("a row the page never attempted is sent as firstByRelay, on every try", async () => {
  const r = rig({ answer: (f) => ({ pending: true }) });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1")] }]));
  await r.page.release();
  await R.runRelay(r.env);
  assert.equal(r.sent[0].body.firstByRelay, true);
});

test("a refusing ack (may already have run) is kept as the row's receipt, not dropped", async () => {
  const r = rig({ answer: (f) => ({ ack: { t: "input.ack", id: "s1", ackId: f.ackId, ok: false, reason: "too long ago", retryable: false } }) });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1")] }]));
  await r.page.release();
  await R.runRelay(r.env);
  assert.equal(r.store.m.get("receipts").a1.reason, "too long ago");
});

test("a stopping verdict stops the lane and the receipt waits for the page; rescued goes on", async () => {
  const r = rig({ answer: (f) => f.ackId === "a1"
    ? { ack: { t: "input.ack", id: "s1", ackId: "a1", ok: false, state: "stale" } }
    : f.ackId === "b1" ? { ack: { t: "input.ack", id: "s1", ackId: "b1", ok: false, state: "rescued" } } : ok(f.ackId) });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1"), input("a2")] }, { lane: "s2", items: [input("b1"), input("b2")] }]));
  await r.page.release();
  await R.runRelay(r.env);
  const w2 = await R.runRelay(r.env);
  assert.deepEqual(r.sent.map((s) => s.body.frame.ackId), ["a1", "b1", "b2"], "a2 never overtakes a stopped a1");
  assert.equal(w2.stopped, 1);
  const c = await r.page.claim();
  assert.deepEqual(c.receipts.map((x) => x.ackId).sort(), ["a1", "b1", "b2"]);
  assert.deepEqual(c.written.map((x) => x.ackId).sort(), ["a1", "b1", "b2"]);
  assert.equal(r.store.m.has("receipts"), false, "a claim clears what it handed back");
});

test("retryable: the same ackId again after a backoff, at most MAX_TRIES, then the lane stops", async () => {
  const r = rig({ answer: (f) => ({ ack: { t: "input.ack", id: "s1", ackId: f.ackId, ok: false, state: "notready", retryable: true } }) });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1"), input("a2")] }]));
  await r.page.release();
  await R.runRelay(r.env);
  const early = await R.runRelay(r.env);
  assert.equal(r.sent.length, 1, "not before the backoff");
  assert.equal(early.waiting, 1);
  for (let i = 0; i < 5; i++) { r.tick(10 * 60_000); await R.runRelay(r.env); }
  assert.equal(r.sent.length, R.MAX_TRIES);
  assert.ok(r.sent.every((s) => s.body.frame.ackId === "a1"));
  assert.equal(new Set(r.sent.map((s) => s.body.frame.firstSentAt)).size, 1, "one firstSentAt across retries");
});

test("pending: written, no receipt, and the next wake re-sends the SAME ackId (the host joins it)", async () => {
  const r = rig({ answer: (f, n) => (n === 1 ? { pending: true } : ok(f.ackId)) });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1"), input("a2")] }]));
  await r.page.release();
  const w1 = await R.runRelay(r.env);
  assert.equal(w1.pending, 1);
  assert.equal(w1.transient, true);
  assert.equal(r.store.m.get("receipts"), undefined);
  const first = r.store.m.get("written").a1;
  r.tick(1000);
  await R.runRelay(r.env);
  assert.deepEqual(r.sent.map((s) => s.body.frame.ackId), ["a1", "a1"]);
  assert.equal(r.sent[1].body.frame.firstSentAt, first);
});

test("needsRelease rows wait for a person; a release of the SAME frame sends, of an edited one does not", async () => {
  const r = rig({ answer: (f) => ok(f.ackId) });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1", { needsRelease: true }), input("a2", { needsRelease: true })] }]));
  await r.page.release();
  const w = await R.runRelay(r.env);
  assert.equal(r.sent.length, 0);
  assert.equal(w.held.length, 2);
  const n = R.notice(w, null, "waterplane", true);
  assert.equal(n.body, "2 wait for you — open to review.");
  assert.deepEqual(n.actions, [{ action: "relay-send", title: "Send 2" }]);
  assert.deepEqual(R.notice(w, null, "waterplane", false).actions, [], "iOS draws no action");
  // The page edited a2 since the notification: same ackId, different frame — not released.
  await r.page.hand(plan([{ lane: "s1", items: [input("a1", { needsRelease: true }), input("a2", { needsRelease: true, frame: { data: "edited" } })] }]));
  assert.equal(await R.release(r.env, [...w.held, { ackId: "gone", key: "x" }]), 1, "only a1: a2 changed, `gone` left the plan");
  await R.runRelay(r.env);
  await R.runRelay(r.env);
  assert.deepEqual(r.sent.map((s) => s.body.frame.ackId), ["a1"]);
});

test("a claim between the worker's decision and its write stops the send; a receipt landing after a claim is kept for the next", async () => {
  let claimDuringFlight = null;
  const r = rig({ answer: async (f) => { if (claimDuringFlight) await claimDuringFlight(); return ok(f.ackId); } });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1"), input("a2")] }]));
  await r.page.release();
  let mid;
  claimDuringFlight = async () => { claimDuringFlight = null; r.tick(1); mid = await r.page.claim(); };
  await R.runRelay(r.env);
  assert.deepEqual(mid.written.map((w) => w.ackId), ["a1"], "the write was recorded before the request");
  assert.deepEqual(mid.receipts, []);
  const late = await r.page.claim();
  assert.deepEqual(late.receipts.map((x) => x.ackId), ["a1"], "the late receipt survived the claim");
  // The page owns now: the worker does not start a2.
  const w = await R.runRelay(r.env);
  assert.equal(w.reason, "page");
  assert.equal(r.sent.length, 1);
});

test("a visible page, a foreign plan, an old host and a refused sign-in send nothing", async () => {
  const vis = rig({ answer: (f) => ok(f.ackId), visible: true });
  await vis.page.hand(plan([{ lane: "s1", items: [input("a1")] }]));
  await vis.page.release();
  assert.equal((await R.runRelay(vis.env)).reason, "visible");
  assert.equal(vis.sent.length, 0);

  const old = rig({ answer: () => ({ status: 404, body: {} }) });
  await old.page.hand(plan([{ lane: "s1", items: [input("a1"), input("a2")] }]));
  await old.page.release();
  assert.equal((await R.runRelay(old.env)).reason, "unsupported");

  const auth = rig({ answer: () => ({ status: 401, body: {} }) });
  await auth.page.hand(plan([{ lane: "s1", items: [input("a1")] }]));
  await auth.page.release();
  const rep = await R.runRelay(auth.env);
  assert.equal(rep.reason, "auth");
  assert.match(R.notice(rep, null, "waterplane", true).body, /refused this phone's sign-in/);
});

test("sealed sign-ins: no token is stored, nothing is sent, and the notice says so only when something waits", async () => {
  const r = rig({ answer: (f) => ok(f.ackId), sealed: true });
  await r.page.hand(plan([{ lane: "s1", items: [input("a1")] }]));
  assert.equal(r.store.m.get("auth").token, undefined);
  await r.page.release();
  const rep = await R.runRelay(r.env);
  assert.equal(rep.reason, "sealed");
  assert.equal(r.sent.length, 0);
  assert.match(R.notice(rep, null, "waterplane", true).body, /sealed/);
  await r.page.hand(plan([]));
  const none = await R.runRelay(r.env);
  assert.equal(R.notice(none, null, "waterplane", true), null, "a sync wake with nothing waiting says nothing");
});

test("a push always gets words: what was sent, else the push's own body", () => {
  const push = { title: "desk is back", body: "desk is reachable again", hostLabel: "desk" };
  const empty = { sent: 0, pending: 0, held: [], reason: "empty", label: null };
  assert.deepEqual(R.notice(empty, push, "waterplane", true), { title: "desk is back", body: "desk is reachable again", actions: [], release: [] });
  const sent = { ...empty, sent: 2, pending: 0, reason: undefined, held: [{ ackId: "x", key: "k" }] };
  assert.equal(R.notice(sent, push, "waterplane", true).body, "Sent 2 to desk. 1 waits for you — open to review.");
  assert.equal(R.notice({ ...sent, held: [] }, null, "waterplane", true).title, "Sent 2 to the desktop");
});

test("sw.js: a link.back push with the relay loaded shows exactly one notification; other pushes as before", async () => {
  const SW = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");
  const RELAY = readFileSync(new URL("../../../public/swRelay.js", import.meta.url), "utf8");
  const on = {};
  const shown = [];
  const self = {
    addEventListener: (t, fn) => { on[t] = fn; },
    registration: { showNotification: (title, opts) => { shown.push({ title, opts }); return Promise.resolve(); } },
    clients: { matchAll: async () => [], openWindow: async () => {}, claim: async () => {} },
  };
  const ctx = vm.createContext({ self, URL, URLSearchParams, Response, caches: {}, console, setTimeout, Date, JSON, Promise, Object, Math });
  ctx.importScripts = () => vm.runInContext(RELAY, ctx);
  vm.runInContext(SW, ctx);
  assert.equal(typeof ctx.WPRelay, "object", "importScripts loaded the relay");
  const run = async (t, ev) => { const waits = []; on[t]({ ...ev, waitUntil: (p) => waits.push(p) }); await Promise.all(waits); };
  // No IndexedDB in this context: the relay finds nothing, and the push's own words show.
  await run("push", { data: { json: () => ({ kind: "link.back", id: "L1", ts: 1, title: "desk is back", body: "desk is reachable again", tag: "link.back", hostLabel: "desk" }) } });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, "desk is back");
  assert.equal(shown[0].opts.body, "desk is reachable again");
  await run("push", { data: { json: () => ({ kind: "git", id: "G1", ts: 1, title: "Push failed", body: "lint", tag: "g" }) } });
  assert.equal(shown.length, 2);
  assert.equal(shown[1].opts.body, "lint");
  assert.equal(shown[1].opts.requireInteraction, true);
});

test("the notice names every row left behind and every row the host refused", () => {
  const base = { sent: 1, pending: 0, held: [], stopped: 0, remaining: 3, reason: undefined, label: "studio" };
  assert.equal(R.notice(base, null, "waterplane", false).body, "2 wait for you — open to review.", "rows left in a lane (no Background Sync on iOS)");
  const push = { title: "studio is back", body: "studio is reachable again", hostLabel: "studio" };
  assert.equal(R.notice(base, push, "waterplane", false).body, "Sent 1 to studio. 2 wait for you — open to review.");
  const refused = { ...base, sent: 0, stopped: 1, remaining: 1 };
  assert.equal(R.notice(refused, null, "waterplane", false).body, "1 was not accepted by studio — open to review. 1 waits for you — open to review.", "a sync wake that sent nothing still says a prompt failed");
  const backoff = { ...base, sent: 0, remaining: 1 };
  assert.equal(R.notice(backoff, null, "waterplane", false), null, "a sync wake only backing off is not news");
});
