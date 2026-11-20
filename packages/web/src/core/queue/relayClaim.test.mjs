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
import { readFileSync } from "node:fs";

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
    assert.equal(a.relayedAt, T0 - 3000, "a claim's retryable receipt can be older than the relay's last write (a later attempt may be in flight): the row stays the relay's, locked");
  });
});

test("a retryable ack on the page's own socket hands a relayed row back (nothing ran, nothing in flight)", async () => {
  await withRelay({ rows: [row("a")] }, async (h, owner) => {
    owner.calls[0].resolve({ receipts: [], written: [{ ackId: "a", firstSentAt: T0 - 3000 }] });
    await settle();
    assert.equal(h.entry("a").relayedAt, T0 - 3000);
    h.fns.onInputAck({ t: "input.ack", ackId: "a", ok: false, retryable: true, reason: "the session is starting" });
    assert.equal(h.entry("a").relayedAt, undefined, "a live retryable proves nothing ran: editable, discardable, re-aimable");
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

test("relayRefusal refuses an empty expectPrompt (an answer must name its question)", async () => {
  const { relayRefusal } = await import("@waterplane/shared");
  assert.equal(relayRefusal({ t: "session.input", ackId: "a", expectPrompt: "" }) !== null, true);
  assert.equal(relayRefusal({ t: "session.input", ackId: "a", expectPrompt: "fp1" }), null);
  assert.equal(relayRefusal({ t: "session.input", ackId: "a", submit: true }), null);
});

test("a row the relay wrote is not editable or rewritable while live; one the host said never ran is free", async () => {
  const { isEditableEntry } = await import("../../outbox.ts");
  const { isRelayedLive } = await import("../../relayedRow.ts");
  const [a] = claimWritten([row("a")], [{ ackId: "a", firstSentAt: T0 }], false, T0).list;
  assert.equal(a.status, "queued");
  assert.equal(isRelayedLive(a), true);
  assert.equal(isEditableEntry(a), false, "the desktop holds the old words");
  assert.equal(isEditableEntry(row("b")), true);
  const refused = { ...a, status: "failed", reason: "no such repo", failState: "refused", failedAt: T0 };
  assert.equal(isRelayedLive(refused), false, "op.ack ok:false: nothing was started");
  const stale = { ...a, status: "failed", reason: "that question is gone", failState: "stale", failedAt: T0 };
  assert.equal(isRelayedLive(stale), false, "a stale answer: nothing was written");
});

test("a relayed row that failed with no host word that it never ran stays locked", async () => {
  const { isRelayedLive, hostSaidNotRun } = await import("../../relayedRow.ts");
  const { LOST_LEDGER_REFUSAL, RELAY_STALE_REFUSAL } = await import("@waterplane/shared");
  const [a] = claimWritten([row("a")], [{ ackId: "a", firstSentAt: T0 }], false, T0).list;
  const locked = [
    // A local give-up (orphaned create, overflow, a pending-create cascade): no failState at all.
    { ...a, status: "failed", reason: "the session never opened", failedAt: T0 },
    // failOutbox's default: nobody recorded whether it ran.
    { ...a, status: "failed", reason: "could not queue", failState: "other", failedAt: T0 },
    // Typed into a screen the desktop could not read back: it may have run.
    { ...a, status: "failed", reason: "unconfirmed", failState: "unconfirmed", failedAt: T0 },
    { ...a, status: "failed", reason: "in the composer", failState: "unsubmitted", failedAt: T0 },
    // `refused` on the wire, but the host's own words say it may already have run.
    { ...a, status: "failed", reason: LOST_LEDGER_REFUSAL, failState: "refused", failedAt: T0 },
    { ...a, status: "failed", reason: RELAY_STALE_REFUSAL, failState: "refused", failedAt: T0 },
  ];
  for (const e of locked) {
    assert.equal(hostSaidNotRun(e), false, `${e.failState}: ${e.reason}`);
    assert.equal(isRelayedLive(e), true, `locked: ${e.failState}: ${e.reason}`);
  }
  // Without relayedAt the page's own failed rows are unaffected.
  assert.equal(isRelayedLive({ ...locked[1], relayedAt: undefined }), false);
});

test("the relay's local give-up through the flusher leaves the row locked; a host refusal frees it", async () => {
  const { verbFns } = await import("./verbs.ts");
  await withRelay({ rows: [row("a"), row("r")] }, async (h, owner) => {
    owner.calls[0].resolve({ receipts: [], written: [{ ackId: "a", firstSentAt: T0 - 1000 }, { ackId: "r", firstSentAt: T0 - 1000 }] });
    await settle();
    h.c.failOutbox("a", "delivery kept failing");
    h.c.failOutbox("r", "no such repo", "refused");
    const v = verbFns({ ...h.c, showToast() {}, sessions: [], setCompose() {}, repoForCwd: () => null });
    assert.equal(v.removeQueued("a"), false, "a local failure proves nothing: the words may have run");
    assert.ok(h.entry("a"));
    assert.equal(v.editQueued("a", "new words"), false);
    assert.equal(v.removeQueued("r"), true, "the host said it never started");
  });
});

test("edit and discard report a refusal to the caller; a relayed row the host refused can be discarded", async () => {
  const { verbFns } = await import("./verbs.ts");
  await withRelay({ rows: [row("a"), row("f")] }, async (h, owner) => {
    owner.calls[0].resolve({ receipts: [], written: [{ ackId: "a", firstSentAt: T0 - 1000 }, { ackId: "f", firstSentAt: T0 - 1000 }] });
    await settle();
    h.c.failOutbox("f", "refused", "refused");
    assert.ok(h.entry("f").relayedAt != null && h.entry("f").status === "failed", "relayedAt stays on a failed row");
    const v = verbFns({ ...h.c, showToast() {}, sessions: [], setCompose() {}, repoForCwd: () => null });
    assert.equal(v.editQueued("a", "new words"), false, "refused: the caller must not say edited");
    assert.equal(h.entry("a").text, "words of a");
    assert.equal(v.removeQueued("a"), false, "refused: the caller must not copy the words or say discarded");
    assert.ok(h.entry("a"));
    assert.equal(v.removeQueued("f"), true, "the host said it never ran, so it can go");
    assert.equal(h.entry("f"), undefined);
  });
});

test("a Send sheet opened on a queue row refuses only once the desktop confirmed that row", async () => {
  const { seedRowGone, noteReceiptRemoval } = await import("../../relayedRow.ts");
  const rows = [{ ackId: "X" }, { ackId: "Y" }];
  assert.equal(seedRowGone("X", rows), false, "row still queued: the rewrite may go");
  // Dismiss / cancel from the main pane while a wide window's Send panel is open: nothing ran.
  assert.equal(seedRowGone("X", [{ ackId: "Y" }]), false, "removed locally, never confirmed: the words may be sent");
  noteReceiptRemoval("X");
  assert.equal(seedRowGone("X", [{ ackId: "Y" }]), true, "confirmed and removed while the sheet sat open");
  assert.equal(seedRowGone("X", rows), false, "a row that is back in the queue is not gone");
  assert.equal(seedRowGone(undefined, []), false, "a sheet not opened on a row has nothing to be gone");
});

test("a Send sheet on a relayed row refuses to post; on a row the host refused it may", async () => {
  const { seedRewriteRefusal, relayedRefusal, noteReceiptRemoval, SEED_ROW_GONE_WHY } = await import("../../relayedRow.ts");
  const [a] = claimWritten([row("a")], [{ ackId: "a", firstSentAt: T0 }], false, T0).list;
  assert.equal(seedRewriteRefusal("a", [a]), relayedRefusal("rewritten"), "live relayed row: a new ackId would run it twice");
  const localFail = { ...a, status: "failed", reason: "the session never opened", failedAt: T0 };
  assert.equal(seedRewriteRefusal("a", [localFail]), relayedRefusal("rewritten", localFail), "a local give-up proves nothing");
  assert.equal(seedRewriteRefusal("a", [{ ...localFail, failState: "refused", reason: "no such repo" }]), null, "the host said it never started");
  assert.equal(seedRewriteRefusal("b", [row("b")]), null, "a page row the relay never wrote");
  assert.equal(seedRewriteRefusal(undefined, []), null);
  noteReceiptRemoval("gone1");
  assert.equal(seedRewriteRefusal("gone1", []), SEED_ROW_GONE_WHY, "confirmed while the sheet sat open");
});

test("Discard on a Send sheet: refused on a relayed row (the row stays), gone once confirmed, else removed", async () => {
  const { verbFns } = await import("./verbs.ts");
  const { seedDiscard, noteReceiptRemoval } = await import("../../relayedRow.ts");
  await withRelay({ rows: [row("a"), row("p")] }, async (h, owner) => {
    owner.calls[0].resolve({ receipts: [], written: [{ ackId: "a", firstSentAt: T0 - 1000 }] });
    await settle();
    const v = verbFns({ ...h.c, showToast() {}, sessions: [], setCompose() {}, repoForCwd: () => null });
    const outbox = () => h.c.outboxRef.current;
    assert.equal(seedDiscard("a", outbox(), v.removeQueued), "refused");
    assert.ok(h.entry("a"), "the relayed row is still queued");
    h.c.failOutbox("a", "delivery kept failing");
    assert.equal(seedDiscard("a", outbox(), v.removeQueued), "refused", "failed locally: still locked");
    assert.equal(seedDiscard("p", outbox(), v.removeQueued), "removed");
    assert.equal(h.entry("p"), undefined);
    noteReceiptRemoval("c");
    assert.equal(seedDiscard("c", outbox(), () => { throw new Error("must not be asked"); }), "gone");
    assert.equal(seedDiscard(undefined, outbox(), v.removeQueued), "none");
  });
});

// ── A stuck relayed row: failed with no host word that it never ran. It is locked for good, so it
// must not be told "it leaves the queue when the desktop confirms", and it needs a way out that
// sends nothing.

/** The six stuck variants (the locked list above), from one relayed row. */
async function stuckRows() {
  const { LOST_LEDGER_REFUSAL, RELAY_STALE_REFUSAL } = await import("@waterplane/shared");
  const [a] = claimWritten([row("a")], [{ ackId: "a", firstSentAt: T0 }], false, T0).list;
  return { a, stuck: [
    { ...a, status: "failed", reason: "the session never opened", failedAt: T0 },
    { ...a, status: "failed", reason: "could not queue", failState: "other", failedAt: T0 },
    { ...a, status: "failed", reason: "unconfirmed", failState: "unconfirmed", failedAt: T0 },
    { ...a, status: "failed", reason: "in the composer", failState: "unsubmitted", failedAt: T0 },
    { ...a, status: "failed", reason: LOST_LEDGER_REFUSAL, failState: "refused", failedAt: T0 },
    { ...a, status: "failed", reason: RELAY_STALE_REFUSAL, failState: "refused", failedAt: T0 },
  ] };
}

test("the refusal is true per case: a live relayed row leaves on the receipt, a stuck one is told the way out", async () => {
  const r = await import("../../relayedRow.ts");
  const { a, stuck } = await stuckRows();
  for (const live of [a, { ...a, status: "pending" }]) {
    assert.equal(r.isRelayedStuck(live), false);
    assert.equal(r.relayedWhy(live), r.RELAYED_WHY);
    assert.match(r.relayedRefusal("discarded", live), /it can't be discarded; it leaves the queue when the desktop confirms$/);
    assert.doesNotMatch(r.relayedRefusal("discarded", live), /remove from the list/);
  }
  for (const e of stuck) {
    const what = `${e.failState}: ${e.reason}`;
    assert.equal(r.isRelayedStuck(e), true, what);
    assert.equal(r.relayedWhy(e), r.RELAYED_STUCK_WHY, what);
    for (const s of [r.relayedWhy(e), r.relayedRefusal("rewritten", e)]) {
      assert.doesNotMatch(s, /leaves the queue|when (the desktop|it) confirms/, `${what}: no receipt is coming`);
      assert.match(s, /never said whether it ran/, what);
      assert.ok(s.includes(`“${r.RELAYED_REMOVE_LABEL}”`), `${what}: names the way out as drawn`);
    }
    assert.match(r.relayedRefusal("rewritten", e), /it can't be rewritten/);
    assert.equal(r.seedRewriteRefusal("a", [e]), r.relayedRefusal("rewritten", e), `${what}: the Send sheet says the same`);
  }
  // Neither stuck nor live: the host said it never ran, or the relay never wrote it.
  const freed = { ...a, status: "failed", reason: "no such repo", failState: "refused", failedAt: T0 };
  assert.equal(r.isRelayedStuck(freed), false);
  assert.equal(r.isRelayedStuck({ ...stuck[1], relayedAt: undefined }), false, "a page row the relay never wrote");
});

test("the way out is offered only to a stuck row, asks first, removes locally and never sends", async () => {
  const r = await import("../../relayedRow.ts");
  const { a, stuck } = await stuckRows();
  const freed = { ...a, status: "failed", reason: "no such repo", failState: "refused", failedAt: T0 };
  const never = () => { throw new Error("must not be asked"); };
  for (const e of [a, { ...a, status: "pending" }, freed, row("p")]) {
    assert.equal(await r.removeRelayedStuck(e, { ask: never, remove: never, toast: never }), "refused", `${e.status}/${e.failState}`);
  }
  for (const e of stuck) {
    assert.equal(await r.removeRelayedStuck(e, { ask: async () => false, remove: never, toast: never }), "kept", "no: the row stays");
    const asked = []; const removed = []; const toasts = [];
    const out = await r.removeRelayedStuck(e, {
      ask: async (q) => { asked.push(q); return true; },
      remove: (id) => { removed.push(id); return true; },
      toast: (s) => toasts.push(s),
    });
    assert.equal(out, "removed");
    assert.deepEqual(removed, ["a"]);
    assert.equal(asked[0], r.RELAYED_REMOVE_ASK);
    assert.equal(asked[0].confirmLabel, r.RELAYED_REMOVE_LABEL);
    assert.match(asked[0].lines.join(" "), /may have/, "the ask says it may already have run");
    assert.match(asked[0].lines.join(" "), /cancels nothing and sends nothing/);
    assert.deepEqual(toasts, [r.RELAYED_REMOVED]);
    assert.doesNotMatch(r.RELAYED_REMOVED, /discard|cancel(ed)? it|sent again/i, "never claims a cancel");
  }
  // The queue's own verb: `mayHaveRun` unlocks a stuck row only, and nothing goes on the wire.
  const { verbFns } = await import("./verbs.ts");
  await withRelay({ rows: [row("a"), row("q")] }, async (h, owner) => {
    owner.calls[0].resolve({ receipts: [], written: [{ ackId: "a", firstSentAt: T0 - 1000 }, { ackId: "q", firstSentAt: T0 - 1000 }] });
    await settle();
    h.c.failOutbox("a", "delivery kept failing");
    const v = verbFns({ ...h.c, showToast() {}, sessions: [], setCompose() {}, repoForCwd: () => null });
    const sent = h.sends().length;
    assert.equal(v.removeQueued("q", { mayHaveRun: true }), false, "a LIVE relayed row is never unlocked: its receipt is coming");
    assert.ok(h.entry("q"));
    assert.equal(v.removeQueued("a"), false, "a plain discard of a stuck row stays refused");
    assert.equal(v.editQueued("a", "new words"), false, "its words stay as they are");
    assert.equal(r.seedRewriteRefusal("a", h.outbox()) != null, true, "no rewrite under a new ackId");
    assert.equal(v.removeQueued("a", { mayHaveRun: true }), true);
    assert.equal(h.entry("a"), undefined);
    assert.equal(h.sends().length, sent, "removing it sent nothing");
  });
});

test("Activity: a stuck relayed row draws 'remove from the list' instead of discard; rewrite and fix stay refused", async () => {
  const r = await import("../../relayedRow.ts");
  const { queueRow } = await import("../../activity/activityQueueRow.ts");
  const deps = { isEditableEntry: () => false, isCreateOp: () => false, laneLabel: (e) => e.sessionId, repoName: (cwd) => cwd };
  const input = { now: T0, online: true, hostSeenAt: T0 - 1000, deps };
  const { a, stuck } = await stuckRows();
  const acts = (e) => Object.fromEntries(queueRow(e, input).actions.map((x) => [x.id, x]));
  for (const e of stuck) {
    const x = acts(e);
    assert.equal(x.discard.label, r.RELAYED_REMOVE_LABEL, `${e.failState}`);
    assert.equal(x.discard.disabledReason, undefined, "the way out is offered");
    assert.equal(x.edit.disabledReason, r.RELAYED_STUCK_WHY, "no rewrite under a new ackId");
    assert.equal(x.fix.disabledReason, r.RELAYED_STUCK_WHY);
    assert.notEqual(x.edit.primary, true, "a refused rewrite never leads the row");
    // "try again" re-sends the SAME ackId (the ledger re-acks a run) or is refused; its sentence never
    // sends the person to a rewrite.
    assert.doesNotMatch(x.sendNow.disabledReason ?? "", /rewrite/, `${e.failState}: no rewrite offered`);
  }
  const live = acts(a);
  assert.equal(live.discard.label, "discard", "a live row is not offered the way out");
  assert.equal(live.discard.disabledReason, r.RELAYED_WHY);
  assert.equal(live.edit.disabledReason, r.RELAYED_WHY);
});

// The callers that cannot load in node (React components; features import the SDK barrel): pin
// that each asks the relayed-row rule before the act it guards. Behaviour is the tests above.
const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const fnBody = (text, head) => {
  const at = text.indexOf(head);
  assert.ok(at >= 0, `missing: ${head}`);
  return text.slice(at, at + 4000);
};

test("pins: useSend's rewrite path refuses through seedRewriteRefusal before any send arm", () => {
  const body = fnBody(src("../send/useSend.tsx"), "function dispatchIntent(");
  const guard = body.indexOf("seedRewriteRefusal(seed.ackId, outboxRef.current)");
  assert.ok(guard > 0, "dispatchIntent asks seedRewriteRefusal");
  assert.match(body.slice(guard, guard + 200), /if \(refusal\) \{ showToast\(refusal\); return false; \}/);
  const firstSend = body.search(/queueOp|addOutbox|queueBacklog|sendIntentPost|liveSend\(/);
  assert.ok(firstSend < 0 || guard < firstSend, "the guard runs before anything is posted");
});

test("pins: the Send sheet's Discard goes through seedDiscard and stops on a refusal", () => {
  const body = fnBody(src("../send/SendSheetEntry.tsx"), "onDiscard=");
  assert.match(body, /const row = seedDiscard\(sendSeed\.ackId, p\.outbox, removeQueued\);\s*if \(row === "refused"\) return;/);
  assert.match(body, /row === "gone" \? SEED_ROW_GONE_DISCARD : "discarded"/);
});

test("pins: QueueSheet draws neither 'back to the box' nor 'rewrite' on a relayed row, and says why", () => {
  const s = src("../../QueueSheet.tsx");
  assert.match(s, /const relayedHere = isRelayedLive\(e\);/);
  assert.match(s, /const relayedOwner = !!resendTarget && isRelayedLive\(resendTarget\);/);
  assert.match(s, /\{!isOp && !isUpload && !isAnswer && !relayedHere && \(/, "back-to-the-box button gated");
  assert.match(s, /\{!isAnswer && !!resendTarget && !relayedOwner && \(/, "rewrite button gated");
  assert.match(s, /relayedOwner \? \[\{ label: "rewrite it and send again", reason:/, "the refusal is a sentence");
});

test("pins: Activity's rewrite/fix and the queue feature's resend refuse a relayed row before opening Send", () => {
  for (const [file, head] of [["../../features/activity/actions.ts", 'case "queue": {'], ["../../features/queue/actions.ts", "export function resend("]]) {
    const body = fnBody(src(file), head);
    const guard = body.indexOf('if (isRelayedLive(e)) { c.say.toast(relayedRefusal("rewritten", e)); return; }');
    assert.ok(guard > 0, `${file}: guard present`);
    assert.ok(guard < body.indexOf("c.nav.openSend("), `${file}: guard before openSend`);
  }
});

test("pins: both trash taps route a stuck relayed row through removeRelayedStuck with mayHaveRun", () => {
  const act = fnBody(src("../../features/activity/actions.ts"), 'case "queue": {');
  const way = act.indexOf('if (id === "discard" && isRelayedStuck(e)) {');
  assert.ok(way > 0 && way < act.indexOf('if (id === "discard") { if (v.removeQueued'), "Activity: the way out before the plain discard");
  assert.match(act, /removeRelayedStuck\(e, \{ ask: askConfirm, remove: \(a\) => v\.removeQueued\(a, \{ mayHaveRun: true \}\), toast: c\.say\.toast \}\)/);
  const q = fnBody(src("../../features/queue/actions.ts"), "export function removeRow(");
  assert.match(q, /if \(e && isRelayedStuck\(e\)\) \{\s*void removeRelayedStuck\(e, \{ ask: askConfirm, remove: \(a\) => c\.queue\.verbs\.removeQueued\(a, \{ mayHaveRun: true \}\)/);
  assert.match(src("../../features/queue/SendQueueSheet.tsx"), /onRemove=\{\(ackId\) => removeRow\(/);
  assert.match(src("../../QueueSheet.tsx"), /title=\{isRelayedStuck\(e\) \? RELAYED_REMOVE_LABEL : "discard"\}/);
});
