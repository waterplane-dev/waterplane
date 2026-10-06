/**
 * **The reader's per-turn cost is `ctxlog.ts`'s accounting, cut at prompts.**
 *
 * The foot of each reader turn prints what that prompt cost, the running total
 * by then, and the context its last request carried. Three ways it could lie:
 * count a streamed reply once per content block (the CLI repeats the usage on
 * every record of one `message.id`), print a running total off a tail-read log
 * whose start is missing, or charge an unpriced model at zero. Each case below
 * pins one of them, plus the agreement with `readContextLog`'s own total.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseTranscript } = await import("../dist/transcript.js");
const { readContextLog } = await import("../dist/ctxlog.js");

const DIR = mkdtempSync(join(tmpdir(), "waterplane-turncost-"));
let n = 0;
function log(records) {
  const p = join(DIR, `t${n++}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
const T0 = Date.parse("2026-09-20T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const user = (ms, text) =>
  ({ type: "user", uuid: `u${ms}`, timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text }] } });
const reply = (ms, id, usage, model = "claude-sonnet-5", text = "ok") =>
  ({ type: "assistant", uuid: `a${ms}`, timestamp: iso(ms),
     message: { id, model, role: "assistant", usage, content: [{ type: "text", text }] } });
const U = (input, output, cacheRead, cacheWrite) =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });

test("a streamed reply is billed once, and the turns sum to the session total", () => {
  const p = log([
    user(T0, "one"),
    reply(T0 + 1, "m1", U(10, 100, 0, 5000), undefined, "a"),
    reply(T0 + 2, "m1", U(10, 100, 0, 5000), undefined, "b"), // same message, second block
    user(T0 + 10, "two"),
    reply(T0 + 11, "m2", U(5, 200, 5000, 300)),
  ]);
  const d = parseTranscript(p, "/repo");
  const [a, b] = d.turns;
  assert.ok(a.costUsd > 0 && b.costUsd > 0);
  assert.equal(a.cumCostUsd, a.costUsd);
  assert.ok(Math.abs(b.cumCostUsd - (a.costUsd + b.costUsd)) < 1e-12);
  assert.equal(a.ctxTok, 5010);
  assert.equal(b.ctxTok, 5305);
  // The split behind the figure, off the same deduped records: the repeat block is not counted twice.
  assert.deepEqual(a.tokens, { input: 10, output: 100, cacheRead: 0, cacheWrite: 5000 });
  assert.deepEqual(b.tokens, { input: 5, output: 200, cacheRead: 5000, cacheWrite: 300 });
  const whole = readContextLog(p).cost.total;
  assert.ok(Math.abs(b.cumCostUsd - whole) < 1e-9, `${b.cumCostUsd} vs ${whole}`);
});

test("an unpriced model withholds its turn and every running total after it", () => {
  const p = log([
    user(T0, "one"),
    reply(T0 + 1, "m1", U(10, 100, 0, 5000)),
    user(T0 + 10, "two"),
    reply(T0 + 11, "m2", U(10, 100, 0, 5000), "some-local-model"),
    user(T0 + 20, "three"),
    reply(T0 + 21, "m3", U(10, 100, 5000, 0)),
  ]);
  const [a, b, c] = parseTranscript(p, "/repo").turns;
  assert.ok(a.cumCostUsd > 0);
  assert.equal(b.costUsd, undefined);
  assert.equal(b.cumCostUsd, undefined);
  assert.equal(b.ctxTok, 5010); // context is still a measurement
  assert.ok(c.costUsd > 0);
  assert.equal(c.cumCostUsd, undefined);
});

test("a turn with no request carries nothing — absent, never zero", () => {
  const p = log([user(T0, "one"), reply(T0 + 1, "m1", U(0, 0, 0, 0)), user(T0 + 5, "two")]);
  for (const t of parseTranscript(p, "/repo").turns) {
    assert.equal(t.costUsd, undefined);
    assert.equal(t.cumCostUsd, undefined);
    assert.equal(t.ctxTok, undefined);
    assert.equal(t.tokens, undefined);
    assert.equal(t.models, undefined);
  }
});

test("a turn names its models and the kinds of subagent it started", () => {
  const task = (ms, type) => ({ type: "assistant", uuid: `k${ms}`, timestamp: iso(ms),
    message: { id: `mk${ms}`, model: "claude-sonnet-5", role: "assistant", usage: U(1, 1, 0, 0),
      content: [{ type: "tool_use", id: `tu${ms}`, name: "Agent", input: type ? { subagent_type: type, prompt: "x" } : { prompt: "x" } }] } });
  const p = log([
    user(T0, "one"),
    reply(T0 + 1, "m1", U(10, 100, 0, 5000), "claude-opus-5-5"),
    task(T0 + 2, "Explore"), task(T0 + 3, "Explore"), task(T0 + 4, null),
  ]);
  const [t] = parseTranscript(p, "/repo").turns;
  assert.deepEqual(t.models.map((m) => m.id).sort(), ["claude-opus-5-5", "claude-sonnet-5"]);
  const sum = t.models.reduce((a, m) => a + m.costUsd, 0);
  assert.ok(Math.abs(sum - t.costUsd) < 1e-12);
  assert.deepEqual(t.agentTypes, [{ type: "Explore", n: 2 }, { type: "(no type)", n: 1 }]);
});

// ── Subagents, on the turn that started them (`turnagents.ts`) ──────────────

/** A conversation log plus its `subagents/` directory. `agents`: id → {meta, records}. */
function withAgents(records, agents) {
  const p = log(records);
  const dir = join(p.replace(/\.jsonl$/, ""), "subagents");
  mkdirSync(dir, { recursive: true });
  for (const [id, a] of Object.entries(agents)) {
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(a.meta));
    writeFileSync(join(dir, `agent-${id}.jsonl`), a.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (a.mtime) utimesSync(join(dir, `agent-${id}.jsonl`), a.mtime / 1000, a.mtime / 1000);
  }
  return p;
}
const call = (ms, id) => ({ type: "assistant", uuid: `c${ms}`, timestamp: iso(ms),
  message: { id: `mc${ms}`, model: "claude-opus-5-5", role: "assistant", usage: U(1, 1, 0, 0),
    content: [{ type: "tool_use", id, name: "Agent", input: { subagent_type: "general-purpose", prompt: "x", run_in_background: true } }] } });
