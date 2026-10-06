// The usage BUDGET — the ceiling that stops automatic work BEFORE the CLI's
// own limit banner does.
//
// `limit.ts` is recovery: the banner already landed, the turn is already dead,
// and all that is left is to wait for the reset and resurrect. That is always
// too late — a backlog draining overnight spends the last of a session window
// on whatever happened to be next in line, and the prompt you actually cared
// about is the one that hits the wall.
//
// So: a percentage you set, checked by the two things that start work with
// nobody present — the send queue and backlog auto-fire — and lifted by itself
// when the window resets. The rule is pure and unit-pinned
// (`packages/shared/test/budget.test.mjs`); what needs a HOST is everything
// around it, which is what this covers.
//
// Asserts:
//   1. `hello` carries the budget and its verdict unprompted
//   2. with no readable usage the gate FAILS OPEN — a scrape that breaks
//      upstream must never freeze every queue on every host
//   3. a real `/usage` scrape over the ceiling flips the verdict to blocked,
//      and the flip is BROADCAST (a second device must not show a stale "ok")
//   4. backlog auto-fire stops, and `waiting()` says WHY in the host's words
//   5. …and a hand-fired item still runs: the budget stops unattended work,
//      never a person who decided to spend the reserve
//   5b. a one-off timed BEFORE the session reset, saved AFTER its own instant
//      (the incident's shape: re-timed at 18:50 for an hour before 19:00), arms
//      that reset from its grace and runs past the session ceiling (a ceiling
//      saves allowance for later in the window, and it has no later), while one
//      timed before the WEEKLY reset stays held by the session cap and says
//      which exemption it does not cover
//   6. under the ceiling the same item fires normally (the control)
//   7. the ceiling is persisted and survives a restart
//   8. a hand-edited store is clamped, not believed
import { killTmuxServers } from "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const PORT = 8879;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-budget-`));
const REPO = join(ROOT, "proj");

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 12000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(150); }
  return false;
};

// A git repo, so the backlog has somewhere to live and a session has somewhere
// to open.
mkdirSync(REPO, { recursive: true });
const git = (args) => spawn("git", args, { cwd: REPO, stdio: "ignore" });
await new Promise((r) => git(["init", "-q"]).on("exit", r));
writeFileSync(join(REPO, "README.md"), "# proj\n");
await new Promise((r) => git(["add", "-A"]).on("exit", r));
await new Promise((r) => git(["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-qm", "init"]).on("exit", r));
// A second repo for 5b, so its rows are not queued behind step 5's item on the
// per-repo `serial` rung — the assertion there is about the BUDGET rung.
const REPO2 = join(ROOT, "proj2");
mkdirSync(REPO2, { recursive: true });
const git2 = (args) => spawn("git", args, { cwd: REPO2, stdio: "ignore" });
await new Promise((r) => git2(["init", "-q"]).on("exit", r));
writeFileSync(join(REPO2, "README.md"), "# proj2\n");
await new Promise((r) => git2(["add", "-A"]).on("exit", r));
await new Promise((r) => git2(["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-qm", "init"]).on("exit", r));

/** Boot the host with a stub whose `/usage` screen reports `pct` of the session
 *  window used — or with no usage screen at all when `pct` is null. */
const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let host = null;
/**
 * Boot the host against the TUI stub. `pct` is what that stub's `/usage` screen
 * will report for the session window — null for "no usage screen at all", which
 * is the shape of an upstream TUI change and the case the gate must fail open on.
 *
 * The usage probe spawns `$<ENV>_CLAUDE_BIN` with no arguments and types
 * `/usage`, so the same stub serves both roles: the sessions the backlog fires
 * into, and the short-lived probe the budget reads.
 */
function boot(pct) {
  const env = {
    ...process.env,
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
    [E.CLAUDE_BIN]: STUB,
    // No `STUB_HOOKS`: the stub only fires hooks from its menu mode, so a hooked
    // session here would wait for a `UserPromptSubmit` that never comes and read
    // a perfectly delivered prompt as an unsubmitted one. Unhooked, delivery
    // falls back to the echo check, which is what this stub does support.
    [E.IDLE_MS]: "1500",
    ...(pct == null ? {} : { STUB_USAGE: `${pct},10` }),
  };
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
}
const bootWith = boot;
// Each section boots on a clean slate, so the panes go with the host: under tmux
// a plain restart would hand the next section the previous one's live sessions.
const stop = async () => { host?.kill(); await sleep(700); killTmuxServers(); };

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const state = { budget: null, frames: [], backlog: null, waiting: {}, sessions: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "budget.state") { state.budget = m; state.frames.push(m); }
    if (m.t === "backlog.list") { state.backlog = m.items; state.waiting = m.waiting ?? {}; }
    if (m.t === "session.list") state.sessions = m.sessions;
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  await sleep(500);
  state.send = (msg) => ws.send(JSON.stringify(msg));
  state.close = () => ws.close();
  return state;
}

