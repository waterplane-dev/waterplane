/**
 * The CLI-integration health rules.
 *
 * Every case here is one the host cannot be asked to produce: a detector that
 * stopped matching, a delivery path failing one time in five while every
 * individual failure is handled, a `claude` upgrade that invalidates a week of
 * evidence. Pinned here rather than in an e2e script because none of it needs a
 * host — and because the properties that matter most are exactly the ones a bug
 * would make silent: that `unknown` never reads as `healthy`, and that a rate
 * can be unhealthy while no single event was.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BROKEN_MISSES,
  CLI_SIGNALS,
  DEGRADED_MISSES,
  RATE_DEGRADED,
  RATE_MIN_SAMPLES,
  RATE_WINDOW,
  SAMPLE_CAP,
  SIGNAL_FORGET_MS,
  agoText,
  blankSignal,
  captureSample,
  clearSeen,
  cleanHealth,
  emptyHealth,
  healthRollup,
  healthSentence,
  noteCliVersion,
  observe,
  redactSample,
  shapeOf,
  signalSpec,
  signalVerdict,
  supersededByGood,
  thresholdsFor,
  unhealthySignals,
} from "../dist/clihealth.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

/** A record with a known version, so the version rules are never accidental. */
const fresh = (version = "2.0.1") => {
  const h = emptyHealth();
  h.version = version;
  h.versionSeenAt = NOW;
  return h;
};

/** Feed a sequence of outcomes, one per minute, ending at `NOW`. */
const feed = (h, id, outcomes, opts = {}) => {
  const n = outcomes.length;
  outcomes.forEach((o, i) => {
    observe(h, id, o, { at: NOW - (n - 1 - i) * MIN, ...opts });
  });
  return h.signals[id];
};

test("the catalog is a list, and every entry says what it means", () => {
  const ids = CLI_SIGNALS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "signal ids must be unique");
  for (const s of CLI_SIGNALS) {
    assert.ok(s.name.length > 10, `${s.id} needs a verb-phrase name`);
    assert.ok(s.means.length > 30, `${s.id} must say what breaks when it breaks`);
    assert.ok(s.capture === "line" || s.capture === "shape");
    assert.equal(signalSpec(s.id).name, s.name);
  }
  // The five the design brief names by hand are all on the board.
  for (const id of ["prompt.box", "limit.reset", "context.meter", "hook.pipe", "deliver.echo"]) {
    assert.ok(ids.includes(id), `${id} missing from the catalog`);
  }
  // An id from a newer host renders as a row rather than throwing inside a
  // readout whose whole job is to be reliable.
  assert.equal(signalSpec("something.new").name, "something.new");
});

test("a signal with no observations is unknown, and unknown is never healthy", () => {
  const sig = blankSignal("prompt.box", "2.0.1");
  const c = signalVerdict(sig, NOW);
  assert.equal(c.verdict, "unknown");
  assert.equal(c.because, "no-observations");
  assert.notEqual(c.verdict, "healthy");
  assert.equal(c.rate, null);          // not 0 — nobody has enough samples for a rate
  assert.equal(c.since, null);
  // …and one confirmed good is what buys `healthy`. Nothing else does.
  const h = fresh();
  const one = feed(h, "prompt.box", ["good"]);
  assert.equal(signalVerdict(one, NOW).verdict, "healthy");
  assert.equal(signalVerdict(one, NOW).because, "confirmed");
});

test("one miss after a good is still healthy; two in a row is degraded, five is broken", () => {
  assert.equal(DEGRADED_MISSES, 2);
  assert.equal(BROKEN_MISSES, 5);
  const h = fresh();
  assert.equal(signalVerdict(feed(h, "prompt.box", ["good", "miss"]), NOW).verdict, "healthy");

  const h2 = fresh();
  const two = feed(h2, "prompt.box", ["good", "miss", "miss"]);
  assert.equal(signalVerdict(two, NOW).verdict, "degraded");
  assert.equal(signalVerdict(two, NOW).because, "misses");
  assert.equal(signalVerdict(two, NOW).misses, 2);

  const h3 = fresh();
  const five = feed(h3, "prompt.box", ["good", "miss", "miss", "miss", "miss", "miss"]);
  assert.equal(signalVerdict(five, NOW).verdict, "broken");
  assert.equal(signalVerdict(five, NOW).misses, 5);

  // A good clears the streak outright — the whole point of "consecutive".
  observe(h3, "prompt.box", "good", { at: NOW });
  assert.equal(signalVerdict(h3.signals["prompt.box"], NOW).verdict, "healthy");
  assert.equal(h3.signals["prompt.box"].misses, 0);
  assert.equal(h3.signals["prompt.box"].missStreakSince, null);
});

