// Usage readings per source: claude's adapter, reset expiry, the chip's one cut and the
// long-press words. A source with nothing to say draws nothing; claude is first; never `?`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  USAGE_SOURCE_RE,
  chipCut,
  chipSegments,
  claudeReading,
  hottestWindow,
  isUsageSourceId,
  readingAfterResets,
  readingHot,
  usageReadingTitle,
  usageWindowPct,
} from "../dist/usagesources.js";
import * as index from "../dist/index.js";

const NOW = 1_790_000_000_000;
const H = 3600e3;

const usage = (o = {}) => ({
  ok: true, sessionPct: 42, weeklyPct: 61,
  sessionResetAt: NOW + 2 * H, weeklyResetAt: NOW + 72 * H, checkedAt: NOW - 60e3, ...o,
});

const copilot = (o = {}) => ({
  source: "copilot", label: "Copilot", checkedAt: NOW - 120e3,
  windows: [{ id: "chat", unit: "mo", pct: 5, used: 9, limit: 200, unitName: "credits", resetAt: NOW + 16 * 24 * H }],
  ...o,
});

test("exported from the index", () => {
  assert.equal(typeof index.claudeReading, "function");
  assert.equal(typeof index.chipSegments, "function");
});

test("claudeReading: ok:false and null are null", () => {
  assert.equal(claudeReading(null), null);
  assert.equal(claudeReading(usage({ ok: false })), null);
  assert.equal(claudeReading(usage({ sessionPct: null, weeklyPct: null })), null);
});

test("claudeReading: round-trips both windows, resets and checkedAt", () => {
  const u = usage();
  const r = claudeReading(u);
  assert.deepEqual(r, {
    source: "claude", label: "Claude", backend: "claude", checkedAt: u.checkedAt,
    windows: [
      { id: "session", unit: "5h", pct: 42, resetAt: u.sessionResetAt },
      { id: "week", unit: "wk", pct: 61, resetAt: u.weeklyResetAt },
    ],
  });
  assert.equal("remembered" in r, false);
});

test("claudeReading: remembered carried; an unprinted window left out, not pct:null", () => {
  const r = claudeReading(usage({ remembered: true, weeklyPct: null, weeklyResetAt: null }));
  assert.equal(r.remembered, true);
  assert.deepEqual(r.windows.map((w) => w.id), ["session"]);
});

test("readingAfterResets: SAME object when nothing expired", () => {
  const r = claudeReading(usage());
  assert.equal(readingAfterResets(r, NOW), r);
  const noReset = copilot({ windows: [{ id: "chat", unit: "mo", pct: 5, resetAt: null }] });
  assert.equal(readingAfterResets(noReset, NOW + 1000 * H), noReset, "unknown reset is not expired");
});

test("readingAfterResets: drops a passed window, null when nothing is left", () => {
  const r = claudeReading(usage());
  const after = readingAfterResets(r, NOW + 3 * H);
  assert.notEqual(after, r);
  assert.deepEqual(after.windows.map((w) => w.id), ["week"]);
  assert.equal(r.windows.length, 2, "input untouched");
  assert.equal(readingAfterResets(r, NOW + 100 * H), null);
  assert.equal(readingAfterResets(copilot({ windows: [] }), NOW), null, "never a reading of empty windows");
});

test("readingAfterResets: a dollar period expires like a window", () => {
  const r = { source: "x", label: "X", checkedAt: NOW, windows: [], usd: { periodId: "m", label: "October", spentUsd: 3, capUsd: null, resetAt: NOW + H } };
  assert.equal(readingAfterResets(r, NOW), r);
  assert.equal(readingAfterResets(r, NOW + 2 * H), null);
});

test("hottestWindow / usageWindowPct / readingHot", () => {
  assert.equal(hottestWindow(claudeReading(usage())).id, "week");
  assert.equal(usageWindowPct({ id: "c", unit: "mo", pct: null, used: 50, limit: 200, resetAt: null }), 25);
  assert.equal(usageWindowPct({ id: "c", unit: "mo", pct: null, resetAt: null }), null);
  assert.equal(usageWindowPct({ id: "c", unit: "mo", pct: 140, resetAt: null }), null, "out of range is not a number");
  assert.equal(hottestWindow(copilot({ windows: [{ id: "c", unit: "mo", pct: null, resetAt: null }] })), null);
  assert.equal(readingHot(claudeReading(usage({ weeklyPct: 80 }))), true);
  assert.equal(readingHot(claudeReading(usage())), false);
  assert.equal(readingHot(claudeReading(usage()), 60), true);
});

