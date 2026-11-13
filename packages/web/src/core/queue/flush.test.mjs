/**
 * The flusher's ORCHESTRATION, run: what `selectSendable`/`markAttempt`/`entryFrame` decide is pinned in
 * their own tests; this file pins the order and the timing around them, which is what makes delivery
 * at-most-once (79b2d0cf: a prompt overtook its picture; 21e3f024: an expired entry released its lane).
 *
 *     node --test packages/web/src/core/queue/flush.test.mjs
 */
import "../../../../../scripts/lib-tsload.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { makeHarness, row, T0 } = await import("./flushHarness.mjs");
const { LANE_GAP_MS } = await import("./logic.ts");
const { retryDelay, roundDelay, MIN_TRY_MS } = await import("@waterplane/shared");
const { MAX_SEND_ATTEMPTS } = await import("../../outbox.ts");

const harness = (opts) => makeHarness(opts);
const withHarness = (name, opts, fn) => test(name, async () => {
  const h = await harness(opts);
  try { await fn(h); } finally { h.restore(); }
});

withHarness("the attempt mark is written BEFORE the frame is sent, and the frame carries firstTryAt", { rows: [row("a")] }, (h) => {
  assert.equal(h.fns.flushOutbox(), 1);
  const sendAt = h.log.findIndex((e) => e.k === "send");
  const markAt = h.log.findIndex((e) => e.k === "write" && e.list.some((x) => x.ackId === "a" && x.status === "pending" && x.attempts === 1));
  assert.ok(markAt >= 0, "the mark was written");
  assert.ok(sendAt > markAt, `mark (${markAt}) before send (${sendAt}): ${JSON.stringify(h.log.map((e) => e.k))}`);
  const frame = h.sends()[0];
  assert.equal(frame.ackId, "a");
  assert.equal(frame.firstSentAt, h.entry("a").firstTryAt);
  assert.equal(frame.firstSentAt, T0);
});

withHarness("an ack timeout on an open socket requeues the SAME ackId with the same firstSentAt, attempt counted", { rows: [row("a")] }, (h) => {
  h.fns.flushOutbox();
  const win = h.fns.ackWindowFor(h.entry("a"));
  h.advance(win);
  const e = h.entry("a");
  assert.equal(e.status, "queued");
  assert.equal(e.attempts, 1, "a timeout on an open socket is a real attempt");
  assert.equal(e.tries, 1);
  assert.equal(h.sends().length, 1, "backing off: the flush the timeout runs sends nothing yet");
  h.advance(retryDelay(1));
  assert.equal(h.fns.flushOutbox(), 1);
  const [first, second] = h.sends();
  assert.equal(second.ackId, first.ackId);
  assert.equal(second.firstSentAt, first.firstSentAt);
  assert.equal(first.firstSentAt, T0, "firstSentAt stays the FIRST try, not the retry");
  assert.equal(h.entry("a").attempts, 2);
});

withHarness("an ack timeout after the socket closed rolls the attempt back", { rows: [row("a")] }, (h) => {
  h.fns.flushOutbox();
  h.close();
  h.advance(h.fns.ackWindowFor(h.entry("a")));
  const e = h.entry("a");
  assert.equal(e.status, "queued");
  assert.equal(e.attempts, 0, "the network being down is not a delivery attempt");
  assert.equal(h.sends().length, 1);
});

withHarness("one in flight per session: a second entry in the lane waits for the ack; two lanes go together", {
  rows: [row("a"), row("b", { ts: T0 + 1 }), row("c", { sessionId: "s2", ts: T0 + 2 })],
}, (h) => {
  assert.equal(h.fns.flushOutbox(), 2);
  assert.deepEqual(h.sends().map((f) => f.ackId).sort(), ["a", "c"]);
  assert.equal(h.fns.flushOutbox(), 0, "nothing more while a is unanswered");
  h.ack("a");
  assert.equal(h.sends().length, 2, "the lane is handed back after a beat, not on the ack");
  h.advance(LANE_GAP_MS);
  assert.deepEqual(h.sends().map((f) => f.ackId).sort(), ["a", "b", "c"]);
  assert.equal(h.entry("a"), undefined);
});

withHarness("an expired entry goes to the next round and its lane is NOT released early", {
  rows: [
    row("a", { attempts: MAX_SEND_ATTEMPTS, firstTryAt: T0 - MIN_TRY_MS - 1, tries: 8 }),
    row("b", { ts: T0 + 1 }),
  ],
}, (h) => {
  assert.equal(h.fns.flushOutbox(), 0, "neither a (expired) nor b (behind it) is written to the socket");
  assert.equal(h.sends().length, 0);
  const a = h.entry("a");
  assert.equal(a.status, "queued", "not failed");
  assert.equal(a.round, 1);
  assert.equal(a.attempts, 0);
  assert.equal(a.retryAt, T0 + roundDelay(1));
  assert.equal(h.entry("b").status, "queued");
  assert.equal(h.fns.flushOutbox(), 0, "and the next pass keeps the lane held by the backoff");
  assert.equal(h.sends().length, 0);
});

withHarness("an entry out of attempts but under the minimum trying time is tried again, not expired", {
  rows: [row("a", { attempts: MAX_SEND_ATTEMPTS, firstTryAt: T0 - 1000 })],
}, (h) => {
  assert.equal(h.fns.flushOutbox(), 1);
  assert.equal(h.entry("a").round, undefined);
});

