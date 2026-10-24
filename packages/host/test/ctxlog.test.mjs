/**
 * The context-window series, read off the CLI's own conversation log.
 *
 * What these fixtures pin is mostly what must NOT get plotted. A graph is a
 * claim about a shape, and every one of the records below is a real record from
 * a real log that would bend that shape the wrong way if it were counted:
 *
 *  - a streaming turn is written several times with one `message.id` and one
 *    usage block, so counting each puts three identical points on one instant;
 *  - a usage-limit rejection is itself written as an assistant turn, with
 *    `<synthetic>` for a model and a usage block of zeros, so plotting it draws
 *    a cliff to zero at exactly the moment nothing happened;
 *  - a subagent's turns carry a different conversation's context entirely.
 *
 * And the one positive rule with teeth: the downsampler may bound the count but
 * may never flatten a tooth — the peak before a compaction and the floor after
 * it are the whole story of the graph.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCumOf, agentEnvelope, agentSpendAt, agentUsage, liveAgentOf, downsample, projectContextLog, readContextLog, sparkOf, updateContextLog, withAgentRuns } from "../dist/ctxlog.js";

const DIR = mkdtempSync(join(tmpdir(), "waterplane-ctxlog-"));
// The >24 MB read-cap fixtures leave ~100 MB here; never keep it past the file.
after(() => rmSync(DIR, { recursive: true, force: true }));
let n = 0;

const iso = (ms) => new Date(ms).toISOString();

/** An ordinary assistant turn. `tok` is split over the three fields that make
 *  up the context a request carried, because the sum is what is plotted. */
const turn = (at, id, tok, extra = {}) => JSON.stringify({
  type: "assistant",
  timestamp: iso(at),
  uuid: `u${id}`,
  ...extra,
  message: {
    id,
    model: "claude-opus-5",
    role: "assistant",
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: tok - 2 - 100,
      cache_creation_input_tokens: 100,
      output_tokens: 500,
    },
  },
});

/** The rejection row: an assistant turn with a synthetic model and zero usage. */
const rejection = (at, resetAt, type = "five_hour") => JSON.stringify({
  type: "assistant",
  timestamp: iso(at),
  message: {
    id: `synth-${at}`,
    model: "<synthetic>",
    role: "assistant",
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
  },
  quotaLimits: { status: "rejected", resetsAt: Math.floor(resetAt / 1000), rateLimitType: type },
});

const compact = (at, trigger, preTokens, postTokens) => JSON.stringify({
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
  timestamp: iso(at),
  compactMetadata: { trigger, preTokens, postTokens, durationMs: 1000 },
});

/** A prompt somebody typed — what a turn IS. */
const prompt = (at, text) => JSON.stringify({
  type: "user",
  timestamp: iso(at),
  uuid: `p${at}`,
  userType: "external",
  message: { role: "user", content: text },
});

/** A tool result. Written as a `user` record too, which is the whole trap: the
 *  bulk of a log is these, and none of them is a turn. */
const toolResult = (at, id) => JSON.stringify({
  type: "user",
  timestamp: iso(at),
  uuid: `r${at}`,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});

/** A local command (`/model`) — the CLI writes an envelope of tags, and the
 *  reader gives it a turn of its own, so the count must too. */
const slash = (at, name, args = "") => JSON.stringify({
  type: "user",
  timestamp: iso(at),
  uuid: `s${at}`,
  message: {
    role: "user",
    content: `<command-name>${name}</command-name>\n<command-args>${args}</command-args>`,
  },
});

function logFile(lines) {
  const p = join(DIR, `c${n++}.jsonl`);
  writeFileSync(p, lines.length ? lines.join("\n") + "\n" : "");
  return p;
}

/** Append, the way the CLI does. */
const append = (p, lines) => appendFileSync(p, lines.join("\n") + "\n");

/** Append WITHOUT the trailing newline — a record caught mid-write. */
const appendPartial = (p, text) => appendFileSync(p, text);

const T0 = Date.parse("2026-09-01T10:00:00.000Z");

test("plots the context a request carried, not the tokens it produced", () => {
  const doc = readContextLog(logFile([turn(T0, "m1", 30_000)]));
  assert.equal(doc.samples.length, 1);
  // 2 + 29 898 + 100 — output_tokens (500) is deliberately not in the READING.
  // It IS in `used`, the running total beside it: output is not context until
  // the turn after, but it was spent the moment it was written.
  // …and the sample carries WHAT it was made of, and WHICH model made it: the
  // kinds in `TOKEN_KINDS` order (input, output, cache read, cache write) and
  // an index into the document's model table. `tok` is the first, third and
  // fourth summed; the output sits in the tuple and out of the reading.
  assert.deepEqual(doc.samples[0], {
    t: T0, tok: 30_000, used: 30_500,
    kinds: [2, 500, 29_898, 100], cum: [2, 500, 29_898, 100], model: 0,
  });
  assert.deepEqual(doc.models, ["claude-opus-5"]);
  const [input, output, cacheRead, cacheWrite] = doc.samples[0].kinds;
  assert.equal(input + cacheRead + cacheWrite, doc.samples[0].tok, "the three that ARE context");
  assert.equal(output, doc.samples[0].used - doc.samples[0].tok, "and the one that is not");
});

test("the cumulative tuple sums to `used` at every reading, thinning and all", () => {
  // The stacked spend chart is drawn from `cum`, and the headline above it is
  // `usageTok`. A cumsum the phone folded out of the SURVIVING samples would
  // end below that headline on any conversation long enough to be thinned —
  // two totals that nearly agree, which is the worst number this file can
  // produce. So it is a recorded counter, like `used` beside it.
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(turn(T0 + i * 1_000, `a${i}`, 30_000 + i * 1_000));
  const doc = readContextLog(logFile(lines));
  for (const s of doc.samples) {
    assert.equal(s.cum.reduce((n, v) => n + v, 0), s.used, `at ${s.t}`);
  }
  // …and it only ever rises, which is what makes it stackable at all.
  for (let i = 1; i < doc.samples.length; i++) {
    for (let k = 0; k < 4; k++) {
      assert.ok(doc.samples[i].cum[k] >= doc.samples[i - 1].cum[k], `kind ${k} fell at ${i}`);
    }
  }
  const last = doc.samples[doc.samples.length - 1];
  assert.equal(last.cum[0] + last.cum[2] + last.cum[3] + last.cum[1], doc.usageTok);
});

test("the running total rises with every request and never falls", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 30_000),
    turn(T0 + 60_000, "m2", 90_000),
    compact(T0 + 90_000, "auto", 90_000, 20_000),
    turn(T0 + 120_000, "m3", 20_000),
  ]));
  const used = doc.samples.map((s) => s.used);
  // 30 500 · +90 500 · +20 500. The compaction cuts the READING by 70k and
  // moves the total not at all — the whole reason they are two series.
  assert.deepEqual(used, [30_500, 121_000, 141_500]);
  assert.deepEqual(doc.samples.map((s) => s.tok), [30_000, 90_000, 20_000]);
  // The last sample's total is the figure the same parse prints as `usageTok`:
  // one counter, never a fold over the readings, which skip a request that
  // carried nothing readable.
  assert.equal(doc.usageTok, 141_500);
});

test("a streaming turn repeated under one message id is ONE point", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 30_000),
    turn(T0 + 400, "m1", 30_000),
    turn(T0 + 1_300, "m1", 30_000),
    turn(T0 + 5_000, "m2", 34_000),
  ]));
  assert.deepEqual(doc.samples.map((s) => s.tok), [30_000, 34_000]);
});

test("the rejection's own zero-usage turn is not a cliff to zero", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 120_000),
    rejection(T0 + 1_000, T0 + 3_600_000),
    turn(T0 + 7_200_000, "m2", 124_000),
  ]));
  assert.deepEqual(doc.samples.map((s) => s.tok), [120_000, 124_000]);
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].kind, "limit");
  assert.equal(doc.events[0].t, T0 + 1_000);
  assert.equal(doc.events[0].resetAt, T0 + 3_600_000);
  assert.equal(doc.events[0].weekly, undefined);
});

test("a non-five_hour rejection is marked weekly", () => {
  const doc = readContextLog(logFile([rejection(T0, T0 + 86_400_000, "seven_day")]));
  assert.equal(doc.events[0].weekly, true);
});

test("a subagent's turns belong to a different conversation's window", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 30_000),
    turn(T0 + 1_000, "m2", 400_000, { isSidechain: true }),
    turn(T0 + 2_000, "m3", 31_000),
  ]));
  assert.deepEqual(doc.samples.map((s) => s.tok), [30_000, 31_000]);
});

test("a compaction carries its trigger and both sides of the drop", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 880_000),
    compact(T0 + 1_000, "auto", 881_715, 6_512),
    turn(T0 + 2_000, "m2", 6_600),
  ]));
  assert.deepEqual(doc.events, [{ kind: "compact", t: T0 + 1_000, trigger: "auto", preTok: 881_715, postTok: 6_512 }]);
  // An OBSERVED auto-compact threshold — a measurement, never relabelled as
  // the window size, which the log does not record at all.
  assert.equal(doc.autoCompactTok, 881_715);
  assert.equal(doc.windowTok, undefined); // the window is the caller's, not the log's
});

