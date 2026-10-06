import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanInstallEntry, deviceLabel, entryAt, filterInstallLog, installDevices,
  installKey, installLogLine, installLogSummary, installReportFrom, installTitle, mergeInstallLog,
} from "../dist/installlog.js";

const PHONE = { id: "aa11bb22", name: "Sam's phone", model: "Pixel 8" };
/** One of this phone's download rows, in the shape `installReportFrom` reads. */
const row = (over = {}) => ({
  id: "l_1",
  name: "app-debug.apk",
  repo: "Tiptoi",
  pkg: "de.hoh.tiptoi",
  label: "Tiptoi",
  version: "0.1.98",
  code: 98,
  install: "installed",
  installedAt: 1_700_000_000_000,
  installAuto: true,
  ...over,
});
const report = (over = {}) => ({
  pullId: "l_1",
  pkg: "de.hoh.tiptoi",
  label: "Tiptoi",
  version: "0.1.98",
  code: 98,
  file: "app-debug.apk",
  repo: "Tiptoi",
  outcome: "installed",
  auto: true,
  at: 1_700_000_000_000,
  ...over,
});

test("a report becomes an entry with the host's own stamp on it", () => {
  const e = cleanInstallEntry(report(), PHONE, 1_700_000_050_000);
  assert.equal(e.pkg, "de.hoh.tiptoi");
  assert.equal(e.deviceId, "aa11bb22");
  assert.equal(e.deviceName, "Sam's phone");
  assert.equal(e.at, 1_700_000_000_000);
  assert.equal(e.reportedAt, 1_700_000_050_000);
  assert.equal(e.key, installKey("aa11bb22", "l_1", 1_700_000_000_000));
});

test("an entry that cannot say what happened is dropped, never repaired", () => {
  assert.equal(cleanInstallEntry(report({ outcome: "asked" }), PHONE, 1), null);
  assert.equal(cleanInstallEntry(report({ pkg: "" }), PHONE, 1), null);
  assert.equal(cleanInstallEntry(report({ pullId: "" }), PHONE, 1), null);
  assert.equal(cleanInstallEntry(report(), { id: "" }, 1), null);
  assert.equal(cleanInstallEntry(null, PHONE, 1), null);
});

test("a clock nobody could read stays absent — it is never rounded to now", () => {
  const e = cleanInstallEntry(report({ at: undefined }), PHONE, 500);
  assert.equal(e.at, undefined);
  assert.equal(e.reportedAt, 500);
  // …and the entry still sorts, by the only instant it has.
  assert.equal(entryAt(e), 500);
  assert.equal(cleanInstallEntry(report({ at: "yesterday" }), PHONE, 500).at, undefined);
  assert.equal(cleanInstallEntry(report({ at: -3 }), PHONE, 500).at, undefined);
});

test("an error is kept only where something actually failed", () => {
  const bad = cleanInstallEntry(report({ outcome: "failed", error: "signatures do not match" }), PHONE, 1);
  assert.equal(bad.error, "signatures do not match");
  const ok = cleanInstallEntry(report({ error: "signatures do not match" }), PHONE, 1);
  assert.equal(ok.error, undefined);
});

test("re-reporting the same install adds nothing", () => {
  const a = cleanInstallEntry(report(), PHONE, 1000);
  const first = mergeInstallLog([], [a]);
  assert.equal(first.added, 1);
  const again = mergeInstallLog(first.entries, [cleanInstallEntry(report(), PHONE, 9999)]);
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.entries.length, 1);
  // The moment the host FIRST heard about it survives the re-report — else a
  // week-old install reads as having happened at the last handshake.
  assert.equal(again.entries[0].reportedAt, 1000);
});

test("a repeat may fill in what was missing, and may never blank what was there", () => {
  const thin = cleanInstallEntry(report({ label: "", version: "" }), PHONE, 1000);
  const one = mergeInstallLog([], [thin]);
  assert.equal(one.entries[0].label, undefined);
  // The phone has since read the archive and knows the app's name.
  const fat = cleanInstallEntry(report(), PHONE, 2000);
  const two = mergeInstallLog(one.entries, [fat]);
  assert.equal(two.updated, 1);
  assert.equal(two.entries[0].label, "Tiptoi");
  // And now it forgets again: the history keeps what it learnt.
  const three = mergeInstallLog(two.entries, [cleanInstallEntry(report({ label: "", version: "" }), PHONE, 3000)]);
  assert.equal(three.entries[0].label, "Tiptoi");
  assert.equal(three.entries[0].version, "0.1.98");
});

