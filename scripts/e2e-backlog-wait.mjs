// Why is this item still queued?
//
// A queued backlog row used to look identical whether the backlog was waiting
// exactly as designed or was stuck on something only the host can see — auto-fire
// switched off, no session open for the repo, the session already running another
// item, the agent mid-turn. From the phone those are indistinguishable, which is
// the same gap `pulls.whyIdle()` closes for downloads.
//
// So `backlog.list` carries a per-item reason (`BacklogManager.waiting()`), and
// this pins the states that are separable without a real TUI. The reason must
// track the ladder that actually DECIDES — an explanation that disagrees with
// the behaviour is worse than none — so it is checked against the item's real
// fate in the same run: the one that reads "one at a time in this repo" must be
// behind an item that genuinely is running.
//
// Two of those states have changed shape, and the sentences here are what
// records it. "No backlog session open for this repo" was a wait NOTHING ended:
// forty rows across twelve repos sat on it, the oldest for three months, every
// one of them auto-fire work that was due. There is no such wait any longer — a
// fired item OPENS a session, so the ladder never reaches that rung for one. What
// is pinned instead is the half that did not change and is the whole reason the
// rule existed: automatic work never lands in the session you are driving by
// hand. It gets one of its own, and the hand-driven one is left alone.
//
// And the second item now waits on `serial` rather than on the first item's
// session being busy — one at a time in this repo. That rung is what stops five
// due items putting five agents in one worktree, which is a thing that could not
// happen while every item in a repo shared one session.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8813;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-blwait-`));
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  // Deliberately generous: the silence heuristic is also what ends an item, so a
  // short window would let the first item complete inside the moment this test
  // needs it to still be running.
  [E.IDLE_MS]: "3000",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = () => { host.kill(); setTimeout(() => process.exit(failed ? 1 : 0), 100); };
const bail = setTimeout(() => { check(false, "timed out"); done(); }, 40000);

bootWait(PORT, 900, async () => {
  const repo = await fetch(`${base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "waitwhy" }),
  }).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let phase = 0;
  let firstId = null;
  let secondId = null;
  /** The session the USER opened — the one automatic work may never use. */
  let handSession = null;
  const seen = [];
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created" && !handSession) handSession = m.session.id;
    if (m.t !== "backlog.list") return;
    const items = m.items.filter((i) => i.repoDir === repo.path);
    const w = m.waiting || {};
    const first = items.find((i) => i.id === firstId);

    if (phase === 0) {
      phase = 1;
      // Auto-fire is off by default and no session is open — the item can only sit.
      ws.send(JSON.stringify({ t: "backlog.add", text: "echo BLWAIT_ONE", repoDir: repo.path, label: "one" }));
      return;
    }
    if (phase === 1 && items.length === 1) {
      phase = 2;
      firstId = items[0].id;
      check(/\bauto is off\b/i.test(w[firstId] || ""), `auto off is named as the reason (got: ${JSON.stringify(w[firstId])})`);
      // A session the USER opened, created FIRST so that the state under test
      // exists before the switch is flipped: with auto on and a live hand-driven
      // session in the repo, the item must still get one of its own.
      ws.send(JSON.stringify({ t: "session.create", cwd: repo.path }));
      setTimeout(() => ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true })), 800);
      return;
    }
    if (phase === 2 && m.auto) {
      // Reasons are re-broadcast when the WORDS change, which is the other half
      // of this feature: they describe sessions, and a session moves without the
      // backlog moving at all.
      if (w[firstId]) seen.push(w[firstId]);
      if (!first || !first.sessionId || (first.status !== "running" && first.status !== "done")) return;
      phase = 3;
      check(!seen.some((r) => /\bauto is off\b/i.test(r)),
        `with the switch on, the reason stopped being about the switch (saw: ${JSON.stringify([...new Set(seen)])})`);
      check(first.sessionId !== handSession,
        `it ran in a session of its OWN, never the hand-driven one (item ${first.sessionId} vs hand ${handSession})`);
      check(!(firstId in w), "a running item is not in the waiting map at all");
      // One at a time in this repo: a second item queued now must say so.
      ws.send(JSON.stringify({ t: "backlog.add", text: "echo BLWAIT_TWO", repoDir: repo.path, label: "two" }));
      phase = 4;
      return;
    }
    if (phase === 4 && items.length === 2) {
      const second = items.find((i) => i.id !== firstId);
      secondId = second.id;
      if (first && first.status === "running") {
        phase = 5;
        check(/one at a time in this repo/i.test(w[secondId] || ""),
          `the repo being busy is named as the reason (got: ${JSON.stringify(w[secondId])})`);
        check(second.status === "queued", "and the second item is genuinely queued behind the first");
        clearTimeout(bail);
        ws.close();
        done();
      }
      return;
    }
  });
});
