// The host settles its own open questions — with nobody watching.
//
// `e2e-settle.mjs` covers the PHONE asking (`input.settle`). That path needs a
// phone, a live socket, and a client that remembered to ask at most three times
// before its row retires — i.e. it works on exactly the days it is not needed.
// This one covers the other half: `deliver.ts` writes an unconfirmable verdict
// down as an open QUESTION, the host re-asks it against the CLI's own
// conversation log on a sweep, and the answer exists whether or not anyone was
// connected when it arrived.
//
// Asserts:
//   1. a delivery that came back `unconfirmed` becomes an open row, with its
//      full text — not a 200-character clipping, not a toast
//   2. the host resolves it WITH THE SOCKET CLOSED, and a client that reconnects
//      an hour later finds the answer in the hello snapshot (no request needed)
//   3. an attached client is PUSHED the resolution the moment it happens
//      (`delivery.settled`), so it can retire the row it is showing
//   4. `absent` — a readable log that does not contain the prompt — is re-sent
//      by the host up to `RESEND_TRIES` times and NOT ONCE MORE, however many
//      sweeps run. What permits a second attempt at all is that each one is
//      preceded by its own fresh `absent` verdict, so there is no copy for it
//      to stack on; what the budget prevents is the failure that made
//      `unconfirmed` un-retryable in the first place — one prompt typed five
//      times. Pinned here at two, because the NUMBER is a setting and the
//      "stops on it" is the rule
//   5. …and the row says so: `resentAt` set, `resentResult` kept, verdict
//      terminal rather than a poller that never stops
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEXT = "please rewrite the flaky retry test and explain the fix";
const PROBE = "rewrite the flaky retry test";

/** How many times the stub was actually typed this text. The count that decides
 *  whether "exactly once" is true. */
function copies(log) {
  let raw = "";
  try { raw = readFileSync(log, "utf8"); } catch { return 0; }
  return raw.split(PROBE).length - 1;
}

/** The claude CLI's own conversation log — the evidence the sweep reads. */
function writeConversation(home, cwd, cid, prompts) {
  const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines = prompts.map((p, i) => JSON.stringify({
    type: "user",
    uuid: `u${i}`,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: p }] },
  }));
  writeFileSync(join(dir, cid + ".jsonl"), lines.join("\n") + "\n");
}

/**
 * A host whose sweep runs in under a second instead of five.
 *
 * The production numbers (5 s, doubling, 15 minutes) are about not re-parsing a
 * megabyte transcript every few seconds for a quarter of an hour; nothing in
 * the RULE depends on them, so the test scales the base down and asserts the
 * behaviour rather than the clock. `blind` never echoes, so every delivery
 * through it is genuinely unconfirmable — which is the state this file is about.
 */
