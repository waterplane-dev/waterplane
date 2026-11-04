/**
 * The first network reading. Every rule that says "a tailnet name proves nothing with Tailscale off"
 * rests on it, and it could be lost at boot: a `current()` later than the seed's fuse was dropped and
 * the shell's first push can land before the page listens, so the phone ran on names all session and
 * a relay on the Wi-Fi read the token and replaced the pin. Each case loads its own copy of the module.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lsKey } from "@waterplane/shared";
import { welcomePinPlan } from "./lanRoute.ts";

const SAVED = "http://100.64.0.5:8770";
const LAN = "http://192.168.1.20:8770";
const SPKI = "a".repeat(64);
const OFF = { transport: "wifi", ssid: null, permission: "denied", tailnet: false };
const ON = { transport: "wifi", ssid: null, permission: "denied", tailnet: true };
const WELCOME = { hostId: "desk5678", tlsPort: 8771, tlsSpki: SPKI };

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window = new EventTarget();
globalThis.location = new URL("http://localhost/");

let copy = 0;
/** A cold start: a fresh module, a saved tailnet row, and a shell made of `plugins`. */
async function boot(t, plugins, row = { id: "d1", base: SAVED, label: "desk" }) {
  store.clear();
  store.set(lsKey("hosts"), JSON.stringify([row]));
  store.set(lsKey("hostActive"), row.id);
  store.set(lsKey("hostBase"), row.base);
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: plugins };
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  return import(`./hostUrl.ts?cold=${++copy}`);
}

const TLS = { setPin: async () => {} };
const NEW_SHELL = (current) => ({ ShellTls: TLS, ShellNet: { current } });
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
/** The seed past its fuse, as `main.tsx` waits for it. */
async function seedPastFuse(h) {
  const seeded = h.seedRouteNet();
  await settle();
  mock.timers.tick(500);
  await seeded;
  await settle();
}
const hang = () => new Promise(() => {});
function answerLater() {
  let answer;
  const asked = new Promise((done) => { answer = done; });
  return { current: () => asked, answer };
}
const push = (s) => window.dispatchEvent(new CustomEvent("app:shell-net", { detail: s }));

test("an answer later than the seed's fuse is kept", async (t) => {
  const late = answerLater();
  const h = await boot(t, NEW_SHELL(late.current));
  await seedPastFuse(h);
  assert.equal(h.netOwedNow(), true);
  assert.equal(h.plainBaseNow(SAVED), false, "no reading yet: the name still decides the route");
  late.answer(OFF);
  await settle();
  assert.equal(h.netOwedNow(), false);
  assert.equal(h.plainBaseNow(SAVED), true);
});

test("a shell that did not answer is asked again, further apart", async (t) => {
  let asks = 0;
  const h = await boot(t, NEW_SHELL(() => { asks++; return asks < 3 ? hang() : Promise.resolve(OFF); }));
  await seedPastFuse(h);
  assert.equal(asks, 2, "the seed's own ask, and the first again as its fuse runs out");
  mock.timers.tick(999);
  await settle();
  assert.equal(asks, 2);
  assert.equal(h.netOwedNow(), true);
  mock.timers.tick(1);
  await settle();
  assert.equal(asks, 3);
  assert.equal(h.netOwedNow(), false);
  assert.equal(h.plainBaseNow(SAVED), true);
  mock.timers.tick(60_000);
  await settle();
  assert.equal(asks, 3, "a reading in hand stops the asking");
});

test("a push counts as the reading", async (t) => {
  const h = await boot(t, NEW_SHELL(hang));
  await seedPastFuse(h);
  let ran = 0;
  h.whenNetRead(() => { ran++; });
  push(OFF);
  assert.equal(ran, 1);
  assert.equal(h.netOwedNow(), false);
});

test("until the reading the token stays on the phone on a tailnet address, and rides once it says so", async (t) => {
  const late = answerLater();
  const h = await boot(t, NEW_SHELL(late.current));
  await seedPastFuse(h);
  assert.equal(h.tokenWithheld(SAVED), true);
  assert.equal(h.tokenWithheld(LAN), false, "a plain LAN address on an unpinned row is the opt-in");
  assert.equal(h.tokenWithheld("http://127.0.0.1:8770"), false);
  late.answer(ON);
  await settle();
  assert.equal(h.tokenWithheld(SAVED), false, "Tailscale really on: as ever");
});

test("no reading yet is the token's word alone: an unknown is still not off for the route", async (t) => {
  const h = await boot(t, NEW_SHELL(hang));
  await seedPastFuse(h);
  assert.equal(h.plainHostRoute(), false);
  assert.equal(h.plainBaseNow(SAVED), false);
});

test("a welcome before the reading teaches nothing, and is judged on its own dial once it is in", async (t) => {
  const row = { base: SAVED };
  for (const [reading, plan] of [[OFF, null], [ON, { hostId: "desk5678", tls: { port: 8771, spki: SPKI } }]]) {
    const late = answerLater();
    const h = await boot(t, NEW_SHELL(late.current));
    await seedPastFuse(h);
    const dialled = h.baseOfDial("ws://100.64.0.5:8770/ws");
    const out = [];
    h.whenNetRead(() => out.push(welcomePinPlan(row, WELCOME, !!dialled && !h.plainBaseNow(dialled))));
    assert.deepEqual(out, [], "deferred");
    late.answer(reading);
    await settle();
    assert.deepEqual(out, [plan]);
    mock.timers.reset();
  }
});

