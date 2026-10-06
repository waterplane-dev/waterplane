/**
 * Where a fork cuts, pinned without a browser.
 *
 * `forkAnchor.ts` is the phone's answer to "where does a tap on this row cut":
 * just BEFORE the tapped turn, addressed by the newest logged turn above it — and both ways it can be wrong are silent. Too
 * generous and a fork cuts at an earlier turn than the reader shows, arriving
 * with less conversation than the number promises (the synthetic-turn case).
 * Too strict and the verbs refuse a `/btw` row for which an exact cut point
 * exists one line above it, which is what was reported from the phone as "fork
 * not working".
 *
 *     node --test packages/web/src/forkAnchor.test.mjs
 *
 * `npm run test:unit` discovers it through the `packages/web/src/*.test.mjs`
 * glob, same as `activityRows`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { anchorNote, forkAnchor, forkBlocker, isLogTurn, isScreenTurn } from "./forkAnchor.ts";

const turn = (id, n, extra = {}) => ({
  id, n, prompt: `p${n}`, promptLabel: `p${n}`, blocks: [], toolCount: 0, files: [], sidechains: 0,
  sentAt: n * 1000, ...extra,
});

const doc = (turns, extra = {}) => ({
  sessionId: "s1", claudeSessionId: "conv-1", source: "jsonl", turns,
  truncated: false, bytes: 10, updatedAt: 1, ...extra,
});

const LOGGED = turn("uuid-a", 1);
const LOGGED2 = turn("uuid-b", 2);
const SCREEN = turn("screen:h7", 2, { local: "screen" });
const SYNTH = turn("t3", 3);

test("a logged turn cuts BEFORE itself: the anchor is the turn above", () => {
  // Reported from the phone: fork at #8 of nine kept #8 and its answer, so the
  // copy was the whole conversation minus one line, and reset at a fork's last
  // turn changed nothing. "Here" is the start of the tapped turn.
  const d = doc([LOGGED, LOGGED2]);
  assert.deepEqual(forkAnchor(d, LOGGED2), { turn: LOGGED, skipped: 0 });
  assert.equal(forkBlocker(d, LOGGED2, true), null);
  assert.equal(anchorNote(LOGGED2, forkAnchor(d, LOGGED2)), null);
});

test("the first turn has nothing before it to keep", () => {
  const d = doc([LOGGED, LOGGED2]);
  assert.equal(forkAnchor(d, LOGGED), null);
  assert.match(forkBlocker(d, LOGGED, true), /nothing in the conversation log comes before/);
});

test("screen turns in between are stepped over, and the gap is said", () => {
  const after = turn("uuid-c", 3);
  const d = doc([LOGGED, SCREEN, after]);
  const a = forkAnchor(d, after);
  assert.deepEqual(a, { turn: LOGGED, skipped: 1 });
  const note = anchorNote(after, a);
  assert.match(note, /#1/);
  assert.match(note, /#3/);
});

test("a tapped screen turn cuts after the newest logged turn before it", () => {
  const d = doc([LOGGED, SCREEN]);
  assert.deepEqual(forkAnchor(d, SCREEN), { turn: LOGGED, skipped: 0 });
  assert.equal(forkBlocker(d, SCREEN, true), null);
});

test("two screen turns in a row both reach past each other", () => {
  const second = turn("screen:h8", 3, { local: "screen" });
  const d = doc([LOGGED, SCREEN, second]);
  assert.deepEqual(forkAnchor(d, second), { turn: LOGGED, skipped: 1 });
});

test("a screen turn with nothing logged before it has no cut point", () => {
  const first = turn("screen:h1", 1, { local: "screen" });
  const d = doc([first, LOGGED]);
  assert.equal(forkAnchor(d, first), null);
  // Later turns are history this fork is meant not to have — never an anchor.
  assert.match(forkBlocker(d, first, true), /nothing in the conversation log comes before/);
});

test("a synthesized turn is refused, and never stepped over", () => {
  // `t<N>` stands for real history the parse could not name; cutting past it
  // would silently drop it.
  const d = doc([LOGGED, SYNTH]);
  assert.equal(forkAnchor(d, SYNTH), null);
  assert.equal(forkBlocker(d, SYNTH, true), "this turn isn't in the conversation log");
  const after = turn("uuid-d", 4);
  const d2 = doc([LOGGED, SYNTH, after]);
  assert.equal(forkAnchor(d2, after), null);
  assert.match(forkBlocker(d2, after, true), /not read from the conversation log/);
});

test("the history fallback has no log to cut at all", () => {
  const d = doc([turn("h1", 1)], { source: "history", claudeSessionId: undefined });
  assert.equal(forkAnchor(d, d.turns[0]), null);
  assert.equal(forkBlocker(d, d.turns[0], true), "this turn isn't in the conversation log");
  assert.equal(forkBlocker(null, LOGGED, true), "this turn isn't in the conversation log");
});

test("a jsonl document with no conversation id is not forkable", () => {
  const d = doc([LOGGED, LOGGED2], { claudeSessionId: undefined });
  assert.equal(forkAnchor(d, LOGGED2), null);
});

test("the link is its own reason, and it outranks nothing", () => {
  const d = doc([LOGGED, SCREEN, LOGGED2]);
  assert.match(forkBlocker(d, LOGGED2, false), /no connection/);
  assert.match(forkBlocker(d, SCREEN, false), /no connection/);
  // A turn with no cut point says THAT offline too — the link is not why.
  assert.match(forkBlocker(d, SYNTH, false), /isn't in the conversation log/);
});

test("the two row predicates", () => {
  assert.equal(isLogTurn(LOGGED), true);
  assert.equal(isLogTurn(SCREEN), false);
  assert.equal(isLogTurn(SYNTH), false);
  assert.equal(isScreenTurn(SCREEN), true);
  assert.equal(isScreenTurn(SYNTH), false);
});
