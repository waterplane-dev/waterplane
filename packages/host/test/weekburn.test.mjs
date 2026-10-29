/**
 * The week-end burn's observer: when it posts a package, how many, and with
 * what lift — and when it stays quiet.
 *
 *     node --test packages/host/test/weekburn.test.mjs
 *
 * The rules (start time, stop line, nudge, wording) are pinned in shared's
 * `weekburn.test.mjs`; this is the plumbing: posts only for a pick bound to
 * THIS week, once the plan's start has passed and while the stop rule allows;
 * one live row per repo; the weekly cap; nothing without a fresh reading; the
 * weekly budget pass and origin stamped on every row; the nudge once a week.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWeekBurn, healthSummaryText } from "../dist/weekburn.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T = Date.UTC(2026, 9, 24, 12, 0, 0);
const R = T + 10 * HOUR; // the weekly reset: inside the fallback day-before start, so "started"
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "weekburn-")); dirs.push(d); return d; };

const reading = (over = {}) => ({ ok: true, sessionPct: 10, weeklyPct: 50, sessionResetAt: T + 2 * HOUR, weeklyResetAt: R, checkedAt: T - MIN, ...over });

function rig(over = {}) {
  const rows = [];
  const added = [];
  const notes = [];
  const state = { usage: reading(), subscription: true, notifyOn: false };
  const stateDir = over.stateDir ?? tmp();
  const make = () => createWeekBurn({
    stateDir,
    usage: () => state.usage,
    usageLog: { read: () => ({ samples: [], keptFrom: null, cap: 0, retainMs: 0, everyMs: 0 }) },
    subscription: () => state.subscription,
    rows: () => rows,
    repos: async () => [{ worktreePath: "/r/a", repoName: "alpha" }, { worktreePath: "/r/b", repoName: "beta" }],
    add: (text, repoDir, label, opts) => {
      const id = `i${added.length + 1}`;
      added.push({ id, text, repoDir, label, opts });
      rows.push({ id, cwd: repoDir, origin: opts.origin, state: "queued" });
      return { id, status: "queued" };
    },
    health: over.health,
    notify: (kind, p) => notes.push({ kind, ...p }),
    notifyOn: () => state.notifyOn,
    now: () => T,
    maxPerRepo: over.maxPerRepo ?? 6,
  });
  return { wb: make(), make, rows, added, notes, state, stateDir };
}

test("nothing is posted without a pick for this week", async () => {
  const { wb, added } = rig();
  assert.deepEqual(await wb.observe(reading()), []);
  assert.equal(added.length, 0);
});

test("a pick at or after the start posts one package per picked repo, stamped", async () => {
  const { wb, added, stateDir } = rig();
  const r = await wb.update({ repos: ["/r/a", "/r/nowhere"] });
  assert.ok(!("error" in r));
  assert.deepEqual(r.status.prefs.repos, ["/r/a"], "an unknown folder is dropped, never spawned");
  assert.equal(r.status.prefs.weekOf, R);
  assert.deepEqual(r.status.prefs.lastRepos, ["/r/a"]);
  assert.equal(r.status.pickedThisWeek, true);
  assert.equal(added.length, 1);
  const a = added[0];
  assert.equal(a.repoDir, "/r/a");
  assert.equal(a.label, "week-end burn");
  assert.equal(a.opts.origin, `weekburn:${R}`);
  assert.equal(a.opts.closeWhenDone, true);
  assert.deepEqual(a.opts.budgetPass, { window: "weekly", from: T, until: R });
  assert.match(a.text, /week-end burn package for alpha/);
  assert.deepEqual(r.status.running, [{ repoDir: "/r/a", posted: 1, live: "i1" }]);
  const disk = JSON.parse(readFileSync(join(stateDir, "weekburn.json"), "utf8"));
  assert.deepEqual(disk.posted["/r/a"], { weekOf: R, count: 1 }, "the count is on disk");
});

test("one live row per repo: the next is posted only after the last settles", async () => {
  const { wb, added, rows } = rig();
  await wb.update({ repos: ["/r/a", "/r/b"] });
  assert.equal(added.length, 2);
  assert.deepEqual(await wb.observe(reading()), [], "both still live");
  rows[0].state = "running";
  assert.deepEqual(await wb.observe(reading()), []);
  rows[0].state = "done";
  assert.deepEqual(await wb.observe(reading()), ["i3"]);
  assert.equal(added[2].repoDir, "/r/a");
  assert.equal(wb.status().running.find((x) => x.repoDir === "/r/a").posted, 2);
});

test("the weekly cap per repo holds", async () => {
  const { wb, added, rows } = rig({ maxPerRepo: 2 });
  await wb.update({ repos: ["/r/a"] });
  rows[0].state = "done";
  await wb.observe(reading());
  rows[1].state = "failed";
  assert.deepEqual(await wb.observe(reading()), []);
  assert.equal(added.length, 2);
  assert.match(wb.status().running[0].stoppedText, /2 packages/);
});

test("before the plan's start nothing posts", async () => {
  const { wb, added, state } = rig();
  state.usage = reading({ weeklyResetAt: T + 3 * 24 * HOUR });
  await wb.update({ repos: ["/r/a"] });
  assert.equal(added.length, 0);
  assert.ok(wb.status().plan.startAt > T);
});

test("stop line, near reset, stale or missing reading, no subscription: nothing posts", async () => {
  const cases = {
    "at the stop line": reading({ weeklyPct: 96 }),
    "stale reading": reading({ checkedAt: T - 30 * MIN }),
    "no weekly percent": reading({ weeklyPct: null }),
    "never read": reading({ checkedAt: 0, ok: false, weeklyPct: null }),
    "within 20 min of the reset": reading({ weeklyResetAt: T + 10 * MIN }),
  };
  for (const [why, u] of Object.entries(cases)) {
    const x = rig();
    x.state.usage = u; // the pick binds to the reading's week, and the update observes this reading
    const r = await x.wb.update({ repos: ["/r/a"] });
    assert.equal(r.status.pickedThisWeek, true, why);
    assert.equal(x.added.length, 0, why);
    assert.deepEqual(await x.wb.observe(u), [], why);
    if (u.weeklyPct != null) assert.ok(r.status.stoppedText, why);
  }
  const n = rig();
  n.state.subscription = false;
  await n.wb.update({ repos: ["/r/a"] });
  assert.equal(n.added.length, 0, "not a subscription");
  assert.equal(n.wb.status().available, false);
  assert.match(n.wb.status().unavailableText, /subscription/);
});

test("a pick made for last week does not run this week", async () => {
  const { wb, added, state, make } = rig();
  state.usage = reading({ weeklyResetAt: R - 7 * 24 * HOUR + 3 * HOUR });
  await wb.update({ repos: ["/r/a"] }).catch(() => {});
  added.length = 0;
  state.usage = reading();
  const again = make();
  assert.deepEqual(await again.observe(reading()), []);
  assert.equal(again.status().pickedThisWeek, false);
});

test("an empty list cancels this week; same-as-last restores the pick", async () => {
  const { wb, added, rows } = rig();
  await wb.update({ repos: ["/r/b"] });
  rows[0].state = "done";
  const c = await wb.update({ repos: [] });
  assert.equal(c.status.pickedThisWeek, false);
  assert.deepEqual(c.status.prefs.lastRepos, ["/r/b"]);
  assert.equal(added.length, 1, "a cancel posts nothing");
  const s = await wb.update({ sameAsLast: true });
  assert.deepEqual(s.status.prefs.repos, ["/r/b"]);
  assert.equal(added.length, 2);
});

test("a pick with no weekly reset is refused in words, nothing changes", async () => {
  const { wb, state, added } = rig();
  state.usage = reading({ ok: false, weeklyPct: null, weeklyResetAt: null });
  const r = await wb.update({ repos: ["/r/a"] });
  assert.match(r.error, /weekly reset/);
  assert.deepEqual(wb.status().prefs.repos, []);
  assert.equal(added.length, 0);
});

test("the nudge goes once per week, remembered on disk, and starts nothing", async () => {
  const { wb, notes, state, added, make } = rig();
  state.notifyOn = true;
  await wb.update({ recurring: true });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "weekburn");
  assert.equal(notes[0].title, "Pick this week's repos");
  assert.equal(added.length, 0);
  await wb.observe(reading());
  assert.equal(notes.length, 1, "once per week");
  await make().observe(reading());
  assert.equal(notes.length, 1, "nudgedWeekOf survives a restart");
});

test("armed: recurring, a pick for this week, or a nudge still possible", async () => {
  const { wb, state } = rig();
  assert.equal(wb.armed(), false, "kind off, nothing picked");
  state.notifyOn = true;
  assert.equal(wb.armed(), true, "this week's nudge is still possible");
  state.notifyOn = false;
  await wb.update({ repos: ["/r/a"] });
  assert.equal(wb.armed(), true);
  state.subscription = false;
  assert.equal(wb.armed(), false);
});

test("the health summary rides into the prompt when the host has one", async () => {
  const { wb, added } = rig({ health: () => ({ value: 71.4, deltaWeek: -2, week: "2026-10-19", move: "drop", alertText: "Tests dropped." }) });
  await wb.update({ repos: ["/r/a"] });
  assert.match(added[0].text, /Health index 71\/100 \(week of 2026-10-19, -2 on the week\)/);
  assert.match(added[0].text, /Tests dropped\./);
  assert.equal(healthSummaryText(undefined), null);
});

test("the person's task and a repo's note ride into the prompt; the status carries each repo's reading for the preview", async () => {
  const { wb, added } = rig({ health: (dir) => (dir === "/r/b" ? { value: 50, week: "2026-10-19" } : undefined) });
  const r = await wb.update({ repos: ["/r/a"], task: "  Raise parser coverage ", notes: { "/r/a": "no new deps", "/r/b": "" } });
  assert.equal(r.status.prefs.task, "Raise parser coverage");
  assert.deepEqual(r.status.prefs.notes, { "/r/a": "no new deps" });
  assert.deepEqual(r.status.readings, { "/r/b": "Health index 50/100 (week of 2026-10-19)." });
  assert.equal(r.status.maxPerRepo, 6);
  assert.match(added[0].text, /Raise parser coverage/);
  assert.match(added[0].text, /For this repo:\nno new deps/);
  assert.match(added[0].text, /never push/);
  assert.match((await wb.full()).readings["/r/b"], /50\/100/);
});
