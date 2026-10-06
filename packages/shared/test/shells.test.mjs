/**
 * The pure half of background shells: bucket, sentence, chip, close words.
 *
 * Each case is a reading this app has to explain without a `ps` to poll —
 * the honest "can't tell yet" for a shell seen once, the wait loop that can
 * never end (the self-match bug from a real `pgrep -f "pytest -q -x"` wait
 * loop measured on this desktop), and the server-like shell where quiet is
 * the point rather than a concern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SHELL_QUIET_MS,
  selfMatchOf,
  selfMatchPattern,
  serverLikeOf,
  shellBucket,
  shellCloseWords,
  shellWords,
  shellsChipText,
  shellsSummary,
} from "../dist/shells.js";

const NOW = 1_700_000_000_000;

function shell(over = {}) {
  return {
    pid: 111,
    startedAt: NOW - 60_000,
    command: "npm test",
    cpuMs: 100,
    workers: 1,
    ...over,
  };
}

test("shellBucket: no reading at all is unknown, not a guess", () => {
  assert.equal(shellBucket(shell(), NOW), "unknown");
});

test("shellBucket: working when CPU moved within the quiet window", () => {
  const sh = shell({ cpuMovedAt: NOW - 5_000 });
  assert.equal(shellBucket(sh, NOW), "working");
});

test("shellBucket: working when only OUTPUT grew recently", () => {
  const sh = shell({ outputAt: NOW - 5_000 });
  assert.equal(shellBucket(sh, NOW), "working");
});

test("shellBucket: stale with no real workers is waiting, not quiet", () => {
  const sh = shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 0 });
  assert.equal(shellBucket(sh, NOW), "waiting");
});

test("shellBucket: a real polling loop — CPU ticks a few ms every couple of minutes — is waiting, not working", () => {
  // workers === 0 (only its own sleep/pgrep), CPU moved moments ago because
  // the loop just woke up and ran its check — the bug this finding names:
  // reading `cpuMovedAt` alone said "working" for a shell that has never had
  // anything but its own wait-loop plumbing under it.
  const sh = shell({ cpuMovedAt: NOW - 5_000, workers: 0 });
  assert.equal(shellBucket(sh, NOW), "waiting");
});

test("shellBucket: stale WITH workers is quiet", () => {
  const sh = shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 2 });
  assert.equal(shellBucket(sh, NOW), "quiet");
});

test("shellBucket: a custom quietMs is honoured", () => {
  const sh = shell({ cpuMovedAt: NOW - 20_000, workers: 3 });
  assert.equal(shellBucket(sh, NOW, 10_000), "quiet");
  assert.equal(shellBucket(sh, NOW, 30_000), "working");
});

test("selfMatchOf: a pgrep -f wait loop matches its own command line", () => {
  const cmd = 'L=/tmp/x; until [ -s $L/out ] && ! pgrep -f "pytest -q -x" >/dev/null; do sleep 10; done; tail -3 $L/out';
  assert.equal(selfMatchOf(cmd), true);
  assert.equal(selfMatchPattern(cmd), "pytest -q -x");
});

test("selfMatchOf: both quote styles", () => {
  assert.equal(selfMatchOf("while pgrep -f 'node worker' >/dev/null; do sleep 5; done"), true);
});

test("selfMatchOf: withholds the claim on a regex/anchor pattern", () => {
  assert.equal(selfMatchOf('pgrep -f "^pytest$"'), false);
  assert.equal(selfMatchOf('pgrep -f "foo.*bar"'), false);
});

test("selfMatchOf: no pgrep -f at all is false", () => {
  assert.equal(selfMatchOf("npm run build"), false);
});

test("serverLikeOf: recognises the word list, case-insensitively", () => {
  assert.equal(serverLikeOf("~/Library/Android/sdk/emulator/emulator -avd obs_test"), true);
  assert.equal(serverLikeOf("VITE dev server"), true);
  assert.equal(serverLikeOf("nodemon --watch src"), true);
  assert.equal(serverLikeOf("./.venv/bin/python -m pytest -q -x"), false);
});

test("shellWords: never says hung/stuck/dead, and names each bucket", () => {
  const words = [
    shellWords(shell(), NOW), // unknown
    shellWords(shell({ cpuMovedAt: NOW - 12_000 }), NOW), // working
    shellWords(shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 0 }), NOW), // waiting
    shellWords(shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 2 }), NOW), // quiet
    shellWords(shell({ command: "~/emulator -avd x", cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, serverLike: true }), NOW),
  ];
  for (const w of words) {
    for (const bad of ["hung", "stuck", "dead"]) assert.ok(!w.toLowerCase().includes(bad), `"${w}" says "${bad}"`);
  }
  assert.equal(words[0], "can't tell yet");
  assert.match(words[1], /running/);
  assert.match(words[2], /waiting in a loop/);
  assert.match(words[3], /^quiet/);
  assert.match(words[4], /long-running by design/);
});

test("shellWords: a self-matching wait loop names the pattern and never claims it will end", () => {
  const cmd = 'until ! pgrep -f "pytest -q -x" >/dev/null; do sleep 10; done';
  const sh = shell({ command: cmd, workers: 0, selfMatch: true, cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000 });
  const w = shellWords(sh, NOW);
  assert.match(w, /pytest -q -x/);
  assert.match(w, /never ends/);
});

test("shellWords: selfMatch outranks the bucket entirely, even 'unknown' (like serverLike)", () => {
  const cmd = 'until ! pgrep -f "pytest -q -x" >/dev/null; do sleep 10; done';
  // No cpuMovedAt/outputAt at all — shellBucket alone would say "unknown" —
  // but the self-match fact is already known from the command text itself,
  // so the words must not fall back to "can't tell yet".
  const sh = shell({ command: cmd, workers: 0, selfMatch: true });
  const w = shellWords(sh, NOW);
  assert.match(w, /pytest -q -x/);
  assert.match(w, /never ends/);
});

test("shellWords: a foreground shell is never described as background at all", () => {
  const sh = shell({ foreground: true, cpuMovedAt: NOW - 1_000 });
  assert.equal(shellWords(sh, NOW), "a command this turn is running");
});

test("shellsSummary: unknown is never folded into quiet", () => {
  const list = [
    shell(), // unknown
    shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 0 }), // waiting
    shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 3 }), // quiet
  ];
  const s = shellsSummary(list, NOW);
  assert.deepEqual(s, { working: 0, waiting: 1, quiet: 1, unknown: 1, foreground: 0, total: 3 });
});

test("shellsSummary: a foreground shell is counted separately, never into total or a bucket", () => {
  const list = [
    shell({ foreground: true, cpuMovedAt: NOW - 1_000 }), // would read "working" if counted
    shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 3 }), // quiet
  ];
  const s = shellsSummary(list, NOW);
  assert.deepEqual(s, { working: 0, waiting: 0, quiet: 1, unknown: 0, foreground: 1, total: 1 });
});

test("shellsChipText: a single shell names its own bucket", () => {
  const one = shellsSummary([shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 0 })], NOW);
  assert.equal(shellsChipText(one), "1 shell · waiting");
});

test("shellsChipText: matches the spec's own examples", () => {
  const oneQuiet = shellsSummary([shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 3 })], NOW);
  assert.equal(shellsChipText(oneQuiet), "1 shell · quiet");

  const threeTwoWaiting = shellsSummary([
    shell({ cpuMovedAt: NOW - 1_000 }), // working
    shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 0 }), // waiting
    shell({ cpuMovedAt: NOW - SHELL_QUIET_MS - 1_000, workers: 0 }), // waiting
  ], NOW);
  assert.equal(shellsChipText(threeTwoWaiting), "3 shells · 2 waiting");
});

test("shellCloseWords: names real workers and folds the rest into a wait-loop count", () => {
  const list = [
    shell({ description: "emulator", workers: 2 }),
    shell({ command: 'until ! pgrep -f "x" >/dev/null; do sleep 5; done', workers: 0 }),
    shell({ command: "while true; do sleep 5; done", workers: 0 }),
  ];
  const summary = shellsSummary(list, NOW);
  assert.equal(shellCloseWords(summary, list), "stops 3 background shells — emulator, 2 wait loops");
});

test("shellCloseWords: nothing to stop is the empty sentence", () => {
  assert.equal(shellCloseWords(shellsSummary([], NOW), []), "");
});

test("shellCloseWords: falls back to the command's own words with no description", () => {
  const list = [shell({ description: undefined, command: "node server.js --port 4000", workers: 1 })];
  const summary = shellsSummary(list, NOW);
  assert.equal(shellCloseWords(summary, list), "stops 1 background shell — node server.js --port");
});

test("shellCloseWords: a foreground shell is left out — closing the session ends the turn, and it, anyway", () => {
  const list = [
    shell({ foreground: true, description: "current command", workers: 1 }),
    shell({ description: "emulator", workers: 2 }),
  ];
  const summary = shellsSummary(list, NOW);
  assert.equal(shellCloseWords(summary, list), "stops 1 background shell — emulator");
});
