/**
 * What a headless run is allowed to SAY IT COST — and what the smart pick's
 * call is allowed to look like.
 *
 * Phase 0 of the smart pick ships the seams and runs no pass. Two of those
 * seams can already be wrong in a way nothing downstream could ever detect, so
 * they are pinned here before anything is built on them:
 *
 *  1. **`envelopeUsage`.** Nobody in this daemon has ever read the `claude -p`
 *     envelope's `usage` or `total_cost_usd` — every caller parsed `result` and
 *     threw the rest away. These numbers become the only honest cost line an
 *     unattended pass has, shown to a person as tokens and dollars. A `0` where
 *     the envelope said nothing is a wrong number wearing a true number's
 *     clothes, and once it is on screen there is no way to tell it from a
 *     measured zero. So: absent, always, on anything unreadable. Pure, so every
 *     way an envelope can be malformed is a literal rather than a spawn.
 *  2. **The argv.** CLAUDE.md's standing rule is that a new unattended
 *     `claude -p` starts from `summarize()`'s flags and justifies every one it
 *     DROPS. `--setting-sources user` keeps the repo's CLAUDE.md out (12k chars
 *     to answer a question about six sentences of backlog text) and `--tools ""`
 *     is the mechanical guarantee behind the harder rule — a pass with no tools
 *     cannot type into a session, which this feature may never do. A flag lost
 *     in a later edit costs tokens silently and forever, which is exactly the
 *     kind of drift a test is for.
 *
 * The envelope's field names are not guesses. They were measured against the
 * installed binary on 2026-09-17 — see `sidecar.ts`'s `envelopeUsage` header,
 * which also records the two other findings that run produced (a `-p` run DOES
 * write a transcript under `~/.claude/projects/<cwd-slug>/`, and thinking is on
 * by default and will dominate this feature's bill).
 *
 * Real banner phrasing appears in one fixture here, under the same carve-out
 * `headlesslimit.test.mjs` and `sidecar.test.mjs` take: nothing in this file is
 * ever rendered into a terminal — it goes to a temp stub's stdout and is read
 * back by `execFile`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelopeUsage, runSmartPickTask } from "../dist/sidecar.js";

// ── 1. the envelope's cost line ────────────────────────────────────────────

/** The real shape, measured: flat `usage`, `total_cost_usd`, `modelUsage`. */
const envelope = (over = {}) => JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"pick":"a"}',
  session_id: "b0f3c1de-0000-4000-8000-000000000001",
  num_turns: 1,
  duration_ms: 2104,
  total_cost_usd: 0.0049,
  usage: {
    input_tokens: 4,
    output_tokens: 12,
    cache_read_input_tokens: 2170,
    cache_creation_input_tokens: 331,
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 4, outputTokens: 12,
      cacheReadInputTokens: 2170, cacheCreationInputTokens: 331,
      costUSD: 0.0049, contextWindow: 200000,
    },
  },
  ...over,
});

test("the four token kinds and the dollar figure come straight off the envelope", () => {
  const { usage, usd } = envelopeUsage(envelope());
  assert.deepEqual(usage, { inTok: 4, outTok: 12, cacheRead: 2170, cacheWrite: 331 });
  assert.equal(usd, 0.0049);
});

test("the four kinds stay APART — nothing here sums them", () => {
  // `tokens.ts`'s rule, and the measurement behind it: 96% of every token this
  // desktop spends is a cache read, so a single "2517 tokens" would be a number
  // about nothing. The reader hands back the split it was given and no total.
  const { usage } = envelopeUsage(envelope());
  assert.deepEqual(Object.keys(usage).sort(), ["cacheRead", "cacheWrite", "inTok", "outTok"]);
});

