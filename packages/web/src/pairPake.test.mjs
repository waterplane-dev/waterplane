/**
 * The page's side of PAKE pairing: what each answer leads to, on a plain and on a protected address.
 * The desktop here runs the REAL host half of `shared/pake.ts`, so a seal in these tests is one the
 * phone truly opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAIR_TTL_MS, pairCommit, pakeDecode, pakeEncode, pakeErrorText, pakeHostOffer, pakeOpenBox, pakeSeal, pakeSecret,
} from "@waterplane/shared";

import {
  PAIR_ASK_OLD, PAIR_ASK_PHONE, PAIR_COMMIT_WRONG, PAIR_NO_PASSWORD_PLAIN, PAIR_SEAL_WRONG, PAIR_SECURE_ONLY, PAIR_SECURE_ONLY_PHONE,
  codeMark, codeWentPlain, markCodePlain, pairStep, pairUnreachable, readSealedReply,
} from "./pairPake.ts";
import { pinSealed } from "./pairNative.ts";
import { LS } from "./storage.ts";

const CODE = "ABCDEFGH";
const OTHER = "ZZZZ2345";
const LAN = "http://192.168.1.20:8770";
const TAIL = "http://100.64.0.5:8770";
const UPDATE_KEY = Buffer.alloc(91, 7).toString("base64");
const SPKI = "a".repeat(64);
const SEALED = {
  ok: true, host: { name: "studio", base: "http://203.0.113.9:8770", httpsUrl: null }, token: "tok_abc", hostId: "abcd1234",
  lanIdentity: { hostId: "abcd1234", secret: "s".repeat(32) }, tls: { port: 8771, spki: SPKI }, updateKey: UPDATE_KEY,
};
const BOX = { deviceName: "pixel", presented: "tok_old" };

const target = (extra = {}) => ({ base: LAN, code: CODE, ...extra });

/** A desktop offering `codes`, holding what the last `finish` put in its `box`. */
function desktop(codes = [CODE], reply = SEALED) {
  const d = { boxes: [], starts: 0, finishes: 0, offers: [] };
  d.start = async (_base, req) => {
    d.starts++;
    const nh = new Uint8Array(16).fill(9);
    const sidP = pakeDecode(req.sidP, 16);
    const ya = pakeDecode(req.ya, 32);
    d.offers = [];
    for (const c of codes) d.offers.push(await pakeHostOffer(await pakeSecret(c), sidP, ya, nh));
    return { status: 200, body: { ok: true, nh: pakeEncode(nh), yb: d.offers.map((o) => pakeEncode(o.yb)) } };
  };
  d.finish = async (_base, req) => {
    d.finishes++;
    assert.equal(req.box.length, req.confirm.length, "one box per share");
    assert.equal(req.box.length, d.offers.length);
    for (const [i, offer] of d.offers.entries()) {
      const at = req.confirm.findIndex((c) => Buffer.from(pakeDecode(c, 32)).equals(Buffer.from(offer.confirm)));
      if (at < 0) continue;
      d.boxes.push(await pakeOpenBox(offer.kBox, offer.th, req.box[at]));
      d.hit = i;
      return { status: 200, body: { ok: true, seal: await pakeSeal(offer.kSeal, offer.th, reply) } };
    }
    return { status: 403, body: { ok: false, error: "unknown", message: "" } };
  };
  return d;
}

/** Answers `start` with this and nothing more. */
const startSays = (status, body = null) => ({
  start: async () => ({ status, body }),
  finish: async () => assert.fail("no finish after a refused start"),
});

test("a good pairing ends in a seal, and the old token rides in the box", async () => {
  const d = desktop();
  const next = await pairStep(target(), true, BOX, d);
  assert.equal(next.kind, "sealed");
  assert.equal(next.reply.hostId, "abcd1234");
  assert.deepEqual(d.boxes, [BOX]);
});

test("several codes showing: one answer per share, and the one that matches is the one that seals", async () => {
  const d = desktop([OTHER, CODE, "QQQQ2345"]);
  assert.equal((await pairStep(target(), true, BOX, d)).kind, "sealed");
  assert.equal(d.hit, 1);
});

