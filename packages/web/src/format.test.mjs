import test from "node:test";
import assert from "node:assert/strict";

import { convoStart, fmtSize, fmtStorage, baseName, inactiveMs, inactivityKnown, when } from "./format.ts";

// ── The two byte formatters ───────────────────────────────────────────────
//
// These exist as a PAIR on purpose and the pair is the thing worth pinning.
// Before this file there were five byte formatters in `packages/web`, and the
// same artifact rendered a different size depending on which screen you opened:
// `fmtSize` verbatim in BuildSheet/PullSheet/FilesSheet (decimal), ArchiveSheet's
// own `size` (binary, spelled the same "KB"), and — the one that made it a
// correctness bug rather than an inconsistency — TWO different functions both
// exported as `fmtBytes`, from `persist.ts` and `uploadScale.ts`, so which one a
// file got was decided by which module it happened to import from.
//
// So: one decimal owner for FILES, one binary owner for the STORAGE ESTIMATE,
// and deliberately different names, because the whole failure was two different
// functions answering to one name.

test("fmtSize is DECIMAL — the same units the host prints and the phone's file manager shows", () => {
  assert.equal(fmtSize(0), "0 B");
  assert.equal(fmtSize(999), "999 B");
  // 1000, not 1024, is the KB boundary.
  assert.equal(fmtSize(1000), "1 KB");
  assert.equal(fmtSize(1023), "1 KB");
  assert.equal(fmtSize(1024), "1 KB");
  assert.equal(fmtSize(1_000_000), "1.0 MB");
  assert.equal(fmtSize(1_000_000_000), "1.0 GB");
});

test("fmtStorage is BINARY — navigator.storage reports binary, so echoing it in decimal would misreport the browser's own number", () => {
  assert.equal(fmtStorage(0), "0 B");
  assert.equal(fmtStorage(1023), "1023 B");
  assert.equal(fmtStorage(1024), "1.0 KB");
  assert.equal(fmtStorage(1024 * 1024), "1.0 MB");
  // Only the storage sheet has a "no reading yet" case; a file always has a size.
  assert.equal(fmtStorage(undefined), "—");
});

test("the two disagree, which is why they may never share a name", () => {
  // Decimal vs binary. Both correct for their own question — and this is the
  // difference that got swapped when both were called `fmtBytes`.
  //
  // Note the two AGREE at exactly 1 MiB ("1.0 MB" either way), which is the
  // trap: a spot check on a round number would have found nothing wrong with
  // the old pair. Pick a value between the boundaries instead.
  assert.equal(fmtSize(1500), "2 KB");
  assert.equal(fmtStorage(1500), "1.5 KB");
  assert.notEqual(fmtSize(1500), fmtStorage(1500));
});

// ── baseName ──────────────────────────────────────────────────────────────
// Pinned here because `activityRows.ts` grew its own copy that handled `/` only;
// a Windows-style path has to come back as the last SEGMENT, not the whole string.
test("baseName splits on both separators and survives a trailing slash", () => {
  assert.equal(baseName("/Users/j/dev/myapp"), "myapp");
  assert.equal(baseName("/Users/j/dev/myapp/"), "myapp");
  assert.equal(baseName("C:\\dev\\myapp"), "myapp");
  assert.equal(baseName("myapp"), "myapp");
});