test("a signal seen ONLY failing is unknown, never healthy and never degraded on one miss", () => {
  const h = fresh();
  const sig = feed(h, "prompt.box", ["miss"]);
  const c = signalVerdict(sig, NOW);
  assert.equal(c.verdict, "unknown");   // nothing here has ever worked
  assert.equal(sig.lastGoodAt, null);
});

test("THE 22% CASE: healthy per event, unhealthy in aggregate", () => {
  // Five failures in twenty, none of them adjacent — so the consecutive-miss
  // rule never fires and every single delivery was "handled". This is the shape
  // that ran for a week without anyone knowing there was a signal to look at.
  const h = fresh();
  const seq = [];
  for (let i = 0; i < RATE_WINDOW; i++) seq.push(i % 4 === 1 ? "miss" : "good");
  const sig = feed(h, "deliver.echo", seq);
  assert.equal(sig.misses, 0, "no streak at all — every miss is followed by a good");

  const c = signalVerdict(sig, NOW);
  assert.equal(c.samples, 20);
  assert.equal(c.failed, 5);
  assert.equal(c.rate, 0.25);
  assert.equal(c.verdict, "degraded");
  assert.equal(c.because, "rate");
  assert.ok(c.rate >= RATE_DEGRADED);

  // Half of everything is `broken`, not merely degraded: at that point the
  // fallback IS the code path.
  const h2 = fresh();
  const half = feed(h2, "deliver.echo", Array.from({ length: 20 }, (_, i) => (i % 2 ? "miss" : "good")));
  assert.equal(signalVerdict(half, NOW).verdict, "broken");
  assert.equal(signalVerdict(half, NOW).because, "rate");
});

test("a rate below the sample floor means nothing, and is not allowed to mean anything", () => {
  assert.equal(RATE_MIN_SAMPLES, 8);
  const h = fresh();
  const sig = feed(h, "deliver.echo", ["good", "miss", "good", "miss"]);
  const c = signalVerdict(sig, NOW);
  assert.equal(c.samples, 4);
  assert.equal(c.failed, 2);
  assert.equal(c.rate, null, "50% of four is not a fact about anything");
  assert.equal(c.verdict, "healthy", "…so the streak rules decide, and there is no streak");
});

test("the rate window is count-based, and ages out at twelve hours", () => {
  const th = thresholdsFor("deliver.echo");
  assert.equal(th.rateWindow, 20);
  assert.equal(th.rateMaxAgeMs, 12 * 3600_000);

  // Twenty-five observations: only the last twenty are kept at all.
  const h = fresh();
  const seq = Array.from({ length: 25 }, () => "good");
  const sig = feed(h, "deliver.echo", seq);
  assert.equal(sig.window.length, 20);

  // Yesterday's failures cannot explain today's screen: aged-out observations
  // leave the rate, but the history they wrote stays.
  const h2 = fresh();
  const old = h2.signals["deliver.echo"] = blankSignal("deliver.echo", "2.0.1");
  for (let i = 0; i < 10; i++) observe(h2, "deliver.echo", "miss", { at: NOW - 20 * 3600_000 + i });
  for (let i = 0; i < 10; i++) observe(h2, "deliver.echo", "good", { at: NOW - i * MIN });
  const c = signalVerdict(h2.signals["deliver.echo"], NOW);
  assert.equal(c.samples, 10, "the day-old half of the window is not counted");
  assert.equal(c.failed, 0);
  assert.equal(c.verdict, "healthy");
  assert.ok(old.lastMissAt != null, "the miss is still in the history, just not in the rate");
});

