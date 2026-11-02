// `isExtensionEnabled` / `pickImageTextReader` (sdk/extensions.ts) and the one cache name the
// service worker and an extension must agree on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createStore } from "./store.ts";
import { EXT_CACHE_PREFIX, bindPluginList, enabledIn, extAssetCacheName, extAssetUrl, isExtensionEnabled, pickImageTextReader, watchExtensionEnabled } from "./extensions.ts";

const view = (id, enabled, state = enabled ? "active" : "off") => ({ manifest: { id }, source: "", enabled, state, values: {} });

test("an extension is on only when the host LISTED it, switched on and active", () => {
  assert.equal(enabledIn(null, "ocr"), false, "not listed yet ⇒ off");
  assert.equal(enabledIn([], "ocr"), false, "unknown ⇒ off");
  assert.equal(enabledIn([view("ocr", false)], "ocr"), false);
  assert.equal(enabledIn([view("ocr", true, "error")], "ocr"), false);
  assert.equal(enabledIn([view("ocr", true)], "ocr"), true);
});

test("isExtensionEnabled follows the bound plugin list as it changes", () => {
  const src = createStore(null);
  bindPluginList(src);
  assert.equal(isExtensionEnabled("ocr"), false);
  src.set([view("ocr", true)]);
  assert.equal(isExtensionEnabled("ocr"), true);
  src.set([view("ocr", false)]);
  assert.equal(isExtensionEnabled("ocr"), false);
});

test("the image-text reader is the first ENABLED manifest offering one; none ⇒ null", () => {
  const a = { read: async () => "a" }, b = { read: async () => "b" };
  const features = [{ id: "plain" }, { id: "x", imageText: a }, { id: "y", imageText: b }];
  assert.equal(pickImageTextReader(features, () => false), null);
  assert.equal(pickImageTextReader(features, (id) => id === "y"), b);
  assert.equal(pickImageTextReader(features, () => true), a);
});

test("sw.js serves /ext-asset/<id>/<file> from the cache this module names, and its purge spares it", () => {
  const sw = readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8");
  assert.ok(sw.includes(`const EXT_CACHE_PREFIX = "${EXT_CACHE_PREFIX}";`));
  assert.match(sw, /!n\.startsWith\(EXT_CACHE_PREFIX\)/, "the per-build purge keeps extension downloads");
  assert.equal(extAssetCacheName("ocr"), "wp-ext-ocr");
  const route = new RegExp(/const EXT_ROUTE = \/(.*)\/;/.exec(sw)[1]);
  assert.ok(route.test(extAssetUrl("ocr", "eng.traineddata.gz")));
  assert.ok(!route.test("/ext-asset/ocr/../x"), "a file is flat");
});

test("the apps door: the first manifest declaring one whose extension is ON; none on ⇒ null (the caller's off state)", async () => {
  const { pickAppsDoor } = await import("./extensions.ts");
  const door = { open: () => {} };
  const fs = [{ id: "a" }, { id: "b", appsDoor: door }, { id: "c", appsDoor: { open: () => {} } }];
  assert.equal(pickAppsDoor(fs, () => false), null);
  assert.equal(pickAppsDoor([], () => true), null);
  assert.deepEqual(pickAppsDoor(fs, (id) => id !== "c"), { feature: "b", door });
  assert.equal(pickAppsDoor(fs, (id) => id === "c").feature, "c");
});

test("watchExtensionEnabled fires again when the first LIVE list lands, even if it changed nothing", () => {
  // A cached "on" that the live list confirms: the boot that errored on the cache gets a second chance.
  const src = createStore([view("ocr", true)]), live = createStore(false);
  bindPluginList(src, live);
  const seen = [];
  const off = watchExtensionEnabled("ocr", (on) => seen.push(on));
  assert.deepEqual(seen, [true]);
  live.set(true);
  assert.deepEqual(seen, [true, true], "re-fired on the live list");
  src.set([view("ocr", false)]);
  assert.deepEqual(seen, [true, true, false], "later changes as before");
  off();

  // A stale "on" the live list says is off: ONE correcting call, not a change plus a re-fire.
  const src2 = createStore([view("ocr", true)]), live2 = createStore(false);
  bindPluginList(src2, live2);
  const seen2 = [];
  watchExtensionEnabled("ocr", (on) => seen2.push(on));
  src2.set([view("ocr", false)]); live2.set(true);
  assert.deepEqual(seen2, [true, false]);
});
