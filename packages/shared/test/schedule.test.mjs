// The wall-clock rules for scheduled prompts (`shared/src/schedule.ts`).
// Nothing here is armed with a timer — the host re-asks these functions on a
// tick, so a restart, a sleep and a DST switch cannot mis-fire a schedule.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GRACE_MIN, cleanAction, cleanRule, composeRule, describeHours, describeRule, fmtOffset,
  hoursOpenFrom, hoursZone, inHours, nextFireAt, ruleAnchor, ruleRecurs, typedName, wallClockToEpoch,
  windowCondition, zoneOffsetMs,
} from "../dist/index.js";

const BERLIN = "Europe/Berlin";
const at = (iso) => Date.parse(iso);

test("zoneOffsetMs knows a real zone and its DST, and refuses a fake one", () => {
  assert.equal(zoneOffsetMs("UTC", at("2026-01-15T12:00:00Z")), 0);
  assert.equal(zoneOffsetMs(BERLIN, at("2026-01-15T12:00:00Z")), 3600_000);  // CET
  assert.equal(zoneOffsetMs(BERLIN, at("2026-07-15T12:00:00Z")), 7200_000);  // CEST
  assert.equal(zoneOffsetMs("Mars/Olympus", Date.now()), null);
});

test("wallClockToEpoch resolves a wall clock in its own zone, either side of DST", () => {
  assert.equal(wallClockToEpoch(2026, 0, 15, 9, 0, BERLIN), at("2026-01-15T08:00:00Z"));
  assert.equal(wallClockToEpoch(2026, 6, 15, 9, 0, BERLIN), at("2026-07-15T07:00:00Z"));
  assert.equal(wallClockToEpoch(2026, 0, 15, 9, 0, "UTC"), at("2026-01-15T09:00:00Z"));
});

test("a once rule fires once and then never again", () => {
  const rule = { kind: "once", at: at("2026-09-10T10:00:00Z") };
  assert.equal(nextFireAt(rule, at("2026-09-01T00:00:00Z")), rule.at);
  assert.equal(nextFireAt(rule, rule.at), null);            // strictly after
  assert.equal(nextFireAt(rule, at("2026-09-11T00:00:00Z")), null);
});

test("a lead time shifts the fire before the anchor, on once and weekly alike", () => {
  const anchor = at("2026-09-10T10:00:00Z");
  assert.equal(nextFireAt({ kind: "once", at: anchor, offsetMin: -120 }, anchor - 86400_000), anchor - 7200_000);

  // Weekly 09:00 UTC minus 2h ⇒ 07:00 UTC.
  const weekly = { kind: "weekly", days: [], hour: 9, minute: 0, tz: "UTC", offsetMin: -120 };
  assert.equal(nextFireAt(weekly, at("2026-09-10T00:00:00Z")), at("2026-09-10T07:00:00Z"));
});

test("a lead time big enough to cross midnight still finds tonight's fire", () => {
  // "Monday 01:00 minus 3h" is due on the SUNDAY evening — the search has to
  // walk candidate ANCHOR days, not fire days, or this occurrence is skipped.
  const rule = { kind: "weekly", days: [1], hour: 1, minute: 0, tz: "UTC", offsetMin: -180 };
  assert.equal(nextFireAt(rule, at("2026-09-06T12:00:00Z")), at("2026-09-06T22:00:00Z")); // Sun 22:00
});

test("empty days means every day", () => {
  const daily = { kind: "weekly", days: [], hour: 9, minute: 0, tz: "UTC" };
  assert.equal(nextFireAt(daily, at("2026-09-10T10:00:00Z")), at("2026-09-11T09:00:00Z"));
  const mondays = { kind: "weekly", days: [1], hour: 9, minute: 0, tz: "UTC" };
  assert.equal(nextFireAt(mondays, at("2026-09-10T10:00:00Z")), at("2026-09-14T09:00:00Z"));
});

test("a weekly rule keeps its wall clock across a DST switch", () => {
  // Europe/Berlin leaves DST on 2026-10-25. 09:00 local stays 09:00 local.
  const rule = { kind: "weekly", days: [], hour: 9, minute: 0, tz: BERLIN };
  assert.equal(nextFireAt(rule, at("2026-10-24T12:00:00Z")), at("2026-10-25T08:00:00Z")); // 09:00 CET
  assert.equal(nextFireAt(rule, at("2026-10-23T12:00:00Z")), at("2026-10-24T07:00:00Z")); // 09:00 CEST
});

