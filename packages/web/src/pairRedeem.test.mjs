/**
 * Pairing by code, the pure half: what the form accepts, what a deep link may
 * do (open a question — never redeem), and where a redeem's token and LAN
 * identity land (bare for the active host, parked for any other, both when
 * there is no host yet) — over the same Map-backed storage shim as hosts.test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HOST_PARK_PREFIX, PAIR_SCHEME, parkedKeyFor, pairDeepLink, pairLandingUrl } from "@waterplane/shared";

import {
  PAIR_LINK_INVALID, fieldsFromPaste, pairLinkRequest, pairLinkSentence, pairTargetOf, readRedeemReply, redeemErrorText,
  PAIR_ROW_KEPT, heldTokenFor, pairAddressOf, pairedNoRoute, scopedKeys, sealedAsk, storeRedeemed, storeSealed,
} from "./pairRedeem.ts";
import { heldToken, holdToken, releaseTokens } from "./deviceToken.ts";
import { addHost, finishSwitch, readHosts, setHostPins, setHostTlsOff, setHostUpdateKey, updateHost, writeSwitch } from "./hosts.ts";
import { LS } from "./storage.ts";

function shim(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz012345";
const IDENT = { hostId: "hid-1", secret: "s".repeat(32) };
const reply = (base, extra = {}) => ({ ok: true, host: { name: "studio", base, httpsUrl: null }, token: TOKEN, lanIdentity: IDENT, ...extra });

// ── Input ────────────────────────────────────────────────────────────────

test("address + code: both must be clean; case, spaces and dashes forgiven", () => {
  assert.deepEqual(pairTargetOf({ address: "100.64.0.5", code: "abcd-efgh" }), { base: "http://100.64.0.5:8770", code: "ABCDEFGH" });
  assert.equal(pairTargetOf({ address: "100.64.0.5", code: "ABCD" }), null);
  assert.equal(pairTargetOf({ address: "100.64.0.5", code: "ABCD0FGH" }), null, "0 is not in the alphabet — never guessed");
  assert.equal(pairTargetOf({ address: "", code: "ABCDEFGH" }), null);
  assert.equal(pairTargetOf({ address: "javascript:alert(1)", code: "ABCDEFGH" }), null);
});

test("a pasted landing URL or deep link in the address field fills both fields", () => {
  const land = pairLandingUrl("https://mac.tail1.ts.net", "ABCDEFGH");
  assert.deepEqual(fieldsFromPaste(land), { address: "https://mac.tail1.ts.net", code: "ABCDEFGH" });
  const deep = pairDeepLink("http://100.64.0.5:8770", "ZZZZ2345");
  assert.deepEqual(fieldsFromPaste(deep), { address: "http://100.64.0.5:8770", code: "ZZZZ2345" });
  assert.equal(fieldsFromPaste("100.64.0.5"), null, "a bare address is just an address");
  // and the target reads the link even with the code field empty
  assert.deepEqual(pairTargetOf({ address: land, code: "" }), { base: "https://mac.tail1.ts.net", code: "ABCDEFGH" });
  assert.equal(fieldsFromPaste(`${land}/apk`), null, "the APK download path is not a pairing link");
});

// ── Deep links ───────────────────────────────────────────────────────────

test("a deep link only ever asks: a valid one opens the form prefilled, an invalid one is refused", () => {
  const ok = pairLinkRequest(pairDeepLink("http://100.64.0.5:8770", "ABCDEFGH"));
  assert.deepEqual(ok, { kind: "ask", target: { base: "http://100.64.0.5:8770", code: "ABCDEFGH" } });
  assert.match(pairLinkSentence(ok.target), /100\.64\.0\.5:8770/);
  assert.match(pairLinkSentence(ok.target), /Nothing is sent until you tap pair/);
  for (const bad of [
    `${PAIR_SCHEME}://pair?u=javascript%3Aalert(1)&c=ABCDEFGH`,
    `${PAIR_SCHEME}://pair?u=http%3A%2F%2F100.64.0.5&c=nope`,
    `${PAIR_SCHEME}://open?u=http%3A%2F%2F100.64.0.5&c=ABCDEFGH`,
    pairLandingUrl("http://100.64.0.5:8770", "ABCDEFGH"), // a landing URL is not a deep link
    "", null, 42,
  ]) assert.deepEqual(pairLinkRequest(bad), { kind: "invalid" }, String(bad));
  assert.equal(PAIR_LINK_INVALID, "That pairing link isn't valid");
});

// That a deep link reaching the shell's REAL global never redeems or stores
// anything is driven end to end in `shellPair.test.mjs`.

// ── The reply ────────────────────────────────────────────────────────────

test("refusals: no-password shows the host's own words, the rest ours", () => {
  const np = readRedeemReply(403, { ok: false, error: "no-password", message: "Pair over Tailscale." });
  assert.equal(np.ok, false);
  assert.equal(redeemErrorText(np), "Pair over Tailscale.");
  const exp = readRedeemReply(410, { ok: false, error: "expired", message: "host words" });
  assert.match(redeemErrorText(exp), /expired/);
  assert.notEqual(redeemErrorText(exp), "host words");
  assert.equal(readRedeemReply(429, null).error, "rate-limited");
  const junk = readRedeemReply(502, "<html>");
  assert.equal(junk.error, "bad-reply");
  assert.match(redeemErrorText(junk), /502/);
  assert.equal(readRedeemReply(200, reply("http://100.64.0.5:8770")).ok, true);
});

// ── Storing ──────────────────────────────────────────────────────────────

test("scoped keys: bare for the active host, parked for another, both with no host", () => {
  assert.deepEqual(scopedKeys(LS.deviceToken, "aaa111", "aaa111"), [LS.deviceToken]);
  assert.deepEqual(scopedKeys(LS.deviceToken, "bbb222", "aaa111"), [parkedKeyFor(LS.deviceToken, "bbb222")]);
  assert.deepEqual(scopedKeys(LS.deviceToken, "bbb222", null), [LS.deviceToken, parkedKeyFor(LS.deviceToken, "bbb222")]);
});

test("pairing a SECOND desktop parks its token; the active host's bare keys are untouched", () => {
  const kv = shim();
  const a = addHost(kv, { base: "100.64.0.1" });
  assert.ok(a.ok);
  kv.setItem(LS.hostActive, a.host.id);
  kv.setItem(LS.hostBase, a.host.base);
  kv.setItem(LS.deviceToken, "active_host_token_000000");
  kv.setItem(LS.lanIdentity, JSON.stringify({ hostId: "A", secret: "a".repeat(32) }));
  const target = { base: "http://100.64.0.2:8770", code: "ABCDEFGH" };
  const r = storeRedeemed(kv, reply("http://100.64.0.2:8770", { host: { name: "studio", base: "http://100.64.0.2:8770", httpsUrl: null, lanBase: "http://192.168.1.20:8770" } }), target);
  assert.ok(r.ok);
  assert.equal(r.added, true);
  assert.equal(r.isActive, false);
  assert.equal(kv.getItem(LS.deviceToken), "active_host_token_000000");
  assert.equal(JSON.parse(kv.getItem(LS.lanIdentity)).hostId, "A");
  assert.equal(kv.getItem(parkedKeyFor(LS.deviceToken, r.host.id)), TOKEN);
  assert.deepEqual(r.host.lan, { base: "http://192.168.1.20:8770", ssids: [], auto: false });
  // …and the switch at the next boot brings them in as bare keys, parking A's.
  writeSwitch(kv, { from: a.host.id, to: r.host.id });
  finishSwitch(kv);
  assert.equal(kv.getItem(LS.deviceToken), TOKEN);
  assert.equal(kv.getItem(parkedKeyFor(LS.deviceToken, a.host.id)), "active_host_token_000000");
});

test("re-pairing the ACTIVE desktop writes bare keys and adds no second row", () => {
  const kv = shim();
  const a = addHost(kv, { name: "mine", base: "100.64.0.1" });
  kv.setItem(LS.hostActive, a.host.id);
  const r = storeRedeemed(kv, reply("http://100.64.0.1:8770"), { base: "http://100.64.0.1:8770", code: "ABCDEFGH" });
  assert.ok(r.ok);
  assert.equal(r.added, false);
  assert.equal(r.isActive, true);
  assert.equal(r.host.name, "mine", "a known host keeps the name somebody gave it");
  assert.equal(readHosts(kv).length, 1);
  assert.equal(kv.getItem(LS.deviceToken), TOKEN);
  assert.ok(![...kv.m.keys()].some((k) => k.startsWith(HOST_PARK_PREFIX)), "nothing parked for the active host");
});

test("a re-pair sends the token this phone holds for EXACTLY that saved address — active or parked — and nothing otherwise", () => {
  const kv = shim();
  const a = addHost(kv, { base: "100.64.0.1" });
  const b = addHost(kv, { base: "100.64.0.2" });
  kv.setItem(LS.hostActive, a.host.id);
  kv.setItem(LS.deviceToken, "active_host_token_000000");
  kv.setItem(parkedKeyFor(LS.deviceToken, b.host.id), "parked_host_token_000000");
  assert.equal(heldTokenFor(kv, "http://100.64.0.1:8770"), "active_host_token_000000");
  assert.equal(heldTokenFor(kv, "http://100.64.0.2:8770"), "parked_host_token_000000", "a parked host's own token, never the active one's");
  assert.equal(heldTokenFor(kv, "http://100.64.0.9:8770"), null, "an unknown address gets no token at all");
  kv.removeItem(parkedKeyFor(LS.deviceToken, b.host.id));
  assert.equal(heldTokenFor(kv, "http://100.64.0.2:8770"), null, "no token held: none sent (and no bare token leaks to it)");
});

test("first run (no host yet): bare AND parked, so the boot's fill-only restore cannot leave a stale bare token", () => {
  const kv = shim({ [LS.deviceToken]: "leftover_token_from_before_0000" });
  const r = storeRedeemed(kv, reply("http://100.64.0.9:8770"), { base: "http://100.64.0.9:8770", code: "ABCDEFGH" });
  assert.ok(r.ok);
  assert.equal(kv.getItem(LS.deviceToken), TOKEN);
  assert.equal(kv.getItem(parkedKeyFor(LS.deviceToken, r.host.id)), TOKEN);
  writeSwitch(kv, { from: null, to: r.host.id });
  finishSwitch(kv);
  assert.equal(kv.getItem(LS.hostActive), r.host.id);
  assert.equal(kv.getItem(LS.deviceToken), TOKEN);
});

test("no password on the host: no token written, the host still added; a bad-shaped token is never stored", () => {
  const kv = shim();
  const r = storeRedeemed(kv, { ok: true, host: { name: "x", base: "http://100.64.0.3:8770", httpsUrl: null }, note: "no password" }, { base: "http://100.64.0.3:8770", code: "ABCDEFGH" });
  assert.ok(r.ok);
  assert.deepEqual(r.wrote, []);
  const kv2 = shim();
  const r2 = storeRedeemed(kv2, reply("http://100.64.0.4:8770", { token: "short", lanIdentity: { hostId: "h", secret: "tiny" } }), { base: "http://100.64.0.4:8770", code: "ABCDEFGH" });
  assert.ok(r2.ok);
  assert.deepEqual(r2.wrote, []);
});

// ── Sealed mode ──────────────────────────────────────────────────────────

test("sealed: a redeemed token is held and written to no key, and the caller is told to re-wrap", (t) => {
  t.after(releaseTokens);
  const kv = shim({ [LS.tokenSealOn]: "1" });
  const a = addHost(kv, { name: "a", base: "http://100.64.0.1:8770" });
  kv.setItem(LS.hostActive, a.host.id);
  const r = storeRedeemed(kv, reply("http://100.64.0.2:8770"), { base: "http://100.64.0.2:8770", code: "ABCDEFGH" });
  assert.equal(r.sealedPending, true);
  assert.equal(heldToken(r.host.id), TOKEN);
  assert.ok(![...kv.m.values()].includes(TOKEN), "the token is in no key");
});

test("mode off: nothing held, nothing pending", (t) => {
  t.after(releaseTokens);
  const kv = shim();
  const r = storeRedeemed(kv, reply("http://100.64.0.2:8770"), { base: "http://100.64.0.2:8770", code: "ABCDEFGH" });
  assert.equal(r.sealedPending, false);
  assert.equal(heldToken(r.host.id), null);
});

test("sealed: a passive token stays plain, and takes the place of a full one held for that desktop", (t) => {
  t.after(releaseTokens);
  const kv = shim({ [LS.tokenSealOn]: "1" });
  const a = addHost(kv, { name: "a", base: "http://100.64.0.1:8770" });
  kv.setItem(LS.hostActive, a.host.id);
  const b = addHost(kv, { name: "b", base: "http://100.64.0.2:8770" });
  holdToken(b.host.id, "full_token_held_00000000");
  const r = storeRedeemed(kv, reply("http://100.64.0.2:8770", { scope: "passive" }), { base: "http://100.64.0.2:8770", code: "ABCDEFGH" });
  assert.equal(r.sealedPending, false);
  assert.equal(kv.getItem(parkedKeyFor(LS.deviceToken, b.host.id)), TOKEN);
  assert.equal(heldToken(b.host.id), null);
});

test("sealed: a re-pair sends the held token, and an unopened blob sends none", (t) => {
  t.after(releaseTokens);
  const kv = shim({ [LS.tokenSealOn]: "1" });
  const a = addHost(kv, { name: "a", base: "http://100.64.0.1:8770" });
  kv.setItem(LS.hostActive, a.host.id);
  assert.equal(heldTokenFor(kv, "http://100.64.0.1:8770"), null);
  holdToken(a.host.id, "held_token_for_a_00000000");
  assert.equal(heldTokenFor(kv, "http://100.64.0.1:8770"), "held_token_for_a_00000000");
});

// ── Rule 1: an unsealed reply ────────────────────────────────────────────

const ASKED = { base: "http://192.168.1.20:8770", code: "ABCDEFGH" };
const SPKI = "a".repeat(64);

test("a row's address is what was asked: no reply's base is ever stored", () => {
  for (const planted of ["https://203.0.113.5", "https://r.example", "http://100.64.0.1:8770", "http://x.ts.net:8770", "https://x.y.ts.net"]) {
    const kv = shim();
    const r = storeRedeemed(kv, reply(planted, { host: { name: "studio", base: planted, httpsUrl: planted } }), ASKED);
    assert.ok(r.ok, planted);
    assert.equal(r.host.base, ASKED.base, planted);
    assert.deepEqual(readHosts(kv).map((h) => h.base), [ASKED.base], planted);
    assert.equal(r.host.vouched, undefined, planted);
  }
});

test("a tailnet pairing, the commonest case, ends with a working row at the address it was asked on", () => {
  for (const base of ["http://100.64.0.5:8770", "https://desk.tail1.ts.net"]) {
    const kv = shim();
    const r = storeRedeemed(kv, reply("https://desk.tail1.ts.net", { host: { name: "desk", base: "https://desk.tail1.ts.net", httpsUrl: "https://desk.tail1.ts.net", lanBase: "http://192.168.1.20:8770" } }), { base, code: "ABCDEFGH" });
    assert.ok(r.ok);
    assert.equal(r.host.base, base);
    assert.equal(r.host.name, "desk");
    assert.equal(kv.getItem(LS.deviceToken), TOKEN);
    assert.equal(r.host.lan?.base, "http://192.168.1.20:8770", "the LAN side is offered to the row as before");
  }
});

test("an unsealed reply sets no hostId, tls, updateKey or LAN identity, whatever it carries", () => {
  const kv = shim();
  const r = storeRedeemed(kv, reply(ASKED.base, { hostId: "abcd1234", tls: { port: 8771, spki: SPKI }, updateKey: "k".repeat(32) }), ASKED);
  assert.ok(r.ok);
  for (const f of ["hostId", "tls", "updateKey", "vouched"]) assert.equal(r.host[f], undefined, f);
  assert.ok(![...kv.m.keys()].some((k) => k.endsWith(LS.lanIdentity.split(".").pop())), "no identity under any key");
  assert.ok(!r.wrote.some((k) => k.includes("lanIdentity")));
});

test("lanBase is kept only if plain by name: a reply can never make a route protected", () => {
  const lanOf = (lanBase) => {
    const r = storeRedeemed(shim(), reply(ASKED.base, { host: { name: "s", base: ASKED.base, httpsUrl: null, lanBase } }), ASKED);
    assert.ok(r.ok);
    return r.host.lan?.base;
  };
  assert.equal(lanOf("http://192.168.1.20:8770"), "http://192.168.1.20:8770");
  for (const b of ["http://100.64.0.1:8770", "http://x.ts.net:8770", "https://x.y.ts.net", "http://127.0.0.1:8770"]) assert.equal(lanOf(b), undefined, b);
});

test("a row holding a pin, a vouched address or a hostId is never touched: not the row, not its token", () => {
  const rows = [
    { base: "http://100.64.0.1:8770", set: (kv, id) => setHostPins(kv, id, { hostId: "abcd1234" }) },
    { base: "http://192.168.1.20:8770", set: (kv, id) => setHostPins(kv, id, { tls: { port: 8771, spki: SPKI } }) },
    { base: "https://me.example", opened: "" },
  ];
  for (const { base, set, opened } of rows) {
    const kv = shim();
    const a = addHost(kv, { name: "mine", base, opened });
    set?.(kv, a.host.id);
    kv.setItem(LS.hostActive, a.host.id);
    kv.setItem(LS.deviceToken, "held_token_before_this_000000");
    const before = kv.getItem(LS.hosts);
    const r = storeRedeemed(kv, reply(base, { host: { name: "planted", base, httpsUrl: null, lanBase: "http://10.0.0.9:8770" } }), { base, code: "ABCDEFGH" });
    assert.deepEqual(r, { ok: false, why: PAIR_ROW_KEPT }, base);
    assert.equal(kv.getItem(LS.hosts), before, base);
    assert.equal(kv.getItem(LS.deviceToken), "held_token_before_this_000000", base);
  }
});

test("an unsealed reply never matches by hostId: a row elsewhere is left alone and a new row holds what was asked", () => {
  const kv = shim();
  const a = addHost(kv, { name: "mine", base: "http://100.64.0.1:8770" });
  setHostPins(kv, a.host.id, { hostId: "abcd1234", tls: { port: 8771, spki: SPKI } });
  const r = storeRedeemed(kv, reply(ASKED.base, { hostId: "abcd1234" }), ASKED);
  assert.ok(r.ok);
  assert.equal(r.added, true);
  assert.notEqual(r.host.id, a.host.id);
  assert.equal(readHosts(kv).find((h) => h.id === a.host.id).base, "http://100.64.0.1:8770");
});

test("a re-pair at a row's own address with nothing to protect still works, and fills a LAN address it lacked", () => {
  const kv = shim();
  const a = addHost(kv, { name: "mine", base: ASKED.base });
  const r = storeRedeemed(kv, reply("https://r.example", { host: { name: "planted", base: "https://r.example", httpsUrl: null, lanBase: "http://10.0.0.9:8770" } }), ASKED);
  assert.ok(r.ok);
  assert.equal(r.host.id, a.host.id);
  assert.equal(r.host.name, "mine");
  assert.equal(r.host.base, ASKED.base);
  assert.equal(r.host.lan.base, "http://10.0.0.9:8770");
});

// ── Link facts ───────────────────────────────────────────────────────────

test("what a link says follows its code: through a changed address, and dropped with a changed code", () => {
  const link = { base: "http://100.64.0.5:8770", code: "ABCDEFGH", secure: true, commit: "0123456789abcdef0123456789abcdef", lan: "http://192.168.1.20:8770" };
  assert.deepEqual(pairTargetOf({ address: link.base, code: "ABCD-EFGH" }, link), link);
  assert.deepEqual(pairTargetOf({ address: link.lan, code: "ABCD-EFGH" }, link), { ...link, base: link.lan });
  assert.deepEqual(pairTargetOf({ address: link.base, code: "ZZZZ2345" }, link), { base: link.base, code: "ZZZZ2345" });
  assert.deepEqual(pairTargetOf({ address: link.base, code: "ABCD-EFGH" }), { base: link.base, code: "ABCDEFGH" });
  const pasted = pairDeepLink(link.base, "ZZZZ2345", { secure: true, commit: "0123456789abcdef0123456789abcdef" });
  assert.equal(pairTargetOf({ address: pasted, code: "" }).secure, true, "a whole link in the field speaks for itself");
});

// ── A seal ───────────────────────────────────────────────────────────────

const SEAL_SPKI = "b".repeat(64);
const KEY = Buffer.alloc(91, 7).toString("base64");
const KEY2 = Buffer.alloc(91, 8).toString("base64");
const WIFI = { base: "http://192.168.1.20:8770", code: "ABCDEFGH" };
const NET = { base: "http://100.64.0.5:8770", code: "ABCDEFGH" };
const sealed = (extra = {}) => ({
  ok: true, host: { name: "studio", base: "http://203.0.113.9:8770", httpsUrl: null }, token: TOKEN, hostId: "abcd1234",
  lanIdentity: { hostId: "abcd1234", secret: "s".repeat(32) }, tls: { port: 8771, spki: SEAL_SPKI }, updateKey: KEY, ...extra,
});

test("a seal on a new desktop: the address is what was asked, and everything only a seal may carry lands", () => {
  const kv = shim();
  addHost(kv, { name: "other", base: "http://100.64.0.9:8770" });
  kv.setItem(LS.hostActive, readHosts(kv)[0].id);
  const r = storeSealed(kv, sealed(), WIFI);
  assert.equal(r.ok, true);
  assert.equal(r.added, true);
  assert.equal(r.host.base, WIFI.base, "never the reply's");
  assert.equal(r.host.name, "studio");
  assert.equal(r.host.hostId, "abcd1234");
  assert.deepEqual(r.host.tls, { port: 8771, spki: SEAL_SPKI });
  assert.deepEqual(r.host.updateKey, { key: KEY, gen: 0 });
  assert.equal(kv.getItem(parkedKeyFor(LS.deviceToken, r.host.id)), TOKEN);
  assert.deepEqual(JSON.parse(kv.getItem(parkedKeyFor(LS.lanIdentity, r.host.id))), sealed().lanIdentity);
  assert.equal(kv.getItem(LS.lanIdentity), null, "the active desktop's identity is untouched");
  assert.equal(sealedAsk(shim(), sealed(), WIFI), null, "nothing to ask about a desktop this phone has never seen");
});

test("a sealed row's LAN side: asked on the LAN address it is not stored twice, and a reply cannot name a protected one", () => {
  const same = storeSealed(shim(), sealed({ host: { name: "s", base: "x", httpsUrl: null, lanBase: WIFI.base } }), WIFI);
  assert.equal(same.host.lan, undefined);
  const kept = storeSealed(shim(), sealed({ host: { name: "s", base: "x", httpsUrl: null, lanBase: WIFI.base } }), NET);
  assert.equal(kept.host.lan.base, WIFI.base);
  const planted = storeSealed(shim(), sealed({ host: { name: "s", base: "x", httpsUrl: null, lanBase: "http://100.64.0.1:8770" } }), WIFI);
  assert.equal(planted.host.lan, undefined);
});

test("a re-pair at the row's own address overwrites the pin, keeps gen under the same key and asks nothing", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: WIFI.base });
  kv.setItem(LS.hostActive, host.id);
  setHostPins(kv, host.id, { hostId: "abcd1234", tls: { port: 9000, spki: "c".repeat(64) } });
  setHostUpdateKey(kv, host.id, { key: KEY, gen: 7 });
  assert.equal(sealedAsk(kv, sealed(), WIFI), null);
  const r = storeSealed(kv, sealed(), WIFI);
  assert.equal(r.ok, true);
  assert.equal(r.added, false);
  assert.equal(r.moved, false);
  assert.equal(r.isActive, true);
  assert.equal(r.host.name, "mine", "a re-pair keeps the name the person knows");
  assert.deepEqual(r.host.tls, { port: 8771, spki: SEAL_SPKI });
  assert.deepEqual(r.host.updateKey, { key: KEY, gen: 7 });
  assert.equal(kv.getItem(LS.deviceToken), TOKEN);
  assert.equal(readHosts(kv).length, 1);
  assert.equal(storeSealed(kv, sealed({ updateKey: KEY2 }), WIFI).host.updateKey.gen, 0, "a new key starts its own count");
});

test("a re-pair at the row's LAN address keeps its base, asks nothing, and updates the rest", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: NET.base, lan: { base: WIFI.base, ssids: ["home"], auto: true } });
  setHostPins(kv, host.id, { hostId: "abcd1234" });
  kv.setItem(LS.hostActive, host.id);
  kv.setItem(LS.hostBase, NET.base);
  assert.equal(sealedAsk(kv, sealed(), WIFI), null);
  const r = storeSealed(kv, sealed({ host: { name: "s", base: "http://203.0.113.5:8770", httpsUrl: null, lanBase: WIFI.base } }), WIFI);
  assert.equal(r.host.base, NET.base, "the tailnet address survives, and no reply supplied it");
  assert.equal(r.moved, false, "nothing to reload for");
  assert.deepEqual(r.host.lan, { base: WIFI.base, ssids: ["home"], auto: true });
  assert.deepEqual(r.host.tls, { port: 8771, spki: SEAL_SPKI });
  assert.deepEqual(r.host.updateKey, { key: KEY, gen: 0 });
  assert.equal(kv.getItem(LS.hostBase), NET.base);
  assert.equal(readHosts(kv).length, 1);
});

test("the l= swap is that same re-pair: the link's LAN address is the one asked, and the base stays", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: NET.base, lan: { base: WIFI.base, ssids: [], auto: false } });
  setHostPins(kv, host.id, { hostId: "abcd1234" });
  const link = { base: NET.base, code: "ABCDEFGH", secure: true, lan: WIFI.base };
  const swapped = pairTargetOf({ address: link.lan, code: link.code }, link);
  assert.equal(swapped.base, WIFI.base, "what the swap button puts in the form");
  assert.equal(sealedAsk(kv, sealed(), swapped), null);
  const r = storeSealed(kv, sealed(), swapped);
  assert.equal(r.host.base, NET.base);
  assert.equal(r.moved, false);
  assert.equal(r.host.lan.base, WIFI.base);
  assert.equal(r.host.hostId, "abcd1234");
});

test("a seal that states another LAN address updates the LAN side and still writes no base", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: NET.base, lan: { base: WIFI.base, ssids: ["home"], auto: true } });
  setHostPins(kv, host.id, { hostId: "abcd1234" });
  const r = storeSealed(kv, sealed({ host: { name: "s", base: "x", httpsUrl: null, lanBase: "http://10.0.0.9:8770" } }), WIFI);
  assert.equal(r.host.base, NET.base);
  assert.deepEqual(r.host.lan, { base: "http://10.0.0.9:8770", ssids: ["home"], auto: true }, "the seal's own statement, the person's choices");
});

test("a new desktop at the row's LAN address takes the address asked: the old base was the old desktop's", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: NET.base, lan: { base: WIFI.base, ssids: [], auto: false } });
  setHostPins(kv, host.id, { hostId: "oldid123" });
  assert.match(sealedAsk(kv, sealed(), WIFI).title, /different desktop/);
  const r = storeSealed(kv, sealed(), WIFI);
  assert.equal(r.host.base, WIFI.base);
  assert.equal(r.moved, true);
  assert.equal(r.host.hostId, "abcd1234");
});

test("a re-pair keeps the person's LAN choices when it restates the address", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: NET.base, lan: { base: "http://10.0.0.9:8770", ssids: ["home"], auto: true } });
  setHostPins(kv, host.id, { hostId: "abcd1234" });
  const r = storeSealed(kv, sealed({ host: { name: "s", base: "x", httpsUrl: null, lanBase: WIFI.base } }), NET);
  assert.deepEqual(r.host.lan, { base: WIFI.base, ssids: ["home"], auto: true });
});

test("a hostId hit at another address is a second question naming both, and only then the row moves", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: NET.base });
  kv.setItem(LS.hostActive, host.id);
  setHostPins(kv, host.id, { hostId: "abcd1234" });
  const ask = sealedAsk(kv, sealed(), WIFI);
  const words = ask.lines.join(" ");
  assert.match(words, /100\.64\.0\.5:8770/);
  assert.match(words, /192\.168\.1\.20:8770/);
  const r = storeSealed(kv, sealed(), WIFI);
  assert.equal(r.host.id, host.id);
  assert.equal(r.host.base, WIFI.base);
  assert.equal(r.moved, true);
  assert.equal(readHosts(kv).length, 1);
  assert.equal(kv.getItem(LS.hostBase), WIFI.base, "the active row's address follows, for the reload");
});

test("a legacy row at the address asked is adopted: one desktop, one row, no question", () => {
  for (const asked of [WIFI, NET]) {
    const kv = shim();
    addHost(kv, asked === WIFI ? { name: "mine", base: NET.base, lan: { base: WIFI.base, ssids: [], auto: false } } : { name: "mine", base: NET.base });
    assert.equal(sealedAsk(kv, sealed(), asked), null);
    const r = storeSealed(kv, sealed(), asked);
    assert.equal(r.added, false);
    assert.equal(r.host.hostId, "abcd1234");
    assert.equal(r.host.name, "mine");
    assert.equal(readHosts(kv).length, 1);
  }
});

test("a seal may touch a row a plain reply never may", () => {
  const kv = shim();
  const { host } = addHost(kv, { base: NET.base });
  setHostPins(kv, host.id, { hostId: "abcd1234" });
  assert.deepEqual(storeRedeemed(kv, reply(NET.base), NET), { ok: false, why: PAIR_ROW_KEPT });
  assert.equal(storeSealed(kv, sealed(), NET).ok, true);
});

test("a hostId that changed under an address is a new desktop: said in words, on the same row", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: NET.base });
  setHostPins(kv, host.id, { hostId: "oldid123" });
  setHostUpdateKey(kv, host.id, { key: KEY, gen: 7 });
  const ask = sealedAsk(kv, sealed(), NET);
  assert.match(ask.title, /different desktop/);
  assert.match(ask.lines.join(" "), /mine/);
  const r = storeSealed(kv, sealed(), NET);
  assert.equal(r.host.id, host.id);
  assert.equal(r.host.hostId, "abcd1234");
  assert.equal(r.host.updateKey.gen, 0, "another desktop's count does not carry over, even under the same bytes");
  const none = shim();
  const h = addHost(none, { base: NET.base }).host;
  setHostPins(none, h.id, { hostId: "oldid123" });
  setHostUpdateKey(none, h.id, { key: KEY, gen: 7 });
  const { updateKey: _k, ...keyless } = sealed();
  assert.equal(storeSealed(none, keyless, NET).host.updateKey, undefined, "and its key does not either");
});

test("a sealed re-pair clears plain HTTP before the pin, and a desktop with no listener loses its pin", () => {
  const kv = shim();
  const { host } = addHost(kv, { base: WIFI.base });
  setHostTlsOff(kv, host.id, true);
  const r = storeSealed(kv, sealed(), WIFI);
  assert.equal(r.ok, true);
  assert.equal(r.host.tlsOff, undefined);
  assert.deepEqual(r.host.tls, { port: 8771, spki: SEAL_SPKI });
  const { tls: _t, ...noTls } = sealed();
  assert.equal(storeSealed(kv, noTls, WIFI).host.tls, undefined);
});

test("a re-pair that changes nothing on the row keeps the address the person typed", () => {
  const kv = shim();
  const asked = { base: "https://me.example", code: "ABCDEFGH" };
  const { host } = addHost(kv, { base: asked.base, opened: "" });
  assert.equal(host.vouched, true);
  assert.equal(storeSealed(kv, sealed(), asked).host.vouched, true);
});

test("sealed mode: a seal's token is held, and the caller is told to re-wrap", (t) => {
  t.after(releaseTokens);
  const kv = shim({ [LS.tokenSealOn]: "1" });
  const r = storeSealed(kv, sealed(), WIFI);
  assert.equal(r.sealedPending, true);
  assert.equal(heldToken(r.host.id), TOKEN);
  assert.equal(kv.getItem(LS.deviceToken), null);
  assert.equal(kv.getItem(parkedKeyFor(LS.deviceToken, r.host.id)), null);
});

test("the old token for a box may come from the row's LAN address; a plain redeem's may not", () => {
  const kv = shim();
  const { host } = addHost(kv, { base: NET.base, lan: { base: WIFI.base, ssids: [], auto: false } });
  kv.setItem(LS.hostActive, host.id);
  kv.setItem(LS.deviceToken, TOKEN);
  assert.equal(heldTokenFor(kv, WIFI.base), null);
  assert.equal(heldTokenFor(kv, WIFI.base, true), TOKEN);
  assert.equal(heldTokenFor(kv, NET.base), TOKEN);
});

// ── A vouched proxy, and a row left with no route ─────────────────────────

const PROXY = { base: "https://desk.example.com", code: "ABCDEFGH" };

test("a sealed pairing at a vouched proxy writes no LAN pin, and takes off one it wrote before", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: PROXY.base });
  setHostPins(kv, host.id, { hostId: "abcd1234", tls: { port: 8771, spki: SEAL_SPKI } });
  const r = storeSealed(kv, sealed(), PROXY);
  assert.equal(r.host.tls, undefined);
  assert.equal(readHosts(kv)[0].tls, undefined);
  assert.equal(r.host.hostId, "abcd1234", "the rest of the seal still lands");
  assert.deepEqual(r.host.updateKey, { key: KEY, gen: 0 });
  assert.equal(storeSealed(shim(), sealed(), PROXY).host.tls, undefined, "a new row at a proxy too");
});

test("a tailnet name or a plain address keeps the pin; so does a proxy-free row asked at its LAN address", () => {
  assert.deepEqual(storeSealed(shim(), sealed(), { base: "https://mac.tail1.ts.net", code: "ABCDEFGH" }).host.tls, { port: 8771, spki: SEAL_SPKI });
  assert.deepEqual(storeSealed(shim(), sealed(), WIFI).host.tls, { port: 8771, spki: SEAL_SPKI });
});

test("a proxy row asked at its LAN address stays a proxy row: no pin, and the base is the row's", () => {
  const kv = shim();
  const { host } = addHost(kv, { name: "mine", base: PROXY.base, lan: { base: WIFI.base, ssids: [], auto: false } });
  setHostPins(kv, host.id, { hostId: "abcd1234" });
  const r = storeSealed(kv, sealed(), WIFI);
  assert.equal(r.host.base, PROXY.base);
  assert.equal(r.host.tls, undefined);
});

test("the pair form opens on the LAN address only where Tailscale is known off", () => {
  const t = { base: NET.base, lan: WIFI.base };
  const wifi = { transport: "wifi", ssid: "home", permission: "granted" };
  assert.equal(pairAddressOf(t, { ...wifi, tailnet: false }), WIFI.base);
  assert.equal(pairAddressOf(t, { ...wifi, tailnet: true }), NET.base);
  assert.equal(pairAddressOf(t, wifi), NET.base, "absent is unknown, never off");
  assert.equal(pairAddressOf(t, null), NET.base);
  assert.equal(pairAddressOf({ base: NET.base }, { ...wifi, tailnet: false }), NET.base, "a row with no LAN address has only its own");
});

test("paired at the LAN address with Tailscale off: the receipt says when no route is left, and names the way there", () => {
  const off = { transport: "wifi", ssid: "home", permission: "granted", tailnet: false };
  const row = (lan) => ({ name: "studio", base: NET.base, lan: { base: WIFI.base, ...lan } });
  const says = pairedNoRoute(row({ ssids: ["home"], auto: false }), WIFI.base, off);
  assert.match(says, /^Paired with studio, but this phone cannot reach it yet/);
  assert.match(says, /Connection health › change LAN settings/);
  assert.match(says, /switch to LAN automatically/);
  assert.ok(pairedNoRoute(row({ ssids: [], auto: true }), WIFI.base, off), "no Wi-Fi name saved");
  assert.ok(pairedNoRoute(row({ ssids: ["other"], auto: true }), WIFI.base, off), "this Wi-Fi is not the saved one");

  assert.equal(pairedNoRoute(row({ ssids: ["home"], auto: true }), WIFI.base, off), null, "the ladder will take this row");
  assert.equal(pairedNoRoute(row({ ssids: [], auto: false }), WIFI.base, { ...off, tailnet: true }), null);
  const { tailnet: _t, ...unknown } = off;
  assert.equal(pairedNoRoute(row({ ssids: [], auto: false }), WIFI.base, unknown), null, "unknown is not off");
  assert.equal(pairedNoRoute(row({ ssids: [], auto: false }), NET.base, off), null, "asked at its own address");
  assert.equal(pairedNoRoute({ name: "s", base: WIFI.base, lan: { base: WIFI.base, ssids: [], auto: false } }, WIFI.base, off), null, "the base IS the LAN address");
  assert.equal(pairedNoRoute({ ...row({ ssids: [], auto: false }), base: PROXY.base }, WIFI.base, off), null, "a proxy needs no tunnel");
});
