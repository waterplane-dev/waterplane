/**
 * Device tokens: where a request may carry one (`tokenFromRequest`), how the
 * ledger keeps them (hashed at rest, 0600, constant-time lookup), what revoke
 * and a password change do to them, how often `lastSeenAt` is written, the LAN
 * identity's MAC and the pre-auth rate limiter.
 *
 * `e2e-lan.mjs` drives the same through a live server; these are the rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthManager, tokenFromRequest, selectWsProtocol, WS_TOKEN_PROTOCOL_PREFIX } from "../dist/auth.js";
import { DeviceLedger, hashToken } from "../dist/deviceledger.js";
import { lanIdentity, lanIdentityPresent, lanMac, validNonce, forgetLanIdentity } from "../dist/lanid.js";
import { RateLimiter } from "../dist/ratelimit.js";
import { checkLan } from "../dist/doctor.js";
import { DEVICE_SEEN_THROTTLE_MS } from "@waterplane/shared";

const root = () => mkdtempSync(join(tmpdir(), "waterplane-dev-"));

// ── tokenFromRequest ─────────────────────────────────────────────────────────

test("tokenFromRequest: cookie first, then Bearer, then the ws subprotocol", () => {
  assert.equal(tokenFromRequest({ cookie: "a=1; usmc_auth=CK; b=2", authorization: "Bearer BR" }), "CK");
  assert.equal(tokenFromRequest({ authorization: "Bearer BR", "sec-websocket-protocol": "usmc, usmc-tok.WS" }), "BR");
  assert.equal(tokenFromRequest({ "sec-websocket-protocol": "usmc, usmc-tok.WS_-9" }), "WS_-9");
  assert.equal(tokenFromRequest({ "sec-websocket-protocol": ["usmc", "usmc-tok.ARR"] }), "ARR");
});

test("tokenFromRequest: absent, malformed and empty carriers are null", () => {
  assert.equal(tokenFromRequest({}), null);
  assert.equal(tokenFromRequest({ authorization: "Basic dXNlcjpwdw==" }), null);
  assert.equal(tokenFromRequest({ authorization: "Bearer" }), null);
  assert.equal(tokenFromRequest({ authorization: "Bearer a b" }), null);
  assert.equal(tokenFromRequest({ authorization: `Bearer ${"x".repeat(300)}` }), null, "no unbounded token");
  assert.equal(tokenFromRequest({ "sec-websocket-protocol": "usmc-tok." }), null);
  assert.equal(tokenFromRequest({ "sec-websocket-protocol": "usmc" }), null);
  assert.equal(tokenFromRequest({ cookie: "other=1" }), null);
  assert.equal(tokenFromRequest({ authorization: "bearer lower" }), "lower", "scheme is case-insensitive");
});

test("selectWsProtocol echoes the base protocol, never the token", () => {
  assert.equal(selectWsProtocol(new Set(["usmc", `${WS_TOKEN_PROTOCOL_PREFIX}SECRET`])), "usmc");
  assert.equal(selectWsProtocol(new Set([`${WS_TOKEN_PROTOCOL_PREFIX}SECRET`, "usmc"])), "usmc");
  assert.equal(selectWsProtocol(new Set([`${WS_TOKEN_PROTOCOL_PREFIX}SECRET`])), false);
  assert.equal(selectWsProtocol(new Set()), false);
});

// ── the ledger ───────────────────────────────────────────────────────────────

test("ledger: the token is on disk only as its sha256, file mode 0600", () => {
  const r = root();
  const l = new DeviceLedger(r);
  const { token, row } = l.mint("Pixel 8", "tailscale");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  const text = readFileSync(l.file, "utf8");
  assert.ok(!text.includes(token), "raw token never written");
  assert.ok(text.includes(hashToken(token)));
  assert.equal(statSync(l.file).mode & 0o777, 0o600);
  assert.equal(row.name, "Pixel 8");
  assert.equal(row.lastKind, "tailscale");
  assert.equal(row.tokenHash, undefined, "a public row never carries the hash");
});

test("ledger: lookup survives a reload; a wrong token finds nothing", () => {
  const r = root();
  const { token, row } = new DeviceLedger(r).mint("phone", "lan");
  const again = new DeviceLedger(r);
  assert.equal(again.lookup(token)?.id, row.id);
  assert.equal(again.lookup(token + "x"), null);
  assert.equal(again.lookup(""), null);
  assert.equal(again.lookup(null), null);
});

test("ledger: revoke kills exactly that token; list marks current, hides hashes", () => {
  const l = new DeviceLedger(root());
  const a = l.mint("a", "lan");
  const b = l.mint("b", "tailscale");
  const list = l.list(b.row.id);
  assert.equal(list[0].id, b.row.id, "current first");
  assert.equal(list[0].current, true);
  assert.ok(list.every((d) => !("tokenHash" in d)));
  assert.equal(l.revoke(a.row.id), true);
  assert.equal(l.revoke(a.row.id), false, "second revoke says it was already gone");
  assert.equal(l.lookup(a.token), null);
  assert.equal(l.lookup(b.token)?.id, b.row.id);
});

test("ledger: a corrupt or hand-edited file loads only well-formed rows", () => {
  const r = root();
  mkdirSync(join(r, ".waterplane"), { recursive: true });
  writeFileSync(join(r, ".waterplane", "devices.json"), JSON.stringify({ devices: [
    { id: "good_id1", name: "ok", createdAt: 1, lastSeenAt: 2, lastKind: "lan", tokenHash: "a".repeat(64) },
    { id: "nohash1", name: "x", createdAt: 1 },
    { id: "badhash", name: "x", createdAt: 1, tokenHash: "zz" },
    { id: "!", name: "x", createdAt: 1, tokenHash: "b".repeat(64) },
  ] }));
  assert.deepEqual(new DeviceLedger(r).list().map((d) => d.id), ["good_id1"]);
  writeFileSync(join(r, ".waterplane", "devices.json"), "{not json");
  assert.equal(new DeviceLedger(r).size, 0);
});

test("ledger: lastSeenAt is written at most once per throttle window", () => {
  const l = new DeviceLedger(root());
  const { row } = l.mint("p", "tailscale", 1_000_000);
  assert.equal(l.touch(row.id, "lan", 1_000_000 + DEVICE_SEEN_THROTTLE_MS - 1), false);
  assert.equal(l.list()[0].lastKind, "tailscale", "nothing changed inside the window");
  assert.equal(l.touch(row.id, "lan", 1_000_000 + DEVICE_SEEN_THROTTLE_MS), true);
  const seen = l.list()[0];
  assert.equal(seen.lastSeenAt, 1_000_000 + DEVICE_SEEN_THROTTLE_MS);
  assert.equal(seen.lastKind, "lan");
  assert.equal(new DeviceLedger(l.file.replace(/\/\.waterplane\/devices\.json$/, "")).list()[0].lastKind, "lan", "persisted");
});

// ── AuthManager over the ledger ──────────────────────────────────────────────

test("auth: no token is minted or valid while no password is set (deny-until-set)", () => {
  const a = new AuthManager(root());
  assert.throws(() => a.issueToken("x", "loopback"), /no password/);
  a.setPassword("correct horse");
  const { token } = a.issueToken("x", "loopback");
  assert.equal(a.checkToken(token), true);
  a.clearPassword();
  assert.equal(a.checkToken(token), false);
  assert.equal(a.devices.size, 0);
});

test("auth: a password change rotates every device; tokens survive a restart", () => {
  const r = root();
  const a = new AuthManager(r);
  a.setPassword("first password");
  const t1 = a.issueToken("one", "lan").token;
  const t2 = a.issueToken("two", "tailscale").token;
  const restarted = new AuthManager(r);
  assert.equal(restarted.checkToken(t1), true, "survives restart");
  restarted.setPassword("second password");
  assert.equal(restarted.checkToken(t1), false);
  assert.equal(restarted.checkToken(t2), false);
  assert.equal(restarted.devices.size, 0, "rows are dropped, not left tokenless");
});

test("auth: logout revokes that token's device only", () => {
  const a = new AuthManager(root());
  a.setPassword("some password");
  const x = a.issueToken("x", "lan");
  const y = a.issueToken("y", "lan");
  a.revoke(x.token);
  assert.equal(a.checkToken(x.token), false);
  assert.equal(a.deviceFor(y.token)?.id, y.deviceId);
});

// ── LAN identity ─────────────────────────────────────────────────────────────

test("lanid: created lazily at 0600, stable across reads", () => {
  const r = root();
  assert.equal(lanIdentityPresent(r), false);
  const id = lanIdentity(r);
  assert.match(id.hostId, /^[a-z0-9]{4,16}$/);
  const file = join(r, ".waterplane", "lan-identity.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  forgetLanIdentity(r);
  assert.deepEqual(lanIdentity(r), id, "re-read from disk, not re-minted");
  assert.equal(lanIdentityPresent(r), true);
});

test("lanid: the MAC is HMAC-SHA256(secret utf8, hostId + newline + nonce), hex", () => {
  const want = createHmac("sha256", Buffer.from("s3cret", "utf8")).update("host1\nabcdefabcdefabcdef").digest("hex");
  assert.equal(lanMac("s3cret", "host1", "abcdefabcdefabcdef"), want);
  assert.notEqual(lanMac("s3cret", "host1", "abcdefabcdefabcdeX"), want);
  assert.notEqual(lanMac("other", "host1", "abcdefabcdefabcdef"), want);
});

test("lanid: nonce bounds", () => {
  assert.equal(validNonce("x".repeat(15)), false);
  assert.equal(validNonce("x".repeat(16)), true);
  assert.equal(validNonce("x".repeat(128)), true);
  assert.equal(validNonce("x".repeat(129)), false);
  assert.equal(validNonce("with space here!!"), false);
  assert.equal(validNonce(12345678901234567), false);
});

// ── rate limit ───────────────────────────────────────────────────────────────

test("ratelimit: a burst, then the refill rate, per key", () => {
  const rl = new RateLimiter({ burst: 3, perSec: 1 });
  const t = 1_000_000;
  assert.deepEqual([1, 2, 3, 4].map(() => rl.take("a", t)), [true, true, true, false]);
  assert.equal(rl.take("b", t), true, "keys are independent");
  assert.ok(rl.retryAfterMs("a", t) > 0);
  assert.equal(rl.take("a", t + 999), false);
  assert.equal(rl.take("a", t + 1000), true);
});

test("ratelimit: the key map stays bounded", () => {
  const rl = new RateLimiter({ burst: 2, perSec: 1, maxKeys: 10 });
  for (let i = 0; i < 100; i++) rl.take(`10.0.0.${i}`, 5000);
  assert.ok(rl.size <= 10, `size ${rl.size}`);
});

// ── doctor ───────────────────────────────────────────────────────────────────

test("doctor lan: quiet unbound, warn without a password, ok with one", () => {
  const r = root();
  assert.equal(checkLan({ root: r, port: 8770, allowPublic: false }, ["192.168.1.5"]), null);
  assert.equal(checkLan({ root: r, port: 8770, allowPublic: true }, []), null);
  assert.equal(checkLan({ root: r, port: 8770, allowPublic: true }, ["192.168.1.5"]).status, "warn");
  new AuthManager(r).setPassword("a long password");
  const ok = checkLan({ root: r, port: 8770, allowPublic: true }, ["192.168.1.5"]);
  assert.equal(ok.status, "ok");
  assert.match(ok.detail, /LAN ready at http:\/\/192\.168\.1\.5:8770 \(password set/);
});
