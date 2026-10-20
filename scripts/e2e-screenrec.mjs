// The desktop's scrollback is RECORDED, because it cannot be read back.
//
// Measured on claude 2.1.267, on every live pane of this desktop:
//
//     history_size=0   alternate_on=1
//
// The CLI draws in the ALTERNATE screen buffer, which by definition keeps no
// scrollback — a line that leaves the top of the grid is overwritten, not
// pushed anywhere. So replaying the whole byte ring through a VT answers with
// ONE SCREEN however long the session has run (measured: a session of hours
// came back as 31 lines), and tmux, the substrate here, has nothing either
// (`capture-pane -S -` returns the same 31 rows). That is the answer to "can
// the server just replay it": no, and no amount of buffer is the fix.
//
// So `host/screenlog.ts` watches instead: one live headless VT per session, fed
// the PTY bytes as they arrive, its grid read on a debounce and diffed against
// the last one (`@waterplane/shared`'s `absorbScreen`, the same pure rule the phone
// uses). This pins the property that makes it worth having: output that has
// scrolled OFF the grid is still in the answer.
//
// The phone keeps its own copy for the tunnel being down, and the two are not
// equally good — it only sees a session while it is on screen and the app is
// awake. Hence `history`, asserted here too: the host says whether it holds
// anything beyond the current grid, so a daemon that has just restarted cannot
// talk a phone out of an archive that is longer than its own.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8823;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-screenrec-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;

bootWait(PORT, 1200, async () => {
  try {
    const repo = await fetch(`${base}/api/repo`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "rec" }),
    }).then((r) => r.json());

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let sid = null;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") sid = m.session.id;
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
    await sleep(200);
    // A SHORT grid on purpose: 14 rows is the floor `ptysize.ts` allows, and
    // the point of the test is output that does not fit in it.
    ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 14 }));
    const until = async (cond, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(100); }
      return false;
    };
    await until(() => sid);
    ws.send(JSON.stringify({ t: "session.attach", id: sid }));
    await sleep(400);

    const empty = await fetch(`${base}/api/scrollback?id=${sid}`).then((r) => r.json());
    check(empty.history === false,
      `a session that has not scrolled yet says so — nothing beyond the grid (got ${empty.history})`);

    // Sixty numbered lines through a fourteen-row grid: forty-odd of them have
    // to have scrolled off by the end, and a replay could never get them back.
    // Slowly enough that the recorder's settle window samples the scroll rather
    // than seeing one unanchorable jump — which is the phone's problem, and the
    // reason the host does this at all.
    ws.send(JSON.stringify({ t: "session.input", id: sid, data: "for i in $(seq 1 60); do echo rec-line-$i; sleep 0.04; done\r" }));

    // Waited FOR, not slept through. Sixty `sleep` forks cost whatever this
    // machine is busy with — measured at 167 ms each on a loaded one — and a
    // fixed wait then reads a correct, complete recording halfway through the
    // loop and calls it a loss. The poll asks the thing under test, which is
    // the point: the last line has to turn up in what the desktop answers.
    let doc = null;
    const done = await until(async () => {
      doc = await fetch(`${base}/api/scrollback?id=${sid}`).then((r) => r.json());
      return (doc.lines ?? []).some((l) => l.includes("rec-line-60"));
    }, 25000);
    check(done, "the whole run reaches the desktop's recording");
    const text = (doc.lines ?? []).join("\n");
    const seen = [];
    const missing = [];
    for (let i = 1; i <= 60; i++) (new RegExp(`(^|\\n)rec-line-${i}\\b`).test(text) ? seen : missing).push(i);
    check(doc.history === true, `the desktop now holds more than the grid (got ${doc.history})`);
    check(doc.lines.length > 14, `…and answers with more lines than fit on it (${doc.lines?.length} from a 14-row grid)`);
    // The load-bearing one: a replay of the byte ring can only ever answer with
    // the last fourteen of these.
    check(missing.length === 0, `every line is there, including the ones that scrolled off (missing: ${missing.slice(0, 8).join(",") || "none"})`);
    // …once each. Duplication is the other half of the report, and the daemon's
    // vantage point is what avoids it: it never has a gap large enough to make
    // a sample unanchorable, so no screen is ever archived whole twice.
    const dupes = [];
    for (let i = 1; i <= 60; i++) {
      const n = (text.match(new RegExp(`(^|\\n)rec-line-${i}\\b`, "g")) ?? []).length;
      if (n > 1) dupes.push(`${i}×${n}`);
    }
    check(dupes.length === 0, `and once each, not a screen archived twice (dupes: ${dupes.slice(0, 8).join(",") || "none"})`);
    // In order, which is what makes it readable as a transcript rather than a
    // bag of moments.
    check(seen.join(",") === Array.from({ length: 60 }, (_, i) => i + 1).join(","), "in order");
    const at = doc.lines.findIndex((l) => l.includes("rec-line-1"));
    const at60 = doc.lines.findIndex((l) => l.includes("rec-line-60"));
    check(at >= 0 && at60 > at, `oldest first, newest last (${at} → ${at60})`);

    ws.close();
  } catch (e) {
    console.log("FAIL: threw", e);
    failed = true;
  }
  host.kill();
  setTimeout(() => process.exit(failed ? 1 : 0), 150);
});

watchdog(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); });
