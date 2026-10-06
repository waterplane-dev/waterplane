/**
 * The local runner's ledger (`localusage.ts`): the server-log parser against
 * REAL lines from ollama 0.35.0 (`fixtures/ollama-server-log.txt`, cut from the
 * spike's own log — docs/analysis/spikes/2026-10-02-local-usage-metrics.md),
 * the attribution rules, the folds, one ledger tick end to end, and the route.
 */
import "../../../scripts/lib-tmuxiso.mjs"; // any tmux this test starts runs in a socket dir of its own
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


const {
  parseRunnerLog, parseGoDuration, pickModel, pickLoad, foldEvent, foldSample, psSample, rotatedOf,
  LocalUsageLedger, setLocalUsageLedger, ollamaLogPath,
} = await import("../dist/localusage.js");
const { handleApi } = await import("../dist/api.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, "fixtures", "ollama-server-log.txt"));
const local = (h, mi, s, d = 2) => new Date(2026, 9, d, h, mi, s).getTime();

// ── Parser ──────────────────────────────────────────────────────────────────

test("the runner's own timings, paired with the access line, exactly as the spike measured", () => {
  const { events, consumed } = parseRunnerLog(FIXTURE);
  assert.equal(consumed, FIXTURE.length, "the fixture ends on a commit point");
  const reqs = events.filter((e) => e.kind === "request");
  assert.equal(reqs.length, 5);
  // /v1/messages, "Say hi in three words." — input 11 + cache_read 3 = task.n_tokens 14.
  const hi = reqs.find((e) => e.path === "/v1/messages" && e.timing.genTok === 4);
  assert.deepEqual(hi, {
    kind: "request", at: local(15, 34, 26), path: "/v1/messages", wallMs: 226.161292, ctxSlot: 65536,
    timing: { promptTok: 11, promptMs: 66.99, cachedTok: 3, genTok: 4, genMs: 26.17 },
  });
  // /api/chat — the same request's own fields: prompt_eval_duration 185994000 ns, 11 − 5 cached, eval 12 in 93.5 ms.
  const chat = reqs.find((e) => e.path === "/api/chat");
  assert.deepEqual(chat.timing, { promptTok: 6, promptMs: 185.99, cachedTok: 5, genTok: 12, genMs: 93.51 });
  assert.equal(chat.wallMs, 3651.523375, "time to answer includes 3.4 s queued behind another request");
});

test("a block whose start was not read is ignored; its access line is a wall-only request", () => {
  const { events } = parseRunnerLog(FIXTURE);
  const resp = events.find((e) => e.path === "/v1/responses");
  assert.deepEqual(resp, { kind: "request", at: local(15, 34, 17), path: "/v1/responses", wallMs: 10629.177167 });
});

test("a load is read once although ollama prints it twice", () => {
  const loads = parseRunnerLog(FIXTURE).events.filter((e) => e.kind === "load");
  assert.deepEqual(loads, [{ kind: "load", at: Date.parse("2026-10-02T07:10:20.847+02:00"), ms: 2780 }]);
});

test("a chunk ending mid-request consumes only up to the last commit point", () => {
  const text = FIXTURE.toString("utf8");
  const cut = text.indexOf('POST     "/api/chat"');
  const head = Buffer.from(text.slice(0, text.lastIndexOf("\n", cut) + 1));
  const { events, consumed } = parseRunnerLog(head);
  assert.ok(!events.some((e) => e.path === "/api/chat"));
  assert.ok(consumed < head.length, "the open /api/chat block is left to be re-read");
  const rest = parseRunnerLog(FIXTURE.subarray(consumed));
  assert.equal(rest.events.filter((e) => e.path === "/api/chat").length, 1, "and is read whole next time, once");
});

test("a partial last line waits for its newline", () => {
  const { consumed } = parseRunnerLog(Buffer.from('[GIN] 2026/10/02 - 15:34:03 | 200 |  56.75µs |  127.0.0.1 | GET  "/api/ps"\n[GIN] 2026/10/02 - 15:3'));
  assert.equal(consumed, Buffer.byteLength('[GIN] 2026/10/02 - 15:34:03 | 200 |  56.75µs |  127.0.0.1 | GET  "/api/ps"\n'));
});

test("two blocks waiting for one access line: both kept, the wall time belongs to nobody", () => {
  const blk = (t, n) => [
    `slot   operator(): id  0 | task ${t} | new prompt, n_ctx_slot = ${n}, n_keep = 4, task.n_tokens = 20`,
    `slot print_timing: id  0 | task ${t} | prompt eval time =      10.00 ms /    20 tokens (x)`,
    `slot print_timing: id  0 | task ${t} |        eval time =      20.00 ms /     5 tokens (x)`,
    `slot print_timing: id  0 | task ${t} |       total time =      30.00 ms /    25 tokens`,
  ].join("\n");
  const buf = Buffer.from(`${blk(3, 65536)}\n${blk(9, 131072)}\n[GIN] 2026/10/02 - 15:00:00 | 200 |  1.5s | 127.0.0.1 | POST     "/v1/messages"\n`);
  const reqs = parseRunnerLog(buf).events;
  assert.equal(reqs.length, 2);
  assert.ok(reqs.every((e) => e.wallMs === undefined && e.path === undefined && e.timing.genTok === 5));
  assert.deepEqual(reqs.map((e) => e.ctxSlot), [65536, 131072]);
});

test("two runners opening the same task id at once: neither block is counted", () => {
  const buf = Buffer.from([
    "slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 65536, n_keep = 4, task.n_tokens = 20",
    "slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 131072, n_keep = 4, task.n_tokens = 30",
    "slot print_timing: id  0 | task 0 | prompt eval time =      10.00 ms /    20 tokens (x)",
    "slot print_timing: id  0 | task 0 |       total time =      30.00 ms /    25 tokens",
    '[GIN] 2026/10/02 - 15:00:00 | 200 |  1.5s | 127.0.0.1 | POST     "/v1/messages"', "",
  ].join("\n"));
  const reqs = parseRunnerLog(buf).events;
  assert.deepEqual(reqs.map((e) => [e.timing, e.wallMs]), [[undefined, 1500]], "only the access line's wall time");
});

test("a failed request with no timings is not counted; noise paths are ignored", () => {
  const buf = Buffer.from([
    '[GIN] 2026/10/02 - 15:00:00 | 500 |  2.1ms | 127.0.0.1 | POST     "/v1/messages"',
    '[GIN] 2026/10/02 - 15:00:01 | 200 |  3.3ms | 127.0.0.1 | POST     "/api/show"',
    '[GIN] 2026/10/02 - 15:00:02 | 200 |  45µs | 127.0.0.1 | GET      "/api/ps"', "",
  ].join("\n"));
  assert.deepEqual(parseRunnerLog(buf).events, []);
});

test("Go durations", () => {
  assert.equal(parseGoDuration("56.75µs"), 0.05675);
  assert.equal(parseGoDuration("226.161292ms"), 226.161292);
  assert.equal(parseGoDuration("3.3996765s"), 3399.6765);
  assert.equal(parseGoDuration("1m2.5s"), 62500);
  assert.equal(parseGoDuration("soon"), null);
});

// ── Attribution ─────────────────────────────────────────────────────────────

const Q = { name: "qwen3-coder:30b-64k", ctx: 65536 };
const G = { name: "gemma4:e4b", ctx: 131072 };
const S = (at, ...models) => ({ at, models });
const T0 = local(15, 0, 0);

test("one model resident either side ⇒ that model", () => {
  const samples = [S(T0, Q), S(T0 + 20_000, Q)];
  assert.equal(pickModel(T0 + 5000, 65536, samples, [], 20_000), Q.name);
});

test("two resident: the slot's context decides, else nobody", () => {
  const samples = [S(T0, Q, G), S(T0 + 20_000, Q, G)];
  assert.equal(pickModel(T0 + 5000, 131072, samples, [], 20_000), G.name);
  assert.equal(pickModel(T0 + 5000, undefined, samples, [], 20_000), null);
  const same = [S(T0, Q, { name: "other", ctx: 65536 }), S(T0 + 20_000, Q, { name: "other", ctx: 65536 })];
  assert.equal(pickModel(T0 + 5000, 65536, same, [], 20_000), null, "same context ⇒ not guessed");
});

test("no sample after it, a sampling gap, or a load ps never showed ⇒ nobody", () => {
  assert.equal(pickModel(T0 + 5000, 65536, [S(T0, Q)], [], 20_000), null);
  assert.equal(pickModel(T0 + 5000, 65536, [S(T0, Q), S(T0 + 600_000, Q)], [], 20_000), null);
  // A model loaded and evicted between two samples while Q stayed resident.
  assert.equal(pickModel(T0 + 5000, 65536, [S(T0, Q), S(T0 + 20_000, Q)], [T0 + 2000], 20_000), null);
  // A load ps DOES show is fine.
  assert.equal(pickModel(T0 + 5000, 65536, [S(T0), S(T0 + 20_000, Q)], [T0 + 2000], 20_000), Q.name);
});

test("a load is the one model new in the next sample", () => {
  assert.equal(pickLoad(T0 + 2000, [S(T0, G), S(T0 + 20_000, G, Q)], 20_000), Q.name);
  assert.equal(pickLoad(T0 + 2000, [S(T0), S(T0 + 20_000, G, Q)], 20_000), null);
});

// ── Folds ───────────────────────────────────────────────────────────────────

test("events fold per model per day, split kept, endpoint counted", () => {
  const days = [];
  const reqs = parseRunnerLog(FIXTURE).events.filter((e) => e.kind === "request" && e.at > local(15, 0, 0));
  for (const e of reqs) foldEvent(days, e, e.timing ? Q.name : null);
  assert.equal(days.length, 1);
  const q = days[0].models.find((m) => m.model === Q.name);
  assert.deepEqual(q.compute, { requests: 3, promptTok: 26, promptMs: 66.99 + 41.72 + 185.99, cachedTok: 11, genTok: 30, genMs: 26.17 + 110.15 + 93.51 });
  assert.equal(q.timed.requests, 3);
  assert.equal(q.untimed, undefined);
  assert.deepEqual(q.byApi, { "/v1/messages": 2, "/api/chat": 1 });
  const nobody = days[0].models.find((m) => m.model === null);
  assert.deepEqual(nobody.untimed, { requests: 1, ms: 10629.177167 });
  assert.equal(nobody.compute, undefined, "no runner timings ⇒ no compute row, never zeros");
});

test("ps samples fold into memory: peak, sum, resident time only across consecutive samples", () => {
  const days = [];
  const body = { models: [{ name: Q.name, size: 25412721704, size_vram: 25412721704, context_length: 65536 }] };
  const mem = { usedBytes: 50e9, availableBytes: 18e9, swapUsedBytes: 1.3e9, source: "vm_stat" };
  const s1 = psSample(T0, body), s2 = psSample(T0 + 20_000, body);
  foldSample(days, s1, null, mem, 20_000);
  foldSample(days, s2, s1, { ...mem, usedBytes: 58e9, availableBytes: 10e9 }, 20_000);
  const r = days[0].models[0];
  assert.deepEqual(r.mem, { samples: 2, sumBytes: 2 * 25412721704, peakBytes: 25412721704, sumVram: 2 * 25412721704, peakVram: 25412721704, residentMs: 20_000, contextLength: 65536 });
  assert.deepEqual(r.machine, { samples: 2, usedSum: 108e9, usedPeak: 58e9, availMin: 10e9, totalBytes: 68e9, swapPeak: 1.3e9, source: "vm_stat" });
  const d2 = [];
  foldSample(d2, s1, null, null, 20_000);
  assert.equal(d2[0].models[0].machine, undefined, "no reader ⇒ absent");
});

// ── The ledger, one tick at a time ──────────────────────────────────────────

test("a tick: starts at the log's END, then counts only new requests, attributed by ps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "localusage-"));
  const log = join(dir, "server.log");
  writeFileSync(log, FIXTURE);
  process.env.WATERPLANE_OLLAMA_LOG = log;
  const ps = { models: [{ name: Q.name, size: 100, size_vram: 100, context_length: 65536 }] };
  const ledger = new LocalUsageLedger(dir, 20_000, async () => ps);
  const now = Date.now();
  await ledger.tick(now);
  let doc = ledger.doc();
  assert.equal(doc.available, true);
  assert.equal(doc.reachable, true);
  assert.deepEqual(doc.loaded, [Q.name]);
  assert.ok(!doc.days.some((d) => d.models.some((m) => m.compute)), "history before the first watch is not back-filled");

  const at = new Date(now + 3000);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}/${p(at.getMonth() + 1)}/${p(at.getDate())} - ${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
  appendFileSync(log, [
    "slot   operator(): id  0 | task 7 | new prompt, n_ctx_slot = 65536, n_keep = 4, task.n_tokens = 120",
    "slot print_timing: id  0 | task 7 | prompt eval time =     100.00 ms /   100 tokens (x)",
    "slot print_timing: id  0 | task 7 |        eval time =     500.00 ms /    40 tokens (x)",
    "slot print_timing: id  0 | task 7 |       total time =     600.00 ms /   140 tokens",
    `[GIN] ${stamp} | 200 |  700ms | 127.0.0.1 | POST     "/v1/messages?beta=true"`, "",
  ].join("\n"));
  await ledger.tick(now + 20_000);
  doc = ledger.doc();
  const rows = doc.days.flatMap((d) => d.models);
  const q = rows.filter((m) => m.model === Q.name && m.compute);
  assert.equal(q.length, 1);
  assert.deepEqual(q[0].compute, { requests: 1, promptTok: 100, promptMs: 100, cachedTok: 20, genTok: 40, genMs: 500 });
  assert.deepEqual(q[0].byApi, { "/v1/messages": 1 });
  assert.ok(!rows.some((m) => m.model === null), "nothing unattributed");

  // A restart resumes at the cursor: nothing counted twice.
  await ledger.tick(now + 60_000); // past SAVE_MS — written
  const again = new LocalUsageLedger(dir, 20_000, async () => ps);
  await again.tick(now + 80_000);
  const n = again.doc().days.flatMap((d) => d.models).filter((m) => m.compute).reduce((a, m) => a + m.compute.requests, 0);
  assert.equal(n, 1);
  delete process.env.WATERPLANE_OLLAMA_LOG;
});

