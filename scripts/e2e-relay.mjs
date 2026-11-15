// `POST /api/relay` through a real host (bg-link-send WP2; `server/bgrelay.ts`,
// `acks.ts`'s long keep). The background relay sends the queue's own frames
// while the page is frozen; the page later re-sends the same ackId. Pinned:
//
//   A. a relayed submit is delivered once and answered with the verbatim
//      `input.ack` (`ok`);
//   B. the same ackId re-sent over the page's WebSocket is re-acked with that
//      verdict and NOT retyped;
//   C. the other way: a page-sent submit still in flight, relayed with its
//      ackId, is joined — answered, typed once;
//   D. refusals: raw keys and a frame without an ackId are refused (422) and
//      type nothing; any verb but POST is 405;
//   E. 46 minutes later (the ledger's clock moved back on disk across a
//      restart — the ordinary TTL is 45) the relayed ackId is still re-acked
//      and not retyped, while an ordinary receipt of the same age is forgotten;
//   F. a passive (kids') token is refused 403 before the route runs.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const TMP = mkdtempSync(join(tmpdir(), `${SLUG}-relay-`));
const STUB_LOG = join(TMP, "stub.log");
const stubEnv = {
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub-tui.mjs",
  [E.CLAUDE_HOME]: join(TMP, "home"),
  STUB_MODE: "answer", STUB_HOOKS: "1", STUB_LOG,
  [E.STOP_VERIFY_MS]: "300",
};
let host = await bootHost({ tag: "relay", env: stubEnv });
const ROOT = host.root;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sockets = new Set();
const done = async (code) => { for (const s of sockets) { try { s.terminate(); } catch { /* gone */ } } await host.stop(); process.exit(code); };
watchdog(async () => { console.error("FAIL: timeout"); await done(1); }, 150_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const typed = (text) => existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8").split(text).length - 1 : 0;

async function relay(body, { tok, method = "POST" } = {}) {
  const r = await fetch(`${host.base}/api/relay`, {
    method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* not json */ }
  return { status: r.status, json };
}

/** A page socket: hello, frames collected, `ack(t, ackId)` waits for a receipt. */
async function page() {
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`);
  sockets.add(ws);
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  ws.send(JSON.stringify({ t: "hello", protocol: 2 }));
  const ack = async (t, ackId, since = 0, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = frames.slice(since).find((f) => f.t === t && f.ackId === ackId);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  };
  return { ws, frames, ack, send: (m) => ws.send(JSON.stringify(m)) };
}

const repo = await fetch(`${host.base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "relay" }) }).then((r) => r.json());
const p1 = await page();
p1.send({ t: "session.create", cwd: repo.path, cols: 100, rows: 30 });
let sid = null;
{
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const s = p1.frames.filter((f) => (f.t === "session.created" || f.t === "session.updated") && f.session).map((f) => f.session);
    sid ??= p1.frames.find((f) => f.t === "session.created")?.session.id ?? null;
    const info = sid ? s.filter((x) => x.id === sid).at(-1) : null;
    if (info?.hooked && info.claudeSessionId && !info.turnActive) break;
    await sleep(50);
  }
}
if (!sid) { check(false, "a session to relay into"); await done(1); }
await sleep(500);

const stamp = () => { const t = Date.now(); return { firstSentAt: t, sentAt: t }; };

// A — a relayed submit.
const A = "RELAY-ALPHA-PROMPT";
const ra = await relay({ frame: { t: "session.input", id: sid, data: A, submit: true, ackId: "rl-a", ...stamp() }, waitMs: 60_000 });
check(ra.status === 200 && ra.json?.ack?.t === "input.ack" && ra.json.ack.ackId === "rl-a" && ra.json.ack.ok === true,
  `A: relayed submit answered with the verbatim input.ack (${ra.status} ${JSON.stringify(ra.json)})`);
check(typed(A) === 1, `A: typed exactly once (${typed(A)})`);
await sleep(1500); // let the stub's turn end before the next prompt

// B — the page re-sends the same ackId.
{
  const since = p1.frames.length;
  p1.send({ t: "session.input", id: sid, data: A, submit: true, ackId: "rl-a", ...stamp() });
  const a = await p1.ack("input.ack", "rl-a", since);
  check(a?.ok === true, `B: the page's re-send is re-acked with the relayed verdict (${JSON.stringify(a)})`);
  await sleep(800);
  check(typed(A) === 1, `B: and not retyped (${typed(A)})`);
}

// C — page first, relay joins the in-flight delivery.
const C = "PAGE-CHARLIE-PROMPT";
{
  const since = p1.frames.length;
  p1.send({ t: "session.input", id: sid, data: C, submit: true, ackId: "pg-c", ...stamp() });
  const rc = await relay({ frame: { t: "session.input", id: sid, data: C, submit: true, ackId: "pg-c", ...stamp() }, waitMs: 60_000 });
  const pa = await p1.ack("input.ack", "pg-c", since);
  check(rc.status === 200 && rc.json?.ack?.ok === true && pa?.ok === true, `C: the relayed repeat is answered like the page's (${JSON.stringify(rc.json)})`);
  await sleep(800);
  check(typed(C) === 1, `C: typed exactly once (${typed(C)})`);
}
await sleep(1500);

