import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_MD_KEY, DESC_KEY } from "../../repoHealthPlot.ts";
import { backendLabels, doorRepoId, notCheckedSentences, weightClocksOf, fixRoute, blockLines, chipCountOf, evidenceDoorOf, headCounts, landingScope, menuAim, scopeChips, viewOf, waiveBody, checkAgainWords, scopesOfTab, tabOfScope } from "./logic.ts";

const be = { understood: ["claude"], unread: [] };
const f = (id, scope, over = {}) => ({
  id, rule: id, scope, kind: "quality", weight: "consider", what: id, backends: be, evidence: null,
  remedy: { kind: "howto", text: "x" }, waive: { via: "ignore" }, ...over,
});
const doc = (over = {}) => ({
  findings: [
    f("repo.a", "repo", { weight: "finding" }), f("repo.b", "repo"), f("repo.inst", "repo", { kind: "install", weight: "finding" }),
    f("machine.m", "machine", { kind: "cost" }), f("account.x", "account"),
  ],
  passed: [
    { id: "repo.p", rule: "p", scope: "repo", what: "p", backends: be, at: 1 },
    { id: "repo.w", rule: "w", scope: "repo", what: "w", backends: be, at: 1, waived: "waived: noise" },
    { id: "machine.p", rule: "mp", scope: "machine", what: "mp", backends: be, at: 1 },
  ],
  notChecked: [{ rule: "n", scope: "repo", why: "no backend" }, { rule: "n2", scope: "machine", why: "absent" }],
  absent: [], at: 1, ...over,
});

test("a chip's count is the number of rows its scope lists, one cut", () => {
  const d = doc();
  const v = viewOf(d, "repo");
  assert.equal(chipCountOf(d, "repo"), v.rows.length + v.install.length);
  assert.equal(v.all, 3);
});

test("the badge cut keeps exactly what the badge counts, and says N of all", () => {
  const v = viewOf(doc(), "repo", "finding");
  assert.equal(v.count, 2);
  assert.equal(v.all, 3);
  assert.deepEqual(v.rows.map((r) => r.id), ["repo.a"]);
  assert.deepEqual(v.install.map((r) => r.id), ["repo.inst"]);
});

test("a scope never lists another scope's findings, passed rows or not-checked rows", () => {
  const v = viewOf(doc(), "machine");
  assert.deepEqual(v.rows.map((r) => r.id), ["machine.m"]);
  assert.deepEqual(v.passed.map((p) => p.id), ["machine.p"]);
  assert.deepEqual(v.notChecked.map((n) => n.rule), ["n2"]);
});

test("waived rows are the checked-off rows that carry a label, apart from the passed ones", () => {
  const v = viewOf(doc(), "repo");
  assert.deepEqual(v.waived.map((p) => p.id), ["repo.w"]);
  assert.deepEqual(v.passed.map((p) => p.id), ["repo.p"]);
});

test("a findings view is never empty: no findings still lists what passed and what was not checked", () => {
  const v = viewOf(doc({ findings: [] }), "repo");
  const c = headCounts(v);
  assert.equal(c.findings, 0);
  assert.equal(c.passed, 2);
  assert.equal(c.notChecked, 1);
});

test("with no repo the repo chip is absent and the sheet lands on this machine", () => {
  assert.deepEqual(scopeChips(false), ["machine", "account"]);
  assert.deepEqual(scopeChips(true), ["repo", "machine", "account"]);
  assert.equal(landingScope(undefined, null), "machine");
  assert.equal(landingScope("repo", null), "machine");
  assert.equal(landingScope(undefined, "r1"), "repo");
  assert.equal(landingScope("account", "r1"), "account");
});

test("a waive of a repo finding names its repo; machine and account need none", () => {
  assert.deepEqual(waiveBody("repo.a", true, "r1"), { id: "repo.a", waive: true, repo: "r1" });
  assert.deepEqual(waiveBody("machine.m", false, "r1"), { id: "machine.m", waive: false });
});

test("the block's line count ignores the final newline", () => {
  assert.equal(blockLines("a\nb\n"), 2);
  assert.equal(blockLines("a\nb"), 2);
});

