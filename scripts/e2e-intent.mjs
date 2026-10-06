// The durable Intent store: what "the host has it" is worth.
//
// The complaint this whole rework answers is prompts that were lost — and the
// promise made in exchange is narrow and checkable: **`op.ack ok` means the
// words are on the desktop's disk, and nothing after that may lose them.** That
// promise has exactly three ways to be broken, and this script is one assertion
// per way:
//
//  1. the ack goes out before the write. Pinned by reading `<state>/intents.json`
//     the instant the receipt lands, and then by `kill -9` — not SIGTERM, which
//     would let a flush handler paper over a store that only persists on exit.
//  2. the second delivery. The ack ledger forgets after 45 minutes and a parked
//     create may wait six hours, so at-most-once has to survive the ledger being
//     gone entirely: the ledger file is DELETED here and the same intent id is
//     posted again under a fresh ackId. It must upsert, answer with the same
//     row, and run once.
//  3. the crash mid-fire. A schedule stamps the occurrence it is spending
//     BEFORE the executor runs, so the one thing a restart may never do is run
//     that occurrence again. Pinned by writing the exact on-disk state a crash
//     in that gap leaves and booting into it.
//
// Plus the migration, because a store nobody's existing rows reach is a store
// nobody has: a legacy `launches.json` is imported once, renamed rather than
// deleted, and the launch it was holding still opens.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { readIntents } from "./lib-e2e.mjs";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8853;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-intent-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const LOG = join(ROOT, "stub-input.log");
const STORE_DIR = join(ROOT, STATE);
const INTENTS = join(STORE_DIR, "intents.json");

const LEGACY_REL = ".claude/inbox/legacy-shot.jpg";
const LEGACY_TEXT = `Look at ${LEGACY_REL} and describe it`;
const LEGACY_PROBE = `Look at ${LEGACY_REL}`;
const MINE_REL = ".claude/inbox/mine-shot.jpg";
const MINE_TEXT = `Compare ${MINE_REL} against the mock and list every difference`;
const MINE_PROBE = `Compare ${MINE_REL}`;
const SPENT_PROBE = "MUST-NOT-FIRE-TWICE";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(LOG, "");
const env = {
  ...process.env,
  // e2e must never touch the shared tmux server, and the boot doctor must never
  // print into output these scripts assert on.
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
  [E.INTENT_TICK_MS]: "300",
  STUB_MODE: "repaint", STUB_LOG: LOG,
};

let host = null;
const boot = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return h;
};

const base = `http://127.0.0.1:${PORT}`;
const log = () => { try { return readFileSync(LOG, "utf8"); } catch { return ""; } };
const count = (probe) => log().split(probe).length - 1;
const rows = () => readIntents(INTENTS);
const row = (id) => rows().find((r) => r.id === id);
const waitFor = async (pred, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(150); }
  return false;
};

// One socket per boot. Every list the script asserts on is kept in these.
let ws = null;
const opAcks = [];
const opened = [];
let launches = [];
let intents = [];
const sessions = new Map();
const connect = () => new Promise((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  sock.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created") sessions.set(m.session.id, m.session);
    if (m.t === "session.list") for (const s of m.sessions) sessions.set(s.id, s);
    if (m.t === "op.ack") opAcks.push(m);
    if (m.t === "launch.list") launches = m.launches;
    if (m.t === "intent.list") intents = m.intents;
    // …and one row per transition. The host stopped rebroadcasting the whole
    // store on every change (one row changed is one row on the wire), so a
    // reader that ignores `intent.changed` holds a snapshot as old as its last
    // explicit ask. The real client applies both; so does this.
    if (m.t === "intent.changed") {
      const at = intents.findIndex((i) => i.id === m.intent.id);
      if (at < 0) intents.push(m.intent); else intents[at] = m.intent;
    }
    if (m.t === "launch.opened") opened.push(m);
  });
  sock.on("open", () => { sock.send(JSON.stringify({ t: "hello", protocol: 1 })); setTimeout(() => resolve(sock), 400); });
});

// ── 0. A repo to aim at ──────────────────────────────────────────────────
host = boot();
await sleep(1000);
const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "alpha" }),
}).then((r) => r.json());
const repos = await fetch(`${base}/api/repos`).then((r) => r.json());
const target = repos.targets.find((r) => r.worktreePath === repo.path);
const upload = (name) => fetch(`${base}/api/repos/${target.id}/inbox`, {
  method: "POST",
  headers: { "content-type": "application/octet-stream", "x-file-name": name, "x-dedupe": "1" },
  body: Buffer.from("not-really-a-jpeg-but-bytes-are-bytes"),
}).then((r) => r.json());
host.kill();
await sleep(600);

