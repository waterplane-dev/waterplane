/**
 * The status line from VS Code's own Copilot Chat logs: present only on a desktop that has them,
 * worded as a local count (never GitHub's figure), and found where each OS keeps VS Code's `User`.
 * The replay and the tally are pinned by packages/vscode/test/copilotlocal.test.mjs, which bundles
 * the same module.
 *
 *     node --test packages/extensions/copilot-usage/test/vscodelocal.test.mjs   (after the host build)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const D = "../../../host/dist/extensions/copilot-usage";
const { localStatus, vscodeUserDirs, CopilotLocalReader } = await import(`${D}/host/index.mjs`);

const NOW = Date.UTC(2026, 9, 21, 12);

test("no Copilot Chat logs and no plan: no status line at all", async () => {
  const d = await new CopilotLocalReader(mkdtempSync(join(tmpdir(), "cpl-none-"))).read(NOW);
  assert.equal(localStatus(d), null);
  assert.equal(localStatus(null), null);
});

test("a month's requests become one status line that says where they were counted", async () => {
  const user = mkdtempSync(join(tmpdir(), "cpl-user-"));
  const dir = join(user, "workspaceStorage", "w1", "chatSessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), [
    JSON.stringify({ kind: 0, v: { requests: [{ timestamp: Date.UTC(2026, 9, 3), modelId: "copilot/claude-opus-4.7" }] } }),
    JSON.stringify({ kind: 1, k: ["requests", 0, "result"], v: { details: "Claude Opus 4.7 • 7.5x" } }),
  ].join("\n"));
  const s = localStatus(await new CopilotLocalReader(user).read(NOW));
  assert.equal(s.tone, "ok");
  assert.equal(s.text, "plan unknown · 7.5 premium requests this month in this desktop's VS Code — counted from its chat logs, not GitHub's figure");
});

test("vscodeUserDirs looks where each OS keeps VS Code, and lists only what exists", () => {
  const home = mkdtempSync(join(tmpdir(), "cpl-home-"));
  assert.deepEqual(vscodeUserDirs(home, "darwin"), []);
  const mac = join(home, "Library", "Application Support", "Code - Insiders", "User");
  mkdirSync(mac, { recursive: true });
  assert.deepEqual(vscodeUserDirs(home, "darwin"), [mac]);
  const appData = join(home, "Roaming");
  const win = join(appData, "Code", "User");
  mkdirSync(win, { recursive: true });
  assert.deepEqual(vscodeUserDirs(home, "win32", appData), [win]);
});
