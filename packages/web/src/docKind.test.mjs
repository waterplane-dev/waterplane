/**
 * What a tapped notification does, pinned to the extension it is about.
 *
 * `docKind.ts` is pure (no DOM, no imports at all), so `node --test` runs it
 * straight over the TypeScript and `npm run test:unit` discovers it.
 *
 *     node --test packages/web/src/docKind.test.mjs
 *
 * The cases that matter are the two ways the feed can be wrong: a report the
 * app can paint that gets downloaded instead (the original complaint — three
 * steps and another app to read six kilobytes of markdown), and an APK that
 * opens a viewer which can only say it cannot render it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isAudio, isHtml, isImage, isImageKind, isMarkdown, isPdf, isRich, isText, isVideo, viewerHandles } from "./docKind.ts";

test("markdown is text, and text is what the viewer paints", () => {
  for (const p of [".claude/outbox/claudemd.md", "REPORT.MARKDOWN", "notes.mdx"]) {
    assert.equal(isMarkdown(p), true, p);
    assert.equal(isText(p), true, p);
    assert.equal(viewerHandles(p), true, p);
  }
  for (const p of ["run.log", "data.csv", "cfg.yaml", "patch.diff", "index.html", "x.json"]) {
    assert.equal(isMarkdown(p), false, p);
    assert.equal(isText(p), true, p);
  }
});

test("a deliverable with no reader is a download, not an empty viewer", () => {
  for (const p of [".claude/outbox/app.apk", "dist.zip", "core.bin", "font.woff2"]) {
    assert.equal(viewerHandles(p), false, p);
  }
});

test("pictures, video, audio and PDFs all open in place", () => {
  assert.equal(isImage("shot.PNG"), true);
  assert.equal(isVideo("clip.mov"), true);
  assert.equal(isImageKind("clip.mov"), true, "the host's image kind includes video");
  assert.equal(isImageKind("shot.png"), true);
  assert.equal(isAudio("memo.m4a"), true);
  assert.equal(isPdf("spec.pdf"), true);
  for (const p of ["shot.png", "clip.mov", "memo.m4a", "spec.pdf"]) assert.equal(viewerHandles(p), true, p);
});

test("the extension is the last one, and case never decides", () => {
  assert.equal(isText("notes.md.apk"), false, "an .apk named like a doc is still an .apk");
  assert.equal(viewerHandles("notes.md.apk"), false);
  assert.equal(isText("REPORT.MD"), true);
  assert.equal(isImage("photo.JPEG"), true);
});

test("an HTML deliverable is a page to look at, and is offered as source too", () => {
  for (const p of [".claude/outbox/daimler-deck.html", "REPORT.HTM", "a/b/index.html"]) {
    assert.equal(isHtml(p), true, p);
    assert.equal(isRich(p), true, p);
    assert.equal(isText(p), true, p);
    assert.equal(viewerHandles(p), true, p);
  }
  // `isRich` is the toggle's list, not "anything textual": a log has no second
  // reading, and offering one would be a button that changes nothing.
  for (const p of ["run.log", "data.csv", "cfg.yaml"]) assert.equal(isRich(p), false, p);
  assert.equal(isRich("claudemd.md"), true, "markdown keeps the toggle it had");
  assert.equal(isHtml("notes.html.apk"), false, "the extension is the last one");
});
