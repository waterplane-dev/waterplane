/**
 * copyText, pinned with a tiny fake document: the async path wins when it can;
 * when it is refused the textarea fallback runs, hands focus and the selection
 * back, leaves nothing in the DOM, and a read ticket is scrubbed on both paths.
 * Run: node --test packages/web/src/webapi/webapiClipboard.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { copyText } from "./webapiClipboard.ts";
import { setReadTicket } from "../hostUrl.ts";

setReadTicket({ wt: "SECRET123", base: "http://h", exp: Date.now() + 1e6 });

const TICKET = "http://h/api/artifact?path=a.png&wt=SECRET123";

function setup({ asyncOk, exec = true }) {
  const log = { written: null, focused: [], body: [], exec: null, ranges: [] };
  const prev = { focus: (o) => log.focused.push(o) };
  const sel = {
    rangeCount: 1, getRangeAt: () => "R0",
    removeAllRanges: () => log.ranges.push("clear"), addRange: (r) => log.ranges.push(r),
  };
  globalThis.window = { isSecureContext: true };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: { writeText: async (t) => { if (!asyncOk) throw new Error("denied"); log.written = t; } },
  } });
  globalThis.document = {
    activeElement: prev, body: { appendChild: (e) => { e.parentNode = globalThis.document.body; log.body.push(e); }, removeChild: (e) => { log.body.splice(log.body.indexOf(e), 1); } },
    getSelection: () => sel,
    createElement: () => ({ style: {}, select() {}, parentNode: null }),
    execCommand: (c) => { log.exec = { c, value: log.body[0].value, readOnly: log.body[0].readOnly, style: { ...log.body[0].style } }; return exec; },
  };
  return log;
}

test("async path: scrubbed text written, no fallback", async () => {
  const log = setup({ asyncOk: true });
  assert.equal(await copyText(TICKET), true);
  assert.ok(log.written && !log.written.includes("SECRET123"), log.written);
  assert.equal(log.exec, null);
});

test("async refused: fallback copies scrubbed text, readonly + fixed, restores focus and selection", async () => {
  const log = setup({ asyncOk: false });
  assert.equal(await copyText(TICKET), true);
  assert.ok(!log.exec.value.includes("SECRET123"), log.exec.value);
  assert.equal(log.exec.c, "copy");
  assert.equal(log.exec.readOnly, true);
  assert.equal(log.exec.style.position, "fixed");
  assert.equal(log.exec.style.top, "0");
  assert.deepEqual(log.focused, [{ preventScroll: true }]);
  assert.deepEqual(log.ranges, ["clear", "R0"]);
  assert.equal(log.body.length, 0);
});

test("fallback reports execCommand's verdict", async () => {
  setup({ asyncOk: false, exec: false });
  assert.equal(await copyText("plain"), false);
});

test("no page at all (a worker, a test) answers false, never throws", async () => {
  const had = globalThis.document;
  delete globalThis.document;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  assert.equal(await copyText("x"), false);
  globalThis.document = had;
});
