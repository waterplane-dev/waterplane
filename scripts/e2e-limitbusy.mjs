// A usage-limit block must clear on a session that is BUSY — not only on one
// that has fallen quiet.
//
// `e2e-limitstuck.mjs` pins the other half: the banner leaving the scan window
// is never recovery. This is the case that pinned too hard. Both surviving
// paths into `checkLimit` hung off silence — `markIdle` runs IDLE_PING_MS after
// the last byte, and the once-a-minute sweep explicitly skipped anything newer
// than that as "mid-turn". A session that came back at the reset and worked
// straight through, spinner repainting every frame, was never quiet enough for
// either. Measured on the live host (2026-09-06): two sessions in `<app>`
// running turns right then, both wearing "at limit", both with a `turnStartedAt`
// an hour past their `blockedSince` and a conversation log that said `clear`.
// The launcher's "2 at limit" chip was counting sessions that were visibly
// working, which is the same lie in the other direction.
//
// So: block the session (quietly — detection hangs off silence too), then start
// a TURN that also makes the PTY loud for the rest of the test, and assert the
// block clears while output is STILL flowing.
//
// The banner is left ON SCREEN throughout, which is the second half and the one
// that took two goes to get right. Making the flood scroll it out of the scan
// window passes for the wrong reason: `checkLimit`'s screen branch re-marks the
// block on every scan while `det.blocked` holds, and when the conversation log
// answers `unknown` — no dated source at all — that branch shadows the clearing
// gate for ever. Measured (2026-09-07, 00:42): a `<app>` session working for
// 19m28s, reset four hours past, wearing "blocked — usage limit" with the wall
// still the last line on screen. A turn IN FLIGHT past <ENV>_LIMIT_SERVING_MS is
// what outranks it.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8829;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-limitbusy-`));
const env = {
  ...process.env, [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.IDLE_PING_MS]: "600",
  [E.LIMIT_SWEEP_MS]: "1000",    // the backstop path, fast enough to observe
  [E.LIMIT_SERVING_MS]: "2500",  // a turn is "work, not a rejection" this fast here
  [E.LIMIT_RETRY_MS]: "60000",   // no auto-continue attempt during this test: an
                                  // attempt sets attempts>0, which is its own
                                  // clearing reason and would prove nothing
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };
const BANNER = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
// The wall, and then silence — detection is a silence-driven scan as well, so
// the block has to exist before the session gets loud.
const SETUP = `echo "${BANNER}"\r`;
// The recovery, and the load-bearing half of the test.
//
// One Return, which `markSubmitted` turns into `setTurn(true)` on an unhooked
// session, and which then talks every ~120 ms for the rest of the test so
// `lastDataAt` never gets older than IDLE_PING_MS and `markIdle` never guesses
// the turn ended. Deliberately NOT enough output to scroll the banner out of the
// 6000-char scan window: the wall stays visible, `det.blocked` stays true, and
// the only thing that can lift the block is the turn having been in flight
// longer than a rejected one could be.
//
// That is precisely the session the bug was about: busy, provably served, and
// flagged at limit. Two separate rules have to hold for it to pass — the SWEEP
// must run against a loud session at all (it used to `continue` on "mid-turn"),
// and the verdict must let a live turn outrank a stale banner.
const BUSY = `(for i in $(seq 1 300); do echo noise-$i; sleep 0.12; done) &\r`;

const timer = setTimeout(() => fail("timed out: the block never cleared on a busy session"), 40_000);

bootWait(PORT, 1200, async () => {
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "busy" }),
  }).then((r) => r.json());
  if (!repo.path) fail("could not create repo");
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  let sid = null;
  let phase = "boot";   // boot → blocked → turned → done
  let pty = "";
  let noiseAtTurn = 0;

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") {
      send({ t: "session.create", cwd: repos.targets[0].worktreePath, cols: 120, rows: 30 });
    } else if (m.t === "session.created" && !sid) {
      sid = m.session.id;
      send({ t: "session.attach", id: sid });
      setTimeout(() => send({ t: "session.input", id: sid, data: SETUP }), 500);
    } else if (m.t === "pty" && m.id === sid) {
      pty += Buffer.from(m.dataB64, "base64").toString("utf8");
    } else if (m.t === "session.updated" && m.session.id === sid) {
      const lim = m.session.limit;
      if (!lim) return;
      if (phase === "boot" && lim.blocked) {
        console.log(`blocked detected (attempts=${lim.attempts})`);
        phase = "turned";
        noiseAtTurn = (pty.match(/noise-/g) || []).length;
        send({ t: "session.input", id: sid, data: BUSY });
      } else if (phase === "turned" && !lim.blocked) {
        phase = "done";
        if (lim.attempts !== 0) fail(`cleared via an auto-continue attempt (attempts=${lim.attempts}) — that is the other path, not this one`);
        // Prove the session was NOT idle when the block lifted, and keeps not
        // being idle afterwards — otherwise this passes for the old reason.
        const noiseAtClear = (pty.match(/noise-/g) || []).length;
        // The wall must still be on screen at the moment it stopped counting —
        // otherwise this passes because the banner scrolled off, which is a
        // different rule (and `e2e-limitstuck.mjs`'s, in the other direction).
        if (!pty.slice(-6000).includes("reached your")) fail("the banner had scrolled out of the scan window — that is the easy case, not this one");
        setTimeout(() => {
          const noiseNow = (pty.match(/noise-/g) || []).length;
          if (noiseAtClear <= noiseAtTurn) fail("the PTY had not started talking when the block cleared — the old idle path could have done this");
          if (noiseNow <= noiseAtClear) fail("the PTY went quiet — the session was idle after all, so nothing was proven");
          clearTimeout(timer);
          console.log(`PASS: block cleared on a busy session with the wall still on screen (noise ${noiseAtTurn} → ${noiseAtClear} → ${noiseNow})`);
          host.kill();
          process.exit(0);
        }, 900);
      }
    }
  });
});
