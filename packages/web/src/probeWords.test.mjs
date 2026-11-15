/**
 * The lookup probe card's words and picks (R-metrics-074): never "better"/"worse", the band said
 * outside or within normal variation, void with its reason, the headline's one line, the export
 * slot from the newest non-void result; and the card's source shape (ConfirmButton for the paid
 * start, the estimate sent back as `accepted`, no second socket, no window.confirm).
 *
 *     node --test packages/web/src/probeWords.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const w = await import("./probeWords.ts");

const tok = (n) => ({ in: 10, cw: 0, cr: n - 10, out: 0 });
const run = (o) => ({ arm: "A", rep: 0, id: "q1", correct: true, capHit: false, final: "x", toolCalls: 2, requests: 3, tokens: tok(30000), ms: 1, ...o });
const result = (o = {}) => ({
  schema: 1, id: "r1", kind: "models", backend: "claude", desktop: "mac", startedAt: Date.UTC(2026, 10, 13, 9), finishedAt: Date.UTC(2026, 10, 13, 10),
  commit: "0123456789abcdef", seed: 1, repeats: 3, maxTurns: 12, questions: ["q1"], arms: [{ arm: "A", model: "m-a" }, { arm: "B", model: "m-b" }],
  fingerprints: {}, runs: [run({}), run({ arm: "B", tokens: tok(40000) }), run({ correct: false, tokens: tok(50000) }), run({ error: "timeout", tokens: undefined })],
  estimate: { tokens: 1, usd: 1 }, ...o,
});
const fig = (ratio, outside) => ({ ratio, lo: ratio - 0.1, hi: ratio + 0.1, band: 0.14, bandFromPrior: false, outside });
const arm = (o) => ({ arm: "A", model: "m-a", runs: 20, correct: 19, capHits: 0, errors: 0, medianTokens: 31000, medianRequests: 4, medianCalls: 3, ...o });
const analysis = (o = {}) => ({ arms: [arm({}), arm({ arm: "B", model: "m-b" })], gate: { pass: true, text: "" }, lines: [], ...o });

const BANNED = [/\bbetter\b/i, /\bworse\b/i, /\bwinner\b/i, /\bbest\b/i];

test("R-metrics-074: the paired line says outside / within normal variation, with its interval and band", () => {
  assert.equal(w.probePairLine("tokens", fig(0.8, true), "m-a", "m-b"), "tokens: m-b ×0.8 of m-a (95% 0.70–0.90), outside normal variation (±14% between repeats).");
  assert.match(w.probePairLine("tokens", { ...fig(1.02, false), bandFromPrior: true, lo: undefined, hi: undefined }, "a", "b"), /^tokens: b ×1\.02 of a, within normal variation \(±14% between repeats, the pilot's band/);
});

test("R-metrics-074: the gate is pass or fail with the counts; an arm line names tokens and requests a question", () => {
  const arms = [{ label: "m-a", s: arm({}) }, { label: "m-b", s: arm({ correct: 12, capHits: 2 }) }];
  assert.match(w.probeGateLine(arms, true), /^Correctness gate passed: m-a 19 of 20, m-b 12 of 20 \(2 at the turn cap\) found right/);
  assert.match(w.probeGateLine(arms, false), /^Correctness gate not passed: .* not compared\.$/);
  assert.equal(w.probeArmLine("m-a", arm({ errors: 1 })), "m-a: median 31k tokens (fresh input, cache write, cache read and output together) and 4 requests a question; 1 run gave no answer and is left out.");
  assert.equal(w.probeArmLine("m-a", arm({ medianTokens: undefined })), "m-a: median tokens not reported and 4 requests a question.");
});

test("R-metrics-074: void says why; the headline's line covers void, paired, baseline and not compared", () => {
  assert.equal(w.probeVoidLine("a tool read outside the scratch checkout"), "Void: a tool read outside the scratch checkout. No figure of this run is read.");
  const r = result();
  assert.equal(w.probeLastLine(r, analysis({ void: "leak" })), "Last search test: model against model, 2026-11-13 — void (leak).");
  // Both sides are named (the ratio is B of A) and requests stand beside tokens.
  assert.equal(w.probeLastLine(r, analysis({ paired: { a: "A", b: "B", n: 18, tokens: fig(0.81, true), requests: fig(1.4, true), calls: fig(1, false) } })),
    "Last search test: model against model, 2026-11-13 — tokens m-b ×0.81 of m-a, outside normal variation; requests m-b ×1.4 of m-a, outside normal variation; correctness gate passed.");
  assert.match(w.probeLastLine(result({ kind: "against", arms: [{ arm: "B", model: "m-a" }], against: "base" }), analysis({ paired: { a: "A", b: "B", n: 18, tokens: fig(0.9, false), requests: fig(1, false), calls: fig(1, false) } }), result({ id: "base", kind: "baseline", arms: [{ arm: "A", model: "m-old" }] })),
    /tokens now \(m-a\) ×0.9 of before \(m-old\), within normal variation; requests now \(m-a\) ×1 of before \(m-old\)/);
  assert.equal(w.probeLastLine(result({ kind: "baseline" }), analysis()), "Last search test: a baseline, 2026-11-13 — kept as a baseline.");
  assert.equal(w.probeLastLine(r, analysis({ gate: { pass: false, text: "" } })), "Last search test: model against model, 2026-11-13 — correctness gate not passed.");
});

test("R-metrics-074: unread results are said as unread, never as none", () => {
  assert.match(w.probeResultsUnreadLine(true), /Reading/);
  assert.match(w.probeResultsUnreadLine(false, "offline"), /could not be read: offline.*not known/);
  assert.doesNotMatch(w.probeResultsUnreadLine(false), /none|No probe|No baseline/i);
  const card = readFileSync(new URL("./ProbeCard.tsx", import.meta.url), "utf8");
  assert.match(card, /resRead \? PROBE_AGAINST_NONE/);
  assert.match(card, /!resRead \? <div className="rh-cap">\{resUnread\}/);
  const region = readFileSync(new URL("./AgentReadingsRegion.tsx", import.meta.url), "utf8");
  assert.match(region, /probes\.data\?\.ok \? <div className="(?:[\w-]+ )*rh-cap">\{PROBE_NONE\}/);
});

test("R-metrics-074: no word on the card ranks a setup", () => {
  const all = [w.probeHelp(), ...Object.values(w.PROBE_KIND_HELP), ...Object.values(w.PROBE_KIND_LABEL), w.PROBE_AGAINST_NONE, w.PROBE_MODEL_B_MISSING,
    w.probeGateLine([{ label: "a", s: arm({}) }], false), w.probeGateLine([{ label: "a", s: arm({}) }], true), w.probePairLine("tokens", fig(2, true), "a", "b"),
    w.probeStatusLine({ state: "running", done: 3, of: 120, note: "asking" }), w.probeStartedText()];
  for (const s of all) for (const bad of BANNED) assert.doesNotMatch(s, bad, s);
  assert.match(w.probeHelp(), /this desktop/, "the ? names where it comes from (R-metrics-069)");
});

test("R-metrics-074: the price is said before the tap, in dollars when priced and tokens otherwise", () => {
  assert.equal(w.probeConfirmText({ tokens: 16_200_000, usd: 21.4 }), "spend about $21.40?");
  assert.equal(w.probeConfirmText({ tokens: 16_200_000, usd: null }), "spend about 16.2M tokens?");
  assert.equal(w.probeStatusLine({ state: "running", done: 3, of: 120, note: "asking" }), "Running on this desktop: 3 of 120 questions asked — asking.");
});

test("R-metrics-073/074: the export slot comes from the newest non-void result that answered something", () => {
  assert.equal(w.probeShareOf([]), null);
  const voided = { result: result({ id: "v", void: "leak" }), analysis: analysis({ void: "leak" }) };
  const one = [{ arm: "A", model: "m-a" }];
  const ok = { result: result({ kind: "baseline", arms: one }), analysis: analysis() };
  // Model against model: two arms, no model in the slot, so no pooled figure.
  const both = { result: result(), analysis: analysis() };
  assert.equal(w.probeShareOf([both]), null);
  // Answered runs only: 3 (the timeout is left out), 2 right; median of 30k, 40k, 50k.
  const shared = w.probeShareOf([voided, both, ok]);
  assert.deepEqual({ ...shared, draw: undefined }, { day: "2026-11-13", kind: "baseline", correct: 2 / 3, tokPerQuestion: 40000, repeats: 3, model: "m-a", questions: ok.result.questions.length, draw: undefined });
  // The draw is a fingerprint of the question ids asked, the same for the same set in any order.
  assert.match(shared.draw, /^[0-9a-f]{8}$/);
  const withIds = (ids, drawn = ids) => ({ result: result({ kind: "baseline", arms: one, questions: drawn, runs: ids.map((id) => run({ id })) }), analysis: analysis() });
  const drawOf = (ids) => w.probeShareOf([withIds(ids)]).draw;
  assert.equal(drawOf(["q1", "q2"]), drawOf(["q2", "q1"]));
  assert.notEqual(drawOf(["other"]), shared.draw);
  // A run that stopped early counts and fingerprints the questions it asked, not the whole draw; an errored question is not asked.
  const stopped = w.probeShareOf([withIds(["q1", "q2"], ["q1", "q2", "q3", "q4"])]);
  assert.equal(stopped.questions, 2);
  assert.equal(stopped.draw, drawOf(["q1", "q2"]));
  const errored = { result: result({ kind: "baseline", arms: one, questions: ["q1", "q2"], runs: [run({ id: "q1" }), run({ id: "q2", error: "timeout", tokens: undefined })] }), analysis: analysis() };
  assert.equal(w.probeShareOf([errored]).questions, 1);
  assert.equal(w.probeShareOf([voided]), null);
});

test("R-metrics-074: the card starts only through a ConfirmButton with the estimate as `accepted`, polls over fetch, never window.confirm", () => {
  const src = readFileSync(new URL("./ProbeCard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /window\.confirm|new WebSocket/);
  assert.match(src, /<ConfirmButton[^>]*confirm=\{probeConfirmText\(est\)\}[^>]*onConfirm=\{start\}/);
  assert.match(src, /accepted: \{ tokens: est\.tokens, usd: est\.usd \}/);
  assert.match(src, /probeEstimate\(plan\.models, plan\.questions, plan\.repeats\)/);
  assert.match(src, /const reloadView = view\.reload;/);
  assert.match(src, /setInterval\(\(\) => reloadView\(\{ quiet: true \}\), POLL_MS\)/);
  assert.equal((src.match(/\{probeSourceText\(\)\}/g) ?? []).length, 1, "the source is said once on the card (the ? says it through probeHelp)");
  const region = readFileSync(new URL("./AgentReadingsRegion.tsx", import.meta.url), "utf8");
  assert.match(region, /<ProbeCard repoId=\{repoId\} view=\{probeView\} results=\{probes\} pts=\{pts\} \/>/);
  assert.match(region, /<SetupShareCard repoId=\{repoId\} pts=\{pts\} probe=\{shareProbe\} \/>/);
});
