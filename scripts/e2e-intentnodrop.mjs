// The complaint's pin: ten prompts, forty minutes of nothing, and all ten words
// still there.
//
// > "some of my prompts on which I spent a lot of work got lost from the list
// >  and apparently also did not make it to a CLI session"
//
// That was not the network. It was the machinery: the browser's send queue
// expired an entry at thirty minutes ("queued too long"), retired the failed
// row an hour later, clipped the words to two hundred characters in a ledger
// that kept them for a day, and the host's ack ledger forgot every verdict
// after forty-five. Four clocks, none of which knew anything about whether the
// work still mattered, and between them a message written on a train was gone
// by the evening.
//
// So this script is deliberately about TIME AND NOTHING ELSE. Nothing here
// fails, nothing is refused, no session dies. The host is simply handed ten
// pieces of work and then taken away for longer than every one of those clocks,
// and the assertions are the three the old design could not make:
//
//   1. all ten rows are still there, and their text is BYTE-IDENTICAL — not
//      clipped to a head, not summarised, not moved to a second store;
//   2. none of them is `failed`, `canceled` or gone. Waiting is not a verdict;
//   3. re-posting the same intent ids past a WIPED ack ledger upserts onto the
//      same ten rows rather than making ten more. That is the guard that
//      replaced the phone's thirty-minute TTL: at-most-once now keys on an
//      intent id that lives as long as the row, so there is nothing left for a
//      deadline to protect.
//
// The clock is faked on DISK rather than waited out: the host is killed, every
// row's timestamps are moved back beyond the longest of the four windows, and
// the ack ledger is deleted outright — which is exactly the state a host that
// really was down for forty minutes boots into.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { readIntents, waitForHost } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8861;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-nodrop-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const LOG = join(ROOT, "stub-input.log");
const STORE_DIR = join(ROOT, STATE);
const INTENTS = join(STORE_DIR, "intents.json");
const ACKS = join(STORE_DIR, "acks.json");

/** Longer than every clock this replaces: the phone's 30-minute queue TTL, its
 *  hour-long retire, and the host ack ledger's 45 minutes. */
const GONE_MS = 90 * 60_000;

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ten prompts, each long enough that a 200-character clip would be visible, and
// each distinct so a row that came back holding another row's words is caught.
const WORDS = Array.from({ length: 10 }, (_, i) =>
  `Prompt ${i + 1}: ` + `work out why the settle sweep re-reads the conversation log for session ${i + 1} `.repeat(6)
  + `and write the answer down. Do not summarise this — every character of it is part of the request. (#${i + 1})`);
const ID = (i) => `nodrop-${i + 1}`;

writeFileSync(LOG, "");
const env = {
  ...process.env,
  // Every host-spawning script pins these: a stub must never reach the shared
  // tmux server, and the boot doctor must never print into asserted output.
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
  [E.INTENT_TICK_MS]: "300",
  STUB_MODE: "repaint", STUB_LOG: LOG,
};
// Auto-fire is off by default and nothing here turns it on. This script is
// about words surviving, not about work starting: a row that RAN would leave
// the store legitimately, and "all ten are still here" would then be testing
// nothing at all.

const boot = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return h;
};

const base = `http://127.0.0.1:${PORT}`;
const rows = () => readIntents(INTENTS);
const row = (id) => rows().find((r) => r.id === id);
const waitFor = async (pred, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(150); }
  return false;
};

const opAcks = [];
let intents = [];
const connect = () => new Promise((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  sock.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "op.ack") opAcks.push(m);
    if (m.t === "intent.list") intents = m.intents;
    // …and one row per transition. The host stopped rebroadcasting the whole
    // store on every change (one row changed is one row on the wire), so a
    // reader that ignores `intent.changed` holds a snapshot as old as its last
    // explicit ask. The real client applies both; so does this.
    if (m.t === "intent.changed") {
      const at = intents.findIndex((i) => i.id === m.intent.id);
      if (at < 0) intents.push(m.intent); else intents[at] = m.intent;
    }
  });
  sock.on("open", () => { sock.send(JSON.stringify({ t: "hello", protocol: 1 })); setTimeout(() => resolve(sock), 400); });
});

// ── 0. A repo to aim at ──────────────────────────────────────────────────
let host = boot();
await waitForHost(PORT);
const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "alpha" }),
}).then((r) => r.json());

