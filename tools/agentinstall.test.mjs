/**
 * The agent install path: the paste-in prompt in docs/install.md (it moved there from the README with
 * the rest of the long install detail), the one skill it sends the agent to, and the doctor flag that
 * skill's loop depends on.
 *
 * ── Why these three ─────────────────────────────────────────────────────────
 *
 * - The prompt names a path inside a clone. Move the skill and every pasted prompt dead-ends, with
 *   nothing in the repo failing — the old copy lived under `deploy/openclaw/` until it served every
 *   agent.
 * - OpenClaw's skill parser reads single-line frontmatter keys only, and `metadata` as one line of
 *   JSON. The first version had it as indented YAML-ish JSON over a dozen lines: it read as fine
 *   prose and OpenClaw would have dropped the gating with it.
 * - The prompt carries the hard "never" rules itself, so an agent that skims the skill still has
 *   them. Two copies of a rule drift; this holds the prompt's words inside the skill.
 * - `npm run doctor -- --json` reached the doctor on no OS: the root script ran a nested `npm run`,
 *   which parses `--json` as its own config, and the Windows launcher dropped every argument. An
 *   agent looping on the JSON got the human report and nothing to parse.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTALL_DOC = "docs/install.md";
const INSTALL = readFileSync(join(ROOT, INSTALL_DOC), "utf8");
const SKILL_PATH = "deploy/agent/waterplane/SKILL.md";

/** The ```text block under "## Installing with an agent", or null. */
function pastePrompt(md) {
  const at = md.indexOf("## Installing with an agent");
  if (at < 0) return null;
  const m = /```text\n([\s\S]*?)\n```/.exec(md.slice(at));
  return m ? m[1] : null;
}

test("the paste-in prompt names a skill that exists in the clone", () => {
  const prompt = pastePrompt(INSTALL);
  assert.ok(prompt, `${INSTALL_DOC} lost its paste-in prompt under '## Installing with an agent'`);
  assert.ok(prompt.includes(SKILL_PATH), `the paste-in prompt must send the agent to ${SKILL_PATH}`);
  assert.ok(existsSync(join(ROOT, SKILL_PATH)), `${SKILL_PATH} is gone — every pasted prompt now dead-ends`);
});

test("the skill's frontmatter is what OpenClaw's single-line parser can read", () => {
  const text = readFileSync(join(ROOT, SKILL_PATH), "utf8").replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fm, "SKILL.md has no frontmatter");
  const lines = fm[1].split("\n");
  for (const line of lines) {
    assert.match(line, /^[a-z][\w-]*: \S/, `frontmatter line is not 'key: value' on one line: ${JSON.stringify(line)}`);
  }
  const keys = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
  assert.equal(keys.name, "waterplane");
  const meta = JSON.parse(keys.metadata).openclaw;
  assert.ok(meta, "metadata has no 'openclaw' object");
  for (const os of meta.os ?? []) assert.ok(["darwin", "linux", "win32"].includes(os), `unknown os ${os}`);
  for (const i of meta.install ?? []) {
    assert.ok(["brew", "node", "go", "download"].includes(i.kind), `installer ${i.id}: unknown kind ${i.kind}`);
    if (i.kind === "brew") assert.deepEqual(i.os, ["darwin"], `installer ${i.id}: brew is offered on macOS only`);
  }
});

test("every hard rule the paste-in prompt states is in the skill too", () => {
  const prompt = pastePrompt(INSTALL) ?? "";
  const skill = readFileSync(join(ROOT, SKILL_PATH), "utf8");
  for (const word of ["WATERPLANE_ALLOW_PUBLIC", "0.0.0.0", "8770", "tailscale funnel", "sudo"]) {
    assert.ok(prompt.includes(word), `the paste-in prompt no longer says ${word}`);
    assert.ok(skill.includes(word), `the paste-in prompt says ${word} and the skill does not`);
  }
});

test("`npm run doctor -- --json` reaches the doctor", () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  assert.match(scripts.doctor, /\s--$/, "the doctor script must end in `--`, or a nested `npm run` swallows --json");
  const wrap = readFileSync(join(ROOT, "scripts/oswrap.mjs"), "utf8");
  assert.match(wrap, /task, \.\.\.extras\]/, "oswrap must hand the caller's arguments to the Windows task");
});
