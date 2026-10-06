/**
 * What `/usage` says, read off a RENDERED screen.
 *
 * The fixture is the real thing: `claude`'s `/usage` tab replayed through the
 * same headless VT `UsageChecker.scrape()` now uses, captured 2026-09-07. Both
 * windows print their reset instant as words under their own heading, and the
 * bug this pins is that a stripped capture has neither the spaces inside the
 * heading nor the ones inside the sentence — so both instants came back null on
 * a screen that named them both, and the phone said "the screen did not name a
 * reset time for this window" twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsage, rememberedUsage, usageAfterResets } from "../dist/usage.js";

/** The rendered `/usage` screen, verbatim. */
const SCREEN = `
  Settings  Status   Config   Usage   Stats

  Session

  Total cost:            $0.0000
  Total duration (API):  0s

  Current session
  ███████████████████████                            46% used
  Resets 10:10pm (Europe/Berlin)

  Current week (all models)
  █████████████████████████████████████████████      90% used
  Resets Sep 10 at 7pm (Europe/Berlin)
  +50% weekly limits promo through Sep 13 · clau.de/cc-50-promo

  Current week (Fable)
  ██████████████████████████▌                        53% used
  Resets Sep 10 at 6:59pm (Europe/Berlin)

  What's contributing to your limits usage?
`;

/** 2026-09-07 18:29 Europe/Berlin, the instant the fixture was taken. */
const NOW = Date.parse("2026-09-07T16:29:00Z");

/** `YYYY-MM-DD HH:MM` in the zone the screen named. Numeric on purpose: a
 *  month NAME is locale data, and the runner's ICU decides whether that is
 *  "Sep" or "Sept". */
const berlin = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

test("both windows' percentages come off the labels", () => {
  const u = parseUsage(SCREEN, NOW);
  assert.equal(u.sessionPct, 46);
  assert.equal(u.weeklyPct, 90);
});

test("the session reset is the bare wall-clock time, later today", () => {
  const u = parseUsage(SCREEN, NOW);
  assert.ok(u.sessionResetAt != null, "session reset must be read");
  assert.equal(berlin(u.sessionResetAt), "2026-09-07 22:10");
});

test("the weekly reset takes the DATE the screen named, not today", () => {
  const u = parseUsage(SCREEN, NOW);
  assert.ok(u.weeklyResetAt != null, "weekly reset must be read");
  assert.equal(berlin(u.weeklyResetAt), "2026-09-10 19:00");
});

test("a per-model week never stands in for the account-wide one", () => {
  const u = parseUsage(SCREEN, NOW);
  assert.notEqual(u.weeklyPct, 53);
  // 6:59pm is the Fable row's instant; the all-models row says 7pm.
  assert.equal(berlin(u.weeklyResetAt), "2026-09-10 19:00");
});

test("a stripped capture — the old input — yields no reset at all", () => {
  // The bug, kept as a test: with the cursor-drawn gaps gone, the headings and
  // the sentences are single words and nothing anchors. Percentages still parse
  // (they are read off a squashed copy), which is exactly why this went unseen.
  const stripped = SCREEN.replace(/[ \t]+/g, "");
  const u = parseUsage(stripped, NOW);
  assert.equal(u.sessionPct, 46);
  assert.equal(u.sessionResetAt, null);
  assert.equal(u.weeklyResetAt, null);
});

/* ── A reading kept across a restart ────────────────────────────────────────
 *
 * `npm run restart` is what shipping a new web bundle to the phone IS, and the
 * checker's cache is in memory — so the phone reconnected to a daemon that had
 * never probed and drew `? / ? wk` for a figure that was on disk the whole
 * time. What may be claimed from that file is the whole correctness here: a
 * window whose reset has passed is GONE, and its old percentage is the
 * plausible-wrong-number `usage.ts` exists to refuse.
 */
const T0 = Date.parse("2026-09-07T16:29:00Z");
const MIN = 60_000;

test("the last kept reading is re-offered, marked as remembered, at its own age", () => {
  const u = rememberedUsage(
    { t: T0 - 5 * MIN, s: 46, w: 90, sr: T0 + 30 * MIN, wr: T0 + 3 * 24 * 60 * MIN },
    T0,
  );
  assert.ok(u, "a reading with both windows still open is worth offering");
  assert.equal(u.ok, true);
  assert.equal(u.sessionPct, 46);
  assert.equal(u.weeklyPct, 90);
  assert.equal(u.remembered, true);
  // The ORIGINAL probe's instant — every staleness rule already reads it.
  assert.equal(u.checkedAt, T0 - 5 * MIN);
});

test("a window whose reset has passed is never re-offered", () => {
  const u = rememberedUsage(
    { t: T0 - 6 * 60 * MIN, s: 46, w: 90, sr: T0 - 60 * MIN, wr: T0 + 2 * 24 * 60 * MIN },
    T0,
  );
  assert.equal(u.sessionPct, null, "that five-hour window rolled over hours ago");
  assert.equal(u.sessionResetAt, null);
  assert.equal(u.weeklyPct, 90, "the week it named is still running");
});

test("a sample that named no reset claims no window, and nothing left ⇒ nothing offered", () => {
  assert.equal(rememberedUsage({ t: T0 - MIN, s: 46, w: 90, sr: null, wr: null }, T0), null);
  assert.equal(rememberedUsage(null, T0), null);
  assert.equal(rememberedUsage({ t: 0, s: 5, w: 5, sr: T0 + MIN, wr: T0 + MIN }, T0), null);
});

test("a live reading loses a window the moment that window resets", () => {
  const live = {
    ok: true, sessionPct: 46, weeklyPct: 90,
    sessionResetAt: T0 - 1, weeklyResetAt: T0 + 60 * MIN, checkedAt: T0 - 20 * MIN,
  };
  const after = usageAfterResets(live, T0);
  assert.equal(after.sessionPct, null);
  assert.equal(after.weeklyPct, 90);
  assert.equal(after.ok, true);
  // Nothing expired ⇒ the SAME object, because `get()` runs on the backlog tick.
  const open = { ...live, sessionResetAt: T0 + MIN };
  assert.equal(usageAfterResets(open, T0), open);
  // Both gone ⇒ an honest `?`, never a number.
  assert.equal(usageAfterResets({ ...live, weeklyResetAt: T0 - 1 }, T0).ok, false);
});
