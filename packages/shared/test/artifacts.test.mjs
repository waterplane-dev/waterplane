// What a build leaves behind, and what it is called (`shared/src/artifacts.ts`).
//
// Every case here is a real artifact from a real repo on this desktop. The
// failure they pin is one a screenshot cannot show: three repos that each
// produce a file called exactly `app-debug.apk`, a 227 MB APK detected twice
// under two names and fetched twice, and an outbox nothing ever removed
// anything from. Both directions are expensive — name too little and the
// download list is unreadable, prune too eagerly and the APK you were about to
// install is gone.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ARTIFACT_POLICY, artifactName, artifactPolicyText, cleanArtifactPolicy, familyKey,
  foldDuplicates, hasVersionToken, inOutbox, pruneVictims,
} from "../dist/artifacts.js";

const when = new Date(2026, 8, 22, 10, 42);

test("a nameless build output is named after the repo, the variant and the version", () => {
  assert.equal(
    artifactName({ repoName: "picture-app", stem: "app-debug", ext: ".apk", version: "1.1.0+344", sha: "4a8c74a8", when }),
    "picture-app-debug-1.1.0+344-4a8c74a8.apk",
    "the repo names the app, `app` is what a build system calls its module and says nothing",
  );
  assert.equal(
    artifactName({ repoName: "Tiptoi", stem: "app-release", ext: ".apk", version: "1.2+34", when }),
    "Tiptoi-release-1.2+34.apk",
    "no sha to offer ⇒ the version alone, not a padded 'unknown'",
  );
  assert.equal(
    artifactName({ repoName: "todolist", stem: "app-debug", ext: ".apk", when }),
    "todolist-debug-0922-1042.apk",
    "neither a version nor a sha ⇒ the clock, because a name with no identifier at all is the bug",
  );
});

test("a name that already says which build it is, is kept", () => {
  // Flutter's own output and a timestamped bundle are better than anything the
  // rule would invent, and renaming them breaks the link between what the build
  // printed and what arrived on the phone.
  assert.equal(
    artifactName({ repoName: "picture-app", stem: "picture-app-debug-v1.1.0-344", ext: ".apk", version: "1.1.0+345", sha: "dead1234", when }),
    "picture-app-debug-v1.1.0-344.apk",
  );
  assert.equal(
    artifactName({ repoName: "FeedbackPlatform", stem: "fp-functions-bundle-20260922-1042", ext: ".tgz", when }),
    "FeedbackPlatform-fp-functions-bundle-20260922-1042.tgz",
    "kept verbatim, but the repo still leads — 'which app' is the half a timestamp can never supply",
  );
  assert.ok(hasVersionToken("app-1.1.0"), "a dotted version is a version");
  assert.ok(!hasVersionToken("app-debug"), "two ordinary words are not");
});

test("two repos' identical outputs stop being the same file name", () => {
  const a = artifactName({ repoName: "Tiptoi", stem: "app-debug", ext: ".apk", sha: "aaaa1111", when });
  const b = artifactName({ repoName: "todolist", stem: "app-debug", ext: ".apk", sha: "bbbb2222", when });
  assert.notEqual(a, b);
  assert.ok(a.startsWith("Tiptoi-") && b.startsWith("todolist-"));
});

test("the same bytes under two names are folded to the better name", () => {
  const files = [
    { relPath: "build/app/outputs/flutter-apk/app-debug.apk", size: 227341116, fingerprint: "abc" },
    { relPath: "picture-app-debug-v1.1.0-344.apk", size: 227341116, fingerprint: "abc" },
    { relPath: "build/app/outputs/flutter-apk/app-release.apk", size: 130433707, fingerprint: "def" },
  ];
  const { kept, folded } = foldDuplicates(files);
  assert.deepEqual(kept.map((k) => k.relPath), ["picture-app-debug-v1.1.0-344.apk", "build/app/outputs/flutter-apk/app-release.apk"]);
  assert.equal(folded.length, 1, "one fold, reported so the build log can say it");
  assert.equal(folded[0].dropped[0].relPath, "build/app/outputs/flutter-apk/app-debug.apk");
});

