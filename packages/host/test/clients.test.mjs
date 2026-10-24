/**
 * `server/clients.ts`: a socket the host stops trusting is told, closed AND torn
 * down, and a frame that still arrives from it is refused — `ws.close()` alone
 * keeps dispatching the peer's frames until the close handshake completes
 * (30 s when the peer never answers it). Fakes stand in for `ws` and the four
 * managers; nothing here opens a port.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClients } from "../dist/server/clients.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeWs() {
  return {
    OPEN: 1, readyState: 1, sent: [], closed: 0, terminated: 0,
    send(s) { this.sent.push(JSON.parse(s)); },
    close() { this.closed++; },
    terminate() { this.terminated++; this.readyState = 3; },
  };
}

/** Two ledger rows: `kid` is passive (locked unless named in `unlocked`), `mine` is full. */
function fakeAuth(unlocked = new Set(), valid = new Set(["kid-tok", "mine-tok"])) {
  const rows = new Map([["kid", { id: "kid", scope: "passive" }], ["mine", { id: "mine" }]]);
  return {
    rows, valid,
    isEnabled: () => true,
    gateTailscale: () => true,
    canManage: (kind) => kind === "loopback" || kind === "tailscale",
    needsToken: (kind) => kind !== "loopback",
    checkToken: (tok) => valid.has(tok),
    devices: { get: (id) => rows.get(id) ?? null },
    passive: { restricted: (row) => row.scope === "passive" && !unlocked.has(row.id) },
  };
}

const GRACE_MS = 20;

function wired(auth) {
  const c = createClients({ auth, notifyPrefs: { enabled: () => true }, push: { notify: async () => {} }, sessions: { setWatched: () => {} }, closeGraceMs: GRACE_MS });
  const connect = (kind, tok, device) => {
    const ws = fakeWs();
    c.clients.add(ws);
    c.wsKind.set(ws, kind);
    if (tok) c.wsToken.set(ws, tok);
    if (device) c.wsDevice.set(ws, device);
    return ws;
  };
  return { c, connect };
}

test("socketAuthorized: the token must still be valid where one is needed, and the device must not be a locked passive row", () => {
  const unlocked = new Set(["kid"]);
  const auth = fakeAuth(unlocked);
  const { c, connect } = wired(auth);
  const loop = connect("loopback");
  const mine = connect("tailscale", "mine-tok", "mine");
  const kid = connect("tailscale", "kid-tok", "kid");
  assert.equal(c.socketAuthorized(loop), true, "loopback needs no token");
  assert.equal(c.socketAuthorized(mine), true);
  assert.equal(c.socketAuthorized(kid), true, "unlocked passive row");
  unlocked.delete("kid");
  assert.equal(c.socketAuthorized(kid), false, "relocked: its frames are refused");
  auth.rows.delete("mine"); auth.valid.delete("mine-tok");
  assert.equal(c.socketAuthorized(mine), false, "revoked where a token is needed: its frames are refused");
  assert.equal(c.socketAuthorized(loop), true, "a loopback socket is untouched by either");
});

test("socketAuthorized and enforceAuth tell one story: on a trusted kind a vanished row neither kicks the socket nor drops its frames", () => {
  // The owner's phone over ungated Tailscale presents its token anyway; a password change
  // clears every row. Kicking or muting that socket would freeze the phone for nothing —
  // the same phone could reconnect tokenless and be accepted.
  const auth = fakeAuth(new Set(), new Set(["mine-tok"]));
  auth.needsToken = () => false;
  const { c, connect } = wired(auth);
  const phone = connect("tailscale", "mine-tok", "mine");
  assert.equal(c.socketAuthorized(phone), true);
  auth.rows.clear(); auth.valid.clear();
  c.enforceAuth();
  assert.equal(phone.closed, 0, "enforceAuth leaves a trusted-kind socket alone");
  assert.equal(phone.sent.length, 0);
  assert.equal(c.socketAuthorized(phone), true, "and its frames keep flowing");
});

test("closeDevice and enforceAuth: authRequired, close(), then terminate() within the grace — the peer cannot hold the socket open by ignoring the close frame", async () => {
  const auth = fakeAuth(new Set(["kid"]));
  const { c, connect } = wired(auth);
  const mine = connect("tailscale", "mine-tok", "mine");
  const other = connect("tailscale", "mine-tok", "mine");
  const kid = connect("tailscale", "kid-tok", "kid");
  assert.equal(c.closeDevice("mine"), 2);
  for (const ws of [mine, other]) {
    assert.equal(ws.sent.at(-1)?.t, "authRequired");
    assert.equal(ws.closed, 1);
    assert.equal(ws.terminated, 0, "the close frame goes first");
  }
  assert.equal(kid.closed, 0, "another device's socket is untouched");
  await sleep(GRACE_MS * 4);
  assert.equal(mine.terminated, 1);
  assert.equal(other.terminated, 1);
  // A password change invalidates the kid's token: enforceAuth drops that socket the same way.
  auth.valid.delete("kid-tok");
  c.enforceAuth();
  assert.equal(kid.sent.at(-1)?.t, "authRequired");
  assert.equal(kid.closed, 1);
  await sleep(GRACE_MS * 4);
  assert.equal(kid.terminated, 1);
});
