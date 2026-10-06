// Automatic sessions STAY OPEN by default — and a full cap then waits for a
// person, saying so.
//
// The other half of `e2e-backlog-slots.mjs`. There the synced *close automatic
// sessions when done* setting is switched on and the reap frees the slot; here
// it is left at its default (off), which is what the person chose: nothing
// closes a session a fired item opened, neither the linger sweep nor the slot
// reap. Four facts:
//
//  1. with ONE slot and two items in two repos, the first runs, finishes — and
//     its session is NOT closed, however idle (the reap floor here is 600 ms);
//  2. the second WAITS, and its sentence says why in words a person can act on:
//     "1 automatic session open (close one to make room)";
//  3. `backlog.list` carries the cap as facts (`autoSlots`): the ceiling and the
//     open session's id with `closeWhenDone: false` — what the phone offers
//     "close one" from. A fact, never an action;
//  4. a person's ordinary close (`session.remove`) frees the slot and the second
//     item runs.
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
  let closedByUs = false;
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
    const other = items.find((i) => i !== done1);
    if (done1 && !firstDoneAt) { firstDoneAt = Date.now(); firstSid = done1.sessionId; }
    const why = other && (m.waiting || {})[other.id];
    if (why && /free slot/i.test(why)) sawWaitWords = why;
    if (m.autoSlots?.open?.length) sawFacts = m.autoSlots;
  });

  // Poll rather than react: the facts that matter are what has NOT happened
  // after the linger and the reap floor have both long passed.
  const poll = setInterval(() => {
    if (finished || !firstDoneAt) return;
    if (!closedByUs && Date.now() - firstDoneAt > 4000) {
      check(!!firstSid && !closedIds.includes(firstSid),
        `the finished item's session is still open well past the linger and the reap floor (${firstSid})`);
      check(/1 automatic session open \(close one to make room\)/.test(sawWaitWords),
        `the second item says it is waiting for a person to close one (${JSON.stringify(sawWaitWords)})`);
      check(sawFacts?.max === 1 && sawFacts.open.some((s) => s.id === firstSid && s.closeWhenDone === false),
        `backlog.list carries the open session as a fact, not set to close (${JSON.stringify(sawFacts)})`);
      closedByUs = true;
      ws.send(JSON.stringify({ t: "session.remove", id: firstSid }));
      // …and the second item now gets the slot.
      const waitRun = setInterval(() => {
        ws.send(JSON.stringify({ t: "backlog.list" }));
      }, 500);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t !== "backlog.list" || finished) return;
        const items = m.items.filter((i) => dirs.includes(i.repoDir));
        if (items.length === 2 && items.every((i) => i.status === "done")) {
          finished = true;
          clearInterval(waitRun); clearInterval(poll); clearTimeout(bail);
          check(true, "a person's close freed the slot and the second item ran");
          ws.close();
          done();
        }
      });
    }
  }, 250);
});
