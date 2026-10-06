/**
 * `local/no-silent-send`, pinned both ways, through ESLint itself.
 *
 * The rule has two halves. The JSX half sees a socket write written INSIDE an
 * `on*` attribute. The feature half exists because that was bypassed by one
 * level of indirection: `onScan={() => scanRepo(dir)}` in a view, and a bare
 * `core().conn.send` in `features/build/store.ts` — the tap said nothing and
 * the rule saw nothing. In `features/**` every `conn.send` now answers for
 * itself, in the function it is written in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import local from "./eslint/rules.js";

const linter = new Linter({ configType: "flat" });
const config = [{
  files: ["**/*.ts", "**/*.tsx"], plugins: { local },
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
  rules: { "local/no-silent-send": "error" },
}];
const FEAT = "packages/web/src/features/build/store.ts";
const lint = (code, file = FEAT) => linter.verify(code, config, { filename: file }).map((m) => m.message);
const flagged = (code, file) => assert.equal(lint(code, file).length, 1, `should be flagged:\n${code}`);
const clean = (code, file) => assert.deepEqual(lint(code, file), [], `should pass:\n${code}`);

test("a bare conn.send in a feature function that says nothing is flagged, in every spelling", () => {
  flagged(`export function scanRepo(d) { core().conn.send({ t: "build.scan", repoDir: d }); }`);
  flagged(`export function scanRepo(d) { const c = core(); c.conn.send({ t: "build.scan", repoDir: d }); }`);
  flagged(`export function scanRepo(d) { const { conn } = core(); conn.send({ t: "build.scan", repoDir: d }); }`);
  flagged(`export const scanRepo = (d) => core().conn.send({ t: "build.scan", repoDir: d });`);
  assert.match(lint(`export function f() { core().conn.send({ t: "x" }); }`)[0], /bare `conn.send` in a feature/);
});

test("a receipt in the same function clears it: toast, liveSend/liveAsk, queueOp, nav.open, conn.status", () => {
  clean(`function f(c) { c.conn.send({ t: "x" }); c.say.toast("asked"); }`);
  clean(`function f() { core().conn.send({ t: "x" }); core().say.toast("asked"); }`);
  clean(`function f(c) { c.conn.send({ t: "x" }); showToast("asked"); }`);
  clean(`function f(c) { c.conn.send({ t: "a" }); c.conn.liveAsk({ t: "b" }, "offline"); }`);
  clean(`function f(c) { c.conn.send({ t: "a" }); c.conn.liveSend({ t: "b" }, "ok", "offline"); }`);
  clean(`function f(c) { c.conn.send({ t: "a" }); c.queue.queueOp({ t: "b" }); }`);
  clean(`function openBuildFor(r) { const c = core(); c.conn.send({ t: "build.list" }); c.nav.open("build"); }`);
  clean(`function f(q) { const c = core(); if (c.conn.status === "open") c.conn.send({ t: "usage.refresh" }); }`);
});

test("the receipt must be in the SAME function, not a sibling", () => {
  flagged(`function f(c) { c.conn.send({ t: "x" }); } function g(c) { c.say.toast("hi"); }`);
});

test("inside a messages handler or boot nobody tapped anything", () => {
  clean(`export const manifest = { messages: { welcome: (m, c) => { c.conn.send({ t: "build.list" }); } } };`);
  clean(`export const manifest = { messages: { "build.done": (m, c) => c.conn.send({ t: "x" }) } };`);
  clean(`export const manifest = { boot: (c) => { c.conn.send({ t: "x" }); return () => {}; } };`);
  clean(`export const manifest = { boot(c) { c.conn.send({ t: "x" }); } };`);
  // A command is a TAP: it gets no such pass.
  flagged(`export const manifest = { commands: [{ id: "x", run: (c) => { c.conn.send({ t: "x" }); } }] };`);
});

test("the standard inline exemption, with a reason, is honoured", () => {
  clean(`export function askOptions(d) {
  // eslint-disable-next-line local/no-silent-send -- the ask form is the receipt
  core().conn.send({ t: "build.options", repoDir: d });
}`);
});

test("outside features/ the feature half is off; the JSX half still holds everywhere", () => {
  clean(`function f(c) { c.conn.send({ t: "x" }); }`, "packages/web/src/Backlog.ts");
  const tsx = "packages/web/src/features/build/BuildSheet.tsx";
  // In a feature the inline handler is reported once, not by both halves.
  assert.equal(lint(`const v = <button onClick={() => { core().conn.send({ t: "x" }); }} />;`, tsx).length, 1);
  clean(`const v = <button onClick={() => { core().conn.send({ t: "x" }); core().say.toast("ok"); }} />;`, tsx);
  flagged(`const v = <button onClick={() => { ws.send({ t: "x" }); }} />;`, "packages/web/src/Backlog.tsx");
});

test("App.tsx and core/** bind the socket by PATH: a bare send() in a tap is flagged with no `.send.bind(` in the file", () => {
  // The socket is `useConnection()`'s now, destructured — the `.bind(` lives in
  // core/conn, and the file doing the writing never spells it.
  const tap = `const { send } = conn; const v = <button onClick={() => { send({ t: "x" }); }} />;`;
  flagged(tap, "packages/web/src/App.tsx");
  flagged(tap, "packages/web/src/core/session/SessionHeader.tsx");
  clean(`const { send, liveSend } = conn; const v = <button onClick={() => { send({ t: "a" }); showToast("ok"); }} />;`, "packages/web/src/App.tsx");
  // Elsewhere a bare `send` is somebody's callback prop, not the socket.
  clean(tap, "packages/web/src/SendSheet.tsx");
  // …and the old spelling still counts wherever it appears.
  flagged(`const send = c.send.bind(c); const v = <button onClick={() => { send({ t: "x" }); }} />;`, "packages/web/src/SendSheet.tsx");
});