test("a machine finding's fix runs on the desktop, any other on a repo", () => {
  assert.equal(fixRoute("machine"), "host");
  assert.equal(fixRoute("repo"), "repo");
  assert.equal(fixRoute("account"), "repo");
});

test("R-metrics-086: the all repos chip is drawn first, and only with two or more primary repos", () => {
  assert.deepEqual(scopeChips(true, true), ["all", "repo", "machine", "account"]);
  assert.deepEqual(scopeChips(true, false), ["repo", "machine", "account"]);
  assert.deepEqual(scopeChips(false, true), ["all", "machine", "account"]);
});

test("R-metrics-090: the landing view and the menu line need no repo", () => {
  assert.equal(landingScope(undefined, null, 3), "all");
  assert.equal(landingScope(undefined, null, 3, true), "machine", "a spend cut with no repo lands where the cut is drawn, not on all repos");
  assert.equal(landingScope(undefined, "r1", 3, true), "repo");
  assert.equal(landingScope(undefined, null, 1), "machine");
  assert.equal(landingScope(undefined, "r1", 3), "repo");
  assert.equal(landingScope("machine", null, 3), "machine");
  assert.deepEqual(menuAim(["a", "b"]), { repoId: null, scope: "all" });
  assert.deepEqual(menuAim(["a"]), { repoId: "a", scope: "repo" });
  assert.deepEqual(menuAim([]), { repoId: null, scope: "machine" });
});

test("R-metrics-089: this repo cut to a rule counts exactly what it shows", () => {
  const d = doc({ findings: [f("repo.a", "repo", { rule: "a" }), f("repo.b", "repo", { rule: "b" }), f("repo.w1", "repo", { rule: "x", kind: "watch" }), f("repo.w2", "repo", { rule: "y", kind: "watch" })] });
  const v = viewOf(d, "repo", undefined, "a");
  assert.equal(v.count, v.rows.length + v.install.length);
  assert.deepEqual(v.rows.map((r) => r.id), ["repo.a"]);
  assert.equal(v.all, 4);
  assert.equal(viewOf(d, "repo", undefined, "watch").count, 2, "every watch row is one group");
});

test("weight clocks: halves, their sum and the commit, absent when the series has neither", () => {
  const pt = (sha7) => ({ sha7 });
  assert.equal(CLAUDE_MD_KEY, "context.claudeMdChars");
  assert.equal(DESC_KEY, "context.descChars");
  const a = { key: "context.claudeMdChars", last: 11_955, points: [pt("aaa1111"), pt("bba067c")] };
  const d = { key: "context.descChars", last: 10_146, points: [pt("bba067c")] };
  const w = weightClocksOf([{ key: "size.p95", last: 1, points: [] }, a, d]);
  assert.equal(w.total, 22_101);
  assert.equal(w.at, "bba067c");
  assert.equal(weightClocksOf([a]).total, null, "one half is not the total");
  assert.equal(weightClocksOf([d]).at, "bba067c");
  assert.equal(weightClocksOf([{ key: "size.p95", last: 1, points: [] }]), null);
  assert.equal(weightClocksOf(undefined), null);
});

test("a screen cut spans every scope and its count is the rows it lists", () => {
  const d = doc();
  d.findings.push(f("machine.cold", "machine", { evidence: { screen: "tokens" } }), f("repo.costly", "repo", { evidence: { screen: "tokens" } }));
  const v = viewOf(d, "repo", undefined, undefined, "tokens");
  assert.equal(v.count, 2);
  assert.equal(v.all, d.findings.length);
  assert.deepEqual([...v.rows, ...v.install].map((r) => r.id).sort(), ["machine.cold", "repo.costly"]);
});

test("a card whose remedy is a door to its own evidence draws one button", () => {
  const route = { screen: "skills", repoId: null };
  assert.equal(evidenceDoorOf({ evidence: route, remedy: { kind: "door", route: { ...route } } }), null);
  assert.equal(evidenceDoorOf({ evidence: route, remedy: { kind: "door", route: { screen: "tokens" } } }), route);
  assert.equal(evidenceDoorOf({ evidence: route, remedy: { kind: "howto" } }), route);
  assert.equal(evidenceDoorOf({ evidence: null, remedy: { kind: "howto" } }), null);
});