const UP = { repoId: "r", name: "p.png", relPath: ".claude/inbox/p.png", size: 10 };
const uploadRows = () => [
  row("up", { mode: "upload", upload: UP, text: "" }),
  row("p", { ts: T0 + 1, text: "look at .claude/inbox/p.png" }),
];
const withUpload = (name, fn) => withHarness(name, { rows: uploadRows() }, async (h) => {
  h.blobs.set("up", new Uint8Array(10));
  await fn(h);
});

withUpload("an upload in flight holds its lane: the prompt behind it is sent only after the upload SUCCEEDS", async (h) => {
  assert.equal(h.fns.flushOutbox(), 1, "only the upload starts");
  assert.ok(h.c.uploadsInFlight.current.has("up"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.uploads.length, 1, "the POST is on its way");
  assert.equal(h.fns.flushOutbox(), 0, "a second pass while the bytes are on their way");
  h.advance(LANE_GAP_MS);
  assert.equal(h.sends().length, 0, "the prompt did not overtake its picture");
  h.uploads[0].resolve({ saved: [{ relPath: UP.relPath, mtime: 1 }] });
  await h.drain("up");
  assert.equal(h.entry("up"), undefined, "the receipt removes the upload row");
  assert.equal(h.sends().length, 0, "the lane is handed back after a beat");
  h.advance(LANE_GAP_MS);
  assert.deepEqual(h.sends().map((f) => f.ackId), ["p"], "released only after the success");
});

withUpload("a NETWORK failure requeues the upload and the prompt still does not overtake it", async (h) => {
  assert.equal(h.fns.flushOutbox(), 1);
  await Promise.resolve(); await Promise.resolve();
  h.uploads[0].reject(Object.assign(new Error("Failed to fetch"), { responded: false }));
  await h.drain("up");
  const up = h.entry("up");
  assert.equal(up.status, "queued", "back in the queue, not failed");
  assert.ok(up.retryAt > h.now, "backing off");
  assert.equal(h.entry("p").status, "queued");
  h.advance(LANE_GAP_MS);
  assert.equal(h.sends().length, 0, "the prompt did not take the lane while its picture backs off");
  h.advance(up.retryAt - h.now);
  assert.equal(h.fns.flushOutbox(), 1, "the upload is tried again");
  assert.equal(h.sends().length, 0, "and the prompt still waits");
  await Promise.resolve(); await Promise.resolve();
  h.uploads[1].resolve({ saved: [{ relPath: UP.relPath, mtime: 1 }] });
  await h.drain("up");
  h.advance(LANE_GAP_MS);
  assert.deepEqual(h.sends().map((f) => f.ackId), ["p"]);
});

withUpload("an upload that fails for good fails the prompt that names its path (real failDependentUploads), not an unrelated one", async (h) => {
  h.c.writeOutbox([...h.outbox(), row("other", { ts: T0 + 2, sessionId: "s1", text: "unrelated words" })]);
  h.blobs.delete("up"); // the bytes are gone: the permanent branch
  h.fns.flushOutbox();
  await h.drain("up");
  assert.equal(h.entry("up").status, "failed");
  assert.equal(h.entry("p").status, "failed", "a prompt naming a picture that never arrived is not sent");
  assert.match(h.entry("p").reason, /never uploaded/);
  assert.equal(h.entry("other").status, "queued", "unrelated work in the lane is still delivered");
  h.advance(LANE_GAP_MS);
  assert.deepEqual(h.sends().map((f) => f.ackId), ["other"]);
});

withUpload("uploadsInFlight guards the lane: an upload entry forced back to queued while its POST runs is not restarted", async (h) => {
  assert.equal(h.fns.flushOutbox(), 1);
  await Promise.resolve(); await Promise.resolve();
  h.c.writeOutbox(h.outbox().map((x) => (x.ackId === "up" ? { ...x, status: "queued" } : x)));
  assert.ok(h.c.uploadsInFlight.current.has("up"));
  assert.equal(h.fns.flushOutbox(), 0, "nothing is sent for the lane while its upload is still running");
  assert.equal(h.uploads.length, 1, "no second POST of the same picture");
  assert.equal(h.sends().length, 0);
});

withHarness("armAll arms queued entries but keeps holdUntilIdle on a pendingCreate entry", {
  rows: [
    row("wait", { armed: false, holdUntilIdle: true, pendingCreate: true, createAck: "mk", sessionId: "create:/repo" }),
    row("plain", { armed: false, holdUntilIdle: true, sessionId: "s2", retryAt: T0 + 99_999 }),
    row("other", { armed: false, sessionId: "s3" }),
  ],
}, (h) => {
  assert.equal(h.fns.flushOutbox(true), 2);
  assert.equal(h.entry("wait").holdUntilIdle, true, "the park a create-dependent entry needs AFTER binding survives");
  assert.equal(h.entry("wait").armed, true);
  assert.equal(h.entry("wait").status, "queued", "and it is not typed while the CLI starts");
  assert.equal(h.entry("plain").holdUntilIdle, undefined);
  assert.equal(h.entry("plain").retryAt, undefined);
  assert.deepEqual(h.sends().map((f) => f.ackId).sort(), ["other", "plain"]);
});
