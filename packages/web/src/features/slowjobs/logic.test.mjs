import test from "node:test";
import assert from "node:assert/strict";
import { screenFor, toastFor } from "./logic.ts";

const f = (o = {}) => ({ kind: "setup.check", state: "done", asked: true, watched: false, ...o });

test("a toast only for a run somebody waited on, and only off its screen", () => {
  assert.equal(toastFor(f({ asked: false }), "app"), null);
  assert.equal(toastFor(f({ watched: true }), "app"), null);
  assert.equal(toastFor(f({ state: "running" }), "app"), null);
  assert.match(toastFor(f(), "app"), /^The setup checklist for app is ready — tap to open\.$/);
});

test("each kind names what finished; a suggestion list says nothing is switched", () => {
  assert.match(toastFor(f({ kind: "skills.uses" }), "app"), /use counts for app are ready/);
  assert.match(toastFor(f({ kind: "skills.recommend" }), "app"), /Nothing is switched until you apply/);
});

test("a failure quotes the host's sentence", () => {
  assert.match(toastFor(f({ state: "failed", error: "Gave up after 10 min." }), "app"), /did not finish: Gave up after 10 min\. Tap to open\.$/);
});

test("the tap opens the screen that reads the kind", () => {
  assert.equal(screenFor("setup.check"), "setup");
  assert.equal(screenFor("skills.recommend"), "skills");
  assert.equal(screenFor("skills.inventory"), "skills");
});
