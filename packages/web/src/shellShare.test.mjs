/**
 * A share from another app, through the REAL global the Android shell calls
 * (`window.shellShare`, installed by `installShellShare`). Any app can share
 * to this one, so the parse is strict: a file URL must be this page's own
 * origin under the shell's file route, and a share held before anyone listens
 * is drained by the first listener — never acted on by itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// shellShare.ts imports its siblings without an extension (Vite resolves
// them); node needs the `.ts`.
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (spec.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(spec)) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

globalThis.window = globalThis;
globalThis.location ??= { origin: "http://localhost" };

const { parseShare, installShellShare, onShellShare } = await import("./shellShare.ts");

const O = "http://localhost";
const file = (url, extra = {}) => ({ url, name: "a.png", type: "image/png", size: 3, ...extra });

test("parseShare keeps files on this origin's file route, and the text", () => {
  const s = parseShare(JSON.stringify({ files: [file(`${O}/_capacitor_file_/data/x/a.png`)], text: "  hi " }), O);
  assert.deepEqual(s, { files: [file(`${O}/_capacitor_file_/data/x/a.png`)], text: "hi" });
});

test("parseShare drops a file elsewhere, off the file route, or malformed", () => {
  const s = parseShare(JSON.stringify({ files: [
    file("http://evil.example/_capacitor_file_/a.png"),
    file(`${O}/api/host/screenshot`),
    file("not a url"),
    { name: "x" },
  ], text: "t" }), O);
  assert.deepEqual(s, { files: [], text: "t" });
});

test("parseShare: nothing usable is null", () => {
  assert.equal(parseShare("{", O), null);
  assert.equal(parseShare(JSON.stringify({ files: [], text: " " }), O), null);
  assert.equal(parseShare("null", O), null);
});

test("parseShare strips directories from the name", () => {
  const s = parseShare(JSON.stringify({ files: [file(`${O}/_capacitor_file_/a`, { name: "../../etc/passwd" })] }), O);
  assert.equal(s.files[0].name, "passwd");
});

test("the global answers true and parks a share until a listener drains it", () => {
  installShellShare();
  const json = JSON.stringify({ text: "hello" });
  assert.equal(window.shellShare(json), true, "taken: the shell must not retry");
  const got = [];
  const off = onShellShare((s) => got.push(s.text));
  assert.deepEqual(got, ["hello"], "drained on register");
  assert.equal(window.shellShare(JSON.stringify({ text: "again" })), true);
  assert.deepEqual(got, ["hello", "again"]);
  off();
  assert.equal(window.shellShare("garbage"), true, "a bad share is dropped, never retried");
});
