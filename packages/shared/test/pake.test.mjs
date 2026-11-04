// CPace over ristretto255 (`pake.ts`) and what the deep link adds (`pairing.ts`). The two ends run
// the same module, so agreement alone would prove little: the transcript, the keys, the confirm and
// the seal are also rebuilt here with `node:crypto`, and one exchange is pinned byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  PAIR_SCHEME, PAKE_DST, PakeFailure, lp, pairCommit, pairDeepLink, pakeBox, pakeConfirm, pakeDecode, pakeEncode, pakeErrorText, pakeHostOffer,
  pakeKeys, pakeOpenBox, pakeOpenSeal, pakePhoneFinish, pakePhoneOpen, pakePhoneStart, pakeSeal, pakeSecret, pakeShareOk, pakeSharedPoint,
  pakeTranscript, parsePairDeepLink, parsePairInput, updateKeyFingerprint,
} from "../dist/index.js";

const CODE = "ABCDEFGH";
const NH = new Uint8Array(16).fill(0x42);
const hex = (b) => Buffer.from(b).toString("hex");

/** A repeatable byte stream: the same exchange every run. */
function stream(seed) {
  let n = 0;
  return (len) => {
    const out = new Uint8Array(len);
    for (let at = 0; at < len; at += 32) out.set(createHash("sha256").update(`${seed}:${n++}`).digest().subarray(0, Math.min(32, len - at)), at);
    return out;
  };
}

async function exchange(phoneCode, hostCodes, rand = {}) {
  const { state, request } = await pakePhoneStart(phoneCode, rand.phone);
  const ya = pakeDecode(request.ya, 32);
  const offers = [];
  for (const c of hostCodes) offers.push(await pakeHostOffer(await pakeSecret(c), state.sidP, ya, NH, rand.host));
  const reply = { nh: pakeEncode(NH), yb: offers.map((o) => pakeEncode(o.yb)) };
  const done = await pakePhoneFinish(state, reply, { deviceName: "pixel" }, rand.box);
  return { state, ya, offers, reply, ...done };
}

test("both ends reach the same keys: the confirm matches, the box opens, the seal opens", async () => {
  const { offers, request, candidates } = await exchange(CODE, [CODE]);
  assert.equal(request.confirm[0], pakeEncode(offers[0].confirm));
  assert.deepEqual(await pakeOpenBox(offers[0].kBox, offers[0].th, request.box[0]), { deviceName: "pixel" });
  const seal = await pakeSeal(offers[0].kSeal, offers[0].th, { ok: true, token: "t" });
  assert.deepEqual(await pakePhoneOpen(candidates, seal), { ok: true, token: "t" });
});

test("a fixed exchange, byte for byte: a change here is a new protocol, and a shipped phone stops pairing", async () => {
  const phone = stream("phone");
  const host = stream("host");
  const { state, offers, request, candidates } = await exchange(CODE, [CODE], { phone, host, box: stream("box") });
  const seal = await pakeSeal(offers[0].kSeal, offers[0].th, { ok: true }, stream("seal"));
  assert.deepEqual({
    secret: hex(await pakeSecret(CODE)),
    sidP: hex(state.sidP),
    ya: hex(state.ya),
    yb: hex(offers[0].yb),
    th: hex(offers[0].th),
    confirm: hex(offers[0].confirm),
    kBox: hex(offers[0].kBox),
    kSeal: hex(candidates[0].kSeal),
    box: request.box[0],
    seal,
  }, {
    secret: "9ac2197d9258257b1ae8463e4214e4cd0a578bc1517f2415928b91be4283fc48",
    sidP: "b624c06e1774016ec78eebc26a586d90",
    ya: "6c73549ccc2ac4f381a1c92cefc130872fd796a65c79683a2d5a5f3a3a9f2762",
    yb: "8ca16b2f156e62c68b8004533c97ecf855347a796daa0cad2efbb7be8d828922",
    th: "6203341ada3c5b7593c954289db33ea9f7802545abe89b8b77b224200223f86fb4a7507ecfcdc532bc1cd9d2e9f5b39ebf41ad302d09d736f64dcc93b67a3a64",
    confirm: "f2a95fa0f59059a3391c94b177bca9105969e3c3b533f1e67e370dc04012dcef",
    kBox: "c560c7e245b72d5017a5f30e34bdbe21932f71aaa6f0177183f813facc4c20bf",
    kSeal: "6c986d7b331e1b227bf8ae4dcd5f525ac2635a87af39fcd7db125d681e963744",
    box: "OCGfOp6LkBSnXA6Bt3IHYybUqBPlscTiOd4VNxRXq81ssADVXyM6kXVlb4kbEOLZk7M=",
    seal: "29zEgM8I2RRW0IJCMAFYDDgXWlU3zSyJH+L1ehHrGrZTYCZm4z5/",
  });
});