const launched = (ms, id) => ({ type: "user", uuid: `r${ms}`, timestamp: iso(ms),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Async agent launched" }] } });
const notify = (ms, agentId) => user(ms, `<task-notification><task-id>${agentId}</task-id><status>completed</status></task-notification>`);
const OLD = Date.now() - 3_600_000;

test("a subagent's spend lands on the turn whose call started it, nested ones on their root's", () => {
  const p = withAgents([
    user(T0, "fan out"), call(T0 + 1, "tu1"), launched(T0 + 2, "tu1"), reply(T0 + 3, "m1", U(10, 100, 0, 5000)),
    user(T0 + 10, "next"), reply(T0 + 11, "m2", U(10, 100, 5000, 0)), notify(T0 + 12, "aaa"),
  ], {
    aaa: { meta: { toolUseId: "tu1", requestShape: "background" }, mtime: OLD,
      records: [reply(T0 + 5, "x1", U(10, 1000, 0, 20000), "claude-opus-5-5")] },
    bbb: { meta: { toolUseId: "inner", parentAgentId: "aaa", requestShape: "background" }, mtime: OLD,
      records: [reply(T0 + 6, "x2", U(10, 1000, 0, 20000), "claude-sonnet-5-5")] },
  });
  const [a, b] = parseTranscript(p, "/repo").turns;
  assert.ok(a.agentCostUsd > 0);
  assert.deepEqual(a.agentModels.map((m) => m.id).sort(), ["claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.equal(a.agentsRunning, undefined, "old and retired — not running");
  assert.equal(b.agentCostUsd, undefined);
  assert.equal(b.cumAgentCostUsd, a.agentCostUsd, "the running total carries it forward");
});

test("an agent still writing keeps its turn open; one the parent retired does not", () => {
  const now = Date.now();
  const mk = (retire) => withAgents([
    user(T0, "fan out"), call(T0 + 1, "tu1"), launched(T0 + 2, "tu1"), reply(T0 + 3, "m1", U(10, 100, 0, 5000)),
    ...(retire ? [notify(now + 60_000, "aaa")] : []),
  ], { aaa: { meta: { toolUseId: "tu1", requestShape: "background" }, mtime: now,
    records: [reply(T0 + 5, "x1", U(10, 1000, 0, 20000), "claude-opus-5-5")] } });
  assert.equal(parseTranscript(mk(false), "/repo").turns[0].agentsRunning, 1);
  assert.equal(parseTranscript(mk(true), "/repo").turns[0].agentsRunning, undefined);
});

test("an agent that cannot be placed withholds every running total, not its neighbours' turn figures", () => {
  const p = withAgents([
    user(T0, "fan out"), call(T0 + 1, "tu1"), launched(T0 + 2, "tu1"), reply(T0 + 3, "m1", U(10, 100, 0, 5000)),
  ], {
    aaa: { meta: { toolUseId: "tu1" }, mtime: OLD, records: [reply(T0 + 5, "x1", U(10, 1000, 0, 20000), "claude-opus-5-5")] },
    zzz: { meta: {}, mtime: OLD, records: [reply(T0 + 6, "x2", U(10, 1000, 0, 20000), "claude-opus-5-5")] },
  });
  const [a] = parseTranscript(p, "/repo").turns;
  assert.ok(a.agentCostUsd > 0);
  assert.equal(a.cumAgentCostUsd, undefined);
  assert.ok(a.cumCostUsd > 0, "the conversation's own total is still a measurement");
});