test("with a reading in hand a welcome is judged at once", async (t) => {
  const h = await boot(t, NEW_SHELL(async () => ON));
  await h.seedRouteNet();
  let ran = 0;
  h.whenNetRead(() => { ran++; });
  assert.equal(ran, 1);
});

test("a shell that never answers degrades to the name, and nobody stays out", async (t) => {
  const h = await boot(t, NEW_SHELL(hang));
  await seedPastFuse(h);
  let ran = 0;
  h.whenNetRead(() => { ran++; });
  assert.equal(h.tokenWithheld(SAVED), true);
  for (let ms = 0; ms < 7400; ms += 100) { mock.timers.tick(100); await settle(); }
  assert.equal(h.tokenWithheld(SAVED), true, "still inside the 8 s");
  assert.equal(ran, 0);
  for (let ms = 0; ms < 200; ms += 100) { mock.timers.tick(100); await settle(); }
  assert.equal(h.netOwedNow(), false);
  assert.equal(h.tokenWithheld(SAVED), false, "today's behaviour");
  assert.equal(ran, 1);
});

test("a shell that answers with no reading at all is one that never answers", async (t) => {
  const h = await boot(t, NEW_SHELL(async () => ({ nonsense: true })));
  await h.seedRouteNet().catch(() => {});
  assert.equal(h.netOwedNow(), true);
  for (let ms = 0; ms < 8000; ms += 100) { mock.timers.tick(100); await settle(); }
  assert.equal(h.netOwedNow(), false);
});

test("a reading after the wait is still kept", async (t) => {
  const late = answerLater();
  const h = await boot(t, NEW_SHELL(late.current));
  await seedPastFuse(h);
  for (let ms = 0; ms < 8000; ms += 100) { mock.timers.tick(100); await settle(); }
  assert.equal(h.tokenWithheld(SAVED), false);
  late.answer(OFF);
  await settle();
  assert.equal(h.tokenWithheld(SAVED), true);
});

test("a reading with no `tailnet` settles it as unknown, never as off", async (t) => {
  const h = await boot(t, NEW_SHELL(async () => ({ transport: "wifi", ssid: null, permission: "denied" })));
  await h.seedRouteNet();
  assert.equal(h.netOwedNow(), false);
  assert.equal(h.tokenWithheld(SAVED), false);
  assert.equal(h.plainBaseNow(SAVED), false);
});

test("a shipped APK owes nothing: no ShellNet, or ShellNet with no ShellTls", async (t) => {
  for (const plugins of [{}, { ShellTls: TLS }, { ShellNet: { current: hang } }]) {
    const h = await boot(t, plugins);
    const seeded = h.seedRouteNet();
    await settle();
    mock.timers.tick(500);
    await seeded;
    assert.equal(h.netOwedNow(), false, JSON.stringify(Object.keys(plugins)));
    assert.equal(h.tokenWithheld(SAVED), false);
    let ran = 0;
    h.whenNetRead(() => { ran++; });
    assert.equal(ran, 1, "a welcome is judged at once, as ever");
    mock.timers.reset();
  }
});

test("a passive phone keeps its token while the reading is owed: with none it would forget it is passive", async (t) => {
  const h = await boot(t, NEW_SHELL(hang));
  await seedPastFuse(h);
  store.set(lsKey("passive"), "1");
  assert.equal(h.tokenWithheld(SAVED), false);
});

test("what a welcome teaches waits for the reading, its dial read before the wait", () => {
  const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const lan = src("./lanLink.ts");
  const learn = lan.slice(lan.indexOf("const learnPins ="), lan.indexOf("dropToTailnet ="));
  assert.ok(learn.indexOf("baseOfDial(conn.dialUrl)") >= 0 && learn.indexOf("baseOfDial(conn.dialUrl)") < learn.indexOf("whenNetRead("));
  assert.match(lan, /netOwedNow\(\) \|\| plainBaseNow\(saved\)/, "the identity is the secret the LAN proof rests on");
  assert.match(lan, /conn\.tokenHeld && !tokenWithheld\(baseOfDial\(conn\.dialUrl\)\)/, "a socket that left the token behind gets it back");
  assert.match(src("./ws.ts"), /this\.heldToken = withheld && !!deviceToken\(\);/);
  const up = src("./webUpdate.ts");
  const note = up.slice(up.indexOf("noteWelcome(msg:"), up.indexOf("trust.offer("));
  assert.ok(note.indexOf("baseOfDial(dialUrl)") < note.indexOf("whenNetRead("), "an update key is a pin too");
  assert.ok(note.indexOf("whenNetRead(") >= 0 && note.indexOf("whenNetRead(") < note.indexOf("plainInShell(base)"));
});
