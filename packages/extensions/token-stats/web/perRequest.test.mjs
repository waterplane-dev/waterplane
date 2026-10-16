import test from "node:test";
import assert from "node:assert/strict";

import { clipRuns, hasRepoDays, reqDays, repoPerRequest, rollingPerRequest, unpricedIn } from "./perRequest.ts";

const NOW = new Date(2026, 8, 28, 12).getTime();
const key = (back) => {
  const d = new Date(NOW); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - back);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
/** A day `back` days ago with repo slices `[repo, turns, usd, priced?]`. */
const day = (back, ...slices) => ({
  day: key(back),
  byRepo: slices.map(([repo, turns, usd, priced = turns]) => ({ repo, turns, pricedTurns: priced, usd })),
});

test("absent without byRepo: an older host is not a desktop that spent nothing", () => {
  assert.equal(hasRepoDays([{ day: key(0) }]), false);
  assert.equal(hasRepoDays([day(0, ["/a", 1, 1])]), true);
  assert.deepEqual(reqDays([{ day: key(0) }]), []);
});

test("a ratio of sums over the window, never a mean of daily ratios", () => {
  // 3 requests at $2 and 300 at $0.05: the mean of ratios is ~$1.03, the
  // price a request actually had is (6 + 15) / 303.
  const days = [day(6, ["/a", 3, 6]), ...[5, 4, 3, 2, 1].map((b) => day(b)), day(0, ["/a", 300, 15])];
  const runs = rollingPerRequest(reqDays(days));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 1, "only the day with a full week behind it");
  assert.ok(Math.abs(runs[0][0].v - 21 / 303) < 1e-9);
});

test("the line is CUT where the window holds too few requests, not joined across", () => {
  const days = [];
  for (let b = 30; b >= 20; b--) days.push(day(b, ["/a", 10, 1]));
  // A fortnight with nothing, then work again.
  for (let b = 5; b >= 0; b--) days.push(day(b, ["/a", 10, 1]));
  const runs = rollingPerRequest(reqDays(days));
  assert.equal(runs.length, 2);
  for (const r of runs) for (const p of r) assert.ok(p.priced >= 20);
});

test("unpriced requests stay out of the denominator and are counted", () => {
  const days = [];
  for (let b = 6; b >= 0; b--) days.push(day(b, ["/a", 10, 1, 5]));
  const rows = reqDays(days);
  const runs = rollingPerRequest(rows);
  assert.ok(Math.abs(runs[0][0].v - 7 / 35) < 1e-9);
  assert.equal(unpricedIn(rows, key(6), key(0)), 35);
});

test("clipRuns keeps only what falls inside the window", () => {
  const runs = [[{ t: 1, v: 1 }, { t: 5, v: 1 }], [{ t: 9, v: 1 }]];
  assert.deepEqual(clipRuns(runs, 4, 6), [[{ t: 5, v: 1 }]]);
});

test("per repo: this week against last, a change only where both are a price", () => {
  const days = [];
  for (let b = 13; b >= 7; b--) days.push(day(b, ["/r/a", 10, 2], ["/r/b", 1, 5]));
  for (let b = 6; b >= 0; b--) days.push(day(b, ["/r/a", 10, 1], ["/r/c", 10, 3]));
  const { rows, hidden } = repoPerRequest(days, [{ key: "/r/a", label: "a" }], NOW);
  assert.equal(hidden, 1, "b never had enough requests to have a price");
  const a = rows.find((r) => r.key === "/r/a");
  assert.equal(a.label, "a");
  assert.ok(Math.abs(a.cur - 0.1) < 1e-9);
  assert.ok(Math.abs(a.prev - 0.2) < 1e-9);
  assert.equal(a.change, -50);
  const c = rows.find((r) => r.key === "/r/c");
  assert.equal(c.label, "c", "falls back to the path's base name");
  assert.equal(c.prev, null);
  assert.equal(c.change, null);
  assert.equal(rows[0].key, "/r/c", "ordered by what the repo cost this week");
});

test("per repo under a span: the span against as many days before it", () => {
  // Days 0-2 at $0.10 a request, days 3-5 at $0.30, day 6 at $1 (outside both 3-day runs).
  const days = [day(6, ["/r/a", 10, 10])];
  for (let b = 5; b >= 3; b--) days.push(day(b, ["/r/a", 10, 3]));
  for (let b = 2; b >= 0; b--) days.push(day(b, ["/r/a", 10, 1]));
  const { rows } = repoPerRequest(days, [], NOW, 20, { from: key(2), to: key(0) });
  const a = rows[0];
  assert.ok(Math.abs(a.cur - 0.1) < 1e-9);
  assert.ok(Math.abs(a.prev - 0.3) < 1e-9, "the three days before, not seven");
  assert.equal(a.change, -67);
});
