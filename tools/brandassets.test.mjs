// The generated logo outputs are a function of brand/*.svg. A missing output or a changed input
// without a regeneration fails here, the way a stale shared/dist would. Fix: npm run brand:assets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inputsHash } from "../scripts/brand-assets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "brand", "outputs.json"), "utf8"));

test("every recorded logo output exists", () => {
  assert.ok(manifest.outputs.length > 0);
  for (const p of manifest.outputs) assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} is missing: npm run brand:assets`);
});

test("the outputs were generated from the current brand/ inputs", () => {
  assert.equal(manifest.inputs, inputsHash(), "brand/ changed since the last generation: npm run brand:assets");
});

test("hero.svg is outlined: no live text, so it does not depend on fonts", () => {
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "brand", "hero.svg"), "utf8"), /<text\b/);
});

test("the notification glyph, themed icon layer and maskable icon are wired", () => {
  const res = "packages/app/android/app/src/main/res";
  assert.match(fs.readFileSync(path.join(ROOT, res, "mipmap-anydpi-v26/ic_launcher.xml"), "utf8"), /<monochrome /);
  assert.match(fs.readFileSync(path.join(ROOT, "packages/web/public/manifest.webmanifest"), "utf8"), /icon-512-maskable\.png[^}]*maskable/);
  for (const f of ["ShellLinkService", "ShellPullService", "ShellInstallReceiver"]) {
    const j = fs.readFileSync(path.join(ROOT, "packages/app/android/app/src/main/java/dev/waterplane/app", f + ".java"), "utf8");
    assert.doesNotMatch(j, /android\.R\.drawable\.stat_/, f);
  }
});
