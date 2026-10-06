/**
 * **The kickoff prompt teaches the limits the PARSER enforces, and no others.**
 *
 * `assess.ts` has had this rule since the merge sizes went in: a prompt that
 * teaches a limit the parser does not enforce is worse than no prompt at all,
 * because the model complies with the wrong number and the app then throws the
 * answer away — a whole repo read spent to produce a note.
 *
 * The naming paragraph added two more caps to keep in step, and both are the
 * kind that go stale silently. `MAX_HEADLINE_CHARS` is a number, so a hand-typed
 * "at most 80 characters" reads correctly right up to the day somebody changes
 * the constant. `ITEM_CATEGORIES` is a list, so a hand-typed one goes wrong the
 * day a fifth kind appears — and the failure is a model confidently answering in
 * a vocabulary `cleanCategory` has never heard of, which is silently `undefined`
 * on every row.
 *
 * So this asserts the INTERPOLATION rather than the text: the prompt has to
 * contain what the shared constants currently say, whatever they currently say.
 *
 *     node --test packages/host/test/assessprompt.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPrompt } from "../dist/assess.js";
import { ITEM_CATEGORIES, MAX_HEADLINE_CHARS, MAX_MERGE_SIZE, MIN_MERGE_SIZE, MAX_NEW } from "@waterplane/shared";

const input = {
  version: 1, at: 1_700_000_000_000, cwd: "/repo/myapp",
  items: [
    { id: "a1", source: "intent", text: "the picker forgets its scroll position", state: "queued" },
    { id: "a2", source: "intent", text: "write the migration guide", state: "failed" },
    { id: "c1", source: "intent", text: "already shipped", state: "done", context: true },
  ],
};

test("the headline cap in the prompt is the one the cleaner enforces", () => {
  const p = assessPrompt(input);
  assert.match(p, new RegExp(`at most ${MAX_HEADLINE_CHARS} characters`),
    "the number has to come from MAX_HEADLINE_CHARS, not from somebody's memory of it");
  // The shape of the ask, which is the half `cleanHeadline` cannot repair: a
  // title that is the item's own opening words is REFUSED, not clipped, so the
  // prompt has to say so or the run pays for eighty drops.
  assert.match(p, /not simply the item's first words/);
  assert.match(p, /3 to 8 words/);
});

test("all four kinds are in the prompt, interpolated from the vocabulary", () => {
  const p = assessPrompt(input);
  assert.match(p, new RegExp(ITEM_CATEGORIES.join(" \\| ")),
    "the list is ITEM_CATEGORIES' own order, joined — a hand-written list is a second vocabulary");
  for (const c of ITEM_CATEGORIES) assert.ok(p.includes(c), `${c} is named`);
  // `cleanCategory` knows four words and no synonyms, so "leave it out" has to
  // be an offered answer: without it the model picks the nearest of four and
  // every row nobody looked at is filed under a heading its author never chose.
  assert.match(p, /Leave `category` out if none fits; never guess\./);
});

test("the JSON shape the prompt shows carries the two fields on all three arrays", () => {
  const p = assessPrompt(input);
  const shape = p.split("\n").filter((l) => l.includes('"headline"'));
  assert.equal(shape.length, 3, "items, merges and new — a shape line that omitted one would teach that that list has no names");
  for (const line of shape) assert.match(line, /"category":"bug\|feature\|enhancement\|chore"/);
});

test("the caps that were already interpolated still are — this file is the whole rule, not one paragraph of it", () => {
  const p = assessPrompt(input);
  assert.match(p, new RegExp(`${MIN_MERGE_SIZE} to ${MAX_MERGE_SIZE} items`));
  assert.match(p, new RegExp(`up to ${MAX_NEW} genuinely missing pieces`));
});
