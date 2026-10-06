/**
 * `toolchain.ts` with fakes only: nothing here downloads, runs brew/unzip/tar/sdkmanager, or
 * touches the real home. The "machine" is a temp directory; the fake `run` and `fetchToFile` create
 * the files the real programs would, so the real probe (`androidenv.ts`) sees what a real install leaves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { probeAndroidEnv } = await import("../dist/androidenv.js");
const { planToolchain, runToolchainInstall, readToolchainState, wantedPackages, cmdlineToolsZip, adoptiumPackage } = await import("../dist/toolchain.js");
const { createHash } = await import("node:crypto");

/** What the fake network serves: every download is these bytes, so its hash is known. */
const BYTES = "bytes";
const BYTES_SHA = createHash("sha256").update(BYTES).digest("hex");
const JDK_TGZ = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21/OpenJDK21U-jdk_aarch64_mac_hotspot_21.tar.gz";

const touch = (p, text = "") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };

function machine({ brew = true, platform = "darwin" } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "toolchain-")));
  const calls = [];
  const fetched = [];
  const logs = [];
  let state = null;
  // Sandboxed: only paths under the temp home exist, so this machine's own brew JDK cannot leak in.
  const mine = (p) => p.startsWith(home);
  const probeDeps = { env: {}, home, platform, exists: (p) => mine(p) && existsSync(p),
    readdir: (p) => { try { return mine(p) ? readdirSync(p) : []; } catch { return []; } },
    readText: (p) => { try { return mine(p) ? readFileSync(p, "utf8") : null; } catch { return null; } }, exec: () => null };
  const sdkRoot = platform === "darwin" ? join(home, "Library", "Android", "sdk") : join(home, "Android", "Sdk");
  const fails = new Set();
  const tmps = [];
  let tmpN = 0;
  const d = {
    env: { PATH: "/usr/bin" }, home, platform, arch: "arm64",
    probe: () => probeAndroidEnv(probeDeps),
    hasBrew: () => brew,
    fetchToFile: async (url, dest) => {
      fetched.push(url);
      if (fails.has("fetch")) throw new Error("network down");
      touch(dest, fails.has("tampered") ? "evil" : BYTES);
    },
    fetchJson: async (url) => {
      fetched.push(url);
      if (fails.has("fetch")) throw new Error("network down");
      return [{ binary: { image_type: "jdk", package: { link: JDK_TGZ, checksum: BYTES_SHA, size: 5 } } }];
    },
    // The real hash of what the fake wrote; the pinned zip "is" BYTES, so its pin maps onto it.
    sha256: async (p) => {
      const h = createHash("sha256").update(readFileSync(p)).digest("hex");
      return h === BYTES_SHA && p.endsWith("cmdline-tools.zip") ? cmdlineToolsZip(platform, "arm64").sha256 : h;
    },
    run: async (cmd, args, o) => {
      calls.push({ cmd, args, input: o.input });
      if (cmd === "sudo") throw new Error("sudo must never be run");
      if (fails.has(cmd)) return 1;
      if (fails.has(`${cmd}-missing`)) throw new Error(`spawn ${cmd} ENOENT`);
      // brew prefixes are absolute, so the fake leaves its JDK where the probe also looks (the own dir).
      if (cmd === "brew") jdkAt(join(d.jdkDir, "brew-jdk"));
      if (cmd === "tar") jdkAt(join(args[3], "jdk-21.0.4+7"));
      if (cmd === "unzip") touch(join(args[4], "cmdline-tools", "bin", "sdkmanager"), "#!/bin/sh");
      if (cmd === "python3") touch(join(args[3], "cmdline-tools", "bin", "sdkmanager"), "#!/bin/sh");
      if (cmd.endsWith("sdkmanager")) {
        if (args.includes("--licenses")) touch(join(sdkRoot, "licenses", "android-sdk-license"), "h");
        if (o.input && !args.includes("--licenses")) { o.onLine("License android-sdk-license:"); touch(join(sdkRoot, "licenses", "android-sdk-license"), "h"); }
        for (const a of args) {
          if (a === "platform-tools") mkdirSync(join(sdkRoot, "platform-tools"), { recursive: true });
          if (a.startsWith("platforms;")) mkdirSync(join(sdkRoot, "platforms", a.split(";")[1]), { recursive: true });
          if (a.startsWith("build-tools;")) mkdirSync(join(sdkRoot, "build-tools", a.split(";")[1]), { recursive: true });
        }
      }
      o.onLine("ok");
      return 0;
    },
    mkdir: (p) => { if (fails.has("mkdir-eacces")) throw new Error("EACCES: permission denied"); mkdirSync(p, { recursive: true }); },
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    rename: (a, b) => renameSync(a, b),
    exists: existsSync,
    readState: () => state, writeState: (t) => { state = t; },
    log: (l) => logs.push(l), now: () => 1,
    privateTmp: () => { const p = join(home, "tmp", `dl-${++tmpN}`); mkdirSync(p, { recursive: true }); tmps.push(p); return p; },
    jdkDir: join(home, ".config", "waterplane", "jdk"),
  };
  function jdkAt(dir) { touch(join(dir, "bin", "java")); touch(join(dir, "release"), 'JAVA_VERSION="21.0.4"\n'); }
  return { d, home, sdkRoot, calls, fetched, logs, fails, tmps };
}

