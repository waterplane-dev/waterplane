/**
 * `lastTurnAt` — when a conversation last carried a real turn.
 *
 * This is a heuristic over the CLI's own record shapes that feeds
 * `SessionInfo.lastTurnAt` → the web's `inactiveMs` → the bulk-close cutoff, so a
 * wrong number here does not render wrong, it CLOSES SESSIONS. It had no test at
 * all; e2e cannot cover it either, because every failure mode is a plausible
 * number rather than a crash.
 *
 * What is pinned is exactly the reasoning in the function's own doc comment: the
 * bookkeeping rows the CLI rewrites on every attach are not turns (the
 * measurement behind that is 92 of 97 live sessions with an mtime under an hour
 * old and a last real turn 87–143 hours old), a tail read starts mid-record and
 * must skip it rather than throw, and nothing readable ⇒ null, never a guess.
 *
 * Fixtures are hand-built logs in a temp dir, as in `convfork.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { lastTurnAt } = await import("../dist/transcript.js");

const DIR = mkdtempSync(join(tmpdir(), "waterplane-lastturn-"));
let n = 0;
/** Write a log from raw records (objects, or strings written verbatim). */
function log(records, name = `t${n++}.jsonl`) {
  const p = join(DIR, name);
  writeFileSync(p, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return p;
}

const at = (ts) => new Date(ts).getTime();
const user = (ts, text = "hi") => ({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (ts, text = "ok") => ({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });

test("the newest user/assistant timestamp wins, whatever the order on disk", () => {
  const p = log([
    assistant("2026-09-01T10:00:00.000Z"),
    user("2026-09-03T08:30:00.000Z"),          // newest, and NOT last in the file
    assistant("2026-09-02T23:59:59.000Z"),
  ]);
  assert.equal(lastTurnAt(p), at("2026-09-03T08:30:00.000Z"));
});

test("bookkeeping rows are not turns, however recently the CLI rewrote them", () => {
  // The whole point of the field. Every row here is one the CLI writes when a
  // client ATTACHES, and `npm run restart` re-attaches every tmux session at
  // once — so on a hundred conversations these are all stamped seconds ago while
  // no work happened. Reading any of them as a turn answers "did anything open
  // the file", which after a restart is always yes.
  const p = log([
    user("2026-09-01T09:00:00.000Z"),
    { type: "mode", timestamp: "2026-09-09T12:00:00.000Z", mode: "acceptEdits" },
    { type: "last-prompt", timestamp: "2026-09-09T12:00:01.000Z" },
    { type: "atis-latch", timestamp: "2026-09-09T12:00:02.000Z" },
    { type: "bridge-session", timestamp: "2026-09-09T12:00:03.000Z" },
    { type: "queue-operation", timestamp: "2026-09-09T12:00:04.000Z" },
    { type: "file-history-snapshot", timestamp: "2026-09-09T12:00:05.000Z" },
    assistant("2026-09-01T09:00:01.000Z"),
  ]);
  assert.equal(lastTurnAt(p), at("2026-09-01T09:00:01.000Z"));
});

test("a message record with no usable timestamp is ignored, never dated now", () => {
  const p = log([
    user("2026-09-01T09:00:00.000Z"),
    { type: "assistant", message: { role: "assistant", content: [] } },          // no timestamp at all
    { type: "assistant", timestamp: "not a date", message: { role: "assistant", content: [] } },
  ]);
  assert.equal(lastTurnAt(p), at("2026-09-01T09:00:00.000Z"));
});

test("a half-written first line in the tail window is skipped, not thrown on", () => {
  // The read is a bounded tail (256 KB), so on any log bigger than that the
  // first line handed to the parser is a FRAGMENT of whatever record spans the
  // boundary. The padding record below is stamped in 2099 precisely so that
  // parsing the fragment — or silently reading from a line boundary instead —
  // would produce an obviously wrong answer rather than the right one by luck.
  const padding = JSON.stringify({
    type: "assistant", timestamp: "2099-01-01T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(400_000) }] },
  });
  const p = log([padding, user("2026-09-04T07:00:00.000Z"), assistant("2026-09-04T07:00:05.000Z")]);
  assert.ok(statSync(p).size > 256 * 1024, "fixture must exceed the tail window");
  assert.equal(lastTurnAt(p), at("2026-09-04T07:00:05.000Z"));
});

test("a missing file and a tail holding no message record both answer null", () => {
  assert.equal(lastTurnAt(join(DIR, "nope.jsonl")), null);
  assert.equal(lastTurnAt(log([{ type: "mode", timestamp: "2026-09-09T12:00:00.000Z" }, "", "{ not json"])), null);
});

test("the memo is keyed on the file's own identity: it hits, and size+mtime invalidates it", () => {
  // Both halves matter and only one is obvious. A memo that never invalidated
  // would freeze a live session's last turn for ever; a memo that never hit
  // would tail-read once per session per settle, with a hundred sessions live.
  // Two records of IDENTICAL byte length let the test restore size+mtime and so
  // distinguish "answered from the memo" from "re-read the file".
  const first = user("2026-09-05T11:11:11.000Z");
  const second = user("2026-09-06T11:11:11.000Z");
  const p = log([first]);
  stamp(p, MTIME);
  assert.equal(lastTurnAt(p), at("2026-09-05T11:11:11.000Z"));

  const size = statSync(p).size;
  writeFileSync(p, JSON.stringify(second) + "\n");
  assert.equal(statSync(p).size, size, "fixture records must be the same length");
  stamp(p, MTIME);
  assert.equal(lastTurnAt(p), at("2026-09-05T11:11:11.000Z"), "same size+mtime ⇒ the memoized answer");

  stamp(p, MTIME + 5_000);
  assert.equal(lastTurnAt(p), at("2026-09-06T11:11:11.000Z"), "a moved mtime ⇒ re-read");
});

test("the memo is bounded: many distinct paths evict the oldest entry", () => {
  // Observed from outside, since the map is private: park an entry, prove it is
  // a hit, push 600 other paths through (the cap is 512), then prove the same
  // read now comes off disk. Unbounded, this map grew one entry per conversation
  // the daemon had ever touched and shed none.
  const older = user("2026-09-07T01:00:00.000Z");
  const newer = user("2026-09-08T01:00:00.000Z");
  const p = log([older], "evictme.jsonl");
  stamp(p, MTIME);
  assert.equal(lastTurnAt(p), at("2026-09-07T01:00:00.000Z"));

  writeFileSync(p, JSON.stringify(newer) + "\n");
  stamp(p, MTIME);
  assert.equal(lastTurnAt(p), at("2026-09-07T01:00:00.000Z"), "still memoized before the flood");

  for (let i = 0; i < 600; i++) lastTurnAt(log([user("2026-09-01T00:00:00.000Z")], `flood${i}.jsonl`));

  assert.equal(lastTurnAt(p), at("2026-09-08T01:00:00.000Z"), "evicted ⇒ read from disk again");
});

/** Pin a file's mtime to a whole millisecond. The memo's key is `size:mtimeMs`
 *  and a natural mtime carries sub-millisecond precision, so a rewrite that
 *  merely restores `st.mtime` lands on a DIFFERENT key and the test would only
 *  ever observe a miss. */
const MTIME = Date.UTC(2026, 8, 1, 12, 0, 0);
function stamp(p, ms) { const d = new Date(ms); utimesSync(p, d, d); }
