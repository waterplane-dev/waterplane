// The RESUME QUEUE: what happens when more than one session is blocked.
//
// A plan limit is an ACCOUNT fact, so the normal case is that every session
// working at that moment blocks on it and parses the SAME reset instant out of
// the same banner. Before the queue, all of them typed "continue" at that
// instant: they raced for a window one of them could have, the rest re-blocked,
// and each spent one of its bounded attempts proving what the first already
// proved. This pins the four rules that replace that:
//   - resumes are SERIALIZED — never two sessions resuming at once
//   - the order is STEERABLE — "go first" beats "blocked longest"
//   - a resume that comes back STILL BLOCKED arms a host-wide hold-off, so the
//     others don't each spend an attempt rediscovering the same wall
//   - an explicit tap (limit.resume) overrules that hold-off; auto-continue off
//     for a session takes it out of the queue entirely
// Portable: throwaway root, stub claude (bash), tiny timing knobs via env.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8799;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-limitq-`));
const env = {
  ...process.env, [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  // A stub that is AT the limit and stays there: every "continue" is answered
  // with the banner again, i.e. the failed resume the hold-off exists for.
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-limit.mjs",
  [E.IDLE_PING_MS]: "600",            // quick idle scans
  [E.LIMIT_RETRY_MS]: "3000",         // = the hold-off length after a failed resume
  [E.LIMIT_RESUME_GAP_MS]: "300",     // breath between two resumes
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };
const ok = (m) => console.log("ok:", m);

bootWait(PORT, 800, async () => {
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "limitq" }),
  }).then((r) => r.json());
  if (!repo.path) fail("could not create repo");
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());
  const cwd = repos.targets[0].worktreePath;

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));

  const ids = [];                 // creation order: [A, B]
  const lim = new Map();          // id → newest SessionLimit
  let cfg = { resumingId: null, holdUntil: null };
  let phase = "boot";
  const resumedEver = new Set();  // ids we ever saw with resuming:true

  const A = () => ids[0], B = () => ids[1];
  const at = (id) => lim.get(id) || {};

  // INVARIANT, checked on every frame: at most one session resumes at a time.
  // The whole feature is this sentence, so it is asserted continuously rather
  // than at one convenient moment.
  const checkSerial = () => {
    const busy = [...lim.entries()].filter(([, l]) => l.resuming).map(([id]) => id);
    if (busy.length > 1) fail(`two sessions resuming at once: ${busy.join(", ")}`);
    for (const id of busy) resumedEver.add(id);
  };

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());

    if (m.t === "welcome") {
      send({ t: "session.create", cwd, cols: 120, rows: 30 });
      return;
    }
    if (m.t === "limit.config") {
      cfg = { resumingId: m.resumingId ?? null, holdUntil: m.holdUntil ?? null };
      return;
    }
    if (m.t === "session.created") {
      ids.push(m.session.id);
      send({ t: "session.attach", id: m.session.id });
      // Both stubs print the banner at boot; A is created first, so it is the
      // longer-blocked one — which is what "go first" has to beat below.
      if (ids.length === 1) setTimeout(() => send({ t: "session.create", cwd, cols: 120, rows: 30 }), 700);
      return;
    }
    if (m.t !== "session.updated" || !m.session.limit) return;
    lim.set(m.session.id, m.session.limit);
    checkSerial();
    if (ids.length < 2) return;
    const a = at(A()), b = at(B());

    // ── 1. both blocked → both in the queue, oldest block first ──
    if (phase === "boot" && a.blocked && b.blocked && a.queuePos && b.queuePos) {
      if (a.queuePos !== 1 || b.queuePos !== 2) fail(`default order should be oldest-block-first, got A=${a.queuePos} B=${b.queuePos}`);
      ok(`both blocked and queued in order (A=${a.queuePos}, B=${b.queuePos})`);
      phase = "steer";
      send({ t: "limit.first", id: B(), on: true });
      return;
    }

    // ── 2. "go first" beats blocked-longest ──
    if (phase === "steer" && b.queuePos === 1 && a.queuePos === 2) {
      if (!b.first) fail("the session pushed to the front should carry first:true");
      ok("go first: B jumped ahead of the longer-blocked A");
      phase = "serialize";
      // Make BOTH due at the same instant — the real-world case (one reset time
      // for the whole account) — and see that only one of them goes.
      send({ t: "limit.resume" });
      return;
    }

    // ── 3. serialized: B goes first, A has not spent an attempt yet ──
    if (phase === "serialize" && b.attempts >= 1) {
      if (a.attempts !== 0) fail("A spent an attempt while B was being resumed — the resumes were not serialized");
      if (!resumedEver.has(B())) fail("B never published resuming:true");
      if (cfg.resumingId !== B()) fail(`limit.config should name B as the resuming session, got ${cfg.resumingId}`);
      ok("serialized: B (pushed to the front) resumed alone, A untouched");
      phase = "held";
      return;
    }

    // ── 4. both resumes failed → the hold-off parks the queue ──
    // "resume all" force-flagged A too, so A follows B (an explicit tap is
    // allowed to overrule the hold-off; that is the point of it being explicit).
    // What must NOT happen afterwards is the AUTOMATIC path burning attempts:
    // every next attempt is pushed past the hold-off, because the account
    // demonstrably has not reset.
    if (phase === "held" && a.attempts >= 1 && b.attempts >= 1) {
      phase = "checking";
      setTimeout(() => {
        if (!cfg.holdUntil || cfg.holdUntil < Date.now()) fail("a failed resume should arm the host-wide hold-off");
        for (const [who, l] of [["A", at(A())], ["B", at(B())]]) {
          if (l.attempts !== 1) fail(`${who} spent ${l.attempts} attempts — the hold-off should have stopped at 1`);
          if (l.nextAttemptAt && l.nextAttemptAt < cfg.holdUntil) fail(`${who}'s next attempt is scheduled before the hold-off lifts`);
        }
        ok(`failed resumes held the queue off until ${new Date(cfg.holdUntil).toISOString()} (no further attempts spent)`);
        phase = "manual";
        send({ t: "limit.resume", id: A() });   // an explicit tap overrules the clock
      }, 1200);
      return;
    }

    // ── 5. a tap beats the hold-off; auto-off leaves the queue ──
    if (phase === "manual" && a.attempts >= 2) {
      if (!cfg.holdUntil || cfg.holdUntil < Date.now()) fail("hold-off expired on its own — the tap proved nothing");
      ok("manual resume overruled the hold-off");
      phase = "off";
      send({ t: "limit.session", id: A(), override: false });
      return;
    }
    if (phase === "off" && a.autoContinue === false) {
      if (a.queuePos != null) fail("a session with auto-continue off must not sit in the resume queue");
      ok("auto-continue off takes the session out of the queue");
      console.log("PASS: resume queue — serialized, steerable, hold-off after a failed resume, tap overrules it");
      host.kill();
      process.exit(0);
    }
  });
  ws.on("error", (e) => fail("ws error " + e.message));
});

watchdog(() => fail("timeout"));
