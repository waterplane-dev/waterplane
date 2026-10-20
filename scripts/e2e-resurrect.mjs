// Verifies limit-exit session RESURRECTION:
//   - a session that exits with a usage-limit banner in its tail is auto-reopened
//     (`--continue`) in the same cwd after the retry cadence
//   - a session that exits WITHOUT a limit banner is NOT resurrected (guard)
//   - a session the user KILLED is NOT resurrected even if limit-blocked
// Portable: throwaway root, stub claude (bash), tiny retry knob via env.
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
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-res-`));
const env = {
  ...process.env, [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.LIMIT_PROBE_MS]: "1200",   // the backoff's first rung (5 s in production) — the one this test waits out
  [E.LIMIT_RETRY_MS]: "1200",   // no reset time in the banner → resurrect at now+1200ms
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const BANNER = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";

const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };

bootWait(PORT, 900, async () => {
  // Three separate repos so a resurrection lands in a KNOWN cwd we can attribute.
  const mk = (n) => fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) }).then((r) => r.json());
  const limited = await mk("limited");   // exits at limit → must resurrect
  const clean = await mk("clean");       // exits without a banner → must NOT resurrect
  const killed = await mk("killed");     // limit-blocked but user-killed → must NOT resurrect

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  const cwd = (r) => r.path;
  const born = new Map();     // cwd → count of session.created seen
  const firstId = new Map();  // cwd → first session id
  let killedId = null;
  let ready = 0;
  let closed = [];            // the latest closed.list

  const bumpBorn = (c) => born.set(c, (born.get(c) ?? 0) + 1);

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "closed.list") closed = m.closed;
    if (m.t === "welcome") {
      send({ t: "session.create", cwd: cwd(limited), cols: 100, rows: 30 });
      send({ t: "session.create", cwd: cwd(clean), cols: 100, rows: 30 });
      send({ t: "session.create", cwd: cwd(killed), cols: 100, rows: 30 });
    } else if (m.t === "session.created") {
      const c = m.session.cwd;
      bumpBorn(c);
      if (!firstId.has(c)) {
        firstId.set(c, m.session.id);
        if (c === cwd(killed)) killedId = m.session.id;
        // Attach so PTY output flows, then drive the exit once all three are up.
        send({ t: "session.attach", id: m.session.id });
        if (++ready === 3) setTimeout(driveExits, 700);
      } else {
        // A SECOND session in a cwd = the resurrection.
        if (c === cwd(limited)) check(true, "limit-exited session was resurrected in the same repo");
      }
    }
  });

  function driveExits() {
    // limited: print the banner, then quit → tail shows the limit → resurrect.
    send({ t: "session.input", id: firstId.get(cwd(limited)), data: `echo "${BANNER}"\r` });
    setTimeout(() => send({ t: "session.input", id: firstId.get(cwd(limited)), data: `exit\r` }), 300);
    // clean: quit with no banner → must NOT resurrect.
    send({ t: "session.input", id: firstId.get(cwd(clean)), data: `echo just-working\r` });
    setTimeout(() => send({ t: "session.input", id: firstId.get(cwd(clean)), data: `exit\r` }), 300);
    // killed: print the banner, then hard-kill via the API → must NOT resurrect.
    send({ t: "session.input", id: firstId.get(cwd(killed)), data: `echo "${BANNER}"\r` });
    setTimeout(() => send({ t: "session.kill", id: killedId }), 300);

    // Wait for the resurrection (retry 1200 ms) ON THE CONDITION, not a fixed
    // window: under tmux a respawn is a new tmux client, and under suite load
    // that took past the 3 s this used to sleep. Then a further grace, so a
    // wrongly resurrected clean or killed session (same clock) has had as long.
    const t0 = Date.now();
    const settle = () => {
      if ((born.get(cwd(limited)) ?? 0) < 2 && Date.now() - t0 < 15000) { setTimeout(settle, 100); return; }
      setTimeout(assertAll, 1500);
    };
    setTimeout(settle, 1500);
    const assertAll = () => {
      check((born.get(cwd(limited)) ?? 0) >= 2, `resurrected (born ${born.get(cwd(limited))} sessions in the limited repo)`);
      check((born.get(cwd(clean)) ?? 0) === 1, `clean exit NOT resurrected (born ${born.get(cwd(clean))})`);
      check((born.get(cwd(killed)) ?? 0) === 1, `user-killed limit session NOT resurrected (born ${born.get(cwd(killed))})`);
      // What each closed row SAYS about why it ended.
      const row = (c) => closed.find((r) => r.id === firstId.get(c));
      check(row(cwd(limited))?.closedBy === "limit", `a limit exit is closedBy "limit" (got ${row(cwd(limited))?.closedBy})`);
      check(typeof row(cwd(limited))?.resumedAs === "string" && row(cwd(limited))?.resumedAs !== firstId.get(cwd(limited)),
        `…and names the session it was reopened as (got ${row(cwd(limited))?.resumedAs})`);
      // No code: the PTY is a tmux client, whose 0 says nothing about the CLI's.
      check(row(cwd(clean))?.closedBy === "exited" && row(cwd(clean))?.exitCode === undefined,
        `a clean exit is closedBy "exited", with no code it cannot know (got ${row(cwd(clean))?.closedBy}/${row(cwd(clean))?.exitCode})`);
      check(row(cwd(killed))?.closedBy === "you", `a person's kill is closedBy "you", not "limit" (got ${row(cwd(killed))?.closedBy})`);
      done();
    };
  }
});

watchdog(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); });
