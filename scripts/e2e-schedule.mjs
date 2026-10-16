// Scheduled prompts: a wall-clock rule that fires a sweep on its own.
//
// Two halves, because the feature has two ways to be wrong:
//
//  A. the CLOCK (pure, shared/schedule.js). A weekly anchor is a wall clock in a
//     NAMED zone with a lead time — "Thursday 18:00 Europe/Berlin, 2h before".
//     The failures that matter are silent: an hour of DST drift, an offset that
//     crosses midnight and lands on the wrong day, a `once` in the past that
//     re-arms itself forever.
//  B. the HOST. It must fire ONCE per occurrence (a fan-out is N claude
//     processes — the one thing in this app that must never be duplicated),
//     catch up a fire it slept through, refuse to catch up one that is stale,
//     and survive a restart with the schedule intact.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { readIntents, waitForHost } from "./lib-e2e.mjs";
import { cleanAction, cleanRule, describeRule, nextFireAt } from "../packages/shared/dist/schedule.js";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8829;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-schedule-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const LOG = join(ROOT, "stub-input.log");
const TEXT = "Audit this project for hardcoded credentials";
const PROBE = "Audit this project for hardcoded";
const LATE_TEXT = "Groom the CLAUDE.md file";
const LATE_PROBE = "Groom the CLAUDE.md";

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A. the clock ─────────────────────────────────────────────────────

/** Wall clock of `epoch` in `tz`, as { dow, hh, mm } — what the user would read. */
const inZone = (epoch, tz) => {
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit",
  }).formatToParts(new Date(epoch))) if (part.type !== "literal") p[part.type] = part.value;
  return { dow: p.weekday, hh: Number(p.hour), mm: Number(p.minute), day: p.day };
};

const BERLIN = "Europe/Berlin";
// Thursday 18:00 Berlin, fire 2h before it.
const weekly = { kind: "weekly", days: [4], hour: 18, minute: 0, tz: BERLIN, offsetMin: -120 };

// Winter (CET, +01) and summer (CEST, +02): the SAME wall clock either side of a
// DST switch. An epoch computed once and stored would be an hour out for half
// the year — which is the whole reason the zone is stored instead.
const winter = nextFireAt(weekly, Date.parse("2026-01-05T12:00:00Z"));
const summer = nextFireAt(weekly, Date.parse("2026-07-06T12:00:00Z"));
const w = inZone(winter, BERLIN), s = inZone(summer, BERLIN);
check(w.dow === "Thu" && w.hh === 16 && w.mm === 0, `winter: Thu 16:00 Berlin (got ${w.dow} ${w.hh}:${w.mm})`);
check(s.dow === "Thu" && s.hh === 16 && s.mm === 0, `summer (DST): still Thu 16:00 Berlin (got ${s.dow} ${s.hh}:${s.mm})`);
check(new Date(winter).getUTCHours() === 15 && new Date(summer).getUTCHours() === 14,
  `the same wall clock is a DIFFERENT instant across DST (UTC ${new Date(winter).getUTCHours()} vs ${new Date(summer).getUTCHours()})`);

// A lead time that crosses midnight moves the fire to the PREVIOUS day. The
// anchor day is what the user picked; the fire day is derived.
const early = nextFireAt({ kind: "weekly", days: [1], hour: 1, minute: 0, tz: BERLIN, offsetMin: -180 }, Date.parse("2026-03-01T00:00:00Z"));
const e = inZone(early, BERLIN);
check(e.dow === "Sun" && e.hh === 22, `Mon 01:00 minus 3h fires Sun 22:00 (got ${e.dow} ${e.hh}:${e.mm})`);

// Empty days = every day; consecutive occurrences are exactly 24h apart outside DST.
const d1 = nextFireAt({ kind: "weekly", days: [], hour: 9, minute: 30, tz: BERLIN }, Date.parse("2026-06-01T00:00:00Z"));
const d2 = nextFireAt({ kind: "weekly", days: [], hour: 9, minute: 30, tz: BERLIN }, d1);
check(d2 - d1 === 24 * 3600e3, `no days = daily (gap ${(d2 - d1) / 3600e3}h)`);