test("fmtOffset says the lead time in the smallest honest words", () => {
  assert.equal(fmtOffset(120), "2h");
  assert.equal(fmtOffset(-90), "1h 30m");
  assert.equal(fmtOffset(45), "45m");
});

test("cleanRule clamps the hostile and drops an unresolvable zone", () => {
  const r = cleanRule({ kind: "weekly", hour: 99, minute: -5, days: [3, 3, 9, -1], tz: "Mars/Olympus", offsetMin: 99999 });
  assert.equal(r.hour, 23);
  assert.equal(r.minute, 0);
  assert.deepEqual(r.days, [0, 3, 6]);   // deduped, clamped, sorted
  assert.equal(r.tz, undefined);         // unresolvable ⇒ host time, never silent local
  assert.equal(r.offsetMin, 1440);       // a lead time longer than a day is clamped
  assert.equal(cleanRule(null).kind, "weekly");
  assert.equal(cleanRule({ kind: "once", at: "nonsense" }).at, 0);
  assert.equal(cleanRule({ kind: "weekly", tz: BERLIN }).tz, BERLIN);
});

test("cleanAction refuses anything that names nothing runnable", () => {
  assert.equal(cleanAction({ kind: "backlog", text: "   " }), null);
  assert.equal(cleanAction({ kind: "backlog", text: "sweep" }), null);      // no repoDir
  const b = cleanAction({ kind: "backlog", repoDir: "/r", text: " sweep " });
  assert.equal(b.text, "sweep");
  assert.equal(b.autoFire, true);   // a scheduled item that waits for a tap is not a schedule
  assert.equal(cleanAction({ kind: "backlog", repoDir: "/r", text: "x", autoFire: false }).autoFire, false);
});

test("a scheduled backlog action carries the WHOLE chain, bounded on the count and never on the words", () => {
  // Why this field exists: without it `text` was the only slot on the wire
  // between the send sheet and `payload.steps`, so a three-turn plan under a
  // clock ran its first turn and the sheet had to say out loud that it had
  // thrown the other two away. Turns 2..n now travel.
  const long = "x".repeat(5000);
  const a = cleanAction({ kind: "backlog", repoDir: "/r", text: "read the failing test", steps: ["read the failing test", " fix it ", long] });
  assert.deepEqual(a.steps, ["read the failing test", " fix it ", long], "the words are passed through untouched — no trim, no clip");
  assert.equal(a.text, "read the failing test");

  // Absent is the old behaviour, and so is a chain that is only its own head:
  // storing `[text]` would make a one-turn rule read back differently from
  // every rule written before the field existed.
  assert.equal(cleanAction({ kind: "backlog", repoDir: "/r", text: "one turn" }).steps, undefined);
  assert.equal(cleanAction({ kind: "backlog", repoDir: "/r", text: "one turn", steps: ["one turn"] }).steps, undefined);

  // Hostile input survives: a non-array, non-strings and blanks are dropped,
  // and the COUNT is capped (`INTENT_MAX_STEPS`, re-applied by the store).
  assert.equal(cleanAction({ kind: "backlog", repoDir: "/r", text: "t", steps: "not an array" }).steps, undefined);
  assert.deepEqual(cleanAction({ kind: "backlog", repoDir: "/r", text: "t", steps: ["a", 7, null, "  ", "b"] }).steps, ["a", "b"]);
  assert.equal(cleanAction({ kind: "backlog", repoDir: "/r", text: "t", steps: Array.from({ length: 200 }, (_, n) => `s${n}`) }).steps.length, 40);

  // A sweep is ONE prompt (`fanout.ts` reads `steps[0]` and nothing else), so
  // the field is not on that arm at all.
  assert.equal(cleanAction({ kind: "fanout", dirs: ["/r"], text: "t", steps: ["a", "b"] }).steps, undefined);
});

test("`steps[0]` repeats `text` by contract — and now by construction", () => {
  // The contract was written down and enforced nowhere: `scheduleToIntent`
  // trusts `steps`, `intentToSchedule` re-derives `text = steps[0]`, so a rule
  // stored with the two disagreeing came back from ONE round trip with a `text`
  // nobody had written — the row's own label quietly replaced by turn one, or
  // the reverse, depending which way it went round.
  //
  // The head is the copy that survives, because it is the string that actually
  // RUNS as turn one. Nothing is clipped and nothing is invented: this picks
  // between two strings the sender already sent.
  const a = cleanAction({ kind: "backlog", repoDir: "/r", text: "tidy the list", steps: ["run the migration", "review it"] });
  assert.equal(a.text, "run the migration");
  assert.deepEqual(a.steps, ["run the migration", "review it"]);
  // A head that only survives the filter still wins — the same rule, applied to
  // what is left rather than to what was sent.
  assert.equal(cleanAction({ kind: "backlog", repoDir: "/r", text: "t", steps: ["a", 7, null, "  ", "b"] }).text, "a");
  // With no chain there is nothing to disagree with, and `text` is untouched.
  assert.equal(cleanAction({ kind: "backlog", repoDir: "/r", text: " sweep " }).text, "sweep");
  assert.equal(cleanAction({ kind: "backlog", repoDir: "/r", text: "one turn", steps: ["something else"] }).text, "one turn");
});

