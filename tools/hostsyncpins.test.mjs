/**
 * No blocking child process on a per-event path of the host.
 *
 * ONE event loop pumps every PTY, so `execFileSync` on a path that runs per
 * wheel report or per poll tick stalls the output of every session at once.
 * Measured: a tmux query is ~6 ms and `ps -axo` ~53 ms of blocked loop each.
 * Both used to sit on such paths (`tmuxscroll.ts` per pan, `readShellList`'s
 * `ps` per shell/busy session every `AGENT_POLL_MS`); they are async now and
 * these are RATCHETS so they stay that way. Read as text: no build, no import.
 *
 * The sync survivors are named, not counted away: each is a call that must
 * block (a keystroke written on the next line, a reading that precedes a kill,
 * a boot-time sequence), and each says why where it is written. A new one is a
 * decision — raise the number here in the same commit and say why in the code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(new URL("..", import.meta.url).pathname, "packages", "host", "src");
// Comments are stripped first: they name `execFileSync(` while explaining why it is gone.
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (rel) => stripComments(readFileSync(join(SRC, rel), "utf8"));
const calls = (text) => (text.match(/\bexecFileSync\(/g) ?? []).length;

test("tmuxscroll.ts: the only blocking tmux calls are the two named sync variants", () => {
  const text = read("tmuxscroll.ts");
  // inCopyModeSync (boot re-attach) and exitCopyModeSync (the typing path).
  assert.equal(calls(text), 2, "tmuxscroll.ts may block in exactly inCopyModeSync and exitCopyModeSync");
  for (const name of ["inCopyModeSync", "exitCopyModeSync"]) {
    const at = text.indexOf(`export function ${name}(`);
    assert.ok(at > 0, `${name} is declared`);
    const body = text.slice(at, text.indexOf("\n}\n", at));
    assert.equal(calls(body), 1, `${name} holds its own execFileSync`);
  }
  // The scroll-path readers are async.
  for (const name of ["inCopyMode", "paneWantsMouse", "exitCopyMode"]) {
    assert.match(text, new RegExp(`export async function ${name}\\(`), `${name} is async`);
  }
});

test("the scroll path awaits tmux: panHistory uses no blocking helper", () => {
  const text = read("sessions/drive.ts");
  const at = text.indexOf("function panHistory(");
  const body = text.slice(at, text.indexOf("\n}\n", at));
  assert.match(body, /await paneWantsMouse\(/, "paneWantsMouse is awaited per pan");
  assert.match(body, /await leaveCopyModeAsync\(/, "the pass-through branch leaves copy-mode without blocking");
  assert.doesNotMatch(body, /Sync\(|leaveCopyMode\(/, "no blocking helper inside the scroll chain");
  // The three that remain are lifecycle (kill-session twice, detach-client): once per close, not per event.
  assert.ok(calls(text) <= 3, "drive.ts gains no new blocking spawn");
});

test("sessions/turn.ts: the poller reads ps async and never blocks on it", () => {
  const text = read("sessions/turn.ts") + read("sessions/agentpoll.ts");
  assert.equal(calls(text), 0, "turn.ts has no execFileSync");
  assert.doesNotMatch(text, /\breadPsTable\(/, "turn.ts never calls the blocking process-table reader");
  assert.match(text, /readPsTableAsync\(/, "checkAgents reads the table async");
  // `readShellList` is handed the table; without it, it would block on its own.
  assert.match(text, /readShellList\(.*, psRows\)/, "readShellList gets the pre-read rows");
});

test("shells.ts: the sync ps reader is the only blocking call, and a kill's precondition still uses it fresh", () => {
  const text = read("shells.ts");
  assert.equal(calls(text), 1, "shells.ts may block only in readPsTable");
  assert.match(text, /const readPs = deps\.readPs \?\? \(\(\) => readPsTable\(true\)\)/,
    "killShellGroup's precondition is a FRESH, synchronous reading");
  const drive = read("sessions/drive.ts");
  assert.match(drive, /rows = readPsTable\(true\)/, "stopShellsUnder reads fresh before it kills");
});
