import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  NO_IDENTITY_SENTENCE, NO_PASSWORD_SENTENCE, NO_PROTECTED_LAN_SENTENCE, asksLanPassword, createLanRouter, fallbackGone, lanDialOf, lanMacHex, lanOnlyBase, lanOnlySentence, lanProbeAnswered, newNonce,
  parseLanIdentity, pinSyncPlan, refusalFits, tailscaleOffSentence, troubleSentence, verifyLanAnswer, welcomePinPlan,
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

test("the LAN probe counts a gated host's 401 as an answer — the probe carries no token", () => {
  assert.equal(lanProbeAnswered(200), true);
  assert.equal(lanProbeAnswered(401), true, "a password-gated host refuses a tokenless /api/health over LAN with 401");
  assert.equal(lanProbeAnswered(403), false, "an origin refusal is not a usable answer");
  assert.equal(lanProbeAnswered(500), false);
  assert.equal(lanProbeAnswered(302), false, "a captive portal redirect is not this host");
});

// ── A desktop this phone holds a pin for ───────────────────────────────

const SPKI = "ab".repeat(32);
const TLS = { port: 8771, spki: SPKI };
const PLAIN_LAN = "http://192.168.1.20:8770";
const TLS_LAN = "https://192.168.1.20:8771";
const ROW = { id: "row11111", name: "desk", base: "http://100.64.0.5:8770", lan: { base: PLAIN_LAN, ssids: ["Home"], auto: true }, tls: TLS };

const pinnedRig = (row, enforcing, over = {}) => rig({
  host: () => row,
  dial: (lan) => lanDialOf(row, lan, enforcing),
  noFallback: (net) => fallbackGone(row, net),
  ...over,
});

test("the ladder checks a pinned row on its TLS address, and the route it yields is that address", async () => {
  const { router, calls } = pinnedRig(ROW, true);
  const v = await router.evaluate("start");
  assert.equal(v.lanBase, TLS_LAN);
  assert.ok(calls.includes(`probe ${TLS_LAN}`) && calls.includes(`verify ${TLS_LAN}`));
  assert.ok(!calls.some((c) => c.includes(PLAIN_LAN)), "the plain address is never contacted");
  assert.match(v.sentence, /192\.168\.1\.20:8771/);
});

test("an enforcing shell never yields a plain LAN route, whichever step fails", async () => {
  const dead = async (base) => { assert.notEqual(base, PLAIN_LAN); return { ok: false, at: 5000 }; };
  for (const over of [{ probe: dead }, { verify: async () => null }]) {
    const { router, calls } = pinnedRig(ROW, true, over);
    const v = await router.evaluate("start");
    assert.equal(v.route, "tailnet");
    assert.equal(v.lanBase, null);
    assert.ok(!calls.some((c) => c.includes(PLAIN_LAN)));
  }
});

test("a LAN address with no TLS form is refused for a pinned row, with nothing contacted", async () => {
  const row = { ...ROW, lan: { ...ROW.lan, base: "https://192.168.1.20:9000" } };
  const { router, calls } = pinnedRig(row, true);
  const v = await router.evaluate("start");
  assert.equal(v.sentence, NO_PROTECTED_LAN_SENTENCE);
  assert.deepEqual(calls, []);
});

test("a shipped shell holding a pin stays on the plain LAN, as does a row on plain HTTP by choice", async () => {
  assert.equal((await pinnedRig(ROW, false).router.evaluate("start")).lanBase, PLAIN_LAN);
  const off = { ...ROW, tls: undefined, tlsOff: true };
  assert.equal((await pinnedRig(off, true).router.evaluate("start")).lanBase, PLAIN_LAN);
});

test("a refused key on the way to the tailnet is said; a plain no-answer keeps the ladder's sentence", async () => {
  const fail = { probe: async () => ({ ok: false, at: 5000 }) };
  const v = await pinnedRig(ROW, true, { ...fail, refused: async () => true }).router.evaluate("start");
  assert.equal(v.trouble, "keyChanged");
  assert.match(v.sentence, /^Using the tailnet: .*different key.*someone is in between\.$/);
  const w = await pinnedRig(ROW, true, { ...fail, refused: async () => false }).router.evaluate("start");
  assert.equal(w.trouble, undefined);
  assert.match(w.sentence, /^Using the tailnet: https:\/\/192\.168\.1\.20:8771 did not answer/);
});

