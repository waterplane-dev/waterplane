/**
 * The `backends` frame for the CORE backends, BYTE-PINNED: `backendInfos()` with the model
 * catalogues unprimed so the pin holds on any machine. Taken when the v2 contract moved `caps`
 * to `facts` + `derive.ts` (`docs/analysis/backend-v2-impl.md` §3 WP1), against a frame that
 * was itself pinned before the move. An in-repo extension pins its own column beside its code.
 * A legitimate wire change regenerates the fixture on purpose (`PIN_UPDATE=1`), in the same
 * commit that says why — never to make this pass.
 */
import "../../../scripts/lib-tmuxiso.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const FIXTURE = new URL("./fixtures/backendinfos.core.pin.json", import.meta.url);
const { backendInfos } = await import("../dist/backends/index.js");

test("backendInfos() for the core backends is byte-identical to the pinned frame", () => {
  const now = JSON.stringify(backendInfos());
  if (process.env.PIN_UPDATE === "1") writeFileSync(FIXTURE, JSON.stringify({ core: now }, null, 1) + "\n");
  assert.equal(now, JSON.parse(readFileSync(FIXTURE, "utf8")).core);
});
