// The look a repo takes over its own waiting items just before one of them
// fires — the whole of it, through a real daemon.
//
// What decides is pure and is pinned without a host
// (`packages/shared/test/smartpick.test.mjs`), and the guard ladder and the
// store are pinned without a daemon (`packages/host/test/smartpick.test.mjs`,
// `smartpickstore.test.mjs`). What needs one is the part nobody can see from
// either: an automatic spender wired into the thing that decides what runs next
// on somebody's desktop while they are asleep. Every pin below is a way this
// feature could look like it worked while quietly costing money, losing words,
// or reordering work that had already begun:
//
//   1. AN UN-TICKED REPO SPENDS NOTHING. Not "little" — nothing: the stub
//      counts every `-p` it is asked for, per repo, and the number for the
//      un-ticked one is zero. That is the whole cost story of the feature, and
//      it is the one claim a person cannot check for themselves.
//   2. A ticked repo buys ONE pass for one pick, every waiting row wears the
//      same `picking` sentence while it runs, and the item the pass chose is
//      the one that starts.
//   3. NOTHING IS DESTROYED. A merge archives its originals — they are still
//      listed, with their own words — the merged text still names every
//      `.claude/inbox/` path its members pointed at, and `undo` puts them back
//      at the positions they had.
//   4. …and a merge a person undid is never proposed again.
//   5. EVERY FAILURE FIRES THE ORIGINAL ORDER. An unreadable answer and a pass
//      that ran past its watchdog both leave the backlog exactly as it was,
//      and neither buys a second doomed pass on the next tick.
//   6. An answer that lands after the watchdog let the row go is recorded
//      `late` and applied to NOTHING.
//   7. A position a person set by hand is never re-placed, even when the model
//      picks something else — the pick runs after it, and the strip says so.
//   8. A row chained behind a merged-away item is re-pointed at the row that
//      will actually finish, and back again on undo.
//   9. A restart with an unchanged backlog re-derives nothing: the fingerprint
//      is on disk, so the next item fires without buying a second look.
//  10. The cost line is the envelope's, never a guess — the tokens and the
//      dollars on the strip are the numbers the run actually reported.
//  11. A row somebody SCHEDULED is groomed with the rest — that was the whole
//      ask — and its CLOCK is never the pass's to decide. Two items on the
//      identical clock fold into one row that carries it (and `undo` gives both
//      of them back, clocks and all); a pick naming a timed row is corrected to
//      the first item without one, out loud; and no timed row ever changes slot.
//
// And under all of them: THE PASS TYPES INTO NOTHING. It is not a send path.
// The stub logs its interactive invocations separately, so "no session was
// opened while the repo was being looked at" is a counted fact rather than a
// comment.
import "./lib-tmuxiso.mjs"; // tmux in a socket dir of its own, killed on exit
import { E, LS, SLUG, rootEnv } from "./lib-brand.mjs";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { waitForHost } from "./lib-e2e.mjs";

const PORT = 8836;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), `${SLUG}-smartpick-`)));
// The stub's own scratch lives OUTSIDE `<ENV>_ROOT`: its counters must not show
// up as uncommitted files inside a repo whose fingerprint this test then
// expects to be stable across a restart.
const STATE = realpathSync(mkdtempSync(join(tmpdir(), `${SLUG}-smartpick-stub-`)));

let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The stub `claude` ────────────────────────────────────────────────────────
//
// ONE binary has to be two things here, because `<ENV>_CLAUDE_BIN` is one
// setting: the interactive shell every fired item runs in, and the `-p`
// completion the grooming pass buys. `claude-stub.sh` cannot answer `-p` and
// `e2e-assess.mjs`'s node stub cannot be a terminal, so this dispatches on the
// argv and keeps the interactive half byte-identical to the shared stub.
const STUB = join(STATE, "claude-stub-smartpick.sh");
const PSTUB = join(STATE, "p-stub.mjs");
writeFileSync(STUB, `#!/bin/bash
NAME="$(basename "$PWD")"
for a in "$@"; do
  if [ "x$a" = "x-p" ]; then exec node ${JSON.stringify(PSTUB)} "$@"; fi
done
printf '%s\\n' "$NAME" >> ${JSON.stringify(STATE)}/tty-"$NAME".log
exec bash --norc
`);
chmodSync(STUB, 0o755);