test("a manual /compact is not an auto-compact threshold", () => {
  const doc = readContextLog(logFile([compact(T0, "manual", 116_187, 6_521)]));
  assert.equal(doc.events[0].trigger, "manual");
  assert.equal(doc.autoCompactTok, null);
});

test("the newest auto-compact wins — the threshold can move mid-conversation", () => {
  const doc = readContextLog(logFile([
    compact(T0, "auto", 180_000, 6_000),
    compact(T0 + 10_000, "auto", 900_000, 7_000),
  ]));
  assert.equal(doc.autoCompactTok, 900_000);
});

test("samples come out in time order whatever the file's order", () => {
  const doc = readContextLog(logFile([
    turn(T0 + 5_000, "m2", 31_000),
    turn(T0, "m1", 30_000),
  ]));
  assert.deepEqual(doc.samples.map((s) => s.t), [T0, T0 + 5_000]);
});

test("garbage lines are skipped, not fatal", () => {
  const doc = readContextLog(logFile(["not json at all", "{oops", turn(T0, "m1", 30_000)]));
  assert.equal(doc.samples.length, 1);
});

test("a missing log is null; an empty one is an empty series", () => {
  assert.equal(readContextLog(join(DIR, "nope.jsonl")), null);
  const doc = readContextLog(logFile([]));
  assert.deepEqual(doc.samples, []);
  assert.deepEqual(doc.events, []);
  assert.equal(doc.truncated, false);
});

// ── the downsampler ───────────────────────────────────────────────────────

test("downsample keeps a short series byte-identical", () => {
  const s = [{ t: 1, tok: 10 }, { t: 2, tok: 20 }];
  assert.equal(downsample(s, 10), s);
});

test("downsample bounds the count", () => {
  const s = Array.from({ length: 5_000 }, (_, i) => ({ t: i, tok: i }));
  assert.ok(downsample(s, 100).length <= 100);
});

test("downsample keeps the peak before a drop and the floor after it", () => {
  // One sawtooth: a long climb to 900k, a compaction to 6k, another climb.
  const s = [];
  for (let i = 0; i < 500; i++) s.push({ t: i, tok: 1_000 + i * 1_800 });
  for (let i = 0; i < 500; i++) s.push({ t: 500 + i, tok: 6_000 + i * 100 });
  const out = downsample(s, 40);
  const toks = out.map((p) => p.tok);
  assert.ok(toks.includes(899_200), `peak lost: max was ${Math.max(...toks)}`);
  assert.ok(toks.includes(6_000), `floor lost: min was ${Math.min(...toks)}`);
  // And the shape is still monotonic in time, or the graph draws backwards.
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t >= out[i - 1].t);
});

// ── the incremental cursor ────────────────────────────────────────────────
//
// This is where an appending reader loses data in ways no type-check sees, so
// each of these is a way that has actually cost somebody a graph.

test("a second pass reads only what was appended, and agrees with a fresh read", () => {
  const p = logFile([turn(T0, "m1", 30_000)]);
  const c1 = updateContextLog(p, null);
  append(p, [turn(T0 + 1_000, "m2", 31_000), turn(T0 + 2_000, "m3", 32_000)]);
  const c2 = updateContextLog(p, c1);
  assert.deepEqual(c2.samples.map((s) => s.tok), [30_000, 31_000, 32_000]);
  assert.deepEqual(projectContextLog(c2), projectContextLog(updateContextLog(p, null)));
});

test("a record caught MID-WRITE is not consumed, and lands on the next pass", () => {
  const p = logFile([turn(T0, "m1", 30_000)]);
  const half = turn(T0 + 1_000, "m2", 31_000);
  appendPartial(p, half.slice(0, 40)); // no newline: the CLI is still writing
  const c1 = updateContextLog(p, null);
  assert.deepEqual(c1.samples.map((s) => s.tok), [30_000]);
  appendPartial(p, half.slice(40) + "\n");
  const c2 = updateContextLog(p, c1);
  assert.deepEqual(c2.samples.map((s) => s.tok), [30_000, 31_000]);
});

test("a streaming duplicate split ACROSS two passes is still one point", () => {
  const p = logFile([turn(T0, "m1", 30_000)]);
  const c1 = updateContextLog(p, null);
  append(p, [turn(T0 + 300, "m1", 30_000)]);
  const c2 = updateContextLog(p, c1);
  assert.deepEqual(c2.samples.map((s) => s.tok), [30_000]);
});

test("a log that SHRANK is re-read from scratch, not appended to", () => {
  const p = logFile([turn(T0, "m1", 30_000), turn(T0 + 1_000, "m2", 31_000)]);
  const c1 = updateContextLog(p, null);
  writeFileSync(p, turn(T0 + 5_000, "m9", 9_000) + "\n");
  const c2 = updateContextLog(p, c1);
  assert.deepEqual(c2.samples.map((s) => s.tok), [9_000]);
});

test("a cursor for a DIFFERENT path is never reused", () => {
  const a = logFile([turn(T0, "m1", 30_000)]);
  const b = logFile([turn(T0, "m2", 7_000)]);
  const c = updateContextLog(b, updateContextLog(a, null));
  assert.equal(c.path, b);
  assert.deepEqual(c.samples.map((s) => s.tok), [7_000]);
});

// ── the row miniature ─────────────────────────────────────────────────────

test("a spark tick sits on the cliff it names, not beside it", () => {
  // 40 readings climbing, a compaction, 40 readings from the floor. The spark
  // holds 16 of them; the tick has to land at the index where the drop shows.
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(turn(T0 + i * 1_000, `a${i}`, 100_000 + i * 20_000));
  lines.push(compact(T0 + 40_000, "auto", 900_000, 6_000));
  for (let i = 0; i < 40; i++) lines.push(turn(T0 + 41_000 + i * 1_000, `b${i}`, 20_000 + i * 1_000));
  const cur = updateContextLog(logFile(lines), null);
  const spark = sparkOf(cur, null, "none");
  assert.ok(spark.pts.length <= 16);
  assert.equal(spark.marks.length, 1);
  const at = spark.marks[0].at;
  const idx = Math.round(at * (spark.pts.length - 1));
  // The reading at the tick is on the high side; the one after is on the low
  // side. That is what "the tick is on the cliff" means.
  assert.ok(spark.pts[idx] > spark.pts[idx + 1], `tick at ${idx}: ${spark.pts.join(",")}`);
  // `peak` is the FULL series' maximum, not the selection's.
  assert.equal(spark.peak, 100_000 + 39 * 20_000);
});

test("the log names the model the window is derived from", () => {
  // The authority on what actually ran — and the only source a CLOSED session
  // has, since there is no live `SessionInfo` to ask and its graph must keep
  // the same axis as everyone else's.
  const cur = updateContextLog(logFile([
    turn(T0, "m1", 30_000),
    rejection(T0 + 1_000, T0 + 3_600_000),  // `<synthetic>` must not win
  ]), null);
  assert.equal(cur.model, "claude-opus-5");
});

test("the effort is the newest turn's, off the same record as its model", () => {
  // `SessionInfo.turnEffort`: an `/effort high` typed after launch shows here
  // and nowhere else. A record without one CLEARS it — never the previous
  // turn's effort beside this turn's model.
  const cur = updateContextLog(logFile([
    turn(T0, "e1", 30_000, { effort: "xhigh" }),
    turn(T0 + 1_000, "e2", 31_000, { effort: "high" }),
  ]), null);
  assert.equal(cur.effort, "high");
  const bare = updateContextLog(logFile([
    turn(T0, "e3", 30_000, { effort: "xhigh" }),
    turn(T0 + 1_000, "e4", 31_000),
  ]), null);
  assert.equal(bare.effort, null);
});

test("a spark carries the known window and the observed compact point, unchanged", () => {
  const cur = updateContextLog(logFile([
    turn(T0, "m1", 30_000),
    compact(T0 + 1_000, "auto", 180_000, 6_000),
  ]), null);
  const spark = sparkOf(cur, 200_000, "model");
  assert.equal(spark.windowTok, 200_000);
  assert.equal(spark.windowFrom, "model");
  assert.equal(spark.autoCompactTok, 180_000);
});

test("no readings yet ⇒ no spark at all, rather than a flat line", () => {
  assert.equal(sparkOf(updateContextLog(logFile([]), null), null, "none"), null);
});

