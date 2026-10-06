/**
 * `transcriptText` — the plain-text rendering of the reader's document.
 *
 * Why it is pinned: this is what the select/copy button produces whenever no
 * terminal is mounted, which is every time you are in reader view and every
 * time the link is down. Its failure mode is the one that sent us here in the
 * first place — an empty sheet that looks like a broken button rather than an
 * error. A formatter that silently drops prompts, or renders a turn with no
 * text at all, reproduces exactly that.
 *
 *     node --test packages/shared/test/transcriptText.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { transcriptText } from "../dist/index.js";

const doc = (turns) => ({
  sessionId: "s1", source: "jsonl", turns, truncated: false, bytes: 0, updatedAt: 0, detail: "lite",
});

test("a turn renders its prompt, its prose and its tool calls", () => {
  const out = transcriptText(doc([{
    id: "t1", n: 2, prompt: "fix the build", promptLabel: "fix the build",
    sentAt: 0, toolCount: 1, files: [], sidechains: 0,
    blocks: [
      { kind: "text", text: "Looking at it." },
      { kind: "tool", id: "x", name: "Bash", label: "npm run build", omitted: true },
    ],
  }]));

  assert.match(out, /#2/);
  assert.match(out, /> fix the build/);
  assert.match(out, /Looking at it\./);
  assert.match(out, /\[Bash\] npm run build/);
});

test("a lite tool block says its input and result were not loaded", () => {
  const out = transcriptText(doc([{
    id: "t1", n: 1, prompt: "go", promptLabel: "go", toolCount: 1, files: [], sidechains: 0,
    blocks: [{ kind: "tool", id: "x", name: "Read", label: "src/App.tsx", omitted: true }],
  }]));
  assert.match(out, /not loaded/);
});

test("a failed tool is marked, and a real result is carried", () => {
  const out = transcriptText(doc([{
    id: "t1", n: 1, prompt: "go", promptLabel: "go", toolCount: 1, files: [], sidechains: 0,
    blocks: [{ kind: "tool", id: "x", name: "Bash", label: "false", ok: false, result: "exit 1" }],
  }]));
  assert.match(out, /FAILED/);
  assert.match(out, /exit 1/);
});

test("an empty document renders as empty, not as whitespace", () => {
  // The caller distinguishes "" from real text to decide whether to show its
  // own explanation, so a document with nothing in it must not come back as
  // a string of separators.
  assert.equal(transcriptText(doc([])), "");
});

test("a turn whose blocks are all blank still shows the prompt", () => {
  const out = transcriptText(doc([{
    id: "t1", n: 7, prompt: "still here?", promptLabel: "still here?", toolCount: 0, files: [], sidechains: 0,
    blocks: [{ kind: "text", text: "   " }],
  }]));
  assert.match(out, /> still here\?/);
});

test("thinking blocks are kept, and labelled as thinking", () => {
  const out = transcriptText(doc([{
    id: "t1", n: 1, prompt: "go", promptLabel: "go", toolCount: 0, files: [], sidechains: 0,
    blocks: [{ kind: "thinking", text: "weighing it up" }],
  }]));
  assert.match(out, /\[thinking\]/);
  assert.match(out, /weighing it up/);
});
