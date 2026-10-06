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
  heldTokenFor, scopedKeys, storeRedeemed,
} from "./pairRedeem.ts";
import { addHost, finishSwitch, readHosts, writeSwitch } from "./hosts.ts";
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

test("pairing a SECOND desktop parks its token and identity; the active host's bare keys are untouched", () => {
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
  assert.deepEqual(JSON.parse(kv.getItem(parkedKeyFor(LS.lanIdentity, r.host.id))), IDENT);
  assert.deepEqual(r.host.lan, { base: "http://192.168.1.20:8770", ssids: [], auto: false });
  // …and the switch at the next boot brings them in as bare keys, parking A's.
  writeSwitch(kv, { from: a.host.id, to: r.host.id });
  finishSwitch(kv);
  assert.equal(kv.getItem(LS.deviceToken), TOKEN);
  assert.deepEqual(JSON.parse(kv.getItem(LS.lanIdentity)), IDENT);
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
