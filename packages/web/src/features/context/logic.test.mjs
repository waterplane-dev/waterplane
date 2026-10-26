import test from "node:test";
import assert from "node:assert/strict";

import { REPLAN_NOTE, compactToast, contextFallbackToast, contextSubject, replanBlockedToast, replanDoneToast } from "./logic.ts";

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

test("a door that asked for another conversation says which one it opened", () => {
  assert.match(contextFallbackToast("myapp · fix"), /not listed — showing myapp · fix/);
  assert.match(contextFallbackToast(null), /none is attached/);
});

test("the carried section is drawn without samples, and the doors in the unmeasured branch (source pin)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../ContextSheet.tsx", import.meta.url), "utf8");
  assert.match(src, /!samples\.length && doc && <CarriedSection/);
  const unmeasured = src.slice(src.indexOf("if (unmeasured) {"));
  assert.ok(unmeasured.slice(0, unmeasured.indexOf("</Hint>")).includes("{doorsRow}"));
  const setup = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.match(setup, /focus: "context-weight"/);
});
