/**
 * CodeQL `js/polynomial-redos` fixes (2026-10-31): every regex below was
 * quadratic on a long run of the wrong characters, and was rewritten as a scan
 * with IDENTICAL output. Each rewrite is pinned two ways: a differential check
 * against the ORIGINAL regex over random strings from the alphabet that
 * matters, and a 50k-char pathological input that must finish fast.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendDictation, askedRef, defaultRootOf, findUrls, imagePaths, pairLandingUrl, remoteKey,
  resolveHostUrl, stateDirPick, stripAnsi, transportPaths, trimEndChars, wsUrlFor,
} from "../dist/index.js";

// A tiny seeded PRNG so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function randomStrings(alphabet, n, maxLen, seed = 7) {
  const r = rng(seed);
  const out = [];
  for (let k = 0; k < n; k++) {
    const len = Math.floor(r() * maxLen);
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
    out.push(s);
  }
  return out;
}
/** Under a second for 50k chars: the quadratic regexes took far longer. */
function fast(fn) {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
}
const BIG = 50_000;

test("trimEndChars is `replace(/[chars]+$/, \"\")`, linear", () => {
  const cases = randomStrings(["/", "\\", "a", "/", "."], 2000, 12);
  for (const s of cases) {
    assert.equal(trimEndChars(s, "/"), s.replace(/\/+$/, ""), JSON.stringify(s));
    assert.equal(trimEndChars(s, "\\/"), s.replace(/[\\/]+$/, ""), JSON.stringify(s));
  }
  assert.equal(trimEndChars("", "/"), "");
  assert.equal(trimEndChars("///", "/"), "");
  fast(() => trimEndChars("/".repeat(BIG) + "x", "/"));
  fast(() => trimEndChars("/".repeat(BIG), "/"));
});

test("trimEnd stands in for /\\s*$/ and /\\s+$/ (appendDictation, findUrls)", () => {
  for (const s of randomStrings([" ", "\t", "\n", "\u00a0", "\u2028", "\ufeff", "a"], 2000, 10)) {
    assert.equal(s.trimEnd(), s.replace(/\s+$/, ""), JSON.stringify(s));
    assert.equal(s.trimEnd(), s.replace(/\s*$/, ""), JSON.stringify(s));
  }
  assert.equal(appendDictation("hello \t\n", "world"), "hello world");
  assert.equal(appendDictation("", " hi "), "hi");
  fast(() => appendDictation("\t".repeat(BIG) + "x", "y"));
  fast(() => findUrls(["\t".repeat(BIG) + "x https://example.com/a"]));
  assert.deepEqual(findUrls(["see https://example.com/a   "]).map((u) => u.url), ["https://example.com/a"]);
});

test("host URL helpers strip trailing slashes as before", () => {
  assert.equal(resolveHostUrl("https://h.ts.net///", "/api/x"), "https://h.ts.net/api/x");
  assert.equal(wsUrlFor("https://h.ts.net//"), "wss://h.ts.net/ws");
  assert.equal(wsUrlFor("http://100.64.0.1:8770/"), "ws://100.64.0.1:8770/ws");
  assert.equal(pairLandingUrl("https://h.ts.net/", "ABC"), "https://h.ts.net/pair/ABC");
  const slashes = "/".repeat(BIG);
  fast(() => resolveHostUrl("https://h" + slashes + "x", "/api/x"));
  fast(() => wsUrlFor("https://h" + slashes + "x"));
  fast(() => pairLandingUrl("https://h" + slashes + "x", "ABC"));
});

test("statedir: trailing / and \\ come off a home longer than one char", () => {
  assert.equal(defaultRootOf("/home/u//"), "/home/u/dev");
  assert.equal(defaultRootOf("C:\\Users\\u\\"), "C:\\Users\\u/dev");
  assert.equal(defaultRootOf("/"), "//dev");
  assert.equal(stateDirPick({ XDG_STATE_HOME: "/x/state/" }, "/h").dir.startsWith("/x/state/"), true);
  fast(() => defaultRootOf("/".repeat(BIG) + "x"));
});

