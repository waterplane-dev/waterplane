/**
 * claude-local's token ledger, and the person's own price table — the two
 * halves of `GET /api/tokenstats/claude-local`.
 *
 * Beside `tokenstats.ts` rather than in it: that store is the ledger; this is
 * a CUT of what it already answers (no rescan, no second tally) plus the disk
 * half of `shared/pricing.ts`'s user table. Reasoning:
 * docs/notes/token-stats-architecture.md#local-models-all-backends-and-your-own-prices.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  addTotals, costOfAny, dayToMs, emptyUserPrices, isAnthropicModel, isPriceGap, parseUserPrices, priceGapText,
  tokenTotal, zeroTotals,
  type BackendLedgerCost, type BackendTokensDoc, type TokenStatsDoc, type TokenTotals, type UserPriceTable,
} from "@waterplane/shared";
import { env } from "./env.js";
import { configDir } from "./branddirs.js";
import { writeJsonAtomic } from "./jsonstore.js";

// ── The person's own prices, for models Anthropic's list does not name ───────
//
// `shared/pricing.ts` has the rules (`costOfAny`: the list first, the file only
// fills a gap, a kind with no rate is a gap, one currency per entry). This is
// the disk half: WHICH file, re-read when its mtime moves, and every failure a
// sentence in `problems` rather than a throw — a typo in a price file must not
// take the statistics screen with it.

/** `WATERPLANE_PRICES` (a path), else `<config dir>/prices.json`. */
export function pricesFilePath(): string {
  const o = (env("PRICES") || "").trim();
  return o || join(configDir(), "prices.json");
}

let pricesCache: { file: string; mtimeMs: number; table: UserPriceTable } | null = null;

/** The parsed table, its path, and what in it was refused. A missing file is an
 *  empty table and NO problem — not having one is the normal case. */
export function readUserPrices(): { table: UserPriceTable; file: string } {
  const file = pricesFilePath();
  let mtimeMs: number;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return { table: emptyUserPrices(), file }; }
  if (pricesCache && pricesCache.file === file && pricesCache.mtimeMs === mtimeMs) return { table: pricesCache.table, file };
  let table: UserPriceTable;
  try { table = parseUserPrices(JSON.parse(readFileSync(file, "utf8"))); }
  catch (e) { table = { entries: [], problems: [`${file} could not be read as JSON: ${(e as Error)?.message || String(e)}`] }; }
  pricesCache = { file, mtimeMs, table };
  return { table, file };
}

const LEDGER_KINDS = (t: TokenTotals): Record<string, number> =>
  ({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite });

/**
 * The NON-Anthropic models in Claude Code's own ledger, as a backend ledger —
 * what `GET /api/tokenstats/claude-local` answers.
 *
 * claude-local is the same binary pointed at another runner, so its tokens are
 * in the SAME jsonl logs this store reads: there is no second ledger to open,
 * and a second tally would drift. This is a CUT of the one ledger by model id
 * (`isAnthropicModel`), off the per-model buckets the store already keeps —
 * `models` for the all-time split, `TokenDay.byModel` for the days. The Claude
 * Code tab makes the complementary cut, so between them every token is shown
 * exactly once and never summed across the two.
 *
 * `sessions` is ABSENT: a conversation is not per model, and a count of the
 * logs a model appeared in is a different fact from what the field means.
 *
 * Money, per model, in this order: the backend's own catalogue says it runs on
 * this machine (`zeroCost`) ⇒ 0 (`source: "local"`) — first, so a price glob
 * written for a hosted twin cannot charge a loopback model; else `costOfAny`
 * (the list, then the person's file); else a SENTENCE saying how to add a
 * price. Never a guessed rate, never a $0 for "unknown".
 */
export function localSliceLedger(doc: TokenStatsDoc, opts: {
  label: string;
  prices: UserPriceTable;
  pricesFile: string;
  zeroCost: ReadonlySet<string>;
  /** The models this backend owns (`modelOwner`); absent ⇒ every non-Anthropic model. */
  keep?: (model: string) => boolean;
}): BackendTokensDoc {
  const mine = (m: string) => !isAnthropicModel(m) && (opts.keep ? opts.keep(m) : true);
  const local = doc.models.filter((g) => mine(g.key) && tokenTotal(g) > 0);
  if (local.length === 0) {
    return {
      available: false,
      reason: opts.keep
        ? `No model of ${opts.label}'s has run through Claude Code on this desktop yet — its tokens appear here once one has.`
        : `No non-Anthropic model has run through Claude Code on this desktop yet — every model in its logs is Claude's, and those are on the Claude Code tab.`,
    };
  }
  const totals = zeroTotals();
  for (const g of local) addTotals(totals, g);
  const days: Extract<BackendTokensDoc, { available: true }>["days"] = [];
  for (const d of doc.days) {
    const slices = (d.byModel ?? []).filter((s) => mine(s.model) && tokenTotal(s.totals) > 0);
    if (slices.length === 0) continue;
    const dt = zeroTotals();
    for (const s of slices) addTotals(dt, s.totals);
    days.push({
      day: d.day, kinds: LEDGER_KINDS(dt), turns: dt.turns,
      byModel: slices
        .map((s) => ({ key: s.model, kinds: LEDGER_KINDS(s.totals), turns: s.totals.turns }))
        .sort((a, b) => tokenTotalOfKinds(b.kinds) - tokenTotalOfKinds(a.kinds) || a.key.localeCompare(b.key)),
    });
  }
  const sums = new Map<string, number>();
  const models: BackendLedgerCost["models"] = local.map((g) => {
    if (opts.zeroCost.has(g.key)) {
      sums.set("USD", sums.get("USD") ?? 0);
      return { key: g.key, currency: "USD", total: 0, source: "local" as const };
    }
    const p = costOfAny(g, g.key, undefined, opts.prices);
    if (isPriceGap(p)) return { key: g.key, unpriced: priceGapText(p, opts.pricesFile) };
    sums.set(p.currency, (sums.get(p.currency) ?? 0) + p.cost.total);
    return { key: g.key, currency: p.currency, total: p.cost.total, source: p.source, ...(p.pattern ? { pattern: p.pattern } : {}) };
  });
  const cost: BackendLedgerCost = {
    totals: [...sums].map(([currency, total]) => ({ currency, total })).sort((a, b) => a.currency.localeCompare(b.currency)),
    models,
    pricesFile: opts.pricesFile,
    ...(opts.prices.problems.length ? { problems: [...opts.prices.problems] } : {}),
  };
  return {
    available: true,
    totals: { kinds: LEDGER_KINDS(totals), turns: totals.turns },
    days,
    models: local.map((g) => ({ key: g.key, label: g.label || g.key, kinds: LEDGER_KINDS(g), turns: g.turns })),
    sliceOf: `the non-Anthropic models in Claude Code's own logs — the same ledger as the Claude Code tab, which leaves them out`,
    cost,
    firstAt: days.length ? dayToMs(days[0].day) : null,
    lastAt: days.length ? dayToMs(days[days.length - 1].day) : null,
    scannedAt: doc.scannedAt,
  };
}

