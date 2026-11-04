// PAKE pairing on the host (`pairpake.ts`, `pair.ts`): sessions, the miss cap, what a hit spends, and
// the rule that a code never crosses a plain socket and lives. The crypto's own vectors are in
// `packages/shared/test/pake.test.mjs`; here the phone's half is that same module, driven as a phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  normalizePairCode, pairCommit, pakeDecode, pakeEncode, pakePhoneFinish, pakePhoneOpen, pakePhoneStart, parsePairDeepLink, updateKeyFingerprint,
} from "@waterplane/shared";
import {
  PairStore, codeMayCross, handlePairAuthed, handlePairPage, handlePairPreAuth, invalidPage, pairNetFrom, pakeFinishLimit, pakeRoute, pakeStartLimit, plainSocketPage, redeemPair,
} from "../dist/pair.js";
import { PAKE_MAX_SESSIONS, PAKE_MISS_CAP, PAKE_SESSION_TTL_MS } from "../dist/pairpake.js";
import { AuthManager } from "../dist/auth.js";
import { pairLines } from "../dist/cli/pair.js";

const root = () => mkdtempSync(join(tmpdir(), "waterplane-pake-"));
const clock = (t = 1_000_000) => { const c = { t, now: () => c.t }; return c; };
const NET = { name: "SECRETHOST", base: "http://100.64.1.2:8770", httpsUrl: null, lanBase: "http://192.168.1.20:8770" };
const TLS = { port: 8771, spki: "cd".repeat(32) };

function world({ password = true, compare, tls = TLS } = {}) {
  const c = clock();
  const r = root();
  const auth = new AuthManager(r);
  if (password) auth.setPassword("correct horse");
  const store = new PairStore({ now: c.now, ...(compare ? { compare } : {}) });
  let gateChanges = 0;
  const deps = { root: r, port: 8770, auth, store, net: async () => NET, apk: () => null, tls: () => tls, onGateChange: () => { gateChanges++; } };
  return { c, auth, store, deps, gateChanges: () => gateChanges };
}

const start = (d, code) => pakeRoute("start", code, "lan", d);
const finish = (d, body, kind = "lan") => pakeRoute("finish", body, kind, d);

/** One phone: `start`, then what it would answer. */
async function open(d, code, box = { deviceName: "Pixel" }) {
  const p = await pakePhoneStart(normalizePairCode(code));
  const s = await start(d, p.request);
  if (!s.body.ok) return { start: s };
  const f = await pakePhoneFinish(p.state, s.body, box);
  return { start: s, ...f, state: p.state };
}

async function pair(d, code, box, kind) {
  const a = await open(d, code, box);
  const r = await finish(d, a.request, kind);
  return { ...a, finish: r, sealed: r.body.ok ? await pakePhoneOpen(a.candidates, r.body.seal) : null };
}

test("a full exchange from the Wi-Fi: the seal opens, the token works, the code is spent", async () => {
  const w = world();
  const { code } = w.store.mint(null);
  const { finish: r, sealed } = await pair(w.deps, code);
  assert.equal(r.status, 200);
  assert.equal(sealed.ok, true);
  assert.ok(w.auth.checkToken(sealed.token), "the token is live");
  assert.equal(w.auth.deviceFor(sealed.token).name, "Pixel");
  assert.equal(sealed.host.base, NET.base);
  assert.equal(sealed.hostId, sealed.lanIdentity.hostId);
  assert.ok(sealed.lanIdentity.secret, "sealed, so a LAN redeemer may have it");
  assert.deepEqual(sealed.tls, TLS);
  assert.ok(pakeDecode(sealed.updateKey)?.length > 0);
  assert.equal(w.store.peek(code), "used");
  assert.equal(w.store.pake.size, 0);
});