test("a run window says whose clock it is on, and the window spelling stays one spelling", () => {
  // `describeHours` is the window and only the window: every caller has a
  // different place in its own sentence for the zone, and two spellings of
  // "07:00–22:00" is how a row and the wait sentence under it start disagreeing.
  assert.equal(describeHours(cleanRule({ kind: "weekly", hour: 9, tz: BERLIN, hours: DAY })), "07:00–22:00");
  assert.equal(describeHours(cleanRule({ kind: "weekly", hour: 9 })), null);
  // The suffix is the one wording for "whose clock", and an absent zone is a
  // real reading rather than silence: `inHours` falls back to the host process,
  // so a row showing only "07:00–22:00" was showing the case that moves with
  // the daemon's `TZ` exactly like the case that cannot.
  assert.equal(hoursZone(cleanRule({ kind: "weekly", hour: 9, tz: BERLIN, hours: DAY })), " Europe/Berlin");
  assert.equal(hoursZone(cleanRule({ kind: "weekly", hour: 9, hours: DAY })), " host clock");
});

test("the pieces a stored rule is assembled from survive a round trip", () => {
  // `cleanEntry` — the whole-row sanitiser this used to test — is gone; the
  // durable Intent store's `cleanIntentRow` is the live one (`intent.test.mjs`).
  // What stays here is the schedule half it delegates to.
  const rule = cleanRule({ kind: "weekly", days: [1], hour: 9, tz: "UTC" });
  assert.equal(rule.tz, "UTC");
  assert.ok(DEFAULT_GRACE_MIN > 0);
  assert.equal(typeof describeRule(rule), "string");
  assert.equal(cleanAction(undefined), null); // nothing runnable ⇒ nothing stored
});

test("describeRule says the KIND, not just a clock", () => {
  // "Thu · 16:00" reads as a date, and the schedule card's section header is not
  // sticky — scrolled past it, the rule line is the only thing left that can say
  // whether this is standing policy or a one-off. Exact strings, because the
  // previous assertion here was `typeof === "string"`, which a wall clock with
  // the kind dropped would have passed.
  assert.equal(describeRule(cleanRule({ kind: "weekly", days: [4], hour: 16, minute: 0 })), "every Thu · 16:00");
  assert.equal(describeRule(cleanRule({ kind: "weekly", hour: 9, minute: 30 })), "every day · 09:30");
  assert.match(describeRule(cleanRule({ kind: "once", at: at("2026-09-09T21:00:00Z") })), /^once · /);
});

// ── The two axes: ANCHOR (`kind`) and RECURRENCE (`oneShot`) ────────────────

test("ruleRecurs and ruleAnchor read the two questions apart", () => {
  assert.equal(ruleRecurs({ kind: "once", at: 0 }), false);
  assert.equal(ruleAnchor({ kind: "once", at: 0 }), "clock");
  assert.equal(ruleRecurs({ kind: "weekly" }), true);
  assert.equal(ruleAnchor({ kind: "weekly" }), "clock");
  assert.equal(ruleRecurs({ kind: "weekly", oneShot: true }), false);
  assert.equal(ruleAnchor({ kind: "weekly", oneShot: true }), "clock"); // still a clock anchor
  assert.equal(ruleRecurs({ kind: "window" }), true);
  assert.equal(ruleAnchor({ kind: "window" }), "window");
  assert.equal(ruleRecurs({ kind: "window", oneShot: true }), false);
});

test("cleanRule carries oneShot on weekly and window, never on once", () => {
  assert.equal(cleanRule({ kind: "weekly", oneShot: true }).oneShot, true);
  assert.equal(cleanRule({ kind: "weekly", oneShot: false }).oneShot, undefined);
  assert.equal(cleanRule({ kind: "weekly", oneShot: "yes" }).oneShot, undefined); // hostile ⇒ recurs
  assert.equal(cleanRule({ kind: "window", oneShot: true }).oneShot, true);
  // `once` already IS the clock one-shot — nothing to carry, and cleanRule's
  // literal return for it never had the field to begin with.
  assert.equal(cleanRule({ kind: "once", oneShot: true }).oneShot, undefined);
});