import { readFileSync, readdirSync } from "node:fs";

function fullSdk(root) {
  mkdirSync(join(root, "platforms", "android-36"), { recursive: true });
  mkdirSync(join(root, "build-tools", "35.0.0"), { recursive: true });
  mkdirSync(join(root, "platform-tools"), { recursive: true });
  touch(join(root, "cmdline-tools", "latest", "bin", "sdkmanager"));
  touch(join(root, "licenses", "android-sdk-license"), "h");
}

test("plan skips what is found: a complete SDK and a JDK leave nothing to do", () => {
  const m = machine();
  fullSdk(m.sdkRoot);
  touch(join(m.d.jdkDir, "jdk-21", "bin", "java"));
  touch(join(m.d.jdkDir, "jdk-21", "release"), 'JAVA_VERSION="21.0.4"\n');
  const plan = planToolchain(m.d);
  assert.ok(plan.steps.every((s) => !s.needed), JSON.stringify(plan.steps));
  assert.deepEqual(wantedPackages(m.d.probe()), []);
});

test("plan with only a JDK missing plans only the JDK; the consent names size, place and licence", () => {
  const m = machine();
  fullSdk(m.sdkRoot);
  const plan = planToolchain(m.d);
  assert.deepEqual(plan.steps.filter((s) => s.needed).map((s) => s.id), ["jdk"]);
  assert.match(plan.consent, /developer\.android\.com\/studio\/terms/);
  assert.match(plan.consent, /no sudo/);
});

test("no brew picks the Adoptium tarball into the config dir; brew picks the formula", async () => {
  const nb = machine({ brew: false });
  fullSdk(nb.sdkRoot);
  assert.equal(planToolchain(nb.d).jdkRoute, "tarball");
  const r = await runToolchainInstall({}, nb.d);
  assert.match(nb.fetched[0], /api\.adoptium\.net\/v3\/assets\/latest\/21\/hotspot\?os=mac&architecture=aarch64/);
  assert.equal(nb.fetched[1], JDK_TGZ, "the tarball is the one the listing named");
  assert.ok(nb.logs.some((l) => /\[jdk\] sha256 verified/.test(l)));
  assert.deepEqual(nb.calls.map((c) => c.cmd), ["tar"]);
  assert.ok(r.ok, r.summary);

  const b = machine({ brew: true });
  assert.equal(planToolchain(b.d).jdkRoute, "brew");
  await runToolchainInstall({}, b.d);
  const brew = b.calls.find((c) => c.cmd === "brew");
  assert.deepEqual(brew.args, ["install", "openjdk@21"]);
  assert.equal(b.fetched.length > 0 && b.fetched.some((u) => u.includes("adoptium")), false);
});

test("licences are refused without the consent flag: no yes is fed, packages are not installed", async () => {
  const m = machine({ brew: false });
  const r = await runToolchainInstall({}, m.d);
  const lic = r.steps.find((s) => s.id === "licences");
  assert.equal(lic.status, "needs-consent");
  assert.equal(r.ok, false);
  assert.ok(!m.calls.some((c) => c.cmd.endsWith("sdkmanager")), "sdkmanager must not run");
  assert.ok(!m.calls.some((c) => c.input), "nothing was fed to any program");
  assert.equal(r.steps.find((s) => s.id === "sdk-packages"), undefined);
  assert.match(r.summary, /licences/);
});

test("with the consent flag only the package install gets y, so only its licences are accepted, and the step names them", async () => {
  const m = machine({ brew: false });
  const r = await runToolchainInstall({ acceptLicences: true }, m.d);
  assert.ok(!m.calls.some((c) => c.args.includes("--licenses")), "never the blanket --licenses");
  const pk = m.calls.find((c) => c.args.includes("platform-tools"));
  assert.deepEqual(pk.args.slice(1), ["platform-tools", "platforms;android-36", "build-tools;35.0.0"]);
  assert.match(pk.input, /^(y\n)+$/);
  const lic = r.steps.find((s) => s.id === "licences");
  assert.equal(lic.status, "done");
  assert.match(lic.note, /accepted android-sdk-license/);
  assert.ok(r.ok, r.summary);
  assert.equal(r.report.missing.length, 0);
  assert.ok(m.fetched.some((u) => /dl\.google\.com\/android\/repository\/commandlinetools-mac_arm64-\d+_latest\.zip/.test(u)));
});