// ── 1. Ten pieces of work, handed over ───────────────────────────────────
let ws = await connect();
const postAll = (tag) => {
  for (let i = 0; i < WORDS.length; i++) {
    ws.send(JSON.stringify({
      t: "intent.post", ackId: `${tag}-${i}`,
      intent: {
        id: ID(i), cwd: repo.path,
        payload: { kind: "prompt", steps: [WORDS[i]] },
        // A work item aimed at the repo, opening its own session when it runs.
        // Deliberately the most ordinary shape there is: this is what "queue it
        // for later" produces, and it is what the phone used to hold on to and
        // then shred at thirty minutes.
        target: { kind: "repo", fresh: true },
        trigger: { kind: "idle" },
        auto: true,
        label: `nodrop ${i + 1}`,
      },
    }));
  }
};
postAll("a");
check(await waitFor(() => opAcks.filter((a) => a.ok && a.ackId.startsWith("a-")).length === 10, 12000),
  `all ten are acked (${opAcks.filter((a) => a.ok).length})`);
// The ack is not a promise about intent — it is a promise about the DISK. The
// row has to be readable the instant the receipt lands, because that is the
// moment the phone is told it may forget the words.
check(rows().length === 10, `…and the store already holds ten rows when the receipts land (${rows().length})`);
check(WORDS.every((w, i) => row(ID(i))?.payload?.steps?.[0] === w),
  "…each with its prompt byte-identical on disk");

// ── 2. Forty minutes of nothing ──────────────────────────────────────────
ws.close();
host.kill();
await sleep(600);

// Every clock this design deleted, wound past. `createdAt` is what a TTL would
// have measured from; the ack ledger is deleted outright, which is what its own
// 45-minute expiry does to a verdict and what makes an ackId retry unsafe on
// its own.
const aged = rows().map((r) => ({ ...r, createdAt: r.createdAt - GONE_MS }));
writeFileSync(INTENTS, JSON.stringify(aged, null, 2));
rmSync(ACKS, { force: true });
check(!existsSync(ACKS), "the ack ledger is gone — the fast path has forgotten every verdict");

host = boot();
await waitForHost(PORT);
ws = await connect();
ws.send(JSON.stringify({ t: "intent.list" }));
await waitFor(() => intents.length > 0, 8000);

// The three assertions the old design could not make.
check(rows().length === 10, `all ten rows survived the outage (${rows().length})`);
const mismatched = WORDS.filter((w, i) => row(ID(i))?.payload?.steps?.[0] !== w);
check(mismatched.length === 0,
  `…with every prompt still whole — no clip, no head, no summary (${mismatched.length} differ)`);
const settled = rows().filter((r) => r.state === "failed" || r.state === "canceled" || r.state === "done");
check(settled.length === 0,
  `…and not one of them was given up on for waiting (${settled.map((r) => `${r.id}:${r.state}`).join(", ") || "none"})`);
// The sentence that used to be here instead. A row may be BLOCKED — nothing is
// firing, auto-fire is off — but "blocked" says what is standing in the way and
// clears itself; "queued too long" said the user had waited, and was terminal.
const excuse = rows().find((r) => JSON.stringify(r).includes("too long"));
check(!excuse, `nothing in the store says anything was queued too long (${excuse?.id ?? "clean"})`);
check(intents.length === 10, `…and the client is told about all ten on reconnect (${intents.length})`);

// ── 3. The replay past a forgotten ledger ────────────────────────────────
// This is the guard that made deleting the phone's TTL safe. With the ack
// ledger wiped, a re-send of the same work is indistinguishable from new work
// AS AN ACKID — so at-most-once has to key on something that outlives it. It
// does: the intent id, for the row's whole life.
postAll("b");
check(await waitFor(() => opAcks.filter((a) => a.ok && a.ackId.startsWith("b-")).length === 10, 12000),
  "a replay past the wiped ledger is accepted rather than refused");
await sleep(800);
check(rows().length === 10, `…and upserts onto the same ten rows rather than making ten more (${rows().length})`);
check(WORDS.every((w, i) => row(ID(i))?.payload?.steps?.[0] === w), "…still holding the same ten prompts");

// ── 4. And it is still work, not a museum ────────────────────────────────
// A row that survived the outage has to be RUNNABLE, or "nothing was lost" is
// a claim about storage rather than about the user's work. One of the ten is
// fired by hand and must reach the stub.
const probe = "Prompt 7:";
ws.send(JSON.stringify({ t: "intent.run", id: ID(6), ackId: "run-7" }));
check(await waitFor(() => { try { return readFileSync(LOG, "utf8").includes(probe); } catch { return false; } }, 25000),
  "a prompt written before a forty-minute outage still runs when it is asked to");

ws.close();
host.kill();
await sleep(200);
rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