test("describeRule prefixes a one-shot weekly/window rule with 'once ·', and says NEXT not every", () => {
  const weeklyOnce = describeRule(cleanRule({ kind: "weekly", days: [4], hour: 18, minute: 0, oneShot: true }));
  assert.equal(weeklyOnce, "once · next Thu · 18:00");
  const windowOnce = describeRule(cleanRule({ kind: "window", window: "session", edge: "after", oneShot: true }));
  assert.equal(windowOnce, "once · right after the session window resets");
  // A recurring rule of either anchor is unaffected — no "once ·" leaks in.
  assert.doesNotMatch(describeRule(cleanRule({ kind: "weekly", days: [4], hour: 18 })), /^once/);
  assert.doesNotMatch(describeRule(cleanRule({ kind: "window", edge: "after" })), /^once/);
});

test("nextFireAt is identical with and without oneShot — arming is an anchor question", () => {
  const base = { kind: "weekly", days: [4], hour: 18, minute: 0, tz: "UTC" };
  const now = at("2026-09-10T00:00:00Z");
  assert.equal(nextFireAt(base, now), nextFireAt({ ...base, oneShot: true }, now));
});

test("composeRule round-trips all four (anchor, recurrence) pairs", () => {
  const now = at("2026-09-10T12:00:00Z");
  const blank = { kind: "once", at: 0 };

  const onceR = composeRule("clock", false, blank, now);
  assert.equal(ruleAnchor(onceR), "clock");
  assert.equal(ruleRecurs(onceR), false);
  assert.equal(onceR.kind, "once");

  const weeklyR = composeRule("clock", true, onceR, now, "UTC");
  assert.equal(ruleAnchor(weeklyR), "clock");
  assert.equal(ruleRecurs(weeklyR), true);
  assert.equal(weeklyR.kind, "weekly");

  const weeklyOnceR = { ...weeklyR, oneShot: true }; // set the way the UI's secondary chip does
  assert.equal(ruleAnchor(weeklyOnceR), "clock");
  assert.equal(ruleRecurs(weeklyOnceR), false);

  const windowR = composeRule("window", true, weeklyOnceR, now);
  assert.equal(ruleAnchor(windowR), "window");
  assert.equal(ruleRecurs(windowR), true);
  assert.equal(windowR.kind, "window");

  const windowOnceR = composeRule("window", false, windowR, now);
  assert.equal(ruleAnchor(windowOnceR), "window");
  assert.equal(ruleRecurs(windowOnceR), false);
  assert.equal(windowOnceR.oneShot, true);

  // Back to clock: the switch does not resurrect the abandoned oneShot.
  const backToClock = composeRule("clock", true, windowOnceR, now, "UTC");
  assert.equal(ruleAnchor(backToClock), "clock");
  assert.equal(ruleRecurs(backToClock), true);
});

test("composeRule carries a lead time across clock and window anchors", () => {
  const now = at("2026-09-10T12:00:00Z");
  const weekly = composeRule("clock", true, { kind: "weekly", offsetMin: -120, tz: "UTC" }, now, "UTC");
  assert.equal(weekly.offsetMin, -120);
  const toWindow = composeRule("window", true, weekly, now);
  assert.equal(toWindow.offsetMin, -120); // still "2h before", now before a reset instead of a clock
});

test("typedName tells a name somebody typed from a slice of their own prompt", () => {
  // Both ends fill an empty name with the first line of the text, cut at 120
  // (`scheduleToIntent`) or 40 (`Backlog.add`). Rendering that above the text it
  // came from put one string on the card twice — "already fi" over the sentence
  // it was sliced out of.
  const long = `${"fix the overlap in the header ".repeat(12)}\nand then run the tests`;
  assert.equal(typedName("weekly sweep", long), "weekly sweep");          // a real name survives
  assert.equal(typedName(long.split("\n")[0].slice(0, 120), long), null); // the host's own slice
  // Second clause: a first line SHORTER than the slice makes the NAME the prefix
  // of the text, not the other way round — a multi-line prompt whose first line
  // the slice swallowed whole.
  assert.equal(typedName("tidy up", "tidy up\n\nand push it"), null);
  // No prose at all (a build, a capture): without the guard `startsWith("")` is
  // vacuously true and every name would vanish.
  assert.equal(typedName("Release APK", ""), "Release APK");
  assert.equal(typedName("   ", long), null);                             // no name ⇒ nothing to show
  assert.equal(typedName(null, long), null);
});

