/**
 * The scenarios this build ships (WP4): every registry entry is shippable and
 * scrubbed, the media its gallery names exists and is small, and `first-look`
 * plays through the real DemoHost — the repo list, a live session, one scripted
 * turn with a choice box answered by tap.
 *
 *     node --test packages/web/src/demo/scenarios/scenarios.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, budgetVerdict, promptFingerprint } from "@waterplane/shared";
import { createDemoHost, assertShippable } from "../host/index.ts";
import { DEMO_SCENARIOS } from "./index.ts";
import { firstLook, CLOCK_START, MEDIA_SIZES, ANDROID_FIXED, ANDROID_SHOT, APK, FIX_MATCH, HOOK_PROMPT, IOS_SHOT } from "./first-look.ts";
import { HOOK_REPLY_MATCH, HOOK_PROMPT as TYPED_PROMPT } from "../../features/demoTour/logic.ts";
import { queueAndSchedule, QUEUED_PROMPT, TURN_END } from "./queue-and-schedule.ts";
import { galleryAndFiles, MEDIA_SIZES as FILE_SIZES } from "./gallery-and-files.ts";
import { numbers, LAST_TOK, WINDOW_TOK } from "./numbers.ts";
import { findLeaks } from "../../../../../tools/demo-scenario.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../../../public");

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test("every bundled scenario is shippable, current and clean", () => {
  const ids = Object.keys(DEMO_SCENARIOS);
  for (const id of ["first-look", "queue-and-schedule", "gallery-and-files", "numbers"]) assert.ok(ids.includes(id), `${id} is registered`);
  for (const id of ids) {
    const sc = DEMO_SCENARIOS[id];
    assert.equal(sc.meta.id, id, "the registry key is the scenario's id");
    assert.equal(sc.meta.protocol, PROTOCOL_VERSION);
    assertShippable(sc);
    assert.deepEqual(findLeaks(sc), [], `${id} leaks something the recording tool's scrub forbids`);
  }
});

test("the scrub would catch a hand edit that leaks", () => {
  const sc = firstLook(CLOCK_START);
  sc.state.model.banner = "cwd /Users/someone/dev/x";
  assert.ok(findLeaks(sc).length > 0);
});

test("every gallery and inbox file is bundled under public/demo/media/<repoId>/ at the size its entry says, under 150 KB", () => {
  const sizes = { ...MEDIA_SIZES, ...FILE_SIZES };
  for (const build of [firstLook, galleryAndFiles]) {
    const m = build(CLOCK_START).state.model;
    for (const [kind, lists] of [["gallery", m.gallery ?? {}], ["inbox", m.inbox ?? {}]]) {
      for (const [repoId, files] of Object.entries(lists)) {
        for (const f of files) {
          const p = join(publicDir, "demo", "media", repoId, f.relPath);
          assert.ok(existsSync(p), `${kind}: ${p} is missing`);
          const size = statSync(p).size;
          assert.equal(size, f.size, `${f.relPath}: entry says ${f.size}, file is ${size}`);
          assert.equal(size, sizes[f.relPath]);
          assert.ok(size < 150 * 1024, `${f.relPath} is ${size} bytes`);
        }
      }
    }
  }
});

test("timestamps follow `now`, so the demo never ages", () => {
  for (const build of [firstLook, queueAndSchedule, galleryAndFiles, numbers]) {
    const a = build(CLOCK_START).state.model.sessions[0].createdAt;
    const b = build(CLOCK_START + 1000).state.model.sessions[0].createdAt;
    assert.equal(b - a, 1000, build.name);
  }
});

function play(build = firstLook) {
  const sc = build(CLOCK_START);
  let now = sc.clock.start;
  const host = createDemoHost(sc, { now: () => now });
  const outs = [];
  const conn = host.connect((o) => outs.push(o));
  const frames = () => outs.filter((o) => o.kind === "frame").map((o) => o.msg);
  const tick = (ms) => { now += ms; host.advance(); };
  return { host, conn, frames, tick };
}

const ptyText = (frames, id) => frames.filter((m) => m.t === "pty" && m.id === id).map((m) => Buffer.from(m.dataB64, "base64").toString("utf8")).join("");

test("first-look: repos, sessions and backlog are there on hello", () => {
  const h = play();
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  const list = h.frames().find((m) => m.t === "session.list");
  assert.deepEqual(list.sessions.map((s) => s.id), ["demo-g1", "demo-n1"]);
  assert.ok(h.frames().some((m) => m.t === "backlog.list" && m.items.length >= 3));
  // A clock rule and a rule anchored to the weekly usage window (the week bar's subject), armed.
  assert.ok(h.frames().some((m) => m.t === "schedule.list" && m.entries.length === 2
    && m.entries.some((e) => e.rule.kind === "window" && typeof e.nextAt === "number")));
  const repos = h.host.request({ method: "GET", path: "/api/repos" });
  assert.deepEqual(JSON.parse(repos.body).targets.map((r) => r.repoName), ["todo-garden", "pocket-notes", "trail-log"]);
  const art = h.host.request({ method: "GET", path: "/api/repos/r1/artifacts" });
  assert.equal(JSON.parse(art.body).files.length, 2);
});

test("first-look: prompt, work lines, a choice box, the answer, the result", () => {
  const h = play();
  const id = "demo-g1";
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  h.conn.receive({ t: "session.attach", id });
  assert.match(ptyText(h.frames(), id), /red left edge/, "the past turn is on the screen");
  h.conn.receive({ t: "session.input", id, data: "add sorting by due date", submit: true, ackId: "a1" });
  h.tick(10_000);
  const upd = () => h.frames().filter((m) => m.t === "session.updated" && m.session.id === id).at(-1).session;
  const box = upd().prompt;
  assert.equal(box.question, "Should the task list be sorted by due date?");
  assert.match(ptyText(h.frames(), id), /Read\u001b\[0m\(src\/store\/tasks.ts\)/);
  h.conn.receive({ t: "session.input", id, data: "1\r", expectPrompt: promptFingerprint(box), ackId: "a2" });
  h.tick(10_000);
  const out = ptyText(h.frames(), id);
  assert.match(out, /Done\. Tasks now sort by due date/);
  assert.match(out, /\.claude\/outbox\/todo-garden-sorted\.png/);
  const doc = JSON.parse(h.host.request({ method: "GET", path: "/api/transcript", query: { id } }).body);
  assert.deepEqual(doc.turns.map((t) => t.prompt), ["make overdue tasks show a red edge", "add sorting by due date"]);
  assert.match(doc.turns[0].blocks[0].text, /red left edge/, "a past turn reads from its stored answer");
  assert.match(doc.turns[1].blocks[0].text, /Done\. Tasks now sort by due date/, "the live turn reads from the PTY");
  assert.equal(upd().turnActive, false);
  assert.equal(upd().prompt, undefined);
  assert.equal(h.host.nextAt(), null);
});

test("queue-and-schedule: the queued prompt waits, then runs in the same session once it is free", () => {
  const h = play(queueAndSchedule);
  const id = "demo-g1";
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  const row = () => h.frames().filter((m) => m.t === "intent.list").at(-1).intents.find((i) => i.id === "i1");
  assert.equal(row().blockReason, "sessionBusy");
  // Three standing rules, all armed: one on a clock, two anchored to the weekly usage reset the header
  // shows — and each is also the intent a real host keeps it as, waiting for its time (Activity's
  // *scheduled*), so Activity does not say "scheduled 0" beside a repo list counting three.
  const entries = h.frames().find((m) => m.t === "schedule.list").entries;
  assert.deepEqual(entries.map((e) => e.enabled), [true, true, true]);
  assert.deepEqual(entries.map((e) => e.rule.kind), ["weekly", "window", "window"]);
  assert.ok(entries.every((e) => typeof e.nextAt === "number" && e.nextAt > CLOCK_START), "every rule is armed");
  const usage = h.frames().find((m) => m.t === "usage.status").usage;
  assert.equal(entries[1].nextAt, usage.weeklyResetAt - 2 * 3_600_000, "two hours before the weekly reset");
  assert.equal(entries[2].nextAt, usage.weeklyResetAt, "right after the weekly reset");
  const scheduled = h.frames().find((m) => m.t === "intent.list").intents.filter((i) => i.id !== "i1");
  assert.deepEqual(scheduled.map((i) => [i.id, i.blockReason]), entries.map((e) => [e.id, "notYet"]));
  const backlog = h.frames().find((m) => m.t === "backlog.list");
  assert.ok(backlog.items.length >= 4);
  assert.equal(backlog.auto, true, "auto is on: no screen says the queued prompt does not start on its own");
  const sess = () => h.frames().filter((m) => m.t === "session.updated" && m.session.id === id).at(-1)?.session
    ?? h.frames().find((m) => m.t === "session.list").sessions.find((s) => s.id === id);
  assert.equal(sess().turnActive, true, "the session is mid-turn when the demo opens");
  h.conn.receive({ t: "session.attach", id });
  h.tick(TURN_END + 100);
  assert.equal(sess().turnActive, false);
  assert.equal(sess().idle, true);
  h.tick(500);
  assert.equal(sess().turnActive, true, "the queued turn is running");
  assert.equal(row().state, "running", "the row changes verdict, it does not vanish");
  h.tick(2_000);
  const out = ptyText(h.frames(), id);
  assert.ok(out.includes(QUEUED_PROMPT), "the queued words were delivered into the session");
  assert.match(out, /grouped by day/);
  assert.equal(sess().turnActive, false);
  assert.equal(row().state, "done");
  assert.equal(h.host.nextAt(), null);
});

test("gallery-and-files: six outbox files in r1, one in r3, one inbox upload", () => {
  const h = play(galleryAndFiles);
  const get = (p) => JSON.parse(h.host.request({ method: "GET", path: p }).body).files;
  assert.deepEqual(get("/api/repos/r1/artifacts").map((f) => f.name).filter((n) => /\.(html|md)$/.test(n)).sort(), ["todo-garden-preview.html", "todo-garden-release-notes.md"]);
  assert.equal(get("/api/repos/r1/artifacts").filter((f) => f.name.endsWith(".png")).length, 4);
  assert.equal(get("/api/repos/r3/artifacts").length, 1);
  assert.deepEqual(get("/api/repos/r1/inbox").map((f) => f.name), ["swipe-sketch.png"]);
});

test("numbers: every reading is self-consistent and arrives on hello", () => {
  const h = play(numbers);
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  const f = (t) => h.frames().find((m) => m.t === t);
  const usage = f("usage.status").usage;
  const budget = f("budget.state");
  assert.deepEqual(budget.verdict, budgetVerdict(budget.budget, usage, CLOCK_START), "the verdict is the shared maths' own answer");
  assert.ok(f("meter.status"));
  assert.equal(f("clihealth"), undefined, "a reading the model does not carry is absent");
  const doc = JSON.parse(h.host.request({ method: "GET", path: "/api/context", query: { id: "demo-g1" } }).body);
  const last = doc.samples.at(-1).tok;
  assert.equal(last, LAST_TOK);
  const left = f("session.list").sessions[0].contextLeft;
  assert.equal(left, Math.round((1 - last / WINDOW_TOK) * 100), "the tab's meter says what the series ends at");
  assert.ok(doc.samples.every((s, i, a) => i === 0 || s.t > a[i - 1].t), "samples are in time order");
});

test("first-look: no headline screen is empty, and its numbers agree with each other", () => {
  const h = play(firstLook);
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  const f = (t) => h.frames().find((m) => m.t === t);
  const usage = f("usage.status").usage;
  const budget = f("budget.state");
  assert.deepEqual(budget.verdict, budgetVerdict(budget.budget, usage, CLOCK_START), "the verdict is the shared maths' own answer");
  assert.ok(f("meter.status"));
  assert.equal(f("clihealth").rollup.verdict, "healthy");
  h.conn.receive({ t: "sent.get" });
  h.conn.receive({ t: "decisions.get" });
  for (const t of ["notification.list", "decisions.log", "sent.log", "pull.list", "install.log"]) {
    const m = f(t);
    assert.ok(m, `${t} arrives on hello`);
    assert.ok((m.items ?? m.entries ?? m.doc?.entries ?? []).length > 0, `${t} has rows`);
  }
  for (const t of ["intent.list", "launch.list", "delivery.list"]) {
    assert.ok((f(t).intents ?? f(t).launches ?? f(t).items).length > 0, `${t} has rows`);
  }
  assert.ok(h.host.request({ method: "GET", path: "/api/repos/r1/inbox" }).body.includes("swipe-sketch.png"));
  for (const s of f("session.list").sessions) {
    const doc = JSON.parse(h.host.request({ method: "GET", path: "/api/context", query: { id: s.id } }).body);
    const last = doc.samples.at(-1).tok;
    assert.equal(s.contextLeft, Math.round((1 - last / doc.windowTok) * 100), `${s.id}: the tab's meter says what the series ends at`);
    assert.ok(doc.samples.every((x, i, a) => i === 0 || x.t > a[i - 1].t), "samples are in time order");
  }
});

test("first-look media: every file the scenario names is bundled at its stated size", () => {
  for (const [rel, size] of Object.entries(MEDIA_SIZES)) {
    const repo = rel.includes("trail-log") ? "r3" : "r1";
    const p = join(publicDir, "demo", "media", repo, rel);
    assert.ok(existsSync(p), `${p} is missing`);
    assert.equal(statSync(p).size, size, rel);
  }
});

const last = (frames, t, pred = () => true) => frames.filter((m) => m.t === t && pred(m)).at(-1);

/** The cued tap: `+ now` on todo-garden starts a NEW session there (`session.create`). Its id. */
const startHook = (h) => {
  h.conn.receive({ t: "session.create", cwd: "~/dev/todo-garden", ackId: "start" });
  const id = last(h.frames(), "session.created").session.id;
  h.conn.receive({ t: "session.attach", id });
  return id;
};
/** The hook's first prompt, as the demo types and sends it from the compose box (`typeHookPrompt`). */
const sendHook = (h, id) => h.conn.receive({ t: "session.input", id, data: HOOK_PROMPT, submit: true, ackId: "hook" });