test("a wrong code is the desktop's refusal, in our words, and never goes on to redeem", async () => {
  for (const plain of [true, false]) {
    const next = await pairStep(target(), plain, BOX, desktop([OTHER]));
    assert.deepEqual(next, { kind: "stop", why: pakeErrorText("unknown") });
  }
});

test("a seal that does not open, or does not read, is nothing believed", async () => {
  const d = desktop();
  const tampered = {
    start: d.start,
    finish: async (b, r) => {
      const got = await d.finish(b, r);
      const raw = Buffer.from(got.body.seal, "base64");
      raw[raw.length - 1] ^= 1;
      return { status: 200, body: { ok: true, seal: raw.toString("base64") } };
    },
  };
  assert.deepEqual(await pairStep(target(), true, BOX, tampered), { kind: "stop", why: PAIR_SEAL_WRONG });
  const { lanIdentity: _gone, ...noIdentity } = SEALED;
  assert.deepEqual(await pairStep(target(), true, BOX, desktop([CODE], noIdentity)), { kind: "stop", why: PAIR_SEAL_WRONG });
});

test("readSealedReply: one bad field and none of it is believed", () => {
  assert.ok(readSealedReply(SEALED));
  const { tls: _t, updateKey: _u, ...bare } = SEALED;
  assert.ok(readSealedReply(bare), "no TLS listener and no key is a real desktop");
  for (const bad of [
    null, "x", { ...SEALED, ok: false }, { ...SEALED, host: null }, { ...SEALED, hostId: "NOT AN ID" },
    { ...SEALED, lanIdentity: { hostId: "other123", secret: "s".repeat(32) } },
    { ...SEALED, tls: { port: 0, spki: SPKI } }, { ...SEALED, tls: { port: 8771, spki: "zz" } },
    { ...SEALED, updateKey: "" }, { ...SEALED, updateKey: "not base64!" },
  ]) assert.equal(readSealedReply(bad), null, JSON.stringify(bad));
});

test("k=: a seal that matches passes, any other is refused even with the right code", async () => {
  const commit = await pairCommit(UPDATE_KEY, SPKI);
  assert.equal((await pairStep(target({ commit }), true, BOX, desktop())).kind, "sealed");
  const wrong = commit.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  assert.deepEqual(await pairStep(target({ commit: wrong }), true, BOX, desktop()), { kind: "stop", why: PAIR_COMMIT_WRONG });
  const { updateKey: _u, ...keyless } = SEALED;
  assert.deepEqual(await pairStep(target({ commit }), true, BOX, desktop([CODE], keyless)), { kind: "stop", why: PAIR_COMMIT_WRONG }, "no key cannot pass a commitment");
});

test("an older desktop on a plain address: one question for both readings, 404 and an older gate's 401", async () => {
  for (const status of [404, 401]) {
    assert.deepEqual(await pairStep(target(), true, BOX, startSays(status)), { kind: "ask", ask: PAIR_ASK_OLD });
  }
  const words = PAIR_ASK_OLD.lines.join(" ");
  assert.match(words, /older desktop/);
  assert.match(words, /blocking encrypted pairing/);
});

test("s=1 takes the question away on a plain address, and a protected address may still redeem", async () => {
  for (const status of [404, 401]) {
    assert.deepEqual(await pairStep(target({ secure: true }), true, BOX, startSays(status)), { kind: "stop", why: PAIR_SECURE_ONLY });
    assert.deepEqual(await pairStep(target({ secure: true, base: TAIL }), false, BOX, startSays(status)), { kind: "redeem" });
  }
});

test("an older desktop on a protected address goes straight on: nothing crosses anything plain", async () => {
  assert.deepEqual(await pairStep(target({ base: TAIL }), false, BOX, startSays(404)), { kind: "redeem" });
});

