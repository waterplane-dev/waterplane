/**
 * What the tokens would have cost at Anthropic's published list prices.
 *
 * ── What this number IS, and what it is not ─────────────────────────────────
 *
 * It is a COUNTERFACTUAL: what the same traffic would have cost billed through
 * the API at standard pay-as-you-go rates. It is almost certainly not what
 * anybody paid — this app drives the Claude CLI, which most people run on a
 * subscription, and a subscription is a flat fee no matter how many tokens go
 * through it. Every surface that shows this must say so; a dollar figure with
 * no framing is read as a bill.
 *
 * The earlier version of the statistics screen showed no prices at all, on the
 * grounds that cost "depends on the plan, the model and the cache tier". Two of
 * those three turned out to be answerable from the logs — the model is on every
 * turn and the cache tier is in the usage block — so the honest position moved:
 * compute it, and be precise about the one thing that is genuinely unknown (the
 * plan) by not claiming to know it.
 *
 * ── The four rates, and why the cache ones matter most here ─────────────────
 *
 * Two numbers are published per model — an input rate and an output rate, per
 * million tokens — and the price list then states the two cache rates in the
 * same units. For every model but two they are exactly multipliers ON the
 * input rate, so that is how they are carried:
 *
 *   cache read      0.1×   — a tenth of input
 *   cache write 5m  1.25×
 *   cache write 1h  2×
 *
 * **The exception is read off the list, not inferred.** Claude Fable 5.1 reads
 * the cache at $0.25/MTok against a $10 input rate — 0.025×, a QUARTER of what
 * the 0.1× rule would charge — so `PriceEntry.cacheRead` overrides the
 * multiplier where the published number disagrees with it. On this app's shape
 * of traffic that is not a rounding detail: 96% of all tokens are cache reads,
 * so a model priced by the rule alone comes out roughly four times too dear.
 *
 * Getting the write TTL right is not a rounding detail either. Measured across
 * one machine's whole corpus, **84% of cache writes were 1-hour** — so pricing
 * every write at the 1.25× default understates that line by ~60%. The usage
 * block carries the split (`cache_creation.ephemeral_1h_input_tokens` /
 * `…_5m_…`) and it was present on 100% of records, so nothing has to be
 * assumed. The published cache prices are the 5-minute TTL; the 1-hour tier is
 * the 2× rule on every model the list prices, including Fable 5.1's, whose
 * discount the list applies to READS only.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *
 * - **An unknown model prices to null, never to a guess.** A rate table goes
 *   stale the week after it is written, and a model missing from it must show
 *   up as unpriced usage the screen can name — not as a silent zero, which
 *   reads as "this was free".
 * - **Rates can change over time, so a rate is asked for A DAY.** No model on
 *   today's list carries an introductory price, but one did — Claude Sonnet 5
 *   was read as $3/$15 after 2026-08-31 by a table written before the list
 *   settled at $2/$10, and every Sonnet session since was charged half again
 *   too much. `intro` stays because that is the shape a change takes; the day
 *   is the local bucket the counts are already in.
 * - **Fast mode is NOT in this table.** Opus 5 at `speed: "fast"` bills
 *   $10/$50 rather than $5/$25, and the conversation log does not record which
 *   speed a turn ran at. Priced here at the standard rate, which is the
 *   conservative direction and is what every surface's "list-price estimate"
 *   wording already covers.
 * - **Prices are cached, not live** (source: claude.com/pricing#api, read
 *   2026-09-19, cross-checked against the `claude-api` skill's model table;
 *   Opus 5.5 added 2026-09-24 from that skill's table — $4/$20, cache read
 *   $0.20 — when sessions started logging `claude-opus-5-5` and every one of
 *   them fell back to a token total beside priced siblings; Haiku 5.5 added
 *   2026-10-09 from the same skill's table and its migration notes — $0.10/
 *   $0.50 at a prompt of 100K tokens or fewer, cache at the multipliers —
 *   after 1.1M of its tokens sat unpriced in one week).
 *   `PRICES_AS_OF` is carried to the UI so the screen can say how old the
 *   table is rather than implying it is current.
 */