test("a spark carries the spend curve alongside the readings, index for index", () => {
  // The row's second miniature. It is the CUMULATIVE spend at each of the same
  // sampled readings, so a launcher row can say how a session got to its total
  // and not only what the total is.
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(turn(T0 + i * 1_000, `a${i}`, 100_000 + i * 20_000));
  const spark = sparkOf(updateContextLog(logFile(lines), null), null, "none");
  assert.equal(spark.usedPts.length, spark.pts.length);
  // It cannot fall — that is the whole difference from `pts`, which a
  // compaction drops to a third.
  for (let i = 1; i < spark.usedPts.length; i++) {
    assert.ok(spark.usedPts[i] >= spark.usedPts[i - 1], `fell at ${i}: ${spark.usedPts.join(",")}`);
  }
  // The curve is the MAIN conversation's own spend, so its end is the total
  // this session reports minus the subagent share.
  const agents = { tok: 5_000_000 };
  const withAgents = sparkOf(updateContextLog(logFile(lines), null), null, "none", agents);
  assert.equal(withAgents.usageTok - withAgents.agentTok, withAgents.usedPts.at(-1));
});

test("a spark carries the baseline off the FULL series, not off its own points", () => {
  // What a turn in a FRESH session here costs — the denominator of the cost
  // chip. `pts` is downsampled keeping each bucket's MAX, so reading the
  // baseline off `pts[0]` would quote a later, larger reading and make every
  // long conversation look cheaper than it is.
  // A conversation that climbed and compacted EARLY, which is where the two
  // diverge: `downsample` emits each bucket's pair in time order, so the first
  // bucket's peak comes out first and `pts[0]` is 300k where the session's
  // first turn was 80k.
  const toks = [80_000, 300_000, 20_000];
  for (let i = 0; i < 57; i++) toks.push(30_000 + i * 5_000);
  const lines = toks.map((tok, i) => turn(T0 + i * 1_000, `a${i}`, tok));
  const spark = sparkOf(updateContextLog(logFile(lines), null), null, "none");
  assert.equal(spark.baseTok, 80_000);
  assert.ok(spark.pts[0] > spark.baseTok, `pts[0]=${spark.pts[0]} is not the baseline`);
  // NOT `toks.length`: these are readings, and the log holds no user record at
  // all, so nothing opened a turn. The two numbers are different facts.
  assert.equal(spark.turns, 0);
  // Every reading summed — the volume this conversation has actually carried.
  assert.equal(spark.spentTok, toks.reduce((a, b) => a + b, 0));
});

/**
 * The turn count.
 *
 * It used to be `samples.length`, which is one per REQUEST — and the outline
 * button that printed it said 24 over a conversation the outline itself listed
 * four turns for. These pin the two apart.
 */
test("a turn that ran many tools is ONE turn, whatever it cost in requests", () => {
  const doc = readContextLog(logFile([
    prompt(T0, "do the thing"),
    turn(T0 + 1_000, "m1", 30_000),
    toolResult(T0 + 1_500, "t1"),
    turn(T0 + 2_000, "m2", 31_000),
    toolResult(T0 + 2_500, "t2"),
    turn(T0 + 3_000, "m3", 32_000),
    prompt(T0 + 9_000, "and the next thing"),
    turn(T0 + 10_000, "m4", 40_000),
  ]));
  assert.equal(doc.samples.length, 4);
  assert.equal(doc.turns, 2);
});

test("a local command is a turn — the reader lists it as one", () => {
  const doc = readContextLog(logFile([
    slash(T0, "model", "opus"),
    prompt(T0 + 1_000, "go"),
    turn(T0 + 2_000, "m1", 30_000),
  ]));
  assert.equal(doc.turns, 2);
});

test("a prompt that TALKS about tool results is still a turn", () => {
  // The cheap pre-filter skips any line carrying `"type":"tool_result"`. Inside
  // a JSON string every quote is escaped, so a prompt quoting that text cannot
  // forge the sequence — and this is the fixture that says so, because getting
  // it wrong silently undercounts exactly the conversations about this code.
  const doc = readContextLog(logFile([
    prompt(T0, 'why is {"type":"tool_result"} not a turn?'),
    turn(T0 + 1_000, "m1", 30_000),
  ]));
  assert.equal(doc.turns, 1);
});

test("a subagent's prompts are not this conversation's turns", () => {
  const doc = readContextLog(logFile([
    prompt(T0, "go"),
    JSON.stringify({ ...JSON.parse(prompt(T0 + 500, "subagent brief")), isSidechain: true }),
    turn(T0 + 1_000, "m1", 30_000),
  ]));
  assert.equal(doc.turns, 1);
});

test("hook echoes and the resume caveat open no turn", () => {
  const doc = readContextLog(logFile([
    prompt(T0, "<user-prompt-submit-hook>context</user-prompt-submit-hook>"),
    prompt(T0 + 100, "Caveat: The messages below were generated by the user while running local commands."),
    prompt(T0 + 200, "the real one"),
    turn(T0 + 1_000, "m1", 30_000),
  ]));
  assert.equal(doc.turns, 1);
});

test("turns keep counting across an incremental read, and reset on a rewrite", () => {
  const p = logFile([prompt(T0, "one"), turn(T0 + 1_000, "m1", 30_000)]);
  let cur = updateContextLog(p, null);
  assert.equal(cur.turns, 1);
  append(p, [prompt(T0 + 2_000, "two"), turn(T0 + 3_000, "m2", 40_000)]);
  cur = updateContextLog(p, cur);
  assert.equal(cur.turns, 2);
  // A shorter file wearing the same name is a different conversation.
  writeFileSync(p, prompt(T0, "fresh") + "\n");
  cur = updateContextLog(p, cur);
  assert.equal(cur.turns, 1);
});

// ── What the session SPENT ────────────────────────────────────────────────
//
// A different question from the one the curve answers, and the reason it needed
// its own counters: the readings are the input side of THIS conversation, while
// the bill is those plus what every turn wrote plus everything the Task tool's
// agents spent in logs this file never plots.

test("usageTok is the readings PLUS what the turns generated", () => {
  const doc = readContextLog(logFile([turn(T0, "m1", 30_000), turn(T0 + 1_000, "m2", 31_000)]));
  // `turn()` writes 500 output tokens per turn; the samples carry neither.
  assert.deepEqual(doc.samples.map((s) => s.tok), [30_000, 31_000]);
  assert.equal(doc.usageTok, 30_000 + 31_000 + 500 + 500);
});

test("a streaming duplicate is not spent twice, and a rejection spends nothing", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 30_000),
    turn(T0 + 400, "m1", 30_000),
    rejection(T0 + 1_000, T0 + 3_600_000),
  ]));
  assert.equal(doc.usageTok, 30_500);
});

test("usageTok survives the readings being capped", () => {
  // The counter is running, not a fold over `samples` — otherwise the longest
  // conversations, the only ones that hit the cap, would report the smallest
  // spend. 30 turns, the series downsampled to 8 points on the way out.
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(turn(T0 + i * 1_000, `m${i}`, 50_000));
  const cur = updateContextLog(logFile(lines), null);
  assert.equal(cur.usageTok, 30 * 50_500);
  assert.equal(projectContextLog(cur).usageTok, 30 * 50_500);
  assert.equal(downsample(cur.samples, 8).length <= 8, true);
});

// ── The subagents ─────────────────────────────────────────────────────────
//
// Measured on this desktop: 0 of 7,761 logs in this repo carry an inline
// `isSidechain` record, and the agents' tokens are all in
// `<conversation>/subagents/agent-*.jsonl` instead. So the sidechain guard in
// the series stays, and the spend is read off that directory.

/** A subagent's own log line — same shape, `isSidechain`, its own file. */
const agentTurn = (at, id, tok, out = 300) => JSON.stringify({
  type: "assistant",
  isSidechain: true,
  timestamp: iso(at),
  message: {
    id,
    model: "claude-opus-5",
    role: "assistant",
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: tok - 2 - 100,
      cache_creation_input_tokens: 100,
      output_tokens: out,
    },
  },
});

