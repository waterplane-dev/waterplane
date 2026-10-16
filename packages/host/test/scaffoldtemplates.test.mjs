/**
 * `newRepo({ template })` — the first-app plan's WP1 seeds. Real fs and real `git init`
 * into a temp root, no daemon: files present, placeholders replaced, state files where
 * `BuildManager` / `artifacts.ts` read them, the name validated, containment unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { newRepo, templateName, packageId, TEMPLATES } = await import("../dist/scaffold.js");
const { BRAND } = await import("@waterplane/shared");

const root = () => mkdtempSync(join(tmpdir(), "wp-scaffold-tpl-"));
const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");
const walkText = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkText(p, out);
    else if (!e.name.endsWith(".jar")) out.push(p);
  }
  return out;
};

test("android-hello: files, package id, signing fallback, builds", async () => {
  const r = root();
  const res = await newRepo(r, r, "Hello-Quiet", { template: "android-hello", description: "A tap counter." });
  assert.ok(!("error" in res), JSON.stringify(res));
  const d = res.path;
  assert.ok(d.endsWith("hello-quiet"), "name is lower-cased");
  assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), "1");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" }).trim(), "");

  const pkg = "dev.waterplane.app.helloquiet";
  for (const f of [
    "gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties",
    "settings.gradle.kts", "build.gradle.kts", "app/build.gradle.kts", "app/src/main/AndroidManifest.xml",
    `app/src/main/kotlin/${pkg.split(".").join("/")}/MainActivity.kt`, "CLAUDE.md", ".gitignore", "README.md",
    `${BRAND.sharedDirName}/builds.json`, `${BRAND.stateDirName}/artifacts.json`,
  ]) assert.ok(existsSync(join(d, f)), `missing ${f}`);
  assert.ok(res.files.includes("gradlew"));
  assert.ok(statSync(join(d, "gradlew")).mode & 0o100, "gradlew stays executable");

  assert.match(read(d, "app/build.gradle.kts"), new RegExp(`applicationId = "${pkg.replaceAll(".", "\\.")}"`));
  assert.match(read(d, "app/build.gradle.kts"), /minSdk = 26/);
  assert.match(read(d, "app/build.gradle.kts"), /keystore\.properties/);
  assert.match(read(d, "app/build.gradle.kts"), /signingConfigs\.getByName\("debug"\)/);
  assert.match(read(d, "app/src/main/res/values/strings.xml"), />Hello Quiet</);
  assert.match(read(d, `app/src/main/kotlin/${pkg.split(".").join("/")}/MainActivity.kt`), new RegExp(`^package ${pkg.replaceAll(".", "\\.")}$`, "m"));
  assert.match(read(d, "CLAUDE.md"), /A tap counter\./);
  for (const g of ["keystore.properties", "*.jks", "build/", ".gradle/", "local.properties", `${BRAND.stateDirName}/`]) {
    assert.ok(read(d, ".gitignore").split("\n").includes(g), `.gitignore lacks ${g}`);
  }
  assert.ok(!existsSync(join(d, "keystore.properties")), "no key material is ever seeded");

  const builds = JSON.parse(read(d, `${BRAND.sharedDirName}/builds.json`));
  assert.deepEqual(builds.map((b) => b.id), ["release", "debug"]);
  assert.ok(builds[0].cmd.includes("assembleRelease") && builds[1].cmd.includes("assembleDebug"));
  const policy = JSON.parse(read(d, `${BRAND.stateDirName}/artifacts.json`));
  assert.equal(policy.collect, true);

  for (const f of walkText(d)) assert.ok(!/\{\{\w+\}\}|__PKGPATH__/.test(readFileSync(f, "utf8")), `unreplaced placeholder in ${f}`);
});

test("web-hello: one page, publish build copies to the outbox", async () => {
  const r = root();
  const res = await newRepo(r, r, "my-page", { template: "web-hello" });
  assert.ok(!("error" in res), JSON.stringify(res));
  const d = res.path;
  assert.ok(existsSync(join(d, "index.html")));
  assert.ok(existsSync(join(d, ".claude/outbox")));
  assert.match(read(d, "CLAUDE.md"), /Storage does not work/);
  const builds = JSON.parse(read(d, `${BRAND.sharedDirName}/builds.json`));
  assert.equal(builds.length, 1);
  assert.ok(builds[0].cmd.includes(".claude/outbox/my-page.html"));
  // The build, run as the host would run it, leaves the page where the gallery looks.
  execFileSync("sh", ["-c", builds[0].cmd], { cwd: d });
  assert.equal(read(d, ".claude/outbox/my-page.html"), read(d, "index.html"));
  assert.match(read(d, "index.html"), /<title>My Page<\/title>/);
  for (const f of walkText(d)) assert.ok(!/\{\{\w+\}\}/.test(readFileSync(f, "utf8")), `unreplaced placeholder in ${f}`);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" }).trim(), "");
});

test("name validation and containment", async () => {
  assert.deepEqual(TEMPLATES, ["android-hello", "web-hello"]);
  assert.deepEqual(templateName("My App!"), { name: "my-app" }, "spaces and punctuation fold to hyphens, like every other name");
  for (const bad of ["", "9lives", "x_y", "a.b", "a--b","..", "../x", "a".repeat(41)]) {
    assert.ok("error" in templateName(bad), `templateName accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(packageId("a-b-c"), "dev.waterplane.app.abc");
  assert.equal(packageId("new"), "dev.waterplane.app.newapp");

  const r = root();
  assert.ok("error" in (await newRepo(r, r, "ok-name", { template: "../../etc" })), "unknown template refused");
  assert.ok("error" in (await newRepo(r, r, "..", { template: "web-hello" })));
  const outside = mkdtempSync(join(tmpdir(), "wp-scaffold-out-"));
  const esc = await newRepo(r, outside, "ok-name", { template: "web-hello" });
  assert.ok("error" in esc, "a parent outside the root is refused");
  assert.equal(readdirSync(outside).length, 0);
  const first = await newRepo(r, r, "dup", { template: "web-hello" });
  assert.ok(!("error" in first));
  assert.ok("error" in (await newRepo(r, r, "dup", { template: "web-hello" })), "existing folder refused");
});
