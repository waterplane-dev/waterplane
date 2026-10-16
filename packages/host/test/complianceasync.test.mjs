/**
 * `inspectRepoAsync` — the setup sweep's inspection, its git asked in the background in two calls
 * instead of one blocking `execFileSync` per path (that froze the host for minutes on WSL over a
 * Windows drive) — must reach exactly the verdicts `inspectRepo` reaches. Compared row by row on
 * the rows that read git: transport dirs ignored or not, tracked under them or not, a tracked
 * `.env`, a legacy state dir with files tracked, and a directory that is not a repo at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY } from "@waterplane/shared";

const { inspectRepo, inspectRepoAsync } = await import("../dist/compliance.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
const GIT_ROWS = ["gitignore-transport", "transport-tracked", "state-dir", "env-gitignored"];
const rows = (checks) => Object.fromEntries(checks.filter((c) => GIT_ROWS.includes(c.id)).map((c) => [c.id, { status: c.status, detail: c.detail, fix: c.fix }]));

function dir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function repo({ ignoreTransport, trackOutbox, trackEnv, legacyTracked, android }) {
  const d = dir("cmpasync-");
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@example.com");
  git(d, "config", "user.name", "t");
  if (ignoreTransport) writeFileSync(join(d, ".gitignore"), ".claude/inbox/\n.claude/outbox/\n.outbox/\n");
  if (trackOutbox) {
    mkdirSync(join(d, ".claude", "outbox"), { recursive: true });
    writeFileSync(join(d, ".claude", "outbox", "shot.png"), "x");
    git(d, "add", "-f", ".claude/outbox/shot.png");
  }
  if (trackEnv) {
    writeFileSync(join(d, ".env.local"), "K=v\n");
    writeFileSync(join(d, ".env.example"), "K=\n");
    git(d, "add", "-f", ".env.local", ".env.example");
  }
  if (legacyTracked) {
    const old = LEGACY[0].stateDirName;
    mkdirSync(join(d, old));
    writeFileSync(join(d, old, "builds.json"), "[]");
    git(d, "add", "-f", `${old}/builds.json`);
  }
  if (android) {
    // An app module (the APK row and the toolchain row) and a build to suggest (builds-configured).
    mkdirSync(join(d, "app", "src", "main"), { recursive: true });
    writeFileSync(join(d, "app", "build.gradle"), "plugins { id 'com.android.application' }\nandroid { defaultConfig { applicationId 'org.example.demo'\n targetSdk 34 } }\n");
    writeFileSync(join(d, "app", "src", "main", "AndroidManifest.xml"), "<manifest/>\n");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "tsc -p .", test: "node --test" } }));
    mkdirSync(join(d, "scripts"));
    writeFileSync(join(d, "scripts", "release.sh"), "#!/bin/sh\necho release\n");
  }
  writeFileSync(join(d, "README.md"), "x\n");
  git(d, "add", "README.md");
  git(d, "commit", "-qm", "init");
  return d;
}

const shapes = {
  "clean (transport ignored, nothing tracked)": { ignoreTransport: true },
  "nothing ignored, an outbox file and a .env tracked": { trackOutbox: true, trackEnv: true },
  "ignored but already tracked, plus a legacy state dir git tracks": { ignoreTransport: true, trackOutbox: true, legacyTracked: true },
  "an Android app module and buildable scripts (the three walks)": { ignoreTransport: true, android: true },
};

for (const [name, shape] of Object.entries(shapes)) {
  test(`complianceasync: the same checklist as the blocking inspection — ${name}`, async () => {
    const d = repo(shape);
    const sync = inspectRepo(d);
    const want = rows(sync);
    assert.ok(Object.keys(want).length >= 3, "the fixture reaches the git rows");
    const got = await inspectRepoAsync(d);
    assert.deepEqual(rows(got), want);
    // Every row, not only git's: the walks (Android, APK modules, build scan) are fetched
    // beforehand too, and must reach the same verdicts in the same order.
    assert.deepEqual(got, sync);
    if (shape.android) {
      for (const id of ["builds-configured", "android-toolchain"]) assert.ok(sync.some((c) => c.id === id), `the fixture reaches ${id}`);
    }
  });
}

test("complianceasync: a directory that is not a repo reads as the blocking inspection does", async () => {
  const d = dir("cmpasync-norepo-");
  writeFileSync(join(d, ".env"), "K=v\n");
  assert.deepEqual(rows(await inspectRepoAsync(d)), rows(inspectRepo(d)));
});
