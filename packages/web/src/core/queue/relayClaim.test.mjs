/**
 * The page taking the queue back from the background relay (`relayOwner.ts` + `wire.ts`'s
 * `applyRelayClaim`), run through the ONE flusher (`flushHarness.mjs`). At-most-once is the
 * subject: the page must not write before the claim has said what the relay already wrote,
 * and a row the relay wrote is the same send continuing — never re-decided, never re-aimed.
 * Plan: .claude/outbox/bg-link-send/PLAN.md (WP3).
 *
 *     node --test packages/web/src/core/queue/relayClaim.test.mjs
 */
import "../../../../../scripts/lib-tsload.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { makeHarness, row, T0 } = await import("./flushHarness.mjs");
const relay = await import("./relayOwner.ts");
const { relayReaimRefusal, claimWritten } = await import("./logic.ts");

/** A fake owner whose claim answers when the test says. */
function fakeOwner({ available = true } = {}) {
  const calls = [];
  const hands = [];
  let releases = 0;
  const o = {
    kind: "apk",
    available: async () => available,
    hand: (p) => { hands.push(p); },
    release: () => { releases++; },
    claim: () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }),
  };
  return { o, calls, hands, get releases() { return releases; } };
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** A harness with the relay wired as `useQueue` wires it: apply on claim, flush on open. */
async function withRelay(opts, fn) {
  const h = await makeHarness(opts);
  relay.resetRelayForTest();
  try {
    const owner = fakeOwner(opts.owner);
    relay.installRelayOwner(owner.o, globalThis.window);
    relay.onRelayClaim((c) => h.fns.applyRelayClaim(c));
    relay.onRelayOpen(() => { h.fns.flushOutbox(); });
    await fn(h, owner);
  } finally {
    relay.resetRelayForTest();
    h.restore();
  }
}

test("no flush before the claim: the gate holds from install until the claim is applied", async () => {
  await withRelay({ rows: [row("a")] }, async (h, owner) => {
    assert.equal(relay.relayHeld(), true, "held at install, before anything can flush");
    assert.equal(h.fns.flushOutbox(), 0);
    assert.equal(h.fns.flushOutbox(true), 0, "not even the explicit Send all");
    assert.deepEqual(h.sends(), []);
    assert.equal(h.c.flushIdleReason.current, "taking the queue back from the background link");
    assert.equal(owner.calls.length, 1, "the boot claim was asked");
    owner.calls[0].resolve({ receipts: [], written: [] });
    await settle();
    assert.equal(relay.relayHeld(), false);
    assert.deepEqual(h.sends().map((f) => f.ackId), ["a"], "the open flushed");
  });
});

test("receipts drop their rows through the queue's own handlers, and the lane goes on", async () => {
  await withRelay({ rows: [row("a"), row("b")] }, async (h, owner) => {
    owner.calls[0].resolve({
      receipts: [{ t: "input.ack", ackId: "a", ok: true }],
      written: [{ ackId: "a", firstSentAt: T0 - 5000 }],
    });
    await settle();
    assert.equal(h.entry("a"), undefined, "the ok receipt retired the row");
    assert.equal(h.c.ackTimers.current.has("a"), false, "and cleared the timer the written row armed");
    h.advance(1000); // the lane gap after the receipt
    assert.ok(h.sends().every((f) => f.ackId !== "a"), "a is never re-sent");
    assert.ok(h.sends().some((f) => f.ackId === "b"), "b follows");
  });
});

test("a written row becomes pending with the EARLIEST firstTryAt and its ack timer armed", async () => {
  const rows = [
    row("a", { attempts: 1, firstTryAt: T0 - 1000 }),      // the relay wrote it earlier than the page first tried
    row("x", { sessionId: "s2", attempts: 1, firstTryAt: T0 - 60_000 }), // the page's own first try is earlier
  ];
  await withRelay({ rows }, async (h, owner) => {
    owner.calls[0].resolve({
      receipts: [],
      written: [{ ackId: "a", firstSentAt: T0 - 9000 }, { ackId: "x", firstSentAt: T0 - 2000 }],
    });
    await settle();
    const a = h.entry("a");
    assert.equal(a.status, "pending");
    assert.equal(a.firstTryAt, T0 - 9000, "min(own, relay's)");
    assert.equal(a.relayedAt, T0 - 9000);
    assert.equal(a.attempts, 2, "the relay's write is an attempt");
    assert.equal(a.armed, true, "the relay sent it: the reconnect question is not about it any more");
    assert.ok(h.c.ackTimers.current.has("a"), "its receipt is awaited");
    assert.equal(h.entry("x").firstTryAt, T0 - 60_000, "the page's earlier first try is kept");
    assert.ok(h.sends().every((f) => f.ackId !== "a" && f.ackId !== "x"), "pending: not written a second time on open");
    // No receipt in the window: the SAME ackId goes again, carrying the earliest first-send stamp.
    h.advance(h.fns.ackWindowFor(h.entry("a")));
    for (let i = 0; i < 60 && !h.sends().some((f) => f.ackId === "a"); i++) { h.advance(1000); h.fns.flushOutbox(); }
    const again = h.sends().find((f) => f.ackId === "a");
    assert.ok(again, "re-sent under the same ackId — the host joins or re-acks it");
    assert.equal(again.firstSentAt, T0 - 9000);
  });
});