// A `once` is spent: past its instant there is no next fire, ever.
const t0 = Date.parse("2026-05-01T20:00:00Z");
check(nextFireAt({ kind: "once", at: t0 }, t0 - 1000) === t0, "once fires at its instant");
check(nextFireAt({ kind: "once", at: t0 }, t0) === null, "a spent once never fires again");
check(nextFireAt({ kind: "once", at: t0, offsetMin: -60 }, t0 - 3600e3 - 1) === t0 - 3600e3, "once honours its offset");

// A garbage zone must not silently become host-local at a plausible-looking
// hour — it is dropped, and the row then says "host time".
check(cleanRule({ kind: "weekly", tz: "Mars/Olympus", hour: 9 }).tz === undefined,
  "an unknown zone is dropped, never guessed");
check(cleanAction({ kind: "fanout", dirs: [], text: "hi" }) === null,
  "an action with no target is refused, not stored");
check(describeRule(weekly).includes("Thu") && describeRule(weekly).includes("2h before"),
  `the rule describes the ANCHOR and the lead separately ("${describeRule(weekly)}")`);

// A `window` row written before `oneShot` existed carries no such key at all —
// on disk, or on the wire from a phone one build behind. `cleanRule` must read
// that absence as "recurs", exactly as it always has, or every schedule
// written before this feature shipped changes behaviour on the next restart.
const oldWindowRow = { kind: "window", window: "session", edge: "before", offsetMin: -60, minPctLeft: 25 };
check(cleanRule(oldWindowRow).oneShot === undefined,
  "a pre-oneShot window row round-trips with no oneShot key — still recurring");
check(cleanRule({ ...oldWindowRow, oneShot: true }).oneShot === true,
  "a oneShot:true window row survives cleanRule unchanged");
check(cleanRule({ kind: "weekly", days: [4], hour: 18, oneShot: true }).oneShot === true,
  "a oneShot:true weekly row survives cleanRule unchanged");

// The grace clamp, as `intents/manager.ts`'s `armFrom` applies it: the search
// never starts further back than `now - graceMin`, so an occurrence missed
// while the host was down is still AHEAD of the floor and comes back as due,
// while one missed by a week is behind it and is never considered at all.
// (Stated against `nextFireAt` and the floor themselves — the old `cleanEntry`
// that used to carry this clamp is gone, and the manager owns it now.)
const now = Date.now();
const armFrom = (at, graceMin, basis) =>
  nextFireAt({ kind: "once", at }, Math.max(basis, now - graceMin * 60_000 - 1));
check(armFrom(now - 20 * 60_000, 120, now - 30 * 60_000) === now - 20 * 60_000,
  "a fire missed inside the grace stays DUE (host was asleep)");
check(armFrom(now - 8 * 24 * 3600e3, 120, now - 9 * 24 * 3600e3) === null,
  "a fire missed by days is not caught up");

// ── B. the host ──────────────────────────────────────────────────────

writeFileSync(LOG, "");
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
  [E.INTENT_TICK_MS]: "1000",
  STUB_MODE: "repaint", STUB_LOG: LOG,
};
const boot = () => {
  const h = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  h.stderr.on("data", (d) => process.stderr.write("[host] " + d));
  return h;
};
let host = boot();
const base = `http://127.0.0.1:${PORT}`;
await waitForHost(PORT);

const mk = (name) => fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
}).then((r) => r.json());
const a = await mk("alpha");
const b = await mk("beta");

let schedules = [];
let items = [];
let runs = [];
const sessions = new Map();
const connect = () => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "schedule.list") { schedules = m.entries; resolve(ws); }
    // A one-off aimed at ONE repo is a BACKLOG row now, so this script has to
    // listen to the other list to see one at all.
    if (m.t === "backlog.list") items = m.items;
    if (m.t === "fanout.run") runs = [m.run, ...runs.filter((r) => r.id !== m.run.id)];
    if (m.t === "session.created") sessions.set(m.session.id, m.session);
  });
});
let ws = await connect();

const log = () => { try { return readFileSync(LOG, "utf8"); } catch { return ""; } };
const count = (probe) => log().split(probe).length - 1;
const waitFor = async (pred, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(200); }
  return false;
};
const entry = (id) => schedules.find((e) => e.id === id);
const item = (id) => items.find((i) => i.id === id);

