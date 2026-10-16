// Settling a delivery that could not be confirmed WHEN IT HAPPENED —
// `input.settle` → host/settle.ts.
//
// The gap this closes: `deliverPrompt()` answers `unconfirmed` (written, never
// seen on screen) or `unsubmitted` (in the composer, every Return swallowed),
// and the client may not auto-retry either — retrying what may already be there
// is what stacked five copies of one prompt. So the queue kept the row, and
// nothing ever revisited it: a permanent gravestone for a prompt whose fate is,
// minutes later, perfectly knowable.
//
// It is knowable because the CLI writes its own conversation log. So the phone
// asks again, and the host answers from evidence:
//
// Asserts:
//   1. the conversation log HAS the prompt ⇒ `landed` (it ran; the row is a lie)
//   2. the text is on the rendered screen ⇒ `composer` (unsent, user's call)
//   3. log readable, prompt in neither log nor screen ⇒ `absent` (never ran, and
//      nothing is holding it — the one verdict that makes a re-send provably
//      safe, which is what the original `unconfirmed` could not say)
//   4. NO conversation log ⇒ `unknown`, never `absent`. A screen is the last 40
//      rows; "not on screen" alone would call a delivered prompt absent, and the
//      client acts on `absent` by sending it again.
//   5. settling types NOTHING into the session, whatever it answers
//   6. an ackId the host knows nothing about is still answered (a client waiting
//      on a reply must not hang on one bad row)
//   7. a delivery whose ECHO WINDOW fails but whose text is already in the log
//      reports `ok` — the log outranks the screen, at delivery time and not only
//      hours later. This is the manufactured loss the whole rework is about: the
//      four-second window is a guess about a TUI that repaints on its own
//      schedule, and it produced 67 rows reading "typed into that session but
//      never seen to run", several of them prompts that were running.
//
// The host's own sweep is deliberately parked here (<ENV>_SETTLE_BASE_MS is set
// past the life of every case below): these cases are about the PHONE asking.
// The sweep asking on its own is `e2e-settlesweep.mjs`, and letting it fire in
// the middle of case 3 would re-send the absent prompt the case is counting.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEXT = "please rewrite the flaky retry test and explain the fix";
const PROBE = "rewrite the flaky retry test";

function copies(log) {
  let raw = "";
  try { raw = readFileSync(log, "utf8"); } catch { return 0; }
  return raw.split(PROBE).length - 1;
}

/** The claude CLI's own conversation log for a cwd — the evidence settle reads.
 *  `at` stamps the turns; the default is now, and an old one is how a case says
 *  "this is a DIFFERENT delivery of the same words". */
function writeConversation(home, cwd, cid, prompts, at = Date.now()) {
  const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines = prompts.map((p, i) => JSON.stringify({
    type: "user",
    uuid: `u${i}`,
    timestamp: new Date(at).toISOString(),
    message: { role: "user", content: [{ type: "text", text: p }] },
  }));
  writeFileSync(join(dir, cid + ".jsonl"), lines.join("\n") + "\n");
}

