// The person's switch for the network-error retry (R-connection-025, host `netretrycfg.ts`):
//   A. hello carries `netretry.config` — on by default, no env override;
//   B. switching it OFF while a retry waits cancels it: `netRetry` gone, every socket
//      told the new config, nothing typed;
//   C. while off, a give-up arms nothing; switched back on, the next give-up is retried;
//   D. a host booted with WATERPLANE_NET_RETRY=0 says `envOff`, and a saved ON still retries nothing.
// The stub (`claude-stub-tui.mjs`, STUB_MODE=answer) writes the CLI's real give-up row for
// `STUB_NETFAIL <n>` turns, as in `e2e-netretry.mjs`.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopNow = async () => {};
const done = async (code) => { await stopNow(); process.exit(code); };
watchdog(async () => { console.error("FAIL: timeout"); await done(1); }, 120_000);

/** One host + one socket + one hooked stub session. */
async function boot(tag, extraEnv) {
  const TMP = mkdtempSync(join(tmpdir(), `${SLUG}-${tag}-`));
  const STUB_LOG = join(TMP, "stub.log");
  const { port, stop } = await bootHost({
    tag,
    env: {
      [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
      [E.CLAUDE_HOME]: join(TMP, "home"),
      STUB_MODE: "answer", STUB_HOOKS: "1", STUB_LOG,
      [E.STOP_VERIFY_MS]: "300",
      [E.NET_RETRY_LADDER_MS]: "2500", [E.NET_RETRY_MAX]: "3",
      ...extraEnv,
    },
  });
  stopNow = stop;
  const base = `http://127.0.0.1:${port}`;
  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: tag }) }).then((r) => r.json());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const h = { ws, sid: null, info: null, cfg: [], acks: new Map(), stop, arc: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 100, rows: 30 }));
    if (m.t === "netretry.config") h.cfg.push(m);
    if (m.t === "session.created" && !h.sid) h.sid = m.session.id;
    if ((m.t === "session.created" || m.t === "session.updated") && m.session.id === h.sid) {
      h.info = m.session;
      const n = h.info.netRetry, key = n ? `${n.state}:${n.attempt}` : "-";
      if (h.arc[h.arc.length - 1] !== key) h.arc.push(key);
    }
    if (m.t === "input.ack") h.acks.set(m.ackId, m);
  });
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 2 })));
  h.until = async (pred, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); }
    check(false, `timed out waiting: ${what} (arc ${h.arc.join(" ")})`);
    await done(1);
  };
  let n = 0;
  h.send = async (text) => {
    const ackId = `${tag}-${++n}`;
    ws.send(JSON.stringify({ t: "session.input", id: h.sid, data: text, submit: true, ackId }));
    await h.until(() => h.acks.has(ackId), 20_000, `ack for ${text}`);
    return h.acks.get(ackId);
  };
  h.continues = () => existsSync(STUB_LOG) ? (readFileSync(STUB_LOG, "utf8").match(/continue/g) ?? []).length : 0;
  h.turnDone = async (what) => {
    await h.until(() => h.info?.turnActive, 10_000, `${what}: the turn started`);
    await h.until(() => !h.info?.turnActive, 15_000, `${what}: the turn ended`);
    await sleep(2500); // past the recheck and the first rung
  };
  await h.until(() => h.info?.hooked && h.info?.claudeSessionId && !h.info?.turnActive, 30_000, "a hooked session with a conversation id");
  await sleep(500);
  return h;
}

// ── A–C: the switch on an ordinary host ──
const h = await boot("netretryswitch", {});
check(h.cfg[0]?.enabled === true && !h.cfg[0]?.envOff, `A: hello says on, no env override (${JSON.stringify(h.cfg[0])})`);

check((await h.send("STUB_NETFAIL 1")).ok, "B: the prompt was delivered");
await h.until(() => h.info?.netRetry?.state === "waiting", 20_000, "B: a retry waiting");
const nCfg = h.cfg.length;
h.ws.send(JSON.stringify({ t: "netretry.set", enabled: false }));
await h.until(() => h.cfg.length > nCfg, 5000, "B: the config broadcast");
check(h.cfg[h.cfg.length - 1].enabled === false, "B: the broadcast says off");
await h.until(() => !h.info?.netRetry, 5000, "B: the waiting retry cancelled");
await sleep(3000);
check(h.continues() === 0, `B: nothing typed after switching off (${h.continues()})`);

h.arc.length = 0;
check((await h.send("STUB_NETFAIL 1")).ok, "C: the prompt was delivered while off");
await h.turnDone("C off");
check(!h.info.netRetry && !h.arc.some((k) => k !== "-"), `C: off ⇒ a give-up arms nothing (${h.arc.join(" ")})`);

h.ws.send(JSON.stringify({ t: "netretry.set", enabled: true }));
await h.until(() => h.cfg[h.cfg.length - 1].enabled === true, 5000, "C: back on");
check((await h.send("STUB_NETFAIL 1")).ok, "C: the prompt was delivered while on");
await h.until(() => h.continues() === 1, 20_000, "C: on again ⇒ the give-up is retried");
check(h.continues() === 1, "C: exactly one `continue` once switched back on");
h.ws.close();
await h.stop();

// ── D: the env override ──
const d = await boot("netretryenv", { [E.NET_RETRY]: "0" });
check(d.cfg[0]?.enabled === true && d.cfg[0]?.envOff === true, `D: hello says envOff (${JSON.stringify(d.cfg[0])})`);
check((await d.send("STUB_NETFAIL 1")).ok, "D: the prompt was delivered");
await d.turnDone("D");
check(!d.info.netRetry && d.continues() === 0, `D: the env override wins over a saved on (${d.arc.join(" ")}, ${d.continues()} typed)`);
d.ws.close();

await done(failed ? 1 : 0);
