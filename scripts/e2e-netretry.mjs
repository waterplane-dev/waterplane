// A turn that ends because the CLI GAVE UP on a transient API error is retried by the
// host (R-connection-024, host `sessions/apiretry.ts` + `netlog.ts`):
//   A. two give-ups, then a served reply: `continue` typed twice, the ladder advances
//      (waiting 0 → sent 1 → waiting 1 → sent 2), and the reply clears `netRetry`;
//   B. more give-ups than the cap: stops at `gaveup` after WATERPLANE_NET_RETRY_MAX tries,
//      typing nothing more — and the person's next prompt clears the gave-up line;
//   C. the phone's cancel while a retry waits: `netRetry` gone, nothing typed.
// The stub (`claude-stub-tui.mjs`, STUB_MODE=answer) writes the CLI's real give-up row
// (`isApiErrorMessage`, `error: "server_error"`, ENOTFOUND) for `STUB_NETFAIL <n>` turns.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG } from "./lib-brand.mjs";

const TMP = mkdtempSync(join(tmpdir(), `${SLUG}-netretry-`));
const STUB_LOG = join(TMP, "stub.log");
const { port: PORT, stop } = await bootHost({
  tag: "netretry",
  env: {
    [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
    [E.CLAUDE_HOME]: join(TMP, "home"),
    STUB_MODE: "answer", STUB_HOOKS: "1", STUB_LOG,
    [E.STOP_VERIFY_MS]: "300",
    [E.NET_RETRY_LADDER_MS]: "2000,500", [E.NET_RETRY_MAX]: "2",
  },
});
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = async (code) => { await stop(); process.exit(code); };
watchdog(async () => { console.error("FAIL: timeout"); await done(1); }, 90_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = `http://127.0.0.1:${PORT}`;
const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "netretry" }) }).then((r) => r.json());
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let sid = null, info = null;
/** Every distinct netRetry value the wire carried, as "state:attempt" (null ⇒ "-"). */
const arc = [];
const acks = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "welcome") ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 100, rows: 30 }));
  if (m.t === "session.created" && !sid) sid = m.session.id;
  if ((m.t === "session.created" || m.t === "session.updated") && m.session.id === sid) {
    info = m.session;
    const n = info.netRetry;
    const key = n ? `${n.state}:${n.attempt}` : "-";
    if (arc[arc.length - 1] !== key) arc.push(key);
  }
  if (m.t === "input.ack") acks.set(m.ackId, m);
});
ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 2 })));

const until = async (pred, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); }
  check(false, `timed out waiting: ${what} (arc ${arc.join(" ")})`);
  await done(1);
};
let n = 0;
const send = async (text) => {
  const ackId = `nr-${++n}`;
  ws.send(JSON.stringify({ t: "session.input", id: sid, data: text, submit: true, ackId }));
  await until(() => acks.has(ackId), 20_000, `ack for ${text}`);
  return acks.get(ackId);
};
const continues = () => existsSync(STUB_LOG) ? (readFileSync(STUB_LOG, "utf8").match(/continue/g) ?? []).length : 0;

await until(() => info?.hooked && info?.claudeSessionId && !info?.turnActive, 30_000, "a hooked session with a conversation id");
await sleep(500);

// A — two give-ups, then the reply.
check((await send("STUB_NETFAIL 2")).ok, "A: the prompt was delivered");
await until(() => arc.includes("sent:2") && arc[arc.length - 1] === "-", 30_000, "A: two retries, then cleared");
const a = arc.join(" ");
check(/waiting:0 sent:1 waiting:1 sent:2 -$/.test(a), `A: the ladder advanced and the reply cleared it (${a})`);
check(continues() === 2, `A: \`continue\` typed exactly twice (${continues()})`);

// B — past the cap: stops, says so, types nothing more.
arc.length = 0;
check((await send("STUB_NETFAIL 9")).ok, "B: the prompt was delivered");
await until(() => info?.netRetry?.state === "gaveup", 30_000, "B: gave up");
check(info.netRetry.attempt === 2 && info.netRetry.max === 2, `B: gave up after the cap (${info.netRetry.attempt}/${info.netRetry.max})`);
check(/ENOTFOUND/.test(info.netRetry.error), "B: the CLI's own line rides along");
const before = continues();
await sleep(2500);
check(continues() === before && before === 4, `B: nothing typed after the give-up (${continues()})`);

// C — the person's next prompt clears the gave-up line; the phone's cancel stops a waiting retry.
arc.length = 0;
check((await send("STUB_NETFAIL 1")).ok, "C: the prompt was delivered");
await until(() => info?.netRetry?.state === "waiting", 20_000, "C: a retry waiting");
check(arc[0] === "-", `C: typing cleared the gave-up line first (${arc.join(" ")})`);
ws.send(JSON.stringify({ t: "session.netRetryCancel", id: sid }));
await until(() => !info?.netRetry, 5000, "C: cancelled");
await sleep(2500);
check(continues() === before, `C: nothing typed after the cancel (${continues()})`);

await done(failed ? 1 : 0);