test("the transcript, the keys, the confirm and the seal, rebuilt with node:crypto", async () => {
  const { state, ya, offers } = await exchange(CODE, [CODE]);
  const o = offers[0];
  const be = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  const th = createHash("sha512").update(Buffer.concat([Buffer.from(PAKE_DST), Buffer.from(state.sidP), NH, ya, o.yb].map((x) => be(Buffer.from(x))))).digest();
  assert.equal(hex(o.th), hex(th));
  assert.equal(hex(await pakeTranscript(state.sidP, NH, ya, o.yb)), hex(th));
  const z = await pakeSharedPoint(state.scalar, o.yb);
  const key = (label) => Buffer.from(hkdfSync("sha256", z, th, Buffer.from(label), 32));
  const k = await pakeKeys(z, th);
  assert.equal(hex(k.kPhone), hex(key("K_phone")));
  assert.equal(hex(k.kBox), hex(key("K_box")));
  assert.equal(hex(k.kSeal), hex(key("K_seal")));
  assert.equal(hex(await pakeConfirm(k.kPhone, th)), createHmac("sha256", key("K_phone")).update(th).digest("hex"));
  const raw = Buffer.from(pakeDecode(await pakeSeal(k.kSeal, th, { a: 1 })));
  const d = createDecipheriv("aes-256-gcm", key("K_seal"), raw.subarray(0, 12));
  d.setAAD(th);
  d.setAuthTag(raw.subarray(raw.length - 16));
  assert.equal(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString(), '{"a":1}');
});

test("every field is length-prefixed: moving a byte between two fields changes the transcript", async () => {
  assert.equal(hex(lp(new Uint8Array([9, 9]))), "0000000209" + "09");
  const a = await pakeTranscript(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array(0), new Uint8Array(0));
  const b = await pakeTranscript(new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array(0), new Uint8Array(0));
  assert.notEqual(hex(a), hex(b));
});

test("each seal draws a fresh nonce", async () => {
  const k = new Uint8Array(32).fill(1);
  const th = new Uint8Array(64).fill(2);
  assert.notEqual(await pakeSeal(k, th, { a: 1 }), await pakeSeal(k, th, { a: 1 }));
});

test("a wrong code on either end: the confirm differs, and nothing opens", async () => {
  const { offers, request, candidates } = await exchange("ZZZZZZZZ", [CODE]);
  assert.notEqual(request.confirm[0], pakeEncode(offers[0].confirm));
  assert.equal(await pakeOpenBox(offers[0].kBox, offers[0].th, request.box[0]), null);
  assert.equal(await pakePhoneOpen(candidates, await pakeSeal(offers[0].kSeal, offers[0].th, { ok: true })), null);
});

test("reordered yb: each confirm follows its own share, not its position", async () => {
  const { state, offers, reply } = await exchange(CODE, ["ZZZZZZZZ", CODE]);
  const swapped = await pakePhoneFinish(state, { nh: reply.nh, yb: [reply.yb[1], reply.yb[0]] }, { deviceName: "pixel" });
  assert.equal(swapped.request.confirm[0], pakeEncode(offers[1].confirm), "the right code answers at its new index");
  assert.notEqual(swapped.request.confirm[1], pakeEncode(offers[0].confirm));
  const seal = await pakeSeal(offers[1].kSeal, offers[1].th, { ok: true });
  assert.deepEqual(await pakePhoneOpen(swapped.candidates, seal), { ok: true });
});

test("a share swapped for another attempt's does not reach the same keys", async () => {
  const a = await exchange(CODE, [CODE]);
  const b = await exchange(CODE, [CODE]);
  const mixed = await pakePhoneFinish(a.state, { nh: a.reply.nh, yb: b.reply.yb }, { deviceName: "pixel" });
  assert.notEqual(mixed.request.confirm[0], pakeEncode(a.offers[0].confirm));
  assert.notEqual(mixed.request.confirm[0], pakeEncode(b.offers[0].confirm));
});