test("a signal that goes quiet returns to unknown — not healthy, and not still red", () => {
  assert.equal(SIGNAL_FORGET_MS, 24 * 3600_000);
  const h = fresh();
  feed(h, "prompt.box", ["good", "miss", "miss", "miss", "miss", "miss"]);
  const sig = h.signals["prompt.box"];
  assert.equal(signalVerdict(sig, NOW).verdict, "broken");
  // A day later with nothing observed at all: the path was not TAKEN. Saying
  // "broken" would be a fact about last week; saying "healthy" would be a lie.
  const later = NOW + SIGNAL_FORGET_MS + MIN;
  const c = signalVerdict(sig, later);
  assert.equal(c.verdict, "unknown");
  assert.equal(c.because, "gone-quiet");
  // A usage block is weeks apart by nature, so that signal is given a month.
  assert.equal(thresholdsFor("limit.reset").forgetMs, 30 * 24 * 3600_000);
  assert.equal(thresholdsFor("prompt.box").forgetMs, SIGNAL_FORGET_MS);
});

test("a fallback is a miss with a name", () => {
  const h = fresh();
  const sig = feed(h, "hook.pipe", ["good", "fallback", "fallback"], { via: "silence heuristics" });
  assert.equal(sig.misses, 2, "taking the substitute IS the primary not answering");
  assert.equal(signalVerdict(sig, NOW).verdict, "degraded");
  assert.equal(sig.via, "silence heuristics");
  assert.equal(sig.lastFallbackAt, NOW);
  assert.equal(sig.window.at(-1).fallback, true);
  assert.equal(sig.window[0].fallback, undefined);
});

test("a fallback the primary rule has been confirmed over is history, not a state", () => {
  const h = fresh();
  // Falls back, then works again — the shape the board got wrong: `healthy`,
  // last confirmed minutes ago, still wearing an amber "Falling back to…" over
  // a captured screen from four days earlier.
  const sig = feed(h, "hook.pipe", ["fallback", "good", "good"], { via: "silence heuristics", raw: "some screen row" });
  assert.equal(signalVerdict(sig, NOW).verdict, "healthy");
  assert.equal(sig.via, "silence heuristics", "the breadcrumb is KEPT — it is the actionable half");
  assert.ok(sig.sample, "and so is the captured input (a shape, for this signal)");
  assert.equal(supersededByGood(sig, sig.lastFallbackAt), true, "a good stamped after it settles the question");
  assert.equal(supersededByGood(sig, sig.sampleAt), true);

  // Still standing on the fallback: nothing has been confirmed since.
  const still = feed(fresh(), "hook.pipe", ["good", "fallback"], { via: "silence heuristics", raw: "row" });
  assert.equal(supersededByGood(still, still.lastFallbackAt), false);

  // Never confirmed at all, and a record with no such stamp at all.
  const never = feed(fresh(), "hook.pipe", ["fallback"], { via: "silence heuristics" });
  assert.equal(supersededByGood(never, never.lastFallbackAt), false);
  assert.equal(supersededByGood(never, null), false);
  assert.equal(supersededByGood(never, undefined), false);
});

test("a version change re-arms every signal, and keeps one breadcrumb", () => {
  const h = fresh("2.0.1");
  feed(h, "prompt.box", ["good", "miss", "miss", "miss", "miss", "miss"]);
  feed(h, "deliver.echo", ["good", "good", "good"]);
  assert.equal(signalVerdict(h.signals["prompt.box"], NOW).verdict, "broken");

  const same = noteCliVersion(h, "2.0.1", NOW);
  assert.equal(same.changed, false);
  assert.equal(h.signals["prompt.box"].misses, 5, "an unchanged version changes nothing");

  const moved = noteCliVersion(h, "2.1.0", NOW + MIN);
  assert.equal(moved.changed, true);
  assert.equal(moved.from, "2.0.1");
  assert.equal(h.versionChangedAt, NOW + MIN);

  // Both directions of keeping history are wrong, so both are cleared: the red
  // signal stops being red (the upgrade may have fixed it) and the green one
  // stops being green (the upgrade is the likeliest thing to have broken it).
  for (const id of ["prompt.box", "deliver.echo"]) {
    const sig = h.signals[id];
    assert.equal(sig.version, "2.1.0");
    assert.equal(sig.misses, 0);
    assert.equal(sig.lastGoodAt, null);
    assert.equal(sig.lastMissAt, null);
    assert.deepEqual(sig.window, []);
    assert.equal(signalVerdict(sig, NOW + MIN).verdict, "unknown");
    assert.equal(sig.priorVersion, "2.0.1");
  }
  assert.equal(h.signals["prompt.box"].priorVerdict, "broken");
  assert.equal(h.signals["deliver.echo"].priorVerdict, "healthy");

  // A first sighting on a fresh record is not a change worth announcing.
  const blank = emptyHealth();
  assert.equal(noteCliVersion(blank, "2.1.0", NOW).changed, false);
  assert.equal(blank.version, "2.1.0");
});

