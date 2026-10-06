/**
 * How big a model's context window is — the number every context graph calls
 * 100%.
 *
 * The reason this is worth a test file of its own is that it is the single
 * point where the whole feature can be silently wrong. A window 5× too small
 * draws a session at 40% as one at 200%; a window 5× too large draws a session
 * about to compact as one with plenty of room. Neither throws, neither shows up
 * in a type-check, and both look exactly like a working chart.
 *
 * So the two properties pinned here are: the RULE holds for ids nobody has
 * written down yet (that is why it is a rule), and an id it does not recognise
 * answers null rather than a plausible default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WINDOW_TOK,
  LONG_WINDOW_TOK,
  contextPct,
  contextWindowFor,
  isClaudeModel,
  resolveContextWindow,
  windowContaining,
} from "../dist/ctxwindow.js";

test("an ordinary Claude id gets the default window", () => {
  for (const id of [
    "claude-opus-5", "claude-sonnet-5", "claude-fable-5",
    "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-5",
    "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5",
  ]) {
    assert.equal(contextWindowFor(id), DEFAULT_WINDOW_TOK, id);
  }
});

test("the long-context marker is what makes a window long", () => {
  assert.equal(contextWindowFor("claude-opus-5[1m]"), LONG_WINDOW_TOK);
  assert.equal(contextWindowFor("claude-opus-4-8[1m]"), LONG_WINDOW_TOK);
  assert.equal(contextWindowFor("claude-opus-4-5[1m]"), LONG_WINDOW_TOK);
  // The other spelling the CLI has used.
  assert.equal(contextWindowFor("claude-sonnet-4-5-1m"), LONG_WINDOW_TOK);
  // And the same id without it is emphatically not long.
  assert.equal(contextWindowFor("claude-opus-5"), DEFAULT_WINDOW_TOK);
});

test("the rule answers a model nobody has written down yet", () => {
  // The point of a rule over a list: a model released next month must not fall
  // off the end and silently switch its graph to a different axis.
  assert.equal(contextWindowFor("claude-opus-9-3"), DEFAULT_WINDOW_TOK);
  assert.equal(contextWindowFor("claude-opus-9-3[1m]"), LONG_WINDOW_TOK);
});

// ── the measurement, which outranks the id ────────────────────────────────
//
// The id rule was the whole design once, and it was wrong: measured across one
// machine's logs, `claude-opus-5` reached 998,242 tokens and `claude-opus-4-8`
// reached 994,851 — both plainly 1M windows, both written to the log with no
// `[1m]`. These pin the correction.

test("an observation snaps UP to a real window, never to itself", () => {
  assert.equal(windowContaining(1), 200_000);
  assert.equal(windowContaining(200_000), 200_000);
  // A conversation that held 346k was not in a 346k window — and an axis
  // topping out at whatever this series reached is the per-series axis the
  // shared scale exists to replace.
  assert.equal(windowContaining(346_785), 1_000_000);
  assert.equal(windowContaining(998_242), 1_000_000);
  // Past the top rung the ladder is out of date; the biggest window we know of
  // beats no answer at all.
  assert.equal(windowContaining(4_000_000), LONG_WINDOW_TOK);
});

test("a measurement beats the id, which is the bug that made this file", () => {
  // The real case: the log says `claude-opus-5`, the id rule says 200k, and the
  // conversation demonstrably held 998k.
  const ev = { model: "claude-opus-5", observedTok: 998_242 };
  assert.deepEqual(resolveContextWindow(ev), { tok: 1_000_000, from: "measured" });
  // Without the observation, the id is all there is — and it says so.
  assert.deepEqual(resolveContextWindow({ model: "claude-opus-5" }), { tok: 200_000, from: "model" });
});

test("a printed gauge beats everything — it is about THIS session", () => {
  assert.deepEqual(
    resolveContextWindow({ model: "claude-opus-5", observedTok: 998_242, screenTok: 200_000 }),
    { tok: 200_000, from: "screen" },
  );
});

test("an observation on an unrecognised model decides nothing", () => {
  // Otherwise a `<synthetic>` turn, or another vendor's id, would mint an axis.
  assert.deepEqual(resolveContextWindow({ model: "<synthetic>", observedTok: 900_000 }), { tok: null, from: "none" });
  assert.deepEqual(resolveContextWindow({}), { tok: null, from: "none" });
});

test("isClaudeModel is the one gate, and excludes the synthetic turn", () => {
  assert.ok(isClaudeModel("claude-opus-5"));
  assert.ok(isClaudeModel("opus"));
  assert.ok(isClaudeModel("claude-opus-5[1m]"));
  assert.ok(!isClaudeModel("<synthetic>"));
  assert.ok(!isClaudeModel("gpt-4o"));
  assert.ok(!isClaudeModel(""));
  assert.ok(!isClaudeModel(null));
});

test("a launch ALIAS is what SessionInfo.model holds before the first turn", () => {
  for (const a of ["opus", "sonnet", "haiku", "fable"]) {
    assert.equal(contextWindowFor(a), DEFAULT_WINDOW_TOK, a);
  }
  assert.equal(contextWindowFor("OPUS"), DEFAULT_WINDOW_TOK); // case-insensitive
});

test("anything unrecognised is null, never a plausible default", () => {
  // `<synthetic>` is the model the CLI stamps on its own usage-wall turns, and
  // it is the one that would most easily slip through.
  for (const id of ["<synthetic>", "gpt-4o", "llama-3", "", "   ", null, undefined]) {
    assert.equal(contextWindowFor(id), null, String(id));
  }
});

test("contextPct is null without a window, and is NOT clamped", () => {
  assert.equal(contextPct(100_000, null), null);
  assert.equal(contextPct(100_000, 0), null);
  assert.equal(contextPct(100_000, 200_000), 50);
  // A reading over the window is a fact worth drawing, not one to hide.
  assert.equal(contextPct(300_000, 200_000), 150);
});
