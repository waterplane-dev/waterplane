/**
 * A prompt check that comes due while a render is still in flight is owed, not dropped.
 *
 * The render answers for the bytes it started with. A box painted after that asks for a check of
 * its own; on a machine slow enough for the render to outlast it, that check found
 * `promptRendering` set and returned, and, the box being the last thing printed, nothing armed
 * another: the box was never published. A fake core whose first render is held until released.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const boxread = await import("../dist/sessions/boxread.js");
const { PROMPT_CHECK_MS, PROMPT_SETTLE_MS } = await import("../dist/sessions/knobs.js");
const { claudeBackend } = await import("../dist/backends/claude.js");

const BOX = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel\n";
const HALF = "Do you want to proceed?\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness() {
  let release; const first = new Promise((r) => { release = r; });
  const st = { renders: 0 };
  const base = {
    screenText: async () => {
      if (++st.renders > 1) return BOX;
      await first; return HALF; // what was on screen when this render began
    },
    armPromptCheck: (s, ms) => boxread.armPromptCheck(core, s, ms),
    emit: () => true,
  };
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const s = {
    info: { id: "w1", cwd: "/", running: true, prompt: null }, backend: claudeBackend, scrollback: BOX, seq: 0,
    copyMode: false, promptTimer: null, promptDueAt: 0, lastPromptCheckAt: 0,
    promptRendering: false, promptGen: 0, promptMisses: 0, promptPending: null, lastResizeAt: 0,
  };
  return { core, s, st, release };
}

test("a box painted during a slow render is published once that render ends, with no more output", async () => {
  const { core, s, st, release } = harness();
  boxread.armPromptCheck(core, s, 0);
  await sleep(30);
  assert.equal(st.renders, 1, "the first render is in flight");
  boxread.armPromptCheck(core, s, 0); // the box's own chunk: its check comes due mid-render
  await sleep(30);
  assert.equal(st.renders, 1, "still one render at a time");
  release();
  // Two agreeing reads, one settle apart (`readTwice`).
  await sleep(PROMPT_SETTLE_MS * 2 + PROMPT_CHECK_MS + 200);
  assert.equal(s.info.prompt?.options?.length, 2, "the box is published");
  clearTimeout(s.promptTimer);
});

test("a render nobody waited for arms nothing afterwards", async () => {
  const { core, s, st, release } = harness();
  boxread.armPromptCheck(core, s, 0);
  await sleep(30);
  release();
  await sleep(PROMPT_SETTLE_MS * 2 + 100);
  assert.equal(st.renders, 1, "no check was owed, so none ran");
  assert.equal(s.promptTimer, null);
});
