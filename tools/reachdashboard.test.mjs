// scripts/reach-dashboard.mjs serves the traffic archive to the tailnet through `tailscale serve`.
// What keeps it safe is pinned here: it binds loopback only, answers only GET / and /data.json, and
// refuses a Host a DNS-rebinding page would send. The shaping of running totals is pinned too.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BIND, handler, hostAllowed, launchdPlist, shape } from "../scripts/reach-dashboard.mjs";

test("it binds loopback only; the tailnet reaches it through tailscale serve", () => {
  assert.equal(BIND, "127.0.0.1");
});

test("loopback and MagicDNS names pass; any other Host is refused", () => {
  for (const h of ["127.0.0.1:8790", "localhost:8790", "box.tail1234.ts.net", "box.tail1234.ts.net:8790"]) assert.ok(hostAllowed(h), h);
  for (const h of ["evil.example:8790", "100.64.0.10:8790", "ts.net", "a.b.ts.net.evil.example", "", undefined]) assert.ok(!hostAllowed(h), String(h));
});

test("only GET / and GET /data.json are answered", async (t) => {
  const srv = http.createServer(handler("/nonexistent/archive.jsonl")).listen(0, "127.0.0.1");
  t.after(() => srv.close());
  await new Promise((r) => srv.once("listening", r));
  const port = srv.address().port;
  const ask = (method, p, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host } }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ code: res.statusCode, body }));
    });
    req.on("error", reject); req.end();
  });
  assert.equal((await ask("GET", "/")).code, 200);
  const data = await ask("GET", "/data.json");
  assert.equal(data.code, 200);
  assert.equal(JSON.parse(data.body).rows, 0);
  assert.equal((await ask("POST", "/data.json")).code, 405);
  assert.equal((await ask("GET", "/../etc/passwd")).code, 404);
  assert.equal((await ask("GET", "/", "evil.example")).code, 403);
});

test("release installs carry each asset's latest reading forward and leave out checksums", () => {
  const rows = [
    { repo: "o/r", kind: "downloads", day: "2026-10-19", tag: "v1", asset: "w-1.tar.gz", count: 2 },
    { repo: "o/r", kind: "downloads", day: "2026-10-19", tag: "v1", asset: "w-1.tar.gz.sha256", count: 9 },
    { repo: "o/r", kind: "downloads", day: "2026-10-24", tag: "v2", asset: "w-2.apk", count: 1 },
    { repo: "o/r", kind: "views", day: "2026-10-20", count: 3, uniques: 1 },
    { repo: "pk", kind: "npm", day: "2026-10-18", count: 5 },
  ];
  const d = shape(rows.map((r) => JSON.stringify(r)).join("\n") + "\n{torn");
  assert.deepEqual(d.releases["o/r"], [{ day: "2026-10-19", total: 2 }, { day: "2026-10-24", total: 3 }]);
  assert.deepEqual(d.views["o/r"], [{ day: "2026-10-20", count: 3, uniques: 1 }]);
  assert.deepEqual(d.npm.pk, [{ day: "2026-10-18", count: 5 }]);
  assert.equal(d.rows, 5);
});

test("the launchd job keeps it alive on the port it was given", () => {
  const p = launchdPlist({ node: "/n", script: "/s.mjs", port: 8790, file: "/f.jsonl", logDir: "/l" });
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.match(p, /<string>--port<\/string><string>8790<\/string>/);
});
