// A WORK ITEM whose own session dies at the usage limit follows the revival —
// and runs exactly once.
//
// This is the sharpest rule in "every backlog item gets its own conversation",
// and the one an e2e has to hold because nothing on a screen shows it.
//
// A `running` row whose session dies is normally REQUEUED when the death was a
// usage limit, and for the old model that was right: every item in a repo shared
// one `backlog · <repo>` session, `resolveRepoSession` followed the
// resurrection, and the requeued row landed back in the same conversation. Now
// that a fired item opens a session FOR ITSELF, a requeue would run the work
// TWICE — the host `--continue`s that very conversation at the reset AND the
// queued row opens a second session to run the same words in. So the row is held
// `running`, says what it is waiting for, and is re-aimed at the revival when it
// appears.
//
// And it holds for the SECOND wall as well, which is the one that shipped broken.
// The exemption was read off the row's TARGET ("this row opens its own
// session"), and the re-aim rewrites that target to a `session` one — so at wall
// 2 the row took the ordinary branch, went `queued`, and the tick's re-aim then
// typed the whole item into the session that was already `--continue`ing its own
// conversation. Two walls is the NORMAL shape for a weekly limit, not an edge: a
// weekly-limited session is reopened five seconds later ("an upgraded plan
// continues now") and hits the same wall by construction. So this script walks
// the row through two of them and counts the sessions.
//
// Its own script rather than a case inside `e2e-resurrect.mjs`, for a reason
// that is about the host and not about tidiness: a limit is an ACCOUNT fact, so
// limit-blocked sessions are resumed one at a time and the first of a wave goes
// alone. A fourth session exiting at the limit in the same run joins that wave
// and waits behind a resurrection whose verdict is not in yet — which would make
// this script a measurement of the resume queue instead of the rule it is about.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8818;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-resitem-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.LIMIT_PROBE_MS]: "1200",   // the backoff's first rung (5 s in production) — the one this test waits out
  // …and the rungs behind it, because this script is about the SECOND wall: the
  // block now carries across a resurrection (`adoptCarriedBlock`), so wall two
  // starts at rung 1 rather than at the probe.
  [E.LIMIT_LADDER_MS]: "1200,1200,1200",
  [E.LIMIT_RETRY_MS]: "1200",   // no reset time in the banner → resurrect at now+1200ms
  // The item must still be RUNNING when its session hits the limit: on an
  // unhooked stub the silence fallback is the only other way a row can end, and
  // a row that finished first would be testing nothing.
  [E.IDLE_MS]: "30000",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = () => { try { host.kill(); } catch { /* already gone */ } setTimeout(() => process.exit(failed ? 1 : 0), 150); };
const bail = setTimeout(() => { check(false, "timed out"); done(); }, 45000);
const BANNER = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";

bootWait(PORT, 900, async () => {
  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "atlimit" }) }).then((r) => r.json());
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  const b64 = (x) => Buffer.from(x, "base64").toString("utf8");

  let added = false;
  /** Sessions born in this repo: its own, and the two that replace it across two
   *  walls. A FOURTH would be the requeue this whole case exists to rule out. */
  let born = 0;
  let firstSid = null;
  let secondSid = null;
  let nowSid = null;
  /** Which wall the script has driven. */
  let wall = 0;
  let attached = false;
  /** The item's own words coming back off the screen — proof the delivery
   *  LANDED. Killing a session MID-delivery is a different verdict (`retry`,
   *  which legitimately requeues, because provably nothing was typed). */
  let landed = false;
  let requeued = false;
  let driven = false;
  /** The sentence the row wears while it is following its session. Read off
   *  `intent.changed` and not off `backlog.list`: the backlog's `waiting` map is
   *  only about QUEUED rows, and the whole point here is that this one is not. */
  const said = new Set();

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "intent.changed" && m.intent.cwd === repo.path && m.intent.blockDetail) { said.add(m.intent.blockDetail); return; }
    if (m.t === "pty") { if (b64(m.dataB64).includes("ITEM_AT_THE_LIMIT")) landed = true; return; }
    if (m.t === "session.created") { if (m.session.cwd === repo.path) born++; return; }
    if (m.t !== "backlog.list") return;
    if (!added) {
      added = true;
      send({ t: "backlog.add", text: "echo ITEM_AT_THE_LIMIT", repoDir: repo.path, label: "at the limit", fire: true });
      return;
    }
    const row = m.items.find((i) => i.repoDir === repo.path);
    if (!row) return;
    if (row.sessionId) {
      if (!firstSid) firstSid = row.sessionId;
      nowSid = row.sessionId;
      if (!attached) { attached = true; send({ t: "session.attach", id: row.sessionId }); }
    }
    if (firstSid && row.status === "queued") requeued = true;
    /** Print the banner into a session, then quit it: the tail shows the limit,
     *  so the host reopens that conversation with `--continue` at the reset. */
    const hitTheWall = (sid) => {
      send({ t: "session.input", id: sid, data: `echo "${BANNER}"\r` });
      setTimeout(() => send({ t: "session.input", id: sid, data: `exit\r` }), 400);
    };

    if (landed && !driven) {
      driven = true;
      wall = 1;
      check(!!firstSid, `the item got a session of its own (${JSON.stringify(firstSid)})`);
      hitTheWall(firstSid);
      return;
    }
    // Wall 1 is over the moment the row is aimed somewhere new. Drive the SAME
    // row into a second wall — which is what a weekly limit does on its own.
    if (wall === 1 && nowSid && nowSid !== firstSid) {
      wall = 2;
      secondSid = nowSid;
      check(!requeued, "after wall 1 it was never put back in the queue");
      hitTheWall(secondSid);
      setTimeout(() => {
        clearTimeout(bail);
        check(!requeued, "it was NEVER put back in the queue — a requeue would run the words a second time");
        check(!!nowSid && nowSid !== secondSid, `it followed the SECOND resurrection too (${JSON.stringify(secondSid)} → ${JSON.stringify(nowSid)})`);
        check(born === 3, `three sessions in that repo all told — its own and one per wall (born ${born})`);
        check([...said].some((r) => /usage limit — following it to the reopened one/i.test(r)),
          `while it waited it said what it was following (${JSON.stringify([...said])})`);
        check(![...said].some((r) => /it will run again when the session reopens/i.test(r)),
          `and it never said the requeue sentence (${JSON.stringify([...said])})`);
        ws.close();
        done();
      }, 6000);
    }
  });
});