// A `once` two seconds out, fanning the prompt into both repos.
ws.send(JSON.stringify({
  t: "schedule.save",
  entry: {
    id: "sched-once", name: "tonight's audit", enabled: true, graceMin: 120,
    rule: { kind: "once", at: Date.now() + 2000 },
    action: { kind: "fanout", dirs: [a.path, b.path], text: TEXT },
  },
}));
await waitFor(() => entry("sched-once"));
check(!!entry("sched-once")?.nextAt, `the host arms it and reports nextAt (${entry("sched-once")?.nextAt})`);

const fired = await waitFor(() => count(PROBE) >= 2, 25000);
await sleep(2500); // let a would-be second fire happen before counting
check(fired && count(PROBE) === 2, `fired once per repo, exactly once (copies: ${count(PROBE)})`);
check(runs[0]?.targets.length === 2, `it went through the normal fan-out (${runs[0]?.targets.length} targets)`);
check([...sessions.values()].map((s) => s.cwd).sort().join() === [a.path, b.path].sort().join(),
  "a fresh session per repo, in that repo's cwd");
// A spent one-shot STAYS. `schedule.ts` deleted it — row, prompt text and all —
// so an occurrence that never ran was indistinguishable afterwards from one
// that had, and the words were simply gone. Under the intent store the row
// survives, disarmed, saying what it did.
const spent = entry("sched-once");
check(!!spent, "a spent one-shot stays in the list — its words are not deleted with it");
check(spent?.enabled === false && spent?.nextAt === null, `…disarmed, with nothing next (${spent?.nextAt})`);
check(spent?.lastResult?.ok === true && spent?.action?.text === TEXT,
  `…and saying what it did, with the prompt intact ("${spent?.lastResult?.detail}")`);
check(schedules.every((e) => !e.running), "nothing is left marked as running");

// A recurring schedule must survive `npm run restart` — a schedule a restart
// forgets is worse than no schedule: you find out on the day it didn't run.
ws.send(JSON.stringify({
  t: "schedule.save",
  entry: {
    id: "sched-weekly", name: "weekly security sweep", enabled: true, graceMin: 120,
    rule: { kind: "weekly", days: [4], hour: 18, minute: 0, tz: BERLIN, offsetMin: -120 },
    action: { kind: "fanout", dirs: [a.path], text: "never fires during this test" },
  },
}));
await waitFor(() => entry("sched-weekly"));
const armedAt = entry("sched-weekly")?.nextAt;
check(armedAt > Date.now(), `the weekly one is armed in the future (${new Date(armedAt).toISOString()})`);
check(inZone(armedAt, BERLIN).hh === 16 && inZone(armedAt, BERLIN).dow === "Thu",
  `armed at Thu 16:00 Berlin — 2h before the 18:00 anchor (got ${inZone(armedAt, BERLIN).dow} ${inZone(armedAt, BERLIN).hh}:00)`);

// On disk — in the INTENT store, which is the one file every kind of deferred
// work now lives in. A schedule is `{trigger: at}` and nothing else.
const persisted = readIntents(join(ROOT, STATE, "intents.json"));
const weeklyRow = persisted.find((e) => e.id === "sched-weekly");
check(!!weeklyRow, "it is on disk, not just in memory");
check(weeklyRow?.trigger?.kind === "at" && weeklyRow?.target?.kind === "repos",
  `…as an at-triggered sweep (${JSON.stringify(weeklyRow?.trigger?.kind)}/${JSON.stringify(weeklyRow?.target?.kind)})`);

