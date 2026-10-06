/**
 * The AUTOMATIC tab name's only input is the session's first prompt; a
 * hand-asked rename also sees the last few prompts (`sessions/record.ts`
 * `firstPromptOf` / `tabTitlePrompt` / `nameNow` / `loadSummary`). The AI
 * per-turn summary is gone; nothing about the screen, later prompts or output
 * may reach the naming call. Fixture in, verdict out: no PTY, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstPromptOf, tabTitlePrompt, recentPromptsOf, renamePrompt, nameNow, loadSummary } from "../dist/sessions/record.js";
import { NAME_INPUT_CHARS } from "../dist/sessions/knobs.js";

const session = (history) => ({ history, info: { id: "s1", cwd: "/r" }, naming: false });

test("the name is asked off the FIRST prompt only, clipped", () => {
  const s = session([
    { id: "a", kind: "prompt", text: `  fix the flaky login test ${"x".repeat(5000)}`, sentAt: 1 },
    { id: "b", kind: "prompt", text: "SECOND PROMPT", sentAt: 2 },
  ]);
  const first = firstPromptOf(s);
  assert.ok(first.startsWith("fix the flaky login test"));
  assert.equal(first.length, NAME_INPUT_CHARS);
  assert.equal(first.includes("SECOND"), false);
  const prompt = tabTitlePrompt(first);
  assert.match(prompt, /opening prompt/);
  assert.ok(prompt.includes("fix the flaky login test"));
  assert.equal(prompt.includes("SECOND"), false);
  assert.equal(firstPromptOf(session([])), "");
});

test("a hand-asked rename also sees the recent prompts, commands left out, clipped", () => {
  const s = session([
    { id: "a", kind: "prompt", text: "continue", sentAt: 1 },
    { id: "b", kind: "prompt", text: "p2", sentAt: 2 },
    { id: "c", kind: "command", text: "/compact", sentAt: 3 },
    { id: "d", kind: "prompt", text: "p3", sentAt: 4 },
    { id: "e", kind: "prompt", text: "p4", sentAt: 5 },
    { id: "f", kind: "prompt", text: "p5", sentAt: 6 },
    { id: "g", kind: "backlog", text: `wire the backend ${"y".repeat(5000)}`, sentAt: 7 },
  ]);
  const recent = recentPromptsOf(s);
  assert.deepEqual(recent.slice(0, 3), ["p3", "p4", "p5"]);
  assert.equal(recent.length, 4);
  assert.ok(recent[3].startsWith("wire the backend"));
  assert.ok(recent[3].length <= 400);
  const prompt = renamePrompt(firstPromptOf(s), recent);
  assert.ok(prompt.includes("continue"));
  assert.ok(prompt.includes("wire the backend"));
  assert.equal(prompt.includes("/compact"), false);
  assert.equal(prompt.includes("p2"), false);
  assert.deepEqual(recentPromptsOf(session([{ id: "a", kind: "prompt", text: "only", sentAt: 1 }])), []);
});

test("a hand-asked name with no prompt sent says so and buys nothing", async () => {
  const core = { sessions: new Map([["s1", session([])]]) };
  assert.deepEqual(await nameNow(core, "s1"), { reason: "no prompt has been sent to this session yet" });
  assert.deepEqual(await nameNow(core, "gone"), { reason: "that session is gone" });
});

test("a summaries file from an older build still loads — only the tab is read", () => {
  const root = mkdtempSync(join(tmpdir(), "waterplane-tabname-"));
  mkdirSync(join(root, ".usmc", "summaries"), { recursive: true });
  const core = { root };
  writeFileSync(join(root, ".usmc", "summaries", "old.json"), JSON.stringify({ text: "was a summary", len: 812, tab: "login test fix" }));
  assert.deepEqual(loadSummary(core, "old"), { tab: "login test fix" });
  writeFileSync(join(root, ".usmc", "summaries", "new.json"), JSON.stringify({ tab: "" }));
  assert.equal(loadSummary(core, "new")?.tab ?? "", "");
  assert.equal(loadSummary(core, "missing"), null);
  rmSync(root, { recursive: true, force: true });
});