// ── inactiveMs / inactivityKnown ─────────────────────────────────────────
//
// `inactiveMs` prefers `lastTurnAt` (read off the CLI's own log, survives a
// host restart) and falls back to `idleSince` (stamped by the daemon, and
// stamped fresh by a tmux re-attach repaint on every restart). Measured on
// the live host: 10 of 107 running sessions have no `lastTurnAt` at all — no
// known `claudeSessionId` — so those 10 fall all the way to `idleSince`,
// which after a restart can read "quiet since just now" for a session idle
// for days. `inactiveMs` stays conservative on that path (0 rather than a
// wrong large number is the safe direction for a destructive filter), and
// `inactivityKnown` is the honest disclosure that the number is a guess.
test("inactiveMs prefers lastTurnAt, falls back to idleSince, and an exited session is infinitely inactive", () => {
  const now = Date.now();
  assert.equal(inactiveMs({ running: false }), Infinity);
  assert.equal(inactiveMs({ running: true, turnActive: true, lastTurnAt: now - 999999 }), 0);
  const withTurn = inactiveMs({ running: true, lastTurnAt: now - 5000 });
  assert.ok(withTurn >= 5000 && withTurn < 5100);
  const withIdle = inactiveMs({ running: true, idleSince: now - 3000 });
  assert.ok(withIdle >= 3000 && withIdle < 3100);
  // Neither field set, never gone idle: counts as active, not "forever quiet".
  assert.equal(inactiveMs({ running: true }), 0);
});

test("inactivityKnown is false only for a running, non-mid-turn session with no lastTurnAt", () => {
  const now = Date.now();
  // Exited: `inactiveMs` returns a real answer (Infinity) — known.
  assert.equal(inactivityKnown({ running: false }), true);
  // Mid-turn: `inactiveMs` returns a real answer (0) — known.
  assert.equal(inactivityKnown({ running: true, turnActive: true }), true);
  // Has a dated log reading — known, regardless of idleSince.
  assert.equal(inactivityKnown({ running: true, lastTurnAt: now - 1000, idleSince: now }), true);
  // Running, quiet, no claudeSessionId to read a turn off of: the fallback is
  // a restart artifact, not a measurement — unknown.
  assert.equal(inactivityKnown({ running: true, idleSince: now }), false);
  assert.equal(inactivityKnown({ running: true }), false);
});

// ── `when` — an instant said absolutely ───────────────────────────────────
//
// The build sheet's five identically-named runs are why this exists: a row
// labelled only with a duration differs from the row above it by a sort order
// the reader has to trust, and `ago` collapses to the same bucket for two runs
// of the same command minutes apart. So the tiers are pinned here, against the
// same Intl calls the function uses (a hard-coded "14:32" would only pass in
// one locale and one timezone).

const at = (d) => d.getTime();
const hhmmOf = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

test("today is the bare time — a date on it would be noise", () => {
  const d = new Date();
  d.setHours(9, 12, 0, 0);
  assert.equal(when(at(d)), hhmmOf(d));
});

test("inside the last six days it is a weekday, and past that a date", () => {
  const now = new Date();
  const twoDays = new Date(now.getTime() - 2 * 86400e3);
  assert.equal(
    when(at(twoDays)),
    `${twoDays.toLocaleDateString([], { weekday: "short" })} ${hhmmOf(twoDays)}`,
  );
  // Six days back a weekday name is ambiguous with the coming one, so it stops.
  const week = new Date(now.getTime() - 8 * 86400e3);
  assert.equal(
    when(at(week)),
    `${week.toLocaleDateString([], { day: "numeric", month: "short" })} ${hhmmOf(week)}`,
  );
});

test("a different year carries the year", () => {
  const old = new Date();
  old.setFullYear(old.getFullYear() - 1);
  assert.match(when(at(old)), new RegExp(String(old.getFullYear())));
});

test("a FUTURE instant is not mistaken for six days ago", () => {
  // `days` goes negative, and the weekday tier is guarded on `>= 0` for it.
  const soon = new Date(Date.now() + 3 * 86400e3);
  assert.equal(
    when(at(soon)),
    `${soon.toLocaleDateString([], { day: "numeric", month: "short" })} ${hhmmOf(soon)}`,
  );
});

