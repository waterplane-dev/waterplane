// What a repo is allowed to be told it can build (`shared/src/buildscan.ts`).
//
// This list is the free alternative to spending an agent turn on "work out how
// this project builds", and its whole claim to being trustworthy is that every
// row was read out of a file somebody already wrote in this repo. So the
// assertions below are mostly about what it must NOT say: a gradle task the
// build file gives no evidence for, a CI step carrying an unresolved `${{ }}`
// expression, a shell fragment torn out of a block scalar, `npm ci`.
//
// The other half is about the rows it must not silently swallow — a release
// script is a legitimate thing to want on a phone, so it is offered with a
// caution rather than filtered away, and a command that is already a button
// stays in the list flagged, because a suggest list that shrinks as you use it
// is one nobody can tell from a broken one.
//
// Pure: literals in, candidates out, no filesystem.
import test from "node:test";
import assert from "node:assert/strict";
import { filterCandidates, scanCandidates } from "../dist/buildscan.js";

const f = (path, text) => ({ path, text });
const cmds = (r) => r.candidates.map((c) => c.cmd);
const find = (r, cmd) => r.candidates.find((c) => c.cmd === cmd);

test("package.json scripts become npm run buttons, minus the lifecycle noise", () => {
  const r = scanCandidates([f("package.json", JSON.stringify({
    scripts: { build: "vite build", "test:unit": "node --test", postinstall: "patch", prepare: "husky" },
  }))]);
  assert.ok(cmds(r).includes("npm run build"));
  assert.ok(cmds(r).includes("npm run test:unit"));
  // `postinstall`/`prepare` exist in every scaffold and are nobody's button.
  assert.ok(!cmds(r).some((c) => c.includes("postinstall")));
  assert.ok(!cmds(r).some((c) => c.includes("prepare")));
});

test("a sub-package's script is labelled by its directory and carries the dir", () => {
  const r = scanCandidates([f("packages/web/package.json", JSON.stringify({ scripts: { build: "vite build" } }))]);
  const c = find(r, "npm run build");
  assert.equal(c.dir, "packages/web");
  // In a monorepo four packages all have `build`; the leaf dir is what tells
  // them apart on a phone-width row.
  assert.equal(c.name, "web · build");
});

test("unparseable package.json contributes nothing rather than a row saying so", () => {
  const r = scanCandidates([f("package.json", "{ not json")]);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.total, 0);
});

test("gradle: assemble/bundle only where the file applies the android plugin", () => {
  const android = scanCandidates([
    f("app/build.gradle", 'plugins { id "com.android.application" }'),
    f("app/gradlew", "#!/bin/sh"),
  ]);
  assert.ok(cmds(android).includes("./gradlew assembleRelease"));
  assert.ok(cmds(android).includes("./gradlew bundleRelease"));

  const plain = scanCandidates([f("build.gradle", 'plugins { id "java" }')]);
  // The base plugin gives `build` and `test` to every gradle project; nothing
  // in this file says `assembleRelease` exists, so it is not offered.
  assert.ok(cmds(plain).includes("gradle build"));
  assert.ok(cmds(plain).includes("gradle test"));
  assert.ok(!cmds(plain).some((c) => c.includes("assemble")));
  assert.ok(!cmds(plain).some((c) => c.includes("bundle")));
});

test("gradle: ./gradlew only where a wrapper actually sits", () => {
  const r = scanCandidates([f("build.gradle", 'plugins { id "java" }')]);
  assert.ok(cmds(r).every((c) => !c.startsWith("./gradlew")));
});

test("an android library gets assemble but not bundle", () => {
  const r = scanCandidates([f("lib/build.gradle.kts", 'plugins { id("com.android.library") }')]);
  assert.ok(cmds(r).includes("gradle assembleRelease"));
  assert.ok(!cmds(r).some((c) => c.includes("bundle")));
});

test("Makefile: real targets only, never variables or special targets", () => {
  const r = scanCandidates([f("Makefile", [
    "CC := gcc",
    "VERSION = 1.0",
    ".PHONY: all clean",
    "all: main.o",
    "\tgcc -o app main.o",
    "clean:",
    "%.o: %.c",
  ].join("\n"))]);
  assert.deepEqual(cmds(r).filter((c) => c.startsWith("make ")).sort(), ["make all", "make clean"]);
});

test("CI: single-line run steps become buttons, expressions and plumbing do not", () => {
  const r = scanCandidates([f(".github/workflows/ci.yml", [
    "jobs:",
    "  build:",
    "    steps:",
    "      - run: npm ci",
    "      - run: sudo apt-get install -y tmux",
    "      - run: npm test",
    "      - run: ./scripts/build-release.sh",
    "      - run: ./deploy.sh --token ${{ secrets.TOKEN }}",
    "      - run: |",
    "          set -e",
    "          make all",
  ].join("\n"))]);
  assert.ok(cmds(r).includes("./scripts/build-release.sh"));
  // `npm ci` is every workflow's first line and nobody's build button.
  assert.ok(!cmds(r).includes("npm ci"));
  // An unresolved workflow expression would reach OUR shell verbatim.
  assert.ok(!cmds(r).some((c) => c.includes("${{")));
  // A block scalar is a script; half of one is worse than nothing.
  assert.ok(!cmds(r).some((c) => c === "set -e" || c === "make all"));
  // `sudo` in front of the machine-setup line must not smuggle it past the filter.
  assert.ok(!cmds(r).some((c) => c.includes("apt-get")));
  // CI's `npm test` is `package.json`'s `npm run test` — one button, not two.
  assert.ok(cmds(r).includes("npm run test"));
  assert.ok(!cmds(r).includes("npm test"));
});

