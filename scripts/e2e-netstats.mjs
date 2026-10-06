// Connectivity + delivery telemetry (`host/netstats.ts`, `web/netlog.ts`).
//
// The point of the file is answering "where did my prompt go?" after the fact,
// so the numbers have to be the ones that actually distinguish the failures:
//   • close codes — 1006 (tunnel died under the socket) and 1001 (phone
//     backgrounded it) look identical from the app and mean opposite things
//   • ack REPLAYS — a retry that found the work already done is the only signal
//     that the tunnel is eating return traffic. Neither end can see it alone:
//     the host thinks it answered, the client thinks it was ignored.
//   • delivery outcomes — `deliver.ts` already knows "the turn started" from
//     "the Return was swallowed"; nothing was keeping score.
//
// Asserts:
//   1. sockets are counted, with their close code and peer tier, and a closed
//      socket's lifetime is priced
//   2. a verified `submit` delivery lands in the outcome counters
//   3. a duplicate ackId (the phone's reconnect retry) counts as an ack replay
//   4. a client roll-up round-trips, keyed per device, and junk is sanitised
//      rather than stored (a bad client must not be able to poison the readout
//      or grow the file)
//   5. DELETE resets the window and moves `since`
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8839;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-netstats-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = () => fetch(`${base}/api/netstats`).then((r) => r.json());

const host = spawn("node", ["packages/host/dist/main.js"], {
  env: {
    ...process.env,
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
    [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
    STUB_MODE: "repaint", STUB_LOG: join(ROOT, "stub-input.log"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
await sleep(900);

const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ns" }),
}).then((r) => r.json());

// ── 1. socket lifecycle ─────────────────────────────────────────────────────
{
  const throwaway = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => throwaway.on("open", r));
  await sleep(250);
  throwaway.close(1001, "gone"); // what a backgrounding phone sends
  await sleep(400);
  const s = (await stats()).sockets;
  check(s.opened >= 1, `socket opens counted (${s.opened})`);
  check(s.closed >= 1, `socket closes counted (${s.closed})`);
  check(s.closeCodes["1001"] >= 1, `the close CODE is kept, not just the count (${JSON.stringify(s.closeCodes)})`);
  check((s.byPeer.loopback ?? 0) >= 1, `the peer's trust tier is kept (${JSON.stringify(s.byPeer)})`);
  check(s.totalOpenMs > 0 && s.minOpenMs !== null, `a closed socket's lifetime is priced (total ${s.totalOpenMs}ms, min ${s.minOpenMs}ms)`);
}

// ── 2 + 3. delivery outcomes and ack replays ────────────────────────────────
{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const acks = [];
  let sessionId = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created") sessionId = m.session.id;
    if (m.t === "input.ack") acks.push(m);
  });
  await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }); });
  await sleep(300);
  ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "ns · main", cols: 80, rows: 24 }));
  for (let i = 0; i < 60 && !sessionId; i++) await sleep(100);

  const ACK = "ns-ack-1";
  const send = () => ws.send(JSON.stringify({ t: "session.input", id: sessionId, data: "count this delivery", ackId: ACK, submit: true }));
  send();
  for (let i = 0; i < 400 && acks.filter((a) => a.ackId === ACK).length < 1; i++) await sleep(100);
  // Settled — so this repeat is answered from the ledger, which is precisely the
  // "the phone never saw my receipt" event worth counting.
  send();
  for (let i = 0; i < 80 && acks.filter((a) => a.ackId === ACK).length < 2; i++) await sleep(100);
  await sleep(300);

  const d = await stats();
  const delivered = Object.values(d.delivery).reduce((a, b) => a + b, 0);
  check(delivered >= 1, `verified deliveries are counted by outcome (${JSON.stringify(d.delivery)})`);
  check(d.delivery.ok >= 1, "…and this one landed as `ok`");
  check(d.ackReplays >= 1, `a duplicate ackId counts as a receipt the phone never saw (${d.ackReplays})`);
  ws.close();
  await sleep(300);
}

// ── 4. the client roll-up ───────────────────────────────────────────────────
{
  await fetch(`${base}/api/netstats`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "phone-a", report: { since: Date.now() - 60000, rttP50: 40, rttP95: 900, reconnects: 3, offlineShare: 0.25, sent: 10, failed: 1, ua: "TestPhone/1" } }),
  });
  // Junk: a hostile/buggy client must not be able to store NaN, negatives, an
  // out-of-range share, or an unbounded string.
  await fetch(`${base}/api/netstats`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "phone-b/../../etc", report: { rttP50: -5, rttP95: "lots", offlineShare: 42, sent: 1e12, ua: "x".repeat(500) } }),
  });
  const d = await stats();
  const a = d.clients["phone-a"];
  check(!!a, `a device's roll-up is stored under its own key (${Object.keys(d.clients)})`);
  check(a?.rttP95 === 900 && a?.reconnects === 3, `…with its numbers intact (rttP95 ${a?.rttP95}, reconnects ${a?.reconnects})`);
  check(a?.offlineShare === 0.25, `…including the offline share (${a?.offlineShare})`);

  const keys = Object.keys(d.clients);
  check(!keys.some((k) => k.includes("/") || k.includes("..")), `a device id is stripped to a safe key (${keys})`);
  const b = d.clients[keys.find((k) => k.startsWith("phone-b")) ?? ""];
  check(b && b.rttP50 === 0, `a negative number is clamped, not stored (${b?.rttP50})`);
  check(b && b.rttP95 === undefined, `a non-number is dropped entirely (${b?.rttP95})`);
  check(b && b.offlineShare === 1, `an out-of-range share is clamped (${b?.offlineShare})`);
  check(b && (b.ua?.length ?? 0) <= 120, `a runaway string is truncated (${b?.ua?.length})`);
}

// ── 5. reset ────────────────────────────────────────────────────────────────
{
  const before = await stats();
  await sleep(20);
  const after = await fetch(`${base}/api/netstats`, { method: "DELETE" }).then((r) => r.json());
  check(after.since > before.since, "DELETE moves the window start");
  check(after.ackReplays === 0 && after.sockets.opened === 0, "…and zeroes the counters");
  check(Object.keys(after.clients).length === 0, "…and forgets the device roll-ups");
}

host.kill();
await sleep(200);
process.exit(failed ? 1 : 0);
