/**
 * A redraw over an idle prompt is not work (`sessions/idlewatch.ts`'s `noteOutput`).
 *
 * Every PTY byte used to clear `info.idle`, so the phone's pill read "coding"
 * over an idle claude prompt after each cursor blink, resize repaint or status
 * line tick (film review, docs/oss-release-plan.md). Output now only ends idle
 * when the rendered grid carries the CLI's working line, or a turn starts.
 *
 * The idle screen is a real capture (`fixtures/permmode/manual.txt`, claude
 * 2.1.293); the working line is the shape `shared/working.ts` documents.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const turn = await import("../dist/sessions/turn.js");
const idle = await import("../dist/sessions/idlewatch.js");
const { IDLE_WATCH_MS } = await import("../dist/sessions/knobs.js");
const { claudeBackend } = await import("../dist/backends/claude.js");
const { shellBackend } = await import("../dist/backends/shell.js");
const { workingLine } = await import("@waterplane/shared");

const IDLE = readFileSync(new URL("./fixtures/permmode/manual.txt", import.meta.url), "utf8");
const WORKING = IDLE.replace("────", "✻ Crafting… (12s · ↓ 3.4k tokens)\n────");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pastWatch = () => wait(IDLE_WATCH_MS * 2 + 50);

function harness(backend = claudeBackend) {
  const events = [];
  const base = { emit: (ev, ...args) => { events.push([ev, ...args]); return true; }, sessions: new Map() };
  base.clearIdle = (s) => idle.clearIdle(core, s);
  const core = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  let grid = IDLE;
  const idleSince = Date.now() - 60_000;
  const s = {
    info: { id: "r1", cwd: tmpdir(), running: true, title: "demo", idle: true, idleSince, turnActive: false },
    backend, scrollback: IDLE, seq: 1000, spawnedAt: Date.now() - 120_000,
    screenLog: { gridText: () => grid },
    turnActive: false, turnFromScreen: false, hooksActive: true, stopPending: false, stopVerifyTimer: null,
    idleWatchTimer: null, agentTimer: null, askDismissed: null, submits: [],
  };
  /** The PTY printed `n` bytes and the grid now reads `text` — what the data handler hands `noteOutput`. */
  const output = (text, n = 120) => { const before = s.seq; grid = text; s.seq += n; s.scrollback += text; idle.noteOutput(core, s, before); };
  const updates = () => events.filter((e) => e[0] === "updated").length;
  const stop = () => { s.info.running = false; turn.clearStopVerify(s); if (s.agentTimer) clearTimeout(s.agentTimer); };
  return { core, s, output, updates, stop, idleSince };
}

test("the fixtures say what this test assumes", () => {
  assert.equal(workingLine(IDLE), null, "the idle capture carries no working line");
  assert.ok(workingLine(WORKING), "the working screen does");
});

test("redraws over an idle prompt leave idle set, its clock unmoved, and announce nothing", async () => {
  const h = harness();
  try {
    // A burst of repaints of the same idle frame: cursor blink, resize, status-line tick.
    for (let i = 0; i < 5; i++) { h.output(IDLE, 40); await wait(IDLE_WATCH_MS / 3); }
    await pastWatch();
    h.output(IDLE.replace("[CAVEMAN]", "[CAVEMAN] 12:01"), 30); // the status line ticked
    await pastWatch();
    assert.equal(h.s.info.idle, true, "still idle — a redraw is not work");
    assert.equal(h.s.info.idleSince, h.idleSince, "idleSince did not restart");
    assert.equal(h.updates(), 0, "no broadcast for a flag that did not move");
  } finally { h.stop(); }
});

test("the working line painting after the output ends idle", async () => {
  const h = harness();
  try {
    h.output(WORKING);
    assert.equal(h.s.info.idle, true, "not decided on the chunk's own tick (the VT parses after it)");
    await pastWatch();
    assert.equal(h.s.info.idle, false, "work on screen ends idle");
    assert.equal(h.s.info.idleSince, undefined);
    assert.equal(h.updates(), 1, "announced once");
  } finally { h.stop(); }
});

test("a turn starting ends idle with no output at all", () => {
  const h = harness();
  try {
    turn.setTurn(h.core, h.s, true); // UserPromptSubmit, our own Return on an unhooked session, the turn watch
    assert.equal(h.s.info.idle, false);
    assert.equal(h.s.info.idleSince, undefined);
  } finally { h.stop(); }
});

test("a backend with no working-line reader keeps the old rule: any output ends idle", () => {
  const h = harness(shellBackend);
  try {
    h.output("$ ");
    assert.equal(h.s.info.idle, false, "no reader for work ⇒ the old signal, never idle over real work");
  } finally { h.stop(); }
});

test("a session that exited is not read", async () => {
  const h = harness();
  h.output(WORKING);
  h.stop(); // the exit path clears the pending read
  await pastWatch();
  assert.equal(h.s.info.idle, true);
});
