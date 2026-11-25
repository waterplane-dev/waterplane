/**
 * Opt-in probes (`optins.ts`): fixture repos in a temp dir, a fake
 * `standingPrompts`, the prefs round-trip — and that none of it reaches the
 * setup checklist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, DEFAULT_AUTOPULL, OPT_INS, OPT_IN_PICKS_FILE, OPT_IN_PICKS_MAX_BYTES, optInMarker } from "@waterplane/shared";

const { inspectOptIns, standingPromptsOf, optInSightings, noteOptInSends, sentOf, readOptInPicks } = await import("../dist/optins.js");
const { SetupPrefsStore, setSetupPrefsStore, setOptInChoice, optInChoices, setupUnseen, markSetupSeen, noteOptInSent } = await import("../dist/setupprefs.js");
const { discoverTargets, listTargets, cachedTargets } = await import("../dist/repos.js");
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
const deps = (o = {}) => ({ standingPrompts: () => [], fixIds: () => ["requirements"], choices: () => ({}), sentTimes: () => ({}), ...o });
const row = async (wt, id, d) => (await inspectOptIns(wt, d ?? deps())).find((r) => r.id === id);

test("one row per catalog entry, in order", async () => {
  const rows = (await inspectOptIns(repo("all"), deps()));
  assert.deepEqual(rows.map((r) => r.id), OPT_INS.map((d) => d.id));
  for (const r of rows) assert.ok(r.detail.length > 0);
});

test("requirements: unfit without the fix, off, then on", async () => {
  const wt = repo("req");
  const u = (await row(wt, "requirements", deps({ fixIds: () => [] })));
  assert.equal(u.relevant, false);
  assert.match(u.detail, /not loaded/);
  assert.equal((await row(wt, "requirements")).state, "off");
  put(wt, ".claude/skills/requirements/SKILL.md", "# r");
  const on = (await row(wt, "requirements"));
  assert.equal(on.state, "on");
  assert.equal(on.relevant, true);
});

test("links: the extension's own answer; off when no extension answers (R-onboarding-032)", async () => {
  const wt = repo("links");
  const none = await row(wt, "links", deps({ plugin: async () => null }));
  assert.deepEqual([none.relevant, none.state], [true, "off"]);
  assert.match(none.detail, /extension is off/);
  const on = await row(wt, "links", deps({ plugin: async (id) => ({ state: "on", detail: `asked ${id}` }) }));
  assert.deepEqual([on.state, on.detail], ["on", "asked links"]);
});

test("repo-health-own: uncommitted is off, committed with readings is on", async () => {
  const wt = repo("own");
  const r0 = (await row(wt, "repo-health-own"));
  if (!r0.relevant) return; // engine unavailable in this checkout: the unfit path
  assert.equal(r0.state, "off");
  put(wt, ".waterplane-shared/health.json", JSON.stringify({ readings: [{ key: "a" }] }));
  const r1 = (await row(wt, "repo-health-own"));
  assert.equal(r1.state, "off");
  assert.equal(r1.partial, true, "written but not committed is begun, not on");
  assert.match(r1.detail, /not committed/);
  commit(wt);
  assert.equal((await row(wt, "repo-health-own")).state, "on");
  assert.equal((await row(wt, "repo-health-own")).partial, undefined);
  put(wt, ".waterplane-shared/health.json", JSON.stringify({ readings: [] }));
  commit(wt);
  assert.equal((await row(wt, "repo-health-own")).state, "off");
  put(wt, ".waterplane-shared/health.json", "{nope");
  commit(wt);
  assert.equal((await row(wt, "repo-health-own")).state, "unknown");
});

test("security-review: marker through standingPrompts; null is unknown", async () => {
  const wt = repo("sec");
  assert.equal((await row(wt, "security-review")).state, "off");
  assert.equal((await row(wt, "security-review", deps({ standingPrompts: () => ["do it\n" + optInMarker("security-review")] }))).state, "on");
  assert.equal((await row(wt, "security-review", deps({ standingPrompts: () => ["other " + optInMarker("local-ci")] }))).state, "off");
  assert.equal((await row(wt, "security-review", deps({ standingPrompts: () => null }))).state, "unknown");
});

test("standingPromptsOf keeps live recurring prompt schedules of this worktree only", async () => {
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

test("sent: found by the marker in rows and live histories, remembered past the session", async () => {
  const wt = repo("sent");
  const other = repo("sent2");
  const words = (id) => "set it up\n" + optInMarker(id);
  const walk = words("local-ci") + "\n" + words("npm-supply-chain");
  const intents = [
    { id: "a", cwd: wt, payload: { kind: "prompt", steps: [words("local-ci")] }, trigger: { kind: "now" }, state: "queued", createdAt: 100 },
    { id: "b", cwd: wt, payload: { kind: "prompt", steps: [walk] }, trigger: { kind: "now" }, state: "done", createdAt: 300 },
    { id: "c", cwd: other, payload: { kind: "prompt", steps: [words("npm-supply-chain")] }, trigger: { kind: "now" }, state: "running", createdAt: 50 },
  ];
  const sessions = [{ cwd: wt, history: [{ id: "h", kind: "prompt", text: words("repo-health-own"), sentAt: 200 }] }];
  const seen = optInSightings(wt, intents, sessions);
  assert.deepEqual(seen.sort((x, y) => x.at - y.at), [
    { id: "local-ci", at: 100, status: "waiting" },
    { id: "repo-health-own", at: 200, status: "open" },
  ], "the walk-through (two markers) and another worktree's row are not sends here");

  assert.deepEqual(sentOf("local-ci", seen), { at: 100, status: "waiting" });
  assert.deepEqual(sentOf("local-ci", seen, 400), { at: 400, status: "ended" }, "a later send whose session closed wins");
  assert.deepEqual(sentOf("local-ci", seen, 90), { at: 100, status: "waiting" });
  assert.equal(sentOf("npm-supply-chain", seen), undefined);

  const r = (await row(wt, "local-ci", deps({ sightings: () => seen })));
  assert.deepEqual(r.sent, { at: 100, status: "waiting" });
  assert.equal(r.state, "off", "sent is not on");
  assert.equal((await row(wt, "security-review", deps({ sightings: () => { throw new Error("x"); } }))).sent, undefined);

  const root = tmp("sentprefs");
  setSetupPrefsStore(new SetupPrefsStore(root));
  try {
    noteOptInSends(wt, [{ id: "1", kind: "prompt", text: words("local-ci"), sentAt: 500 }, { id: "2", kind: "prompt", text: walk, sentAt: 600 }]);
    noteOptInSends(wt, [{ id: "1", kind: "prompt", text: words("local-ci"), sentAt: 450 }]);
    assert.deepEqual(new SetupPrefsStore(root).optInSentTimes(wt), { "local-ci": 500 }, "persisted, forward only, the walk ignored");
    const rr = (await inspectOptIns(wt, { standingPrompts: () => [], fixIds: () => [] })).find((x) => x.id === "local-ci");
    assert.deepEqual(rr.sent, { at: 500, status: "ended" });
  } finally { setSetupPrefsStore(null); }
});

test("local-ci: off, then a hooks dir, husky, lefthook, pre-commit, core.hooksPath", async () => {
  assert.equal((await row(repo("ci0", { init: false }), "local-ci")).relevant, false);
  const wt = repo("ci");
  assert.equal((await row(wt, "local-ci")).state, "off");
  put(wt, ".git/hooks/pre-push.sample", "#");
  assert.equal((await row(wt, "local-ci")).state, "off");
  put(wt, ".git/hooks/pre-push", "#!/bin/sh");
  assert.equal((await row(wt, "local-ci")).state, "on");
  const w2 = repo("ci2");
  put(w2, ".husky/pre-push", "x");
  assert.match((await row(w2, "local-ci")).detail, /husky/);
  const w3 = repo("ci3");
  put(w3, "lefthook.yml", "pre-push:\n  commands: {}");
  assert.match((await row(w3, "local-ci")).detail, /lefthook/);
  const w4 = repo("ci4");
  put(w4, ".pre-commit-config.yaml", "default_stages: [pre-push]");
  assert.equal((await row(w4, "local-ci")).state, "on");
  const w5 = repo("ci5");
  put(w5, "tools/hooks/pre-push", "x");
  git(w5, "config", "core.hooksPath", "tools/hooks");
  assert.match((await row(w5, "local-ci")).detail, /core\.hooksPath/);
});

test("npm-supply-chain: unfit, off naming the missing half, on", async () => {
  const wt = repo("npm");
  assert.equal((await row(wt, "npm-supply-chain")).relevant, false);
  put(wt, "package.json", "{}");
  assert.equal((await row(wt, "npm-supply-chain")).state, "off");
  put(wt, ".npmrc", "ignore-scripts=true\n");
  const half = (await row(wt, "npm-supply-chain"));
  assert.equal(half.state, "off");
  assert.match(half.detail, /min-release-age/);
  assert.doesNotMatch(half.detail, /missing ignore-scripts/);
  put(wt, ".npmrc", "ignore-scripts=true\nmin-release-age=7\n");
  assert.equal((await row(wt, "npm-supply-chain")).state, "on");
});

test("gcp-cleanup: unfit without deploy evidence, always unknown with it", async () => {
  const wt = repo("gcp");
  assert.equal((await row(wt, "gcp-cleanup")).relevant, false);
  put(wt, "scripts/deploy.sh", "gcloud run deploy x");
  const r = (await row(wt, "gcp-cleanup"));
  assert.equal(r.relevant, true);
  assert.equal(r.state, "unknown");
  assert.match(r.detail, /scripts\/deploy\.sh/);
  const w2 = repo("gcp2");
  put(w2, "cloudbuild.yaml", "steps: []");
  assert.equal((await row(w2, "gcp-cleanup")).state, "unknown");
});

test("prefs: round-trip, refusals, clearing, stamping, reload", async () => {
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
    const rows = (await inspectOptIns(wt, { standingPrompts: () => [], fixIds: () => [] }));
    assert.equal(rows.find((r) => r.id === "local-ci").choice, "declined");
    assert.equal(rows.find((r) => r.id === "local-ci").state, "off");
    assert.deepEqual(new SetupPrefsStore(root).optInChoices(wt), { "local-ci": "declined", "gcp-cleanup": "done" });
    assert.deepEqual(setOptInChoice(wt, "local-ci", null), { ok: true });
    assert.deepEqual(optInChoices(wt), { "gcp-cleanup": "done" });
    assert.deepEqual(store.ignored(wt), []);
  } finally { setSetupPrefsStore(null); }
});

test("opt-ins never reach the setup checklist", async () => {
  const wt = repo("insp");
  put(wt, "package.json", "{}");
  const ids = () => JSON.stringify(inspectRepo(wt).map((c) => c.id));
  const before = ids();
  await inspectOptIns(wt, deps());
  assert.equal(ids(), before);
  assert.ok(!before.includes("opt"));
});

test("exposure-watch: probe, idempotent fix, other entries kept (R-security-012)", async () => {
  const { setExposureDir } = await import("../dist/exposure.js");
  const { addExposureTarget, ghOfRemote, targetName } = await import("../dist/exposurewatch.js");
  const { readFileSync } = await import("node:fs");
  const dir = tmp("expdir");
  setExposureDir(dir);
  try {
    const wt = repo("exp");
    const none = (await row(wt, "exposure-watch"));
    assert.equal(none.state, "off");
    assert.equal(none.relevant, true);
    assert.match(none.detail, /no daily exposure runner/i);
    assert.equal((await row(repo("exp-nogit", { init: false }), "exposure-watch")).relevant, false);

    git(wt, "remote", "add", "origin", "git@github.com:Own/my-repo.git");
    put(dir, "targets.json", JSON.stringify({ version: 1, extra: 7, targets: [{ name: "my-repo", dir: "/elsewhere", play: { id: "x" } }] }));
    assert.doesNotMatch((await row(wt, "exposure-watch")).detail, /no daily/i);
    const r = addExposureTarget(wt);
    assert.equal(r.added, true);
    const doc = JSON.parse(readFileSync(join(dir, "targets.json"), "utf8"));
    assert.equal(doc.extra, 7);
    assert.deepEqual(doc.targets[0], { name: "my-repo", dir: "/elsewhere", play: { id: "x" } });
    assert.match(doc.targets[1].name, /^wp-optin-exp-/);
    assert.equal(doc.targets[1].gh, "Own/my-repo");
    assert.equal(doc.targets[1].dir, wt);
    assert.equal(doc.targets[1].addedBy, "phone");
    assert.equal((await row(wt, "exposure-watch")).state, "on");
    assert.equal(addExposureTarget(wt).added, false);
    assert.equal(JSON.parse(readFileSync(join(dir, "targets.json"), "utf8")).targets.length, 2);
  } finally { setExposureDir(null); }
  assert.equal(ghOfRemote("https://github.com/A/b.git"), "A/b");
  assert.equal(ghOfRemote("https://gitlab.com/A/b.git"), undefined);
  assert.equal(targetName("/x/Real Estate_Calc", new Set(["real-estate_calc"])), "real-estate_calc-2");
});

test("local-ci-status: relevant only for unpinned required local-ci with a hook", async () => {
  const { chmodSync } = await import("node:fs");
  const R = (o) => ({ mode: "pr-checks", requiredChecks: ["local-ci"], requiredApprovals: 0, allowedMerge: [], autoMerge: false, ...o });
  const wt = repo("lcs");
  const d = (rules) => deps({ rules: () => rules });
  assert.equal((await row(wt, "local-ci-status", d(undefined))).relevant, false);
  assert.match((await row(wt, "local-ci-status", d(undefined))).detail, /not read/);
  assert.equal((await row(wt, "local-ci-status", d(R({ mode: "direct", requiredChecks: [] })))).relevant, false);
  assert.equal((await row(wt, "local-ci-status", d(R({ mode: "pr", requiredChecks: [] })))).relevant, false);
  assert.equal((await row(wt, "local-ci-status", d(R({ requiredChecks: ["ci"] })))).relevant, false);
  assert.equal((await row(wt, "local-ci-status", d(R({ pinnedChecks: ["local-ci"] })))).relevant, false);
  assert.equal((await row(wt, "local-ci-status", d(R()))).relevant, false); // no hook yet
  put(wt, ".git/hooks/pre-push", "#!/bin/sh\nexit 0\n");
  chmodSync(join(wt, ".git/hooks/pre-push"), 0o755);
  const off = (await row(wt, "local-ci-status", d(R())));
  assert.equal(off.relevant, true); assert.equal(off.state, "off");
  git(wt, "config", "waterplane.localCiStatus", "true");
  assert.equal((await row(wt, "local-ci-status", d(R()))).state, "on");
});

test("apk offers: no app is unfit; the download rule and the install list decide, unread is unknown", async () => {
  const bare = repo("noapk");
  assert.equal((await row(bare, "apk-download")).relevant, false);
  assert.equal((await row(bare, "apk-install")).relevant, false);

  const wt = repo("apk");
  put(wt, "android/app/build.gradle", 'apply plugin: "com.android.application"\nandroid { defaultConfig { applicationId "a.b.c" } }');
  put(wt, ".claude/outbox/app.apk", "12345");
  const rule = (o) => deps({ pullRule: () => ({ ...DEFAULT_AUTOPULL, ...o }) });
  assert.equal((await row(wt, "apk-download")).state, "unknown");
  assert.equal((await row(wt, "apk-download", rule({}))).state, "off");
  assert.equal((await row(wt, "apk-download", rule({ enabled: true }))).state, "on");
  const left = await row(wt, "apk-download", rule({ enabled: true, match: ["*.zip"] }));
  assert.deepEqual([left.state, left.partial], ["off", true]);
  assert.match(left.detail, /app\.apk.*patterns/);
  assert.match((await row(wt, "apk-download", rule({ enabled: true, maxBytes: 2 }))).detail, /size cap/);

  const allow = (l) => deps({ installAllow: () => l });
  assert.equal((await row(wt, "apk-install", allow(null))).state, "unknown");
  assert.equal((await row(wt, "apk-install", allow([]))).state, "off");
  assert.equal((await row(wt, "apk-install", allow(["a.b.c"]))).state, "on");
});

test("apk-install: a build variant on the list counts, a package behind a variable is unknown", async () => {
  const wt = repo("apkv");
  put(wt, "android/app/build.gradle", 'android { defaultConfig { applicationId "a.b.c" } buildTypes { debug { applicationIdSuffix ".debug" } } }');
  assert.equal((await row(wt, "apk-install", deps({ installAllow: () => ["a.b.c.debug"] }))).state, "on");
  put(wt, "android/app/build.gradle", "android { defaultConfig { applicationId = appId } }");
  assert.equal((await row(wt, "apk-install", deps({ installAllow: () => [] }))).state, "unknown");
});

test("setup seen: unseen until marked, chosen or sent; the first mark stands, by realpath, across a restart", () => {
  const root = tmp("seen");
  const [a, b, c] = [repo("seena"), repo("seenb"), repo("seenc")];
  const link = join(root, "link-to-a");
  symlinkSync(a, link);
  assert.equal(setupUnseen(a), false, "no store: nothing is said");
  assert.equal(markSetupSeen(a).ok, false);
  setSetupPrefsStore(new SetupPrefsStore(root));
  try {
    for (const wt of [a, b, c, link]) assert.equal(setupUnseen(wt), true);
    assert.deepEqual(markSetupSeen(link, 100), { ok: true });
    assert.deepEqual(markSetupSeen(a, 200), { ok: true });
    setOptInChoice(b, "local-ci", "declined");
    noteOptInSent(c, "local-ci", 5);
    for (const wt of [a, b, c, link]) assert.equal(setupUnseen(wt), false);
    const again = new SetupPrefsStore(root);
    assert.equal(again.setupUnseen(a), false);
    assert.equal(again.setupUnseen(c), false);
  } finally { setSetupPrefsStore(null); }
});

test("setupUnseen rides every listing of a primary checkout and is read at answer time, never off the last scan", async () => {
  const root = tmp("seenlist");
  const wt = join(root, "app");
  mkdirSync(wt);
  git(wt, "init", "-q");
  put(wt, "f", "x");
  commit(wt);
  git(wt, "worktree", "add", "-q", join(root, "linked"));
  const flags = (ts) => Object.fromEntries(ts.map((t) => [t.isPrimary ? "primary" : "linked", t.setupUnseen]));
  assert.deepEqual(flags(await discoverTargets(root)), { primary: undefined, linked: undefined });
  setSetupPrefsStore(new SetupPrefsStore(tmp("seenlist-state")));
  try {
    assert.deepEqual(flags(await discoverTargets(root)), { primary: true, linked: undefined });
    assert.deepEqual(flags(await listTargets(root)), { primary: true, linked: undefined });
    markSetupSeen(wt);
    assert.deepEqual(flags(await cachedTargets(root)), { primary: undefined, linked: undefined });
  } finally { setSetupPrefsStore(null); }
});

test("picks: the repo's own file, cleaned; missing, broken, oversized or a link is none", () => {
  const wt = repo("picks");
  const rel = `${BRAND.stateDirName}/${OPT_IN_PICKS_FILE}`;
  assert.deepEqual(readOptInPicks(wt), []);
  const good = JSON.stringify({ picks: [{ id: "local-ci", want: true, why: "has tests" }, { id: "nope", want: true, why: "x" }] });
  put(wt, rel, good);
  assert.deepEqual(readOptInPicks(wt), [{ id: "local-ci", want: true, why: "has tests" }]);
  for (const bad of ["not json", "null", "[]", "{}", good + " ".repeat(OPT_IN_PICKS_MAX_BYTES)]) {
    put(wt, rel, bad);
    assert.deepEqual(readOptInPicks(wt), [], bad.slice(0, 12));
  }
  const linked = repo("pickslink");
  const outside = join(tmp("picksout"), "picks.json");
  writeFileSync(outside, good);
  mkdirSync(join(linked, BRAND.stateDirName));
  symlinkSync(outside, join(linked, rel));
  assert.deepEqual(readOptInPicks(linked), []);
  assert.equal(readFileSync(outside, "utf8"), good);
});