test("ollama not answering: reachable false, nothing sampled, no memory row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "localusage-"));
  process.env.WATERPLANE_OLLAMA_LOG = join(dir, "nope.log");
  const ledger = new LocalUsageLedger(dir, 20_000, async () => { throw new Error("ECONNREFUSED"); });
  await ledger.tick(Date.now());
  const doc = ledger.doc();
  assert.equal(doc.reachable, false);
  assert.deepEqual(doc.loaded, []);
  assert.deepEqual(doc.days, []);
  assert.equal(doc.log.readable, false);
  assert.match(doc.log.reason, /no readable server log/);
  delete process.env.WATERPLANE_OLLAMA_LOG;
});

test("log path: macOS default, the knob, off, and Linux says why", () => {
  assert.deepEqual(ollamaLogPath("darwin", "/Users/me"), { file: "/Users/me/.ollama/logs/server.log" });
  assert.match(ollamaLogPath("linux", "/home/me").reason, /journal/);
  process.env.WATERPLANE_OLLAMA_LOG = "0";
  assert.match(ollamaLogPath("darwin", "/Users/me").reason, /switched off/);
  delete process.env.WATERPLANE_OLLAMA_LOG;
  assert.equal(rotatedOf("/x/server.log"), "/x/server-1.log");
});

