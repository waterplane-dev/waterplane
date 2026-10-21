// The demo's swap point (demo-mode-plan.md §2, WP1): every door the page has to
// a desktop answered by the in-bundle fake one, nothing off the device, and the
// fake desktop's state surviving the watchdog's reload. Driven over a fake
// browser target — no DOM, no timers of the script (`tick: false`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, decode, encode } from "@waterplane/shared";
import { DEMO_WS_URL, OFF_DEVICE, createDemoTransport, routeOf } from "./transport.ts";
import { demoMediaUrl } from "./media.ts";
import { demoProblem, demoScenarioId, exitDemo, isDemo, urlWithDemo } from "./mode.ts";
import { installDemoTransport } from "./transport.ts";
import { demoSnapKey } from "../storage.ts";

const HREF = "http://localhost/index.html#/";

const scenario = (over = {}) => ({
  meta: { id: "wp1-test", protocol: PROTOCOL_VERSION, stamp: "s1" },
  clock: { start: 1_000 },
  state: { bootId: "boot-demo", model: {} },
  script: [],
  ...over,
});

/** A sessionStorage stand-in. */
function memStore() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
}

/** The XHR slice the uploads touch. A real XHR invokes `on*` too; this one only listeners. */
class FakeXHR extends EventTarget {
  readyState = 0;
  status = 0;
  responseText = "";
  responseType = "";
  upload = new EventTarget();
  realSends = 0;
  open() { this.readyState = 1; }
  setRequestHeader() {}
  send() { this.realSends++; }
  abort() {}
}

function harness({ sc = scenario(), store = memStore(), now = 1_000 } = {}) {
  const passed = [];
  const refusals = [];
  const beacons = [];
  const target = {
    fetch: async (input) => { passed.push(String(input?.url ?? input)); return new Response("static", { status: 200 }); },
    XMLHttpRequest: class extends FakeXHR {},
    navigator: { sendBeacon: (url) => { beacons.push(String(url)); return true; } },
  };
  const t = createDemoTransport({
    scenario: sc, href: HREF, target, store, tick: false,
    clock: { now: () => now },
    onRefused: (url, via) => refusals.push(`${via} ${url}`),
  });
  return { t, target, store, passed, refusals, beacons };
}

