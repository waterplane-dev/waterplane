// A one-off with a clock is a BACKLOG row, and it runs ITSELF.
//
// Recurrence — not trigger kind — decides which list a row lives in. A standing
// rule is a clock to arm, pause and skip; a one-off aimed at ONE place is
// waiting work whose WHEN happens to be an instant, and it belongs on the list
// of the repo's waiting work, where the verbs it needs are (re-fire, drag,
// *drop the clock*).
//
// Two shapes of failure this pins, both of which were silent:
//
//  A. **the LISTS.** `schedule.save` is unchanged on the wire — an APK pinned to
//     an old bundle still sends exactly this message — so the only visible
//     difference is which list the row comes back on. A one-off aimed at one
//     repo is in `backlog.list` wearing `at`, and deliberately NOT in
//     `schedule.list`: that sheet has no verb it could use. A recurring rule and
//     a one-off SWEEP are the other way round.
//
//  B. **the RUN.** A one-off used to be TWO rows: the timed parent made a child
//     backlog item and settled `done`, so one piece of work had two accounts of
//     itself — and a parent that failed at rung 3 (its grace missed) made no
//     child at all, which is how nine scheduled items on a real desktop ended up
//     in no backlog. It runs itself now, in a
//     session of its own, once; and a failed one is rescued by *drop the clock*
//     (`intent.update` with a new trigger), which is the only patch a terminal
//     row accepts.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { readIntents, waitForHost } from "./lib-e2e.mjs";
import { E, LS, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8830;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-timedwork-`));
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
const LOG = join(ROOT, "stub-input.log");
const STORE = join(ROOT, STATE, "intents.json");

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(LOG, "");
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: STUB, [E.IDLE_MS]: "1500",
  [E.INTENT_TICK_MS]: "1000",
  // Each fired item opens a session OF ITS OWN and those sessions linger for ten
  // minutes so a person can look at them — which, at the default cap of three,
  // means the fourth item in this script would wait out a 60-second reap. Both
  // knobs turned down: the subject here is which list a row lives in and what
  // runs it, not how long a finished conversation is kept.
  [E.BACKLOG_LINGER_MS]: "4000", [E.BACKLOG_REAP_IDLE_MS]: "3000",
  STUB_MODE: "repaint", STUB_LOG: LOG,
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
const base = `http://127.0.0.1:${PORT}`;
const bail = watchdog(() => { check(false, "timed out"); host.kill(); process.exit(1); }, 180_000);
await waitForHost(PORT);

const repo = await fetch(`${base}/api/repo`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "timed" }),
}).then((r) => r.json());

let schedules = [];
let items = [];
/** How many of each LIST frame have arrived, and when the last one did.
 *  Section 7 is about a frame being SENT, not about a row eventually looking
 *  right — every list here is also re-sent by ordinary churn (a row settling, a
 *  session being reaped), so counting frames over a quiet socket is the only way
 *  to tell "the host told this phone" from "something else happened to". */
const frames = { schedule: 0, backlog: 0, at: 0 };
const sessions = new Map();
const ws = await new Promise((resolve) => {
  const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  s.on("open", () => s.send(JSON.stringify({ t: "hello", protocol: 1 })));
  s.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "schedule.list") { schedules = m.entries; frames.schedule++; frames.at = Date.now(); resolve(s); }
    if (m.t === "backlog.list") { items = m.items; frames.backlog++; frames.at = Date.now(); }
    if (m.t === "session.created") sessions.set(m.session.id, m.session);
  });
});

const log = () => { try { return readFileSync(LOG, "utf8"); } catch { return ""; } };
const count = (probe) => log().split(probe).length - 1;
const waitFor = async (pred, ms = 40_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(200); }
  return false;
};
const card = (id) => schedules.find((e) => e.id === id);
const item = (id) => items.find((i) => i.id === id);
const row = (id) => readIntents(STORE).find((r) => r.id === id);
/** Every row a rule minted — `scheduleItemOrigin`'s durable half. */
const children = (id) => readIntents(STORE).filter((r) => r.origin === `schedule:${id}`);

/** One `schedule.save`, the way the phone sends it. */
const save = (id, rule, over = {}) => ws.send(JSON.stringify({
  t: "schedule.save",
  entry: {
    id, name: over.name ?? id, enabled: true, graceMin: over.graceMin ?? 120,
    rule,
    action: { kind: "backlog", repoDir: repo.path, text: over.text, autoFire: true },
    ...(over.waitUntilFree ? { waitUntilFree: true } : {}),
  },
}));

