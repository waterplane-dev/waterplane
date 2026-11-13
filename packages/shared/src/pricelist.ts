/**
 * Reading Anthropic's own price page into rates — so a running installation
 * prices a new model, or a changed rate, the day the page says so rather than
 * the day somebody ships a release.
 *
 * Why this exists: the built-in table (`pricing.ts`) went five weeks without
 * Claude Fable 5.2 (every one of its turns unpriced) and charged Claude Sonnet
 * 5.5's cache reads at the 0.1× rule while the page said 0.05× — doubling the
 * biggest line of every Sonnet session. An open-source install cannot wait for
 * its owner to update.
 *
 * ── The source ──────────────────────────────────────────────────────────────
 *
 * `PRICE_LIST_URL` is the Markdown form of the docs pricing page. Its first
 * table states all four rates per model — base input, 5-minute write, 1-hour
 * write, cache hits, output — so nothing here is derived from a multiplier.
 *
 * ── The rule: a page we cannot read gives NO prices, never wrong ones ───────
 *
 * The page is somebody else's prose and its shape will change. So the parse is
 * strict and all-or-nothing: the header must be exactly the six columns, every
 * price cell exactly `$N / MTok`, and every row must pass the arithmetic the
 * page has always held to (5-minute write = 1.25× input, 1-hour write = 2×
 * input, a cache read no dearer than input, output no cheaper). One row that
 * fails means the columns no longer mean what we think, so the WHOLE read is
 * refused with a sentence and the host keeps what it had. A row whose NAME we
 * cannot turn into a model id is skipped, not fatal: the page grows rows for
 * things we have never logged.
 *
 * Pure: no fetch, no clock, no disk. The host owns all three (`pricefetch.ts`).
 */
import type { Rate } from "./pricing.js";

export const PRICE_LIST_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";

/** The page is ~56 KB; anything far past that is not the page. */
export const PRICE_LIST_MAX_BYTES = 1_000_000;

/** Fewer priced rows than this and the table we found is not the model table. */
const MIN_ROWS = 5;

export type PriceListParse =
  | {
      ok: true;
      /** Canonical alias → rate, `cacheRead` always set (the page states it). */
      rates: Record<string, Rate>;
      /** A model's dearer card for long prompts (Haiku 5.5 past 100K tokens).
       *  Recorded, not yet charged — the ledger does not split by prompt length. */
      longPrompt: Record<string, Rate & { overTokens: number }>;
      /** Rows skipped because their name is not a model we can key. */
      skipped: string[];
    }
  | { ok: false; why: string };

const HEADER = ["Model", "Base input tokens", "5m cache writes", "1h cache writes", "Cache hits and refreshes", "Output tokens"];

const cells = (line: string): string[] => {
  const parts = line.split("|").map((c) => c.trim());
  // A table row starts and ends with a pipe: drop the empty ends.
  return parts.slice(1, parts.length - 1);
};

/** `$0.20 / MTok<sup>1</sup>` → 0.2. Anything else → null. */
function dollars(cell: string): number | null {
  const m = /^\$(\d{1,4}(?:\.\d{1,4})?)\s*\/\s*MTok(?:\s*<sup>\d+<\/sup>)?$/.exec(cell);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 && v < 1000 ? v : null;
}

/** Longest first-column cell read; a retired-model note with a URL is well under this. */
const MODEL_CELL_MAX = 300;

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 + 1e-6 * Math.abs(b);

/**
 * `Claude Opus 4.1 ([retired, …](https://…))` → `{ id: "claude-opus-4-1" }`.
 * `Claude Haiku 5.5 (for prompts over 100,000 tokens)` → also `overTokens: 100000`.
 * Null when the name is not `Claude <Family> <version>` plus those two kinds of note.
 */
