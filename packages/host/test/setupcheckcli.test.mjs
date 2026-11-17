/**
 * `setup-check` (cli/setupcheck.ts): argument parsing, the text report, and a real run over a temp
 * repo and a temp CLAUDE_CONFIG_DIR with no daemon. Exit 0 always; "not checked" never reads as passed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseSetupCheckArgs, setupCheckLines, allReposLines, run } from "../dist/cli/setupcheck.js";

test("args: dir, --json, unknown option, second dir", () => {
  assert.deepEqual(parseSetupCheckArgs(["x", "--json"]), { dir: "x", json: true, help: false, all: false });
  assert.ok("error" in parseSetupCheckArgs(["--nope"]));
  assert.ok("error" in parseSetupCheckArgs(["a", "b"]));
});

test("report: counts line, grouped scopes, passed and not-checked lists always shown", () => {
  const backends = { understood: ["claude"], unread: [] };
  const lines = setupCheckLines({
    findings: [{ id: "repo.x", rule: "x", scope: "repo", kind: "quality", weight: "finding", what: "CLAUDE.md is big", backends: { understood: ["claude"], unread: [{ id: "othercli", why: "no reader" }] }, evidence: null, remedy: { kind: "words", words: "w" }, waive: {} }],
    passed: [{ id: "repo.y", rule: "y", scope: "repo", what: "Skills have names.", backends, at: 1 }],
    notChecked: [{ rule: "machine.z", scope: "machine", why: "the session history is kept by the running host" }],
    absent: [],
  }).join("\n");
  assert.match(lines, /1 finding · 1 check passed · 1 not checked/);
  assert.match(lines, /This repo\n  1\. CLAUDE.md is big/);
  assert.match(lines, /not read: othercli/);
  assert.match(lines, /Checked, nothing to fix\n  - Skills have names/);
  assert.match(lines, /Not checked\n  - Not checked: the session history/);
});

test("run over a temp repo and a temp config dir: exit 0, JSON has the lists", async () => {
  const repo = mkdtempSync(join(tmpdir(), "wp-sc-repo-"));
  const cfg = mkdtempSync(join(tmpdir(), "wp-sc-cfg-"));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "CLAUDE.md"), "# Rules\n- be brief\n");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const out = [];
  const log = console.log;
  console.log = (s) => out.push(String(s));
  try {
    assert.equal(await run([repo, "--json"]), 0);
  } finally { console.log = log; if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
  const doc = JSON.parse(out.join("\n"));
  for (const k of ["findings", "passed", "notChecked", "absent"]) assert.ok(Array.isArray(doc[k]), k);
  assert.ok(doc.passed.length + doc.notChecked.length > 0, "never an empty view");
  assert.ok(doc.absent.some((a) => /session history/.test(a.what)));
});

test("args: --all", () => {
  assert.equal(parseSetupCheckArgs(["--all", "r"]).all, true);
});

test("all-repos report: a repeated finding once with its repos, then nothing open, then not checked", () => {
  const lines = allReposLines({
    groups: [{ rule: "context-weight", kind: "quality", weight: "finding", what: "Heavy.", ranIn: 3, unreadIn: 1, repos: [{ repoId: "a", name: "alpha", findingIds: ["x"] }, { repoId: "b", name: "beta", findingIds: ["y"] }] }],
    clear: [{ repoId: "c", name: "gamma", passed: 4, notChecked: 2 }],
    notChecked: [{ repoId: "d", name: "delta", why: "timed out" }],
  }, 0).join("\n");
  assert.equal(lines.match(/Heavy\./g).length, 1);
  assert.match(lines, /in 2 of 3 repos · not checked in 1\n  - alpha\n  - beta/);
  assert.match(lines, /Nothing open\n  - gamma \(4 checks passed · 2 not checked\)/);
  assert.match(lines, /Not checked\n  - delta: timed out/);
  assert.match(lines, /no saving lines/);
});

test("--all over a temp root: exit 0, two repos, one rollup", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp-sc-root-"));
  const cfg = mkdtempSync(join(tmpdir(), "wp-sc-cfg-"));
  for (const n of ["one", "two"]) {
    const d = join(root, n);
    mkdirSync(d);
    execFileSync("git", ["init", "-q", d]);
    writeFileSync(join(d, "CLAUDE.md"), "# Rules\n");
  }
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const out = [];
  const log = console.log;
  console.log = (s) => out.push(String(s));
  try { assert.equal(await run(["--all", root, "--json"]), 0); }
  finally { console.log = log; if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
  const doc = JSON.parse(out.join("\n"));
  assert.equal(doc.total, 2);
  const seen = doc.rollup.groups.flatMap((g) => g.repos).length + doc.rollup.clear.length + doc.rollup.notChecked.length;
  assert.ok(seen >= 2, "every repo lands in a group, nothing open or not checked");
});

test("run reads what the phone stored: a waiver set aside for this repo is not listed as a finding", async () => {
  const { realpathSync } = await import("node:fs");
  const { SetupPrefsStore } = await import("../dist/setupprefs.js");
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wp-sc-repo-")));
  const cfg = mkdtempSync(join(tmpdir(), "wp-sc-cfg-"));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "wp-sc-state-")));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "CLAUDE.md"), "# Rules\n- be brief\n");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const read = async (stateRoot) => {
    const out = [];
    const log = console.log;
    console.log = (s) => out.push(String(s));
    try { assert.equal(await run([repo, "--json"], undefined, stateRoot), 0); } finally { console.log = log; }
    return JSON.parse(out.join("\n"));
  };
  try {
    const open = await read(state);
    assert.ok(open.findings.some((f) => f.id === "repo.efficiency-rules"), "listed while nothing is waived");
    assert.equal(new SetupPrefsStore(state).setRepoWaived(repo, "repo.efficiency-rules", { at: "2026-11-16T00:00:00Z", reason: "on purpose" }).ok, true);
    const set = await read(state);
    assert.ok(!set.findings.some((f) => f.id === "repo.efficiency-rules"), "the stored waiver reaches the CLI");
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
});
