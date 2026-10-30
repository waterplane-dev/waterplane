/**
 * The week card's pure half: which repo wears which colour, a column's stacked bands, the
 * spans the two cost-window reads ask for, and the sentences the card says about them.
 *
 * Kept out of `WeekCard.tsx` and `TokenStatsBody.tsx` so it is node-tested (`weekBands.test.mjs`)
 * and so the body stays under its line budget. The bucketing itself is NOT here: the number on
 * an hour and the list that hour opens are `weekCut` (shared/costwindow.ts), one predicate.
 */
import {
  type CostHourRepo, type CostWindowDoc, fmtCount, fmtUsd, HOUR_MS, hourKeyMs, type PtsCalibration,
  type PtsRefusal, ptsRefusalText, SESSION_BUDGET_PCT_CAVEAT, type UsageInfo, usageChip, type WeekBucket, type WeekCut,
  undatedText, undatedWhy, windowStartHour,
} from "@waterplane/shared";
import { leadClause } from "./usageCut.ts";

/**
 * How many repos get a hue of their own: the validated categorical palette's size (`SLOT`,
 * `--chart-1..4`). Never a generated fifth — the slot order is the CVD-safety mechanism — so
 * every repo past these folds into ONE hueless "other repos" band, as `foldParts` does.
 */
export const REPO_SLOTS = 4;
/** The fold's slot index: drawn in ink-grey, never a hue. */
export const OTHER_SLOT = -1;
export const OTHER_LABEL = "other repos";

/**
 * Which repo holds which slot, for the life of the card.
 *
 * `ranked` is the span's repos by cost (dearest first). The top `REPO_SLOTS` get a slot; with
 * `prev` (the last assignment), a repo that still qualifies KEEPS its slot when another overtakes
 * it, and a newcomer takes the lowest free one — a colour that hops between two repos on a
 * re-read reads as two repos swapping their spend. Repos missing from the map are the fold.
 */
export function repoSlots(ranked: readonly string[], prev?: ReadonlyMap<string, number> | null): Map<string, number> {
  const top = ranked.slice(0, REPO_SLOTS);
  const out = new Map<string, number>();
  for (const k of top) {
    const s = prev?.get(k);
    if (s != null && s >= 0 && s < REPO_SLOTS) out.set(k, s);
  }
  const used = new Set(out.values());
  for (const k of top) {
    if (out.has(k)) continue;
    let s = 0;
    while (used.has(s)) s++;
    out.set(k, s);
    used.add(s);
  }
  return out;
}

export interface Band {
  /** The repo key, or `""` + OTHER for the fold. */
  key: string;
  label: string;
  slot: number;
  usd: number;
  /** Bottom and top edge in VALUE space (dollars), bottom band first. */
  v0: number;
  v1: number;
}

/**
 * One hour's column as bands: the slotted repos in SLOT order from the bottom, the fold on top,
 * accumulated in value space (never per-pixel). An empty band is dropped — a zero-height sliver
 * is a claim that the repo ran.
 */
export function columnBands(byRepo: readonly CostHourRepo[], slots: ReadonlyMap<string, number>): Band[] {
  const named = new Map<number, { key: string; label: string; usd: number }>();
  let other = 0;
  for (const r of byRepo) {
    const usd = r.cost?.total;
    if (!(usd > 0) || !Number.isFinite(usd)) continue;
    const s = slots.get(r.repo);
    if (s == null) { other += usd; continue; }
    const cur = named.get(s) ?? { key: r.repo, label: r.label, usd: 0 };
    cur.usd += usd;
    named.set(s, cur);
  }
  const out: Band[] = [];
  let v = 0;
  for (const s of [...named.keys()].sort((a, b) => a - b)) {
    const b = named.get(s)!;
    out.push({ key: b.key, label: b.label, slot: s, usd: b.usd, v0: v, v1: v + b.usd });
    v += b.usd;
  }
  if (other > 0) out.push({ key: "\u0000other", label: OTHER_LABEL, slot: OTHER_SLOT, usd: other, v0: v, v1: v + other });
  return out;
}

