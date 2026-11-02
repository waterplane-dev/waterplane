import { test } from "node:test";
import assert from "node:assert/strict";
import { apkNeedWords, apkOk, cmpVersion } from "./apkGate.ts";

test("versions compare by number, not by text", () => {
  assert.ok(cmpVersion("0.1.10", "0.1.9") > 0);
  assert.equal(cmpVersion("v0.1.8", "0.1.8"), 0);
  assert.equal(cmpVersion("0.1.8-dev", "0.1.8"), 0);
  assert.ok(cmpVersion("0.2", "0.1.9") > 0);
});

test("apkOk: no requirement passes, an older or silent shell does not", () => {
  assert.equal(apkOk(undefined, ""), true);
  assert.equal(apkOk("0.1.8", "0.1.8"), true);
  assert.equal(apkOk("0.1.8", "0.1.9"), true);
  assert.equal(apkOk("0.1.8", "0.1.6"), false);
  assert.equal(apkOk("0.1.8", ""), false);
});

test("the refusal names both versions, or says an older one", () => {
  assert.equal(apkNeedWords("0.1.8", "0.1.6"), "needs the 0.1.8 APK · yours is 0.1.6");
  assert.equal(apkNeedWords("0.1.8", ""), "needs the 0.1.8 APK · yours is an older one");
});

test("the shell-too-old sentence names a place that HAS an APK, per distribution", async () => {
  const { shellApkUrl, shellApkWhere, shellApkWords } = await import("./apkGate.ts");
  assert.equal(shellApkUrl("files", "a.b", "o", "s"), null, "the files tab is a pane, not a link");
  assert.equal(shellApkUrl("release", "a.b", "o", "s"), "https://github.com/o/s/releases/latest");
  assert.match(shellApkUrl("play", "a.b", "o", "s"), /^https:\/\/play\.google\.com\/store\/apps\/details\?id=a\.b$/);
  const self = (version) => ({ pkg: "dev.waterplane.app.dev", version });
  assert.equal(shellApkWhere("play", "dev.waterplane.app", [{ pkg: "dev.waterplane.app", version: "0.2.0" }], "0.1.8"), "play", "Play wins even with an APK in files");
  assert.equal(shellApkWhere("dev", "dev.waterplane.app.dev", [{ pkg: "de.hoh.game", version: "9.9.9" }, self("0.1.9")], "0.1.8"), "files");
  assert.equal(shellApkWhere("dev", "dev.waterplane.app", [{ pkg: "de.hoh.game", version: "9.9.9" }], "0.1.8"), "release", "a build of another app is not the shell's APK");
  assert.equal(shellApkWhere(undefined, undefined, [{}], "0.1.8"), "release", "an old shell that cannot name itself never claims the files tab");
  // "A newer APK is already on the files tab" only when it is: the same or an older shell build, or
  // one whose version was never read, cannot lift the gate.
  assert.equal(shellApkWhere("dev", "dev.waterplane.app.dev", [self("0.1.6")], "0.1.8"), "release", "an older shell build is no way past the gate");
  assert.equal(shellApkWhere("dev", "dev.waterplane.app.dev", [self(undefined)], "0.1.8"), "release", "an unread version is not new enough");
  assert.equal(shellApkWhere("dev", "dev.waterplane.app.dev", [self("0.1.6"), self("0.1.8")], "0.1.8"), "files", "one passing copy is enough");
  assert.doesNotMatch(shellApkWords("release").note, /files tab/);
  assert.doesNotMatch(shellApkWords("play").note, /files tab/);
  for (const w of ["play", "files", "release"]) assert.ok(shellApkWords(w).verb);
});
