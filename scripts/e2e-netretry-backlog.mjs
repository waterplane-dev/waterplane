// A backlog item fired into a session whose turn the CLI GAVE UP on a transient API
// error is not done (R-connection-024, host `sessions/apiretry.ts` → `turnEnded`'s
// `net` → `intents/watch.ts`):
//   A. one give-up, then the host's `continue` is served: the item stays `running`
//      through the retry and is `done` only after the real reply;
//   B. more give-ups than the cap: the item is STALLED — still `running` (never failed,
//      never done, its prompt never re-fired) with its session's netRetry `gaveup`, so
//      the row's note is derivable; the auto-retry switch flipped from the row leaves
//      the gaveup in place; "Retry now" (`session.netRetryNow`) types `continue` the
//      ladder's way and the item is `done` after that real reply;
//   C. a person types into the session while the retry waits: the retry is called
//      off and the item completes on THEIR turn's end, as any other;
//   D. a stall, dismissed and probed: dismissing the session's gave-up line only HIDES
//      it (the session keeps `gaveup`, `dismissed`; the row stays running); a queued row
//      in the same repo, held only by the stalled row's serial claim, SAYS so
//      ("waiting behind a stalled item: API unreachable"); past the cap the host
//      probes every `NET_RETRY_STALL_MS` with no cap — the first probe gives up again,
//      the second gets a real reply, the stalled row is done and the queued row runs.
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
    // The stall probe: long enough that B's checks at the cap see no probe, short
    // enough that D's two probes fit the watchdog.
    [E.NET_RETRY_STALL_MS]: "6000",
    [E.BACKLOG_LINGER_MS]: "600000",
  },
});
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = async (code) => { await stop(); process.exit(code); };
watchdog(async () => { console.error("FAIL: timeout"); await done(1); }, 170_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = `http://127.0.0.1:${PORT}`;
const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "nrbacklog" }) }).then((r) => r.json());
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
/** label → the latest backlog row; label → every status it wore, in order. */
const rows = new Map(), statuses = new Map();
/** session id → every distinct netRetry "state:attempt" ("-" = none). */
const arcs = new Map();
let listed = false;
let netCfg = null;
/** session id → its latest netRetry; label → every distinct `waiting` sentence. */
const nets = new Map(), waits = new Map();
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
      const w = m.waiting?.[i.id];
      const ws_ = waits.get(i.label) ?? [];
      if (w && ws_[ws_.length - 1] !== w) ws_.push(w);
      waits.set(i.label, ws_);
    }
  }
  if (m.t === "session.created" || m.t === "session.updated") {
    const n = m.session.netRetry;
    const key = n ? `${n.state}:${n.attempt}` : "-";
    const a = arcs.get(m.session.id) ?? [];
    if (a[a.length - 1] !== key) a.push(key);
    arcs.set(m.session.id, a);
    nets.set(m.session.id, n ?? null);
  }
  if (m.t === "input.ack") acks.set(m.ackId, m);
  if (m.t === "netretry.config") netCfg = m;
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

