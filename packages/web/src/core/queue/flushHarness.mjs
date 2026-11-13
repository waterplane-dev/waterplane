/**
 * Test helper (not shipped: nothing in the bundle imports an .mjs): drives `sendFns` — the ONE flusher —
 * from node with a fake queue context, a fake socket and a virtual clock, and writes every
 * `writeOutbox` and every `conn.send` into ONE ordered event log. At-most-once delivery is an
 * ORDER ("the attempt mark is on disk before the frame is on the wire"), so the order is what a test reads.
 *
 *     const h = await makeHarness({ rows: [row("a")] });
 *     h.fns.flushOutbox();
 *     h.log   // [{ k: "write", list }, { k: "send", frame }, ...]
 *     h.tick(6000);        // the virtual clock: timers due by then fire, Date.now() has moved
 *     h.ack("a");          // an input.ack through the real `wireFns`
 *
 * Import `scripts/lib-tsload.mjs` BEFORE this file, as `pending.test.mjs` does.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const store = new Map();
const fakeStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
// send.ts reaches IndexedDB and the network through `../../idb` and `../../api`. Only ITS imports of those
// two are redirected to flushStubs.mjs (registered after lib-tsload's hooks, so it runs first).
registerHooks({
  resolve(spec, ctx, next) {
    if (ctx.parentURL?.endsWith("/core/queue/send.ts") && (spec === "../../idb" || spec === "../../api")) {
      return { url: new URL("./flushStubs.mjs", import.meta.url).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

// Installed for the import only (module top levels may read it); each harness installs and restores its own.
const saved0 = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
globalThis.localStorage = fakeStorage;
const { sendFns } = await import("./send.ts");
const { wireFns } = await import("./wire.ts");
const { pendingFns } = await import("./pending.ts");
if (saved0) Object.defineProperty(globalThis, "localStorage", saved0); else delete globalThis.localStorage;

export const T0 = 1_800_000_000_000;

/** An input row as `submitInput` queues it. */
export const row = (ackId, over = {}) => ({
  ackId, sessionId: "s1", cwd: "/repo", text: `words of ${ackId}`, ts: T0, status: "queued", mode: "input", armed: true, ...over,
});

export async function makeHarness({ rows = [], status = "open", sessions = [], autoSend = true } = {}) {
  let now = T0;
  let seq = 0;
  const timers = new Map(); // id -> { at, fn }
  // Put back exactly what was found (absent stays absent) — see restore().
  const GLOBALS = ["window", "localStorage", "clearTimeout", "__flushFake"];
  const found = new Map(GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const realNow = Date.now;
  Date.now = () => now;
  globalThis.localStorage = fakeStorage;
  globalThis.window = {
    setTimeout: (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };

  // The upload's two doors. `blobs` is the "uploads" IndexedDB store (a test seeds it); `uploads` is one
  // controllable promise per `api.uploadInbox` call: `settle(i)` resolves it, `reject(i, err)` fails it.
  const blobs = new Map();
  const uploads = [];
  globalThis.__flushFake = {
    idbGet: async (_store, key) => blobs.get(key) ?? null,
    idbSet: async (_store, key, value) => { blobs.set(key, value); return true; },
    idbDel: async (_store, key) => { blobs.delete(key); },
    uploadInbox: (repoId, blob, name, signal, onProgress) => new Promise((resolve, reject) => {
      uploads.push({ repoId, name, signal, onProgress, resolve, reject });
    }),
  };

  const log = [];
  const conn = { status, send: (frame) => { log.push({ k: "send", frame }); return true; } };
  const ref = (current) => ({ current });
  const c = {
    // env
    connRef: ref(conn), status, reconnectAsk: false, setReconnectAsk() {},
    sessions, sessionsRef: ref(sessions), backendsRef: ref(undefined), exitedRef: ref(new Set()), activeIdRef: ref(null),
    budgetRef: ref(null), serialSessionsRef: ref(false), confirmQueueRef: ref(false), autoSendRef: ref(autoSend),
    readModeRef: ref(false), launchesRef: ref([]), setLaunches() {}, setBudget() {},
    // refs
    outboxRef: ref(rows), ackTimers: ref(new Map()), uploadsInFlight: ref(new Set()), uploadAborts: ref(new Map()),
    busyLanesRef: ref(new Set()), budgetHeldLanesRef: ref(new Set()), busySerialRef: ref(new Set()), serialWatchRef: ref([]),
    holdQueueRef: ref(false), flushIdleReason: ref(null), queueBlockedRef: ref(new Map()), setQueueBlocked() {},
    pendingKept: ref(new Map()), pendingEntry: null,
    up: {
      inflightRef: ref(0), parkingRef: ref(0), upBytesRef: ref({ sent: 0, total: 0, startedAt: 0, fullAt: 0 }),
      allBufsRef: ref(new Set()), uploadBufRef: ref(null), refreshUploadLabel() {},
    },
    // core fns: the one writer is faked so the log sees it
    writeOutbox(list) { c.outboxRef.current = list; log.push({ k: "write", list }); return list; },
    addOutbox(e) { c.writeOutbox([...c.outboxRef.current, e]); },
    addOutboxFirstInLane(e) { c.writeOutbox([e, ...c.outboxRef.current]); },
    // The real `failOutboxImpl` (useQueue.ts) minus toast/noteSendFailed/retainUploadBytes: the entry becomes
    // `failed` with reason/failState/failedAt, and a failed upload fails the queued prompts that name its path.
    failOutbox(ackId, reason, state) {
      const e = c.outboxRef.current.find((x) => x.ackId === ackId && x.status !== "failed");
      if (!e) return;
      log.push({ k: "fail", ackId, reason });
      c.writeOutbox(c.outboxRef.current.map((x) => (x.ackId === ackId
        ? { ...x, status: "failed", reason, failState: state ?? "other", failedAt: Date.now() } : x)));
      if (e.mode === "upload" && e.upload) c.failDependentUploads(e, `the image it refers to never uploaded — ${reason}`);
    },
    applyDeliverySettled() {}, holdWall: () => null,
    failPendingCreates() {}, adoptPendingSession() {}, holdForLaunch() {}, queueSessionPrompt() {},
  };
  Object.assign(c, pendingFns(c)); // the REAL failDependentUploads (and the rest, unused here)
  Object.assign(c, sendFns(c));
  Object.assign(c, wireFns(c));

  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].fn();
    }
    now = end;
  };
  return {
    c, fns: c, log, conn, advance, tick: advance, timers, blobs, uploads,
    /** Await the in-flight upload for `ackId` leaving `uploadsInFlight` (bounded: microtask turns only, no timers). */
    async drain(ackId, max = 50) {
      for (let i = 0; i < max && c.uploadsInFlight.current.has(ackId); i++) await Promise.resolve();
      assert.ok(!c.uploadsInFlight.current.has(ackId), `upload ${ackId} did not settle within ${max} microtask turns`);
    },
    get now() { return now; },
    outbox: () => c.outboxRef.current,
    entry: (ackId) => c.outboxRef.current.find((x) => x.ackId === ackId),
    sends: () => log.filter((e) => e.k === "send").map((e) => e.frame),
    ack: (ackId) => c.onInputAck({ t: "input.ack", ackId, ok: true }),
    close() { conn.status = "closed"; },
    restore() {
      Date.now = realNow;
      for (const [k, d] of found) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    },
  };
}