test("a retryable receipt for a written row requeues it, as on the page's own socket", async () => {
  await withRelay({ rows: [row("a")] }, async (h, owner) => {
    owner.calls[0].resolve({
      receipts: [{ t: "input.ack", ackId: "a", ok: false, retryable: true, reason: "the session is starting" }],
      written: [{ ackId: "a", firstSentAt: T0 - 3000 }],
    });
    await settle();
    const a = h.entry("a");
    assert.equal(a.status, "queued");
    assert.ok(a.retryAt > h.now, "backed off");
    assert.equal(a.waitReason, "the session is starting");
    assert.equal(a.firstTryAt, T0 - 3000);
  });
});

test("socket down at claim: a written row stays queued as an attempted retry, armed", async () => {
  await withRelay({ rows: [row("a", { armed: false, offline: true })], status: "closed" }, async (h, owner) => {
    owner.calls[0].resolve({ receipts: [], written: [{ ackId: "a", firstSentAt: T0 - 4000 }] });
    await settle();
    const a = h.entry("a");
    assert.equal(a.status, "queued");
    assert.equal(a.attempts, 1);
    assert.equal(a.armed, true);
    assert.equal(h.c.ackTimers.current.has("a"), false, "no timer without a socket");
  });
});

test("re-aim is refused on a written row, and while the claim holds", () => {
  const [a] = claimWritten([row("a")], [{ ackId: "a", firstSentAt: T0 }], true, T0).list;
  assert.match(relayReaimRefusal(a, false), /background link already sent it/);
  assert.match(relayReaimRefusal(row("b"), true), /taking the queue back/);
  assert.equal(relayReaimRefusal(row("b"), false), null);
});

test("a claim that keeps failing is retried, then the page flushes anyway after 10 s", async () => {
  await withRelay({ rows: [row("a")] }, async (h, owner) => {
    owner.calls[0].reject(new Error("bridge"));
    await settle();
    h.advance(relay.CLAIM_RETRY_MS);
    assert.equal(owner.calls.length, 2, "retried");
    assert.equal(h.fns.flushOutbox(), 0, "still held");
    for (let i = 1; i < owner.calls.length + 20 && relay.relayHeld(); i++) {
      owner.calls.at(-1).reject(new Error("bridge"));
      await settle();
      h.advance(relay.CLAIM_RETRY_MS);
    }
    assert.equal(relay.relayHeld(), false, "the give-up opened the gate");
    assert.ok(h.now - T0 <= relay.CLAIM_GIVE_UP_MS + relay.CLAIM_RETRY_MS);
    assert.ok(h.sends().some((f) => f.ackId === "a"), "and flushed");
  });
});

test("resume re-claims: held again until that claim lands; a second resume joins it", async () => {
  await withRelay({ rows: [] }, async (h, owner) => {
    owner.calls[0].resolve({ receipts: [], written: [] });
    await settle();
    assert.equal(relay.relayHeld(), false);
    relay.reclaimRelay();
    relay.reclaimRelay();
    assert.equal(relay.relayHeld(), true);
    assert.equal(owner.calls.length, 2, "one claim per resume, joined");
    owner.calls[1].resolve({ receipts: [], written: [] });
    await settle();
    assert.equal(relay.relayHeld(), false);
  });
});

test("the plan is handed once the owner is confirmed, and release hands the freshest first", async () => {
  await withRelay({ rows: [] }, async (h, owner) => {
    let n = 0;
    relay.publishRelayPlan(() => ({ hostId: "h1", v: 1, issuedAt: ++n, lanes: [], depth: 0 }));
    await settle();
    assert.equal(owner.hands.length >= 1, true, "handed after available() said yes");
    const before = owner.hands.length;
    relay.releaseRelay();
    assert.equal(owner.hands.length, before + 1);
    assert.equal(owner.releases, 1);
  });
});

