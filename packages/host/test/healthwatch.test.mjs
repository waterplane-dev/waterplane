/**
 * The health index's plumbing: when a refresh is due, one push per (week, kind)
 * across a restart, the kill switch, and a missing series staying absent.
 *
 *     node --test packages/host/test/healthwatch.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthWatch, HEALTH_REFRESH_MS } from "../dist/healthwatch.js";
import { ensureStateDirIgnored } from "../dist/stateignore.js";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "healthwatch-")); dirs.push(d); return d; };

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5); // a Monday
const row = (w, f) => ({
  day: new Date(T0 + w * 7 * DAY).toISOString().slice(0, 10), ts: T0 + w * 7 * DAY, prereg: "p1",
  size: { value: { p95: 100 * f, lineMean: 400 * f, max: 900 * f, maxPath: "src/big.ts" } }, retouch: { value: { rate: 0.5 * f } },
  hatches: { value: { a: 10 * f } }, context: { value: { claudeMdChars: 10_000 * f, descChars: 0 } },
  untested: { value: Array(Math.round(10 * f)).fill("x") }, classics: { value: { loc: 1000, files: 40 } },
});
/** 10 flat-ish weeks (tiny wobble), then a big worsening week. */
const slipping = () => [...Array.from({ length: 10 }, (_, i) => row(i, 1 + (i % 2) * 0.01)), row(10, 1.6)];
const asText = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function make(over = {}) {
  const root = tmp();
  const log = { refresh: [], notify: [] };
  let now = T0 + 100 * DAY;
  const text = { v: asText(slipping()), ...over.text };
  const deps = {
    root, statePath: join(root, "healthindex.json"),
    repos: async () => [{ id: "r1", repoName: "demo", worktreePath: "/nonexistent/demo" }],
    refresh: async (wt, measureOnly) => { log.refresh.push(wt); (log.only ??= []).push(measureOnly); over.onRefresh?.(text); return over.refreshOk ?? true; },
    warnChars: () => 16_000,
    notify: (k, p) => log.notify.push([k, p]),
    now: () => now,
    readSeries: () => text.v,
    ...over.deps,
  };
  return { deps, log, text, mk: () => new HealthWatch(deps), setNow: (t) => { now = t; } };
}

test("a series with no scored week or no file is absent, with a reason", () => {
  const m = make({ text: { v: null } });
  const w = m.mk();
  const r = w.recompute("/nonexistent/demo");
  assert.equal(r.series, null);
  assert.match(r.reason, /no repo-health series/);
  assert.equal(w.summaryFor("/nonexistent/demo"), undefined);
  m.text.v = asText([row(0, 1)].map((x) => ({ ...x, size: null })));
  assert.match(w.respond("/nonexistent/demo").reason, /no scored week/);
});

test("boot computes the chip from the series without running the engine", async () => {
  const m = make();
  const w = m.mk();
  await w.start();
  w.stop();
  const s = w.summaryFor("/nonexistent/demo");
  assert.ok(s && s.value < 100, "slipped below 100");
  assert.equal(s.move, "drop");
});

test("due: absent or older than 7 days; not within the week; not retried at once after a failure", async () => {
  const m = make({ refreshOk: false });
  const w = m.mk();
  assert.equal(w.due("/nonexistent/demo"), true);
  await w.sweep();
  assert.equal(m.log.refresh.length, 1);
  assert.equal(w.due("/nonexistent/demo"), false, "a failed attempt waits before the next");
  m.setNow(Date.now() + 365 * DAY); // far later: due again
  assert.equal(w.due("/nonexistent/demo"), true);
  const ok = make();
  const w2 = ok.mk();
  await w2.sweep();
  assert.equal(w2.due("/nonexistent/demo"), false, "refreshed just now");
  ok.setNow(T0 + 100 * DAY + HEALTH_REFRESH_MS + 1);
  assert.equal(w2.due("/nonexistent/demo"), true);
});

test("R-metrics-093: a repo with no series file is measured by the sweep: update alone, no push", async () => {
  const m = make({ text: { v: null }, onRefresh: (t) => { t.v = asText(slipping()); } });
  const w = m.mk();
  await w.sweep();
  assert.deepEqual(m.log.only, [true], "update alone: nothing lands in the outbox unasked");
  assert.ok(w.summaryFor("/nonexistent/demo"), "the chip has its value");
  // The same series DOES push for a repo that was already measured (the test below).
  assert.equal(m.log.notify.length, 0, "a first reading is no news");
  await w.sweep();
  assert.equal(m.log.refresh.length, 1, "not due again this week");
  assert.equal(m.log.notify.length, 0, "and it is not news an hour later either");
  // The weekly run stays `update` alone, across a restart too.
  m.setNow(T0 + 100 * DAY + HEALTH_REFRESH_MS + 1);
  const w2 = m.mk();
  await w2.sweep();
  assert.deepEqual(m.log.only, [true, true]);
  // …until a person taps refresh.
  w2.refreshed("/nonexistent/demo");
  m.setNow(T0 + 100 * DAY + 3 * HEALTH_REFRESH_MS);
  await w2.sweep();
  assert.deepEqual(m.log.only, [true, true, false]);
});

