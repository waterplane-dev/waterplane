// The waterplane desktop read (`src/hostlink.ts`): off by default, loopback only, the phone's
// token-screen routes only, and every failure a sentence — never a reading nobody took.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { data } from "./helpers.mjs";

test("desktopBase: empty is off, only this machine is ever named", () => {
  assert.ok("off" in data.desktopBase(""));
  assert.deepEqual(data.desktopBase("http://127.0.0.1:8770"), { base: "http://127.0.0.1:8770" });
  assert.deepEqual(data.desktopBase(" http://localhost:9000/ "), { base: "http://localhost:9000" });
  assert.deepEqual(data.desktopBase("http://[::1]:8770"), { base: "http://[::1]:8770" });
  for (const remote of ["http://100.64.0.10:8770", "https://desk.tail1234.ts.net", "http://192.168.0.13:8770", "http://127.0.0.1.evil.com"]) {
    const b = data.desktopBase(remote);
    assert.ok("off" in b, remote);
    assert.match(b.off, /only this machine/);
  }
  assert.ok("off" in data.desktopBase("file:///etc/passwd"));
  assert.ok("off" in data.desktopBase("not a url"));
});

test("forwardable: the token screen's reads and nothing else", () => {
  for (const p of [
    "/api/usagenow", "/api/localusage", "/api/usagelog?hours=48", "/api/usagelog/copilot",
    "/api/tokenwindows?w=session%3A1%3A2&fresh=1", "/api/costwindow?from=1&to=2", "/api/tokenstats/copilot?fresh=1",
  ]) assert.ok(data.forwardable(p), p);
  for (const p of [
    "/api/tokenstats", "/api/host/screenshot", "/api/repos", "/api/tokenstats/../repos", "/api/usagelog/../../x",
    "http://evil/api/usagenow", "/api/costwindow#x", "/api/hook",
  ]) assert.equal(data.forwardable(p), false, p);
});

test("readLive/readPath: off is a sentence, a dead port is a sentence, an answer passes through", async (t) => {
  const off = await data.readLive("");
  assert.equal(off.doc, null);
  assert.equal(off.host, null);
  assert.match(off.why, /off/);

  const doc = { usage: null, readings: [], billing: { profile: "subscription", source: "probe" }, budget: null, periods: [], backends: [] };
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push({ url: req.url, origin: req.headers.origin ?? null });
    if (req.url === "/api/usagenow") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(doc)); return; }
    res.statusCode = 404; res.end(JSON.stringify({ error: "nothing here" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}`;

  const live = await data.readLive(url);
  assert.deepEqual(live.doc, doc);
  assert.equal(live.host, url);
  // No Origin: the host's browser gate is for browsers; a loopback read from Node is the curl case.
  assert.equal(seen[0].origin, null);

  await assert.rejects(data.readPath(url, "/api/localusage"), /nothing here/);
  await assert.rejects(data.readPath(url, "/api/host/screenshot"), /does not forward/);
  assert.equal(seen.some((s) => s.url === "/api/host/screenshot"), false);
  await assert.rejects(data.readPath("", "/api/localusage"), /off/);

  const dead = await data.readLive("http://127.0.0.1:1");
  assert.equal(dead.doc, null);
  assert.match(dead.why, /desktop answered at/);
});