async function boot(mode, port, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), `${SLUG}-settle-${mode}-`));
  const home = mkdtempSync(join(tmpdir(), `${SLUG}-settle-home-`));
  const log = join(root, "stub-input.log");
  writeFileSync(log, "");
  const host = spawn("node", ["packages/host/dist/main.js"], {
    env: {
      ...process.env,
      [E.PREFLIGHT]: "0",
      [E.PORT]: String(port), [E.HOST]: "127.0.0.1", ...rootEnv(root),
      [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
      // The conversation log lives under a throwaway home, so the test can BE
      // the CLI's own record without touching the developer's.
      [E.CLAUDE_HOME]: home,
      // Park the host's own open-question sweep — see the header.
      [E.SETTLE_BASE_MS]: "600000",
      STUB_MODE: mode, STUB_LOG: log,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stderr.on("data", (d) => process.stderr.write(`[host:${mode}] ` + d));
  const base = `http://127.0.0.1:${port}`;
  await waitForHost(port);

  const repo = await fetch(`${base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "set" }),
  }).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const acks = [];
  const settled = [];
  let session = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created") session = m.session;
    if (m.t === "input.ack") acks.push(m);
    if (m.t === "input.settled") settled.push(...m.results);
  });
  await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }); });
  await sleep(300);
  ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, title: "set · main", cols: 80, rows: 24 }));
  for (let i = 0; i < 60 && !session; i++) await sleep(100);

  return {
    log, acks, settled, ws, host, home, cwd: repo.path,
    id: () => session?.id,
    cid: () => session?.claudeSessionId,
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** Deliver TEXT (or another prompt) with the verified path and wait for its
     *  (failing) receipt. */
    deliver: async (ackId, text = TEXT) => {
      ws.send(JSON.stringify({ t: "session.input", id: session.id, data: text, ackId, submit: true }));
      for (let i = 0; i < 600 && !acks.some((a) => a.ackId === ackId); i++) await sleep(100);
      return acks.find((a) => a.ackId === ackId);
    },
    /** Ask what became of it, and wait for the answer. */
    settle: async (ackId, text = TEXT, since = Date.now() - 60_000) => {
      ws.send(JSON.stringify({ t: "input.settle", items: [{ ackId, id: session.id, text, since }] }));
      for (let i = 0; i < 200 && !settled.some((r) => r.ackId === ackId); i++) await sleep(100);
      return settled.find((r) => r.ackId === ackId);
    },
    stop: async () => { ws.close(); host.kill(); await sleep(200); },
  };
}

// ── 1. the conversation log has it: it RAN ─────────────────────────────────
{
  const h = await boot("blind", 8853);
  check(!!h.id(), "session opened");
  const a = await h.deliver("settle-landed");
  check(a?.state === "unconfirmed", `an unreadable screen still fails as unconfirmed (state: ${a?.state})`);

  // The CLI accepted and ran it after all — the case the old queue could only
  // display as "not delivered" for ever.
  writeConversation(h.home, h.cwd, h.cid(), ["something earlier", TEXT]);
  const r = await h.settle("settle-landed");
  check(r?.verdict === "landed", `a prompt in the conversation log settles as landed (verdict: ${r?.verdict})`);
  check(r?.alive === true, "…and reports the session still alive");
  check(copies(h.log) === 1, `settling typed nothing (copies: ${copies(h.log)})`);
  await h.stop();
}

// ── 2. it is sitting in the composer ───────────────────────────────────────
{
  // `deaf` echoes the text and swallows every Return — the `unsubmitted`
  // verdict, and the one case where the text is provably still on screen.
  const h = await boot("deaf", 8854, { STUB_HOOKS: "1" });
  const a = await h.deliver("settle-composer");
  check(a?.state === "unsubmitted", `a swallowed Return fails as unsubmitted (state: ${a?.state})`);
  const r = await h.settle("settle-composer");
  check(r?.verdict === "composer", `text still on the rendered screen settles as composer (verdict: ${r?.verdict})`);
  check(copies(h.log) === 1, `settling typed nothing (copies: ${copies(h.log)})`);
  await h.stop();
}

// ── 3. readable log, and it is in neither the log nor the screen ───────────
{
  const h = await boot("blind", 8855);
  const a = await h.deliver("settle-absent");
  check(a?.state === "unconfirmed", `unreadable screen ⇒ unconfirmed (state: ${a?.state})`);
  // A log that exists and does NOT contain the prompt is the whole point: the
  // negative is a fact, not a small window.
  writeConversation(h.home, h.cwd, h.cid(), ["a completely unrelated earlier prompt"]);
  const r = await h.settle("settle-absent");
  check(r?.verdict === "absent", `a readable log without the prompt settles as absent (verdict: ${r?.verdict})`);
  check(r?.alive === true, "…and says the session is still there to re-send into");
  check(copies(h.log) === 1, `settling typed nothing — the RE-SEND is the client's move (copies: ${copies(h.log)})`);
  await h.stop();
}

// ── 4. no log at all ⇒ unknown, never absent ───────────────────────────────
{
  const h = await boot("blind", 8856);
  const a = await h.deliver("settle-unknown");
  check(a?.state === "unconfirmed", `unreadable screen ⇒ unconfirmed (state: ${a?.state})`);
  const r = await h.settle("settle-unknown");
  check(r?.verdict === "unknown", `no conversation log ⇒ unknown, so the client never re-sends on a guess (verdict: ${r?.verdict})`);

  // 6. and a row the host has never heard of is still answered.
  const stray = await h.settle("settle-never-seen", "text that was never sent anywhere");
  check(!!stray, "an unknown ackId is answered rather than left hanging");
  check(stray?.verdict === "unknown", `…as unknown (verdict: ${stray?.verdict})`);
  check(copies(h.log) === 1, `settling typed nothing (copies: ${copies(h.log)})`);
  await h.stop();
}

// ── 7. the log outranks the screen AT DELIVERY TIME ────────────────────────
{
  // `blind` never echoes, so the four-second window cannot possibly succeed —
  // and the conversation log already says the prompt is a turn in this session.
  // The old code answered `unconfirmed` here and the row became a permanent
  // gravestone; the screen was simply not the best available witness.
  const h = await boot("blind", 8857);
  check(!!h.id(), "session opened");
  writeConversation(h.home, h.cwd, h.cid(), ["something earlier", TEXT]);
  const a = await h.deliver("deliver-proven");
  check(a?.state === "ok", `a failed echo window with the text in the log reports ok (state: ${a?.state})`);
  check(a?.ok === true, "…and the receipt is a success, so the phone drops the row");
  check(copies(h.log) === 1, `and it was still typed exactly once (copies: ${copies(h.log)})`);
  await h.stop();
}

// ── 8. an OLDER identical prompt is not proof about this one ───────────────
{
  const h = await boot("blind", 8858);
  // Same text, but the CLI accepted it an hour before this delivery started.
  // Matching it would report a prompt as running on the strength of a different
  // one — the exact false `ok` that would turn this fix into a silent loss.
  const dir = h.home;
  writeConversation(dir, h.cwd, h.cid(), [TEXT], Date.now() - 3600_000);
  const a = await h.deliver("deliver-stale-twin");
  check(a?.state === "unconfirmed", `a match outside the recency window is not proof (state: ${a?.state})`);
  await h.stop();
}

// ── 9–11. the fourteen-character collision ─────────────────────────────────
//
// Observed live on 2026-09-05, and it is this whole subsystem's own failure
// mode arriving by a different road. Every comparison here ran on
// `squash(text).slice(0, 14)`, so two prompts sharing a fourteen-character head
// were indistinguishable — and the verdicts that produced were not "I could not
// tell" but confident and wrong: a prompt that never ran settled `landed` on
// another prompt's log entry (the row retires, the words are gone), a prompt
// that was nowhere settled `composer` ("press Return there, never retype it")
// against a stranger's echo, and `deliverPrompt` returned `ok` — the verdict
// nothing ever revisits — for a prompt that never ran.
//
// The trigger shape is the ordinary one: A RE-SEND SHARES ITS ENTIRE HEAD WITH
// THE ORIGINAL, which is exactly what a person types when this app tells them
// their prompt did not run.
const TWIN = "please rewrite the docs index so it links the new notes";

// 9. the LOG half. The log has the OTHER prompt and nothing else.
{
  const h = await boot("blind", 8859);
  const a = await h.deliver("collide-log-a");
  check(a?.state === "unconfirmed", `the first prompt fails as unconfirmed (state: ${a?.state})`);
  writeConversation(h.home, h.cwd, h.cid(), ["something earlier", TEXT]);
  // The twin never ran. The old rule matched TEXT's turn on fourteen shared
  // characters and answered `landed`, which retires the row and loses the
  // words; the log holds the whole turn, so it is compared whole.
  const r = await h.settle("collide-log-b", TWIN);
  check(r?.verdict === "absent", `a prompt sharing 14 characters with a logged one is NOT landed (verdict: ${r?.verdict})`);
  await h.stop();
}

// 10. the SCREEN half. The composer holds the other prompt.
{
  // `deaf` echoes and swallows every Return, so TEXT is provably sitting on the
  // rendered screen — and the twin is provably nowhere.
  const h = await boot("deaf", 8860, { STUB_HOOKS: "1" });
  const a = await h.deliver("collide-screen-a");
  check(a?.state === "unsubmitted", `the first prompt fails as unsubmitted (state: ${a?.state})`);
  const r = await h.settle("collide-screen-b", TWIN);
  check(r?.verdict === "unknown",
    `an echo another open delivery would have matched too is not evidence (verdict: ${r?.verdict})`);
  check(copies(h.log) === 1, `and settling still typed nothing (copies: ${copies(h.log)})`);
  await h.stop();
}

// 11. AT DELIVERY TIME, which is the expensive one: nothing ever revisits an ok.
{
  const h = await boot("blind", 8861);
  check(!!h.id(), "session opened");
  // The log already holds a prompt with the same head, stamped inside the
  // recency window. The echo window cannot succeed in `blind`, so the delivery
  // falls through to the log — which used to find those fourteen characters and
  // report a prompt as running that had never been accepted by anything.
  writeConversation(h.home, h.cwd, h.cid(), [TEXT]);
  const a = await h.deliver("collide-deliver", TWIN);
  check(a?.state === "unconfirmed",
    `another prompt's turn does not make this delivery ok (state: ${a?.state})`);
  check(a?.ok !== true, "…and the receipt is not a success, so the phone keeps the row");
  await h.stop();
}

process.exit(failed ? 1 : 0);