/** When this table was taken. Shown, so a stale rate is visible rather than
 *  silently authoritative. */
export const PRICES_AS_OF = "2026-10-09";

/** Multipliers on a model's INPUT rate. */
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;

export interface Rate {
  /** USD per million tokens. */
  input: number;
  output: number;
  /**
   * The published cache-READ rate, USD per million, where the list states one
   * that is not `input × CACHE_READ_MULT`.
   *
   * Absent means the multiplier — every model but Fable 5.1 and Opus 5.5. Carried
   * as an absolute rate rather than as a per-model multiplier because that is
   * how the price list states it, and a second derivation is a second place to
   * get it wrong.
   */
  cacheRead?: number;
}

interface PriceEntry extends Rate {
  /** An introductory price, in force up to and including `until` (`YYYY-MM-DD`). */
  intro?: Rate & { until: string };
}

/**
 * List prices, USD per million tokens, keyed by the CANONICAL model alias.
 *
 * Only first-party Anthropic API rates. Bedrock and Vertex are partner-operated
 * with their own pricing and are not represented — a conversation run through
 * one of those would be priced wrongly here, which is why the screen calls this
 * a list-price estimate rather than a cost.
 *
 * The Mythos ids are the two the list does NOT price (they are not on the
 * public page at all). They are kept at their Fable twins' input/output rates,
 * which is what the model documentation states — but Fable 5.1's cache-read
 * discount is deliberately NOT extended to `claude-mythos-5-1`: that number is
 * unstated for it, and the 0.1× rule is the one that errs dear rather than
 * cheap.
 */
export const PRICES: Record<string, PriceEntry> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  // Two published cards, chosen by PROMPT length: $0.10/$0.50 up to a 100K-token
  // prompt, $0.50/$2.50 above it. This table prices buckets, not requests, so
  // it carries the short card and a longer prompt is UNDER-priced (5×) — the
  // fast-mode stance, and measured 0 of 106 haiku-5-5 requests here past 100K
  // (2026-10-09). Splitting the long card out needs the scan to tally those
  // requests under their own key; until then this is the one known floor.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * The alias a logged model id prices under, or null when it is not one of ours.
 *
 * The log records what the API returned, which is not always the alias the
 * table is keyed by: a date suffix (`claude-haiku-4-5-20251001`) and the
 * long-context marker (`claude-opus-5[1m]`, which is the same model at the same
 * price) both appear. `<synthetic>` — the CLI's own usage-wall turns — is
 * deliberately not a model.
 */
export function normalizeModel(model: string | null | undefined): string | null {
  if (!model) return null;
  let id = model.trim().toLowerCase();
  if (!id || !id.startsWith("claude-")) return null;
  id = id.replace(/(\[1m\]|-1m)$/, "");         // context variant, same price
  id = id.replace(/-\d{8}$/, "");                // dated snapshot → alias
  return id;
}

/** The rate for a model on a given day, or null when we have no list price.
 *  `day` is `YYYY-MM-DD`; omit it to get the current (non-intro) rate. */
export function rateFor(model: string | null | undefined, day?: string): Rate | null {
  const id = normalizeModel(model);
  if (!id) return null;
  const p = PRICES[id];
  if (!p) return null;
  // Lexicographic compare is correct for `YYYY-MM-DD` and needs no parsing —
  // and no zone, which matters because the day buckets are already local.
  const r = p.intro && day && day <= p.intro.until ? p.intro : p;
  // Spread out by hand rather than returned whole: `intro` must not ride along
  // on a rate, and an absent `cacheRead` has to stay ABSENT (the multiplier),
  // never an explicit `undefined` a caller's `??` would read past and a
  // `deepEqual` would not.
  return r.cacheRead != null
    ? { input: r.input, output: r.output, cacheRead: r.cacheRead }
    : { input: r.input, output: r.output };
}

