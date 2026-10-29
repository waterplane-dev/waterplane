/**
 * Passive devices (R-connection-011…014): the default-deny allowlist, the
 * scope a pairing stores, the Tailscale gate a passive row holds on, and the
 * PIN unlock — hashed at rest, rate-limited, per device, and back to passive
 * when the time runs out. `scripts/e2e-passive.mjs` drives the same through a
 * live server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthManager } from "../dist/auth.js";
import { PairStore, redeemPair } from "../dist/pair.js";
import { PassiveGate, passiveAllows, passiveItems, passiveNeverAllows, queuedApkIn } from "../dist/passive.js";
import { requestPeerKind } from "../dist/net.js";

const root = () => mkdtempSync(join(tmpdir(), "waterplane-passive-"));
const item = (over = {}) => ({ id: "i1", repoId: "r1", repoDir: "/x", repoName: "x", name: "app.apk", relPath: ".claude/outbox/app.apk", size: 1, mtime: 1, ts: 1, source: "outbox", ...over });
const q = (s = "") => new URLSearchParams(s);
const none = () => false;

// ── the allowlist ────────────────────────────────────────────────────────────

test("passiveAllows: the named reads pass, as GET/HEAD only", () => {
  for (const p of ["/api/health", "/api/webbundle", "/api/webbundle/file", "/api/passive/state", "/api/theme"]) {
    assert.equal(passiveAllows("GET", p, q(), none), true, p);
    assert.equal(passiveAllows("HEAD", p, q(), none), true, p);
    assert.equal(passiveAllows("POST", p, q(), none), false, `POST ${p}`);
  }
});

test("passiveAllows: default deny — every other route is refused", () => {
  for (const [m, p] of [
    ["GET", "/api/repos"], ["GET", "/api/devices"], ["POST", "/api/devices/revoke"], ["POST", "/api/pair/mint"],
    ["GET", "/api/transcript"], ["POST", "/api/shell/open"], ["GET", "/api/lan/identity"], ["GET", "/api/peer/job"],
    ["GET", "/api/apps/readiness"], ["GET", "/api/repos/r1/artifacts/x"], ["GET", "/api/health/extra"], ["GET", "/api/something-new"],
  ]) assert.equal(passiveAllows(m, p, q(), () => true), false, `${m} ${p}`);
});

test("passiveNeverAllows: auth material is refused to a passive row even while unlocked; the rest of full scope is not its business", () => {
  for (const [m, p] of [
    ["POST", "/api/pair/mint"], ["POST", "/api/devices/revoke"], ["POST", "/api/peers"], ["DELETE", "/api/peers/pc"], ["PUT", "/api/peers/pc"],
    ["GET", "/api/lan/identity"], ["HEAD", "/api/lan/identity"],
  ]) assert.equal(passiveNeverAllows(m, p), true, `${m} ${p}`);
  for (const [m, p] of [
    ["GET", "/api/peers"], ["GET", "/api/peers/pc/status"], ["GET", "/api/peerjobs"], ["GET", "/api/devices"], ["GET", "/api/pair/mint"],
    ["POST", "/api/auth/lock"], ["POST", "/api/auth/unlock"], ["GET", "/api/repos"], ["POST", "/api/repos/r1/sweep"], ["GET", "/api/lan/verify"],
  ]) assert.equal(passiveNeverAllows(m, p), false, `${m} ${p}`);
});

test("passiveAllows: an artifact only when it is an APK in the auto-pull queue now", () => {
  const items = [item(), item({ id: "i2", name: "shot.png", relPath: ".claude/outbox/shot.png" })];
  const has = queuedApkIn(items);
  assert.equal(passiveAllows("GET", "/api/repos/r1/artifact", q("path=.claude/outbox/app.apk&download=1"), has), true);
  assert.equal(passiveAllows("GET", "/api/repos/r1/artifact", q("path=.claude/outbox/app.apk&stat=1"), has), true);
  assert.equal(passiveAllows("DELETE", "/api/repos/r1/artifact", q("path=.claude/outbox/app.apk"), has), false, "never a delete");
  assert.equal(passiveAllows("GET", "/api/repos/r1/artifact", q("path=.claude/outbox/shot.png"), has), false, "queued, but not an APK");
  assert.equal(passiveAllows("GET", "/api/repos/r1/artifact", q("path=src/secret.ts"), has), false, "any other file of the repo");
  assert.equal(passiveAllows("GET", "/api/repos/r2/artifact", q("path=.claude/outbox/app.apk"), has), false, "same path, other repo");
  assert.equal(passiveAllows("GET", "/api/repos/r1/artifact", q(), has), false, "no path");
  assert.equal(passiveAllows("GET", "/api/repos/%E0%A4/artifact", q("path=x.apk"), () => true), false, "a bad escape is refused");
  assert.deepEqual(passiveItems(items).map((i) => i.id), ["i1"]);
});

// ── through `tailscale serve`: a proxied loopback request is a tailnet one ──

test("requestPeerKind: a proxied loopback request is tailscale, so the gate applies to it", () => {
  assert.equal(requestPeerKind("127.0.0.1", {}), "loopback");
  assert.equal(requestPeerKind("::ffff:127.0.0.1", { "x-forwarded-for": "100.1.2.3" }), "tailscale");
  assert.equal(requestPeerKind("127.0.0.1", { "tailscale-user-login": "x@y" }), "tailscale");
  assert.equal(requestPeerKind("192.168.1.5", { "x-forwarded-for": "127.0.0.1" }), "lan", "never an upgrade");
  // L2: funnel traffic is the public internet through the same proxy.
  assert.equal(requestPeerKind("127.0.0.1", { "tailscale-funnel-request": "?1", "x-forwarded-for": "1.2.3.4" }), "public");
  assert.equal(requestPeerKind("127.0.0.1", { "tailscale-funnel-request": "?1" }), "public");
  assert.equal(requestPeerKind("100.80.1.2", {}), "tailscale");
});

// ── scope on the ledger, and the Tailscale gate ──────────────────────────────

test("a passive pairing stores scope, switches the Tailscale gate on and holds it", async () => {
  const r = root();
  const auth = new AuthManager(r);
  auth.setPassword("correct horse");
  assert.equal(auth.gateTailscale(), false);
  const full = auth.issueToken("owner", "tailscale");
  assert.equal(auth.deviceFor(full.token).scope, undefined, "existing/full tokens carry no scope");

  const store = new PairStore();
  const { code } = store.mint(null, true);
  let gateChanges = 0;
  const deps = { root: r, auth, store, net: async () => ({ name: "desk", base: "http://h:1", httpsUrl: null }), onGateChange: () => { gateChanges++; } };
  const out = await redeemPair({ code, deviceName: "kids" }, "lan", deps);
  assert.equal(out.status, 200);
  assert.equal(out.body.scope, "passive");
  assert.equal(auth.deviceFor(out.body.token).scope, "passive");
  assert.equal(auth.restricted(out.body.token), true);
  assert.equal(auth.restricted(full.token), false);
  assert.equal(auth.gateTailscale(), true, "pairing a passive device switches the gate on");
  assert.equal(gateChanges, 1, "…and the open sockets are re-checked right then (`onGateChange`)");
  assert.equal(auth.needsToken("tailscale"), true);
  assert.throws(() => auth.setGateTailscale(false), /passive device/);
  // A second redeem — the gate is already on — re-checks nothing.
  const again2 = store.mint(null, true);
  assert.equal((await redeemPair({ code: again2.code, deviceName: "kids2" }, "lan", deps)).status, 200);
  assert.equal(gateChanges, 1);

  // Survives a restart: scope is on disk, the gate with it.
  const again = new AuthManager(r);
  assert.equal(again.deviceFor(out.body.token).scope, "passive");
  assert.equal(again.needsToken("tailscale"), true);
  assert.ok(again.devices.list().some((d) => d.scope === "passive"));
});

test("a passive code with no password set is refused and stays unspent", async () => {
  const r = root();
  const auth = new AuthManager(r);
  const store = new PairStore();
  const { code } = store.mint(null, true);
  const deps = { root: r, auth, store, net: async () => ({ name: "desk", base: "http://h:1", httpsUrl: null }) };
  const out = await redeemPair({ code }, "tailscale", deps);
  assert.equal(out.status, 403);
  assert.equal(store.peek(code), "ok");
});

// ── the PIN and the unlock ───────────────────────────────────────────────────

test("PIN: hashed at rest (0600), digits only, and a corrupt file means no PIN", () => {
  const r = root();
  const g = new PassiveGate(r);
  assert.equal(g.pinSet(), false);
  assert.throws(() => g.setPin("12"), /digits/);
  assert.throws(() => g.setPin("abcd"), /digits/);
  g.setPin("4711");
  const raw = readFileSync(g.file, "utf8");
  assert.ok(!raw.includes("4711"), "never the PIN itself");
  assert.equal(statSync(g.file).mode & 0o777, 0o600);
  assert.equal(new PassiveGate(r).pinSet(), true);
  g.setPin(null);
  assert.equal(new PassiveGate(r).pinSet(), false);
});

test("unlock: right PIN lifts THAT device until the clock says, then it is passive again", () => {
  let now = 1_000_000;
  const relocked = [];
  const g = new PassiveGate(root(), { now: () => now, unlockMs: 30 * 60_000, onRelock: (id) => relocked.push(id) });
  const kid = { id: "kid-0001", name: "kids", createdAt: 1, lastSeenAt: 1, lastKind: "lan", scope: "passive" };
  const other = { ...kid, id: "kid-0002" };
  const owner = { ...kid, id: "own-0001", scope: undefined };
  assert.equal(g.unlock(kid, "4711").error, "no-pin");
  g.setPin("4711");
  assert.equal(g.unlock(owner, "4711").error, "not-passive");
  assert.equal(g.unlock(null, "4711").error, "not-passive");
  assert.equal(g.unlock(kid, "0000").error, "wrong-pin");
  assert.equal(g.restricted(kid), true);
  const ok = g.unlock(kid, "4711");
  assert.equal(ok.ok, true);
  assert.equal(ok.unlockedUntil, now + 30 * 60_000);
  assert.equal(g.restricted(kid), false);
  assert.equal(g.restricted(other), true, "one device's unlock is not another's");
  assert.equal(g.restricted(owner), false, "a full token is never restricted");
  now += 30 * 60_000 - 1;
  assert.equal(g.restricted(kid), false);
  now += 1;
  assert.equal(g.restricted(kid), true, "expired ⇒ passive again");
  assert.equal(g.unlockedUntil(kid.id), null);
  assert.deepEqual(relocked, [kid.id], "expiry closes its sockets");
});

test("unlock: Lock now, a PIN change and a restart all end an unlock", () => {
  const r = root();
  const g = new PassiveGate(r);
  const kid = { id: "kid-0001", name: "kids", createdAt: 1, lastSeenAt: 1, lastKind: "lan", scope: "passive" };
  g.setPin("4711");
  assert.equal(g.unlock(kid, "4711").ok, true);
  assert.equal(g.lock(kid.id), true);
  assert.equal(g.restricted(kid), true);
  assert.equal(g.unlock(kid, "4711").ok, true);
  g.setPin("1234");
  assert.equal(g.restricted(kid), true, "a new PIN locks every unlocked device");
  assert.equal(g.unlock(kid, "1234").ok, true);
  assert.equal(new PassiveGate(r).restricted(kid), true, "held in memory: a restart comes back locked");
  g.lock(kid.id);
});

test("unlock: rate-limited per device — five tries, then one a minute", () => {
  let now = 5_000_000;
  const g = new PassiveGate(root(), { now: () => now });
  g.setPin("4711");
  const kid = { id: "kid-0001", name: "kids", createdAt: 1, lastSeenAt: 1, lastKind: "lan", scope: "passive" };
  for (let i = 0; i < 5; i++) assert.equal(g.unlock(kid, "0000").error, "wrong-pin");
  const r = g.unlock(kid, "4711");
  assert.equal(r.error, "rate-limited", "even the right PIN waits");
  assert.ok(r.retryAfterMs >= 1000);
  assert.equal(g.unlock({ ...kid, id: "kid-0002" }, "4711").ok, true, "another device has its own bucket");
  now += 61_000;
  assert.equal(g.unlock(kid, "4711").ok, true);
  g.lock(kid.id); g.lock("kid-0002");
});

test("passiveAllows: a passive token never reaches compliance, the triage mark, the watch re-run or the agent exposure routes", () => {
  for (const p of ["/api/repos/r1/compliance", "/api/repos/r1/compliance/triage", "/api/repos/r1/compliance/accept", "/api/repos/r1/exposure/run", "/api/agent/exposure", "/api/agent/exposure/triage"]) {
    for (const m of ["GET", "POST"]) assert.equal(passiveAllows(m, p, q(), none), false, `${m} ${p}`);
  }
});
