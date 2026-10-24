/**
 * The chart labels both plots share — how a token count and an axis instant are worded.
 *
 * One home so a value read off an axis and the same value in a readout can never be worded
 * differently by two charts. `contextPlot.ts` and `statsPlot.ts` re-export these under their
 * original names; the wording below is moved verbatim.
 */

/** `1.2M` / `184k` / `912`. Axis ticks and labels alike, so a value read off
 *  the axis and the same value in a tooltip can never be worded differently. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * The same units, one decimal below 10k: `1.8k`, not `2k`.
 *
 * `fmtTokens` is an AXIS label — four of them across a phone's width, where a
 * decimal is noise. A readout beside a row's sparkline is the opposite case:
 * it is the only number on the line, and rounding 1,800 and 2,400 both to `2k`
 * throws away the difference the row exists to show. Above 10k the decimal is
 * noise again (`83.4k` says nothing `83k` did not), so the two agree there.
 */
export function fmtTokensFine(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n >= 10_000) return fmtTokens(n);
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

/**
 * A clock label whose precision follows the SPAN, not the value.
 *
 * A conversation can be twenty minutes or eleven days. Four axis labels all
 * reading "13:40" because they are the same day, or all reading "23 Jun"
 * because they are the same hour, are four labels that say nothing.
 */
export function fmtAxisTime(t: number, spanMs: number): string {
  const d = new Date(t);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (spanMs < 36 * 3600_000) return hhmm;
  return spanMs < 14 * 86_400_000 ? `${fmtAxisDay(t)} ${hhmm}` : fmtAxisDay(t);
}

/** A calendar day's axis label ("2 Oct") — what a DAY bucket is named by, never a clock. */
export const fmtAxisDay = (t: number): string =>
  `${new Date(t).getDate()} ${new Date(t).toLocaleString(undefined, { month: "short" })}`;
