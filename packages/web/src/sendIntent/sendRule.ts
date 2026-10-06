/** The two rare clauses on a rule. Split from `sendIntent.ts` (docs/notes/send-architecture.md); pure, no React. */
import { describeHours, type ScheduleRule } from "@waterplane/shared";

// ── The two rare clauses on a rule ───────────────────────────────────

/** The two usage meters, spelled once. The same nouns `describeRule` puts on
 *  the schedule card, so the control's sentence and the row's cannot drift. */
export const WINDOW_LABEL: Record<"session" | "weekly", string> = {
  session: "the session window",
  weekly: "the weekly window",
};

/**
 * The same two meters on the GUARD's own control, labelled by what that control
 * does rather than by the noun.
 *
 * Ten lines above it, the anchor segmented already says `session window` /
 * `weekly window`. Wearing the same two nouns twice on one screen asks the
 * reader the same question twice, with the difference carried only in a
 * section-hint — and the two questions ("when does this become possible" and
 * "is it worth doing") are about different windows as often as the same one,
 * which is the whole reason `guardWindow` exists.
 */
export const GUARD_LABEL: Record<"session" | "weekly", string> = {
  session: "checks the session meter",
  weekly: "checks the weekly meter",
};

/** The meter this rule's ANCHOR tracks, and the one its condition READS — the
 *  same two defaults `shared/schedule.ts` resolves with (`anchorWindow` /
 *  `guardOf`), so nothing here can claim a different meter than the host read. */
export const anchorWindowOf = (rule: ScheduleRule): "session" | "weekly" =>
  rule.window === "weekly" ? "weekly" : "session";
export const guardWindowOf = (rule: ScheduleRule): "session" | "weekly" =>
  rule.guardWindow ?? anchorWindowOf(rule);

/**
 * **What the headroom condition will actually do**, in the terms of the two
 * windows it sits between.
 *
 * Three sentences rather than one with clauses, because the three cases are
 * three different facts: the condition reads the window the rule is anchored
 * to; the condition reads the OTHER one; or the condition is written in the one
 * shape that cannot be evaluated at all and is dropped.
 *
 * That third case is a SENTENCE and not a dimmed control, and not a refusal
 * either: the rule is perfectly savable as written — `cleanRule` simply drops
 * the clause, exactly as it always has — so what the screen owes the reader is
 * what will happen and what to do instead, on the row where the decision is
 * being made.
 */
export function guardWords(rule: ScheduleRule): string {
  const anchor = anchorWindowOf(rule);
  const guard = guardWindowOf(rule);
  const other = anchor === "weekly" ? "session" : "weekly";
  const pct = rule.minPctLeft;
  if (rule.edge === "after" && guard === anchor) {
    return `A window that has just reset is empty by definition, so there is nothing to ask about ${WINDOW_LABEL[anchor]} at the instant this fires — written like this the condition is dropped and the rule runs every time. Point it at ${WINDOW_LABEL[other]}, or set it back to no condition.`;
  }
  // A ONE-SHOT is kept until a reset meets the condition (the host re-arms it;
  // only a run spends it), so its sentence has a second half a recurring
  // rule's does not need — that one simply waits for its next occurrence.
  const kept = rule.oneShot === true ? " It stays armed for the next reset, and the next, until one meets the condition — then it runs once." : "";
  if (guard === anchor) {
    return `If less than ${pct}% of ${WINDOW_LABEL[anchor]} is left when it fires, nothing runs and you get a notification saying it was skipped.${kept} A meter the host cannot read counts as not met — the condition exists to stop work, so an unreadable one stops it too.`;
  }
  return `It waits for ${WINDOW_LABEL[anchor]} to reset, then asks about ${WINDOW_LABEL[guard]}: unless at least ${pct}% of that one is left, nothing runs and you get a notification saying it was skipped.${kept}`;
}

/**
 * **What the run window will actually do**, including the two ways of writing
 * one that do not mean what they look like.
 *
 * A window that WRAPS midnight is the one people name most (22:00–07:00), so it
 * is said out loud rather than left to be inferred from two numbers in the
 * wrong order. A window with no width has two readings — "every minute" and "no
 * minute" — so `cleanRule` drops it rather than picking one, and this is the
 * sentence that stops that being silent: a schedule that quietly stops
 * mattering is the one failure the whole module is built against.
 *
 * Every case names the OPENING, because that is what the grace is counted from
 * (`hoursOpenFrom`) and it is the single most surprising thing about the
 * feature — a 03:00 rule behind a 07:00 window is not four hours late.
 */
export function hoursWords(rule: ScheduleRule): string {
  const h = rule.hours;
  if (!h) {
    return "Any hour. Set a window and the rule still becomes due when the anchor above says — it waits for the window to open, and how late it counts as is measured from that opening, not from the anchor.";
  }
  if (h.from === h.to) {
    return "Both ends name the same minute, which is a window with no width. It is dropped rather than guessed at, so the rule would run at any hour — move one of them.";
  }
  const opens = `${String(Math.floor(h.from / 60)).padStart(2, "0")}:${String(h.from % 60).padStart(2, "0")}`;
  const zone = rule.tz ? `, ${rule.tz}` : "";
  const overnight = h.from > h.to ? " — overnight, through midnight" : "";
  return `Only ${describeHours(rule)}${overnight}${zone}. Due outside it, the run waits for ${opens} and its lateness is counted from there.`;
}

/** The `.claude/inbox/…` paths a prompt names — what the host must not run
 *  without, and the reason a send can be "waiting for a file" with nobody
 *  having chosen that. Matched on the SHAPE of the path: only the host can tell
 *  a file this device is uploading from one another device already landed. */
export function inboxRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\.claude\/inbox\/[A-Za-z0-9._-]+/g)) out.add(m[0]);
  return [...out];
}