test("nothing in the sealed reply travels outside the seal", async () => {
  const w = world();
  const { finish: r, sealed } = await pair(w.deps, w.store.mint(null).code);
  assert.deepEqual(Object.keys(r.body).sort(), ["ok", "seal"]);
  assert.ok(!JSON.stringify(r.body).includes(sealed.token));
});

test("the sealed facts match what the deep link committed to", async () => {
  const w = world();
  const res = fakeRes();
  await handlePairAuthed(fakeReq("/api/pair/mint", "127.0.0.1", "POST", "{}"), res, null, w.deps, "loopback");
  const m = JSON.parse(res.body);
  const link = parsePairDeepLink(m.deepLink);
  const { sealed } = await pair(w.deps, m.code);
  assert.equal(link.commit, await pairCommit(sealed.updateKey, sealed.tls.spki));
  assert.equal(m.commit, link.commit);
  assert.equal(m.updateKeyFingerprint, await updateKeyFingerprint(sealed.updateKey));
  assert.equal(link.secure, true);
  assert.equal(link.base, NET.base, "u= stays the plain base, never TLS");
  assert.equal(link.lan, NET.lanBase);
  assert.ok(!m.deepLink.includes(String(TLS.port)), "TLS facts ride only inside the seal");
  const lan = parsePairDeepLink(m.lanDeepLink);
  assert.equal(lan.base, NET.lanBase);
  assert.equal(lan.commit, link.commit);
  assert.equal(m.lanBase, NET.lanBase);
});

test("a desktop with no TLS listener commits to the update key alone, and the seal says the same", async () => {
  const w = world({ tls: null });
  const res = fakeRes();
  await handlePairAuthed(fakeReq("/api/pair/mint", "127.0.0.1", "POST", "{}"), res, null, w.deps, "loopback");
  const m = JSON.parse(res.body);
  const { sealed } = await pair(w.deps, m.code);
  assert.equal(sealed.tls, undefined);
  assert.equal(m.commit, await pairCommit(sealed.updateKey));
});

test("with no password the link does not promise PAKE, which would refuse every attempt", async () => {
  const w = world({ password: false });
  const res = fakeRes();
  await handlePairAuthed(fakeReq("/api/pair/mint", "127.0.0.1", "POST", "{}"), res, null, w.deps, "loopback");
  const m = JSON.parse(res.body);
  const link = parsePairDeepLink(m.deepLink);
  assert.equal(link.secure, undefined);
  assert.equal(link.commit, undefined);
  assert.equal(m.commit, undefined);
  assert.ok(m.updateKeyFingerprint, "the fingerprint is printed either way");
});

test(`at most ${PAKE_MAX_SESSIONS} sessions, the oldest out`, async () => {
  const w = world();
  const { code } = w.store.mint(null);
  const first = await open(w.deps, code);
  for (let i = 0; i < PAKE_MAX_SESSIONS; i++) await open(w.deps, code);
  assert.equal(w.store.pake.size, PAKE_MAX_SESSIONS);
  const r = await finish(w.deps, first.request);
  assert.equal(r.status, 410);
  assert.equal(r.body.error, "no-session");
});

test(`a session lives ${PAKE_SESSION_TTL_MS / 1000} s, and running out costs no miss`, async () => {
  const w = world();
  const { code } = w.store.mint(null);
  const a = await open(w.deps, code);
  w.c.t += PAKE_SESSION_TTL_MS;
  const r = await finish(w.deps, a.request);
  assert.equal(r.body.error, "no-session");
  assert.equal(w.store.peek(code), "ok");
  const b = await open(w.deps, code);
  w.c.t += PAKE_SESSION_TTL_MS - 1;
  assert.equal((await finish(w.deps, b.request)).status, 200, "just inside the 60 seconds");
});

test("one finish per session, whatever it decided: a wrong one leaves no second try", async () => {
  const w = world();
  const { code } = w.store.mint(null);
  const good = await open(w.deps, code);
  const junk = { ...good.request, confirm: [pakeEncode(new Uint8Array(32))] };
  assert.equal((await finish(w.deps, junk)).body.error, "unknown");
  const r = await finish(w.deps, good.request);
  assert.equal(r.body.error, "no-session");
  assert.equal(w.store.peek(code), "ok", "the code survives");
});

