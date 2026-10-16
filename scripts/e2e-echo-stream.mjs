// The echo is placed by the BOX it is in, not by how far up the render it sits.
//
// The failure this pins was ~30% of deliveries on the live host, and it was
// never that the text could not be found. It was found and then refused: the
// old rule accepted a hit only within ~11 rows of the last row of the rendered
// capture, and `render.ts` replays the whole buffer into a fixed 50-row VT, so
// a repaint caught mid-turn leaves a DUPLICATED footer and rows of streaming
// turn output sitting UNDER the newest composer frame. Distance from the bottom
// of the render measures that tear; it does not measure the composer.
//
// What the refusal cost, in order: `unconfirmed` — the verdict that is never
// auto-retried — for a prompt in plain sight; then the miss sweep's Esc into a
// running turn, interrupting it; then six ctrl-Us deleting the interjection
// that HAD landed; then a re-send of the same words minutes later.
//
// `STUB_MODE=stream` draws exactly that shape: a real `❯`-plus-rules composer
// frame with twelve rows of turn output and a doubled footer below it. Every
// other stub mode draws the plain `> ` composer with no rules, which exercises
// the no-box FALLBACK — so this script is the only end-to-end coverage of the
// structural rule, and the assertions are the three things the bug destroyed:
// the verdict, the health signal, and the keystrokes that must never be sent.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { cleanHealth } from "../packages/shared/dist/clihealth.js";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8863;
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEXT = "Yes all 3 — and say which of the three you finished first";
const PROBE = "Yes all 3";

const root = mkdtempSync(join(tmpdir(), `${SLUG}-echostream-`));
const log = join(root, "stub-input.log");
writeFileSync(log, "");

const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(root),
  [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
  STUB_MODE: "stream", STUB_LOG: log,
  // The spawn grace that stops a brand-new session filing a fallback before
  // its first hook could have arrived — a real rule, so it is shortened rather
  // than removed, or this script's one observation never reaches the file.
  [E.HEALTH_GRACE_MS]: "1",
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[stream] " + d));
const base = `http://127.0.0.1:${PORT}`;
await waitForHost(PORT);

const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "echostream" }),
}).then((r) => r.json());

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
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
      ws.send(JSON.stringify({ t: "backlog.add", text: TEXT, repoDir: repo.path, label: "torn render" }));
      return;
    }
    const it = m.items[0];
    if (it) item = it;
    if (it && (it.status === "done" || it.status === "failed")) resolve();
  });
  setTimeout(resolve, 60000);
});

// The health record is DEBOUNCED, so give the flush a moment before reading it.
await sleep(2500);
const readHealth = () => {
  try { return cleanHealth(JSON.parse(readFileSync(join(root, STATE, "clihealth.json"), "utf8"))); }
  catch { return null; }
};
const health = readHealth();
const typed = readFileSync(log, "utf8");
ws.close();
host.kill();
await sleep(200);

const copies = typed.split(PROBE).length - 1;
check(copies === 1, `torn render: instruction written exactly once (copies: ${copies})`);
check(item?.status === "done",
  `torn render: delivery confirmed from inside the box (status: ${item?.status}, error: ${item?.error || "-"})`);

// The signal, not just the verdict. A delivery that came back `ok` through the
// conversation-log RESCUE would also read `done` above, and that is the primary
// rule still not answering — which is exactly the reading that was amber for a
// week. So assert the last observation is a plain good with no fallback on it.
const sig = health?.signals["deliver.echo"];
const last = sig?.window?.at(-1);
check(!!sig, "the host recorded an observation against deliver.echo");
check(last?.ok === true, `…and it is a good, not a miss (${JSON.stringify(last ?? null)})`);
check(!last?.fallback, "…with no fallback flag — the echo check itself answered, nothing rescued it");
check((sig?.misses ?? 0) === 0, `no misses on the signal at all (misses: ${sig?.misses ?? 0})`);

// The keystrokes. An Esc at a session that is running INTERRUPTS the turn, and
// the ctrl-U sweep behind it deletes text that had landed — the two bytes the
// miss path sends and this delivery must never have reached.
check(!typed.includes("\x1b"), "no Esc ever reached the session");
check(!typed.includes("\x15"), "no ctrl-U sweep over a composer that was fine");

process.exit(failed ? 1 : 0);