const IDENTITY = new Uint8Array(32);
// RFC 9496 A.2: the field prime itself, and a negative field element. Each is 32 bytes of nothing valid.
const NON_CANONICAL = [
  Buffer.from("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "hex"),
  Buffer.from("0100000000000000000000000000000000000000000000000000000000000000", "hex"),
];

test("the identity point and a non-canonical encoding are refused on both ends", async () => {
  const { state, reply } = await exchange(CODE, [CODE]);
  assert.equal(await pakeShareOk(IDENTITY), false);
  await assert.rejects(pakePhoneFinish(state, { nh: reply.nh, yb: [pakeEncode(IDENTITY)] }, {}), PakeFailure);
  await assert.rejects(pakeHostOffer(await pakeSecret(CODE), state.sidP, IDENTITY, NH), PakeFailure);
  await assert.rejects(pakeSharedPoint(state.scalar, IDENTITY), PakeFailure);
  for (const bad of NON_CANONICAL) {
    assert.equal(await pakeShareOk(bad), false, hex(bad));
    await assert.rejects(pakePhoneFinish(state, { nh: reply.nh, yb: [pakeEncode(bad)] }, {}), PakeFailure);
    await assert.rejects(pakeHostOffer(await pakeSecret(CODE), state.sidP, bad, NH), PakeFailure);
  }
  assert.equal(await pakeShareOk(new Uint8Array(31)), false, "the wrong length");
});

test("a phone refuses more shares than a host may offer, and none at all", async () => {
  const { state, reply } = await exchange(CODE, [CODE]);
  await assert.rejects(pakePhoneFinish(state, { nh: reply.nh, yb: Array(6).fill(reply.yb[0]) }, {}), PakeFailure);
  await assert.rejects(pakePhoneFinish(state, { nh: reply.nh, yb: [] }, {}), PakeFailure);
  await assert.rejects(pakePhoneFinish(state, { nh: "short", yb: reply.yb }, {}), PakeFailure);
  const five = await pakePhoneFinish(state, { nh: reply.nh, yb: Array(5).fill(reply.yb[0]) }, {});
  assert.equal(five.request.confirm.length, 5);
});

const flip = (b64, at) => { const b = Buffer.from(b64, "base64"); b[at < 0 ? b.length + at : at] ^= 1; return b.toString("base64"); };

test("a tampered seal does not open: nonce, body, tag, or a different transcript", async () => {
  const { offers, candidates } = await exchange(CODE, [CODE]);
  const o = offers[0];
  const seal = await pakeSeal(o.kSeal, o.th, { ok: true });
  for (const at of [0, 12, -1]) assert.equal(await pakePhoneOpen(candidates, flip(seal, at)), null, `byte ${at}`);
  assert.equal(await pakeOpenSeal(o.kSeal, new Uint8Array(64), seal), null, "aad is TH");
  assert.equal(await pakePhoneOpen(candidates, "not base64!"), null);
  assert.equal(await pakePhoneOpen(candidates, ""), null);
  assert.equal(await pakePhoneOpen(candidates, 7), null);
});

test("a tampered box does not open, and a box is not a seal", async () => {
  const { offers, request } = await exchange(CODE, [CODE]);
  const o = offers[0];
  for (const at of [0, 12, -1]) assert.equal(await pakeOpenBox(o.kBox, o.th, flip(request.box[0], at)), null, `byte ${at}`);
  assert.equal(await pakeOpenBox(o.kBox, new Uint8Array(64), request.box[0]), null, "aad is TH");
  assert.equal(await pakeOpenSeal(o.kSeal, o.th, await pakeBox(o.kBox, o.th, { a: 1 })), null, "different keys by label");
});

test("base64 has one spelling", () => {
  assert.deepEqual(pakeDecode("AAE="), new Uint8Array([0, 1]));
  assert.equal(pakeDecode("AAF="), null, "stray bits in the last character");
  assert.equal(pakeDecode("AAE"), null, "padding dropped");
  assert.equal(pakeDecode("AA-_"), null, "the url alphabet");
  assert.equal(pakeDecode("AAE=", 3), null, "the wrong length");
  assert.equal(pakeDecode(null), null);
});

test("noble is never a static import, so the phone's main chunk stays clean", () => {
  for (const f of ["index.js", "pake.js", "pairing.js"]) {
    const src = readFileSync(new URL(`../dist/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /^\s*(import|export)\s[^(]*@noble/m, f);
  }
});

// ── The deep link ───────────────────────────────────────────────────────

const DER = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d03010703420004" + "11".repeat(64), "hex");
const UPDATE_KEY = DER.toString("base64");
const SPKI = "ab".repeat(32);

test("k= is 32 hex of SHA-256(DER ‖ the pin's 32 bytes): the bytes, not their text", async () => {
  const want = createHash("sha256").update(Buffer.concat([DER, Buffer.from(SPKI, "hex")])).digest("hex").slice(0, 32);
  assert.equal(await pairCommit(UPDATE_KEY, SPKI), want);
  assert.equal(await pairCommit(UPDATE_KEY, SPKI), "80157f9f3f5e67d5f085ec7b77e845ed");
  assert.notEqual(await pairCommit(UPDATE_KEY, SPKI), createHash("sha256").update(UPDATE_KEY + SPKI).digest("hex").slice(0, 32));
});

test("k= with no TLS listener covers the DER alone; malformed input is null, never a pass", async () => {
  assert.equal(await pairCommit(UPDATE_KEY), createHash("sha256").update(DER).digest("hex").slice(0, 32));
  assert.equal(await pairCommit("not base64!", SPKI), null);
  assert.equal(await pairCommit("", SPKI), null);
  assert.equal(await pairCommit(undefined, SPKI), null);
  assert.equal(await pairCommit(UPDATE_KEY, "ab"), null, "a pin is 32 bytes");
  assert.equal(await pairCommit(UPDATE_KEY, "AB".repeat(32)), null, "a pin is lowercase");
  assert.equal(await pairCommit(UPDATE_KEY, 7), null);
});

test("the update key's fingerprint is lowercase hex SHA-256 of the DER", async () => {
  assert.equal(await updateKeyFingerprint(UPDATE_KEY), createHash("sha256").update(DER).digest("hex"));
  assert.equal(await updateKeyFingerprint("nope!"), null);
});

const BASE = "http://192.168.1.5:8770";
const LAN = "http://192.168.1.6:8770";

test("the deep link gains s=1, k= and l=, and they parse back", () => {
  const link = pairDeepLink(BASE, CODE, { secure: true, commit: "0123456789abcdef0123456789abcdef", lan: LAN });
  assert.equal(link, `${PAIR_SCHEME}://pair?u=${encodeURIComponent(BASE)}&c=${CODE}&s=1&k=0123456789abcdef0123456789abcdef&l=${encodeURIComponent(LAN)}`);
  assert.deepEqual(parsePairDeepLink(link), { base: BASE, code: CODE, secure: true, commit: "0123456789abcdef0123456789abcdef", lan: LAN });
  assert.deepEqual(parsePairInput(link), { base: BASE, code: CODE, secure: true, commit: "0123456789abcdef0123456789abcdef", lan: LAN });
});

test("additive: a shipped page reads u and c off the new link, and a plain link still parses alone", () => {
  const link = pairDeepLink(BASE, CODE, { secure: true, commit: "0123456789abcdef0123456789abcdef", lan: LAN });
  // A shipped bundle's whole reading of a link, as it stands in `parsePairDeepLink` before these fields.
  const shipped = new URLSearchParams(/^[a-z+.-]+:\/\/pair\/?\?(.*)$/i.exec(link)[1]);
  assert.equal(shipped.get("u"), BASE);
  assert.equal(shipped.get("c"), CODE);
  assert.deepEqual(parsePairDeepLink(pairDeepLink(BASE, CODE)), { base: BASE, code: CODE });
  assert.equal(pairDeepLink(BASE, CODE), `${PAIR_SCHEME}://pair?u=${encodeURIComponent(BASE)}&c=${CODE}`);
});

test("a commitment that cannot be read refuses the link; a bad l= is dropped, and can never be a javascript: base", () => {
  for (const k of ["0123", "0123456789ab", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcdef0", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", ""]) {
    assert.equal(parsePairDeepLink(`${PAIR_SCHEME}://pair?u=${encodeURIComponent(BASE)}&c=${CODE}&k=${k}`), null, k);
  }
  const bad = parsePairDeepLink(`${PAIR_SCHEME}://pair?u=${encodeURIComponent(BASE)}&c=${CODE}&l=${encodeURIComponent("javascript:alert(1)")}`);
  assert.deepEqual(bad, { base: BASE, code: CODE });
  assert.equal(parsePairDeepLink(`${PAIR_SCHEME}://pair?u=${encodeURIComponent(BASE)}&c=${CODE}&s=0`).secure, undefined, "only s=1 is secure");
});

test("every typed refusal has a sentence of its own", () => {
  for (const e of ["closed", "no-codes", "no-session"]) assert.ok(pakeErrorText(e).length > 20, e);
  assert.notEqual(pakeErrorText("closed"), pakeErrorText("no-codes"));
  assert.match(pakeErrorText("unknown"), /does not know/);
});
