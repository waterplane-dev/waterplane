/**
 * The demo tour's pure half (`features/demoTour/logic.ts`).
 *
 *     node --test packages/web/src/features/demoTour/logic.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EMPTY_TOUR, HOOK_SCENARIO, TOUR, TOUR_ROWS, TOUR_SESSION, cardShown, hintShown, loopDone, markHook, markSeen, needsSession,
  parseTourState, progressText, shouldOpenHook, tourProgress, tourSession,
} from "./logic.ts";

/** The string literals of `routing.ts`'s `Overlay` union — the route stack's own list. */
function overlayIds() {
  const src = readFileSync(fileURLToPath(new URL("../../routing.ts", import.meta.url)), "utf8");
  const m = /export type Overlay = ([^;]+);/.exec(src);
  assert.ok(m, "could not find `export type Overlay` in routing.ts — did it move?");
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

test("every sheet row opens an Overlay the route stack knows", () => {
  const known = overlayIds();
  assert.ok(known.has("demotour"), "the tour's own sheet is an Overlay");
  for (const r of TOUR_ROWS) {
    if (r.target.kind === "sheet") assert.ok(known.has(r.target.overlay), `${r.id}: "${r.target.overlay}" is not an Overlay`);
  }
});

test("rows: unique ids, grouped, one sentence each, a dozen or so", () => {
  const ids = TOUR_ROWS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "row ids are unique");
  assert.ok(TOUR_ROWS.length >= 12 && TOUR_ROWS.length <= 16, `${TOUR_ROWS.length} rows`);
  assert.ok(TOUR.length >= 3 && TOUR.every((g) => g.rows.length > 0));
  for (const r of TOUR_ROWS) {
    assert.ok(r.headline.trim() && r.sentence.trim(), r.id);
    assert.match(r.sentence, /[.!?]$/, `${r.id}: a sentence ends like one`);
    assert.doesNotMatch(r.sentence, /\b(amazing|powerful|seamless|revolutionary|magic)/i, `${r.id}: plain words`);
  }
});

test("the tour drives the live session and answer-by-tap", () => {
  const live = TOUR_ROWS.find((r) => r.id === "live");
  assert.deepEqual(live.target, { kind: "session" });
  const answer = TOUR_ROWS.find((r) => r.id === "answer");
  assert.equal(answer.target.kind, "reader");
  assert.match(answer.target.seed, /sort/, "the first-look scenario answers prompts containing 'sort'");
  assert.equal(needsSession(answer.target), true);
  assert.equal(needsSession({ kind: "sheet", overlay: "tokens" }), false);
  assert.equal(needsSession({ kind: "sheet", overlay: "gallery", inSession: true }), true);
});

test("markSeen: adds once, ignores repeats and unknown ids (same object back)", () => {
  const a = markSeen(EMPTY_TOUR, "live");
  assert.deepEqual(a.seen, ["live"]);
  assert.equal(markSeen(a, "live"), a);
  assert.equal(markSeen(a, "no-such-row"), a);
  assert.deepEqual(EMPTY_TOUR.seen, [], "never mutates");
});

test("progress counts seen rows and says so in words", () => {
  assert.equal(progressText(EMPTY_TOUR), `0 of ${TOUR_ROWS.length} tried`);
  let s = markSeen(markSeen(EMPTY_TOUR, "live"), "tokens");
  assert.deepEqual(tourProgress(s), { seen: 2, total: TOUR_ROWS.length, done: false });
  for (const r of TOUR_ROWS) s = markSeen(s, r.id);
  assert.equal(tourProgress(s).done, true);
  assert.equal(progressText(s), `All ${TOUR_ROWS.length} tried`);
});

test("parseTourState: malformed reads as fresh, stale ids dropped, duplicates folded", () => {
  assert.deepEqual(parseTourState(null), EMPTY_TOUR);
  assert.deepEqual(parseTourState("x"), EMPTY_TOUR);
  assert.deepEqual(parseTourState({ opened: "yes", seen: "live" }), EMPTY_TOUR);
  assert.deepEqual(parseTourState({ opened: true, read: true, seen: ["live", "gone", 3, "live"] }),
    { seen: ["live"], opened: true, read: true, closed: false });
  // A record from before the hook (`shown`) reads as a fresh hook, its rows kept.
  assert.deepEqual(parseTourState({ shown: true, seen: ["live"] }), { ...EMPTY_TOUR, seen: ["live"] });
});

const HOOK = { demo: true, scenario: HOOK_SCENARIO };

test("the hook opens its session once, in its scenario, only over nothing", () => {
  assert.equal(shouldOpenHook(EMPTY_TOUR, { ...HOOK, active: false }), true);
  assert.equal(shouldOpenHook(markHook(EMPTY_TOUR, "opened"), { ...HOOK, active: false }), false);
  assert.equal(shouldOpenHook(EMPTY_TOUR, { ...HOOK, active: true }), false, "a restored route is not taken over");
  assert.equal(shouldOpenHook(EMPTY_TOUR, { demo: true, scenario: "numbers", active: false }), false);
  assert.equal(shouldOpenHook(EMPTY_TOUR, { demo: false, scenario: HOOK_SCENARIO, active: false }), false);
  const o = markHook(EMPTY_TOUR, "opened");
  assert.equal(markHook(o, "opened"), o, "same object back");
});

test("the reader hint stands on the hook session until the reader was opened", () => {
  assert.equal(hintShown(EMPTY_TOUR, { ...HOOK, activeId: TOUR_SESSION }), true);
  assert.equal(hintShown(EMPTY_TOUR, { ...HOOK, activeId: "demo-n1" }), false);
  assert.equal(hintShown(markHook(EMPTY_TOUR, "read"), { ...HOOK, activeId: TOUR_SESSION }), false);
  assert.equal(hintShown(EMPTY_TOUR, { demo: true, scenario: "gallery-and-files", activeId: TOUR_SESSION }), false);
});

test("the closing card: after the annotate-and-send-back turn has ENDED, until put away", () => {
  const working = { id: TOUR_SESSION, turnActive: true, lastPrompt: ".claude/inbox/x.png make this bigger" };
  const done = { ...working, turnActive: false };
  assert.equal(loopDone(working), false);
  assert.equal(loopDone(done), true);
  assert.equal(loopDone({ turnActive: false, lastPrompt: "add a quick-add bar above the task list" }), false);
  assert.equal(cardShown(EMPTY_TOUR, { ...HOOK, session: done }), true);
  assert.equal(cardShown(EMPTY_TOUR, { ...HOOK, session: working }), false);
  assert.equal(cardShown(markHook(EMPTY_TOUR, "closed"), { ...HOOK, session: done }), false);
  assert.equal(cardShown(EMPTY_TOUR, { ...HOOK, session: { ...done, id: "demo-n1" } }), false);
});

test("tourSession: the scenario's id, else its repo, else none", () => {
  const g = { id: TOUR_SESSION, cwd: "/u/dev/todo-garden" };
  const other = { id: "x", cwd: "/u/dev/pocket-notes" };
  const renamed = { id: "y", cwd: "/u/dev/todo-garden/" };
  assert.equal(tourSession([other, g]), g);
  assert.equal(tourSession([other, renamed]), renamed);
  assert.equal(tourSession([other]), null);
  assert.equal(tourSession([]), null);
});
