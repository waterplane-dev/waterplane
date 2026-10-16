/**
 * The body fuse, pinned without a browser: `timedFetch` stops guarding once
 * headers land, so a stalled body must reject — as a `TimeoutError`, which the
 * reader reads as offline — and a slow-but-moving one must not.
 * Run: node --test packages/web/src/webapi/webapiBody.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isOffline } from "@waterplane/shared";
import { readJsonFused } from "./webapiBody.ts";

const enc = new TextEncoder();
const response = (chunks, gapMs, hang) => new Response(new ReadableStream({
  async start(c) {
    for (const s of chunks) { c.enqueue(enc.encode(s)); await new Promise((r) => setTimeout(r, gapMs)); }
    if (!hang) c.close();
  },
}));

test("a body that stops arriving rejects as offline", async () => {
  const err = await readJsonFused(response(['{"turns":'], 0, true), 50).catch((e) => e);
  assert.ok(isOffline(err), String(err));
  assert.match(String(err.message), /stalled/);
});

test("a slow body that keeps moving is read whole", async () => {
  const doc = await readJsonFused(response(['{"a":', '1,"b"', ':[2]}'], 30, false), 80);
  assert.deepEqual(doc, { a: 1, b: [2] });
});