// D — refusals.
{
  const raw = await relay({ frame: { t: "session.input", id: sid, data: "RAW-KEYS-DELTA", ackId: "rl-d1" } });
  check(raw.status === 422 && /raw keys/.test(raw.json?.refused ?? ""), `D: raw keys refused in words (${raw.status} ${raw.json?.refused})`);
  const noId = await relay({ frame: { t: "session.input", id: sid, data: "NOID-DELTA", submit: true } });
  check(noId.status === 422 && /ackId/.test(noId.json?.refused ?? ""), `D: no ackId refused (${noId.status})`);
  const get = await relay(undefined, { method: "GET" });
  check(get.status === 405, `D: GET is 405 (${get.status})`);
  await sleep(500);
  check(typed("RAW-KEYS-DELTA") === 0 && typed("NOID-DELTA") === 0, "D: nothing typed for either");
}

// An ORDINARY receipt (page only, never relayed) for E's contrast: an answer to no
// open question — refused `stale`, remembered, nothing typed.
{
  const since = p1.frames.length;
  p1.send({ t: "session.input", id: sid, data: "1\r", expectPrompt: "no-such-question", ackId: "pg-e", ...stamp() });
  const a = await p1.ack("input.ack", "pg-e", since);
  check(a?.state === "stale", `E: an ordinary page receipt exists (${a?.state})`);
}

// E — 46 minutes later, across a restart: move the ledger's clock back on disk.
for (const s of sockets) s.terminate();
sockets.clear();
await host.stop();
{
  const file = join(ROOT, STATE, "acks.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const back = 46 * 60_000;
  check(typeof doc.acks["rl-a"]?.keepUntil === "number", "E: the relayed verdict was persisted with keepUntil");
  check(doc.acks["pg-e"] && doc.acks["pg-e"].keepUntil === undefined, "E: the ordinary one without");
  for (const rec of Object.values(doc.acks)) {
    rec.ts -= back;
    if (typeof rec.keepUntil === "number") rec.keepUntil -= back;
  }
  writeFileSync(file, JSON.stringify(doc));
}
host = await bootHost({ tag: "relay", env: { ...stubEnv, ...rootEnv(ROOT) } });
{
  const p2 = await page();
  p2.send({ t: "session.input", id: sid, data: A, submit: true, ackId: "rl-a", ...stamp() });
  const a = await p2.ack("input.ack", "rl-a");
  check(a?.ok === true, `E: 46 min later the page's re-send of the relayed ackId is still re-acked (${JSON.stringify(a)})`);
  const rr = await relay({ frame: { t: "session.input", id: sid, data: A, submit: true, ackId: "rl-a", ...stamp() }, waitMs: 20_000 });
  check(rr.json?.ack?.ok === true, "E: and so is a relayed one");
  await sleep(1000);
  check(typed(A) === 1, `E: still typed exactly once (${typed(A)})`);
  // The relayed repeat re-wrote the ledger (keepLong extends and flushes): the
  // ordinary receipt of the same age was dropped on load, the relayed one kept.
  const after = JSON.parse(readFileSync(join(ROOT, STATE, "acks.json"), "utf8"));
  check(after.acks["rl-a"] && !after.acks["pg-e"], `E: the ordinary 46-min-old receipt is forgotten, the relayed one kept (${Object.keys(after.acks).join(",")})`);

  // F — a passive token.
  const tokFor = async () => {
    await new Promise((resolve, reject) => {
      p2.send({ t: "auth.set", password: "e2e-relay-password" });
      const end = Date.now() + 5000;
      const tick = () => {
        if (p2.frames.some((f) => f.t === "auth.state" && f.auth?.enabled)) return resolve();
        if (Date.now() > end) return reject(new Error("no auth.state"));
        setTimeout(tick, 25);
      };
      tick();
    });
    const post = (path, body) => fetch(`${host.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const m = await post("/api/pair/mint", { passive: true });
    const r = await post("/api/pair/redeem", { code: m.code, deviceName: "kids phone" });
    return r.scope === "passive" ? r.token : null;
  };
  const kid = await tokFor();
  check(typeof kid === "string", "F: a passive token");
  const pf = await relay({ frame: { t: "session.input", id: sid, data: "PASSIVE-FOXTROT", submit: true, ackId: "rl-f", ...stamp() }, waitMs: 5000 }, { tok: kid });
  check(pf.status === 403 && pf.json?.passive === true, `F: refused 403 to a passive token (${pf.status})`);
  await sleep(500);
  check(typed("PASSIVE-FOXTROT") === 0, "F: nothing typed");
}

await done(failed ? 1 : 0);