test("chipSegments: single claude is one segment, today's chip", () => {
  const segs = chipSegments([claudeReading(usage())]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].source, "claude");
  assert.equal(segs[0].text, "61%");
  assert.equal(segs[0].unit, "wk");
  assert.equal(segs[0].hidden, undefined);
});

test("chipSegments: claude first even when cooler, others hottest first", () => {
  const cool = claudeReading(usage({ sessionPct: 1, weeklyPct: 2 }));
  const hot = { ...copilot(), source: "gemini", label: "Gemini", windows: [{ id: "d", unit: "dy", pct: 90, resetAt: null }] };
  const segs = chipSegments([copilot(), hot, cool]);
  assert.deepEqual(segs.map((s) => s.source), ["claude", "gemini", "copilot"]);
  assert.equal(segs[1].hot, true);
  assert.equal(segs[2].text, "5%");
  assert.equal(segs[2].unit, "mo");
});

test("chipSegments: a reading with nothing to draw is dropped", () => {
  const empty = copilot({ windows: [{ id: "chat", unit: "mo", pct: null, resetAt: null }] });
  assert.deepEqual(chipSegments([claudeReading(usage()), empty]).map((s) => s.source), ["claude"]);
  assert.deepEqual(chipSegments([]), []);
  assert.deepEqual(chipSegments(undefined), []);
  const cut = chipCut([empty]);
  assert.equal(cut.total, 0);
});

test("chipCut: past max the rest are named in hidden, on the last segment too", () => {
  const mk = (source, label, pct) => ({ source, label, checkedAt: NOW, windows: [{ id: "w", unit: "mo", pct, resetAt: null }] });
  const rs = [mk("codex", "Codex", 10), claudeReading(usage()), mk("gemini", "Gemini", 20), copilot(), mk("zed", "Zed", 30)];
  const cut = chipCut(rs, 3);
  assert.deepEqual(cut.segments.map((s) => s.source), ["claude", "zed", "gemini"]);
  assert.deepEqual(cut.hidden, ["Codex", "Copilot"]);
  assert.equal(cut.total, 5);
  assert.deepEqual(cut.segments[2].hidden, ["Codex", "Copilot"]);
  assert.equal(cut.segments[0].hidden, undefined);
  assert.deepEqual(chipSegments(rs, 3), cut.segments);
});

test("chipCut: duplicate sources keep the first", () => {
  const cut = chipCut([copilot(), copilot({ windows: [{ id: "chat", unit: "mo", pct: 99, resetAt: null }] })]);
  assert.equal(cut.total, 1);
  assert.equal(cut.segments[0].text, "5%");
});

test("usageReadingTitle: the plan's wording, never `?`", () => {
  const t = usageReadingTitle(copilot(), NOW);
  assert.match(t, /^Copilot usage — chat 5% \(9 \/ 200 credits\) · resets \w{3} \d{1,2} \(in 16d\) · checked 2m ago$/);
  const c = usageReadingTitle(claudeReading(usage({ weeklyPct: null, remembered: true })), NOW);
  assert.match(c, /^Claude usage — 5-hour session 42% · resets \d\d:\d\d \(in 2h\) · checked 1m ago \(kept from before a restart\)$/);
  for (const r of [copilot({ windows: [{ id: "chat", unit: "mo", pct: null, resetAt: null }] }), claudeReading(usage({ sessionResetAt: null }))]) {
    assert.equal(usageReadingTitle(r, NOW).includes("?"), false);
  }
});

test("isUsageSourceId", () => {
  for (const ok of ["claude", "copilot", "plugin:anthropic", "my_plugin-1"]) assert.equal(isUsageSourceId(ok), true, ok);
  for (const bad of ["", "Claude", "a b", ":x", "x/y", 3, null, "a".repeat(49)]) assert.equal(isUsageSourceId(bad), false, String(bad));
  assert.ok(USAGE_SOURCE_RE instanceof RegExp);
});
