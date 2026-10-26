import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTING_ROWS } from "../../settingsIndex.ts";
import { announce, fallbackNote, failuresOf, isFreshPhone, inShort, launcherLine, normVersion, pickRelease, RELEASES, rowView } from "./logic.ts";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const facts = (over = {}) => ({
  now: NOW, needsYou: null, pushInfo: null, failures: null, clocks: null, weekburn: null,
  dropCopy: null, native: true, apk: "0.1.8", ...over,
});
const R18 = RELEASES.find((r) => r.version === "0.1.8");
const thing = (id) => R18.things.find((t) => t.id === id);
const view = (id, over) => rowView(thing(id), facts(over));

test("the rows are short: a title of at most 4 words, a line of at most 90 chars, ids unique", () => {
  for (const r of RELEASES) {
    const ids = new Set();
    for (const t of r.things) {
      assert.ok(t.title.split(/\s+/).length <= 4, `${t.id}: title "${t.title}"`);
      assert.ok(t.line.length <= 90, `${t.id}: line is ${t.line.length} chars`);
      assert.ok(!ids.has(t.id), `${t.id} twice`);
      ids.add(t.id);
      assert.ok(t.verb === null || /^[a-z]/.test(t.verb), `${t.id}: a verb starts lower case (a sheet's name inside it stays as drawn)`);
    }
  }
});

test("a fact not read draws no state line and keeps the default door", () => {
  for (const t of R18.things) {
    if (t.id === "shade-taps") continue; // reads no fact: the APK is the whole state
    const v = rowView(t, facts());
    assert.equal(v.text, null, t.id);
    assert.deepEqual(v.door, t.door, t.id);
  }
});

test("bell: a count opens exactly those (the bell's cut); none opens the feed", () => {
  assert.deepEqual(view("bell-needs-you", { needsYou: 3 }), { text: "3 need you", door: { kind: "bell" }, verb: "open those 3" });
  assert.deepEqual(view("bell-needs-you", { needsYou: 1 }), { text: "1 needs you", door: { kind: "bell" }, verb: "open it" });
  assert.deepEqual(view("bell-needs-you", { needsYou: 0 }), { text: "nothing needs you", door: { kind: "feed" }, verb: "open the feed" });
});

test("push information: on / off, the door is the setting by id", () => {
  assert.deepEqual(view("push-info", { pushInfo: false }), { text: "off", door: { kind: "setting", id: "notif-info-push" }, verb: "change it" });
  assert.equal(view("push-info", { pushInfo: true }).text, "on");
});

test("failures: the number and the cut are one list; one opens that repo; none has no door", () => {
  const items = [
    { id: "n1", key: "git:r1:push" }, { id: "n2", key: "build:r2:apk" }, { id: "n3", key: "nonsense" },
  ];
  const names = { r1: "ciqkit", r2: "garmin-monorepo" };
  const f = failuresOf(items, (id) => names[id] ?? null);
  assert.deepEqual(f.map((x) => x.id), ["n1", "n2"]);
  const v = view("repo-failures", { failures: f });
  assert.equal(v.text, "2 failed: ciqkit push, garmin-monorepo build");
  assert.deepEqual(v.door, { kind: "feedCut", ids: ["n1", "n2"] });
  assert.equal(v.verb, "see those 2");
  assert.deepEqual(view("repo-failures", { failures: f.slice(1) }), { text: "garmin-monorepo build failed", door: { kind: "build", repoId: "r2" }, verb: "open build" });
  assert.deepEqual(view("repo-failures", { failures: [] }), { text: "nothing has failed", door: null, verb: null });
});

test("a repo id with a colon still parses; an unknown repo keeps its id", () => {
  assert.deepEqual(failuresOf([{ id: "a", key: "git:C:/x:pull" }], () => null)[0], { id: "a", repoId: "C:/x", repoName: "C:/x", verb: "pull", kind: "git" });
});

test("automation and build clocks: no list is no claim; a build count cuts to exactly those ids", () => {
  const clocks = [
    { id: "a", enabled: true, nextAt: NOW + 3 * H, isBuild: false },
    { id: "b", enabled: true, nextAt: NOW + 30 * H, isBuild: true },
    { id: "c", enabled: false, nextAt: null, isBuild: true },
  ];
  assert.equal(view("automation", { clocks: [] }).text, null);
  assert.equal(view("automation", { clocks }).text, "next one fires in 3h");
  assert.equal(view("automation", { clocks: [clocks[2]] }).text, "nothing armed");
  const b = view("build-clock", { clocks });
  assert.equal(b.text, "2 builds on a clock");
  assert.deepEqual(b.door, { kind: "automationCut", ids: ["b", "c"], label: "builds on a clock" });
  assert.equal(b.verb, "see those 2");
  assert.deepEqual(view("build-clock", { clocks: [clocks[0]] }), { text: "none yet", door: { kind: "sheet", id: "schedule" }, verb: "open Automation" });
});

