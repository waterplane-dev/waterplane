/**
 * The frame detection and the one outgoing message.
 *
 *     node --test packages/web/src/vscodeShell.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openInVscodeFrom, vscodeParentOf } from "./vscodeShell.ts";

const framed = (...origins) => {
  const sent = [];
  const win = { location: { ancestorOrigins: origins }, parent: { postMessage: (m, o) => sent.push([m, o]) } };
  return { win, sent };
};
const VS = "vscode-webview://abc123";

test("not framed: parent is the window itself", () => {
  const win = { location: { ancestorOrigins: [] } };
  win.parent = win;
  assert.equal(vscodeParentOf(win), null);
  assert.equal(openInVscodeFrom(win, "https://example.com"), false);
});

test("framed by an http site: null, nothing posted", () => {
  const { win, sent } = framed("https://evil.example");
  assert.equal(vscodeParentOf(win), null);
  assert.equal(openInVscodeFrom(win, "https://example.com"), false);
  assert.equal(sent.length, 0);
});

test("framed by a vscode webview: its origin", () => {
  assert.equal(vscodeParentOf(framed(VS).win), VS);
});

test("nested: the first ancestor decides", () => {
  assert.equal(vscodeParentOf(framed("https://a.example", VS).win), null);
  assert.equal(vscodeParentOf(framed(VS, "https://a.example").win), VS);
});

test("missing ancestorOrigins or location: null, never throws", () => {
  const p = {};
  assert.equal(vscodeParentOf({ parent: p, location: {} }), null);
  assert.equal(vscodeParentOf({ parent: p }), null);
  assert.equal(vscodeParentOf(null), null);
  assert.equal(vscodeParentOf({ get parent() { throw new Error("x"); } }), null);
});

test("open posts the one message to the exact origin", () => {
  const { win, sent } = framed(VS);
  assert.equal(openInVscodeFrom(win, "https://example.com/a?b=1"), true);
  assert.deepEqual(sent, [[{ shell: "vscode", v: 1, op: "open", url: "https://example.com/a?b=1" }, VS]]);
  assert.notEqual(sent[0][1], "*");
});

test("only http(s) is passed on", () => {
  const { win, sent } = framed(VS);
  for (const u of ["javascript:alert(1)", "file:///etc/passwd", "intent://x", "vscode://x", "https://a b", ""]) {
    assert.equal(openInVscodeFrom(win, u), false, u);
  }
  assert.equal(sent.length, 0);
});