/** The legend: the slotted repos in slot order, plus the fold when any repo is in it. */
export function legendEntries(ranked: readonly { repo: string; label: string }[], slots: ReadonlyMap<string, number>): { key: string; label: string; slot: number }[] {
  const named = ranked.filter((r) => slots.has(r.repo))
    .map((r) => ({ key: r.repo, label: r.label, slot: slots.get(r.repo)! }))
    .sort((a, b) => a.slot - b.slot);
  return ranked.length > named.length ? [...named, { key: "\u0000other", label: OTHER_LABEL, slot: OTHER_SLOT }] : named;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hh = (t: number) => `${String(new Date(t).getHours()).padStart(2, "0")}:00`;

/** `Tue 14:00–15:00` — the hour a bucket stands for, from its top. */
export function hourWords(t: number): string {
  return `${DAYS[new Date(t).getDay()]} ${hh(t)}–${hh(t + HOUR_MS)}`;
}

/**
 * The column's answer, as a line under the chart (the crosshair rule — never a floating box):
 * `Tue 14:00–15:00 · $31 · tiptoi $20, garmin $9, 2 others · 7 sessions`. The total is never
 * printed without its split, so the repo clause is always there when the host sent one.
 */
export function hourText(b: WeekBucket): string {
  const repos = b.byRepo.filter((r) => r.cost?.total > 0).slice().sort((x, y) => y.cost.total - x.cost.total);
  const named = repos.slice(0, 2).map((r) => `${r.label} ${fmtUsd(r.cost.total)}`);
  const rest = repos.length - named.length;
  const split = named.length ? ` · ${named.join(", ")}${rest > 0 ? `, ${rest} ${rest === 1 ? "other" : "others"}` : ""}` : "";
  // The folded ones ran in this hour too: the column's count is every session, listed or not.
  const n = b.convoIds.length + (b.restConvos > 0 ? b.restConvos : 0);
  return `${hourWords(b.t)} · ${fmtUsd(b.usd)}${split} · ${n} ${n === 1 ? "session" : "sessions"}`;
}

// ── the spans the two reads ask for ──────────────────────────────────────

export const WEEK_MS = 7 * 24 * HOUR_MS;

/**
 * The week read: from the hour the week's cut starts on (`windowStartHour` of the instant it
 * opened, `weeklyResetAt − 7 d` — the nearest hour, the rule every window edge here shares) to
 * now, or null without a FUTURE reset instant (a reading whose week already rolled describes the
 * previous week). `from` is SENT on the hour, so the host's floor is the identity and the card,
 * the limit bar's cut and the heat grid start on the same hour; `openedAt` is the reset itself,
 * for the caption and for the usage readings (instants, not buckets). Keyed on `from`, so the
 * scrape's minute jitter does not re-read.
 */
export function weekSpan(usage: UsageInfo | null | undefined, now: number): { from: number; openedAt: number; key: string } | null {
  const r = usage?.weeklyResetAt;
  if (r == null || !Number.isFinite(r) || r <= now) return null;
  const openedAt = r - WEEK_MS;
  const from = windowStartHour(openedAt);
  return { from, openedAt, key: `${from}` };
}

/**
 * The span the Totals box's repo split is read over, given the cut on screen: from the hour its
 * cut starts on (`fromHour`, already `windowStartHour`) to the hour the NEXT window's cut starts
 * on (`toHour` = `windowStartHour(resetAt)`, so a past window's read ends where its heat cell
 * does — or now, for one still running, worked out at read time so the key stays put). `"week"`
 * when the cut IS the week the week card already read: the same span, so the same document,
 * never a second fetch. Null with no cut.
 */
export function scopeSpan(
  cut: { id: string; back: number; fromHour: number; resetAt: number } | null,
  week: { from: number } | null,
): { from: number; toHour: number; key: string } | "week" | null {
  if (!cut) return null;
  if (cut.id === "week" && cut.back === 0 && week && week.from === cut.fromHour) return "week";
  const toHour = windowStartHour(cut.resetAt);
  return { from: cut.fromHour, toHour, key: `${cut.fromHour}:${toHour}` };
}

/** A document the screen may draw for the span it asked: the right shape (an older host or a
 *  cached half-shape is absent, not half-drawn) AND an answer to THIS `from` — a key change
 *  leaves the previous window's answer in hand until the new one lands. */
export function docFor(doc: CostWindowDoc | null | undefined, from: number | null): CostWindowDoc | null {
  if (!doc || from == null) return null;
  if (!Array.isArray(doc.convos) || !Array.isArray(doc.hours) || !doc.cost || !doc.agentCost) return null;
  // Records in no hour are in no span: every figure would be a floor that looks exact.
  if (undatedWhy(doc.undated)) return null;
  return doc.from === Math.round(from) ? doc : null;
}

// ── words ─────────────────────────────────────────────────────────────────

/** A cost-window read as `foldStateText` words it: its state, and the answer when one came. */
export interface FoldRead { state: string; error?: string | null; data?: { undated?: number } | null }

/** What a cost-window read that has nothing to draw says, by state — four states, four sentences,
 *  and the ledger's own refusal (`undatedText`) when the answer came but cannot be drawn. */
export function foldStateText(
  res: FoldRead,
  what: "window" | "week",
): string {
  // The answer came, and is refused by `docFor` for what it cannot count (shared `undatedWhy`).
  const undated = undatedText(res.data?.undated);
  if (undated) return undated;
  if (res.state === "offline") {
    return what === "window"
      ? "No connection — the repo split for a window is folded on the desktop."
      : "No connection — where the week went is folded on the desktop.";
  }
  if (res.state === "error") {
    if (/^404\b/.test(res.error ?? "")) {
      return what === "window"
        ? "This desktop’s host predates the per-window repo split; tap All time for the all-time one."
        : "This desktop’s host predates the week view — it answers once the host is updated.";
    }
    return `The desktop could not fold ${what === "window" ? "this window’s" : "the week’s"} conversations${res.error ? ` (${res.error})` : ""}.`;
  }
  return what === "window"
    ? "Folding this window’s conversations on the desktop…"
    : "Folding the week’s conversations on the desktop…";
}

/** The calibration's sentence: what one weekly point is worth and how it was measured, or the
 *  refusal in its own words. Null with no reading at all (nothing to calibrate against). */
export function calText(cal: PtsCalibration | PtsRefusal | null | undefined): string | null {
  if (!cal) return null;
  if ("usdPerPt" in cal) {
    const n = cal.stretches;
    return `≈ pts: ${fmtUsd(cal.usdPerPt)} per weekly point, measured over ${n} ${n === 1 ? "stretch" : "stretches"} of readings since the reset (${SESSION_BUDGET_PCT_CAVEAT}).`;
  }
  return ptsRefusalText(cal);
}

/**
 * `Since the weekly reset, Thu 18:59 — 2 d 5 h ago: the first minute of the week falls before the
 * first column and is left out.` — `openedAt` is the reset instant (`weekSpan`), the document's
 * `fromHour` the hour its cut starts on; the edge clause is `leadClause`, the live cut's wording.
 */
export function weekCaption(doc: CostWindowDoc, openedAt: number, now: number): string {
  const clause = leadClause(openedAt - doc.fromHour, "week", "the first column");
  const at = new Date(openedAt);
  const day = DAYS[at.getDay()];
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const h = Math.max(0, Math.floor((now - openedAt) / HOUR_MS));
  const ago = h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h} h`;
  return `Since the weekly reset, ${day} ${clock} — ${ago} ago${clause ? `: ${clause}` : ""}.`;
}

/**
 * A figure on the card: money when a list price covered it, else the TOKEN count — the rung
 * `costChip(…) ?? usageChip(…)` the launcher row climbs. A local model or an unpriced rate has
 * cost 0 with tokens in it, and `$0` beside that reads as "this was free". Null when neither was
 * measured: absent, never a zero.
 */
export function usdOrTok(usd: number, tok: number): string | null {
  if (Number.isFinite(usd) && usd > 0) return fmtUsd(usd);
  const t = usageChip(tok);
  return t ? `${t} tokens` : null;
}

/** Whether a figure is money (true) or fell back to tokens — so a row's share and its "at list
 *  prices" clause follow the same rung `usdOrTok` printed. */
export const priced = (usd: number): boolean => Number.isFinite(usd) && usd > 0;

/**
 * Whether an ALL-TIME conversation may wear this week's points: only when it ran wholly inside
 * the week (its first turn at or after the hour the week's cut starts on, `windowStartHour` —
 * the cut's own left edge, idempotent when handed `weekSpan`'s `from`). The row's dollars are all-time and the rate is this week's, so a conversation that
 * started in August reads "≈ 45 pts" for spend the week never saw. Absent beats wrong.
 */
export function convoInWeek(c: { firstAt: number | null }, weekFrom: number | null | undefined): boolean {
  return weekFrom != null && Number.isFinite(weekFrom) && c.firstAt != null && c.firstAt >= windowStartHour(weekFrom);
}

/**
 * What the capped list leaves out, unfiltered: `Lists 60 of 591 sessions — 531 cheaper sessions
 * not listed · $12.40, counted in every total above.` Null when the host folded nothing.
 */
export function listedText(listed: number, cut: Pick<WeekCut, "total" | "restText">): string | null {
  const rest = cut.restText(null);
  if (!rest) return null;
  return `Lists ${listed} of ${cut.total} ${cut.total === 1 ? "session" : "sessions"} — ${rest}, counted in every total above.`;
}

/** A row's folded sessions, said under its list: `12 more sessions are in this row's total, not listed.` */
export function moreText(more: number): string | null {
  return more > 0 ? `${more} more ${more === 1 ? "session is" : "sessions are"} in this row’s total, not listed.` : null;
}

/** `3 sessions · 1.2M tokens` — a row's facts, the folded sessions counted in. */
export function rowFacts(listed: number, more: number, tok: number): string {
  const n = listed + (more > 0 ? more : 0);
  return `${n} ${n === 1 ? "session" : "sessions"} · ${fmtCount(tok)} tokens`;
}

/** The share of a dollar figure an agent slice is, rounded — `null` when there is no figure. */
export function agentPct(agentUsd: number, usd: number): number | null {
  return usd > 0 && Number.isFinite(agentUsd) ? Math.round((agentUsd / usd) * 100) : null;
}

/** The key's hour as an instant — re-exported so the card does not reach into shared twice. */
export { hourKeyMs };
