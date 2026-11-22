import test from "node:test";
import assert from "node:assert/strict";

import { BRAND, parkedKeyFor } from "@waterplane/shared";
import {
  bearerFor, bearerForSaved, deviceToken, dropDeviceToken, dropLanIdentity, forgetHeldLanIdentity, forgetHeldToken, heldLanIdentities, heldToken,
  heldTokens, holdLanIdentity, holdToken, holdTokens, lanIdentity, pickDeviceName, releaseTokens, sealedMode, setDeviceToken, setLanIdentity,
  tokenForHost, wsProtocols,
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

// ── The LAN identity: one reader, and never a plain key while sealed ─────

const IDENT = { hostId: "desk1234", secret: "s".repeat(32) };
const IDENT_B = { hostId: "desk5678", secret: "t".repeat(32) };

test("identity, mode off: storage is the only answer, and set and drop write the key as they always did", (t) => {
  const m = store(t, { [LS.hostActive]: A });
  holdLanIdentity(A, IDENT_B);
  assert.equal(lanIdentity(), null, "the map is not consulted");
  setLanIdentity(IDENT);
  assert.deepEqual(JSON.parse(m.get(LS.lanIdentity)), IDENT);
  assert.deepEqual(lanIdentity(), IDENT);
  dropLanIdentity();
  assert.equal(m.has(LS.lanIdentity), false);
});

test("identity, sealed: what the blob held answers for the active desktop only, and nothing is written", (t) => {
  const m = store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1" });
  assert.equal(lanIdentity(), null, "before the unseal there is none");
  holdTokens({ [A]: TOK, [B]: OTHER }, { [A]: IDENT, [B]: IDENT_B, cccc3333: { hostId: "x", secret: "short" } });
  assert.deepEqual(lanIdentity(), IDENT);
  assert.deepEqual(heldLanIdentities(), { [A]: IDENT, [B]: IDENT_B }, "a row that is no identity is not held");
  m.set(LS.hostActive, B);
  assert.deepEqual(lanIdentity(), IDENT_B, "a host switch moves no key: the row id picks it");
  assert.equal(m.has(LS.lanIdentity), false);
});

test("identity, sealed: one read over the tailnet goes to memory and never to a key", (t) => {
  const m = store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1" });
  setLanIdentity(IDENT);
  assert.equal(m.has(LS.lanIdentity), false);
  assert.deepEqual(lanIdentity(), IDENT);
  assert.deepEqual(heldLanIdentities(), { [A]: IDENT }, "so the next re-wrap carries it");
});

test("identity, sealed: a drop empties the map for the active desktop, takes a plain leftover too, and leaves the blob", (t) => {
  const m = store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1", [LS.tokenSeal]: "the blob", [LS.lanIdentity]: JSON.stringify(IDENT) });
  holdTokens({ [A]: TOK, [B]: OTHER }, { [A]: IDENT, [B]: IDENT_B });
  dropLanIdentity();
  assert.equal(lanIdentity(), null);
  assert.equal(m.has(LS.lanIdentity), false);
  assert.deepEqual(heldLanIdentities(), { [B]: IDENT_B });
  assert.equal(m.get(LS.tokenSeal), "the blob");
});

test("identity, sealed over a blob from before identities were in it: the plain copy still answers", (t) => {
  store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1", [LS.lanIdentity]: JSON.stringify(IDENT) });
  holdTokens({ [A]: TOK });
  assert.deepEqual(lanIdentity(), IDENT);
});

test("identity: what arrived this run beats the blob, a forget is by row, and release empties it with the tokens", (t) => {
  store(t, { [LS.hostActive]: A, [LS.tokenSealOn]: "1" });
  holdLanIdentity(A, IDENT_B);
  holdTokens({ [A]: TOK }, { [A]: IDENT, [B]: IDENT_B });
  assert.deepEqual(lanIdentity(), IDENT_B);
  forgetHeldLanIdentity(B);
  assert.deepEqual(heldLanIdentities(), { [A]: IDENT_B });
  releaseTokens();
  assert.deepEqual(heldLanIdentities(), {});
});