test("peer remoteKey: trailing slashes around .git as before", () => {
  const orig = (path) => path.split(/[?#]/)[0].replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "").replace(/^\/+/, "");
  // Through the public function: same key for the shapes a remote takes.
  assert.equal(remoteKey("https://github.com/o/r.git/"), "github.com/o/r");
  assert.equal(remoteKey("git@github.com:o/r.git"), "github.com/o/r");
  assert.equal(remoteKey("https://github.com/o/r//.git//"), "github.com/o/r");
  assert.equal(remoteKey("ssh://git@host:22/o/r"), "host/o/r");
  // Differential on the path expression itself.
  const mine = (path) => trimEndChars(trimEndChars(path.split(/[?#]/)[0], "/").replace(/\.git$/i, ""), "/").replace(/^\/+/, "");
  for (const s of randomStrings(["/", ".git", "a", "?", "#", ".GIT"], 2000, 8)) assert.equal(mine(s), orig(s), JSON.stringify(s));
  fast(() => remoteKey("https://github.com/" + "/".repeat(BIG) + "x"));
});

test("askedRef's parenthetical is /\\(([^)]*)\\)/ by indexOf", () => {
  const orig = (t) => /\(([^)]*)\)/.exec(t)?.[1]?.trim() ?? null;
  for (const s of randomStrings(["(", ")", " ", "a", "session 61c1e521"], 3000, 10)) {
    const t = s.trim();
    const mine = askedRef(s);
    const o = orig(t);
    const sess = /session ([0-9a-f]{8})/.exec(t)?.[1] ?? null;
    const date = /^\d{4}-\d{2}-\d{2}/.exec(t)?.[0] ?? null;
    const note = o && !sess ? o : (!date && /^[0-9a-f]{8}$/.test(t) ? t : null);
    assert.equal(mine.note, note, JSON.stringify(s));
  }
  assert.deepEqual(askedRef("2026-09-27 (user request)"), { date: "2026-09-27", session: null, note: "user request" });
  assert.deepEqual(askedRef("2026-09-16 (session 61c1e521)"), { date: "2026-09-16", session: "61c1e521", note: null });
  fast(() => askedRef("(".repeat(BIG)));
});

test("imagePaths / transportPaths match what IMG_RE + the old trim found", () => {
  const IMG_RE = /\S+\.(?:png|jpe?g|gif|webp|bmp|heic|heif|svg)\b/gi;
  const oldTrim = (s) => s.replace(/^[([{'"`*]+/, "").replace(/[)\]}.,;:'"`*]+$/, "");
  const oldImages = (text) => {
    const m = text.match(IMG_RE);
    return m ? [...new Set(m.map(oldTrim))] : [];
  };
  const alphabet = [" ", "\n", "a", ".", ".png", ".PNG", ".jpeg", ".jpg", "x", "_", "-", "`", "*", ")", "(", "\"", "!", ".svg", "/"];
  for (const s of randomStrings(alphabet, 4000, 14)) assert.deepEqual(imagePaths(s), oldImages(s), JSON.stringify(s));
  assert.deepEqual(imagePaths("see `.claude/inbox/a.png` and **b.JPG**, then c.png."), [".claude/inbox/a.png", "b.JPG", "c.png"]);
  assert.deepEqual(imagePaths("a.png.b.gif x.pngx .png"), ["a.png.b.gif"]);
  assert.deepEqual(transportPaths("look at .claude/outbox/flow.gif)."), [".claude/outbox/flow.gif"]);
  fast(() => imagePaths("!".repeat(BIG)));
  fast(() => imagePaths("a" + ".".repeat(BIG)));
  fast(() => transportPaths(".claude/inbox/x" + "\"".repeat(BIG) + "y"));
  fast(() => imagePaths("a.png" + "!".repeat(BIG) + "\""));
});

test("stripAnsi removes what the old ANSI regex removed", () => {
  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[PX^_].*?\x1b\\|\x1b\][^\x07]*\x07/g;
  const alphabet = ["\x1b", "[", "]", "P", "X", "^", "_", "\\", "\x07", "\n", "\r", "\u2028", "1", ";", "?", " ", "m", "a", "\x1b\\", "\x1b[", "\x1b]", "\x1bP"];
  for (const s of randomStrings(alphabet, 20000, 16)) assert.equal(stripAnsi(s), s.replace(ANSI, ""), JSON.stringify(s));
  assert.equal(stripAnsi("\x1b[1;32mok\x1b[0m \x1b]0;title\x07done \x1bPq#0\x1b\\."), "ok done .");
  assert.equal(stripAnsi("plain"), "plain");
  fast(() => stripAnsi("\x1bP".repeat(BIG / 2)));
  fast(() => stripAnsi("\x1b]".repeat(BIG / 2)));
  fast(() => stripAnsi("\x1bP\n".repeat(BIG / 3) + "\x1b\\"));
  fast(() => stripAnsi("\x1b[" + "1".repeat(BIG)));
});
