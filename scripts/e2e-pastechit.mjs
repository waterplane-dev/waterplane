// A LONG, MULTI-LINE instruction is delivered — and submitted.
//
// Regression for the "it typed the prompt into the CLI but never fired it" bug,
// hit by the Build sheet's one-tap "set up" prompt (15 lines, ~1.5 KB).
//
// The host writes the whole instruction in one chunk, which is indistinguishable
// from a paste, and the claude TUI COLLAPSES a paste: the composer shows
// `[Pasted text #1 +11 lines]` followed by whatever tail still fits. The echo
// check looks for the HEAD of the text (`echoProbe`), and the head is precisely
// what the placeholder hides — so a prompt that echoed perfectly read as never
// typed, came back `unconfirmed` (the verdict that is never auto-retried), and
// sat in the composer one keypress from running while the queue displayed a
// gravestone.
//
// So: the placeholder is an echo, provided it can be tied to THIS text (its tail
// is on screen, or the hidden-line count accounts for all of it). What must hold
// here is the whole contract at once — the text is written exactly ONCE, Return
// is pressed after it, and the item completes rather than failing "not
// confirmed".
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, NAME, SHARED, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8880;
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shaped like the real SETUP_PROMPT: many lines, and a tail that is nowhere
// near the head (the head is what the placeholder swallows).
const TEXT = [
  `Set up ${NAME}'s build buttons for this repo.`,
  "",
  `${NAME} can run shell commands in this repo without a Claude session.`,
  "",
  "1. Work out how this project really builds and packages, from the repo itself.",
  `2. Write ${SHARED}/builds.json: a JSON array of objects { id, name, cmd, dir }.`,
  "   - id: short unique slug.",
  "   - name: short button label, e.g. Release APK.",
  "   - cmd: ONE shell command line, run by the login shell.",
  "3. Prefer commands that produce a downloadable artifact.",
  "4. Every command must be non-interactive and must not publish anything.",
  "5. Check each command actually exists before writing it down.",
  "6. Finish with one line per button you wrote, and say what you skipped.",
].join("\n");
const HEAD = `Set up ${NAME}'s build buttons`;
const TAIL = "say what you skipped";

// The OTHER collapse trigger: length alone, with no newline in it. The composer
// collapses anything past ~800 characters whatever its shape, and the
// placeholder it draws for a one-liner carries no `+N lines` clause — it counts
// NEWLINES and there are none. So the screen holds `[Pasted text #1]` and
// nothing else: no head, no tail, no count. A rule that required the clause
// matched none of these, which is every long message typed on a phone.
const ONE = "Tidy the flaky retry test and explain the fix: " +
  "with enough context past eight hundred characters that the composer collapses it on length alone. ".repeat(12) +
  "and finish with one sentence, exactly once please.";
const ONE_HEAD = "Tidy the flaky retry test";
const ONE_TAIL = "exactly once please";

const root = mkdtempSync(join(tmpdir(), `${SLUG}-paste-`));
const log = join(root, "stub-input.log");
writeFileSync(log, "");
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(root),
  [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
  STUB_MODE: "paste", STUB_LOG: log,
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
await waitForHost(PORT);

const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "paste" }),
}).then((r) => r.json());

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let item = null;
let oneItem = null;
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
      ws.send(JSON.stringify({ t: "backlog.add", text: TEXT, repoDir: repo.path, label: "paste task" }));
      ws.send(JSON.stringify({ t: "backlog.add", text: ONE, repoDir: repo.path, label: "one-line paste task" }));
      return;
    }
    const terminal = (it) => it && (it.status === "done" || it.status === "failed");
    const rows = m.items ?? [];
    const mine = rows.find((r) => r.text === TEXT);
    const one = rows.find((r) => r.text === ONE);
    if (mine) item = mine;
    if (one) oneItem = one;
    if (rows.length >= 2 && rows.every(terminal)) resolve();
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

check(copies === 1, `collapsed paste: instruction written exactly once (copies: ${copies})`);
check(submitted, "collapsed paste: Return pressed after the text (the prompt was fired, not left in the composer)");
check(item?.status === "done", `collapsed paste: item completed, not failed as unconfirmed (status: ${item?.status}, error: ${item?.error || "-"})`);

// The same contract for the placeholder that says NOTHING — no count, no tail.
const oneCopies = raw.split(ONE_HEAD).length - 1;
const oneAt = raw.indexOf(ONE_HEAD);
const oneSubmitted = oneAt >= 0 && raw.indexOf("\r", raw.indexOf(ONE_TAIL)) > oneAt;
check(oneCopies === 1, `bare placeholder: one-liner written exactly once (copies: ${oneCopies})`);
check(oneSubmitted, "bare placeholder: Return pressed after the one-liner");
check(oneItem?.status === "done", `bare placeholder: item completed, not failed as unconfirmed (status: ${oneItem?.status}, error: ${oneItem?.error || "-"})`);

process.exit(failed ? 1 : 0);
