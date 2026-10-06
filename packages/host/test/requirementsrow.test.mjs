/**
 * The requirements setup row, PINNED byte for byte — written before the check
 * moved out of core into `packages/extensions/requirements/` (a contributed
 * `setupCheck`/`setupFix`), and required to pass unchanged on both sides of the
 * move: the row's words, its place in the checklist, and what the fix writes
 * and says.
 *
 * Fixture repos in a temp dir; `HOME` points at a fake one so the prompt count
 * reads fixture transcripts and the retention sentence reads a fixture
 * `~/.claude/settings.json`. The build command quotes this checkout's absolute
 * path, so the snapshot spells it `<ROOT>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");
const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "waterplane-reqhome-")));
process.env.HOME = fakeHome;

const { inspectRepo, fixRepoCompliance } = await import("../dist/compliance.js");
const { transcriptDirName } = await import("@waterplane/shared");
const { loadSetupForTest } = await import("./setuphelper.mjs");
await loadSetupForTest();

const SNAP = JSON.parse(readFileSync(join(here, "fixtures", "requirements-row.json"), "utf8"));

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function repo(name, { commits = 0 } = {}) {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), `waterplane-req-${name}-`)));
  git(wt, "init", "-q");
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(wt, `f${i}.txt`), String(i));
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", `c${i}`);
  }
  return wt;
}

function prompts(wt, n, file = "s1.jsonl") {
  const dir = join(fakeHome, ".claude", "projects", transcriptDirName(wt));
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      type: "user", timestamp: `2026-09-${String(10 + (i % 15)).padStart(2, "0")}T10:00:${String(i % 60).padStart(2, "0")}.000Z`,
      uuid: `u-${wt.length}-${i}`, sessionId: "abcdef0123", message: { content: `please make the thing number ${i} work properly` },
    }));
  }
  writeFileSync(join(dir, file), lines.join("\n") + "\n");
}

function setUp(wt, state, areas = {}) {
  mkdirSync(join(wt, ".claude", "skills", "requirements"), { recursive: true });
  writeFileSync(join(wt, ".claude", "skills", "requirements", "SKILL.md"), "# requirements\n");
  mkdirSync(join(wt, "docs", "requirements"), { recursive: true });
  if (state) writeFileSync(join(wt, "docs", "requirements", ".state.json"), JSON.stringify(state));
  for (const [f, body] of Object.entries(areas)) writeFileSync(join(wt, "docs", "requirements", f), body);
}

const scrub = (v, wt) => JSON.parse(JSON.stringify(v).split(REPO_ROOT).join("<ROOT>").split(wt).join("<WT>"));

function row(wt) {
  const checks = inspectRepo(wt);
  const i = checks.findIndex((c) => c.id === "requirements");
  return scrub({ row: checks[i] ?? null, before: checks[i - 1]?.id ?? null, after: checks[i + 1]?.id ?? null }, wt);
}

const AREA = [
  "### R-a-001 · requested", "x", "### R-a-002 · shipped", "x", "### R-a-003 · shipped", "x",
  "### R-a-004 · superseded", "x", "### R-a-005 · dropped", "x", "",
].join("\n");

function observe() {
  const out = {};

  // 1. Not set up: a pass carrying the offer.
  const a = repo("none", { commits: 1 });
  out.notSetUp = row(a);

  // 2. Set up, never built: a warn quoting the build command, with the count to read.
  const b = repo("unbuilt", { commits: 2 });
  setUp(b, null);
  prompts(b, 3);
  out.neverBuilt = row(b);

  // 3. Built, a few prompts behind: a pass with the tally.
  const c = repo("built", { commits: 3 });
  // An Android module, so the row's place BETWEEN two core rows is pinned too.
  mkdirSync(join(c, "app"), { recursive: true });
  writeFileSync(join(c, "app", "build.gradle"), 'plugins { id "com.android.application" }\n');
  const sha = git(c, "rev-parse", "HEAD~1");
  setUp(c, { lastRun: "2026-09-01T12:00:00.000Z", promptsThrough: "2026-09-12T00:00:00.000Z", commitsThrough: sha, lastCostUsd: 0.4321 },
    { "area.md": AREA, "README.md": "### R-z-001 · requested\n" });
  prompts(c, 6);
  out.builtFresh = row(c);

  // 4. Built, REQ_STALE_PROMPTS or more behind: a warn saying update, no cost field.
  const d = repo("stale", { commits: 1 });
  setUp(d, { lastRun: "2026-08-01T00:00:00.000Z", promptsThrough: null, commitsThrough: null }, { "area.md": AREA });
  prompts(d, 25);
  out.builtStale = row(d);

  // 5. Retention above 30 days drops the retention sentence.
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 90 }));
  out.builtLongRetention = row(c);
  writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 14 }));
  out.builtShortRetention = row(c);

  // 6. The fix: writes the preset and the index, then is idempotent.
  const e = repo("fix");
  const target = { id: "fx", repoName: "fx", branch: "main", isPrimary: true, worktreePath: e, outboxCount: 0, changedCount: 0 };
  const f1 = fixRepoCompliance(target, ["requirements"]);
  const skill = readFileSync(join(e, ".claude/skills/requirements/SKILL.md"), "utf8");
  const readme = readFileSync(join(e, "docs/requirements/README.md"), "utf8");
  const f2 = fixRepoCompliance(target, ["requirements"]);
  out.fix = scrub({
    first: { ok: f1.ok, applied: f1.applied, notes: f1.notes },
    skill, readme,
    second: { ok: f2.ok, applied: f2.applied, notes: f2.notes },
    rowAfter: f2.report.checks.find((c) => c.id === "requirements"),
    stateWritten: existsSync(join(e, "docs/requirements/.state.json")),
  }, e);
  return out;
}

test("the requirements setup row and fix render byte-identical to the pinned snapshot", () => {
  const got = observe();
  if (process.env.PIN_WRITE) writeFileSync(join(here, "fixtures", "requirements-row.json"), JSON.stringify(got, null, 2) + "\n");
  for (const k of Object.keys(SNAP)) assert.deepEqual(got[k], SNAP[k], k);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(SNAP).sort());
});