test("a zero that was MEASURED is kept — absent and nothing-spent are different facts", () => {
  const { usage, usd } = envelopeUsage(envelope({
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0,
  }));
  assert.deepEqual(usage, { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(usd, 0, "a reported zero cost is a reading, not a missing one");
});

test("anything unreadable is ABSENT, never a zero", () => {
  // Every one of these has been a real `-p` stdout at some point: a crash before
  // the envelope, a stub, a truncated write, a raw sentence.
  for (const stdout of ["", "   ", "not json at all", "[]", "null", "42", '"a string"', '{"result":"x"', "{}"]) {
    const out = envelopeUsage(stdout);
    assert.equal(out.usage, undefined, `${JSON.stringify(stdout)} yields no usage`);
    assert.equal(out.usd, undefined, `${JSON.stringify(stdout)} yields no cost`);
  }
});

test("a PARTIAL usage object is no usage at all", () => {
  // The direction that matters. Three of four kinds filled in and the fourth
  // defaulted to 0 renders as a complete four-kind breakdown, and a person
  // reading "0 cache writes" cannot tell it from a call that really wrote none.
  // A shape this does not recognise is a shape it declines to summarise.
  const partials = [
    { input_tokens: 4, output_tokens: 12, cache_read_input_tokens: 2170 },
    { input_tokens: 4, output_tokens: 12 },
    { output_tokens: 12, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
    { input_tokens: "4", output_tokens: 12, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
    { input_tokens: -1, output_tokens: 12, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
    { input_tokens: NaN, output_tokens: 12, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
  ];
  for (const usage of partials) {
    assert.equal(envelopeUsage(envelope({ usage })).usage, undefined, `${JSON.stringify(usage)} is not a breakdown`);
  }
  // …and the dollar figure is read on its OWN: a run may legitimately report a
  // price with no breakdown, and dropping it because its neighbour was broken
  // would be throwing away a fact nobody disputed.
  assert.equal(envelopeUsage(envelope({ usage: { input_tokens: 4 } })).usd, 0.0049);
});

test("a cost figure that is not a number is absent, and takes nothing else with it", () => {
  for (const total_cost_usd of ["0.0049", null, undefined, {}, -1, NaN, Infinity]) {
    const out = envelopeUsage(envelope({ total_cost_usd }));
    assert.equal(out.usd, undefined, `${JSON.stringify(total_cost_usd)} is not a price`);
    assert.deepEqual(out.usage, { inTok: 4, outTok: 12, cacheRead: 2170, cacheWrite: 331 }, "the tokens still stand");
  }
});

test("`modelUsage` is not read — the flat object is the one source", () => {
  // It is keyed by a model id this daemon does not otherwise know and carries
  // nothing the flat `usage` has not got. Reading both would be two opinions
  // about one call's cost; an envelope with only the camel-cased half is a
  // shape we have never measured, so it answers absent rather than guessing.
  const out = envelopeUsage(JSON.stringify({
    type: "result",
    total_cost_usd: 0.0049,
    modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 4, outputTokens: 12, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 } },
  }));
  assert.equal(out.usage, undefined);
  assert.equal(out.usd, 0.0049);
});

// ── 2. the call itself ─────────────────────────────────────────────────────

const BIN_DIR = mkdtempSync(join(tmpdir(), "waterplane-smartpick-"));

/**
 * A stub `claude` that records its argv and its stdin, then prints `out`.
 *
 * Each argument is written wrapped in pipes on its own line, which matters more
 * than it looks: `--tools ""` is a flag whose VALUE is the empty string, and a
 * recorder that wrote one argument per bare line could not tell that empty
 * argument from a blank line or from the flag having no value at all — which is
 * precisely the drift this test exists to catch.
 */
function stubClaude(name, out, code = 0) {
  const p = join(BIN_DIR, name);
  writeFileSync(
    p,
    `#!/bin/sh\nfor a in "$@"; do printf '|%s|\\n' "$a" >>"${p}.argv"; done\ncat >"${p}.stdin"\ncat <<'WATERPLANE_EOF'\n${out}\nWATERPLANE_EOF\nexit ${code}\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

/** The stub's recording, back as the argv it was handed. */
const argvOf = (bin) =>
  readFileSync(`${bin}.argv`, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.slice(1, -1));

const withBin = async (bin, fn) => {
  const prev = process.env.WATERPLANE_CLAUDE_BIN;
  process.env.WATERPLANE_CLAUDE_BIN = bin;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.WATERPLANE_CLAUDE_BIN; else process.env.WATERPLANE_CLAUDE_BIN = prev;
  }
};

const req = (over = {}) => ({
  cwd: BIN_DIR, prompt: "{\"tasks\":[]}", system: "groom the list", model: "haiku", timeoutMs: 5000, ...over,
});

test("the argv keeps every one of the summary's flags, and the prompt goes on stdin", async () => {
  const bin = stubClaude("claude-argv", envelope());
  const run = await withBin(bin, () => runSmartPickTask(req()));
  const argv = argvOf(bin);

  assert.deepEqual(argv, [
    "-p", "--output-format", "json",
    "--model", "haiku",
    // Skips the PROJECT's settings, so no repo CLAUDE.md is read.
    "--setting-sources", "user",
    // The items are in the prompt. Also: no tools is no way to type anywhere.
    "--tools", "",
    // The one ADDITION, and the measured reason for it: the same three-item
    // pass cost $0.0067–$0.025 and took 13–36 s with thinking on, against
    // $0.0014 and 2.8 s with it off, for the identical conclusion. The clock is
    // the half that matters most — a person's next backlog item is held behind
    // this call, and two runs in three blew through the 20 s watchdog, so the
    // repo would have paid for a completion it then threw away every time.
    // Asking for it in the system prompt does not work; it is asked for there
    // and 2,644 thinking tokens were spent anyway.
    "--thinking", "disabled",
    "--system-prompt", "groom the list",
  ]);
  // "" is a real argument and must survive as one — a `--tools` with its value
  // dropped is `--tools --system-prompt`, i.e. every tool enabled.
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.equal(readFileSync(`${bin}.stdin`, "utf8"), "{\"tasks\":[]}");
  assert.equal(run.text, '{"pick":"a"}', "the envelope's result is unwrapped");
  assert.equal(run.failed, false);
  assert.equal(run.limited, false);
  assert.deepEqual(run.usage, { inTok: 4, outTok: 12, cacheRead: 2170, cacheWrite: 331 });
  assert.equal(run.usd, 0.0049);
  assert.equal(typeof run.durationMs, "number");
});

test("an account block is `limited`, not `failed` — a different sentence and a different fix", () => {
  // `limited` is not `error` anywhere in this daemon: one clears itself at a
  // reset, the other does not. The banner's words are never the answer either —
  // they would reach a JSON sanitiser as prose and be counted as a real pass.
  const bin = stubClaude("claude-limited", JSON.stringify({
    type: "result", subtype: "success", is_error: true,
    result: "You've hit your session limit · resets 5:10pm (Europe/Berlin)",
    session_id: "x",
  }), 1);
  return withBin(bin, async () => {
    const run = await runSmartPickTask(req());
    assert.equal(run.limited, true);
    assert.equal(run.failed, false);
    assert.equal(run.text, "", "the banner is never handed on as an answer");
    assert.match(run.detail, /quota/);
  });
});

test("a binary that is not there is a failure with words, and no numbers at all", async () => {
  const run = await withBin(join(BIN_DIR, "does-not-exist"), () => runSmartPickTask(req()));
  assert.equal(run.failed, true);
  assert.equal(run.text, "");
  assert.equal(run.usage, undefined, "nothing was measured, so nothing is reported");
  assert.equal(run.usd, undefined);
  assert.ok(run.detail, "a failure the caller can put on the strip");
});

test("a fenced or raw answer still comes back whole — nothing here clips a JSON body", async () => {
  // `runSummaryTask`'s `tidy()` squashes whitespace and cuts at 240 chars, which
  // is right for a sentence on a session row and would quietly truncate a JSON
  // object into something `JSON.parse` refuses. The smart pick deliberately
  // does not reuse it; the sanitiser downstream is what reads this.
  const long = `{"pick":"a","why":"${"x".repeat(400)}"}`;
  const bin = stubClaude("claude-long", JSON.stringify({ type: "result", result: long, session_id: "x" }));
  const run = await withBin(bin, () => runSmartPickTask(req()));
  assert.equal(run.text, long);
  assert.equal(run.text.length > 240, true, "not clipped to a summary's width");
});

// ── 3. the prompts, which are the whole contract and the whole bill ────────

const { SMARTPICK_SYSTEM, smartpickPrompt } = await import("../dist/smartpick.js");
const { SMARTPICK_MAX_ITEMS, SMARTPICK_MAX_CHARS } = await import("@waterplane/shared");

test("the system prompt still states the output shape it is sanitised against", () => {
  // A drift here is invisible from every direction: `cleanSmartPick` would go on
  // refusing every answer, every pass would record `failed`, and the strip would
  // read exactly like a flaky model. The shape is the contract, so it is pinned
  // where it is written.
  for (const frag of ['"pick"', '"order"', '"merges"', '"ids"', '"text"', '"why"']) {
    assert.ok(SMARTPICK_SYSTEM.includes(frag), `the answer shape still names ${frag}`);
  }
  assert.match(SMARTPICK_SYSTEM, /ONE JSON object and nothing else/);
  assert.match(SMARTPICK_SYSTEM, /every id exactly once/i);
});

test("the four `never`s are all still there", () => {
  // Each one is a way a machine that may groom a list could start rewriting it,
  // and each is enforced twice — here in words to the model, and in
  // `cleanSmartPick` against the answer. The words are the cheap half and the
  // only half that stops the behaviour happening in the first place.
  assert.match(SMARTPICK_SYSTEM, /Never invent a task/);
  assert.match(SMARTPICK_SYSTEM, /Never drop a task/);
  assert.match(SMARTPICK_SYSTEM, /Never change the words of a task you do not merge/);
  assert.match(SMARTPICK_SYSTEM, /Never answer with anything but the JSON object/);
});

test("the system prompt asks for the answer straight away — thinking is the bill", () => {
  // Phase 0's measurement: a trivial one-word haiku reply spent 548 THINKING
  // tokens and cost $0.0049. Input size is not what this feature is billed for,
  // so the only lever on the number is telling the model what kind of job this
  // is. Losing this paragraph would multiply the cost of every pick silently.
  assert.match(SMARTPICK_SYSTEM, /answer straight away/i);
  assert.match(SMARTPICK_SYSTEM, /Do not reason step by step/i);
});

/** Candidates the prompt builder will accept, `n` of them. */
const cands = (n, len = 20) =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, text: `t${i}`.padEnd(len, "x"), order: i, steps: 1 }));

const FACTS = { branch: "main", dirty: ["M src/a.ts", "?? notes.md"], commits: ["one", "two"] };
const build = (list, over = {}) => smartpickPrompt({
  repo: "myapp", facts: FACTS, cands: list, createdAt: () => 0, now: 0, ...over,
});

test("the repo's cheap facts go in whole, and nothing else about the repo does", () => {
  const out = build(cands(2));
  const doc = JSON.parse(out.text);
  assert.deepEqual(doc.repo, { name: "myapp", branch: "main", dirty: FACTS.dirty, commits: FACTS.commits });
  // The brief's second decision: item texts plus cheap facts already on hand.
  // Not a repo scan — so there is no fourth key here to grow one in.
  assert.deepEqual(Object.keys(doc).sort(), ["repo", "tasks"]);
  assert.equal(doc.tasks.length, 2);
  assert.equal(out.omitted, 0);
});

test("an item within the budget goes in WHOLE, and is not marked clipped", () => {
  const out = build(cands(3, 100));
  for (const t of JSON.parse(out.text).tasks) assert.equal("clipped" in t, false);
  for (const c of out.sent) assert.equal(c.clipped, undefined);
});

test("past the character budget an item is clipped — and the CLIP TRAVELS", () => {
  // The flag on the candidate is what `cleanSmartPick` refuses a merge on. A
  // clip made here and not carried through is a merge folding words the model
  // never read, which is the one failure the clipped rule exists to prevent.
  const big = [
    { id: "whole", text: "w".repeat(SMARTPICK_MAX_CHARS), order: 0, steps: 1 },
    { id: "cut", text: "c".repeat(5000), order: 1, steps: 1 },
  ];
  const out = build(big);
  const tasks = JSON.parse(out.text).tasks;
  assert.equal(tasks[0].text.length, SMARTPICK_MAX_CHARS, "the first went in whole");
  assert.equal("clipped" in tasks[0], false);
  assert.equal(tasks[1].clipped, true);
  assert.ok(tasks[1].text.length < 5000, "and it really is shorter");
  assert.equal(out.sent[0].clipped, undefined);
  assert.equal(out.sent[1].clipped, true, "the sanitiser is told, so it can refuse a merge over it");
});

test("past the item cap the rest keep their places, and the pass SAYS how many it never saw", () => {
  const out = build(cands(SMARTPICK_MAX_ITEMS + 7));
  assert.equal(JSON.parse(out.text).tasks.length, SMARTPICK_MAX_ITEMS);
  assert.equal(out.sent.length, SMARTPICK_MAX_ITEMS);
  // A pass that silently ignores half a backlog while reporting a clean sweep is
  // worse than one that admits it ran out of room.
  assert.equal(out.omitted, 7);
});

test("a label and `resume` travel; nothing that is not a fact about the item does", () => {
  const out = build([
    { id: "a", text: "do a", label: "flaky test", order: 0, steps: 1, resume: true },
    { id: "b", text: "do b", order: 1, steps: 1 },
  ]);
  const [a, b] = JSON.parse(out.text).tasks;
  assert.equal(a.label, "flaky test");
  assert.equal(a.resume, true);
  assert.equal("label" in b, false, "an absent label is absent, not an empty string");
  assert.equal("resume" in b, false);
  assert.equal(typeof a.age, "string", "how long it has waited is the one fact that is not in its words");
});

// ── 4. the clock, as the model is told about it ─────────────────────────────

test("the system prompt tells the model what an `at` means to each of the three verbs", () => {
  // A one-off with a clock is an ordinary backlog row, so the pass sees it — and
  // the sanitiser then corrects a pick that names one and refuses a merge across
  // two different ones, whatever the model answers. This paragraph is the cheap
  // half: without it the model's `why` is confident prose about having ordered
  // something it was never allowed to order, which is the sentence a person
  // reads on the strip.
  assert.match(SMARTPICK_SYSTEM, /A task with an `at` runs at that time on its own/);
  assert.match(SMARTPICK_SYSTEM, /never pick it as next/);
  assert.match(SMARTPICK_SYSTEM, /merge it only with a task whose `at` is identical/);
  // …and the one verb it DOES have over a clock: several items queued for one
  // instant are a queue, and which of them goes first is a question their
  // person has not answered by timing them. The refusal that still stands is
  // the crossing, and the brief says both halves in one breath — a model told
  // only "never move it" answered with the order it was handed and called it a
  // decision.
  assert.match(SMARTPICK_SYSTEM, /MAY order tasks that share the same `at` among themselves/);
  assert.match(SMARTPICK_SYSTEM, /never move such a task past a task with a different `at` or with none/);
});

test("the clock's SENTENCE travels into the task object, and nothing else about the trigger does", () => {
  const out = build([
    { id: "a", text: "do a", order: 0, steps: 1, at: "once · Thu, 18 Sep, 21:00", atKey: '[{"kind":"once","at":2000},120,1]' },
    { id: "b", text: "do b", order: 1, steps: 1 },
  ]);
  const [a, b] = JSON.parse(out.text).tasks;
  assert.equal(a.at, "once · Thu, 18 Sep, 21:00", "in the words the person set it in");
  // The KEY stays on this side of the wire: equality between two clocks is
  // decided here against the store, never by a model comparing two strings —
  // and the grace, the hold and the armed instant are facts it has no verb for,
  // so sending them is prompt somebody is billed for and nothing more.
  for (const k of ["atKey", "graceMin", "holdForHost", "nextAt", "rule", "trigger"]) {
    assert.equal(k in a, false, `${k} must not be in the prompt`);
  }
  assert.equal("at" in b, false, "a row with no clock says nothing about one");
  assert.equal(out.sent[0].atKey, '[{"kind":"once","at":2000},120,1]', "…but the sanitiser still gets it");
});