// B — past the cap: STALLED, not failed — then Retry now, and done on its reply.
add("B", "STUB_NETFAIL 3");
await until(() => arcOf("B").includes("gaveup:2"), 40_000, "B: the session gave up at the cap");
await sleep(1500);
check(rows.get("B").status === "running", `B: the item is still running, stalled (${statuses.get("B").join(" → ")})`);
check(!statuses.get("B").includes("failed") && !statuses.get("B").includes("done"), `B: never failed nor done (${statuses.get("B").join(" → ")})`);
check(continues() === afterA + 2, `B: two continues typed at the cap, no more (${continues() - afterA})`);
// The toggle on the row is the host's own switch: off keeps the gaveup the row stands on.
ws.send(JSON.stringify({ t: "netretry.set", enabled: false }));
await until(() => netCfg && netCfg.enabled === false, 10_000, "B: the switch reads off");
await sleep(500);
check(arcOf("B").at(-1) === "gaveup:2", `B: switching off leaves the stall (${arcOf("B").join(" ")})`);
ws.send(JSON.stringify({ t: "netretry.set", enabled: true }));
await until(() => netCfg && netCfg.enabled === true, 10_000, "B: the switch reads on");
ws.send(JSON.stringify({ t: "session.netRetryNow", id: rows.get("B").sessionId }));
await until(() => rows.get("B")?.status === "done" || rows.get("B")?.status === "failed", 30_000, "B: settled after Retry now");
check(rows.get("B").status === "done", `B: done after Retry now's reply (${statuses.get("B").join(" → ")}, ${rows.get("B").error ?? ""})`);
check(continues() === afterA + 3, `B: Retry now typed exactly one continue (${continues() - afterA})`);
check(/gaveup:2 waiting:0 sent:1/.test(arcOf("B").join(" ")), `B: Retry now resumed the ladder at try 1 (${arcOf("B").join(" ")})`);
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
const afterC = continues();

// D — a stall dismissed, the queued row behind it told why, the probe frees both.
// NETFAIL 4: the turn and the ladder's two continues give up (gaveup:2), the first
// probe gives up too (gaveup:3), the second probe is served.
add("D1", "STUB_NETFAIL 4\nSTUB_SAY served-D1");
await until(() => rows.get("D1")?.status === "running", 30_000, "D1: running");
add("D2", "STUB_SAY served-D2");
await until(() => arcOf("D1").includes("gaveup:2"), 40_000, "D1: the session gave up at the cap");
const sidD = rows.get("D1").sessionId;
check(nets.get(sidD)?.nextAt != null, `D1: the gave-up carries the next stall probe (${JSON.stringify(nets.get(sidD))})`);
ws.send(JSON.stringify({ t: "session.netRetryCancel", id: sidD }));
await until(() => nets.get(sidD)?.dismissed === true, 10_000, "D1: the line is dismissed");
check(nets.get(sidD)?.state === "gaveup", `D1: dismissing kept the gave-up (${JSON.stringify(nets.get(sidD))})`);
check(rows.get("D1").status === "running", `D1: still running, stalled (${statuses.get("D1").join(" → ")})`);
await until(() => (waits.get("D2") ?? []).some((w) => /waiting behind a stalled item: API unreachable/.test(w)), 15_000, "D2: the waiting reason names the stall");
check(rows.get("D2").status === "queued", `D2: queued behind the stall (${statuses.get("D2").join(" → ")})`);
check(rows.get("D2").holderSessionId === sidD, `D2: points at the stalled session (${rows.get("D2").holderSessionId})`);
// The first probe gives up again: back to the stall, still dismissed, no cap.
await until(() => arcOf("D1").includes("gaveup:3"), 20_000, "D1: the first probe gave up");
check(nets.get(sidD)?.dismissed === true, "D1: the probe kept the line hidden");
check(rows.get("D1").status === "running", "D1: still stalled after the first probe");
// The second probe is served: D1 completes the ordinary way, D2 then runs.
await until(() => rows.get("D1")?.status === "done" || rows.get("D1")?.status === "failed", 30_000, "D1: settled after the second probe");
check(rows.get("D1").status === "done", `D1: done on the probe's real reply (${statuses.get("D1").join(" → ")}, ${rows.get("D1").error ?? ""})`);
check(continues() === afterC + 4, `D1: two ladder continues + two probes (${continues() - afterC})`);
check(/gaveup:2 .*sent:3 gaveup:3 .*sent:4/.test(arcOf("D1").join(" ")), `D1: probes past the cap (${arcOf("D1").join(" ")})`);
check(!statuses.get("D1").includes("failed"), `D1: never failed (${statuses.get("D1").join(" → ")})`);
await until(() => rows.get("D2")?.status === "done", 30_000, "D2: ran once the stall cleared");
check(stubLog().includes("served-D2"), "D2: its turn reached the CLI");

await done(failed ? 1 : 0);
