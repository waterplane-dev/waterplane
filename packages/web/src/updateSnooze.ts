/**
 * **"Not now" that survives a reload.**
 *
 * `UpdateBanner.tsx`'s × is deliberately in-memory: waving the bar away is an
 * answer about this screen, and a reload is exactly when being told again is
 * useful, since a reload is what applies the staged build. But a reload is not
 * always a decision — the watchdog reloads on a bad wake, a cold start reloads,
 * a navigation in the APK reloads — so a phone mid-task can be asked the same
 * question a dozen times in an afternoon, and the answer it is being asked to
 * give costs whatever is half-written in a box.
 *
 * Snooze is that answer, made durable and given an end: hide it for a chosen
 * span, and be asked again after. Not forever, for the same reason the
 * insecure-origin banner is snoozed a week rather than dismissed — a build that
 * is verified and staged and never taken is the old build still running.
 *
 * Keyed on the BUILD, like the dismissal: silencing this one must not silence
 * the next. Nothing here touches the automatic path — `watchAutoApply()` still
 * restarts once the phone is put down, snoozed or not. This hides a bar; it
 * never postpones an update.
 */

/**
 * The durations on offer.
 *
 * A single fixed window was the first version and it was wrong in both
 * directions: four hours is far too long for "give me two minutes to finish
 * this message", and too short for "not today". The short end is the one that
 * was actually missing — the reason this bar gets waved away is almost always a
 * sentence half-typed, and that is over in minutes.
 *
 * Four of them, because a phone row fits four chips and a list long enough to
 * read is a list nobody reads. Shortest first: it is the common answer, and it
 * lands under the thumb that just tapped the clock.
 */
export const SNOOZE_CHOICES: { ms: number; label: string }[] = [
  { ms: 5 * 60 * 1000, label: "5m" },
  { ms: 60 * 60 * 1000, label: "1h" },
  { ms: 4 * 60 * 60 * 1000, label: "4h" },
  { ms: 24 * 60 * 60 * 1000, label: "1d" },
];

/** The longest snooze anyone can ask for — the guard below, not a default. */
export const MAX_SNOOZE_MS = SNOOZE_CHOICES.reduce((m, c) => Math.max(m, c.ms), 0);

export type UpdateSnooze = { id: string; until: number };

/** Tolerant on purpose: a key written by an older build, half-written by a
 *  quota throw, or hand-edited must read as "not snoozed", never throw. */
export function parseSnooze(raw: string | null): UpdateSnooze | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const { id, until } = v as { id?: unknown; until?: unknown };
    if (typeof id !== "string" || !id) return null;
    if (typeof until !== "number" || !Number.isFinite(until)) return null;
    return { id, until };
  } catch { return null; }
}

export function snoozeFor(id: string, now: number, ms: number): UpdateSnooze {
  return { id, until: now + ms };
}

/**
 * Is THIS staged build silenced right now?
 *
 * False for a different build (a newer bundle is a new question), and false
 * once the window has passed — including when the clock has moved BACKWARDS
 * past the snooze by more than the LONGEST window on offer, which is what a
 * phone that changed timezone or corrected its clock looks like. An `until`
 * further out than anything this picker can produce is not a snooze anyone
 * asked for.
 */
export function snoozeActive(s: UpdateSnooze | null, stagedId: string | null, now: number): boolean {
  if (!s || !stagedId || s.id !== stagedId) return false;
  return now < s.until && s.until - now <= MAX_SNOOZE_MS;
}

/** What the button says it did. Minutes below the hour, hours below the day —
 *  "0.08h" is a number nobody reads as five minutes. */
export function snoozeSentence(ms: number): string {
  const label =
    ms < 60 * 60 * 1000 ? `${Math.round(ms / 60_000)} min`
    : ms < 24 * 60 * 60 * 1000 ? `${Math.round(ms / 3_600_000)} hours`
    : `${Math.round(ms / 86_400_000)} day${ms >= 2 * 86_400_000 ? "s" : ""}`;
  return `Hidden for ${label} — it still applies on its own once you put the phone down.`;
}
