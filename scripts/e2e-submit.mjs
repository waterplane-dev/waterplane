// Verified compose delivery — `session.input` with `submit: true`.
//
// The regression this pins is the one that made prompts *disappear*. The old
// contract was: host writes the bytes, answers `input.ack ok`, client drops the
// outbox entry, and 50 ms later the CLIENT fires the submitting Return as a
// bare, unacked `session.input "\r"`. A socket dying anywhere in that gap (and
// the reconnect watchdog reloads the page, taking ws.ts's in-memory send queue
// with it) left the prompt sitting typed-but-unsent in the composer, with the
// queue entry already gone and the UI saying "sent". Nothing on either side
// could tell you it had happened.
//
// `submit` moves the Return to the side of the tunnel that can see whether it
// worked: the host runs the same `deliverPrompt()` the backlog and the fan-out
// use, and the receipt means "the prompt is running", not "bytes reached a file
// descriptor".
//
// Asserts:
//   1. a `submit` send is typed EXACTLY ONCE and actually SUBMITS (the stub's
//      command output appears), and the receipt is ok
//   2. a duplicate ackId RACING the first delivery joins it — no second copy,
//      both deliveries acked (this is the phone's normal reconnect retry, which
//      routinely arrives while the host is still typing)
//   3. a duplicate ackId AFTER it settled is re-acked from the ledger, still
//      without retyping
//   4. a TUI that echoes the text but swallows every Return (hooked, so the
//      missing turn is provable) is reported `ok:false state:"unsubmitted"` —
//      the text is in the composer, so the client must say so and must NOT
//      retype
//   5. a TUI whose input never echoes is `unconfirmed` and NOT marked retryable
//   6. `submit` is opt-in: a plain ackId'd `session.input` still takes the raw
//      write path (bytes through, no Return, no verification)
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

const TEXT = "please summarise the failing test and propose a fix";
const PROBE = "summarise the failing test";

function copies(log) {
  let raw = "";
  try { raw = readFileSync(log, "utf8"); } catch { return 0; }
  return raw.split(PROBE).length - 1;
}

/**
 * Boot a host on `port` whose `claude` is the fake TUI in `mode`, open one
 * session, and hand the caller a driver.
 */