test("typed refusals: on a protected address the three a tailnet outlives redeem, on a plain one none does", async () => {
  for (const error of ["no-password", "closed", "no-codes"]) {
    const said = startSays(409, { ok: false, error, message: "" });
    assert.deepEqual(await pairStep(target({ base: TAIL }), false, BOX, said), { kind: "redeem" }, error);
    assert.deepEqual(await pairStep(target({ base: TAIL, secure: true }), false, BOX, said), { kind: "redeem" }, `s=1 ${error}`);
    const plain = await pairStep(target(), true, BOX, said);
    assert.equal(plain.kind, "stop", error);
  }
  const words = async (error) => (await pairStep(target(), true, BOX, startSays(409, { ok: false, error, message: "" }))).why;
  assert.equal(await words("no-password"), PAIR_NO_PASSWORD_PLAIN);
  assert.match(await words("no-password"), /Set a password on the desktop/);
  assert.match(await words("closed"), /new code/);
  assert.match(await words("no-codes"), /new code/);
});

test("the same three at finish behave the same, and the rest stop everywhere", async () => {
  const d = desktop();
  const at = (error) => ({ start: d.start, finish: async () => ({ status: 403, body: { ok: false, error, message: "" } }) });
  assert.deepEqual(await pairStep(target({ base: TAIL }), false, BOX, at("closed")), { kind: "redeem" });
  assert.equal((await pairStep(target(), true, BOX, at("closed"))).kind, "stop");
  for (const error of ["unknown", "expired", "used", "no-session", "rate-limited"]) {
    for (const plain of [true, false]) {
      assert.deepEqual(await pairStep(target(), plain, BOX, at(error)), { kind: "stop", why: pakeErrorText(error) });
    }
  }
});

test("nothing a refusal says reaches the screen on a plain address", async () => {
  const relay = { ok: false, error: "no-password", message: "Call 0900-RELAY to pair" };
  const next = await pairStep(target(), true, BOX, startSays(403, relay));
  assert.doesNotMatch(next.why, /RELAY/);
});

test("a good start spoken and then a 404 is no older desktop: a relay cannot force the question at finish", async () => {
  const d = desktop();
  for (const status of [404, 401]) {
    const next = await pairStep(target(), true, BOX, { start: d.start, finish: async () => ({ status, body: null }) });
    assert.equal(next.kind, "stop");
    assert.match(next.why, new RegExp(String(status)));
  }
});

test("an answer that is no pairing reply stops: it is not read as an older desktop", async () => {
  for (const [status, body] of [[200, null], [200, { ok: true }], [500, null], [403, { error: "origin" }], [502, "<html>"]]) {
    const next = await pairStep(target(), true, BOX, startSays(status, body));
    assert.equal(next.kind, "stop", `${status}`);
  }
  assert.deepEqual(await pairStep(target(), true, BOX, startSays(429)), { kind: "stop", why: pakeErrorText("rate-limited") });
});

test("a bad share from the desktop stops before the code is guessed at", async () => {
  const bad = (yb) => ({ start: async () => ({ status: 200, body: { ok: true, nh: pakeEncode(new Uint8Array(16)), yb } }), finish: async () => assert.fail("no finish") });
  const point = pakeEncode(new Uint8Array(32));
  for (const yb of [[], Array(6).fill(point), ["nope"], [point]]) {
    assert.deepEqual(await pairStep(target(), true, BOX, bad(yb)), { kind: "stop", why: PAIR_SEAL_WRONG });
  }
});

test("no answer at all says what to check, in words for that kind of address", async () => {
  const gone = { start: async () => { throw new Error("offline"); }, finish: async () => assert.fail("no finish") };
  assert.deepEqual(await pairStep(target(), true, BOX, gone), { kind: "stop", why: pairUnreachable(LAN, true) });
  assert.match(pairUnreachable(LAN, true), /Wi-Fi/);
  assert.match(pairUnreachable(TAIL, false), /Tailscale/);
  const d = desktop();
  const late = { start: d.start, finish: async () => { throw new Error("offline"); } };
  assert.deepEqual(await pairStep(target(), true, BOX, late), { kind: "stop", why: pairUnreachable(LAN, true) });
});

test("a phone with no WebCrypto: asked on a plain address, refused under s=1, straight on where protected", async (t) => {
  const was = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (b) => b }, configurable: true });
  t.after(() => Object.defineProperty(globalThis, "crypto", was));
  const none = { start: async () => assert.fail("nothing is sent"), finish: async () => assert.fail("nothing is sent") };
  assert.deepEqual(await pairStep(target(), true, BOX, none), { kind: "ask", ask: PAIR_ASK_PHONE });
  assert.deepEqual(await pairStep(target({ secure: true }), true, BOX, none), { kind: "stop", why: PAIR_SECURE_ONLY_PHONE });
  assert.deepEqual(await pairStep(target({ base: TAIL }), false, BOX, none), { kind: "redeem" });
  assert.equal(await codeMark(CODE), null);
});