// ── A large rotated log: caught up a chunk per tick, the loop never held ──────

/** A synthetic server log of `n` whole requests, all on one past day. */
function bigLog(n, firstLine) {
  const parts = [firstLine];
  const p = (x) => String(x).padStart(2, "0");
  for (let i = 0; i < n; i++) {
    const s = i % 86400;
    const stamp = `2026/01/15 - ${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
    const task = i % 1000;
    parts.push(
      `slot   operator(): id  0 | task ${task} | new prompt, n_ctx_slot = 65536, n_keep = 4, task.n_tokens = ${100 + (i % 50)}`,
      `slot print_timing: id  0 | task ${task} | prompt eval time =     ${(i % 97) + 1}.00 ms /   ${50 + (i % 40)} tokens (x)`,
      `slot print_timing: id  0 | task ${task} |        eval time =     ${(i % 89) + 1}.00 ms /    ${10 + (i % 30)} tokens (x)`,
      `slot print_timing: id  0 | task ${task} |       total time =     1.00 ms /   1 tokens`,
      `[GIN] ${stamp} | 200 |  700ms | 127.0.0.1 | POST     "/v1/messages?beta=true"`,
    );
  }
  return Buffer.from(parts.join("\n") + "\n");
}

/** Run `fn` while measuring the longest stretch the event loop was not handed back. */
async function longestStretch(fn) {
  let max = 0, last = performance.now(), on = true;
  const spin = () => { const t = performance.now(); max = Math.max(max, t - last); last = t; if (on) setImmediate(spin); };
  setImmediate(spin);
  try { await fn(); } finally { on = false; }
  await new Promise((r) => setImmediate(r));
  return max;
}

test("the yielding parse IS the parse: identical events and consumed bytes, fixture and a large log", async () => {
  const { parseRunnerLogYielding } = await import("../dist/localusage.js");
  assert.deepEqual(await parseRunnerLogYielding(FIXTURE), parseRunnerLog(FIXTURE));
  const big = bigLog(20_000, "time=2026-01-15T00:00:00.000Z level=INFO msg=a");
  assert.deepEqual(await parseRunnerLogYielding(big, 1), parseRunnerLog(big));
});

test("a large ROTATED log is drained one chunk per tick, the loop is never held, and nothing is lost or counted twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "localusage-rot-"));
  const log = join(dir, "server.log");
  const header = "time=2026-01-15T00:00:00.000Z level=INFO source=server.go msg=\"first run\"";
  writeFileSync(log, header + "\n");
  process.env.WATERPLANE_OLLAMA_LOG = log;
  try {
    const ledger = new LocalUsageLedger(dir, 20_000, async () => ({ models: [] }));
    let now = Date.now();
    await ledger.tick(now); // cursor at the end of the (one-line) file
    // ~24 MB of requests land, then ollama restarts and rotates.
    const body = bigLog(60_000, header).subarray(header.length + 1);
    appendFileSync(log, body);
    const whole = readFileSync(log);
    const expect = parseRunnerLog(whole).events.filter((e) => e.kind === "request");
    renameSync(log, rotatedOf(log));
    writeFileSync(log, "time=2026-01-16T00:00:00.000Z level=INFO msg=\"second run\"\n");

    // The old behaviour, for scale: the whole file through the parser in one go.
    const t0 = performance.now(); parseRunnerLog(whole); const wholeMs = performance.now() - t0;

    let ticks = 0, worst = 0;
    do {
      now += 20_000;
      worst = Math.max(worst, await longestStretch(() => ledger.tick(now)));
      ticks++;
    } while (ledger.draining && ticks < 50);
    assert.equal(ledger.draining, false, "the rotated file was finished");
    assert.ok(ticks >= Math.ceil(whole.length / (4 * 1024 * 1024)), `one chunk per tick: ${ticks} ticks for ${whole.length} bytes`);
    console.log(`# rotated ${(whole.length / 1e6).toFixed(1)} MB: ${ticks} ticks, longest synchronous stretch ${worst.toFixed(1)} ms (one-go parse: ${wholeMs.toFixed(0)} ms)`);
    assert.ok(worst < 60, `the loop was held ${worst.toFixed(1)} ms in one stretch`);

    const rows = ledger.doc().days.flatMap((d) => d.models).filter((m) => m.compute);
    const sum = (k) => rows.reduce((a, m) => a + m.compute[k], 0);
    assert.equal(sum("requests"), expect.length, "every request counted once");
    assert.equal(sum("promptTok"), expect.reduce((a, e) => a + e.timing.promptTok, 0));
    assert.equal(sum("genTok"), expect.reduce((a, e) => a + e.timing.genTok, 0));
    assert.ok(rows.every((m) => m.model === null), "no ps samples from then: unattributed, never guessed");
  } finally { delete process.env.WATERPLANE_OLLAMA_LOG; }
});

