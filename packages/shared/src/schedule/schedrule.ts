// Cut from schedule.ts (move only): the rule record, anchors and window conditions
// The one door stays `./schedule.js`; this slice imports its siblings directly, never the barrel.

/** How late a missed occurrence may still run, by default (minutes). Two hours:
 *  long enough to survive a lunch-time sleep, short enough that a laptop opened
 *  on Saturday doesn't fire Thursday's sweep. */
export const DEFAULT_GRACE_MIN = 120;

/** Weekday labels, index = `Date.getDay()`. */
export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * When a schedule fires.
 *
 * Two independent questions live in this type. `kind` is the ANCHOR — an
 * absolute instant, a weekly wall clock, or a usage reset — and decides which
 * of the fields below are read at all. `oneShot` is the RECURRENCE — does this
 * rule keep standing after it fires, or was it "just this once" — and it is
 * orthogonal to the anchor: "tonight 23:00" and "every Thursday 18:00" are the
 * same clock anchor with two different answers to how often, and a weekly wall
 * clock or a usage reset is entitled to the same pair. `kind: "once"` already
 * IS the clock anchor's one-shot (an absolute instant has no "every" to ask
 * for), which is why `oneShot` is never set there — one way to say each thing.
 * Use `ruleRecurs`/`ruleAnchor` to read the two questions apart; nothing else
 * in this file keys on `kind` alone to mean "does this repeat".
 *
 * `once` carries an absolute instant (the phone resolves "tonight 23:00" with
 * the device's own clock — there is no recurrence to drift). `weekly` carries a
 * wall clock plus its zone, re-resolved per occurrence; `days` empty means every
 * day, which is how "daily" is expressed without a third variant.
 */
export interface ScheduleRule {
  kind: "once" | "weekly" | "window";
  /** `once`: the anchor instant, epoch ms. */
  at?: number;
  /** `weekly`: anchor days, 0 = Sunday .. 6 = Saturday. Empty ⇒ every day. */
  days?: number[];
  /** `weekly`: anchor wall clock in `tz`. */
  hour?: number;
  minute?: number;
  /** IANA zone the anchor is expressed in, e.g. "Europe/Berlin". */
  tz?: string;
  /** Shift from the anchor, minutes. NEGATIVE = before it ("2h before the reset"). */
  offsetMin?: number;
  /**
   * `weekly` and `window` only: fire the next occurrence and stop, rather than
   * every one — "next Thursday 18:00, then done" or "next time my session
   * window resets, then done". Absent means it recurs, which is what every rule
   * written before this field existed meant and still means: a reader that does
   * not know this field drops it and gets exactly the old behaviour. Never set
   * on `once` — that kind already names a single instant with nothing to repeat.
   */
  oneShot?: boolean;

  /**
   * The hours of the day this rule may actually RUN — quiet hours, stated as
   * the window they leave open, in minutes of day in `tz`. Absent ⇒ any hour,
   * which is what every rule written before this field existed meant and still
   * means: a reader that does not know it drops it and gets the old behaviour.
   *
   * It is NOT a second anchor and it never moves the occurrence. `nextFireAt`
   * places the fire exactly where it always did; this decides whether the
   * instant it landed on is one the machine may speak at. The two are kept
   * apart for the same reason the anchor and the lead time are: "every day at
   * 03:00" and "the moment the weekly window comes back" are facts about when
   * the work becomes worth doing, and "not while I am asleep" is a policy over
   * all of them. Folded into the anchor, the policy would have to be re-derived
   * into every rule that carries it, and the row could no longer say what it is
   * tracking — which is the complaint `describeRule` has made since before
   * there was a reset to anchor to.
   *
   * It WRAPS midnight (`{from: 1320, to: 420}` is 22:00–07:00), because the
   * window people actually name is the night one; a pair that could not cross
   * midnight would have to be written as two rules that then drift apart.
   * `from === to` is DROPPED by `cleanRule` rather than read as "always" or as
   * "never" — a window with no width is a rule that can never fire, and a
   * schedule that quietly stops mattering is the one failure this file is
   * built against.
   *
   * The GRACE is measured from the moment the window OPENS, not from the
   * anchor (`intentVerdict`'s `at` arm, and `hoursOpenFrom` below). A rule
   * anchored at 03:00 with a 07:00–22:00 window would otherwise spend its whole
   * grace asleep and report itself missed at the first instant it was allowed
   * to run — a schedule that can only ever fail, which is worse than one that
   * never fires, because it fails loudly at the user every day.
   */
  hours?: { from: number; to: number };

  // ── `window`: anchored to a USAGE RESET rather than to a wall clock ───────
  //
  // The two anchors this app's users actually plan around are not times of day:
  // they are "before my session window resets, while there is still allowance
  // to spend" and "the moment the weekly window comes back". A wall clock
  // cannot express either — the session window slides with whenever you last
  // started using it, and `describeRule` already warned that a resolved clock
  // "hides the fact that the schedule is tracking an 18:00 reset, which is the
  // thing that has to be edited when the reset moves."
  //
  // `offsetMin` carries the lead time unchanged (negative = before), which is
  // what its own doc line has said since before there was anything to anchor to.

  /** Which reset this rule tracks. */
  window?: "session" | "weekly";
  /**
   * `window` only: the budget PERIOD this rule tracks, when it is not one of the
   * two scraped windows - a calendar `month`/`week`/`day` or a span (`PeriodId`).
   * Absent means `window` says it (and `session`/`weekly` stay valid ids). A
   * rolling period has no reset edge and `windowRuleRefusal` (period.ts) refuses
   * it with a sentence. When set, `window` is `session` (the default) and means
   * nothing; read the anchor through `anchorPeriodId`.
   */
  periodId?: string;
  /**
   * Which side of it.
   *
   * `before` fires `offsetMin` ahead of the reset — the "spend what is left"
   * case, and the only one a condition makes sense for.
   * `after` fires at the reset itself (plus `offsetMin` if given) — the "start
   * the moment the allowance is back" case, which is unconditional by nature:
   * a window that has just reset is by definition empty.
   */
  edge?: "before" | "after";
  /**
   * `before` only: run only if at least this much of the allowance is still
   * UNUSED, 0..100. Absent ⇒ no condition.
   *
   * Expressed as what is LEFT rather than what is used, because that is the
   * question being asked — "is there enough headroom to be worth spending?" —
   * and because the percentage on the screen it is compared against is a USED
   * figure, so naming this one the same way would make every reading of the
   * pair an inversion somebody has to do in their head.
   */
  minPctLeft?: number;
  /**
   * Test `minPctLeft` against the OTHER usage window.
   *
   * The instruction this exists for cannot be written otherwise: *"right after
   * the session window resets, but only if 30% of the week is left"*. The
   * ANCHOR has to be the session reset — that is the instant the work becomes
   * possible — and the CONDITION has to be about the week, because the week is
   * the allowance a thirteen-repo sweep actually eats. One `window` field
   * answered both questions, so naming one of them meant giving up the other,
   * and the shape people kept asking for was exactly the one it could not hold.
   *
   * Absent ⇒ the condition tests the window the rule is anchored to, which is
   * what every rule written before this field meant. Naming the SAME window is
   * not a guard at all and `cleanRule` drops it — one way to say each thing.
   *
   * It is also the one thing that lifts the `after`-edge rule above. A window
   * that has just reset is empty by definition, so a condition on THAT window
   * could only ever mean "never run"; a condition on the other one is a real
   * question with a real answer, and refusing it was refusing the only shape
   * anybody wanted an `after` edge with a condition for.
   */
  guardWindow?: "session" | "weekly";
}

/** The anchor a rule is measured against — the question `kind` answers once
 *  `oneShot` has been read apart from it. */
export type RuleAnchor = "clock" | "window";

/** Which anchor. `once` and `weekly` are both clock-anchored; only `window`
 *  tracks a usage reset instead of a time of day. */
export function ruleAnchor(rule: ScheduleRule): RuleAnchor {
  return rule.kind === "window" ? "window" : "clock";
}

/**
 * **Does this rule keep standing after it fires?** The one answer for
 * "is this a schedule, or a thing that happens once" — the host's arm/settle
 * logic, the schedule sheet's pause-vs-on/off split, and the verdict ladder's
 * one-off branch all ask here rather than hand-rolling `kind !== "once"`,
 * which stopped being a complete answer the day `oneShot` could apply to a
 * `weekly` or `window` rule too.
 */
export function ruleRecurs(rule: ScheduleRule): boolean {
  if (rule.kind === "once") return false;
  return rule.oneShot !== true;
}

/**
 * (anchor, recurrence) → a rule, carrying over whatever still means the same
 * thing across the switch. The one encoder: a UI control renders the two
 * questions as two toggles and never hand-rolls which `kind`/`oneShot` pair a
 * choice maps to.
 *
 * `offsetMin` crosses anchors because it is a LEAD TIME in both: negative on a
 * `weekly` rule and negative on a `before`-edge `window` rule mean the same
 * thing ("fire this long ahead of the anchor"). A positive `window` `before`
 * offset does not exist (`cleanRule` clamps it), so nothing is lost crossing
 * the other way.
 *
 * `hours` crosses for a stronger reason: it is not about the anchor at all. "I
 * am asleep between 22:00 and 07:00" stays true whichever instant the rule is
 * hung off, and dropping it at the switch would silently re-open a door the
 * user shut. `guardWindow` does NOT cross — it names one of two usage windows
 * and means nothing on a wall clock — so it rides on `src` like `minPctLeft`,
 * the field it exists to redirect.
 */
export function composeRule(
  anchor: RuleAnchor, recurs: boolean, prev: ScheduleRule, now: number, tz?: string,
): ScheduleRule {
  // The window AND the zone it is expressed in, together on every kind: `hours`
  // is minutes of day in `tz`, so a switch that carried the numbers and dropped
  // the zone would re-read a 07:00–22:00 window against whatever clock the
  // daemon happens to run on. `cleanRule` says the rest of why. The device's
  // own zone is the fallback the sheet already passes in.
  const zone = prev.tz || tz;
  const only = prev.hours ? (zone ? { hours: prev.hours, tz: zone } : { hours: prev.hours }) : {};
  if (anchor === "clock" && !recurs) {
    return { kind: "once", at: prev.kind === "once" ? prev.at ?? now + 3600e3 : now + 3600e3, offsetMin: 0, ...only };
  }
  if (anchor === "clock") {
    const src = prev.kind === "weekly" ? prev : undefined;
    return {
      kind: "weekly",
      days: src?.days ?? [],
      hour: src?.hour ?? 18,
      minute: src?.minute ?? 0,
      tz: src?.tz || tz,
      offsetMin: prev.offsetMin ?? 0,
      ...(recurs ? {} : { oneShot: true }),
      ...only,
    };
  }
  const src = prev.kind === "window" ? prev : undefined;
  return {
    kind: "window",
    window: src?.window ?? "session",
    ...(src?.periodId ? { periodId: src.periodId } : {}),
    edge: src?.edge ?? "before",
    offsetMin: src?.offsetMin ?? Math.min(0, prev.offsetMin ?? -60),
    ...(src?.minPctLeft != null ? { minPctLeft: src.minPctLeft } : {}),
    ...(src?.guardWindow ? { guardWindow: src.guardWindow } : {}),
    ...(recurs ? {} : { oneShot: true }),
    ...only,
  };
}

/** The reset instants a `window` rule is measured against. Passed in rather than
 *  read, because this module has no clock and no host — see `nextFireAt`. */
export interface WindowResets {
  sessionResetAt?: number | null;
  weeklyResetAt?: number | null;
  /** 0..100 USED, as the CLI reports it. */
  sessionPct?: number | null;
  weeklyPct?: number | null;
  /** Reset instants of the configured periods by id (`periodBounds(...).resetAt`,
   *  computed by the caller). Read when a rule carries a `periodId`. */
  periodResetAt?: Record<string, number | null | undefined>;
}

/** The reset this rule tracks, or `null` when the host has not read one yet. */
export function windowResetAt(rule: ScheduleRule, r: WindowResets | undefined): number | null {
  if (!r) return null;
  if (rule.periodId) {
    const p = r.periodResetAt?.[rule.periodId];
    return typeof p === "number" && p > 0 ? p : null;
  }
  const at = rule.window === "weekly" ? r.weeklyResetAt : r.sessionResetAt;
  return typeof at === "number" && at > 0 ? at : null;
}

/** The USED percentage for this rule's window, or `null` when unread. */
export function windowPct(rule: ScheduleRule, r: WindowResets | undefined): number | null {
  if (!r) return null;
  const p = rule.window === "weekly" ? r.weeklyPct : r.sessionPct;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

/** The period id this rule's anchor tracks: its `periodId`, else its window. */
export const anchorPeriodId = (rule: ScheduleRule): string => rule.periodId ?? (rule.window === "weekly" ? "weekly" : "session");

/** The window this rule's ANCHOR tracks, with the same default `windowPct`
 *  reads (`undefined` is the session window). */
export const anchorWindow = (rule: ScheduleRule): "session" | "weekly" => (rule.window === "weekly" ? "weekly" : "session");

/** The window `minPctLeft` is tested against — the guard when one is named,
 *  the anchor's own otherwise. One reading, so the condition, its sentence and
 *  `describeRule` cannot disagree about which meter was read. */
const guardOf = (rule: ScheduleRule): "session" | "weekly" => rule.guardWindow ?? anchorWindow(rule);

/**
 * **May this occurrence run?** — asked at FIRE time, never at arm time.
 *
 * The distinction is the whole feature. Arming happens once, hours ahead; the
 * usage figure it would have been tested against is stale by the time the
 * instant arrives, and the condition is precisely about what is true THEN. So
 * `nextFireAt` places the occurrence and this decides, on the day, whether it
 * is spent or skipped.
 *
 * **A reading it cannot get is a SKIP, not a run.** The opposite default is
 * tempting — `budgetVerdict` fails OPEN for exactly this shape of input, and
 * says why: it is scraped off a TUI and a parse broken upstream must not freeze
 * every queue on every host. That argument does not transfer. The budget is a
 * safety rail whose failure mode is "stop working"; this is a condition the
 * user wrote to make work happen only when it is worth it, and firing a sweep
 * across thirteen repos because nobody could read a percentage is the outcome
 * they were trying to avoid. Failing closed here also cannot go silent: a skip
 * is notified, so an unreadable meter surfaces as a sentence rather than as a
 * schedule that quietly stopped mattering.
 */
export function windowCondition(rule: ScheduleRule, r: WindowResets | undefined): { ok: boolean; detail: string } {
  if (rule.kind !== "window") return { ok: true, detail: "" };
  const guard = guardOf(rule);
  // A window that has just reset is empty by definition — there is nothing to
  // test, and a condition on `after` would only ever be a way to never run.
  // That argument is about the window this rule is ANCHORED to and about no
  // other: `guardWindow` naming the other one asks a question that has an
  // answer at exactly this instant ("the session window is back — is there
  // still a week's allowance to spend it out of?"), which is the whole reason
  // the field exists. So the exemption is scoped to the same window, and lifts
  // the moment the condition is about the other one.
  if (rule.edge === "after" && guard === anchorWindow(rule)) return { ok: true, detail: "" };
  const min = rule.minPctLeft;
  if (min == null) return { ok: true, detail: "" };
  // Read the GUARD's meter, never the anchor's — the rule may be tracking one
  // window's reset while asking about the other one's remainder.
  const used = windowPct({ ...rule, window: guard }, r);
  const name = guard === "weekly" ? "weekly" : "session";
  if (used == null) {
    return { ok: false, detail: `skipped — the ${name} usage could not be read, so the condition could not be checked` };
  }
  const left = Math.max(0, 100 - used);
  if (left >= min) return { ok: true, detail: `${Math.round(left)}% of the ${name} window was left` };
  return {
    ok: false,
    detail: `skipped — conditions not met: ${Math.round(left)}% of the ${name} window was left, and this rule needs at least ${min}%`,
  };
}
