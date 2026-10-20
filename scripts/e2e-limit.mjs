// Usage-limit auto-continue:
//   - unit-checks detectLimitText/parseResetTime against the pinned TUI shapes
//   - banner in the PTY → session.updated { limit.blocked:true } + "limit" notification
//   - an auto "continue" attempt fires on the retry cadence (no reset time in banner)
//   - flooding the screen past the banner (after an attempt) → blocked:false ("resumed")
//   - limit.setAuto / limit.session toggles round-trip and re-derive session state
// Portable: throwaway root, stub claude (bash), tiny idle/retry knobs via env.
import { watchdog } from "./lib-watchdog.mjs";
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { detectLimitText, parseResetTime } from "../packages/host/dist/limit.js";
import { bootWait } from "./lib-e2e.mjs";
import { E, SLUG, rootEnv } from "./lib-brand.mjs";

// ── unit: detection + reset-time parsing ─────────────────────────────
const now = Date.now();
const assert = (cond, m) => { if (!cond) { console.error("FAIL (unit):", m); process.exit(1); } };

assert(detectLimitText("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.", now).blocked, "current banner should block");
assert(detectLimitText("5-hour limit reached ∙ resets 3am", now).blocked, "5-hour banner should block");
assert(detectLimitText("❯ 1. Stop and wait for limit to reset", now).blocked, "stop-and-wait menu should block");
assert(!detectLimitText("Approaching your Fable 5 limit · resets 3am", now).blocked, "approaching is a warning, not a block");
assert(!detectLimitText("we discussed the usage limit and how it resets weekly", now).blocked, "prose about limits must not block");

// Clock-time parses are asserted from a FIXED probe (today 10:00) so the suite
// doesn't change behavior with the wall clock (4pm is past-grace after 16:00).
const probe10 = new Date(now); probe10.setHours(10, 0, 0, 0);
const P10 = probe10.getTime();
const at4pm = parseResetTime("your limit will reset at 4pm", P10);
assert(at4pm === P10 + 6 * 3600e3, "4pm parse from 10am");
const rel = parseResetTime("resets in 2 hours", P10);
assert(rel != null && Math.abs(rel - (P10 + 2 * 3600e3)) < 5000, "relative parse");
const tue = parseResetTime("resets Tue 3am", P10);
assert(tue != null && tue > P10 && new Date(tue).getDay() === 2 && new Date(tue).getHours() === 3, "weekday parse");
const t2359 = parseResetTime("resets at 23:59", P10);
assert(t2359 === P10 + 13 * 3600e3 + 59 * 60e3, "24h parse");
assert(parseResetTime("resets soon", P10) == null, "no time → null");

// Stale banner: a reset time a little in the past means "already reset" (catch
// up now), NOT tomorrow. Beyond the 6h grace it really means tomorrow.
{
  const at1400 = new Date(now); at1400.setHours(14, 0, 0, 0);
  const probe = at1400.getTime() + 2 * 3600e3; // pretend it's 16:00
  const stale = parseResetTime("resets at 2pm", probe);
  assert(stale != null && stale <= probe, "reset 2h in the past stays in the past (already reset)");
  const probeLate = at1400.getTime() + 9 * 3600e3; // pretend it's 23:00
  const tomorrow = parseResetTime("resets at 2pm", probeLate);
  assert(tomorrow != null && tomorrow > probeLate, "reset 9h in the past rolls to tomorrow");
}

// Weekly limits print a calendar date: "Resets Jul 9 at 7pm (Europe/Berlin)".
// Must land on that DATE (not today) and honor the printed zone.
{
  const jul1 = new Date("2026-07-01T09:00:00+02:00").getTime(); // 1 Jul, well before the 9th
  const wk = parseResetTime("Current week (Fable) · Resets Jul 9 at 7pm (Europe/Berlin)".toLowerCase(), jul1);
  assert(wk != null, "weekly month-date parses");
  const berlin = new Date(wk).toLocaleString("en-GB", { timeZone: "Europe/Berlin" });
  assert(berlin.startsWith("09/07/2026, 19:00"), `weekly resets Jul 9 19:00 Berlin, got ${berlin}`);
  // The same wall-clock in a far-west zone is a different instant → zone honored.
  const wkNY = parseResetTime("resets Jul 9 at 7pm (America/New_York)".toLowerCase(), jul1);
  assert(wkNY != null && wkNY - wk === 6 * 3600e3, "New_York 7pm is 6h after Berlin 7pm in summer");
}

// Newer CLI copy: the weekly banner prints a BARE time with no date
// ("You've hit your weekly limit · resets 7pm"). Detect the block AND flag it
// weekly — the bare time lands on the wrong DAY, so auto-continue must attempt
// promptly (upgraded plan continues now) instead of parking on it.
{
  const bare = detectLimitText("You've hit your weekly limit · resets 7pm (Europe/Berlin)", now);
  assert(bare.blocked, "bare-time weekly banner should block");
  assert(bare.weekly, "weekly banner should set the weekly flag");
  const sess = detectLimitText("You've hit your session limit · resets 6:20pm (Europe/Berlin)", now);
  assert(sess.blocked && !sess.weekly, "session-limit banner blocks but is NOT weekly");
}
console.log("unit: detection + parse OK");

