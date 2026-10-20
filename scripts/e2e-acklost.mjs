// A host that boots with an UNREADABLE ack ledger fails CLOSED on a re-send
// first sent before the loss — and runs everything else as it always did.
//
// The ledger (`acks.json`) is the host's memory of which ackIds it already
// handled; it is what turns a phone's retry into a re-ack instead of a second
// session / second prompt / second work item. When it is corrupt at boot it is
// kept aside (`lost`), and from then on the only thing that tells a pre-loss
// retry from a new op is the message's own `firstSentAt` + `sentAt`
// (`shared/sendstamp.ts`). This boots a real host onto a corrupt file and sends,
// on each of the three ackId paths (durableOp, session.input, backlog.add):
//
//   • a re-send first sent ten minutes before the boot ⇒ refused in the one
//     sentence, NOTHING run, and a replay of the same ackId re-acked the same;
//   • a fresh send (first sent now) ⇒ runs;
//   • no `firstSentAt` at all (an older client) ⇒ runs — the old behaviour.
//
// Both stamps are sent on a phone clock an HOUR AHEAD of the desktop's, so the
// pass also proves the comparison is skew-free (it reads the AGE, not the time).
import { watchdog } from "./lib-watchdog.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { LOST_LEDGER_MARGIN_MS, LOST_LEDGER_REFUSAL } from "../packages/shared/dist/index.js";
import { bootHost } from "./lib-e2e.mjs";
import { E, SLUG } from "./lib-brand.mjs";

const STATE_DIR = join(mkdtempSync(join(tmpdir(), `${SLUG}-acklost-`)), "state");
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(join(STATE_DIR, "acks.json"), '{"updatedAt":1,"acks":{"old-op":{"ts":'); // truncated mid-write

const { port: PORT, stop } = await bootHost({ tag: "acklost", env: { [E.STATE_DIR]: STATE_DIR } });
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const done = async () => { await stop(); process.exit(failed ? 1 : 0); };
watchdog(() => { console.log("FAIL: timeout"); failed = true; void done(); }).unref();

const SKEW = 3_600_000; // the phone's clock runs an hour ahead
const phoneNow = () => Date.now() + SKEW;
const preLoss = () => ({ firstSentAt: phoneNow() - 10 * 60_000, sentAt: phoneNow() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = () => { const t = phoneNow(); return { firstSentAt: t, sentAt: t }; };

const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "acklost" }),
}).then((r) => r.json());
const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());
const cwd = repos.targets.find((t) => t.worktreePath === repo.path)?.worktreePath ?? repos.targets[0]?.worktreePath;
if (!cwd) { console.log("FAIL: no repo"); failed = true; await done(); }

// The margin errs CLOSED: a first send inside LOST_LEDGER_MARGIN_MS of the boot
// is still refused (transit could hide a pre-loss send there). Wait it out, so
// "fresh" below means fresh.
await sleep(LOST_LEDGER_MARGIN_MS + 500);

const frames = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
ws.send(JSON.stringify({ t: "hello", protocol: 2 }));
const send = (m) => ws.send(JSON.stringify(m));
async function receipt(t, ackId, since, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hits = frames.slice(since).filter((f) => f.t === t && f.ackId === ackId);
    if (hits.length) return hits[hits.length - 1];
    await sleep(25);
  }
  return null;
}
const created = (since) => frames.slice(since).filter((f) => f.t === "session.created");

// ── durableOp: session.create ──
{
  const since = frames.length;
  send({ t: "session.create", cwd, cols: 80, rows: 24, ackId: "op-pre", ...preLoss() });
  const a = await receipt("op.ack", "op-pre", since);
  check(a && a.ok === false && a.reason === LOST_LEDGER_REFUSAL, `pre-loss create refused in words (${a && (a.reason ?? a.ok)})`);
  await sleep(800);
  check(created(since).length === 0, "and nothing was spawned");
  const s2 = frames.length;
  send({ t: "session.create", cwd, cols: 80, rows: 24, ackId: "op-pre", ...preLoss() });
  const b = await receipt("op.ack", "op-pre", s2);
  check(b && b.ok === false && b.reason === LOST_LEDGER_REFUSAL, "its retry is re-acked with the same refusal");
}
let sid = null;
{
  const since = frames.length;
  send({ t: "session.create", cwd, cols: 80, rows: 24, ackId: "op-fresh", ...fresh() });
  const a = await receipt("op.ack", "op-fresh", since);
  check(a && a.ok === true && !!a.sessionId, `a fresh create runs (${a && (a.reason ?? a.sessionId)})`);
  sid = a?.sessionId ?? null;
}
{
  const since = frames.length;
  send({ t: "session.create", cwd, cols: 80, rows: 24, ackId: "op-bare" });
  const a = await receipt("op.ack", "op-bare", since);
  check(a && a.ok === true && !!a.sessionId, "a create with no firstSentAt (older client) runs");
}

// ── session.input ──
if (sid) {
  await sleep(500);
  const since = frames.length;
  send({ t: "session.input", id: sid, data: "echo pre\r", ackId: "in-pre", ...preLoss() });
  const a = await receipt("input.ack", "in-pre", since);
  check(a && a.ok === false && a.reason === LOST_LEDGER_REFUSAL && a.retryable === false, `pre-loss input refused, not retryable (${a && a.reason})`);
  const s2 = frames.length;
  send({ t: "session.input", id: sid, data: "echo fresh\r", ackId: "in-fresh", ...fresh() });
  const b = await receipt("input.ack", "in-fresh", s2);
  check(b && b.ok === true, "a fresh input is delivered");
  const s3 = frames.length;
  send({ t: "session.input", id: sid, data: "echo bare\r", ackId: "in-bare" });
  const c = await receipt("input.ack", "in-bare", s3);
  check(c && c.ok === true, "an input with no firstSentAt is delivered");
}

// ── backlog.add ──
{
  const since = frames.length;
  send({ t: "backlog.add", text: "pre-loss item", repoDir: cwd, ackId: "bl-pre", ...preLoss() });
  const a = await receipt("backlog.ack", "bl-pre", since);
  check(a && a.ok === false && a.reason === LOST_LEDGER_REFUSAL && !a.itemId, "pre-loss backlog.add refused, no item");
  const s2 = frames.length;
  send({ t: "backlog.add", text: "fresh item", repoDir: cwd, ackId: "bl-fresh", ...fresh() });
  const b = await receipt("backlog.ack", "bl-fresh", s2);
  check(b && b.ok === true && !!b.itemId, "a fresh backlog.add lands");
  const s3 = frames.length;
  send({ t: "backlog.add", text: "bare item", repoDir: cwd, ackId: "bl-bare" });
  const c = await receipt("backlog.ack", "bl-bare", s3);
  check(c && c.ok === true && !!c.itemId, "a backlog.add with no firstSentAt lands");
}

ws.close();
await done();