test("identity is the fingerprint, never the size alone", () => {
  // Two ABI splits of one app are within bytes of each other; folding them
  // would silently drop a release.
  const { kept } = foldDuplicates([
    { relPath: "out/app-arm64.apk", size: 1000, fingerprint: "one" },
    { relPath: "out/app-x86.apk", size: 1000, fingerprint: "two" },
  ]);
  assert.equal(kept.length, 2);
  // And a file that could not be read is never folded with anything.
  const unread = foldDuplicates([
    { relPath: "out/a.apk", size: 10 },
    { relPath: "out/b.apk", size: 10 },
  ]);
  assert.equal(unread.kept.length, 2);
  assert.equal(unread.folded.length, 0);
});

test("a prune only ever touches older builds of what was just produced", () => {
  const t = (mins) => Date.UTC(2026, 8, 22, 10, 42) - mins * 60_000;
  const files = [
    { relPath: ".claude/outbox/picture-app-debug-1.1.0+344.apk", mtime: t(0) },
    { relPath: ".claude/outbox/picture-app-debug-1.1.0+343.apk", mtime: t(60) },
    { relPath: ".claude/outbox/picture-app-debug-1.1.0+342.apk", mtime: t(120) },
    { relPath: ".claude/outbox/picture-app-debug-1.1.0+341.apk", mtime: t(180) },
    { relPath: ".claude/outbox/picture-app-release-1.1.0+340.apk", mtime: t(240) },
    { relPath: ".claude/outbox/screenshot.png", mtime: t(300) },
    { relPath: ".claude/outbox/report.md", mtime: t(9000) },
  ];
  const victims = pruneVictims(files, [".claude/outbox/picture-app-debug-1.1.0+344.apk"], 3);
  assert.deepEqual(victims.map((v) => v.relPath), [".claude/outbox/picture-app-debug-1.1.0+341.apk"],
    "the newest three of THAT family survive; a sibling release, a screenshot and a report are not this run's business");
});

test("a run's own output is never a victim of its own prune", () => {
  const files = [
    { relPath: ".claude/outbox/app-a.apk", mtime: 5 },
    { relPath: ".claude/outbox/app-b.apk", mtime: 5 },
    { relPath: ".claude/outbox/app-c.apk", mtime: 5 },
  ];
  // All one family, all the same second — which is exactly what a build writing
  // three files at once looks like.
  const victims = pruneVictims(files, files.map((f) => f.relPath), 1);
  assert.deepEqual(victims, [], "equal mtimes are not evidence one replaces another, and none of them is older than itself");
});

test("the policy defaults are on, and an unreadable field falls back to the default not to off", () => {
  assert.deepEqual(DEFAULT_ARTIFACT_POLICY, { collect: true, prune: true, keep: 3 });
  assert.deepEqual(cleanArtifactPolicy({}), DEFAULT_ARTIFACT_POLICY, "a policy nobody can parse must not silently turn the feature off");
  assert.deepEqual(cleanArtifactPolicy({ collect: false, prune: true, keep: 0 }), { collect: false, prune: true, keep: 3 });
  assert.equal(cleanArtifactPolicy({ keep: 5000 }).keep, 50, "a fat-fingered number is capped, not obeyed");
  assert.match(artifactPolicyText({ collect: true, prune: true, keep: 3 }), /newest 3/);
  assert.match(artifactPolicyText({ collect: false, prune: true, keep: 3 }), /exactly where they land/);
});

test("the outbox test knows both spellings and nothing else", () => {
  assert.ok(inOutbox(".claude/outbox/app.apk"));
  assert.ok(inOutbox(".outbox/app.apk"));
  assert.ok(!inOutbox("build/outputs/app.apk"));
  assert.ok(!inOutbox("outboxes/app.apk"));
});

test("familyKey still answers the questions the download queue asks it", () => {
  // It moved here from the host so the prune and the queue cannot disagree; the
  // rules themselves are unchanged and `host/test/autopull.test.mjs` pins them
  // in full.
  assert.equal(familyKey(".claude/outbox/picture-app-1.1.0+343.apk"), familyKey(".claude/outbox/picture-app-1.1.0+344.apk"));
  assert.notEqual(familyKey(".claude/outbox/app-debug.apk"), familyKey(".claude/outbox/app-release.apk"));
});
