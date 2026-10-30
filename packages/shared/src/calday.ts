/**
 * Local CALENDAR-day arithmetic — the one place a day step or a day count is made.
 *
 * A local day is 23, 24 or 25 hours long, so `t + n * 86_400_000` lands an hour
 * off after a DST switch and `(b - a) / 86_400_000` is not a whole number. That
 * idiom was fixed three times one site at a time (4165230b, fa6779e5, 63a174c9)
 * and left in the neighbour each time; design review 2026-10-30 W1 made it
 * one module. `tools/calday.test.mjs` fails if it comes back.
 * Genuine ms DURATIONS (a rate-limit window is 168 h) stay in ms, and are the
 * ratchet's allow-list.
 */
const MS_PER_DAY = 86_400_000;

/** `t` moved by `n` calendar days, keeping the local clock time (setDate, not ms). */
export function addLocalDays(t: number, n: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Whole calendar days from `a`'s local date to `b`'s (negative if b is earlier); clock times ignored. */
export function localDaysBetween(a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  return Math.round(
    (Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) - Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / MS_PER_DAY,
  );
}
