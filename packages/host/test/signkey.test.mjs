/**
 * `signkey.ts`: the desktop signing key is made once, mode 600 in a 700 dir, never inside a repo,
 * and a repo gets only a gitignored pointer. Real `keytool` when this machine has a working one
 * (SKIPS in words otherwise), in a temp HOME / config dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "signkey-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
for (const k of Object.keys(process.env)) if (/CONFIG_DIR$/.test(k)) delete process.env[k];
const { findKey, ensureDesktopKey, linkKey, readLink, parseProps, keysDir } = await import("../dist/signkey.js");
const { apkInstallCheck } = await import("../dist/apkcheck.js");

let hasKeytool = true;
try { execFileSync("keytool", ["-help"], { stdio: "ignore" }); } catch { hasKeytool = false; }
if (!hasKeytool) console.log("# SKIP real-keytool test: no working keytool on this machine");
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const repo = () => mkdtempSync(join(tmpdir(), "signkey-repo-"));
const fakeKey = (xdg, props = "storePassword=p\n") => {
  process.env.XDG_CONFIG_HOME = xdg;
  mkdirSync(join(xdg, "waterplane", "keys"), { recursive: true });
  writeFileSync(join(keysDir(), "sideload.jks"), "x");
  writeFileSync(join(keysDir(), "sideload.properties"), props);
};

test("nothing yet: findKey says none, link refuses in words", () => {
  const f = findKey();
  assert.equal(f.best, "none");
  assert.equal(f.desktop.exists, false);
  assert.equal(linkKey(repo()).ok, false);
});

test("the debug key is found and only linked when chosen", () => {
  mkdirSync(join(home, ".android"));
  writeFileSync(join(home, ".android", "debug.keystore"), "x");
  const f = findKey();
  assert.equal(f.best, "none");
  assert.deepEqual(f.available, ["debug"]);
  const d = repo();
  assert.equal(linkKey(d, "debug").ok, true);
  assert.equal(readLink(d), "debug");
  assert.equal(parseProps(readFileSync(join(d, "keystore.properties"), "utf8")).keyAlias, "androiddebugkey");
});

test("create once, modes, idempotent, linked and ignored, never in the repo", { skip: !hasKeytool && "no working keytool on this machine" }, () => {
  const a = ensureDesktopKey();
  assert.equal(a.ok, true, a.error);
  assert.equal(a.created, true);
  const dir = keysDir();
  assert.equal(mode(dir), "700");
  assert.equal(mode(join(dir, "sideload.jks")), "600");
  assert.equal(mode(join(dir, "sideload.properties")), "600");
  const before = readFileSync(join(dir, "sideload.jks"));
  const b = ensureDesktopKey();
  assert.equal(b.ok && b.created, false);
  assert.deepEqual(readFileSync(join(dir, "sideload.jks")), before);

  const d = repo();
  writeFileSync(join(d, ".gitignore"), "node_modules");
  const l = linkKey(d);
  assert.equal(l.ok, true, l.error);
  assert.equal(mode(join(d, "keystore.properties")), "600");
  const p = parseProps(readFileSync(join(d, "keystore.properties"), "utf8"));
  assert.deepEqual(Object.keys(p).sort(), ["keyAlias", "keyPassword", "storeFile", "storePassword"]);
  assert.equal(p.storeFile, join(dir, "sideload.jks"));
  assert.ok(!p.storeFile.startsWith(d));
  assert.equal(readLink(d), "desktop");
  const gi = readFileSync(join(d, ".gitignore"), "utf8").split("\n");
  assert.ok(gi.includes("keystore.properties") && gi.includes("*.jks") && gi.includes("node_modules"));
  assert.equal(existsSync(join(d, "sideload.jks")), false);
  const again = linkKey(d);
  assert.equal(again.ok && again.gitignore.length, 0);
  execFileSync("keytool", ["-list", "-keystore", p.storeFile, "-storepass", p.storePassword], { stdio: "ignore" });
});

test("a jks whose properties are gone is never regenerated over", () => {
  process.env.XDG_CONFIG_HOME = join(home, ".config2");
  mkdirSync(join(home, ".config2", "waterplane", "keys"), { recursive: true });
  writeFileSync(join(keysDir(), "sideload.jks"), "precious");
  assert.equal(findKey().desktop.broken, true);
  const r = ensureDesktopKey({ keytool: "/nonexistent/keytool" });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(join(keysDir(), "sideload.jks"), "utf8"), "precious");
});

test("keytool failure is a sentence and leaves no properties behind", () => {
  process.env.XDG_CONFIG_HOME = join(home, ".config3");
  const r = ensureDesktopKey({ keytool: "/nonexistent/keytool" });
  assert.equal(r.ok, false);
  assert.match(r.error, /keytool could not create/);
  assert.equal(findKey().desktop.exists, false);
  assert.equal(existsSync(join(keysDir(), "sideload.properties")), false);
});

test("a key that would live inside the repo is refused", () => {
  const d = repo();
  fakeKey(join(d, ".cfg"));
  const r = linkKey(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /inside the repo/);
  assert.equal(existsSync(join(d, "keystore.properties")), false);
});

test("apk row: a module reading keystore.properties offers the signing-key fix until linked", () => {
  process.env.XDG_CONFIG_HOME = join(home, ".config4");
  const d = repo();
  mkdirSync(join(d, "app"));
  writeFileSync(join(d, "app", "build.gradle.kts"),
    'plugins { id("com.android.application") }\nval p = file("../keystore.properties")\nandroid { defaultConfig { applicationId = "a.b"; targetSdk = 35 } }');
  const row = apkInstallCheck(d);
  assert.equal(row.fix, "signing-key");
  assert.match(row.detail, /No keystore\.properties/);
  assert.doesNotMatch(row.detail, /debug key/);
  fakeKey(join(home, ".config4"));
  assert.equal(linkKey(d).ok, true);
  const after = apkInstallCheck(d);
  assert.equal(after.fix, null);
  assert.match(after.detail, /this desktop's signing key/);
});
