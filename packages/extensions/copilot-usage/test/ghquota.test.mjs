/**
 * Copilot's quota parse over the real `gh api /copilot_internal/user` body (2026-10-15, this
 * desktop): chat 9 / 200 used (95.3 % remaining) ⇒ 5 %, reset 2026-11-01; `has_quota:false`,
 * `unlimited` and an empty or malformed body are ABSENT, never a guessed number; gh missing ⇒ null.
 *
 *     node --test packages/extensions/copilot-usage/test/ghquota.test.mjs   (after the host build)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const D = "../../../host/dist/extensions/copilot-usage";
const { parseCopilotQuota, fetchCopilotQuota, makeProbe, onPath } = await import(`${D}/host/index.mjs`);

const NOW = Date.UTC(2026, 9, 15, 12);
const FIXTURE = {
  login: "someone",
  copilot_plan: "individual",
  quota_reset_date_utc: "2026-11-01T00:00:00Z",
  quota_snapshots: {
    chat: { has_quota: true, unlimited: false, entitlement: 200, remaining: 191, credits_used: 9, percent_remaining: 95.3, overage_count: 0, token_based_billing: true },
    completions: { has_quota: true, unlimited: true, entitlement: 0, remaining: 0, credits_used: 0, percent_remaining: 100, overage_count: 0 },
    premium_interactions: { has_quota: false, unlimited: false, entitlement: 0, remaining: 0, credits_used: 0, percent_remaining: 100, overage_count: 0 },
  },
};
const clone = () => JSON.parse(JSON.stringify(FIXTURE));

test("the real body: chat 5 % of a month, 9 / 200 credits, reset Nov 1; premium without quota dropped", () => {
  const r = parseCopilotQuota(FIXTURE, NOW);
  assert.equal(r.source, "copilot");
  assert.equal(r.label, "Copilot");
  assert.equal(r.checkedAt, NOW);
  assert.deepEqual(r.windows, [
    { id: "chat", unit: "mo", pct: 5, resetAt: Date.UTC(2026, 10, 1), used: 9, limit: 200, unitName: "credits" },
  ]);
});

test("the body as text parses the same", () => {
  assert.deepEqual(parseCopilotQuota(JSON.stringify(FIXTURE), NOW), parseCopilotQuota(FIXTURE, NOW));
});

test("premium counts only with a real quota", () => {
  const b = clone();
  b.quota_snapshots.premium_interactions = { has_quota: true, unlimited: false, entitlement: 300, credits_used: 30, percent_remaining: 90 };
  const r = parseCopilotQuota(b, NOW);
  assert.deepEqual(r.windows.map((w) => [w.id, w.pct, w.used, w.limit]), [["chat", 5, 9, 200], ["premium", 10, 30, 300]]);
});

test("unlimited drops the window; nothing left is null", () => {
  const b = clone();
  b.quota_snapshots.chat.unlimited = true;
  assert.equal(parseCopilotQuota(b, NOW), null);
});

test("empty snapshots, no snapshots, malformed ⇒ null", () => {
  assert.equal(parseCopilotQuota({ quota_snapshots: {} }, NOW), null);
  assert.equal(parseCopilotQuota({ copilot_plan: "individual" }, NOW), null);
  assert.equal(parseCopilotQuota("not json", NOW), null);
  assert.equal(parseCopilotQuota(null, NOW), null);
  assert.equal(parseCopilotQuota([], NOW), null);
  assert.equal(parseCopilotQuota({ message: "Not Found", documentation_url: "x" }, NOW), null);
});

test("an out-of-range percent is not a number: the count form alone stays", () => {
  const b = clone();
  b.quota_snapshots.chat.percent_remaining = 4300;
  assert.deepEqual(parseCopilotQuota(b, NOW).windows[0], { id: "chat", unit: "mo", pct: null, resetAt: Date.UTC(2026, 10, 1), used: 9, limit: 200, unitName: "credits" });
  b.quota_snapshots.chat.credits_used = "nine";
  assert.equal(parseCopilotQuota(b, NOW), null);
});

test("no reset date, or one that does not parse, is null — never a guessed day", () => {
  const b = clone();
  delete b.quota_reset_date_utc;
  assert.equal(parseCopilotQuota(b, NOW).windows[0].resetAt, null);
  b.quota_reset_date_utc = "next month";
  assert.equal(parseCopilotQuota(b, NOW).windows[0].resetAt, null);
});

test("gh missing ⇒ a miss, and the probe answers null (logged once)", async () => {
  const got = await fetchCopilotQuota(join(tmpdir(), "no-such-gh-binary-here"));
  assert.equal(got.miss, "gh-missing");
  const logs = [];
  const probe = makeProbe(() => fetchCopilotQuota(join(tmpdir(), "no-such-gh-binary-here")), (m) => logs.push(m), () => NOW);
  assert.equal(await probe(), null);
  assert.equal(await probe(), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /gh-missing/);
});

test("a stub gh: the body is read; a failing gh is a miss, never a number", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghq-"));
  const ok = join(dir, "gh-ok");
  writeFileSync(ok, `#!/bin/sh\n[ "$1" = api ] && [ "$2" = /copilot_internal/user ] || exit 9\ncat <<'EOF'\n${JSON.stringify(FIXTURE)}\nEOF\n`);
  chmodSync(ok, 0o755);
  const bad = join(dir, "gh-bad");
  writeFileSync(bad, "#!/bin/sh\necho 'gh: Not Found (HTTP 404)' >&2\nexit 1\n");
  chmodSync(bad, 0o755);
  const probe = makeProbe(() => fetchCopilotQuota(ok), () => {}, () => NOW);
  assert.equal((await probe()).windows[0].pct, 5);
  const miss = await fetchCopilotQuota(bad);
  assert.equal(miss.miss, "gh-failed");
  assert.match(miss.detail, /404/);
  assert.equal(await makeProbe(() => fetchCopilotQuota(bad), () => {}, () => NOW)(), null);
});

test("onPath stats, never runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghp-"));
  writeFileSync(join(dir, "copilot"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "copilot"), 0o755);
  writeFileSync(join(dir, "notexec"), "x");
  assert.equal(onPath("copilot", dir), true);
  assert.equal(onPath("notexec", dir), false);
  assert.equal(onPath("copilot", "/nonexistent-dir"), false);
});

test("the probe registers as COPILOT's account, so a claude session's header never draws it", async () => {
  const { activate } = await import(`${D}/host/index.mjs`);
  const dir = mkdtempSync(join(tmpdir(), "gha-"));
  writeFileSync(join(dir, "copilot"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "copilot"), 0o755);
  const defs = [];
  const PATH = process.env.PATH;
  process.env.PATH = dir;
  try {
    activate({ log: () => {}, usageProbe: (def) => defs.push(def), env: () => undefined });
  } finally { process.env.PATH = PATH; }
  assert.equal(defs.length, 1);
  assert.equal(defs[0].source, "copilot");
  // Without it the reading is account-only and `headerReadings` hands it to a claude session.
  assert.equal(defs[0].backend, "copilot");
});
