// A prompt LONGER THAN THE COMPOSER is delivered — and submitted.
//
// Regression for the failure the live host filed 45% of the time on every
// message between 300 and 800 characters, against 17% on the short ones.
//
// The composer is a VIEWPORT, not a field. The CLI sizes it off the terminal's
// height and scrolls the text inside it, so a prompt longer than that viewport
// is only partly drawn — and after a write the cursor is at the end, so the
// part drawn is the TAIL. Measured against the 2.1.267 binary at 56 columns, a
// 632-character prompt shows 3 composer rows at a terminal height of 12, 5 at
// 20, and all 14 at 40: the heights a phone reports are exactly the ones that
// hide it. Every screen rule asked for the fourteen-character HEAD, which is
// off the top of the box, and under 800 characters the CLI collapses nothing,
// so the placeholder rule that rescues the longer prompts cannot speak about
// these at all. The prompt echoed perfectly, read as never typed, came back
// `unconfirmed` (the verdict that is never auto-retried) and sat one keypress
// from running behind a gravestone.
//
// So: everything the box is holding being a window onto this text is an echo
// (`echo.ts`'s `scrolled` rule). What must hold here is the whole contract at
// once — the text is written exactly ONCE, Return is pressed after it, and the
// item completes rather than failing "not confirmed".
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8886;
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The live capture's own shape: one line, no newline anywhere in it, 632
// characters — comfortably past the three rows the box draws and comfortably
// short of the 800 at which the CLI would collapse it into a placeholder.
const TEXT = "Can we have this run in the background automatically to bring the time to a"
  + " minimum that images take to show up in the gallery? If yes make this an option in"
  + " the user settings. Next independent request: I want to be able to rotate more than"
  + " one image at once with the already existing multi selection option from the"
  + " gallery. Spawn sub agents for implementation. Plan with opus. And do a review"
  + " before finishing. The screenshot is in the inbox and the three marked regions are"
  + " the gallery, the rotate control and the settings row.";
const HEAD = "Can we have this run in the background";
const TAIL = "the rotate control and the settings row";

const root = mkdtempSync(join(tmpdir(), `${SLUG}-scroll-`));
const log = join(root, "stub-input.log");
writeFileSync(log, "");
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(root),
  [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
  STUB_MODE: "scroll", STUB_LOG: log,
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
await waitForHost(PORT);

const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "scroll" }),
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
      ws.send(JSON.stringify({ t: "backlog.add", text: TEXT, repoDir: repo.path, label: "scrolled task" }));
      return;
    }
    const rows = m.items ?? [];
    const mine = rows.find((r) => r.text === TEXT);
    if (mine) item = mine;
    if (rows.length >= 1 && rows.every((it) => it.status === "done" || it.status === "failed")) resolve();
  });
  setTimeout(resolve, 60000);
});

let raw = "";
try { raw = readFileSync(log, "utf8"); } catch { /* nothing arrived */ }
const copies = raw.split(HEAD).length - 1;
const headAt = raw.indexOf(HEAD);
// A Return written AFTER the text — the submit keystroke, which the old code
// never reached because it gave up at the echo check.
const submitted = headAt >= 0 && raw.indexOf("\r", raw.indexOf(TAIL)) > headAt;

ws.close();
host.kill();
await sleep(200);

check(copies === 1, `scrolled composer: instruction written exactly once (copies: ${copies})`);
check(submitted, "scrolled composer: Return pressed after the text (fired, not left in the composer)");
check(item?.status === "done", `scrolled composer: item completed, not failed as unconfirmed (status: ${item?.status}, error: ${item?.error || "-"})`);

process.exit(failed ? 1 : 0);
