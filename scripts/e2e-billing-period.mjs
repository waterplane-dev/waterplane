// Billing profile + dollar budget periods, over the wire (plan docs/plans/billing-periods.md).
//
// A host booted on a throwaway claude home holding ONE hand-built conversation
// dated now (the ledger the period-to-date spend is folded from, as in
// e2e-tokenstats). Asserts:
//   1. billing.set api answers billing.status {api, setting}; it persists
//      across a restart; billing.set null hands it back to the probe
//   2. budget.set with a calendar-month usd period + cap comes back as
//      budget.state carrying that period (and its ceiling)
//   3. the period's spend is folded from the ledger at list price (> 0), and a
//      cap below it blocks, naming the month, with a reset (the month's edge)
//   4. a timed AUTO backlog item is held, in words that name the budget...
//   5. ...while a HAND-fired one still runs (the cap holds unattended work only)
//   6. raising the cap above the spend releases the verdict
// Not covered here (unit-pinned in host/test/billingperiods + spendlimit): the
// probe's classification, the pace push, spend-wall recognition.
import { killTmuxServers } from "./lib-tmuxiso.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8887;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-billperiod-`));
const HOME = mkdtempSync(join(tmpdir(), `${SLUG}-billperiod-home-`));
const REPO = join(ROOT, "proj");

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(150); }
  return false;
};
const run = (cmd, args) => new Promise((r) => spawn(cmd, args, { cwd: REPO, stdio: "ignore" }).on("exit", r));

mkdirSync(REPO, { recursive: true });
await run("git", ["init", "-q"]);
writeFileSync(join(REPO, "README.md"), "# proj\n");
await run("git", ["add", "-A"]);
await run("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-qm", "init"]);

// The ledger: one big Opus turn an hour ago (inside any month that is at least
// an hour old; the test is not run in the first hour of a month's first day).
const convDir = join(HOME, ".claude", "projects", "-Users-nobody-dev-demo");
mkdirSync(convDir, { recursive: true });
const at = Math.max(Date.now() - 3600_000, new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() + 60_000);
writeFileSync(join(convDir, "aaaa.jsonl"), JSON.stringify({
  type: "assistant", timestamp: new Date(at).toISOString(), uuid: "u-1", cwd: "/Users/nobody/dev/demo",
  message: {
    id: "m1", model: "claude-opus-4-8", role: "assistant",
    usage: {
      input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, speed: "standard",
    },
  },
}) + "\n");

const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let host = null;
function boot() {
  const env = {
    ...process.env,
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
    [E.CLAUDE_BIN]: STUB,
    [E.CLAUDE_HOME]: HOME,
    [E.IDLE_MS]: "1500",
  };
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
}
const stop = async () => { host?.kill(); await sleep(700); killTmuxServers(); };

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const s = { budget: null, billing: null, backlog: null, waiting: {}, sessions: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "budget.state") s.budget = m;
    if (m.t === "billing.status") s.billing = m;
    if (m.t === "backlog.list") { s.backlog = m.items; s.waiting = m.waiting ?? {}; }
    if (m.t === "session.list") s.sessions = m.sessions;
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  await sleep(500);
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.close = () => ws.close();
  return s;
}

const MONTH = { id: "month", kind: "calendar", unit: "usd", cycle: "month", anchorDay: 1, tz: "UTC" };
const budgetWith = (max) => ({
  enabled: true, sessionMax: 100, weeklyMax: null, leftoverMax: null,
  ceilings: [{ periodId: "session", max: 100, unit: "pct" }, { periodId: "month", max, unit: "usd" }],
  periods: [MONTH],
});
const month = (a) => a.budget?.periods?.find((p) => p.period.id === "month");

boot();
await waitForHost(PORT);
let a = await connect();

// ── 1 — the billing profile ──
a.send({ t: "billing.set", profile: "api" });
check(await waitFor(() => a.billing?.profile === "api" && a.billing?.source === "setting"),
  `billing.set api answers billing.status api from the setting (got ${a.billing?.profile}/${a.billing?.source})`);

// ── 2 — a calendar-month usd period + cap round-trips ──
a.send({ t: "budget.set", budget: budgetWith(10) });
check(await waitFor(() => month(a) != null), "budget.set with a calendar-month period returns budget.state carrying it");
check(month(a)?.period.cycle === "month" && month(a)?.period.anchorDay === 1 && month(a)?.period.tz === "UTC",
  "…with its cycle, anchor day and zone intact");
check(a.budget?.budget.ceilings?.some((l) => l.periodId === "month" && l.max === 10 && l.unit === "usd"),
  "…and the $10 ceiling on it");
check(month(a)?.resetAt != null && month(a).resetAt > Date.now(), "…and a computed reset (the next month's edge)");

// ── 3 — spend is folded from the ledger; over the cap the verdict blocks ──
const folded = await waitFor(() => (month(a)?.spentUsd ?? 0) > 10, 30000);
check(folded, `period-to-date spend is folded from the ledger at list price (spentUsd ${month(a)?.spentUsd})`);
check(await waitFor(() => a.budget?.verdict.blocked === true, 30000),
  `spend over the $10 cap blocks automatic work (state ${a.budget?.verdict.state})`);
check(a.budget?.verdict.resumeAt != null, "…and the verdict knows when it lifts (the period's reset)");

// ── 4/5 — it holds auto work, never a hand-fired item ──
a.send({ t: "backlog.setAuto", enabled: true });
a.send({ t: "backlog.add", text: "write a file called BP.txt", repoDir: REPO, label: "gated" });
await sleep(600);
a.send({ t: "backlog.openRepoSession", repoDir: REPO });
await waitFor(() => a.sessions.some((s) => s.cwd === REPO && s.running), 20000);
await sleep(4000);
const item = () => (a.backlog ?? []).find((i) => i.label === "gated");
check(item()?.status === "queued", `a queued auto item is held over the dollar cap (status ${item()?.status})`);
check(/budget|month|\$/i.test(a.waiting[item()?.id ?? ""] ?? ""), `...with a reason in words ("${a.waiting[item()?.id ?? ""]}")`);
a.send({ t: "backlog.fire", id: item().id });
check(await waitFor(() => ["running", "done"].includes(item()?.status), 30000),
  `a HAND-fired item still runs over the cap (status ${item()?.status})`);

// ── 6 — a cap above the spend lets go ──
a.send({ t: "budget.set", budget: budgetWith(1_000_000) });
check(await waitFor(() => a.budget?.verdict.blocked === false, 15000), "raising the cap above the spend releases the verdict");

// ── 1b — the override persists across a restart, and null hands it back ──
a.close();
await stop();
boot();
await waitForHost(PORT);
a = await connect();
a.send({ t: "billing.get" });
check(await waitFor(() => a.billing?.profile === "api" && a.billing?.source === "setting"), "the billing override survives a host restart");
check(month(a)?.period.id === "month", "...and so does the month period");
a.send({ t: "billing.set", profile: null });
check(await waitFor(() => a.billing?.source === "probe"), `billing.set null hands the profile back to the probe (got ${a.billing?.source})`);
a.close();
await stop();

console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
