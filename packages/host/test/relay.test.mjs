// `POST /api/relay`'s core (`server/bgrelay.ts`) and the ledger's long keep
// (`acks.ts`'s `keepLong`, bg-link-send WP2).
//
// The stand-in socket goes through the real `clients.ts` bookkeeping (`send`,
// the watched union) with a fake handler standing in for the router, so what
// is pinned here is the relay's own contract: the one accept rule
// (`relayRefusal`) refuses before anything runs, the stand-in is never in
// `clients` and never counts as watching, it is sent receipts only, and the
// long keep is asked BEFORE the dispatch. The real route through a real host —
// a relayed submit, the page re-send re-acked and not retyped, 46 min later,
// the passive token — is `scripts/e2e-relay.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, RELAY_WAIT_MAX_MS, roleAllows, roleAfterHello } from "@waterplane/shared";

const scratch = mkdtempSync(join(tmpdir(), "wp-relay-"));
process.env[`${BRAND.envPrefix}ROOT`] ??= scratch;
const { createRelay, relayWaitMs, RELAY_WAIT_DEFAULT_MS } = await import("../dist/server/bgrelay.js");
const { createClients } = await import("../dist/server/clients.js");
const { AckLedger, ACK_TTL_MS, RELAY_KEEP_MS } = await import("../dist/acks.js");

const fakeAuth = {
  isEnabled: () => false, gateTailscale: () => false, canManage: () => true,
  needsToken: () => false, checkToken: () => true,
  devices: { get: () => null }, passive: { restricted: () => false },
};

/** The real clients bookkeeping, a recording ledger, and a handler you write per test. */
function rig(handler, known = new Set()) {
  const watched = [];
  const c = createClients({ auth: fakeAuth, notifyPrefs: { enabled: () => true }, push: { notify: async () => {} }, sessions: { setWatched: (s) => watched.push([...s]) } });
  const calls = [];
  const kept = [];
  const remembered = [];
  const deps = {
    attached: c.attached, clients: c.clients, wsKind: c.wsKind, wsToken: c.wsToken, wsDevice: c.wsDevice, wsRole: c.wsRole,
    acks: { keepLong: (id) => kept.push({ id, beforeDispatch: calls.length === 0 }), get: (id) => (known.has(id) ? { ok: true } : undefined), remember: (id, rec) => remembered.push({ id, ...rec }) },
    handleClientMessage: (ws, msg) => { calls.push({ ws, msg }); handler?.(c, ws, msg); },
  };
  return { c, calls, kept, remembered, watched, relay: createRelay(deps).relay };
}
const who = { kind: "tailscale", tok: "tok-1", deviceId: "dev-1" };
const submit = (ackId = "a-1") => ({ t: "session.input", id: "s1", data: "hello", submit: true, ackId });

test("the one accept rule refuses before anything runs (422, nothing dispatched, nothing kept)", async () => {
  const { relay, calls, kept } = rig();
  const cases = [
    [{}, /not a frame/],
    [{ frame: "x" }, /not a frame/],
    [{ frame: { t: "session.input", id: "s1", data: "hi", submit: true } }, /without an ackId/],
    [{ frame: { t: "session.input", id: "s1", data: "\u001b[A", ackId: "k" } }, /raw keys are never relayed/],
    [{ frame: { t: "hello", protocol: 2, ackId: "h" } }, /not something the background relay sends/],
    [{ frame: { t: "updates.apply", ackId: "u" } }, /not something the background relay sends/],
    [{ frame: { t: "session.attach", id: "s1", ackId: "x" } }, /not something/],
    [null, /not a frame/],
  ];
  for (const [body, why] of cases) {
    const r = await relay(body, who);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.match(r.body.refused, why);
  }
  assert.equal(calls.length, 0, "no refused frame reached the router");
  assert.equal(kept.length, 0, "nothing marked for a long keep");
});