test("first-look hook: a new session in todo-garden opens on Claude Code's header; its typed prompt builds, checks two devices and lands both screenshots", () => {
  const h = play();
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  const id = startHook(h);
  assert.notEqual(id, "demo-g1", "a session of its own, beside the older one");
  assert.match(ptyText(h.frames(), id), /Claude Code/, "the CLI's own welcome header (R-demo-016)");
  assert.equal(h.host.nextAt(), null, "nothing runs before the prompt is sent");
  sendHook(h, id);
  assert.match(ptyText(h.frames(), id), /check iOS sim and Android emulator/, "the sent prompt is on the screen");
  h.tick(1_000);
  const mid = last(h.frames(), "session.updated", (m) => m.session.id === id).session;
  assert.ok(mid.turnActive && mid.contextLeft < 100, "the context meter moves while the turn runs");
  h.tick(10_000);
  const out = ptyText(h.frames(), id);
  assert.match(out, /xcrun simctl io booted screenshot/);
  assert.match(out, /adb exec-out screencap/);
  const end = last(h.frames(), "session.updated", (m) => m.session.id === id).session;
  assert.equal(end.turnActive, false);
  assert.equal(end.contextSpark.pts.at(-1), 128_000, "the spark the cost line reads ends where the meter does");
  assert.equal(end.contextSpark.baseTok, 56_000, "a fresh session's start");
  const shots = h.frames().filter((m) => m.t === "session.images" && m.id === id).flatMap((m) => m.images.map((i) => i.relPath));
  assert.deepEqual(shots, [IOS_SHOT, ANDROID_SHOT], "① iOS, then ② Android");
  const art = JSON.parse(h.host.request({ method: "GET", path: "/api/repos/r1/artifacts" }).body).files;
  assert.deepEqual(art.slice(0, 2).map((f) => f.relPath).sort(), [ANDROID_SHOT, IOS_SHOT].sort(), "the gallery shows both first");
  const doc = JSON.parse(h.host.request({ method: "GET", path: "/api/transcript", query: { id } }).body);
  const [hook] = doc.turns;
  assert.equal(hook.prompt, HOOK_PROMPT);
  assert.equal(hook.ctxTok, 128_000);
  assert.ok(hook.costUsd > 0 && hook.tokens.cacheRead > 0, "priced, with its split");
  assert.ok(Math.abs(hook.cumCostUsd - hook.costUsd) < 1e-12, "the first turn of its conversation");
  const tok = hook.tokens.input + hook.tokens.output + hook.tokens.cacheRead + hook.tokens.cacheWrite;
  assert.equal(hook.models[0].tok, tok, "the model split sums to the token split");
  assert.equal(h.host.nextAt(), null);
});

