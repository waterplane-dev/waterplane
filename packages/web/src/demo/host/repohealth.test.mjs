// The demo's repo-health series: it must satisfy the real reader and agree with itself everywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { parseRepoHealthPlot } from "@waterplane/shared";
import { demoRepoHealth, hasDemoRepoHealth } from "./repohealth.ts";
import { demoHttp } from "./demohttp.ts";

const NOW = new Date(2026, 9, 2, 15, 20).getTime();
const NAMES = ["todo-garden", "pocket-notes", "trail-log", "photo-shelf"];
const vals = (pts) => pts.map((p) => p.v);

test("shape: the real host's plot reader accepts every demo repo's plot, whole", () => {
  for (const name of NAMES) {
    const view = demoRepoHealth(name, NOW);
    assert.ok(view, name);
    const back = parseRepoHealthPlot(JSON.stringify(view.plot));
    assert.ok(back, `${name}: reader refused the plot`);
    assert.equal(back.series.length, 7);
    for (const s of back.series) assert.equal(s.points.length, back.days, `${name} ${s.key}`);
    assert.equal(view.series.days, view.plot.days);
    assert.equal(view.behind, 0);
    assert.equal(view.series.lastSha, view.plot.series[0].points.at(-1).sha7);
  }
  assert.equal(demoRepoHealth("nope", NOW), null);
  assert.ok(hasDemoRepoHealth("trail-log") && !hasDemoRepoHealth("nope"));
});

test("deterministic: same day, same document; another day, a different one", () => {
  for (const name of NAMES) {
    const a = JSON.stringify({ ...demoRepoHealth(name, NOW), readAt: 0 });
    const b = JSON.stringify({ ...demoRepoHealth(name, NOW + 7 * 60_000), readAt: 0 });
    assert.equal(a, b);
    assert.notEqual(a, JSON.stringify({ ...demoRepoHealth(name, NOW + 5 * 86_400_000), readAt: 0 }));
  }
});

test("relative to now: the last reading is today and the series spans about four weeks", () => {
  const v = demoRepoHealth("todo-garden", NOW);
  const days = v.plot.series[0].points.map((p) => p.day);
  assert.equal(days.at(-1), "2026-10-02");
  assert.ok(days[0] >= "2026-09-04" && days[0] <= "2026-09-06", days[0]);
  assert.ok(days.length >= 20, "enough readings for a rank");
});

test("consistent: lines are the sum of the groups and of the types; p95, longest and the tape share one list", () => {
  for (const name of NAMES) {
    const { plot } = demoRepoHealth(name, NOW);
    const c = plot.classics;
    const loc = vals(c.loc);
    loc.forEach((l, i) => {
      assert.equal(c.packages.reduce((s, x) => s + x.points[i].v, 0), l, `${name} groups @${i}`);
      assert.equal(c.types.reduce((s, x) => s + x.points[i].v, 0), l, `${name} types @${i}`);
    });
    assert.equal(c.types.reduce((s, x) => s + x.files, 0), c.files.at(-1).v, `${name} type files`);
    // tape: descending, named, and its head is the longest file; p95 is one of its entries
    assert.deepEqual([...c.tape].sort((a, b) => b - a), c.tape);
    assert.equal(c.tapePaths.length, c.tape.length);
    assert.equal(plot.longest.points.at(-1).v, c.tape[0]);
    assert.equal(plot.longest.path, c.tapePaths[0]);
    const p95 = plot.series.find((s) => s.key === "size.p95");
    assert.ok(c.tape.includes(p95.last), `${name} p95 ${p95.last} not on the tape`);
    assert.ok(p95.last <= c.tape[0]);
    plot.longest.points.forEach((pt, i) => assert.ok(pt.v >= p95.points[i].v, `${name} longest < p95 @${i}`));
  }
});

test("consistent: each rate's detail names the same integers the value was made from", () => {
  for (const name of NAMES) {
    const { plot } = demoRepoHealth(name, NOW);
    const s = Object.fromEntries(plot.series.map((x) => [x.key, x]));
    const nums = (t) => (t.match(/[\d,]+/g) ?? []).map((x) => Number(x.replace(/,/g, "")));
    const [re, touches] = nums(s["retouch.rate"].detail);
    assert.equal(s["retouch.rate"].last, Math.round((re / touches) * 100) / 100, `${name} retouch`);
    const [h, lines] = nums(s["hatches.perKloc"].detail);
    assert.equal(lines, plot.classics.loc.at(-1).v);
    assert.equal(s["hatches.perKloc"].last, Math.round((h / (lines / 1000)) * 10) / 10, `${name} hatches`);
    const [u, files] = nums(s["untested.count"].detail);
    assert.equal(u, s["untested.count"].last);
    assert.equal(files, plot.classics.files.at(-1).v);
    assert.ok(u <= files);
  }
});

test("honest: no non-finite or negative value, ranks are fractions, the skill count is unranked", () => {
  for (const name of NAMES) {
    const { plot } = demoRepoHealth(name, NOW);
    for (const s of plot.series) {
      for (const p of s.points) assert.ok(p.v === null || (Number.isFinite(p.v) && p.v >= 0), `${name} ${s.key}`);
      const r = s.reading;
      if (r.rank === null) assert.ok(r.reason, `${name} ${s.key} null rank with no reason`);
      else assert.ok(r.rank >= 0 && r.rank <= 1 && ["rising", "falling", "flat"].includes(r.slope));
    }
    assert.equal(plot.series.find((s) => s.key === "context.skillCount").reading.rank, null);
    // growth, not decline: the tree is bigger today than four weeks ago
    assert.ok(plot.classics.loc.at(-1).v > plot.classics.loc[0].v);
  }
});

test("opt-in: /repohealth answers only where numbers.repoHealth is set, and only for a known repo", () => {
  const m = (on) => ({ repos: [{ id: "r1", repoName: "todo-garden" }, { id: "r9", repoName: "stranger" }], numbers: on ? { repoHealth: true } : {} });
  const get = (model, id) => demoHttp(model, NOW, { method: "GET", path: `/api/repos/${id}/repohealth`, query: {} });
  assert.equal(get(m(false), "r1").status, 404);
  assert.equal(get(m(true), "r1").status, 200);
  assert.equal(JSON.parse(get(m(true), "r1").body).plot.series.length, 7);
  assert.equal(get(m(true), "r9").status, 404);
  assert.equal(get(m(true), "zz").status, 404);
});
