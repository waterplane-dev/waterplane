/**
 * The few numbers the extension can print the moment VS Code opens, before any scan: folded from
 * the `CorpusDoc` a finished scan already holds, kept in `globalState`, read back with zero IO
 * (the full ledger is 3 MB and folding it costs half a second — too much for activation).
 *
 * It is a reading of a past scan, so it carries `scannedAt` and the caller prints the age beside it.
 * A figure with nothing priced behind it is `null`, never $0; a config dir other than the one it
 * was folded from is somebody else's number and is dropped by the caller (`configDir`).
 * Pure: no vscode, no IO.
 */
import { fmtCount, fmtUsd } from "@waterplane/shared";
import type { CostBreakdown, TokenTotals } from "@waterplane/shared";
import { HEADLINE_DAYS, headline, headlineSpan } from "../../../extensions/token-stats/web/headline.js";
import type { HeadlineDay } from "../../../extensions/token-stats/web/headline.js";
import type { CorpusDoc } from "../protocol.js";

export interface HeadlineSummary {
  v: 1;
  /** The Claude config dir the scan read; a different one means this summary is not for it. */
  configDir: string;
  scannedAt: number;
  conversations: number;
  /** List-price cost of everything on the machine; null when nothing was priced. */
  allCost: CostBreakdown | null;
  /** The headline's seven calendar days ending at `scannedAt`. */
  week: { total: number; split: TokenTotals; cost: CostBreakdown | null; requests: number; days: HeadlineDay[] };
  /** Per repo over the same seven days, priced turns only. `tok` is the context those requests sent
   *  (`byRepo.ctxTok`): the ledger keeps no per-repo output split, so it is not a total token count. */
  weekByRepo: { repo: string; usd: number; tok: number }[];
}

const ZERO: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 0 };

/** `cost` as a figure only when something was priced. */
const priced = (c: CostBreakdown | null | undefined): CostBreakdown | null => (c && c.total > 0 ? c : null);

export function summaryOf(doc: CorpusDoc, configDir: string): HeadlineSummary {
  const h = headline(doc.days, doc.scannedAt);
  const inSpan = new Set(headlineSpan(doc.scannedAt).map((d) => d.day));
  const byRepo = new Map<string, { usd: number; tok: number }>();
  for (const d of doc.days) {
    if (!inSpan.has(d.day)) continue;
    for (const r of d.byRepo ?? []) {
      if (!(r.pricedTurns > 0)) continue;
      const cur = byRepo.get(r.repo) ?? { usd: 0, tok: 0 };
      cur.usd += r.usd;
      cur.tok += r.ctxTok ?? 0;
      byRepo.set(r.repo, cur);
    }
  }
  return {
    v: 1,
    configDir,
    scannedAt: doc.scannedAt,
    conversations: doc.conversations,
    allCost: priced(doc.cost),
    week: {
      total: h?.total ?? 0,
      split: h?.split ?? { ...ZERO },
      cost: priced(h?.cost),
      requests: h?.split.turns ?? 0,
      days: h?.days ?? [],
    },
    weekByRepo: [...byRepo.entries()].map(([repo, v]) => ({ repo, ...v })).sort((a, b) => b.usd - a.usd),
  };
}

/**
 * This folder's seven days: summed over the repo keys that match it EXACTLY (the caller passes
 * `repoOfWorktree` of the folder and its realpath). A sub-folder opened as the workspace matches
 * only its own cwd key — no prefix matching, so it is absent rather than a wrong number.
 * Null when no key matches or nothing under it was priced.
 */
export function thisRepoWeek(s: HeadlineSummary, folderKeys: string[]): { usd: number; tok: number } | null {
  const keys = new Set(folderKeys);
  let usd = 0;
  let tok = 0;
  for (const r of s.weekByRepo) {
    if (!keys.has(r.repo)) continue;
    usd += r.usd;
    tok += r.tok;
  }
  return usd > 0 ? { usd, tok } : null;
}

/**
 * The summary while its seven days still overlap the last seven: a scan more than `HEADLINE_DAYS`
 * days old says nothing about "the last 7 days", so it is absent (the caller says "read when
 * opened"), never a stale week printed under today's label.
 */
export function currentSummary(s: HeadlineSummary | null, now: number): HeadlineSummary | null {
  return s && now - s.scannedAt <= HEADLINE_DAYS * 86_400_000 ? s : null;
}

/** The money figure, else the token count; null when the seven days hold nothing (never "$0"). */
export function weekFigure(s: HeadlineSummary): string | null {
  if (s.week.cost) return fmtUsd(s.week.cost.total);
  return s.week.total > 0 ? `${fmtCount(s.week.total)} tokens` : null;
}

/** "input $1.20 · output $3.40 · …", or the same in tokens when nothing was priced. */
export function weekSplit(s: HeadlineSummary): string {
  const c = s.week.cost;
  if (c) return `input ${fmtUsd(c.input)} · output ${fmtUsd(c.output)} · cache read ${fmtUsd(c.cacheRead)} · cache write ${fmtUsd(c.cacheWrite)}`;
  const t = s.week.split;
  return `input ${fmtCount(t.input)} · output ${fmtCount(t.output)} · cache read ${fmtCount(t.cacheRead)} · cache write ${fmtCount(t.cacheWrite)} tokens`;
}
