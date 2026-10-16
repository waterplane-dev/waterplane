/**
 * `promptText`: a fork's override file, and the pinned default everywhere else.
 * The config dir is pointed at a temp dir by `WATERPLANE_CONFIG_DIR`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wp-prompts-"));
process.env.WATERPLANE_CONFIG_DIR = dir;
const { promptText, overriddenPrompts } = await import("../dist/prompts.js");
const { NAME_SYSTEM } = await import("../dist/naming.js");
mkdirSync(join(dir, "prompts"), { recursive: true });
const put = (n, t) => writeFileSync(join(dir, "prompts", n + ".md"), t);
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("absent file: the default, byte for byte", () => {
  assert.equal(promptText("tab-name", NAME_SYSTEM), NAME_SYSTEM);
  assert.deepEqual(overriddenPrompts(), []);
});

test("an override is used, and re-read on the next call", () => {
  put("tab-name", "mine\nline two\n");
  assert.equal(promptText("tab-name", "default"), "mine\nline two");
  put("tab-name", "changed");
  assert.equal(promptText("tab-name", "default"), "changed");
  assert.deepEqual(overriddenPrompts(), ["tab-name"]);
});

test("a bad name is refused and never reads a file", () => {
  put("evil", "x");
  for (const n of ["../prompts/evil", "Evil", "a/b", "", "a.b"]) assert.equal(promptText(n, "default"), "default");
});

test("empty or whitespace-only file: the default", () => {
  put("blank", "");
  put("spaces", " \n\t\n");
  assert.equal(promptText("blank", "default"), "default");
  assert.equal(promptText("spaces", "default"), "default");
  assert.ok(!overriddenPrompts().includes("blank"));
});

test("an unreadable entry (a directory) never throws", () => {
  mkdirSync(join(dir, "prompts", "dirish.md"));
  assert.equal(promptText("dirish", "default"), "default");
});

test("the session tab title, its rename and the assess guidance take an override; the rest of the prompt stays", async () => {
  const { tabTitlePrompt, renamePrompt } = await import("../dist/sessions/record.js");
  const { TAB_TITLE_PROMPT, RENAME_PROMPT } = await import("../dist/sessions/knobs.js");
  const { assessPrompt, ASSESS_GUIDANCE } = await import("../dist/assess/hassinput.js");
  const input = { version: 1, at: 0, cwd: "/x", items: [] };
  assert.ok(tabTitlePrompt("fix the bug").startsWith(TAB_TITLE_PROMPT + "\n\n----- THE SESSION'S OPENING PROMPT -----\nfix the bug"));
  assert.ok(renamePrompt("a", []).startsWith(RENAME_PROMPT + "\n\n"));
  assert.ok(assessPrompt(input).includes(ASSESS_GUIDANCE));
  put("session-title", "Name it in Dutch.");
  put("session-rename", "Rename it in Dutch.");
  put("assess-guidance", "Judge strictly.");
  assert.equal(tabTitlePrompt("fix the bug"), "Name it in Dutch.\n\n----- THE SESSION'S OPENING PROMPT -----\nfix the bug");
  assert.ok(renamePrompt("a", ["b"]).startsWith("Rename it in Dutch.\n\n----- THE SESSION'S OPENING PROMPT -----\na"));
  const a = assessPrompt(input);
  assert.ok(a.includes("Judge strictly.") && !a.includes(ASSESS_GUIDANCE));
  // The contract half is code: the out-file shape is still there.
  assert.match(a, /"items":\[\{"id":"<id>","verdict"/);
  for (const n of ["session-title", "session-rename", "assess-guidance"]) rmSync(join(dir, "prompts", n + ".md"));
});
