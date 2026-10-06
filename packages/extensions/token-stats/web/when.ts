/** Wording of an instant, a span and a share: the limit windows' reset and time-axis labels, the tiles' dates and spans. */
import { fmtShare, type TokenStatsDoc } from "@waterplane/shared";

/**
 * A reset instant as few words as it can be said in. Same day ⇒ the time
 * alone (the five-hour window is always today or tomorrow); further out ⇒ the
 * weekday too, because "resets at 09:00" for a window four days away is the
 * wrong-day mistake the parse refuses to make upstream.
 */
/**
 * A time label under the chart.
 *
 * The time alone, except at local MIDNIGHT, where the label is the weekday
 * instead: a day-wide strip always straddles two dates, and a reader who can
 * see where one ends needs no date on the other five labels. Putting the
 * weekday on every one of them is how the first two labels ended up overlapping
 * into a single unreadable word.
 */
export function tickWhen(ts: number): string {
  const d = new Date(ts);
  if (d.getHours() === 0 && d.getMinutes() === 0) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function resetWhen(ts: number): string {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return hm;
  const tomorrow = new Date(today.getTime() + 86400000);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${hm}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${hm}`;
}

/** A model id with the prefix every one of them carries taken off — the same
 *  trim `ModelLegend` makes, for the same reason. */
export function short(label: string): string {
  return label.replace(/^claude-/, "");
}

/** How long a window is, in the unit a person thinks in: a week is seven days,
 *  not 168 hours. */
export function spanWord(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} hours`;
}

/** A date and a clock time, short enough for a tile. */
export function whenShort(t: number): string {
  return new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}


/** `38% of it` — and never a percentage of nothing, which is a division by
 *  zero wearing a face. */
export function shareNote(part: number, whole: number): string | undefined {
  if (whole <= 0) return undefined;
  return `${fmtShare(part / whole)} of it`;
}

export function spanDays(doc: TokenStatsDoc): number {
  if (doc.firstAt == null || doc.lastAt == null) return 0;
  return Math.round((doc.lastAt - doc.firstAt) / 86_400_000) + 1;
}
