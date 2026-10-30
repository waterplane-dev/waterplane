/**
 * A backend ledger cut to a span (c2 §1): on its HOURS only, absent with words wherever the cut
 * cannot be exact, never a day summed into the wrong span; the native unit kept as itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { besideFigure, hourFloor, ledgerOverSpan, LEDGER_SPAN_STALE_MS } from "../dist/index.js";

const H = 3_600_000;
const base = hourFloor(Date.UTC(2026, 9, 1, 12));
const doc = (over = {}) => ({
  available: true,
  firstAt: base + 5 * 60_000,
  lastAt: base + 3 * H + 10 * 60_000,
  scannedAt: base + 4 * H,
  unit: { name: "AI credits" },
  hourly: {
    from: base,
    rows: [
      { hour: base, kinds: { input: 100, output: 10 }, unit: 2 },
      { hour: base + H, kinds: { input: 50 } },
      { hour: base + 3 * H, kinds: { input: 7 }, unit: 1.5 },
    ],
  },
  ...over,
});
const now = base + 4 * H;

test("sums the hours inside [from, to), kinds apart, the native unit as itself", () => {
  assert.deepEqual(ledgerOverSpan(doc(), base, base + 2 * H, now), { kind: "spent", kinds: { input: 150, output: 10 }, unit: { name: "AI credits", amount: 2 } });
  // `to` off the hour but past the last record: the running hour counts.
  assert.deepEqual(ledgerOverSpan(doc(), base + H, base + 3 * H + 30 * 60_000, now), { kind: "spent", kinds: { input: 57 }, unit: { name: "AI credits", amount: 1.5 } });
});

test("no store is no line; nothing in the span is no line", () => {
  assert.deepEqual(ledgerOverSpan({ available: false }, base, base + H, now), { kind: "none" });
  assert.deepEqual(ledgerOverSpan(doc(), base + 2 * H, base + 3 * H, now), { kind: "none" });
});

test("a day-only ledger is absent with words, never a day summed into the span", () => {
  const r = ledgerOverSpan(doc({ hourly: undefined }), base, base + H, now);
  assert.equal(r.kind, "absent");
  assert.match(r.why, /by day/);
});

test("an edge the hours cannot cut is absent", () => {
  assert.equal(ledgerOverSpan(doc(), base + 30 * 60_000, base + 2 * H, now).kind, "absent");
  // `to` mid-hour with later spend in that hour.
  assert.match(ledgerOverSpan(doc(), base, base + 3 * H + 5 * 60_000, now).why, /later spend/);
  // the span reaches before the hours kept, and the ledger has older spend.
  assert.match(ledgerOverSpan(doc({ firstAt: base - 10 * H }), base - 2 * H, base + H, now).why, /keeps hours only since/);
  // …but a ledger whose first record is inside its hours answers a wider span.
  assert.equal(ledgerOverSpan(doc(), base - 2 * H, base + H, now).kind, "spent");
});

test("a stalled scan and a bad figure are absent, not a floor", () => {
  assert.match(ledgerOverSpan(doc({ scannedAt: base }), base, base + 4 * H, base + 4 * H + LEDGER_SPAN_STALE_MS).why, /recently/);
  const bad = doc(); bad.hourly.rows[0].kinds.input = -1;
  assert.match(ledgerOverSpan(bad, base, base + H, now).why, /not a count/);
  assert.match(ledgerOverSpan(doc({ unit: undefined }), base, base + H, now).why, /does not name/);
});

test("besideFigure: the unit where there is one, else the kinds named, largest first", () => {
  assert.equal(besideFigure({ backend: "copilot", label: "Copilot", kinds: { input: 9 }, unit: { name: "AI credits", amount: 312 }, scannedAt: 1 }), "312 AI credits");
  assert.equal(besideFigure({ backend: "codex", label: "Codex", kinds: { output: 40_000, input: 1_200_000 }, scannedAt: 1 }), "1.2M input, 40k output tokens");
});

test("a positive unit total below the rounding step stays positive", () => {
  const d = doc({ hourly: { from: base, rows: [{ hour: base, kinds: { input: 1 }, unit: 0.0003 }] } });
  const r = ledgerOverSpan(d, base, base + H, now);
  assert.equal(r.unit.amount, 0.0003);
  assert.doesNotMatch(besideFigure(r), /^0 /);
});

test("a ledger that holds records it could not date answers no span: the figure would be a floor", () => {
  // bughunt 2026-10-29 C2-4: an undated record is in the totals and in no hour row, so any
  // span it might belong to would read short while looking exact.
  const d = doc(); d.hourly.undated = 1;
  const r = ledgerOverSpan(d, base, base + 2 * H, now);
  assert.equal(r.kind, "absent");
  assert.match(r.why, /could not date/);
  // none undated, or a document from a host that does not say: the cut as today.
  const z = doc(); z.hourly.undated = 0;
  assert.equal(ledgerOverSpan(z, base, base + 2 * H, now).kind, "spent");
  assert.equal(ledgerOverSpan(doc(), base, base + 2 * H, now).kind, "spent");
  // a count that is not a count is not "none undated".
  const bad = doc(); bad.hourly.undated = -1;
  assert.match(ledgerOverSpan(bad, base, base + 2 * H, now).why, /not a count/);
});

test("undatedWhy is the one rule, and claude's own figures word it as a beside line (design round 4)", async () => {
  const { undatedWhy, undatedText } = await import("../dist/index.js");
  assert.equal(undatedWhy(undefined), null);
  assert.equal(undatedWhy(0), null);
  assert.match(undatedWhy(1), /holds 1 record it could not date/);
  assert.match(undatedWhy(-1), /not a count/);
  assert.equal(undatedText(0), null);
  assert.equal(undatedText(undefined), null);
  assert.equal(undatedText(2), "Claude Code: holds 2 records it could not date that could fall in this span, so the figure could be missing them.");
  // ledgerOverSpan answers with the same words, not a second copy.
  const d = doc(); d.hourly.undated = 2;
  assert.equal(ledgerOverSpan(d, base, base + 2 * H, now).why, undatedWhy(2));
});

test("undatedSince: a span starting after the newest undated log's mtime misses none (design round 4)", async () => {
  const { undatedSince, undatedWhy } = await import("../dist/index.js");
  assert.equal(undatedSince({ undated: 3, undatedUntil: 100 }, 101), 0);
  assert.equal(undatedSince({ undated: 3, undatedUntil: 100 }, 100), 3, "written at the span's start: could be in it");
  assert.equal(undatedSince({ undated: 3 }, 1e15), 3, "no bound said: every span keeps the count");
  assert.equal(undatedSince({ undated: 3, undatedUntil: "x" }, 1e15), 3);
  assert.equal(undatedSince({ undated: 0 }, 5), 0);
  assert.equal(undatedSince({}, 5), undefined, "an older host: read as before");
  assert.equal(undatedSince(null, 5), undefined);
  assert.equal(undatedWhy(undatedSince({ undated: -1, undatedUntil: 1 }, 5)), "its ledger holds a figure that is not a count");
});

test("undatedSince counts per log: one old log never lends its count to a span opened after it (design round 5, r4-1b L1)", async () => {
  const { undatedSince, undatedLogsOf } = await import("../dist/index.js");
  // Log A: last written at 10, 5 undated. Log B: written at 100, 1 undated.
  const doc = { undated: 6, undatedUntil: 100, undatedLogs: undatedLogsOf([[10, 5], [100, 1]]) };
  assert.deepEqual(doc.undatedLogs, [[10, 5], [100, 1]], "ascending by mtime");
  assert.equal(undatedSince(doc, 50), 1, "only B could hold a record of a span opened at 50");
  assert.equal(undatedSince(doc, 10), 6, "written at the span's start: could be in it");
  assert.equal(undatedSince(doc, 101), 0);
  // A log with an unknown mtime is in `undated` and in no pair: never subtracted, so always counted.
  assert.equal(undatedSince({ undated: 7, undatedLogs: [[10, 5], [100, 1]] }, 101), 1);
  // A list that cannot be read keeps the old rule, never a smaller number.
  assert.equal(undatedSince({ undated: 6, undatedUntil: 100, undatedLogs: [[10, 9]] }, 50), 6, "pairs that outnumber the total are not believed");
  assert.equal(undatedSince({ undated: 6, undatedUntil: 100, undatedLogs: "x" }, 50), 6);
  assert.equal(undatedSince({ undated: 6, undatedUntil: 100, undatedLogs: [[10, -1]] }, 50), 6);
});

test("undatedLogsOf is bounded: past the cap the OLDEST pairs merge under the newer mtime, so a count only grows (design round 5)", async () => {
  const { undatedLogsOf, undatedSince, UNDATED_LOGS_CAP } = await import("../dist/index.js");
  const many = Array.from({ length: UNDATED_LOGS_CAP + 10 }, (_, i) => [1000 - i, 1]);
  const logs = undatedLogsOf(many);
  assert.equal(logs.length, UNDATED_LOGS_CAP);
  assert.equal(logs.reduce((n, [, k]) => n + k, 0), many.length, "no record lost in a merge");
  for (let i = 1; i < logs.length; i++) assert.ok(logs[i][0] > logs[i - 1][0]);
  const doc = { undated: many.length, undatedLogs: logs };
  // Exact per log would say `from` lets in the logs with m >= from; merged it may say more, never fewer.
  for (const from of [900, 960, 980, 995, 1001]) {
    const exact = many.filter(([m]) => m >= from).length;
    assert.ok(undatedSince(doc, from) >= exact, `from ${from}`);
  }
  assert.equal(undatedSince(doc, 1001), 0);
  assert.deepEqual(undatedLogsOf([[5, 0], [Number.NaN, 2], [7, 2], [7, 1]]), [[7, 3]], "zero and unknown dropped; one mtime one pair");
});