// Restart, and prove the schedule comes back armed — plus a fire the host slept
// through (written straight into the file, which is exactly what a machine that
// was off looks like) runs LATE rather than being dropped.
ws.close();
host.kill();
await sleep(600);
// Written in the LEGACY shape, into the legacy file, which is exactly what a
// host upgraded across this change finds on its next boot: the store imports
// `schedules.json` once, renames it `*.migrated`, and the rows carry on as
// intents. Two birds — the missed-fire rule and the migration — one boot.
const onDisk = [];
onDisk.push({
  id: "sched-missed", name: "missed while asleep", enabled: true, graceMin: 120,
  createdAt: Date.now() - 3600e3,
  rule: { kind: "once", at: Date.now() - 15 * 60_000 },
  action: { kind: "fanout", dirs: [b.path], text: LATE_TEXT },
});
onDisk.push({
  id: "sched-stale", name: "missed last week", enabled: true, graceMin: 120,
  createdAt: Date.now() - 9 * 24 * 3600e3,
  rule: { kind: "once", at: Date.now() - 8 * 24 * 3600e3 },
  action: { kind: "fanout", dirs: [b.path], text: "STALE-MUST-NOT-RUN" },
});
writeFileSync(join(ROOT, STATE, "schedules.json"), JSON.stringify(onDisk, null, 2));

host = boot();
await waitForHost(PORT);
ws = await connect();
check(!!entry("sched-weekly"), "the weekly schedule survives a host restart");
check(entry("sched-weekly")?.nextAt === armedAt, "and comes back armed at the same instant");

const ranLate = await waitFor(() => count(LATE_PROBE) >= 1, 25000);
await sleep(2000);
check(ranLate && count(LATE_PROBE) === 1, `a fire missed while the host was down runs late, once (copies: ${count(LATE_PROBE)})`);
check(count("STALE-MUST-NOT-RUN") === 0, "a fire missed by a week is NOT caught up");
check(!!entry("sched-missed") && !!entry("sched-stale"), "both migrated legacy rows are in the list");
// The migration is once, and the evidence stays: a conversion nobody can check
// is a conversion nobody can trust.
check(!existsSync(join(ROOT, STATE, "schedules.json")) && existsSync(join(ROOT, STATE, "schedules.json.migrated")),
  "the legacy schedules.json is imported once and renamed, never deleted");
// The one the grace window refused is a row that says so — never one that
// looks like it ran, and never one that quietly vanished with its prompt.
const stale = entry("sched-stale");
check(stale?.lastResult?.ok === false && /passed|missed/.test(stale?.lastResult?.detail ?? ""),
  `the stale one says it missed its instant ("${stale?.lastResult?.detail}")`);

// Disabling must actually stop the clock, and "run now" must not consume the
// next scheduled occurrence (testing a schedule on Tuesday can't eat Thursday).
ws.send(JSON.stringify({ t: "schedule.setEnabled", id: "sched-weekly", enabled: false }));
await waitFor(() => entry("sched-weekly")?.enabled === false);
check(entry("sched-weekly")?.nextAt === null, "a disabled schedule reports no next fire");
ws.send(JSON.stringify({ t: "schedule.setEnabled", id: "sched-weekly", enabled: true }));
await waitFor(() => entry("sched-weekly")?.enabled === true);
check(entry("sched-weekly")?.nextAt > Date.now(), "re-enabling re-arms it");

ws.send(JSON.stringify({ t: "schedule.remove", id: "sched-weekly" }));
await waitFor(() => !entry("sched-weekly"));
check(!entry("sched-weekly"), "remove drops it");

// ── A scheduled CHAIN runs every step, in order ──────────────────────────
//
// It used to run the first one and drop the rest with a toast on the phone
// (F13/S4). The steps were never missing from the store — they were on the row,
// in full, and simply never handed to a delivery, which is the worst shape a
// loss can take: nothing on either side says anything is gone.
//
// One row carrying three turns, not three rows: `deliverChain` awaits each
// delivery, and `deliverPrompt` waits for the session to be ready, so awaiting
// is what puts them on separate turns in the order given.
const CHAIN = ["Chain step ONE alpha", "Chain step TWO alpha", "Chain step THREE alpha"];
ws.send(JSON.stringify({
  t: "intent.post", ackId: "sched-chain-1",
  intent: {
    id: "sched-chain", cwd: a.path,
    payload: { kind: "prompt", steps: CHAIN },
    target: { kind: "repo", fresh: true },
    trigger: { kind: "at", rule: { kind: "once", at: Date.now() + 2000 }, graceMin: 120 },
    title: "a scheduled chain",
  },
}));
const allSteps = await waitFor(() => CHAIN.every((step) => log().includes(step)), 60000);
check(allSteps, `every step of a scheduled chain is delivered (${CHAIN.filter((x) => log().includes(x)).length}/3)`);
const pos = CHAIN.map((step) => log().indexOf(step));
check(allSteps && pos[0] < pos[1] && pos[1] < pos[2], `…in the order they were written (${pos.join(" < ")})`);
check(CHAIN.every((step) => count(step) === 1), "…each exactly once — a chain is turns, never a retry loop");