// Automatic work is gated by the global switch, which is off by default. Every
// row below is `autoFire` work, so nothing at all happens without this.
// Automatic sessions stay open by default (cd04487); these rows need their slot back.
ws.send(JSON.stringify({ t: "settings.set", key: `${LS}backlog.closeWhenDone`, value: "1", ts: Date.now(), device: "e2e" }));
ws.send(JSON.stringify({ t: "backlog.setAuto", enabled: true }));

// ── 1 + 6. saved as a schedule, listed as a backlog row, clock and all ──────

const ONCE = "TIMED one-off words";
save("tw-once", { kind: "once", at: Date.now() + 2500 }, { text: ONCE, waitUntilFree: true, name: "tonight's item" });
check(await waitFor(() => item("tw-once")), "a one-off backlog entry lands in backlog.list");
check(card("tw-once") === undefined,
  "…and NOT in schedule.list: that sheet lists standing rules, and a one-off has nothing to pause or skip");
check(item("tw-once")?.at?.rule?.kind === "once",
  `…the row carries its whole rule, not a rendered sentence (${item("tw-once")?.at?.rule?.kind})`);
check(item("tw-once")?.at?.nextAt > Date.now(),
  `…armed, with the ROW's own instant (${item("tw-once")?.at?.nextAt})`);
check(item("tw-once")?.at?.graceMin === 120, `…and the grace that says how late is too late (${item("tw-once")?.at?.graceMin})`);
check(item("tw-once")?.holdForHost === true,
  "…and `wait until it's free` arrives as `holdForHost` — the host-wide half of the tick, on the row that does the work");
check(item("tw-once")?.repoDir === repo.path, "…in the repo the rule named");

// ── 2. it runs ITSELF: one session, one delivery, no child ──────────────────

check(await waitFor(() => count(ONCE) >= 1), "the words are typed when its instant comes");
await sleep(3000); // let a would-be second delivery happen before counting
check(count(ONCE) === 1, `…exactly once (copies: ${count(ONCE)})`);
const ownSession = [...sessions.values()].find((s) => (s.title || "").startsWith("backlog · "));
check(!!ownSession && ownSession.cwd === repo.path,
  `…in a session of its own, titled for the item (${JSON.stringify(ownSession?.title)})`);
check(await waitFor(() => item("tw-once")?.status === "done"), `the row itself settles (${item("tw-once")?.status})`);
check(row("tw-once")?.nextAt === null, `…disarmed, with nothing next (${row("tw-once")?.nextAt})`);
check(children("tw-once").length === 0,
  `no child row: one piece of work, one row, one account of it (${children("tw-once").length})`);
check(row("tw-once")?.result?.childId === undefined, "…and nothing on the row points at one");

// ── 3. a one-off saved PAST its grace fails, and stays in the backlog ───────
//
// The seven rows this whole change exists for. They used to be `failed` parents
// with no child anywhere, so the repo's backlog did not have them and the smart
// pick — whose candidates are backlog rows — could never see them.

const MISSED = "TIMED missed words";
save("tw-missed", { kind: "once", at: Date.now() - 4 * 3600e3 }, { text: MISSED, graceMin: 60 });
check(await waitFor(() => item("tw-missed")?.status === "failed"),
  `a one-off whose instant is long past fails (${item("tw-missed")?.status})`);
check(!!item("tw-missed"), "…and is STILL in the repo's backlog, which is the whole point");
check(/one-off|passed/.test(item("tw-missed")?.error ?? ""),
  `…saying which instant it missed ("${item("tw-missed")?.error}")`);
check(count(MISSED) === 0, "…having typed nothing");

// `re-fire` on the row — `backlog.fire`, the verb the sheet already has.
ws.send(JSON.stringify({ t: "backlog.fire", id: "tw-missed" }));
check(await waitFor(() => count(MISSED) >= 1), "re-fire on a failed timed row runs it, words and all");
await sleep(2500);
check(count(MISSED) === 1, `…once (copies: ${count(MISSED)})`);

// ── 4. drop the clock: a failed one-off waits its turn instead ──────────────

const DROP = "TIMED dropped-clock words";
save("tw-drop", { kind: "once", at: Date.now() - 4 * 3600e3 }, { text: DROP, graceMin: 60 });
check(await waitFor(() => item("tw-drop")?.status === "failed"), "a second failed one-off, to rescue the other way");

