// Backlog instruction delivery: the text reaches the session EXACTLY ONCE.
//
// Regression for the repeated-prompt bug: the echo check ANSI-stripped a byte
// window off the tail of the raw capture, but one claude-TUI repaint is tens of
// KB, so text that was plainly on screen read as "not echoed". feed() then
// retyped it up to 3×, and fireItem re-ran feed() up to MAX_FIRE_ATTEMPTS — the
// same instruction landed in the session ~15 times.
//
// Three shapes, all of which must write the text once and only once:
//   repaint — composer visible but buried behind trailing repaint bytes → delivered
//   blind   — input never echoes → NOT delivered, and never auto-retried
//   deaf    — the text echoes but every Return is swallowed (hooked session, so
//             the missing turn is provable) → the item must FAIL saying the
//             prompt is sitting unsent, not report a turn that never started.
//             Regression for: a fan-out reported every repo "running" while each
//             session held an un-run prompt, because output growth (a repainting
//             TUI always grows) was taken as proof the Return landed.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

// One literal port per host, each its own: `run-e2e.mjs` learns a script's ports by reading
// the literals in its source (`portsOf`), so a host on `PORT + 1` was on a port the runner
// never knew about. It was the port four other scripts declare — and `e2e-restore`, running
// beside this one, restarted its host into the gap and read ANOTHER root's recent list
// ("survives restart … (got 0)"). Never derive a port by arithmetic here.
const PORT = 8812, PORT_BLIND = 8826, PORT_DEAF = 8827;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-blecho-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEXT = ".... Should we start using Gemini 3.7 flash or would we not benefit from this brand new released model?";
const PROBE = "Should we start using Gemini";

/** Occurrences of the instruction in what the stub actually received. */
function copiesWritten(log) {
  let raw = "";
  try { raw = readFileSync(log, "utf8"); } catch { return 0; }
  return raw.split(PROBE).length - 1;
}

/**
 * Boot a host whose `claude` is the fake TUI in `mode`, queue one item, and
 * report what the stub received plus the item's final state.
 */
async function run(mode, port, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), `${SLUG}-blecho-${mode}-`));
  const log = join(root, "stub-input.log");
  writeFileSync(log, "");
  const env = {
    ...process.env,
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(port), [E.HOST]: "127.0.0.1", ...rootEnv(root),
    [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
    STUB_MODE: mode, STUB_LOG: log,
    ...extraEnv,
  };
  const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write(`[host:${mode}] ` + d));
  const base = `http://127.0.0.1:${port}`;
  await waitForHost(port);

  const repo = await fetch(`${base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "echo" }),
  }).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let item = null;
  let started = false;
  await new Promise((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t !== "backlog.list") return;
      if (!started) {
        started = true;
        ws.send(JSON.stringify({ t: "backlog.openRepoSession", repoDir: repo.path }));
        ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true }));
        ws.send(JSON.stringify({ t: "backlog.add", text: TEXT, repoDir: repo.path, label: "echo task" }));
        return;
      }
      const it = m.items[0];
      if (it) item = it;
      if (it && (it.status === "done" || it.status === "failed")) resolve();
    });
    // Cap the wait: `blind` burns MAX_FIRE_ATTEMPTS worth of ticks before failing.
    setTimeout(resolve, 60000);
  });

  const copies = copiesWritten(log);
  ws.close();
  host.kill();
  await sleep(200);
  return { copies, item };
}

const repaint = await run("repaint", PORT);
check(repaint.copies === 1, `repaint TUI: instruction written exactly once (copies: ${repaint.copies})`);
check(repaint.item?.status === "done", `repaint TUI: item delivered and completed (status: ${repaint.item?.status}, error: ${repaint.item?.error || "-"})`);

const blind = await run("blind", PORT_BLIND);
check(blind.copies === 1, `unreadable screen: instruction written at most once, never re-hammered (copies: ${blind.copies})`);
check(blind.item?.status === "failed", `unreadable screen: item flagged, not silently retried (status: ${blind.item?.status})`);
check(/not confirmed/i.test(blind.item?.error || ""), `unreadable screen: error names the ambiguity (error: ${JSON.stringify(blind.item?.error)})`);

const deaf = await run("deaf", PORT_DEAF, { STUB_HOOKS: "1" });
check(deaf.copies === 1, `swallowed Return: instruction still written exactly once (copies: ${deaf.copies})`);
check(deaf.item?.status === "failed", `swallowed Return: item is NOT reported as running/done (status: ${deaf.item?.status})`);
check(/Return/.test(deaf.item?.error || ""), `swallowed Return: error says the prompt is sitting unsent (error: ${JSON.stringify(deaf.item?.error)})`);

process.exit(failed ? 1 : 0);