test("first-look hook: the combined picture sent back with 'make ② look like ①' gets a fix on both, an after screenshot and the APK in the outbox", () => {
  const h = play();
  h.conn.receive({ t: "hello", protocol: PROTOCOL_VERSION });
  const id = startHook(h);
  sendHook(h, id);
  h.tick(14_000);
  const name = "collage-2-marked-1.jpg";
  const up = h.host.request({ method: "POST", path: "/api/repos/r1/inbox", bodyBytes: 4321, headers: { "x-file-name": encodeURIComponent(name) } });
  assert.equal(up.status, 200);
  assert.ok(`make ② ${HOOK_REPLY_MATCH} ①`.includes(FIX_MATCH));
  h.conn.receive({ t: "session.input", id, data: `.claude/inbox/${name} (2 screenshots side by side, numbered; marked: 1 circle) make ② look like ①`, submit: true, ackId: "b1" });
  h.tick(14_000);
  const out = ptyText(h.frames(), id);
  assert.match(out, /I see your circle in ②/);
  assert.match(out, /gradlew assembleDebug/);
  assert.ok(out.includes(ANDROID_FIXED));
  assert.equal(last(h.frames(), "session.images").images[0].relPath, ANDROID_FIXED);
  // The build reaches the phone the way the real host says it: one outbox notification, a tap to download.
  const apk = last(h.frames(), "notification").item;
  assert.equal(apk.kind, "artifact");
  assert.equal(apk.title, "Outbox: todo-garden-debug.apk");
  assert.match(apk.body, /^8\.4 MB · .* — tap to download$/);
  assert.equal(apk.file.relPath, APK);
  const art = JSON.parse(h.host.request({ method: "GET", path: "/api/repos/r1/artifacts" }).body).files;
  assert.equal(art[0].relPath, APK, "listed in the outbox");
  const s = last(h.frames(), "session.updated", (m) => m.session.id === id).session;
  assert.equal(s.turnActive, false);
  const doc = JSON.parse(h.host.request({ method: "GET", path: "/api/transcript", query: { id } }).body);
  const t = doc.turns.at(-1);
  assert.equal(t.ctxTok, 151_000);
  assert.ok(t.costUsd > 0 && t.cumCostUsd > doc.turns.at(-2).cumCostUsd);
  // The fix sent three agents: their spend is split out of the prompt's figure, by model and by kind,
  // and every running total is the turns summed — the conversation's own and the agents' apart.
  near(t.agentCostUsd, t.agentModels.reduce((a, m) => a + m.costUsd, 0), "agent models sum to the agents' figure");
  assert.ok(t.agentCostUsd > 3 * t.costUsd, "most of this prompt was its agents");
  assert.deepEqual(t.agentTypes, [{ type: "Explore", n: 2 }, { type: "code-reviewer", n: 1 }]);
  near(t.cumCostUsd, doc.turns.reduce((a, x) => a + x.costUsd, 0), "the conversation's running total");
  near(t.cumAgentCostUsd, doc.turns.reduce((a, x) => a + (x.agentCostUsd ?? 0), 0), "the agents' running total");
});

test("the hook's reply match is the one the demo tour waits for", async () => {
  const sc = firstLook(CLOCK_START);
  assert.equal(HOOK_REPLY_MATCH, FIX_MATCH);
  assert.ok(sc.state.model.replies.some((r) => r.match === HOOK_REPLY_MATCH), "a scripted reply answers the combine-and-send-back prompt");
  assert.equal(TYPED_PROMPT, HOOK_PROMPT, "the demo types the prompt the hook turn answers");
  assert.equal(sc.state.model.replies[0].match, HOOK_PROMPT, "and that reply is the first rule, so no other one catches it");
});
