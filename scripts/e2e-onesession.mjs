// Two items in ONE repo get TWO conversations — and still run one at a time.
//
// This script used to pin the opposite ("both items used ONE session"), and the
// inversion is the point of the change it now guards. The old model appended
// every item a repo ever queued into one `backlog · <repo>` session that nothing
// ever closed. `shared/sessioncost.ts` computes what that costs: every turn
// re-sends the whole conversation, so a window sitting at k× its own baseline
// pays `k·base·R` per turn for ever while a fresh one pays one `base·W` and
// `base·R` after that — break-even at ~8 turns for 2.5×, ~3 for 5×, ~1 for 9×.
// A backlog session reaches 5× within a handful of items, because each item
// reads ITS OWN files into the window and none of that helps the next. The
// desktop-wide measurement in CLAUDE.md is the same shape: 124 conversations out
// of 8,968 grew past 200k and were 76% of every token spent.
//
// So the three facts below, which have to hold together: each item gets its own
// session (the cost argument), never two at once in one repo (`serial` — five
// due items must not put five agents in one worktree), and they run in the order
// they were added, which is the only thing that makes a queue a queue.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const PORT = 8809;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-os-`));
const env = { ...process.env, [E.PREFLIGHT]: "0", [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT), [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh", [E.IDLE_MS]: "1200" };
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };

bootWait(PORT, 900, async () => {
  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "os" }) }).then((r) => r.json());
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let added = false;
  let bothDone = false;
  /** sessionId per item id — two items must not share one. */
  const sidOf = new Map();
  /** The order items were first seen RUNNING, by label. Two items added a
   *  moment apart run in the order they were added — the second one is held by
   *  `serial` until the first is finished with the worktree. (The LIST shows
   *  them the other way up: an un-pinned add goes newest-on-top, which is a
   *  statement about what you read first, not about what runs first.) */
  const runOrder = [];
  let everTwoRunning = false;

  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t !== "backlog.list") return;
    if (!added) {
      added = true;
      ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true }));
      // No `backlog.openRepoSession`: firing opens a session FOR each item now,
      // which is the whole thing under test.
      ws.send(JSON.stringify({ t: "backlog.add", text: "echo ITEM_ONE", repoDir: repo.path, label: "one" }));
      ws.send(JSON.stringify({ t: "backlog.add", text: "echo ITEM_TWO", repoDir: repo.path, label: "two" }));
      return;
    }
    const mine = m.items.filter((i) => i.repoDir === repo.path);
    if (mine.filter((i) => i.status === "running").length > 1) everTwoRunning = true;
    for (const i of mine) {
      if (i.sessionId) sidOf.set(i.id, i.sessionId);
      if (i.status === "running" && !runOrder.includes(i.label)) runOrder.push(i.label);
    }
    if (mine.length === 2 && mine.every((i) => i.status === "done") && !bothDone) {
      bothDone = true;
      const sids = new Set(sidOf.values());
      check(sids.size === 2, `each item ran in a conversation of its own (saw ${sids.size} session id${sids.size === 1 ? "" : "s"} for 2 items)`);
      check(!everTwoRunning, "never two running at once in one repo — one worktree, one agent");
      check(runOrder.length === 2 && runOrder[0] === "one" && runOrder[1] === "two",
        `they ran in the order they were added (ran ${JSON.stringify(runOrder)})`);
      ws.close();
      host.kill();
      setTimeout(() => process.exit(failed ? 1 : 0), 100);
    }
  });
});
setTimeout(() => { console.log("FAIL: timeout"); host.kill(); process.exit(1); }, 25000);
