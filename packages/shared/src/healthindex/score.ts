// healthindex/score: The absolute score: per-entry scores, alerts, the capped headline, the weekly series. Barrel: ../healthindex.ts (read the header there).
import { HEALTH_ENTRIES, type HealthEntry, HEALTH_GOOD, HEALTH_SCORE_CAP_GAP, HEALTH_ALERT_WARN, HEALTH_ALERT_SEVERE, type HealthSeriesRow, type HealthSizeParts, type HealthAlertSubject, type HealthAlert, type HealthIndexPoint, type HealthIndexSeries } from "./types.js";
import { healthScore, healthWeeks, healthContextGood, type HealthEntryReadings, healthEntryReadings, centralOf, treeOf, DAY_MS } from "./readings.js";

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

// ── words: one wording for the phone and VS Code ────────────────────────────

/** A whole number with thousands separators, locale-free: `8,397`. */
const commas = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const oneDp = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);

/** Plain names for an entry, as the cap sentence names it. */
export const HEALTH_ENTRY_LABEL: Record<HealthEntry, string> = {
  size: "file length",
  retouch: "re-touches",
  hatches: "escape hatches",
  context: "CLAUDE.md + skill descriptions",
  untested: "untested modules",
};

function alertText(level: HealthAlert["level"], subject: HealthAlertSubject, value: number, good: number, path?: string): string {
  const body = (() => {
    switch (subject) {
      case "max":
        return `${path ?? "the longest file"} is ${commas(value)} lines (good: under ${commas(good)})`;
      case "lineMean":
        return `the average line sits in a file of ${commas(value)} lines (good: under ${commas(good)})`;
      case "retouch":
        return `${pct(value)} of recent file edits rework the edit before (good: under ${pct(good)})`;
      case "hatches":
        return `${oneDp(value)} unexplained escape hatches per 1,000 lines (good: under ${oneDp(good)})`;
      case "context":
        return `CLAUDE.md + skill descriptions are ${commas(value)} chars (good: under ${commas(good)})`;
      case "untested":
        return `${pct(value)} of source files have no test reaching them (good: under ${pct(good)})`;
    }
  })();
  return `${level}: ${body}`;
}

function alertOf(entry: HealthEntry, subject: HealthAlertSubject, value: number, good: number, path?: string | null): HealthAlert | null {
  const score = healthScore(value, good);
  if (!(score < HEALTH_ALERT_WARN)) return null;
  const level = score < HEALTH_ALERT_SEVERE ? "severe" : "warn";
  const p = path ?? undefined;
  return { level, entry, subject, value, good, score, ...(p ? { path: p } : {}), text: alertText(level, subject, value, good, p) };
}

/**
 * The cap, said once: `null` when the cap did not set the number. The worst
 * entry's score is derived (`value − HEALTH_SCORE_CAP_GAP`), so the wire
 * summary can be worded from its three fields alone.
 */
export function healthCapWords(s: { value: number; mean: number; cappedBy: HealthEntry | null }): string | null {
  if (!s.cappedBy || !(s.value < s.mean)) return null;
  const worst = Math.round(s.value - HEALTH_SCORE_CAP_GAP);
  return `Capped at ${Math.round(s.value)} by ${HEALTH_ENTRY_LABEL[s.cappedBy]} (${worst} of 100): the entries average ${Math.round(s.mean)}, and the score stays within ${HEALTH_SCORE_CAP_GAP} of its worst entry.`;
}

