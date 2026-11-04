/**
 * `hostUrl.ts` in the Android shell, with the LAN route in force: the OPAQUE
 * loads — `abs()` (an `<img src>`, Background Fetch, the native download
 * service) and `sendBeacon` — carry no bearer and so must go to the SAVED
 * (tailnet) address, while fetch/XHR follow the route. On the LAN every
 * `/api/*` is token-gated, so an opaque load there is a 401.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lsKey } from "@waterplane/shared";

const SAVED = "http://100.64.0.5:8770";
const LAN = "http://192.168.1.20:8770";

// The shell's globals, before the module is evaluated.
const store = new Map([[lsKey("hostBase"), SAVED]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.Capacitor = { isNativePlatform: () => true };
globalThis.location = new URL("http://localhost/");
const fetched = [];
const fetchInits = [];
let answer = 200;
globalThis.fetch = async (input, init) => { fetched.push(String(input)); fetchInits.push(init); return new Response("{}", { status: answer }); };
globalThis.XMLHttpRequest = class { open() {} setRequestHeader() {} addEventListener() {} };
const beacons = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { sendBeacon: (url) => { beacons.push(String(url)); return true; } },
});

const {
  abs, dialBaseOf, hostBase, installHostRouting, invalidateSavedHostBase, pickSavedBase, plainDownloadRoute, plainHostRoute, plainShellRoute,
  routeContext, savedHostBase, savedRowPlain, seedRouteNet, setRouteBase,
  baseOfDial, plainBaseNow, readTicketLeft, savedBasePinned, scrubTickets, setReadTicket, ticketedUrl, ticketless, tokenWithheld, tokenWithheldOf,
} = await import("./hostUrl.ts");
const { onBearerRejected } = await import("./deviceToken.ts");
installHostRouting();

test("abs() ignores the LAN route: an opaque load goes to the saved address", () => {
  assert.equal(setRouteBase(LAN), LAN);
  assert.equal(hostBase(), LAN, "the route IS in force for the transports");
  assert.equal(abs("/api/repos/r/artifact?path=a.png"), `${SAVED}/api/repos/r/artifact?path=a.png`);
  setRouteBase(null);
  assert.equal(abs("/api/x"), `${SAVED}/api/x`);
});

test("the patch adds no bearer on pake/*: the old token rides sealed in the box", async () => {
  const sent = () => new Headers(fetchInits.at(-1)?.headers).get("authorization");
  store.set(lsKey("deviceToken"), "tok_abcdefghijklmnopqrstuvwxyz012345");
  try {
    await fetch(`${hostBase()}/api/repos`);
    assert.match(sent(), /^Bearer /, "the patch is on for this origin");
    for (const p of ["start", "finish"]) {
      await fetch(`${hostBase()}/api/pair/pake/${p}`, { method: "POST" });
      assert.equal(sent(), null, p);
    }
  } finally { store.delete(lsKey("deviceToken")); }
});

test("a beacon goes to the saved address on the LAN route; fetch follows the route", async () => {
  setRouteBase(LAN);
  navigator.sendBeacon("/api/netstats", "{}");
  assert.equal(beacons.at(-1), `${SAVED}/api/netstats`);
  await fetch("/api/repos");
  assert.equal(fetched.at(-1), `${LAN}/api/repos`);
  setRouteBase(null);
});

test("the plain route follows the route in force, read per call", () => {
  assert.equal(plainHostRoute(), false);
  setRouteBase(LAN);
  assert.equal(plainHostRoute(), true);
  setRouteBase(null);
  assert.equal(plainHostRoute(), false);
});

// ── The route rule's inputs ──────────────────────────────────────────────

const PIN = { port: 8771, spki: "a".repeat(64) };
const LAN_TLS = "https://192.168.1.20:8771";

test("dialBaseOf: a pin is used only by a shell that enforces it, on a plain-by-name http address", () => {
  const row = { base: LAN, tls: PIN };
  assert.equal(dialBaseOf(row, true), LAN_TLS);
  assert.equal(dialBaseOf(row, false), LAN, "a shipped APK ignores the pin it learned");
  assert.equal(dialBaseOf({ ...row, tlsOff: true }, true), LAN);
  assert.equal(dialBaseOf({ base: LAN }, true), LAN);
  for (const base of [SAVED, "https://desk.tail1.ts.net", "http://127.0.0.1:8770", "https://me.example"]) assert.equal(dialBaseOf({ base, tls: PIN }, true), base, base);
  assert.equal(dialBaseOf({ base: SAVED, tls: PIN, lan: { base: LAN, ssids: [], auto: true } }, true, LAN), LAN_TLS, "the LAN candidate of a tailnet row");
});

test("pickSavedBase applies it, so abs() and every saved-address reader get the TLS address", () => {
  const hosts = JSON.stringify([{ id: "abcd1234", name: "d", base: LAN, tls: PIN }]);
  assert.equal(pickSavedBase(hosts, "abcd1234", LAN, true), LAN_TLS);
  assert.equal(pickSavedBase(hosts, "abcd1234", LAN, false), LAN);
  assert.equal(pickSavedBase(hosts, "abcd1234", LAN), LAN);
  assert.equal(pickSavedBase(null, null, LAN, true), LAN, "no row, no pin");
});

test("routeContext: trusted is a pinned TLS base on an enforcing shell, or the very https base the person typed", () => {
  const row = { base: SAVED, tls: PIN, lan: { base: LAN, ssids: [], auto: true } };
  assert.deepEqual(routeContext(LAN_TLS, row, true, null), { trusted: true });
  assert.deepEqual(routeContext(LAN_TLS, row, false, null), {}, "no plugin, no TLS route");
  assert.deepEqual(routeContext(LAN_TLS, { ...row, tlsOff: true }, true, null), {});
  assert.deepEqual(routeContext("https://192.168.1.21:8771", row, true, null), {}, "another host on the same port");
  assert.deepEqual(routeContext("https://192.168.1.20:9999", row, true, null), {}, "another port on the same host");
  assert.deepEqual(routeContext(SAVED, row, true, null), {}, "a tailnet base is not its own TLS address");
  const typed = { base: "https://me.example", vouched: true };
  assert.deepEqual(routeContext("https://me.example", typed, false, null), { trusted: true });
  assert.deepEqual(routeContext("https://other.example", typed, false, null), {});
  assert.deepEqual(routeContext("https://me.example", { base: "https://me.example" }, false, null), {}, "a saved address nobody vouched for");
  assert.deepEqual(routeContext("https://me.example", { ...typed, lan: { base: "https://me.example", ssids: [], auto: false }, vouched: undefined }, true, null), {}, "lan.base is never vouched");
  const net = (tailnet) => ({ transport: "wifi", ssid: null, permission: "denied", tailnet });
  assert.deepEqual(routeContext(SAVED, null, false, net(false)), { tailnet: false });
  assert.deepEqual(routeContext(SAVED, null, false, net(true)), { tailnet: true });
  assert.deepEqual(routeContext(SAVED, null, false, { transport: "wifi", ssid: null, permission: "denied" }), {}, "a shell that does not say keeps today's answer");
});

test("savedRowPlain judges a row by name alone: Tailscale being off now says nothing about a saved desktop", () => {
  assert.equal(savedRowPlain({ base: SAVED }, false), false);
  assert.equal(savedRowPlain({ base: LAN }, false), true);
  assert.equal(savedRowPlain({ base: LAN, tls: PIN }, true), false);
  assert.equal(savedRowPlain({ base: LAN, tls: PIN }, false), true);
  assert.equal(savedRowPlain({ base: "https://me.example" }, false), true);
  assert.equal(savedRowPlain({ base: "https://me.example", vouched: true }, false), false);
  assert.equal(savedRowPlain({ base: SAVED, tls: PIN, lan: { base: LAN, ssids: [], auto: true } }, true, LAN), false);
});

test("in a browser the page IS the address: an https page is where the person went, and only the shell refuses", (t) => {
  const was = { cap: globalThis.Capacitor, loc: globalThis.location };
  t.after(() => { globalThis.Capacitor = was.cap; globalThis.location = was.loc; invalidateSavedHostBase(); });
  globalThis.Capacitor = { isNativePlatform: () => false };
  invalidateSavedHostBase();
  globalThis.location = new URL("https://me.example/");
  assert.equal(plainHostRoute(), false);
  globalThis.location = new URL("http://192.168.1.20:8770/");
  assert.equal(plainHostRoute(), true);
  assert.equal(plainShellRoute(), false);
  assert.equal(plainDownloadRoute(), false);
});

test("the live route: a row, a plugin and the network each change the answer, and the cache can be told", async (t) => {
  const row = { id: "abcd1234", name: "d", base: LAN, tls: PIN };
  const reset = () => {
    store.delete(lsKey("hosts")); store.delete(lsKey("hostActive")); store.set(lsKey("hostBase"), SAVED);
    delete globalThis.Capacitor.Plugins;
    invalidateSavedHostBase();
  };
  t.after(reset);
  store.set(lsKey("hosts"), JSON.stringify([row]));
  store.set(lsKey("hostActive"), row.id);
  store.set(lsKey("hostBase"), LAN);

  invalidateSavedHostBase();
  assert.equal(savedHostBase(), LAN, "no ShellTls: the plain address");
  assert.equal(plainHostRoute(), true);
  assert.equal(plainShellRoute(), true);
  assert.equal(plainDownloadRoute(), true);

  globalThis.Capacitor.Plugins = { ShellTls: { setPin: async () => {} } };
  assert.equal(savedHostBase(), LAN, "still the cached answer");
  invalidateSavedHostBase();
  assert.equal(savedHostBase(), LAN_TLS);
  assert.equal(abs("/api/x"), `${LAN_TLS}/api/x`);
  assert.equal(plainHostRoute(), false);
  assert.equal(plainDownloadRoute(), false);

  store.set(lsKey("hosts"), JSON.stringify([{ ...row, tls: undefined, tlsOff: true }]));
  invalidateSavedHostBase();
  assert.equal(savedHostBase(), LAN, "tlsOff: the person's way out");
  assert.equal(plainHostRoute(), true);

  store.set(lsKey("hosts"), JSON.stringify([{ ...row, base: SAVED, tls: undefined }]));
  store.set(lsKey("hostBase"), SAVED);
  invalidateSavedHostBase();
  assert.equal(plainHostRoute(), false);
  // Downloads ask of the saved address, so a plain LAN route over a protected saved address fetches.
  setRouteBase(LAN);
  assert.equal(plainHostRoute(), true);
  assert.equal(plainDownloadRoute(), false);
  setRouteBase(null);

  // A shell that says the tailnet is not under this network takes the name's word away. Last, because
  // the seeded reading stays for the life of the module.
  globalThis.Capacitor.Plugins.ShellNet = { current: async () => ({ transport: "wifi", ssid: null, permission: "denied", tailnet: false }) };
  await seedRouteNet();
  assert.equal(plainHostRoute(), true);
  assert.equal(plainDownloadRoute(), true);
});

// ── The token on a plain dial ───────────────────────────────────────────

test("tokenWithheldOf: a pinned row or a dead tunnel, on an enforcing shell, and nothing less", () => {
  const net = (tailnet) => ({ transport: "wifi", ssid: null, permission: "denied", ...(tailnet === undefined ? {} : { tailnet }) });
  const row = { base: SAVED, tls: PIN };
  assert.equal(tokenWithheldOf(SAVED, row, true, net(false)), true, "Tailscale off: the Wi-Fi answers");

  assert.equal(tokenWithheldOf(SAVED, row, true, net(true)), false, "Tailscale on behaves as ever");
  assert.equal(tokenWithheldOf(SAVED, row, true, net(undefined)), false, "absent is unknown, never false");
  assert.equal(tokenWithheldOf(SAVED, row, true, null), false, "a shell that said nothing");

  assert.equal(tokenWithheldOf(SAVED, { base: SAVED }, true, net(false)), true, "no pin: only the Wi-Fi can answer this dial");
  assert.equal(tokenWithheldOf(SAVED, { base: SAVED }, true, net(true)), false, "no pin, Tailscale on");
  assert.equal(tokenWithheldOf(SAVED, { base: SAVED }, true, net(undefined)), false, "no pin, absent is unknown, never false");
  assert.equal(tokenWithheldOf(SAVED, { base: SAVED }, true, null), false);
  assert.equal(tokenWithheldOf("https://desk.tail1.ts.net", { base: "https://desk.tail1.ts.net" }, true, net(false)), true, "a MagicDNS name needs the tunnel too");
  assert.equal(tokenWithheldOf(LAN, { base: LAN }, true, net(false)), false, "a plain LAN address on an unpinned row is the opt-in");
  assert.equal(tokenWithheldOf(LAN, { base: LAN, tls: PIN, tlsOff: true }, true, net(false)), false, "the person chose plain, on the LAN");
  assert.equal(tokenWithheldOf(SAVED, { ...row, tlsOff: true }, true, net(false)), true, "plain was the LAN's choice, not a dial with no tunnel");
  assert.equal(tokenWithheldOf(SAVED, { ...row, tlsOff: true }, true, net(true)), false);
  assert.equal(tokenWithheldOf("https://desk.tail1.ts.net", { base: "https://desk.tail1.ts.net", vouched: true }, true, net(false)), false, "the address the person vouched for");
  assert.equal(tokenWithheldOf(SAVED, row, false, net(false)), false, "a shell that cannot enforce a pin");
  assert.equal(tokenWithheldOf(SAVED, null, true, net(false)), true, "no row to ask, and still no tunnel");
  assert.equal(tokenWithheldOf(SAVED, null, true, net(true)), false);
  assert.equal(tokenWithheldOf(null, row, true, net(false)), false);

  const lanRow = { base: LAN, tls: PIN };
  assert.equal(tokenWithheldOf(LAN_TLS, lanRow, true, net(false)), false, "the pinned address is the way in");
  assert.equal(tokenWithheldOf(LAN, lanRow, true, net(true)), true, "plain by name, on any network");
  assert.equal(tokenWithheldOf("https://me.example", { base: "https://me.example", tls: PIN, vouched: true }, true, net(false)), false, "typed by the person");
  assert.equal(tokenWithheldOf("http://127.0.0.1:8770", { base: "http://127.0.0.1:8770", tls: PIN }, true, net(false)), false, "loopback");
});

test("the transports: nothing on a withheld dial, and a 401 there forgets nothing", async (t) => {
  // The live test above left `tailnet: false` seeded for the life of the module.
  const TOK = "tok_abcdefghijklmnopqrstuvwxyz012345";
  const sent = () => new Headers(fetchInits.at(-1)?.headers).get("authorization");
  let refused = 0;
  onBearerRejected(() => { refused++; });
  t.after(() => {
    onBearerRejected(null);
    answer = 200;
    store.delete(lsKey("deviceToken")); store.delete(lsKey("hosts")); store.delete(lsKey("hostActive"));
    delete globalThis.Capacitor.Plugins;
    invalidateSavedHostBase();
  });
  const row = { id: "abcd1234", name: "d", base: SAVED, tls: PIN };
  store.set(lsKey("deviceToken"), TOK);
  store.set(lsKey("hosts"), JSON.stringify([row]));
  store.set(lsKey("hostActive"), row.id);
  globalThis.Capacitor.Plugins = { ShellTls: { setPin: async () => {} }, ShellNet: { current: async () => ({ transport: "wifi", ssid: null, permission: "denied", tailnet: false }) } };
  await seedRouteNet();
  invalidateSavedHostBase();
  answer = 401;

  assert.equal(tokenWithheld(), true);
  await fetch("/api/repos");
  assert.equal(sent(), null, "no bearer to the Wi-Fi");
  assert.equal(refused, 0, "a 401 on a request that carried nothing refuses nothing");

  store.set(lsKey("hosts"), JSON.stringify([{ ...row, tls: undefined }]));
  assert.equal(tokenWithheld(), true, "no pin, and still no tunnel under a tailnet address");
  await fetch("/api/repos");
  assert.equal(sent(), null, "only the Wi-Fi could read it");
  assert.equal(refused, 0, "and a 401 there forgets nothing");

  store.set(lsKey("hosts"), JSON.stringify([{ ...row, base: LAN, tls: undefined }]));
  invalidateSavedHostBase();
  assert.equal(tokenWithheld(), false, "read per call");
  await fetch("/api/repos");
  assert.equal(sent(), `Bearer ${TOK}`, "a plain LAN address on an unpinned row sends it as it always did");
  assert.equal(refused, 1, "and a 401 on that is the host's refusal");

  store.set(lsKey("hosts"), JSON.stringify([row]));
  invalidateSavedHostBase();
  assert.equal(tokenWithheld(LAN_TLS, { base: LAN, tls: PIN }), false, "a saved row and one of its addresses, asked by name");
  assert.equal(tokenWithheld(SAVED, { base: SAVED, tls: PIN }), true);

  delete globalThis.Capacitor.Plugins.ShellTls;
  assert.equal(tokenWithheld(), false, "a shipped APK enforces no pin");
  globalThis.Capacitor.isNativePlatform = () => false;
  t.after(() => { globalThis.Capacitor.isNativePlatform = () => true; });
  globalThis.Capacitor.Plugins.ShellTls = { setPin: async () => {} };
  assert.equal(tokenWithheld(), false, "a browser is no shell");
});

// `ws.ts` cannot load under node (parameter properties), so the socket's half is pinned on its source.
test("the socket offers the token only where it may, and what answers a withheld dial changes nothing", () => {
  const ws = readFileSync(new URL("./ws.ts", import.meta.url), "utf8");
  assert.match(ws, /const withheld = tokenWithheld\(baseOfDial\(this\.url\)\);/, "judged on the url this socket dials");
  assert.match(ws, /wsProtocols\(withheld \? null : deviceToken\(\)\)/);
  const asked = ws.indexOf('msg.t === "authRequired" && withheld');
  const paused = ws.indexOf("this.authPaused = true");
  assert.ok(asked > 0 && asked < paused, "before the pause, the password gate and every listener");
  assert.match(ws.slice(asked, paused), /\{ ws\.close\(\); return; \}/);

  const lan = readFileSync(new URL("./lanLink.ts", import.meta.url), "utf8");
  const reject = lan.slice(lan.indexOf("const rejectToken"));
  assert.ok(reject.indexOf("if (tokenWithheld()) return;") < reject.indexOf("dropDeviceToken()"), "checked before the drop");
  assert.ok(reject.indexOf("if (tokenWithheld()) return;") > 0);
});

// ── The read ticket ─────────────────────────────────────────────────────

const PINNED = "https://192.168.1.20:8771";
const TICKET = { base: PINNED, wt: "t.k+n/1", exp: 5000 };
const WT = `wt=${encodeURIComponent(TICKET.wt)}`;

test("a ticket rides only on an opaque read route of its own address, while alive", () => {
  const art = `${PINNED}/api/repos/r/artifact?path=a.png`;
  assert.equal(ticketedUrl(art, TICKET, 1), `${art}&${WT}`);
  assert.equal(ticketedUrl(`${PINNED}/api/repos/r/inbox/a.png`, TICKET, 1), `${PINNED}/api/repos/r/inbox/a.png?${WT}`);
  assert.equal(ticketedUrl(`${art}#x`, TICKET, 1), `${art}&${WT}#x`);
  assert.equal(ticketedUrl(art, TICKET, 5000), art, "expired");
  assert.equal(ticketedUrl(art, null, 1), art);
  assert.equal(ticketedUrl(`${SAVED}/api/repos/r/artifact?path=a.png`, TICKET, 1), `${SAVED}/api/repos/r/artifact?path=a.png`, "another address");
  assert.equal(ticketedUrl(`${PINNED}/api/repos`, TICKET, 1), `${PINNED}/api/repos`, "not an opaque route");
  assert.equal(ticketedUrl(`${PINNED}/api/plugin-file/x`, TICKET, 1), `${PINNED}/api/plugin-file/x`);
  assert.equal(ticketedUrl(`${art}&wt=x`, TICKET, 1), `${art}&wt=x`, "never twice");
  assert.equal(ticketedUrl(`${PINNED}.evil.example/api/repos/r/artifact`, TICKET, 1), `${PINNED}.evil.example/api/repos/r/artifact`);
});

test("the opaque paths are the host's own list", async () => {
  const { readFileSync } = await import("node:fs");
  const origin = readFileSync(new URL("../../host/src/origin.ts", import.meta.url), "utf8");
  const mine = readFileSync(new URL("./hostUrl.ts", import.meta.url), "utf8");
  for (const re of ["/^\\/api\\/repos\\/[^/]+\\/artifact$/", "/^\\/api\\/repos\\/[^/]+\\/inbox\\/[^/]+$/"]) {
    assert.ok(origin.includes(re) && mine.includes(re), re);
  }
});

test("abs() carries a ticket only for the address it was asked of: a tailnet phone is unaffected", () => {
  setReadTicket({ ...TICKET, exp: Date.now() + 60_000 });
  assert.equal(abs("/api/repos/r/artifact?path=a.png"), `${SAVED}/api/repos/r/artifact?path=a.png`);
  setReadTicket({ ...TICKET, base: SAVED, exp: Date.now() + 60_000 });
  assert.match(abs("/api/repos/r/artifact?path=a.png"), /[?&]wt=/);
  assert.equal(readTicketLeft(PINNED, Date.now()), 0, "held for another address");
  assert.ok(readTicketLeft(SAVED, Date.now()) > 0);
  setReadTicket(null);
  assert.equal(abs("/api/repos/r/artifact?path=a.png"), `${SAVED}/api/repos/r/artifact?path=a.png`);
});

test("a ticket never leaves: copy scrubs this page's own values, a cache key drops any", () => {
  setReadTicket(TICKET);
  const art = `${PINNED}/api/repos/r/artifact?path=a.png`;
  assert.equal(scrubTickets(`see ${art}&${WT} now`), `see ${art} now`);
  assert.equal(scrubTickets(`${PINNED}/api/repos/r/inbox/a.png?${WT}&thumb=120`), `${PINNED}/api/repos/r/inbox/a.png?thumb=120`);
  assert.equal(scrubTickets("my notes say ?wt=abc"), "my notes say ?wt=abc", "a person's own words");
  setReadTicket({ ...TICKET, wt: "next" });
  assert.equal(scrubTickets(`${art}&${WT}`), art, "the one before a renewal too");
  setReadTicket(null);
  assert.equal(ticketless(`${art}&wt=abc&thumb=120&v=3`), `${art}&thumb=120&v=3`);
  assert.equal(ticketless(`${PINNED}/x?wt=abc`), `${PINNED}/x`);
  assert.equal(ticketless(`${PINNED}/x?wt=abc&thumb=1#y`), `${PINNED}/x?thumb=1#y`);
});

test("a socket's url gives back its base, and that base is judged as the row says", () => {
  assert.equal(baseOfDial(`wss://192.168.1.20:8771/ws`), PINNED);
  assert.equal(baseOfDial("ws://100.64.0.5:8770/ws"), SAVED);
  assert.equal(baseOfDial("nonsense"), null);
  assert.equal(plainBaseNow("http://127.0.0.1:8770"), false);
  assert.equal(plainBaseNow(LAN), true);
  assert.equal(plainBaseNow(PINNED), true, "no row holds this pin");
  assert.equal(savedBasePinned(), false, "a tailnet base is never rewritten");

  // A LAN-only row holding that pin, on a shell that enforces it: the dial a welcome is judged on.
  const row = { id: "abcd1234", name: "desk", base: LAN, tls: { port: 8771, spki: "ab".repeat(32) } };
  const plugins = globalThis.Capacitor.Plugins;
  store.set(lsKey("hosts"), JSON.stringify([row]));
  store.set(lsKey("hostActive"), row.id);
  globalThis.Capacitor.Plugins = { ShellTls: { setPin: async () => {} } };
  invalidateSavedHostBase();
  try {
    assert.equal(savedHostBase(), PINNED);
    assert.equal(savedBasePinned(), true);
    assert.equal(plainBaseNow(PINNED), false, "the pin's own TLS address is protected");
    assert.equal(plainBaseNow(LAN), true, "and its plain address never is");
    // The same row on a shipped shell: nothing protected, nothing rewritten.
    delete globalThis.Capacitor.Plugins;
    invalidateSavedHostBase();
    assert.equal(savedBasePinned(), false);
    assert.equal(plainBaseNow(PINNED), true);
  } finally {
    store.delete(lsKey("hosts")); store.delete(lsKey("hostActive"));
    globalThis.Capacitor.Plugins = plugins;
    invalidateSavedHostBase();
  }
});
