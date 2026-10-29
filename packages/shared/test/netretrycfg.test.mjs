// The network-error retry switch's shared half (`netretrycfg.ts`, R-connection-025).
import { test } from "node:test";
import assert from "node:assert/strict";
import { netRetryEffective, netRetryEnvOffText, netRetryToggleText } from "../dist/index.js";

test("the env override wins over a saved on", () => {
  assert.equal(netRetryEffective({ enabled: true }), true);
  assert.equal(netRetryEffective({ enabled: false }), false);
  assert.equal(netRetryEffective({ enabled: true, envOff: true }), false);
});

test("the env sentence names the knob and the way out", () => {
  const t = netRetryEnvOffText();
  assert.match(t, /WATERPLANE_NET_RETRY=0/);
  assert.match(t, /restart/);
});

test("a tap's receipt says what happened, and that the env still wins", () => {
  assert.match(netRetryToggleText(false), /cancelled/);
  assert.match(netRetryToggleText(true), /on$/);
  assert.match(netRetryToggleText(true, true), /^saved on — still off/);
});
