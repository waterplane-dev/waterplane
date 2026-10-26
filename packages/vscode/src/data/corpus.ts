/**
 * Every conversation on this machine, folded: the all-sessions overview.
 *
 * The fold is `tokenstats.ts`' `aggregate()` (the host's all-sessions screen),
 * kept to the rows the extension draws — totals, the subagents' slice, days
 * with their model, launch and repo splits, models, repos — priced in the same
 * loop per model×day, because rates differ per model and change over time and a
 * day row has no model to price at. An unpriced model's tokens are COUNTED into
 * `unpriced`, never charged zero. `top` is not folded here at all: it is the
 * host's `foldCostWindow` over all time, so the dearest-conversations table is
 * the phone's to the cent (`corpus.test.mjs` pins the totals equal as well).
 *
 * The hours are the same projection one level down (`aggregate()`'s `hours`,
 * `hoursFrom`, `hourOfDay`): every hour folds into the 24-slot clock, and only
 * the last `HOURS_DAYS` days of them go on the wire, like the phone's document.
 * `week` is `foldCostWindow` again, over the last seven calendar days to now —
 * the headline's span, never the account's weekly-limit window: no reset
 * instant is read here. `spans` is the same fold over the span filter's calendar
 * spans (30 and 90 days, `span.ts`' `calendarFrom`), so their repo bars and
 * costliest list are cost INSIDE the span, as the phone's `/api/costwindow` is.
 */
import { basename } from "node:path";
import type { CostBreakdown, ModelSlice, TokenDay, TokenGroup, TokenHour, TokenHourSlot, TokenTotals } from "@waterplane/shared";
import {
  PRICES_AS_OF, addCost, addTotals, costOf, dayToMs, isPriced, normalizeModel, tokenTotal, zeroCost, zeroTotals,
} from "@waterplane/shared";
import { CROSS, localHour } from "../../../host/src/tokenscan.js";
import type { Tally } from "../../../host/src/tokenscan.js";
import { foldCostWindow, repoOfWorktree } from "../../../host/src/costwindow.js";
import type { Files } from "../../../host/src/costwindow.js";
import type { CorpusDoc } from "../protocol.js";
import type { ScanStats } from "./store.js";

/** How many conversations `top` names (`tokenstats.ts`' `TOP_CONVOS`). */
const TOP_CONVOS = 12;
/** Days of hour rows put on the wire (`tokenstats.ts`' `HOURS_DAYS` default). The clock folds them all. */
export const HOURS_DAYS = 14;
/** Calendar days `week` folds, today included — the token-stats headline's `HEADLINE_DAYS`. */
export const WEEK_DAYS = 7;
/** The span filter's calendar spans (`span.ts`' `SPANS`), each folded whole into `spans`. */
export const SPAN_DAYS = [30, 90] as const;

const uncross = (k: string): [hour: string, model: string] => {
  const i = k.indexOf(CROSS);
  return i < 0 ? ["", k] : [k.slice(0, i), k.slice(i + 1)];
};
const tallyToTotals = (t: Tally): TokenTotals =>
  ({ input: t[0], output: t[1], cacheRead: t[2], cacheWrite: t[3], cacheWrite1h: t[4], turns: t[5] });
const nest = <T>(m: Map<string, Map<string, T>>, a: string, b: string, blank: () => T): T => {
  const inner = m.get(a) ?? m.set(a, new Map()).get(a)!;
  return inner.get(b) ?? inner.set(b, blank()).get(b)!;
};
const get = <T>(m: Map<string, T>, k: string, blank: () => T): T => m.get(k) ?? m.set(k, blank()).get(k)!;
const dayMs = (d: string | null): number | null => {
  if (!d) return null;
  const [y, mo, da] = d.split("-").map(Number);
  return new Date(y, (mo || 1) - 1, da || 1).getTime();
};
const slices = (t: Map<string, TokenTotals> | undefined, c: Map<string, CostBreakdown> | undefined): ModelSlice[] =>
  [...(t ?? new Map<string, TokenTotals>()).entries()]
    .map(([model, totals]) => ({ model, totals, cost: c?.get(model) ?? zeroCost() }))
    .sort((x, y) => tokenTotal(y.totals) - tokenTotal(x.totals));

/**
 * Fold the store's per-file summaries into the overview document. Pure apart
 * from the clock it is handed: `now` stamps `scannedAt` unless `scan` (the
 * store's last refresh) says otherwise.
 */
