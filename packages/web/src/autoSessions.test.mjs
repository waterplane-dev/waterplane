/**
 * Automatic sessions as the phone words them — `autoSessions.ts`.
 *
 *     node --test packages/web/src/autoSessions.test.mjs
 *
 * Two rules worth a test: ABSENT is inherit and never "keep open" (the global
 * is said beside it), and the "close one to make room" count is exactly the
 * list it opens — the host's snapshot intersected with the live sessions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  autoSlotSessions, closeChipWords, closeChoiceDraft, closeChoiceLabel, closeChoiceOf, closeChoicePatch,
  closeChoiceToast, closeEffectWords, closeOneLabel, opensOwnSession, slotHeld, slotSessionState,
} from "./autoSessions.ts";

test("absent is inherit, false is keep, true is close", () => {
  assert.equal(closeChoiceOf(undefined), "inherit");
  assert.equal(closeChoiceOf(null), "inherit");
  assert.equal(closeChoiceOf(false), "keep");
  assert.equal(closeChoiceOf(true), "close");
});

test("the wire: update clears with null, add sends nothing for inherit", () => {
  assert.equal(closeChoicePatch("inherit"), null);
  assert.equal(closeChoicePatch("keep"), false);
  assert.equal(closeChoicePatch("close"), true);
  assert.equal(closeChoiceDraft("inherit"), undefined);
  assert.equal(closeChoiceDraft("keep"), false);
  assert.equal(closeChoiceDraft("close"), true);
});

test("the inherit chip says what the global does today", () => {
  assert.equal(closeChoiceLabel("inherit", false), "as set globally (currently: keep open)");
  assert.equal(closeChoiceLabel("inherit", true), "as set globally (currently: close when done)");
  assert.equal(closeChoiceLabel("keep", true), "keep open");
  assert.equal(closeChoiceLabel("close", false), "close when done");
});

test("the effective sentence follows the global only when the row inherits", () => {
  assert.match(closeEffectWords(undefined, false), /stays open .* as set globally\.$/);
  assert.match(closeEffectWords(undefined, true), /closes itself .* as set globally\.$/);
  assert.match(closeEffectWords(false, true), /stays open .* this item's own choice\.$/);
  assert.match(closeEffectWords(true, false), /closes itself .*Recently closed.* this item's own choice\.$/);
  assert.equal(closeChoiceToast("inherit", false), "follows the global setting — stays open");
  assert.equal(closeChoiceToast("close", false), "its session will close when done");
});

test("the closed row's chip is only an item's own answer", () => {
  assert.equal(closeChipWords(undefined), null);
  assert.equal(closeChipWords(false), "stays open");
  assert.equal(closeChipWords(true), "closes when done");
});

test("only a row that opens its own session is asked", () => {
  assert.equal(opensOwnSession({}), true);
  assert.equal(opensOwnSession({ targetSessionId: "s1" }), false);
});

const facts = (max, ids) => ({ max, open: ids.map((id, n) => ({ id, closeWhenDone: n === 0 })) });
const sess = (id, extra = {}) => ({ id, cwd: "/r", title: `backlog · r · ${id}`, remoteControl: true, running: true, createdAt: 1, ...extra });

test("held on a slot: the host's cap is full AND the row's sentence names the slot", () => {
  const wait = "waiting for a free slot — 3 automatic sessions open (close one to make room)";
  assert.equal(slotHeld(wait, facts(3, ["a", "b", "c"])), true);
  assert.equal(slotHeld(wait, facts(3, ["a", "b"])), false, "a slot is free: the cap is not what holds it");
  assert.equal(slotHeld("waiting — one at a time in this repo", facts(3, ["a", "b", "c"])), false);
  assert.equal(slotHeld(wait, undefined), false, "an older host sent no facts");
  assert.equal(slotHeld(undefined, facts(1, ["a"])), false);
});

test("the list is the snapshot intersected with LIVE sessions, in the host's order", () => {
  const live = [sess("c"), sess("a"), sess("gone-later", { running: false }), sess("other")];
  const got = autoSlotSessions(facts(4, ["a", "b", "c", "gone-later"]), live);
  assert.deepEqual(got.map((x) => x.s.id), ["a", "c"], "b closed since the snapshot; an exited one is not open");
  assert.equal(got[0].closeWhenDone, true);
  assert.equal(got[1].closeWhenDone, false);
  assert.deepEqual(autoSlotSessions(null, live), []);
  // The count on the control is that list's length — the tap opens exactly those.
  assert.equal(closeOneLabel(got.length), "close one to make room — 2 open");
});

test("a slot session's state line", () => {
  assert.equal(slotSessionState(sess("a", { turnActive: true }), false), "working · stays open until closed");
  assert.equal(slotSessionState(sess("a"), true), "idle · closes itself when done");
});
