/**
 * The lookup probe's pure half (R-metrics-071, `probe/`): the pool refuses a hole in words, the
 * seeded draw is the same on every desktop, the arms are interleaved and rotated, the leak check
 * voids a reach outside the worktree (memory excepted) or at the key, the correctness gate holds
 * the headline back, and the paired ratio is inside or outside its repeat-noise band.
 *
 *     node --test packages/shared/test/probe.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProbePool, drawProbeQuestions, probeSchedule, probeFinalAnswer, probeCorrect, probeLeakOf,
  analyzeProbe, probeGate, probeEstimate, probeAcceptedCovers, probeFingerprintDiff, probeSourceText,
  agentSourceText, PROBE_POOL_PATH, PROBE_SCHEMA, PROBE_PRIOR_LOG_SD, normalizePosix,
} from "../dist/index.js";

const pool = (n = 30) => ({
  owner: "the repo's maintainers",
  questions: Array.from({ length: n }, (_, i) => ({ id: `q${String(i).padStart(2, "0")}`, q: `question ${i}?`, all: [`answer${i}\\b`] })),
});

test("R-metrics-071 a pool without an owner, with a bad pattern or a duplicate id is refused in words", () => {
  assert.match(parseProbePool({ questions: pool().questions }).refused, /owner/);
  const bad = pool(); bad.questions[3] = { id: "x", q: "?", all: ["(unclosed"] };
  assert.match(parseProbePool(bad).refused, /does not compile/);
  const dup = pool(); dup.questions[1] = { ...dup.questions[0] };
  assert.match(parseProbePool(dup).refused, /used twice/);
  assert.equal(parseProbePool(pool()).pool.questions.length, 30);
  assert.equal(PROBE_POOL_PATH, ".waterplane-shared/probe.json");
});

test("the draw is seeded: same seed same ids, another seed another order, never more than the pool", () => {
  const p = parseProbePool(pool()).pool;
  assert.deepEqual(drawProbeQuestions(p, 7), drawProbeQuestions(p, 7));
  assert.notDeepEqual(drawProbeQuestions(p, 7), drawProbeQuestions(p, 8));
  assert.equal(drawProbeQuestions(p, 7).length, 20);
  assert.equal(new Set(drawProbeQuestions(p, 7)).size, 20);
  assert.equal(drawProbeQuestions(parseProbePool(pool(5)).pool, 1).length, 5);
});

test("R-metrics-071 arms are interleaved per repeat and rotated, so neither always meets the cold cache", () => {
  const s = probeSchedule(["a", "b"], [{ arm: "A", model: "m1" }, { arm: "B", model: "m2" }], 2);
  assert.deepEqual(s.map((x) => `${x.id}${x.arm}${x.rep}`), ["aA1", "aB1", "aB2", "aA2", "bB1", "bA1", "bA2", "bB2"]);
  const firsts = s.filter((_, i) => i % 2 === 0).map((x) => x.arm);
  assert.equal(firsts.filter((a) => a === "A").length, firsts.filter((a) => a === "B").length);
});

test("grading reads the last ANSWER line; a cap hit is wrong; patterns take other spellings", () => {
  assert.equal(probeFinalAnswer("thinking\nANSWER: no\nmore\nANSWER: sidecar.ts (facade)"), "sidecar.ts (facade)");
  assert.equal(probeCorrect("Sidecar.TS", ["\\bsidecar\\.ts"]), true);
  assert.equal(probeCorrect("120 s, ollama cold-loads", ["120", "ollama|cold[- ]?load"]), true);
  assert.equal(probeCorrect("sidecar.ts", ["\\bsidecar\\.ts"], true), false);
  assert.equal(probeCorrect("", ["x"]), false);
});

test("R-metrics-071 leak check: outside the worktree is a leak, memory is the setup, the key is always a leak", () => {
  const scope = { worktrees: ["/tmp/wp-probe-1"], allowed: ["/Users/me/.claude/projects/-Users-me-repo/memory"], home: "/Users/me" };
  assert.equal(probeLeakOf({ name: "Read", input: { file_path: "/tmp/wp-probe-1/src/a.ts" } }, scope), null);
  assert.equal(probeLeakOf({ name: "Grep", input: { pattern: "/api/hook", path: "packages" } }, scope), null);
  assert.equal(probeLeakOf({ name: "Read", input: { file_path: "/Users/me/.claude/projects/-Users-me-repo/memory/x.md" } }, scope), null);
  assert.match(probeLeakOf({ name: "Read", input: { file_path: "/Users/me/repo/src/a.ts" } }, scope), /outside the worktree/);
  assert.match(probeLeakOf({ name: "Grep", input: { pattern: "x", path: "../../Users/me/repo" } }, scope), /outside/);
  assert.match(probeLeakOf({ name: "Glob", input: { pattern: "/Users/me/repo/**/*.ts" } }, scope), /outside/);
  assert.match(probeLeakOf({ name: "Grep", input: { pattern: "sidecar", glob: "**/probe.json" } }, scope), /answer key/);
  assert.match(probeLeakOf({ name: "Read", input: { file_path: "~/.ssh/id" } }, scope), /outside/);
  assert.equal(normalizePosix("/a/b/../../c/./d"), "/c/d");
});