test("observing against a moved version re-arms even if nobody called noteCliVersion", () => {
  const h = fresh("2.0.1");
  feed(h, "prompt.box", ["good", "good", "good"]);
  h.version = "2.2.0";                       // the store noticed, the caller did not
  const sig = observe(h, "prompt.box", "miss", { at: NOW, raw: "1. Yes" });
  assert.equal(sig.version, "2.2.0");
  assert.equal(sig.priorVersion, "2.0.1");
  assert.equal(sig.totalGood, 0, "the old binary's successes are not evidence about this one");
  assert.equal(sig.misses, 1);
});

test("a sample is a shape, not a transcript — the mode is the signal's, not the caller's", () => {
  // `shape` signals carry prose (a prompt, a log record), so no characters of
  // the input survive. A caller that hands prose to one CANNOT leak it.
  const secretish = "please deploy with AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\nand tell nobody";
  const shaped = captureSample("deliver.echo", secretish);
  assert.equal(shaped, "2 lines, 95 chars, longest line 79");
  assert.ok(!shaped.includes("wJalr"));
  assert.ok(!shaped.includes("deploy"));
  assert.equal(shapeOf(""), "empty");

  // `line` signals carry TUI chrome, which is kept — "this line no longer
  // matches" is only actionable if the line is kept — but redacted first.
  const line = captureSample("prompt.box", "  ❯ 1. Yes   2. No  ");
  assert.equal(line, "❯ 1. Yes 2. No");
});

test("redaction removes the four things a screen can leak", () => {
  assert.equal(redactSample("token: abcdefghijklmnop"), "token=<redacted>");
  assert.equal(redactSample("Authorization: Bearer xyz"), "Authorization=<redacted>");
  assert.equal(redactSample("mail me at a.b+c@example.com"), "mail me at <email>");
  assert.equal(redactSample("open /Users/somebody/dev/myapp/x.ts"), "open ~/dev/myapp/x.ts");
  assert.equal(redactSample("open /home/somebody/dev/x.ts"), "open ~/dev/x.ts");
  assert.equal(redactSample("https://user:pw@host/x"), "https://<redacted>@host/x");
  // The catch-all: no legible line holds 24 characters of base64-ish text with
  // no separator, and every credential ever issued does.
  assert.equal(redactSample("saw AKIAIOSFODNN7EXAMPLEKEY123456 here"), "saw <redacted:29> here");
  assert.ok(!redactSample("a".repeat(40)).includes("aaaa"));
  // Ordinary prose survives, or the sample is useless.
  assert.equal(redactSample("Enter to confirm · Esc to cancel"), "Enter to confirm · Esc to cancel");
  // And it is capped.
  const long = redactSample("x y ".repeat(400));
  assert.equal(long.length, SAMPLE_CAP);
  assert.ok(long.endsWith("…"));
});

test("agoText is compact, so the sentence has exactly one form", () => {
  assert.equal(agoText(0), "<1m");
  assert.equal(agoText(59_000), "<1m");
  assert.equal(agoText(-5), "<1m");
  assert.equal(agoText(12 * MIN), "12m");
  assert.equal(agoText(3 * 3600_000), "3h");
  assert.equal(agoText(47 * 3600_000), "47h");
  assert.equal(agoText(4 * 24 * 3600_000), "4d");
});

