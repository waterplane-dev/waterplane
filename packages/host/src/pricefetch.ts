/**
 * Reading Anthropic's price page, so this desktop prices a new model or a
 * changed rate the day the page says so (the parse and its rules:
 * `@waterplane/shared`'s `pricelist.ts`; what the rates feed: `pricing.ts`).
 *
 * ── What goes over the network ──────────────────────────────────────────────
 *
 * ONE `GET` of the fixed `PRICE_LIST_URL` (HTTPS), with a generic user agent,
 * no cookies, no identifiers and nothing about this desktop in it. At boot when
 * the last good read is older than a day, then once a day, and on demand (at
 * most once an hour) when a ledger meets an Anthropic model it cannot price.
 * `WATERPLANE_PRICE_FETCH=0` stops all of it; the built-in table is then used.
 *
 * ── What is kept ────────────────────────────────────────────────────────────
 *
 * `<state dir>/pricelist.json`: the last GOOD read (rates, the long-prompt
 * cards, when) plus the last try and its failure sentence. A read that fails
 * — the network, a non-200, a body too big, or a page the parser refuses —
 * keeps what was installed and records why; it never removes a good read.
 * A cached good read is installed at boot whatever its age: a page read a
 * month ago is still nearer the truth than the table this build shipped with.
 *
 * Not imported by the ledgers (`costwindow.ts` and the context ledgers are
 * bundled into the VS Code extension): they report a gap through
 * `pricegap.ts`, which this module listens on.
 */
import { join } from "node:path";
import {
  BRAND, PRICES, PRICES_AS_OF, envName, PRICE_LIST_MAX_BYTES, PRICE_LIST_URL, installPriceList, installedPriceList, logTag, normalizeModel, parsePriceList, priceListDiff, rateFor,
  type ComplianceCheck, type Rate,
} from "@waterplane/shared";
import { env } from "./env.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import { onPriceGap } from "./pricegap.js";

export const PRICE_FETCH_FILE = "pricelist.json";
const DAY_MS = 24 * 3_600_000;
/** A good read older than this is fetched again at boot, and the daily timer's period. */
export const PRICE_REFRESH_MS = DAY_MS;
/** On-demand fetches (an unpriced model met) are at most this often. */
export const PRICE_GAP_MIN_MS = 3_600_000;
/** A gap in tokens older than this asks for nothing — a model last used months ago is history. */
export const PRICE_GAP_RECENT_MS = 7 * DAY_MS;
/** The setup check warns when the last good read is older than this. */
export const PRICE_STALE_MS = 7 * DAY_MS;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = `${BRAND.slug}-pricecheck`;

export interface PriceListState {
  /** The last good read; absent until one succeeded. */
  good?: {
    rates: Record<string, Rate>;
    longPrompt: Record<string, Rate & { overTokens: number }>;
    fetchedAt: number;
  };
  lastTryAt?: number;
  /** Why the last try failed, a sentence; absent when it succeeded. */
  lastError?: string;
  /** Anthropic models met with no rate: alias → when their newest unpriced tokens were spent. */
  gaps?: Record<string, number>;
}

/** One GET → the body text, or a failure sentence. Injected in tests: no network there. */
export type FetchText = (url: string) => Promise<{ ok: true; text: string } | { ok: false; why: string }>;

/** The real GET: fixed HTTPS URL, 20 s, no cookies (Node's fetch keeps none), a generic agent. */
export const fetchPriceText: FetchText = async (url) => {
  if (!url.startsWith("https://")) return { ok: false, why: "The price page address is not HTTPS, so it was not read." };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
      redirect: "follow",
      credentials: "omit",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    return { ok: false, why: name === "TimeoutError" || name === "AbortError"
      ? "Anthropic's price page did not answer within 20 seconds."
      : "Anthropic's price page could not be reached (no network, or the name did not resolve)." };
  }
  // Redirects are followed, but only to Anthropic's own sites over HTTPS: anything else is not the page.
  if (!priceHostOk(res.url || url)) {
    try { await res.body?.cancel(); } catch { /* nothing to free */ }
    return { ok: false, why: "The price page address led somewhere other than Anthropic's own sites, so it was not read." };
  }
  if (res.status !== 200) {
    try { await res.body?.cancel(); } catch { /* nothing to free */ }
    return { ok: false, why: `Anthropic's price page answered ${res.status} instead of the page.` };
  }
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > PRICE_LIST_MAX_BYTES) {
    try { await res.body?.cancel(); } catch { /* nothing to free */ }
    return { ok: false, why: "The price page was far larger than expected, so it was not read." };
  }
  // Read with a cap, so a page that lies about (or omits) its length still stops.
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PRICE_LIST_MAX_BYTES) {
          try { await reader.cancel(); } catch { /* nothing to free */ }
          return { ok: false, why: "The price page was far larger than expected, so it was not read." };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, why: "Anthropic's price page stopped part-way through." };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
};

