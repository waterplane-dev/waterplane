/**
 * External-session discovery, off fixtures: the Linux /proc parsers and the
 * C-locale `ps -o lstart` parser. No real processes. Anything unreadable is an
 * ABSENT start time or a skipped row, never a wrong value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cmdlineText, looksLikeClaude, parseBtime, parseProcStatStartTicks, parsePsLstart, procStartMs,
} from "../dist/discover.js";
import { whisperInstallHint } from "../dist/dictate.js";

// starttime (22nd field) = 123456. comm holds a space and a ")" to prove parsing from the last ")".
const STAT = "4242 (claude (x) y) S 1 4242 4242 34816 4242 4194560 100 0 0 0 5 2 0 0 20 0 11 0 123456 1000 200 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";

test("proc stat: starttime is field 22, counted past a comm with parentheses", () => {
  assert.equal(parseProcStatStartTicks(STAT), 123456);
});

test("proc stat: truncated or garbled lines are null", () => {
  assert.equal(parseProcStatStartTicks("4242 (claude) S 1 2"), null);
  assert.equal(parseProcStatStartTicks("no parens at all"), null);
  assert.equal(parseProcStatStartTicks(""), null);
});

test("btime + ticks give an epoch ms; either missing is undefined", () => {
  const procStat = "cpu  1 2 3\nbtime 1700000000\nprocesses 99\n";
  assert.equal(parseBtime(procStat), 1700000000);
  assert.equal(procStartMs(STAT, procStat), 1700000000 * 1000 + 1234560);
  assert.equal(procStartMs(STAT, "cpu 1\n"), undefined);
  assert.equal(procStartMs("junk", procStat), undefined);
});

test("cmdline is NUL-separated and still matches the claude binary", () => {
  const c = cmdlineText("/usr/local/bin/claude\0--continue\0");
  assert.equal(c, "/usr/local/bin/claude --continue");
  assert.ok(looksLikeClaude(c));
  assert.ok(!looksLikeClaude("node /opt/claude-foo/index.js"));
});

const PS = [
  "  101 Sat Oct  4 12:00:00 2026 /usr/local/bin/claude --continue",
  "  102 Sat Oct  4 12:05:00 2026 vim notes.txt",
  "  103 Sat Oct  4 12:06:00 2026 claude",
  "  104 sam. oct.  4 12:07:00 2026 claude",
  "  105 Sat Oct  4 12:08:00 2026 claude",
  "",
].join("\n");

test("ps lstart (C locale): claude rows only, own and managed pids excluded", () => {
  const rows = parsePsLstart(PS, 103, new Set([105]));
  assert.deepEqual(rows.map((r) => r.pid), [101]);
  assert.equal(rows[0].startedAt, Date.parse("Sat Oct  4 12:00:00 2026"));
});

test("ps lstart: a localized row or a busybox error is dropped, so the list degrades to empty", () => {
  assert.deepEqual(parsePsLstart(PS.split("\n")[3], 0, new Set()), []);
  assert.deepEqual(parsePsLstart("ps: invalid option -- 'x'\nBusyBox v1", 0, new Set()), []);
});

test("whisper hint: brew on macOS, generic elsewhere", () => {
  assert.match(whisperInstallHint("darwin"), /brew install whisper-cpp/);
  assert.doesNotMatch(whisperInstallHint("linux"), /brew/);
  assert.match(whisperInstallHint("linux"), /whisper-cli/);
});
