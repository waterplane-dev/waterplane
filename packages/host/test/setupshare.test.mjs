/**
 * The desktop's half of the setup block (R-metrics-073, `setupshare.ts`): the repo identity is one
 * hash for every spelling of one remote and nothing for a local path, and the outbox write goes
 * through the strict parser, so an extra field never reaches the file and a malformed block writes
 * nothing.
 *
 *     npm run build -w @waterplane/host && node --test packages/host/test/setupshare.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shareRepoOfUrl, setupShareFileName, writeSetupShare } from "../dist/setupshare.js";

const block = {
  kind: "agent-setup-block", schema: 1, from: "Ana", backend: "claude", models: ["claude-opus-4-1"], cli: ["2.1.300"],
  repo: { name: "waterplane", key: "0123456789abcdef" }, days: { from: "2026-10-31", to: "2026-11-14" }, startTok: 41000,
  groups: [{ group: "repo", chars: 12000, parts: { projectMd: 12000 } }],
};

test("R-metrics-073: one identity for every spelling of a remote, none for a local path", () => {
  const a = shareRepoOfUrl("git@github.com:Org/Waterplane.git");
  const b = shareRepoOfUrl("https://github.com/org/waterplane/");
  assert.ok(a);
  assert.deepEqual(a, b);
  assert.equal(a.name, "waterplane");
  assert.match(a.key, /^[0-9a-f]{16}$/);
  assert.equal(shareRepoOfUrl("/Users/someone/dev/repo"), null);
  assert.equal(shareRepoOfUrl("file:///Users/someone/repo"), null);
  assert.equal(shareRepoOfUrl(null), null);
  assert.notDeepEqual(shareRepoOfUrl("git@github.com:org/other.git"), a);
});

test("R-metrics-073: the file name is a slug of the name and the last day", () => {
  assert.equal(setupShareFileName("Ana María", "2026-11-14"), "setup-ana-maria-2026-11-14.json");
  assert.equal(setupShareFileName("../../etc", "2026-11-14"), "setup-etc-2026-11-14.json");
  assert.equal(setupShareFileName("李", "2026-11-14"), "setup-block-2026-11-14.json");
});

test("R-metrics-073: the outbox write re-reads the block strictly and keeps no extra field", () => {
  const wt = mkdtempSync(join(tmpdir(), "wp-share-"));
  const w = writeSetupShare(wt, JSON.stringify({ ...block, markers: [{ detail: "CLAUDE.md" }], sessions: 42 }));
  assert.ok(w.ok, w.error);
  assert.equal(w.relPath, ".claude/outbox/setup-ana-2026-11-14.json");
  const text = readFileSync(join(wt, w.relPath), "utf8");
  assert.doesNotMatch(text, /markers|sessions|CLAUDE\.md/);
  assert.deepEqual(JSON.parse(text), block);
  const bad = writeSetupShare(wt, JSON.stringify({ ...block, groups: [{ group: "repo", chars: 1, parts: { "mcp__slack": 3 } }] }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /named like a tool/);
  assert.deepEqual(readdirSync(join(wt, ".claude/outbox")), ["setup-ana-2026-11-14.json"]);
  assert.equal(existsSync(join(wt, ".git")), false, "never git");
});

test("R-metrics-073: an outbox that links outside the repo is refused, nothing is written there", () => {
  const wt = mkdtempSync(join(tmpdir(), "wp-share-"));
  const outside = mkdtempSync(join(tmpdir(), "wp-share-out-"));
  mkdirSync(join(wt, ".claude"));
  symlinkSync(outside, join(wt, ".claude/outbox"));
  const w = writeSetupShare(wt, JSON.stringify(block));
  assert.equal(w.ok, false);
  assert.match(w.error, /not a plain folder/);
  assert.deepEqual(readdirSync(outside), []);
});
