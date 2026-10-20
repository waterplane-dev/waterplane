// A usage-limit block must NOT be cleared by the banner merely leaving the
// screen — the session gets stuck, silently, and that is the worst outcome the
// whole auto-continue feature exists to prevent.
//
// The real failure (2026-09-03): a session hit the wall, was flagged, and was
// sitting in the resume queue waiting for its turn. Before the queue reached it,
// an idle scan found the banner gone from the 6000-char window and cleared the
// block — the recovery gate accepted "any non-passive byte since the block",
// i.e. one arrow key pressed on the phone while looking at the session. The
// session left the queue with attempts still 0, no "continue" was ever typed,
// and the prompt that hit the limit never ran. It sat at an empty composer for
// three hours until the user retried by hand.
//
// So: block the session, press a key that is NOT a submit, scroll the banner off
// the screen, and assert the block SURVIVES and the auto-continue attempt still
// fires. Recovery has to be a turn actually starting, never the absence of text.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8804;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-limitstuck-`));
const env = {
  ...process.env, [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.IDLE_PING_MS]: "600",       // quick idle scans, so the scan that used to mis-clear runs
  [E.LIMIT_RETRY_MS]: "9000",    // banner carries no reset time → cadence; late enough that the
                                  // false-clear window is exercised well before the attempt
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };
const BANNER = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
// One submit, before the block exists: it arms a DELAYED flood. Everything after
// this point reaches the session without a Return, which is the whole point —
// a Return would legitimately start a turn and legitimately clear the block.
const SETUP = `(sleep 4; for i in $(seq 1 900); do echo filler-$i; done) & echo "${BANNER}"\r`;

const timer = watchdog(() => fail("timed out before the auto-continue attempt fired"));

bootWait(PORT, 1200, async () => {
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "stuck" }),
  }).then((r) => r.json());
  if (!repo.path) fail("could not create repo");
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  let sid = null;
  let phase = "boot";   // boot → blocked → keyed → done
  let pty = "";

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
        phase = "keyed";
        // A bare arrow key — exactly what the phone's special-keys row sends, and
        // exactly what used to count as "the user typed, so this must have
        // recovered". It is not passive (so it is not filtered as wheel/focus
        // noise) and it is not a submit (no turn starts). Sent a few times so one
        // is guaranteed to land after blockedSince.
        for (const d of [200, 700, 1400]) {
          setTimeout(() => send({ t: "session.input", id: sid, data: "\x1b[B" }), d);
        }
        console.log("pressed a non-submitting key, waiting for the flood to scroll the banner off");
      } else if (phase === "keyed" && !lim.blocked) {
        fail("block was cleared with attempts=0 — the banner scrolling off plus a keystroke "
          + "must NOT count as recovery; the session would sit stuck with nothing retrying it");
      } else if (phase === "keyed" && lim.attempts >= 1) {
        phase = "done";
        if (!/filler-900/.test(pty)) fail("the flood never ran — the banner was never scrolled off, so nothing was proven");
        setTimeout(() => {
          if (!/continue/.test(pty.slice(-4000))) fail("attempt should have typed 'continue' into the PTY");
          clearTimeout(timer);
          console.log("PASS: block survived a keystroke + a scrolled-off banner, and auto-continue still fired");
          host.kill();
          process.exit(0);
        }, 700);
      }
    }
  });
});
