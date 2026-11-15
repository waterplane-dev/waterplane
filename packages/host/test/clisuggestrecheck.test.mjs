/**
 * The CLI's next-prompt proposal is re-read even when the screen never falls
 * quiet. Live 2026-11-13: background agents ticked their panel every second, the
 * 4 s quiet tick (`markIdle`) never came, and the phone kept offering the
 * PREVIOUS proposal while the desk showed a new one. `scheduleChecks` arms one
 * re-read per `CLI_SUGGEST_RECHECK_MS` that further output never pushes back.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const boxread = await import("../dist/sessions/boxread.js");
const { CLI_SUGGEST_RECHECK_MS } = await import("../dist/sessions/knobs.js");

function harness() {
  const reads = [];
  const base = { checkCliSuggestion: (s) => { reads.push(s.info.id); } };
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  const s = {
    info: { id: "w1", running: true }, backend: { caps: {} },
    hooksActive: false, turnActive: false, copyMode: false,
    promptTimer: null, promptDueAt: 0, lastPromptCheckAt: 0, idleTimer: null, suggestTimer: null,
  };
  return { core, s, reads };
}

test("constant output still re-reads the proposal once per recheck window", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { core, s, reads } = harness();
    // Output every second for twelve seconds: the idle timer is pushed back each time.
    for (let i = 0; i < 12; i++) { boxread.scheduleChecks(core, s); mock.timers.tick(1000); }
    assert.equal(reads.length, Math.floor(12000 / CLI_SUGGEST_RECHECK_MS), "one read per window, never starved");
  } finally { mock.timers.reset(); }
});

test("a pane panned into history, or an ended session, is not read", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { core, s, reads } = harness();
    s.copyMode = true;
    boxread.scheduleChecks(core, s); mock.timers.tick(CLI_SUGGEST_RECHECK_MS);
    s.copyMode = false; s.info.running = false;
    boxread.scheduleChecks(core, s); mock.timers.tick(CLI_SUGGEST_RECHECK_MS);
    assert.equal(reads.length, 0);
  } finally { mock.timers.reset(); }
});
