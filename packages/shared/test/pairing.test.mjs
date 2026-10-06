// Pairing codes and links (`shared/src/pairing.ts`). The base inside a link
// is fed to fetch, so it passes the same scheme allowlist as a typed one.
import test from "node:test";
import { PAIR_SCHEME, LEGACY_PAIR_SCHEMES } from "../dist/pairing.js";
import assert from "node:assert/strict";
import {
  PAIR_ALPHABET, PAIR_CODE_LEN, PAIR_TTL_MS, formatPairCode, newPairCode, normalizePairCode, pairDeepLink,
  pairExpired, pairLandingUrl, pairPathCode, pairRedeemErrorText, parsePairDeepLink, parsePairInput,
  parsePairLandingUrl,
} from "../dist/index.js";

test("the alphabet has no look-alikes and the code is 8 of it", () => {
  for (const ch of "01OI") assert.ok(!PAIR_ALPHABET.includes(ch));
  assert.equal(PAIR_ALPHABET.length, 32);
  assert.equal(PAIR_TTL_MS, 600_000);
  for (let i = 0; i < 50; i++) {
    const c = newPairCode();
    assert.equal(c.length, PAIR_CODE_LEN);
    assert.equal(normalizePairCode(c), c);
  }
});

test("a typed code forgives case, spaces and dashes, and nothing else", () => {
  assert.equal(normalizePairCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizePairCode(" ab cd ef gh "), "ABCDEFGH");
  assert.equal(formatPairCode("ABCDEFGH"), "ABCD-EFGH");
  for (const bad of ["ABCDEFG", "ABCDEFGHJ", "ABCD0FGH", "ABCDOFGH", "ABCD1FGH", "ABCDIFGH", "ABCD_FGH", "", null, 12345678]) {
    assert.equal(normalizePairCode(bad), null, String(bad));
  }
});

test("deep link and landing URL round-trip", () => {
  const base = "https://desk.tail1234.ts.net";
  const code = "ABCDEFGH";
  const dl = pairDeepLink(base, code);
  assert.equal(dl, `${PAIR_SCHEME}://pair?u=https%3A%2F%2Fdesk.tail1234.ts.net&c=ABCDEFGH`);
  assert.deepEqual(parsePairDeepLink(dl), { base, code });
  const land = pairLandingUrl(base, code);
  assert.equal(land, "https://desk.tail1234.ts.net/pair/ABCDEFGH");
  assert.deepEqual(parsePairLandingUrl(land), { base, code });
  assert.deepEqual(parsePairInput(dl), { base, code });
  assert.deepEqual(parsePairInput(land), { base, code });
  const plain = "http://100.64.0.5:8770";
  assert.deepEqual(parsePairInput(pairLandingUrl(plain, code)), { base: plain, code });
  assert.deepEqual(parsePairInput(pairDeepLink(plain, code)), { base: plain, code });
});

test("garbage is refused", () => {
  for (const bad of [
    "", null, "hello", `${PAIR_SCHEME}://pair`, `${PAIR_SCHEME}://pair?u=javascript%3Aalert(1)&c=ABCDEFGH`,
    `${PAIR_SCHEME}://pair?u=https%3A%2F%2Fx&c=ABC`, `${PAIR_SCHEME}://other?u=https%3A%2F%2Fx&c=ABCDEFGH`,
    "https://x/pair/", "https://x/pair/ABCDEFGH/apk", "https://x/notpair/ABCDEFGH", "ftp://x/pair/ABCDEFGH",
    "javascript:alert(1)//pair/ABCDEFGH", "https://x/pair/%E0%A4%A",
  ]) {
    assert.equal(parsePairInput(bad), null, String(bad));
  }
});

test("landing paths: page and apk", () => {
  assert.deepEqual(pairPathCode("/pair/ABCDEFGH"), { code: "ABCDEFGH", apk: false });
  assert.deepEqual(pairPathCode("/pair/abcd-efgh/apk"), { code: "ABCDEFGH", apk: true });
  assert.equal(pairPathCode("/pair/ABCDEFGH/x"), null);
  assert.equal(pairPathCode("/pair/../etc"), null);
});

test("expiry and error words", () => {
  assert.ok(!pairExpired(1000, 999));
  assert.ok(pairExpired(1000, 1000));
  for (const e of ["bad-request", "unknown", "expired", "used", "rate-limited", "no-password"]) assert.ok(pairRedeemErrorText(e).length > 0);
});

test("a legacy scheme still parses, and is never emitted", () => {
  const base = "https://desk.tail1234.ts.net";
  for (const old of LEGACY_PAIR_SCHEMES) {
    assert.deepEqual(parsePairDeepLink(`${old}://pair?u=${encodeURIComponent(base)}&c=ABCDEFGH`), { base, code: "ABCDEFGH" });
    assert.ok(!pairDeepLink(base, "ABCDEFGH").startsWith(`${old}://`));
  }
});