// The `-p` half. Its mode is read from a file PER REPO on every invocation, so
// one booted host drives six repos through six different answers at the same
// time — and so the count of how many times it was asked anything at all is
// per repo too, which is what makes pin 1 a number rather than an impression.
writeFileSync(PSTUB, `import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
const STATE = ${JSON.stringify(STATE)};
const name = basename(process.cwd());

// One line per invocation, and the line IS the argv — so the same file answers
// "how many passes did this repo buy" and "with which flags".
appendFileSync(join(STATE, \`p-\${name}.log\`), JSON.stringify(process.argv.slice(2)) + "\\n");

const modeFile = join(STATE, \`mode-\${name}\`);
const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "noop";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try { input = JSON.parse(raw); } catch { /* only the garbage modes care */ }
const tasks = Array.isArray(input.tasks) ? input.tasks : [];
const ids = tasks.map((t) => t.id);
const idOf = (marker) => (tasks.find((t) => String(t.text || "").includes(marker)) || {}).id;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function answer() {
  if (mode === "garbage") return "I had a think about it and could not make up my mind. Sorry!";
  if (mode === "slow") {
    // Deliberately outliving BOTH watchdogs, and deaf to the kill: the host's
    // own timer has to be the thing that releases the row, and a child that
    // died on \`execFile\`'s signal would settle the promise early and record a
    // plain failure instead of the timeout this pins.
    process.on("SIGTERM", () => {});
    await nap(2500);
    return JSON.stringify({ pick: ids[ids.length - 1] ?? null, order: [...ids].reverse(), merges: [], why: "far too late" });
  }
  // Long enough that the HOLD is observable on the wire. A pass that answers in
  // under a millisecond would still be correct and would pin nothing about what
  // the rows wear while it thinks.
  await nap(300);
  if (mode === "pick-c") {
    const c = idOf("TASK_C");
    return JSON.stringify({
      pick: c ?? ids[0] ?? null,
      order: [c, ...ids.filter((i) => i !== c)].filter(Boolean),
      merges: [],
      why: "the flaky test is in the way of the other two",
    });
  }
  if (mode === "merge-ab") {
    const a = idOf("TASK_A"), b = idOf("TASK_B"), c = idOf("TASK_C");
    const rest = ids.filter((i) => i !== a && i !== b && i !== c);
    return JSON.stringify({
      pick: c ?? a ?? null,
      order: [c, a, b, ...rest].filter(Boolean),
      merges: a && b ? [{
        ids: [a, b],
        // Names BOTH transport paths on purpose: the sanitiser drops a merged
        // text that loses one, and a merge that quietly dropped a file the
        // agent was told to read is the failure that rule exists for.
        text: "echo TASK_AB - rebuild the importer from the notes in .claude/inbox/a-notes.md and attach .claude/inbox/b-shot.png",
        why: "both are the importer job",
      }] : [],
      why: "the importer work is one job",
    });
  }
  // Two items on one clock, and a model that also names one of them as NEXT.
  // Both halves of the clock rule in one answer: the merge is the case that is
  // allowed (identical clocks), and the pick is the case that is corrected.
  if (mode === "merge-timed") {
    const t1 = idOf("TASK_T1"), t2 = idOf("TASK_T2"), u = idOf("TASK_U");
    return JSON.stringify({
      pick: t1 ?? u ?? null,
      order: [t1, t2, u].filter(Boolean),
      merges: t1 && t2 ? [{
        ids: [t1, t2],
        text: "echo TASK_T12 - both halves of the importer, notes in .claude/inbox/t-notes.md",
        why: "the two halves are one job on one clock",
      }] : [],
      why: "the timed importer work is one job",
    });
  }
  // The pick, on its own: a timed row the pass may not put first.
  if (mode === "pick-timed") {
    const t1 = idOf("TASK_T1"), u = idOf("TASK_U");
    return JSON.stringify({
      pick: t1 ?? u ?? null,
      order: [t1, u].filter(Boolean),
      merges: [],
      why: "the scheduled one looks more urgent",
    });
  }
  return JSON.stringify({ pick: ids[0] ?? null, order: ids, merges: [], why: "nothing worth changing" });
}

const text = await answer();
// The envelope shape \`envelopeUsage\` reads, with numbers no arithmetic could
// have produced from the prompt — so a cost line that matched by accident would
// still be caught.
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: text,
  session_id: "stub-session", num_turns: 1, duration_ms: 1,
  total_cost_usd: 0.0042,
  usage: { input_tokens: 1234, output_tokens: 56, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 },
}));
`);

const setMode = (name, mode) => writeFileSync(join(STATE, `mode-${name}`), mode);
const lines = (f) => { try { return readFileSync(join(STATE, f), "utf8").split("\n").filter(Boolean); } catch { return []; } };
/**
 * How many GROOMING completions this repo has ever bought.
 *
 * The filter is not decoration. A fired item opens a session, and every turn
 * that session ends buys a `summarize()` — another `claude -p`, in the same
 * worktree, through the same stub. Counting raw invocations would have scored
 * an un-ticked repo that ran three items at "three passes" and called the
 * feature's whole cost story broken. `--thinking disabled` is the one flag only
 * the grooming pass carries, which is what makes it the honest discriminator.
 */