// ── analysis ───────────────────────────────────────────────────────────────

const rec = (arm, rep, id, tok, extra = {}) => ({
  arm, rep, id, correct: true, capHit: false, final: "x", toolCalls: 2, requests: 3,
  tokens: { in: 0, cw: 0, cr: tok, out: 0 }, ms: 1, ...extra,
});
function result(kind, arms, runs, extra = {}) {
  return {
    schema: PROBE_SCHEMA, id: "r1", kind, backend: "claude", desktop: "box", startedAt: 0, commit: "abcdef0123", seed: 1,
    repeats: 3, maxTurns: 12, questions: [...new Set(runs.map((r) => r.id))], arms, fingerprints: {}, runs,
    estimate: { tokens: 1, usd: 1 }, ...extra,
  };
}
const ARMS = [{ arm: "A", model: "claude-sonnet-5-5" }, { arm: "B", model: "claude-opus-5-5" }];
// Per question a base, per repeat a ±small wobble: within-arm log SD ≈ 0.05.
const wob = [0.95, 1, 1.05];
function twoArms(ratio, n = 20, reps = 3) {
  const runs = [];
  for (let q = 0; q < n; q++) for (let r = 0; r < reps; r++) {
    const base = 60_000 + q * 7_000;
    runs.push(rec("A", r + 1, `q${q}`, Math.round(base * wob[r % 3])));
    runs.push(rec("B", r + 1, `q${q}`, Math.round(base * ratio * wob[(r + 1) % 3])));
  }
  return runs;
}

test("R-metrics-071 a 30% step is outside the band, an A/A is inside it", () => {
  const big = analyzeProbe(result("models", ARMS, twoArms(1.3)));
  assert.ok(big.gate.pass);
  assert.equal(big.paired.n, 20);
  assert.ok(Math.abs(big.paired.tokens.ratio - 1.3) < 0.02);
  assert.equal(big.paired.tokens.outside, true);
  assert.equal(big.paired.tokens.bandFromPrior, false);
  const same = analyzeProbe(result("models", ARMS, twoArms(1)));
  assert.equal(same.paired.tokens.outside, false);
  assert.ok(same.lines.some((l) => /inside the ±\d+% repeat noise/.test(l)));
});

