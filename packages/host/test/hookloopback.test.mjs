// The loopback gate on both hook sinks: a peer that is not this machine (a tailnet
// address) gets 403 BEFORE the body is read or anything is dispatched.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
const { handleApi } = await import("../dist/api.js");

async function post(path, fakeRemote, extra = {}) {
  let hooked = 0;
  const ctx = { sessions: { onHookEvent() { hooked++; }, addBrowserLink() { hooked++; return false; } }, pluginHook: async () => { hooked++; return { status: 200, body: {} }; } };
  const server = createServer((req, res) => {
    if (fakeRemote) Object.defineProperty(req.socket, "remoteAddress", { value: fakeRemote });
    handleApi(req, res, ctx).catch((e) => { res.statusCode = 500; res.end(String(e)); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...extra }, body: "{}",
    });
    return { status: r.status, hooked };
  } finally { server.close(); }
}

for (const path of ["/api/hook", "/api/plugin/stubcli/hook", "/api/shell/open"]) {
  test(`${path}: a non-loopback peer is refused 403 and nothing is dispatched`, async () => {
    const r = await post(path, "100.64.0.1");
    assert.equal(r.status, 403);
    assert.equal(r.hooked, 0);
  });
  test(`${path}: a loopback peer is let through`, async () => {
    const r = await post(path, null);
    assert.notEqual(r.status, 403);
  });
  // Behind `tailscale serve` every tailnet request arrives FROM 127.0.0.1; the
  // proxy's headers are the only thing that says so. Loopback is not enough.
  for (const [h, v] of [["x-forwarded-for", "100.64.0.9"], ["forwarded", "for=100.64.0.9"], ["tailscale-user-login", "someone@example.com"], ["x-forwarded-proto", "https"], ["via", "1.1 proxy"]]) {
    test(`${path}: a loopback request carrying ${h} (proxied) is refused 403 and nothing is dispatched`, async () => {
      const r = await post(path, null, { [h]: v });
      assert.equal(r.status, 403);
      assert.equal(r.hooked, 0);
    });
  }
}

test("one proxy list: the agent routes refuse the same headers as the hook sinks", async () => {
  const { PROXY_HEADERS, localProcessRefusal } = await import("../dist/net.js");
  const { agentCallerRefusal } = await import("../dist/agentintents.js");
  assert.equal(localProcessRefusal("127.0.0.1", {}), null);
  for (const h of PROXY_HEADERS) {
    assert.ok(localProcessRefusal("127.0.0.1", { [h]: "x" }), h);
    assert.ok(agentCallerRefusal("127.0.0.1", { [h]: "x" }), h);
  }
  assert.ok(localProcessRefusal("100.64.0.1", {}));
});

test("/api/shell/open: form body reaches addBrowserLink; a bad one is still 204", async () => {
  const seen = [];
  const ctx = { sessions: { addBrowserLink(id, url) { seen.push([id, url]); return false; } } };
  const server = createServer((req, res) => { handleApi(req, res, ctx).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const at = `http://127.0.0.1:${server.address().port}/api/shell/open`;
    const body = new URLSearchParams({ session: "abc12345", url: "https://github.com/login/device" }).toString();
    const r = await fetch(at, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    assert.equal(r.status, 204);
    assert.deepEqual(seen, [["abc12345", "https://github.com/login/device"]]);
    const big = await fetch(at, { method: "POST", body: "url=" + "a".repeat(20_000) }).catch(() => null);
    assert.ok(!big || big.status === 204, "an oversized body stores nothing and answers no error");
    assert.equal(seen.length, 1);
    const get = await fetch(at);
    assert.notEqual(get.status, 204, "never a GET");
  } finally { server.close(); }
});
