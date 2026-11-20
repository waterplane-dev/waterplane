/**
 * The Setup check collector (`setupcheck/`): a source that throws is an `absent` entry and its rule
 * says "not checked"; the badge number equals the repo cut; the checked-off list is never empty when
 * rules ran; autoCompactFor works over an injected disk; the waive store cleans on the way in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findingCut } from "@waterplane/shared";

const { runSetupCheck, sweepRepos } = await import("../dist/setupcheck/collect.js");
const { SetupCheckStore } = await import("../dist/setupcheck/store.js");
const { autoCompactFor, autoCompactMachineFor, autoCompactFact, claudeCliRow, weekPaceFact, checkIdOfFinding, trendOf, periodFact, copilotFact, healthFact } = await import("../dist/setupcheck/readers.js");
const { inspectRepo, summarize } = await import("../dist/compliance.js");
const { SetupPrefsStore } = await import("../dist/setupprefs.js");
const { waiveRepoFinding } = await import("../dist/setupcheck/waive.js");

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "ignore" });
function fixtureRepo() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "setupcheck-")));
  git(d, "init", "-q");
  writeFileSync(join(d, ".env.local"), "K=v\n");
  mkdirSync(join(d, ".claude"), { recursive: true });
  writeFileSync(join(d, "CLAUDE.md"), "# repo\n");
  return d;
}

const NOW = Date.parse("2026-11-16T12:00:00Z");
const deps = (wt, over = {}) => ({
  now: () => NOW,
  repoKey: () => "fixture",
  inspect: async () => inspectRepo(wt),
  hostChecks: () => [],
  claudeCli: async () => null,
  instructions: () => ({ files: [], overlaps: [], desktop: [] }),
  warn: () => ({ warnChars: 16000, warnSource: "default", globalWarnChars: 16000 }),
  points: async () => [],
  ledger: async () => { throw new Error("ledger unreadable"); },
  skills: async () => [],
  autoCompact: () => autoCompactFor(wt, { env: undefined, userDir: join(wt, "nouser"), read: () => null }),
  usage: () => null,
  billing: () => "subscription",
  backends: () => [{ id: "claude", label: "Claude Code" }],
  waived: () => ({}),
  ...over,
});

test("a source that throws is absent, and the rules that need it say not checked", async () => {
  const wt = fixtureRepo();
  const doc = await runSetupCheck(deps(wt), wt);
  assert.ok(doc.absent.some((a) => a.what === "the token ledger" && /unreadable/.test(a.why)));
  assert.ok(doc.notChecked.some((n) => n.rule === "cold-cache" && n.scope === "machine"), "ledger rules are not checked");
  assert.ok(!doc.passed.some((p) => p.rule === "cold-cache"), "never a pass for what could not be read");
});

test("the badge equals the repo cut and the checked-off list is not empty", async () => {
  const wt = fixtureRepo();
  const doc = await runSetupCheck(deps(wt), wt);
  const checks = inspectRepo(wt);
  const cut = findingCut(doc.findings, { scope: "repo", repo: "fixture", weight: "finding" });
  const compliance = checks.filter((c) => c.scope !== "host");
  // Only compliance-backed rows count in the badge; the engine uses the same predicate.
  const backed = cut.rows.filter((f) => compliance.some((c) => f.id.endsWith(`.${c.id}`) || f.id === `repo.${c.id}`));
  assert.equal(backed.length, summarize(checks).issues);
  assert.ok(doc.passed.length + doc.notChecked.length > 0);
});

test("the claude CLI row: not found warns, signed in passes, an unanswered probe is no row", () => {
  assert.equal(claudeCliRow({ bin: "claude", missing: true }, null).status, "warn");
  assert.equal(claudeCliRow({ bin: "/x/claude" }, "in").status, "pass");
  assert.equal(claudeCliRow({ bin: "/x/claude" }, "out").status, "warn");
  assert.equal(claudeCliRow({ bin: "/x/claude" }, null), null);
});

test("an unanswered claude probe becomes a not-checked line, a signed-in one a passed row", async () => {
  const wt = fixtureRepo();
  const none = await runSetupCheck(deps(wt), wt);
  assert.ok(none.notChecked.some((n) => n.rule === "install.claude-cli"));
  const ok = await runSetupCheck(deps(wt, { claudeCli: async () => claudeCliRow({ bin: "/x/claude" }, "in") }), wt);
  assert.ok(ok.passed.some((p) => p.rule === "install.claude-cli"));
});

test("autoCompactFor reads an injected disk and honours the env layer first", () => {
  const read = (p) => (p.endsWith(join(".claude", "settings.json")) ? '{"autoCompactWindow":"300k"}' : null);
  const r = autoCompactFor("/wt", { env: undefined, userDir: "/u", read });
  assert.equal(r.source, "project");
  const e = autoCompactFor("/wt", { env: "200000", userDir: "/u", read });
  assert.equal(e.source, "env");
});

test("the week pace needs a day of the week and says nothing before that", () => {
  assert.equal(weekPaceFact({ weeklyPct: 50, weeklyResetAt: NOW + 6.9 * 86_400_000 }, NOW), null);
  assert.equal(weekPaceFact(null, NOW), null);
  assert.equal(weekPaceFact({ weeklyPct: 60, weeklyResetAt: NOW + 4 * 86_400_000 }, NOW).runsOut, true);
  assert.equal(weekPaceFact({ weeklyPct: 20, weeklyResetAt: NOW + 4 * 86_400_000 }, NOW).runsOut, false);
});

test("a finding id maps back to its check; a finding no check backs maps to null", () => {
  assert.equal(checkIdOfFinding("repo.context-weight"), "context-weight");
  assert.equal(checkIdOfFinding("repo.watch.exposure:abc"), "exposure:abc");
  assert.equal(checkIdOfFinding("repo.instruction-overlap:a+b"), null);
  assert.equal(checkIdOfFinding("repo.watch.exposure:A3:left-pad@1.2.3"), "exposure:A3:left-pad@1.2.3");
  assert.equal(checkIdOfFinding("repo.watch.exposure:D3:ciq:a/p/x#100+"), "exposure:D3:ciq:a/p/x#100+");
  assert.equal(checkIdOfFinding("machine.cold-cache"), null);
});

test("trendOf splits the last 7 days from the 7 before", () => {
  const days = [{ day: "2026-11-15", turns: 10, cost: { total: 5 } }, { day: "2026-11-05", turns: 4, cost: { total: 1 } }];
  const t = trendOf(days, NOW);
  assert.deepEqual(t.cur, { usd: 5, turns: 10 });
  assert.deepEqual(t.prev, { usd: 1, turns: 4 });
});

test("the store answers the last doc at once and a slow first sweep answers pending", async () => {
  const wt = fixtureRepo();
  let n = 0;
  const slow = new SetupCheckStore(() => deps(wt, { inspect: () => new Promise(() => { n++; }) }), { waitMs: 20 });
  assert.deepEqual(await slow.get(wt), { pending: true });
  const fast = new SetupCheckStore(() => deps(wt), { waitMs: 5000 });
  const a = await fast.get(wt);
  assert.ok("doc" in a);
  const b = await fast.get(wt);
  assert.equal(b.doc, a.doc, "the cached doc, not a re-run");
});

test("a repo finding no check backs is waived for that repo only, and survives a reload", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setupprefs-")));
  const a = realpathSync(mkdtempSync(join(tmpdir(), "repo-a-")));
  const b = realpathSync(mkdtempSync(join(tmpdir(), "repo-b-")));
  const s = new SetupPrefsStore(root);
  const id = "repo.instruction-overlap:CLAUDE.md+AGENTS.md";
  assert.equal(s.setRepoWaived(a, id, { at: "2026-11-16T00:00:00Z", reason: "same file on purpose" }).ok, true);
  assert.equal(new SetupPrefsStore(root).waivedFindings(a)[id].reason, "same file on purpose");
  assert.equal(s.waivedFindings(b)[id], undefined, "another repo is not waived");
  assert.equal(s.waivedFindings()[id], undefined);
  assert.equal(s.setRepoWaived(a, "machine.x", { at: "x" }).ok, false);
  assert.equal(s.setRepoWaived(a, id, null).ok, true);
  assert.equal(s.waivedFindings(a)[id], undefined);
});

test("waiving a machine finding is stored and cleaned; a repo id is refused in words", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setupprefs-")));
  const s = new SetupPrefsStore(root);
  assert.equal(s.setWaived("machine.cold-cache", { at: "2026-11-16T00:00:00Z", reason: " fine " }).ok, true);
  assert.equal(s.waivedFindings()["machine.cold-cache"].reason, "fine");
  const again = new SetupPrefsStore(root);
  assert.ok(again.waivedFindings()["machine.cold-cache"]);
  const bad = s.setWaived("repo.context-weight", { at: "x" });
  assert.equal(bad.ok, false);
  assert.equal(s.setWaived("machine.cold-cache", null).ok, true);
  assert.deepEqual(s.waivedFindings(), {});
});

test("contributed findings fold in: a finding replaces not-checked, a clean answer is a passed row, a waive moves it (H2)", async () => {
  const { foldContributed } = await import("../dist/setupcheck/collect.js");
  const f = { id: "repo.permissions-broad", rule: "permissions-broad", scope: "repo", kind: "quality", weight: "consider", what: "x", backends: { understood: ["claude"], unread: [] }, evidence: { screen: "permissions", ruleKeys: ["allow:Bash"] }, remedy: { kind: "howto", text: "t" }, waive: { via: "ignore" } };
  const res = () => ({ findings: [], passed: [], notChecked: [{ rule: "permissions-broad", scope: "repo", repo: "k", why: "not read" }, { rule: "permissions-shadowed", scope: "repo", repo: "k", why: "not read" }, { rule: "permissions-broad", scope: "machine", why: "not read" }] });
  const r = res();
  foldContributed(r, { findings: [f], answered: ["permissions"] }, { repo: "k", waived: {}, at: 1 });
  assert.equal(r.findings[0].repo, "k");
  assert.equal(r.findings[0].evidence.repoId, "k");
  assert.ok(!r.notChecked.some((n) => /permissions/.test(n.rule)), "answered rules are no longer not-checked");
  assert.ok(r.passed.some((p) => p.id === "repo.permissions-shadowed"), "clean = passed");
  assert.ok(!r.passed.some((p) => p.id === "repo.permissions-broad"), "a finding is not also a pass");
  const w = res();
  foldContributed(w, { findings: [f], answered: ["permissions"] }, { repo: "k", waived: { "repo.permissions-broad": { reason: "ok", at: "t" } }, at: 1 });
  assert.equal(w.findings[0].waive.waived.reason, "ok");
  const none = res();
  foldContributed(none, { findings: [], answered: [] }, { repo: "k", waived: {}, at: 1 });
  assert.equal(none.notChecked.length, 3, "an extension that did not answer leaves not-checked as it was");
});

test("invalidate drops the cached document: the next read waits for a fresh run, and a run in flight is discarded", async () => {
  const wt = fixtureRepo();
  let n = 0;
  const store = new SetupCheckStore(() => deps(wt, { hostChecks: () => { n++; return []; } }), { waitMs: 5000 });
  const a = await store.get(wt);
  const runs = n;
  store.invalidate();
  const b = await store.get(wt);
  assert.equal(n, runs + 1, "re-ran before answering");
  assert.notEqual(b.doc, a.doc);
});

test("health alerts, period pace and Copilot are collected from what the host computes", async () => {
  assert.equal(healthFact({ series: null }), undefined);
  assert.deepEqual(healthFact({ series: { points: [{ alerts: [{ level: "severe", subject: "size", text: "severe: big" }] }] } }), { alerts: [{ entry: "size", level: "severe", text: "severe: big" }] });
  const DAY = 86_400_000;
  const st = (spent) => [{ period: { id: "month", unit: "usd" }, start: NOW - 10 * DAY, resetAt: NOW + 20 * DAY, active: true, spentUsd: spent }];
  const cap = [{ periodId: "month", max: 100, unit: "usd" }];
  assert.equal(periodFact(st(null), cap, NOW), null, "unmeasured is not a pass");
  assert.equal(periodFact(st(10), [], NOW), null, "no cap, nothing to judge");
  assert.equal(periodFact(st(10), cap, NOW).firing, false);
  assert.equal(periodFact(st(60), cap, NOW).firing, true);
  assert.equal(copilotFact([], NOW), null);
  const r = { source: "copilot", label: "Copilot", checkedAt: NOW, windows: [{ id: "chat", used: 90, limit: 100, unit: "mo" }] };
  const c = copilotFact([r], NOW);
  assert.ok(c && c.usedPct >= 80, "the hottest window");
  const wt = fixtureRepo();
  const doc = await runSetupCheck(deps(wt, {
    health: () => ({ alerts: [{ entry: "size", level: "severe", text: "severe: big" }] }),
    period: () => ({ firing: true, text: "month: past its cap" }),
    copilot: () => c,
  }), wt);
  assert.ok(doc.findings.some((f) => f.id === "repo.health-alert:size"));
  assert.ok(doc.findings.some((f) => f.id === "account.period-pace"));
  assert.ok(doc.findings.some((f) => f.id === "account.copilot-quota"));
  assert.ok(!doc.notChecked.some((n) => n.rule === "period-pace" || n.rule === "copilot-quota" || n.rule === "health-alert"));
});

test("a desktop row with a fix becomes a machine finding whose remedy is that fix", async () => {
  const wt = fixtureRepo();
  const row = { id: "tailscale-watchdog", label: "Tailscale watchdog", status: "warn", scope: "host", fix: "tailscale-watchdog", detail: "not installed" };
  const doc = await runSetupCheck(deps(wt, { hostChecks: () => [row] }), wt);
  const f = doc.findings.find((x) => x.id === "machine.install.tailscale-watchdog");
  assert.ok(f, "listed");
  assert.deepEqual(f.remedy, { kind: "fix", fixId: "tailscale-watchdog" });
});

test("every fix id a desktop row names reaches the phone as a fix remedy", async () => {
  const { hostChecks } = await import("../dist/plugins/setupcontrib.js");
  const wt = fixtureRepo();
  const rows = (await hostChecks(wt)).filter((c) => c.fix);
  const doc = await runSetupCheck(deps(wt, { hostChecks: () => rows.map((c) => ({ ...c, status: "warn" })) }), wt);
  for (const c of rows) assert.ok(doc.findings.some((f) => f.remedy.kind === "fix" && f.remedy.fixId === c.fix), `${c.id} keeps its fix`);
});

test("R-metrics-086: the all-repos sweep reads machine sources once for N repos; a throwing repo is not checked", async () => {
  const wts = [fixtureRepo(), fixtureRepo(), fixtureRepo()];
  const calls = { host: 0, cli: 0, points: 0, ledger: 0, skills: 0, billing: 0 };
  const into = new Map();
  const d = deps(wts[0], {
    hostChecks: () => { calls.host++; return []; },
    claudeCli: async () => { calls.cli++; return null; },
    points: async () => { calls.points++; return []; },
    ledger: async () => { calls.ledger++; throw new Error("ledger unreadable"); },
    skills: async () => { calls.skills++; return []; },
    billing: () => { calls.billing++; return "subscription"; },
    inspect: async (wt) => { if (wt === wts[1]) throw new Error("path is gone"); return inspectRepo(wt); },
  });
  await sweepRepos(d, wts.map((w, i) => ({ id: `r${i}`, name: `R${i}`, worktree: w })), into, { concurrency: 2 });
  assert.deepEqual(calls, { host: 1, cli: 1, points: 1, ledger: 1, skills: 1, billing: 1 });
  assert.equal(into.size, 3);
  // a source that throws is an absent fact, not a failed repo: all three have a document
  assert.ok(wts.every((_, i) => "doc" in into.get(`r${i}`)));
  assert.ok(into.get("r1").doc.absent.some((a) => /checklist/.test(a.what)));
});

test("R-metrics-088: a repo whose check outlasts its timeout is not checked, with the sentence", async () => {
  const wt = fixtureRepo();
  const into = new Map();
  await sweepRepos(deps(wt, { inspect: () => new Promise(() => {}) }), [{ id: "slow", name: "Slow", worktree: wt }], into, { timeoutMs: 30 });
  assert.match(into.get("slow").why, /took longer/);
});

test("R-metrics-088: getAll answers pending with done and total while the sweep runs", async () => {
  const wts = [fixtureRepo(), fixtureRepo()];
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = new SetupCheckStore(() => deps(wts[0], { inspect: async (wt) => { if (wt === wts[1]) await gate; return inspectRepo(wt); } }), { waitMs: 150, sweep: { concurrency: 2 } });
  const repos = wts.map((w, i) => ({ id: `r${i}`, name: `R${i}`, worktree: w }));
  const first = await store.getAll(repos);
  assert.equal(first.pending, true);
  assert.deepEqual([first.done, first.total], [1, 2]);
  release();
  await new Promise((r) => setTimeout(r, 400));
  const later = await store.getAll(repos);
  assert.equal(later.pending, false);
  assert.equal(later.done, 2);
});

test("the machine auto-compact reading is judged by the person's chosen window, as the repo check is", () => {
  const read = (p) => (p.endsWith("settings.json") ? '{"autoCompactWindow":"800k"}' : null);
  const machine = autoCompactMachineFor({ env: undefined, userDir: "/u", read });
  const row = { id: "auto-compact", label: "x", status: "pass", detail: "", fix: null };
  assert.equal(autoCompactFact(machine, row, machine).machine.status, "warn", "800k is over the hard limit with no chosen default");
  assert.equal(autoCompactFact(machine, row, machine, "800k").machine.status, "pass", "800k is the person's own choice");
});

test("waive: a watch row goes to the accepts store with a reason and an end, and a take-back clears it or says why not", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setupprefs-")));
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "repo-w-")));
  const prefs = new SetupPrefsStore(root);
  const calls = [];
  let accepted = false, builtIn = false;
  const io = {
    prefs,
    ignore: (_t, id, on) => { calls.push(["ignore", id, on]); return { ok: false, error: "not advisory" }; },
    accept: (_t, req) => {
      calls.push(["accept", req]);
      if (req.accept) { accepted = true; return { ok: true }; }
      if (builtIn) return { ok: false, error: "Accepted in code: x" };
      if (!accepted) return { ok: false, error: "That finding is not accepted." };
      accepted = false; return { ok: true };
    },
  };
  const t = { worktreePath: wt };
  const id = "repo.watch.exposure:dep:left-pad";
  assert.deepEqual(waiveRepoFinding(t, io, { id, waive: true }), { ok: true });
  const a = calls.find((c) => c[0] === "accept")[1];
  assert.equal(a.accept, true);
  assert.ok(a.reason, "an accept carries a reason");
  assert.deepEqual(a.until, { change: true });
  assert.equal(prefs.waivedFindings(wt)[id], undefined, "no forever waiver for a security finding");
  assert.deepEqual(waiveRepoFinding(t, io, { id, waive: false }), { ok: true });
  assert.equal(accepted, false);
  const none = waiveRepoFinding(t, io, { id, waive: false });
  assert.equal(none.ok, false);
  assert.match(none.error, /not accepted/);
  builtIn = true;
  assert.match(waiveRepoFinding(t, io, { id, waive: false }).error, /in code/);
  // a non-exposure finding no check backs stays a per-repo waiver
  const ov = "repo.instruction-overlap:A+B";
  assert.deepEqual(waiveRepoFinding(t, io, { id: ov, waive: true, reason: "on purpose" }), { ok: true });
  assert.equal(prefs.waivedFindings(wt)[ov].reason, "on purpose");
  assert.deepEqual(waiveRepoFinding(t, io, { id: ov, waive: false }), { ok: true });
});

test("waive: an exposure key with @ / + # is accepted and taken back through the accepts store, never a prefs waiver", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setupprefs-")));
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "repo-w-")));
  const prefs = new SetupPrefsStore(root);
  const accepts = [];
  const io = {
    prefs,
    ignore: () => ({ ok: false, error: "not advisory" }),
    accept: (_t, req) => { accepts.push(req); return { ok: true }; },
  };
  const t = { worktreePath: wt };
  for (const key of ["A3:left-pad@1.2.3", "A1:@scope/pkg", "D3:ciq:a/p/x#100+"]) {
    const id = `repo.watch.exposure:${key}`;
    assert.deepEqual(waiveRepoFinding(t, io, { id, waive: true }), { ok: true });
    assert.equal(accepts.at(-1).id, `exposure:${key}`);
    assert.equal(accepts.at(-1).accept, true);
    assert.deepEqual(waiveRepoFinding(t, io, { id, waive: false }), { ok: true }, "a take-back of a key the prefs store refuses still clears the accept");
    assert.equal(accepts.at(-1).accept, false);
  }
  assert.deepEqual(prefs.waivedFindings(wt), {}, "no forever waiver was written");
});

test("waive: an exposure key of any shape is read off the prefix, under watch and install alike", () => {
  for (const key of ["D3:ciq:a/p#100+", "D3:app (beta)/x=1$~y", `D3:${"k".repeat(300)}`, "A1:@scope/pkg"]) {
    assert.equal(checkIdOfFinding(`repo.watch.exposure:${key}`), `exposure:${key}`);
    assert.equal(checkIdOfFinding(`repo.install.exposure:${key}`), `exposure:${key}`);
  }
  assert.equal(checkIdOfFinding("repo.context-weight"), "context-weight");
});

test("waive: an accept the person already made on the exposure screen is kept, and a take-back of a never-accepted # key is an error", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setupprefs-")));
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "repo-w-")));
  const prefs = new SetupPrefsStore(root);
  const calls = [];
  let already = true;
  const io = {
    prefs,
    isAccepted: () => already,
    ignore: () => ({ ok: false, error: "not advisory" }),
    accept: (_t, req) => { calls.push(req); return req.accept ? { ok: true } : { ok: false, error: "That finding is not accepted." }; },
  };
  const t = { worktreePath: wt };
  const id = "repo.install.exposure:D3:ciq:a/p#100+";
  assert.deepEqual(waiveRepoFinding(t, io, { id, waive: true }), { ok: true });
  assert.deepEqual(calls, [], "their own reason and end were not replaced");
  already = false;
  assert.deepEqual(waiveRepoFinding(t, io, { id, waive: true }), { ok: true });
  assert.equal(calls.length, 1);
  const back = waiveRepoFinding(t, io, { id, waive: false });
  assert.equal(back.ok, false);
  assert.match(back.error, /not accepted/);
});

test("the week's pace is measured at the reading, so a stale reading is not projected too low", () => {
  const DAYMS = 86_400_000;
  const reset = NOW + 3 * DAYMS;
  // read 2 days ago at 60% (4 days in at that time); now it is 5 days in
  const stale = weekPaceFact({ weeklyPct: 60, weeklyResetAt: reset, checkedAt: NOW - 2 * DAYMS }, NOW);
  assert.equal(stale.runsOut, true, "60% at day 4 runs out, which day 5 would hide as 42%");
});
