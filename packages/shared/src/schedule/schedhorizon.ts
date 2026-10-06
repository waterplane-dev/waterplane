// Cut from schedule.ts (move only): how much is coming, and how soon
// The one door stays `./schedule.js`; this slice imports its siblings directly, never the barrel.

import type { ScheduleRule } from "./schedrule.js";
import { isStandingSchedule } from "./schedfire.js";

// ── How much is coming, and how soon ────────────────────────────────────────

/**
 * **What is armed, bucketed by how far out it is.**
 *
 * A count on its own does not answer the question people actually ask of a
 * schedule list. "7 scheduled" is the same badge whether all seven fire tonight
 * or the next one is a fortnight away, and those are opposite situations: one
 * is something to look at before bed, the other is furniture.
 *
 * The buckets are DISJOINT and the wording says so (`more`), because the
 * alternative — cumulative counts — reads as a total that keeps growing and
 * makes "2 in 24h and 5 in 2d" mean 5 to one person and 7 to the next.
 *
 * `unarmed` is kept apart from every horizon rather than folded into "later":
 * a rule with nothing armed is not far away, it is not coming at all, and the
 * two reasons for it (switched off, or a `window` rule still waiting for its
 * first usage reading) are both things a person can act on.
 *
 * **A spent one-off is not one of those reasons and is not counted here at
 * all** (`isStandingSchedule`). It cannot be armed, so filing it under "not
 * armed" described a state nobody could leave — and being counted into `total`
 * it made the badge say "10 armed rules" about a desktop holding none.
 */
export interface ScheduleHorizon {
  /** Inside the hour — the only bucket worth interrupting anybody for. */
  soon: number;
  /** 1h … 24h. */
  day: number;
  /** 24h … 48h. */
  twoDay: number;
  /** 48h … 7d. */
  week: number;
  /** Beyond a week. */
  later: number;
  /** Armed at nothing: switched off, or waiting for a reading. */
  unarmed: number;
  /** Everything above, including `unarmed`. */
  total: number;
}

const H = 3_600_000;

/** Which bucket an instant falls in. `unarmed` is the absence of one. */
export type HorizonBucket = keyof Omit<ScheduleHorizon, "total">;

/**
 * The bucket names, as the chip says them — the ONE spelling.
 *
 * A count on screen is a promise that a list somewhere holds exactly those
 * rows, so the words on the chip and the words on the filtered list's own bar
 * come from here, and the boundaries that produced the count are
 * `horizonBucket` and nothing else. Two copies of `<= 24h` is how "2 within
 * the hour" opens a list of three.
 */
export const HORIZON_LABEL: Record<HorizonBucket, string> = {
  soon: "within the hour",
  day: "in 24h",
  twoDay: "in 2d",
  week: "this week",
  later: "later",
  unarmed: "not armed",
};

/** The bucket one armed instant falls in. The only place the edges live. */
export function horizonBucket(at: number | null | undefined, now: number): HorizonBucket {
  if (at == null) return "unarmed";
  const inMs = at - now;
  // An instant already behind us is due NOW, not "later" — a missed
  // occurrence inside its grace is the most urgent thing in this list, and
  // bucketing it by raw distance would file it under "beyond a week" on the
  // wrong side of zero.
  if (inMs <= H) return "soon";
  if (inMs <= 24 * H) return "day";
  if (inMs <= 48 * H) return "twoDay";
  if (inMs <= 7 * 24 * H) return "week";
  return "later";
}

/**
 * Bucket a set of armed instants. Rows are anything carrying a `nextAt`, and a
 * row that also carries its `rule` is put through `isStandingSchedule` first:
 * a one-off that has been and gone is history, and this counts what is coming.
 */
export function scheduleHorizon(rows: readonly { nextAt?: number | null; rule?: ScheduleRule }[], now: number): ScheduleHorizon {
  const h: ScheduleHorizon = { soon: 0, day: 0, twoDay: 0, week: 0, later: 0, unarmed: 0, total: 0 };
  for (const r of rows) {
    if (!isStandingSchedule(r, now)) continue;
    h.total++;
    h[horizonBucket(r.nextAt, now)]++;
  }
  return h;
}

/** Buckets in the order the chip reads them: nearest first, `unarmed` last. */
const HORIZON_ORDER: HorizonBucket[] = ["soon", "day", "twoDay", "week", "later", "unarmed"];

/**
 * The bucket the chip's LEADING number counts — what tapping it filters to.
 *
 * `null` when the chip says nothing, so a tap that would open an empty list
 * cannot happen.
 */
export function horizonLead(h: ScheduleHorizon): HorizonBucket | null {
  return HORIZON_ORDER.find((k) => h[k] > 0) ?? null;
}

/**
 * The horizon as one line. `null` when there is nothing armed at all — a badge
 * that says "0 scheduled" is a badge that trains people not to read badges.
 *
 * At most the two nearest non-empty buckets, because this is read at a glance
 * on a phone and the third number is never the one that changes a decision.
 * The full breakdown belongs in the sheet the chip opens.
 */
export function horizonWords(h: ScheduleHorizon): string | null {
  const parts = HORIZON_ORDER
    .filter((k) => k !== "unarmed")
    .map((k) => ({ n: h[k], label: HORIZON_LABEL[k] }))
    .filter((p) => p.n > 0);
  if (!parts.length) {
    // Armed at nothing is still worth a word — it is the state somebody has to
    // do something about, and silence here reads as "nothing is scheduled"
    // when the truth is "everything scheduled is stuck".
    return h.unarmed > 0 ? `${h.unarmed} ${HORIZON_LABEL.unarmed}` : null;
  }
  const [a, b] = parts;
  // `more` is what makes the buckets legibly disjoint in the one place the
  // reader cannot see their definitions.
  return b ? `${a.n} ${a.label} · ${b.n} more ${b.label}` : `${a.n} ${a.label}`;
}

// ── When a piece of work will fire, in words ─────────────────────────
//
// Moved here from the web's `sendIntent.ts`, unchanged, because a second
// reader needs the same sentence: the host's agent route (`agentintents.ts`)
// answers an agent that posted a prompt for later with "when will this fire",
// and a second phrasing of that is two opinions about one row. The send sheet
// re-exports all four, so no web call site moved.