// ── 1/2 — no readable usage: told about the budget, and it holds nothing ──
bootWith(null);
await sleep(1200);
let a = await connect();
check(a.budget !== null, "hello carries the usage budget unprompted");
check(a.budget?.budget.sessionMax === 90, `the default ceiling is 90% (got ${a.budget?.budget.sessionMax})`);
check(a.budget?.budget.enabled === true, "…and it is armed by default");
check(a.budget?.budget.weeklyMax === null, "the weekly ceiling is off by default (days-long pause is never a default)");
// The reading is scraped off a TUI. With nothing parseable the verdict must be
// `unknown` and MUST NOT block: a parser broken by an upstream change would
// otherwise freeze every queue on every host, silently, for ever.
check(await waitFor(() => a.budget?.verdict.state === "unknown"), `an unreadable usage scrape is 'unknown' (got ${a.budget?.verdict.state})`);
check(a.budget?.verdict.blocked === false, "…and it fails OPEN — nothing is held back");
a.close();
await stop();

// ── 3 — over the ceiling: the verdict flips, and every socket hears it ──
bootWith(96);
await sleep(1200);
a = await connect();
const b = await connect();
const blocked = await waitFor(() => a.budget?.verdict.blocked === true, 30000);
check(blocked, `96% of the session window blocks against a 90% ceiling (state ${a.budget?.verdict.state})`);
check(a.budget?.verdict.which === "session", "…and it names the session window, the one that resets soonest");
check(a.budget?.verdict.pct === 96 && a.budget?.verdict.max === 90, `…with the reading and the ceiling behind it (${a.budget?.verdict.pct}/${a.budget?.verdict.max})`);
check(a.budget?.verdict.resumeAt != null, "…and when it will lift, which is the only actionable half of a pause");
check(b.budget?.verdict.blocked === true, "the flip reaches a second device too — the budget is the account's");

// ── 4 — backlog auto-fire stops, and says why ──
a.send({ t: "backlog.setAuto", enabled: true });
a.send({ t: "backlog.add", text: "write a file called BUDGET.txt", repoDir: REPO, label: "gated" });
await sleep(600);
// A session in the repo, so the row is provably held by the BUDGET and not by
// anything about where it would run. The item opens a session of its own when it
// fires now, so nothing here needs one to exist — what this rules out is the
// test passing for a reason that has moved: rung 2 is above every rung that
// could otherwise be the answer, and the assertion below reads the sentence.
a.send({ t: "backlog.openRepoSession", repoDir: REPO });
await waitFor(() => a.sessions.some((s) => s.cwd === REPO && s.running), 20000);
await sleep(4000);
const item = () => (a.backlog ?? []).find((i) => i.label === "gated");
check(item()?.status === "queued", `a queued item does NOT auto-fire over the budget (status ${item()?.status})`);
const why = a.waiting[item()?.id ?? ""] ?? "";
check(/budget/i.test(why), `the backlog says why, in the host's own words ("${why}")`);

// ── 5 — a person may still spend the reserve ──
a.send({ t: "backlog.fire", id: item().id });
const ranByHand = await waitFor(() => ["running", "done"].includes(item()?.status), 30000);
check(ranByHand, `a HAND-fired item still runs while the budget is over (status ${item()?.status})`);
a.close(); b.close();
await stop();

// ── 5b — a before-reset one-off is lifted past its own window's ceiling ──
// The incident: twelve rows timed an hour before the weekly reset sat held by a
// weekly budget at 97% and never ran. Here the session window stands in for the
// weekly one (the stub's session reset is hours out, the weekly one days), and
// the rows go through `schedule.save`, the op the Send sheet uses for a clock.
bootWith(96);
await sleep(1200);
a = await connect();
check(await waitFor(() => a.budget?.verdict.blocked === true && a.budget?.verdict.resumeAt != null, 30000),
  `5b: the session ceiling is over and the host knows when it resets (state ${a.budget?.verdict.state})`);
