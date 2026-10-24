// `isExtensionEnabled` / `pickImageTextReader` (sdk/extensions.ts) and the one cache name the
// service worker and an extension must agree on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createStore } from "./store.ts";
import { EXT_CACHE_PREFIX, bindPluginList, enabledIn, extAssetCacheName, extAssetUrl, isExtensionEnabled, pickImageTextReader } from "./extensions.ts";

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