async function boot(port, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), `${SLUG}-sweep-`));
  const home = mkdtempSync(join(tmpdir(), `${SLUG}-sweep-home-`));
  const log = join(root, "stub-input.log");
  writeFileSync(log, "");
  const host = spawn("node", ["packages/host/dist/main.js"], {
    env: {
      ...process.env,
      [E.PREFLIGHT]: "0",
      [E.PORT]: String(port), [E.HOST]: "127.0.0.1", ...rootEnv(root),
      [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
      [E.CLAUDE_HOME]: home,
      [E.SETTLE_BASE_MS]: "800",
      [E.SETTLE_MAX_GAP_MS]: "1600",
      STUB_MODE: "blind", STUB_LOG: log,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stderr.on("data", (d) => process.stderr.write(`[host:${port}] ` + d));
  const base = `http://127.0.0.1:${port}`;
  await sleep(900);

  const repo = await fetch(`${base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "swp" }),
  }).then((r) => r.json());

  /** One socket's view of the host. Several are opened over a run — the point of
   *  the whole exercise is what happens between them. */
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const state = { acks: [], lists: [], pushes: [], sent: [], session: null };
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "session.created") state.session = m.session;
      if (m.t === "input.ack") state.acks.push(m);
      if (m.t === "delivery.list") state.lists.push(m.items);
      if (m.t === "delivery.settled") state.pushes.push(m.item);
      if (m.t === "sent.new") state.sent.push(m.entry);
    });
    await new Promise((r) => { ws.on("open", () => { ws.send(JSON.stringify({ t: "hello", protocol: 1 })); r(); }); });
    await sleep(300);
    return { ws, state, send: (msg) => ws.send(JSON.stringify(msg)) };
  };

  return {
    log, home, root, host, cwd: repo.path, connect,
    stop: async () => { host.kill(); await sleep(200); },
  };
}

/** Wait until `pick` returns something truthy, or give up. */
async function until(pick, tries = 120, gap = 150) {
  for (let i = 0; i < tries; i++) {
    const v = pick();
    if (v) return v;
    await sleep(gap);
  }
  return null;
}

// ── 1–2. resolved with the socket CLOSED, found again on reconnect ─────────
{
  const h = await boot(8859);
  const c1 = await h.connect();
  c1.send({ t: "session.create", cwd: h.cwd, title: "swp · main", cols: 80, rows: 24 });
  const session = await until(() => c1.state.session);
  check(!!session, "session opened");

  c1.send({ t: "session.input", id: session.id, data: TEXT, ackId: "sweep-landed", submit: true });
  const ack = await until(() => c1.state.acks.find((a) => a.ackId === "sweep-landed"), 200);
  check(ack?.state === "unconfirmed", `a TUI that never echoes still fails as unconfirmed (state: ${ack?.state})`);

  const openRow = await until(() => (c1.state.lists.at(-1) ?? []).find((i) => i.ackId === "sweep-landed"));
  check(!!openRow, "the host wrote the question down and broadcast it");
  check(openRow?.verdict === "open", `…as an OPEN question, not a verdict (verdict: ${openRow?.verdict})`);
  check(openRow?.text === TEXT, "…keeping the full text, un-clipped — it is what makes the row actionable");

  // The phone goes away. Everything from here happens with nobody attached.
  c1.ws.close();
  await sleep(300);
  writeConversation(h.home, h.cwd, session.claudeSessionId, ["something earlier", TEXT]);
  await sleep(3000);

  const c2 = await h.connect();
  const list = await until(() => c2.state.lists.at(-1));
  const row = (list ?? []).find((i) => i.ackId === "sweep-landed");
  check(row?.verdict === "landed", `the host settled it alone and says so on hello (verdict: ${row?.verdict})`);
  check(!!row?.resolvedAt, "…with the moment it decided");
  check(copies(h.log) === 1, `and a prompt that RAN was never typed again (copies: ${copies(h.log)})`);

  // 6. …and the AUDIT TRAIL hears about it.
  //
  // `sent.json` is appended from inside the delivery — i.e. at the one moment
  // the answer is not yet known — so a row settled minutes later still read
  // `"result":"unconfirmed"` on disk for ever. That file is what a person, and
  // the measurement this whole rework was built on, reads as "what happened to
  // my deliveries": leaving it uncorrected does not lose a detail, it
  // manufactures a failure rate. Both halves are kept, because "reported X,
  // settled Y" is the honest row and the gap between them is the signal.
  await sleep(900);   // the log's write is debounced
  const sent = JSON.parse(readFileSync(join(h.root, STATE, "sent.json"), "utf8"));
  const audit = sent.find((e) => e.text === TEXT);
  check(!!audit, "the delivery is in the sent log");
  check(audit?.result === "unconfirmed", `…still reporting what delivery could see at the time (${audit?.result})`);
  check(audit?.settled === "landed", `…and now ALSO what the host later proved (settled: ${audit?.settled})`);
  check(!!audit?.settledAt && !!audit?.settledDetail, "…with when it was decided, and why");
  c2.ws.close();
  await h.stop();
}

// ── 3. an attached client is pushed the resolution ────────────────────────
{
  const h = await boot(8860);
  const c = await h.connect();
  c.send({ t: "session.create", cwd: h.cwd, title: "swp · main", cols: 80, rows: 24 });
  const session = await until(() => c.state.session);
  c.send({ t: "session.input", id: session.id, data: TEXT, ackId: "sweep-push", submit: true });
  await until(() => c.state.acks.find((a) => a.ackId === "sweep-push"), 200);

  writeConversation(h.home, h.cwd, session.claudeSessionId, [TEXT]);
  const pushed = await until(() => c.state.pushes.find((i) => i.ackId === "sweep-push"));
  check(!!pushed, "the resolution is pushed, unasked, to an attached socket");
  check(pushed?.verdict === "landed", `…naming what it turned out to be (verdict: ${pushed?.verdict})`);
  check(pushed?.ackId === "sweep-push", "…and the client's own row key, so the red row can be retired");

  // The corrected audit row rides the same `sent.new` frame it was created on,
  // under the SAME id — a client replaces by id, so the row changes verdict
  // rather than appearing twice.
  const corrected = await until(() => c.state.sent.find((e) => e.settled === "landed"));
  check(!!corrected, "the settled verdict is pushed onto the sent-log row too");
  check(corrected?.result === "unconfirmed",
    `…beside the original verdict rather than instead of it (${corrected?.result})`);
  check(c.state.sent.filter((e) => e.id === corrected?.id).length >= 2,
    "…as an update to the same row id, not a second row");

  // The reconciliation path: asking for the set explicitly answers too.
  c.state.lists.length = 0;
  c.send({ t: "delivery.list" });
  const asked = await until(() => c.state.lists.at(-1));
  check(!!asked?.some((i) => i.ackId === "sweep-push"), "delivery.list answers the same set on request");
  c.ws.close();
  await h.stop();
}

// ── 4–5. `absent` is re-sent by the host, up to the budget and no further ──
{
  // Two, so the test proves both halves — that a second attempt is allowed,
  // and that the budget is a wall — without sitting through the default four.
  const h = await boot(8861, { [E.RESEND_TRIES]: "2" });
  const c = await h.connect();
  c.send({ t: "session.create", cwd: h.cwd, title: "swp · main", cols: 80, rows: 24 });
  const session = await until(() => c.state.session);
  c.send({ t: "session.input", id: session.id, data: TEXT, ackId: "sweep-absent", submit: true });
  const ack = await until(() => c.state.acks.find((a) => a.ackId === "sweep-absent"), 200);
  check(ack?.state === "unconfirmed", `unreadable screen ⇒ unconfirmed (state: ${ack?.state})`);
  check(copies(h.log) === 1, `typed once so far (copies: ${copies(h.log)})`);

  // A log that EXISTS and does not hold the prompt. That is the one verdict
  // that makes a second send provably safe: nothing ran it, nothing is holding
  // it in a composer, so there is no copy for a second one to stack on.
  writeConversation(h.home, h.cwd, session.claudeSessionId, ["a completely unrelated earlier prompt"]);

  const resent = await until(() => copies(h.log) >= 2, 200);
  check(!!resent, "the host re-sent it on its own — no client asked for anything");

  // …and then keeps sweeping. The row re-opens (the re-send is blind too, so
  // its own verdict is unconfirmable) and settles absent again, which spends
  // the second and last attempt.
  const spent = await until(() => copies(h.log) >= 3, 200);
  check(!!spent, `the budget's second attempt is spent too (copies: ${copies(h.log)})`);

  // On the number, the row is ANSWERED rather than re-asked for ever.
  const settled = await until(() => c.state.pushes.find((i) => i.ackId === "sweep-absent"), 200);
  check(settled?.verdict === "absent", `it ends terminal, not as a poller (verdict: ${settled?.verdict})`);
  check(!!settled?.resentAt, "…recording that the host tried");
  check(settled?.resentResult === "unconfirmed", `…and what came of it (resentResult: ${settled?.resentResult})`);

  // The wall: sit through several more sweeps and the count must not move.
  await sleep(6000);
  check(copies(h.log) === 3,
    `EXACTLY the budget, however many sweeps run (copies: ${copies(h.log)})`);
  c.ws.close();
  await h.stop();
}

process.exit(failed ? 1 : 0);