// ── 1. Migration: the rows an upgraded host finds on disk ────────────────
// Written in the shape `launch.ts` used to persist, which is exactly what a
// host upgraded across this change wakes up to.
mkdirSync(STORE_DIR, { recursive: true });
writeFileSync(join(STORE_DIR, "launches.json"), JSON.stringify([{
  id: "legacy-launch-1", cwd: repo.path, repoName: "alpha", prompt: LEGACY_TEXT,
  needs: [LEGACY_REL], createdAt: Date.now() - 60_000, deadlineAt: Date.now() + 3600e3,
  state: "waiting", missing: [LEGACY_REL], cols: 80, rows: 24, title: "alpha · legacy",
}], null, 2));

host = boot();
await sleep(1200);
ws = await connect();
ws.send(JSON.stringify({ t: "launch.list" }));
await waitFor(() => launches.length > 0, 6000);

const migrated = launches.find((l) => l.id === "legacy-launch-1");
check(migrated?.state === "waiting", `a legacy launch is imported and still waiting (${migrated?.state})`);
check(migrated?.needs?.includes(LEGACY_REL), `…still naming the file it is short of (${JSON.stringify(migrated?.needs)})`);
check(!existsSync(join(STORE_DIR, "launches.json")) && existsSync(join(STORE_DIR, "launches.json.migrated")),
  "the legacy file is imported once and RENAMED — a conversion nobody can check is one nobody can trust");
const legacyRow = row("legacy-launch-1");
check(legacyRow?.trigger?.kind === "files" && legacyRow?.target?.fresh === true,
  "…and lives in the intent store as a files-triggered fresh-session intent");
check(legacyRow?.payload?.steps?.[0] === LEGACY_TEXT, "…with the prompt in full");

await upload("legacy-shot.jpg");
check(await waitFor(() => count(LEGACY_PROBE) >= 1, 20000), "the file landing opens it — the migrated row still works");
await sleep(1200);
check(count(LEGACY_PROBE) === 1, `…exactly once (copies: ${count(LEGACY_PROBE)})`);

// ── 2. The ack means the disk ────────────────────────────────────────────
const spawnedBefore = sessions.size;
const post = (ackId) => ws.send(JSON.stringify({
  t: "intent.post", ackId,
  intent: {
    id: "mine-1", cwd: repo.path,
    payload: { kind: "prompt", steps: [MINE_TEXT] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "files", needs: [MINE_REL], deadlineAt: Date.now() + 3600e3 },
    title: "alpha · mine",
  },
}));
post("ip-1");
await waitFor(() => opAcks.some((a) => a.ackId === "ip-1"), 8000);
// Read the file the INSTANT the receipt lands: an ack that outran the write
// would show up here as a missing row, which is precisely the failure the
// phone was being asked to trust.
const onDiskNow = row("mine-1");
const ack1 = opAcks.find((a) => a.ackId === "ip-1");
check(ack1?.ok === true, "intent.post is acked ok");
check(ack1?.intentId === "mine-1", `…naming the row (${ack1?.intentId})`);
check(!ack1?.sessionId, "…and NOT a session — accepted is not open");
check(ack1?.launchId === "mine-1", "…while a files-trigger keeps the old launchId name, so an old bundle still binds");
check(onDiskNow?.payload?.steps?.[0] === MINE_TEXT,
  "the row is on disk BEFORE the ack goes out — un-clipped, in full");
check(sessions.size === spawnedBefore, `nothing was spawned by the post (sessions: ${sessions.size}, was ${spawnedBefore})`);

// ── 3. kill -9, and the row is still there ───────────────────────────────
// SIGKILL rather than SIGTERM on purpose: a store that only wrote on a clean
// exit would pass a SIGTERM test and lose everything on the crash it exists for.
host.kill("SIGKILL");
ws.close();
await sleep(700);
// `blocked` is the honest on-disk state for a row waiting on a file — and it is
// recomputed on load rather than trusted, so what matters here is that the row
// and its words are still there at all.
const survived = row("mine-1");
check(!!survived && survived.state !== "done" && survived.state !== "failed",
  `the row survives kill -9, still pending (${survived?.state})`);
check(survived?.payload?.steps?.[0] === MINE_TEXT, "…with its words, un-clipped, after a crash");

// ── 4. A replay past a WIPED ack ledger upserts, never doubles ───────────
// The ledger's TTL is 45 minutes; a parked create may wait six hours. So
// at-most-once cannot rest on it, and this deletes it outright to prove that.
rmSync(join(STORE_DIR, "acks.json"), { force: true });
host = boot();
await sleep(1200);
ws = await connect();
ws.send(JSON.stringify({ t: "intent.list" }));
await waitFor(() => intents.length > 0, 6000);
check(intents.some((i) => i.id === "mine-1"), "the restarted host lists the row it was holding");