test("installing the same build twice is two entries, not one", () => {
  const a = cleanInstallEntry(report(), PHONE, 1_700_000_050_000);
  const b = cleanInstallEntry(report({ at: 1_700_000_900_000 }), PHONE, 1_700_000_950_000);
  const { entries } = mergeInstallLog([a], [b]);
  assert.equal(entries.length, 2);
  // Newest first.
  assert.equal(entries[0].at, 1_700_000_900_000);
});

test("two phones installing the same build are two entries", () => {
  const a = cleanInstallEntry(report(), PHONE, 1);
  const b = cleanInstallEntry(report(), { id: "cc33dd44", name: "the old phone" }, 1);
  const { entries } = mergeInstallLog([], [a, b]);
  assert.equal(entries.length, 2);
  assert.deepEqual(new Set(entries.map((e) => e.deviceId)), new Set(["aa11bb22", "cc33dd44"]));
});

test("the log is capped, oldest first", () => {
  const base = 1_700_000_000_000;
  const many = [];
  for (let i = 0; i < 10; i++) {
    many.push(cleanInstallEntry(report({ pullId: `l_${i}`, at: base + i }), PHONE, base + 1000 + i));
  }
  const { entries } = mergeInstallLog([], many, 4);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((e) => e.at), [base + 9, base + 8, base + 7, base + 6]);
});

test("the devices are derived from the log, and wear their newest name", () => {
  const old = cleanInstallEntry(report({ pullId: "l_0", at: 1000 }), { id: "aa11bb22", name: "phone" }, 1);
  const recent = cleanInstallEntry(report({ pullId: "l_1", at: 2000 }), { id: "aa11bb22", name: "kitchen phone" }, 1);
  const failed = cleanInstallEntry(report({ pullId: "l_2", at: 1500, outcome: "failed" }), { id: "cc33dd44" }, 1);
  const devices = installDevices([old, recent, failed]);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].id, "aa11bb22");
  assert.equal(devices[0].name, "kitchen phone");
  assert.equal(devices[0].installs, 2);
  assert.equal(devices[0].failures, 0);
  assert.equal(devices[1].failures, 1);
  assert.equal(devices[1].installs, 0);
});

test("a device nobody named is still called something a person can read", () => {
  assert.equal(deviceLabel({ id: "aa11bb22cc", name: "kitchen phone", model: "Pixel 8" }), "kitchen phone");
  assert.equal(deviceLabel({ id: "aa11bb22cc", model: "Pixel 8" }), "Pixel 8");
  assert.equal(deviceLabel({ id: "aa11bb22cc" }), "device aa11bb");
});

test("the title is the app and its version, never the package", () => {
  const e = cleanInstallEntry(report(), PHONE, 1);
  assert.equal(installTitle(e), "Tiptoi 0.1.98");
  assert.equal(installTitle({ ...e, label: undefined }), "de.hoh.tiptoi 0.1.98");
  assert.equal(installTitle({ ...e, version: undefined }), "Tiptoi");
});