test("a waive body carries the finding's own via", () => {
  assert.deepEqual(waiveBody("repo.watch.exposure:x", true, "r1", undefined, "accept"), { id: "repo.watch.exposure:x", waive: true, repo: "r1", via: "accept" });
  assert.equal(waiveBody("machine.m", true, null, undefined, "none").via, undefined);
});

test("not-checked rows read as plain sentences, once per reason, never a rule id", () => {
  const s = notCheckedSentences([{ rule: "permissions-broad", why: "the permission files were not read" }, { rule: "permissions-shadowed", why: "the permission files were not read" }]);
  assert.deepEqual(s, ["The permission files were not read."]);
});

test("an evidence door resolves the repo the host names by worktree path to its id, never hands the path on", () => {
  const repos = [{ id: "a429a5b275", worktreePath: "/Users/x/FeedbackPlatform" }, { id: "0e849abf45", worktreePath: "/Users/x/Talking-sandwatch" }];
  // The real shape: findings carry the repo key (a worktree path) in evidence.repoId.
  assert.equal(doorRepoId(repos, "/Users/x/FeedbackPlatform", null), "a429a5b275");
  assert.equal(doorRepoId(repos, "/Users/x/FeedbackPlatform/", "0e849abf45"), "a429a5b275");
  assert.equal(doorRepoId(repos, "a429a5b275", null), "a429a5b275");
  // Unknown or absent: the repo the check is drilled into, else nothing (never the raw path).
  assert.equal(doorRepoId(repos, "/gone", "0e849abf45"), null); // an unknown named repo is not the drilled one
  assert.equal(doorRepoId(repos, undefined, "0e849abf45"), "0e849abf45");
  assert.equal(doorRepoId(repos, "/gone", "nope"), null);
});

test("a backend a plugin added is named by the label the desktop sent, never by its raw id", () => {
  const labels = backendLabels([{ id: "claude", label: "Claude Code" }, { id: "acme", label: "ACME Agent" }]);
  assert.deepEqual(labels, { claude: "Claude Code", acme: "ACME Agent" });
  assert.deepEqual(backendLabels(null), {});
});

test("Check again always ends on a line: the check's time, then no change or how many checks changed", () => {
  const at = new Date(2026, 10, 18, 14, 2).getTime();
  const f = (id, what) => ({ id, rule: id, scope: "repo", kind: "context", weight: "finding", what, backends: {}, evidence: null, remedy: { kind: "none" }, waive: { via: "none" } });
  const before = { findings: [f("repo.a", "CLAUDE.md is 14 kB"), f("repo.b", "no tests")], passed: [], notChecked: [], absent: [], at: at - 60000 };
  assert.equal(checkAgainWords(null, { ...before, at }, "repo"), "Checked 14:02.");
  assert.equal(checkAgainWords(before, { ...before, at }, "repo"), "Checked 14:02. No change.");
  const after = { ...before, at, findings: [f("repo.a", "CLAUDE.md is 11 kB")], passed: [{ id: "repo.b", rule: "b", scope: "repo", what: "tests", backends: {} }] };
  assert.equal(checkAgainWords(before, after, "repo"), "Checked 14:02. 2 checks changed.");
  // Another scope's change is not this scope's.
  assert.equal(checkAgainWords(before, { ...before, at, findings: [...before.findings, { ...f("machine.x", "x"), scope: "machine" }] }, "repo"), "Checked 14:02. No change.");
});

test("Setup & health's tabs split the scopes: This repo has repo and all repos, This desktop machine and account", () => {
  assert.deepEqual(scopesOfTab("repo"), ["repo", "all"]);
  assert.deepEqual(scopesOfTab("desktop"), ["machine", "account"]);
  for (const s of ["repo", "all", "machine", "account"]) assert.ok(scopesOfTab(tabOfScope(s)).includes(s));
});