// ── live host flow ───────────────────────────────────────────────────
const PORT = 8797;
const ROOT = mkdtempSync(join(tmpdir(), `${SLUG}-limit-`));
const env = {
  ...process.env, [E.PREFLIGHT]: "0", 
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: process.cwd() + "/scripts/claude-stub.sh",
  [E.IDLE_PING_MS]: "600",       // quick idle scans
  [E.LIMIT_RETRY_MS]: "1500",    // quick continue attempt (banner has no reset time)
};
const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.on("data", (d) => process.stdout.write("[host] " + d));
host.stderr.on("data", (d) => process.stderr.write("[host] " + d));

const fail = (m) => { console.error("FAIL:", m); host.kill(); process.exit(1); };
const BANNER = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";

bootWait(PORT, 800, async () => {
  const repo = await fetch(`http://127.0.0.1:${PORT}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "limit" }),
  }).then((r) => r.json());
  if (!repo.path) fail("could not create repo");
  const repos = await fetch(`http://127.0.0.1:${PORT}/api/repos`).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (m) => ws.send(JSON.stringify(m));
  let sid = null;
  let pty = "";
  let phase = "boot"; // boot → blocked → attempted → resumed → toggles
  let sawLimitNotif = false;
  let globalOff = false;
  const logPhases = new Set(); // limit entries seen in the decision log ("decisions.log")

  ws.on("open", () => send({ t: "hello", protocol: 1 }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") {
      send({ t: "session.create", cwd: repos.targets[0].worktreePath, cols: 120, rows: 30 });
    } else if (m.t === "session.created" && !sid) {
      sid = m.session.id;
      send({ t: "session.attach", id: sid });
      if (!m.session.limit || m.session.limit.autoContinue !== true) fail("new session should carry limit state with autoContinue on (default)");
      // Print the blocked banner, then go quiet → idle scan should flag it.
      setTimeout(() => send({ t: "session.input", id: sid, data: `echo "${BANNER}"\r` }), 500);
    } else if (m.t === "pty" && m.id === sid) {
      pty += Buffer.from(m.dataB64, "base64").toString("utf8");
    } else if (m.t === "notification" && m.item.kind === "limit") {
      console.log("notification:", m.item.title, "—", m.item.body);
      sawLimitNotif = true;
    } else if (m.t === "limit.config") {
      if (m.enabled === false) globalOff = true; // the setAuto(false) round-trip
    } else if (m.t === "decisions.log") {
      // Limit lifecycle events land in the decision log too.
      for (const e of m.entries) if (e.source === "limit") logPhases.add(e.phase);
    } else if (m.t === "session.updated" && m.session.id === sid) {
      const lim = m.session.limit;
      if (!lim) return;
      if (phase === "boot" && lim.blocked) {
        console.log(`blocked detected (attempts=${lim.attempts}, nextAttemptAt=${lim.nextAttemptAt ? "set" : "null"})`);
        phase = "blocked"; // the schedule lands in a follow-up update
      } else if (phase === "blocked" && lim.blocked && lim.nextAttemptAt && lim.attempts === 0) {
        console.log(`attempt scheduled for ${new Date(lim.nextAttemptAt).toISOString()}`);
      } else if (phase === "blocked" && lim.attempts >= 1) {
        // Leave the "blocked" phase NOW, not inside the timer: more session.updated
        // frames carrying attempts>=1 arrive during the 700 ms wait, and each would
        // re-enter this branch. The later re-entries check the PTY tail *after* the
        // filler below has scrolled "continue" out of it → spurious failure.
        phase = "attempting";
        // The attempt typed "continue" into the PTY — bash echoes it.
        setTimeout(() => {
          if (!/continue/.test(pty.slice(-2000))) fail("attempt should have typed 'continue' into the PTY");
          console.log("auto-continue attempt landed in the PTY");
          phase = "attempted";
          // Push the banner out of the scan window; with attempts>0 the next
          // idle scan should clear the block ("resumed").
          send({ t: "session.input", id: sid, data: "for i in $(seq 1 800); do echo filler-$i; done\r" });
        }, 700);
      } else if (phase === "attempted" && !lim.blocked) {
        console.log("resumed: blocked cleared after the banner left the screen");
        if (!sawLimitNotif) fail("no 'limit' notification was fired");
        phase = "toggles";
        send({ t: "limit.setAuto", enabled: false });
      } else if (phase === "toggles" && lim.autoContinue === false && lim.autoContinueOverride == null) {
        console.log("global off propagated to session");
        phase = "override";
        send({ t: "limit.session", id: sid, override: true });
      } else if (phase === "override" && lim.autoContinue === true && lim.autoContinueOverride === true) {
        if (!globalOff) fail("limit.config broadcast for the global toggle never arrived");
        console.log("per-session override beats the global switch");
        for (const p of ["blocked", "attempt", "resumed"]) {
          if (!logPhases.has(p)) fail(`activity log is missing the "${p}" limit entry (saw: ${[...logPhases].join(", ") || "none"})`);
        }
        console.log("activity log carries the limit lifecycle:", [...logPhases].join(" → "));
        console.log("PASS: limit detection, auto-continue, resume, global + per-session toggles");
        host.kill();
        process.exit(0);
      }
    }
  });
  ws.on("error", (e) => fail("ws error " + e.message));
});

watchdog(() => fail("timeout"));