test("CI's `npm test` and the manifest's `test` script dedupe to one row", () => {
  const r = scanCandidates([
    f("package.json", JSON.stringify({ scripts: { test: "node --test" } })),
    f(".github/workflows/ci.yml", "      - run: npm test"),
  ]);
  assert.deepEqual(cmds(r), ["npm run test"]);
});

test("a shell script is offered as itself, titled by its own first comment", () => {
  const r = scanCandidates([f("scripts/ship-betas.sh", "#!/bin/bash\n# ship all beta apps\nset -e\n")]);
  const c = find(r, "./scripts/ship-betas.sh");
  assert.equal(c.name, "ship all beta apps");
});

test("a publishing command is offered WITH a caution, never filtered away", () => {
  const r = scanCandidates([f("scripts/ship-prod.sh", "#!/bin/bash\nfastlane deliver\n")]);
  const c = find(r, "./scripts/ship-prod.sh");
  assert.ok(c, "the release script is still in the list");
  assert.match(c.note, /nobody watching/);
  // The ordinary ones say nothing.
  const plain = scanCandidates([f("package.json", JSON.stringify({ scripts: { build: "vite build" } }))]);
  assert.equal(find(plain, "npm run build").note, undefined);
});

test("an npm script that publishes is flagged on its BODY, not just its name", () => {
  const r = scanCandidates([f("package.json", JSON.stringify({ scripts: { ship: "np --yolo" , rel: "npm publish" } }))]);
  assert.ok(find(r, "npm run rel").note, "`npm publish` in the body is what makes it outward-facing");
});

test("an already-configured command stays in the list, flagged", () => {
  const files = [f("package.json", JSON.stringify({ scripts: { build: "vite build", test: "node --test" } }))];
  const r = scanCandidates(files, [{ id: "b1", name: "Build", cmd: "npm run build" }]);
  const c = find(r, "npm run build");
  assert.equal(c.already, true, "it is still offered — a list that shrinks as you use it looks broken");
  assert.equal(find(r, "npm run test").already, undefined);
});

test("`already` matches on dir as well as command", () => {
  const files = [f("packages/web/package.json", JSON.stringify({ scripts: { build: "vite build" } }))];
  // Same command, repo root — a different build, and not this one.
  const r = scanCandidates(files, [{ id: "b1", name: "Build", cmd: "npm run build" }]);
  assert.equal(find(r, "npm run build").already, undefined);
});

test("the same command described twice is one row, and keeps its caution", () => {
  const r = scanCandidates([
    f("scripts/deploy.sh", "#!/bin/bash\n"),
    f(".github/workflows/cd.yml", "      - run: ./scripts/deploy.sh"),
  ]);
  assert.equal(cmds(r).filter((c) => c === "./scripts/deploy.sh").length, 1);
  assert.ok(find(r, "./scripts/deploy.sh").note, "the caution survives the dedupe");
});

test("things that make a downloadable file rank above checks", () => {
  const r = scanCandidates([f("app/build.gradle", 'plugins { id "com.android.application" }')]);
  const iAssemble = cmds(r).indexOf("gradle assembleRelease");
  const iTest = cmds(r).indexOf("gradle test");
  assert.ok(iAssemble < iTest, "a build button's point is the artifact at the end of it");
});

test("the list is capped but the total is told, so the UI can say what it hid", () => {
  const scripts = {};
  for (let i = 0; i < 90; i++) scripts[`task${i}`] = "echo hi";
  const r = scanCandidates([f("package.json", JSON.stringify({ scripts }))], [], 10);
  assert.equal(r.candidates.length, 10);
  assert.equal(r.total, 90);
});

test("filtering is word-wise over name, command, dir and source; empty query keeps everything", () => {
  const r = scanCandidates([
    f("app/build.gradle", 'plugins { id "com.android.application" }'),
    f("packages/web/package.json", JSON.stringify({ scripts: { build: "vite build" } })),
  ]);
  assert.equal(filterCandidates(r.candidates, "").length, r.candidates.length);
  // Order of the typed words must not matter.
  assert.deepEqual(
    filterCandidates(r.candidates, "release apk").map((c) => c.cmd),
    filterCandidates(r.candidates, "apk release").map((c) => c.cmd),
  );
  assert.deepEqual(filterCandidates(r.candidates, "release apk").map((c) => c.cmd), ["gradle assembleRelease"]);
  assert.deepEqual(filterCandidates(r.candidates, "web").map((c) => c.cmd), ["npm run build"]);
  assert.deepEqual(filterCandidates(r.candidates, "nothing here"), []);
});

test("a repo that describes nothing answers with an empty list, not a guess", () => {
  const r = scanCandidates([f("README.md", "# hi"), f("src/main.ts", "console.log(1)")]);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.total, 0);
});