test("a derived name must not survive an EDIT of the words it was derived from", () => {
  /**
   * The round trip is where this predicate is actually load-bearing, and it is
   * the one place it can be defeated: the editor is the Send sheet, seeded from
   * the stored row, and seeding the stored `name` verbatim hands a derivation
   * back as a decision. Change the prompt and the old slice no longer prefixes
   * the new words — so it reads as a name somebody chose, and the card is
   * crowned with a mid-word fragment of a prompt that no longer exists.
   *
   * The fix is on the seed (`seedFromSchedule` / `seedFromIntent` in App.tsx):
   * a name is carried into the editor only if this function still calls it one.
   */
  const before = "measure the always-on context first and stop if it is already fine";
  const derived = before.slice(0, 120);            // what the host stored as `name`
  assert.equal(typedName(derived, before), null);  // not a name while the words stand
  const after = "actually just delete the skill index and re-measure";
  // Seeded verbatim it would come back a "name"; re-derived through this, it does not.
  assert.equal(typedName(derived, after), derived, "unguarded, the stale slice reads as typed");
  assert.equal(typedName(typedName(derived, before) ?? undefined, after), null);
});

// ── The run window: quiet hours over any anchor ─────────────────────────────
//
// `hours` is the third question a rule can be asked, and it is deliberately not
// part of the anchor: `nextFireAt` places the occurrence exactly where it
// always did, and this decides whether the instant it landed on is one the
// machine may speak at. Every test below is about that separation holding.

const DAY = { from: 7 * 60, to: 22 * 60 };    // 07:00–22:00
const NIGHT = { from: 22 * 60, to: 7 * 60 };  // 22:00–07:00, wrapping

test("inHours is half-open, wraps midnight, and is true when there is no window", () => {
  // Half-open so 07:00–22:00 and 22:00–07:00 are complements rather than two
  // windows that both claim 22:00 — a minute owned by both is a minute where
  // "only during the day" and "only at night" agree, which is not a thing
  // either of them means.
  const day = cleanRule({ kind: "weekly", hour: 9, tz: "UTC", hours: DAY });
  assert.equal(inHours(day, at("2026-09-10T07:00:00Z")), true);   // `from` is inside
  assert.equal(inHours(day, at("2026-09-10T22:00:00Z")), false);  // `to` is not
  assert.equal(inHours(day, at("2026-09-10T06:59:00Z")), false);

  const night = cleanRule({ kind: "weekly", hour: 9, tz: "UTC", hours: NIGHT });
  assert.equal(inHours(night, at("2026-09-10T23:30:00Z")), true);
  assert.equal(inHours(night, at("2026-09-10T03:00:00Z")), true);
  assert.equal(inHours(night, at("2026-09-10T12:00:00Z")), false);

  // Absent ⇒ any hour, which is what every rule written before this field
  // existed meant and still means.
  assert.equal(inHours(cleanRule({ kind: "weekly", hour: 9, tz: "UTC" }), at("2026-09-10T03:00:00Z")), true);
});

test("the window is read in the rule's OWN zone, either side of DST", () => {
  // The daemon runs under whatever TZ launchd handed it. A window resolved
  // against the host's clock would shut the door an hour early for half the
  // year — the same drift the stored zone exists to keep out of the anchor.
  const r = cleanRule({ kind: "weekly", hour: 9, tz: BERLIN, hours: DAY });
  assert.equal(inHours(r, at("2026-07-15T05:30:00Z")), true);   // 07:30 CEST — open
  assert.equal(inHours(r, at("2026-01-15T05:30:00Z")), false);  // 06:30 CET — shut
});

