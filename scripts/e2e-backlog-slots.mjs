// The cap on automatic sessions, as a rung — and how it frees itself: a working
// session going idle (R-automation-042). Nothing is closed to make room.
//
// Every fired work item opens a session of its own now, which means the bound on
// how many `claude` processes machinery may have running is the difference
// between "a week of due work" and a dozen agents starting inside one minute.
// That bound used to live in a side door: the host was asked to open a session,
// refused with a string ("waiting for a free backlog session — …open this repo's
// backlog session yourself"), and the row wore a sentence produced by a ladder
// nobody could see from the row. It is `intentVerdict`'s rung 4.6 now
// (`noSlot`, fed by `IntentFacts.autoSlotsFree`), so it reads like every other
// wait and the numbers in it come from the host that knows them.
//
// Five facts, none of which a screen shows and all of which fail quietly:
//
//  1. with ONE slot, one item runs at a time — across DIFFERENT repos, so this
//     is the cap and not `serial`;
//  2. each of them still gets its own conversation;
//  3. the ones that are waiting SAY they are waiting for a slot, with the
//     desktop's real numbers in the sentence;
//  4. the slot frees itself when the working session goes IDLE — with *close
//     automatic sessions when done* ON and a ten-minute linger, a closed
//     session here could only be a reap made to free a slot, and there is none:
//     an idle session holds no slot, so closing one would free nothing;
//  5. …and they run IN THE ORDER THEY WERE ADDED: the freed slot goes to the
//     NEXT TICK's fresh count, which hands it to the first row in order, never
//     to the rows behind it.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, LS, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8817;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-slots-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  // ONE slot: the whole point. Three items in three repos then have nothing to
  // wait on but the cap.
  [E.BACKLOG_SESSIONS]: "1",
  [E.IDLE_MS]: "1200",
  // The no-hook silence floor is a minute in production; a test cannot sit out
  // three of them. The linger is left long, so a session closed here could only
  // have been closed to make room — which must not happen.
  [E.BACKLOG_REAP_IDLE_MS]: "600",
  [E.BACKLOG_LINGER_MS]: "600000",
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
  const repos = [await mk("slot-a"), await mk("slot-b"), await mk("slot-c")];
  const dirs = repos.map((r) => r.path);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let added = false;
  let settled = false;
  /** item id → session id. Three items must make three conversations. */
  const sidOf = new Map();
  /** The most items seen `running` in any one frame. One slot, one item. */
  let peakRunning = 0;
  /** Every "waiting for a slot" sentence seen, so the numbers can be asserted. */
  const slotReasons = new Set();
  /** Session ids the host has listed as recently closed. */
  let closedIds = [];
  /** The order the three items actually STARTED in — a cap test that only
   *  counts cannot see an inverted queue. */
  const runOrder = [];

  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "closed.list") { closedIds = m.closed.map((c) => c.id); return; }
    if (m.t !== "backlog.list") return;
    if (!added) {
      added = true;
      // The close-when-done half (`e2e-backlog-keepopen.mjs` is the default,
      // off): switched on first, exactly as the phone would, so that a reap —
      // if anything still made one — would be allowed to close these.
      ws.send(JSON.stringify({ t: "settings.set", key: `${LS}backlog.closeWhenDone`, value: "1", ts: Date.now(), device: "e2e" }));
      ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true }));
      dirs.forEach((dir, i) => ws.send(JSON.stringify({ t: "backlog.add", text: `echo SLOT_${i}`, repoDir: dir, label: `item ${i}` })));
      return;
    }
    const items = m.items.filter((i) => dirs.includes(i.repoDir));
    const w = m.waiting || {};
    peakRunning = Math.max(peakRunning, items.filter((i) => i.status === "running").length);
    for (const i of items) {
      if (i.sessionId) sidOf.set(i.id, i.sessionId);
      if ((i.status === "running" || i.status === "done") && !runOrder.includes(i.label)) runOrder.push(i.label);
      const why = w[i.id];
      if (why && /free slot/i.test(why)) slotReasons.add(why);
    }
    if (items.length === 3 && items.every((i) => i.status === "done") && !settled) {
      settled = true;
      clearTimeout(bail);
      check(peakRunning === 1, `one slot, one item at a time — across three different repos (peak ${peakRunning})`);
      const sids = new Set(sidOf.values());
      check(sids.size === 3, `each item still ran in a conversation of its own (saw ${sids.size} for 3 items)`);
      const said = [...slotReasons];
      check(said.length > 0, `the waiting items said what they were waiting for (${JSON.stringify(said)})`);
      check(said.some((r) => /1 automatic session at a time/i.test(r)),
        `…with THIS desktop's numbers in it, not a guess at the default (${JSON.stringify(said)})`);
      // The linger window here is ten minutes and the run is seconds, so a
      // closed session could only have been closed to make room.
      const closed = [...sids].filter((id) => closedIds.includes(id));
      check(closed.length === 0,
        `nothing was closed to make room — the slot freed itself when the working session went idle (${closed.length} closed)`);
      check(runOrder.join(" → ") === "item 0 → item 1 → item 2",
        `…and they ran in the order they were added, not backwards (${runOrder.join(" → ")})`);
      ws.close();
      done();
    }
  });
});