a.send({ t: "backlog.setAuto", enabled: true });
const sessionReset = a.budget.verdict.resumeAt;
// A lead that puts the row's own time about five minutes BEHIND us — saved late,
// inside its lead window and inside its grace. It used to arm from `createdAt`,
// past the instant, and skip this reset for the next one in silence.
const leadMin = Math.ceil((sessionReset - Date.now()) / 60_000) + 5;
const saveWindow = (id, rule) => a.send({
  t: "schedule.save",
  entry: {
    id, name: id, enabled: true, graceMin: 120, rule,
    action: { kind: "backlog", repoDir: REPO2, text: `write a file called ${id}.txt`, autoFire: true },
  },
});
saveWindow("bp-session", { kind: "window", window: "session", edge: "before", offsetMin: -leadMin, oneShot: true });
saveWindow("bp-weekly", { kind: "window", window: "weekly", edge: "before", offsetMin: -1440, oneShot: true });
const row = (id) => (a.backlog ?? []).find((i) => i.id === id);
check(await waitFor(() => ["running", "done"].includes(row("bp-session")?.status), 30_000),
  `5b: saved past its instant, it arms this reset and runs past the session ceiling (status ${row("bp-session")?.status})`);
const weeklyWhy = a.waiting["bp-weekly"] ?? "";
check(row("bp-weekly")?.status === "queued", `5b: the before-WEEKLY row is still waiting (status ${row("bp-weekly")?.status})`);
check(/session window/.test(weeklyWhy) && /budget/.test(weeklyWhy),
  `5b: …held by the SESSION cap, in words that name it ("${weeklyWhy}")`);
a.close();
await stop();

// ── 6 — the control: under the ceiling, the same item fires by itself ──
bootWith(20);
await sleep(1200);
a = await connect();
check(await waitFor(() => a.budget?.verdict.blocked === false && a.budget?.verdict.state === "ok", 30000),
  `20% is under the 90% ceiling (state ${a.budget?.verdict.state})`);
a.send({ t: "backlog.setAuto", enabled: true });
a.send({ t: "backlog.add", text: "second item", repoDir: REPO, label: "ungated" });
await sleep(600);
a.send({ t: "backlog.openRepoSession", repoDir: REPO });
await waitFor(() => a.sessions.some((s) => s.cwd === REPO && s.running), 20000);
const free = () => (a.backlog ?? []).find((i) => i.label === "ungated");
check(await waitFor(() => ["running", "done"].includes(free()?.status), 30000),
  `under the budget the same item auto-fires (status ${free()?.status}${free()?.error ? ` — ${free().error}` : ""})`);

// ── 7 — the ceiling is persisted ──
a.send({ t: "budget.set", budget: { enabled: true, sessionMax: 60, weeklyMax: 75 } });
check(await waitFor(() => a.budget?.budget.sessionMax === 60), "a new ceiling is echoed back to the client that set it");
check(a.budget?.budget.weeklyMax === 75, "…including the weekly one it just turned on");
const onDisk = JSON.parse(readFileSync(join(ROOT, STATE, "budget.json"), "utf8"));
check(onDisk.sessionMax === 60, "the ceiling is on disk, not just in memory");
a.close();
await stop();
bootWith(20);
await sleep(1200);
a = await connect();
check(a.budget?.budget.sessionMax === 60, "the ceiling survives a host restart");
// …and now 20% is over the 60%? No — but the WEEKLY 10% is under 75 too, so the
// verdict is `ok`. What matters is that the number came back, not the verdict.
a.close();
await stop();

// ── 8 — the store is hand-editable JSON; a hostile value is clamped ──
// `sessionMax: 0` would block every automatic send for ever, with no way back
// through a UI whose slider starts at 50.
writeFileSync(join(ROOT, STATE, "budget.json"), JSON.stringify({ enabled: true, sessionMax: 0, weeklyMax: 900 }));
bootWith(20);
await sleep(1200);
a = await connect();
check(a.budget?.budget.sessionMax === 1, `a 0% ceiling is clamped to 1, never believed (got ${a.budget?.budget.sessionMax})`);
check(a.budget?.budget.weeklyMax === 100, `a 900% ceiling is clamped to 100 (got ${a.budget?.budget.weeklyMax})`);
a.close();
await stop();

console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