test("a window or once rule keeps its zone too — the same rule answers the same on any host", () => {
  // `tz` used to survive only the `weekly` branch of `cleanRule`, while `hours`
  // survived all three. So a `{kind:"window"}` rule with 07:00–22:00 on it was
  // read against `getHours()`, the DAEMON's clock: the same rule was OPEN at
  // 05:30Z under `TZ=Asia/Tokyo` and SHUT under `TZ=UTC`. launchd sets no `TZ`,
  // so on a Mac in the user's own zone it happened to be right — and a `TZ` in
  // the plist, a Linux host or a person travelling with the phone shifted the
  // whole window by the offset, in silence, on the one kind of rule whose row
  // never printed a zone.
  const tz = process.env.TZ;
  const under = (zone, fn) => {
    process.env.TZ = zone;
    try { return fn(); } finally { if (tz == null) delete process.env.TZ; else process.env.TZ = tz; }
  };

  const win = cleanRule({ kind: "window", edge: "after", tz: BERLIN, hours: DAY });
  assert.equal(win.tz, BERLIN, "the zone is stored on a window rule");
  assert.equal(under("Asia/Tokyo", () => inHours(win, at("2026-07-15T05:30:00Z"))), true);   // 07:30 CEST
  assert.equal(under("UTC", () => inHours(win, at("2026-07-15T05:30:00Z"))), true);          // the SAME answer
  assert.equal(under("Asia/Tokyo", () => inHours(win, at("2026-07-15T04:30:00Z"))), false);  // 06:30 CEST
  assert.equal(under("UTC", () => inHours(win, at("2026-07-15T04:30:00Z"))), false);

  const once = cleanRule({ kind: "once", at: at("2026-07-15T03:00:00Z"), tz: BERLIN, hours: DAY });
  assert.equal(once.tz, BERLIN);
  assert.equal(under("Asia/Tokyo", () => hoursOpenFrom(once, at("2026-07-15T03:00:00Z"))), at("2026-07-15T05:00:00Z"));
  assert.equal(under("UTC", () => hoursOpenFrom(once, at("2026-07-15T03:00:00Z"))), at("2026-07-15T05:00:00Z"));

  // Tied to the window: a rule with no hours has no wall clock to read on those
  // two kinds, so it carries no zone to invite the next reader to think the
  // anchor moved.
  assert.equal(cleanRule({ kind: "window", edge: "after", tz: BERLIN }).tz, undefined);
  assert.equal(cleanRule({ kind: "once", at: 5, tz: BERLIN }).tz, undefined);
  // An unresolvable zone is dropped on every kind, as it always was on weekly —
  // the row then says "host clock" rather than naming a zone nobody can resolve.
  assert.equal(cleanRule({ kind: "window", edge: "after", tz: "Mars/Olympus", hours: DAY }).tz, undefined);
});

test("composeRule carries the window's zone across every anchor switch", () => {
  // "I am asleep between 22:00 and 07:00" stays true whichever instant the rule
  // is hung off — and so does the zone those two clocks were typed in. The
  // sheet passes the device's zone; switching anchor must not drop it, or the
  // window silently moves to the daemon's clock the moment somebody taps
  // "repeating" and back.
  const now = at("2026-09-10T12:00:00Z");
  const weekly = composeRule("clock", true, { kind: "once", at: 0, hours: NIGHT }, now, BERLIN);
  assert.equal(weekly.tz, BERLIN);
  const win = composeRule("window", true, weekly, now, BERLIN);
  assert.deepEqual(win.hours, NIGHT);
  assert.equal(win.tz, BERLIN, "the window rule keeps the zone its hours are written in");
  const once = composeRule("clock", false, win, now, BERLIN);
  assert.deepEqual(once.hours, NIGHT);
  assert.equal(once.tz, BERLIN);
  // No hours, nothing to place: the zone rides with the window, not on its own.
  assert.equal(composeRule("window", true, { kind: "once", at: 0 }, now, BERLIN).tz, undefined);
});

test("hoursOpenFrom answers the instant itself when the window is already open", () => {
  const r = cleanRule({ kind: "weekly", hour: 3, tz: "UTC", hours: DAY });
  const open = at("2026-09-10T09:00:00Z");
  assert.equal(hoursOpenFrom(r, open), open);
  // No window at all ⇒ nothing to wait for; the basis is the instant asked
  // about, so a rule without `hours` measures its grace exactly as before.
  const bare = cleanRule({ kind: "weekly", hour: 3, tz: "UTC" });
  assert.equal(hoursOpenFrom(bare, open), open);
});

test("hoursOpenFrom finds the NEXT opening, today's or tomorrow's", () => {
  // This is the instant a late occurrence's grace is counted from. A rule
  // anchored at 03:00 behind a 07:00–22:00 window is due at 03:00 and may not
  // run until 07:00 — measuring two hours of grace from the anchor would
  // report it missed at 05:00, every day, having never once been allowed to
  // try.
  const r = cleanRule({ kind: "weekly", hour: 3, tz: "UTC", hours: DAY });
  assert.equal(hoursOpenFrom(r, at("2026-09-10T03:00:00Z")), at("2026-09-10T07:00:00Z"));
  assert.equal(hoursOpenFrom(r, at("2026-09-10T23:00:00Z")), at("2026-09-11T07:00:00Z"));
  // A night window shut at noon opens this evening, not tomorrow morning.
  const night = cleanRule({ kind: "weekly", hour: 12, tz: "UTC", hours: NIGHT });
  assert.equal(hoursOpenFrom(night, at("2026-09-10T12:00:00Z")), at("2026-09-10T22:00:00Z"));
});