async function boot(mode, port, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), `${SLUG}-submit-${mode}-`));
  const log = join(root, "stub-input.log");
  writeFileSync(log, "");
  const host = spawn("node", ["packages/host/dist/main.js"], {
    env: {
      ...process.env,
      [E.PREFLIGHT]: "0",
      [E.PORT]: String(port), [E.HOST]: "127.0.0.1", ...rootEnv(root),
      [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
      STUB_MODE: mode, STUB_LOG: log,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stderr.on("data", (d) => process.stderr.write(`[host:${mode}] ` + d));
  const base = `http://127.0.0.1:${port}`;
  await sleep(900);

  const repo = await fetch(`${base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "sub" }),
  }).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const acks = [];
  let sessionId = null;
  let info = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created") { sessionId = m.session.id; info = m.session; }
    if (m.t === "session.updated" && m.session.id === sessionId) info = m.session;
    if (m.t === "input.ack") acks.push(m);
  });
  await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }); });
  await sleep(300);
  ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "sub · main", cols: 80, rows: 24 }));
  for (let i = 0; i < 60 && !sessionId; i++) await sleep(100);

  return {
    log, acks, ws, host, cwd: repo.path,
    id: () => sessionId,
    /** The host's latest view of the session — `hooked` is the one that matters
     *  below: the stub's own SessionStart lands whenever its node boot finishes,
     *  and a test that drives the turn state has to know that has HAPPENED.
     *  SessionStart sets turnActive false, so a UserPromptSubmit posted before it
     *  is silently undone — a race decided by machine load, which is not what any
     *  case here means to assert. */
    hooked: async (ms = 10000) => {
      for (let i = 0; i < ms / 100; i++) {
        if (info?.hooked) return true;
        await sleep(100);
      }
      return false;
    },
    send: (msg) => ws.send(JSON.stringify(msg)),
    ackFor: (ackId) => acks.filter((a) => a.ackId === ackId),
    stop: async () => { ws.close(); host.kill(); await sleep(200); },
  };
}

/** Wait until `n` receipts carry `ackId`, or the budget runs out. */
async function waitAcks(h, ackId, n, ms = 60000) {
  for (let i = 0; i < ms / 100; i++) {
    if (h.ackFor(ackId).length >= n) return;
    await sleep(100);
  }
}

// ── 1–3. the happy path, and the retry that races it ────────────────────────
{
  const h = await boot("repaint", 8836);
  check(!!h.id(), "session opened");

  const ACK = "submit-ack-1";
  h.send({ t: "session.input", id: h.id(), data: TEXT, ackId: ACK, submit: true });
  // The phone's reconnect retry normally arrives while the host is still typing,
  // which is exactly the window `inputsInFlight` exists to cover.
  await sleep(150);
  h.send({ t: "session.input", id: h.id(), data: TEXT, ackId: ACK, submit: true });

  await waitAcks(h, ACK, 2);
  const got = h.ackFor(ACK);
  check(got.length === 2, `both deliveries of the same ackId are answered (got ${got.length})`);
  check(got.every((a) => a.ok === true), `both receipts are ok (${JSON.stringify(got.map((a) => [a.ok, a.state]))})`);
  check(got[0]?.state === "ok", `the receipt says the turn started (state: ${got[0]?.state})`);
  check(copies(h.log) === 1, `typed exactly once despite the racing duplicate (copies: ${copies(h.log)})`);

  // The stub echoes a command marker once a Return is actually consumed; a
  // repainting TUI grows whether or not the keystroke landed, so the marker —
  // not output growth — is what proves the submit.
  const raw = readFileSync(h.log, "utf8");
  check(raw.includes("\r"), "a Return was written to the session");

  // …and once it has SETTLED, the ledger answers instead of re-running.
  h.send({ t: "session.input", id: h.id(), data: TEXT, ackId: ACK, submit: true });
  await waitAcks(h, ACK, 3, 8000);
  check(h.ackFor(ACK).length === 3, "a late duplicate is answered from the ledger");
  check(copies(h.log) === 1, `a late duplicate does not retype (copies: ${copies(h.log)})`);

  // 6. `submit` is opt-in — a plain ackId'd input is still the raw write path.
  const RAW_ACK = "submit-ack-raw";
  h.send({ t: "session.input", id: h.id(), data: "xyzzy-raw", ackId: RAW_ACK });
  await waitAcks(h, RAW_ACK, 1, 8000);
  const rawAck = h.ackFor(RAW_ACK)[0];
  check(rawAck?.ok === true, "a non-submit input still acks ok");
  check(rawAck?.state === undefined, `a non-submit receipt carries no delivery state (state: ${rawAck?.state})`);

  await h.stop();
}

// ── 7. interjecting into a WORKING session must not block ──────────────────
//
// The automation callers (backlog, fan-out) deliberately wait for the turn to
// end before typing — their instruction is a new task. A person typing in the
// compose bar means the opposite: you interject, and the TUI holds the line
// until the turn ends. Sharing the waiting behaviour would silently turn every
// compose send into the "hold until idle" mode the app offers as a separate,
// explicit choice, and would park the prompt on the host for 45 s before giving
// up with "not ready" — strictly worse than the raw write it replaced.
{
  const h = await boot("repaint", 8840, { STUB_HOOKS: "1" });
  // Wait for the stub's OWN SessionStart first. It arrives when its node process
  // has finished booting, it means "this session sits at its prompt", and it
  // therefore CLEARS turnActive — so posting the interjection's UserPromptSubmit
  // before it lands leaves the session not-working by the time delivery reads
  // the flag, and the case silently stops testing an interjection at all.
  check(await h.hooked(), "the session's hook pipe is live before the turn is driven");
  // Drive the session turn-active the way a real `claude` would, through the
  // hook sink (loopback-only, which is where this test runs). The cwd is what
  // routes the event to a session, so it has to be the session's own.
  await fetch(`http://127.0.0.1:8840/api/hook`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: h.cwd }),
  }).catch(() => {});
  await sleep(300);

  const ACK = "submit-ack-busy";
  const t0 = Date.now();
  h.send({ t: "session.input", id: h.id(), data: TEXT, ackId: ACK, submit: true });
  await waitAcks(h, ACK, 1, 30000);
  const took = Date.now() - t0;
  const a = h.ackFor(ACK)[0];
  check(!!a, `an interjection is answered at all (after ${took}ms)`);
  check(took < 20000, `…without waiting out the idle timeout (${took}ms, the automation path would take 45000ms)`);
  // A turn was ALREADY running, so "the turn started" cannot prove this Return
  // landed — the delivery falls back to press-and-look and reports ok, which is
  // the honest answer and still strictly more than the old path checked.
  check(a?.ok === true, `…and is delivered (ok: ${a?.ok}, state: ${a?.state}, reason: ${a?.reason ?? "-"})`);
  check(copies(h.log) === 1, `…exactly once (copies: ${copies(h.log)})`);
  await h.stop();
}

// ── 4. the Return is swallowed: provable only on a hooked session ───────────
{
  const h = await boot("deaf", 8837, { STUB_HOOKS: "1" });
  const ACK = "submit-ack-deaf";
  h.send({ t: "session.input", id: h.id(), data: TEXT, ackId: ACK, submit: true });
  await waitAcks(h, ACK, 1);
  const a = h.ackFor(ACK)[0];
  check(a?.ok === false, `swallowed Return is NOT reported as delivered (ok: ${a?.ok})`);
  check(a?.state === "unsubmitted", `…and says the prompt is sitting unsent (state: ${a?.state})`);
  check(!a?.retryable, "…and is not marked auto-retryable (retyping would stack a copy)");
  check(/Return/i.test(a?.reason || ""), `…with a reason that names the fix (${JSON.stringify(a?.reason)})`);
  check(copies(h.log) === 1, `typed exactly once, never re-hammered (copies: ${copies(h.log)})`);
  await h.stop();
}

// ── 5. the screen can't be read at all ──────────────────────────────────────
{
  const h = await boot("blind", 8838);
  const ACK = "submit-ack-blind";
  h.send({ t: "session.input", id: h.id(), data: TEXT, ackId: ACK, submit: true });
  await waitAcks(h, ACK, 1);
  const a = h.ackFor(ACK)[0];
  check(a?.ok === false, `an unreadable screen is not reported as delivered (ok: ${a?.ok})`);
  check(a?.state === "unconfirmed", `…and is flagged ambiguous rather than failed-for-good (state: ${a?.state})`);
  check(!a?.retryable, "…and is NOT auto-retryable — that is what stacked five copies");
  check(copies(h.log) <= 1, `written at most once (copies: ${copies(h.log)})`);
  await h.stop();
}

// ── 6. the screen can't be read, but the CLI can say what it took ──────────
//
// The live shape this rescue was built for: the composer is a VIEWPORT, so a
// long single-line prompt draws only its tail and the head the echo probe is
// cut from is off the top of the box. Measured on this desktop, 46% of
// deliveries between 300 and 800 characters came back unconfirmable against 19%
// of the shorter ones — every one of them typed, sitting in the composer, one
// keystroke from running, and swept away by the miss path.
//
// `blind` is that failure in its purest form (the text is accepted and NEVER
// displayed), and the only thing added is a pipe: `UserPromptSubmit` carries
// the submitted prompt, so the delivery presses Return once and asks the CLI
// what it took. Case 5 above is the same stub WITHOUT hooks and still answers
// `unconfirmed` — a Return is only pressed where there is something that can
// answer for it.
{
  const h = await boot("blind", 8839, { STUB_HOOKS: "1" });
  const ACK = "submit-ack-blindhook";
  h.send({ t: "session.input", id: h.id(), data: TEXT, ackId: ACK, submit: true });
  await waitAcks(h, ACK, 1);
  const a = h.ackFor(ACK)[0];
  check(a?.ok === true, `a prompt the screen never showed is confirmed by the hook that names it (ok: ${a?.ok}, state: ${a?.state})`);
  check(copies(h.log) === 1, `…and it is still typed exactly once (copies: ${copies(h.log)})`);
  await h.stop();
}

// ── 7. the command that submits, works for minutes, and announces NOTHING ───
//
// `/compact` fires no hook at all — no `UserPromptSubmit`, no `Stop` — and the
// conversation log is silent about slash commands whether they ran or not. So
// every rung of the submit ladder was missing and the delivery said what it
// says when nothing answers: "typed, but Return was swallowed — open the
// session and press Return". Reported from a phone, beside a terminal reading
// "✳ Compacting conversation… 15%", with the app's own Activity screen offering
// to rewrite a prompt that was already running.
//
// The one thing that CAN answer is the CLI's own working line, which the host
// already reads for this command and publishes as a turn marked `fromScreen`
// (`e2e-stophook.mjs` pins that half). `goal` mode plays it exactly: the stub
// prints "Compacting conversation… (1s) 32%" and posts nothing.
//
// Case 4 above is the guard on the other side — an ordinary prompt into a
// Return-swallowing TUI is still `unsubmitted`, because a spinner the host
// inferred is no evidence about a Return unless the command IS the one that
// paints it.
{
  const h = await boot("goal", 8841, { STUB_HOOKS: "1", STUB_GOAL_MS: "15000" });
  await h.hooked();
  const ACK = "submit-ack-compact";
  const t0 = Date.now();
  h.send({ t: "session.input", id: h.id(), data: "/compact", ackId: ACK, submit: true });
  await waitAcks(h, ACK, 1, 30000);
  const a = h.ackFor(ACK)[0];
  const took = Date.now() - t0;
  check(a?.ok === true, `work no hook announced is confirmed by the line it paints (ok: ${a?.ok}, state: ${a?.state}, reason: ${a?.reason ?? "-"}, ${took}ms)`);
  // The whole point: two presses at most, and never five into a running
  // compaction. The stub logs every byte, so a stray Return is visible.
  const raw = readFileSync(h.log, "utf8");
  check(raw.split("/compact").length - 1 === 1, `typed exactly once (copies: ${raw.split("/compact").length - 1})`);
  check(raw.split("\r").length - 1 <= 2, `…and Return pressed at most twice (presses: ${raw.split("\r").length - 1})`);
  await h.stop();
}

process.exit(failed ? 1 : 0);