test("a replayed finish finds nothing: one token, one row", async () => {
  const w = world();
  const a = await pair(w.deps, w.store.mint(null).code);
  const r = await finish(w.deps, a.request);
  assert.equal(r.status, 410);
  assert.equal(r.body.error, "no-session");
  assert.equal(w.auth.devices.list().length, 1);
});

test("a start cannot replace a live session", async () => {
  const w = world();
  const { code } = w.store.mint(null);
  const p = await pakePhoneStart(code);
  const s = await start(w.deps, p.request);
  const again = await start(w.deps, p.request);
  assert.equal(again.status, 400);
  const f = await pakePhoneFinish(p.state, s.body, { deviceName: "Pixel" });
  assert.equal((await finish(w.deps, f.request)).status, 200, "the phone's attempt is still the one held");
});

test("start refuses a share that is no group element, and holds nothing for it", async () => {
  const w = world();
  w.store.mint(null);
  const sidP = pakeEncode(new Uint8Array(16).fill(7));
  for (const ya of [pakeEncode(new Uint8Array(32)), pakeEncode(Buffer.from("ed" + "ff".repeat(30) + "7f", "hex")), "short", 7]) {
    const r = await start(w.deps, { sidP, ya });
    assert.equal(r.status, 400, String(ya));
    assert.equal(r.body.error, "bad-request");
  }
  assert.equal((await start(w.deps, {})).status, 400);
  assert.equal(w.store.pake.size, 0);
});

test("a host offers at most five codes, one share each", async () => {
  const w = world();
  for (let i = 0; i < 7; i++) w.store.mint(null);
  const a = await open(w.deps, "ABCDEFGH");
  assert.equal(a.start.body.yb.length, 5);
});

test("more than five open: the newest five are offered, so the new QR the phone asks for always pairs", async () => {
  const w = world();
  const codes = Array.from({ length: 6 }, () => w.store.mint(null).code);
  const oldest = await pair(w.deps, codes[0], { deviceName: "Pixel" }, "lan");
  assert.equal(oldest.finish.status, 403);
  assert.equal(oldest.finish.body.error, "unknown");
  const newest = await pair(w.deps, codes[5], { deviceName: "Pixel" }, "lan");
  assert.equal(newest.finish.status, 200);
  assert.ok(newest.sealed);
});

test("no password: refused at start, nothing spent, not a 404", async () => {
  const w = world({ password: false });
  const { code } = w.store.mint(null);
  const { start: s } = await open(w.deps, code);
  assert.equal(s.status, 403);
  assert.equal(s.body.error, "no-password");
  assert.equal(w.store.peek(code), "ok");
  assert.equal(w.store.pake.size, 0);
});

test("no live code: no-codes, not a 404 an older host could have sent", async () => {
  const w = world();
  const { start: s } = await open(w.deps, "ABCDEFGH");
  assert.equal(s.status, 409);
  assert.equal(s.body.error, "no-codes");
  assert.match(s.body.message, /no pairing code/);
});

test(`${PAKE_MISS_CAP} misses close a code for PAKE only: redeem still takes it`, async () => {
  const w = world();
  const { code } = w.store.mint(null);
  for (let i = 0; i < PAKE_MISS_CAP - 1; i++) {
    const r = await pair(w.deps, "ZZZZZZZZ");
    assert.equal(r.finish.status, 403);
    assert.equal(r.finish.body.error, "unknown", `miss ${i + 1}`);
  }
  const last = await pair(w.deps, "ZZZZZZZZ");
  assert.equal(last.finish.body.error, "closed", "the miss that closes it says so");
  const { start: s } = await open(w.deps, code);
  assert.equal(s.status, 409);
  assert.equal(s.body.error, "closed");
  assert.equal(w.store.peek(code), "ok", "closed is not burned");
  const r = await redeemPair({ code, deviceName: "Pixel" }, "tailscale", w.deps);
  assert.equal(r.status, 200);
  assert.ok(w.auth.checkToken(r.body.token));
});