// ── convoStart ────────────────────────────────────────────────────────────
//
// The bulk-close dialog offers "only the ones nothing was ever typed into".
// That button is destructive, so the predicate behind it may only say "fresh"
// where the absence of a record IS a measurement — a fresh claude session is
// launched with `--session-id`, so its id is known before its log exists,
// while a `--continue` resume has no id until the daemon matches one. Calling
// that second case empty would close a week of work under a label promising
// there was nothing in it.
test("convoStart says started on any positive record of a turn", () => {
  const now = Date.now();
  assert.equal(convoStart({ running: true, turnActive: true }), "started");
  assert.equal(convoStart({ running: true, lastTurnAt: now - 1000 }), "started");
  assert.equal(convoStart({ running: true, firstPrompt: "hi" }), "started");
  assert.equal(convoStart({ running: true, lastPrompt: "go on" }), "started");
  assert.equal(convoStart({ running: true, contextLeft: 91 }), "started");
  assert.equal(convoStart({ running: true, contextUsedTok: 12000 }), "started");
  assert.equal(convoStart({ running: true, contextSpark: { pts: [100], marks: [] } }), "started");
  // A record beats a known id — the id is what a fresh session also has.
  assert.equal(convoStart({ running: true, claudeSessionId: "u1", lastTurnAt: now }), "started");
});

test("convoStart says fresh only with an id and nothing on the record", () => {
  assert.equal(convoStart({ running: true, claudeSessionId: "u1" }), "fresh");
  assert.equal(convoStart({ running: true, backendSessionId: "ses_1" }), "fresh");
  // An empty spark is not a reading.
  assert.equal(convoStart({ running: true, claudeSessionId: "u1", contextSpark: { pts: [], marks: [] } }), "fresh");
});

test("convoStart refuses to call an un-identified session empty", () => {
  // What a --continue / pick resume looks like until a log is matched to it.
  assert.equal(convoStart({ running: true }), "unknown");
  assert.equal(convoStart({ running: true, idleSince: Date.now() }), "unknown");
});

// ── Helpers lifted out of BuildSheet / CaptureSheet / SnippetSheet / … ────
// Each was a verbatim copy; the outputs below are what every copy printed.
import { agoText, durSpan, dur, seqId, stripAnsi, clamp, clock, hhmm } from "./format.ts";
import { seenAgo } from "./features/hosts/logic.ts";

test("durSpan: seconds, then minutes and seconds, never hours", () => {
  assert.equal(durSpan(0, 0), "0s");
  assert.equal(durSpan(0, 59_400), "59s");
  assert.equal(durSpan(0, 59_600), "1m 0s");
  assert.equal(durSpan(0, 125_000), "2m 5s");
  assert.equal(durSpan(0, 3_725_000), "62m 5s");
  assert.equal(durSpan(10_000, 0), "0s");
});

test("dur floors minutes and hours, rounds seconds, reaches days", () => {
  const at = (ago) => dur(Date.now() - ago);
  assert.equal(at(45_000), "45s");
  assert.equal(at(119_000), "1m");
  assert.equal(at(3_599_000 + 1_000), "1h");
  assert.equal(at(90_000_000), "1d");
});

test("seqId: prefixed, unique, base-36", () => {
  const a = seqId("b"), b = seqId("b");
  assert.match(a, /^b_[0-9a-z]+_[0-9a-z]+$/);
  assert.notEqual(a, b);
  assert.match(seqId("sn"), /^sn_/);
});

test("stripAnsi drops CSI and OSC, and turns a bare CR into a newline", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(stripAnsi("\x1b]0;title\x07ok"), "ok");
  assert.equal(stripAnsi("a\rb\r\nc"), "a\nb\r\nc");
});

test("clamp holds a value inside the range", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

test("clock never adds a weekday; hhmm does once the moment is far off", () => {
  const near = Date.now() + 3600e3, far = Date.now() + 30 * 3600e3;
  assert.equal(clock(near), hhmm(near));
  assert.equal(clock(far), new Date(far).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  assert.notEqual(hhmm(far), clock(far));
});

test("agoText and seenAgo are one phrasing", () => {
  for (const ms of [0, 44_999, 45_000, 60_000, 3_600_000, 47 * 3_600_000, 49 * 3_600_000, 10 * 86_400_000]) {
    assert.equal(seenAgo(ms), agoText(ms));
  }
  assert.equal(agoText(120_000), "2 min ago");
  assert.equal(agoText(3 * 3_600_000), "3 h ago");
  assert.equal(agoText(72 * 3_600_000), "3 d ago");
});
