import { test } from "node:test";
import assert from "node:assert/strict";
import { diskLevel, diskPushText, diskStep, diskWarnGb } from "../dist/diskwatch.js";

const G = 1e9;

test("the line off its env string: default 10, 0 is off, junk is the default", () => {
  assert.equal(diskWarnGb(undefined), 10);
  assert.equal(diskWarnGb(""), 10);
  assert.equal(diskWarnGb("20"), 20);
  assert.equal(diskWarnGb("0"), null);
  assert.equal(diskWarnGb("-3"), 10);
  assert.equal(diskWarnGb("lots"), 10);
});

test("levels: under the line is low, under 3 GB critical", () => {
  assert.equal(diskLevel(50 * G, 10), "ok");
  assert.equal(diskLevel(7.5 * G, 10), "low");
  assert.equal(diskLevel(2 * G, 10), "critical");
});

test("one push per level crossed, re-armed only 2 GB back above the line", () => {
  let s = diskStep("ok", 7.5 * G, 10);
  assert.deepEqual(s, { push: "low", told: "low" });
  s = diskStep(s.told, 7 * G, 10);
  assert.equal(s.push, null, "still low: said already");
  s = diskStep(s.told, 10.5 * G, 10);
  assert.deepEqual(s, { push: null, told: "low" }, "hovering at the line is not re-armed");
  s = diskStep(s.told, 9.5 * G, 10);
  assert.equal(s.push, null);
  s = diskStep(s.told, 2 * G, 10);
  assert.deepEqual(s, { push: "critical", told: "critical" });
  s = diskStep(s.told, 6 * G, 10);
  assert.deepEqual(s, { push: null, told: "low" }, "out of critical re-arms critical");
  s = diskStep(s.told, 12 * G, 10);
  assert.deepEqual(s, { push: null, told: "ok" });
  assert.equal(diskStep(s.told, 8 * G, 10).push, "low", "the next drop is told again");
});

test("the words: free and total, and the Tailscale sentence only on macOS", () => {
  const mac = diskPushText("low", 7.5 * G, 460 * G, "darwin");
  assert.equal(mac.title, "Desktop disk low · 7.5 GB free");
  assert.match(mac.body, /7\.5 of 460 GB free/);
  assert.match(mac.body, /Tailscale/);
  assert.doesNotMatch(diskPushText("critical", 1 * G, 100 * G, "linux").body, /Tailscale/);
});