// ── …and the chain gets there the way the PHONE sends one ────────────────
//
// The block above posts `payload.steps` straight onto the row, which proves the
// executor half. The route a person actually takes is `schedule.save`, and that
// message speaks `ScheduleAction` — whose `backlog` arm carried `text` and
// nothing else, so there was nowhere between the send sheet and `payload.steps`
// for turns 2..n to sit and the sheet had to say out loud that it was dropping
// them. This is that last link, asserted at the two places it can be lost: the
// row the host stores, and the list it comes BACK on.
//
// **And that list is the BACKLOG now.** `schedule.save` is unchanged on the
// wire — an APK pinned to an old bundle still sends exactly this message and
// still gets its ack — but a one-off aimed at one repo is waiting work with a
// clock on it (`isTimedWorkRow`), so `intentToSchedule` answers `null` for it
// and it is deliberately NOT in `schedule.list`. The schedules sheet has no
// verb it could use: there is no recurrence to pause and no next occurrence to
// skip.
const SAVED = ["Saved chain ONE", "Saved chain TWO", "Saved chain THREE"];
const savedEntry = {
  id: "sched-saved-chain", name: "a saved chain", enabled: true, graceMin: 120,
  // Far enough out that nothing fires during the test: what is under test is
  // what the store HOLDS, not another delivery of the same three turns.
  rule: { kind: "once", at: Date.now() + 36e5 },
  action: { kind: "backlog", repoDir: a.path, text: SAVED[0], autoFire: true, steps: SAVED },
};
ws.send(JSON.stringify({ t: "schedule.save", entry: savedEntry }));
await waitFor(() => item("sched-saved-chain"));
const savedRow = readIntents(join(ROOT, STATE, "intents.json")).find((e) => e.id === "sched-saved-chain");
check(JSON.stringify(savedRow?.payload?.steps) === JSON.stringify(SAVED),
  `a saved chain reaches the store whole (${JSON.stringify(savedRow?.payload?.steps)})`);
check(entry("sched-saved-chain") === undefined,
  "…and is NOT a schedule card: a one-off aimed at one repo is a backlog row, and that sheet lists standing rules");
check(item("sched-saved-chain")?.steps === 3,
  `…it is a backlog row carrying three turns (${item("sched-saved-chain")?.steps})`);
check(item("sched-saved-chain")?.at?.rule?.kind === "once" && item("sched-saved-chain")?.at?.nextAt > Date.now(),
  `…wearing its clock, armed (${item("sched-saved-chain")?.at?.rule?.kind}, ${item("sched-saved-chain")?.at?.nextAt})`);
check(item("sched-saved-chain")?.repoDir === a.path, "…in the repo the rule named");

// The rename round trip, which is where a chain was always most likely to be
// lost: an edit re-posts the whole entry, so a chain the store could only hand
// back as its own head would vanish the first time anybody changed the name.
ws.send(JSON.stringify({ t: "schedule.save", entry: { ...savedEntry, name: "a renamed chain" } }));
await waitFor(() => readIntents(join(ROOT, STATE, "intents.json")).find((e) => e.id === "sched-saved-chain")?.title === "a renamed chain");
const renamed = readIntents(join(ROOT, STATE, "intents.json")).find((e) => e.id === "sched-saved-chain");
check(JSON.stringify(renamed?.payload?.steps) === JSON.stringify(SAVED),
  `renaming the rule cannot shorten it (${JSON.stringify(renamed?.payload?.steps)})`);
check(renamed?.payload?.steps?.[0] === SAVED[0],
  "…with `text` still `steps[0]` — one contract, shared with `backlog.add`");
check(readIntents(join(ROOT, STATE, "intents.json")).filter((e) => e.id === "sched-saved-chain").length === 1,
  "…and the upsert overwrote the row rather than adding a second copy of it");

ws.close();
host.kill();
await sleep(200);
process.exit(failed ? 1 : 0);
