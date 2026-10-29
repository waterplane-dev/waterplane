// A backlog item fired into a session whose turn the CLI GAVE UP on a transient API
// error is not done (R-connection-024, host `sessions/apiretry.ts` → `turnEnded`'s
// `net` → `intents/watch.ts`):
//   A. one give-up, then the host's `continue` is served: the item stays `running`
//      through the retry and is `done` only after the real reply;
//   B. more give-ups than the cap: the item is `failed` saying the API could not be
//      reached and the retries ran out — never `done`;
//   C. a person types into the session while the retry waits: the retry is called
//      off and the item completes on THEIR turn's end, as any other.
// The stub (`claude-stub-tui.mjs`, STUB_MODE=answer) writes the CLI's real give-up row
// for `STUB_NETFAIL <n>` turns; `STUB_SAY` sets a served answer's text.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG } from "./lib-brand.mjs";

const TMP = mkdtempSync(join(tmpdir(), `${SLUG}-netretry-backlog-`));
const STUB_LOG = join(TMP, "stub.log");
const { port: PORT, stop } = await bootHost({
  tag: "netretry-backlog",
  env: {
    [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
    [E.CLAUDE_HOME]: join(TMP, "home"),
    STUB_MODE: "answer", STUB_HOOKS: "1", STUB_LOG,
    [E.STOP_VERIFY_MS]: "300",
    // The first rung is long enough for C's person to type over it.
    [E.NET_RETRY_LADDER_MS]: "4000,500", [E.NET_RETRY_MAX]: "2",
    [E.BACKLOG_LINGER_MS]: "600000",
  },
});
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = async (code) => { await stop(); process.exit(code); };
watchdog(async () => { console.error("FAIL: timeout"); await done(1); }, 110_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = `http://127.0.0.1:${PORT}`;
const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "nrbacklog" }) }).then((r) => r.json());
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
/** label → the latest backlog row; label → every status it wore, in order. */
const rows = new Map(), statuses = new Map();
/** session id → every distinct netRetry "state:attempt" ("-" = none). */
const arcs = new Map();
let listed = false;
const acks = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === "backlog.list") {
    listed = true;
    for (const i of m.items) {
      if (i.repoDir !== repo.path) continue;
      rows.set(i.label, i);
      const s = statuses.get(i.label) ?? [];
      if (s[s.length - 1] !== i.status) s.push(i.status);
      statuses.set(i.label, s);
    }
  }
  if (m.t === "session.created" || m.t === "session.updated") {
    const n = m.session.netRetry;
    const key = n ? `${n.state}:${n.attempt}` : "-";
    const a = arcs.get(m.session.id) ?? [];
    if (a[a.length - 1] !== key) a.push(key);
    arcs.set(m.session.id, a);
  }
  if (m.t === "input.ack") acks.set(m.ackId, m);
});
ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 2 })));

const until = async (pred, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); }
  check(false, `timed out waiting: ${what} (${JSON.stringify([...statuses])} ${JSON.stringify([...arcs])})`);
  await done(1);
};
const stubLog = () => existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8") : "";
const continues = () => (stubLog().match(/continue/g) ?? []).length;
const arcOf = (label) => arcs.get(rows.get(label)?.sessionId) ?? [];
const add = (label, text) => ws.send(JSON.stringify({ t: "backlog.add", text, repoDir: repo.path, label }));

await until(() => listed, 15_000, "the first backlog list");
ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true }));

// A — one give-up, the retry served: done only after the real reply.
add("A", "STUB_NETFAIL 1\nSTUB_SAY served-A");
await until(() => arcOf("A").includes("waiting:0"), 30_000, "A: the retry is waiting");
check(rows.get("A").status === "running", `A: the item is still running while the retry waits (${rows.get("A").status})`);
await until(() => rows.get("A")?.status === "done", 30_000, "A: done");
const aArc = arcOf("A").join(" ");
check(/waiting:0 sent:1/.test(aArc), `A: done came after the host's continue (${aArc})`);
check(!rows.get("A").error, `A: settled ok (${rows.get("A").error ?? ""})`);
check(!statuses.get("A").includes("failed"), `A: never failed on the way (${statuses.get("A").join(" → ")})`);
const afterA = continues();

// B — past the cap: failed, in words, never done.
add("B", "STUB_NETFAIL 9");
await until(() => rows.get("B")?.status === "failed" || rows.get("B")?.status === "done", 40_000, "B: settled");
check(rows.get("B").status === "failed", `B: the item failed, not done (${statuses.get("B").join(" → ")})`);
check(/could not be reached/.test(rows.get("B").error ?? "") && /stopped retrying/.test(rows.get("B").error ?? ""),
  `B: the sentence says the API was unreachable and the retries ran out (${rows.get("B").error})`);
check(arcOf("B").includes("gaveup:2"), `B: the session gave up at the cap (${arcOf("B").join(" ")})`);
check(continues() === afterA + 2, `B: two continues typed, no more (${continues() - afterA})`);
const afterB = continues();

// C — a person types over the waiting retry: the item completes on their turn.
add("C", "STUB_NETFAIL 1");
await until(() => arcOf("C").includes("waiting:0"), 30_000, "C: the retry is waiting");
const sidC = rows.get("C").sessionId;
ws.send(JSON.stringify({ t: "session.input", id: sidC, data: "STUB_SAY person-took-over", submit: true, ackId: "nrb-c" }));
await until(() => acks.has("nrb-c"), 20_000, "C: the person's prompt acked");
check(acks.get("nrb-c").ok, "C: the person's prompt was delivered");
await until(() => rows.get("C")?.status === "done" || rows.get("C")?.status === "failed", 30_000, "C: settled");
check(rows.get("C").status === "done", `C: done on the person's turn, not failed (${statuses.get("C").join(" → ")}, ${rows.get("C").error ?? ""})`);
check(stubLog().includes("person-took-over"), "C: the person's turn reached the CLI");
await sleep(5000); // past the first rung: had the retry survived, it would have typed now
check(continues() === afterB, `C: no continue was typed after the person took over (${continues() - afterB})`);

await done(failed ? 1 : 0);
