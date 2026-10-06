// Delivery of a TUI-LOCAL slash command — `/cost`, `/usage`, `/context`, …
//
// These are the commands `claude` handles inside its own TUI: they open a view
// and never submit a prompt. Both halves of the normal delivery contract broke
// on them, and the user saw one symptom — "the info screen I asked for closes
// itself, and the app says the message wasn't delivered".
//
//  1. THE ECHO WINDOW. Typing `/cost` opens the completion menu BELOW the input
//     box — a row per command plus a wrapped description. The composer check
//     read only the bottom ~11 rows, so the echo sat ~17 rows above the window:
//     text plainly on screen, read as never typed ⇒ `unconfirmed`, and the
//     "sweep the composer in case it landed" path then pressed Esc, which is
//     what closed the menu/view. Hence: no Esc is ever sent for a local command,
//     and the composer check places the echo instead of slicing rows off the
//     bottom.
//
//  2. THE SUBMIT PROOF. A local command fires no `UserPromptSubmit`, so on a
//     hooked session the turn-start proof can never arrive — the host pressed
//     Return five times, the first opened the view and the other four dismissed
//     it, and the verdict was `unsubmitted` for a command that had run. The
//     proof that fits is the screen MOVING, which is self-limiting: once a view
//     is up, the screen has changed and no further Return is sent.
//
// The list is POSITIVE (`isLocalCommand`): `/init`, `/compact`, `/review` and
// every custom `.md` command really do start a turn, and case 3 pins that they
// keep the ordinary contract — including the widened echo check, which they
// need just as much (their completion menu looks exactly the same).
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot a host whose `claude` is the completion-menu TUI, with hooks live. */
async function boot(port) {
  const root = mkdtempSync(join(tmpdir(), `${SLUG}-slashlocal-`));
  const log = join(root, "stub-input.log");
  writeFileSync(log, "");
  const host = spawn("node", ["packages/host/dist/main.js"], {
    env: {
      ...process.env,
      [E.PREFLIGHT]: "0",
      [E.PORT]: String(port), [E.HOST]: "127.0.0.1", ...rootEnv(root),
      [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
      STUB_MODE: "menu", STUB_LOG: log, STUB_HOOKS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stderr.on("data", (d) => process.stderr.write("[host:menu] " + d));
  const base = `http://127.0.0.1:${port}`;
  await sleep(900);

  const repo = await fetch(`${base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "loc" }),
  }).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const acks = [];
  let sessionId = null;
  let screen = "";
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created") sessionId = m.session.id;
    if (m.t === "input.ack") acks.push(m);
    if (m.t === "pty") screen += Buffer.from(m.dataB64, "base64").toString("utf8");
  });
  await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }); });
  await sleep(300);
  ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "loc · main", cols: 80, rows: 24 }));
  for (let i = 0; i < 60 && !sessionId; i++) await sleep(100);
  ws.send(JSON.stringify({ t: "session.attach", id: sessionId }));
  await sleep(300);

  return {
    log, acks, ws, host,
    id: () => sessionId,
    out: () => screen,
    keys: () => { try { return readFileSync(log, "utf8"); } catch { return ""; } },
    send: (msg) => ws.send(JSON.stringify(msg)),
    ackFor: (ackId) => acks.filter((a) => a.ackId === ackId),
    stop: async () => { ws.close(); host.kill(); await sleep(200); },
  };
}

async function waitAcks(h, ackId, n, ms = 60000) {
  for (let i = 0; i < ms / 100; i++) {
    if (h.ackFor(ackId).length >= n) return;
    await sleep(100);
  }
}

/**
 * The keystroke log is not this session's alone.
 *
 * `usage.ts` refreshes its reading by spawning the binary into a short-lived
 * PTY of its own and typing `/usage` at it — and a stub launched that way
 * appends to the same `STUB_LOG`. So a probe that happens to fire mid-case adds
 * a `/usage\r` nobody in this file pressed, and a Return count is exactly the
 * assertion that notices. Drop the probe's own line before counting; every
 * command this file delivers is something else.
 */
const mine = (raw) => raw.split("/usage\r").join("");
const returns = (raw) => mine(raw).split("\r").length - 1;
const escs = (raw) => mine(raw).split("\x1b").length - 1;

const h = await boot(8862);
check(!!h.id(), "session opened");

// ── 1–2. the local command runs, once, and stays open ───────────────────────
{
  const ACK = "local-cost";
  const before = h.out().length;
  h.send({ t: "session.input", id: h.id(), data: "/cost", ackId: ACK, submit: true });
  await waitAcks(h, ACK, 1);
  const a = h.ackFor(ACK)[0];
  const keys = h.keys();
  const seen = h.out().slice(before);

  check(a?.ok === true, `a local command is reported delivered (ok: ${a?.ok}, state: ${a?.state}, reason: ${a?.reason ?? "-"})`);
  check(a?.state === "ok", `…with the delivered verdict, not a phantom failure (state: ${a?.state})`);
  check(seen.includes("OPENED: /cost"), "…the TUI actually ran it and opened its view");
  check(returns(keys) === 1, `exactly one Return was written (got ${returns(keys)})`);
  check(escs(keys) === 0, `no Esc was ever written (got ${escs(keys)})`);
  check(!seen.includes("DISMISSED"), "…so the view the user asked for is still on screen");
  check(keys.split("/cost").length - 1 === 1, "typed exactly once");
}

// ── 3. a turn-starting slash command keeps the ordinary contract ────────────
//
// Same completion menu, so this also pins the widened echo check on its own:
// before the fix this came back `unconfirmed` with the menu Esc'd away.
{
  // Close the view by hand, the way the user does (the Esc toolbar key) — the
  // point of case 1 is that nothing else was going to.
  h.send({ t: "session.input", id: h.id(), data: "\x1b" });
  // Waited for, not slept on: a key crosses the tmux client before the CLI
  // logs it. (A client whose start-up terminal queries were unanswered used to
  // hold a lone Esc on top; the host answers them now — `termqueries.ts`.)
  for (let i = 0; i < 80 && !h.keys().includes("\x1b"); i++) await sleep(100);
  await sleep(600);
  const keysBefore = h.keys().length;
  const ACK = "local-init";
  const before = h.out().length;
  h.send({ t: "session.input", id: h.id(), data: "/init", ackId: ACK, submit: true });
  await waitAcks(h, ACK, 1);
  const a = h.ackFor(ACK)[0];
  const keys = h.keys().slice(keysBefore);
  const seen = h.out().slice(before);

  check(a?.ok === true, `a turn-starting command is delivered (ok: ${a?.ok}, state: ${a?.state})`);
  check(a?.state === "ok", `…and its echo is found through the menu (state: ${a?.state}, not "unconfirmed")`);
  check(seen.includes("SUBMITTED: /init"), "…and it was actually submitted");
  check(escs(keys) === 0, `…with no Esc written (got ${escs(keys)})`);
  check(keys.split("/init").length - 1 === 1, "typed exactly once");
}

// ── 4. `/btw`: submits, starts no turn, opens no view ───────────────────────
//
// The third category, and the one that had no proof at all. `/btw` takes the
// composer's words, files them as a note and clears the box — and fires no
// `UserPromptSubmit`, so the hooked path pressed Return five times waiting for
// a turn that cannot start, found the conversation log silent (the CLI writes
// NOTHING for a `/btw` — no envelope, no stdout record) and reported
// `unsubmitted`: "it is sitting in the composer, unsent — do not retype it",
// about a note that had been filed perfectly.
//
// It is not in `isLocalCommand` and must not be: that list is what the PHONE
// reads to hold a command until the turn ends, and this is the one command
// whose entire purpose is to be said to a working agent. `startsNoTurn` is the
// wider question the submit contract asks.
{
  const ACK = "local-btw";
  const before = h.out().length;
  const keysBefore = h.keys().length;
  h.send({ t: "session.input", id: h.id(), data: "/btw remember the flaky test", ackId: ACK, submit: true });
  await waitAcks(h, ACK, 1);
  const a = h.ackFor(ACK)[0];
  const keys = h.keys().slice(keysBefore);
  const seen = h.out().slice(before);

  check(a?.ok === true, `a note is reported delivered (ok: ${a?.ok}, state: ${a?.state}, reason: ${a?.reason ?? "-"})`);
  check(a?.state === "ok", `…and NOT as words left in the composer (state: ${a?.state}, not "unsubmitted")`);
  check(seen.includes("NOTED: /btw remember the flaky test"), "…the TUI actually filed it");
  check(returns(keys) === 1, `one Return, not five (got ${returns(keys)})`);
  check(keys.split("/btw").length - 1 === 1, "typed exactly once");
  check(!seen.includes("DISMISSED"), "…and nothing was dismissed");
}

await h.stop();
process.exit(failed ? 1 : 0);
