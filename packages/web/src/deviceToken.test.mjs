import test from "node:test";
import assert from "node:assert/strict";

import { BRAND } from "@waterplane/shared";
import { bearerFor, pickDeviceName, wsProtocols } from "./deviceToken.ts";

const TOK = "AbCdEf0123456789_-AbCdEf0123456789_-abcdefg";

test("the bearer goes to the host base in force and nowhere else", () => {
  const base = "http://100.64.0.5:8770";
  assert.equal(bearerFor(`${base}/api/repos`, base, TOK), `Bearer ${TOK}`);
  assert.equal(bearerFor("http://100.64.0.5:8770/api/x?y=1", `${base}/`, TOK), `Bearer ${TOK}`);
  assert.equal(bearerFor("http://100.64.0.5:9999/api/repos", base, TOK), null, "another port is another origin");
  assert.equal(bearerFor("https://100.64.0.5:8770/api/repos", base, TOK), null, "another scheme");
  assert.equal(bearerFor("http://192.168.1.20:8770/api/lan/verify", base, TOK), null, "the LAN address while it is being verified");
  assert.equal(bearerFor("https://example.com/api/repos", base, TOK), null, "a third party");
  assert.equal(bearerFor("/api/repos", base, TOK), null, "an unresolved path is not the host");
  assert.equal(bearerFor(`${base}/api/repos`, null, TOK), null, "no host base");
  assert.equal(bearerFor(`${base}/api/repos`, base, null), null, "no token");
});

test("once the LAN is the route, the bearer follows it there — and stops going to the tailnet address", () => {
  const lan = "http://192.168.1.20:8770";
  assert.equal(bearerFor(`${lan}/api/repos`, lan, TOK), `Bearer ${TOK}`);
  assert.equal(bearerFor("http://100.64.0.5:8770/api/repos", lan, TOK), null);
});

test("the socket offers the token as a SECOND subprotocol, and nothing without one", () => {
  assert.deepEqual(wsProtocols(TOK), [BRAND.wsProtocol, `${BRAND.wsProtocol}-tok.${TOK}`]);
  assert.equal(wsProtocols(null), undefined);
});

test("the device name is never blank", () => {
  assert.equal(pickDeviceName("  My phone ", "Pixel 8"), "My phone");
  assert.equal(pickDeviceName("", "Pixel 8"), "Pixel 8");
  assert.equal(pickDeviceName("", ""), "Android phone");
  assert.equal(pickDeviceName("x".repeat(80), "").length, 60);
});
