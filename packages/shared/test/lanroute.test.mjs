// LAN or tailnet (`shared/src/lanroute.ts`): three gates ANDed, and every
// missing piece of evidence means the tailnet.
import test from "node:test";
import assert from "node:assert/strict";
import { LAN_PROBE_TIMEOUT_MS, decideLanRoute, lanRouteLabel, ssidMatches } from "../dist/index.js";

const lan = { base: "http://192.168.1.2:8770", ssids: ["Home"], auto: true };
const host = { lan };
const wifi = { transport: "wifi", ssid: "Home", permission: "granted" };
const good = { host, net: wifi, probe: { ok: true, ms: 40, at: 10 }, macVerified: true, lastFailure: null };

test("all three gates pass ⇒ LAN, with the measured time in the sentence", () => {
  const d = decideLanRoute(good);
  assert.equal(d.route, "lan");
  assert.equal(d.reason, "lan-ok");
  assert.match(d.sentence, /"Home".*in 40 ms/);
  assert.equal(lanRouteLabel(d.route), "LAN");
});

test("every gate combination: LAN only when SSID ∧ probe ∧ MAC", () => {
  for (const ssidOk of [true, false])
    for (const probeOk of [true, false])
      for (const macOk of [true, false]) {
        const d = decideLanRoute({
          ...good,
          net: { ...wifi, ssid: ssidOk ? "Home" : "Cafe" },
          probe: { ok: probeOk, ms: 40, at: 10 },
          macVerified: macOk,
        });
        assert.equal(d.route, ssidOk && probeOk && macOk ? "lan" : "tailnet", `${ssidOk} ${probeOk} ${macOk}`);
        assert.ok(d.sentence.length > 0);
      }
});

test("each missing precondition names itself", () => {
  const cases = [
    [{ host: {} }, "no-lan"],
    [{ host: { lan: { ...lan, auto: false } } }, "auto-off"],
    [{ net: null }, "no-net"],
    [{ net: { ...wifi, transport: "cellular" } }, "not-wifi"],
    [{ net: { ...wifi, transport: "none" } }, "not-wifi"],
    [{ net: { ...wifi, permission: "denied" } }, "no-permission"],
    [{ net: { ...wifi, permission: "prompt" } }, "no-permission"],
    [{ net: { ...wifi, ssid: null } }, "no-ssid"],
    [{ net: { ...wifi, ssid: "home" } }, "ssid-mismatch"],
    [{ probe: null }, "probe-pending"],
    [{ probe: { ok: false, at: 10 } }, "probe-failed"],
    [{ probe: { ok: true, ms: LAN_PROBE_TIMEOUT_MS + 1, at: 10 } }, "probe-slow"],
    [{ macVerified: null }, "mac-pending"],
    [{ macVerified: false }, "mac-failed"],
  ];
  for (const [patch, reason] of cases) {
    const d = decideLanRoute({ ...good, ...patch });
    assert.equal(d.route, "tailnet", reason);
    assert.equal(d.reason, reason);
  }
  assert.equal(decideLanRoute({ ...good, probe: null }).next, "probe");
  assert.equal(decideLanRoute({ ...good, macVerified: null }).next, "verify");
});

test("a failure newer than the probe holds the tailnet; a newer probe lifts it", () => {
  const failed = decideLanRoute({ ...good, lastFailure: { at: 20, reason: "socket closed" } });
  assert.equal(failed.reason, "failed-recently");
  assert.match(failed.sentence, /socket closed/);
  const reprobed = decideLanRoute({ ...good, probe: { ok: true, ms: 30, at: 30 }, lastFailure: { at: 20 } });
  assert.equal(reprobed.route, "lan");
});

test("an unmeasured probe time is left out, never guessed", () => {
  const d = decideLanRoute({ ...good, probe: { ok: true, at: 10 } });
  assert.equal(d.route, "lan");
  assert.doesNotMatch(d.sentence, /ms/);
});

test("ssidMatches is exact", () => {
  assert.ok(ssidMatches(host, "Home"));
  assert.ok(!ssidMatches(host, "home"));
  assert.ok(!ssidMatches(host, null));
  assert.ok(!ssidMatches({}, "Home"));
});