test("the line says when honestly, and whether anybody tapped", () => {
  const fmt = (ms) => `t${ms}`;
  const timed = cleanInstallEntry(report(), PHONE, 1_700_000_050_000);
  assert.match(installLogLine(timed, fmt), /^installed by itself on Sam's phone · t1700000000000$/);
  const untimed = cleanInstallEntry(report({ at: undefined, auto: false }), PHONE, 5);
  assert.match(installLogLine(untimed, fmt), /^installed on a tap on Sam's phone · reported t5$/);
  const bad = cleanInstallEntry(report({ outcome: "failed", error: "no space" }), PHONE, 1_700_000_050_000);
  assert.match(installLogLine(bad, fmt), /failed to install by itself .* — no space$/);
});

test("a shell that never recorded who asked makes no claim about a person", () => {
  // The old shell's rows: `install` is there, `installAuto` is not.
  const e = cleanInstallEntry(report({ auto: undefined }), PHONE, 5);
  assert.equal(e.auto, undefined);
  const line = installLogLine(e, () => "T");
  assert.match(line, /^installed on Sam's phone/);
  assert.doesNotMatch(line, /on a tap|by itself/);
  // …and `installReportFrom` carries the absence rather than flattening it.
  assert.equal(installReportFrom([row({ installAuto: undefined })])[0].auto, undefined);
  assert.equal(installReportFrom([row({ installAuto: false })])[0].auto, false);
  // A non-boolean is not an answer either.
  assert.equal(cleanInstallEntry(report({ auto: "yes" }), PHONE, 5).auto, undefined);
});

test("an `at` after the moment the host was told is not a clock", () => {
  // An install is reported AFTER it happens, so this is provably wrong — a
  // phone whose clock is a year fast, or a field in the wrong unit.
  const far = cleanInstallEntry(report({ at: 2_000_000_000_000 }), PHONE, 1_700_000_000_000);
  assert.equal(far.at, undefined);
  assert.match(installLogLine(far, () => "T"), /reported T/);
  // Ordinary skew between two devices survives.
  const skew = cleanInstallEntry(report({ at: 1_700_000_060_000 }), PHONE, 1_700_000_000_000);
  assert.equal(skew.at, 1_700_000_060_000);
});

test("a key cannot be made to name another device's row", () => {
  const a = cleanInstallEntry(report({ pullId: "c" }), { id: "a:b" }, 1);
  const b = cleanInstallEntry(report({ pullId: "b:c" }), { id: "a" }, 1);
  assert.notEqual(a.key, b.key);
  const { entries } = mergeInstallLog([], [a, b]);
  assert.equal(entries.length, 2);
});

test("the cap is spent on the HOST's clock, so a fast phone cannot evict a slow one", () => {
  // Phone B's clock is a year ahead. Under an `at`-ordered cut every B row
  // outranks every A row and A's real history is what ages out.
  const now = 1_700_000_000_000;
  const mk = (id, pullId, at, told) =>
    cleanInstallEntry({ ...report(), pullId, at }, { id }, told);
  const older = [];
  for (let i = 0; i < 3; i++) older.push(mk("aaaa", `a_${i}`, now - 10_000 + i, now - 5_000 + i));
  // B reports later (bigger reportedAt) but its `at` is refused as being in the
  // future, so it falls back to reportedAt — still the host's number.
  const newer = [];
  for (let i = 0; i < 3; i++) newer.push(mk("bbbb", `b_${i}`, now + 9e10, now + i));
  const { entries } = mergeInstallLog(older, newer, 4);
  assert.equal(entries.length, 4);
  // The newest by the HOST's clock survive, and A is not wiped out.
  assert.ok(entries.some((e) => e.deviceId === "aaaa"), "the slower phone keeps a row");
});

test("a loud phone cannot push a quiet one out of the log", () => {
  const now = 1_700_000_000_000;
  const rows = [];
  // Every one of these is newer than the quiet phone's only install.
  for (let i = 0; i < 20; i++) {
    rows.push(cleanInstallEntry({ ...report(), pullId: `loud_${i}`, at: undefined }, { id: "loud" }, now + i));
  }
  rows.push(cleanInstallEntry({ ...report(), pullId: "quiet", at: undefined }, { id: "quiet" }, now - 1e6));
  const { entries } = mergeInstallLog([], rows, 10);
  assert.equal(entries.length, 10);
  assert.ok(entries.some((e) => e.deviceId === "quiet"), "the quiet phone keeps its row");
  assert.equal(entries.filter((e) => e.deviceId === "loud").length, 9);
});

test("one phone on its own still gets the whole cap", () => {
  const now = 1_700_000_000_000;
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(cleanInstallEntry({ ...report(), pullId: `l_${i}`, at: undefined }, { id: "only" }, now + i));
  }
  const { entries } = mergeInstallLog([], rows, 10);
  assert.equal(entries.length, 10);
});

test("a failure's words never travel onto an outcome that is not a failure", () => {
  // The old-shell case: no `at`, so a retry folds onto the same key.
  const failed = cleanInstallEntry(report({ at: undefined, outcome: "failed", error: "no space" }), PHONE, 1000);
  const one = mergeInstallLog([], [failed]);
  assert.equal(one.entries[0].error, "no space");
  const worked = cleanInstallEntry(report({ at: undefined }), PHONE, 2000);
  const two = mergeInstallLog(one.entries, [worked]);
  assert.equal(two.entries[0].outcome, "installed");
  assert.equal(two.entries[0].error, undefined);
});

test("a build number of zero is not a build, on either path", () => {
  assert.equal(cleanInstallEntry(report({ code: 0 }), PHONE, 1).code, undefined);
  assert.equal(installReportFrom([row({ code: 0 })])[0].code, undefined);
  assert.equal(installReportFrom([row({ code: 98 })])[0].code, 98);
});

test("the summary counts devices, because one phone is not the case this exists for", () => {
  assert.match(installLogSummary({ entries: [], devices: [], total: 0 }), /Nothing has installed itself yet/);
  const a = cleanInstallEntry(report(), PHONE, 1);
  const b = cleanInstallEntry(report({ pullId: "l_2", outcome: "failed" }), { id: "cc33dd44" }, 1);
  const entries = [a, b];
  const doc = { entries, devices: installDevices(entries), total: 2 };
  assert.match(installLogSummary(doc), /^2 installs on 2 devices · 1 failed\.$/);
  const one = { entries: [a], devices: installDevices([a]), total: 1 };
  assert.match(installLogSummary(one), /^1 install on 1 device\.$/);
});

test("the log cuts to one device or one app", () => {
  const a = cleanInstallEntry(report(), PHONE, 1);
  const b = cleanInstallEntry(report({ pullId: "l_2", pkg: "de.hoh.talkingpictures" }), PHONE, 1);
  const c = cleanInstallEntry(report({ pullId: "l_3" }), { id: "cc33dd44" }, 1);
  const all = [a, b, c];
  assert.equal(filterInstallLog(all, { deviceId: "aa11bb22" }).length, 2);
  assert.equal(filterInstallLog(all, { pkg: "de.hoh.tiptoi" }).length, 2);
  assert.equal(filterInstallLog(all, { deviceId: "aa11bb22", pkg: "de.hoh.tiptoi" }).length, 1);
  assert.equal(filterInstallLog(all, {}).length, 3);
});

// ── what a phone reports ─────────────────────────────────────────────

test("only a terminal outcome is reported — waiting for a tap is not an install", () => {
  assert.equal(installReportFrom([row({ install: "asked" })]).length, 0);
  assert.equal(installReportFrom([row({ install: "installing" })]).length, 0);
  assert.equal(installReportFrom([row({ install: "" })]).length, 0);
  assert.equal(installReportFrom([row()]).length, 1);
  assert.equal(installReportFrom([row({ install: "failed", installError: "no space" })])[0].error, "no space");
});

test("a row that cannot say which app is not reported", () => {
  assert.equal(installReportFrom([row({ pkg: "" })]).length, 0);
  assert.equal(installReportFrom([row({ id: "" })]).length, 0);
});

test("a report carries what the phone knows and nothing it does not", () => {
  const [e] = installReportFrom([row()]);
  assert.deepEqual(e, {
    pullId: "l_1",
    pkg: "de.hoh.tiptoi",
    outcome: "installed",
    auto: true,
    label: "Tiptoi",
    version: "0.1.98",
    code: 98,
    file: "app-debug.apk",
    repo: "Tiptoi",
    at: 1_700_000_000_000,
  });
  // A shell too old to stamp the install sends neither `at` nor `auto` — and
  // `auto: false` would be the positive claim that somebody tapped.
  const [old] = installReportFrom([row({ installedAt: 0, installAuto: undefined })]);
  assert.equal(old.at, undefined);
  assert.equal(old.auto, undefined);
});