export function foldCorpus(files: Files, now: number, scan?: ScanStats): CorpusDoc {
  const totals = zeroTotals();
  const subagents = zeroTotals();
  const unpriced = zeroTotals();
  const cost = zeroCost();
  const subCost = zeroCost();
  const days = new Map<string, TokenTotals>();
  const dayCost = new Map<string, CostBreakdown>();
  const dayModel = new Map<string, Map<string, TokenTotals>>();
  const dayModelCost = new Map<string, Map<string, CostBreakdown>>();
  const dayAgents = new Map<string, Map<string, number>>();
  const dayRepo = new Map<string, Map<string, { turns: number; pricedTurns: number; usd: number; ctxTok: number }>>();
  const hours = new Map<string, TokenTotals>();
  const hourCost = new Map<string, CostBreakdown>();
  const hourModel = new Map<string, Map<string, TokenTotals>>();
  const hourModelCost = new Map<string, Map<string, CostBreakdown>>();
  /** 0..23 → every hour on record folded onto one clock face. */
  const slots: TokenTotals[] = Array.from({ length: 24 }, zeroTotals);
  const slotCost: CostBreakdown[] = Array.from({ length: 24 }, zeroCost);
  const models = new Map<string, TokenTotals>();
  const modelCost = new Map<string, CostBreakdown>();
  const repos = new Map<string, TokenTotals>();
  const repoCost = new Map<string, CostBreakdown>();
  const repoModel = new Map<string, Map<string, TokenTotals>>();
  const repoModelCost = new Map<string, Map<string, CostBreakdown>>();
  const cold = { count: 0, tok: 0, usd: 0, premiumUsd: 0 };
  let conversations = 0;
  let subagentLogs = 0;
  let fastTurns = 0;
  let logs = 0;

  for (const [slug, byFile] of Object.entries(files)) {
    for (const sum of Object.values(byFile)) {
      logs++;
      if (sum.sub) subagentLogs++; else conversations++;
      if (sum.f) fastTurns += sum.f;
      const repoKey = sum.w ? repoOfWorktree(sum.w) : slug;
      // A subagent transcript is ONE launch, on the day of its earliest bucket.
      if (sum.sub) {
        let earliest = "";
        let earliestModel = "unknown";
        for (const key of Object.keys(sum.x)) {
          const [hour, model] = uncross(key);
          if (hour && (!earliest || hour < earliest)) { earliest = hour; earliestModel = model; }
        }
        if (earliest) {
          const inner = get(dayAgents, earliest.slice(0, 10), () => new Map<string, number>());
          inner.set(earliestModel, (inner.get(earliestModel) ?? 0) + 1);
        }
      }
      for (const [key, r] of Object.entries(sum.r ?? {})) {
        const [hour, model] = uncross(key);
        const day = hour.slice(0, 10) || undefined;
        cold.count += r[0];
        cold.tok += r[1];
        const wrote = costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: r[1], cacheWrite1h: r[2] }, model, day);
        const asRead = costOf({ input: 0, output: 0, cacheRead: r[1], cacheWrite: 0, cacheWrite1h: 0 }, model, day);
        if (wrote) {
          cold.usd += wrote.total;
          if (asRead) cold.premiumUsd += Math.max(0, wrote.total - asRead.total);
        }
      }
      for (const [key, t] of Object.entries(sum.x)) {
        const [hour, model] = uncross(key);
        // The day is a PREFIX of the hour; an undated record is in the totals and in no day.
        const day = hour.slice(0, 10);
        const slot = hour.length >= 13 ? Number(hour.slice(11, 13)) : NaN;
        const inSlot = slot >= 0 && slot < 24;
        const v = tallyToTotals(t);
        if (day) addTotals(get(days, day, zeroTotals), v);
        if (hour) {
          addTotals(get(hours, hour, zeroTotals), v);
          addTotals(nest(hourModel, hour, model, zeroTotals), v);
        }
        if (inSlot) addTotals(slots[slot], v);
        addTotals(get(models, model, zeroTotals), v);
        addTotals(get(repos, repoKey, zeroTotals), v);
        addTotals(totals, v);
        // A slice OF the total, never a second total.
        if (sum.sub) addTotals(subagents, v);
        if (day) addTotals(nest(dayModel, day, model, zeroTotals), v);
        addTotals(nest(repoModel, repoKey, model, zeroTotals), v);
        const dr = day ? nest(dayRepo, day, repoKey, () => ({ turns: 0, pricedTurns: 0, usd: 0, ctxTok: 0 })) : null;
        // The context those requests sent, as the host's ledger counts it: the health score's spend line reads it.
        if (dr) { dr.turns += v.turns; dr.ctxTok += v.input + v.cacheRead + v.cacheWrite; }
        const c = costOf(v, model, day || undefined);
        if (!c) { addTotals(unpriced, v); continue; }
        if (dr) { dr.pricedTurns += v.turns; dr.usd += c.total; }
        addCost(cost, c);
        if (sum.sub) addCost(subCost, c);
        if (day) {
          addCost(get(dayCost, day, zeroCost), c);
          addCost(nest(dayModelCost, day, model, zeroCost), c);
        }
        if (hour) {
          addCost(get(hourCost, hour, zeroCost), c);
          addCost(nest(hourModelCost, hour, model, zeroCost), c);
        }
        if (inSlot) addCost(slotCost[slot], c);
        addCost(get(modelCost, model, zeroCost), c);
        addCost(get(repoCost, repoKey, zeroCost), c);
        addCost(nest(repoModelCost, repoKey, model, zeroCost), c);
      }
    }
  }

  const dayRows: TokenDay[] = [...days.entries()]
    .map(([day, t]) => ({
      day, ...t, cost: dayCost.get(day) ?? zeroCost(),
      byModel: slices(dayModel.get(day), dayModelCost.get(day)),
      agents: [...(dayAgents.get(day) ?? new Map<string, number>()).entries()]
        .map(([model, count]) => ({ model, count }))
        .sort((x, y) => y.count - x.count),
      byRepo: [...(dayRepo.get(day) ?? new Map()).entries()]
        .map(([repo, r]) => ({ repo, ...r }))
        .sort((x, y) => y.usd - x.usd),
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const modelRows: TokenGroup[] = [...models.entries()]
    // Labelled by the alias; the raw id stays as the key.
    .map(([key, t]) => ({ key, label: normalizeModel(key) ?? key, ...t, cost: modelCost.get(key) ?? zeroCost(), priced: isPriced(key) }))
    .sort((a, b) => tokenTotal(b) - tokenTotal(a));
  const repoRows: TokenGroup[] = [...repos.entries()]
    .map(([key, t]) => ({
      key, label: basename(key) || key, ...t, cost: repoCost.get(key) ?? zeroCost(), priced: isPriced(key),
      byModel: slices(repoModel.get(key), repoModelCost.get(key)),
    }))
    .sort((a, b) => tokenTotal(b) - tokenTotal(a));

  // Cut on the way OUT, from local midnight `HOURS_DAYS - 1` days before `now`.
  const cutFrom = new Date(now);
  cutFrom.setHours(0, 0, 0, 0);
  cutFrom.setDate(cutFrom.getDate() - (HOURS_DAYS - 1));
  const cutKey = localHour(cutFrom.getTime()).slice(0, 10);
  const hourRows: TokenHour[] = [...hours.entries()]
    .filter(([hour]) => hour.slice(0, 10) >= cutKey)
    .map(([hour, t]) => ({ hour, ...t, cost: hourCost.get(hour) ?? zeroCost(), byModel: slices(hourModel.get(hour), hourModelCost.get(hour)) }))
    .sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
  // From the ROWS, not the cut: nothing in the window is "no hours", never a fortnight off.
  const hoursFrom = hourRows.length ? dayToMs(hourRows[0].hour.slice(0, 10)) : null;
  const hourOfDay: TokenHourSlot[] = slots.map((t, hour) => ({ hour, ...t, cost: slotCost[hour] }));

  // The host's own all-time conversation fold, so the table is the phone's to the cent.
  const top: CorpusDoc["top"] = foldCostWindow(files, 0, Number.MAX_SAFE_INTEGER, { byConv: new Map() }, now, TOP_CONVOS).convos;
  // Each row's first request (the parent log's `b`), as the phone's `tokenstats.ts` sets `firstTok`:
  // the all-sessions rows draw it as a bar. A log that did not record one leaves it absent.
  const firstOf = new Map<string, number>();
  for (const byFile of Object.values(files)) {
    for (const [fileKey, sum] of Object.entries(byFile)) if (!sum.sub && sum.b) firstOf.set(fileKey.split("/")[0], sum.b);
  }
  const withFirst = (convos: CorpusDoc["top"]) => { for (const c of convos) { const b = firstOf.get(c.id); if (b) c.firstTok = b; } };
  withFirst(top);
  // The headline's seven calendar days (local midnight six days back, to now), folded the way the
  // phone's week card is — so "where the week went" breaks down the very figure the headline prints.
  const weekFrom = new Date(now);
  weekFrom.setHours(0, 0, 0, 0);
  weekFrom.setDate(weekFrom.getDate() - (WEEK_DAYS - 1));
  const week = foldCostWindow(files, weekFrom.getTime(), now, { byConv: new Map() }, now);
  withFirst(week.convos);
  // The span filter's calendar spans, from local midnight n-1 days back like `calendarFrom`.
  const spans: CorpusDoc["spans"] = {};
  for (const n of SPAN_DAYS) {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (n - 1));
    spans[n] = foldCostWindow(files, from.getTime(), now, { byConv: new Map() }, now);
    withFirst(spans[n].convos);
  }

  const first = dayRows[0]?.day ?? null;
  const last = dayRows[dayRows.length - 1]?.day ?? null;
  return {
    totals, cost, unpriced, subagents, subagentCost: subCost,
    days: dayRows, hours: hourRows, hoursFrom, hourOfDay, models: modelRows, repos: repoRows, top,
    week, spans,
    conversations, subagentLogs, fastTurns,
    coldStarts: {
      count: cold.count, tok: cold.tok,
      ...(cold.usd > 0 ? { usd: cold.usd } : {}),
      ...(cold.premiumUsd > 0 ? { premiumUsd: cold.premiumUsd } : {}),
    },
    firstAt: dayMs(first), lastAt: dayMs(last),
    pricesAsOf: PRICES_AS_OF,
    scannedAt: scan?.scannedAt || now,
    logs: scan?.logs ?? logs,
    reread: scan?.reread ?? 0,
  };
}