test("every package present but no licence ever accepted: the person gets the command, nothing says yes for them", async () => {
  const m = machine({ brew: false });
  fullSdk(m.sdkRoot);
  rmSync(join(m.sdkRoot, "licenses"), { recursive: true, force: true });
  touch(join(m.d.jdkDir, "jdk-21", "bin", "java"));
  touch(join(m.d.jdkDir, "jdk-21", "release"), 'JAVA_VERSION="21.0.4"\n');
  const r = await runToolchainInstall({ acceptLicences: true }, m.d);
  const lic = r.steps.find((s) => s.id === "licences");
  assert.equal(lic.status, "needs-you");
  assert.match(lic.command, /sdkmanager --sdk_root=.* --licenses$/);
  assert.ok(!m.calls.some((c) => c.input), "nothing was fed to any program");
});

test("resume after a failed step: the second run does only the rest", async () => {
  const m = machine({ brew: false });
  m.fails.add("fetch");
  const first = await runToolchainInstall({ acceptLicences: true }, m.d);
  assert.equal(first.steps[0].id, "jdk");
  assert.equal(first.steps[0].status, "failed");
  assert.match(first.steps[0].note, /network down/);
  assert.equal(first.steps.length, 1, "stops at the failure");
  assert.equal(readToolchainState(m.d).steps.jdk.status, "failed");

  m.fails.delete("fetch");
  m.calls.length = 0;
  const second = await runToolchainInstall({ acceptLicences: true }, m.d);
  assert.ok(second.ok, second.summary);
  // Run it once more: everything is found now, nothing is fetched or run.
  m.calls.length = 0; m.fetched.length = 0;
  const third = await runToolchainInstall({ acceptLicences: true }, m.d);
  assert.ok(third.ok);
  assert.deepEqual(third.steps.map((s) => s.status), ["skipped", "skipped", "skipped", "skipped"]);
  assert.equal(m.calls.length + m.fetched.length, 0);
});

test("a step that needs sudo yields the command for the person, never a run", async () => {
  const m = machine({ brew: false });
  touch(join(m.d.jdkDir, "jdk-21", "bin", "java"));
  touch(join(m.d.jdkDir, "jdk-21", "release"), 'JAVA_VERSION="21.0.4"\n');
  m.fails.add("mkdir-eacces");
  const r = await runToolchainInstall({ acceptLicences: true }, m.d);
  const s = r.steps.find((x) => x.id === "cmdline-tools");
  assert.equal(s.status, "needs-you");
  assert.match(s.command, /^sudo mkdir -p .*Android/);
  assert.ok(!m.calls.some((c) => c.cmd === "sudo"), "sudo was not run");
  assert.equal(r.ok, false);
  assert.match(r.summary, /Run: sudo/);
});

test("a download whose SHA-256 differs is deleted and never unpacked", async () => {
  const m = machine({ brew: false });
  m.fails.add("tampered");
  const r = await runToolchainInstall({ acceptLicences: true }, m.d);
  assert.equal(r.steps[0].id, "jdk");
  assert.equal(r.steps[0].status, "failed");
  assert.match(r.steps[0].note, /checksum mismatch/);
  assert.ok(!m.calls.some((c) => c.cmd === "tar"), "tar must not run on unverified bytes");
  assert.ok(m.tmps.length > 0 && m.tmps.every((p) => !existsSync(p)), "the bad download, and its private dir, are deleted");

  // The SDK zip the same way: JDK present, zip tampered.
  const z = machine({ brew: false });
  touch(join(z.d.jdkDir, "jdk-21", "bin", "java"));
  touch(join(z.d.jdkDir, "jdk-21", "release"), 'JAVA_VERSION="21.0.4"\n');
  z.fails.add("tampered");
  const rz = await runToolchainInstall({ acceptLicences: true }, z.d);
  const s = rz.steps.find((x) => x.id === "cmdline-tools");
  assert.equal(s.status, "failed");
  assert.match(s.note, /checksum mismatch/);
  assert.ok(!z.calls.some((c) => c.cmd === "unzip"), "unzip must not run on unverified bytes");
});

