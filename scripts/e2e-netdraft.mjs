// The recovery writer never types `continue` over a PERSON's words in the composer
// (`recover/recoverwrite.ts`'s draft rung, read with `composer.ts`'s `composerReading`),
// pinned end to end on the net retry (host `sessions/apiretry.ts`) against the REAL
// composer shape — `❯` between two rules, claude's dim `Try "…"` hint in an empty box
// (stub `STUB_COMPOSER=frame`). The other limit/net e2e draw a bare `> `, where the rung
// has no box to place and so is never asked.
//   A. the box holds only the dim hint ⇒ empty: the retry types `continue` as before;
//   B. words typed at the desk (stub `STUB_DRAFT_FILE`) ⇒ the retry PARKS, the phone's
//      line says why ("words in the composer"), each park longer than the last (the
//      back-off), nothing typed; the words cleared ⇒ it types `continue` and the reply
//      clears the episode.
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG } from "./lib-brand.mjs";

const TMP = mkdtempSync(join(tmpdir(), `${SLUG}-netdraft-`));
const STUB_LOG = join(TMP, "stub.log");
const DRAFT = join(TMP, "draft.txt");
const { port: PORT, stop } = await bootHost({
  tag: "netdraft",
  env: {
    [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
    [E.CLAUDE_HOME]: join(TMP, "home"),
    STUB_MODE: "answer", STUB_HOOKS: "1", STUB_LOG, STUB_COMPOSER: "frame", STUB_DRAFT_FILE: DRAFT,
    [E.STOP_VERIFY_MS]: "300",
    [E.NET_RETRY_LADDER_MS]: "1500", [E.NET_RETRY_MAX]: "3", [E.NET_RETRY_PARK_MS]: "1000",
  },
});
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = async (code) => { await stop(); process.exit(code); };
watchdog(async () => { console.error("FAIL: timeout"); await done(1); }, 120_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = `http://127.0.0.1:${PORT}`;
const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "netdraft" }) }).then((r) => r.json());
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let sid = null, info = null;
/** Every distinct netRetry value the wire carried, as "state:attempt" (null ⇒ "-"). */
const arc = [];
/** Each draft park the wire carried: its nextAt and how far ahead it was when it arrived. */
const parks = [];
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
    if (n?.why === "words in the composer" && n.nextAt != null && parks.at(-1)?.nextAt !== n.nextAt) {
      parks.push({ nextAt: n.nextAt, ahead: n.nextAt - Date.now() });
    }
  }
  if (m.t === "input.ack") acks.set(m.ackId, m);
});
ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 2 })));

const until = async (pred, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); }
  check(false, `timed out waiting: ${what} (arc ${arc.join(" ")}; parks ${parks.map((p) => p.ahead).join(",")})`);
  await done(1);
};
let n = 0;
const send = async (text) => {
  const ackId = `nd-${++n}`;
  ws.send(JSON.stringify({ t: "session.input", id: sid, data: text, submit: true, ackId }));
  await until(() => acks.has(ackId), 20_000, `ack for ${text}`);
  return acks.get(ackId);
};
const continues = () => existsSync(STUB_LOG) ? (readFileSync(STUB_LOG, "utf8").match(/continue/g) ?? []).length : 0;

await until(() => info?.hooked && info?.claudeSessionId && !info?.turnActive, 30_000, "a hooked session with a conversation id");
await sleep(500);

// A — the dim hint alone is an empty box: the retry types as it always did.
check((await send("STUB_NETFAIL 1")).ok, "A: the prompt was delivered (into the real composer frame, past its dim hint)");
await until(() => arc.includes("sent:1") && arc[arc.length - 1] === "-", 30_000, "A: one retry, then cleared");
check(continues() === 1, `A: \`continue\` typed once over the hint-only box (${continues()})`);
check(parks.length === 0, `A: the hint was never read as a draft (${parks.length} draft parks)`);

// B — words at the desk: parked, said, backed off; cleared ⇒ typed.
arc.length = 0;
check((await send("STUB_NETFAIL 1")).ok, "B: the prompt was delivered");
await until(() => info?.netRetry?.state === "waiting", 20_000, "B: a retry waiting");
writeFileSync(DRAFT, "half a thou");
await until(() => parks.length >= 3, 40_000, "B: three draft parks");
check(info.netRetry?.why === "words in the composer", `B: the phone's line says why (${info.netRetry?.why})`);
check(info.netRetry?.state === "waiting" && info.netRetry.attempt === 0, `B: still waiting, no rung spent (${info.netRetry?.state}:${info.netRetry?.attempt})`);
const [p1, p2, p3] = parks.map((p) => p.ahead);
check(p2 > p1 * 1.5 && p3 > p2 * 1.5, `B: each draft park longer than the last (${p1}, ${p2}, ${p3} ms)`);
check(continues() === 1, `B: nothing typed over the words (${continues()})`);
writeFileSync(DRAFT, "");
await until(() => arc.includes("sent:1") && arc[arc.length - 1] === "-", 40_000, "B: the words cleared, one retry, then cleared");
check(continues() === 2, `B: \`continue\` typed once the composer was empty (${continues()})`);

await done(failed ? 1 : 0);