test("a closed code is left out of the offer, and the live one beside it still pairs", async () => {
  const w = world();
  const a = w.store.mint(null).code;
  for (let i = 0; i < PAKE_MISS_CAP; i++) await pair(w.deps, "ZZZZZZZZ");
  const b = w.store.mint(null).code;
  assert.equal((await open(w.deps, a)).start.body.yb.length, 1);
  assert.equal((await pair(w.deps, b)).finish.status, 200);
});

test("a miss counts on every code offered, and a hit counts on none", async () => {
  const w = world();
  w.store.mint(null);
  w.store.mint(null);
  for (let i = 0; i < PAKE_MISS_CAP; i++) await pair(w.deps, "ZZZZZZZZ");
  assert.equal(w.store.pakeCodes().open.length, 0);
  assert.equal(w.store.pakeCodes().live, 2);
});

test("every confirm is compared with every code, whichever matched first", async () => {
  let calls = 0;
  const w = world({ compare: (a, b) => { calls++; return timingSafeEqual(a, b); } });
  const codes = [w.store.mint(null).code, w.store.mint(null).code, w.store.mint(null).code];
  const a = await open(w.deps, codes[0]);
  calls = 0;
  assert.equal((await finish(w.deps, a.request)).status, 200);
  assert.ok(calls >= 9, `3 offers by 3 confirms, saw ${calls}`);
});

test("a relay that reorders yb changes nothing: the confirm is matched by value", async () => {
  const w = world();
  w.store.mint(null);
  const { code } = w.store.mint(null);
  const p = await pakePhoneStart(code);
  const s = await start(w.deps, p.request);
  const f = await pakePhoneFinish(p.state, { nh: s.body.nh, yb: [...s.body.yb].reverse() }, { deviceName: "Pixel" });
  const r = await finish(w.deps, f.request);
  assert.equal(r.status, 200);
  assert.ok((await pakePhoneOpen(f.candidates, r.body.seal)).token);
  assert.equal(w.store.peek(code), "used");
});

test("a tampered box is a miss: the right code is not spent and no token exists", async () => {
  const w = world();
  const { code } = w.store.mint(null);
  const a = await open(w.deps, code);
  const b = Buffer.from(a.request.box[0], "base64");
  b[b.length - 1] ^= 1;
  const r = await finish(w.deps, { ...a.request, box: [b.toString("base64")] });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "unknown");
  assert.equal(w.store.peek(code), "ok");
  assert.equal(w.auth.devices.list().length, 0);
  assert.equal(w.store.pakeCodes().open.length, 1);
});

test("more confirms than offers, a box list that does not line up, or junk: a miss, and the session is gone", async () => {
  const w = world();
  const { code } = w.store.mint(null);
  for (const mangle of [
    (q) => ({ ...q, confirm: [q.confirm[0], q.confirm[0]], box: [q.box[0], q.box[0]] }),
    (q) => ({ ...q, box: [] }),
    (q) => ({ ...q, confirm: "x" }),
    (q) => ({ ...q, confirm: [] , box: [] }),
    (q) => ({ ...q, confirm: ["short"] }),
  ]) {
    const a = await open(w.deps, code);
    const r = await finish(w.deps, mangle(a.request));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "unknown");
    assert.equal((await finish(w.deps, a.request)).body.error, "no-session");
  }
  assert.equal(w.store.peek(code), "ok");
});

test("a finish with no readable sidP touches nothing", async () => {
  const w = world();
  const { code } = w.store.mint(null);
  await open(w.deps, code);
  assert.equal((await finish(w.deps, {})).status, 400);
  assert.equal((await finish(w.deps, { sidP: pakeEncode(new Uint8Array(16)) })).status, 410);
  assert.equal(w.store.pake.size, 1);
});

