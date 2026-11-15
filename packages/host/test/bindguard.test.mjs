/**
 * R-security-002: the daemon never listens on a public interface without the
 * explicit opt-in. The decision is `planBinds`; the CORS half is origin.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planBinds } from "../dist/bindguard.js";

const TS = "100.64.0.1";
const LAN = "192.168.1.20";
const plan = (o) => planBinds({ hostEnv: undefined, ip: TS, allowPublic: false, lanIps: [], ...o });

test("default with a Tailscale IP binds only it and loopback (R-security-002)", () => {
  assert.deepEqual(plan({}), { binds: [TS, "127.0.0.1"], refused: [] });
});

test("no Tailscale IP binds 127.0.0.1 only (R-security-002)", () => {
  assert.deepEqual(plan({ ip: null }).binds, ["127.0.0.1"]);
});

test("lan IPs are not bound without the opt-in even if offered (R-security-002)", () => {
  // main.ts passes [] without the opt-in; a stray list must still not widen it
  // through HOST, which is the other way in.
  assert.deepEqual(plan({ hostEnv: LAN, lanIps: [LAN] }), { binds: ["127.0.0.1"], refused: [LAN] });
});

test("HOST=0.0.0.0 without the opt-in is refused and falls back to loopback (R-security-002)", () => {
  assert.deepEqual(plan({ hostEnv: "0.0.0.0" }), { binds: ["127.0.0.1"], refused: ["0.0.0.0"] });
  assert.deepEqual(plan({ hostEnv: "::" }), { binds: ["127.0.0.1"], refused: ["::"] });
});

test("HOST=a LAN IP without the opt-in is refused (R-security-002)", () => {
  assert.deepEqual(plan({ hostEnv: LAN }), { binds: ["127.0.0.1"], refused: [LAN] });
  assert.deepEqual(plan({ hostEnv: LAN, ip: null }), { binds: ["127.0.0.1"], refused: [LAN] });
});

test("HOST=::1, localhost or the Tailscale IP is allowed (R-security-002)", () => {
  assert.deepEqual(plan({ hostEnv: "::1" }), { binds: ["::1"], refused: [] });
  assert.deepEqual(plan({ hostEnv: "localhost" }), { binds: ["localhost"], refused: [] });
  assert.deepEqual(plan({ hostEnv: TS }), { binds: [TS], refused: [] });
});

test("with the opt-in, 0.0.0.0 and LAN IPs are kept (R-security-002)", () => {
  assert.deepEqual(plan({ hostEnv: "0.0.0.0", allowPublic: true }), { binds: ["0.0.0.0"], refused: [] });
  assert.deepEqual(plan({ allowPublic: true, lanIps: [LAN] }), { binds: [TS, "127.0.0.1", LAN], refused: [] });
});
