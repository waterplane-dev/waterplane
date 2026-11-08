// The Web Push wire format against its own RFCs: a wrong byte here is a push the phone silently
// cannot read, and the push service still answers 201.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { encryptPayload, generateVapidKeys, postPush, PushRefused, PUSH_MAX_PLAINTEXT, pushTransport, vapidAuthorization, vapidFrom } from "../dist/pushsend.js";

const u = (s) => Buffer.from(s, "base64url");

test("RFC 8291 appendix A: the worked example comes out byte for byte", () => {
  const body = encryptPayload("When I grow up, I want to be a watermelon", {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  }, { privateKey: u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: u("DGv6ra1nlYgDCS1FRnbzlw") });
  assert.equal(body.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

/** The phone's side, written from the RFC separately from the sender. */
function decrypt(body, ua, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ua.computeSecret(asPublic), auth, info, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const iv = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const rest = body.subarray(21 + idlen);
  const d = createDecipheriv("aes-128-gcm", key, iv);
  d.setAuthTag(rest.subarray(-16));
  const out = Buffer.concat([d.update(rest.subarray(0, -16)), d.final()]);
  let end = out.length - 1;
  while (end > 0 && out[end] === 0) end--;
  assert.equal(out[end], 2, "the last record's delimiter, before any padding");
  return out.subarray(0, end).toString("utf8");
}

test("a fresh send reads back on the phone's side, at the largest size too, and never repeats a key or salt", () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
  const big = "é".repeat(PUSH_MAX_PLAINTEXT / 2) + "x".repeat(PUSH_MAX_PLAINTEXT % 2);
  for (const text of ["", "hello", big]) assert.equal(decrypt(encryptPayload(text, keys), ua, auth), text);
  assert.equal(encryptPayload(big, keys).length, 4096, "the whole body stays inside what a push service must take");
  const a = encryptPayload("same", keys), b = encryptPayload("same", keys);
  assert.notDeepEqual(a.subarray(0, 86), b.subarray(0, 86));
});

test("a payload over one record and a subscription with bad keys are refused, never sent wrong", () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
  assert.throws(() => encryptPayload("x".repeat(PUSH_MAX_PLAINTEXT + 1), keys), /over/);
  assert.throws(() => encryptPayload("x", { ...keys, p256dh: "x" }), /p256dh/);
  assert.throws(() => encryptPayload("x", { ...keys, auth: "y" }), /auth/);
});

test("generated keys are always full length, even a private scalar with a leading zero byte", () => {
  for (let i = 0; i < 600; i++) {
    const k = generateVapidKeys();
    assert.equal(u(k.publicKey).length, 65);
    assert.equal(u(k.privateKey).length, 32);
  }
});

test("the VAPID header: the service's origin, 12 h from this host's clock, a signature the public key verifies", () => {
  const keys = generateVapidKeys();
  const vapid = vapidFrom("mailto:a@example.com", keys);
  const now = 1_800_000_000_000;
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(vapidAuthorization("https://fcm.example.test:8443/send/secret?x=1", vapid, now));
  assert.ok(m);
  assert.deepEqual(JSON.parse(u(m[1])), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(u(m[2])), { aud: "https://fcm.example.test:8443", exp: now / 1000 + 12 * 3600, sub: "mailto:a@example.com" });
  assert.equal(m[4], keys.publicKey);
  const point = u(keys.publicKey);
  const pub = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") } });
  assert.ok(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: "ieee-p1363" }, u(m[3])));
});

test("a contact or key no service could accept is refused at boot", () => {
  const keys = generateVapidKeys();
  assert.throws(() => vapidFrom("not a url", keys));
  assert.throws(() => vapidFrom("http://example.com", keys), /https: or mailto:/);
  assert.throws(() => vapidFrom("mailto:a@example.com", { ...keys, publicKey: "AAAA" }), /public key/);
  assert.throws(() => vapidFrom("mailto:a@example.com", { ...keys, privateKey: "AAAA" }), /private key/);
});

test("the body's size says a class, not a length, and a payload cut to the 1024 floor is not padded past it", () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
  const size = (n) => encryptPayload("x".repeat(n), keys).length;
  assert.equal(size(1), size(256));
  assert.equal(size(300), size(512));
  assert.ok(size(256) < size(257));
  assert.equal(size(1024), 1024 + 86 + 17);
  const text = "x".repeat(300);
  assert.equal(decrypt(encryptPayload(text, keys), ua, auth), text);
});

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });
async function serve(handler) {
  const s = createServer(handler); servers.push(s);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return new URL(`http://127.0.0.1:${s.address().port}/secret`);
}
const post = (url, ms) => postPush(url, {}, Buffer.from("x"), ms, httpRequest);

test("a service that drips its answer forever is given up on at the deadline, as a timeout", async (t) => {
  const timers = [];
  t.after(() => timers.forEach(clearInterval));
  const url = await serve((_req, res) => { res.writeHead(201); timers.push(setInterval(() => res.write("."), 10)); });
  const started = Date.now();
  await assert.rejects(post(url, 150), (e) => e.code === "ETIMEDOUT");
  assert.ok(Date.now() - started < 2000);
});

test("a 2xx resolves; anything else is a refusal carrying the status and the Date header push.ts reads", async () => {
  let length;
  await post(await serve((req, res) => { length = req.headers["content-length"]; res.writeHead(201); res.end(); }), 2000);
  assert.equal(length, "1");
  const date = "Sat, 07 Nov 2026 12:00:00 GMT";
  await assert.rejects(post(await serve((_req, res) => { res.writeHead(403, { date }); res.end("no"); }), 2000),
    (e) => e instanceof PushRefused && e.statusCode === 403 && e.headers.date === date);
});

test("a malformed endpoint is refused without its text anywhere on the error", () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
  const vapid = vapidFrom("mailto:a@example.com", generateVapidKeys());
  assert.throws(() => pushTransport.sendNotification({ endpoint: "no-scheme/secret-path", keys }, "x", vapid), (e) => {
    assert.equal(e.code, "ERR_INVALID_URL");
    assert.ok(!JSON.stringify({ ...e, m: e.message, s: e.stack }).includes("secret-path"));
    return true;
  });
});
