/**
 * The local runner's shared half: the memory-pressure SENTENCE, and the shape
 * of a sample both ends have to word the same way.
 *
 * `packages/host/test/localrt.test.mjs` pins the same function through the
 * host's re-export, and that is not duplication — it is the two import paths
 * being pinned, which is the thing that would break if the move to
 * `@waterplane/shared` were half-done. What this file adds is the half the host never
 * calls: the rules the PHONE relies on when it draws the note under a model
 * picker, at the moment somebody is choosing.
 *
 * Every case below is a way this could produce a plausible, wrong, ACTIONED
 * claim:
 *
 *  - a refusal instead of a sentence (CLAUDE.md: nothing applies itself). The
 *    numbers here — a `memFree` on a machine with a page cache and a
 *    compressor, against a size the runner only knows for a model it has
 *    already loaded — are good enough to warn on and nowhere near good enough
 *    to block somebody's work on;
 *  - a warning about the model that is ALREADY loaded, which is what a naive
 *    match on a provider-prefixed id (`ollama/qwen3-coder:30b` against the
 *    runner's `qwen3-coder:30b`) produces, and which trains people to ignore
 *    the warning that matters. The stripping rule is the phone's
 *    (`web/localRt.ts`); what is pinned HERE is that this function matches on
 *    an EXACT name and therefore depends on it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { memoryPressureNote } from "../dist/localrt.js";

const GB = 2 ** 30;
const model = (name, gb) => ({ name, size: gb * GB, vram: gb * GB });

test("it is a SENTENCE, or nothing — it never answers a verdict", () => {
  // The whole contract: a string to read, or `null`. No boolean, no "blocked",
  // no object anybody could switch on. A caller cannot refuse work with this
  // even if it wanted to.
  const note = memoryPressureNote([model("qwen3-coder:30b", 18)], "gemma4:e4b", 6 * GB);
  assert.equal(typeof note, "string");
  assert.equal(memoryPressureNote([], "gemma4:e4b", 6 * GB), null);
});

test("nothing resident is silence, not an all-clear", () => {
  // A runner holding nothing has no conflict to report, and a readout that
  // speaks when there is nothing to say is one people stop reading.
  assert.equal(memoryPressureNote([], "anything", 0), null);
});

test("the model already loaded is never a conflict with itself", () => {
  // Matching is EXACT, on the runner's own name. This is the case the phone's
  // provider-prefix stripping exists to reach: `ollama/qwen3-coder:30b` handed
  // in unstripped would miss here and produce a "second model" warning about
  // the one already resident.
  const loaded = [model("qwen3-coder:30b", 18)];
  assert.equal(memoryPressureNote(loaded, "qwen3-coder:30b", 1 * GB), null);
  assert.ok(memoryPressureNote(loaded, "ollama/qwen3-coder:30b", 1 * GB),
    "an unstripped id does NOT match — which is exactly why the caller must strip it");
});

test("it names what is held, what is free, and what switching costs", () => {
  // The three things somebody decides with. Not a recommendation, not a
  // threshold, not a refusal — the two numbers and the consequence.
  const note = memoryPressureNote([model("qwen3-coder:30b", 18)], "gemma4:e4b", 6.5 * GB);
  assert.match(note, /qwen3-coder:30b/);
  assert.match(note, /18\.0 GB held/);
  assert.match(note, /6\.5 GB free/);
  assert.match(note, /reloads from disk/);
});

test("every resident model is named, and the held total is their SUM", () => {
  const note = memoryPressureNote([model("qwen3-coder:30b", 18), model("gemma4:e4b", 9)], "third:8b", 2 * GB);
  assert.match(note, /qwen3-coder:30b, gemma4:e4b are already loaded/);
  assert.match(note, /27\.0 GB held/);
});

test("one model says “is”, several say “are” — the sentence has to read", () => {
  assert.match(memoryPressureNote([model("a", 1)], "b", 1), / is already loaded/);
  assert.match(memoryPressureNote([model("a", 1), model("b", 1)], "c", 1), / are already loaded/);
});

test("the size of the model being ASKED for is never invented", () => {
  // The runner can only price a model it has loaded before, so the want side is
  // unknown for most of the interesting cases. The note says what IS known
  // rather than half-inventing the other side — no "needs N GB", no total, no
  // arithmetic on a number nobody measured.
  const note = memoryPressureNote([model("qwen3-coder:30b", 18)], "never-seen:70b", 4 * GB);
  assert.ok(!/never-seen:70b/.test(note), "it does not quote a size it was never told");
  assert.match(note, /may evict it/);
});

test("zero free memory is still a sentence, never a block", () => {
  // The most alarming input there is. It still reports, and it still reports in
  // GB rather than degrading to a bare number or a NaN.
  const note = memoryPressureNote([model("qwen3-coder:30b", 18)], "gemma4:e4b", 0);
  assert.match(note, /0\.0 GB free/);
});
