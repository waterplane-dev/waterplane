import { test } from "node:test";
import assert from "node:assert/strict";

import { setupMissingText, setupSteps, setupSummary, setupView } from "./phoneSetup.ts";

const link = (over = {}) => ({ enabled: true, running: true, notifications: true, batteryExempt: true, ...over });

test("no shell, no checklist", () => {
  assert.equal(setupSteps({ link: null, canInstall: true }), null);
});

test("an install access not yet known is absent, never counted as missing", () => {
  const steps = setupSteps({ link: link(), canInstall: null });
  assert.deepEqual(steps.map((s) => s.id), ["link", "notifications", "battery"]);
  assert.equal(setupMissingText(steps), null);
});

test("the banner names what is missing, and the count is the checklist's", () => {
  const steps = setupSteps({ link: link({ notifications: false }), canInstall: false });
  assert.equal(setupSummary(steps), "2 of 4 ready");
  assert.equal(setupMissingText(steps), "Phone setup 2 of 4 ready — still missing: notifications, install apps.");
});

test("the banner's sheet lists only what is missing, and counts what it hid", () => {
  const steps = setupSteps({ link: link({ notifications: false }), canInstall: false });
  const cut = setupView(steps, false);
  assert.deepEqual(cut.shown.map((s) => s.id), ["notifications", "install"]);
  assert.equal(cut.hidden, 2);
  const all = setupView(steps, true);
  assert.equal(all.shown.length, 4);
  assert.equal(all.hidden, 0);
});
