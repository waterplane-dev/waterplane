// `shared/src/wire/messages.ts`'s `isClientFrame`: the one shape check the host
// makes on a decoded WebSocket frame before dispatch. A frame that is not an
// object with a string `t` used to throw at `msg.t`; an unknown `t` must stay a
// frame (the wire is versioned — the router ignores it, it is not an error).
import test from "node:test";
import assert from "node:assert/strict";
import { decode, isClientFrame } from "../dist/index.js";

test("an object with a string t is a frame — known or not", () => {
  assert.equal(isClientFrame({ t: "hello" }), true);
  assert.equal(isClientFrame({ t: "session.input", id: "x", data: "y" }), true);
  assert.equal(isClientFrame({ t: "from.a.newer.client" }), true, "unknown t is the router's no-op, not a shape error");
  assert.equal(isClientFrame({ t: "__proto__" }), true, "the shape is fine; the ROUTER must not resolve it off the prototype");
  assert.equal(isClientFrame(decode('{"t":"ping","extra":[1,2]}')), true);
});

test("anything else is not a frame, and checking never throws", () => {
  for (const x of [null, undefined, "hello", 42, true, [], [{ t: "hello" }], {}, { t: 1 }, { t: null }, { t: { x: 1 } }, { type: "hello" }]) {
    assert.equal(isClientFrame(x), false, JSON.stringify(x) ?? String(x));
  }
  assert.equal(isClientFrame(decode("null")), false);
  assert.equal(isClientFrame(decode('"a string"')), false);
});
