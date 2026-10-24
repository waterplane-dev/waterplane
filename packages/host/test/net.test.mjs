// Trust tier of a request: loopback socket + proxy headers / Host header (net.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
const N = await import("../dist/net.js");

test("loopback socket naming another host is not a local process", () => {
  const h = { host: "mac.tn.ts.net" };
  assert.notEqual(N.localProcessRefusal("127.0.0.1", h), null);
  assert.equal(N.requestPeerKind("127.0.0.1", h), "tailscale");
});

test("loopback socket with a local Host stays local", () => {
  for (const host of ["localhost:8770", "127.0.0.1:8770", "[::1]:8770", "::1", "0.0.0.0:1", undefined]) {
    assert.equal(N.localProcessRefusal("127.0.0.1", { host }), null, String(host));
    assert.equal(N.requestPeerKind("127.0.0.1", { host }), "loopback", String(host));
  }
});

test("proxy header behaviour is unchanged", () => {
  const h = { host: "127.0.0.1:8770", "x-forwarded-for": "100.64.0.2" };
  assert.notEqual(N.localProcessRefusal("127.0.0.1", h), null);
  assert.equal(N.requestPeerKind("127.0.0.1", h), "tailscale");
  assert.equal(N.requestPeerKind("127.0.0.1", { "tailscale-funnel-request": "?1" }), "public");
  assert.ok(N.PROXY_HEADERS.includes("x-forwarded-for"));
});

test("a non-loopback peer is never upgraded by a local Host", () => {
  assert.equal(N.requestPeerKind("100.64.0.2", { host: "localhost" }), "tailscale");
  assert.notEqual(N.localProcessRefusal("100.64.0.2", { host: "localhost" }), null);
  assert.equal(N.hostHeaderIsLocal("evil.example"), false);
});
