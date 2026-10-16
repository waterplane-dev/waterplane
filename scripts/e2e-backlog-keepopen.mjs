// Automatic sessions STAY OPEN by default — and an open IDLE one holds no slot.
//
// The other half of `e2e-backlog-slots.mjs`. There the synced *close automatic
// sessions when done* setting is switched on; here it is left at its default
// (off): nothing closes a session a fired item opened. And since
// R-automation-042 that no longer stops queued work — only a WORKING automatic
// session holds a slot. Four facts:
//
//  1. with ONE slot and two items in two repos, the first runs and the second
//     WAITS while it works, saying so in this desktop's numbers;
//  2. the first finishes — and its session is NOT closed, however idle (the
//     linger here is 1.5 s);
//  3. the second item then runs with nobody closing anything: the idle open
//     session freed its slot by going idle;
//  4. `backlog.list` carries the cap as facts (`autoSlots`): the open session's
//     id with `closeWhenDone: false` and `busy: false`. A fact, never an action.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8824;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-keepopen-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.BACKLOG_SESSIONS]: "1",
  [E.IDLE_MS]: "1200",
  // Both short, so that a session still open after them is open because
  // nothing is ALLOWED to close it — not because nothing got round to it.
  [E.BACKLOG_REAP_IDLE_MS]: "600",
  [E.BACKLOG_LINGER_MS]: "1500",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = () => { try { host.kill(); } catch { /* already gone */ } setTimeout(() => process.exit(failed ? 1 : 0), 150); };
const bail = setTimeout(() => { check(false, "timed out"); done(); }, 45000);

bootWait(PORT, 900, async () => {
  const mk = (n) => fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) }).then((r) => r.json());
  const dirs = [(await mk("keep-a")).path, (await mk("keep-b")).path];

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let added = false;
  /** When the first item settled `done` — the waiting clock starts there. */
  let firstDoneAt = 0;
  let firstSid = "";
  let finished = false;
  let closedIds = [];
  let sawWaitWords = "";
  let sawFacts = null;

  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "closed.list") { closedIds = m.closed.map((c) => c.id); return; }
    if (m.t !== "backlog.list") return;
    if (!added) {
      added = true;
      ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true }));
      dirs.forEach((dir, i) => ws.send(JSON.stringify({ t: "backlog.add", text: `echo KEEP_${i}`, repoDir: dir, label: `item ${i}` })));
      return;
    }
    const items = m.items.filter((i) => dirs.includes(i.repoDir));
    if (items.length < 2) return;
    const done1 = items.find((i) => i.status === "done");
    if (done1 && !firstDoneAt) { firstDoneAt = Date.now(); firstSid = done1.sessionId; }
    for (const i of items) {
      const why = (m.waiting || {})[i.id];
      if (why && /free slot/i.test(why)) sawWaitWords = why;
    }
    if (firstSid && m.autoSlots?.open?.some((s) => s.id === firstSid && s.busy === false)) sawFacts = m.autoSlots;
    if (!finished && items.every((i) => i.status === "done")) {
      finished = true;
      clearTimeout(bail);
      // Past the linger, so a session still open is open because nothing is
      // ALLOWED to close it — not because nothing got round to it.
      setTimeout(() => {
        check(!!firstSid && !closedIds.includes(firstSid),
          `the finished item's session is still open well past the linger (${firstSid})`);
        check(/1 automatic session at a time and 1 is working/.test(sawWaitWords),
          `the second item said it waited on a WORKING session (${JSON.stringify(sawWaitWords)})`);
        check(true, "the second item ran with nobody closing anything — an idle open session holds no slot");
        check(sawFacts?.max === 1 && sawFacts.open.some((s) => s.id === firstSid && s.closeWhenDone === false && s.busy === false),
          `backlog.list carries the open session as a fact: kept open, not working (${JSON.stringify(sawFacts)})`);
        ws.close();
        done();
      }, 2500);
    }
  });
});
