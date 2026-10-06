/**
 * Tailnet discovery (`discover.ts`) and `waterplane pair` (`cli/pair.ts`):
 * the `tailscale status --json` parser over a fixture, what is listed once the
 * probes answered, and the CLI's argument parse and output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const D = await import("../dist/tailnetpeers.js");
const P = await import("../dist/cli/pair.js");

const FIXTURE = {
  Self: { HostName: "mac", DNSName: "mac.tail1234.ts.net.", TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"], Online: true, OS: "macOS" },
  Peer: {
    "nodekey:a": { HostName: "orb-linux", DNSName: "orb-linux.tail1234.ts.net.", TailscaleIPs: ["100.64.0.80", "fd7a::2"], Online: true, OS: "linux" },
    "nodekey:b": { HostName: "old-laptop", TailscaleIPs: ["100.90.0.2"], Online: false, OS: "windows" },
    "nodekey:c": { HostName: "pixel", TailscaleIPs: ["100.90.0.3"], Online: true, OS: "android" },
    "nodekey:d": { HostName: "v6only", TailscaleIPs: ["fd7a::9"], Online: true, OS: "linux" },
    "nodekey:e": { DNSName: "nameless.tail1234.ts.net.", TailscaleIPs: ["100.90.0.5"], Online: true },
    "nodekey:f": null,
  },
};

test("parse: only ONLINE peers with a tailnet IPv4, Self excluded", () => {
  const rows = D.parseTailnetStatus(FIXTURE);
  assert.deepEqual(rows.map((r) => r.name), ["orb-linux", "pixel", "nameless"]);
  assert.equal(rows[0].ip, "100.64.0.80");
  assert.equal(rows[0].os, "linux");
});

test("parse: malformed input lists nobody", () => {
  assert.deepEqual(D.parseTailnetStatus(null), []);
  assert.deepEqual(D.parseTailnetStatus({}), []);
  assert.deepEqual(D.parseTailnetStatus({ Peer: "x" }), []);
});

test("healthKind: a daemon, a daemon behind a password, or neither", () => {
  assert.equal(D.healthKind(200, { ok: true, protocol: 12 }), "open");
  assert.equal(D.healthKind(401, { error: "auth required", authRequired: true }), "gated");
  assert.equal(D.healthKind(200, { ok: true }), null);
  assert.equal(D.healthKind(200, "<html>"), null);
  assert.equal(D.healthKind(401, { error: "nope" }), null);
  assert.equal(D.healthKind(403, { authRequired: true }), null);
});

const deps = (answers, status = JSON.stringify(FIXTURE)) => ({
  status: async () => status,
  probe: async (ip, port) => answers[`${ip}:${port}`] ?? null,
});

test("discover lists those that answered, with port and gate", async () => {
  const r = await D.discoverTailnetPeers([8770], deps({ "100.64.0.80:8770": "open", "100.90.0.5:8770": "gated" }));
  assert.deepEqual(r.peers, [
    { name: "orb-linux", addr: "100.64.0.80:8770", os: "linux", gated: false },
    { name: "nameless", addr: "100.90.0.5:8770", os: "", gated: true },
  ]);
  assert.equal(r.note, undefined);
});

test("discover tries the own port and 8770, and lists a daemon on the other one", async () => {
  const r = await D.discoverTailnetPeers([9000], deps({ "100.90.0.3:9000": "open" }));
  assert.equal(r.peers.length, 1);
  assert.equal(r.peers[0].addr, "100.90.0.3:9000");
});

test("no tailscale: an empty list and a sentence", async () => {
  const r = await D.discoverTailnetPeers([8770], deps({}, null));
  assert.deepEqual(r.peers, []);
  assert.match(r.note, /Tailscale is not installed/);
});

test("nobody answered: empty, and the sentence says so", async () => {
  const r = await D.discoverTailnetPeers([8770], deps({}));
  assert.deepEqual(r.peers, []);
  assert.match(r.note, /none answered as a waterplane desktop/);
});

test("the probe count is capped", async () => {
  const Peer = {};
  for (let i = 0; i < 100; i++) Peer[`k${i}`] = { HostName: `h${i}`, TailscaleIPs: [`100.90.1.${i}`], Online: true };
  const seen = new Set();
  await D.discoverTailnetPeers([8770], { status: async () => JSON.stringify({ Peer }), probe: async (ip) => { seen.add(ip); return null; } });
  assert.equal(seen.size, D.DISCOVER_MAX_PEERS);
});

test("pair CLI: argument parse", () => {
  assert.deepEqual(P.parsePairArgs([]), { port: null, json: false, help: false });
  assert.deepEqual(P.parsePairArgs(["--port", "9000", "--json"]), { port: 9000, json: true, help: false });
  assert.equal(P.parsePairArgs(["--port=8771"]).port, 8771);
  assert.match(P.parsePairArgs(["--port", "0"]).error, /--port/);
  assert.match(P.parsePairArgs(["--port"]).error, /--port/);
  assert.match(P.parsePairArgs(["--wat"]).error, /unknown option/);
  assert.equal(P.parsePairArgs(["-h"]).help, true);
});

test("pair CLI: prints code, address, landing URL and deep link", async () => {
  const m = { code: "ABCDEFGH", expiresAt: 1, base: "http://100.64.0.80:8770", landingUrl: "http://100.64.0.80:8770/pair/ABCDEFGH", deepLink: "x://pair?a=1" };
  const text = P.pairLines(m).join("\n");
  assert.match(text, /ABCD-EFGH/);
  assert.match(text, /100\.64\.0\.80:8770/);
  assert.match(text, /\/pair\/ABCDEFGH/);
  assert.match(text, /x:\/\/pair\?a=1/);
  assert.match(text, /Web app +http:\/\/100\.64\.0\.80:8770\/ /, "the PWA route, not only the landing page and the APK");
  const out = [];
  const log = console.log;
  console.log = (s) => out.push(s);
  try {
    let asked;
    const code = await P.run(["--port", "8770"], async (url, init) => { asked = { url, init }; return new Response(JSON.stringify(m), { status: 200 }); });
    assert.equal(code, 0);
    assert.equal(asked.url, "http://127.0.0.1:8770/api/pair/mint");
    assert.equal(asked.init.method, "POST");
    assert.ok(out.join("\n").includes("ABCD-EFGH"));
  } finally { console.log = log; }
});

test("pair CLI: a host that is not running is a sentence and exit 1", async () => {
  const err = console.error;
  const out = [];
  console.error = (s) => out.push(s);
  try {
    const code = await P.run(["--port", "8770"], async () => { throw new Error("ECONNREFUSED"); });
    assert.equal(code, 1);
    assert.match(out.join("\n"), /Is the host running/);
  } finally { console.error = err; }
});