function tokenTotalOfKinds(k: Record<string, number>): number {
  return (k.input ?? 0) + (k.output ?? 0) + (k.cacheRead ?? 0) + (k.cacheWrite ?? 0);
}

/**
 * Which claude-jsonl backend a non-Anthropic model's tokens belong to, when
 * several write into Claude Code's one set of logs (claude-local, claude-endpoint).
 *
 * The first backend, in registry order, whose LIVE catalogue lists the model
 * owns it; else the first whose REMEMBERED catalogue (`known`, what it listed
 * before — `rememberCatalogues`) does; else the FIRST backend (claude-local: a
 * model Ollama no longer has still ran somewhere other than Anthropic). The
 * memory is what stops an endpoint's tokens migrating to the claude-local tab
 * whenever that endpoint is unreachable and its live list is empty. So every
 * token lands on exactly one tab — never on two, never summed.
 */
export function modelOwner(model: string, backends: ReadonlyArray<{ id: string; ids: readonly string[]; known?: readonly string[] }>): string | null {
  if (backends.length === 0) return null;
  return backends.find((b) => b.ids.includes(model))?.id
    ?? backends.find((b) => b.known?.includes(model))?.id
    ?? backends[0].id;
}

// ── The catalogues, remembered ──────────────────────────────────────────────
//
// A catalogue is LIVE (`backendInfos()`), and an endpoint that is down lists
// nothing. Every id a backend's catalogue has ever listed is kept here, per
// backend, so ownership survives the outage. Small, bounded (`KNOWN_CAP` per
// backend, newest first), written only when it changes, tmp+rename.

const CATALOGUE_FILE = "backend-catalogue.json";
const KNOWN_CAP = 500;
let catalogueCache: { file: string; ids: Record<string, string[]> } | null = null;

function readCatalogueFile(file: string): Record<string, string[]> {
  if (catalogueCache?.file === file) return catalogueCache.ids;
  let ids: Record<string, string[]> = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { v?: number; ids?: unknown };
    if (raw?.v === 1 && raw.ids && typeof raw.ids === "object") {
      for (const [k, v] of Object.entries(raw.ids as Record<string, unknown>)) {
        if (Array.isArray(v)) ids[k] = v.filter((x): x is string => typeof x === "string" && x !== "").slice(0, KNOWN_CAP);
      }
    }
  } catch { ids = {}; /* absent or unreadable ⇒ nothing remembered, never a throw */ }
  catalogueCache = { file, ids };
  return ids;
}

/**
 * Fold each backend's live catalogue into the remembered one (live ids first,
 * then the older ones, capped) and hand back the sharers with `known` filled.
 * A failed write keeps the in-memory memory and degrades to "remembered until
 * restart" — never a throw on a statistics read.
 */
export function rememberCatalogues<T extends { id: string; ids: readonly string[] }>(stateDir: string, sharers: readonly T[]): Array<T & { known: string[] }> {
  const file = join(stateDir, CATALOGUE_FILE);
  const mem = readCatalogueFile(file);
  let changed = false;
  for (const b of sharers) {
    if (b.ids.length === 0) continue;
    const before = mem[b.id] ?? [];
    const next = [...new Set([...b.ids, ...before])].slice(0, KNOWN_CAP);
    if (next.length !== before.length || next.some((x, i) => x !== before[i])) { mem[b.id] = next; changed = true; }
  }
  if (changed) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeJsonAtomic(file, { v: 1, ids: mem });
    } catch { /* kept in memory */ }
  }
  return sharers.map((b) => ({ ...b, known: [...(mem[b.id] ?? [])] }));
}

/** Test seam: forget the in-memory copy so the next read goes to disk. */
export function forgetCatalogueCache(): void { catalogueCache = null; }