test("a code spent between start and finish answers used, and spends nothing twice", async () => {
  const w = world();
  const { code } = w.store.mint(null);
  const a = await open(w.deps, code);
  w.store.redeem(code);
  const r = await finish(w.deps, a.request);
  assert.equal(r.status, 410);
  assert.equal(r.body.error, "used");
  assert.equal(w.auth.devices.list().length, 0);
});

test("a passive code keeps its scope over PAKE, and switches the gate on", async () => {
  const w = world();
  const { code } = w.store.mint(null, true);
  const { sealed } = await pair(w.deps, code);
  assert.equal(sealed.scope, "passive");
  assert.equal(w.auth.deviceFor(sealed.token).scope, "passive");
  assert.equal(w.auth.gateTailscale(), true);
  assert.equal(w.gateChanges(), 1);
});

test("presented in the box retires the caller's own row and nobody else's", async () => {
  const w = world();
  const first = (await pair(w.deps, w.store.mint(null).code, { deviceName: "Pixel" })).sealed;
  const other = (await pair(w.deps, w.store.mint(null).code, { deviceName: "Tablet" })).sealed;
  const again = (await pair(w.deps, w.store.mint(null).code, { deviceName: "Pixel", presented: first.token })).sealed;
  assert.ok(w.auth.checkToken(again.token));
  assert.equal(w.auth.checkToken(first.token), false, "the old row is gone");
  assert.ok(w.auth.checkToken(other.token), "another device is untouched");
  assert.equal(w.auth.devices.list().length, 2);
  await pair(w.deps, w.store.mint(null).code, { deviceName: "Pixel", presented: "not-a-token" });
  assert.ok(w.auth.checkToken(again.token) && w.auth.checkToken(other.token), "junk retires nothing");
});

test("a miss never retires what its box presented", async () => {
  const w = world();
  const first = (await pair(w.deps, w.store.mint(null).code)).sealed;
  w.store.mint(null);
  await pair(w.deps, "ZZZZZZZZ", { deviceName: "x", presented: first.token });
  assert.ok(w.auth.checkToken(first.token));
});

test("no header is read on these routes: a Bearer retires nothing and buys nothing", async () => {
  const w = world();
  const held = (await pair(w.deps, w.store.mint(null).code)).sealed;
  const { code } = w.store.mint(null);
  const p = await pakePhoneStart(code);
  const headers = { authorization: `Bearer ${held.token}` };
  const sRes = fakeRes();
  await handlePairPreAuth(fakeReq("/api/pair/pake/start", "10.1.0.1", "POST", JSON.stringify(p.request), headers), sRes, "lan", w.deps);
  const f = await pakePhoneFinish(p.state, JSON.parse(sRes.body), { deviceName: "New" });
  const fRes = fakeRes();
  await handlePairPreAuth(fakeReq("/api/pair/pake/finish", "10.1.0.1", "POST", JSON.stringify(f.request), headers), fRes, "lan", w.deps);
  assert.equal(fRes.status, 200);
  assert.ok(w.auth.checkToken(held.token), "a header never stands in for `presented`");
});

test("both routes answer POST only, and each is rate-limited per IP", async () => {
  const w = world();
  w.store.mint(null);
  const get = fakeRes();
  assert.equal(await handlePairPreAuth(fakeReq("/api/pair/pake/start", "10.1.0.2"), get, "lan", w.deps), true);
  assert.equal(get.status, 405);
  assert.equal(await handlePairPreAuth(fakeReq("/api/pair/mint", "10.1.0.2", "POST"), fakeRes(), "lan", w.deps), false, "the rest of /api/pair stays behind the gate");
  for (const [limit, path] of [[pakeStartLimit, "/api/pair/pake/start"], [pakeFinishLimit, "/api/pair/pake/finish"]]) {
    for (let i = 0; i < 5; i++) assert.equal(limit.take("10.1.0.3"), true);
    const res = fakeRes();
    await handlePairPreAuth(fakeReq(path, "10.1.0.3", "POST", "{}"), res, "lan", w.deps);
    assert.equal(res.status, 429, path);
    assert.equal(JSON.parse(res.body).error, "rate-limited");
    assert.ok(Number(res.headers["retry-after"]) >= 1);
  }
});

