/**
 * What a failed PTY spawn is allowed to SAY.
 *
 * The kernel caps concurrent pseudo-terminals system-wide, and past the cap
 * node-pty throws `posix_spawnp failed.` and nothing else — a string naming a
 * syscall wrapper rather than any fact a person can act on. `spawnFailure()`
 * replaces it with the count, but only when the count is EVIDENCE: a message
 * that merely matches the pattern while capacity remains keeps its own words,
 * because a confident "the pty table is full" on a spawn that actually failed
 * for a missing binary is worse than the errno it replaced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exhaustionSentence, looksLikePtyExhaustion, ptyMax, ptyOpen, spawnFailure } from "../dist/ptycap.js";

test("node-pty's own message is recognised", () => {
  assert.equal(looksLikePtyExhaustion(new Error("posix_spawnp failed.")), true);
});

test("the errnos an exhausted table raises are recognised", () => {
  for (const m of ["spawn EAGAIN", "openpt: ENXIO", "EMFILE: too many open files", "ENFILE"]) {
    assert.equal(looksLikePtyExhaustion(new Error(m)), true, m);
  }
});

test("an unrelated failure is not", () => {
  for (const m of ["ENOENT: no such file or directory, spawn 'claude'", "permission denied"]) {
    assert.equal(looksLikePtyExhaustion(new Error(m)), false, m);
  }
});

test("an unrelated failure keeps its own words", () => {
  const raw = "ENOENT: no such file or directory, spawn 'claude'";
  assert.equal(spawnFailure(new Error(raw)), raw);
});

test("a non-Error is stringified, never thrown on", () => {
  assert.equal(spawnFailure("plain string"), "plain string");
  assert.equal(spawnFailure(null), "null");
});

test("the readings are a number or null, never a guess", () => {
  for (const v of [ptyMax(), ptyOpen()]) {
    assert.ok(v === null || (Number.isFinite(v) && v >= 0), `got ${v}`);
  }
});

test("with headroom, a pty-shaped error is NOT relabelled as exhaustion", () => {
  // Nothing in this suite fills the pty table, so on a platform where both
  // readings are available the verdict must fall through to the raw message.
  const max = ptyMax(), open = ptyOpen();
  if (max === null || open === null || open >= max) return; // unreadable or genuinely full
  assert.equal(spawnFailure(new Error("posix_spawnp failed.")), "posix_spawnp failed.");
});

test("the exhaustion sentence names the count, the cap and the knob", () => {
  const s = exhaustionSentence(511, 511);
  assert.match(s, /511 of 511/);
  assert.match(s, /kern\.tty\.ptmx_max|kernel\.pty\.max/);
  // It must say what to DO — the whole complaint against `posix_spawnp failed`
  // is that it named a syscall and no action.
  assert.match(s, /close some sessions/i);
  assert.doesNotMatch(s, /posix_spawnp/);
});
