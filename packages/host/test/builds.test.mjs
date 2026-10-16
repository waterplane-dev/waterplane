/**
 * `detectArtifacts`'s stale fallback: what a build that produced no
 * `BUILD_ART_EXT` file gets told it did.
 *
 * The fallback exists so an incremental gradle build ("BUILD SUCCESSFUL, 50
 * up-to-date") does not read as "the build produced nothing" — it hands back
 * the newest matching binaries already on disk, flagged `stale`. But it used
 * to fire on ANY empty `out`, including a web build that rewrote `dist` with
 * fifteen `.js`/`.css`/`.html` files: none of those match `BUILD_ART_EXT`, so
 * `out` stayed empty and the fallback handed back an unrelated week-old APK
 * labelled "unchanged by this run (already up to date)" — a false claim about
 * a run that had just written real output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { detectArtifacts } = await import("../dist/builds.js");

function repo() {
  return mkdtempSync(join(tmpdir(), "waterplane-builds-"));
}

test("a run that rewrites an output dir with no packaged binary reports nothing, not a stale unrelated one", () => {
  const dir = repo();
  try {
    // An old APK, well before the run — dirs backdated along with the file,
    // same reasoning as the sibling test below.
    const outDir = join(dir, "app", "build", "outputs", "apk");
    mkdirSync(outDir, { recursive: true });
    const apk = join(outDir, "app-debug.apk");
    writeFileSync(apk, "apk bytes");
    const oldMs = Date.now() - 7 * 24 * 3600_000;
    for (const p of [apk, join(dir, "app", "build", "outputs"), join(dir, "app", "build")]) {
      utimesSync(p, oldMs / 1000, oldMs / 1000);
    }

    // The run under test starts after that, and only touches `dist` — a web
    // build, writing files whose extensions are not `BUILD_ART_EXT`.
    const sinceMs = Date.now();
    const dist = join(dir, "web", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html></html>");
    writeFileSync(join(dist, "app.js"), "console.log(1)");

    const found = detectArtifacts(dir, dir, sinceMs);
    assert.deepEqual(found, [], "no artifact, and no stale one substituted for it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run that touches nothing at all still falls back to the newest stale binary", () => {
  const dir = repo();
  try {
    const outDir = join(dir, "app", "build", "outputs", "apk");
    mkdirSync(outDir, { recursive: true });
    const apk = join(outDir, "app-debug.apk");
    writeFileSync(apk, "apk bytes");
    // Backdate the apk AND the `build`/`outputs` dirs it sits under — those
    // are the two path segments `ART_DIRS` matches, and in real use they
    // carry the mtime of whenever this repo last built the app, same as the
    // file. Only backdating the file would leave the dirs looking "just
    // touched" purely because the test itself just created them.
    const oldMs = Date.now() - 7 * 24 * 3600_000;
    for (const p of [apk, join(dir, "app", "build", "outputs"), join(dir, "app", "build")]) {
      utimesSync(p, oldMs / 1000, oldMs / 1000);
    }

    // sinceMs AFTER the apk's mtime, and nothing under the tree changes.
    const found = detectArtifacts(dir, dir, Date.now());
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "app-debug.apk");
    assert.equal(found[0].stale, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run that produces a real packaged binary is unaffected", () => {
  const dir = repo();
  try {
    const outDir = join(dir, "app", "build", "outputs", "apk");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "app-debug.apk"), "fresh apk bytes");

    const found = detectArtifacts(dir, dir, Date.now() - 1000);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "app-debug.apk");
    assert.equal(found[0].stale, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gradle's scratch jars and the checked-in wrapper are never offered as a run's output", () => {
  const dir = repo();
  try {
    const wrap = join(dir, "gradle", "wrapper");
    const inter = join(dir, "app", "build", "intermediates", "r_class_jar", "debug");
    mkdirSync(wrap, { recursive: true });
    mkdirSync(inter, { recursive: true });
    writeFileSync(join(wrap, "gradle-wrapper.jar"), "wrapper");
    writeFileSync(join(inter, "R.jar"), "r classes");
    const oldMs = Date.now() - 7 * 24 * 3600_000;
    for (const p of [join(wrap, "gradle-wrapper.jar"), join(inter, "R.jar"), join(dir, "app", "build")]) {
      utimesSync(p, oldMs / 1000, oldMs / 1000);
    }
    assert.deepEqual(detectArtifacts(dir, dir, Date.now()), [], "stale fallback offers neither");
    writeFileSync(join(inter, "R.jar"), "fresh r classes");
    writeFileSync(join(wrap, "gradle-wrapper.jar"), "fresh wrapper");
    assert.deepEqual(detectArtifacts(dir, dir, Date.now() - 5000).map((a) => a.name), [], "nor a freshly written one");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale fallback never reaches outside the build's own dir, nor into .claude/", () => {
  const dir = repo();
  try {
    const oldMs = Date.now() - 3 * 24 * 3600_000;
    // Three APKs another build collected into the outbox, days ago.
    const outbox = join(dir, ".claude", "outbox");
    mkdirSync(outbox, { recursive: true });
    const apk = join(outbox, "waterplane-dev-debug.apk");
    writeFileSync(apk, "apk bytes");
    // And one at the repo's own app module, also untouched.
    const appOut = join(dir, "app", "build", "outputs");
    mkdirSync(appOut, { recursive: true });
    const appApk = join(appOut, "app-debug.apk");
    writeFileSync(appApk, "apk bytes");
    const ext = join(dir, "packages", "vscode");
    mkdirSync(ext, { recursive: true });
    for (const p of [apk, outbox, join(dir, ".claude"), appApk, appOut, join(dir, "app", "build"), join(dir, "app")]) {
      utimesSync(p, oldMs / 1000, oldMs / 1000);
    }
    // A run in packages/vscode that wrote nothing: none of those is its output.
    assert.deepEqual(detectArtifacts(dir, dir, Date.now(), ext), [], "nothing from elsewhere in the repo");
    // A repo-root build still gets its own untouched APK — but not the outbox's.
    assert.deepEqual(detectArtifacts(dir, dir, Date.now(), dir).map((a) => a.name), ["app-debug.apk"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a freshly packaged VS Code extension is the run's artifact", () => {
  const dir = repo();
  try {
    const ext = join(dir, "packages", "vscode");
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "waterplane-0.1.0.vsix"), "vsix bytes");
    const found = detectArtifacts(dir, dir, Date.now() - 1000, ext);
    assert.deepEqual(found.map((a) => [a.name, !!a.stale]), [["waterplane-0.1.0.vsix", false]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