/** Open a demo socket the way `ws.ts` does: handlers after the constructor, hello on open. */
function openSocket(t) {
  const ws = t.dial(DEMO_WS_URL);
  const got = [];
  let closed = null;
  const opened = new Promise((resolve) => {
    ws.onopen = () => { ws.send(encode({ t: "hello", protocol: PROTOCOL_VERSION })); resolve(); };
  });
  ws.onmessage = (ev) => got.push(decode(ev.data));
  ws.onclose = (ev) => { closed = ev; };
  const until = async (pred, ms = 500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = got.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no frame matched; got ${JSON.stringify(got.map((m) => m.t))}`);
  };
  return { ws, got, opened, until, closed: () => closed };
}

test("the socket: hello → welcome, from the fake desktop, over the single connection", async () => {
  const { t } = harness();
  const s = openSocket(t);
  assert.equal(s.ws.readyState, 0, "a socket opens asynchronously, like a real one");
  await s.opened;
  assert.equal(s.ws.readyState, 1);
  const w = await s.until((m) => m.t === "welcome");
  assert.equal(w.protocol, PROTOCOL_VERSION);
  assert.equal(w.bootId, "boot-demo");
  assert.equal(w.hostName, "Demo");
  s.ws.send(encode({ t: "ping" }));
  await s.until((m) => m.t === "pong");
  t.stop();
});

test("the socket: a scripted frame is delivered when the transport advances the script", async () => {
  let now = 1_000;
  const sc = scenario({ script: [{ at: 50, event: { kind: "frame", msg: { t: "toast", message: "scripted" } } }] });
  const t = createDemoTransport({ scenario: sc, href: HREF, target: { fetch: async () => new Response("") }, store: null, tick: false, clock: { now: () => now } });
  const s = openSocket(t);
  await s.opened;
  await s.until((m) => m.t === "welcome");
  t.host.advance();
  assert.ok(!s.got.some((m) => m.t === "toast"), "not due yet");
  now += 60;
  t.host.advance();
  const toast = await s.until((m) => m.t === "toast");
  assert.equal(toast.message, "scripted");
});

test("the socket: a session.attach's full keyframe is handed over before send() returns, so the opening tap never paints the empty terminal", async () => {
  const REPO = "/demo/todo";
  const sc = scenario({ state: { bootId: "boot-demo", model: {
    repos: [{ id: "todo", repoName: "todo", branch: "main", isPrimary: true, worktreePath: REPO, outboxCount: 0, changedCount: 0 }],
    sessions: [{ id: "s1", cwd: REPO, title: "todo", remoteControl: false, running: true, createdAt: 1, idle: true }],
    screens: { s1: { data: "welcome to the demo\r\n", seq: 21 } },
  } } });
  const t = createDemoTransport({ scenario: sc, href: HREF, target: { fetch: async () => new Response("") }, store: null, tick: false, clock: { now: () => 1_000 } });
  const s = openSocket(t);
  await s.opened;
  await s.until((m) => m.t === "welcome");
  await s.until((m) => m.t === "session.list");  // everything the hello answered has been delivered
  const before = s.got.length;
  s.ws.send(encode({ t: "session.attach", id: "s1" }));
  const keyframe = s.got.slice(before).find((m) => m.t === "pty");
  assert.ok(keyframe?.full, "the full keyframe is already delivered when send() returns");
  assert.match(Buffer.from(keyframe.dataB64, "base64").toString("utf8"), /welcome to the demo/);
  assert.ok(!s.got.slice(before).some((m) => m.t === "session.history"), "everything else about the attach still travels like a frame");
  await s.until((m) => m.t === "session.history");
  // …and a second attach from the same point is current: nothing to replay, nothing delivered early.
  const n = s.got.length;
  s.ws.send(encode({ t: "session.attach", id: "s1", resumeSeq: keyframe.seq, resumeBoot: "boot-demo" }));
  assert.ok(!s.got.slice(n).some((m) => m.t === "pty"), "a current resume point replays nothing");
  t.stop();
});

test("the socket: closing it reports the close, and a demo disconnect fault closes from the host side", async () => {
  const { t } = harness();
  t.host.faults.set([{ kind: "disconnect", match: { t: "ping" } }]);
  const s = openSocket(t);
  await s.opened;
  await s.until((m) => m.t === "welcome");
  s.ws.send(encode({ t: "ping" }));
  for (let i = 0; i < 50 && !s.closed(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.closed()?.code, 1006);
  assert.equal(s.ws.readyState, 3);
});

test("fetch: /api/health is answered by the fake desktop, never the network", async () => {
  const { target, passed } = harness();
  const r = await target.fetch("/api/health", { cache: "no-store" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.protocol, PROTOCOL_VERSION);
  assert.equal(r.headers.get("content-type"), "application/json");
  // Absolute on the page's own origin is the same door.
  const r2 = await target.fetch("http://localhost/api/health");
  assert.equal(r2.status, 200);
  // An unanswered route is a 404 with a SENTENCE, never a hang.
  const r3 = await target.fetch("/api/nothing-here", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } });
  assert.equal(r3.status, 404);
  assert.match(await r3.text(), /demo/i);
  assert.deepEqual(passed, [], "nothing reached the real fetch");
});

test("fetch: the page's own static files still load, from the same origin", async () => {
  const { target, passed } = harness();
  await target.fetch("/demo/media/r/shot.png");
  await target.fetch("/assets/index.js");
  assert.deepEqual(passed, ["/demo/media/r/shot.png", "/assets/index.js"]);
});

test("off the device is refused, by every door, and said", async () => {
  const { target, passed, refusals, beacons } = harness();
  await assert.rejects(target.fetch("https://fcm.googleapis.com/fcm/send/x"), (e) => e instanceof TypeError && e.message.startsWith(OFF_DEVICE));
  await assert.rejects(target.fetch("http://100.64.0.1:8770/api/health"), /Not in the demo/);
  assert.equal(target.navigator.sendBeacon("http://192.168.1.5:8770/api/netstats", "{}"), false);
  const x = new target.XMLHttpRequest();
  const ended = new Promise((r) => x.addEventListener("loadend", r));
  let errored = false;
  x.addEventListener("error", () => { errored = true; });
  x.open("POST", "https://elsewhere.example/upload");
  x.send("bytes");
  await ended;
  assert.ok(errored);
  assert.equal(x.status, 0);
  assert.equal(x.realSends, 0);
  assert.deepEqual(passed, []);
  assert.deepEqual(beacons, [], "the real beacon was never called");
  assert.equal(refusals.length, 4);
  assert.match(refusals.join("\n"), /XMLHttpRequest https:\/\/elsewhere/);
});

test("sendBeacon to /api goes to the fake desktop, not the network", () => {
  const { target, beacons } = harness();
  assert.equal(target.navigator.sendBeacon("/api/netstats", "{\"a\":1}"), true);
  assert.deepEqual(beacons, []);
});

test("a Blob beacon is answered at once and never read (pagehide: WebKit errors on the read)", () => {
  const { target, beacons } = harness();
  let reads = 0;
  class Watched extends Blob { text() { reads++; return super.text(); } }
  assert.equal(target.navigator.sendBeacon("/api/ui-usage", new Watched(["{}"], { type: "application/json" })), true);
  assert.equal(reads, 0);
  assert.deepEqual(beacons, []);
});

test("XHR send: an upload gets its upload progress, then a status and a body", async () => {
  const { target, t } = harness();
  const x = new target.XMLHttpRequest();
  const ups = [];
  x.upload.addEventListener("progress", (e) => ups.push([e.loaded, e.total]));
  const states = [];
  x.addEventListener("readystatechange", () => states.push(x.readyState));
  const loaded = new Promise((r) => x.addEventListener("load", r));
  x.open("POST", "/api/repos/demo-todo/inbox");
  x.send(new Blob([new Uint8Array(1234)]));
  await loaded;
  assert.deepEqual(ups, [[1234, 1234]]);
  assert.deepEqual(states, [2, 3, 4]);
  assert.equal(x.readyState, 4);
  const expect = t.host.request({ method: "POST", path: "/api/repos/demo-todo/inbox", bodyBytes: 1234 });
  assert.equal(x.status, expect.status);
  assert.equal(x.responseText, expect.body);
  assert.equal(x.getResponseHeader("content-type"), expect.contentType);
  assert.equal(x.realSends, 0);
});

test("XHR: a same-origin static file goes to the real send", () => {
  const { target } = harness();
  const x = new target.XMLHttpRequest();
  x.open("GET", "/assets/a.json");
  x.send();
  assert.equal(x.realSends, 1);
});

test("the snapshot survives a reload: same boot, same clock, same ack ledger — nothing runs twice", async () => {
  const store = memStore();
  const a = harness({ store, now: 5_000 });
  assert.ok(store.m.has(demoSnapKey("wp1-test")), "written at install, before any tap");
  const s = openSocket(a.t);
  await s.opened;
  await s.until((m) => m.t === "welcome");
  // A durable op the demo refuses: its receipt is ledgered under the ackId.
  s.ws.send(encode({ t: "build.run", ackId: "ack-1", repoId: "r", buildId: "b" }));
  const first = await s.until((m) => m.t === "op.ack" && m.ackId === "ack-1");
  assert.equal(first.ok, false);
  a.t.stop();

  // The watchdog reload: a fresh page, the same tab's sessionStorage.
  const b = harness({ store, now: 9_000 });
  const snap = b.t.host.snapshot();
  assert.equal(snap.state.bootId, "boot-demo");
  assert.equal(snap.startedAt, 5_000, "the script's clock is not restarted");
  assert.deepEqual(snap.acks["ack-1"], first);
  const s2 = openSocket(b.t);
  await s2.opened;
  const w = await s2.until((m) => m.t === "welcome");
  assert.equal(w.bootId, "boot-demo", "a reload is not read as a host restart");
  s2.ws.send(encode({ t: "build.run", ackId: "ack-1", repoId: "r", buildId: "b" }));
  const again = await s2.until((m) => m.t === "op.ack" && m.ackId === "ack-1");
  assert.deepEqual(again, first, "re-acked from the ledger");
  b.t.stop();
});

test("restore is all or nothing: a broken or foreign snapshot starts the demo fresh", () => {
  for (const raw of ["{not json", JSON.stringify({ v: 1, scenario: "other" }), JSON.stringify(null)]) {
    const store = memStore();
    store.setItem(demoSnapKey("wp1-test"), raw);
    const { t } = harness({ store, now: 7_000 });
    const snap = t.host.snapshot();
    assert.equal(snap.startedAt, 7_000, raw);
    assert.deepEqual(snap.acks, {}, raw);
    assert.equal(JSON.parse(store.getItem(demoSnapKey("wp1-test"))).startedAt, 7_000, "fresh state written back");
  }
  // A changed stamp (a re-shipped scenario) never restores the old one's state.
  const store = memStore();
  harness({ store, now: 1 }).t.host.faults.set([]);
  const { t } = harness({ sc: scenario({ meta: { id: "wp1-test", protocol: PROTOCOL_VERSION, stamp: "s2" } }), store, now: 2 });
  assert.equal(t.host.snapshot().startedAt, 2);
});

test("routeOf: the three doors", () => {
  assert.equal(routeOf("/api/health", HREF).route, "host");
  assert.equal(routeOf("/ws", HREF).route, "host");
  assert.equal(routeOf("/apiary", HREF).route, "local");
  assert.equal(routeOf("/demo/media/x.png", HREF).route, "local");
  assert.equal(routeOf("data:text/plain,hi", HREF).route, "local");
  assert.equal(routeOf("blob:http://localhost/abc", HREF).route, "local");
  assert.equal(routeOf("http://localhost:8770/api/health", HREF).route, "refuse", "another port is another origin");
  assert.equal(routeOf("https://example.com/", HREF).route, "refuse");
});

test("abs() in the demo: host files become bundled media; every other /api URL stays for fetch", () => {
  assert.equal(demoMediaUrl("/api/repos/demo-todo/artifact?path=.claude%2Foutbox%2Fflow.gif"), "/demo/media/demo-todo/dot-claude/outbox/flow.gif");
  assert.equal(demoMediaUrl("/api/repos/demo-todo/artifact?path=docs%2Fa%20b.png&download=1"), "/demo/media/demo-todo/docs/a%20b.png");
  assert.equal(demoMediaUrl("/api/repos/demo-todo/inbox/shot%201.png"), "/demo/media/demo-todo/dot-claude/inbox/shot%201.png");
  assert.equal(demoMediaUrl("/api/repos/demo-todo/artifact?path=x.png&stat=1"), "/api/repos/demo-todo/artifact?path=x.png&stat=1");
  assert.equal(demoMediaUrl("/api/repos/demo-todo/artifact?path=..%2F..%2Fetc%2Fpasswd"), "/api/repos/demo-todo/artifact?path=..%2F..%2Fetc%2Fpasswd", "a traversal is not mapped");
  assert.equal(demoMediaUrl("/api/health"), "/api/health");
  assert.equal(demoMediaUrl("/assets/icon.png"), "/assets/icon.png");
});

test("the switch: ?demo= is set and removed without touching the route", () => {
  assert.equal(urlWithDemo("http://localhost/?x=1#/s/abc", "first-look"), "http://localhost/?x=1&demo=first-look#/s/abc");
  assert.equal(urlWithDemo("http://localhost/?demo=first-look#/s/abc", null), "http://localhost/#/s/abc");
});

test("the switch: the URL asks, an unknown scenario runs no demo and says why", () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "location");
  try {
    Object.defineProperty(globalThis, "location", { value: { search: "?demo=../etc", href: HREF }, configurable: true });
    assert.equal(demoScenarioId(), null, "not shaped like an id: no ask");
    Object.defineProperty(globalThis, "location", { value: { search: "?demo=no-such-demo", href: HREF }, configurable: true });
    assert.equal(demoScenarioId(), "no-such-demo");
    assert.equal(installDemoTransport(), false);
    assert.equal(isDemo(), false, "every guard stays off with the transport");
    assert.match(demoProblem() ?? "", /no demo called "no-such-demo"/);
  } finally {
    if (had) Object.defineProperty(globalThis, "location", had);
    else delete globalThis.location;
  }
});

test("a scenario that refuses to start becomes the demo problem, never a throw before React mounts", async () => {
  const { DEMO_SCENARIOS } = await import("./scenarios/index.ts");
  const had = Object.getOwnPropertyDescriptor(globalThis, "location");
  const id = "throws-on-start";
  DEMO_SCENARIOS[id] = scenario({ meta: { id, protocol: PROTOCOL_VERSION, stamp: "s1" }, faults: [{ match: "x" }] });
  try {
    Object.defineProperty(globalThis, "location", { value: { search: `?demo=${id}`, href: HREF }, configurable: true });
    let r;
    assert.doesNotThrow(() => { r = installDemoTransport(); });
    assert.equal(r, false);
    assert.equal(isDemo(), false, "every guard stays off with the transport");
    assert.match(demoProblem() ?? "", /could not start.*fault rule/);
  } finally {
    delete DEMO_SCENARIOS[id];
    if (had) Object.defineProperty(globalThis, "location", had);
    else delete globalThis.location;
  }
});

test("leaving the demo reloads even when the URL would not change (a route hash, no ?demo=)", () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "location");
  const fake = (href) => {
    const calls = [];
    const u = new URL(href);
    return { calls, value: { href, search: u.search, hash: u.hash, replace: (x) => calls.push(["replace", x]), reload: () => calls.push(["reload"]) } };
  };
  try {
    // The bug WP7 found: same URL => `replace` is a same-document navigation and nothing reloads.
    const a = fake("http://localhost/#a=demo-g1&o=gallery");
    Object.defineProperty(globalThis, "location", { value: a.value, configurable: true });
    exitDemo();
    assert.deepEqual(a.calls, [["reload"]], "the page must reload itself, keeping the route");
    // With ?demo= to take off, the replace IS a new document; the route rides along.
    const b = fake("http://localhost/?demo=first-look#a=demo-g1");
    Object.defineProperty(globalThis, "location", { value: b.value, configurable: true });
    exitDemo();
    assert.deepEqual(b.calls, [["replace", "http://localhost/#a=demo-g1"]]);
  } finally {
    if (had) Object.defineProperty(globalThis, "location", had);
    else delete globalThis.location;
  }
});