/** Whether a model has a published list price at all. */
export function isPriced(model: string | null | undefined): boolean {
  return rateFor(model) != null;
}

/** The counts one cost calculation needs. A subset of `TokenTotals`, spelled
 *  out so this module does not depend on the wire types. */
export interface Priceable {
  input: number;
  output: number;
  cacheRead: number;
  /** ALL cache writes, both tiers. */
  cacheWrite: number;
  /** The portion of `cacheWrite` written at the 1-hour TTL (2× rather than
   *  1.25×). Never larger than `cacheWrite`. */
  cacheWrite1h: number;
}

/** What each kind cost, in USD. Kept apart for the same reason the token kinds
 *  are: one number cannot be un-summed, and cache read is most of the tokens
 *  while output is most of the money. */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function zeroCost(): CostBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.total += b.total;
  return a;
}

/**
 * Price one bucket of counts for one model on one day.
 *
 * Null — not zero — when the model has no published rate. Zero is a claim that
 * it was free; null is the truth, and it is what lets the caller total up the
 * usage it could not price and say so on screen.
 */
export function costOf(t: Priceable, model: string | null | undefined, day?: string): CostBreakdown | null {
  const rate = rateFor(model, day);
  if (!rate) return null;
  const per = (tok: number, usdPerM: number) => (tok / 1_000_000) * usdPerM;
  // The 1-hour portion is a SUBSET of `cacheWrite`, so the 5-minute part is the
  // remainder. Clamped: a malformed record must not make the cheaper tier
  // negative and quietly reduce the bill.
  const w1h = Math.max(0, Math.min(t.cacheWrite1h, t.cacheWrite));
  const w5m = Math.max(0, t.cacheWrite - w1h);
  // The published rate where the list gives one, the multiplier otherwise —
  // see the header. Fable 5.1's read is 0.025× of input, and charging it the
  // 0.1× rule would make the dominant line of the bill four times too big.
  const readRate = rate.cacheRead ?? rate.input * CACHE_READ_MULT;
  const cost: CostBreakdown = {
    input: per(t.input, rate.input),
    output: per(t.output, rate.output),
    cacheRead: per(t.cacheRead, readRate),
    cacheWrite: per(w5m, rate.input * CACHE_WRITE_5M_MULT) + per(w1h, rate.input * CACHE_WRITE_1H_MULT),
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return cost;
}

/**
 * `$1,284.40` / `$4.21` / `$0.0031` / `$0`.
 *
 * Cents for anything a person would recognise as an amount, and four decimals
 * below one cent — a per-day figure on a quiet day is genuinely fractions of a
 * cent, and "$0.00" beside a bar that is visibly there reads as "free".
 */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  const a = Math.abs(n);
  if (a < 0.01) return `$${n.toFixed(4)}`;
  if (a < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

/** The same, compact enough for a chart axis: `$1.2k` / `$421` / `$4.21`. */
export function fmtUsdShort(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1000) return `$${(n / 1000).toFixed(a >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  if (a >= 10) return `$${Math.round(n)}`;
  if (a === 0) return "$0";
  if (a < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

// ── Prices a PERSON supplied, for models this table does not price ──────────
//
// The table above is Anthropic's list and nothing else. A hosted open model
// (Bedrock, Vertex, OpenRouter, a rented GPU behind an OpenAI-shaped URL) has a
// real price too, but it is the operator's, it changes per contract, and this
// file is the wrong place to guess it. So the person states it, in a JSON file
// (`prices.json` in the waterplane config dir, or the path in
// `WATERPLANE_PRICES`):
//
//   { "qwen3-coder:*": { "input": 0.2, "output": 0.8, "cacheRead": 0.02, "currency": "USD" } }
//
// Rules, each the same rule the list prices follow:
//
//  - **It only fills a GAP.** `costOfAny` asks `costOf` first; a model the list
//    prices is priced by the list whatever the file says, so no Claude result
//    can move because somebody wrote a glob too wide.
//  - **No entry ⇒ a gap**, never zero, and the caller says how to add one.
//  - **A kind with tokens and no rate in the entry ⇒ a gap**, naming the kind.
//    Charging an open model's cache reads at its input rate (or at nothing) is
//    a guess about somebody else's price list.
//  - **One currency per entry, never converted.** A total across entries in two
//    currencies is two totals (`addPriced`).

/** One person-supplied rate, per MILLION tokens, in `currency`. */
export interface UserRate {
  input: number;
  output: number;
  /** Absent ⇒ cache reads cannot be priced for this model (never 0.1× of input). */
  cacheRead?: number;
  /** Absent ⇒ cache writes cannot be priced for this model. One rate for both TTL tiers. */
  cacheWrite?: number;
  /** As written, upper-cased (`USD`, `EUR`). Absent in the file ⇒ `USD`, the
   *  unit of every other figure here and the one the docs state. */
  currency: string;
}

/** A parsed table: patterns in the order they are tried (exact ids first,
 *  then globs, most literal characters first — the most specific line wins). */
export interface UserPriceTable {
  entries: { pattern: string; rate: UserRate }[];
  /** Entries of the file that were refused, each a sentence naming the key. */
  problems: string[];
}

export function emptyUserPrices(): UserPriceTable {
  return { entries: [], problems: [] };
}

const finiteRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Read a person's price file (already JSON-parsed). Never throws: a bad entry is
 * dropped WITH a sentence, a bad file is an empty table with one.
 */
export function parseUserPrices(raw: unknown): UserPriceTable {
  const out = emptyUserPrices();
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    out.problems.push("the price file is not a JSON object of model id → rates");
    return out;
  }
  for (const [pattern, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = pattern.trim();
    if (!key) { out.problems.push("an entry with an empty model id was skipped"); continue; }
    if (!v || typeof v !== "object" || Array.isArray(v)) { out.problems.push(`"${key}": not an object of rates`); continue; }
    const r = v as Record<string, unknown>;
    if (!finiteRate(r.input) || !finiteRate(r.output)) {
      out.problems.push(`"${key}": needs numeric "input" and "output" (price per million tokens)`);
      continue;
    }
    const bad = (["cacheRead", "cacheWrite"] as const).filter((k) => r[k] !== undefined && !finiteRate(r[k]));
    if (bad.length) { out.problems.push(`"${key}": ${bad.join(" and ")} must be a non-negative number`); continue; }
    if (r.currency !== undefined && (typeof r.currency !== "string" || !r.currency.trim())) {
      out.problems.push(`"${key}": "currency" must be a code such as "USD"`);
      continue;
    }
    const rate: UserRate = {
      input: r.input, output: r.output,
      currency: typeof r.currency === "string" ? r.currency.trim().toUpperCase() : "USD",
    };
    if (r.cacheRead !== undefined) rate.cacheRead = r.cacheRead as number;
    if (r.cacheWrite !== undefined) rate.cacheWrite = r.cacheWrite as number;
    out.entries.push({ pattern: key, rate });
  }
  const isGlob = (p: string) => p.includes("*");
  out.entries.sort((a, b) =>
    Number(isGlob(a.pattern)) - Number(isGlob(b.pattern))
    || b.pattern.replace(/\*/g, "").length - a.pattern.replace(/\*/g, "").length
    || a.pattern.localeCompare(b.pattern));
  return out;
}

/** `*` matches any run of characters; everything else is literal, case-insensitive. */
export function globMatch(pattern: string, id: string): boolean {
  const body = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`, "i").test(id);
}