const passArgv = (name) => lines(`p-${name}.log`).map((l) => JSON.parse(l)).filter((a) => a.includes("--thinking"));
const passCount = (name) => passArgv(name).length;
/** How many INTERACTIVE claudes have ever been spawned in it — the pass must
 *  add nothing to this number. */
const ttyCount = (name) => lines(`tty-${name}.log`).length;

// ── The host ─────────────────────────────────────────────────────────────────
const env = {
  ...process.env,
  [E.PREFLIGHT]: "0",
  [E.PORT]: String(PORT), [E.HOST]: "127.0.0.1", ...rootEnv(ROOT),
  [E.CLAUDE_BIN]: STUB,
  [E.IDLE_MS]: "1200",
  // Six repos being groomed at once, one item running in each. The cap is not
  // what is under test here and must not be what blocks a row: `noSlot` is a
  // rung ABOVE the hold, so a row short of a slot never reaches the pass at all.
  [E.BACKLOG_SESSIONS]: "8",
  [E.BACKLOG_REAP_IDLE_MS]: "600",
  [E.BACKLOG_LINGER_MS]: "600000",
  // 800 ms, which the host floors at 100 — the `slow` stub sits well past it.
  [E.SMARTPICK_TIMEOUT_MS]: "800",
  // OFF. The churn floor is belt-and-braces against a pass whose own result
  // keeps moving the fingerprint; leaving it at 15 s here would make half these
  // pins assert a `skipped` record instead of the thing they are about.
  [E.SMARTPICK_MIN_INTERVAL_MS]: "0",
  // A merged row waits this long before it may be the row that fires, so the
  // *put them back* button is there when a person reaches it. 30 s in
  // production; long enough here to see the hold, short enough that the rest of
  // the script is not sitting out half a minute per merge.
  [E.SMARTPICK_MERGE_HOLD_MS]: "1500",
};
let host = null;
const boot = () => {
  host = spawn("node", ["packages/host/dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  host.stderr.on("data", (d) => process.stderr.write("[host] " + d));
};
const stop = async () => { host?.kill("SIGKILL"); await sleep(700); };
process.on("exit", () => { try { host?.kill("SIGKILL"); } catch { /* already gone */ } });

const base = `http://127.0.0.1:${PORT}`;
const bail = setTimeout(() => { check(false, "timed out"); void stop().then(() => process.exit(1)); }, 180_000);

// ── One connection, the two lists the phone reads ────────────────────────────
let c = null;
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const s = { items: [], waiting: {}, smartPick: [], passes: {}, intents: [], toasts: [], outcomes: new Map(), shapes: [] };
  /** Every outcome ever seen per repo — a `timeout` overwritten by the `late`
   *  that follows it two seconds later would otherwise be unobservable. */
  const seen = (cwd, o) => { const set = s.outcomes.get(cwd) ?? new Set(); set.add(o); s.outcomes.set(cwd, set); };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "backlog.list") {
      s.items = m.items; s.waiting = m.waiting || {};
      s.smartPick = m.smartPick; s.passes = m.passes;
      s.shapes.push({ smartPick: m.smartPick, passes: m.passes });
      for (const [cwd, p] of Object.entries(m.passes || {})) seen(cwd, p.outcome);
      s.onList?.(m);
    }
    if (m.t === "intent.list") s.intents = m.intents;
    if (m.t === "intent.changed") {
      const at = s.intents.findIndex((i) => i.id === m.intent.id);
      if (at < 0) s.intents.push(m.intent); else s.intents[at] = m.intent;
    }
    if (m.t === "toast") s.toasts.push(m.text);
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "hello", protocol: 1 }));
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.close = () => ws.close();
  s.refresh = () => { s.send({ t: "backlog.list" }); s.send({ t: "intent.list" }); };
  s.rows = (dir) => s.items.filter((i) => i.repoDir === dir).sort((a, b) => a.order - b.order);
  s.row = (dir, marker) => s.rows(dir).find((i) => (i.text || "").includes(marker));
  s.intent = (id) => s.intents.find((i) => i.id === id);
  await sleep(300);
  s.refresh();
  await sleep(300);
  return s;
}

/** Poll a predicate, asking the host for a fresh pair of lists as it goes. */
async function waitFor(pred, ms = 40_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    c.refresh();
    await sleep(150);
  }
  return false;
}

/** A repo with items in it, listed in the order this array is written — the
 *  backlog puts the newest on TOP, so they go in backwards. */
