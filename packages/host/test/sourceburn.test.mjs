/** `createSourceBurnWatch`: the burn push per non-claude source's long window (c2 §3). */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSourceBurnWatch } from "../dist/burnwatch.js";

const MIN = 60_000;
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "srcburn-")); dirs.push(d); return d; };
const T0 = Date.UTC(2026, 9, 9, 8, 0, 0);
const NOW = T0 + 91 * MIN;
const hist = (id, per) => Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * 10 * MIN, w: [{ id, pct: 10 + i * per, resetAt: T0 + 5 * 24 * 60 * MIN }] }));
const reading = (over = {}) => ({ source: "copilot", label: "Copilot", checkedAt: NOW, windows: [{ id: "month", label: "Month", unit: "mo", pct: 50, resetAt: null }], ...over });

function make(samples, dir = tmp(), extra = {}) {
  const sent = [];
  const w = createSourceBurnWatch({ history: () => samples, notify: (k, p) => sent.push([k, p, existsSync(join(dir, "burnwatch-sources.json"))]), stateDir: dir, now: () => NOW, thresholdPtsPerHour: 4, cooldownMs: 3 * 60 * MIN, ...extra });
  return { w, sent, dir };
}

test("fires once per stretch, latch written before notify, tagged per source:window", async () => {
  const { w, sent, dir } = make(hist("month", 3));
  assert.equal(await w.observe(reading()), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "burn");
  assert.equal(sent[0][1].tag, "burn:copilot:month");
  assert.equal(sent[0][2], true, "latch on disk at notify time");
  assert.ok(JSON.parse(readFileSync(join(dir, "burnwatch-sources.json"), "utf8"))["copilot:month"].lastAt);
  assert.equal(await w.observe(reading()), false);
  assert.equal(sent.length, 1);
});

test("a restart keeps the latch; the cooldown is honoured", async () => {
  const dir = tmp();
  await make(hist("month", 3), dir).w.observe(reading());
  const again = make(hist("month", 3), dir);
  assert.equal(await again.w.observe(reading()), false);
  assert.equal(again.sent.length, 0);
});

test("claude, remembered readings and 5h windows are ignored; claude's file untouched", async () => {
  const { w, sent, dir } = make(hist("month", 3));
  assert.equal(await w.observe(reading({ source: "claude" })), false);
  assert.equal(await w.observe(reading({ remembered: true })), false);
  assert.equal(await w.observe(reading({ windows: [{ id: "month", label: "5h", unit: "5h", pct: 50, resetAt: null }] })), false);
  assert.equal(sent.length, 0);
  await w.observe(reading());
  assert.equal(existsSync(join(dir, "burnwatch.json")), false);
});

test("a slow climb stays quiet; threshold 0 is off", async () => {
  assert.equal(await make(hist("month", 0.1)).w.observe(reading()), false);
  const off = make(hist("month", 3), tmp(), { thresholdPtsPerHour: 0 });
  assert.equal(off.w.armed(), false);
  assert.equal(await off.w.observe(reading()), false);
});

test("a corrupt latch file is moved aside, not trusted", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "burnwatch-sources.json"), "{nope");
  const { w } = make(hist("month", 3), dir);
  assert.equal(await w.observe(reading()), true);
});

test("two sources observed in the same drain each get their push (guard is per source)", async () => {
  const sent = [];
  const w = createSourceBurnWatch({ history: () => hist("month", 3), notify: (k, p) => sent.push(p.tag), stateDir: tmp(), now: () => NOW, thresholdPtsPerHour: 4, cooldownMs: 3 * 60 * MIN });
  const [a, b] = await Promise.all([w.observe(reading()), w.observe(reading({ source: "other", label: "Other" }))]);
  assert.deepEqual([a, b], [true, true]);
  assert.deepEqual(sent.sort(), ["burn:copilot:month", "burn:other:month"]);
});

test("a rejected claude reading does not hold the guard against a real source in the same drain", async () => {
  const { w, sent } = make(hist("month", 3));
  const [a, b] = await Promise.all([w.observe(reading({ source: "claude" })), w.observe(reading())]);
  assert.deepEqual([a, b], [false, true]);
  assert.equal(sent.length, 1);
});