/** The person's rate for a model id, or null. Exact (case-insensitive) beats a glob. */
export function userRateFor(table: UserPriceTable | null | undefined, model: string | null | undefined): { pattern: string; rate: UserRate } | null {
  if (!table || !model) return null;
  const id = model.trim();
  for (const e of table.entries) if (globMatch(e.pattern, id)) return e;
  return null;
}

/** A cost with the unit it is in, and whose price it was. */
export interface PricedCost {
  currency: string;
  cost: CostBreakdown;
  source: "list" | "user";
  /** The table line that priced it, for `source: "user"`. */
  pattern?: string;
}

/** Why a bag could not be priced. */
export interface PriceGap { model: string; why: "no-entry" | "missing-kinds"; kinds?: string[] }

/**
 * Price a bag of counts with the list where the list has the model, else with
 * the person's table. `costOf` is consulted FIRST and its answer returned
 * unchanged — the file cannot reprice a model the list knows.
 */
export function costOfAny(t: Priceable, model: string | null | undefined, day: string | undefined, table: UserPriceTable | null | undefined): PricedCost | PriceGap {
  const list = costOf(t, model, day);
  if (list) return { currency: "USD", cost: list, source: "list" };
  const name = model ?? "";
  const hit = userRateFor(table, model);
  if (!hit) return { model: name, why: "no-entry" };
  const r = hit.rate;
  const missing: string[] = [];
  if (t.cacheRead > 0 && r.cacheRead == null) missing.push("cacheRead");
  if (t.cacheWrite > 0 && r.cacheWrite == null) missing.push("cacheWrite");
  if (missing.length) return { model: name, why: "missing-kinds", kinds: missing };
  const per = (tok: number, perM: number) => (tok / 1_000_000) * perM;
  const cost: CostBreakdown = {
    input: per(t.input, r.input),
    output: per(t.output, r.output),
    cacheRead: t.cacheRead > 0 ? per(t.cacheRead, r.cacheRead!) : 0,
    cacheWrite: t.cacheWrite > 0 ? per(t.cacheWrite, r.cacheWrite!) : 0,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return { currency: r.currency, cost, source: "user", pattern: hit.pattern };
}

export function isPriceGap(x: PricedCost | PriceGap): x is PriceGap {
  return "why" in x;
}

/** Fold a priced cost into one total PER CURRENCY — never converted, never summed across. */
export function addPriced(into: Map<string, number>, p: PricedCost): Map<string, number> {
  into.set(p.currency, (into.get(p.currency) ?? 0) + p.cost.total);
  return into;
}

/** The one wording of a price gap, with how to close it. `where` is the file the host reads. */
export function priceGapText(g: PriceGap, where: string): string {
  if (g.why === "missing-kinds") {
    const ks = g.kinds ?? [];
    return `${g.model}: your price entry has no rate for ${ks.join(" and ")}, which this model used — add ${ks.map((k) => `"${k}"`).join(" and ")} to its entry in ${where}.`;
  }
  return `${g.model}: no price — add "${g.model}": {"input": …, "output": …, "cacheRead": …, "cacheWrite": …, "currency": "USD"} (per million tokens) to ${where}.`;
}

/** `12.40 EUR` / `$12.40` — a user-priced amount in its own currency. */
export function fmtMoney(n: number, currency: string): string {
  if (currency === "USD") return fmtUsd(n);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return `0 ${currency}`;
  const a = Math.abs(n);
  return `${a < 0.01 ? n.toFixed(4) : a < 1000 ? n.toFixed(2) : Math.round(n).toLocaleString()} ${currency}`;
}

/**
 * Whether a logged model id is ANTHROPIC'S — Claude, wherever it was served.
 *
 * Wider than `normalizeModel` on purpose: a Bedrock, Vertex or OpenRouter id
 * (`us.anthropic.claude-sonnet-4-5-…`, `anthropic/claude-sonnet-4.5`) is not
 * on the list but is still a Claude model and belongs on the Claude view,
 * unpriced. Everything else in Claude Code's log — an Ollama tag such as
 * `qwen3-coder:30b-64k`, an OpenRouter `qwen/qwen3-coder` — is another
 * vendor's model the CLI was pointed at.
 */
export function isAnthropicModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const id = model.trim().toLowerCase();
  if (id === "<synthetic>") return true;
  return /(^|[./:@])(anthropic\.)?claude-/.test(id);
}
