/**
 * Opt-in probes (`optins.ts`): fixture repos in a temp dir, a fake
 * `standingPrompts`, the prefs round-trip — and that none of it reaches the
 * setup checklist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPT_INS, optInMarker } from "@waterplane/shared";

const { inspectOptIns, standingPromptsOf } = await import("../dist/optins.js");
const { SetupPrefsStore, setSetupPrefsStore, setOptInChoice, optInChoices } = await import("../dist/setupprefs.js");
const { inspectRepo } = await import("../dist/compliance.js");

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const tmp = (n) => realpathSync(mkdtempSync(join(tmpdir(), `wp-optin-${n}-`)));
function repo(n, { init = true } = {}) {
  const wt = tmp(n);
  if (init) git(wt, "init", "-q");
  return wt;
}
const put = (wt, rel, text) => { mkdirSync(join(wt, rel, ".."), { recursive: true }); writeFileSync(join(wt, rel), text); };
const commit = (wt) => { git(wt, "add", "."); git(wt, "commit", "-q", "-m", "x"); };
const deps = (o = {}) => ({ standingPrompts: () => [], fixIds: () => ["requirements"], choices: () => ({}), ...o });
const row = (wt, id, d) => inspectOptIns(wt, d ?? deps()).find((r) => r.id === id);

test("one row per catalog entry, in order", () => {
  const rows = inspectOptIns(repo("all"), deps());
  assert.deepEqual(rows.map((r) => r.id), OPT_INS.map((d) => d.id));
  for (const r of rows) assert.ok(r.detail.length > 0);
});

test("requirements: unfit without the fix, off, then on", () => {
  const wt = repo("req");
  const u = row(wt, "requirements", deps({ fixIds: () => [] }));
  assert.equal(u.relevant, false);
  assert.match(u.detail, /not loaded/);
  assert.equal(row(wt, "requirements").state, "off");
  put(wt, ".claude/skills/requirements/SKILL.md", "# r");
  const on = row(wt, "requirements");
  assert.equal(on.state, "on");
  assert.equal(on.relevant, true);
});

test("repo-health-own: uncommitted is off, committed with readings is on", () => {
  const wt = repo("own");
  const r0 = row(wt, "repo-health-own");
  if (!r0.relevant) return; // engine unavailable in this checkout: the unfit path
  assert.equal(r0.state, "off");
  put(wt, ".waterplane-shared/health.json", JSON.stringify({ readings: [{ key: "a" }] }));
  const r1 = row(wt, "repo-health-own");
  assert.equal(r1.state, "off");
  assert.match(r1.detail, /not committed/);
  commit(wt);
  assert.equal(row(wt, "repo-health-own").state, "on");
  put(wt, ".waterplane-shared/health.json", JSON.stringify({ readings: [] }));
  commit(wt);
  assert.equal(row(wt, "repo-health-own").state, "off");
  put(wt, ".waterplane-shared/health.json", "{nope");
  commit(wt);
  assert.equal(row(wt, "repo-health-own").state, "unknown");
});

test("security-review: marker through standingPrompts; null is unknown", () => {
  const wt = repo("sec");
  assert.equal(row(wt, "security-review").state, "off");
  assert.equal(row(wt, "security-review", deps({ standingPrompts: () => ["do it\n" + optInMarker("security-review")] })).state, "on");
  assert.equal(row(wt, "security-review", deps({ standingPrompts: () => ["other " + optInMarker("local-ci")] })).state, "off");
  assert.equal(row(wt, "security-review", deps({ standingPrompts: () => null })).state, "unknown");
});

test("standingPromptsOf keeps live recurring prompt schedules of this worktree only", () => {
  const wt = repo("sp");
  const other = repo("sp2");
  const weekly = { kind: "weekly", days: [1], hour: 9, minute: 0, tz: "UTC" };
  const mk = (o) => ({ id: "i", cwd: wt, payload: { kind: "prompt", steps: ["p"] }, trigger: { kind: "at", rule: weekly, graceMin: 0 }, ...o });
  const out = standingPromptsOf([
    mk({}), mk({ archived: true }), mk({ cwd: other }),
    mk({ trigger: { kind: "at", rule: { kind: "once", at: 1, tz: "UTC" }, graceMin: 0 } }),
    mk({ trigger: { kind: "now" } }),
  ], wt);
  assert.deepEqual(out, ["p"]);
});

test("local-ci: off, then a hooks dir, husky, lefthook, pre-commit, core.hooksPath", () => {
  assert.equal(row(repo("ci0", { init: false }), "local-ci").relevant, false);
  const wt = repo("ci");
  assert.equal(row(wt, "local-ci").state, "off");
  put(wt, ".git/hooks/pre-push.sample", "#");
  assert.equal(row(wt, "local-ci").state, "off");
  put(wt, ".git/hooks/pre-push", "#!/bin/sh");
  assert.equal(row(wt, "local-ci").state, "on");
  const w2 = repo("ci2");
  put(w2, ".husky/pre-push", "x");
  assert.match(row(w2, "local-ci").detail, /husky/);
  const w3 = repo("ci3");
  put(w3, "lefthook.yml", "pre-push:\n  commands: {}");
  assert.match(row(w3, "local-ci").detail, /lefthook/);
  const w4 = repo("ci4");
  put(w4, ".pre-commit-config.yaml", "default_stages: [pre-push]");
  assert.equal(row(w4, "local-ci").state, "on");
  const w5 = repo("ci5");
  put(w5, "tools/hooks/pre-push", "x");
  git(w5, "config", "core.hooksPath", "tools/hooks");
  assert.match(row(w5, "local-ci").detail, /core\.hooksPath/);
});

test("npm-supply-chain: unfit, off naming the missing half, on", () => {
  const wt = repo("npm");
  assert.equal(row(wt, "npm-supply-chain").relevant, false);
  put(wt, "package.json", "{}");
  assert.equal(row(wt, "npm-supply-chain").state, "off");
  put(wt, ".npmrc", "ignore-scripts=true\n");
  const half = row(wt, "npm-supply-chain");
  assert.equal(half.state, "off");
  assert.match(half.detail, /min-release-age/);
  assert.doesNotMatch(half.detail, /missing ignore-scripts/);
  put(wt, ".npmrc", "ignore-scripts=true\nmin-release-age=7\n");
  assert.equal(row(wt, "npm-supply-chain").state, "on");
});

test("gcp-cleanup: unfit without deploy evidence, always unknown with it", () => {
  const wt = repo("gcp");
  assert.equal(row(wt, "gcp-cleanup").relevant, false);
  put(wt, "scripts/deploy.sh", "gcloud run deploy x");
  const r = row(wt, "gcp-cleanup");
  assert.equal(r.relevant, true);
  assert.equal(r.state, "unknown");
  assert.match(r.detail, /scripts\/deploy\.sh/);
  const w2 = repo("gcp2");
  put(w2, "cloudbuild.yaml", "steps: []");
  assert.equal(row(w2, "gcp-cleanup").state, "unknown");
});

test("screenshots: unfit, off for a web app, on with targets", () => {
  const wt = repo("shot");
  assert.equal(row(wt, "screenshots").relevant, false);
  put(wt, "package.json", JSON.stringify({ devDependencies: { vite: "1" } }));
  const off = row(wt, "screenshots");
  assert.equal(off.relevant, true);
  assert.equal(off.state, "off");
  put(wt, ".waterplane/capture.json", JSON.stringify({ targets: [{ id: "a" }] }));
  assert.equal(row(wt, "screenshots").state, "on");
});

test("prefs: round-trip, refusals, clearing, stamping, reload", () => {
  const root = tmp("prefs");
  const wt = repo("prefwt");
  const store = new SetupPrefsStore(root);
  setSetupPrefsStore(store);
  try {
    assert.deepEqual(optInChoices(wt), {});
    assert.deepEqual(setOptInChoice(wt, "local-ci", "declined"), { ok: true });
    assert.deepEqual(setOptInChoice(wt, "gcp-cleanup", "done"), { ok: true });
    assert.equal(setOptInChoice(wt, "nope", "done").ok, false);
    assert.equal(setOptInChoice(wt, "local-ci", "maybe").ok, false);
    assert.deepEqual(optInChoices(wt), { "local-ci": "declined", "gcp-cleanup": "done" });
    const rows = inspectOptIns(wt, { standingPrompts: () => [], fixIds: () => [] });
    assert.equal(rows.find((r) => r.id === "local-ci").choice, "declined");
    assert.equal(rows.find((r) => r.id === "local-ci").state, "off");
    assert.deepEqual(new SetupPrefsStore(root).optInChoices(wt), { "local-ci": "declined", "gcp-cleanup": "done" });
    assert.deepEqual(setOptInChoice(wt, "local-ci", null), { ok: true });
    assert.deepEqual(optInChoices(wt), { "gcp-cleanup": "done" });
    assert.deepEqual(store.ignored(wt), []);
  } finally { setSetupPrefsStore(null); }
});

test("opt-ins never reach the setup checklist", () => {
  const wt = repo("insp");
  put(wt, "package.json", "{}");
  const ids = () => JSON.stringify(inspectRepo(wt).map((c) => c.id));
  const before = ids();
  inspectOptIns(wt, deps());
  assert.equal(ids(), before);
  assert.ok(!before.includes("opt"));
});
