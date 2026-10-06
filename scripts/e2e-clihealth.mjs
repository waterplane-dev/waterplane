// The CLI integration reports its own health — end to end.
//
// `packages/shared/src/clihealth.ts` is pure and pinned by `npm run test:unit`:
// every threshold, the verdict order, the redaction, the sentence. What no unit
// test can pin is the half that actually decides whether the feature works —
// that the HOST notices. The failure this exists to catch is not a crash: it is
// a heuristic that quietly stops matching while every code path around it
// handles the miss gracefully, individually, exactly as designed. Which is
// indistinguishable from working.
//
// There is a second failure, discovered on the live host the day this shipped,
// and it is the one that kills the feature rather than merely blunting it: a
// signal that reports a miss where the rule was NOT the right rule and
// correctly declined to fire. Both of the board's first two readings on the
// real machine were that — a choice-box detector reported "4 of 9 failed" while
// working perfectly, and a hook pipe reported 42 misses on sessions whose pipes
// were alive. An amber chip nobody can act on is an amber chip that teaches the
// one person who could act on it to stop reading the board, which costs
// everything the board was for. So the rule is: **an observation is a miss only
// if the primary rule was the right rule and failed.**
//
// Which makes this script two halves that only mean something as a pair. Each
// boots its own host on its own temp ROOT, so neither can poison the real
// record and neither can see the other's:
//
//   A. `STUB_MODE=unreadable` — a dialog the detector genuinely cannot read
//      (the real footer, option rows numbered `1)` instead of `1.`). Asserts
//      that the app knows it is blind, that the miss lands on `prompt.box` and
//      reaches `degraded`, and that the captured sample keeps the line that
//      stopped matching while dropping the account name and the credential that
//      were sitting next to it.
//
//   B. `STUB_MODE=prose` — a session that is not asking anything and merely
//      SAYS the words, which is what a claude working on `prompt.ts` puts on a
//      screen. Asserts that the interlock still fires (it must: a false wait is
//      cheap, typing into a live question box is not) and that the health
//      record stays completely EMPTY of `prompt.box` — not a miss, and not a
//      `good` either, because nothing was seen to work.
//
// B also carries the `hook.pipe` pair, for the same reason and on the same
// host: a stub has no hook pipe, so `hooksActive` is false for its whole life,
// and the question is whether merely EXISTING in that state is a fallback.
// It is not — the fallback is the silence heuristic being used to decide a turn
// boundary, which only happens once a turn has been seen to start. Sitting
// there records nothing; typing a Return and going quiet records exactly one.
//
// The record is read off `<root>/<state>/clihealth.json` rather than asked for
// over the socket: the root is this test's own temp directory, which is also
// what keeps an e2e run from ever writing into the real host's health record.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { cleanHealth, healthRollup, signalVerdict } from "../packages/shared/dist/clihealth.js";
import { E, SLUG, STATE, rootEnv } from "./lib-brand.mjs";

const STUB = process.cwd() + "/scripts/claude-stub-tui.mjs";
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot a host on its own ROOT with the stub in `mode`, open one session in a
 * fresh repo, and hand back the session's published info plus a reader for the
 * health record.
 *
 * `<ENV>_IDLE_PING_MS` is pulled under the stub's 2 s repaint cycle on purpose:
 * the silence timer is rescheduled on every byte, so at the 4 s default a mode
 * that repaints itself is never quiet long enough to go idle and the turn-
 * boundary guess this script asserts about would simply never be taken.
 * `<ENV>_HEALTH_GRACE_MS` is the spawn grace that stops a two-second-old session
 * logging a fallback before its first hook could possibly have arrived; it is
 * a real rule, and it is minutes wide, so it is shortened rather than removed.
 */