test("no unzip on the desktop: the SDK zip is extracted with python3, and with neither the step says what to install", async () => {
  const m = machine({ brew: false });
  touch(join(m.d.jdkDir, "jdk-21", "bin", "java"));
  touch(join(m.d.jdkDir, "jdk-21", "release"), 'JAVA_VERSION="21.0.4"\n');
  m.fails.add("unzip-missing");
  const r = await runToolchainInstall({ acceptLicences: true }, m.d);
  assert.equal(r.steps.find((x) => x.id === "cmdline-tools").status, "done");
  assert.ok(m.calls.some((c) => c.cmd === "python3"));
  assert.ok(existsSync(join(m.sdkRoot, "cmdline-tools", "latest", "bin", "sdkmanager")));

  const n = machine({ brew: false });
  touch(join(n.d.jdkDir, "jdk-21", "bin", "java"));
  touch(join(n.d.jdkDir, "jdk-21", "release"), 'JAVA_VERSION="21.0.4"\n');
  n.fails.add("unzip-missing");
  n.fails.add("python3-missing");
  const rn = await runToolchainInstall({ acceptLicences: true }, n.d);
  const s = rn.steps.find((x) => x.id === "cmdline-tools");
  assert.equal(s.status, "failed");
  assert.match(s.note, /neither unzip nor python3.*apt install unzip/);
});

test("the Adoptium listing must name a tarball AND its checksum, or nothing is downloaded", () => {
  assert.throws(() => adoptiumPackage([{ binary: { image_type: "jdk", package: { link: "https://x/jdk.tar.gz" } } }]), /SHA-256/);
  assert.throws(() => adoptiumPackage([{ binary: { image_type: "jdk", package: { link: "http://x/jdk.tar.gz", checksum: BYTES_SHA } } }]), /SHA-256/);
  assert.throws(() => adoptiumPackage(null), /no JDK 21/);
  assert.equal(adoptiumPackage([{ binary: { image_type: "jre", package: { link: "https://x/jre.tar.gz", checksum: BYTES_SHA } } },
    { binary: { image_type: "jdk", package: { link: "https://x/jdk.tar.gz", checksum: BYTES_SHA } } }]).link, "https://x/jdk.tar.gz");
});

test("the pins are the template's: an SDK with only another platform still needs android-36 and build-tools 35.0.0", () => {
  const m = machine();
  fullSdk(m.sdkRoot);
  rmSync(join(m.sdkRoot, "platforms", "android-36"), { recursive: true });
  mkdirSync(join(m.sdkRoot, "platforms", "android-34"), { recursive: true });
  assert.deepEqual(wantedPackages(m.d.probe()), ["platforms;android-36"]);
  const tpl = readFileSync(new URL("../templates/android-hello/app/build.gradle.kts", import.meta.url), "utf8");
  assert.match(tpl, /compileSdk = 36/);
  assert.match(tpl, /buildToolsVersion = "35\.0\.0"/);
});

test("the planned size is derived from what the needed steps fetch, not a constant", () => {
  const all = machine({ brew: false });
  const big = planToolchain(all.d).installBytes;
  const jdkOnly = machine({ brew: false });
  fullSdk(jdkOnly.sdkRoot);
  const small = planToolchain(jdkOnly.d).installBytes;
  assert.ok(big > small && small > 0, `${big} > ${small} > 0`);
  assert.ok(big >= cmdlineToolsZip("darwin", "arm64").bytes, "includes the pinned zip's real size");
  assert.match(planToolchain(all.d).consent, /About \d/);
});

test("the real download dir is fresh, private and owned; a pre-placed file or symlink is never written through", async () => {
  const { privateTmpUnder, exclusiveWriteStream } = await import("../dist/toolchain.js");
  const { statSync, symlinkSync, readFileSync: rf, lstatSync } = await import("node:fs");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "toolchain-priv-")));
  const a = privateTmpUnder(join(base, "data"));
  const b = privateTmpUnder(join(base, "data"));
  assert.notEqual(a, b, "every download gets its own dir");
  assert.ok(a.startsWith(join(base, "data")), "under the per-user data dir, never os.tmpdir()");
  assert.equal(statSync(a).mode & 0o777, 0o700);
  assert.equal(statSync(a).uid, process.getuid());

  // A symlink planted where the download goes: O_EXCL refuses it, the target is untouched.
  const victim = join(base, "victim");
  writeFileSync(victim, "keep");
  symlinkSync(victim, join(a, "jdk21.tar.gz"));
  const s = exclusiveWriteStream(join(a, "jdk21.tar.gz"));
  const err = await new Promise((resolve) => { s.on("error", resolve); s.on("open", () => resolve(null)); });
  assert.equal(err?.code, "EEXIST");
  assert.equal(rf(victim, "utf8"), "keep");
  assert.ok(lstatSync(join(a, "jdk21.tar.gz")).isSymbolicLink());
  const ok = exclusiveWriteStream(join(b, "fresh.zip"));
  await new Promise((resolve, reject) => { ok.on("error", reject); ok.end("x", resolve); });
  assert.equal(statSync(join(b, "fresh.zip")).mode & 0o777, 0o600);
});
