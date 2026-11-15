/**
 * Compare by model (`agentseries/bymodel.ts`, R-metrics-072): alternating days split by model,
 * the same day-shuffle band as the before/after, the minimums (absent with a sentence, never a
 * number from three sessions), the one-model state, and model + CLI that changed together.
 *
 *     node --test packages/shared/test/agentbymodel.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  compareByModel, compareByModelAll, byModelCliText, BY_MODEL_READINGS, BY_MODEL_ALTERNATE_TEXT,
  addLocalDays, COMPARE_MIN_N,
} from "../dist/index.js";

const BASE = new Date(2026, 9, 5, 9, 0).getTime(); // Mon 5 Oct 2026, 09:00 local
const NOW = addLocalDays(BASE, 14);

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

let ids = 0;
const pt = (t0, o = {}) => ({ id: `s${ids++}`, t0, repo: "r", fresh: true, headless: false, model: "m1", cli: "2.1.1", req: 20, commit: true, start: 20000, look: 10, skills: 0, ...o });

/** 14 days × 5 sessions, models alternating by day; m2's `look`/`req` × `factor`. */
function alternating(seed, factor, o = () => ({})) {
  const r = rng(seed);
  const out = [];
  for (let d = 0; d < 14; d++) {
    const m = d % 2 === 0 ? "m1" : "m2";
    const dayF = Math.exp(0.1 * gauss(r));
    for (let s = 0; s < 5; s++) {
      const v = 20 * dayF * Math.exp(0.3 * gauss(r)) * (m === "m2" ? factor : 1);
      out.push(pt(addLocalDays(BASE, d) + s * 3_600_000, { model: m, look: v, req: v, ...o(m, d, s) }));
    }
  }
  return out;
}

test("alternating days: a ×0.4 model is outside the band, the same model is inside, same data same band", () => {
  const stepped = alternating(5, 0.4);
  const r = compareByModel(stepped, { reading: "look", now: NOW });
  assert.ok(!("absent" in r), r.absent);
  assert.equal(r.a.model, "m1");
  assert.equal(r.b.model, "m2");
  assert.equal(r.a.n, 35);
  assert.equal(r.a.days, 7);
  assert.ok(r.ratio > 0.3 && r.ratio < 0.55, `ratio ${r.ratio}`);
  assert.equal(r.inside, false);
  assert.equal(r.cliTogether, undefined, "both models ran the same CLI");
  assert.deepEqual(compareByModel(stepped, { reading: "look", now: NOW }), r);

  const flat = compareByModel(alternating(5, 1), { reading: "look", now: NOW });
  assert.equal(flat.inside, true, JSON.stringify(flat));
  assert.ok(flat.band[0] < 1 && flat.band[1] > 1);
});

test("one model only is its own absence, worded plainly, with no number", () => {
  const ps = alternating(2, 1).map((p) => ({ ...p, model: "m1" }));
  const r = compareByModel(ps, { reading: "req", now: NOW });
  assert.equal(r.kind, "oneModel");
  assert.match(r.absent, /^Only one model ran these sessions in the last 14 days: m1 \(70 sessions on 14 days\)/);
  assert.ok(!("ratio" in r));
  assert.match(BY_MODEL_ALTERNATE_TEXT, /alternate them by day/);
});

test("under the minimum the comparison is absent with the sentence why — never a number from three sessions", () => {
  const ps = alternating(3, 1).filter((p) => p.model === "m1");
  for (let i = 0; i < 3; i++) ps.push(pt(addLocalDays(BASE, 3) + i, { model: "m2" }));
  const r = compareByModel(ps, { reading: "look", now: NOW });
  assert.equal(r.kind, "tooFew");
  assert.match(r.absent, new RegExp(`m2 3 sessions on 1 day; comparing two models needs at least ${COMPARE_MIN_N} sessions`));
  assert.ok(!("ratio" in r));
});

test("model and CLI that changed together are flagged and worded; a shared CLI version is not", () => {
  const ps = alternating(4, 0.5, (m) => ({ cli: m === "m1" ? "2.1.273" : "2.1.281" }));
  const r = compareByModel(ps, { reading: "req", now: NOW });
  assert.equal(r.cliTogether, true);
  assert.equal(byModelCliText(r), "Every m1 session here ran CLI 2.1.273, every m2 session CLI 2.1.281: the model and the CLI version changed together, so this cannot tell which of the two moved a reading.");
  const mixed = alternating(4, 0.5, (m, d, s) => ({ cli: m === "m1" || s > 0 ? (m === "m1" ? "2.1.273" : "2.1.281") : "2.1.273" }));
  assert.equal(compareByModel(mixed, { reading: "req", now: NOW }).cliTogether, undefined);
  const unsaid = alternating(4, 0.5, (m, d, s) => (s === 0 ? { cli: undefined } : { cli: m }));
  assert.equal(compareByModel(unsaid, { reading: "req", now: NOW }).cliTogether, undefined, "a session with no CLI version cannot rule a shared one out");
});

test("skill loads compare means with the share beside; the window and unnamed sessions are honoured", () => {
  const ps = alternating(6, 1, (m, d, s) => ({ skills: m === "m2" ? (s < 2 ? 2 : 0) : (s < 1 ? 1 : 0) }));
  ps.push(pt(addLocalDays(BASE, 2), { model: undefined }));
  ps.push(pt(addLocalDays(BASE, -30), { model: "m3" })); // outside the window
  const r = compareByModel(ps, { reading: "skills", now: NOW });
  assert.equal(r.mean, true);
  assert.ok(Math.abs(r.a.value - 0.2) < 1e-9 && Math.abs(r.a.share - 0.2) < 1e-9);
  assert.ok(Math.abs(r.b.value - 0.8) < 1e-9 && Math.abs(r.b.share - 0.4) < 1e-9);
  assert.equal(r.unnamed, 1);
  assert.deepEqual(r.others, []);
  const short = compareByModel(ps, { reading: "look", now: NOW, days: 7 });
  assert.equal(short.kind, "tooFew", "alternating, a 7-day window holds 3 or 4 days per model");
  assert.match(short.absent, /on 4 days for each/);
  const all = compareByModelAll(ps, { now: NOW });
  assert.deepEqual(all.map((x) => x.reading), [...BY_MODEL_READINGS]);
});
