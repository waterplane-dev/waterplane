// The page's clock follows the demo's (transport.ts `shiftDate`): once a
// scenario's `clock` step jumps ahead, `Date.now()` and `new Date()` on the
// page read the same instant the desktop is at — and never before a jump.
//
//   node --test packages/web/src/demo/clockshift.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@waterplane/shared";
import { createDemoTransport, shiftDate } from "./transport.ts";

test("shiftDate: now and an argument-less Date move; a Date from a value does not; instances stay Dates", () => {
  let by = 0;
  const D = shiftDate(Date, () => by);
  const t = Date.now();
  assert.ok(Math.abs(D.now() - t) < 50);
  by = 3_600_000;
  assert.ok(Math.abs(D.now() - (t + by)) < 50, "Date.now() reads the shift live");
  assert.ok(Math.abs(new D().getTime() - (t + by)) < 50);
  assert.equal(new D(1234).getTime(), 1234, "a value is that value");
  assert.equal(new D(2026, 0, 2).getMonth(), 0);
  assert.ok(new D() instanceof Date && new D() instanceof D);
  assert.equal(D.UTC(2026, 0, 1), Date.UTC(2026, 0, 1));
  assert.equal(typeof D(), "string");
});

test("the transport shifts its target's Date only once a jump happened, and the core is not shifted twice", () => {
  const start = 5_000_000;
  let real = start;
  const FakeDate = shiftDate(Date, () => real - Date.now()); // a pinned page clock, like Playwright's
  const target = { fetch: async () => new Response(""), Date: FakeDate };
  const sc = {
    meta: { id: "cs", protocol: PROTOCOL_VERSION, stamp: "cs1" },
    clock: { start },
    state: { bootId: "b", model: {} },
    script: [{ at: 100, event: { kind: "clock", to: start + 7_200_000 } }],
  };
  const t = createDemoTransport({ scenario: sc, href: "http://phone.test/?demo=cs", target, store: null, tick: false });
  assert.equal(target.Date, FakeDate, "no jump yet: the page's clock is untouched");
  real += 100;
  t.host.advance();
  assert.notEqual(target.Date, FakeDate);
  assert.equal(target.Date.now(), start + 7_200_000, "the page is at the instant the desktop jumped to");
  assert.equal(t.host.clockShift(), 7_200_000 - 100, "the core counted the jump once");
  real += 1_000;
  assert.equal(target.Date.now(), start + 7_201_000, "and time goes on from there");
  t.stop();
});
