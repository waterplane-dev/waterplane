/**
 * The pairing deep link, driven through the REAL global the Android
 * shell calls (`window.shellPair`, installed by `installShellBridge`):
 * any app on the phone can fire that link, so it may only ever OPEN the pair
 * form prefilled — never redeem, never store a host or a token. Asserted by
 * behaviour: the handler receives the target, and no request leaves the page
 * and no storage key is written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { PAIR_SCHEME, pairDeepLink } from "@waterplane/shared";

// shellLink.ts imports its siblings without an extension (Vite resolves
// them); node needs the `.ts`.
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (spec.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(spec)) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const fetches = [];
globalThis.fetch = async (u) => { fetches.push(String(u)); return new Response("{}"); };
const writes = [];
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { writes.push(k); store.set(k, String(v)); },
  removeItem: (k) => { writes.push(k); store.delete(k); },
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
const events = [];
globalThis.window = globalThis;
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
globalThis.addEventListener ??= () => {};
globalThis.dispatchEvent ??= (e) => { events.push(e.type); return true; };

const { installShellBridge, onShellPair } = await import("./shellLink.ts");
installShellBridge();

const LINK = pairDeepLink("http://100.64.0.5:8770", "ABCDEFGH");

test("a valid link held before any listener is handed to the first one, and nothing is redeemed", () => {
  fetches.length = 0; writes.length = 0;
  assert.equal(window.shellPair(LINK), true, "taken: the shell must not retry");
  const got = [];
  const off = onShellPair((t) => got.push(t));
  assert.deepEqual(got, [{ base: "http://100.64.0.5:8770", code: "ABCDEFGH" }]);
  off();
  assert.deepEqual(fetches, [], "no request — in particular no /api/pair/redeem");
  assert.deepEqual(writes, [], "no host, token or identity stored");
});

test("with the form listening, a link only prefills it; still no request and no write", () => {
  fetches.length = 0; writes.length = 0;
  const got = [];
  const off = onShellPair((t) => got.push(t));
  assert.equal(window.shellPair(LINK), true);
  assert.equal(got.length, 1);
  off();
  assert.deepEqual(fetches, []);
  assert.deepEqual(writes, []);
});

test("an invalid link is taken (truthy), reaches no listener, and redeems nothing", () => {
  fetches.length = 0; writes.length = 0;
  const got = [];
  const off = onShellPair((t) => got.push(t));
  for (const bad of [`${PAIR_SCHEME}://pair?u=javascript%3Aalert(1)&c=ABCDEFGH`, "", `${PAIR_SCHEME}://open?u=x&c=y`]) {
    assert.equal(window.shellPair(bad), true, `${bad}: the shell must not retry`);
  }
  off();
  assert.deepEqual(got, []);
  assert.deepEqual(fetches, []);
  assert.ok(!writes.some((k) => /host|Token|lanIdentity/.test(k)), `no pairing state written: ${writes}`);
});
