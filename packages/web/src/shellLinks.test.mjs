import test from "node:test";
import assert from "node:assert/strict";
import {
  AWAITING_CODE_HINT, LOCAL_LINK_NOTE, codeRefusedToast, copyCodeLabel, hasShellBar, hasUserinfo, linkSummary, orderLinks, SUSPICIOUS_LINK, sourceLabel,
} from "./shellLinks.ts";

test("sourceLabel: only a browser-sourced link says where it came from", () => {
  assert.equal(sourceLabel({ source: "browser" }), "a program asked to open this");
  assert.equal(sourceLabel({ source: "screen" }), null);
});

test("local link note says why and what to do", () => {
  assert.match(LOCAL_LINK_NOTE, /desktop's own localhost/);
  assert.match(LOCAL_LINK_NOTE, /can't be opened from the phone/);
  assert.match(LOCAL_LINK_NOTE, /no-browser \/ device flag/);
});

test("code wording carries the code itself", () => {
  assert.equal(copyCodeLabel("ABCD-1234"), "copy code ABCD-1234");
  assert.match(codeRefusedToast("ABCD-1234"), /needs https/);
  assert.match(codeRefusedToast("ABCD-1234"), /ABCD-1234/);
});

test("orderLinks: newest first, input untouched, nothing dropped", () => {
  const a = { url: "a", source: "screen", at: 1 };
  const b = { url: "b", source: "browser", at: 3 };
  const c = { url: "c", source: "screen", at: 2 };
  const input = [a, b, c];
  assert.deepEqual(orderLinks(input).map((l) => l.url), ["b", "c", "a"]);
  assert.deepEqual(input.map((l) => l.url), ["a", "b", "c"]);
});

test("linkSummary: drops the scheme and clips long urls", () => {
  assert.equal(linkSummary("https://github.com/login/device"), "github.com/login/device");
  const s = linkSummary("https://accounts.example.com/" + "x".repeat(200));
  assert.equal(s.length, 44);
  assert.ok(s.endsWith("…"));
});

test("hasShellBar: links or a waiting code, never an empty list", () => {
  assert.equal(hasShellBar({}), false);
  assert.equal(hasShellBar({ links: [] }), false);
  assert.equal(hasShellBar({ links: null, awaitingCode: false }), false);
  assert.equal(hasShellBar({ links: [{}] }), true);
  assert.equal(hasShellBar({ awaitingCode: true }), true);
  assert.ok(AWAITING_CODE_HINT.includes("paste code"));
});

test("linkSummary: userinfo is a warning, never the host it imitates", () => {
  assert.equal(linkSummary("https://github.com@evil.tld/x"), SUSPICIOUS_LINK);
  assert.equal(linkSummary("https://user:pw@example.com/"), SUSPICIOUS_LINK);
  assert.equal(hasUserinfo("https://github.com@evil.tld/x"), true);
  assert.equal(hasUserinfo("https://github.com/login/device"), false);
  assert.equal(linkSummary("https://github.com/a?b=1"), "github.com/a?b=1");
  assert.equal(linkSummary("not a url"), "not a url");
});