ws.send(JSON.stringify({ t: "intent.update", ackId: "tw-drop-1", id: "tw-drop", patch: { trigger: { kind: "idle" } } }));
check(await waitFor(() => row("tw-drop")?.trigger?.kind === "idle"),
  `the clock is dropped on disk (${row("tw-drop")?.trigger?.kind})`);
// The disk write lands before the backlog push that carries it, and under a
// loaded parallel run the push can trail by more than one read: wait for it.
check(await waitFor(() => item("tw-drop")?.at === undefined), "…so the row stops wearing one");
check(await waitFor(() => count(DROP) >= 1), "…and it fires on the next tick, like any other queued item");
await sleep(2500);
check(count(DROP) === 1, `…once (copies: ${count(DROP)})`);
check(await waitFor(() => item("tw-drop")?.status === "done"), `…and settles (${item("tw-drop")?.status})`);

// A `done` row is not rescuable — it ran, and there is nothing owed.
ws.send(JSON.stringify({ t: "intent.update", ackId: "tw-drop-2", id: "tw-drop", patch: { trigger: { kind: "idle" } } }));
await sleep(1200);
check(row("tw-drop")?.state === "done", "…and the same patch on a row that already ran is refused");

// ── 4b. …and the other WHEN a person can pick instead of the clock ─────────
//
// *drop the clock* sends `{trigger: {kind: "idle"}}`, but the Send sheet's WHEN
// control offers *now* as well, and a seeded edit of a row that is still QUEUED
// has to reach the SAME row — the alternative is posting a second one, and the
// words then run twice (once here, once when the clock comes round). `now` and
// `idle` are one behaviour in the ladder by design, and this is the pin that
// says so about a row that still has a clock on it when the patch arrives.

const NOWED = "TIMED now-instead words";
save("tw-now", { kind: "once", at: Date.now() + 36 * 3600e3 }, { text: NOWED });
check(await waitFor(() => item("tw-now")?.at?.nextAt > Date.now()), "a one-off waiting on a clock a day and a half out");
check(item("tw-now")?.status !== "failed", `…and not a failed one: this is the QUEUED case (${item("tw-now")?.status})`);

ws.send(JSON.stringify({ t: "intent.update", ackId: "tw-now-1", id: "tw-now", patch: { trigger: { kind: "now" } } }));
check(await waitFor(() => row("tw-now")?.trigger?.kind === "now"),
  `a queued timed row accepts *now* on the row it already has (${row("tw-now")?.trigger?.kind})`);
check(row("tw-now")?.nextAt === undefined && row("tw-now")?.lastOccurrence === undefined,
  "…and the clock's bookkeeping goes with the clock");
check(await waitFor(() => count(NOWED) >= 1), "…and it runs");
await sleep(2500);
check(count(NOWED) === 1, `…exactly once — never once here and again at the instant (copies: ${count(NOWED)})`);
check(readIntents(STORE).filter((r) => (r.payload?.steps ?? []).includes(NOWED)).length === 1,
  "…out of ONE row: an edit to the WHEN must never leave a second one behind");

// ── 5. a RECURRING rule is unchanged: a card, and a child per occurrence ────

const WEEKLY = "TIMED weekly words";
// Every day at an hour that has already passed today, so it never fires on its
// own during the run — the hand `schedule.run` below is the only occurrence.
const hourAgo = new Date(Date.now() - 3600e3);
save("tw-weekly", { kind: "weekly", days: [], hour: hourAgo.getUTCHours(), minute: 0, tz: "UTC", offsetMin: 0 }, { text: WEEKLY });
check(await waitFor(() => card("tw-weekly")), "a recurring backlog rule IS a schedule card");
check(item("tw-weekly") === undefined,
  "…and is not a backlog row: it is not waiting work, it is the thing that MAKES some");
check(card("tw-weekly")?.action?.kind === "backlog" && card("tw-weekly")?.nextAt > Date.now(),
  `…armed for its next occurrence (${card("tw-weekly")?.nextAt})`);

ws.send(JSON.stringify({ t: "schedule.run", id: "tw-weekly", ackId: "tw-weekly-run" }));
check(await waitFor(() => children("tw-weekly").length === 1),
  `a standing rule still mints a child per occurrence (${children("tw-weekly").length})`);
