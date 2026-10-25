// The build ↔ schedule seam in words: the Build sheet's cue (a count is a
// filter — its ids are exactly the rules its words describe), the form's
// seeds, refusals and entry, and Activity's provenance for a fired run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRule } from "@waterplane/shared";
import {
  buildRunFromSchedule, buildScheduleBlocker, buildScheduleCue, buildScheduleEntry, buildScheduleValues, buildScheduleWhen,
} from "./buildSchedule.ts";

const NOW = Date.UTC(2026, 9, 25, 9, 0);
const H = 3600e3;
const weekly = { kind: "weekly", days: [1, 2, 3, 4, 5], hour: 7, minute: 0, tz: "UTC" };
const rule = (id, extra = {}) => ({
  id, name: `rule ${id}`, enabled: true, rule: weekly, createdAt: 0, graceMin: 120, nextAt: NOW + 3 * H,
  action: { kind: "build", repoDir: "/r", buildId: "apk" }, ...extra,
});
const APK = { id: "apk", name: "Android APK", cmd: "npm run apk" };

test("no rule for this build ⇒ no cue at all", () => {
  assert.equal(buildScheduleCue([], "/r", APK, NOW), null);
  // another build, another repo, a prompt rule: none of them is this entry's
  const others = [
    rule("a", { action: { kind: "build", repoDir: "/r", buildId: "web" } }),
    rule("b", { action: { kind: "build", repoDir: "/other", buildId: "apk" } }),
    rule("c", { action: { kind: "backlog", repoDir: "/r", text: "run build apk" } }),
  ];
  assert.equal(buildScheduleCue(others, "/r", APK, NOW), null);
});

test("one armed rule: the card's rule line plus the countdown, and its one id", () => {
  const cue = buildScheduleCue([rule("a")], "/r", APK, NOW);
  assert.deepEqual(cue.ids, ["a"]);
  assert.equal(cue.words, `${describeRule(weekly)} · next in 3h`);
  assert.equal(cue.label, "the schedule “rule a”");
});

test("a paused rule says paused in text; an armed-at-nothing one says not armed", () => {
  assert.equal(buildScheduleCue([rule("a", { enabled: false, nextAt: null })], "/r", APK, NOW).words, `${describeRule(weekly)} · paused`);
  assert.equal(buildScheduleCue([rule("a", { nextAt: null })], "/r", APK, NOW).words, `${describeRule(weekly)} · not armed`);
});

test("several rules: the count, the soonest armed one — and the cut is exactly those ids", () => {
  const entries = [rule("a", { nextAt: NOW + 5 * H }), rule("b", { nextAt: NOW + 2 * H }), rule("c", { enabled: false, nextAt: null }),
    rule("x", { action: { kind: "build", repoDir: "/r", buildId: "web" } })];
  const cue = buildScheduleCue(entries, "/r", APK, NOW);
  assert.equal(cue.words, "3 schedules · next in 2h");
  assert.deepEqual(cue.ids, ["a", "b", "c"]);
  assert.equal(cue.label, "the 3 schedules that run “Android APK”");
  const allPaused = [rule("a", { enabled: false, nextAt: null }), rule("b", { enabled: false, nextAt: null })];
  assert.equal(buildScheduleCue(allPaused, "/r", APK, NOW).words, "2 schedules · paused");
});

test("a spent one-off is not a schedule: neither counted nor in the cut", () => {
  const spent = rule("s", { rule: { kind: "once", at: NOW - H }, enabled: false, nextAt: null, lastOccurrence: NOW - H });
  assert.equal(buildScheduleCue([spent], "/r", APK, NOW), null);
  assert.deepEqual(buildScheduleCue([spent, rule("a")], "/r", APK, NOW).ids, ["a"]);
});

const ASKS = { ...APK, cmd: "npm run apk -- {{flavor}} {{mode}}", params: [
  { id: "flavor", kind: "text", default: "dev" },
  { id: "mode", kind: "choice", options: ["debug", "release"] },
] };

test("values: the build's stored defaults and nothing else — or the edited rule's own", () => {
  assert.deepEqual(buildScheduleValues(ASKS, null), { flavor: "dev" });
  const edited = rule("a", { action: { kind: "build", repoDir: "/r", buildId: "apk", params: { flavor: "play", mode: "release" } } });
  assert.deepEqual(buildScheduleValues(ASKS, edited), { flavor: "play", mode: "release" });
});

test("a missing value REPLACES save with the sentence; a past once is refused in words", () => {
  const when = buildScheduleWhen(null, NOW);
  assert.match(buildScheduleBlocker(ASKS, { flavor: "dev" }, when, NOW + H), /mode/);
  assert.equal(buildScheduleBlocker(ASKS, { flavor: "dev", mode: "debug" }, when, NOW + H), null);
  assert.equal(buildScheduleBlocker(APK, {}, when, null), "the time it resolves to has already passed");
});

test("the entry: a build action with the picked values, named after the build when nothing was typed", () => {
  const when = buildScheduleWhen(null, NOW);
  const e = buildScheduleEntry({ id: "s1", repoDir: "/r", build: ASKS, vals: { flavor: "dev", mode: "debug" }, when, preview: NOW + H, now: NOW });
  assert.deepEqual(e.action, { kind: "build", repoDir: "/r", buildId: "apk", params: { flavor: "dev", mode: "debug" } });
  assert.equal(e.name, "Android APK");
  assert.equal(e.id, "s1");
  assert.equal(e.nextAt, NOW + H);
  const named = buildScheduleEntry({ id: "s1", repoDir: "/r", build: APK, vals: {}, when: { ...when, name: " nightly APK " }, preview: null, now: NOW });
  assert.equal(named.name, "nightly APK");
  assert.equal("params" in named.action, false);
});

test("editing seeds the rule's own when, its typed name kept", () => {
  const w = buildScheduleWhen(rule("a", { name: "nightly APK", graceMin: 30 }), NOW);
  assert.deepEqual(w.rule, weekly);
  assert.equal(w.graceMin, 30);
  assert.equal(w.name, "nightly APK");
});

test("provenance: off the run's origin, joined to the rule's row — absent when the rule is gone", () => {
  const run = { id: "r1", origin: "schedule:s1", payload: { kind: "build", buildId: "apk", name: "Android APK" } };
  const ruleRow = { id: "s1", title: "nightly APK", payload: { kind: "build", buildId: "apk" } };
  assert.deepEqual(buildRunFromSchedule(run, [ruleRow, run]), { id: "s1", name: "nightly APK" });
  assert.equal(buildRunFromSchedule(run, [run]), null);
  assert.equal(buildRunFromSchedule({ ...run, origin: undefined }, [ruleRow]), null);
  assert.equal(buildRunFromSchedule({ ...run, payload: { kind: "prompt", text: "x" } }, [ruleRow]), null);
});