test("five boxes fit under the body cap", async () => {
  const w = world();
  for (let i = 0; i < 5; i++) w.store.mint(null);
  const a = await open(w.deps, "ZZZZZZZZ", { deviceName: "x".repeat(100), presented: "t".repeat(200) });
  const res = fakeRes();
  await handlePairPreAuth(fakeReq("/api/pair/pake/finish", "10.1.0.4", "POST", JSON.stringify(a.request)), res, "lan", w.deps);
  assert.equal(res.status, 403, "read and refused as a miss, not cut off");
});

/** A fake req/res pair, the body an async iterable as a real request's is. */
function fakeReq(url, addr = "10.9.0.1", method = "GET", body = "", headers = {}, socket = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(req, { url, method, headers, socket: { remoteAddress: addr, ...socket } });
}
function fakeRes() {
  const r = { status: 0, headers: {}, body: "" };
  r.writeHead = (s, h) => { r.status = s; r.headers = h ?? {}; return r; };
  r.end = (b) => { if (b) r.body += String(b); };
  return r;
}

const APK = () => {
  const dir = mkdtempSync(join(tmpdir(), "waterplane-pake-apk-"));
  const path = join(dir, "x.apk");
  writeFileSync(path, "apk");
  return { path, size: 3, mtimeMs: Date.now() };
};

let addrSeq = 0;
const next = () => ++addrSeq;

// Every peer kind `requestPeerKind` can answer, by what actually arrives. A distinct address per
// row keeps the landing limiter out of the test.
const PROTECTED = [
  ["loopback", () => ["127.0.0.1", { host: "127.0.0.1:8770" }, {}]],
  ["tailnet", () => [`100.64.7.${next()}`, {}, {}]],
  ["through tailscale serve", () => ["127.0.0.1", { host: "box.tail1234.ts.net", "x-forwarded-for": `100.64.8.${next()}`, "tailscale-user-login": "a@b" }, {}]],
  ["TLS from the Wi-Fi", () => [`192.168.7.${next()}`, {}, { encrypted: true }]],
];
const PLAIN = [
  ["plain from the Wi-Fi", () => [`192.168.8.${next()}`, {}, {}]],
  ["plain from a public address", () => [`203.0.113.${next()}`, {}, {}]],
  ["no address at all", () => [undefined, {}, {}]],
  ["a proxy header forged by a Wi-Fi peer", () => [`192.168.9.${next()}`, { "x-forwarded-for": "100.64.0.1", "tailscale-user-login": "a@b" }, {}]],
  ["a Funnel request", () => ["127.0.0.1", { host: "box.tail1234.ts.net", "tailscale-funnel-request": "?1", "x-forwarded-for": `203.0.113.${next()}` }, {}]],
];

const req = ([addr, headers, socket], url, method = "GET") => fakeReq(url, addr, method, "", headers, socket);

for (const [name, peer] of PROTECTED) {
  test(`landing, ${name}: the page, the deep link and the APK, and the code lives`, async () => {
    const w = world();
    const d = { ...w.deps, apk: APK };
    const { code } = w.store.mint(null);
    const page = fakeRes();
    await handlePairPage(req(peer(), `/pair/${code}`), page, d);
    assert.equal(page.status, 200);
    assert.match(page.body, /SECRETHOST/);
    assert.match(page.body, /:\/\/pair\?u=/);
    assert.match(page.body, /s=1&amp;k=|s=1&k=/, "its deep link is the secure one");
    const apk = fakeRes();
    apk.write = () => true; apk.on = () => apk; apk.once = () => apk; apk.emit = () => true; apk.removeListener = () => apk;
    await handlePairPage(req(peer(), `/pair/${code}/apk`, "HEAD"), apk, d);
    assert.equal(apk.status, 200);
    assert.equal(apk.headers["content-type"], "application/vnd.android.package-archive");
    assert.equal(w.store.peek(code), "ok");
  });
}

