/**
 * `onboard.ts` on fakes only: nothing is downloaded, no gradle runs, no key is made, no repo is
 * written. The "machine" is a set of paths that exist and a log of every call, so the tests can
 * say which step did what, in which order, and that a resumed job does not do it twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

const { OnboardManager, planOnboard, tildeText, ANDROID_FIRST_BUILD_WORDS } = await import("../dist/onboard.js");

const ROOT = "/fake/root";

function machine({ toolchainNeeded = true, keyExists = false, buildOutcome = "done", env = {} } = {}) {
  const calls = [];
  const paths = new Set();
  const files = new Map();
  let state = null;
  const frames = [];
  const runs = new Map();
  const sdkRoot = "/fake/home/Library/Android/sdk";
  const jdkHome = "/fake/home/.config/waterplane/jdk/jdk-21/Contents/Home";
  const m = {
    toolchainNeeded, keyExists, buildOutcome,
    /** A build run that stays `running` until the test finishes it. */
    holdBuild: false,
  };
  const report = () => ({
    jdk: m.toolchainNeeded ? null : { home: jdkHome, source: "own", major: 21 },
    jdkTooOld: null,
    sdk: m.toolchainNeeded ? null : { root: sdkRoot, source: "default", platforms: ["android-36"], buildTools: ["35.0.0"], cmdlineTools: true, platformTools: true, licensesAccepted: true },
    missing: m.toolchainNeeded ? ["jdk", "sdk"] : [], installBytes: m.toolchainNeeded ? 500e6 : 0, summary: m.toolchainNeeded ? "Missing: everything" : null,
  });
  const builds = new Map(); // repoDir -> configs
  const d = {
    root: ROOT,
    now: () => 1000,
    readState: () => state,
    writeState: (t) => { state = t; },
    emit: (job) => frames.push(job),
    env,
    exists: (p) => paths.has(p),
    readText: (p) => files.get(p) ?? null,
    writeText: (p, t) => { calls.push(["writeText", p]); files.set(p, t); },
    sleep: () => new Promise((r) => setImmediate(r)),
    probe: () => { calls.push(["probe"]); return report(); },
    planToolchain: () => {
      const n = m.toolchainNeeded;
      return {
        steps: [{ id: "jdk", needed: n, what: "a JDK 21" }, { id: "cmdline-tools", needed: n, what: "the cmdline tools" }],
        installBytes: n ? 523_000_000 : 0, consent: "Install stuff. About 500 MB.", jdkDir: "/fake/jdk", sdkRoot, jdkRoute: "tarball",
      };
    },
    runToolchain: async (o) => {
      calls.push(["runToolchain", o.acceptLicences]);
      if (m.toolchainResult) return m.toolchainResult;
      m.toolchainNeeded = false;
      return { ok: true, steps: [{ id: "jdk", status: "done", note: "ok", at: 1 }], report: report(), summary: "The Android toolchain is ready." };
    },
    key: () => ({ exists: m.keyExists, broken: false, jks: "/fake/keys/sideload.jks", dir: "/fake/keys" }),
    ensureKey: (o) => { calls.push(["ensureKey", o.keytool ?? null]); const created = !m.keyExists; m.keyExists = true; return { ok: true, created, jks: "/fake/keys/sideload.jks", note: created ? "created the key" : "key already there" }; },
    linkKey: (repo) => { calls.push(["linkKey", repo]); return { ok: true, kind: "desktop", file: join(repo, "keystore.properties"), gitignore: [], note: "linked" }; },
    newRepo: async (root, parent, name, opts) => {
      calls.push(["newRepo", name, opts.template, opts.description ?? null]);
      const path = join(root, name);
      paths.add(path); paths.add(join(path, ".git"));
      builds.set(path, opts.template === "android-hello"
        ? [{ id: "release", name: "Release APK", cmd: "./gradlew --console=plain assembleRelease" }, { id: "debug", name: "Debug APK", cmd: "./gradlew --console=plain assembleDebug" }]
        : [{ id: "publish", name: "Publish page", cmd: `mkdir -p .claude/outbox && cp index.html .claude/outbox/${name}.html` }]);
      return { path, branch: "main", files: ["a", "b"] };
    },
    repoId: (dir) => `id:${dir}`,
    setup: (repoDir) => { calls.push(["setup", repoDir]); return { ok: true, applied: [], notes: [] }; },
    builds: {
      list: (r) => builds.get(r) ?? [],
      save: (r, b) => { calls.push(["saveBuilds", b.map((x) => x.cmd)]); builds.set(r, b); return b; },
      run: (r, id) => {
        calls.push(["build", id]);
        const runId = `br_${runs.size + 1}`;
        const cfg = builds.get(r).find((b) => b.id === id);
        const run = { runId, repoDir: r, buildId: id, name: cfg.name, cmd: cfg.cmd, cwd: r, status: "running", exitCode: null, startedAt: 1000 };
        runs.set(runId, run);
        return run;
      },
      get: (runId) => {
        const run = runs.get(runId);
        if (!run) return null;
        if (run.status === "running" && !m.holdBuild) {
          const apk = run.buildId === "release";
          Object.assign(run, m.buildOutcome === "done"
            ? { status: "done", exitCode: 0, finishedAt: 4000, artifacts: [{ repoId: "x", name: "a", relPath: apk ? `.claude/outbox/app-release.apk` : "x.txt", size: 9 }] }
            : { status: "failed", exitCode: 1, finishedAt: 4000 });
          if (!apk && m.buildOutcome === "done") paths.add(join(run.repoDir, ".claude/outbox", `${run.repoDir.split("/").pop()}.html`));
        }
        return { ...run };
      },
    },
    openSession: async (o) => { calls.push(["openSession", o.prompt ?? null, o.intentId]); return o.prompt ? { sessionId: "s1", intentId: o.intentId, note: "opened with prompt" } : { sessionId: "s1", note: "opened" }; },
  };
  return { d, m, calls, paths, files, frames, runs, getState: () => state, setState: (s) => { state = s; } };
}

