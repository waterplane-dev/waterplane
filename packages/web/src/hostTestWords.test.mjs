import test from "node:test";
import assert from "node:assert/strict";

import { lanHttpsFix, lanTestWords, lanTlsLine, routeCardTag, routeNowWords, staleLanOffer, tailnetOkWords } from "./hostTestWords.ts";

test("the tailnet test names how long it took and which folder the desktop serves", () => {
  assert.equal(tailnetOkWords(123.4, "/Users/me/dev"), "Reached in 123 ms: the desktop serving /Users/me/dev.");
});

test("a Wi-Fi test tells proven, impostor, unchecked and silent apart", () => {
  assert.equal(lanTestWords({ s: "ok", ms: 40, proven: true }).tone, "ok");
  assert.match(lanTestWords({ s: "ok", ms: 40, proven: false }).text, /not this desktop/);
  assert.match(lanTestWords({ s: "ok", ms: 40, proven: null }).text, /switch to this desktop to check/);
  assert.match(lanTestWords({ s: "bad", aborted: true }).text, /address may have changed/);
});

test("a stale Wi-Fi address is met with the one the desktop reports now", () => {
  const bad = { s: "bad", aborted: true };
  assert.equal(staleLanOffer("http://192.168.0.62:8770", bad, ["192.168.0.64"]), "192.168.0.64");
  assert.equal(staleLanOffer("http://192.168.0.62:8770", bad, ["192.168.0.62"]), null, "same address: nothing to offer");
  assert.equal(staleLanOffer("http://192.168.0.62:8770", { s: "ok", ms: 5, proven: true }, ["192.168.0.64"]), null, "a proven address is not stale");
  assert.equal(staleLanOffer("http://192.168.0.62:8770", null, ["192.168.0.64"]), "192.168.0.64", "untested: offered before the test too");
  assert.equal(staleLanOffer(null, null, ["192.168.0.64"]), null, "an empty field has its own chips");
});

test("the same IP typed with https or another port is not offered as a stale address", () => {
  assert.equal(staleLanOffer("https://192.168.0.64:8770", { s: "bad", aborted: false }, ["192.168.0.64"]), null);
});

test("a Wi-Fi address typed as https to an IP is offered as the bare IP; a name or plain address is left alone", () => {
  assert.equal(lanHttpsFix("https://192.168.0.64:8770"), "192.168.0.64");
  assert.equal(lanHttpsFix("https://192.168.0.64:8771"), "192.168.0.64");
  assert.equal(lanHttpsFix("http://192.168.0.64:8770"), null);
  assert.equal(lanHttpsFix("https://desk.home.example"), null);
  assert.equal(lanHttpsFix(null), null);
});

test("the Wi-Fi encryption line tells an old APK, a key not learned yet and a pinned key apart", () => {
  const spki = "ab".repeat(32);
  const base = { lanBase: "http://192.168.0.64:8770", shell: true };
  assert.match(lanTlsLine({ ...base, enforcing: false }).text, /newest APK/);
  assert.match(lanTlsLine({ ...base, enforcing: true }).text, /next time it connects to it over Tailscale/);
  const ok = lanTlsLine({ ...base, enforcing: true, tls: { port: 8771, spki } });
  assert.equal(ok.tone, "ok");
  assert.match(ok.text, /port 8771/);
  assert.match(ok.text, /abababababababab…/);
  assert.equal(lanTlsLine({ ...base, enforcing: true, tls: { port: 8771, spki }, tlsOff: true }), null, "the shield says plain HTTP");
  assert.equal(lanTlsLine({ ...base, shell: false, enforcing: false }), null, "a browser cannot pin and is not told to");
  assert.equal(lanTlsLine({ ...base, lanBase: "https://192.168.0.64:8770", enforcing: true }), null, "the https fix speaks first");
  assert.equal(lanTlsLine({ ...base, lanBase: null, enforcing: true }), null);
});

test("the Edit screen says which address is in use, whether it answers, and why", () => {
  const base = { active: true, status: "connecting", lastSeenAgo: "3m", dial: "https://tailnet-name.ts.net:8771" };
  const w = routeNowWords({ ...base, route: { route: "tailnet", sentence: "Using the tailnet: not on a listed Wi-Fi." } });
  assert.equal(w.via, "tailnet");
  assert.equal(w.head, "In use: tailnet address");
  assert.equal(w.state, "connecting… last heard 3m ago");
  assert.equal(w.dial, "https://tailnet-name.ts.net:8771");
  assert.equal(routeNowWords({ ...base, saved: base.dial, route: null }).dial, null, "the field below already shows the saved address");
  assert.equal(routeNowWords({ ...base, lastSeenAgo: "0s", status: "closed", route: null }).state, "not connected — dropped seconds ago");
  assert.equal(w.tone, "warn");
  assert.match(w.why, /not on a listed Wi-Fi/);
  assert.equal(routeNowWords({ ...base, status: "open", route: { route: "lan", sentence: "s" } }).head, "In use: home Wi-Fi address");
  assert.equal(routeNowWords({ ...base, route: null }).via, null, "undecided is said, never guessed");
  assert.equal(routeNowWords({ ...base, active: false, route: null }).head, "Not in use");
});

test("each address card is tagged in use, fallback, standby or off — and says why it is off", () => {
  const f = { active: true, route: "tailnet", hasLan: true, auto: true, ssids: 0 };
  assert.deepEqual(routeCardTag("tailnet", f), { text: "in use", inUse: true });
  assert.equal(routeCardTag("lan", f).text, "waiting for a Wi-Fi name");
  assert.equal(routeCardTag("lan", { ...f, auto: false }).text, "off");
  assert.equal(routeCardTag("lan", { ...f, ssids: 1 }).text, "standby");
  assert.deepEqual(routeCardTag("lan", { ...f, route: "lan" }), { text: "in use", inUse: true });
  assert.equal(routeCardTag("tailnet", { ...f, route: "lan" }).text, "fallback");
  assert.equal(routeCardTag("tailnet", { ...f, active: false }), null);
  assert.equal(routeCardTag("lan", { ...f, hasLan: false }), null);
});
