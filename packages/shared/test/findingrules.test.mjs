/** The finding rules: facts in, findings + checked-off list out. node --test packages/shared/test/findingrules.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { repoRules, machineRules, accountRules } from "../dist/index.js";

const now = Date.UTC(2026, 10, 16);
const chk = (id, status, extra = {}) => ({ id, label: id, status, detail: `${id} detail`, fix: null, ...extra });
const ids = (r) => r.findings.map((f) => f.id);

test("repo: a failing check is a finding, a passing one is checked off, an absent one is not checked", () => {
  const r = repoRules({ now, repo: "r", checks: [
    chk("context-weight", "warn", { advisory: true, alwaysOnChars: 20000 }),
    chk("env-gitignored", "fail", { fix: "gitignore-env" }),
    chk("auto-compact", "pass"),
    chk("claude-md", "warn", { fix: "claude-md" }),
    chk("exposure:a", "warn", { exposure: {} }),
  ], instructions: { overlaps: [], warnChars: 16000 } });
  assert.ok(ids(r).includes("repo.context-weight"));
  const cw = r.findings.find((f) => f.id === "repo.context-weight");
  assert.equal(cw.weight, "consider");
  assert.equal(cw.remedy.prompt, "groom");
  const env = r.findings.find((f) => f.id === "repo.env-gitignored");
  assert.equal(env.weight, "finding");
  assert.deepEqual(env.remedy, { kind: "fix", fixId: "gitignore-env" });
  assert.ok(r.passed.some((p) => p.id === "repo.auto-compact"));
  assert.ok(ids(r).includes("repo.install.claude-md"));
  assert.ok(ids(r).some((i) => i.startsWith("repo.watch.")));
  assert.ok(r.notChecked.some((n) => n.rule === "skill-frontmatter"));
  assert.ok(r.passed.some((p) => p.rule === "instruction-overlap"));
});

test("repo: overlap, permissions, health, efficiency", () => {
  const r = repoRules({ now, repo: "r", checks: [],
    instructions: { overlaps: [{ a: "CLAUDE.md", b: "AGENTS.md", chars: 900, ofSmaller: 0.9, readers: ["claude"] }], warnChars: 16000 },
    permissions: [{ source: "project", list: "allow", rule: "Bash", notes: ["Allows all of Bash: x."] }, { source: "user", list: "allow", rule: "Edit", notes: ["Allows all of Edit: y."] }],
    health: { alerts: [{ entry: "size", level: "severe", text: "severe: a.ts" }, { entry: "dups", level: "warn", text: "warn" }] },
    efficiency: { present: false, target: "AGENTS.md" } });
  assert.ok(ids(r).includes("repo.instruction-overlap:CLAUDE.md+AGENTS.md"));
  const pb = r.findings.find((f) => f.id === "repo.permissions-broad");
  assert.deepEqual(pb.evidence.ruleKeys, ["allow:Bash"]);
  assert.ok(r.passed.some((p) => p.id === "repo.permissions-shadowed"));
  assert.deepEqual(ids(r).filter((i) => i.startsWith("repo.health")), ["repo.health-alert:size"]);
  assert.deepEqual(r.findings.find((f) => f.id === "repo.efficiency-rules").remedy, { kind: "write", target: "AGENTS.md" });
});

test("repo: a waived finding keeps the waiver", () => {
  const r = repoRules({ now, repo: "r", checks: [chk("context-weight", "warn", { advisory: true, ignored: true })] });
  assert.ok(r.findings[0].waive.waived);
});

test("repo: no backend understood is not checked, never passed (saving rules)", () => {
  const r = repoRules({ now, repo: "r", backends: { understood: [], unread: [{ id: "othercli", why: "store not understood" }] },
    checks: [chk("context-weight", "warn", { advisory: true, alwaysOnChars: 20000 })], instructions: { overlaps: [], warnChars: 16000 }, points: [] });
  assert.equal(r.findings[0].saving, undefined);
  assert.ok(r.findings.length === 1);
  assert.ok(r.notChecked.some((n) => n.rule === "context-weight" && /othercli/.test(n.why)));
});

const ledger = { usd: 100, tok: 1e6, writeTok: 10000, writeUsd: 40, cold: { usd: 10, count: 5 }, agentUsd: 30, agentRuns: 9, conversations: 30, topUsd: [20, 10, 5], models: [{ label: "m", tok: 1000, usd: 50 }], turns: 100 };

test("machine: ledger levers become findings, quiet ones are checked off", () => {
  const r = machineRules({ now, ledger, trend: { cur: { usd: 30, turns: 30 }, prev: { usd: 10, turns: 30 } },
    globalInstructions: { chars: 30000, warnChars: 16000 },
    skills: [{ id: "a", level: "user", listingChars: 300, usesEverywhere: { d30: 0 } }, { id: "b", level: "user", listingChars: 100, usesEverywhere: { d30: 4 } }],
    permissions: [{ source: "user", list: "allow", rule: "Bash", notes: ["Allows all of Bash: x."] }],
    autoCompact: { source: "unset", status: "warn", machine: { source: "unset", status: "warn" } },
    hostChecks: [chk("live-price-list", "warn", { fix: "price" }), chk("tailscale", "pass")] });
  for (const i of ["cold-cache", "cache-writes", "subagent-share", "concentration", "model-mix", "request-trend", "global-instructions", "skills-unused", "permissions-broad", "auto-compact", "price-list"]) {
    assert.ok(ids(r).includes(`machine.${i}`), i);
  }
  assert.deepEqual(r.findings.find((f) => f.id === "machine.skills-unused").evidence.ids, ["a"]);
  assert.equal(r.findings.find((f) => f.id === "machine.cold-cache").evidence.box, "cold");
  assert.ok(r.passed.some((p) => p.id === "machine.install.tailscale"));
});

test("machine: a quiet ledger lists what was checked; an absent one says not checked", () => {
  const q = machineRules({ now, ledger: { ...ledger, writeUsd: 1, cold: { usd: 0, count: 0 }, agentUsd: 1, topUsd: [1], models: [] } });
  assert.ok(q.passed.some((p) => p.id === "machine.cache-writes"));
  assert.ok(q.passed.some((p) => p.id === "machine.cold-cache"));
  const none = machineRules({ now });
  assert.equal(none.findings.length, 0);
  assert.ok(none.notChecked.length >= 6);
  const blind = machineRules({ now, ledger, backends: { understood: [], unread: [{ id: "othercli", why: "x" }] } });
  assert.equal(blind.findings.length, 0);
  assert.ok(blind.notChecked.some((n) => n.rule === "cold-cache"));
});

test("account: pace rules", () => {
  const r = accountRules({ now, usage: { week: { runsOut: true, text: "Week on course to run out." }, period: { firing: false, text: "" }, copilot: null } });
  assert.deepEqual(ids(r), ["account.week-pace"]);
  assert.ok(r.passed.some((p) => p.id === "account.period-pace"));
  assert.ok(r.notChecked.some((n) => n.rule === "copilot-quota"));
  const blind = accountRules({ now, backends: { understood: [], unread: [{ id: "claude", why: "no log" }] }, usage: { week: { runsOut: true, text: "x" } } });
  assert.equal(blind.findings.length, 0);
});

test("R-metrics-086: auto-compact from the user-level setting, the env or unset is ONE machine finding, never a repo finding", () => {
  for (const source of ["user", "unset", "env"]) {
    const repo = repoRules({ now, repo: "r", checks: [chk("auto-compact", "warn", { fix: "auto-compact" })], autoCompact: { source, status: "warn" } });
    assert.ok(!ids(repo).includes("repo.auto-compact"), source);
    assert.ok(!repo.passed.some((p) => p.id === "repo.auto-compact"), "an open window is not a pass");
    assert.ok(ids(machineRules({ now, autoCompact: { source, status: "warn", machine: { source, status: "warn" } } })).includes("machine.auto-compact"), source);
  }
});

test("machine auto-compact: an env window that warns is a finding; no machine reading is not checked, never a pass", () => {
  const env = machineRules({ now, autoCompact: { source: "env", status: "warn", machine: { source: "env", status: "warn" } } });
  assert.ok(ids(env).includes("machine.auto-compact"));
  assert.ok(!env.passed.some((p) => p.id === "machine.auto-compact"));
  const none = machineRules({ now, autoCompact: { source: "project", status: "warn" } });
  assert.ok(!none.passed.some((p) => p.id === "machine.auto-compact"));
  assert.ok(none.notChecked.some((n) => n.rule === "auto-compact"));
});

test("R-metrics-086: a repo's own settings override stays that repo's finding; the machine judges the user level", () => {
  const ac = { source: "project", status: "warn", machine: { source: "user", status: "pass" } };
  const repo = repoRules({ now, repo: "r", checks: [chk("auto-compact", "warn", { fix: "auto-compact" })], autoCompact: ac });
  assert.ok(ids(repo).includes("repo.auto-compact"));
  const m = machineRules({ now, autoCompact: ac });
  assert.ok(!ids(m).includes("machine.auto-compact"));
  assert.ok(m.passed.some((p) => p.id === "machine.auto-compact"));
});

test("repo: a context-weight warn that is only a repeat is the overlap finding's, never a second weight finding", () => {
  const r = repoRules({ now, repo: "r", checks: [chk("context-weight", "warn", { advisory: true, alwaysOnChars: 3000, overlapOnly: true, detail: "CLAUDE.md and AGENTS.md repeat 900 chars" })],
    instructions: { overlaps: [{ a: "CLAUDE.md", b: "AGENTS.md", chars: 900, readers: ["claude"] }], warnChars: 16000 } });
  assert.ok(!ids(r).includes("repo.context-weight"));
  assert.ok(r.passed.some((p) => p.id === "repo.context-weight"));
  assert.ok(ids(r).includes("repo.instruction-overlap:CLAUDE.md+AGENTS.md"));
});

test("machine: a trend or concentration too thin to judge is not checked, never passed", () => {
  const thin = { usd: 30, tok: 3000000, writeTok: 0, writeUsd: 0, cold: null, agentUsd: 0, agentRuns: 0, conversations: 5, topUsd: [27, 1, 1, 1, 0], models: [], turns: 12 };
  const r = machineRules({ now, ledger: thin, trend: { cur: { usd: 3, turns: 8 }, prev: { usd: 4, turns: 12 } } });
  for (const rule of ["concentration", "request-trend"]) {
    assert.ok(!r.passed.some((p) => p.rule === rule), `${rule} must not be passed on thin data`);
    assert.ok(r.notChecked.some((n) => n.rule === rule), `${rule} is not checked`);
  }
});

test("repo: a saving is priced off Claude's history only for a repeat Claude reads", () => {
  const points = Array.from({ length: 12 }, (_, i) => ({ id: "s" + i, t0: now - (i + 1) * 3600e3 * 5, repo: "r", fresh: true, headless: false, model: "claude-sonnet-4-5", start: 20000, req: 10 }));
  const o = (readers) => ({ a: ".github/copilot-instructions.md", b: "AGENTS.md", chars: 9000, ofSmaller: 0.9, readers });
  const at = (readers) => repoRules({ now, repo: "r", points, checks: [], instructions: { overlaps: [o(readers)], warnChars: 16000 } })
    .findings.find((f) => f.rule === "instruction-overlap");
  assert.equal(at(["copilot"]).saving, undefined, "no Claude request carried a Copilot-only repeat");
  assert.ok(at(["claude", "copilot"]).saving, "a repeat Claude reads is priced");
});

test("docInput: an unmeasured cold-start premium stays null, never a zero that passes the cold-cache rule", async () => {
  const { docInput } = await import("../dist/findings/rules/insights.js");
  const base = { cost: { total: 1, cacheWrite: 0 }, totals: { cacheWrite: 0, turns: 1 }, subagentCost: { total: 0 }, subagentLogs: 0, conversations: 1, models: [] };
  assert.equal(docInput({ ...base }).cold, null);
  assert.equal(docInput({ ...base, coldStarts: { count: 3 } }).cold, null);
  assert.deepEqual(docInput({ ...base, coldStarts: { count: 3, premiumUsd: 0 } }).cold, { usd: 0, count: 3 });
});

test("a rule that reads only files carries no backends line; one that reads conversations keeps it", () => {
  const backends = { understood: ["claude"], unread: [{ id: "codex", why: "its own store" }] };
  const none = { understood: [], unread: [] };
  const r = repoRules({ now, repo: "r", backends, checks: [chk("env-gitignored", "fail"), chk("claude-md", "pass")],
    instructions: { overlaps: [], warnChars: 16000 }, efficiency: { present: false, target: "CLAUDE.md" } });
  assert.deepEqual(r.findings.find((f) => f.id === "repo.efficiency-rules").backends, none);
  assert.deepEqual(r.findings.find((f) => f.id === "repo.env-gitignored").backends, none);
  assert.deepEqual(r.passed.find((p) => p.id === "repo.install.claude-md").backends, none);
  const m = machineRules({ now, backends, skills: [{ id: "s", level: "user", usesEverywhere: { d30: 0 }, listingChars: 100 }] });
  assert.deepEqual(m.findings.find((f) => f.id === "machine.skills-unused").backends, backends);
});
