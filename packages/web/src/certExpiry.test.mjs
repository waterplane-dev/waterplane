import test from "node:test";
import assert from "node:assert/strict";
import { certExpiryLine } from "./certExpiry.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const DAY = 86_400_000;
const f = (days) => ({ tlsName: "desk.home.arpa", tlsNameUntil: NOW + days * DAY });

test("says the date and the exact command, only on that hostname and within 30 days", () => {
  const s = certExpiryLine(f(30), "desk.home.arpa", NOW);
  assert.match(s, /ends on 2026-12-24\./);
  assert.match(s, /lan-cert issue --name desk\.home\.arpa/);
  assert.ok(certExpiryLine(f(1), "DESK.home.arpa", NOW));
  assert.equal(certExpiryLine(f(31), "desk.home.arpa", NOW), null, "more than 30 days");
  assert.equal(certExpiryLine(f(10), "100.64.0.1", NOW), null, "another hostname");
  assert.equal(certExpiryLine(f(10), "mac.ts.net", NOW), null);
});

test("absent, wrong or past values show nothing", () => {
  for (const w of [undefined, null, {}, { tlsName: "desk.home.arpa" }, { tlsNameUntil: NOW + DAY },
    { tlsName: 5, tlsNameUntil: NOW + DAY }, { tlsName: "desk.home.arpa", tlsNameUntil: "soon" },
    { tlsName: "desk.home.arpa", tlsNameUntil: NaN }, { tlsName: "", tlsNameUntil: NOW + DAY }, f(-1)]) {
    assert.equal(certExpiryLine(w, "desk.home.arpa", NOW), null);
  }
});
