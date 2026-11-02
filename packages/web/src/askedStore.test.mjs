// The ONE-reading store the launcher's count and the Apps sheet share (`useInstallCaps.ts`, P4
// review F3/N3): run, not read as source — each case is a way the badge and the sheet once could
// disagree, or a refresh could wedge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAskedStore } from "./askedStore.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test("concurrent refreshes share ONE ask, and every subscriber hears the one answer", async () => {
  const d = deferred();
  let asks = 0;
  const s = createAskedStore(() => { asks++; return d.promise; }, "unknown");
  const heard = [];
  s.subscribe(() => heard.push(`a:${s.get()}`));
  s.subscribe(() => heard.push(`b:${s.get()}`));
  const p1 = s.refresh(), p2 = s.refresh();
  assert.equal(p1, p2, "the second refresh joins the first");
  assert.equal(asks, 1);
  d.resolve("caps");
  await p1;
  assert.equal(s.get(), "caps");
  assert.deepEqual(heard, ["a:caps", "b:caps"]);
  await s.refresh();
  assert.equal(asks, 2, "a refresh after the answer asks again");
});

test("a rejected ask keeps the last value, clears the in-flight call and does not reject the caller", async () => {
  let n = 0;
  const s = createAskedStore(() => (++n === 1 ? Promise.resolve("first") : Promise.reject(new Error("bridge gone"))), "unknown");
  await s.refresh();
  let heard = 0;
  s.subscribe(() => heard++);
  await s.refresh(); // resolves: a `void refresh()` call site never sees an unhandled rejection
  assert.equal(s.get(), "first");
  assert.equal(heard, 0, "nothing new was said");
  const again = s.refresh();
  assert.equal(n, 3, "in-flight was cleared: the next refresh asks again");
  await again;
});

test("a subscriber unsubscribing mid-emit does not skip the next one", async () => {
  const s = createAskedStore(() => Promise.resolve(1), 0);
  const heard = [];
  const offA = s.subscribe(() => { heard.push("a"); offA(); });
  s.subscribe(() => heard.push("b"));
  s.set(1);
  s.set(2);
  assert.deepEqual(heard, ["a", "b", "b"]);
});

test("set is a local change: subscribers hear it, no ask", () => {
  let asks = 0;
  const s = createAskedStore(() => { asks++; return Promise.resolve({ cleanup: false }); }, { cleanup: undefined });
  let heard = 0;
  s.subscribe(() => heard++);
  s.set({ cleanup: true });
  assert.deepEqual(s.get(), { cleanup: true });
  assert.equal(heard, 1);
  assert.equal(asks, 0);
});