function agentDir(files) {
  const dir = join(DIR, `subs${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, name), lines.join("\n") + "\n");
  }
  return dir;
}

test("a directory that was never created is zero agents, not a failure", () => {
  // The CLI makes it when the first agent runs, so its absence IS the
  // measurement — and the phone may print a total that says so.
  const use = agentUsage(join(DIR, "no-such-session", "subagents"), null);
  assert.deepEqual({ tok: use.tok, logs: use.logs }, { tok: 0, logs: 0 });
});

test("a conversation log past the 24 MB read cap is read WHOLE: its first turn is in the total and the chart", () => {
  // A tail read started the totals, the compactions and the chart in the
  // middle and printed them as complete; the head is the part it dropped.
  const pad = JSON.stringify({ type: "user", message: { content: "x".repeat(1024 * 1024) } });
  const doc = readContextLog(logFile([turn(T0, "m1", 30_000), ...Array(26).fill(pad), turn(T0 + 60_000, "m2", 90_000)]));
  assert.equal(doc.usageTok, 30_500 + 90_500);
  assert.equal(doc.samples.length, 2);
  assert.equal(doc.truncated, false);
});

test("an agent log past the 24 MB read cap is counted from its FIRST record, not its tail", () => {
  // Measured: a 246 MB implementer log read from its last 24 MB put 307M on
  // the screen for 786M spent. The head of the log is the part a tail drops.
  const pad = JSON.stringify({ type: "user", message: { content: "x".repeat(1024 * 1024) } });
  const dir = agentDir({
    "agent-big.jsonl": [agentTurn(T0, "first", 50_000), ...Array(26).fill(pad), agentTurn(T0 + 1_000, "last", 60_000)],
  });
  assert.equal(agentUsage(dir, null).tok, 50_000 + 60_000 + 300 * 2);
});

test("every agent log is summed, input and output alike", () => {
  const dir = agentDir({
    "agent-a.jsonl": [agentTurn(T0, "a1", 40_000), agentTurn(T0 + 1_000, "a2", 41_000)],
    "agent-b.jsonl": [agentTurn(T0, "b1", 9_000)],
    "agent-a.meta.json": ['{"agentType":"Explore"}'],
  });
  const use = agentUsage(dir, null);
  assert.equal(use.tok, 40_000 + 41_000 + 9_000 + 300 * 3);
  assert.equal(use.logs, 2); // the `.meta.json` is not a transcript
});

test("an agent's streaming duplicates and its rejection turn are not spent", () => {
  const dir = agentDir({
    "agent-a.jsonl": [agentTurn(T0, "a1", 40_000), agentTurn(T0 + 300, "a1", 40_000), rejection(T0 + 1_000, T0 + 60_000)],
  });
  assert.equal(agentUsage(dir, null).tok, 40_300);
});

test("a second pass adds only what the agent has written since", () => {
  const dir = agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 40_000)] });
  const c1 = agentUsage(dir, null);
  assert.equal(c1.tok, 40_300);
  append(join(dir, "agent-a.jsonl"), [agentTurn(T0 + 1_000, "a2", 41_000)]);
  const c2 = agentUsage(dir, c1);
  assert.equal(c2.tok, 40_300 + 41_300);
  // And a fresh cursor over the same directory agrees.
  assert.equal(agentUsage(dir, null).tok, c2.tok);
});

test("an agent log that vanished keeps its tally", () => {
  // Those tokens were spent. A total that drops while you watch reads as a
  // broken readout, not as housekeeping in a directory nobody is looking at.
  const dir = agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 40_000)] });
  const c1 = agentUsage(dir, null);
  rmSync(join(dir, "agent-a.jsonl"));
  assert.equal(agentUsage(dir, c1).tok, 40_300);
});

test("the spark carries the TOTAL and the agent share, or neither", () => {
  const cur = updateContextLog(logFile([turn(T0, "m1", 30_000), turn(T0 + 1_000, "m2", 31_000)]), null);
  const use = agentUsage(agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 40_000)] }), null);
  const spark = sparkOf(cur, null, "none", use);
  assert.equal(spark.agentTok, 40_300);
  assert.equal(spark.usageTok, 30_500 + 31_500 + 40_300);
  // Nobody looked at the directory ⇒ no total at all. A figure that silently
  // leaves the agents out is the one wrong number this must never publish.
  const blind = sparkOf(cur, null, "none");
  assert.equal(blind.usageTok, undefined);
  assert.equal(blind.agentTok, undefined);
});

// ── The split: the same tokens, by kind ───────────────────────────────────
//
// "16M spent" with nothing beside it is the number `shared/tokens.ts` opens by
// calling this app's most misleading: 96% of it, measured over this desktop's
// corpus, is the conversation being re-read out of the prompt cache. The
// screens are only allowed to print the total because the split travels with
// it, and the split is only worth anything if it is the SAME pass over the
// SAME records — a second tally with its own guards would drift by a few
// percent and be impossible to argue with.

test("the split accounts for every token the total counts, and no others", () => {
  const cur = updateContextLog(logFile([
    turn(T0, "m1", 30_000),
    turn(T0 + 300, "m1", 30_000),            // a streaming duplicate
    rejection(T0 + 500, T0 + 60_000),        // the wall's own zero-usage turn
    turn(T0 + 1_000, "m2", 31_000),
  ]), null);
  const doc = projectContextLog(cur);
  const s = doc.split;
  // Both turns: 2 fresh + (tok - 102) cache read + 100 cache write + 500 out.
  assert.deepEqual(
    { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite },
    { input: 4, output: 1_000, cacheRead: 30_000 - 102 + 31_000 - 102, cacheWrite: 200 },
  );
  // The invariant the two screens rest on. Written out rather than via
  // `tokenTotal` so this test still fails if that function changes meaning.
  assert.equal(s.input + s.output + s.cacheRead + s.cacheWrite, doc.usageTok);
  // Requests, not prompts: the duplicate and the rejection are excluded by the
  // same guards that keep them out of the total.
  assert.equal(s.turns, 2);
});

test("split.turns counts REQUESTS while turns counts prompts", () => {
  // A turn that ran three tools sent four requests. `cacheReading` divides
  // context by requests on the all-sessions screen, so this one must too or
  // the same conversation reads two ways depending which screen you opened.
  const doc = readContextLog(logFile([
    prompt(T0, "do the thing"),
    turn(T0 + 1, "m1", 10_000),
    toolResult(T0 + 2, "t1"),
    turn(T0 + 3, "m2", 11_000),
    toolResult(T0 + 4, "t2"),
    turn(T0 + 5, "m3", 12_000),
  ]));
  assert.equal(doc.turns, 1);
  assert.equal(doc.split.turns, 3);
});

test("the 1-hour cache-write tier is read, not assumed", () => {
  // It prices at 2x input against 1.25x for the 5-minute one, and it is what
  // `cacheReading`'s payback ratio is blended over. A record that carries no
  // `cache_creation` block simply prices at the cheaper tier.
  const withTier = JSON.parse(turn(T0, "m1", 30_000));
  withTier.message.usage.cache_creation = { ephemeral_1h_input_tokens: 80, ephemeral_5m_input_tokens: 20 };
  const doc = readContextLog(logFile([JSON.stringify(withTier), turn(T0 + 1_000, "m2", 31_000)]));
  assert.equal(doc.split.cacheWrite, 200);
  assert.equal(doc.split.cacheWrite1h, 80);
});

test("a re-read from scratch produces the same split as an incremental one", () => {
  const p = logFile([turn(T0, "m1", 30_000)]);
  const c1 = updateContextLog(p, null);
  append(p, [turn(T0 + 1_000, "m2", 31_000)]);
  const c2 = updateContextLog(p, c1);
  assert.deepEqual(c2.split, readContextLog(p).split);
});

test("the agents' tokens are split the same way, and sum to their total", () => {
  const use = agentUsage(agentDir({
    "agent-a.jsonl": [agentTurn(T0, "a1", 40_000), agentTurn(T0 + 1_000, "a2", 41_000)],
    "agent-b.jsonl": [agentTurn(T0, "b1", 9_000)],
  }), null);
  const s = use.split;
  assert.equal(s.input + s.output + s.cacheRead + s.cacheWrite, use.tok);
  assert.equal(s.input, 6);
  assert.equal(s.output, 900);
  assert.equal(s.cacheWrite, 300);
  assert.equal(s.turns, 3);
});

test("an agent log that vanished keeps its split, like its total", () => {
  const dir = agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 40_000)] });
  const c1 = agentUsage(dir, null);
  rmSync(join(dir, "agent-a.jsonl"));
  assert.deepEqual(agentUsage(dir, c1).split, c1.split);
});

test("a record with nothing on it is not a request on either screen", () => {
  // `tokenstats.ts` drops an all-zero usage block before its own turn counter.
  // The totals are the same either way; the DENOMINATOR is not, and both
  // screens divide context by it.
  const empty = JSON.parse(turn(T0 + 500, "m2", 30_000));
  empty.message.usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  const doc = readContextLog(logFile([turn(T0, "m1", 30_000), JSON.stringify(empty)]));
  assert.equal(doc.split.turns, 1);
  assert.equal(doc.split.input + doc.split.output + doc.split.cacheRead + doc.split.cacheWrite, doc.usageTok);
});

// ── What those tokens COST ────────────────────────────────────────────────
//
// The launcher row prints money now, not a token count, because `38M` and `18M`
// side by side say nothing about which conversation was the expensive one — the
// answer is the model each ran and how much of the traffic was cache reads at a
// tenth of the rate. That makes this fold the thing standing behind a dollar
// figure on screen, and the cases below are the ways it can be confidently
// wrong by a large factor: charging the whole conversation at the model that
// happened to run LAST, silently charging zero for a model nobody has a rate
// for, and disagreeing with the all-sessions screen about the same records.

test("the cost is the same pass as the split, and adds up per kind", () => {
  const doc = readContextLog(logFile([turn(T0, "m1", 1_000_000)]));
  const s = doc.split;
  // Opus 5: $5/MTok in, $25 out, cache read a tenth, a 5-minute write 1.25x.
  const want = (s.input * 5 + s.output * 25 + s.cacheRead * 0.5 + s.cacheWrite * 6.25) / 1e6;
  assert.ok(Math.abs(doc.cost.total - want) < 1e-9, `${doc.cost.total} vs ${want}`);
  assert.ok(Math.abs(doc.cost.total - (doc.cost.input + doc.cost.output + doc.cost.cacheRead + doc.cost.cacheWrite)) < 1e-12);
  assert.equal(doc.unpricedTok, 0);
});

test("each record is priced on ITS OWN model, not the newest one", () => {
  // A conversation that switched models mid-way is the ordinary case, and
  // pricing `split` as a whole afterwards would have to pick one rate — the
  // newest, which is what `cur.model` is. Haiku's rates are a fifth of Opus's,
  // so charging a haiku turn at opus is a 5x error on that line.
  const haiku = JSON.parse(turn(T0, "h1", 1_000_000));
  haiku.message.model = "claude-haiku-4-5";
  const mixed = readContextLog(logFile([JSON.stringify(haiku), turn(T0 + 1_000, "m2", 1_000_000)]));
  const bothOpus = readContextLog(logFile([turn(T0, "m1", 1_000_000), turn(T0 + 1_000, "m2", 1_000_000)]));
  const bothHaiku = readContextLog(logFile([JSON.stringify(haiku), JSON.stringify({ ...JSON.parse(turn(T0 + 1_000, "h2", 1_000_000)), message: { ...JSON.parse(turn(T0 + 1_000, "h2", 1_000_000)).message, model: "claude-haiku-4-5" } })]));
  // The mixed conversation lands between the two uniform ones — which it cannot
  // do if either model's rate was applied to both records.
  assert.ok(bothHaiku.cost.total < mixed.cost.total && mixed.cost.total < bothOpus.cost.total,
    `${bothHaiku.cost.total} < ${mixed.cost.total} < ${bothOpus.cost.total}`);
  assert.ok(Math.abs(mixed.cost.total - (bothHaiku.cost.total + bothOpus.cost.total) / 2) < 1e-9);
  assert.equal(mixed.model, "claude-opus-5", "the newest model is still what the WINDOW is derived from");
});

test("a model with no published rate is counted, never charged zero", () => {
  // A rate table goes stale the week after it is written. The tokens that fall
  // through it have to surface as usage the screen can name — a silent zero
  // reads as "this was free", and it makes the figure low by an unknown amount.
  const odd = JSON.parse(turn(T0, "x1", 1_000_000));
  odd.message.model = "claude-opus-9-3";
  const doc = readContextLog(logFile([JSON.stringify(odd)]));
  assert.equal(doc.cost, null, "nothing priced ⇒ no cost at all, not a breakdown of zeros");
  assert.equal(doc.unpricedTok, doc.usageTok);
  // Beside a real record the cost is true and LOW, and says so.
  const some = readContextLog(logFile([JSON.stringify(odd), turn(T0 + 1_000, "m2", 1_000_000)]));
  assert.ok(some.cost.total > 0);
  assert.equal(some.unpricedTok, doc.usageTok);
});

test("the rejection turn and a streaming duplicate cost nothing, like the tokens", () => {
  // Same guards as the split, because it is the same bag: a record counted
  // twice would be money counted twice.
  const one = readContextLog(logFile([turn(T0, "m1", 30_000)]));
  const noisy = readContextLog(logFile([
    turn(T0, "m1", 30_000),
    turn(T0 + 300, "m1", 30_000),
    rejection(T0 + 1_000, T0 + 60_000),
  ]));
  assert.equal(noisy.cost.total, one.cost.total);
  assert.equal(noisy.unpricedTok, 0, "`<synthetic>` is not an unpriced model");
});

test("a re-read from scratch costs the same as an incremental one", () => {
  const p = logFile([turn(T0, "m1", 30_000)]);
  const c1 = updateContextLog(p, null);
  append(p, [turn(T0 + 1_000, "m2", 31_000)]);
  const c2 = updateContextLog(p, c1);
  assert.deepEqual(projectContextLog(c2).cost, readContextLog(p).cost);
});

test("the spark's cost is the conversation's PLUS its agents', or absent", () => {
  const cur = updateContextLog(logFile([turn(T0, "m1", 1_000_000)]), null);
  const use = agentUsage(agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 1_000_000)] }), null);
  const spark = sparkOf(cur, null, "none", use);
  assert.ok(Math.abs(spark.costUsd - (projectContextLog(cur).cost.total + use.cost.total)) < 1e-12);
  assert.equal(spark.agentCostUsd, use.cost.total);
  assert.ok(spark.agentCostUsd > 0 && spark.agentCostUsd < spark.costUsd);
  // Nobody looked at the subagent directory ⇒ no figure at all, exactly as
  // `usageTok` behaves. A bill that leaves eight conversations out is worse
  // than no bill.
  const blind = sparkOf(cur, null, "none");
  assert.equal(blind.costUsd, undefined);
  assert.equal(blind.agentCostUsd, undefined);
});

test("a session nothing could price publishes no cost, and the row falls back", () => {
  const odd = JSON.parse(turn(T0, "x1", 500_000));
  odd.message.model = "claude-opus-9-3";
  const cur = updateContextLog(logFile([JSON.stringify(odd)]), null);
  const spark = sparkOf(cur, null, "none", agentUsage(agentDir({}), null));
  assert.equal(spark.costUsd, undefined, "absent, never 0 — a 0 chip reads as free");
  assert.equal(spark.unpricedTok, cur.usageTok, "…and what it could not price is named");
  assert.ok(spark.usageTok > 0, "the token total is still there to fall back to");
});

test("the agents are priced on their own models too", () => {
  // A fan-out that runs haiku workers under an opus parent is the ordinary
  // shape, and it is the case where charging the agents at the parent's rate is
  // a 5x error on most of the bill.
  const cheap = JSON.parse(agentTurn(T0, "a1", 1_000_000));
  cheap.message.model = "claude-haiku-4-5";
  const h = agentUsage(agentDir({ "agent-a.jsonl": [JSON.stringify(cheap)] }), null);
  const o = agentUsage(agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 1_000_000)] }), null);
  assert.equal(h.tok, o.tok, "the same tokens…");
  assert.ok(Math.abs(h.cost.total * 5 - o.cost.total) < 1e-9, "…at a fifth of the money");
});

test("an agent log that vanished keeps its cost, like its total", () => {
  const dir = agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 40_000)] });
  const c1 = agentUsage(dir, null);
  rmSync(join(dir, "agent-a.jsonl"));
  assert.deepEqual(agentUsage(dir, c1).cost, c1.cost);
});

// ── Which model ran what, and when the agents ran ─────────────────────────
//
// Two stacked charts rest on these: the samples stacked by model, and one bar
// per subagent launch coloured by the model it ran. Both read an INDEX into one
// table, which is the thing that can be silently wrong — a table sorted without
// its indices rewritten is a chart with the right bars in the wrong colours,
// and nothing about it looks broken.

test("the model table is ordered by VOLUME, and every index is rewritten with it", () => {
  // First-seen order is haiku, then opus. Opus carries far more, so the table
  // comes out opus-first — and the sample that haiku produced must still point
  // at haiku afterwards.
  const haiku = (at, id, tok) => {
    const r = JSON.parse(turn(at, id, tok));
    r.message.model = "claude-haiku-4-5";
    return JSON.stringify(r);
  };
  const doc = readContextLog(logFile([
    haiku(T0, "h1", 10_000),
    turn(T0 + 1_000, "m2", 500_000),
    turn(T0 + 2_000, "m3", 600_000),
  ]));
  assert.deepEqual(doc.models, ["claude-opus-5", "claude-haiku-4-5"], "the dominant model takes slot 0");
  assert.deepEqual(doc.samples.map((s) => doc.models[s.model]),
    ["claude-haiku-4-5", "claude-opus-5", "claude-opus-5"],
    "…and each sample still names the model that actually ran it");
});

test("a projection never rewrites the live cursor's own samples", () => {
  // `downsample` hands back the cursor's own array under the cap, so a
  // re-pointing done in place would renumber the cursor every read — and the
  // second projection would re-point the already-re-pointed indices.
  const p = logFile([turn(T0, "m1", 30_000), turn(T0 + 1_000, "m2", 31_000)]);
  const cur = updateContextLog(p, null);
  const a = projectContextLog(cur);
  const b = projectContextLog(cur);
  assert.deepEqual(a.samples, b.samples, "two projections of one cursor agree");
  assert.deepEqual(a.models, b.models);
});

test("a record with no model leaves the index off rather than pointing at slot 0", () => {
  const anon = JSON.parse(turn(T0, "m1", 30_000));
  delete anon.message.model;
  const doc = readContextLog(logFile([JSON.stringify(anon), turn(T0 + 1_000, "m2", 31_000)]));
  assert.equal(doc.samples[0].model, undefined, "absent — slot 0 would be a claim");
  assert.equal(doc.models[doc.samples[1].model], "claude-opus-5");
});

test("every agent is a dated event with a size and a model", () => {
  const dir = agentDir({
    "agent-a.jsonl": [agentTurn(T0, "a1", 40_000), agentTurn(T0 + 60_000, "a2", 41_000)],
    "agent-b.jsonl": [agentTurn(T0 + 30_000, "b1", 9_000)],
    "agent-a.meta.json": ['{"agentType":"Explore","description":"look at the thing"}'],
  });
  const use = agentUsage(dir, null);
  assert.equal(use.runs.length, 2);
  // Oldest first, so the bars come out in the order they happened.
  assert.deepEqual(use.runs.map((r) => r.id), ["a", "b"]);
  const [a, b] = use.runs;
  assert.equal(a.at, T0, "its FIRST record is when it started");
  assert.equal(a.endAt, T0 + 60_000, "…and its last is when it stopped writing");
  assert.equal(a.tok, 40_300 + 41_300);
  assert.equal(a.modelId, "claude-opus-5");
  assert.equal(a.type, "Explore", "the task type comes off its own meta file");
  assert.ok(a.costUsd > 0);
  assert.equal(b.type, undefined, "no meta file ⇒ no label, and still a row");
  assert.equal(b.at, T0 + 30_000);
  // The roster is the same tokens as the total, not a second tally.
  assert.equal(use.runs.reduce((n, r) => n + r.tok, 0), use.tok);
});

test("an agent whose log carries no clock is counted and NOT placed in time", () => {
  // It spent what it spent. A bar drawn at the epoch is a claim about when,
  // and this chart's whole x axis is when.
  const undated = JSON.parse(agentTurn(T0, "a1", 40_000));
  delete undated.timestamp;
  const use = agentUsage(agentDir({ "agent-a.jsonl": [JSON.stringify(undated)] }), null);
  assert.equal(use.tok, 40_300, "the tokens are real");
  assert.deepEqual(use.runs, [], "…the event is not");
});

test("an agent's model is folded into the table even when the parent never ran it", () => {
  // The ordinary fan-out shape: haiku workers under an opus parent. Dropping
  // that model would colour most of a fan-out session's bars "unknown".
  const cheap = JSON.parse(agentTurn(T0, "a1", 40_000));
  cheap.message.model = "claude-haiku-4-5";
  const cur = updateContextLog(logFile([turn(T0, "m1", 30_000)]), null);
  const use = agentUsage(agentDir({ "agent-a.jsonl": [JSON.stringify(cheap)] }), null);
  const { models, agents } = withAgentRuns(projectContextLog(cur).models, use.runs);
  assert.deepEqual(models, ["claude-opus-5", "claude-haiku-4-5"]);
  assert.equal(models[agents[0].model], "claude-haiku-4-5");
  assert.equal(agents[0].modelId, undefined, "the id does not travel beside the index");
});

test("a dated snapshot is the SAME model as its alias, not a second band", () => {
  // Measured on a real conversation here: a parent and one of its own subagents
  // took separate slots because the log spelled the model two ways, and the bar
  // came out a different colour from the band above it while both sentences
  // named one model.
  const dated = JSON.parse(turn(T0 + 1_000, "m2", 31_000));
  dated.message.model = "claude-opus-5-20260401";
  const long = JSON.parse(turn(T0 + 2_000, "m3", 32_000));
  long.message.model = "claude-opus-5[1m]";
  const doc = readContextLog(logFile([turn(T0, "m1", 30_000), JSON.stringify(dated), JSON.stringify(long)]));
  assert.deepEqual(doc.models, ["claude-opus-5"], "one model, however it was spelled");
  assert.deepEqual(doc.samples.map((x) => x.model), [0, 0, 0]);
  // …and it is still PRICED on the raw id, which is where a dated snapshot
  // belongs: the alias is for banding, the rate is for billing.
  assert.ok(doc.cost.total > 0);
});

test("an agent on a dated snapshot of its parent's model is not a second band", () => {
  const dated = JSON.parse(agentTurn(T0, "a1", 40_000));
  dated.message.model = "claude-opus-5-20260401";
  const cur = updateContextLog(logFile([turn(T0, "m1", 30_000)]), null);
  const use = agentUsage(agentDir({ "agent-a.jsonl": [JSON.stringify(dated)] }), null);
  const { models, agents } = withAgentRuns(projectContextLog(cur).models, use.runs);
  assert.deepEqual(models, ["claude-opus-5"]);
  assert.equal(agents[0].model, 0);
});

test("a model the parent DID run is not appended twice", () => {
  const cur = updateContextLog(logFile([turn(T0, "m1", 30_000)]), null);
  const use = agentUsage(agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 40_000)] }), null);
  const { models, agents } = withAgentRuns(projectContextLog(cur).models, use.runs);
  assert.deepEqual(models, ["claude-opus-5"]);
  assert.equal(agents[0].model, 0);
});

// ── The agents' spend over time, and their windows on the row ─────────────

test("the agents' running total ends EXACTLY at agentTok, overlaps added", () => {
  // Two agents writing at the same time: their spend adds, and the curve's
  // last point is the same figure the headline prints.
  const dup = agentTurn(T0 + 20_000, "a2", 41_000);
  const use = agentUsage(agentDir({
    "agent-a.jsonl": [agentTurn(T0, "a1", 40_000), dup, dup, agentTurn(T0 + 60_000, "a3", 42_000)],
    "agent-b.jsonl": [agentTurn(T0 + 10_000, "b1", 9_000), agentTurn(T0 + 30_000, "b2", 9_500)],
  }), null);
  const cum = agentCumOf(use);
  assert.equal(cum[cum.length - 1][1], use.tok, "the last point is the total");
  assert.deepEqual(cum.map(([t]) => t), [T0, T0 + 10_000, T0 + 20_000, T0 + 30_000, T0 + 60_000]);
  assert.equal(cum[1][1], 40_300 + 9_300, "the second agent's first request is ADDED to the first's");
  for (let i = 1; i < cum.length; i++) assert.ok(cum[i][1] >= cum[i - 1][1], "a running total never falls");
});

test("the agents' spend lands on the spark's readings, the last one being the total", () => {
  const use = agentUsage(agentDir({
    "agent-a.jsonl": [agentTurn(T0, "a1", 40_000), agentTurn(T0 + 60_000, "a3", 42_000)],
    "agent-b.jsonl": [agentTurn(T0 + 10_000, "b1", 9_000)],
  }), null);
  const cum = agentCumOf(use);
  const at = agentSpendAt([T0 - 1, T0 + 15_000, T0 + 30_000], use);
  assert.equal(at[0], 0, "nothing spent before the first agent ran");
  assert.equal(at[1], cum[1][1], "step-held at the running total");
  assert.equal(at[2], use.tok, "spend after the newest reading still lands on the last one");
  for (let i = 1; i < at.length; i++) assert.ok(at[i] >= at[i - 1]);
  assert.equal(agentSpendAt([T0], agentUsage(agentDir({}), null)), null, "no agent spend ⇒ absent");
});

test("an undated record is counted at its log's next dated one, an undated log at the end", () => {
  const undated = JSON.parse(agentTurn(T0 + 5_000, "a2", 1_000));
  delete undated.timestamp;
  const lost = JSON.parse(agentTurn(T0, "c1", 7_000));
  delete lost.timestamp;
  const use = agentUsage(agentDir({
    "agent-a.jsonl": [agentTurn(T0, "a1", 40_000), JSON.stringify(undated), agentTurn(T0 + 60_000, "a3", 42_000)],
    "agent-c.jsonl": [JSON.stringify(lost)],
  }), null);
  const cum = agentCumOf(use);
  assert.equal(cum[cum.length - 1][1], use.tok);
  assert.equal(cum[0][1], 40_300);
  assert.equal(cum[1][1], 40_300 + 1_300 + 42_300 + 7_300);
});

test("thinning keeps true values of the running total and the exact last point", () => {
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(agentTurn(T0 + i * 1_000, `a${i}`, 1_000 + i));
  const use = agentUsage(agentDir({ "agent-a.jsonl": lines }), null);
  const cum = agentCumOf(use, 120);
  assert.ok(cum.length <= 120);
  assert.equal(cum[cum.length - 1][1], use.tok);
  // Every kept point is a value the unthinned curve actually took at that t.
  const full = agentCumOf(use, 10_000);
  const at = new Map(full);
  for (const [t, v] of cum) assert.equal(at.get(t), v);
});

test("no dated agent record ⇒ no curve, never a line at the epoch", () => {
  const lost = JSON.parse(agentTurn(T0, "c1", 7_000));
  delete lost.timestamp;
  assert.equal(agentCumOf(agentUsage(agentDir({ "agent-c.jsonl": [JSON.stringify(lost)] }), null)), null);
  assert.equal(agentCumOf(agentUsage(agentDir({}), null)), null);
});

test("the row's agent envelope is the largest agent window in each reading's stretch", () => {
  const env = agentEnvelope([0, 100, 200], [
    { ctx: [[10, 5], [60, 9]] },
    { ctx: [[140, 3], [160, 7], [999, 4]] },
  ]);
  // Boundaries at 50 and 150: 10→0, 60→1, 140→1, 160→2, 999→2 (open-ended).
  assert.deepEqual(env, [5, 9, 7]);
  assert.equal(agentEnvelope([0, 100], [{ ctx: [] }, {}]), null, "no agent window ⇒ absent");
});

test("the spark carries the agent envelope aligned to its own readings", () => {
  const cur = updateContextLog(logFile([turn(T0, "m1", 30_000), turn(T0 + 120_000, "m2", 31_000)]), null);
  const use = agentUsage(agentDir({
    "agent-a.jsonl": [agentTurn(T0 + 10_000, "a1", 40_000), agentTurn(T0 + 100_000, "a2", 90_000)],
  }), null);
  const spark = sparkOf(cur, 200_000, "model", use);
  assert.equal(spark.agentEnv.length, spark.pts.length);
  assert.deepEqual(spark.agentEnv, [40_000, 90_000]);
  assert.equal(sparkOf(cur, 200_000, "model", null).agentEnv, undefined, "no agents looked at ⇒ absent");
});

// ── The RUNNING agent's window ────────────────────────────────────────────
//
// A subagent ran 819 requests at 484k average and peaked at 967k while nothing
// said so. The spark names the largest CURRENT window among agents still
// writing; a finished agent, however large it once was, is not news.

test("a live agent's CURRENT window rides on the spark, not its peak", () => {
  const cur = updateContextLog(logFile([turn(T0, "m1", 30_000)]), null);
  const dir = agentDir({
    "agent-big.jsonl": [agentTurn(T0 + 1_000, "b1", 900_000), agentTurn(T0 + 60_000, "b2", 720_000)],
    "agent-small.jsonl": [agentTurn(T0 + 50_000, "s1", 80_000)],
  });
  writeFileSync(join(dir, "agent-big.meta.json"), JSON.stringify({ agentType: "Explore" }));
  const use = agentUsage(dir, null);
  const spark = sparkOf(cur, 1_000_000, "model", use, T0 + 120_000);
  assert.equal(spark.liveAgentTok, 720_000, "the newest request, not the 900k peak");
  assert.equal(spark.liveAgentAt, T0 + 60_000);
  assert.equal(spark.liveAgentId, "big");
  assert.equal(spark.liveAgentType, "Explore");
});

test("a finished agent is not live, however large it was", () => {
  const cur = updateContextLog(logFile([turn(T0, "m1", 30_000)]), null);
  const use = agentUsage(agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 967_000)] }), null);
  const spark = sparkOf(cur, 1_000_000, "model", use, T0 + 60 * 60_000);
  assert.equal(spark.liveAgentTok, undefined);
  assert.equal(spark.liveAgentAt, undefined);
  assert.equal(spark.liveAgentId, undefined);
});

test("live means a last record within ten minutes — the boundary is inclusive", () => {
  const use = agentUsage(agentDir({ "agent-a.jsonl": [agentTurn(T0, "a1", 600_000)] }), null);
  assert.equal(liveAgentOf(use, T0 + 10 * 60_000)?.tok, 600_000);
  assert.equal(liveAgentOf(use, T0 + 10 * 60_000 + 1), null);
});

test("the live pick is the largest window among the live agents only", () => {
  const use = agentUsage(agentDir({
    "agent-old.jsonl": [agentTurn(T0, "o1", 950_000)],
    "agent-x.jsonl": [agentTurn(T0 + 20 * 60_000, "x1", 300_000)],
    "agent-y.jsonl": [agentTurn(T0 + 21 * 60_000, "y1", 510_000)],
  }), null);
  const live = liveAgentOf(use, T0 + 25 * 60_000);
  assert.deepEqual({ tok: live.tok, id: live.id }, { tok: 510_000, id: "y" });
});

test("no agents, or none looked at ⇒ no live reading", () => {
  const cur = updateContextLog(logFile([turn(T0, "m1", 30_000)]), null);
  const none = agentUsage(join(DIR, "never", "subagents"), null);
  assert.equal(sparkOf(cur, null, "none", none, T0).liveAgentTok, undefined);
  assert.equal(sparkOf(cur, null, "none", null, T0).liveAgentTok, undefined);
});

// ── What compacting shed, saved and cost ──────────────────────────────────
//
// The ledger is a counterfactual and a counterfactual is the easiest thing on
// this screen to get quietly wrong, so what these pin is mostly its EDGES: the
// saving is per REQUEST and not per compaction, it chains correctly across
// several, a boundary with nothing after it has saved nothing rather than $0,
// and a trigger the log did not name goes in no row at all.

test("the shed window is both sides of the drop, per trigger", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 200_000),
    compact(T0 + 1000, "manual", 200_000, 20_000),
    turn(T0 + 2000, "m2", 25_000),
    compact(T0 + 3000, "auto", 180_000, 15_000),
    turn(T0 + 4000, "m3", 30_000),
  ]));
  assert.equal(doc.compaction.manual.count, 1);
  assert.equal(doc.compaction.manual.shedTok, 180_000);
  assert.equal(doc.compaction.auto.count, 1);
  assert.equal(doc.compaction.auto.shedTok, 165_000);
  assert.equal(doc.compaction.unmeasured, 0);
});

test("the saving is counted per REQUEST, not per compaction", () => {
  // One compaction, three requests after it. Each of those three re-sent a
  // window 180k smaller than the same request in a conversation that never
  // compacted — so the saving is 3 × 180k and not 180k. Getting this wrong
  // makes a long conversation's saving look like a single turn's.
  const doc = readContextLog(logFile([
    turn(T0, "m1", 200_000),
    compact(T0 + 1000, "manual", 200_000, 20_000),
    turn(T0 + 2000, "m2", 25_000),
    turn(T0 + 3000, "m3", 30_000),
    turn(T0 + 4000, "m4", 35_000),
  ]));
  assert.equal(doc.compaction.manual.savedTok, 3 * 180_000);
  // …and the request BEFORE the boundary saved nothing: it carried the whole
  // window, which is what the boundary was about.
  assert.ok(doc.compaction.auto.savedTok === 0);
});

test("the shed chains: after two compactions a request saves both", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 200_000),
    compact(T0 + 1000, "manual", 200_000, 20_000),   // sheds 180k
    turn(T0 + 2000, "m2", 25_000),                    // saves 180k
    compact(T0 + 3000, "auto", 180_000, 15_000),      // sheds 165k
    turn(T0 + 4000, "m3", 30_000),                    // saves 180k + 165k
    turn(T0 + 5000, "m4", 35_000),                    // …and again
  ]));
  assert.equal(doc.compaction.manual.savedTok, 3 * 180_000);
  assert.equal(doc.compaction.auto.savedTok, 2 * 165_000);
  // The sum is exactly the counterfactual window difference at every request,
  // which is the property that makes the two rows addable at all.
  assert.equal(
    doc.compaction.manual.savedTok + doc.compaction.auto.savedTok,
    180_000 + (180_000 + 165_000) + (180_000 + 165_000),
  );
});

test("a compaction with no turn after it has saved NOTHING, not $0", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 200_000),
    compact(T0 + 1000, "manual", 200_000, 20_000),
  ]));
  assert.equal(doc.compaction.manual.count, 1);
  assert.equal(doc.compaction.manual.shedTok, 180_000);
  assert.equal(doc.compaction.manual.savedTok, 0);
  // Absent, never 0 — a `$0` here reads as "compacting was pointless", which
  // is the opposite of "it has not paid back yet".
  assert.equal(doc.compaction.manual.savedUsd, undefined);
  assert.equal(doc.compaction.manual.rebuildUsd, undefined);
});

test("the rebuild is the FIRST request after the boundary and no other", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 200_000),
    compact(T0 + 1000, "manual", 200_000, 20_000),
    turn(T0 + 2000, "m2", 25_000),
    turn(T0 + 3000, "m3", 30_000),
  ]));
  // `turn()` writes 100 cache-creation tokens per request; only one of them is
  // the window being written back.
  assert.equal(doc.compaction.manual.rebuildTok, 100);
});

test("a boundary the log did not describe is counted and priced into nothing", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 200_000),
    compact(T0 + 1000, "manual", 200_000, undefined),
    compact(T0 + 2000, undefined, 200_000, 20_000),
    turn(T0 + 3000, "m2", 25_000),
  ]));
  assert.equal(doc.compaction.unmeasured, 2, "both are in no row");
  assert.equal(doc.compaction.manual.count, 0);
  assert.equal(doc.compaction.auto.count, 0);
  assert.equal(doc.compaction.manual.savedTok, 0);
  assert.equal(doc.compaction.auto.savedTok, 0);
});

test("the money is priced per record, on each request's own model", () => {
  // The saving is priced as CACHE READS — opus-5 input is $5/MTok, so the read
  // rate is $0.50/MTok. One request saving 180k is 0.18 × 0.50 = $0.09.
  const doc = readContextLog(logFile([
    turn(T0, "m1", 200_000),
    compact(T0 + 1000, "manual", 200_000, 20_000),
    turn(T0 + 2000, "m2", 25_000),
  ]));
  assert.ok(Math.abs(doc.compaction.manual.savedUsd - 0.09) < 1e-9,
    `saved ${doc.compaction.manual.savedUsd}`);
});

test("an unpriced model leaves the tokens counted and the money absent", () => {
  const doc = readContextLog(logFile([
    turn(T0, "m1", 200_000, {}),
    compact(T0 + 1000, "manual", 200_000, 20_000),
    JSON.stringify({
      type: "assistant", timestamp: iso(T0 + 2000), uuid: "ux",
      message: {
        id: "mx", model: "claude-nonesuch-9", role: "assistant",
        usage: { input_tokens: 2, cache_read_input_tokens: 24_898, cache_creation_input_tokens: 100, output_tokens: 500 },
      },
    }),
  ]));
  assert.equal(doc.compaction.manual.savedTok, 180_000, "the tokens are known");
  assert.equal(doc.compaction.manual.savedUsd, undefined, "the money is not");
});

test("an incremental read reaches the same ledger as a read from scratch", () => {
  // The cursor carries the running shed across reads; a second read that
  // started its shed at zero would silently stop counting the saving.
  const lines = [
    turn(T0, "m1", 200_000),
    compact(T0 + 1000, "manual", 200_000, 20_000),
    turn(T0 + 2000, "m2", 25_000),
  ];
  const p = logFile(lines);
  let cur = updateContextLog(p, null);
  append(p, [turn(T0 + 3000, "m3", 30_000), turn(T0 + 4000, "m4", 35_000)]);
  cur = updateContextLog(p, cur);
  const incremental = projectContextLog(cur).compaction;
  const whole = readContextLog(p).compaction;
  assert.deepEqual(incremental, whole);
  assert.equal(whole.manual.savedTok, 3 * 180_000);
});

// ── The turns that came back to an expired cache ───────────────────────────
//
// Real numbers throughout, from this desktop's own logs. The shape they pin is
// the one the curve cannot show: the window is the same size either side of a
// re-write, so nothing about the graph says the turn cost twenty times the one
// before it.

/** A request with the three context fields set exactly — the only way to write
 *  a cold resume, where the read is the preamble and the write is everything
 *  this conversation was carrying. */
const req = (at, id, { read, write, w1h = null, out = 500 }) => JSON.stringify({
  type: "assistant",
  timestamp: iso(at),
  uuid: `u${id}`,
  message: {
    id,
    model: "claude-opus-5",
    role: "assistant",
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      ...(w1h == null ? {} : { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1h } }),
      output_tokens: out,
    },
  },
});

test("a resume that re-wrote its window is counted, priced and dated", () => {
  // Measured, 2026-09-20: 207,363 carried, fourteen hours quiet, then 36,770
  // read (the tools-and-system preamble, a separate cache entry) and 172,448
  // written at the 1-hour tier.
  const p = logFile([
    req(T0, "a", { read: 200_000, write: 7_361 }),
    req(T0 + 14 * 3_600_000, "b", { read: 36_770, write: 172_448, w1h: 172_448 }),
  ]);
  const log = readContextLog(p);
  assert.equal(log.coldStarts.count, 1);
  assert.equal(log.coldStarts.tok, 172_448);
  // Opus 5 at $5/Mtok input: 2x to write, 0.1x to read back.
  assert.ok(Math.abs(log.coldStarts.usd - 1.72448) < 0.001);
  assert.ok(Math.abs(log.coldStarts.premiumUsd - 1.638) < 0.01);
  const ev = log.events.filter((e) => e.kind === "rebuild");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].wroteTok, 172_448);
  assert.equal(ev[0].prevTok, 207_363);
  assert.equal(ev[0].gapMs, 14 * 3_600_000);
});

test("the preamble read never makes a cold resume look warm", () => {
  // The case that breaks `cacheWrite > cacheRead`: a 66k conversation comes
  // back cold, reads 36,770 and writes 30,638. Write BELOW read, stone cold.
  const p = logFile([
    req(T0, "a", { read: 60_000, write: 5_931 }),
    req(T0 + 5 * 3_600_000, "b", { read: 36_770, write: 30_638 }),
  ]);
  assert.equal(readContextLog(p).coldStarts.count, 1);
});

test("a compaction is not an expired cache", () => {
  // Measured: 380,483 -> 12,543 by hand, then 32,510 read and 31,579 written.
  // Those tokens were discarded on purpose and the compaction ledger already
  // prices the rebuild; counting them here would bill compacting twice.
  const p = logFile([
    req(T0, "a", { read: 370_000, write: 9_692 }),
    compact(T0 + 60_000, "manual", 380_483, 12_543),
    req(T0 + 120_000, "b", { read: 32_510, write: 31_579 }),
  ]);
  const log = readContextLog(p);
  assert.equal(log.coldStarts.count, 0);
  assert.equal(log.coldStarts.tok, 0);
  assert.equal(log.events.filter((e) => e.kind === "rebuild").length, 0);
  // …and the rebuild IS charged to the compaction, exactly once.
  assert.equal(log.compaction.manual.rebuildTok, 31_579);
});

test("the first request of a conversation is a baseline, not a re-write", () => {
  const p = logFile([req(T0, "a", { read: 0, write: 120_000 })]);
  const log = readContextLog(p);
  assert.equal(log.coldStarts.count, 0);
  assert.equal(log.coldStarts.usd, undefined);       // absent, never $0
  assert.equal(log.coldStarts.premiumUsd, undefined);
});

test("an ordinary warm turn is never counted, however much it writes", () => {
  // A turn that reads its window back and writes a big new tool result on top.
  const p = logFile([
    req(T0, "a", { read: 100_000, write: 2_000 }),
    req(T0 + 30_000, "b", { read: 102_000, write: 40_000 }),
  ]);
  assert.equal(readContextLog(p).coldStarts.count, 0);
});

test("a re-write is not a mark on the spark — the window did not move", () => {
  const p = logFile([
    req(T0, "a", { read: 200_000, write: 7_361 }),
    req(T0 + 14 * 3_600_000, "b", { read: 36_770, write: 172_448 }),
  ]);
  const cur = updateContextLog(p);
  const spark = sparkOf(cur, 1_000_000, "measured");
  assert.equal(spark.marks.length, 0);
  assert.equal(spark.coldStarts.count, 1);
});

// ── Skills ────────────────────────────────────────────────────────────────
// The `Skill` tool writes the skill's text into the log as a meta user record
// tied to its tool call (`sourceToolUseID`) — the one dated moment a skill
// entered the window. Shape copied from a real 2.1.30x log.

const skillBody = (at, dir, body = "# body\n", extra = {}) => JSON.stringify({
  type: "user",
  isMeta: true,
  timestamp: iso(at),
  uuid: `k${at}`,
  sourceToolUseID: `toolu_${at}`,
  ...extra,
  message: { role: "user", content: [{ type: "text", text: `Base directory for this skill: ${dir}\n\n${body}` }] },
});

test("a skill body is a dated load, named by its directory, and never a turn", () => {
  const body = "# heuristics\n" + "x".repeat(500);
  const doc = readContextLog(logFile([
    prompt(T0, "fix the detector"),
    skillBody(T0 + 1_000, "/repo/.claude/skills/heuristics", body),
    turn(T0 + 2_000, "m1", 30_000),
    skillBody(T0 + 3_000, "/cache/plugins/wp/skills/waterplane/"),
  ]));
  assert.deepEqual(doc.skills.map((s) => [s.t, s.name]), [[T0 + 1_000, "heuristics"], [T0 + 3_000, "waterplane"]]);
  assert.equal(doc.skills[0].chars, "Base directory for this skill: /repo/.claude/skills/heuristics\n\n".length + body.length);
  assert.equal(doc.turns, 1);
});

test("a prompt quoting the skill phrase is not a load, nor is an undated or tool-less body", () => {
  const doc = readContextLog(logFile([
    prompt(T0, "Base directory for this skill: /x/skills/fake"),
    skillBody(T0 + 1_000, "/x/skills/notool", "b", { sourceToolUseID: undefined }),
    JSON.stringify({ ...JSON.parse(skillBody(0, "/x/skills/undated")), timestamp: undefined }),
  ]));
  assert.deepEqual(doc.skills, []);
});

test("a subagent's skill loads ride on its own roster row, never the parent's list", () => {
  const dir = agentDir({
    "agent-aaa.jsonl": [
      skillBody(T0, "/r/.claude/skills/host", "b", { isSidechain: true }),
      agentTurn(T0 + 1_000, "a1", 20_000),
      skillBody(T0 + 2_000, "/r/.claude/skills/host-core", "b", { isSidechain: true }),
    ],
    "agent-bbb.jsonl": [agentTurn(T0 + 500, "b1", 10_000)],
  });
  const use = agentUsage(dir, null);
  const byId = Object.fromEntries(use.runs.map((r) => [r.id, r]));
  assert.deepEqual(byId.aaa.skills.map((s) => s.name), ["host", "host-core"]);
  assert.equal(byId.bbb.skills, undefined);
  // The body is not spend: the tally is the one request alone.
  assert.equal(use.tok, 20_000 + 300 + 10_000 + 300);
});
