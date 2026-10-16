/**
 * Transport-dir file references, pinned without a browser.
 *
 * `fileRefs.ts` decides what piece of conversation text becomes a tappable
 * file, and both of its halves fail silently in opposite directions. Too narrow
 * and a report's own screenshots stay dead text with the pictures one tap away
 * in the gallery — the bug `bareFileRef` exists for. Too wide and an ordinary
 * source path, or a filename in a diff, turns into a thumbnail of something
 * else entirely; nothing throws, and the type-check is happy either way.
 *
 * Run over the TypeScript directly, the way the other `packages/web` tests are:
 *
 *     node --test packages/web/src/fileRefs.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bareFileRef, docImageRef, dropFileRef, linkedImages, parseFileRef, refsIn, wholeFileRef } from "./fileRefs.ts";

const OUTBOX = [
  ".claude/outbox/boulder-10-flow.gif",
  ".claude/outbox/boulder-13-highball.gif",
  ".claude/outbox/report.md",
  ".claude/inbox/1000075294-mtx9ltl9ca2e0a.png",
];

test("a written-out transport path still resolves, prefix or not", () => {
  assert.equal(parseFileRef(".claude/outbox/a.png")?.relPath, ".claude/outbox/a.png");
  assert.equal(parseFileRef("/Users/me/dev/repo/.claude/inbox/b.jpg")?.relPath, ".claude/inbox/b.jpg");
  // Trailing sentence punctuation belongs to the sentence.
  assert.equal(parseFileRef(".claude/outbox/a.md.")?.name, "a.md");
  assert.equal(parseFileRef(".claude/outbox/")?.relPath, undefined);
  assert.equal(refsIn("see .claude/outbox/a.png and .claude/outbox/a.png").length, 1); // deduped
});

test("a bare media name resolves only when the listing holds exactly one", () => {
  assert.equal(bareFileRef("boulder-10-flow.gif", OUTBOX)?.relPath, ".claude/outbox/boulder-10-flow.gif");
  assert.equal(bareFileRef("  boulder-13-highball.gif  ", OUTBOX)?.relPath, ".claude/outbox/boulder-13-highball.gif");
  assert.equal(bareFileRef("1000075294-mtx9ltl9ca2e0a.png", OUTBOX)?.relPath, ".claude/inbox/1000075294-mtx9ltl9ca2e0a.png");
  // The raw label stays what was written — the reader shows the name, not the path.
  assert.equal(bareFileRef("boulder-10-flow.gif", OUTBOX)?.raw, "boulder-10-flow.gif");
  assert.equal(bareFileRef("boulder-10-flow.gif", OUTBOX)?.image, true);
});

test("a bare name resolves to nothing rather than to a guess", () => {
  // Not in the listing: an unknown name is not a file reference.
  assert.equal(bareFileRef("nope.gif", OUTBOX), null);
  // Not media: the file types a repo is full of are exactly the false positives.
  assert.equal(bareFileRef("report.md", OUTBOX), null);
  assert.equal(bareFileRef("api.ts", [".claude/outbox/api.ts"]), null);
  // Ambiguous — same basename in both transport dirs is a coin flip, so refuse.
  assert.equal(bareFileRef("shot.png", [".claude/inbox/shot.png", ".claude/outbox/shot.png"]), null);
  // A path is not a bare name (the written-out branch owns those).
  assert.equal(bareFileRef(".claude/outbox/boulder-10-flow.gif", OUTBOX), null);
  assert.equal(bareFileRef("outbox/boulder-10-flow.gif", OUTBOX), null);
  // Prose is not a name, and no listing resolves nothing at all.
  assert.equal(bareFileRef("the gif above.gif", OUTBOX), null);
  assert.equal(bareFileRef("boulder-10-flow.gif", []), null);
  assert.equal(bareFileRef("boulder-10-flow.gif", undefined), null);
  // A listing entry outside the transport dirs never lends its name to one.
  assert.equal(bareFileRef("logo.png", ["assets/logo.png"]), null);
});

test("wholeFileRef is whole-string, so prose around a path is not a match", () => {
  assert.equal(wholeFileRef(" .claude/outbox/a.png ")?.name, "a.png");
  assert.equal(wholeFileRef("see .claude/outbox/a.png"), null);
});

test("docImageRef resolves an image link against the document's folder", () => {
  // The README case: a hero image a repo root's README names relatively.
  assert.equal(docImageRef("docs/assets/hero.svg", "README.md")?.relPath, "docs/assets/hero.svg");
  assert.equal(docImageRef("./a.png", "docs/x.md")?.relPath, "docs/a.png");
  assert.equal(docImageRef("../media/first-look.gif", "docs/notes/x.md")?.relPath, "docs/media/first-look.gif");
  assert.equal(docImageRef("/brand/logo.png?raw=1", "docs/x.md")?.relPath, "brand/logo.png");
  assert.equal(docImageRef("my%20shot.png", "x.md")?.relPath, "my shot.png");
  assert.equal(docImageRef("clip.mp4", "x.md")?.video, true);
});

test("a docs gif linked to its film is found in both spellings, in text order", () => {
  // The sized HTML one is how README shows a phone-tall film without overflowing a laptop;
  // the phone reader must still draw it as the picture, never print the tags.
  const t = `[![one](a.gif)](a.mp4) then <a href="docs/media/b.mp4"><img src="docs/media/b.gif" width="270" alt="the phone&#39;s &quot;loop&quot;"></a>.`;
  const got = linkedImages(t);
  assert.deepEqual(got.map((m) => [m.alt, m.src, m.href]), [["one", "a.gif", "a.mp4"], [`the phone's "loop"`, "docs/media/b.gif", "docs/media/b.mp4"]]);
  assert.equal(t.slice(got[1].at, got[1].end).endsWith("</a>"), true);
  // Attribute order is free, and a self-closed img is the same picture.
  assert.equal(linkedImages(`<a href="x.mp4"><img alt="x" width="9" src="x.gif" /></a>`)[0]?.src, "x.gif");
  // A plain link, or an img with no src, is not one.
  assert.deepEqual(linkedImages(`<a href="x.mp4">x</a> <a href="y.mp4"><img alt="y"></a> [x](y.mp4)`), []);
  // A bare img is the picture, its tap the picture itself; one inside a link is found once, as the link.
  const bare = linkedImages(`<p> <img src="docs/menu.jpg" width="49%" alt="Menu"> <a href="v.mp4"><img src="v.gif"></a> <img src="docs/play.jpg"> </p>`);
  assert.deepEqual(bare.map((m) => [m.src, m.href]), [["docs/menu.jpg", "docs/menu.jpg"], ["v.gif", "v.mp4"], ["docs/play.jpg", "docs/play.jpg"]]);
});

test("docImageRef refuses what is not a picture inside the repo", () => {
  assert.equal(docImageRef("https://example.com/a.png", "README.md"), null);
  assert.equal(docImageRef("//cdn.example.com/a.png", "README.md"), null);
  assert.equal(docImageRef("data:image/png;base64,AAAA", "README.md"), null);
  assert.equal(docImageRef("../a.png", "README.md"), null);   // climbs out of the repo
  assert.equal(docImageRef("CHANGELOG.md", "README.md"), null); // not media
});

test("dropFileRef takes out exactly the one mention and tidies the hole", () => {
  const p = ".claude/inbox/1000078093-muwkhwxk2d07aa.png";
  assert.equal(dropFileRef(`Fix it. ${p}`, p), "Fix it.");
  assert.equal(dropFileRef(`see ${p} and fix`, p), "see and fix");
  assert.equal(dropFileRef(`see ${p}.`, p), "see.");
  // An absolute lead-in goes with it — no orphan directory left behind.
  assert.equal(dropFileRef(`look /Users/me/repo/${p} now`, p), "look now");
  // Other files and the writer's own blank lines stay.
  assert.equal(dropFileRef(`a\n\n${p}\n.claude/inbox/b.png`, p), "a\n\n.claude/inbox/b.png");
  // Every mention of that path, not just the first.
  assert.equal(dropFileRef(`${p} then ${p} again`, p), "then again");
  // Nothing to drop is the text unchanged, untrimmed.
  assert.equal(dropFileRef("  hi  ", p), "  hi  ");
});