test("an opening keeps its wall clock across a DST switch", () => {
  // Europe/Berlin leaves DST on 2026-10-25: 07:00 local stays 07:00 local, and
  // the opening moves in UTC rather than in the user's day.
  const r = cleanRule({ kind: "weekly", hour: 3, tz: BERLIN, hours: DAY });
  assert.equal(hoursOpenFrom(r, at("2026-10-25T01:00:00Z")), at("2026-10-25T06:00:00Z")); // 07:00 CET
  assert.equal(hoursOpenFrom(r, at("2026-10-24T01:00:00Z")), at("2026-10-24T05:00:00Z")); // 07:00 CEST
});

test("cleanRule refuses a run window it would have to invent, and drops one with no width", () => {
  assert.deepEqual(cleanRule({ kind: "weekly", hours: NIGHT }).hours, NIGHT);
  // NOT clamped. `{from: 5000, to: 100}` used to become `{from: 1439, to: 100}`
  // — a 23:59–01:40 night window nobody typed, on a rule that then quietly
  // never ran in the daytime again. The phone's `<input type=time>` cannot
  // produce a minute outside 0..1439, so a value outside it is a corrupt file
  // or a hostile draft, and the honest answer is the one `from === to` already
  // gets: drop the window, which is the old behaviour (any hour).
  assert.equal(cleanRule({ kind: "weekly", hours: { from: 5000, to: 100 } }).hours, undefined);
  assert.equal(cleanRule({ kind: "weekly", hours: { from: -30, to: 99999 } }).hours, undefined);
  assert.equal(cleanRule({ kind: "weekly", hours: { from: 0, to: 1439 } }).hours?.to, 1439, "the real edges still pass");
  // `from === to` has two readings — "every minute" and "no minute" — and a
  // sanitiser that picks one turns a typo into a schedule that never fires
  // again. Absent is the honest answer and the old behaviour.
  assert.equal(cleanRule({ kind: "weekly", hours: { from: 540, to: 540 } }).hours, undefined);
  assert.equal(cleanRule({ kind: "weekly", hours: { from: "nine", to: 420 } }).hours, undefined);
  assert.equal(cleanRule({ kind: "weekly", hours: "22:00-07:00" }).hours, undefined);
  assert.equal(cleanRule({ kind: "weekly" }).hours, undefined);
  // Carried on every anchor: "not while I am asleep" is a policy over the
  // anchor, never a part of one.
  assert.deepEqual(cleanRule({ kind: "once", at: 5, hours: DAY }).hours, DAY);
  assert.deepEqual(cleanRule({ kind: "window", edge: "after", hours: NIGHT }).hours, NIGHT);
});

test("describeRule says the run window as one trailing clause, on every anchor", () => {
  assert.equal(
    describeRule(cleanRule({ kind: "weekly", days: [4], hour: 16, minute: 0, hours: DAY })),
    "every Thu · 16:00, only 07:00–22:00",
  );
  assert.equal(
    describeRule(cleanRule({ kind: "window", window: "session", edge: "after", hours: NIGHT })),
    "right after the session window resets, only 22:00–07:00",
  );
  // The clause goes LAST, after the anchor and its lead time, so the line still
  // opens with the thing the rule tracks.
  assert.equal(
    describeRule(cleanRule({ kind: "weekly", days: [1], hour: 1, minute: 0, offsetMin: -180, hours: DAY })),
    "every Mon · 01:00, 3h before, only 07:00–22:00",
  );
  // No window ⇒ not a word about one (the strings above this section still hold).
  assert.equal(describeRule(cleanRule({ kind: "weekly", days: [4], hour: 16, minute: 0 })), "every Thu · 16:00");
  assert.equal(describeHours(cleanRule({ kind: "weekly", hour: 9 })), null);
});

