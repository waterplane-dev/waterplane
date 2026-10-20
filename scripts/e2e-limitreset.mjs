// A usage limit that RESETS must produce a typed "continue" — not a badge that
// quietly removes itself.
//
// The real failure (2026-09-10, three sessions, one account): the wall came
// down at 20:20 with its reset at 00:00. Two sessions were flagged and their
// auto-continue attempts armed for 00:02 (reset + buffer). At 00:00:38 the
// minute sweep re-read the CLI's log, saw the rejection's own `resetsAt` lying
// in the past, and called that a CLEAR — which cancels the pending attempt
// (`clearLimitBlock` kills `limitTimer`). No "continue" was ever typed, the
// prompts that hit the wall never ran, and the sessions sat at an empty
// composer with no badge saying anything was owed.
//
// The distinction that fixes it: a reset INSTANT passing is a fact about the
// clock, not about the account — nothing has been served and nothing has run —
// so a clock-only clear must WAIT for the attempt it would otherwise cancel.
// Being served again (an ordinary turn after the rejection) is the other kind
// of clear and still lifts the block on its own; that half is `limitlog.test.mjs`.
//
// The block here comes from the LOG alone: the stub prints no banner, so the
// screen heuristic cannot mask what is being tested.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8829;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-limitreset-`));
const HOME = mkdtempSync(join(tmpdir(), `${SLUG}-limitreset-home-`));

const RESET_IN_MS = 5_000;   // the wall lifts this long after the log is written
const BUFFER_MS = 4_000;     // …and the attempt is due that long after the reset

const env = {
  ...process.env, [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  // Be the CLI's own record, under a throwaway home.
  [E.CLAUDE_HOME]: HOME,
  [E.IDLE_PING_MS]: "600",
  [E.LIMIT_SWEEP_MS]: "700",                     // the sweep that used to do the cancelling
  [E.LIMIT_RESET_BUFFER_MS]: String(BUFFER_MS),  // …fires several times inside this gap
  [E.LIMIT_RETRY_MS]: "60000",                   // no cadence attempt can rescue the test
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };
const ok = (m) => console.log("ok:", m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const timer = watchdog(() => fail("timed out before the auto-continue attempt fired"), 60_000);

/** The rejection row the CLI writes, plus an ordinary turn BEFORE it. */
function writeLog(cwd, cid, rejectedAt, resetAt) {
  const dir = join(HOME, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const served = {
    type: "assistant", timestamp: new Date(rejectedAt - 60_000).toISOString(),
    message: { model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "on it" }] },
  };
  const rejected = {
    type: "assistant", timestamp: new Date(rejectedAt).toISOString(),
    message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "quota" }] },
    quotaLimits: { status: "rejected", resetsAt: Math.floor(resetAt / 1000), rateLimitType: "five_hour" },
  };
  writeFileSync(join(dir, cid + ".jsonl"), [served, rejected].map((r) => JSON.stringify(r)).join("\n") + "\n");
}

bootWait(PORT, 1000, async () => {
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "limitreset" }),
  }).then((r) => r.json());
  if (!repo.path) fail("could not create repo");

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let session = null;
  let pty = "";
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created") session = m.session;
    if (m.t === "session.updated" && session && m.session.id === session.id) session = m.session;
    if (m.t === "pty" && session && m.id === session.id) pty += Buffer.from(m.dataB64, "base64").toString("utf8");
  });
  await new Promise((r) => ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }));
  await sleep(300);
  ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "limitreset · main", cols: 80, rows: 24 }));

  const until = async (cond, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return; await sleep(150); }
    fail(what);
  };

  await until(() => session?.claudeSessionId, 10_000, "the session never published a conversation id");
  ws.send(JSON.stringify({ t: "session.attach", id: session.id }));
  await sleep(300);

  // ── the wall, dated, with its reset a few seconds out ──────────────────
  const resetAt = Date.now() + RESET_IN_MS;
  writeLog(repo.path, session.claudeSessionId, Date.now(), resetAt);

  await until(() => session?.limit?.blocked, 12_000, "the log's rejection row never blocked the session");
  if (Math.abs((session.limit.resetAt ?? 0) - resetAt) > 1500) {
    fail(`the block took its reset from somewhere other than the log row (${session.limit.resetAt} vs ${resetAt})`);
  }
  ok("a dated rejection in the CLI's own log blocks the session, with the row's own reset instant");

  // ── the gap the bug lived in: reset passed, attempt not yet due ─────────
  await sleep(Math.max(0, resetAt - Date.now()) + 1500);
  if (!session.limit?.blocked) {
    fail("the block was cleared by its reset instant passing — that cancels the pending continue, and nothing types it afterwards");
  }
  if (/continue/i.test(pty)) fail("something typed the continue before its scheduled moment");
  ok("a reset instant merely passing does not clear the block (the attempt it would cancel is still owed)");

  // ── the attempt itself ─────────────────────────────────────────────────
  await until(() => (session.limit?.attempts ?? 0) > 0, 15_000, "the auto-continue attempt never fired after the reset");
  await until(() => /continue/i.test(pty), 6_000, "the attempt was counted but nothing was typed into the session");
  ok("the continue is typed once the reset is past — the work that hit the wall runs");

  // ── and only then does the badge go ─────────────────────────────────────
  await until(() => !session.limit?.blocked, 15_000, "the block never cleared after a continue that worked");
  ok("the block clears on the attempt's own evidence, not on the clock");

  clearTimeout(timer);
  console.log("PASS e2e-limitreset");
  ws.close();
  host.kill();
  process.exit(0);
});
