/**
 * The demo's fake host (`packages/web/src/demo/host/`) and this host answer
 * the SAME messages — docs/analysis/demo-mode-plan.md §1, "Parity test".
 *
 * The demo's table is exhaustive over `ClientMessage["t"]` by type (tsc fails
 * on a missing key). That guards one side only: a message the host routes but
 * the wire type no longer names, or a wire type the host stopped routing,
 * passes tsc and leaves the demo answering something no real desktop does.
 * So: every key of the host's `HANDLED` is a key of the demo's `HANDLERS`, and
 * vice versa, minus the gaps listed below WITH their reason.
 *
 * And the durable ops: a message the host answers through `op.ack` (its
 * `durable: true` routes plus the two that call `durableOp` themselves) must
 * be one the demo answers through `op.ack` too — `DURABLE_OPS` in the demo's
 * verdict.ts — or a queued op in the demo waits for a receipt that is never
 * sent, and the queue retries it until its give-up budget runs out.
 *
 * Here and not in the web tests because importing `routes/index.ts` drags the
 * host in (it needs `dist`, which `test:host` builds).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { ROUTES, HANDLED } = await import("../dist/routes/index.js");
const { HANDLERS } = await import("../../web/src/demo/host/handlers.ts");
const { DURABLE_OPS } = await import("../../web/src/demo/host/verdict.ts");

/** Host routes the demo deliberately has no entry for: reason per key. */
const HOST_ONLY = {};
/** Demo entries for messages the host does not route: reason per key. */
const DEMO_ONLY = {
  // Both are still in `ClientMessage`, so the demo's exhaustive table must
  // name them; the host routes neither (the wire comment on `session.reopen`
  // says so: every reopen is a `session.create` with `resumeSessionId`). The
  // demo refuses both, which is the most a desktop that ignores them could do.
  "session.background": "in the wire type, routed by no host",
  "session.reopen": "in the wire type, routed by no host — reopen is session.create + resumeSessionId",
};

const minus = (a, b) => [...a].filter((k) => !b.has(k)).sort();

test("every message the host routes, the demo answers — and nothing else", () => {
  const host = new Set(HANDLED);
  const demo = new Set(Object.keys(HANDLERS));
  assert.deepEqual(minus(host, demo), Object.keys(HOST_ONLY).sort(), "host routes missing from the demo's HANDLERS");
  assert.deepEqual(minus(demo, host), Object.keys(DEMO_ONLY).sort(), "demo HANDLERS the host does not route");
});

test("the demo's DURABLE_OPS are exactly the host's op.ack routes", () => {
  const durable = Object.entries(ROUTES)
    .filter(([, r]) => (typeof r === "function" ? /\bdurableOp\(/.test(String(r)) : r?.durable === true))
    .map(([t]) => t)
    .sort();
  assert.ok(durable.length >= 10, `found only ${durable.length} durable routes — the detection is broken, not the table`);
  assert.deepEqual([...DURABLE_OPS].sort(), durable);
});