test("an unknown ackId first sent past the ledger's life is answered with a remembered refusing ack; a known, fresh or relay-first one is not", async () => {
  const { RELAY_STALE_REFUSAL } = await import("../dist/server/bgrelay.js");
  const now = Date.now();
  const old = (ackId) => ({ ...submit(ackId), firstSentAt: now - 54 * 60_000, sentAt: now }); // 54 min old on the phone's clock
  const fresh = (ackId) => ({ ...submit(ackId), firstSentAt: now - 10 * 60_000, sentAt: now });
  const r1 = rig(undefined, new Set(["known-old"]));
  const stale = await r1.relay({ frame: old("lost-old"), waitMs: 20 }, who);
  assert.equal(stale.status, 200, "an ack the relay stores as the row's receipt, not a 422 it would drop");
  assert.deepEqual(stale.body, { ack: { t: "input.ack", id: "s1", ackId: "lost-old", ok: false, reason: RELAY_STALE_REFUSAL, retryable: false } });
  assert.equal(r1.calls.length, 0, "nothing ran");
  assert.deepEqual(r1.kept.map((k) => k.id), ["lost-old"], "kept long, so the page's own re-send hears the same");
  assert.deepEqual(r1.remembered, [{ id: "lost-old", ok: false, reason: RELAY_STALE_REFUSAL }]);
  const bl = await r1.relay({ frame: { t: "backlog.add", repoDir: "/r", text: "x", ackId: "b-old", firstSentAt: now - 54 * 60_000, sentAt: now }, waitMs: 20 }, who);
  assert.deepEqual(bl.body, { ack: { t: "backlog.ack", ackId: "b-old", ok: false, reason: RELAY_STALE_REFUSAL } });
  const op = await r1.relay({ frame: { t: "intent.post", ackId: "o-old", firstSentAt: now - 54 * 60_000, sentAt: now }, waitMs: 20 }, who);
  assert.deepEqual(op.body, { ack: { t: "op.ack", ackId: "o-old", ok: false, reason: RELAY_STALE_REFUSAL } });
  assert.equal(r1.remembered.find((m) => m.id === "o-old").op, true);
  assert.equal(r1.calls.length, 0);
  const known = await r1.relay({ frame: old("known-old"), waitMs: 20 }, who);
  assert.equal(known.status, 200, "a remembered ackId is re-acked whatever its age");
  assert.equal(r1.calls.length, 1);
  const young = await r1.relay({ frame: fresh("young"), waitMs: 20 }, who);
  assert.equal(young.status, 200);
  const never = await r1.relay({ frame: submit("never-tried"), waitMs: 20 }, who);
  assert.equal(never.status, 200, "a row never attempted carries no firstSentAt and runs");
  const before = r1.calls.length;
  await r1.relay({ frame: old("relay-first"), firstByRelay: true, waitMs: 20 }, who);
  assert.equal(r1.calls.length, before + 1, "the relay's own first stamp is not an age: unknown means it never arrived, so it runs");
});

test("accepted: submit, answer, backlog.add and a RELAY_OPS op reach the handler", async () => {
  const frames = [
    submit("i-1"),
    { t: "session.input", id: "s1", data: "2\r", expectPrompt: "fp", ackId: "i-2" },
    { t: "backlog.add", repoDir: "/r", text: "x", ackId: "b-1" },
    { t: "intent.post", ackId: "o-1" },
  ];
  const ackT = { "session.input": "input.ack", "backlog.add": "backlog.ack", "intent.post": "op.ack" };
  const { relay, calls } = rig((c, ws, msg) => c.send(ws, { t: ackT[msg.t], ackId: msg.ackId, ok: true }));
  for (const f of frames) {
    const r = await relay({ frame: f, waitMs: 1000 }, who);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ack: { t: ackT[f.t], ackId: f.ackId, ok: true } }, f.t);
  }
  assert.equal(calls.length, frames.length);
  assert.deepEqual(calls.map((x) => x.msg), frames, "the frame is handed over verbatim");
});

test("the stand-in: never in clients, never watching, role relay, the request's identity, receipts only", async () => {
  let seen;
  const { relay, c, kept } = rig((cl, ws, msg) => {
    seen = { inClients: cl.clients.has(ws), role: cl.wsRole.get(ws), kind: cl.wsKind.get(ws), tok: cl.wsToken.get(ws), device: cl.wsDevice.get(ws), att: cl.attached.has(ws) };
    // What a handler does to its asker: attach it (session.create), toast it, stream it, ack it.
    cl.attached.get(ws).add("s1");
    cl.recomputeWatched();
    seen.watching = cl.isAttachedToSomeone("s1");
    cl.send(ws, { t: "toast", text: "should never arrive" });
    cl.broadcast({ t: "session.list", sessions: [] });
    cl.send(ws, { t: "input.ack", ackId: "other", ok: true }); // someone else's receipt: ignored
    cl.send(ws, { t: "input.ack", ackId: msg.ackId, ok: false, state: "unconfirmed", reason: "r" });
  });
  const r = await relay({ frame: submit("i-9"), waitMs: 1000 }, who);
  assert.deepEqual(r.body, { ack: { t: "input.ack", ackId: "i-9", ok: false, state: "unconfirmed", reason: "r" } });
  assert.deepEqual(seen, { inClients: false, role: "relay", kind: "tailscale", tok: "tok-1", device: "dev-1", att: true, watching: false });
  assert.equal(c.clients.size, 0, "the stand-in never joined clients");
  assert.deepEqual(kept, [{ id: "i-9", beforeDispatch: true }], "the long keep is asked before the dispatch");
});

test("no verdict inside waitMs ⇒ pending; a late ack is dropped by the closed stand-in", async () => {
  let late;
  const { relay } = rig((c, ws, msg) => { late = () => c.send(ws, { t: "input.ack", ackId: msg.ackId, ok: true }); });
  const t0 = Date.now();
  const r = await relay({ frame: submit("p-1"), waitMs: 40 }, who);
  assert.deepEqual(r, { status: 200, body: { pending: true } });
  assert.ok(Date.now() - t0 >= 35, "waited about waitMs");
  assert.doesNotThrow(() => late());
});

