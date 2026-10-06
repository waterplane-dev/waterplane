/**
 * The peer ledger and its routes: `peers.json` is 0600, an inbound token is
 * kept only as its sha256, an unlisted or device token is "not paired", the
 * management routes refuse a LAN caller, and the version header is a 409 in the
 * peer's own words. Pure over a temp dir and fake req/res — no daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPeerStore, hashPeerToken } from "../dist/peers/store.js";
import { handlePeerRoutes } from "../dist/peers/routes.js";
import { PEER_API_HEADER, PEER_API_VERSION, peerVersionRefusalText } from "@waterplane/shared";

const dir = () => mkdtempSync(join(tmpdir(), "waterplane-peers-"));
const TOK_IN = "inbound-token-0123456789abcdef";
const TOK_OUT = "outbound-token-0123456789abcdef";

test("store: file is 0600, inbound keeps only the hash, outbound keeps the clear token", () => {
  const d = dir();
  const s = createPeerStore(d);
  const r = s.upsert({ name: "pc", addr: "100.64.1.2:8770", inboundToken: TOK_IN, outboundToken: TOK_OUT });
  assert.equal(r.ok, true);
  assert.equal(statSync(s.file).mode & 0o777, 0o600);
  const raw = readFileSync(s.file, "utf8");
  assert.ok(!raw.includes(TOK_IN), "inbound token never on disk in clear");
  assert.ok(raw.includes(hashPeerToken(TOK_IN)));
  assert.ok(raw.includes(TOK_OUT));
  assert.deepEqual(s.list().map((p) => [p.name, p.inbound, p.outbound]), [["pc", true, true]]);
  assert.ok(!JSON.stringify(s.list()).includes(TOK_OUT), "the phone's list carries no token");
  assert.deepEqual(s.outbound("pc"), { name: "pc", addr: "100.64.1.2:8770", token: TOK_OUT });
  // survives a reload
  assert.equal(createPeerStore(d).authenticate(TOK_IN)?.name, "pc");
});

test("store: unlisted token refused, delete invalidates, a merge keeps the other direction", () => {
  const s = createPeerStore(dir());
  s.upsert({ name: "pc", addr: "127.0.0.1:9000", inboundToken: TOK_IN });
  assert.equal(s.authenticate(TOK_IN)?.name, "pc");
  assert.equal(s.authenticate("some-other-token-0123456789"), null);
  assert.equal(s.authenticate(""), null);
  assert.equal(s.authenticate(undefined), null);
  assert.equal(s.outbound("pc"), null, "no clear token held ⇒ cannot call");
  const r = s.upsert({ name: "pc", addr: "127.0.0.1:9000", outboundToken: TOK_OUT });
  assert.equal(r.ok && r.replaced, true);
  assert.equal(s.authenticate(TOK_IN)?.name, "pc", "inbound survived the merge");
  assert.equal(s.remove("pc"), true);
  assert.equal(s.authenticate(TOK_IN), null);
  assert.equal(s.outbound("pc"), null);
  assert.equal(s.remove("pc"), false);
});

test("store: refusals are sentences (name, address, token, empty)", () => {
  const s = createPeerStore(dir());
  const bad = (i) => { const r = s.upsert(i); assert.equal(r.ok, false); return r.error; };
  assert.match(bad({ name: "../x", addr: "127.0.0.1:1", inboundToken: TOK_IN }), /name/);
  assert.match(bad({ name: "pc", addr: "192.168.1.5:8770", inboundToken: TOK_IN }), /Tailscale/);
  assert.match(bad({ name: "pc", addr: "pc.local:8770", inboundToken: TOK_IN }), /Tailscale/);
  assert.match(bad({ name: "pc", addr: "127.0.0.1:1", inboundToken: "short" }), /token/);
  assert.match(bad({ name: "pc", addr: "127.0.0.1:1" }), /token/);
  assert.equal(s.list().length, 0);
});

// ── routes ───────────────────────────────────────────────────────────────────

function harness(remote = "127.0.0.1") {
  const store = createPeerStore(dir());
  const sent = [];
  const warned = [];
  const res = { writeHead(c) { sent.push({ status: c, body: null }); return { end() {} }; } };
  const deps = (extra = {}) => ({
    store,
    canManage: (k) => k === "loopback" || k === "tailscale",
    json: (_r, data, status = 200) => sent.push({ status, body: data }),
    readJson: async (r) => r.body ?? {},
    version: "9.9.9",
    warn: (m) => warned.push(m),
    ...extra,
  });
  const call = async (method, path, { headers = {}, body, extra, from = remote } = {}) => {
    sent.length = 0;
    const req = { method, headers, body, socket: { remoteAddress: from } };
    const handled = await handlePeerRoutes(req, res, path, new URL(path, "http://x"), deps(extra));
    return { handled, ...(sent.at(-1) ?? {}) };
  };
  return { store, call, warned };
}

test("routes: /api/peers manages the ledger on the trusted path, never LAN", async () => {
  const h = harness();
  let r = await h.call("POST", "/api/peers", { body: { name: "pc", addr: "100.100.1.1:8770", inboundToken: TOK_IN, outboundToken: TOK_OUT } });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes(TOK_OUT));
  r = await h.call("GET", "/api/peers");
  assert.deepEqual(r.body.peers.map((p) => p.name), ["pc"]);
  r = await h.call("POST", "/api/peers", { body: { name: "x", addr: "10.0.0.1:1", inboundToken: TOK_IN } });
  assert.equal(r.status, 400);
  for (const from of ["192.168.1.9", "8.8.8.8"]) {
    for (const [m, p] of [["GET", "/api/peers"], ["POST", "/api/peers"], ["DELETE", "/api/peers/pc"]]) {
      r = await h.call(m, p, { from, body: { name: "evil", addr: "127.0.0.1:1", inboundToken: TOK_IN } });
      assert.equal(r.status, 403, `${m} ${p} from ${from}`);
    }
  }
  assert.deepEqual(h.store.list().map((p) => p.name), ["pc"], "nothing changed from LAN");
  r = await h.call("DELETE", "/api/peers/pc");
  assert.equal(r.status, 200);
  r = await h.call("DELETE", "/api/peers/pc");
  assert.equal(r.status, 404);
});

test("routes: hello needs a peer token and the version header", async () => {
  const h = harness();
  h.store.upsert({ name: "pc", addr: "127.0.0.1:9", inboundToken: TOK_IN });
  const ok = { authorization: `Bearer ${TOK_IN}`, [PEER_API_HEADER]: String(PEER_API_VERSION) };
  let r = await h.call("GET", "/api/peer/hello", { headers: ok });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { peerApi: PEER_API_VERSION, version: "9.9.9", you: "pc" });

  // no token, an unlisted one, a device-token-shaped one: all "not paired"
  for (const headers of [{ [PEER_API_HEADER]: "1" }, { ...ok, authorization: "Bearer unknown-token-0123456789" }, { ...ok, cookie: `x_auth=${TOK_IN}`, authorization: undefined }]) {
    r = await h.call("GET", "/api/peer/hello", { headers });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ok: false, error: "not paired" });
  }
  assert.ok(h.warned.length >= 3 && h.warned[0].includes("127.0.0.1"));

  // version: wrong and absent are 409 in the peer's words
  r = await h.call("GET", "/api/peer/hello", { headers: { ...ok, [PEER_API_HEADER]: String(PEER_API_VERSION + 1) } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, peerVersionRefusalText(PEER_API_VERSION, PEER_API_VERSION + 1));
  r = await h.call("GET", "/api/peer/hello", { headers: { authorization: ok.authorization } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, peerVersionRefusalText(PEER_API_VERSION, null));

  // a good token from LAN still never gets in
  r = await h.call("GET", "/api/peer/hello", { headers: ok, from: "192.168.1.9" });
  assert.equal(r.status, 403);
});

test("routes: other /api/peer paths go to serve only after auth, else 404; other paths are not ours", async () => {
  const h = harness();
  h.store.upsert({ name: "pc", addr: "127.0.0.1:9", inboundToken: TOK_IN });
  const ok = { authorization: `Bearer ${TOK_IN}`, [PEER_API_HEADER]: String(PEER_API_VERSION) };
  let seen = null;
  const serve = async (_q, res, path, _u, peer) => { seen = [path, peer.name]; return path === "/api/peer/jobs"; };
  let r = await h.call("POST", "/api/peer/jobs", { headers: ok, extra: { serve } });
  assert.deepEqual(seen, ["/api/peer/jobs", "pc"]);
  assert.equal(r.handled, true);
  r = await h.call("POST", "/api/peer/jobs", { headers: { [PEER_API_HEADER]: "1" }, extra: { serve: async () => assert.fail("must not run unauthenticated") } });
  assert.equal(r.status, 403);
  r = await h.call("GET", "/api/peer/nope", { headers: ok, extra: { serve } });
  assert.equal(r.status, 404);
  r = await h.call("GET", "/api/peer/jobs", { headers: ok });
  assert.equal(r.status, 404, "no serve handler yet ⇒ 404");
  r = await h.call("GET", "/api/health");
  assert.equal(r.handled, false);
});

test("routes: GET /api/peers says this daemon's own tailnet address, or null — never a guess", async () => {
  const h = harness();
  let r = await h.call("GET", "/api/peers", { extra: { selfAddr: "100.64.0.2:8770" } });
  assert.deepEqual(r.body.self, { addr: "100.64.0.2:8770" });
  r = await h.call("GET", "/api/peers", { extra: { selfAddr: null } });
  assert.deepEqual(r.body.self, { addr: null });
  r = await h.call("GET", "/api/peers");
  assert.deepEqual(r.body.self, { addr: null }, "nothing registered is not bound on a tailnet IP");
});

test("routes: hello says whether claude is signed in here, and nothing when that is unreadable", async () => {
  const h = harness();
  h.store.upsert({ name: "pc", addr: "127.0.0.1:9", inboundToken: TOK_IN });
  const ok = { authorization: `Bearer ${TOK_IN}`, [PEER_API_HEADER]: String(PEER_API_VERSION) };
  let r = await h.call("GET", "/api/peer/hello", { headers: ok, extra: { signedIn: async () => "out" } });
  assert.equal(r.body.claudeSignedIn, false);
  r = await h.call("GET", "/api/peer/hello", { headers: ok, extra: { signedIn: async () => "in" } });
  assert.equal(r.body.claudeSignedIn, true);
  r = await h.call("GET", "/api/peer/hello", { headers: ok, extra: { signedIn: async () => null } });
  assert.equal("claudeSignedIn" in r.body, false);
});

test("routes: /api/peers/<name>/status asks the peer now, on the trusted path only", async () => {
  const h = harness();
  h.store.upsert({ name: "pc", addr: "100.100.1.1:8770", inboundToken: TOK_IN, outboundToken: TOK_OUT });
  const asked = [];
  const askPeer = async (t) => { asked.push(t); return { kind: "ok", body: { peerApi: 1, version: "1.2.3", claudeSignedIn: false } }; };
  let r = await h.call("GET", "/api/peers/pc/status", { extra: { askPeer } });
  assert.deepEqual(r.body, { ok: true, version: "1.2.3", claudeSignedIn: false });
  assert.equal(asked[0].token, TOK_OUT);
  assert.ok(!JSON.stringify(r.body).includes(TOK_OUT));
  r = await h.call("GET", "/api/peers/pc/status", { extra: { askPeer: async () => ({ kind: "unreachable", error: "timeout" }) } });
  assert.deepEqual(r.body, { ok: false, error: "pc did not answer: timeout" });
  r = await h.call("GET", "/api/peers/nope/status", { extra: { askPeer } });
  assert.deepEqual(r.body, { ok: false, error: "no such peer" });
  r = await h.call("GET", "/api/peers/pc/status", { extra: { askPeer }, from: "192.168.1.9" });
  assert.equal(r.status, 403);
});