check(children("tw-weekly")[0]?.cwd === repo.path, "…in the rule's repo");
const childRan = await waitFor(() => count(WEEKLY) >= 1);
if (!childRan) console.log("[dbg] child row:", JSON.stringify(children("tw-weekly")[0], null, 1));
check(childRan, "…and the CHILD is what runs the words");
check(card("tw-weekly")?.nextAt > Date.now(), "…while the rule keeps standing, armed for its own next run");

// ── 7. an edit that MOVES a row between the lists reaches the phone ────────
//
// Classification is derived from the rule, and moving a row between the lists by
// editing *once* → *every week* is the change's own selling point. It did move —
// on the host. The phone's backlog copy is only ever replaced by a `backlog.list`
// frame, `intent.changed` never touches it, and nothing re-asks; so a broadcast
// that sent only the list the row belongs to NOW left the row sitting in the one
// it had just left, with its old clock, until the socket reconnected. Both
// directions, and this socket is never re-opened below — that is the test.
//
// Asserted on the FRAME rather than on how the list eventually looks. Both lists
// are also re-sent by ordinary churn, so "the row is gone from `items`" passes
// for the wrong reason as soon as anything else in the store moves. The socket
// is quiesced first, then each edit must produce BOTH frames on its own.

/** Wait until neither list has been broadcast for `ms` — a genuinely quiet
 *  socket, so the next frame is attributable to the next edit. */
const quiesce = async (ms = 3000) => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (Date.now() - frames.at > ms) return true;
    await sleep(250);
  }
  return false;
};

const CROSS = "TIMED crossing words";
const far = () => Date.now() + 36 * 3600e3;
save("tw-cross", { kind: "once", at: far() }, { text: CROSS });
check(await waitFor(() => item("tw-cross")), "a one-off starts life as a backlog row");
check(card("tw-cross") === undefined, "…and as no card");

// *once* → *every week*, through the same `schedule.save` upsert the Send sheet
// uses. The row is a card afterwards, so the SCHEDULE frame was always sent;
// what was missing is the backlog frame telling this phone the row left.
check(await quiesce(), "the socket goes quiet, so the next frames belong to the next edit");
let before = { ...frames };
save("tw-cross", { kind: "weekly", days: [], hour: hourAgo.getUTCHours(), minute: 0, tz: "UTC", offsetMin: 0 }, { text: CROSS });
check(await waitFor(() => card("tw-cross"), 8000), "editing it to *every week* makes it a card");
check(await waitFor(() => frames.backlog > before.backlog, 8000),
  "…and the backlog list is re-sent in the same breath, with no reconnect");
check(item("tw-cross") === undefined, "…so this phone's backlog stops carrying it");

// …and back again, which is the direction that leaves a stale CARD.
check(await quiesce(), "quiet again");
before = { ...frames };
save("tw-cross", { kind: "once", at: far() }, { text: CROSS });
check(await waitFor(() => item("tw-cross"), 8000), "editing it back to *once* returns it to the backlog");
// `schedule.save`'s own route broadcasts the entries list unconditionally, so
// this half holds today whichever way `onChange` keys itself. It is pinned
// anyway: the card's exit must not quietly depend on a line in a route that
// looks like a redundant broadcast to anyone tidying it up.
check(await waitFor(() => frames.schedule > before.schedule, 8000),
  "…and the schedules list is re-sent too, or the card it just left lingers there");
check(card("tw-cross") === undefined, "…so the card goes with the rule that made it");

// Dropping the clock altogether is the one crossing no test of the NEW row can
// see — there is no clock left on it to key off — so the host says the whole
// store moved instead.
save("tw-cross2", { kind: "weekly", days: [], hour: hourAgo.getUTCHours(), minute: 0, tz: "UTC", offsetMin: 0 }, { text: "TIMED unclocked words" });
check(await waitFor(() => card("tw-cross2")), "a standing rule, to un-clock");
check(await quiesce(), "quiet before the un-clock");
before = { ...frames };
ws.send(JSON.stringify({ t: "intent.update", ackId: "tw-cross2-1", id: "tw-cross2", patch: { trigger: { kind: "idle" } } }));
check(await waitFor(() => frames.schedule > before.schedule, 8000),
  "…and when its clock is taken away the schedules list is re-sent, without waiting for a reconnect");
check(card("tw-cross2") === undefined, "…so the card goes");

clearTimeout(bail);
ws.close();
host.kill();
await sleep(200);
process.exit(failed ? 1 : 0);
