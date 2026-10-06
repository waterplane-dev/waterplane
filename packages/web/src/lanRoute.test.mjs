import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  NO_IDENTITY_SENTENCE, NO_PASSWORD_SENTENCE, createLanRouter, lanMacHex, newNonce, parseLanIdentity, verifyLanAnswer,
} from "./lanRoute.ts";
import { LOCATION_DISCLOSURE, LOCATION_SKIPPED_TEXT, parseNetState } from "./shellNet.ts";

test("the location disclosure states all four facts before Android asks (Play's prominent disclosure)", () => {
  const all = LOCATION_DISCLOSURE.lines.join("\n");
  assert.match(all, /Wi-Fi network it is on/, "WHAT is read: the Wi-Fi name");
  assert.match(all, /switch to the desktop's home address automatically/, "WHY");
  assert.match(all, /compared on this phone/, "where it is used");
  assert.match(all, /never sent anywhere/, "that it never leaves");
  assert.match(all, /Skip.*LAN switching stays manual/, "what skipping costs");
  assert.equal(LOCATION_DISCLOSURE.continueLabel, "Continue");
  assert.equal(LOCATION_DISCLOSURE.skipLabel, "Skip");
  assert.match(LOCATION_SKIPPED_TEXT, /stays manual/);
});

const ID = { hostId: "h_abc123", secret: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXh5eg" };
const NONCE = "0123456789abcdef0123456789abcdef";
// The host's `lanMac`, recomputed with node's crypto: key = utf8(secret), msg = hostId "\n" nonce.
const MAC = createHmac("sha256", ID.secret).update(`${ID.hostId}\n${NONCE}`).digest("hex");

test("the phone's WebCrypto MAC equals the host's node-crypto MAC for the same vector", async () => {
  assert.equal(await lanMacHex(ID.secret, ID.hostId, NONCE), MAC);
});

test("an answer is accepted only with the right hostId AND the right MAC", async () => {
  assert.equal(await verifyLanAnswer(ID, NONCE, { hostId: ID.hostId, mac: MAC }), true);
  assert.equal(await verifyLanAnswer(ID, NONCE, { hostId: ID.hostId, mac: MAC.toUpperCase() }), true);
  assert.equal(await verifyLanAnswer(ID, NONCE, { hostId: "h_other", mac: MAC }), false, "another desktop");
  assert.equal(await verifyLanAnswer(ID, NONCE, { hostId: ID.hostId, mac: MAC.replace(/^./, (c) => (c === "0" ? "1" : "0")) }), false);
  assert.equal(await verifyLanAnswer(ID, "ffff" + NONCE.slice(4), { hostId: ID.hostId, mac: MAC }), false, "a replayed answer to another nonce");
  assert.equal(await verifyLanAnswer(ID, NONCE, null), false);
  assert.equal(await verifyLanAnswer(ID, NONCE, { hostId: ID.hostId, mac: MAC }, undefined), true);
});

test("no WebCrypto ⇒ no MAC ⇒ never LAN", async () => {
  assert.equal(await lanMacHex(ID.secret, ID.hostId, NONCE, null), null);
});

test("a nonce is 32 hex characters and not repeated", () => {
  const a = newNonce(), b = newNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test("identity parsing refuses anything that is not one", () => {
  assert.deepEqual(parseLanIdentity({ ...ID, hostName: "x" }), ID);
  assert.equal(parseLanIdentity({ hostId: "h", secret: "short" }), null);
  assert.equal(parseLanIdentity(null), null);
  assert.equal(parseLanIdentity("x"), null);
});

test("the shell's net state is read as an object (or JSON), anything else is not reported", () => {
  assert.deepEqual(parseNetState({ transport: "wifi", ssid: "Home", permission: "granted" }), { transport: "wifi", ssid: "Home", permission: "granted" });
  assert.deepEqual(parseNetState('{"transport":"cellular","ssid":null,"permission":"denied"}'), { transport: "cellular", ssid: null, permission: "denied" });
  assert.deepEqual(parseNetState({ transport: "wifi", ssid: "  ", permission: "granted" }).ssid, null);
  assert.equal(parseNetState({ transport: "5g", ssid: null, permission: "granted" }), null);
  assert.equal(parseNetState(null), null);
});

// ── the ladder, with the IO handed in ────────────────────────────────────

const LAN = "http://192.168.1.20:8770";
const HOST = { lan: { base: LAN, ssids: ["Home"], auto: true } };
const WIFI = { transport: "wifi", ssid: "Home", permission: "granted" };

function rig(over = {}) {
  const calls = [];
  const applied = [];
  let t = 1000;
  const deps = {
    host: () => HOST,
    net: async () => WIFI,
    ensureToken: async () => { calls.push("token"); return "ok"; },
    ensureIdentity: async () => { calls.push("identity"); return ID; },
    probe: async (base) => { calls.push(`probe ${base}`); return { ok: true, ms: 12, at: ++t }; },
    verify: async (base, nonce) => {
      calls.push(`verify ${base}`);
      return { hostId: ID.hostId, mac: createHmac("sha256", ID.secret).update(`${ID.hostId}\n${nonce}`).digest("hex") };
    },
    apply: (v) => applied.push(v),
    now: () => ++t,
    nonce: () => NONCE,
    ...over,
  };
  return { deps, calls, applied, router: createLanRouter(deps) };
}

test("every gate passed ⇒ LAN, with the LAN base, after token, identity, probe and verify in that order", async () => {
  const { router, calls, applied } = rig();
  const v = await router.evaluate("start");
  assert.equal(v.route, "lan");
  assert.equal(v.lanBase, LAN);
  assert.match(v.sentence, /^Using LAN: on "Home"/);
  assert.deepEqual(calls, ["token", "identity", `probe ${LAN}`, `verify ${LAN}`]);
  assert.equal(applied.length, 1);
});

test("a bad MAC ⇒ tailnet, no LAN base", async () => {
  const { router } = rig({ verify: async () => ({ hostId: ID.hostId, mac: "00".repeat(32) }) });
  const v = await router.evaluate("start");
  assert.equal(v.route, "tailnet");
  assert.equal(v.lanBase, null);
  assert.match(v.sentence, /could not prove it is this desktop/);
});

test("the SSID gate stops the ladder before any request", async () => {
  const { router, calls } = rig({ net: async () => ({ ...WIFI, ssid: "Cafe" }) });
  const v = await router.evaluate("net");
  assert.equal(v.route, "tailnet");
  assert.match(v.sentence, /"Cafe" is not one of this desktop's saved networks/);
  assert.deepEqual(calls, []);
});

test("a host with no password cannot mint a token: tailnet, and the sentence says to set one", async () => {
  const { router, calls } = rig({ ensureToken: async () => "no-password" });
  const v = await router.evaluate("start");
  assert.equal(v.route, "tailnet");
  assert.equal(v.sentence, NO_PASSWORD_SENTENCE);
  assert.match(v.sentence, /set a password on the host to use LAN/);
  assert.deepEqual(calls, [], "nothing is sent to the LAN address");
});

test("no identity ⇒ tailnet, and the LAN address is never contacted", async () => {
  const { router, calls } = rig({ ensureIdentity: async () => { calls.push("identity"); return null; } });
  const v = await router.evaluate("start");
  assert.equal(v.sentence, NO_IDENTITY_SENTENCE);
  assert.deepEqual(calls, ["token", "identity"]);
});

test("a probe that fails or throws ⇒ tailnet, no verify", async () => {
  const a = rig({ probe: async () => ({ ok: false, at: 5 }) });
  assert.equal((await a.router.evaluate("start")).route, "tailnet");
  assert.ok(!a.calls.some((c) => c.startsWith("verify")));
  const b = rig({ probe: async () => { throw new Error("boom"); } });
  const v = await b.router.evaluate("start");
  assert.equal(v.route, "tailnet");
  assert.equal(v.lanBase, null);
});

test("a LAN failure falls back to the tailnet at once and names the reason; the next trigger re-probes", async () => {
  const { router, applied } = rig();
  await router.evaluate("start");
  const f = router.noteFailure("the connection dropped");
  assert.equal(f.route, "tailnet");
  assert.equal(f.lanBase, null);
  assert.match(f.sentence, /the LAN connection failed \(the connection dropped\)/);
  assert.equal(applied.at(-1), f);
  const again = await router.evaluate("reopen");
  assert.equal(again.route, "lan", "a probe newer than the failure lets the LAN back");
});

test("single flight: triggers during a pass share it and cause exactly ONE more pass", async () => {
  let release;
  let passes = 0;
  const gate = new Promise((r) => { release = r; });
  const { router, applied } = rig({ net: async () => { passes++; if (passes === 1) await gate; return WIFI; } });
  const p1 = router.evaluate("start");
  const p2 = router.evaluate("net");
  const p3 = router.evaluate("reopen");
  assert.equal(p1, p2);
  assert.equal(p2, p3);
  release();
  const v = await p1;
  assert.equal(passes, 2, "one pass, plus one for the triggers that landed mid-flight");
  assert.equal(v.route, "lan");
  assert.equal(applied.filter((x) => x.route === "lan").length, 1, "the stale pass did not apply its LAN verdict");
});

test("a stale pass may still fall BACK: its tailnet verdict is applied at once", async () => {
  let release;
  let passes = 0;
  const gate = new Promise((r) => { release = r; });
  const { router, applied } = rig({
    net: async () => { passes++; if (passes === 1) { await gate; return { ...WIFI, transport: "cellular" }; } return WIFI; },
  });
  const p = router.evaluate("start");
  void router.evaluate("net");
  release();
  await p;
  assert.equal(applied[0].route, "tailnet");
  assert.equal(applied.at(-1).route, "lan");
});

test("no host (browser / nothing paired) ⇒ nothing applied", async () => {
  const { router, applied } = rig({ host: () => null });
  assert.equal(await router.evaluate("start"), null);
  assert.equal(applied.length, 0);
});

test("saving LAN settings drops a LAN route they no longer allow, at once", async () => {
  const { lanDropOnSave } = await import("./lanRoute.ts");
  const LAN = "http://192.168.1.20:8770";
  assert.equal(lanDropOnSave(null, { base: LAN, auto: false }), null, "already on the tailnet: nothing to drop");
  assert.match(lanDropOnSave(LAN, { base: LAN, auto: false }), /automatically is off/);
  assert.match(lanDropOnSave(LAN, null), /automatically is off/, "LAN address removed");
  assert.match(lanDropOnSave(LAN, { base: "http://192.168.1.21:8770", auto: true }), /address changed/);
  assert.equal(lanDropOnSave(LAN, { base: LAN, auto: true }), null, "still allowed: the ladder re-decides");
});