const ANDROID = { name: "Hello-Quiet", path: "android", description: "a tip calculator" };
const ALL = { repo: true, toolchain: true, signingKey: true, installApps: true, session: true };
const names = (calls) => calls.map((c) => c[0]).filter((n) => n !== "probe" && n !== "writeText");

test("plan: android lists the toolchain line with a derived size and the licence link, and the key line", () => {
  const mm = machine();
  const plan = planOnboard(ANDROID, mm.d);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.name, "hello-quiet");
  assert.equal(plan.folder, join(ROOT, "hello-quiet"));
  assert.deepEqual(plan.steps.map((s) => s.id), ["probe", "toolchain", "scaffold", "signing-key", "setup", "build", "session"]);
  const tc = plan.consent.find((l) => l.id === "toolchain");
  assert.equal(tc.bytes, 523_000_000, "the size is the toolchain plan's, not a constant");
  assert.match(tc.what, /about 500 MB to download/);
  assert.equal(tc.link, "https://developer.android.com/studio/terms");
  assert.ok(plan.consent.find((l) => l.id === "signingKey").required);
  assert.equal(plan.steps.find((s) => s.id === "build").what, ANDROID_FIRST_BUILD_WORDS);
  assert.match(ANDROID_FIRST_BUILD_WORDS, /about 5 minutes/);
  assert.equal(plan.firstPrompt, "a tip calculator");
});