test("a restart mid-drain resumes the rotated file at its cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "localusage-rot2-"));
  const log = join(dir, "server.log");
  const header = "time=2026-01-15T00:00:00.000Z level=INFO msg=\"first run\"";
  writeFileSync(log, header + "\n");
  process.env.WATERPLANE_OLLAMA_LOG = log;
  try {
    let now = Date.now();
    const a = new LocalUsageLedger(dir, 20_000, async () => ({ models: [] }));
    await a.tick(now);
    appendFileSync(log, bigLog(30_000, header).subarray(header.length + 1));
    const n = parseRunnerLog(readFileSync(log)).events.filter((e) => e.kind === "request").length;
    renameSync(log, rotatedOf(log));
    writeFileSync(log, "time=2026-01-16T00:00:00.000Z level=INFO msg=\"second run\"\n");
    now += 60_000; await a.tick(now); // one chunk, and saved (past SAVE_MS)
    assert.equal(a.draining, true);
    const b = new LocalUsageLedger(dir, 20_000, async () => ({ models: [] }));
    for (let i = 0; i < 20 && (i === 0 || b.draining); i++) { now += 60_000; await b.tick(now); }
    assert.equal(b.draining, false);
    const got = b.doc().days.flatMap((d) => d.models).filter((m) => m.compute).reduce((s, m) => s + m.compute.requests, 0);
    assert.equal(got, n, "the restart neither lost nor re-counted a request");
  } finally { delete process.env.WATERPLANE_OLLAMA_LOG; }
});