/** HTTPS on claude.com or anthropic.com (or a subdomain) — where the price page may move to. */
export function priceHostOk(u: string): boolean {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === "https:" && ["claude.com", "anthropic.com"].some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch { return false; }
}

export interface PriceFetchDeps {
  /** `<state dir>`; `pricelist.json` lives here. */
  stateDir: string;
  fetchText?: FetchText;
  now?: () => number;
  /** Read at CALL time; default `WATERPLANE_PRICE_FETCH` !== "0". */
  enabled?: () => boolean;
  log?: (line: string) => void;
}

export interface PriceFetch {
  /** Install the cached good read; fetch if it is over a day old; arm the daily timer. */
  start(): Promise<void>;
  stop(): void;
  /** One read of the page now. Resolves to whether rates were installed. */
  fetchNow(): Promise<boolean>;
  /** A ledger met an unpriced Anthropic model (via `pricegap.ts`). */
  noteGap(model: string, usedAt: number): void;
  state(): PriceListState;
  enabled(): boolean;
}

/** Whether `WATERPLANE_PRICE_FETCH` leaves fetching on (it is on unless `0`). */
export const priceFetchEnabled = (): boolean => env("PRICE_FETCH")?.trim() !== "0";

/** The long-prompt cards of a stored read, each one whole or dropped (a read from before they were kept has none). */
function cleanLongCards(v: unknown): Record<string, Rate & { overTokens: number }> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  const out: Record<string, Rate & { overTokens: number }> = {};
  for (const [id, c] of Object.entries(v as Record<string, Partial<Rate & { overTokens: number }>>)) {
    if (c && ok(c.input) && ok(c.output) && ok(c.overTokens) && (c.cacheRead == null || ok(c.cacheRead))) {
      out[id] = { input: c.input, output: c.output, overTokens: c.overTokens, ...(c.cacheRead != null ? { cacheRead: c.cacheRead } : {}) };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

const accept = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);

export function createPriceFetch(deps: PriceFetchDeps): PriceFetch {
  const file = join(deps.stateDir, PRICE_FETCH_FILE);
  const fetchText = deps.fetchText ?? fetchPriceText;
  const now = deps.now ?? Date.now;
  const enabled = deps.enabled ?? priceFetchEnabled;
  const log = deps.log ?? ((l: string) => console.log(`${logTag} ${l}`));
  let st: PriceListState = readJsonGuarded<PriceListState>(file, {}, accept);
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<boolean> | null = null;

  const save = () => {
    try { writeJsonAtomic(file, st); } catch (e) { log(`price list: could not save ${file}: ${(e as Error).message}`); }
  };
  const install = (g: NonNullable<PriceListState["good"]>) => installPriceList({ rates: g.rates, longPrompt: cleanLongCards(g.longPrompt), fetchedAt: g.fetchedAt });

  async function readOnce(): Promise<boolean> {
    const at = now();
    const got = await fetchText(PRICE_LIST_URL).catch((): { ok: false; why: string } => ({ ok: false, why: "Anthropic's price page could not be read." }));
    const parsed = got.ok ? parsePriceList(got.text) : null;
    if (!got.ok || !parsed || !parsed.ok) {
      const why = !got.ok ? got.why : parsed && !parsed.ok ? parsed.why : "The price page could not be read.";
      st = { ...st, lastTryAt: at, lastError: why };
      save();
      log(`price list: kept ${st.good ? `the read of ${new Date(st.good.fetchedAt).toISOString().slice(0, 10)}` : "the built-in prices"} — ${why}`);
      return false;
    }
    const before: Record<string, Rate> = st.good?.rates ?? PRICES;
    const changed = priceListDiff(parsed.rates, before);
    st = { ...st, good: { rates: parsed.rates, longPrompt: parsed.longPrompt, fetchedAt: at }, lastTryAt: at, lastError: undefined };
    // A model the page now prices is no longer a gap.
    if (st.gaps) for (const id of Object.keys(st.gaps)) if (parsed.rates[id]) delete st.gaps[id];
    save();
    install(st.good!);
    if (changed.length) {
      log(`price list: read ${Object.keys(parsed.rates).length} models off Anthropic's price page; against ${before === PRICES ? `the built-in table (${PRICES_AS_OF})` : "the previous read"}:`);
      for (const l of changed) log(`  ${l}`);
    }
    return true;
  }

  function fetchNow(): Promise<boolean> {
    if (!enabled()) return Promise.resolve(false);
    inFlight ??= readOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    async start() {
      // Off means the built-in table, not a frozen cache of an old read.
      if (!enabled()) { installPriceList(null); return; }
      if (st.good && st.good.rates && typeof st.good.fetchedAt === "number") install(st.good);
      if (!st.good || now() - st.good.fetchedAt > PRICE_REFRESH_MS) await fetchNow();
      timer ??= setInterval(() => { void fetchNow(); }, PRICE_REFRESH_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    fetchNow,
    noteGap(model, usedAt) {
      const t = now();
      if (!Number.isFinite(usedAt) || t - usedAt > PRICE_GAP_RECENT_MS) return;
      // Keyed by the canonical alias, as the page's rates are, so a read that prices the model clears it.
      const id = normalizeModel(model) ?? model;
      const gaps = (st.gaps ??= {});
      if (!(gaps[id] >= usedAt)) { gaps[id] = usedAt; save(); }
      // At most one read an hour, counted from the last try of ANY kind (boot, daily, a gap) and
      // persisted with it, so a restart does not reset the limit.
      if (!enabled() || t - (st.lastTryAt ?? 0) < PRICE_GAP_MIN_MS) return;
      void fetchNow();
    },
    state: () => st,
    enabled,
  };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The desktop's `price-list` row. Sentences only — nothing here fetches or
 * changes a price. Warn when the last good read is over a week old while
 * fetching is on, or when an Anthropic model was unpriced in the last week.
 */
export function priceListRow(st: PriceListState, enabled: boolean, now = Date.now()): ComplianceCheck {
  const base = { id: "price-list", label: "Model prices", scope: "host" as const, fix: null };
  if (!enabled) {
    return { ...base, status: "pass",
      detail: `Built-in prices dated ${PRICES_AS_OF} are used, because ${envName("PRICE_FETCH")}=0 turns off reading Anthropic's price page.` };
  }
  // A model priced since (by a read, or a built-in row) is no longer a gap, whatever the file still says.
  const gaps = Object.entries(st.gaps ?? {})
    .filter(([m, at]) => now - at <= PRICE_GAP_RECENT_MS && rateFor(m) == null).map(([m]) => m).sort();
  const lines: string[] = [];
  let warn = false;
  if (gaps.length) {
    warn = true;
    lines.push(...gaps.map((m) => `${m} is not on Anthropic's price page yet; its tokens are counted but not priced.`));
  }
  const g = st.good;
  if (!g) {
    warn = true;
    lines.push(`Anthropic's price page has not been read yet, so built-in prices dated ${PRICES_AS_OF} are used.` +
      (st.lastError ? ` Last try: ${st.lastError}` : ""));
  } else if (now - g.fetchedAt > PRICE_STALE_MS) {
    warn = true;
    lines.push(`Prices were last read from Anthropic's price page on ${day(g.fetchedAt)}, over a week ago.` +
      (st.lastError ? ` Last try: ${st.lastError}` : ""));
  } else {
    lines.unshift(`Prices read from Anthropic's price page on ${day(g.fetchedAt)}.`);
  }
  return { ...base, status: warn ? "warn" : "pass", detail: lines.join(" ") };
}

// ── The daemon's one instance ──────────────────────────────────────────────

let live: PriceFetch | null = null;

/** Boot: create the instance, listen for gaps, install the cache and maybe fetch. Never throws. */
export function startPriceFetch(stateDir: string): PriceFetch {
  live?.stop();
  live = createPriceFetch({ stateDir });
  const pf = live;
  onPriceGap((model, usedAt) => pf.noteGap(model, usedAt));
  void pf.start().catch(() => undefined);
  return pf;
}

/** The `welcome` field: the installed read, absent when the host prices from its built-in table. */
export function welcomePrices(): { prices?: { rates: Record<string, Rate>; longPrompt?: Record<string, Rate & { overTokens: number }>; fetchedAt: number } } {
  const p = installedPriceList();
  return p ? { prices: { rates: p.rates, ...(p.longPrompt ? { longPrompt: p.longPrompt } : {}), fetchedAt: p.fetchedAt } } : {};
}

/** The desktop row, or null when the daemon did not start the reader (a test, `--doctor`). */
export function livePriceListRow(): ComplianceCheck | null {
  return live ? priceListRow(live.state(), live.enabled()) : null;
}