async function seedRepo(name, texts) {
  const r = await fetch(`${base}/api/repo`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((x) => x.json());
  const dir = r.path;
  for (const t of [...texts].reverse()) c.send({ t: "backlog.add", text: t, repoDir: dir });
  await sleep(250);
  return dir;
}

const tick = (dir, enabled) => c.send({ t: "backlog.setSmartPick", repoDir: dir, enabled });
/** The order a repo's rows actually STARTED in, which is the only thing the
 *  user experiences — the list order is just what it was predicted to be. */
const runOrder = (dir) => c.items
  .filter((i) => i.repoDir === dir && i.startedAt)
  .sort((a, b) => a.startedAt - b.startedAt)
  .map((i) => (i.text || "").match(/TASK_[A-Z]+/)?.[0] ?? i.id);

boot();
await waitForHost(PORT);
await sleep(600);
c = await connect();

const A = "echo TASK_A - rebuild the importer, notes in .claude/inbox/a-notes.md";
const B = "echo TASK_B - attach .claude/inbox/b-shot.png to the importer notes";
const C = "echo TASK_C - the flaky test";
// The timed half. `T1`/`T2` are saved through `schedule.save` — the message the
// phone has always sent for "run this at a time", unchanged by any of this —
// and land in the repo's BACKLOG, because recurrence and not trigger kind
// decides which list a row lives in. `U` is the ordinary item that comes up for
// firing and so is what buys the pass; the timed two are what the pass is then
// allowed, and not allowed, to do things to.
const T1 = "echo TASK_T1 - the importer's first half, notes in .claude/inbox/t-notes.md";
const T2 = "echo TASK_T2 - the importer's second half";
const U = "echo TASK_U - the untimed chore";
/**
 * One clock, an hour out, on a one-off aimed at one repo.
 *
 * An hour rather than seconds on purpose: these rows must never come DUE inside
 * the run. A timed row that fired would be testing the ladder, which
 * `e2e-timedwork.mjs` already pins; what is under test here is what a grooming
 * pass may do to a row that is waiting on a clock, which is only observable
 * while it is still waiting.
 */
const CLOCK_AT = Date.now() + 3_600_000;
const saveTimed = (id, dir, text) => c.send({
  t: "schedule.save",
  entry: {
    id, name: id, enabled: true, graceMin: 120,
    rule: { kind: "once", at: CLOCK_AT },
    waitUntilFree: true,
    action: { kind: "backlog", repoDir: dir, text, autoFire: true },
  },
});

// ── Six repos, groomed six different ways, at once ───────────────────────────
const offDir = await seedRepo("off", [A, B, C]);
const pickDir = await seedRepo("pick", [A, B, C]);
const mergeDir = await seedRepo("merge", [A, B, C]);
const badDir = await seedRepo("bad", [A, B]);
const slowDir = await seedRepo("slow", [A, B]);
const dragDir = await seedRepo("drag", [A, B, C]);
const mtDir = await seedRepo("mtimed", [U]);
const ptDir = await seedRepo("ptimed", [U]);
saveTimed("mt-1", mtDir, T1);
saveTimed("mt-2", mtDir, T2);
saveTimed("pt-1", ptDir, T1);

setMode("pick", "pick-c");
setMode("merge", "merge-ab");
setMode("bad", "garbage");
setMode("slow", "slow");
setMode("drag", "pick-c");
setMode("mtimed", "merge-timed");
setMode("ptimed", "pick-timed");

// The clock arrives on the BACKLOG row, through the same `schedule.save` an old
// APK still sends — which is the premise everything below rests on.
await waitFor(() => !!c.row(mtDir, "TASK_T1") && !!c.row(ptDir, "TASK_T1"));
check(c.row(mtDir, "TASK_T1")?.at?.rule?.kind === "once",
  `a one-off aimed at one repo is a backlog row wearing its clock (${JSON.stringify(c.row(mtDir, "TASK_T1")?.at?.rule)})`);
check(c.row(mtDir, "TASK_T1")?.holdForHost === true,
  "…and *wait until it's free* rides on it as the host-wide hold");
const ptSlotBefore = c.row(ptDir, "TASK_T1").order;
const mtSlotsBefore = [c.row(mtDir, "TASK_T1").order, c.row(mtDir, "TASK_T2").order];

// A row chained behind TASK_A in the repo whose TASK_A is about to be merged
// away. `backlog.add` cannot make a chain, so the row is posted and then
// re-triggered, which is the same patch the sheet's *queue behind* sends.
await waitFor(() => !!c.row(mergeDir, "TASK_A"));
const mergeA = c.row(mergeDir, "TASK_A").id;
const mergeB = c.row(mergeDir, "TASK_B").id;
c.send({ t: "backlog.add", text: "echo TASK_Z - only once the importer is done", repoDir: mergeDir });
await waitFor(() => !!c.row(mergeDir, "TASK_Z"));
const zId = c.row(mergeDir, "TASK_Z").id;
c.send({ t: "intent.update", id: zId, ackId: "chain-z", patch: { trigger: { kind: "after", id: mergeA, title: "the importer" } } });
await waitFor(() => c.intent(zId)?.trigger?.kind === "after");

// The drag. `backlog.swap` is the tap that exchanges two rows, and it is one of
// exactly two verbs that stamp `handOrdered` — which is the whole mechanism by
// which a position a person set survives an automatic sort.
c.send({ t: "backlog.swap", id: c.row(dragDir, "TASK_A").id, otherId: c.row(dragDir, "TASK_B").id });
await waitFor(() => c.rows(dragDir)[0]?.text?.includes("TASK_B"));
const dragOrderBefore = c.rows(dragDir).map((i) => `${i.text.match(/TASK_[A-Z]/)[0]}@${i.order}`);
check(c.rows(dragDir).filter((i) => i.handOrdered).length === 2,
  "a swap marks exactly the two rows it moved as placed by hand");

for (const d of [pickDir, mergeDir, badDir, slowDir, dragDir, mtDir, ptDir]) tick(d, true);
await waitFor(() => c.smartPick?.length === 7);
check(Array.isArray(c.smartPick) && !c.smartPick.includes(offDir),
  `the tick is per repo: seven on, and the un-ticked one is not among them`);
check(c.shapes.every((s) => Array.isArray(s.smartPick) && s.passes && typeof s.passes === "object"),
  "every backlog.list ships both fields — a client never has to guess whether the host knows the feature");

const slowOrderBefore = c.rows(slowDir).map((i) => i.text.match(/TASK_[A-Z]/)[0]);
const badOrderBefore = c.rows(badDir).map((i) => i.text.match(/TASK_[A-Z]/)[0]);

// Nothing has fired yet, so nothing has been looked at yet.
check(passCount("pick") === 0 && passCount("off") === 0,
  "a repo whose items have not come up for firing has bought nothing");

// Automatic sessions stay open by default (cd04487); these rows need their slot back.
c.send({ t: "settings.set", key: `${LS}backlog.closeWhenDone`, value: "1", ts: Date.now(), device: "e2e" });
c.send({ t: "backlog.setAuto", enabled: true });

// ── 2 · one pass per pick, and the pass types into nothing ───────────────────
const held = await waitFor(() => Object.entries(c.waiting)
  .some(([id, why]) => /looking over this repo/.test(why) && c.items.find((i) => i.id === id)?.repoDir === pickDir));
check(held, "a ticked repo HOLDS its next item while it looks — with a sentence, not a spinner");
const heldRows = c.rows(pickDir).filter((i) => /looking over this repo/.test(c.waiting[i.id] || ""));
check(heldRows.length >= 2,
  `every waiting row in the repo wears the same hold, from ONE look (${heldRows.length} of 3)`);
check(ttyCount("pick") === 0,
  "…and the look opened no session: the pass reads a list, it is not a send path");
check(c.rows(pickDir).every((i) => i.status === "queued"),
  "…and nothing was started while it thought");

check(await waitFor(() => runOrder(pickDir).length >= 1), "the held item eventually runs");
check(runOrder(pickDir)[0] === "TASK_C", `the item the pass picked is the one that started (${runOrder(pickDir).join(" → ")})`);
check(passCount("pick") === 1, `one pick bought exactly one pass (${passCount("pick")})`);

const argv = passArgv("pick")[0] || [];
const flag = (f, v) => { const at = argv.indexOf(f); return at >= 0 && argv[at + 1] === v; };
check(argv[0] === "-p" && flag("--output-format", "json") && flag("--setting-sources", "user")
  && flag("--tools", "") && flag("--thinking", "disabled") && argv.includes("--system-prompt"),
  `the pass keeps every flag the cheap unattended call is required to keep, thinking included (${argv.slice(0, 12).join(" ")})`);

// ── 10 · the cost line is the envelope's ─────────────────────────────────────
const pickPass = c.passes[pickDir];
check(!!pickPass && pickPass.outcome === "applied", `the pass recorded itself as applied (${pickPass?.outcome})`);
check(pickPass?.tokens?.inTok === 1234 && pickPass?.tokens?.outTok === 56
  && pickPass?.tokens?.cacheRead === 7 && pickPass?.tokens?.cacheWrite === 8,
  `the tokens on the strip are the run's own (${JSON.stringify(pickPass?.tokens)})`);
check(pickPass?.usd === 0.0042, `…and so is the dollar figure (${pickPass?.usd})`);
check(pickPass?.engine === "claude-p" && pickPass?.model === "haiku",
  `…and it says which engine and model spent them (${pickPass?.engine} / ${pickPass?.model})`);
check(/TASK_C/.test(pickPass?.picked || ""), `the strip names what was picked, in the item's words (${pickPass?.picked})`);
tick(pickDir, false);

// ── 7 · a hand-placed row is never re-placed ─────────────────────────────────
check(await waitFor(() => !!c.passes[dragDir]), "the repo with a drag in it also ran its look");
const dragPass = c.passes[dragDir];
check(dragPass?.sorted === 0 && dragPass?.outcome === "noop",
  `a pass over rows a person placed moves nothing (${dragPass?.outcome}, sorted ${dragPass?.sorted})`);
check(c.rows(dragDir).map((i) => `${i.text.match(/TASK_[A-Z]/)[0]}@${i.order}`).join(",") === dragOrderBefore.join(","),
  `…and every slot is the one the drag left (${dragOrderBefore.join(" ")})`);
check((dragPass?.notes || []).some((n) => /you had placed/.test(n)),
  `…and it SAYS the pick runs behind the row you placed (${JSON.stringify(dragPass?.notes)})`);
check(await waitFor(() => runOrder(dragDir).length >= 1), "the drag repo starts something");
check(runOrder(dragDir)[0] === "TASK_B", `…and it is the row the person put first, not the one the model picked (${runOrder(dragDir).join(" → ")})`);
tick(dragDir, false);

// ── 5a · an unreadable answer fires the order it found ───────────────────────
check(await waitFor(() => c.passes[badDir]?.outcome === "failed"), "an answer that is not JSON is a FAILED pass, not a silent one");
check(/nothing readable/.test(c.passes[badDir]?.detail || ""),
  `…and it says what went wrong (${c.passes[badDir]?.detail})`);
check(await waitFor(() => runOrder(badDir).length >= 1), "the item fires anyway");
check(runOrder(badDir)[0] === badOrderBefore[0],
  `…in exactly the order the repo already had (${badOrderBefore.join(" ")} → ${runOrder(badDir).join(" → ")})`);
check(passCount("bad") === 1, `…and the same doomed pass is not bought again on the next tick (${passCount("bad")})`);
tick(badDir, false);

// ── 5b/6 · the watchdog, and the answer that arrives too late ────────────────
check(await waitFor(() => c.outcomes.get(slowDir)?.has("timeout")), "a pass that runs past its watchdog is recorded as a timeout");
check(await waitFor(() => runOrder(slowDir).length >= 1), "…and the item fires");
check(runOrder(slowDir)[0] === slowOrderBefore[0],
  `…in the order the repo already had (${slowOrderBefore.join(" ")} → ${runOrder(slowDir).join(" → ")})`);
check(passCount("slow") === 1, `…and the next tick does not buy the same timeout again (${passCount("slow")})`);
check(await waitFor(() => c.outcomes.get(slowDir)?.has("late")), "the answer that arrived afterwards is recorded LATE");
check(c.rows(slowDir).map((i) => i.text.match(/TASK_[A-Z]/)[0]).join(",") === slowOrderBefore.join(","),
  `…and applied to nothing: the order it proposed was the reverse, and the list is unchanged (${slowOrderBefore.join(" ")})`);
tick(slowDir, false);

// ── 3 · a merge keeps everything, and undo puts it back ──────────────────────
check(await waitFor(() => c.rows(mergeDir).some((i) => i.mergedFrom?.length === 2)), "two items that are one job become one row");
const merged = c.rows(mergeDir).find((i) => i.mergedFrom?.length === 2);
check(/^mg[0-9a-f]{6}$/.test(merged.id), `the merged row's id says where it came from (${merged.id})`);
check(merged.label === undefined, "…and it carries no label: nobody named it");
check((merged.origin || "").startsWith("smartpick:"), `…and its provenance is on the row (${merged.origin})`);
check(merged.text.includes(".claude/inbox/a-notes.md") && merged.text.includes(".claude/inbox/b-shot.png"),
  "the merged words still name every transport path its members pointed at");

const archivedA = c.rows(mergeDir).find((i) => i.id === mergeA);
const archivedB = c.rows(mergeDir).find((i) => i.id === mergeB);
check(archivedA?.archived === true && archivedB?.archived === true,
  "the originals are ARCHIVED — set aside, never retired");
check(archivedA?.text === A && archivedB?.text === B,
  "…with every word anybody typed still in the list");
check(archivedA?.mergedInto === merged.id && archivedB?.mergedInto === merged.id,
  "…and each says which row now stands in for it");
const prevOrders = { [mergeA]: archivedA.order, [mergeB]: archivedB.order };

// ── 8 · the chain behind a merged-away row ───────────────────────────────────
check(c.intent(zId)?.trigger?.id === merged.id,
  `a row chained behind a folded item is re-pointed at the row that will finish (${c.intent(zId)?.trigger?.id})`);
check(/TASK_AB/.test(c.intent(zId)?.trigger?.title || ""),
  `…and the sentence it wears names something real (${c.intent(zId)?.trigger?.title})`);

// ── 4 · undo, and the window it needs to be reachable in ─────────────────────
//
// The pass picks and applies in one breath, and `applySmartPick` may name the
// merged row as the pick — so the tick right behind the apply used to FIRE it,
// the notification's promise ("undo is on the row") was already false by the
// time a phone was picked up, and the sleeper met "it has already run" instead.
// A row nobody typed therefore waits out its own undo window first.
// (Here the merged row is behind a sibling that is already running, so what it
// SAYS is `serial`'s sentence rather than the merge's; the hold itself is pinned
// where it can be isolated, in `smartpickstore.test.mjs`. What this script can
// still see is the consequence, which is the thing that matters: a row nobody
// typed has not started by the time a person could reach it.)
const mergedNow = () => c.rows(mergeDir).find((i) => i.id === merged.id);
check(mergedNow()?.status !== "running" && mergedNow()?.status !== "done",
  `the row the pass wrote did not fire in the breath that wrote it (${mergedNow()?.status})`);
check(merged.status === "queued" || merged.status === "blocked",
  `the merged row is still waiting, so undo is on the table (${merged.status})`);
c.send({ t: "backlog.unmerge", id: merged.id });
check(await waitFor(() => !c.rows(mergeDir).some((i) => i.id === merged.id)), "undo removes the row the pass wrote");
check(c.rows(mergeDir).find((i) => i.id === mergeA)?.archived !== true
  && c.rows(mergeDir).find((i) => i.id === mergeB)?.archived !== true,
  "…and brings both originals back out of archived");
check(c.rows(mergeDir).find((i) => i.id === mergeA)?.order === prevOrders[mergeA]
  && c.rows(mergeDir).find((i) => i.id === mergeB)?.order === prevOrders[mergeB],
  "…at the positions they had before the merge");
check(c.intent(zId)?.trigger?.id === mergeA,
  `…and the chain is put back on the item it was written behind (${c.intent(zId)?.trigger?.id})`);

c.send({ t: "backlog.unmerge", id: "not-a-merged-row" });
check(await waitFor(() => c.toasts.some((t) => /not made by the smart pick/.test(t))),
  `a refused undo answers in words (${JSON.stringify(c.toasts.slice(-1))})`);

// The same model, asked again, proposes the same merge again — and the pass
// refuses it, because a person already said no. Without this the two of them
// take turns for ever.
const passesBefore = passCount("merge");
check(await waitFor(() => passCount("merge") > passesBefore, 60_000), "the repo looks again once its fingerprint has moved");
// Wait for the RECORD, never for a fixed sleep. `passCount` counts the stub
// being SPAWNED and the record it produces lands a few hundred milliseconds
// later; a `sleep(600)` here passed on a quiet desktop and failed on a full
// parallel e2e run, reading the PREVIOUS pass's (noteless) summary and
// reporting it as the refusal never having been said.
const undidNote = await waitFor(() => (c.passes[mergeDir]?.notes || []).some((n) => /already undid/.test(n)), 30_000);
check(!c.rows(mergeDir).some((i) => i.mergedFrom?.length),
  "a merge a person undid is never proposed again");
check(undidNote,
  `…and the strip says why it was left alone (${JSON.stringify(c.passes[mergeDir]?.notes)})`);
tick(mergeDir, false);

// ── 11a · a pick may not name a row with a clock ─────────────────────────────
//
// The stub names the scheduled row as NEXT, which is the one thing "next"
// cannot mean here: a timed row runs at the instant a person chose, and a pass
// that put it first would either be overruling that instant or claiming
// something it cannot do. The pick moves to the first item without a clock and
// the strip says that is what happened — a silent correction reads as the model
// having picked the boring one.
check(await waitFor(() => !!c.passes[ptDir]), "the repo with a scheduled row in it ran its look");
check((c.passes[ptDir]?.notes || []).some((n) => /runs on its own clock/.test(n) && /the first item without one/.test(n)),
  `…and SAYS the clock stands and the pick moved (${JSON.stringify(c.passes[ptDir]?.notes)})`);
check(await waitFor(() => runOrder(ptDir).length >= 1), "something starts in it");
check(runOrder(ptDir)[0] === "TASK_U",
  `…and it is the item WITHOUT a clock, not the one the model picked (${runOrder(ptDir).join(" → ")})`);
check(c.row(ptDir, "TASK_T1")?.order === ptSlotBefore,
  `the timed row's slot is its clock's — the sort never re-placed it (${c.row(ptDir, "TASK_T1")?.order} was ${ptSlotBefore})`);
check(["queued", "blocked"].includes(c.row(ptDir, "TASK_T1")?.status)
  && c.row(ptDir, "TASK_T1")?.at?.nextAt === CLOCK_AT,
  `…and it is still waiting on exactly the instant it was saved for (${c.row(ptDir, "TASK_T1")?.status})`);
tick(ptDir, false);

// ── 11b · two items on ONE clock fold into a row that carries it ─────────────
check(await waitFor(() => c.rows(mtDir).some((i) => i.mergedFrom?.length === 2)),
  "two scheduled items that are one job become one row");
const mtMerged = c.rows(mtDir).find((i) => i.mergedFrom?.length === 2);
check(mtMerged?.at?.rule?.kind === "once" && mtMerged?.at?.nextAt === CLOCK_AT,
  `…on the SAME clock its members waited on, never on “as soon as the repo is free” (${JSON.stringify(mtMerged?.at?.rule)})`);
check(mtMerged?.holdForHost === true,
  "…and it keeps the *wait until it's free* they were both saved with");
check(mtMerged?.text.includes(".claude/inbox/t-notes.md"),
  "…and it still names the file its members pointed at");
const mtT1 = c.rows(mtDir).find((i) => i.id === "mt-1");
const mtT2 = c.rows(mtDir).find((i) => i.id === "mt-2");
check(mtT1?.archived === true && mtT2?.archived === true, "the originals are set aside, never retired");
check((c.passes[mtDir]?.notes || []).some((n) => /runs on its own clock/.test(n)),
  `and the pick, which named one of them, was corrected out loud (${JSON.stringify(c.passes[mtDir]?.notes)})`);
check(runOrder(mtDir)[0] === "TASK_U",
  `…so the item that ran is the one without a clock (${runOrder(mtDir).join(" → ")})`);

c.send({ t: "backlog.unmerge", id: mtMerged.id });
check(await waitFor(() => !c.rows(mtDir).some((i) => i.id === mtMerged.id)), "undo takes the merged row away again");
check(c.rows(mtDir).find((i) => i.id === "mt-1")?.archived !== true
  && c.rows(mtDir).find((i) => i.id === "mt-2")?.archived !== true,
  "…and both scheduled items come back");
check(c.rows(mtDir).find((i) => i.id === "mt-1")?.at?.nextAt === CLOCK_AT
  && c.rows(mtDir).find((i) => i.id === "mt-2")?.at?.nextAt === CLOCK_AT,
  "…still armed for the instant they were saved for: a merge and its undo never touched a clock");
check(c.rows(mtDir).find((i) => i.id === "mt-1")?.order === mtSlotsBefore[0]
  && c.rows(mtDir).find((i) => i.id === "mt-2")?.order === mtSlotsBefore[1],
  "…at the slots they had");
tick(mtDir, false);

// ── 1 · the un-ticked repo, at the end, having run its whole list ────────────
check(await waitFor(() => runOrder(offDir).length === 3, 90_000),
  `every item in the un-ticked repo ran (${runOrder(offDir).join(" → ")})`);
check(runOrder(offDir).join(",") === "TASK_A,TASK_B,TASK_C",
  `…in exactly the order it was listed (${runOrder(offDir).join(" → ")})`);
check(passCount("off") === 0, `AN UN-TICKED REPO SPENDS NOTHING — zero completions bought (${passCount("off")})`);
check(c.passes[offDir] === undefined, "…and it has no pass to show, because none ever ran");

// ── 9 · a restart re-derives nothing ─────────────────────────────────────────
//
// The fingerprint of the state a pass left behind is on disk, so the next tick
// after a restart reads "nothing has changed" and fires the item the repo
// already had — without buying a second look. Getting the repo into that state
// deliberately: the tick goes on with the switch off, the switch goes on long
// enough for exactly one pass to start, and off again while that pass is still
// thinking, so the row it was holding never fires and the list it recorded is
// the list that is still there.
c.send({ t: "backlog.setAuto", enabled: false });
await sleep(400);
const resumeDir = await seedRepo("resume", [A, B, C]);
setMode("resume", "noop");
tick(resumeDir, true);
await waitFor(() => c.smartPick?.includes(resumeDir));

c.onList = () => {
  if (Object.entries(c.waiting).some(([id, why]) => /looking over this repo/.test(why)
    && c.items.find((i) => i.id === id)?.repoDir === resumeDir)) {
    c.onList = null;
    c.send({ t: "backlog.setAuto", enabled: false });
  }
};
c.send({ t: "backlog.setAuto", enabled: true });
check(await waitFor(() => c.passes[resumeDir]?.outcome === "noop"), "the quiet repo ran one look and moved nothing");
await sleep(500);
check(passCount("resume") === 1, `…for exactly one completion (${passCount("resume")})`);
check(c.rows(resumeDir).length === 3 && c.rows(resumeDir).every((i) => i.status === "queued" && !i.startedAt),
  "…and its three items are all still waiting, so the list it recorded is the list on disk");

c.close();
await stop();
boot();
await waitForHost(PORT);
await sleep(600);
c = await connect();
check(c.smartPick?.includes(resumeDir), "the tick survives the restart");
check(c.passes[resumeDir]?.outcome === "noop", "…and so does the record of the last look");
c.send({ t: "backlog.setAuto", enabled: true });
check(await waitFor(() => runOrder(resumeDir).length >= 1), "the first item fires after the restart");
check(passCount("resume") === 1,
  `…having bought NO second look: the fingerprint was read off disk (${passCount("resume")})`);

clearTimeout(bail);
c.close();
await stop();
console.log(failed ? "\nFAILED" : "\nOK");
process.exit(failed ? 1 : 0);