test("the sentence says which signal, since when, how many misses, and what it last saw", () => {
  const h = fresh();
  observe(h, "prompt.box", "good", { at: NOW - 60 * MIN });
  for (let i = 4; i >= 0; i--) {
    observe(h, "prompt.box", "miss", { at: NOW - (i + 8) * MIN, raw: "❯ 1. Yes   2. No" });
  }
  assert.equal(
    healthSentence(h.signals["prompt.box"], NOW),
    "Reading a question box off the screen is broken — 5 misses in a row over the last 12m, " +
      "last confirmed 1h ago. Last input: “❯ 1. Yes 2. No”.",
  );
});

test("the rate sentence names the fraction, and a shape sample is not quoted as text", () => {
  const h = fresh();
  const seq = [];
  for (let i = 0; i < RATE_WINDOW; i++) seq.push(i % 4 === 1 ? "miss" : "good");
  seq.forEach((o, i) => {
    observe(h, "deliver.echo", o, {
      at: NOW - (RATE_WINDOW - 1 - i) * MIN,
      ...(o === "miss" ? { raw: "one\ntwo\nthree" } : {}),
    });
  });
  assert.equal(
    healthSentence(h.signals["deliver.echo"], NOW),
    "Confirming a prompt reached the composer is degraded — 5 of the last 20 failed (25%) " +
      "over the last 19m, last confirmed <1m ago. Last input: 3 lines, 13 chars, longest line 5.",
  );
});

test("the sentence answers for every verdict, so no caller has a reason to write its own", () => {
  const h = fresh();
  observe(h, "context.meter", "good", { at: NOW - 5 * MIN });
  assert.equal(
    healthSentence(h.signals["context.meter"], NOW),
    "Reading the context-window figure is working — last confirmed 5m ago.",
  );

  assert.equal(
    healthSentence(blankSignal("hook.pipe", "2.0.1"), NOW),
    "The CLI's lifecycle hooks has not been checked yet.",
  );

  const upgraded = fresh("2.0.1");
  observe(upgraded, "hook.pipe", "good", { at: NOW - MIN });
  noteCliVersion(upgraded, "2.1.0", NOW);
  assert.equal(
    healthSentence(upgraded.signals["hook.pipe"], NOW),
    "The CLI's lifecycle hooks has not been checked since claude 2.1.0 — " +
      "its history was cleared when the CLI changed from 2.0.1.",
  );

  const quiet = fresh();
  observe(quiet, "prompt.box", "good", { at: NOW });
  assert.equal(
    healthSentence(quiet.signals["prompt.box"], NOW + 3 * 24 * 3600_000),
    "Reading a question box off the screen has gone quiet — nothing observed for 3d, so its state is unknown.",
  );

  // Never confirmed at all is said in those words, rather than as a missing clause.
  const never = fresh();
  feed(never, "slash.local", ["miss", "miss"], { raw: "/cost" });
  assert.ok(healthSentence(never.signals["slash.local"], NOW).includes("never confirmed at all"));
});

test("the rollup takes the worst, lists the unknowns, and never alarms on them", () => {
  const h = fresh();
  feed(h, "prompt.box", ["good", "miss", "miss"]);                 // degraded
  feed(h, "deliver.echo", ["good", "good"]);                       // healthy
  h.signals["limit.reset"] = blankSignal("limit.reset", "2.0.1");  // unknown

  const r = healthRollup(h, NOW);
  assert.equal(r.verdict, "degraded");
  assert.deepEqual(r.degraded, ["prompt.box"]);
  assert.deepEqual(r.broken, []);
  assert.deepEqual(r.unknown, ["limit.reset"]);
  assert.equal(r.version, "2.0.1");
  // One line per UNHEALTHY signal — an unexercised probe is listed, not shouted.
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0].startsWith("Reading a question box off the screen is degraded"));

  // Worst wins, and worst-first is the order the sheet renders.
  feed(h, "hook.pipe", ["good", "miss", "miss", "miss", "miss", "miss"]);
  const r2 = healthRollup(h, NOW);
  assert.equal(r2.verdict, "broken");
  assert.deepEqual(
    unhealthySignals(h, NOW).map((s) => s.id),
    ["hook.pipe", "prompt.box", "limit.reset"],
  );

  // A board with nothing on it at all is unknown, not healthy.
  assert.equal(healthRollup(emptyHealth(), NOW).verdict, "unknown");
  const onlyUnknown = fresh();
  onlyUnknown.signals["prompt.box"] = blankSignal("prompt.box", "2.0.1");
  assert.equal(healthRollup(onlyUnknown, NOW).verdict, "unknown");
});