test("plan: a folder under the home is SAID from ~, and only said so — folder and job paths stay absolute", () => {
  const mm = machine({ toolchainNeeded: false, keyExists: true });
  mm.d.home = "/fake";
  const plan = planOnboard({ name: "hello-otter", path: "web" }, mm.d);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.folder, join(ROOT, "hello-otter"), "the folder the job acts on is absolute");
  const repo = plan.consent.find((l) => l.id === "repo");
  assert.equal(repo.what, "Create ~/root/hello-otter and a git repo in it");
  assert.equal(repo.where, "~/root/hello-otter");
  assert.match(plan.steps.find((s) => s.id === "scaffold").what, /^Create ~\/root\/hello-otter from/);
  // A path that merely STARTS with the home's letters is not under it.
  assert.equal(tildeText("/fakery/x and /fake", "/fake"), "/fakery/x and /fake");
  assert.equal(tildeText("/fake", "/fake/"), "~");
  assert.equal(tildeText("/fake/a", undefined), "/fake/a");
  assert.equal(tildeText("/a", "/"), "/a");
});

test("plan: nothing to install and a key already there leaves only repo, phone and session lines", () => {
  const mm = machine({ toolchainNeeded: false, keyExists: true });
  const plan = planOnboard(ANDROID, mm.d);
  assert.deepEqual(plan.consent.map((l) => l.id), ["repo", "installApps", "session"]);
  assert.equal(plan.steps.find((s) => s.id === "toolchain").needed, false);
});

test("plan: web has no toolchain, key or install line; a taken folder and a bad name are refused in words", () => {
  const mm = machine();
  const plan = planOnboard({ name: "page", path: "web" }, mm.d);
  assert.deepEqual(plan.steps.map((s) => s.id), ["scaffold", "setup", "build", "session"]);
  assert.deepEqual(plan.consent.map((l) => l.id), ["repo", "session"]);
  assert.ok(!mm.calls.some((c) => c[0] === "probe"), "the web plan does not probe for Android tools");
  mm.paths.add(join(ROOT, "page"));
  assert.match(planOnboard({ name: "page", path: "web" }, mm.d).error, /already exists/);
  assert.match(planOnboard({ name: "9lives", path: "web" }, mm.d).error, /letters, digits and hyphens/);
});