function modelOf(cell: string): { id: string; overTokens?: number; upTo?: boolean } | null {
  // No real model name is this long; bounds the regexes below on a hostile cell.
  if (cell.length > MODEL_CELL_MAX) return null;
  // A parenthesised Markdown link is a status note ("limited availability", "retired").
  let name = cell.replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "").trim();
  let overTokens: number | undefined;
  let upTo = false;
  const card = /\(for prompts (up to|over) ([\d,]+) tokens\)$/.exec(name);
  if (card) {
    name = name.slice(0, card.index).trim();
    if (card[1] === "over") overTokens = Number(card[2].replace(/,/g, ""));
    else upTo = true;
  }
  const m = /^Claude ([A-Z][a-z]+) (\d+(?:\.\d+)?)$/.exec(name);
  if (!m) return null;
  const id = `claude-${m[1].toLowerCase()}-${m[2].replace(".", "-")}`;
  return overTokens ? { id, overTokens } : { id, upTo };
}

export function parsePriceList(md: string): PriceListParse {
  if (typeof md !== "string" || !md) return { ok: false, why: "The price page came back empty." };
  if (md.length > PRICE_LIST_MAX_BYTES) return { ok: false, why: "The price page was far larger than expected, so it was not read." };
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => {
    const c = cells(l.trim());
    return c.length === HEADER.length && c.every((v, i) => v === HEADER[i]);
  });
  if (at < 0) return { ok: false, why: "The price page no longer has the model table this version knows how to read." };
  if (!/^\|\s*:?-+/.test((lines[at + 1] ?? "").trim())) return { ok: false, why: "The model table on the price page has an unexpected shape." };

  const rates: Record<string, Rate> = {};
  const longPrompt: Record<string, Rate & { overTokens: number }> = {};
  const skipped: string[] = [];
  for (let i = at + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) break;
    const c = cells(line);
    if (c.length !== HEADER.length) return { ok: false, why: "A row of the price table has the wrong number of columns." };
    const model = modelOf(c[0]);
    if (!model) { skipped.push(c[0]); continue; }
    const [input, w5m, w1h, read, output] = c.slice(1).map(dollars);
    if (input == null || w5m == null || w1h == null || read == null || output == null) {
      return { ok: false, why: `The price row for ${model.id} has a price this version cannot read.` };
    }
    if (!near(w5m, input * 1.25) || !near(w1h, input * 2) || read > input || output < input) {
      return { ok: false, why: `The price row for ${model.id} no longer adds up the way the price page always has, so none of it was used.` };
    }
    const rate: Rate = { input, output, cacheRead: read };
    if (model.overTokens) { longPrompt[model.id] = { ...rate, overTokens: model.overTokens }; continue; }
    if (rates[model.id]) return { ok: false, why: `The price page lists ${model.id} twice.` };
    rates[model.id] = rate;
  }
  if (Object.keys(rates).length < MIN_ROWS) return { ok: false, why: "The price table had too few rows to be the model table." };
  return { ok: true, rates, longPrompt, skipped };
}

/**
 * How the read list differs from the built-in table, one line per model — for
 * the maintainer script and the host's log. Never shown as a correction of
 * anybody's bill: both are list prices.
 */
export function priceListDiff(read: Record<string, Rate>, builtin: Record<string, Rate>, mult = 0.1): string[] {
  const out: string[] = [];
  for (const [id, r] of Object.entries(read)) {
    const b = builtin[id];
    if (!b) { out.push(`${id}: not in the built-in table ($${r.input}/$${r.output}, cache read $${r.cacheRead})`); continue; }
    const bRead = b.cacheRead ?? b.input * mult;
    const d: string[] = [];
    if (!near(b.input, r.input)) d.push(`input $${b.input} → $${r.input}`);
    if (!near(b.output, r.output)) d.push(`output $${b.output} → $${r.output}`);
    if (r.cacheRead != null && !near(bRead, r.cacheRead)) d.push(`cache read $${+bRead.toFixed(4)} → $${r.cacheRead}`);
    if (d.length) out.push(`${id}: ${d.join(", ")}`);
  }
  for (const id of Object.keys(builtin)) if (!read[id]) out.push(`${id}: in the built-in table, not on the page`);
  return out;
}