test("with no tailnet to fall to, both failures offer pairing by code and neither says tailnet", async () => {
  const fail = { probe: async () => ({ ok: false, at: 5000 }) };
  const off = { net: async () => ({ ...WIFI, tailnet: false }) };
  for (const [refused, trouble] of [[true, "keyChanged"], [false, "noAnswer"]]) {
    const v = await pinnedRig(ROW, true, { ...fail, ...off, refused: async () => refused }).router.evaluate("start");
    assert.equal(v.trouble, trouble);
    assert.match(v.sentence, /pair again by code\.$/);
    assert.doesNotMatch(v.sentence, /tailnet/);
  }
});

test("fallbackGone: a LAN-only row, or Tailscale KNOWN off; absent is unknown, never off", () => {
  assert.equal(fallbackGone({ base: PLAIN_LAN }, null), true);
  assert.equal(fallbackGone({ base: ROW.base }, { ...WIFI, tailnet: false }), true);
  assert.equal(fallbackGone({ base: "https://x.y.ts.net" }, { ...WIFI, tailnet: false }), true);
  assert.equal(fallbackGone({ base: ROW.base }, WIFI), false, "a VPN with no addresses yet reports nothing");
  assert.equal(fallbackGone({ base: ROW.base }, { ...WIFI, tailnet: true }), false);
  assert.equal(fallbackGone({ base: ROW.base }, null), false);
  assert.equal(lanOnlyBase("https://me.example"), false, "a vouched proxy is not a LAN address");
});

test("the words name the address without its scheme", () => {
  assert.match(lanOnlySentence(TLS_LAN), /at 192\.168\.1\.20:8771\. No tailnet address/);
  assert.match(troubleSentence("noAnswer", TLS_LAN, false), /^192\.168\.1\.20:8771 did not answer\. The desktop may be off, or its address may have changed: pair again by code\.$/);
});

test("a refusal counts only for this address and only when newer than `since`", () => {
  assert.equal(refusalFits(null, TLS_LAN), false);
  assert.equal(refusalFits({ host: "192.168.1.20", at: 10 }, TLS_LAN), true);
  assert.equal(refusalFits({ host: "192.168.1.99", at: 10 }, TLS_LAN), false);
  assert.equal(refusalFits({ host: "192.168.1.20", at: 10 }, TLS_LAN, 11), false, "history");
  assert.equal(refusalFits({ host: "fd00::1", at: 10 }, "https://[fd00::1]:8771"), true, "IPv6 with or without brackets");
  assert.equal(refusalFits({ at: 10 }, TLS_LAN), true, "no name to compare");
});

test("a welcome teaches only on a protected dial, and absent fields clear nothing", () => {
  const w = { hostId: "desk5678", tlsPort: 8771, tlsSpki: SPKI };
  const row = { base: ROW.base };
  assert.equal(welcomePinPlan(row, w, false), null, "never on an unprotected route");
  assert.deepEqual(welcomePinPlan(row, w, true), { hostId: "desk5678", tls: TLS });
  assert.equal(welcomePinPlan({ ...row, hostId: "desk5678", tls: TLS }, w, true), null, "nothing new");
  assert.equal(welcomePinPlan({ ...row, hostId: "desk5678", tls: TLS }, { hostId: "desk5678" }, true), null, "a socket not bound yet leaves the pin");
});

test("a re-keyed desktop's welcome replaces the pin; a bad value, tlsOff and a vouched proxy do not", () => {
  const other = "cd".repeat(32);
  const held = { base: ROW.base, tls: TLS };
  assert.deepEqual(welcomePinPlan(held, { tlsPort: 8771, tlsSpki: other }, true), { tls: { port: 8771, spki: other } });
  assert.deepEqual(welcomePinPlan(held, { tlsPort: 9000, tlsSpki: SPKI }, true), { tls: { port: 9000, spki: SPKI } });
  assert.equal(welcomePinPlan(held, { tlsPort: 8771, tlsSpki: "nope" }, true), null);
  assert.equal(welcomePinPlan({ base: ROW.base, tlsOff: true }, { tlsPort: 8771, tlsSpki: SPKI }, true), null);
  assert.equal(welcomePinPlan({ base: "https://me.example" }, { tlsPort: 8771, tlsSpki: SPKI }, true), null, "the service would refuse the proxy's own leaf");
  assert.deepEqual(welcomePinPlan({ base: "https://x.y.ts.net" }, { tlsPort: 8771, tlsSpki: SPKI }, true), { tls: TLS }, "ts.net keeps system trust, so it may hold one");
});

