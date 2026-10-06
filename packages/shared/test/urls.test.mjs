// Putting a URL back together after the terminal GRID broke it across rows
// (`shared/src/urls.ts`). The load-bearing part is what is NOT joined: the
// evidence is the wrap geometry (full rows, same inset, one width), never
// "the next row also looks URL-ish".
import test from "node:test";
import assert from "node:assert/strict";
import { findUrls, findUrlsInText } from "../dist/index.js";

// A real `/login` link, wrapped the way a 53-column phone terminal wraps it.
const LOGIN =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&state=cQb7hRqDdxKqM6fnqs6N6jdsYfHWu9J0ZWwDdOxnhpw";

function wrap(s, width) {
  const out = [];
  for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
  return out;
}

test("a URL wrapped by the grid comes back as one URL", () => {
  const rows = wrap(LOGIN, 53);
  assert.ok(rows.length > 3, "fixture must actually wrap");
  const [hit, ...rest] = findUrls(rows);
  assert.equal(rest.length, 0);
  assert.equal(hit.url, LOGIN);
  assert.equal(hit.line, 0);
  assert.equal(hit.lines, rows.length);
});

test("the wrap survives the box inset the CLI draws it in", () => {
  const rows = wrap(LOGIN, 40).map((r) => "  " + r);
  assert.equal(findUrls(rows)[0].url, LOGIN);
});

test("the run stops at the first row that is not full", () => {
  const rows = [...wrap(LOGIN, 53), "", "  Paste it where you were asked to."];
  assert.equal(findUrls(rows)[0].url, LOGIN);
});

test("a following row that merely looks URL-ish is not joined", () => {
  // The URL ended mid-row, so nothing about it was wrapped. A flush-left path
  // underneath is a different line and must stay one.
  const rows = ["see https://example.com/a for this", "packages/host/src/login.ts"];
  const hits = findUrls(rows);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, "https://example.com/a");
  assert.equal(hits[0].lines, 1);
});

test("a row of a different width breaks the run — those are separate lines", () => {
  // Two full-width-looking rows that are not the same width: not a wrap.
  const rows = ["https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbb", "cccccccccccccccccccc"];
  const hit = findUrls(rows)[0];
  assert.equal(hit.url, "https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbb");
  assert.equal(hit.lines, 2);
});

test("an indent that does not match the first row ends the URL", () => {
  const rows = wrap(LOGIN, 53);
  rows[2] = " " + rows[2];
  const hit = findUrls(rows)[0];
  assert.ok(hit.url.length < LOGIN.length);
  assert.equal(hit.lines, 2);
});

test("prose punctuation after a URL is not part of it", () => {
  assert.equal(findUrls(["open https://example.com/x."])[0].url, "https://example.com/x");
  assert.equal(findUrls(["(https://example.com/x)"])[0].url, "https://example.com/x");
});

test("two links on one row are two links, and repeats collapse", () => {
  const hits = findUrls(["a https://one.example/x b https://two.example/y", "https://one.example/x"]);
  assert.deepEqual(hits.map((h) => h.url), ["https://one.example/x", "https://two.example/y"]);
});

test("a bare scheme with nothing after it is not a URL", () => {
  assert.deepEqual(findUrls(["https://", "http://"]), []);
});

test("findUrlsInText splits on newlines and nothing else", () => {
  assert.equal(findUrlsInText(wrap(LOGIN, 53).join("\n"))[0].url, LOGIN);
});

// Measured on claude 2.1.x at 54 columns: the login panel is a scrolled
// viewport, and its `↓` is painted over the last shown row of the link, two
// columns from the edge. The rejoin stopped at the row above and the phone
// opened a link with no `scope`.
const OVERPAINTED = [
  "https://claude.com/cai/oauth/authorize?code=true&clien",
  "t_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_typ",
  "e=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%",
  "2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key↓u",
  "",
  "✻ Cooked for 0s · done 10:28 AM",
];

test("a scroll indicator painted over the link keeps the clean prefix and says it is cut", () => {
  const hit = findUrls(OVERPAINTED)[0];
  assert.equal(hit.url, OVERPAINTED.slice(0, 3).join("") + "2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key");
  assert.equal(hit.lines, 4);
  assert.equal(hit.truncated, true);
});

test("…and on the link's first row too (`↑` over `client_id`)", () => {
  const hit = findUrls(["https://claude.com/cai/oauth/authorize?code=true&client_↑d", "=9d1c250a"])[0];
  assert.equal(hit.url, "https://claude.com/cai/oauth/authorize?code=true&client_");
  assert.equal(hit.truncated, true);
});

test("a whole link is not truncated, and a quote closing it is prose", () => {
  assert.equal(findUrls(wrap(LOGIN, 53))[0].truncated, undefined);
  const hit = findUrls(['see "https://example.com/x" there'])[0];
  assert.equal(hit.url, "https://example.com/x");
  assert.equal(hit.truncated, undefined);
});

test("a glyph row that is NOT full width is the next line, not an over-paint", () => {
  const rows = wrap(LOGIN, 53).slice(0, 2);
  rows.push("abc→def");
  const hit = findUrls(rows)[0];
  assert.equal(hit.truncated, undefined);
  assert.equal(hit.lines, 2);
});