test("R-metrics-093: no first measurement where it is declined or switched off; a failed one waits", async () => {
  const no = make({ text: { v: null }, deps: { mayStart: () => false } });
  await no.mk().sweep();
  assert.equal(no.log.refresh.length, 0, "declined");
  const off = make({ text: { v: null }, deps: { enabled: () => false } });
  await off.mk().sweep();
  assert.equal(off.log.refresh.length, 0, "switched off");
  const bad = make({ text: { v: null }, refreshOk: false });
  const w = bad.mk();
  await w.sweep();
  await w.sweep();
  assert.equal(bad.log.refresh.length, 1);
  assert.equal(w.summaryFor("/nonexistent/demo"), undefined, "absent, never 0");
});

test("R-metrics-093: the state dir is ignored locally, never through .gitignore", async () => {
  const wt = tmp();
  const git = (...a) => execFileSync("git", a, { cwd: wt, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))) }).toString();
  git("init", "-q");
  assert.equal(await ensureStateDirIgnored(wt), true);
  mkdirSync(join(wt, ".waterplane"));
  writeFileSync(join(wt, ".waterplane", "repohealth.jsonl"), "x\n");
  assert.equal(git("status", "--short"), "");
  const once = readFileSync(join(wt, ".git/info/exclude"), "utf8");
  assert.equal(await ensureStateDirIgnored(wt), true);
  assert.equal(readFileSync(join(wt, ".git/info/exclude"), "utf8"), once, "written once");
  assert.equal(await ensureStateDirIgnored(tmp()), false, "not a git repo");
});

test("one push per (week, kind), and not again after a restart", async () => {
  const m = make();
  const w = m.mk();
  await w.sweep();
  await w.sweep();
  // The fixture's week is also a new severe alert: one combined push, never two.
  const moves = () => m.log.notify;
  assert.equal(moves().length, 1);
  const [kind, p] = moves()[0];
  assert.equal(kind, "health");
  assert.equal(p.tag, "health:r1");
  assert.match(p.title, /demo/);
  assert.ok(p.body.length > 0);
  const again = m.mk(); // the restart: state is read back from the file
  await again.sweep();
  assert.equal(moves().length, 1);
  // next week's drop is a new (week, kind)
  m.text.v = asText([...slipping(), row(11, 2.6)]);
  await again.sweep();
  assert.equal(moves().length, 2);
  assert.ok(JSON.parse(readFileSync(m.deps.statePath, "utf8")).repos);
});

test("WATERPLANE_HEALTH_WEEKLY=0: no refresh, no push, but the chip still reads", async () => {
  const m = make({ deps: { enabled: () => false } });
  const w = m.mk();
  await w.start();
  await w.sweep();
  w.stop();
  assert.equal(m.log.refresh.length, 0);
  assert.equal(m.log.notify.length, 0);
  assert.ok(w.summaryFor("/nonexistent/demo"));
});

test("a throwing reader degrades to absent and does not crash or push", async () => {
  const m = make({ deps: { readSeries: () => { throw new Error("boom"); } } });
  const w = m.mk();
  await w.sweep();
  assert.equal(w.respond("/nonexistent/demo").series, null);
  assert.equal(m.log.notify.length, 0);
});

test("a successful manual refresh stamps lastRefresh and recomputes", () => {
  const m = make();
  const w = m.mk();
  assert.equal(w.respond("/nonexistent/demo").lastRefresh, null);
  const r = w.refreshed("/nonexistent/demo");
  assert.ok(r.lastRefresh);
  assert.ok(w.summaryFor("/nonexistent/demo"));
});

test("the chip follows the series file when it is rewritten from outside (stamp moved), without the engine", async () => {
  const stamp = { v: "1:100" };
  const m = make({ deps: { seriesStamp: () => stamp.v } });
  const w = m.mk();
  await w.start();
  w.stop();
  const before = w.summaryFor("/nonexistent/demo");
  assert.ok(before && before.value < 100);
  // A CLI re-cut rewrites the file: a better last week. Same stamp ⇒ the cache stands.
  m.text.v = asText([...slipping().slice(0, 10), row(10, 0.6)]);
  assert.equal(w.summaryFor("/nonexistent/demo").value, before.value, "an unchanged stamp is served from the cache");
  stamp.v = "2:180";
  const after = w.summaryFor("/nonexistent/demo");
  assert.ok(after.value > before.value, `re-derived from the rewritten file: ${after.value}`);
  assert.equal(after.value, repoValue(w.respond("/nonexistent/demo")), "chip and index view agree");
  assert.equal(m.log.refresh.length, 1, "only the boot sweep ran the engine");
  // The file going away takes the chip with it.
  m.text.v = null; stamp.v = null;
  assert.equal(w.summaryFor("/nonexistent/demo"), undefined);
});