test("waitMs: clamped to 0..RELAY_WAIT_MAX_MS, default when absent or junk", () => {
  assert.equal(relayWaitMs(undefined), RELAY_WAIT_DEFAULT_MS);
  assert.equal(relayWaitMs("100"), RELAY_WAIT_DEFAULT_MS);
  assert.equal(relayWaitMs(Number.NaN), RELAY_WAIT_DEFAULT_MS);
  assert.equal(relayWaitMs(-5), 0);
  assert.equal(relayWaitMs(10 * RELAY_WAIT_MAX_MS), RELAY_WAIT_MAX_MS);
  assert.equal(relayWaitMs(1234.9), 1234);
});

test("role relay: sent only the three receipts; never grantable by hello", () => {
  for (const t of ["input.ack", "backlog.ack", "op.ack"]) assert.equal(roleAllows("relay", t), true, t);
  for (const t of ["toast", "pty", "session.list", "notification", "welcome", "pong"]) assert.equal(roleAllows("relay", t), false, t);
  assert.equal(roleAfterHello("relay", undefined), undefined, "a page cannot declare itself the relay");
});

// ── the ledger's long keep ───────────────────────────────────────────────────

function ledgerRoot() {
  const root = mkdtempSync(join(tmpdir(), "wp-relay-acks-"));
  mkdirSync(join(root, BRAND.stateDirName), { recursive: true });
  return root;
}
/** Run `fn` with Date.now moved `ms` into the future. */
function later(ms, fn) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try { return fn(); } finally { Date.now = real; }
}

test("keepLong before the verdict: kept 24 h, persisted; an ordinary record is gone at 46 min", () => {
  const root = ledgerRoot();
  const l = new AckLedger(root);
  l.keepLong("relayed");
  l.remember("relayed", { ok: true, state: "ok" });
  l.remember("plain", { ok: true, state: "ok" });
  l.flush();
  const at46 = ACK_TTL_MS + 60_000;
  later(at46, () => {
    assert.equal(l.get("relayed")?.ok, true, "the relay's verdict outlives the ordinary TTL");
    assert.equal(l.get("plain"), undefined, "an ordinary one does not");
  });
  // Persisted: a restart 46 min later still re-acks it.
  const file = JSON.parse(readFileSync(join(root, BRAND.stateDirName, "acks.json"), "utf8"));
  assert.ok(file.acks.relayed.keepUntil >= file.acks.relayed.ts + RELAY_KEEP_MS - 1000);
  later(at46, () => {
    const again = new AckLedger(root);
    assert.equal(again.get("relayed")?.state, "ok");
    assert.equal(again.get("plain"), undefined);
  });
  later(RELAY_KEEP_MS + 60_000, () => assert.equal(new AckLedger(root).get("relayed"), undefined, "and is gone after 24 h"));
});

test("keepLong after the verdict (the page sent it first) extends that record and writes it now", () => {
  const root = ledgerRoot();
  const l = new AckLedger(root);
  l.remember("page-first", { ok: true });
  l.keepLong("page-first");
  // No flush: keepLong wrote it.
  const file = JSON.parse(readFileSync(join(root, BRAND.stateDirName, "acks.json"), "utf8"));
  assert.ok(typeof file.acks["page-first"].keepUntil === "number");
  later(ACK_TTL_MS + 60_000, () => assert.equal(l.get("page-first")?.ok, true));
});

test("a file written before keepUntil existed reads as it always did", () => {
  const root = ledgerRoot();
  const now = Date.now();
  writeFileSync(join(root, BRAND.stateDirName, "acks.json"), JSON.stringify({ updatedAt: now, acks: {
    fresh: { ts: now - 60_000, ok: true },
    stale: { ts: now - ACK_TTL_MS - 60_000, ok: true },
    shortKeep: { ts: now - ACK_TTL_MS - 60_000, ok: true, keepUntil: now - ACK_TTL_MS }, // never SHORTENS below the TTL
  } }));
  const l = new AckLedger(root);
  assert.equal(l.lost, null);
  assert.equal(l.get("fresh")?.ok, true);
  assert.equal(l.get("stale"), undefined);
  assert.equal(l.get("shortKeep"), undefined);
});

test("a retryable verdict is never remembered — the mark waits for the next attempt's", () => {
  const root = ledgerRoot();
  const l = new AckLedger(root);
  l.keepLong("retry-me");
  assert.equal(l.get("retry-me"), undefined, "a mark is not a verdict");
  l.remember("retry-me", { ok: true });
  later(ACK_TTL_MS + 60_000, () => assert.equal(l.get("retry-me")?.ok, true));
});
