/**
 * DemoHost's interface rules (WP2a of docs/analysis/demo-mode-plan.md):
 *
 *   - the handler table is exhaustive BY TYPE — proven with tsc, not asserted
 *     at runtime, because the point is that a new client message fails the
 *     build;
 *   - every refusal ends its sender's wait with the receipt it is waiting for;
 *   - a snapshot round-trips through JSON and a restored demo still answers a
 *     replayed ackId from its ledger instead of running it twice.
 *
 *     node --test packages/web/src/demo/host/demohost.test.mjs
 *
 * Needs `npm run build:shared` (test:unit does it): `@waterplane/shared`
 * resolves to dist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, promptFingerprint } from "@waterplane/shared";
import { createDemoHost, restoreDemoHost, NOT_IN_DEMO, RECEIPTS, DURABLE_OPS, assertShippable } from "./index.ts";
import { HANDLERS } from "./handlers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");

const scenario = (over = {}) => ({
  meta: { id: "t", protocol: PROTOCOL_VERSION, stamp: "s1" },
  clock: { start: 1_000_000 },
  state: { bootId: "boot-1", model: { repos: [{ name: "todo" }] } },
  script: [{ at: 500, event: { kind: "frame", msg: { t: "toast", text: "scripted" } } }],
  ...over,
});

function harness(sc = scenario(), raw) {
  let now = sc.clock.start;
  const clock = { now: () => now };
  const host = raw === undefined ? createDemoHost(sc, clock) : restoreDemoHost(sc, clock, raw);
  const outs = [];
  const conn = host.connect((o) => outs.push(o));
  const frames = () => outs.filter((o) => o.kind === "frame").map((o) => o.msg);
  return { host, conn, outs, frames, tick: (ms) => { now += ms; host.advance(); } };
}

/** A message of type `t` with every field a receipt may address. */
const probe = (t, ackId = `a-${t}`) => ({ t, ackId, id: "s1", pid: 7, name: "m", plugin: "p", method: "q" });