post("ip-2");
await waitFor(() => opAcks.some((a) => a.ackId === "ip-2"), 8000);
await sleep(800);
const ack2 = opAcks.find((a) => a.ackId === "ip-2");
check(ack2?.ok === true && ack2?.intentId === "mine-1",
  `a replay under a NEW ackId with no ledger to help gets the SAME row (${ack2?.intentId})`);
check(rows().filter((r) => r.id === "mine-1").length === 1, "…and there is exactly one of it");
check(rows().filter((r) => r.payload?.steps?.[0] === MINE_TEXT).length === 1,
  "…one row for those words, however many posts carried them");

await upload("mine-shot.jpg");
check(await waitFor(() => count(MINE_PROBE) >= 1, 20000), "it opens when its file lands");
await sleep(1500);
check(count(MINE_PROBE) === 1, `and the prompt is typed exactly ONCE, not once per post (copies: ${count(MINE_PROBE)})`);

// ── 5. The crash mid-fire: an occurrence already spent is never re-spent ─
// A schedule stamps `lastOccurrence` and flips to `starting` BEFORE its
// executor runs. This writes exactly the state a crash in that gap leaves —
// occurrence spent, nothing recorded as having happened — and boots into it.
// The one thing that must not follow is the sweep running.
host.kill("SIGKILL");
ws.close();
await sleep(700);

const occurrence = Date.now() - 2 * 60_000;
const clock = new Date(occurrence);
const kept = rows().filter((r) => r.id !== "spent-1");
kept.push({
  id: "spent-1", cwd: repo.path,
  payload: { kind: "prompt", steps: [`${SPENT_PROBE} — audit everything`] },
  target: { kind: "repos", dirs: [repo.path] },
  trigger: { kind: "at", rule: { kind: "weekly", days: [], hour: clock.getHours(), minute: clock.getMinutes(), offsetMin: 0 }, graceMin: 120 },
  title: "nightly sweep",
  // The crash state, verbatim: spent, and mid-flight.
  state: "starting", startedAt: occurrence, lastOccurrence: occurrence, nextAt: occurrence,
  createdAt: occurrence - 3600e3,
});
writeFileSync(INTENTS, JSON.stringify(kept, null, 2));

host = boot();
await sleep(1500);
ws = await connect();
await sleep(2500); // several ticks: a re-fire would have happened by now
check(count(SPENT_PROBE) === 0, `an occurrence spent before the crash is NOT run again (copies: ${count(SPENT_PROBE)})`);
const spent = row("spent-1");
check(spent?.state === "queued" || spent?.state === "blocked",
  `the recurring row keeps standing rather than failing (${spent?.state})`);
check(spent?.result?.ok === false && /restarted/.test(spent?.result?.detail ?? ""),
  `…and says what happened to that occurrence ("${spent?.result?.detail}")`);
check(spent?.lastOccurrence === occurrence, "…the occurrence stays spent");
check(spent?.nextAt > Date.now() + 12 * 3600e3,
  `…and the NEXT one is armed, ahead (${spent?.nextAt ? new Date(spent.nextAt).toISOString() : spent?.nextAt})`);

// ── 6. Cancel and dismiss ────────────────────────────────────────────────
ws.send(JSON.stringify({
  t: "intent.post", ackId: "ip-3",
  intent: {
    id: "doomed-1", cwd: repo.path,
    payload: { kind: "prompt", steps: ["MUST-NEVER-RUN — cancelled before its file arrived"] },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "files", needs: [".claude/inbox/never.jpg"], deadlineAt: Date.now() + 3600e3 },
  },
}));
await waitFor(() => opAcks.some((a) => a.ackId === "ip-3"), 8000);
ws.send(JSON.stringify({ t: "intent.cancel", id: "doomed-1" }));
check(await waitFor(() => row("doomed-1")?.state === "canceled", 6000),
  `a cancel settles the row (${row("doomed-1")?.state})`);
check(count("MUST-NEVER-RUN") === 0, "…and it never ran");
check(!row("doomed-1")?.dismissedAt, "a cancelled row is NOT dismissed by cancelling it");
ws.send(JSON.stringify({ t: "intent.dismiss", id: "doomed-1" }));
check(await waitFor(() => !!row("doomed-1")?.dismissedAt, 6000),
  "dismiss is its own act — the gate a terminal row passes before it may ever be compacted away");
check(!!row("doomed-1")?.payload?.steps?.[0], "…and even then the words are still in the row");

ws.close();
host.kill();
await sleep(200);
process.exit(failed ? 1 : 0);