test("events awaiting a sample are BOUNDED: past the cap the oldest are counted unattributed, never dropped", async () => {
  const { rootStateDir } = await import("../dist/branddirs.js");
  const dir = mkdtempSync(join(tmpdir(), "localusage-cap-"));
  const state = rootStateDir(dir);
  mkdirSync(state, { recursive: true });
  const at = Date.now();
  const ev = (i) => ({ kind: "request", at: at + i, path: "/v1/messages", wallMs: 10 });
  writeFileSync(join(state, "localusage.json"), JSON.stringify({ v: 1, since: at, cursor: null, days: [], unresolved: Array.from({ length: 6000 }, (_, i) => ev(i)) }));
  const ledger = new LocalUsageLedger(dir, 20_000, async () => ({ models: [] }));
  const rows = ledger.doc().days.flatMap((d) => d.models);
  assert.equal(rows.reduce((s, m) => s + (m.untimed?.requests ?? 0), 0), 1000, "exactly the overflow was counted");
  assert.ok(rows.every((m) => m.model === null), "as unattributed");
});

// ── The route ───────────────────────────────────────────────────────────────

async function get(path) {
  const server = createServer((req, res) => { handleApi(req, res, {}).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

test("GET /api/localusage: not started is a sentence at 200; started is the ledger", async () => {
  setLocalUsageLedger(null);
  let r = await get("/api/localusage");
  assert.equal(r.status, 200);
  assert.equal(r.body.available, false);
  assert.match(r.body.reason, /has not started/);

  process.env.WATERPLANE_LOCAL_USAGE = "0";
  r = await get("/api/localusage");
  assert.match(r.body.reason, /switched off/);
  delete process.env.WATERPLANE_LOCAL_USAGE;

  const dir = mkdtempSync(join(tmpdir(), "localusage-"));
  setLocalUsageLedger(new LocalUsageLedger(dir, 20_000, async () => ({ models: [] })));
  r = await get("/api/localusage");
  assert.equal(r.body.available, true);
  assert.equal(r.body.runner, "ollama");
  assert.equal(r.body.reachable, null, "not asked yet");
  assert.ok(typeof r.body.unattributedWhy === "string");
  setLocalUsageLedger(null);
});
