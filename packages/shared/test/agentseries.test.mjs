/**
 * Agent efficiency series (`agentseries/`): day/week buckets with the min-n
 * absence, the before/after band (deterministic, a 40% step outside it, no step
 * inside it, a model change absent), and the derived markers with their collapse.
 *
 *     node --test packages/shared/test/agentseries.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  seriesOf, compareAround, derivedMarkers, collapseMarkers, addLocalDays, hourKeyMs,
  SERIES_MIN_N, isoWeekOf,
} from "../dist/index.js";

const BASE = new Date(2026, 9, 5, 9, 0).getTime(); // Mon 5 Oct 2026, 09:00 local

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

let ids = 0;
const pt = (t0, o = {}) => ({ id: `s${ids++}`, t0, repo: "r", fresh: true, headless: false, model: "m1", req: 20, commit: true, start: 20000, look: 10, ...o });

/** 28 days × 6 sessions; `look` lognormal with day and session noise, × `step` from day 14. */
function window28(seed, step, o = {}) {
  const r = rng(seed);
  const out = [];
  for (let d = 0; d < 28; d++) {
    const dayF = Math.exp(0.1 * gauss(r));
    for (let s = 0; s < 6; s++) {
      const v = 20 * dayF * Math.exp(0.3 * gauss(r)) * (d >= 14 ? step : 1);
      out.push(pt(addLocalDays(BASE, d) + s * 3_600_000, { look: v, req: v, ...(typeof o === "function" ? o(d) : o) }));
    }
  }
  return out;
}

test("seriesOf buckets by local day and ISO week, readings over their own sessions", () => {
  const ps = [];
  for (let i = 0; i < 6; i++) ps.push(pt(BASE + i * 60_000, { start: 1000 * (i + 1), parts: { memory: 500, skills: 100 * i } }));
  ps.push(pt(BASE + 1, { headless: true, start: 999_999 }));           // not in start
  ps.push(pt(BASE + 2, { sub: true, start: 4000 }));                     // subStart only
  ps.push(pt(BASE + 3, { fresh: false, start: 999_999 }));               // resumed: nowhere
  ps.push(pt(addLocalDays(BASE, 1), { start: 7000 }));
  const days = seriesOf(ps, { grain: "day" });
  assert.deepEqual(days.map((b) => b.key), ["2026-10-05", "2026-10-06"]);
  const d0 = days[0];
  assert.equal(d0.fresh, 7);
  assert.deepEqual(d0.start, { median: 3500, n: 6 });
  assert.deepEqual(d0.parts.memory, { median: 500, n: 6 });
  assert.equal(d0.req.n, 7, "headless committing sessions count for req");
  assert.ok("absent" in d0.subStart, "one subagent log is below the minimum");
  assert.match(days[1].start.absent, new RegExp(`1 fresh interactive.*at least ${SERIES_MIN_N}`));
  const weeks = seriesOf(ps, { grain: "week" });
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].key, isoWeekOf("2026-10-06"));
  assert.equal(weeks[0].start.n, 7);
  assert.equal(seriesOf(ps, { grain: "day", model: "other" }).length, 0);
});

test("compareAround: a 40% step is outside the band, no step is inside, and the band is deterministic", () => {
  const at = hourKeyMs("2026-10-19T00");
  const stepped = window28(7, 1.4);
  const a = compareAround(stepped, at, { reading: "look" });
  assert.ok(!("absent" in a), a.absent);
  assert.ok(a.ratio > 1.15 && a.ratio < 1.7, `ratio ${a.ratio}`);
  assert.equal(a.inside, false);
  assert.equal(a.nBefore, 84);
  assert.equal(a.daysBefore, 14);
  assert.equal(a.model, "m1");
  assert.deepEqual(compareAround(stepped, at, { reading: "look" }), a, "same data, same band");

  const flat = compareAround(window28(7, 1), at, { reading: "look" });
  assert.equal(flat.inside, true, JSON.stringify(flat));
  assert.ok(flat.band[0] < 1 && flat.band[1] > 1);
});

test("compareAround is absent when the model changes, and when too few days", () => {
  const at = hourKeyMs("2026-10-19T00");
  const mixed = window28(3, 1, (d) => ({ model: d >= 14 ? "m2" : "m1" }));
  const r = compareAround(mixed, at, { reading: "req" });
  assert.match(r.absent, /More than one model.*m1, m2/);
  const one = compareAround(mixed, at, { reading: "req", model: "m1" });
  assert.match(one.absent, /0 after/);
  const few = compareAround(window28(3, 1).filter((p) => p.t0 < addLocalDays(BASE, 16)), at, { reading: "req" });
  assert.match(few.absent, /14 days with sessions before and 2 after/);
});

test("derivedMarkers: model, CLI, memory and skills steps; same-kind markers collapse", () => {
  const ps = [];
  for (let d = 0; d < 4; d++) {
    for (let s = 0; s < 4; s++) {
      ps.push(pt(addLocalDays(BASE, d) + s * 60_000, {
        model: d >= 2 ? "m2" : "m1",
        cli: d >= 1 ? "2.2.0" : "2.1.0",
        parts: { memory: d === 3 ? 6000 : 4000, skills: 2000 + d * 100 },
      }));
    }
  }
  const m = derivedMarkers(ps);
  assert.deepEqual(m.map((x) => x.kind), ["cli", "model", "memory"]);
  assert.equal(m[0].label, "CLI 2.2.0");
  assert.equal(m[1].label, "model m1 to m2");
  assert.equal(m[1].t, hourKeyMs("2026-10-07T00"));
  assert.match(m[2].label, /^memory \+2,000 chars$/);
  for (const x of m) assert.doesNotMatch(`${x.label} ${x.detail ?? ""}`, /better|worse|improv|regress/i);
  // Pooled over repos, a listing median follows the repo mix: model and CLI marks stay, listing marks go.
  assert.deepEqual(derivedMarkers(ps, { listings: false }).map((x) => x.kind), ["cli", "model"]);

  const day = hourKeyMs("2026-10-07T00");
  const c = collapseMarkers([
    { t: day + 3600_000, kind: "instructions", label: "a" },
    { t: day + 7200_000, kind: "instructions", label: "b" },
    { t: day + 9000_000, kind: "instructions", label: "c" },
    { t: day + 9000_000, kind: "tag", label: "trim" },
    { t: addLocalDays(day, 1), kind: "instructions", label: "d" },
  ]);
  assert.equal(c.length, 3);
  assert.equal(c[0].count, 3);
  assert.equal(c[0].t, day + 3600_000);
  assert.equal(c[0].detail, "a; b; c");
  assert.equal(c[1].kind, "tag");
  assert.equal(c[2].count, undefined);
});
