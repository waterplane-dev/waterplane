import test from "node:test";
import assert from "node:assert/strict";

import { REPLAN_NOTE, compactToast, contextSubject, replanBlockedToast, replanDoneToast } from "./logic.ts";

const a = { id: "a" }, b = { id: "b" };

test("the row's session wins over the attached one", () => {
  assert.equal(contextSubject("b", [a, b], a), b);
});

test("no id, or a stale one, is the attached session", () => {
  assert.equal(contextSubject(null, [a, b], a), a);
  assert.equal(contextSubject("gone", [a, b], a), a);
});

test("nothing to show is null, so the sheet falls through", () => {
  assert.equal(contextSubject("gone", [a], null), null);
  assert.equal(contextSubject(null, [], null), null);
});

test("the compact receipt says whether it went or waits", () => {
  assert.equal(compactToast(true, "myapp · fix"), "sent /compact to myapp · fix");
  assert.equal(compactToast(false, "x"), "queued /compact — sends when the link is back");
});

test("re-plan: the offline sentence says neither the Esc nor the prompt went; the note says what is lost", () => {
  assert.match(replanBlockedToast("api"), /Esc did not reach api, and the re-plan prompt was not queued/);
  assert.match(replanDoneToast("api"), /Esc to api and queued the re-plan prompt/);
  assert.match(REPLAN_NOTE, /not reported back is lost/);
  assert.match(REPLAN_NOTE, /background keeps going/);
});
