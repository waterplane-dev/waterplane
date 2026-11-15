/**
 * The Agent readings headline (R-metrics-070): `setupCostOf` (start × requests at the cache-read
 * list rate, the median of the per-session product, split by whose each part is) and
 * `setupPatternOf` / `setupPatternText` (one neutral sentence around the newest change).
 *
 *     node --test packages/shared/test/agentsetup.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupCostOf, setupPatternOf, setupPatternText, patternName, PATTERN_MIN_MOVE, cacheReadRate, addLocalDays, hourKeyMs, SETUP_COST_MIN_N } from "../dist/index.js";

const NOW = new Date(2026, 10, 14, 12, 0).getTime();
let ids = 0;
const pt = (t0, o = {}) => ({ id: `s${ids++}`, t0, repo: "r", fresh: true, headless: false, model: "claude-sonnet-4-5", req: 10, commit: true, start: 20000, look: 10, skills: 1, ...o });

test("setup cost: median of start × requests per session, at the cache-read list rate, with its split", () => {
  const ps = [];
  for (let i = 0; i < 11; i++) ps.push(pt(NOW - (i + 1) * 3_600_000, { req: 10 + i, parts: { projectMd: 1000, userMd: 3000, system: 6000 } }));
  // Out of the reading: headless, a subagent, resumed, outside the window.
  ps.push(pt(NOW - 3_600_000, { headless: true, req: 999 }), pt(NOW - 3_600_000, { sub: true, req: 999 }),
    pt(NOW - 3_600_000, { fresh: false, req: 999 }), pt(addLocalDays(NOW, -20), { req: 999 }));
  const c = setupCostOf(ps, { now: NOW });
  assert.ok(!("absent" in c), c.absent);
  assert.equal(c.n, 11);
  assert.equal(c.requests, 15);
  assert.equal(c.tok, 20000 * 15, "the median session's product");
  assert.ok(Math.abs(cacheReadRate("claude-sonnet-4-5") - 0.3) < 1e-12);
  assert.ok(Math.abs(c.usd - (20000 * 15 * 0.3) / 1e6) < 1e-12);
  assert.deepEqual(c.models, ["claude-sonnet-4-5"]);
  assert.deepEqual(c.split.map((g) => [g.group, Math.round(g.share * 100)]), [["repo", 10], ["yours", 30], ["cli", 60]]);
  assert.equal(c.nSplit, 11);
});

test("setup cost: absent with too few sessions; no dollars where too few are priced; no split where no parts", () => {
  const few = setupCostOf([pt(NOW - 1000)], { now: NOW });
  assert.match(few.absent, new RegExp(`1 fresh interactive sessions .* at least ${SETUP_COST_MIN_N}`));
  const unpriced = Array.from({ length: 12 }, (_, i) => pt(NOW - (i + 1) * 60_000, { model: i < 4 ? "claude-sonnet-4-5" : "llama-local" }));
  const c = setupCostOf(unpriced, { now: NOW });
  assert.equal(c.usd, undefined, "never a dollar figure off four priced sessions");
  assert.equal(c.nPriced, 4);
  assert.equal(c.n, 12, "the unpriced stay in the token median");
  assert.equal(c.split.length, 0);
});

/** 28 days × 6 sessions around `at`; each reading its own noise, × its step from day 14. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const BASE = new Date(2026, 9, 5, 9, 0).getTime();
const AT = hourKeyMs("2026-10-19T00");
function window28(seed, step = {}) {
  const r = rng(seed);
  const out = [];
  const f = (k, d) => (d >= 14 ? step[k] ?? 1 : 1);
  for (let d = 0; d < 28; d++) {
    for (let s = 0; s < 6; s++) {
      const n = () => Math.exp(0.15 * gauss(r));
      out.push(pt(addLocalDays(BASE, d) + s * 3_600_000, {
        start: 20000 * n() * f("start", d), look: 20 * n() * f("look", d), req: 30 * n() * f("req", d), skills: 2 * n() * f("skills", d),
      }));
    }
  }
  return out;
}
const mark = { t: AT, kind: "instructions", label: "CLAUDE.md trimmed" };

test("pattern: start down with looks and requests up is the trim pattern; worded neutrally", () => {
  const p = setupPatternOf(window28(5, { start: 0.6, look: 1.6, req: 1.6 }), [mark]);
  assert.ok(!("absent" in p), p.absent);
  assert.deepEqual(p.moved.map((m) => `${m.reading} ${m.dir}`), ["start down", "look up", "req up"]);
  assert.deepEqual(p.within, ["skills"]);
  const t = setupPatternText(p);
  assert.match(t, /^Around CLAUDE\.md trimmed \(2026-10-19, claude-sonnet-4-5 sessions\): start context down \d+%, looks before the first edit up \d+%, requests up \d+% — the pattern of a trim that removed something agents used\.$/);
  assert.doesNotMatch(t, /better|worse|improv|regress|good|bad/i);
});

test("pattern: one reading out says the rest are within; none out says no detectable change", () => {
  const one = setupPatternOf(window28(5, { start: 0.6 }), [mark]);
  assert.match(setupPatternText(one), /: start context down \d+%, looks before the first edit, requests, skill loads within normal variation\.$/);
  const none = setupPatternOf(window28(5), [mark]);
  assert.equal(none.moved.length, 0);
  assert.match(setupPatternText(none), /no detectable change/);
});

test("pattern: the newest marker without a two-reading compare is skipped; none at all is absent with why", () => {
  const ps = window28(5, { start: 0.6, look: 1.6, req: 1.6 });
  const late = { t: addLocalDays(BASE, 26), kind: "tag", label: "v1" }; // 2 days after: too few
  const p = setupPatternOf(ps, [mark, late]);
  assert.equal(p.marker, mark);
  assert.equal(p.others, 1);
  assert.match(setupPatternText(p), /One other change falls in the same 28 days, and a before\/after cannot tell them apart\.$/);
  assert.match(setupPatternOf(ps, []).absent, /No change is known/);
  assert.match(setupPatternOf(ps, [late]).absent, /None of the 1 newest changes/);
});

test("pattern: a move under the practical floor is within, even when the day band is narrower than it", () => {
  // Start context ±0.5% noise (a very narrow band), 0.5% lower after the marker; requests +50%.
  const r = rng(11);
  const ps = [];
  for (let d = 0; d < 28; d++) for (let s = 0; s < 6; s++) {
    const after = d >= 14;
    ps.push(pt(addLocalDays(BASE, d) + s * 3_600_000, {
      start: 63_300 * (after ? 0.995 : 1) * (1 + 0.005 * gauss(r)), look: 20, req: 40 * (after ? 1.5 : 1) * Math.exp(0.1 * gauss(r)), skills: 2,
    }));
  }
  assert.equal(PATTERN_MIN_MOVE, 0.02);
  const p = setupPatternOf(ps, [{ t: AT, kind: "tag", label: "v1" }]);
  assert.ok(!("absent" in p), p.absent);
  assert.ok(p.within.includes("start"), "0.5% is not a move");
  assert.deepEqual(p.moved.map((m) => `${m.reading} ${m.dir}`), ["req up"]);
  assert.doesNotMatch(setupPatternText(p), /trim|start context down/);
});

test("pattern names: only the shapes it knows, otherwise none", () => {
  const m = (reading, dir) => ({ reading, dir, ratio: dir === "up" ? 1.5 : 0.5 });
  assert.match(patternName([m("start", "up"), m("look", "down")]), /addition agents use in place of looking/);
  assert.match(patternName([m("start", "down"), m("skills", "up")]), /load as skills/);
  assert.match(patternName([m("look", "up"), m("req", "up")]), /the work itself/);
  assert.equal(patternName([m("start", "up"), m("look", "up")]), undefined);
});
