/**
 * Pairing codes (`pair.ts`): TTL, single use on redeem (and NOT on a page view),
 * nothing but a hash at rest, the constant-time lookup, the outstanding cap,
 * the redeem limiter, what a redeem hands to which peer kind, and that the
 * landing page for a bad code says nothing about this desktop.
 *
 * `scripts/e2e-pair.mjs` drives the same through a live server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAIR_TTL_MS, formatPairCode } from "@waterplane/shared";
import {
  PairStore, PAIR_MAX_OUTSTANDING, redeemPair, redeemLimit, invalidPage, landingPage, latestApk, handlePairPage, apkSource, releaseApkUrl, handlePairAuthed,
} from "../dist/pair.js";
import { AuthManager } from "../dist/auth.js";

const root = () => mkdtempSync(join(tmpdir(), "waterplane-pair-"));
const clock = (t = 1_000_000) => { const c = { t, now: () => c.t }; return c; };
const NET = { name: "SECRETHOST", base: "https://secrethost.tail1234.ts.net", httpsUrl: "https://secrethost.tail1234.ts.net", lanBase: "http://192.168.1.20:8770" };
const deps = (r, auth, store) => ({ root: r, auth, store, net: async () => NET });

test("a code is live for PAIR_TTL_MS, then expired", () => {
  const c = clock();
  const s = new PairStore({ now: c.now });
  const { code, expiresAt } = s.mint(null);
  assert.equal(expiresAt, c.t + PAIR_TTL_MS);
  assert.equal(s.peek(code), "ok");
  c.t += PAIR_TTL_MS - 1;
  assert.equal(s.peek(code), "ok");
  c.t += 1;
  assert.equal(s.peek(code), "expired");
  assert.equal(s.redeem(code).state, "expired");
  c.t += 2 * PAIR_TTL_MS; // forgotten entirely later
  assert.equal(s.peek(code), "unknown");
});

test("single use: redeem spends it, peek (landing, APK) does not", () => {
  const s = new PairStore({ now: clock().now });
  const { code } = s.mint("dev1");
  for (let i = 0; i < 5; i++) assert.equal(s.peek(code), "ok");
  assert.deepEqual(s.redeem(code), { state: "ok", mintedBy: "dev1", passive: false });
  assert.equal(s.redeem(code).state, "used");
  assert.equal(s.peek(code), "used");
  assert.equal(s.peek("ABCDEFGH"), "unknown");
});

test("only sha256 of the code is held", () => {
  const s = new PairStore();
  const { code } = s.mint(null);
  const hashes = s.storedHashes();
  assert.deepEqual(hashes, [createHash("sha256").update(code).digest("hex")]);
  assert.ok(!JSON.stringify(s).includes(code), "no plaintext on the instance");
});

test("the lookup compares against every entry, never an early exit — and with timingSafeEqual by default", () => {
  let calls = 0;
  const pairs = [];
  const s = new PairStore({ now: clock().now, compare: (x, y) => { calls++; pairs.push([x, y]); return timingSafeEqual(x, y); } });
  const codes = [];
  for (let i = 0; i < PAIR_MAX_OUTSTANDING; i++) codes.push(s.mint(null).code);
  for (const [i, code] of codes.entries()) {
    calls = 0;
    assert.equal(s.peek(code), "ok", `code #${i}`);
    assert.equal(calls, codes.length, `a hit at #${i} still compared against all ${codes.length}`);
  }
  calls = 0;
  assert.equal(s.peek("ZZZZZZZZ"), "unknown");
  assert.equal(calls, codes.length, "a miss compares against all of them too");
  // Every comparison is between two equal-length digests (timingSafeEqual throws otherwise).
  assert.ok(pairs.every(([x, y]) => x.length === 32 && y.length === 32));
  // The default store really is on timingSafeEqual: a store without the seam
  // finds the same codes (a plain !== compare of Buffers would find none).
  const d = new PairStore({ now: clock().now });
  const c = d.mint(null).code;
  assert.equal(d.peek(c), "ok");
});

test(`at most ${PAIR_MAX_OUTSTANDING} outstanding; a new mint drops the oldest`, () => {
  const c = clock();
  const s = new PairStore({ now: c.now });
  const codes = [];
  for (let i = 0; i < PAIR_MAX_OUTSTANDING + 2; i++) { codes.push(s.mint(null).code); c.t += 1; }
  assert.equal(s.outstanding(), PAIR_MAX_OUTSTANDING);
  assert.equal(s.peek(codes[0]), "unknown");
  assert.equal(s.peek(codes[1]), "unknown");
  assert.equal(s.peek(codes.at(-1)), "ok");
  // a spent code does not count against the cap
  s.redeem(codes.at(-1));
  assert.equal(s.outstanding(), PAIR_MAX_OUTSTANDING - 1);
});

test("redeem is rate-limited per key (burst 5, then refused)", () => {
  const key = `test-${Math.random()}`;
  const now = 5_000_000;
  for (let i = 0; i < 5; i++) assert.equal(redeemLimit.take(key, now), true);
  assert.equal(redeemLimit.take(key, now), false);
  assert.ok(redeemLimit.retryAfterMs(key, now) > 0);
  assert.equal(redeemLimit.take(key, now + 10_000), true, "one more after 10 s");
});

test("redeem with a password: token + host; lanIdentity only to loopback/tailscale", async () => {
  const r = root();
  const auth = new AuthManager(r);
  auth.setPassword("correct horse");
  const store = new PairStore();

  const a = await redeemPair({ code: store.mint(null).code, deviceName: "Pixel" }, "tailscale", deps(r, auth, store));
  assert.equal(a.status, 200);
  assert.equal(a.body.ok, true);
  assert.equal(a.body.host.name, "SECRETHOST");
  assert.equal(a.body.host.lanBase, NET.lanBase);
  assert.ok(a.body.token && auth.checkToken(a.body.token));
  assert.equal(auth.deviceFor(a.body.token).name, "Pixel");
  assert.ok(a.body.lanIdentity?.secret, "trusted path gets the identity");

  const b = await redeemPair({ code: store.mint(null).code, deviceName: "Other" }, "lan", deps(r, auth, store));
  assert.equal(b.status, 200);
  assert.ok(b.body.token);
  assert.equal(b.body.lanIdentity, undefined, "a LAN redeemer never gets the identity secret");
});

test("a re-pair presenting this phone's old token replaces its ledger row — no ghost; anyone else's token is untouched", async () => {
  const r = root();
  const auth = new AuthManager(r);
  auth.setPassword("correct horse");
  const store = new PairStore();
  const first = await redeemPair({ code: store.mint(null).code, deviceName: "Pixel" }, "tailscale", deps(r, auth, store));
  const other = await redeemPair({ code: store.mint(null).code, deviceName: "Tablet" }, "tailscale", deps(r, auth, store));
  const again = await redeemPair({ code: store.mint(null).code, deviceName: "Pixel" }, "tailscale", deps(r, auth, store), first.body.token);
  assert.equal(again.status, 200);
  assert.ok(auth.checkToken(again.body.token), "the new token works");
  assert.equal(auth.checkToken(first.body.token), false, "the old row is gone");
  assert.ok(auth.checkToken(other.body.token), "another device is untouched");
  // Garbage or an unknown token retires nothing and does not stop the redeem.
  const junk = await redeemPair({ code: store.mint(null).code, deviceName: "Pixel" }, "tailscale", deps(r, auth, store), "not-a-token");
  assert.equal(junk.status, 200);
  assert.ok(auth.checkToken(again.body.token) && auth.checkToken(other.body.token));
  // A refused redeem (bad code) never retires the presented token.
  const bad = await redeemPair({ code: "ABCD-EFGH" }, "tailscale", deps(r, auth, store), again.body.token);
  assert.equal(bad.status, 404);
  assert.ok(auth.checkToken(again.body.token));
});

test("redeem with no password: tailscale gets no token and is told; LAN is refused and the code survives", async () => {
  const r = root();
  const auth = new AuthManager(r);
  const store = new PairStore();
  const { code } = store.mint(null);
  const lan = await redeemPair({ code, deviceName: "x" }, "lan", deps(r, auth, store));
  assert.equal(lan.status, 403);
  assert.equal(lan.body.ok, false);
  assert.equal(lan.body.error, "no-password");
  assert.equal(store.peek(code), "ok", "a refusal spends nothing");
  const ts = await redeemPair({ code, deviceName: "x" }, "tailscale", deps(r, auth, store));
  assert.equal(ts.body.ok, true);
  assert.equal(ts.body.token, undefined);
  assert.match(ts.body.note, /no password/);
  assert.equal(store.peek(code), "used");
});

test("redeem errors carry the shared sentence", async () => {
  const r = root();
  const auth = new AuthManager(r);
  auth.setPassword("correct horse");
  const store = new PairStore();
  const bad = await redeemPair({ code: "0O1I" }, "lan", deps(r, auth, store));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "bad-request");
  const unk = await redeemPair({ code: "ABCD-EFGH" }, "lan", deps(r, auth, store));
  assert.equal(unk.body.error, "unknown");
  assert.match(unk.body.message, /does not know/);
  const { code } = store.mint(null);
  await redeemPair({ code, deviceName: "a" }, "lan", deps(r, auth, store));
  const again = await redeemPair({ code, deviceName: "a" }, "lan", deps(r, auth, store));
  assert.equal(again.body.error, "used");
  assert.equal(again.body.token, undefined);
});

/** A fake req/res pair enough for `handlePairPage`. */
function fakeReq(url, addr = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {
  return { url, method: "GET", headers: {}, socket: { remoteAddress: addr } };
}
function fakeRes() {
  const r = { status: 0, headers: {}, body: "" };
  r.writeHead = (s, h) => { r.status = s; r.headers = h ?? {}; return r; };
  r.end = (b) => { if (b) r.body += String(b); };
  return r;
}

test("the landing page for a bad, spent or expired code reveals nothing", async () => {
  const c = clock();
  const store = new PairStore({ now: c.now });
  const d = { ...deps(root(), new AuthManager(root()), store), port: 8770, apk: () => null };
  const spent = store.mint(null).code;
  store.redeem(spent);
  const expired = store.mint(null).code;
  c.t += PAIR_TTL_MS;
  for (const path of ["/pair/ABCDEFGH", `/pair/${spent}`, `/pair/${expired}`, `/pair/${expired}/apk`, "/pair/nonsense", "/pair"]) {
    const res = fakeRes();
    await handlePairPage(fakeReq(path), res, d);
    assert.equal(res.status, 404, path);
    assert.equal(res.body, invalidPage(), path);
    assert.doesNotMatch(res.body, /SECRETHOST|secrethost|192\.168/, path);
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(res.headers["content-security-policy"], /default-src 'none'/);
  }
  const live = store.mint(null).code;
  const res = fakeRes();
  await handlePairPage(fakeReq(`/pair/${live}`), res, d);
  assert.equal(res.status, 200);
  assert.match(res.body, /SECRETHOST/);
  assert.match(res.body, /No Android app is offered from this computer/);
  assert.equal(store.peek(live), "ok", "viewing does not spend");
});

test("the landing page: web link, APK link, code and deep link; http-only explains https", () => {
  const html = landingPage("ABCDEFGH", NET, { path: "/x.apk", size: 30 * 1048576, mtimeMs: Date.now() });
  assert.match(html, /href="https:\/\/secrethost\.tail1234\.ts\.net\/"/);
  assert.match(html, /href="\/pair\/ABCDEFGH\/apk"/);
  assert.match(html, new RegExp(formatPairCode("ABCDEFGH")));
  assert.match(html, /waterplane:\/\/pair\?u=https%3A%2F%2Fsecrethost/);
  assert.doesNotMatch(html, /<script/i);
  const plain = landingPage("ABCDEFGH", { name: "h<b>", base: "http://100.64.1.2:8770", httpsUrl: null }, null);
  assert.match(plain, /tailscale serve/);
  assert.match(plain, /h&lt;b&gt;/, "host name escaped");
});

test("latestApk: newest of WATERPLANE_APK_PATH (file or dir) and the default", () => {
  const d = root();
  const a = join(d, "a.apk"), b = join(d, "sub", "b.apk");
  mkdirSync(join(d, "sub"));
  writeFileSync(a, "AAAA");
  writeFileSync(b, "BBBBBB");
  utimesSync(a, 1000, 1000);
  utimesSync(b, 2000, 2000);
  assert.equal(latestApk(a, join(d, "missing.apk")).path, a);
  assert.equal(latestApk(join(d, "sub"), a).path, b, "a directory yields its newest .apk, and newer wins");
  assert.equal(latestApk(undefined, a).path, a);
  assert.equal(latestApk(undefined, join(d, "none.apk")), null);
});

test("apkSource: a local build wins; else the release; else none", () => {
  const local = { path: "/x.apk", size: 5, mtimeMs: 1 };
  assert.deepEqual(apkSource(local, "https://example.invalid/a.apk"), { kind: "local", apk: local });
  assert.deepEqual(apkSource(null, "https://example.invalid/a.apk"), { kind: "release", url: "https://example.invalid/a.apk" });
  assert.deepEqual(apkSource(null, null), { kind: "none" });
});

test("releaseApkUrl: only from what the release names, never a guessed asset", () => {
  assert.equal(releaseApkUrl({ version: "1.2.3" }, undefined), null, "a release that names no APK offers none");
  assert.equal(releaseApkUrl(null, undefined), null, "no release.json (a checkout) offers none");
  assert.equal(releaseApkUrl({ version: "1.2.3", apk: "slug-1.2.3.apk" }, undefined, "org", "slug"),
    "https://github.com/org/slug/releases/download/v1.2.3/slug-1.2.3.apk");
  assert.equal(releaseApkUrl({ version: "1.2.3", apk: "../evil.apk" }, undefined), null, "a path is not an asset name");
  assert.equal(releaseApkUrl({ version: "1.2.3", apk: "a.txt" }, undefined), null);
  assert.equal(releaseApkUrl({ version: "1.2.3", apk: "other-1.2.3.apk" }, undefined, "org", "slug"), null, "only the shared release name resolves");
  assert.equal(releaseApkUrl(null, "https://example.invalid/x.apk"), "https://example.invalid/x.apk");
  assert.equal(releaseApkUrl(null, "http://example.invalid/x.apk"), null, "https only");
});

test("the landing page: a release APK link when no local build; the web route in words when neither", () => {
  const rel = landingPage("ABCDEFGH", NET, null, "https://github.com/o/s/releases/download/v1/s-1.apk");
  assert.match(rel, /href="https:\/\/github\.com\/o\/s\/releases\/download\/v1\/s-1\.apk"/);
  assert.doesNotMatch(rel, /npm run apk/);
  const none = landingPage("ABCDEFGH", NET, null, null);
  assert.doesNotMatch(none, /\.apk"/, "no link that could 404");
  assert.match(none, /web version/);
  const local = landingPage("ABCDEFGH", NET, { path: "/x.apk", size: 1048576, mtimeMs: 1 }, "https://github.com/o/s/releases/download/v1/s-1.apk");
  assert.match(local, /href="\/pair\/ABCDEFGH\/apk"/);
  assert.doesNotMatch(local, /github\.com/, "the local build wins");
});

test("the landing page names the web route as a URL in words, not only as a button and an APK", () => {
  for (const apk of [{ path: "/x.apk", size: 1048576, mtimeMs: 1 }, null]) {
    const html = landingPage("ABCDEFGH", NET, apk, null);
    assert.match(html, /Or open <code>https:\/\/secrethost\.tail1234\.ts\.net\/<\/code> in this phone's browser/);
  }
  const rel = landingPage("ABCDEFGH", NET, null, "https://github.com/o/s/releases/download/v1/s-1.apk");
  assert.match(rel, /<code>https:\/\/secrethost\.tail1234\.ts\.net\/<\/code>/, "with a release APK too");
  const plain = landingPage("ABCDEFGH", { name: "h", base: "http://100.64.1.2:8770", httpsUrl: null }, null);
  assert.match(plain, /<code>http:\/\/100\.64\.1\.2:8770\/<\/code>/);
  assert.doesNotMatch(plain, /home screen to keep it/, "plain http cannot install");
});

test("L7: minting a pairing code is the trusted path's alone (loopback / Tailscale), never a LAN token", async () => {
  const auth = new AuthManager(root());
  auth.setPassword("pw-for-mint-test");
  const d = { ...deps(root(), auth, new PairStore()), port: 8770, apk: () => null };
  const post = () => ({ url: "/api/pair/mint", method: "POST", headers: {}, socket: { remoteAddress: "192.168.1.9" }, on() {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from("{}"); } });
  for (const kind of ["lan", "public", "unknown"]) {
    const res = fakeRes();
    assert.equal(await handlePairAuthed(post(), res, null, d, kind), true);
    assert.equal(res.status, 403, kind);
    assert.match(res.body, /Tailscale/, "refused in words");
  }
  for (const kind of ["loopback", "tailscale"]) {
    const res = fakeRes();
    await handlePairAuthed(post(), res, null, d, kind);
    assert.equal(res.status, 200, kind);
  }
});
