// Which CACHED file listing may answer which question (`shared/src/gallery.ts`).
// The rule is strict containment, never a broadness score — images-all-time and
// everything-4h are incomparable, and a scalar rank would serve one for the other.
import test from "node:test";
import assert from "node:assert/strict";
import {
  coversQuery, filterGalleryRows, galleryCacheKey, galleryScopeKey, pickCoveringListing,
} from "../dist/index.js";

const H = 3600;

test("kind containment: all covers everything, image and doc cover only themselves", () => {
  assert.equal(coversQuery({ kind: "all" }, { kind: "image" }), true);
  assert.equal(coversQuery({ kind: "all" }, { kind: "doc" }), true);
  assert.equal(coversQuery({ kind: "image" }, { kind: "image" }), true);
  assert.equal(coversQuery({ kind: "image" }, { kind: "doc" }), false);
  assert.equal(coversQuery({ kind: "image" }, { kind: "all" }), false);
});

test("window containment: all-time covers any window, a window covers no wider one", () => {
  assert.equal(coversQuery({ kind: "all" }, { kind: "all", since: 4 * H }), true);
  assert.equal(coversQuery({ kind: "all", since: 4 * H }, { kind: "all" }), false);
  assert.equal(coversQuery({ kind: "all", since: 24 * H }, { kind: "all", since: 4 * H }), true);
  assert.equal(coversQuery({ kind: "all", since: 4 * H }, { kind: "all", since: 24 * H }), false);
  assert.equal(coversQuery({ kind: "all", since: 4 * H }, { kind: "all", since: 4 * H }), true);
});

test("the two incomparable listings never answer for each other", () => {
  const imagesAllTime = { kind: "image" };
  const everything4h = { kind: "all", since: 4 * H };
  assert.equal(coversQuery(imagesAllTime, everything4h), false);
  assert.equal(coversQuery(everything4h, imagesAllTime), false);
});

test("pickCoveringListing prefers an exact coverage, then the freshest", () => {
  const want = { kind: "image", since: 4 * H };
  const wider = { kind: "all", since: 24 * H, savedAt: 900 };
  const exact = { kind: "image", since: 4 * H, savedAt: 100 };
  assert.equal(pickCoveringListing([wider, exact], want), exact);

  const olderExact = { kind: "image", since: 4 * H, savedAt: 10 };
  const newerExact = { kind: "image", since: 4 * H, savedAt: 20 };
  assert.equal(pickCoveringListing([olderExact, newerExact], want), newerExact);

  assert.equal(pickCoveringListing([{ kind: "doc", savedAt: 1 }], want), null);
  assert.equal(pickCoveringListing([], want), null);
});

test("filterGalleryRows cuts on mtime, kind and a case-insensitive name substring", () => {
  const now = 1_000_000_000;
  const isImage = (p) => p.endsWith(".png") || p.endsWith(".mp4");
  const rows = [
    { name: "Shot.png", relPath: "out/Shot.png", mtime: now - 1000 },
    { name: "clip.mp4", relPath: "out/clip.mp4", mtime: now - 1000 },
    { name: "notes.md", relPath: "out/notes.md", mtime: now - 1000 },
    { name: "old.png", relPath: "out/old.png", mtime: now - 10 * H * 1000 },
  ];
  const names = (want) => filterGalleryRows(rows, want, isImage, now).map((r) => r.name);

  // kind=image includes video, matching the host's own rule.
  assert.deepEqual(names({ kind: "image" }), ["Shot.png", "clip.mp4", "old.png"]);
  assert.deepEqual(names({ kind: "doc" }), ["notes.md"]);
  assert.deepEqual(names({ kind: "all", since: 4 * H }), ["Shot.png", "clip.mp4", "notes.md"]);
  assert.deepEqual(names({ kind: "all", query: "SHOT" }), ["Shot.png"]);
  assert.deepEqual(names({ kind: "all", query: "   " }), rows.map((r) => r.name)); // blank ⇒ no filter
});

test("cache keys separate the tabs, and the incomparable coverages inside one", () => {
  assert.notEqual(galleryScopeKey("all", "r1", "r1,r2"), galleryScopeKey("all", "r1", "r1,r2,r3"));
  assert.notEqual(galleryScopeKey("outbox", "r1"), galleryScopeKey("inbox", "r1"));
  const k = galleryScopeKey("outbox", "r1");
  assert.notEqual(galleryCacheKey(k, { kind: "image" }), galleryCacheKey(k, { kind: "all", since: 4 * H }));
  assert.equal(galleryCacheKey(k, { kind: "all" }), galleryCacheKey(k, { kind: "all", since: undefined }));
});