async function boot(port, mode, name) {
  const root = mkdtempSync(join(tmpdir(), `${SLUG}-clihealth-`));
  const env = {
    ...process.env,
    [E.PREFLIGHT]: "0",
    [E.PORT]: String(port), [E.HOST]: "127.0.0.1", ...rootEnv(root),
    [E.CLAUDE_BIN]: STUB, STUB_MODE: mode,
    [E.IDLE_PING_MS]: "1200", [E.HEALTH_GRACE_MS]: "1",
  };
  const host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write(`[${mode}] ` + d));
  const base = `http://127.0.0.1:${port}`;
  await sleep(1500);

  const repo = await fetch(`${base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  }).then((r) => r.json());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const state = { sid: null, info: null };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "session.created") state.sid = m.session.id;
    if ((m.t === "session.created" || m.t === "session.updated") && (!state.sid || m.session.id === state.sid)) state.info = m.session;
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  await sleep(200);
  ws.send(JSON.stringify({ t: "session.create", cwd: repo.path, cols: 80, rows: 40 }));

  const until = async (cond, ms = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(150); }
    return false;
  };
  await until(() => state.sid);
  ws.send(JSON.stringify({ t: "session.attach", id: state.sid }));

  /** The health record as the host has written it, or null before the first flush. */
  const readHealth = () => {
    try { return cleanHealth(JSON.parse(readFileSync(join(root, STATE, "clihealth.json"), "utf8"))); }
    catch { return null; }
  };
  const stop = () => { try { ws.close(); } catch { /* already gone */ } host.kill(); };
  return { state, ws, until, readHealth, stop };
}

/** A. A box that is genuinely up and genuinely unreadable. */
async function unreadablePhase() {
  const h = await boot(8899, "unreadable", "blind");
  try {
    // 1. The app is blind, and says so in the only way it can: no parsed box,
    //    but the weaker "something is asking you something" flag.
    check(await h.until(() => h.state.info?.awaitingInput === true), "an unparsable dialog raises awaitingInput");
    check(!h.state.info?.prompt, "...and publishes no box — which is the silent failure, not an error");

    // 2. The record.
    if (!(await h.until(() => h.readHealth() != null, 15000))) {
      check(false, "the host wrote no health record at all — noteHealth is a no-op on this host");
      return;
    }

    // Two appearances of the box = two misses = degraded; the persist is
    // debounced ~2 s, so this waits for the file rather than assuming it.
    const degraded = await h.until(() => {
      const rec = h.readHealth();
      const sig = rec?.signals["prompt.box"];
      return !!sig && signalVerdict(sig, Date.now()).verdict === "degraded";
    }, 25000);
    check(degraded, "the host records the miss against prompt.box and the verdict reaches degraded");

    const sig = h.readHealth()?.signals["prompt.box"];
    check((sig?.misses ?? 0) >= 2, `two misses in a row, not one moment (misses=${sig?.misses ?? 0})`);
    check(sig?.lastGoodAt == null, "nothing here has ever been confirmed, so it is not healthy either");
    check(signalVerdict(sig, Date.now()).because === "misses",
      "the streak rule decided it — a rate needs more samples than a blocked session produces");

    // 3. The sample: the line that stopped matching, and nothing that was
    //    sitting next to it on the screen.
    const sample = sig?.sample ?? "";
    check(/Enter to confirm/.test(sample), "the sample keeps the footer the matcher was matching against");
    check(/1\) Yes/.test(sample), "...and the option row it refused, which is the whole point of keeping a sample");
    check(!sample.includes("/Users/somebody"), "the account name is redacted out of the sample");
    check(/~\/dev\/octopus/.test(sample), "...the path is still legible as a path");
    check(!sample.includes("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "the token-shaped string never enters the record");
    check(/<redacted/.test(sample), "...and the sample says where something was removed");

    // 4. The rollup is what the launcher's mark and the notification are cut
    //    from, so a signal that is degraded and a board that says "healthy"
    //    would be the same silence in a new place.
    const roll = healthRollup(h.readHealth(), Date.now());
    check(roll.verdict === "degraded", "the rollup — what a badge shows — is degraded too");
    check(roll.degraded.includes("prompt.box"), "...and names the signal, so the mark can be tapped through to it");
    check(roll.lines.some((l) => /question box/i.test(l)), "...with one generated sentence, not a count");
  } finally {
    h.stop();
  }
}

/** B. Prose that merely says the words, and a pipe that was never owed a hook. */
async function prosePhase() {
  const h = await boot(8900, "prose", "talker");
  try {
    // The interlock fires. It has to: the cheap gate's question is "is anything
    // possibly asking you something?", and it is answered loosely on purpose
    // because a false wait costs a queue a few seconds while typing into a live
    // question box costs a turn's work. Nothing about this half is being fixed.
    check(await h.until(() => h.state.info?.awaitingInput === true, 15000),
      "prose containing the footer's words still trips the interlock, exactly as designed");
    check(!h.state.info?.prompt, "...and the strict pass correctly refuses to read a paragraph as a box");

    // Let the screen cycle several times. Under the old rule each repaint that
    // re-raised the flag was one `prompt.box` miss, which is how a working
    // detector reported 44% failure on the real host.
    await sleep(7000);

    // The hook pipe, negative half. The stub POSTs no hooks (STUB_HOOKS is
    // unset), so this session has been unhooked for its whole life and has gone
    // idle several times over by now — but nothing ever started a turn, so no
    // `Stop` was ever owed and no silence guess was ever taken. Merely being
    // unhooked is not a fallback. This is the assertion a `npm run restart`
    // used to break thirty times over: `rediscover()` hands back thirty live
    // tmux sessions with `hooksActive` false, and each logged a miss for a pipe
    // that was perfectly alive.
    const beforeHook = h.readHealth()?.signals["hook.pipe"];
    check(beforeHook == null,
      `an unhooked session that never ran a turn records no fallback (got ${JSON.stringify(beforeHook?.window ?? null)})`);

    // The hook pipe, positive half. A raw write ending in Return is our own
    // Return, which is what sets `turnActive` on a session with no pipe — so
    // from here the CLI owes us a turn boundary and will not report one. The
    // silence timer guesses it, and THAT is the fallback worth recording.
    h.ws.send(JSON.stringify({ t: "session.input", id: h.state.sid, data: "tell me about the detector" }));
    await sleep(150);
    h.ws.send(JSON.stringify({ t: "session.input", id: h.state.sid, data: "\r" }));

    const logged = await h.until(() => h.readHealth()?.signals["hook.pipe"] != null, 15000);
    check(logged, "a turn boundary guessed from silence IS the fallback, and is recorded");
    const hook = h.readHealth()?.signals["hook.pipe"];
    check(hook?.via === "silence heuristics", `...named by what stood in (via=${hook?.via})`);
    check(hook?.totalMiss === 1,
      `...exactly once for this session, not once per turn (totalMiss=${hook?.totalMiss})`);

    // …and the record that now provably exists on this host — the store is
    // installed, the file is on disk, `hook.pipe` is in it — holds nothing at
    // all about the choice-box detector. That is the whole of fix 1 stated as
    // an absence, which is the only way it can be stated: a correct refusal is
    // not a miss, and it is not a `good` either, because a `good` per refusal
    // would fill the twenty-slot window with successes and make the real misses
    // arithmetically invisible.
    const rec = h.readHealth();
    check(rec != null, "the store is demonstrably live on this host");
    check(rec?.signals["prompt.box"] == null,
      `prose records NOTHING against prompt.box (got ${JSON.stringify(rec?.signals["prompt.box"] ?? null)})`);
    check(healthRollup(rec, Date.now()).degraded.includes("prompt.box") === false,
      "...so no chip, no toast, and no notification about a detector that did its job");
  } finally {
    h.stop();
  }
}

(async () => {
  try {
    await unreadablePhase();
    await prosePhase();
  } catch (e) {
    console.error(e);
    failed = true;
  } finally {
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  }
})();
