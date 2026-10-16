/** `assertCtxComplete`: an unassigned ctx member fails the boot, naming it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { serverCtxKeys, assertCtxComplete } from "../dist/server/ctxseal.js";

const complete = () => Object.fromEntries(serverCtxKeys().map((k) => [k, 0]));

test("a complete ctx passes", () => {
  assert.doesNotThrow(() => assertCtxComplete(complete()));
});

test("a missing key throws and is named", () => {
  const ctx = complete();
  delete ctx.backlog;
  ctx.plugins = undefined;
  assert.throws(() => assertCtxComplete(ctx), (e) => /backlog/.test(e.message) && /plugins/.test(e.message) && !/sessions/.test(e.message));
});

test("falsy-but-assigned values (false, 0, empty) count as assigned", () => {
  const ctx = { ...complete(), DOCTOR: false, ROOT: "" };
  assert.doesNotThrow(() => assertCtxComplete(ctx));
});
