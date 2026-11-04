import test from "node:test";
import assert from "node:assert/strict";

import { BRAND, parkedKeyFor } from "@waterplane/shared";
import {
  bearerFor, bearerForSaved, deviceToken, dropDeviceToken, forgetHeldToken, heldToken, heldTokens, holdToken, holdTokens, pickDeviceName,
  releaseTokens, sealedMode, setDeviceToken, tokenForHost, wsProtocols,
} from "./deviceToken.ts";
import { LS } from "./storage.ts";

const TOK = "AbCdEf0123456789_-AbCdEf0123456789_-abcdefg";

test("the bearer goes to the host base in force and nowhere else", () => {
  const base = "http://100.64.0.5:8770";
  assert.equal(bearerFor(`${base}/api/repos`, base, TOK), `Bearer ${TOK}`);
  assert.equal(bearerFor("http://100.64.0.5:8770/api/x?y=1", `${base}/`, TOK), `Bearer ${TOK}`);
  assert.equal(bearerFor("http://100.64.0.5:9999/api/repos", base, TOK), null, "another port is another origin");
  assert.equal(bearerFor("https://100.64.0.5:8770/api/repos", base, TOK), null, "another scheme");
  for (const p of ["start", "finish"]) assert.equal(bearerFor(`${base}/api/pair/pake/${p}`, base, TOK), null, "pake/* carries no bearer");
  assert.equal(bearerFor(`${base}/api/pair/redeem`, base, TOK), `Bearer ${TOK}`, "redeem still may");
  assert.equal(bearerFor("http://192.168.1.20:8770/api/lan/verify", base, TOK), null, "the LAN address while it is being verified");
  assert.equal(bearerFor("https://example.com/api/repos", base, TOK), null, "a third party");
  assert.equal(bearerFor("/api/repos", base, TOK), null, "an unresolved path is not the host");
  assert.equal(bearerFor(`${base}/api/repos`, null, TOK), null, "no host base");
  assert.equal(bearerFor(`${base}/api/repos`, base, null), null, "no token");
});

test("once the LAN is the route, the bearer follows it there — and stops going to the tailnet address", () => {
  const lan = "http://192.168.1.20:8770";
  assert.equal(bearerFor(`${lan}/api/repos`, lan, TOK), `Bearer ${TOK}`);
  assert.equal(bearerFor("http://100.64.0.5:8770/api/repos", lan, TOK), null);
});

test("the socket offers the token as a SECOND subprotocol, and nothing without one", () => {
  assert.deepEqual(wsProtocols(TOK), [BRAND.wsProtocol, `${BRAND.wsProtocol}-tok.${TOK}`]);
  assert.equal(wsProtocols(null), undefined);
});

test("the device name is never blank", () => {
  assert.equal(pickDeviceName("  My phone ", "Pixel 8"), "My phone");
  assert.equal(pickDeviceName("", "Pixel 8"), "Pixel 8");
  assert.equal(pickDeviceName("", ""), "Android phone");
  assert.equal(pickDeviceName("x".repeat(80), "").length, 60);
});

// ── Sealed mode ──────────────────────────────────────────────────────────

const OTHER = "OtherDesktopToken0123456789";
const A = "aaaa1111";
const B = "bbbb2222";

/** `localStorage` as a Map for one test, and an empty held map after it. */
function store(t, init = {}) {
  const m = new Map(Object.entries(init));
  const was = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); },
  } });
  t.after(() => {
    releaseTokens();
    if (was) Object.defineProperty(globalThis, "localStorage", was); else delete globalThis.localStorage;
  });
  return m;
}

test("mode off: storage is the only answer, whatever the map holds", (t) => {
  store(t, { [LS.hostActive]: A, [LS.deviceToken]: TOK, [parkedKeyFor(LS.deviceToken, B)]: OTHER });
  holdTokens({ [A]: "HeldNotConsulted0123456789" });
  assert.equal(sealedMode(), false);
  assert.equal(deviceToken(), TOK);
  assert.equal(tokenForHost(A), TOK);
  assert.equal(tokenForHost(B), OTHER);
  assert.equal(tokenForHost("cccc3333"), null);
});

test("mode off: set and drop write the key, as they always did", (t) => {
  const m = store(t, { [LS.hostActive]: A });
  setDeviceToken(TOK);
  assert.equal(m.get(LS.deviceToken), TOK);
  dropDeviceToken();
  assert.equal(m.has(LS.deviceToken), false);
});

test("sealed: every read comes from the map, and before the unseal there is simply no token", (t) => {
  store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1" });
  assert.equal(deviceToken(), null);
  assert.equal(tokenForHost(B), null);
  holdTokens({ [A]: TOK, [B]: OTHER });
  assert.equal(deviceToken(), TOK);
  assert.equal(tokenForHost(A), TOK);
  assert.equal(tokenForHost(B), OTHER);
  assert.equal(bearerForSaved({ base: "http://100.64.0.7:8770" }, tokenForHost(B), "http://100.64.0.7:8770/api/attention"), `Bearer ${OTHER}`);
});

test("sealed: a passive token left in plain storage still answers, since no prompt can open it", (t) => {
  store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1", [LS.deviceToken]: TOK, [LS.passive]: "1" });
  assert.equal(deviceToken(), TOK);
  assert.equal(tokenForHost(A), TOK);
});

test("sealed: a mint goes to memory and never to a key", (t) => {
  const m = store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1" });
  setDeviceToken(TOK);
  assert.equal(m.has(LS.deviceToken), false);
  assert.equal(deviceToken(), TOK);
});

test("sealed: a drop empties the map and leaves the blob alone", (t) => {
  const m = store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1", [LS.tokenSeal]: "the blob" });
  holdTokens({ [A]: TOK, [B]: OTHER });
  dropDeviceToken();
  assert.equal(deviceToken(), null);
  assert.equal(tokenForHost(B), OTHER, "only the active desktop's");
  assert.equal(m.get(LS.tokenSeal), "the blob");
});

test("the whole set is offered for wrapping only once the blob was opened this run", (t) => {
  store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1" });
  holdToken(B, OTHER);
  assert.equal(heldTokens(), null, "open without the sign-ins, then a pairing: wrapping this would drop every other desktop");
  assert.equal(heldToken(B), OTHER);
  holdTokens({ [A]: TOK, [B]: "OlderCopyFromTheBlob0123456" });
  assert.deepEqual(heldTokens(), { [A]: TOK, [B]: OTHER }, "what arrived this run is newer than the blob");
  forgetHeldToken(B);
  assert.deepEqual(heldTokens(), { [A]: TOK });
  releaseTokens();
  assert.equal(heldTokens(), null);
});

test("a held token of the wrong shape is not held", (t) => {
  store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1" });
  holdTokens({ [A]: "short" });
  holdToken(B, "short");
  assert.equal(deviceToken(), null);
  assert.equal(tokenForHost(B), null);
});