// ── A code sent plain ─────────────────────────────────────────────────────

function kvShim() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

test("a code sent plain stays dead for as long as a code can live, and only that code", async () => {
  const kv = kvShim();
  const mark = await codeMark(CODE);
  assert.equal(codeWentPlain(kv, mark, 1000), false);
  assert.equal(markCodePlain(kv, mark, 1000), true);
  assert.equal(codeWentPlain(kv, mark, 1000 + PAIR_TTL_MS - 1), true);
  assert.equal(codeWentPlain(kv, await codeMark(OTHER), 1000), false);
  assert.equal(codeWentPlain(kv, mark, 1000 + PAIR_TTL_MS), false, "past a code's life the desktop has forgotten it too");
  assert.doesNotMatch([...kv.m.values()].join(), new RegExp(CODE), "the code itself is never stored");
});

test("marks past a code's life are pruned on the next write; damaged storage reads as none", async () => {
  const kv = kvShim();
  markCodePlain(kv, "old", 0);
  markCodePlain(kv, "new", PAIR_TTL_MS + 1);
  assert.equal([...kv.m.values()][0].includes("old"), false);
  kv.m.clear();
  for (const raw of ["{", "null", "3", '[null,{"mark":1}]']) {
    kv.m.set(LS.pairCodesSent, raw);
    assert.equal(codeWentPlain(kv, "m", 0), false, raw);
  }
});

test("a mark that cannot be written says so, so the code does not leave", () => {
  const kv = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.equal(markCodePlain(kv, "m", 0), false);
});

// ── The shell's half ──────────────────────────────────────────────────────

function shell(t, plugins) {
  const was = globalThis.Capacitor;
  globalThis.Capacitor = { Plugins: plugins };
  t.after(() => { globalThis.Capacitor = was; });
}

const HOST = { id: "row1", name: "studio", base: LAN, tls: { port: 8771, spki: SPKI } };

test("a sealed pairing pins TLS under the ROW id and asks about the update key under the desktop's", async (t) => {
  const calls = [];
  shell(t, {
    ShellTls: {
      setPin: async (o) => { calls.push(["setPin", o]); },
      removePin: async (o) => { calls.push(["removePin", o]); },
      list: async () => ({ pins: [] }), lastRefusal: async () => ({}),
    },
    ShellUpdate: { pinUpdateKey: async (o) => { calls.push(["pinUpdateKey", o]); return { pinned: false }; } },
  });
  await pinSealed(HOST, SEALED);
  assert.deepEqual(calls, [
    ["setPin", { hostId: "row1", spki: SPKI }],
    ["pinUpdateKey", { hostId: "abcd1234", name: "studio", key: UPDATE_KEY }],
  ]);
  calls.length = 0;
  const { tls: _t, updateKey: _u, ...bare } = SEALED;
  const { tls: _r, ...noPin } = HOST;
  await pinSealed(noPin, bare);
  assert.deepEqual(calls, [["removePin", { hostId: "row1" }]], "a desktop that stopped offering TLS has no pin left");
  calls.length = 0;
  await pinSealed(noPin, { ...SEALED, updateKey: undefined });
  assert.deepEqual(calls, [["removePin", { hostId: "row1" }]], "the pin follows the row: a proxy's row held none, whatever the seal carried");
});

test("a shipped APK has neither plugin, and a shell that refuses cannot fail the pairing", async (t) => {
  shell(t, {});
  await pinSealed(HOST, SEALED);
  shell(t, {
    ShellTls: { setPin: async () => { throw new Error("bad"); }, removePin: async () => {}, list: async () => ({}), lastRefusal: async () => ({}) },
    ShellUpdate: { pinUpdateKey: async () => { throw new Error("bad"); } },
  });
  await pinSealed(HOST, SEALED);
});
