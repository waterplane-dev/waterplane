/**
 * `familyKey` — "which artifact IS this", independent of which BUILD of it.
 *
 * The rule decides whether a new file SUPERSEDES one already queued, so both
 * directions are expensive and neither is visible: fold too little and the phone
 * re-fetches 130 MB per build and keeps the old one beside it; fold too much and
 * one artifact silently deletes a sibling that a build legitimately produced.
 * Every case below is a real artifact name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { catchUpCandidates, familyKey } from "../dist/autopull.js";

const out = (name) => familyKey(`.claude/outbox/${name}`);
const same = (a, b, why) => assert.equal(out(a), out(b), why);
const apart = (a, b, why) => assert.notEqual(out(a), out(b), why);

test("a version and a build number are the same artifact, whatever joins them", () => {
  // `+` is semver's build metadata and what Flutter/pub and a Gradle
  // `versionName+versionCode` write. It used to leave `0+343` as one token,
  // which reads as a stable WORD — so every build was its own family and
  // nothing ever superseded anything.
  same("picture-app-1.1.0+343.apk", "picture-app-1.1.0+344.apk", "a new build of the same version");
  same("picture-app-1.1.0+343.apk", "picture-app-1.2.0+350.apk", "a new version of the same app");
  same("app-1.1.0.apk", "app-2.0.1.apk", "the plain dotted version, which always worked");
  same("app-v2.apk", "app-v3.apk", "a bare `v2`");
  same("myapp-2026.09.21.apk", "myapp-2026.09.22.apk", "a date in the name");
  same("tiptoi-debug-0f98c1ab.apk", "tiptoi-debug-39a2f7e1.apk", "a commit hash");
});

test("two artifacts a build really does produce both of stay apart", () => {
  apart("app-debug.apk", "app-release.apk", "debug and release are two files, not two builds of one");
  apart("app-1.0.0-arm64.apk", "app-1.0.0-x86.apk", "an ABI split — neither may delete the other");
  apart("app.apk", "app.aab", "the extension is part of the key");
  apart("report.md", "notes.md", "different reports");
  assert.notEqual(familyKey("docs/report.md"), familyKey("out/report.md"), "the directory is part of the key");
});

test("a word that merely looks like a hash is a word", () => {
  same("facade-1.zip", "facade-2.zip", "`facade` is hex-only but has no digit, so it stays stable");
  apart("facade.zip", "decade.zip", "…and two such words are still two artifacts");
});

test("when every token is variable the key falls back to the exact path", () => {
  // A camera roll: `1000074170.jpg` has no stable word left to compare, and two
  // differently-named photos must never supersede each other.
  apart("1000074170.jpg", "1000074171.jpg", "two photos");
  same("1000074170.jpg", "1000074170.jpg", "a regeneration at the same path still supersedes");
});

test("the uniquifier files.ts appends is not a second artifact", () => {
  same("build_2.apk", "build.apk", "`_2` is what keeps a name unique on disk");
});

/**
 * `catchUpCandidates` — what a rule that was just switched ON may fetch from
 * what is already on disk.
 *
 * The miss it exists for is one minute wide: the rule for picture-app was saved
 * at 10:43 and the 227 MB APK it was saved for finished at 10:42, so no
 * detector ever saw it and the switch looked dead. The bound matters as much as
 * the catch-up — a whole-repo rule switched on must not push a year of
 * artifacts at a phone.
 */
test("the catch-up takes the newest of each family and nothing else", () => {
  const now = Date.UTC(2026, 8, 22, 10, 45);
  const f = (relPath, minsAgo) => ({ name: relPath.split("/").pop(), relPath, size: 10, mtime: now - minsAgo * 60_000 });
  const picked = catchUpCandidates([
    f("build/app/outputs/flutter-apk/app-debug.apk", 3),
    f(".claude/outbox/picture-app-1.1.0+343.apk", 60),
    f(".claude/outbox/picture-app-1.1.0+344.apk", 5),
  ], now);
  assert.deepEqual(picked.map((p) => p.name), ["app-debug.apk", "picture-app-1.1.0+344.apk"],
    "two builds of one app are one thing to fetch, and the debug APK is a second thing");
});

test("the catch-up is bounded by age and by count", () => {
  const now = Date.UTC(2026, 8, 22, 10, 45);
  const f = (name, minsAgo) => ({ name, relPath: `.claude/outbox/${name}`, size: 10, mtime: now - minsAgo * 60_000 });
  assert.deepEqual(catchUpCandidates([f("old-app.apk", 60 * 30)], now), [],
    "a day-and-a-quarter-old artifact is not what the switch was just flipped for");
  const many = [f("a.apk", 5), f("b.apk", 4), f("c.apk", 3), f("d.apk", 2), f("e.apk", 1)];
  assert.deepEqual(catchUpCandidates(many, now).map((p) => p.name), ["e.apk", "d.apk", "c.apk"],
    "newest first, three at most");
});
