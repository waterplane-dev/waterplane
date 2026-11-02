/**
 * Property tests (fast-check) over shared's pure parsers and maths. Fixed seed and capped runs:
 * deterministic, and the whole file runs in about a second. A counterexample here is a real input
 * the code mishandles, so keep the seed and shrink it into a normal test when one appears.
 * (`.js`, not `.mjs`, on purpose: OpenSSF Scorecard's Fuzzing check scans only js/ts files.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  PAIR_ALPHABET, PAIR_CODE_LEN, newPairCode, normalizePairCode, formatPairCode,
  pairDeepLink, parsePairDeepLink, parsePairInput, pairLandingUrl,
  normalizeHostBase, wsUrlFor, cleanBudget, cleanPeriods, periodBounds,
  spent, linearPace, perDayLeft, projectedEnd,
  cleanHeadline, cleanTabTitle, cleanCommitMessage,
} from "../dist/index.js";

const RUNS = { seed: 42, numRuns: 200 };
const anything = fc.anything();
const code = fc.array(fc.constantFrom(...PAIR_ALPHABET), { minLength: PAIR_CODE_LEN, maxLength: PAIR_CODE_LEN }).map((a) => a.join(""));
const ok = (n) => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);

test("pair code: format then normalize is identity, case and spacing forgiven", () => {
  fc.assert(fc.property(code, (c) => {
    assert.equal(normalizePairCode(formatPairCode(c)), c);
    assert.equal(normalizePairCode(` ${c.toLowerCase()} `), c);
  }), RUNS);
  assert.match(newPairCode(), new RegExp(`^[${PAIR_ALPHABET}]{${PAIR_CODE_LEN}}$`));
});

test("pair parsers never throw on any input and only return well-formed targets", () => {
  fc.assert(fc.property(anything, (raw) => {
    assert.ok(normalizePairCode(raw) === null || normalizePairCode(raw).length === PAIR_CODE_LEN);
    for (const f of [parsePairDeepLink, parsePairInput]) {
      const t = f(raw);
      if (t !== null) {
        assert.equal(typeof t.base, "string");
        assert.equal(normalizePairCode(t.code), t.code);
      }
    }
  }), RUNS);
  fc.assert(fc.property(fc.string(), fc.string(), (a, b) => { parsePairDeepLink(a + b); parsePairInput(b + a); }), RUNS);
});

test("pair deep link round-trips base and code", () => {
  fc.assert(fc.property(fc.webUrl({ validSchemes: ["http", "https"], withQueryParameters: false, withFragments: false }), code, (base, c) => {
    const t = parsePairDeepLink(pairDeepLink(base, c));
    assert.ok(t, pairDeepLink(base, c));
    assert.equal(t.code, c);
    assert.equal(t.base, normalizeHostBase(base)); // the parser normalises (adds the default port)
    assert.ok(pairLandingUrl(base, c).endsWith(`/pair/${c}`));
  }), RUNS);
});

test("normalizeHostBase: only http(s) bases, idempotent, never throws; wsUrlFor maps scheme", () => {
  fc.assert(fc.property(fc.oneof(fc.string(), fc.webUrl(), fc.domain(), fc.ipV6(), fc.ipV4()), (raw) => {
    const b = normalizeHostBase(raw);
    if (b === null) return;
    assert.match(b, /^https?:\/\//);
    assert.equal(normalizeHostBase(b), b);
    const ws = wsUrlFor(b);
    assert.match(ws, /^wss?:\/\//);
    assert.equal(ws.replace(/^ws/, "http").replace(/\/ws$/, ""), b);
  }), RUNS);
  for (const evil of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://h"]) assert.equal(normalizeHostBase(evil), null);
});

test("cleanBudget / cleanPeriods swallow arbitrary JSON and stay idempotent", () => {
  fc.assert(fc.property(anything, (raw) => {
    const b = cleanBudget(raw);
    assert.equal(typeof b, "object");
    assert.deepEqual(cleanBudget(JSON.parse(JSON.stringify(b))), b);
    const p = cleanPeriods(raw);
    assert.ok(Array.isArray(p));
  }), RUNS);
});

test("period maths: spent/pace/per-day/projection are null or finite and non-negative", () => {
  const t = fc.double({ min: 0, max: 4e12, noNaN: true });
  const n = fc.oneof(t, fc.constant(NaN), fc.constant(Infinity), fc.constant(null), fc.double());
  fc.assert(fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), n, n, n, (max, start, reset, now) => {
    for (const v of [
      linearPace(max, start, reset, now),
      perDayLeft(max, max / 2, reset, now),
      projectedEnd(max / 2, start, reset, now),
    ]) assert.ok(ok(v), String(v));
    const p = linearPace(max, start, reset, now);
    if (p !== null) assert.ok(p <= max);
  }), RUNS);
  fc.assert(fc.property(fc.array(fc.record({ at: n, usd: n })), n, n, (s, a, b) => {
    const v = spent(s, a, b);
    assert.ok(v === null || typeof v === "number");
  }), RUNS);
});

test("periodBounds: calendar periods bracket now and reset after start (DST-safe)", () => {
  const zone = fc.constantFrom("UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe");
  fc.assert(fc.property(zone, fc.constantFrom("day", "week", "month"), fc.integer({ min: 1, max: 31 }), fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1.5e12, max: 2.2e12 }), (tz, cycle, anchorDay, startDow, now) => {
    const b = periodBounds({ id: "x", kind: "calendar", unit: "usd", cycle, anchorDay, startDow, tz }, now);
    assert.ok(b.active);
    assert.ok(b.start <= now && now < b.resetAt, JSON.stringify({ tz, cycle, anchorDay, startDow, now, b }));
  }), RUNS);
});

test("naming cleaners never throw on anything and return trimmed non-empty strings or undefined", () => {
  fc.assert(fc.property(anything, fc.string(), (raw, text) => {
    for (const v of [cleanHeadline(raw, text), cleanTabTitle(raw), cleanCommitMessage(raw)]) {
      assert.ok(v === undefined || (typeof v === "string" && v.length > 0 && v === v.trim()), JSON.stringify(v));
    }
  }), RUNS);
});
