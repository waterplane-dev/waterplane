/**
 * `timedFetch`'s caller signal: a cancel the caller makes reaches the request
 * for its WHOLE life, not only until the headers land. A screen that drops a
 * read mid-body (a megabyte gif side, a scrollback document) must free the
 * socket, and the APK has six to the host.
 * Run: node --test packages/shared/test/netfuse.test.mjs (after build:shared)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TimeoutError, timedFetch } from "../dist/netfuse.js";

/** A fetch whose headers arrive at once and whose body never ends; it records the signal it was handed. */
function streamingFetch() {
  const got = {};
  const doFetch = async (_url, init) => {
    got.signal = init?.signal;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":')); } });
    return new Response(body, { status: 200 });
  };
  return { doFetch, got };
}

test("a caller abort AFTER the headers still aborts the request (the body is on the wire)", async () => {
  const { doFetch, got } = streamingFetch();
  const ac = new AbortController();
  const r = await timedFetch("/x", { signal: ac.signal }, 5_000, doFetch);
  assert.equal(r.status, 200);
  assert.equal(got.signal.aborted, false);
  ac.abort();
  assert.equal(got.signal.aborted, true, "the body kept its socket after the caller let go");
});

test("a caller abort before the headers is still the caller's own error, never a TimeoutError", async () => {
  const ac = new AbortController();
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }));
  const p = timedFetch("/x", { signal: ac.signal }, 5_000, hang);
  ac.abort();
  const err = await p.catch((e) => e);
  assert.ok(!(err instanceof TimeoutError), String(err));
  assert.equal(err.name, "AbortError");
});

test("the fuse ends at the headers: a body still arriving past `ms` is not aborted by it", async () => {
  const { doFetch, got } = streamingFetch();
  await timedFetch("/x", undefined, 20, doFetch);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(got.signal.aborted, false);
});
