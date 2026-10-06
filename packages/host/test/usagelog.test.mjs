/**
 * The kept `/usage` readings — what goes in the file, and what never does.
 *
 * `usage.test.mjs` pins the parse: a screen in, two percentages and two reset
 * instants out. This pins the layer above it, whose whole job is deciding that
 * a reading is worth remembering — and every way it can be wrong produces a
 * chart that looks fine:
 *
 *   • recording a FAILED probe as two nulls. The history would then show the
 *     account's limits dropping to unknown every time the daemon had a bad
 *     minute, which is a fact about this daemon dressed as a fact about the
 *     account.
 *   • recording every poll, so a day of flat 15% is 180 identical rows — and,
 *     with a cap, evicts the week that had something in it.
 *   • recording NOTHING while a value is unchanged, which makes "flat for four
 *     hours" and "nobody looked for four hours" the same series. They are
 *     opposite facts and the chart draws one of them as a gap.
 *   • losing the reset instants, without which a 5-hour window rolling over is
 *     indistinguishable from usage being refunded.
 *
 * File-level, with a real temp directory, because the retention and the
 * append/compact split are the parts that only misbehave across a restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { UsageLog } = await import("../dist/usagelog.js");

const HOUR = 3_600_000;
/** A reading as the checker publishes it. */
const info = (t, s, w, sr = t + HOUR, wr = t + 48 * HOUR) => ({
  ok: true, sessionPct: s, weeklyPct: w, sessionResetAt: sr, weeklyResetAt: wr, checkedAt: t,
});

function fresh() {
  const root = mkdtempSync(join(tmpdir(), "waterplane-usagelog-"));
  return { root, log: new UsageLog(root), path: join(root, ".waterplane", "usagelog.jsonl") };
}

test("a reading that parsed is kept, with the reset instants it named", () => {
  const { root, log } = fresh();
  try {
    const t = Date.now() - HOUR;
    log.note(info(t, 15, 30));
    const doc = log.read();
    assert.equal(doc.samples.length, 1);
    assert.deepEqual(doc.samples[0], { t, s: 15, w: 30, sr: t + HOUR, wr: t + 48 * HOUR });
    assert.equal(doc.keptFrom, t, "the oldest reading still held is stated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed probe is dropped, not recorded as unknown", () => {
  const { root, log } = fresh();
  try {
    log.note({ ok: false, sessionPct: null, weeklyPct: null, sessionResetAt: null, weeklyResetAt: null, checkedAt: Date.now() });
    // `ok` true but nothing parsed off the screen is the same non-answer.
    log.note({ ...info(Date.now(), null, null), ok: true });
    assert.equal(log.read().samples.length, 0);
    assert.equal(log.read().keptFrom, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unchanged reading is skipped, but not for ever", () => {
  const { root, log } = fresh();
  try {
    const t0 = Date.now() - 4 * HOUR;
    // The reset instants are held FIXED across these readings, which is what a
    // real window does: they only move when the window rolls over. A helper
    // that derived them from `checkedAt` would make every reading "changed"
    // and this rule untestable.
    const sr = t0 + 3 * HOUR;
    const wr = t0 + 80 * HOUR;
    log.note(info(t0, 15, 30, sr, wr));
    log.note(info(t0 + 60_000, 15, 30, sr, wr));       // a minute later, identical
    log.note(info(t0 + 20 * 60_000, 15, 30, sr, wr));  // still identical
    assert.equal(log.read().samples.length, 1, "a repeat inside the window adds nothing");

    log.note(info(t0 + 31 * 60_000, 15, 30, sr, wr));
    assert.equal(log.read().samples.length, 2,
      "…but a flat stretch is still drawn, so a repeat is kept every REPEAT_MS");

    log.note(info(t0 + 32 * 60_000, 16, 30, sr, wr));
    assert.equal(log.read().samples.length, 3, "a CHANGED reading is kept immediately");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a reading at or before the newest one is ignored", () => {
  const { root, log } = fresh();
  try {
    const t = Date.now() - HOUR;
    log.note(info(t, 15, 30));
    log.note(info(t, 99, 99));       // the same scrape, resolved twice
    log.note(info(t - 60_000, 1, 1)); // a clock that went backwards
    const s = log.read().samples;
    assert.equal(s.length, 1);
    assert.equal(s[0].s, 15, "the first answer stands; a duplicate never overwrites it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an out-of-range percentage is null, never clamped", () => {
  const { root, log } = fresh();
  try {
    const t = Date.now() - HOUR;
    log.note(info(t, 4300, 30));
    const s = log.read().samples;
    assert.equal(s.length, 1, "the weekly figure still parsed, so the reading is worth keeping");
    assert.equal(s[0].s, null, "100 and a parse that produced 4,300 must not look the same");
    assert.equal(s[0].w, 30);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readings survive a restart, and retention is applied on load", () => {
  const { root, log, path } = fresh();
  try {
    const now = Date.now();
    log.note(info(now - 2 * HOUR, 10, 20));
    log.note(info(now - HOUR, 12, 21));
    const again = new UsageLog(root);
    assert.equal(again.read().samples.length, 2, "a restart re-reads what was appended");

    // A reading older than the retention bound, written straight into the file
    // as an earlier build would have left it.
    const old = JSON.stringify({ t: now - 400 * 24 * HOUR, s: 5, w: 5, sr: null, wr: null });
    writeFileSync(path, `${old}\n${readFileSync(path, "utf8")}`);
    const third = new UsageLog(root);
    const s = third.read().samples;
    assert.equal(s.length, 2, "…and drops what is past the retention bound");
    assert.ok(s.every((r) => r.t > now - 31 * 24 * HOUR));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a corrupt line is skipped and the rest of the history survives", () => {
  const { root, log, path } = fresh();
  try {
    const now = Date.now();
    log.note(info(now - 2 * HOUR, 10, 20));
    writeFileSync(path, `${readFileSync(path, "utf8")}{"t":not json\nnot a row at all\n`);
    log.note(info(now - HOUR, 11, 21));
    const again = new UsageLog(root);
    assert.equal(again.read().samples.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("`hours` narrows the window and never widens it past what is retained", () => {
  const { root, log } = fresh();
  try {
    const now = Date.now();
    log.note(info(now - 10 * HOUR, 10, 20));
    log.note(info(now - 2 * HOUR, 40, 25));
    assert.equal(log.read(6 * HOUR).samples.length, 1, "only the readings inside the window");
    assert.equal(log.read(6 * HOUR).keptFrom, now - 10 * HOUR,
      "…while `keptFrom` still reports what is actually held, not what was asked for");
    assert.equal(log.read(9999 * HOUR).samples.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
