/**
 * waterplane.dev cannot fall behind the README.
 *
 * The site's sections are generated from README.md blocks marked `<!-- site:NAME -->`
 * (scripts/site/site-lib.mjs). The generated page is committed, so a README edit without
 * `npm run site` would ship a stale site: before this, the two were kept in step by hand and
 * the site still told people to `curl` an installer URL the README had already moved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../scripts/site/build-site.mjs";
import { extractBlocks, inline, parseImage, renderSection, siteHref, slug, tokenize } from "../scripts/site/site-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const ctx = { repoUrl: "https://github.com/o/r", siteIds: new Set(["install"]) };
const dims = () => ({ width: 10, height: 20 });

test("site/index.html is what the README says (else: npm run site)", () => {
  const current = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.ok(build().html === current, "site/index.html is behind README.md: run `npm run site` and commit the result");
});

test("every picture the site shows exists in the repo", () => {
  for (const src of build().media) assert.doesNotThrow(() => readFileSync(join(ROOT, src)), src);
});

test("links: on-page anchors stay, other anchors and paths go to GitHub", () => {
  assert.equal(siteHref("#install", ctx), "#install");
  assert.equal(siteHref("#known-limits", ctx), "https://github.com/o/r#known-limits");
  assert.equal(siteHref("docs/install.md#x", ctx), "https://github.com/o/r/blob/main/docs/install.md#x");
  assert.equal(siteHref("https://a.b/c", ctx), "https://a.b/c");
});

test("inline: code is literal, links inside code-bearing text survive", () => {
  assert.equal(inline("a `<b>` **c** *d*", ctx), "a <code>&lt;b&gt;</code> <strong>c</strong> <em>d</em>");
  assert.equal(inline("[`x` y](docs/a.md)", ctx), '<a href="https://github.com/o/r/blob/main/docs/a.md"><code>x</code> y</a>');
});

test("slug matches GitHub's heading anchors", () => {
  assert.equal(slug("Your own buttons: plugins"), "your-own-buttons-plugins");
  assert.equal(slug("Queue it now, or schedule it"), "queue-it-now-or-schedule-it");
});

test("pictures: markdown, linked and HTML forms", () => {
  assert.deepEqual(parseImage("![a](x.svg)"), { alt: "a", src: "x.svg" });
  assert.deepEqual(parseImage('<a href="v.mp4"><img src="x.gif" width="270" alt="b"></a>'), { alt: "b", src: "x.gif" });
  assert.equal(parseImage("text ![a](x.svg)"), null);
});

test("a section: phone picture to the figure, its video caption dropped", () => {
  const md = '### Hi there\n\n<a href="v.mp4"><img src="docs/media/x.gif" alt="A"></a>\n\n*[video](v.mp4)*\n\nBody.';
  const r = renderSection("x", md, ctx, dims);
  assert.equal(r.id, "hi-there");
  assert.deepEqual(r.media, ["docs/media/x.gif"]);
  assert.match(r.html, /<figure class="phone"><img src="assets\/x.gif" width="10" height="20" loading="lazy" alt="A"><\/figure>/);
  assert.doesNotMatch(r.html, /video/);
});

test("a block without a heading is the hero, opening with a bold sentence", () => {
  const r = renderSection("intro", "**Big claim.** The rest.", ctx, dims);
  assert.match(r.html, /<h1>Big claim\.<\/h1>\n<p class="lede">The rest\.<\/p>/);
  assert.throws(() => renderSection("intro", "No lead.", ctx, dims), /bold sentence/);
});

test("what the site cannot draw is refused, naming the block", () => {
  assert.throws(() => tokenize("| a | b |\n| - | - |", "t"), /block "t": a table/);
  assert.throws(() => extractBlocks("<!-- site:a -->\nx\n"), /no matching/);
});