test("cleanHealth clamps rather than believes what came off disk", () => {
  assert.deepEqual(cleanHealth(null), emptyHealth());
  assert.deepEqual(cleanHealth("nonsense"), emptyHealth());

  const dirty = {
    version: "2.0.1",
    versionSeenAt: NOW,
    signals: {
      "prompt.box": {
        id: "prompt.box",
        version: "2.0.1",
        misses: 9_999_999,                    // a hand-edited permanent red
        lastMissAt: NOW,
        window: Array.from({ length: 200 }, () => ({ at: NOW, ok: false })),
        totalGood: -4,
        sample: "token: abcdefghijklmnop",    // never went through observe()
        priorVerdict: "nonsense",
      },
      "gone.away": { id: "gone.away", misses: 3 },   // a signal this build has never heard of
    },
  };
  const c = cleanHealth(dirty);
  assert.equal(c.version, "2.0.1");
  assert.equal(c.signals["prompt.box"].misses, 9_999);
  assert.equal(c.signals["prompt.box"].window.length, RATE_WINDOW);
  assert.equal(c.signals["prompt.box"].totalGood, 0);
  assert.equal(c.signals["prompt.box"].sample, "token=<redacted>");
  assert.equal(c.signals["prompt.box"].priorVerdict, undefined);
  assert.equal(c.signals["gone.away"], undefined);
  // A cleaned record is still gradeable, which is the point of cleaning it.
  assert.equal(signalVerdict(c.signals["prompt.box"], NOW).verdict, "broken");
});

test("clearSeen drops only the misses the reader saw, and a later miss still counts", () => {
  const h = emptyHealth();
  h.version = "2.1.0";
  const id = "deliver.submit";
  let t = 1_000_000;
  // A degraded rate: misses mixed with goods, a fallback and a sample.
  for (let i = 0; i < 12; i++) observe(h, id, i % 3 === 0 ? "fallback" : "good", { at: t += 1000, via: "press-and-look", raw: "x" });
  observe(h, id, "good", { at: t += 1000 });
  const seen = h.signals[id].lastMissAt;
  assert.equal(signalVerdict(h.signals[id], t).verdict, "degraded");

  const cleared = clearSeen(h.signals[id], seen);
  assert.equal(cleared.misses, 0);
  assert.ok(cleared.window.every((o) => o.at > seen), "nothing at or before the read miss survives");
  assert.equal(cleared.via, undefined);
  assert.equal(cleared.sample, undefined);
  assert.equal(cleared.totalMiss, h.signals[id].totalMiss, "all-time totals are not a warning");
  // A good after the cleared miss is real evidence: working.
  assert.equal(signalVerdict(cleared, t).verdict, "healthy");

  // Cleared through the newest good too ⇒ nothing seen working since: unknown, said as cleared.
  const all = clearSeen(h.signals[id], t);
  assert.equal(signalVerdict(all, t).verdict, "unknown");
  assert.match(healthSentence(all, t + 60_000), /cleared its misses/);

  // A miss landing after the board was drawn is not cleared by a late tap.
  h.signals[id] = clearSeen(h.signals[id], seen);
  observe(h, id, "miss", { at: t += 1000 });
  const late = clearSeen(h.signals[id], seen);
  assert.equal(late.misses, 1);
  assert.equal(late.lastMissAt, t);
});

test("claudeNewerThanTested: warns only when NEWER than tested, absent when unparsable", async () => {
  const { claudeNewerThanTested, TESTED_CLAUDE_VERSION } = await import("../dist/index.js");
  assert.equal(claudeNewerThanTested(`${TESTED_CLAUDE_VERSION} (Claude Code)`), null);
  assert.equal(claudeNewerThanTested("0.0.1 (Claude Code)"), null, "older is never a warning");
  assert.match(claudeNewerThanTested("99.0.0 (Claude Code)"), /heuristics may miss; clihealth will show it/);
  assert.notEqual(claudeNewerThanTested("2.1.290", "2.1.289"), null);
  assert.equal(claudeNewerThanTested("garbage"), null);
  assert.equal(claudeNewerThanTested(undefined), null);
});
