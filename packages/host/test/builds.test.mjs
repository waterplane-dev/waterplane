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
