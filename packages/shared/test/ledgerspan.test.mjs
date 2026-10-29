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
