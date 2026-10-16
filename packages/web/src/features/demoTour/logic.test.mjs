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
  EMPTY_TOUR, HOOK_PROMPT, HOOK_SCENARIO, TOUR, TOUR_ROWS, TOUR_SESSION, cardShown, claimHook, claimsHook, cueShown, hintShown, loopDone, shouldTypeHook, markHook, markSeen, needsSession,
  parseTourState, progressText, tourProgress, tourSession,
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
  assert.deepEqual(parseTourState({ opened: "yes", seen: "live", sid: 3 }), EMPTY_TOUR);
  assert.deepEqual(parseTourState({ opened: true, read: true, seen: ["live", "gone", 3, "live"], sid: "demo-7" }),
    { seen: ["live"], opened: true, read: true, closed: false, typed: false, sid: "demo-7" });
  // A record from before the hook (`shown`) reads as a fresh hook, its rows kept.
  assert.deepEqual(parseTourState({ shown: true, seen: ["live"] }), { ...EMPTY_TOUR, seen: ["live"] });
});

const HOOK = { demo: true, scenario: HOOK_SCENARIO };
const GARDEN = { id: "demo-7", cwd: "~/dev/todo-garden" };

test("the demo opens on the repo list: the start cue stands until a session is started or put away", () => {
  assert.equal(cueShown(EMPTY_TOUR, { ...HOOK, active: false }), true);
  assert.equal(cueShown(EMPTY_TOUR, { ...HOOK, active: true }), false, "never over a session");
  assert.equal(cueShown(markHook(EMPTY_TOUR, "opened"), { ...HOOK, active: false }), false, "its X");
  assert.equal(cueShown(claimHook(EMPTY_TOUR, "demo-7"), { ...HOOK, active: false }), false, "a session was started");
  assert.equal(cueShown(EMPTY_TOUR, { demo: true, scenario: "numbers", active: false }), false);
  assert.equal(cueShown(EMPTY_TOUR, { demo: false, scenario: HOOK_SCENARIO, active: false }), false);
});

test("the first FRESH session in the tour's repo is the hook's, once", () => {
  assert.equal(claimsHook(EMPTY_TOUR, { ...HOOK, session: GARDEN }), true);
  assert.equal(claimsHook(EMPTY_TOUR, { ...HOOK, session: { id: "demo-8", cwd: "~/dev/pocket-notes" } }), false, "another repo");
  assert.equal(claimsHook(EMPTY_TOUR, { ...HOOK, session: { id: "demo-g1", cwd: "~/dev/todo-garden", firstPrompt: "make overdue tasks show a red edge" } }), false, "the older session there");
  const claimed = claimHook(EMPTY_TOUR, "demo-7");
  assert.deepEqual(claimed, { ...EMPTY_TOUR, sid: "demo-7", opened: true });
  assert.equal(claimHook(claimed, "demo-7"), claimed, "same object back");
  assert.equal(claimsHook(claimed, { ...HOOK, session: { ...GARDEN, id: "demo-9" } }), false, "never a second one");
  assert.equal(claimsHook(markHook(EMPTY_TOUR, "typed"), { ...HOOK, session: GARDEN }), false, "a spent hook takes none");
  assert.equal(claimsHook(EMPTY_TOUR, { demo: true, scenario: "numbers", session: GARDEN }), false);
});

test("the first prompt is typed once, into the session the cued tap started, into an empty box only", () => {
  const s = claimHook(EMPTY_TOUR, "demo-7");
  const at = { ...HOOK, activeId: "demo-7", draft: "" };
  assert.equal(shouldTypeHook(s, at), true);
  assert.equal(shouldTypeHook(EMPTY_TOUR, at), false, "no session claimed");
  assert.equal(shouldTypeHook(markHook(s, "typed"), at), false, "once per visit");
  assert.equal(shouldTypeHook(s, { ...at, draft: "my own words" }), false, "never into a person's words");
  assert.equal(shouldTypeHook(s, { ...at, activeId: "demo-g1" }), false, "not the older session");
  assert.equal(shouldTypeHook(s, { ...at, scenario: "numbers" }), false);
});

test("the reader hint and the closing card wait for the loop to END, on the hook's session", () => {
  const s = markHook(claimHook(EMPTY_TOUR, "demo-7"), "typed");
  const working = { id: "demo-7", turnActive: true, lastPrompt: ".claude/inbox/collage-2-marked.png make ② look like ①" };
  const done = { ...working, turnActive: false };
  assert.equal(loopDone(working), false);
  assert.equal(loopDone(done), true);
  assert.equal(loopDone({ turnActive: false, lastPrompt: HOOK_PROMPT }), false, "the first turn is not the loop");
  assert.equal(hintShown(s, { ...HOOK, session: done }), true);
  assert.equal(hintShown(s, { ...HOOK, session: working }), false, "never over the work");
  assert.equal(hintShown(markHook(s, "read"), { ...HOOK, session: done }), false);
  assert.equal(hintShown(s, { ...HOOK, session: { ...done, id: "demo-g1" } }), false);
  assert.equal(cardShown(s, { ...HOOK, session: done }), true);
  assert.equal(cardShown(s, { ...HOOK, session: working }), false);
  assert.equal(cardShown(markHook(s, "closed"), { ...HOOK, session: done }), false);
  assert.equal(cardShown(s, { ...HOOK, session: { ...done, id: "demo-n1" } }), false);
  assert.equal(cardShown(EMPTY_TOUR, { ...HOOK, session: done }), false, "no hook session, no card");
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
