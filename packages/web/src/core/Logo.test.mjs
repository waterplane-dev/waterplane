import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SMALL_CUT_PX, useSmallMark } from "./logoMark.ts";

const brand = (f) => new URL(`../../../../brand/${f}`, import.meta.url);

test("the small mark is used strictly below the spec's cut, and the cut is brand.json's", () => {
  const conf = JSON.parse(fs.readFileSync(brand("brand.json"), "utf8"));
  assert.equal(SMALL_CUT_PX, conf.smallCutPx);
  assert.equal(useSmallMark(63), true);
  assert.equal(useSmallMark(64), false);
  assert.equal(useSmallMark(32), true);
  assert.equal(useSmallMark(192), false);
});

test("Logo inlines all four marks (full/small x dark/light) from brand/ through the @brand alias", () => {
  const src = fs.readFileSync(new URL("./Logo.tsx", import.meta.url), "utf8");
  const files = ["icon.svg", "icon-small.svg", "icon-light.svg", "icon-small-light.svg"];
  for (const f of files) {
    assert.match(src, new RegExp(`@brand/${f.replace(/\./g, "\\.")}\\?raw`), f);
    assert.ok(fs.existsSync(brand(f)), f);
  }
});