test("the handler table type-checks exhaustively, and a missing message fails tsc", () => {
  const dir = mkdtempSync(join(tmpdir(), "demohost-tsc-"));
  try {
    const handlers = join(here, "handlers.ts");
    // One client message left out of the table: must not satisfy it.
    writeFileSync(join(dir, "missing.ts"), [
      `import { HANDLERS } from ${JSON.stringify(handlers)};`,
      `import type { HandlerTable } from ${JSON.stringify(handlers)};`,
      `const { ["ping"]: _gone, ...rest } = HANDLERS;`,
      `export const table = rest satisfies HandlerTable;`,
      "",
    ].join("\n"));
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts")).map((f) => join(here, f));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, target: "ES2022", lib: ["ES2023"], types: [],
        module: "ESNext", moduleResolution: "Bundler", allowImportingTsExtensions: true,
        noUnusedLocals: false, noUnusedParameters: true,
      },
      files: [...sources, join(dir, "missing.ts")],
    }));
    let out = "";
    try {
      execFileSync(join(repo, "node_modules/.bin/tsc"), ["-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
    } catch (e) {
      out = String(e.stdout);
    }
    const errors = out.split("\n").filter((l) => /error TS\d+/.test(l));
    assert.ok(errors.length > 0, "a table missing `ping` must not type-check");
    // Every error is the fixture's — the real table and the rest of the folder are clean.
    for (const l of errors) assert.match(l, /missing\.ts/, l);
    assert.match(out, /ping/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every refused message ends its sender's wait with its own receipt, or a toast when it has none", () => {
  const { conn, frames } = harness();
  for (const [t, h] of Object.entries(HANDLERS)) {
    if (h.tier === "A") continue;
    const before = frames().length;
    conn.receive(probe(t));
    const got = frames().slice(before);
    assert.equal(got.length, 1, `${t} answers exactly once`);
    const [m] = got;
    if (t in RECEIPTS) {
      assert.notEqual(m.t, "toast", `${t} has a receipt; a toast would leave its row pending`);
      assert.notEqual(m.ok, true, t); // `session.named` has no `ok`: a reason and no name IS its refusal
      assert.equal(m.retryable, undefined, `${t}: a refusal is never auto-retryable`);
      assert.equal(m.reason ?? m.error, h.reason ?? NOT_IN_DEMO, t);
    } else {
      assert.deepEqual(m, { t: "toast", text: h.reason ?? NOT_IN_DEMO }, t);
    }
  }
  // The durable ops answer through op.ack specifically.
  for (const t of DURABLE_OPS) {
    if (HANDLERS[t].tier === "A") continue;
    conn.receive(probe(t, `d-${t}`));
    assert.equal(frames().at(-1).t, "op.ack", t);
  }
});

test("a tier-B op re-sent with the same ackId is re-acked from the ledger, identically", () => {
  const { conn, frames, host } = harness();
  conn.receive({ t: "build.run", repoDir: "todo", ackId: "k1" });
  conn.receive({ t: "build.run", repoDir: "todo", ackId: "k1" });
  const acks = frames().filter((m) => m.t === "op.ack");
  assert.equal(acks.length, 2);
  assert.deepEqual(acks[0], { t: "op.ack", ackId: "k1", ok: false, reason: HANDLERS["build.run"].reason });
  assert.deepEqual(acks[1], acks[0]);
  assert.deepEqual(Object.keys(host.snapshot().acks), ["k1"]);
});

test("hello is answered with welcome at this protocol and the persisted boot id", () => {
  const { conn, frames } = harness();
  conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  const w = frames()[0];
  assert.equal(w.t, "welcome");
  assert.equal(w.protocol, PROTOCOL_VERSION);
  assert.equal(w.bootId, "boot-1");
});

test("snapshot round-trips through JSON, and a restored demo still answers a replayed ackId from the ledger", () => {
  const a = harness();
  a.conn.receive({ t: "session.create", cwd: "todo", ackId: "c1" });
  a.tick(600); // fires the scripted frame
  a.host.faults.set([{ kind: "latency", match: { t: "op.ack" }, ms: 50 }]);
  const snap = a.host.snapshot();
  const raw = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(raw, snap, "JSON-plain: the round trip is the identity");
  assert.equal(snap.scriptPos, 1);

  // The watchdog reload: a new host from the stored snapshot.
  const b = harness(scenario(), raw);
  assert.deepEqual(b.host.snapshot(), snap);
  b.conn.receive({ t: "session.create", cwd: "todo", ackId: "c1" });
  const ack = b.outs.find((o) => o.kind === "frame" && o.msg.t === "op.ack");
  assert.deepEqual(ack, { kind: "frame", msg: a.frames().find((m) => m.t === "op.ack"), afterMs: 50 });
  b.tick(10_000);
  assert.ok(!b.frames().some((m) => m.t === "toast"), "the script does not replay after a reload");
});

test("a snapshot of another scenario, stamp or protocol restores nothing", () => {
  const a = harness();
  a.conn.receive({ t: "build.run", repoDir: "todo", ackId: "k1" });
  const snap = JSON.parse(JSON.stringify(a.host.snapshot()));
  for (const bad of [
    { ...snap, stamp: "s2" },
    { ...snap, scenario: "other" },
    { ...snap, protocol: PROTOCOL_VERSION + 1 },
    { ...snap, v: 99 },
    { ...snap, acks: undefined },
    null, "x",
  ]) {
    assert.deepEqual(harness(scenario(), bad).host.snapshot().acks, {}, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("fault hooks: a dropped ack is recovered by the same-ackId retry; a disconnect can take health down until reconnect", () => {
  const { host, conn, frames, outs } = harness();
  host.faults.set([{ kind: "drop", match: { t: "op.ack", times: 1 } }]);
  conn.receive({ t: "build.run", repoDir: "todo", ackId: "k1" });
  assert.equal(frames().length, 0);
  conn.receive({ t: "build.run", repoDir: "todo", ackId: "k1" });
  assert.equal(frames().length, 1);
  assert.deepEqual(host.faults.fired(), [{ rule: 0, count: 1 }]);

  host.faults.set([{ kind: "disconnect", match: { t: "ping" }, health: false }]);
  conn.receive({ t: "ping" });
  assert.equal(outs.at(-1).kind, "close");
  assert.equal(host.request({ method: "GET", path: "/api/health" }).status, 503);
  conn.receive({ t: "ping" });
  assert.equal(outs.at(-1).kind, "close", "a closed connection hears nothing");
  host.faults.set([]);
  host.connect(() => {});
  assert.equal(host.request({ method: "GET", path: "/api/health" }).status, 200);
});

test("fault hooks: offline drops the open sockets; http:true keeps health up; a stayDown disconnect keeps the socket path down across a reload", () => {
  const { host, outs } = harness();
  host.faults.set([{ kind: "offline" }]);
  assert.equal(outs.at(-1).kind, "close", "an open socket closes when the device goes offline");
  const refused = [];
  host.connect((o) => refused.push(o));
  assert.equal(refused.at(-1)?.kind, "close");
  assert.equal(host.request({ method: "GET", path: "/api/health" }).status, 503);
  host.faults.set([{ kind: "offline", http: true }]);
  assert.equal(host.request({ method: "GET", path: "/api/health" }).status, 200, "http:true answers HTTP");
  host.faults.set([]);

  const fresh = [];
  const c2 = host.connect((o) => fresh.push(o));
  host.faults.set([{ kind: "disconnect", match: { t: "ping" }, stayDown: true }]);
  c2.receive({ t: "ping" });
  assert.equal(fresh.at(-1).kind, "close");
  // The reload: a new host from the snapshot still refuses sockets but answers health.
  const again = restoreDemoHost(scenario(), { now: () => 1_000_000 }, JSON.parse(JSON.stringify(host.snapshot())));
  const after = [];
  again.connect((o) => after.push(o));
  assert.equal(after.at(-1)?.kind, "close", "the socket path stays down after the reload");
  assert.equal(again.request({ method: "GET", path: "/api/health" }).status, 200);
  again.faults.set([]);
  const ok = [];
  again.connect((o) => ok.push(o));
  assert.equal(ok.length, 0, "cleared: a socket opens again");
});

test("a scenario carrying faults is refused for shipping", () => {
  assert.throws(() => assertShippable(scenario({ faults: [{ kind: "offline" }] })), /tests only/);
  assert.doesNotThrow(() => assertShippable(scenario()));
});

// ── WP2b: the model behind tier A ───────────────────────────────────────────

const REPO = "/demo/todo";
const BOX = { kind: "tool", question: "Do you want to create src/done.ts?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }] };
const desk = (over = {}) => scenario({
  script: [],
  state: {
    bootId: "boot-1",
    model: {
      repos: [{ id: "todo", repoName: "todo", branch: "main", isPrimary: true, worktreePath: REPO, outboxCount: 1, changedCount: 0 }],
      gallery: { todo: [{ name: "flow.gif", relPath: ".claude/outbox/flow.gif", mtime: 1, size: 10 }] },
      replies: [
        { match: "done", steps: [
          { kind: "output", text: "Adding a done flag.\r\n", afterMs: 100 },
          { kind: "prompt", prompt: BOX, answers: { "1": [{ kind: "output", text: "Created src/done.ts\r\n" }], "2": [{ kind: "output", text: "Skipped.\r\n" }] }, afterMs: 100 },
          { kind: "output", text: "All set.\r\n", afterMs: 100 },
        ] },
      ],
      ...over,
    },
  },
});
const text = (frames, id) => frames.filter((m) => m.t === "pty" && m.id === id).map((m) => Buffer.from(m.dataB64, "base64").toString("utf8")).join("");
const lastUpdate = (h) => h.frames().filter((m) => m.t === "session.updated").at(-1).session;

function opened(h) {
  h.conn.receive({ t: "session.create", cwd: REPO, ackId: "c1" });
  const ack = h.frames().find((m) => m.t === "op.ack");
  assert.equal(ack.ok, true);
  return ack.sessionId;
}

test("hello sends the host's unasked snapshot, and no frame for a number the scenario does not carry — except usage", () => {
  const sc = desk();
  const h = harness(sc);
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  const ts = h.frames().map((m) => m.t);
  for (const t of ["welcome", "session.list", "backlog.list", "schedule.list", "intent.list", "delivery.list", "settings.all"]) assert.ok(ts.includes(t), t);
  for (const t of ["meter.status", "budget.state", "clihealth"]) assert.ok(!ts.includes(t), `${t} is absent, never invented`);
  // The app asks for usage on every screen and draws "? / ? wk" without it, so the demo desktop always holds one.
  const usage = h.frames().find((m) => m.t === "usage.status").usage;
  assert.deepEqual([usage.sessionPct, usage.weeklyPct], [42, 61]);
  assert.ok(usage.sessionResetAt > sc.clock.start && usage.checkedAt < sc.clock.start, "a reading taken a moment ago, a window that has not rolled over");
});

test("usage.refresh and usage.get answer the held reading, quietly — never a toast about the demo", () => {
  const h = harness(desk());
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  const held = h.frames().find((m) => m.t === "usage.status").usage;
  for (const t of ["usage.refresh", "usage.get"]) {
    const before = h.frames().length;
    h.conn.receive({ t });
    const got = h.frames().slice(before);
    assert.deepEqual(got.map((m) => m.t), ["usage.status"], t);
    assert.deepEqual(got[0].usage, held, t);
  }
});

test("a scenario's own usage wins over the default", () => {
  const own = { ok: true, sessionPct: 7, weeklyPct: 9, sessionResetAt: null, weeklyResetAt: null, checkedAt: 1 };
  const sc = desk();
  sc.state.model.numbers = { usage: own };
  const h = harness(sc);
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  assert.deepEqual(h.frames().find((m) => m.t === "usage.status").usage, own);
});

test("localrt.watch is answered at once with the host's own 'not polled here' frame, never silence", () => {
  const h = harness(desk());
  h.conn.receive({ t: "localrt.watch" });
  const f = h.frames().filter((m) => m.t === "localrt.sample");
  assert.equal(f.length, 1);
  assert.equal(f[0].disabled, true, "the demo desktop polls nothing: the phone words that quietly, not as 'no answer'");
  assert.equal(f[0].sample.reachable, false);
  assert.deepEqual(f[0].sample.models, []);
});

test("session.create → op.ack with its id; attach replays in full, a current resume point replays nothing", () => {
  const h = harness(desk());
  const id = opened(h);
  assert.ok(h.frames().some((m) => m.t === "session.created" && m.session.id === id));
  h.conn.receive({ t: "session.attach", id });
  const full = h.frames().filter((m) => m.t === "pty").at(-1);
  assert.equal(full.full, true);
  assert.match(Buffer.from(full.dataB64, "base64").toString("utf8"), /todo/);
  assert.equal(full.seq, Buffer.from(full.dataB64, "base64").length, "seq counts bytes");
  assert.equal(h.frames().at(-1).t, "session.history");

  const before = h.frames().filter((m) => m.t === "pty").length;
  h.conn.receive({ t: "session.attach", id, resumeSeq: full.seq, resumeBoot: "boot-1" });
  assert.equal(h.frames().filter((m) => m.t === "pty").length, before, "already current: no replay");
  h.conn.receive({ t: "session.attach", id, resumeSeq: full.seq, resumeBoot: "other-boot" });
  assert.equal(h.frames().filter((m) => m.t === "pty").at(-1).full, true, "another boot's resume point is ignored");
});

test("a cwd outside the demo's repos is refused in words, not opened", () => {
  const h = harness(desk());
  h.conn.receive({ t: "session.create", cwd: "/etc", ackId: "c9" });
  const ack = h.frames().find((m) => m.t === "op.ack");
  assert.equal(ack.ok, false);
  assert.match(ack.reason, /demo's repos/);
  assert.ok(!h.frames().some((m) => m.t === "session.created"));
});

test("send → input.ack ok; the same ackId re-sent re-acks and runs nothing twice", () => {
  const h = harness(desk());
  const id = opened(h);
  h.conn.receive({ t: "session.attach", id });
  const send = { t: "session.input", id, data: "hello there", submit: true, ackId: "i1" };
  h.conn.receive(send);
  h.conn.receive(send);
  const acks = h.frames().filter((m) => m.t === "input.ack");
  assert.equal(acks.length, 2);
  assert.deepEqual(acks[1], acks[0]);
  assert.equal(acks[0].ok, true);
  assert.equal(acks[0].state, "ok");
  assert.equal(text(h.frames(), id).split("hello there").length - 1, 1, "echoed once");
  h.conn.receive({ t: "session.history", id });
  assert.equal(h.frames().at(-1).entries.length, 1);
});

test("a send to a closed session is refused with a sentence", () => {
  const h = harness(desk());
  const id = opened(h);
  h.conn.receive({ t: "session.remove", id });
  h.conn.receive({ t: "session.input", id, data: "late", submit: true, ackId: "i9" });
  const ack = h.frames().at(-1);
  assert.equal(ack.t, "input.ack");
  assert.equal(ack.ok, false);
  assert.equal(ack.retryable, undefined);
  assert.match(ack.reason, /closed/);
});

test("a scripted turn: output on the clock, a parsed choice box, the tapped answer, the rest, the turn's end", () => {
  const h = harness(desk());
  const id = opened(h);
  h.conn.receive({ t: "session.attach", id });
  h.conn.receive({ t: "session.input", id, data: "mark it done", submit: true, ackId: "i1" });
  assert.equal(h.host.nextAt(), 1_000_000 + 100);
  h.tick(100);
  assert.match(text(h.frames(), id), /Adding a done flag/);
  h.tick(100);
  assert.deepEqual(lastUpdate(h).prompt, BOX);
  h.tick(10_000);
  assert.doesNotMatch(text(h.frames(), id), /All set/, "the rest waits for the answer");

  // A stale answer is refused with nothing written.
  h.conn.receive({ t: "session.input", id, data: "1\r", expectPrompt: "not-this-one", ackId: "a0" });
  assert.equal(h.frames().at(-1).state, "stale");
  assert.deepEqual(lastUpdate(h).prompt, BOX);

  h.conn.receive({ t: "session.input", id, data: "1\r", expectPrompt: promptFingerprint(BOX), ackId: "a1" });
  assert.equal(h.frames().filter((m) => m.t === "input.ack").at(-1).ok, true);
  assert.equal(lastUpdate(h).prompt, undefined);
  h.tick(200);
  const out = text(h.frames(), id);
  assert.ok(out.indexOf("Created src/done.ts") >= 0 && out.indexOf("Created src/done.ts") < out.indexOf("All set."), out);
  assert.equal(lastUpdate(h).turnActive, false);
  assert.equal(h.host.nextAt(), null);
});

test("a prompt with no scripted reply says so on screen, never silence", () => {
  const h = harness(desk());
  const id = opened(h);
  h.conn.receive({ t: "session.attach", id });
  h.conn.receive({ t: "session.input", id, data: "something unscripted", submit: true, ackId: "i1" });
  h.tick(1_000);
  assert.match(text(h.frames(), id), /no scripted answer/);
});

test("raw keys echo into the composer and Return submits the line once", () => {
  const h = harness(desk());
  const id = opened(h);
  h.conn.receive({ t: "session.attach", id });
  for (const k of ["h", "i", "x", "\x7f", "\r"]) h.conn.receive({ t: "session.input", id, data: k });
  h.conn.receive({ t: "session.history", id });
  assert.deepEqual(h.frames().at(-1).entries.map((e) => e.text), ["hi"]);
});

test("backlog: add → backlog.ack with an item id, listed once; fire runs it and the turn's end marks it done", () => {
  const h = harness(desk());
  h.conn.receive({ t: "backlog.add", text: "add a due date", repoDir: REPO, ackId: "b1" });
  const ack = h.frames().find((m) => m.t === "backlog.ack");
  assert.equal(ack.ok, true);
  h.conn.receive({ t: "backlog.add", text: "add a due date", repoDir: REPO, ackId: "b1" });
  h.conn.receive({ t: "backlog.list" });
  const list = h.frames().at(-1);
  assert.equal(list.t, "backlog.list");
  assert.deepEqual(list.items.map((i) => i.id), [ack.itemId], "the retry added nothing");

  h.conn.receive({ t: "backlog.fire", id: ack.itemId });
  assert.equal(h.frames().filter((m) => m.t === "backlog.list").at(-1).items[0].status, "running");
  h.tick(5_000);
  assert.equal(h.frames().filter((m) => m.t === "backlog.list").at(-1).items[0].status, "done");
});

test("intent.post writes a row once per id; schedule.save upserts on its id", () => {
  const h = harness(desk());
  const draft = { id: "x1", cwd: REPO, payload: { kind: "prompt", steps: ["tidy up"] }, trigger: { kind: "now" } };
  h.conn.receive({ t: "intent.post", intent: draft, ackId: "p1" });
  h.conn.receive({ t: "intent.post", intent: draft, ackId: "p2" });
  h.conn.receive({ t: "intent.list" });
  assert.deepEqual(h.frames().at(-1).intents.map((i) => i.id), ["x1"]);
  const acks = h.frames().filter((m) => m.t === "op.ack");
  assert.equal(acks.length, 2);
  assert.ok(acks.every((a) => a.ok && a.intentId === "x1"));

  const entry = { id: "s1", name: "nightly", enabled: false, rule: { kind: "once", at: 2_000_000 }, action: { kind: "prompt" }, createdAt: 1, nextAt: null, graceMin: 5 };
  h.conn.receive({ t: "schedule.save", entry, ackId: "s-a" });
  h.conn.receive({ t: "schedule.save", entry: { ...entry, name: "nightly sweep" }, ackId: "s-b" });
  const sched = h.frames().filter((m) => m.t === "schedule.list").at(-1);
  assert.deepEqual(sched.entries.map((e) => e.name), ["nightly sweep"]);
});

test("the sheet-open reads answer with empty lists, not toasts", () => {
  const h = harness(desk());
  for (const t of ["build.list", "capture.list", "fanout.list", "launch.list"]) h.conn.receive({ t, repoDir: REPO });
  assert.deepEqual(h.frames().map((m) => m.t), ["build.list", "capture.list", "fanout.list", "launch.list"]);
});

test("HTTP: repos, gallery, seen, scrollback, storage answer; the rest is 404 in words", () => {
  const h = harness(desk());
  const id = opened(h);
  const get = (path, query) => h.host.request({ method: "GET", path, query });
  assert.equal(JSON.parse(get("/api/repos").body).targets[0].id, "todo");
  assert.equal(JSON.parse(get("/api/repos/todo/artifacts").body).files[0].name, "flow.gif");
  assert.equal(h.host.request({ method: "POST", path: "/api/repos/todo/artifacts/seen" }).status, 200);
  assert.equal(JSON.parse(get("/api/repos").body).targets[0].outboxSeenAt, 1_000_000);
  assert.equal(h.host.request({ method: "POST", path: "/api/repos/todo/inbox/seen" }).status, 200);
  assert.ok(JSON.parse(get("/api/scrollback", { id }).body).lines.join("\n").includes("todo"));
  assert.equal(get("/api/scrollback", { id: "nope" }).status, 404);
  assert.equal(get("/api/context", { id }).status, 404);
  assert.equal(get("/api/storage/host").status, 200);
  assert.equal(get("/api/storage/transport").status, 200);
  assert.equal(JSON.parse(get("/api/health").body).sessions, 1);
  const miss = h.host.request({ method: "POST", path: "/api/host/screenshot" });
  assert.equal(miss.status, 404);
  assert.match(miss.body, /own desktop/);
});

test("limit and prompt faults change the session the way the host's parsed state would", () => {
  const h = harness(desk());
  const id = opened(h);
  h.host.faults.set([
    { kind: "limit", match: { t: "ping", times: 1 }, sessionId: id, resetsInMs: 60_000 },
    { kind: "prompt", match: { t: "session.history", times: 1 }, sessionId: id },
  ]);
  h.conn.receive({ t: "ping" });
  assert.equal(lastUpdate(h).limit.blocked, true);
  assert.equal(lastUpdate(h).limit.resetAt, 1_000_000 + 60_000);
  h.tick(60_000);
  assert.equal(lastUpdate(h).limit, undefined, "the pause lifts at its reset");
  h.conn.receive({ t: "session.history", id });
  assert.equal(lastUpdate(h).prompt.kind, "tool");
});

test("a scripted turn survives the watchdog reload mid-flight", () => {
  const a = harness(desk());
  const id = opened(a);
  a.conn.receive({ t: "session.input", id, data: "mark it done", submit: true, ackId: "i1" });
  const raw = JSON.parse(JSON.stringify(a.host.snapshot()));
  const b = harness(desk(), raw);
  b.conn.receive({ t: "session.attach", id });
  b.tick(200);
  assert.deepEqual(lastUpdate(b).prompt, BOX);
});

test("script events drive sessions too: output and a box at their instant", () => {
  const sc = desk();
  const h = harness(sc);
  const id = opened(h);
  // A script naming the session the scenario seeded is the common case; here
  // the id is minted, so the events are added after the create.
  sc.script.push({ at: 50, event: { kind: "output", sessionId: id, text: "background work\r\n" } });
  h.conn.receive({ t: "session.attach", id });
  h.tick(50);
  assert.match(text(h.frames(), id), /background work/);
});

test("the first-app routes refuse in words: no plan, never a job, a start is a 400 with the reason", async () => {
  const { demoHttp, ONBOARD_NOT_IN_DEMO } = await import("./demohttp.ts");
  const plan = demoHttp({}, 0, { method: "GET", path: "/api/onboard/plan", query: { name: "hello-otter", path: "web" } });
  assert.equal(plan.status, 200);
  const p = JSON.parse(plan.body);
  assert.equal(p.ok, false);
  assert.equal(p.error, ONBOARD_NOT_IN_DEMO);
  assert.deepEqual(p.consent, [], "nothing to consent to");
  assert.deepEqual(JSON.parse(demoHttp({}, 0, { method: "GET", path: "/api/onboard" }).body), { ok: true, job: null });
  for (const path of ["/api/onboard", "/api/onboard/resume"]) {
    const r = demoHttp({}, 0, { method: "POST", path });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error, ONBOARD_NOT_IN_DEMO);
  }
});

test("HTTP: /api/search answers from the gallery the way the host does; /api/tokenstats is an honest empty ledger", async () => {
  const { demoHttp } = await import("./demohttp.ts");
  const f = (name, mtime) => ({ name, relPath: `.claude/outbox/${name}`, mtime, ctime: mtime, size: 1 });
  const m = {
    repos: [
      { id: "a", repoName: "alpha", branch: "main" },
      { id: "b", repoName: "beta", branch: "dev" },
    ],
    gallery: { a: [f("shot.png", 5000), f("notes.md", 9000)], b: [f("Shot-2.PNG", 7000)] },
  };
  const search = (query) => JSON.parse(demoHttp(m, 0, { method: "GET", path: "/api/search", query }).body);
  assert.deepEqual(search({}).hits.map((x) => x.name), ["notes.md", "Shot-2.PNG", "shot.png"], "newest first");
  assert.deepEqual(search({}).hits[1], { repoId: "b", repoName: "beta", branch: "dev", ...f("Shot-2.PNG", 7000) });
  assert.equal(search({}).truncated, false);
  assert.deepEqual(search({ q: "SHOT" }).hits.map((x) => x.name), ["Shot-2.PNG", "shot.png"]);
  assert.deepEqual(search({ kind: "doc" }).hits.map((x) => x.name), ["notes.md"]);
  assert.deepEqual(search({ kind: "image", repos: "a" }).hits.map((x) => x.name), ["shot.png"]);
  assert.deepEqual(search({ repos: "nope" }).hits, []);
  assert.equal(search({ limit: "1" }).truncated, true);
  const at = (now, query) => JSON.parse(demoHttp(m, now, { method: "GET", path: "/api/search", query }).body).hits.map((x) => x.name);
  assert.deepEqual(at(10_000, { since: "4" }), ["notes.md", "Shot-2.PNG"], "since is seconds back from now, on mtime (ms)");

  const r = demoHttp(m, 0, { method: "GET", path: "/api/tokenstats" });
  assert.equal(r.status, 200);
  const doc = JSON.parse(r.body);
  assert.equal(doc.conversations, 0);
  assert.equal(doc.totals.input + doc.totals.output, 0);
  assert.equal(doc.hourOfDay.length, 24);
  assert.deepEqual(doc.days, []);
});
