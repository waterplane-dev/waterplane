// The RESUME QUEUE'S RELEASE MODE: sequential, per-repo, or all at once.
//
// e2e-limitqueue.mjs pins the default — resumes are serialized, because a limit
// is an ACCOUNT fact and firing every blocked session at the reset instant
// spends N bounded attempts proving what one proves. That argument covers the
// FIRST resume of a wave and nothing after it: once one session provably works
// again, the limit demonstrably has lifted, and how fast the rest follow is a
// question about the work. This pins what the modes actually promise:
//   - the PROBE is alone whatever the mode says — no second session spends an
//     attempt until one has come back working
//   - in `repo` mode two sessions in DIFFERENT worktrees do resume together…
//   - …and two in the SAME worktree never do (the send queue's own rule: two
//     agents must not edit one checkout)
//   - the mode rides on limit.config, so every client agrees on it
// Portable: throwaway root, stub claude (node), tiny timing knobs via env.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8802;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-limitpar-`));
const env = {
  ...process.env, [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  // The stub that RESUMES: the release modes only differ past a resume that took.
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-limit.mjs",
  STUB_LIMIT_OK: "1",
  [E.IDLE_PING_MS]: "700",            // how long a verdict takes to become visible
  [E.LIMIT_RETRY_MS]: "3000",
  // The ladder's own first attempt (a 5 s probe) is pushed out of the test: the
  // release under test is `limit.resume` with every session due at once. Under
  // load the clients take longer than 5 s to go quiet, and the probes then went
  // one by one on their own — never two at once, so the run saw no parallel
  // wave and timed out, with the queue having done nothing wrong.
  [E.LIMIT_PROBE_MS]: "600000",
  [E.LIMIT_RESUME_GAP_MS]: "200",     // < the verdict, so parallel resumes overlap observably
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

// On a failure the run says what each session drew and when, relative to the resume —
// the one fact that separates "the queue broke its rule" from "a session looked busy".
const trail = [];
const fail = (m) => {
  console.error("FAIL:", m);
  for (const t of trail.slice(-60)) console.error("  trail", t);
  host.kill(); process.exit(1);
};
const ok = (m) => console.log("ok:", m);

bootWait(PORT, 800, async () => {
  const mk = async (name) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
    }).then((x) => x.json());
    if (!r.path) fail(`could not create repo ${name}`);
  };
  await mk("alpha");
  await mk("beta");
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());
  const dirs = Object.fromEntries(repos.targets.map((t) => [t.repoName, t.worktreePath]));
  const A = dirs.alpha, B = dirs.beta;
  if (!A || !B) fail("both repos should be discovered");

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));

  const cwdOf = new Map();        // session id → worktree
  const lim = new Map();          // session id → newest SessionLimit
  let cfg = { mode: null, resumingIds: [] };
  let phase = "boot";
  let probeId = null;             // the first session ever TYPED INTO by the resume queue
  let sawParallel = false;        // two sessions resuming at once, in different repos

  // Two sessions in alpha and one in beta: enough for both halves of `repo`
  // mode. Alpha's pair must never overlap; alpha and beta must.
  const PLAN = [A, A, B];
  let created = 0;
  // The continue ladder reads output in the last moment as "busy" and backs
  // that session off a minute, so the resume waits on a CONDITION: no session
  // has drawn anything for a second. (It used to wait for each tmux client's
  // post-timeout redraw ~5 s in too; the host answers the client's start-up
  // queries now, so there is no such redraw — `termqueries.ts`.)
  const lastPty = new Map();      // session id → when its last PTY frame arrived
  const quietAll = () => [...cwdOf.keys()].every((id) => Date.now() - (lastPty.get(id) ?? 0) > 1000);

  // INVARIANTS, checked on every frame — the modes are claims about what may be
  // true SIMULTANEOUSLY, so they are asserted continuously rather than once.
  //
  // "Resuming" here means TYPED INTO: `resuming` with an attempt spent. The queue
  // can let a session through and hand it straight back without typing anything
  // (`doLimitContinue`'s busy check: output in the last moment ⇒ "look again
  // later", no attempt, no verdict) — that flash of `resuming` is not a resume,
  // and counting it made a bounced session the "probe" and failed a run in which
  // the session that was really typed into first had gone alone.
  const checkParallel = () => {
    const busy = [...lim.entries()].filter(([, l]) => l.resuming && l.attempts >= 1).map(([id]) => id);
    if (busy.length && probeId == null) probeId = busy[0];
    if (busy.length > 1) {
      if (busy.includes(probeId)) fail("the probe resumed alongside another session — the first resume must be alone");
      const seen = new Set();
      for (const id of busy) {
        const dir = cwdOf.get(id);
        if (seen.has(dir)) fail(`two sessions in the same worktree resumed at once (${dir}) — repo mode must not`);
        seen.add(dir);
      }
      sawParallel = true;
    }
  };

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());

    if (m.t === "welcome") {
      send({ t: "session.create", cwd: PLAN[0], cols: 120, rows: 30 });
      return;
    }
    if (m.t === "limit.config") {
      cfg = { mode: m.mode ?? null, resumingIds: m.resumingIds ?? [] };
      trail.push(`${Date.now() % 100000} cfg mode=${cfg.mode} resuming=${cfg.resumingIds.join(",")}`);
      // The phases advance on THIS frame too. `limit.setMode` publishes the
      // queue (session updates) BEFORE it broadcasts the new mode, so the last
      // session.updated the switch causes arrives while `cfg.mode` is still
      // "one" — and a run whose sessions then sat quiet (a loaded desktop: no
      // stray redraw to deliver one more update) waited on a mode it already
      // had until the timeout.
      advance();
      return;
    }
    if (m.t === "session.created") {
      cwdOf.set(m.session.id, m.session.cwd);
      send({ t: "session.attach", id: m.session.id });
      created++;
      // Staggered, so "blocked longest" gives a deterministic order.
      if (created < PLAN.length) setTimeout(() => send({ t: "session.create", cwd: PLAN[created], cols: 120, rows: 30 }), 600);
      return;
    }
    if (m.t === "pty") {
      lastPty.set(m.id, Date.now());
      trail.push(`${Date.now() % 100000} pty ${m.id} ${JSON.stringify(Buffer.from(m.dataB64, "base64").toString("utf8").slice(0, 50))}`);
      return;
    }
    if (m.t !== "session.updated" || !m.session.limit) return;
    lim.set(m.session.id, m.session.limit);
    { const l = m.session.limit; trail.push(`${Date.now() % 100000} lim ${m.session.id} blocked=${l.blocked} attempts=${l.attempts} resuming=${!!l.resuming} prompt=${!!m.session.prompt}`); }
    checkParallel();
    advance();
  });

  /** One step of the phases, off whatever the newest frame made true — asked
   *  on every session.updated AND every limit.config, since each phase waits
   *  on a fact that only one of the two carries. */
  function advance() {
    if (created < PLAN.length) return;
    const all = [...lim.values()];

    // ── 1. everything blocked → the mode is published, default sequential ──
    if (phase === "boot" && all.length === PLAN.length && all.every((l) => l.blocked && l.queuePos)) {
      if (cfg.mode !== "one") fail(`the default release mode should be "one", got ${cfg.mode}`);
      ok("all three blocked and queued; release mode defaults to one at a time");
      phase = "switch";
      send({ t: "limit.setMode", mode: "repo" });
      return;
    }

    // ── 2. the switch is host state, echoed to every client ──
    if (phase === "switch" && cfg.mode === "repo") {
      ok("release mode switched to one-per-repo and published on limit.config");
      phase = "running";
      // all of them due at the same instant — the real case — once every client is quiet
      const t0 = Date.now();
      const go = () => {
        if (quietAll()) { trail.push(`${Date.now() % 100000} RESUME`); send({ t: "limit.resume" }); return; }
        if (Date.now() - t0 > 20000) { fail(`the sessions never went quiet (${cwdOf.size} sessions)`); return; }
        setTimeout(go, 100);
      };
      go();
      return;
    }

    // ── 3. the probe works, then the rest go — one per worktree at a time ──
    if (phase === "running" && sawParallel && all.every((l) => l.attempts >= 1)) {
      phase = "done";
      setTimeout(() => {
        const stillBlocked = [...lim.values()].filter((l) => l.blocked).length;
        if (stillBlocked) fail(`${stillBlocked} session(s) still blocked — the resuming stub should have cleared every block`);
        ok("probe went alone, then alpha and beta resumed together while alpha's own pair stayed serialized");
        console.log("PASS: resume release mode — probe first, parallel across repos, never two in one worktree");
        host.kill();
        process.exit(0);
      }, 1500);
    }
  }
  ws.on("error", (e) => fail("ws error " + e.message));
});

watchdog(() => fail("timeout"));