for (const [name, peer] of PLAIN) {
  for (const [what, suffix, method] of [["page", "", "GET"], ["APK", "/apk", "GET"], ["HEAD", "", "HEAD"]]) {
    test(`landing, ${name}, ${what}: nothing about this desktop, and the code is burned`, async () => {
      const w = world();
      let asked = 0;
      const d = { ...w.deps, apk: () => { asked++; return APK(); }, net: async () => { asked++; return NET; } };
      const { code } = w.store.mint(null);
      const res = fakeRes();
      await handlePairPage(req(peer(), `/pair/${code}${suffix}`, method), res, d);
      assert.equal(res.status, 403);
      assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.body, method === "HEAD" ? "" : plainSocketPage());
      assert.doesNotMatch(res.body, /SECRETHOST|100\.64|192\.168|:\/\/pair\?|\/apk|href=/);
      assert.equal(asked, 0, "nothing about this desktop was even looked up");
      assert.equal(w.store.peek(code), "used");
      assert.equal(w.store.pakeCodes().open.length, 0, "PAKE no longer offers it");
    });
  }
}

test("the plain page says to scan the code on the desktop's screen", () => {
  assert.match(plainSocketPage(), /scan it from the desktop's screen/);
});

test("a burned code is simply invalid afterwards, and redeem refuses it", async () => {
  const w = world();
  const { code } = w.store.mint(null);
  const peer = PLAIN[0][1];
  await handlePairPage(req(peer(), `/pair/${code}`), fakeRes(), w.deps);
  const again = fakeRes();
  await handlePairPage(req(peer(), `/pair/${code}`), again, w.deps);
  assert.equal(again.status, 404);
  assert.equal(again.body, invalidPage());
  const r = await redeemPair({ code, deviceName: "x" }, "tailscale", w.deps);
  assert.equal(r.body.error, "used");
});

test("a plain socket's bad code still gets the same invalid page, and burns no other code", async () => {
  const w = world();
  const { code } = w.store.mint(null);
  for (const path of ["/pair/ABCDEFGH", "/pair/nonsense", "/pair"]) {
    const res = fakeRes();
    await handlePairPage(req(PLAIN[0][1](), path), res, w.deps);
    assert.equal(res.status, 404, path);
    assert.equal(res.body, invalidPage(), path);
  }
  assert.equal(w.store.peek(code), "ok");
});

test("the code burns before the rate limit and the method check: a relay cannot spend those first", async () => {
  const w = world();
  const peer = PLAIN[0][1]();
  for (let i = 0; i < 40; i++) await handlePairPage(req(peer, "/pair/nonsense"), fakeRes(), w.deps);
  const { code } = w.store.mint(null);
  const limited = fakeRes();
  await handlePairPage(req(peer, `/pair/${code}`), limited, w.deps);
  assert.equal(limited.status, 429);
  assert.equal(limited.body, invalidPage());
  assert.equal(w.store.peek(code), "used");
  const posted = w.store.mint(null).code;
  const res = fakeRes();
  await handlePairPage(req(PLAIN[0][1](), `/pair/${posted}`, "POST"), res, w.deps);
  assert.equal(res.status, 405);
  assert.equal(w.store.peek(posted), "used");
});

test("codeMayCross reads requestPeerKind's answer and the socket, nothing else", () => {
  assert.equal(codeMayCross("loopback", {}), true);
  assert.equal(codeMayCross("tailscale", {}), true);
  for (const kind of ["lan", "public", "unknown"]) {
    assert.equal(codeMayCross(kind, {}), false, kind);
    assert.equal(codeMayCross(kind, { encrypted: true }), true, kind);
  }
});

const netOf = (over) => pairNetFrom({ port: 8770, name: "h", httpsUrl: null, tailscale: null, hostEnv: undefined, allowPublic: false, lanIps: [], ...over });

test("pairNet: no tailnet means the plain LAN address, never loopback and never TLS", () => {
  const lan = netOf({ allowPublic: true, lanIps: ["192.168.1.5", "10.0.0.2"] });
  assert.equal(lan.base, "http://192.168.1.5:8770");
  assert.equal(lan.lanBase, "http://192.168.1.5:8770");
  assert.equal(lan.httpsUrl, null);
});

test("pairNet: the tailnet still wins, with the LAN address beside it", () => {
  const n = netOf({ tailscale: "100.64.1.2", allowPublic: true, lanIps: ["192.168.1.5"] });
  assert.equal(n.base, "http://100.64.1.2:8770");
  assert.equal(n.lanBase, "http://192.168.1.5:8770");
  assert.equal(netOf({ httpsUrl: "https://h.ts.net", tailscale: "100.64.1.2" }).base, "https://h.ts.net");
});

test("pairNet: an explicit host is what is bound; loopback only when nothing else is", () => {
  assert.equal(netOf({ hostEnv: "192.168.1.9", allowPublic: true, lanIps: ["192.168.1.5"] }).base, "http://192.168.1.9:8770");
  assert.equal(netOf({ hostEnv: "::1" }).base, "http://[::1]:8770");
  assert.equal(netOf({ hostEnv: "0.0.0.0", allowPublic: true, lanIps: ["192.168.1.5"] }).base, "http://192.168.1.5:8770");
  assert.equal(netOf({ lanIps: ["192.168.1.5"] }).base, "http://127.0.0.1:8770", "not opted in: the LAN is not bound");
  assert.equal(netOf({ allowPublic: true }).base, "http://127.0.0.1:8770", "no LAN interface at all");
});

test("the landing page tells a LAN-only desktop's phone about the network, not the tailnet", async () => {
  const w = world();
  const d = { ...w.deps, net: async () => ({ name: "H", base: "http://192.168.1.5:8770", httpsUrl: null, lanBase: "http://192.168.1.5:8770" }) };
  const res = fakeRes();
  await handlePairPage(req(PROTECTED[3][1](), `/pair/${w.store.mint(null).code}`), res, d);
  assert.match(res.body, /same network/);
  assert.doesNotMatch(res.body, /same tailnet/);
});

const MINT = { code: "ABCDEFGH", expiresAt: 1, base: "http://100.64.0.80:8770", landingUrl: "http://100.64.0.80:8770/pair/ABCDEFGH", deepLink: "x://pair?u=a&c=b" };

test("pair CLI: the fingerprint beside the code, and the LAN deep link when there is one", () => {
  const text = pairLines({ ...MINT, updateKeyFingerprint: "ab".repeat(32), lanBase: "http://192.168.1.5:8770", lanDeepLink: "x://pair?u=lan" }).join("\n");
  assert.match(text, new RegExp(`Update key +${"ab".repeat(32)}`));
  assert.match(text, /LAN deep link +x:\/\/pair\?u=lan/);
  assert.match(text, /Landing URL/);
});

test("pair CLI: a LAN-only desktop prints no plain landing URL to open, which would burn the code", () => {
  const base = "http://192.168.1.5:8770";
  const text = pairLines({ ...MINT, base, lanBase: base, landingUrl: `${base}/pair/ABCDEFGH` }).join("\n");
  assert.doesNotMatch(text, /Landing URL|\/pair\/ABCDEFGH|Web app/);
  assert.match(text, /Deep link/);
  assert.match(text, /cancels the code/);
});