test("consent refusal: a start without a required tick does nothing and names what is missing", () => {
  const mm = machine();
  const ob = new OnboardManager(mm.d);
  const r = ob.start(ANDROID, { repo: true, session: true, signingKey: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.deepEqual(r.missing, ["toolchain"]);
  assert.match(r.error, /not consented/);
  assert.equal(ob.current(), null);
  assert.deepEqual(names(mm.calls), [], "nothing ran");
  assert.equal(mm.getState(), null, "nothing was written");
  const r2 = ob.start({ name: "page", path: "web" }, { session: true });
  assert.deepEqual(r2.missing, ["repo"]);
});

test("android: step order, the toolchain gets the licence consent, keytool comes from the probed JDK", async () => {
  const mm = machine();
  const keytool = "/fake/home/.config/waterplane/jdk/jdk-21/Contents/Home/bin/keytool";
  mm.paths.add(keytool); // the JDK the toolchain step installs, not on PATH
  const ob = new OnboardManager(mm.d);
  const r = ob.start(ANDROID, ALL);
  assert.equal(r.ok, true, r.error);
  await ob.idle();
  const job = ob.current();
  assert.equal(job.state, "done", job.summary);
  assert.deepEqual(job.steps.map((s) => [s.id, s.status]), [
    ["probe", "done"], ["toolchain", "done"], ["scaffold", "done"], ["signing-key", "done"], ["setup", "done"], ["build", "done"], ["session", "done"],
  ]);
  assert.deepEqual(names(mm.calls), ["runToolchain", "newRepo", "ensureKey", "linkKey", "setup", "saveBuilds", "build", "openSession"]);
  assert.equal(mm.calls.find((c) => c[0] === "runToolchain")[1], true);
  assert.equal(mm.calls.find((c) => c[0] === "ensureKey")[1], keytool);
  assert.equal(job.artifact, ".claude/outbox/app-release.apk");
  assert.deepEqual(mm.calls.find((c) => c[0] === "openSession").slice(1), ["a tip calculator", `${job.id}-session`]);
  assert.equal(job.sessionId, "s1");
  assert.ok(mm.frames.length >= 8, "a frame per transition");
  assert.equal(JSON.parse(mm.getState()).state, "done", "persisted");
});

test("android build is pointed at the found toolchain when the host env names none (local.properties, JAVA_HOME)", async () => {
  const mm = machine({ toolchainNeeded: false, keyExists: true });
  const ob = new OnboardManager(mm.d);
  ob.start(ANDROID, { repo: true, session: true });
  await ob.idle();
  const repo = join(ROOT, "hello-quiet");
  assert.match(mm.files.get(join(repo, "local.properties")), /^sdk\.dir=\/fake\/home\/Library\/Android\/sdk$/m);
  const saved = mm.calls.find((c) => c[0] === "saveBuilds")[1];
  assert.ok(saved.every((cmd) => cmd.startsWith("JAVA_HOME='/fake/home/.config/waterplane/jdk/jdk-21/Contents/Home' ./gradlew")), saved.join("\n"));

  const set = machine({ toolchainNeeded: false, keyExists: true, env: { JAVA_HOME: "/j", ANDROID_HOME: "/a" } });
  const ob2 = new OnboardManager(set.d);
  ob2.start(ANDROID, { repo: true, session: true });
  await ob2.idle();
  assert.ok(!set.calls.some((c) => c[0] === "saveBuilds" || c[0] === "writeText"), "a host env that names both is left alone");
});

test("web: no probe, toolchain or key; the page in the outbox is the artifact; no description opens a bare session", async () => {
  const mm = machine();
  const ob = new OnboardManager(mm.d);
  const r = ob.start({ name: "page", path: "web" }, { repo: true, session: true });
  assert.equal(r.ok, true, r.error);
  await ob.idle();
  const job = ob.current();
  assert.equal(job.state, "done", job.summary);
  assert.deepEqual(names(mm.calls), ["newRepo", "setup", "build", "openSession"]);
  assert.ok(!mm.calls.some((c) => c[0] === "probe"));
  assert.equal(job.artifact, ".claude/outbox/page.html");
  assert.equal(mm.calls.find((c) => c[0] === "openSession")[1], null, "no first prompt typed when nothing was described");
  assert.ok(job.suggestedPrompt.length > 10);
});

test("session not consented: the step is skipped in words and nothing opens", async () => {
  const mm = machine();
  const ob = new OnboardManager(mm.d);
  ob.start({ name: "page", path: "web" }, { repo: true });
  await ob.idle();
  const s = ob.current().steps.find((x) => x.id === "session");
  assert.equal(s.status, "skipped");
  assert.match(s.note, /not consented/);
  assert.ok(!mm.calls.some((c) => c[0] === "openSession"));
});

test("resume after a restart mid-build: nothing before the build runs again, the build re-runs once", async () => {
  const mm = machine({ toolchainNeeded: false, keyExists: true });
  mm.m.holdBuild = true;
  const ob = new OnboardManager(mm.d);
  ob.start(ANDROID, { repo: true, session: true });
  // Let it reach the build and park there (the run never finishes while held).
  for (let i = 0; i < 50 && !ob.current().buildRunId; i++) await new Promise((r) => setImmediate(r));
  const saved = JSON.parse(mm.getState());
  assert.equal(saved.steps.find((s) => s.id === "build").status, "running");
  assert.equal(saved.buildRunId, "br_1");

  // "Restart": a new manager over the same persisted state; the store failed the orphaned run
  // ("the host restarted while this build was running").
  mm.runs.get("br_1").status = "failed";
  mm.m.holdBuild = false;
  mm.calls.length = 0;
  const ob2 = new OnboardManager(mm.d);
  assert.equal(ob2.boot(), true, "a running job resumes on boot");
  await ob2.idle();
  const job = ob2.current();
  assert.equal(job.state, "done", job.summary);
  assert.deepEqual(names(mm.calls), ["build", "openSession"], "scaffold, key and setup were not repeated");
  assert.equal(job.buildRunId, "br_2");
  // A finished job does not resume a second time.
  assert.equal(new OnboardManager(mm.d).boot(), false);
});

test("resume after a restart mid-scaffold: the folder it made is adopted, never made twice", async () => {
  const mm = machine();
  const ob = new OnboardManager(mm.d);
  ob.start({ name: "page", path: "web" }, { repo: true, session: true });
  await ob.idle();
  const done = JSON.parse(mm.getState());
  // Rewind the persisted job to "scaffold was running" with the folder already on disk.
  for (const s of done.steps) s.status = s.id === "scaffold" ? "running" : "pending";
  done.state = "running"; delete done.repoDir; delete done.buildRunId; delete done.artifact;
  mm.setState(JSON.stringify(done));
  mm.calls.length = 0;
  const ob2 = new OnboardManager(mm.d);
  ob2.boot();
  await ob2.idle();
  assert.equal(ob2.current().state, "done");
  assert.ok(!mm.calls.some((c) => c[0] === "newRepo"), "newRepo is not called over an existing repo");
  assert.match(ob2.current().steps.find((s) => s.id === "scaffold").note, /already there/);
  assert.equal(ob2.current().repoDir, join(ROOT, "page"));
});

test("idempotence: a found toolchain is skipped, an existing key is linked, not made again", async () => {
  const mm = machine({ toolchainNeeded: false, keyExists: true });
  const ob = new OnboardManager(mm.d);
  ob.start(ANDROID, { repo: true, session: true });
  await ob.idle();
  const job = ob.current();
  assert.equal(job.steps.find((s) => s.id === "toolchain").status, "skipped");
  assert.ok(!mm.calls.some((c) => c[0] === "runToolchain"));
  assert.match(job.steps.find((s) => s.id === "signing-key").note, /already there/);
});

test("a stop names its fix; resume carries on from that step with consent only ever added", async () => {
  const mm = machine({ keyExists: true });
  mm.m.toolchainResult = { ok: false, steps: [{ id: "cmdline-tools", status: "needs-you", note: "cannot create the SDK root", command: "sudo mkdir -p /x", at: 1 }], report: {}, summary: "Stopped" };
  const ob = new OnboardManager(mm.d);
  ob.start(ANDROID, { repo: true, toolchain: true, session: true });
  await ob.idle();
  let job = ob.current();
  assert.equal(job.state, "stopped");
  const tc = job.steps.find((s) => s.id === "toolchain");
  assert.equal(tc.status, "needs-you");
  assert.equal(tc.command, "sudo mkdir -p /x");
  assert.match(job.summary, /Run: sudo mkdir -p \/x/);
  assert.ok(!mm.calls.some((c) => c[0] === "newRepo"), "nothing after the stop ran");
  assert.ok(!mm.calls.some((c) => c[0] === "sudo"));

  delete mm.m.toolchainResult;
  const r = ob.resume({ toolchain: false, signingKey: true });
  assert.equal(r.ok, true);
  await ob.idle();
  job = ob.current();
  assert.equal(job.state, "done", job.summary);
  assert.equal(job.consent.toolchain, true, "a resume cannot take a tick back");
  assert.equal(job.consent.signingKey, true, "a resume can add one");
});

test("a failed build stops with the do-it-yourself command", async () => {
  const mm = machine({ buildOutcome: "failed" });
  const ob = new OnboardManager(mm.d);
  ob.start({ name: "page", path: "web" }, { repo: true, session: true });
  await ob.idle();
  const job = ob.current();
  assert.equal(job.state, "stopped");
  const b = job.steps.find((s) => s.id === "build");
  assert.equal(b.status, "failed");
  assert.match(b.note, /exit 1/);
  assert.match(b.command, /^cd \/fake\/root\/page && mkdir -p \.claude\/outbox/);
  assert.ok(!mm.calls.some((c) => c[0] === "openSession"));
});