// Healthy rows (every entry near its good line) with the longest file set per week: lines 1000 = fine,
// 3000 = warn (score 33), 6000 = severe (score 17).
const healthy = (w, maxLines) => ({
  ...row(w, 1), size: { value: { p95: 100, lineMean: 300, max: maxLines, maxPath: "src/big.ts" } },
  retouch: { value: { rate: 0.1 } }, hatches: { value: { a: 1 } }, untested: { value: Array(5).fill("x") },
});
const sev = (w, f) => healthy(w, f);
const severeKind = (m) => m.log.notify.filter(([, p]) => /severe health warning/.test(p.title));

test("a NEW severe alert pushes once; the same week again, and a restart, do not", async () => {
  const flat = Array.from({ length: 10 }, (_, i) => healthy(i, 1000));
  const m = make({ text: { v: asText([...flat, sev(10, 6000)]) } });
  const w = m.mk();
  await w.sweep();
  const s1 = severeKind(m);
  assert.equal(s1.length, 1);
  assert.equal(s1[0][1].tag, "health:r1");
  assert.equal(s1[0][1].title, "demo: severe health warning");
  assert.match(s1[0][1].body, /severe/);
  await w.sweep();
  await m.mk().sweep();
  assert.equal(severeKind(m).length, 1);
});

test("severe all along: no push", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => healthy(i, 6000));
  const m = make({ text: { v: asText(rows) } });
  await m.mk().sweep();
  assert.equal(severeKind(m).length, 0);
});

test("warn to severe pushes", async () => {
  const pre = Array.from({ length: 10 }, (_, i) => healthy(i, 3000));
  const probe = make({ text: { v: asText([...pre, healthy(10, 3000)]) } }).mk().respond("/nonexistent/demo");
  assert.ok(probe.series.points.at(-1).alerts.some((a) => a.level === "warn"), "setup is warn-level");
  const m = make({ text: { v: asText([...pre, healthy(10, 6000)]) } });
  await m.mk().sweep();
  assert.equal(severeKind(m).length, 1);
});

test("the first scored week stays silent", async () => {
  const m = make({ text: { v: asText([healthy(0, 6000)]) } });
  await m.mk().sweep();
  assert.equal(severeKind(m).length, 0);
});

function repoValue(r) { return r.series.points[r.series.points.length - 1].index; }

test("a series measured before lineMean says to re-measure, naming the command", () => {
  const old = Array.from({ length: 3 }, (_, i) => {
    const r = row(i, 1);
    delete r.size.value.lineMean;
    return r;
  });
  const w = make({ text: { v: asText(old) } }).mk();
  const r = w.respond("/nonexistent/demo");
  assert.equal(r.series, null);
  assert.match(r.reason, /older engine/);
  assert.match(r.reason, /rm <repo>\/\.waterplane\/repohealth\.jsonl && node tools\/repohealth\.mjs update --root=<repo>/);
  // a series that simply lacks another reading keeps the generic reason
  const other = make({ text: { v: asText([row(0, 1)].map((x) => ({ ...x, retouch: { value: null, reason: "x" } }))) } }).mk();
  assert.match(other.respond("/nonexistent/demo").reason, /no week has every enabled reading/);
});

test("a move and a severe alert in one sweep are ONE push: severe title, severe texts then the move body", async () => {
  const flat = Array.from({ length: 10 }, (_, i) => healthy(i, 1000));
  const m = make({ text: { v: asText([...flat, sev(10, 6000)]) } });
  const probe = m.mk().respond("/nonexistent/demo");
  assert.ok(probe.move?.kind, "setup: the week is also a called move");
  await m.mk().sweep();
  assert.equal(m.log.notify.length, 1);
  const [, p] = m.log.notify[0];
  assert.equal(p.title, "demo: severe health warning");
  assert.equal(p.tag, "health:r1");
  const lines = p.body.split("\n");
  assert.match(lines[0], /severe/);
  assert.ok(p.body.endsWith(probe.words.body), p.body);
});

test("no severe push on a gap week (a definition change), however bad the new reading", async () => {
  const flat = Array.from({ length: 10 }, (_, i) => healthy(i, 1000));
  const gapRow = { ...sev(10, 6000), prereg: "p2" };
  const m = make({ text: { v: asText([...flat, gapRow]) } });
  const r = m.mk().respond("/nonexistent/demo");
  assert.equal(r.series.points.at(-1).gap, true, "setup: last week is a gap");
  await m.mk().sweep();
  assert.equal(severeKind(m).length, 0);
});

test("respond carries commits beside the series, and null without one — never omitted", () => {
  const m = make();
  const r = m.mk().respond("/nonexistent/demo");
  assert.ok(r.commits && r.commits.total === 11 && r.commits.points.length === 11);
  // An omitted key means an OLDER host (`healthCommitsAvailability` → "absent"), and the x-axis
  // row then tells the person to restart the desktop: never true of a repo with no series yet.
  const none = make({ text: { v: null } }).mk().respond("/nonexistent/demo");
  assert.equal(none.commits, null);
});