test("nextFireAt is unchanged by a run window — placing and allowing are two questions", () => {
  // The occurrence lands where it always did; whether it may RUN there is the
  // verdict ladder's question (`intent.test.mjs`). Folding the window into the
  // anchor here would move the instant the row says it tracks.
  const base = { kind: "weekly", days: [], hour: 3, minute: 0, tz: "UTC" };
  const now = at("2026-09-10T00:00:00Z");
  assert.equal(nextFireAt({ ...base, hours: DAY }, now), nextFireAt(base, now));
  assert.equal(nextFireAt({ ...base, hours: DAY }, now), at("2026-09-10T03:00:00Z"));
});

test("composeRule carries a run window across every anchor switch", () => {
  // Unlike `guardWindow`, quiet hours are not about the anchor at all: "I am
  // asleep between 22:00 and 07:00" stays true whichever instant the rule is
  // hung off, and dropping it at the switch would silently re-open a door the
  // user shut.
  const now = at("2026-09-10T12:00:00Z");
  const weekly = composeRule("clock", true, { kind: "weekly", hours: NIGHT }, now, "UTC");
  assert.deepEqual(weekly.hours, NIGHT);
  assert.deepEqual(composeRule("window", true, weekly, now).hours, NIGHT);
  assert.deepEqual(composeRule("clock", false, weekly, now).hours, NIGHT);
});

// ── The headroom guard on the OTHER usage window ────────────────────────────

const resets = (over = {}) => ({
  sessionResetAt: at("2026-09-10T05:00:00Z"), weeklyResetAt: at("2026-09-12T05:00:00Z"),
  sessionPct: 40, weeklyPct: 10, ...over,
});

test("a guard naming the OTHER window survives; one naming the same window is not a guard", () => {
  const other = cleanRule({ kind: "window", window: "session", edge: "after", minPctLeft: 30, guardWindow: "weekly" });
  assert.equal(other.guardWindow, "weekly");
  assert.equal(other.minPctLeft, 30);
  // Two fields saying one thing is two fields the next reader has to prove
  // agree before they can read either.
  assert.equal(cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -60, minPctLeft: 30, guardWindow: "session" }).guardWindow, undefined);
  assert.equal(cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -60, guardWindow: "nonsense" }).guardWindow, undefined);
  // And the `after`-edge condition still dies without one: a window that has
  // just reset is empty, so a condition on it could only ever mean "never run".
  assert.equal(cleanRule({ kind: "window", window: "session", edge: "after", minPctLeft: 30 }).minPctLeft, undefined);
});

test("the condition reads the GUARD's meter, and the after-edge exemption lifts with it", () => {
  // The instruction this whole field exists for: "right after the session
  // window resets, but only if 30% of the week is left" — an anchor on one
  // window and a question about the other, which one `window` field could not
  // hold at the same time.
  const r = cleanRule({ kind: "window", window: "session", edge: "after", minPctLeft: 30, guardWindow: "weekly" });
  const ok = windowCondition(r, resets({ weeklyPct: 50, sessionPct: 100 }));
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /50% of the weekly window was left/);   // the weekly meter, not the session one
  const no = windowCondition(r, resets({ weeklyPct: 90, sessionPct: 0 }));
  assert.equal(no.ok, false);
  assert.match(no.detail, /10% of the weekly window was left/);
  assert.match(no.detail, /at least 30%/);
  // Unreadable still fails CLOSED, guard or no guard — firing a sweep because
  // nobody could read a percentage is the outcome the condition was written to
  // avoid.
  assert.equal(windowCondition(r, resets({ weeklyPct: null })).ok, false);
  // Without a guard the `after` edge is unconditional, exactly as before.
  const bare = cleanRule({ kind: "window", window: "session", edge: "after" });
  assert.equal(windowCondition(bare, resets({ sessionPct: 100 })).ok, true);
});

test("describeRule names the guard's window, and only when it is the other one", () => {
  assert.equal(
    describeRule(cleanRule({ kind: "window", window: "session", edge: "after", minPctLeft: 30, guardWindow: "weekly" })),
    "right after the session window resets, only if 30% of the week is left",
  );
  assert.equal(
    describeRule(cleanRule({ kind: "window", window: "weekly", edge: "before", offsetMin: -120, minPctLeft: 30, guardWindow: "session" })),
    "2h before the weekly window resets, only if 30% of the session window is left",
  );
  // One window in the sentence needs no second noun — the existing wording is
  // unchanged, which is what "absent = old behaviour" means for a string.
  assert.equal(
    describeRule(cleanRule({ kind: "window", window: "session", edge: "before", offsetMin: -120, minPctLeft: 40 })),
    "2h before the session window resets, only if 40% is left",
  );
});
