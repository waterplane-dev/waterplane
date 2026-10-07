/**
 * The images feature's pure half: where an annotated picture is parked and
 * where closing the annotator returns to, the strip's merge/trim/drop, the
 * re-mark swap, and the gallery's cuts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  NEWIMG_CAP, annReturnOverlay, dropStrip, findInStrips, galleryCtxForFile, isViewable, isVideoPath, markedRef,
  mergeNewImages, ocrBlock, outboxCut, parkLane, swapImageRef, trimNewImages,
} from "./logic.ts";

const im = (relPath, extra = {}) => ({ name: relPath.split("/").pop(), relPath, mtime: 1, ...extra });

test("a picture is parked in the lane its path will be SENT from", () => {
  assert.equal(parkLane("session", "/r", "s1"), "s1");
  assert.equal(parkLane("session", "/r", null), "/r");
  assert.equal(parkLane("send", "/r", "s1", "/w"), "create:/w");
  assert.equal(parkLane("send", "/r", "s1", null), "create:/r");
  assert.equal(parkLane("pad", "/r", "s1", "/w", "/p"), "create:/p");
  assert.equal(parkLane("backlog-item", "/r", "s1"), "/r");
});

test("closing the annotator puts back the sheet it replaced", () => {
  assert.equal(annReturnOverlay("backlog-item", false), "backlog");
  assert.equal(annReturnOverlay("send", true), "send");
  assert.equal(annReturnOverlay("send", false), null);
  assert.equal(annReturnOverlay("pad", false), "pad");
  assert.equal(annReturnOverlay("session", true), null);
});

test("re-marking swaps the path AND its old note, nested parentheses included", () => {
  const t = "fix a.png (marked: 1 box top-left (x 12%, y 8%)) please";
  assert.equal(swapImageRef(t, "a.png", "b.png (marked: 2)"), "fix b.png (marked: 2) please");
  assert.equal(swapImageRef("no ref here", "a.png", "b.png"), "no ref here b.png");
  assert.equal(markedRef("x.png"), "x.png");
  assert.equal(markedRef("x.png", "1 box"), "x.png (marked: 1 box)");
});

test("the strip merges by path, keeps arrival order, and tags the repo", () => {
  const a = mergeNewImages(new Map(), "s", "r1", [im("o/a.png"), im("o/b.png")]);
  const b = mergeNewImages(a, "s", "r1", [im("o/b.png"), im("o/c.png")]);
  assert.deepEqual(b.get("s").map((x) => x.relPath), ["o/a.png", "o/b.png", "o/c.png"]);
  assert.equal(b.get("s")[0].repoId, "r1");
  assert.notEqual(a, b);
});

test("dropping a session with no strip returns the same map (no emit)", () => {
  const m = new Map([["s", [im("a.png", { repoId: "r" })]]]);
  assert.equal(dropStrip(m, "nope"), m);
  assert.equal(dropStrip(m, "s").has("s"), false);
});

test("the persisted strip drops empties and keeps the newest CAP", () => {
  const many = Array.from({ length: NEWIMG_CAP + 5 }, (_, i) => im(`o/${i}.png`, { repoId: "r" }));
  const out = trimNewImages(new Map([["a", many], ["b", []]]));
  assert.deepEqual(Object.keys(out), ["a"]);
  assert.equal(out.a.length, NEWIMG_CAP);
  assert.equal(out.a[0].relPath, "o/5.png");
});

test("a notification's picture opens at its place in a strip, preferring the named session", () => {
  const strips = new Map([
    ["s1", [im("o/x.png", { repoId: "r" })]],
    ["s2", [im("o/y.png", { repoId: "r" }), im("o/x.png", { repoId: "r" })]],
  ]);
  assert.deepEqual(findInStrips(strips, { repoId: "r", relPath: "o/x.png" }), { sessionId: "s1", i: 0 });
  assert.deepEqual(findInStrips(strips, { repoId: "r", relPath: "o/x.png" }, "s2"), { sessionId: "s2", i: 1 });
  assert.equal(findInStrips(strips, { repoId: "other", relPath: "o/x.png" }), null);
});

test("viewable is pictures and videos; everything else is a download", () => {
  assert.equal(isViewable("a/b.PNG"), true);
  assert.equal(isViewable("a/b.mov"), true);
  assert.equal(isVideoPath("a/b.mov"), true);
  assert.equal(isViewable("a/b.zip"), false);
});

test("a file opens the gallery all-time on its outbox, named by basename when unnamed", () => {
  const c = galleryCtxForFile({ repoId: "r", relPath: ".claude/outbox/shot.png" }, "notifications");
  assert.equal(c.scope, "outbox");
  assert.equal(c.allTime, true);
  assert.equal(c.returnTo, "notifications");
  assert.equal(c.openFile.name, "shot.png");
});

test("the outbox badge's cut is its own edge and number, absent when nothing is counted", () => {
  assert.deepEqual(outboxCut({ outboxSeenAt: 5, outboxCount: 3 }), { since: 5, count: 3 });
  assert.equal(outboxCut({ outboxSeenAt: 5, outboxCount: 0 }), undefined);
  assert.equal(outboxCut({ outboxCount: 3 }), undefined);
  assert.equal(outboxCut(undefined), undefined);
});

test("text read off a photo goes in fenced and labelled, a fence inside it is out-fenced", () => {
  const b = ocrBlock("  Error: boom\nat x  ");
  assert.match(b, /^Text read off a photo .*not sent/);
  assert.ok(b.includes("\n```\nError: boom\nat x\n```\n"));
  const nested = ocrBlock("see ```js\ncode\n```");
  assert.ok(nested.includes("\n````\nsee ```js"));
});
