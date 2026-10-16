/**
 * The health index's plumbing: when a refresh is due, one push per (week, kind)
 * across a restart, the kill switch, and a missing series staying absent.
 *
 *     node --test packages/host/test/healthwatch.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthWatch, HEALTH_REFRESH_MS } from "../dist/healthwatch.js";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "healthwatch-")); dirs.push(d); return d; };

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5); // a Monday
const row = (w, f) => ({
  day: new Date(T0 + w * 7 * DAY).toISOString().slice(0, 10), ts: T0 + w * 7 * DAY, prereg: "p1",
  size: { value: { p95: 100 * f } }, retouch: { value: { rate: 0.5 * f } },
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
    refresh: async (wt) => { log.refresh.push(wt); return over.refreshOk ?? true; },
    warnChars: () => 16_000,
    notify: (k, p) => log.notify.push([k, p]),
    now: () => now,
    readSeries: () => text.v,
    ...over.deps,
  };
  return { deps, log, text, mk: () => new HealthWatch(deps), setNow: (t) => { now = t; } };
}

test("a series with no baseline or no file is absent, with a reason", () => {
  const m = make({ text: { v: null } });
  const w = m.mk();
  const r = w.recompute("/nonexistent/demo");
  assert.equal(r.series, null);
  assert.match(r.reason, /no repo-health series/);
  assert.equal(w.summaryFor("/nonexistent/demo"), undefined);
  m.text.v = asText([row(0, 1)].map((x) => ({ ...x, size: null })));
  assert.match(w.respond("/nonexistent/demo").reason, /baseline/);
});

test("boot computes the chip from the series without running the engine", async () => {
  const m = make();
  const w = m.mk();
  await w.start();
  w.stop();
  const s = w.summaryFor("/nonexistent/demo");
  assert.ok(s && s.value < 100, "slipped below the baseline");
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

test("a repo with no series file is never refreshed", async () => {
  const m = make({ text: { v: null } });
  await m.mk().sweep();
  assert.equal(m.log.refresh.length, 0);
});

test("one push per (week, kind), and not again after a restart", async () => {
  const m = make();
  const w = m.mk();
  await w.sweep();
  await w.sweep();
  assert.equal(m.log.notify.length, 1);
  const [kind, p] = m.log.notify[0];
  assert.equal(kind, "health");
  assert.equal(p.tag, "health:r1");
  assert.match(p.title, /demo/);
  assert.ok(p.body.length > 0);
  const again = m.mk(); // the restart: state is read back from the file
  await again.sweep();
  assert.equal(m.log.notify.length, 1);
  // next week's drop is a new (week, kind)
  m.text.v = asText([...slipping(), row(11, 2.6)]);
  await again.sweep();
  assert.equal(m.log.notify.length, 2);
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
  assert.ok(after.value > 100, `re-derived from the rewritten file: ${after.value}`);
  assert.equal(after.value, repoValue(w.respond("/nonexistent/demo")), "chip and index view agree");
  assert.equal(m.log.refresh.length, 1, "only the boot sweep ran the engine");
  // The file going away takes the chip with it.
  m.text.v = null; stamp.v = null;
  assert.equal(w.summaryFor("/nonexistent/demo"), undefined);
});

function repoValue(r) { return r.series.points[r.series.points.length - 1].index; }
