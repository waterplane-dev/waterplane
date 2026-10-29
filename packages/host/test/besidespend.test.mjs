/** `besideSpend`: the other backends' ledgers over one span (c2 §2). No daemon. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { besideSpend } from "../dist/besidespend.js";
import { BACKENDS } from "../dist/backends/index.js";

const H = 3_600_000;
const FROM = Math.floor(Date.UTC(2026, 9, 1) / H) * H;
const TO = FROM + 24 * H;
const NOW = TO + H;
const CLAUDE = BACKENDS.find((x) => x.id === "claude");
const b = (id) => (id === "claude" ? CLAUDE : { id, label: id.toUpperCase(), facts: {}, caps: {} });
const deps = (ledgers, extra = {}) => ({
  backends: () => Object.keys(ledgers).map(b),
  ledger: (be) => ledgers[be.id](be),
  now: () => NOW, timeoutMs: 40, ...extra,
});
const doc = (rows, extra = {}) => ({ available: true, hourly: { from: FROM, rows }, firstAt: FROM, lastAt: FROM + 2 * H, scannedAt: NOW - 1000, ...extra });

test("claude-log backends are skipped; a spent ledger carries kinds and unit", async () => {
  const out = await besideSpend(FROM, TO, deps({
    claude: () => { throw new Error("must not be read"); },
    codex: async () => doc([{ hour: FROM + H, kinds: { input: 10, output: 2 }, unit: 3 }], { unit: { name: "AI credits" } }),
  }));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].kinds, { input: 10, output: 2 });
  assert.deepEqual(out[0].unit, { name: "AI credits", amount: 3 });
  assert.equal(out[0].scannedAt, NOW - 1000);
});

test("a throwing and a hanging ledger are absent sentences, never missing", async () => {
  const out = await besideSpend(FROM, TO, deps({
    boom: async () => { throw new Error("db locked"); },
    slow: () => new Promise(() => {}),
  }));
  assert.equal(out.length, 2);
  for (const r of out) assert.match(r.absent, /could not be read in time/);
});

test("nothing ran / unavailable ⇒ no row; a day-only ledger ⇒ absent", async () => {
  const out = await besideSpend(FROM, TO, deps({
    none: async () => ({ available: false, reason: "no store" }),
    quiet: async () => doc([]),
    days: async () => ({ available: true, scannedAt: NOW, firstAt: FROM, lastAt: FROM + H }),
  }));
  const ids = out.map((r) => r.backend);
  assert.equal(ids.includes("none"), false);
  const days = out.find((r) => r.backend === "days");
  assert.ok(days && typeof days.absent === "string");
});