test("no owner (a browser, an older APK): never held, the flusher is exactly as before", async () => {
  const h = await makeHarness({ rows: [row("a")] });
  relay.resetRelayForTest();
  try {
    relay.installRelayOwner(null);
    assert.equal(relay.relayHeld(), false);
    assert.equal(h.fns.flushOutbox(), 1);
    relay.releaseRelay(); relay.reclaimRelay();
    assert.equal(relay.relayHeld(), false);
  } finally { relay.resetRelayForTest(); h.restore(); }
});

test("an owner without the relay cap is dropped and the gate opens", async () => {
  const h = await makeHarness({ rows: [row("a")] });
  relay.resetRelayForTest();
  try {
    const owner = fakeOwner({ available: false });
    relay.installRelayOwner(owner.o, globalThis.window);
    relay.onRelayClaim((c) => h.fns.applyRelayClaim(c));
    relay.onRelayOpen(() => { h.fns.flushOutbox(); });
    await settle();
    assert.equal(relay.relayHeld(), false);
    assert.deepEqual(h.sends().map((f) => f.ackId), ["a"]);
  } finally { relay.resetRelayForTest(); h.restore(); }
});

test("the claim is not asked until a queue can apply it: a page that dies before mounting loses nothing", async () => {
  relay.resetRelayForTest();
  try {
    const owner = fakeOwner();
    relay.installRelayOwner(owner.o, globalThis.window);
    await settle();
    assert.equal(owner.calls.length, 0, "boot claim waits: it would empty the owner's store with nobody to apply it");
    assert.equal(relay.relayHeld(), true, "the gate holds meanwhile");
    let applied = 0;
    relay.onRelayClaim(() => { applied++; });
    assert.equal(owner.calls.length, 1, "asked the moment the queue registers");
    owner.calls[0].resolve({ receipts: [], written: [] });
    await settle();
    assert.equal(applied, 1);
    assert.equal(relay.relayHeld(), false);
  } finally {
    relay.resetRelayForTest();
  }
});

test("the gate opening flushes only once the reconnect drain has run for the open link", () => {
  assert.equal(relay.relayOpenFlushes("open", false), true, "a visible/resume claim in a drained session");
  assert.equal(relay.relayOpenFlushes("open", true), false, "the drain was deferred behind the gate: it asks first");
  assert.equal(relay.relayOpenFlushes("closed", false), false, "the open edge has not been seen: the drain runs on it");
  assert.equal(relay.relayOpenFlushes(null, false), false);
});

test("the claim's count says sent only for rows the host took or holds, never for a refusal", async () => {
  const h = await makeHarness({ rows: [row("ok"), row("nope", { sessionId: "s2" }), row("held", { sessionId: "s3" }), row("rescued", { sessionId: "s4" })] });
  try {
    const n = h.fns.applyRelayClaim({
      receipts: [
        { t: "input.ack", ackId: "ok", ok: true },
        { t: "input.ack", ackId: "nope", ok: false, reason: "the session ended" },
        { t: "input.ack", ackId: "rescued", ok: false, state: "rescued" },
      ],
      written: [
        { ackId: "ok", firstSentAt: T0 - 5000 }, { ackId: "nope", firstSentAt: T0 - 5000 },
        { ackId: "held", firstSentAt: T0 - 5000 }, { ackId: "rescued", firstSentAt: T0 - 5000 },
      ],
    });
    assert.equal(n, 3, "ok + rescued + the held (written, no receipt yet); the refused row is not counted");
    assert.equal(h.fns.applyRelayClaim({ receipts: [{ t: "input.ack", ackId: "gone", ok: true }], written: [] }), 0, "an unknown ackId counts nothing");
  } finally { h.restore(); }
});

test("going to the background hands the freshest plan, with no queue write and no freeze", async () => {
  await withRelay({ rows: [row("a")] }, async (h, owner) => {
    await settle();
    let facts = "auto-on";
    relay.publishRelayPlan(() => ({ v: 1, hostId: "h", depth: 1, lanes: [], issuedAt: 0, facts }));
    const before = owner.hands.length;
    const listeners = {};
    const doc = { visibilityState: "visible", addEventListener: (t, fn) => { listeners[t] = fn; } };
    const had = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
    try {
      relay.installRelayLifecycle();
      facts = "auto-off"; // changed with no queue write
      doc.visibilityState = "hidden";
      listeners.visibilitychange();
      assert.equal(owner.hands.length, before + 1, "the plan was built again and handed");
      assert.equal(owner.hands.at(-1).facts, "auto-off");
    } finally {
      if (had) Object.defineProperty(globalThis, "document", had); else delete globalThis.document;
    }
  });
});
