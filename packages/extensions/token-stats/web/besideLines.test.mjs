import test from "node:test";
import assert from "node:assert/strict";
import { besideLines } from "./besideLines.ts";

test("absent or empty rows draw no block", () => {
  assert.equal(besideLines(undefined), null);
  assert.equal(besideLines([]), null);
});

test("lead once, one line per row: native unit figure, kinds figure, absent sentence", () => {
  const v = besideLines([
    { backend: "copilot", label: "Copilot", kinds: { input: 10 }, unit: { name: "AI credits", amount: 12.5 }, scannedAt: 1 },
    { backend: "gemini", label: "Gemini", kinds: { input: 1500, output: 500 }, scannedAt: 1 },
    { backend: "codex", label: "Codex", absent: "keeps its ledger by day, so a span is not cut" },
  ]);
  assert.match(v.lead, /not in the figure above/);
  assert.deepEqual(v.lines.map((l) => l.text), [
    "12.5 AI credits", "1.5k input, 500 output tokens", "keeps its ledger by day, so a span is not cut",
  ]);
  assert.ok(!v.lines.some((l) => /total|%/.test(l.text)), "never a sum or share");
});