test("the shell's pins follow the rows; a pin already right is left alone, keeping the refusal", () => {
  const rows = [{ id: "aaaa1111", tls: TLS }, { id: "bbbb2222" }, { id: "cccc3333", tlsOff: true }];
  assert.deepEqual(pinSyncPlan(rows, []), { set: [{ hostId: "aaaa1111", spki: SPKI }], remove: [] });
  assert.deepEqual(pinSyncPlan(rows, [{ hostId: "aaaa1111", spki: SPKI }]), { set: [], remove: [] });
  assert.deepEqual(pinSyncPlan(rows, [{ hostId: "aaaa1111", spki: "cd".repeat(32) }]).set, [{ hostId: "aaaa1111", spki: SPKI }]);
  assert.deepEqual(pinSyncPlan(rows, [{ hostId: "cccc3333", spki: SPKI }, { hostId: "gone1111", spki: SPKI }]).remove, ["cccc3333", "gone1111"]);
});

// ── Tailscale off, and nothing to fall to ───────────────────────────────

const FOREIGN = { ...WIFI, ssid: "Cafe", tailnet: false };

test("Tailscale off on a foreign Wi-Fi: the sentence never says the tailnet is in use", async () => {
  const v = await pinnedRig(ROW, true, { net: async () => FOREIGN }).router.evaluate("start");
  assert.equal(v.route, "tailnet");
  assert.equal(v.sentence, `Tailscale is off on this device: turn it on to reach the desktop. Not on LAN: "Cafe" is not one of this desktop's saved networks.`);
});

test("off mobile data, with LAN off, and a failure in use: the same, and the reason stays", async () => {
  const mobile = await pinnedRig(ROW, true, { net: async () => ({ ...FOREIGN, transport: "cellular", ssid: null }) }).router.evaluate("start");
  assert.match(mobile.sentence, /^Tailscale is off on this device.*the phone is on mobile data\.$/);
  const off = { ...ROW, lan: { ...ROW.lan, auto: false } };
  assert.match((await pinnedRig(off, true, { net: async () => FOREIGN }).router.evaluate("start")).sentence, /^Tailscale is off.*switching to LAN automatically is off\.$/);
  const { router } = pinnedRig(ROW, true, { net: async () => FOREIGN });
  await router.evaluate("start");
  assert.match(router.noteFailure("closed").sentence, /^Tailscale is off.*the LAN connection failed \(closed\)/);
});

test("the old sentence stays where it is true: Tailscale on or unknown, or an address that needs no tunnel", async () => {
  const say = async (row, net) => (await pinnedRig(row, true, { net: async () => net }).router.evaluate("start")).sentence;
  const said = `Using the tailnet: "Cafe" is not one of this desktop's saved networks.`;
  assert.equal(await say(ROW, { ...FOREIGN, tailnet: true }), said);
  const { tailnet: _t, ...unknown } = FOREIGN;
  assert.equal(await say(ROW, unknown), said);
  assert.equal(await say({ ...ROW, base: "https://me.example" }, FOREIGN), said);
  assert.equal(rig({ net: async () => FOREIGN }).router.noteFailure("x").sentence.startsWith("Using the tailnet"), true, "no network read yet: nothing known");
});

test("a sentence that claims no tailnet is left alone, and the password button survives the rewording", () => {
  const trouble = troubleSentence("noAnswer", PLAIN_LAN, false);
  assert.equal(tailscaleOffSentence(trouble), trouble);
  assert.equal(asksLanPassword(NO_PASSWORD_SENTENCE), true);
  assert.equal(asksLanPassword(tailscaleOffSentence(NO_PASSWORD_SENTENCE)), true);
  assert.equal(asksLanPassword(NO_IDENTITY_SENTENCE), false);
});
