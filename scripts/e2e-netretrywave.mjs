// One net-retry WAVE per host (owner decision 2026-11-02; host `recover/wavegate.ts`,
// `sessions/apiretry.ts`'s `netWave`): two sessions give up on a transient API error
// together. Whichever's rung comes due first types its `continue` ALONE (the probe);
// the other waits — its line says why (`NET_WAVE_WHY`) — and types nothing until the
// probe's served reply proves the network is back, even across the probe's own
// failed retry (the rest are held until the probe's next rung).
// The stub (`claude-stub-tui.mjs`, STUB_MODE=answer) writes the CLI's real give-up row
// for `STUB_NETFAIL <n>` turns; each session here fails its prompt and its first
// `continue`, and is served on the second.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG } from "./lib-brand.mjs";

const TMP = mkdtempSync(join(tmpdir(), `${SLUG}-netwave-`));
const { port: PORT, stop } = await bootHost({
  tag: "netretrywave",
  env: {
    [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
    [E.CLAUDE_HOME]: join(TMP, "home"),
    STUB_MODE: "answer", STUB_HOOKS: "1",
    [E.STOP_VERIFY_MS]: "300",
    [E.NET_RETRY_LADDER_MS]: "2000,1500", [E.NET_RETRY_MAX]: "3",
  },
});
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = async (code) => { await stop(); process.exit(code); };
watchdog(async () => { console.error("FAIL: timeout"); await done(1); }, 90_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The host's sentence for a held session (apiretry.ts's NET_WAVE_WHY), matched loosely.
const HELD = /another session's retry/;

const base = `http://127.0.0.1:${PORT}`;
const mkRepo = (name) => fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => r.json());
const repos = [await mkRepo("netwave-a"), await mkRepo("netwave-b")];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
/** cwd → session id, and per session: its info and the timed arc of netRetry states. */
const byCwd = new Map();
const info = new Map();
const arcs = new Map();
const acks = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "welcome") for (const r of repos) ws.send(JSON.stringify({ t: "session.create", cwd: r.path, cols: 100, rows: 30 }));
  if (m.t === "session.created" && repos.some((r) => r.path === m.session.cwd) && !byCwd.has(m.session.cwd)) byCwd.set(m.session.cwd, m.session.id);
  if ((m.t === "session.created" || m.t === "session.updated") && [...byCwd.values()].includes(m.session.id)) {
    const id = m.session.id;
    info.set(id, m.session);
    const n = m.session.netRetry;
    const key = n ? `${n.state}:${n.attempt}${n.why && HELD.test(n.why) ? ":held" : ""}` : "-";
    const arc = arcs.get(id) ?? [];
    if (arc[arc.length - 1]?.key !== key) arc.push({ key, at: Date.now() });
    arcs.set(id, arc);
  }
  if (m.t === "input.ack") acks.set(m.ackId, m);
});
ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 2 })));

const until = async (pred, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); }
  const show = [...arcs.entries()].map(([id, a]) => `${id}: ${a.map((x) => x.key).join(" ")}`).join(" | ");
  check(false, `timed out waiting: ${what} (${show})`);
  await done(1);
};

await until(() => byCwd.size === 2 && [...byCwd.values()].every((id) => info.get(id)?.hooked && info.get(id)?.claudeSessionId && !info.get(id)?.turnActive), 30_000, "two hooked sessions with conversation ids");
await sleep(500);
const ids = [...byCwd.values()];
for (const id of ids) arcs.set(id, []);

// Both prompts at once: both turns give up together.
let n = 0;
const sent = ids.map((id) => {
  const ackId = `nw-${++n}`;
  ws.send(JSON.stringify({ t: "session.input", id, data: "STUB_NETFAIL 2", submit: true, ackId }));
  return ackId;
});
await until(() => sent.every((a) => acks.has(a)), 20_000, "both prompts acked");
check(sent.every((a) => acks.get(a).ok), "both prompts delivered");

// Both end served (`-` after a `sent:2`).
await until(() => ids.every((id) => { const a = arcs.get(id) ?? []; return a.some((x) => x.key.startsWith("sent:2")) && a[a.length - 1].key === "-"; }), 45_000, "both sessions served after their second retry");

const firstSent = (id) => arcs.get(id).find((x) => x.key.startsWith("sent:"))?.at ?? Infinity;
const [lead, follow] = [...ids].sort((a, b) => firstSent(a) - firstSent(b));
const la = arcs.get(lead), fa = arcs.get(follow);
const leadServed = la[la.length - 1].at;
const line = (a) => a.map((x) => x.key).join(" ");
check(firstSent(follow) >= leadServed, `the second session typed nothing until the probe got through (lead ${line(la)} | follow ${line(fa)})`);
check(fa.some((x) => x.key.endsWith(":held")), `the waiting session said why (${line(fa)})`);
check(la.filter((x) => x.key.startsWith("sent:")).length === 2, `the probe ran its own ladder, alone (${line(la)})`);

await done(failed ? 1 : 0);