test("an APK-gated row says why in words and offers the APK; a browser says app only", () => {
  assert.deepEqual(view("downloads-once", { apk: "0.1.6", dropCopy: null }),
    { text: "needs the 0.1.8 APK · yours is 0.1.6", door: { kind: "sheet", id: "apps" }, verb: "get the APK" });
  assert.deepEqual(view("downloads-once", { native: false, apk: null }), { text: "app only", door: null, verb: null });
  assert.equal(view("downloads-once", { dropCopy: true }).text, "on");
  assert.equal(view("shade-taps", {}).text, "in this APK");
  assert.equal(view("shade-taps", { apk: null }).text, null);
});

test("week-end burn: absent when unavailable, picked count, nothing picked with the reset", () => {
  const w = (over) => ({ prefs: { repos: ["/a", "/b"], weekOf: 1, recurring: false, lastRepos: [], stopPct: 95 },
    available: true, weeklyPct: 40, weeklyResetAt: NOW + 3 * 24 * H, plan: null, pickedThisWeek: true, running: [], ...over });
  assert.equal(view("weekburn", { weekburn: w({ available: false }) }).text, null);
  assert.equal(view("weekburn", { weekburn: w() }).text, "2 picked");
  assert.match(view("weekburn", { weekburn: w({ plan: { startAt: NOW + H, reasonText: "" } }) }).text, /^2 picked · starts \w+ \d\d:\d\d$/);
  assert.equal(view("weekburn", { weekburn: w({ pickedThisWeek: false }) }).text, "nothing picked · resets in 3d");
});

test("the launcher row: once per desktop version with rows, never before the host said", () => {
  assert.equal(announce(RELEASES, null, ""), null);
  assert.equal(announce(RELEASES, "0.1.8", "0.1.8"), null);
  assert.equal(announce(RELEASES, "v0.1.8", "")?.version, "0.1.8");
  assert.equal(announce(RELEASES, "0.1.7", ""), null, "a version with no rows announces nothing");
  const r = R18;
  const n = r.things.length;
  const gated = r.things.filter((t) => t.needsApk).length;
  assert.equal(launcherLine("waterplane", r, { native: true, apk: "0.1.6" }), `waterplane 0.1.8 is on the desktop · ${n} new things, ${gated} need the new APK`);
  assert.equal(launcherLine("waterplane", r, { native: false, apk: null }), `waterplane 0.1.8 is on the desktop · ${n} new things`);
});

test("the sheet opens on the desktop's release, else the newest", () => {
  assert.equal(pickRelease(RELEASES, "0.1.6").version, "0.1.6");
  assert.equal(pickRelease(RELEASES, "9.9.9").version, RELEASES[0].version);
  assert.equal(normVersion("v0.1.8-dev"), "0.1.8");
  assert.equal(inShort(90 * 60_000), "1h");
  assert.equal(inShort(26 * H), "1d 2h");
});

test("a phone that never ran a session is not announced; an upgrade with sessions is", () => {
  const none = { sessions: 0, recent: 0, closed: 0 };
  assert.equal(isFreshPhone(none), true);
  assert.equal(isFreshPhone({ ...none, closed: 1 }), false);
  assert.equal(announce(RELEASES, "0.1.8", "", isFreshPhone(none)), null);
  assert.equal(announce(RELEASES, "0.1.8", "", isFreshPhone({ ...none, sessions: 2 }))?.version, "0.1.8");
});

test("a desktop version with no rows says so; one with rows does not", () => {
  assert.equal(fallbackNote(RELEASES, "0.1.9"), `Nothing written for 0.1.9 yet — below is ${RELEASES[0].version}.`);
  assert.equal(fallbackNote(RELEASES, "0.1.8"), null);
  assert.equal(fallbackNote(RELEASES, null), null);
});

test("every setting door names a row that exists in the settings index", () => {
  const ids = new Set(SETTING_ROWS.map((r) => r.id));
  for (const r of RELEASES) for (const t of r.things) {
    if (t.door?.kind === "setting") assert.ok(ids.has(t.door.id), `${t.id} -> ${t.door.id}`);
  }
});

test("a row with no default door draws none until the APK gate offers one", () => {
  assert.deepEqual(view("shade-taps", {}), { text: "in this APK", door: null, verb: null });
});