/** One week's score from its readings; null when any enabled entry is absent, or none is enabled. */
function scoreWeek(r: HealthEntryReadings, disabled: readonly HealthEntry[], contextWarnChars: number | null) {
  const enabled = HEALTH_ENTRIES.filter((e) => !disabled.includes(e));
  if (enabled.length === 0 || enabled.some((e) => r.values[e] === undefined)) return null;
  const ctxGood = healthContextGood(contextWarnChars);
  const scores: Partial<Record<HealthEntry, number>> = {};
  let sizeParts: HealthSizeParts | null = null;
  const alerts: HealthAlert[] = [];
  for (const e of enabled) {
    const v = r.values[e] as number;
    if (e === "size") {
      const m = r.max!;
      sizeParts = {
        lineMean: { value: v, score: healthScore(v, HEALTH_GOOD.lineMean) },
        max: { value: m.value, score: healthScore(m.value, HEALTH_GOOD.max), path: m.path },
      };
      scores.size = Math.sqrt(sizeParts.lineMean.score * sizeParts.max.score);
      // Size alerts on its sub-readings: the blend is under a line only if one
      // of them is, and the sub-reading is what can be named.
      const a1 = alertOf("size", "lineMean", v, HEALTH_GOOD.lineMean);
      const a2 = alertOf("size", "max", m.value, HEALTH_GOOD.max, m.path);
      if (a1) alerts.push(a1);
      if (a2) alerts.push(a2);
      continue;
    }
    const good = e === "context" ? ctxGood : HEALTH_GOOD[e];
    scores[e] = healthScore(v, good);
    const a = alertOf(e, e, v, good);
    if (a) alerts.push(a);
  }
  const n = enabled.length;
  // A score of 0 cannot occur (good > 0, value finite), so ln is finite.
  const mean = Math.exp(enabled.reduce((s, e) => s + Math.log(scores[e] as number), 0) / n);
  let worst: HealthEntry = enabled[0];
  for (const e of enabled) if ((scores[e] as number) < (scores[worst] as number)) worst = e;
  const capped = (scores[worst] as number) + HEALTH_SCORE_CAP_GAP;
  const index = Math.min(mean, capped);
  alerts.sort((a, b) => a.score - b.score);
  return { index, mean, scores, sizeParts, cappedBy: capped < mean ? worst : null, alerts, enabled };
}

/**
 * The scored series. `null` when no week has every enabled entry — no score
 * is no series, never a number nobody measured.
 */
export function healthIndex(
  rows: readonly HealthSeriesRow[],
  contextWarnChars: number | null,
): HealthIndexSeries | null {
  const points: HealthIndexPoint[] = [];
  for (const { week, row } of healthWeeks(rows)) {
    const c = centralOf(row);
    const readings = healthEntryReadings(row);
    const s = scoreWeek(readings, c.disabled, contextWarnChars);
    if (!s) continue;
    const prereg = typeof row.prereg === "string" ? row.prereg : null;
    const prev = points[points.length - 1];
    const base = {
      week, index: s.index, mean: s.mean, scores: s.scores, sizeParts: s.sizeParts,
      cappedBy: s.cappedBy, alerts: s.alerts, values: readings.values, prereg,
      central: c.fp, disabled: c.disabled, overridden: c.overridden, tree: treeOf(row),
    };
    if (!prev) {
      points.push({ ...base, gap: false, lnLink: null, comparable: 0, contributions: {}, spanDays: null });
      continue;
    }
    const spanDays = daysBetween(prev.week, week);
    const gapReason = prev.prereg !== prereg ? "prereg" : prev.central !== c.fp ? "central" : null;
    if (gapReason) {
      points.push({ ...base, gap: true, lnLink: null, comparable: 0, contributions: {}, spanDays, gapReason });
      continue;
    }
    // Same fingerprint ⇒ same enabled set, so every entry is in both weeks.
    const n = s.enabled.length;
    const contributions: Partial<Record<HealthEntry, number>> = {};
    for (const e of s.enabled) {
      const a = prev.scores[e];
      const b = s.scores[e];
      if (a !== undefined && b !== undefined) contributions[e] = (prev.mean * (Math.log(b) - Math.log(a))) / n;
    }
    points.push({
      ...base, gap: false, lnLink: Math.log(s.index / prev.index), comparable: n, contributions, spanDays,
    });
  }
  if (points.length === 0) return null;
  return { baselineWeek: points[0].week, points };
}

/** One row by the SAME formula a week uses (`scoreWeek`); null when an enabled entry is absent. */
export function healthRowScore(
  row: HealthSeriesRow,
  contextWarnChars: number | null,
): { index: number; mean: number; scores: Partial<Record<HealthEntry, number>>; cappedBy: HealthEntry | null } | null {
  const s = scoreWeek(healthEntryReadings(row), centralOf(row).disabled, contextWarnChars);
  return s ? { index: s.index, mean: s.mean, scores: s.scores, cappedBy: s.cappedBy } : null;
}

/** One scored commit (a series row) for the phone's commits axis. No lnLink, contributions or move. */