test("one repeat per arm takes the pilot's band and says so", () => {
  const a = analyzeProbe(result("models", ARMS, twoArms(1.05, 20, 1), { repeats: 1 }));
  assert.equal(a.paired.tokens.bandFromPrior, true);
  // 1.96 · 0.22 · √2 / √20 ≈ 0.136 on the log scale → ±15%
  assert.ok(Math.abs(a.paired.tokens.band - (Math.exp(1.96 * PROBE_PRIOR_LOG_SD * Math.SQRT2 / Math.sqrt(20)) - 1)) < 1e-9);
  assert.ok(a.lines.some((l) => /the pilot's/.test(l)));
});

test("R-metrics-071 correctness is a gate: an arm under 90% gets no token ratio", () => {
  const runs = twoArms(0.7).map((r) => (r.arm === "B" && Number(r.id.slice(1)) < 5 ? { ...r, correct: false } : r));
  const a = analyzeProbe(result("models", ARMS, runs));
  assert.equal(a.gate.pass, false);
  assert.equal(a.paired, undefined);
  assert.match(a.pairedAbsent, /finds things worse|not compared/);
  assert.equal(probeGate([{ arm: "A", model: "m", runs: 0, correct: 0, capHits: 0, errors: 0 }]).pass, false);
});

test("a run with an error is left out of every figure, never read as zero tokens", () => {
  const runs = twoArms(1.3);
  runs.push(rec("B", 4, "q0", 0, { error: "timed out", tokens: undefined }));
  const a = analyzeProbe(result("models", ARMS, runs));
  assert.equal(a.arms[1].errors, 1);
  assert.equal(a.arms[1].runs, 60);
});

test("R-metrics-071 a leak makes the result void: no figure is read", () => {
  const a = analyzeProbe(result("models", ARMS, twoArms(1.3), { void: "Read reached outside the worktree" }));
  assert.equal(a.paired, undefined);
  assert.match(a.void, /outside/);
});

test("against a baseline: A is the stored before, B the now, and the setup diff is said", () => {
  const before = result("baseline", [{ arm: "A", model: "claude-sonnet-5-5" }], twoArms(1).filter((r) => r.arm === "A"),
    { fingerprints: { A: { backend: "claude", model: "claude-sonnet-5-5", cli: "2.1.325", startTok: 20000, commit: "aaaaaaaa11" } } });
  const nowRuns = twoArms(1.3).filter((r) => r.arm === "B");
  const now = result("against", [{ arm: "B", model: "claude-sonnet-5-5" }], nowRuns,
    { against: "r0", fingerprints: { B: { backend: "claude", model: "claude-sonnet-5-5", cli: "2.1.330", startTok: 28000, commit: "bbbbbbbb22" } } });
  const a = analyzeProbe(now, before);
  assert.equal(a.paired.tokens.outside, true);
  assert.ok(a.lines.some((l) => /differs in: CLI 2\.1\.325 → 2\.1\.330, start context \+\S+ tokens, commit aaaaaaaa → bbbbbbbb/.test(l)));
  assert.match(analyzeProbe(now, null).pairedAbsent, /no longer stored/);
  assert.equal(probeFingerprintDiff(before.fingerprints.A, before.fingerprints.A), "");
});

test("R-metrics-071 the estimate errs high, covers only what was accepted, and says where it comes from", () => {
  const e = probeEstimate(["claude-sonnet-5-5", "claude-opus-5-5"], 20, 3);
  assert.equal(e.runs, 120);
  assert.ok(e.tokens > 120 * 100_000);
  assert.ok(e.usd > 0);
  assert.equal(probeAcceptedCovers({ tokens: e.tokens, usd: e.usd }, e), true);
  assert.equal(probeAcceptedCovers({ tokens: e.tokens - 1, usd: e.usd }, e), false);
  assert.equal(probeAcceptedCovers({ tokens: e.tokens, usd: e.usd - 1 }, e), false);
  assert.equal(probeEstimate(["no-such-model"], 20, 3).usd, null);
  assert.ok(probeSourceText().startsWith(agentSourceText()), "one source sentence, the agent readings' words (R-metrics-069)");
});
