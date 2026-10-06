/**
 * A fictional, self-consistent token ledger for the demo's Token usage screen.
 *
 * ── Why generate RECORDS and not the document ───────────────────────────────
 *
 * The real host folds per-conversation hour×model tallies into every figure on
 * the screen (`packages/host/src/tokenstats.ts` `aggregate()`), which is why no
 * two of them can disagree. This does the same over synthetic tallies: one
 * deterministic pass makes ~300 conversations and their subagents, and EVERY
 * output — the document, the window grids, the usage log — is a fold of that
 * one list. Nothing here is typed in as a total.
 *
 * ── Why HEAVY ───────────────────────────────────────────────────────────────
 *
 * The screen exists for the person whose bill is dominated by a few long
 * conversations, so the fortnight has the SHAPE of a measured heavy desktop
 * (four months, ~16k USD at list price): cache reads hundreds of times the
 * output, writes a few percent of the tokens and a third of the money, agents a
 * third to a half, an expired-cache premium of a few percent, and six long
 * conversations (`MARATHONS`, shaped on the dearest real ones) on top. A small,
 * cheap fortnight would leave every insight on the screen below its threshold.
 *
 * Semantics copied from the host, field by field:
 *  - `totals`, `models`, `repos`, `hourOfDay`, `days` and `hours` are all sums of the same
 *    cells, so they agree to the token. The span is the last 14 LOCAL days ending today
 *    (the host's `HOURS_DAYS` window), so `hours` is NOT a subset of the days here — it covers
 *    the whole record, and `hourOfDay` (all-time on the host) equals `totals` for the same reason.
 *    That fortnight is also what the weekly limit grid needs a week of.
 *  - every cost is `costOf(tokens, model, day)` per (hour, model) cell, summed with `addCost`;
 *    a figure is never priced from a day row that has lost its model.
 *  - subagent files are a slice OF the totals, dated by their earliest hour.
 *
 * Determinism: output depends only on `now`, and only through the LOCAL HOUR it falls in (plus
 * `scannedAt`), so a screen that re-reads does not see the ledger reshuffle. Local zone, like the
 * real ledger's day keys.
 *
 * Every figure is invented and shows under the always-on demo line. Models are real priced ids
 * (`PRICES`) so `costOf` prices them; repo paths are the demo's three fictional repos (duplicated
 * from scenarios/garden.ts — demo/host may not import scenarios).
 */
import {
  PRICES_AS_OF, addCost, addTotals, costOf, dayToMs, hourToMs, isPriced, normalizeModel, tokenTotal, zeroCost, zeroTotals,
  type CostBreakdown, type TokenConvo, type TokenDay, type TokenGroup, type TokenHour, type TokenHourSlot,
  type TokenStatsDoc, type TokenTotals, type TokenWindow, type TokenWindowSeries, type TokenWindowsDoc, type UsageHistoryDoc,
  type UsageSample,
} from "@waterplane/shared";

const GARDEN = "~/dev/todo-garden";
const NOTES = "~/dev/pocket-notes";
const TRAIL = "~/dev/trail-log";

/** The models the ledger runs, all real ids `costOf` prices. No local model: a real ledger with one
 *  leads the screen with a sentence about it, which is not what the demo is for. */
export const LEDGER_OPUS = "claude-opus-5";
const OPUS_55 = "claude-opus-5-5";
const FABLE = "claude-fable-5";
const FABLE_51 = "claude-fable-5-1";
const SONNET = "claude-sonnet-5";
export const LEDGER_SONNET = "claude-sonnet-5-5";
export const LEDGER_HAIKU = "claude-haiku-4-5";

/** Days of record, today included. */
export const LEDGER_DAYS = 14;
const HOUR = 3_600_000;
const SEED = 20_261_002;
/** Fast-mode turns the ledger claims (counted, never priced — the screen says so). */
const FAST_TURNS = 3;
/** The host's `TOP_CONVOS`. */
const TOP = 12;
/** What a fresh session on this desktop starts with — CLAUDE.md, skills, tools (measured: 56k). */
const BASE_TOK = 56_000;
/** A subagent's own starting window: the baseline without the parent's conversation. */
const AGENT_BASE_TOK = 24_000;
/** Requests an agent makes per hour while it runs. */
const AGENT_RATE = 120;
/** A pause longer than the cache's hour: the next request re-writes the whole window. */
const MIN_GAP_H = 1.6;

/** What each repo's conversations were about, in the demo's own vocabulary. */
const TITLES: Record<string, string[]> = {
  [GARDEN]: [
    "make overdue tasks show a red edge", "group the tasks by day", "add a swipe to complete",
    "persist the filter between launches", "tidy the empty state", "speed up the list on 2,000 tasks",
    "recurring tasks every second Tuesday", "undo for a deleted task", "drag to reorder within a day",
  ],
  [NOTES]: [
    "the markdown export drops the title", "search should ignore accents", "pin a note to the top",
    "autosave loses the last word", "dark theme for the editor", "tags with a colour each",
  ],
  [TRAIL]: [
    "import a GPX file and draw the route", "elevation profile under the map", "show distance per hour",
    "merge two hikes into one", "offline map tiles", "photos pinned to the route",
  ],
};

/**
 * The long conversations, placed by hand: in real use a handful of them carry the bill, and a
 * random fortnight of ordinary sessions would never show it. Their shapes follow measured heavy
 * sessions (hours, requests, agents, how deep the window ran); the work and the repos are invented.
 * `back` is days before today, `at` the local hour the first prompt went in.
 */
interface Marathon {
  repo: string; title: string; back: number; at: number; spanH: number; sittings: number;
  model: string; turns: number; peak: number;
  agents: number; agentTurns: number; agentPeak: number;
}
const MARATHONS: Marathon[] = [
  { repo: GARDEN, title: "rewrite the sync engine for offline edits", back: 9, at: 9, spanH: 25, sittings: 4,
    model: LEDGER_OPUS, turns: 361, peak: 430_000, agents: 28, agentTurns: 120, agentPeak: 420_000 },
  { repo: GARDEN, title: "move every screen to the new design tokens", back: 4, at: 8, spanH: 14, sittings: 3,
    model: LEDGER_OPUS, turns: 198, peak: 360_000, agents: 33, agentTurns: 107, agentPeak: 400_000 },
  { repo: NOTES, title: "end-to-end encryption for shared notebooks", back: 13, at: 10, spanH: 93, sittings: 26,
    model: LEDGER_OPUS, turns: 319, peak: 640_000, agents: 18, agentTurns: 132, agentPeak: 460_000 },
  { repo: GARDEN, title: "split the 3,000-line store into modules", back: 2, at: 9, spanH: 10, sittings: 2,
    model: LEDGER_OPUS, turns: 324, peak: 300_000, agents: 34, agentTurns: 74, agentPeak: 300_000 },
  { repo: TRAIL, title: "find why the route drifts on long hikes", back: 7, at: 13, spanH: 26, sittings: 5,
    model: LEDGER_OPUS, turns: 626, peak: 820_000, agents: 0, agentTurns: 0, agentPeak: 0 },
  { repo: NOTES, title: "a plugin API for custom note types", back: 12, at: 15, spanH: 82, sittings: 9,
    model: LEDGER_OPUS, turns: 380, peak: 420_000, agents: 6, agentTurns: 112, agentPeak: 380_000 },
];

/** mulberry32: small, fast, and identical on every JS engine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DDTHH`, local — the host's hour key. */
function localHour(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
}
function hourFloorMs(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** One (hour, model) bucket of one file, the host's `Tally` with names. */
interface Cell { hour: string; model: string; t: TokenTotals }
interface Cold { hour: string; model: string; count: number; tok: number; tok1h: number }
/** One conversation log or one subagent transcript. */
interface LogFile { convo: string; title: string; sub: boolean; repo: string; cells: Cell[]; cold: Cold[] }

/** When the work happens, by local hour: mornings, afternoons and a long evening. */
const HOUR_WEIGHT = [
  1.5, 0.9, 0.3, 0.15, 0.1, 0.1, 1.4, 2, 4.1, 6.2, 11.8, 11.5,
  10.1, 8.5, 9.3, 10.3, 11.8, 10.3, 6, 7.2, 15.3, 15.5, 13.6, 3.3,
];

/** One conversation to emit: its own requests and its agents', in sittings with gaps between. */
interface Plan {
  repo: string; title: string; start: number; spanH: number; sittings: number;
  model: string; turns: number; base: number; peak: number; oneHour: boolean;
  agents: { model: string; turns: number; peak: number }[];
}

function generate(anchor: number): LogFile[] {
  const rng = prng(SEED);
  const pick = <T>(xs: readonly T[], ws: readonly number[]): T => {
    let r = rng() * ws.reduce((a, b) => a + b, 0);
    for (let i = 0; i < xs.length; i++) { r -= ws[i]; if (r < 0) return xs[i]; }
    return xs[xs.length - 1];
  };
  const between = (lo: number, hi: number) => lo + rng() * (hi - lo);
  const files: LogFile[] = [];
  const today = new Date(anchor);
  today.setHours(0, 0, 0, 0);
  const dayAt = (back: number, h = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, h).getTime();
  let n = 0;
  const used = new Map<string, number>();
  const titleFor = (repo: string) => {
    const k = used.get(repo) ?? 0;
    used.set(repo, k + 1);
    return TITLES[repo][k % TITLES[repo].length];
  };
  const agentModel = () => pick([LEDGER_OPUS, SONNET, FABLE, FABLE_51, LEDGER_HAIKU], [0.5, 0.33, 0.06, 0.06, 0.05]);

  const emit = (p: Plan) => {
    const id = `demo-tok-${n++}`;
    const cells = new Map<string, Cell>();
    const cold: Cold[] = [];
    const add = (into: Map<string, Cell>, at: number, mdl: string, t: Partial<TokenTotals>) => {
      const hour = localHour(Math.min(at, anchor));
      const key = `${hour}\u0000${mdl}`;
      const cell = into.get(key) ?? into.set(key, { hour, model: mdl, t: zeroTotals() }).get(key)!;
      addTotals(cell.t, t);
    };
    // Sittings: the active stretches of the span, with pauses past the cache's hour between them.
    const k = Math.max(1, p.sittings);
    const activeH = k === 1 ? p.spanH : p.spanH * between(0.45, 0.6);
    const lens = Array.from({ length: k }, () => between(0.6, 1.4));
    const gaps = Array.from({ length: k - 1 }, () => between(0.4, 1.6));
    const sumL = lens.reduce((a, b) => a + b, 0);
    const sumG = gaps.reduce((a, b) => a + b, 0) || 1;
    const sit: { from: number; hours: number; turns: number }[] = [];
    let t = p.start;
    for (let s = 0; s < k; s++) {
      const hours = (lens[s] / sumL) * activeH;
      sit.push({ from: t, hours, turns: Math.max(1, Math.round((lens[s] / sumL) * p.turns)) });
      t += hours * HOUR;
      if (s < k - 1) t += Math.max(MIN_GAP_H, (gaps[s] / sumG) * (p.spanH - activeH)) * HOUR;
    }
    // The conversation's own requests: the window climbs from the baseline toward its peak.
    let prev = 0;
    let i = 0;
    for (const s of sit) {
      for (let j = 0; j < s.turns && i < p.turns; j++, i++) {
        const at = s.from + (j / s.turns) * s.hours * HOUR;
        const ctx = Math.round(p.base + (p.peak - p.base) * Math.pow(i / Math.max(1, p.turns - 1), 0.85) * between(0.97, 1));
        const output = Math.round(between(120, p.model === LEDGER_HAIKU ? 400 : 820));
        const input = 1 + Math.floor(rng() * 30);
        if (j === 0) {
          // The first request writes the whole window; so does the first after a pause — the
          // cache expired, and that one is the cold start the screen prices.
          add(cells, at, p.model, { input, output, cacheRead: 0, cacheWrite: ctx, cacheWrite1h: p.oneHour ? ctx : 0, turns: 1 });
          if (i > 0) cold.push({ hour: localHour(Math.min(at, anchor)), model: p.model, count: 1, tok: ctx, tok1h: p.oneHour ? ctx : 0 });
        } else {
          const write = Math.max(300, ctx - prev) + Math.round(rng() * 3_200);
          add(cells, at, p.model, { input, output, cacheRead: prev, cacheWrite: write, cacheWrite1h: p.oneHour ? write : 0, turns: 1 });
        }
        prev = ctx;
      }
    }
    files.push({ convo: id, title: p.title, sub: false, repo: p.repo, cells: [...cells.values()], cold });
    // Subagents: their own transcripts, each re-reading its OWN growing window on every step.
    for (const a of p.agents) {
      const s = sit[Math.floor(rng() * sit.length)];
      const from = s.from + rng() * s.hours * HOUR;
      const ac = new Map<string, Cell>();
      let aprev = 0;
      for (let q = 0; q < a.turns; q++) {
        const at = from + (q / AGENT_RATE) * HOUR;
        const ctx = Math.round(AGENT_BASE_TOK + (a.peak - AGENT_BASE_TOK) * Math.pow(q / Math.max(1, a.turns - 1), 0.8));
        const output = Math.round(between(60, 420));
        if (q === 0) {
          add(ac, at, a.model, { input: 3, output, cacheRead: 0, cacheWrite: ctx, cacheWrite1h: 0, turns: 1 });
        } else {
          const write = Math.max(200, ctx - aprev) + Math.round(rng() * 900);
          add(ac, at, a.model, { input: 1 + Math.floor(rng() * 8), output, cacheRead: aprev, cacheWrite: write, cacheWrite1h: 0, turns: 1 });
        }
        aprev = ctx;
      }
      files.push({ convo: id, title: p.title, sub: true, repo: p.repo, cells: [...ac.values()], cold: [] });
    }
  };

  // The marathons first, so their ids and places do not move when the filler changes.
  for (const m of MARATHONS) {
    emit({
      repo: m.repo, title: m.title, start: dayAt(m.back, m.at) + 7 * 60_000, spanH: m.spanH, sittings: m.sittings,
      model: m.model, turns: m.turns, base: BASE_TOK, peak: m.peak, oneHour: true,
      agents: Array.from({ length: m.agents }, () => ({
        model: pick([LEDGER_OPUS, FABLE, SONNET], [0.76, 0.06, 0.18]), turns: Math.round(m.agentTurns * between(0.5, 1.5)), peak: Math.round(m.agentPeak * between(0.5, 1.1)),
      })),
    });
  }

  // Everything else: many small conversations, a fair number of ordinary ones, a few long ones.
  for (let back = LEDGER_DAYS - 1; back >= 0; back--) {
    const dow = new Date(dayAt(back)).getDay();
    const weight = dow === 0 ? 0.35 : dow === 6 ? 0.5 : 1;
    const count = Math.round(weight * 22 + rng() * 6);
    // Hours of this day a conversation may START in: none past the one `now` is in.
    const maxHour = back === 0 ? new Date(anchor).getHours() : 23;
    const hours = Array.from({ length: maxHour + 1 }, (_, h) => h);
    for (let c = 0; c < count; c++) {
      const repo = pick([GARDEN, NOTES, TRAIL], [0.55, 0.28, 0.17]);
      const start = dayAt(back, pick(hours, hours.map((h) => HOUR_WEIGHT[h]))) + Math.floor(rng() * 50) * 60_000;
      const kind = pick(["tiny", "ordinary", "long"] as const, [0.55, 0.36, 0.09]);
      if (kind === "tiny") {
        const model = pick([LEDGER_HAIKU, LEDGER_SONNET, SONNET], [0.5, 0.33, 0.17]);
        const base = Math.round(between(14_000, 40_000));
        emit({ repo, title: titleFor(repo), start, spanH: 0.2, sittings: 1, model, turns: 1 + Math.floor(rng() * 6),
          base, peak: base + Math.round(rng() * 12_000), oneHour: false, agents: [] });
      } else if (kind === "ordinary") {
        const model = pick([LEDGER_OPUS, OPUS_55, FABLE, SONNET], [0.66, 0.22, 0.05, 0.07]);
        const agents = rng() < 0.35 ? 1 + Math.floor(rng() * 4) : 0;
        const sittings = pick([1, 2, 3], [0.45, 0.35, 0.2]);
        emit({ repo, title: titleFor(repo), start, spanH: sittings === 1 ? between(0.5, 2.5) : between(4, 9), sittings, model,
          turns: Math.round(between(20, 170)), base: BASE_TOK, peak: Math.round(between(110_000, 260_000)), oneHour: true,
          agents: Array.from({ length: agents }, () => ({ model: agentModel(), turns: Math.round(between(10, 60)), peak: Math.round(between(60_000, 220_000)) })) });
      } else {
        const model = pick([LEDGER_OPUS, OPUS_55], [0.75, 0.25]);
        const agents = 2 + Math.floor(rng() * 9);
        const sittings = 2 + Math.floor(rng() * 3);
        emit({ repo, title: titleFor(repo), start, spanH: between(5, 14), sittings, model,
          turns: Math.round(between(180, 520)), base: BASE_TOK, peak: Math.round(between(260_000, 480_000)), oneHour: true,
          agents: Array.from({ length: agents }, () => ({ model: agentModel(), turns: Math.round(between(25, 110)), peak: Math.round(between(120_000, 360_000)) })) });
      }
    }
  }
  return files;
}

/** Epoch ms of the top of the hour `hour` (`YYYY-MM-DDTHH`) names. */
const hourMs = (hour: string) => hourToMs(hour);

interface Ledger {
  doc: TokenStatsDoc;
  /** hour → model → tokens and money; what a window grid and the usage log fold. */
  cells: Map<string, Map<string, { t: TokenTotals; c: CostBreakdown }>>;
  titles: Map<string, string>;
}

const nest = <T>(m: Map<string, Map<string, T>>, a: string, b: string, blank: () => T): T => {
  const inner = m.get(a) ?? m.set(a, new Map()).get(a)!;
  return inner.get(b) ?? inner.set(b, blank()).get(b)!;
};

/** The host's `aggregate()`, over the synthetic files. See the header for the semantics kept. */
function aggregate(files: LogFile[], now: number): Ledger {
  const totals = zeroTotals();
  const subagents = zeroTotals();
  const days = new Map<string, TokenTotals>();
  const hours = new Map<string, TokenTotals>();
  const slots: TokenTotals[] = Array.from({ length: 24 }, zeroTotals);
  const models = new Map<string, TokenTotals>();
  const repos = new Map<string, TokenTotals>();
  const cost = zeroCost();
  const subCost = zeroCost();
  const dayCost = new Map<string, CostBreakdown>();
  const hourCost = new Map<string, CostBreakdown>();
  const slotCost: CostBreakdown[] = Array.from({ length: 24 }, zeroCost);
  const modelCost = new Map<string, CostBreakdown>();
  const repoCost = new Map<string, CostBreakdown>();
  const unpriced = zeroTotals();
  const dayModel = new Map<string, Map<string, TokenTotals>>();
  const dayModelCost = new Map<string, Map<string, CostBreakdown>>();
  const hourModel = new Map<string, Map<string, TokenTotals>>();
  const hourModelCost = new Map<string, Map<string, CostBreakdown>>();
  const dayAgents = new Map<string, Map<string, number>>();
  const dayRepo = new Map<string, Map<string, { turns: number; pricedTurns: number; usd: number }>>();
  const repoModel = new Map<string, Map<string, TokenTotals>>();
  const repoModelCost = new Map<string, Map<string, CostBreakdown>>();
  const cold = { count: 0, tok: 0, usd: 0, premiumUsd: 0 };
  const convos = new Map<string, TokenConvo & { first: string; last: string }>();
  const titles = new Map<string, string>();
  const cells = new Map<string, Map<string, { t: TokenTotals; c: CostBreakdown }>>();
  let conversations = 0;
  let subagentLogs = 0;

  for (const f of files) {
    if (f.sub) subagentLogs++; else conversations++;
    titles.set(f.convo, f.title);
    const cv = convos.get(f.convo) ?? convos.set(f.convo, {
      id: f.convo, repo: f.repo, label: f.repo.split("/").pop() ?? f.repo, firstAt: null, lastAt: null,
      totals: zeroTotals(), cost: zeroCost(), agentTotals: zeroTotals(), agentCost: zeroCost(), agents: 0, first: "", last: "",
    }).get(f.convo)!;
    if (f.sub) {
      cv.agents++;
      let earliest = "";
      let earliestModel = "";
      for (const c of f.cells) if (!earliest || c.hour < earliest) { earliest = c.hour; earliestModel = c.model; }
      if (earliest) {
        const inner = dayAgents.get(earliest.slice(0, 10)) ?? dayAgents.set(earliest.slice(0, 10), new Map()).get(earliest.slice(0, 10))!;
        inner.set(earliestModel, (inner.get(earliestModel) ?? 0) + 1);
      }
    }
    for (const r of f.cold) {
      const day = r.hour.slice(0, 10);
      cold.count += r.count;
      cold.tok += r.tok;
      const wrote = costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: r.tok, cacheWrite1h: r.tok1h }, r.model, day);
      const asRead = costOf({ input: 0, output: 0, cacheRead: r.tok, cacheWrite: 0, cacheWrite1h: 0 }, r.model, day);
      if (wrote) {
        cold.usd += wrote.total;
        if (asRead) {
          const prem = Math.max(0, wrote.total - asRead.total);
          cold.premiumUsd += prem;
          if (prem > 0) cv.coldUsd = (cv.coldUsd ?? 0) + prem;
        }
      }
    }
    for (const { hour, model, t: v } of f.cells) {
      const day = hour.slice(0, 10);
      const slot = Number(hour.slice(11, 13));
      addTotals(days.get(day) ?? days.set(day, zeroTotals()).get(day)!, v);
      addTotals(hours.get(hour) ?? hours.set(hour, zeroTotals()).get(hour)!, v);
      addTotals(slots[slot], v);
      addTotals(models.get(model) ?? models.set(model, zeroTotals()).get(model)!, v);
      addTotals(repos.get(f.repo) ?? repos.set(f.repo, zeroTotals()).get(f.repo)!, v);
      addTotals(totals, v);
      if (f.sub) addTotals(subagents, v);
      addTotals(nest(dayModel, day, model, zeroTotals), v);
      addTotals(nest(hourModel, hour, model, zeroTotals), v);
      const dr = nest(dayRepo, day, f.repo, () => ({ turns: 0, pricedTurns: 0, usd: 0 }));
      dr.turns += v.turns;
      addTotals(nest(repoModel, f.repo, model, zeroTotals), v);
      addTotals(cv.totals, v);
      if (f.sub) addTotals(cv.agentTotals, v);
      if (!cv.first || hour < cv.first) cv.first = hour;
      if (!cv.last || hour > cv.last) cv.last = hour;
      const bag = nest(cells, hour, model, () => ({ t: zeroTotals(), c: zeroCost() }));
      addTotals(bag.t, v);
      const c = costOf(v, model, day);
      if (!c) { addTotals(unpriced, v); continue; }
      dr.pricedTurns += v.turns;
      dr.usd += c.total;
      addCost(bag.c, c);
      addCost(cv.cost, c);
      if (f.sub) addCost(cv.agentCost, c);
      addCost(nest(dayModelCost, day, model, zeroCost), c);
      addCost(nest(hourModelCost, hour, model, zeroCost), c);
      addCost(nest(repoModelCost, f.repo, model, zeroCost), c);
      addCost(cost, c);
      if (f.sub) addCost(subCost, c);
      addCost(dayCost.get(day) ?? dayCost.set(day, zeroCost()).get(day)!, c);
      addCost(hourCost.get(hour) ?? hourCost.set(hour, zeroCost()).get(hour)!, c);
      addCost(slotCost[slot], c);
      addCost(modelCost.get(model) ?? modelCost.set(model, zeroCost()).get(model)!, c);
      addCost(repoCost.get(f.repo) ?? repoCost.set(f.repo, zeroCost()).get(f.repo)!, c);
    }
  }

  const bySplit = (m: Map<string, TokenTotals> | undefined, cs: Map<string, CostBreakdown> | undefined) =>
    [...(m ?? new Map<string, TokenTotals>()).entries()]
      .map(([model, totals]) => ({ model, totals, cost: cs?.get(model) ?? zeroCost() }))
      .sort((x, y) => tokenTotal(y.totals) - tokenTotal(x.totals));

  const top: TokenConvo[] = [...convos.values()]
    .filter((c) => tokenTotal(c.totals) > 0)
    .sort((a, b) => (b.cost.total - a.cost.total) || (tokenTotal(b.totals) - tokenTotal(a.totals)))
    .slice(0, TOP)
    .map(({ first, last, ...c }) => ({ ...c, firstAt: first ? hourMs(first) : null, lastAt: last ? hourMs(last) : null }));

  const dayRows: TokenDay[] = [...days.entries()]
    .map(([day, t]) => ({
      day, ...t, cost: dayCost.get(day) ?? zeroCost(),
      byModel: bySplit(dayModel.get(day), dayModelCost.get(day)),
      agents: [...(dayAgents.get(day) ?? new Map<string, number>()).entries()]
        .map(([model, count]) => ({ model, count })).sort((x, y) => y.count - x.count),
      byRepo: [...(dayRepo.get(day) ?? new Map()).entries()].map(([repo, r]) => ({ repo, ...r })).sort((x, y) => y.usd - x.usd),
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const hourRows: TokenHour[] = [...hours.entries()]
    .map(([hour, t]) => ({
      hour, ...t, cost: hourCost.get(hour) ?? zeroCost(), byModel: bySplit(hourModel.get(hour), hourModelCost.get(hour)),
    }))
    .sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
  const slotRows: TokenHourSlot[] = slots.map((t, hour) => ({ hour, ...t, cost: slotCost[hour] }));

  const group = (
    m: Map<string, TokenTotals>, costs: Map<string, CostBreakdown>, label: (k: string) => string,
    split?: Map<string, Map<string, TokenTotals>>, splitCost?: Map<string, Map<string, CostBreakdown>>,
  ): TokenGroup[] =>
    [...m.entries()]
      .map(([key, t]) => ({
        key, label: label(key), ...t, cost: costs.get(key) ?? zeroCost(), priced: isPriced(key),
        ...(split ? { byModel: bySplit(split.get(key), splitCost?.get(key)) } : {}),
      }))
      .sort((a, b) => tokenTotal(b) - tokenTotal(a));

  const firstDay = dayRows[0]?.day ?? null;
  const lastDay = dayRows[dayRows.length - 1]?.day ?? null;

  const doc: TokenStatsDoc = {
    totals, days: dayRows, hours: hourRows, hoursFrom: hourRows.length ? dayToMs(hourRows[0].hour.slice(0, 10)) : null,
    hourOfDay: slotRows,
    models: group(models, modelCost, (k) => normalizeModel(k) ?? k),
    repos: group(repos, repoCost, (k) => k.split("/").pop() ?? k, repoModel, repoModelCost),
    conversations, subagents, subagentLogs, cost, subagentCost: subCost, unpriced,
    fastTurns: Math.min(FAST_TURNS, totals.turns),
    coldStarts: {
      count: cold.count, tok: cold.tok,
      ...(cold.usd > 0 ? { usd: cold.usd } : {}),
      ...(cold.premiumUsd > 0 ? { premiumUsd: cold.premiumUsd } : {}),
    },
    top, pricesAsOf: PRICES_AS_OF,
    firstAt: firstDay ? dayToMs(firstDay) : null, lastAt: lastDay ? dayToMs(lastDay) : null,
    scannedAt: now, logs: files.length, reread: 0,
  };
  return { doc, cells, titles };
}

let memo: { anchor: number; ledger: Ledger } | null = null;
function ledgerAt(now: number): Ledger {
  const anchor = hourFloorMs(now);
  if (!memo || memo.anchor !== anchor) memo = { anchor, ledger: aggregate(generate(anchor), now) };
  // `scannedAt` is the one field that follows `now` itself.
  return { ...memo.ledger, doc: { ...memo.ledger.doc, scannedAt: now } };
}

/** The `top` conversations with the readable name of the work each one was — for the scenario's
 *  `recent` rows, which is where the phone looks a conversation id up (`nameOf`). */
export function demoTopConvos(now: number): { convo: TokenConvo; title: string }[] {
  const { doc, titles } = ledgerAt(now);
  return (doc.top ?? []).map((convo) => ({ convo, title: titles.get(convo.id) ?? convo.label }));
}

/** The demo's `/api/tokenstats`: 14 days, ~300 conversations, all fictional. */
export function demoTokenStats(now: number): TokenStatsDoc {
  return ledgerAt(now).doc;
}

/** The host's `windowCells`, verbatim: which cells of a grid an hour bucket belongs to. */
export function windowCells(hourMsAt: number, anchor: number, lenMs: number): number[] {
  if (!Number.isFinite(hourMsAt) || !Number.isFinite(anchor) || !(lenMs > 0)) return [];
  const hi = Math.ceil((anchor - hourMsAt) / lenMs) - 1;
  const out: number[] = [];
  for (const k of [hi - 1, hi]) {
    if (k < 0) continue;
    const opened = anchor - (k + 1) * lenMs;
    const closes = anchor - k * lenMs;
    if (hourMsAt >= hourFloorMs(opened) && hourMsAt < closes) out.push(k);
  }
  return out;
}

/** `?w=<id>:<anchor>:<lenMs>` specs, repeated (the demo transport joins repeats with commas). */
export function parseWindowSpecs(raw: string | undefined): { id: string; anchor: number; lenMs: number }[] {
  return (raw ?? "").split(",").map((s) => {
    const [id, anchor, len] = s.split(":");
    return { id: id || "", anchor: Number(anchor), lenMs: Number(len) };
  }).filter((sp) => sp.id && Number.isFinite(sp.anchor) && sp.lenMs > 0);
}

/** The demo's `/api/tokenwindows`: the host's `windowSeries`, over the same cells. */
export function demoTokenWindows(now: number, specs: { id: string; anchor: number; lenMs: number }[]): TokenWindowsDoc {
  const { cells, doc } = ledgerAt(now);
  const hourKeys = [...cells.keys()].sort();
  const oldest = hourKeys[0];
  const newest = hourKeys[hourKeys.length - 1];
  const series: TokenWindowSeries[] = specs.map((spec) => {
    const grid = new Map<number, Map<string, { t: TokenTotals; c: CostBreakdown }>>();
    for (const [hour, byModel] of cells) {
      for (const k of windowCells(hourMs(hour), spec.anchor, spec.lenMs)) {
        const cell = grid.get(k) ?? grid.set(k, new Map()).get(k)!;
        for (const [model, v] of byModel) {
          const bag = cell.get(model) ?? cell.set(model, { t: zeroTotals(), c: zeroCost() }).get(model)!;
          addTotals(bag.t, v.t);
          addCost(bag.c, v.c);
        }
      }
    }
    const windows = [...grid.entries()].map(([back, byModel]): TokenWindow => {
      const t = zeroTotals();
      const c = zeroCost();
      const slices = [];
      for (const [model, bag] of byModel) { addTotals(t, bag.t); addCost(c, bag.c); slices.push({ model, totals: bag.t, cost: bag.c }); }
      return { back, ...t, cost: c, byModel: slices.sort((a, b) => tokenTotal(b.totals) - tokenTotal(a.totals)) };
    }).sort((a, b) => a.back - b.back);
    return { id: spec.id, anchor: spec.anchor, lenMs: spec.lenMs, windows, oldestHour: oldest ? hourMs(oldest) : null, newestHour: newest ? hourMs(newest) : null };
  });
  return { series, scannedAt: doc.scannedAt };
}

/** The reading a usage log must end at: the scenario's `numbers.usage`. */
export interface LedgerUsage {
  sessionPct: number | null;
  weeklyPct: number | null;
  checkedAt: number;
  sessionResetAt: number | null;
  weeklyResetAt: number | null;
}

const SESSION_MS = 5 * HOUR;
const WEEK_MS = 7 * 24 * HOUR;
const EVERY_MS = 15 * 60_000;
const RETAIN_MS = LEDGER_DAYS * 24 * HOUR;

/**
 * The demo's `/api/usagelog`: a reading every 15 minutes while the desktop was awake (not 00:00–07:00),
 * each window's percentage a scaled running sum of the SAME hourly cost the ledger holds — so the
 * sawtooth rises where the work was and resets every five hours, the weekly figure only rises
 * within its week, and the last reading is exactly the scenario's. Past windows are scaled so the
 * busiest tops out near 80% (the current one is scaled to land on the reading).
 */
export function demoUsageLog(now: number, usage: LedgerUsage, hours?: number): UsageHistoryDoc {
  const { cells } = ledgerAt(now);
  const perHour = new Map<number, number>();
  for (const [hour, byModel] of cells) {
    let usd = 0;
    for (const v of byModel.values()) usd += v.c.total;
    perHour.set(hourMs(hour), usd);
  }
  /** Spend between two instants, an hour's money spread evenly across it. */
  const spend = (a: number, b: number): number => {
    if (b <= a) return 0;
    let s = 0;
    for (let h = hourFloorMs(a); h < b; h += HOUR) {
      const usd = perHour.get(h);
      if (!usd) continue;
      const lo = Math.max(a, h);
      const hi = Math.min(b, h + HOUR);
      if (hi > lo) s += usd * ((hi - lo) / HOUR);
    }
    return s;
  };
  const t0 = now - RETAIN_MS;
  const wins = (anchor: number | null, len: number, pct: number | null) => {
    if (anchor == null || pct == null) return { end: (_t: number) => null as number | null, pct: (_t: number) => null as number | null };
    const endOf = (t: number) => anchor - Math.floor((anchor - t - 1) / len) * len;
    // The busiest window STARTED before the current one, over its full length.
    let busiest = 0;
    for (let e = anchor - len; e > t0; e -= len) busiest = Math.max(busiest, spend(e - len, e));
    const curSpend = spend(anchor - len, usage.checkedAt);
    const pastScale = busiest > 0 ? 80 / busiest : 0;
    const curScale = curSpend > 0 ? pct / curSpend : 0;
    return {
      end: endOf,
      pct: (t: number) => {
        const e = endOf(t);
        const cur = e === anchor;
        const v = cur
          ? (curScale ? curScale * spend(e - len, t) : pct * Math.min(1, (t - (e - len)) / Math.max(1, usage.checkedAt - (e - len))))
          : pastScale * spend(e - len, t);
        return Math.max(0, Math.min(100, Math.round(v)));
      },
    };
  };
  const sess = wins(usage.sessionResetAt, SESSION_MS, usage.sessionPct);
  const week = wins(usage.weeklyResetAt, WEEK_MS, usage.weeklyPct);
  const samples: UsageSample[] = [];
  for (let t = usage.checkedAt - EVERY_MS; t > t0; t -= EVERY_MS) {
    const h = new Date(t).getHours();
    if (h < 7) continue;
    samples.push({ t, s: sess.pct(t), w: week.pct(t), sr: sess.end(t), wr: week.end(t) });
  }
  samples.reverse();
  samples.push({
    t: usage.checkedAt, s: usage.sessionPct, w: usage.weeklyPct,
    sr: usage.sessionResetAt, wr: usage.weeklyResetAt,
  });
  const since = hours != null && Number.isFinite(hours) && hours > 0 ? now - hours * HOUR : null;
  const kept = since == null ? samples : samples.filter((s) => s.t >= since);
  return { samples: kept, keptFrom: kept.length ? kept[0].t : null, cap: 2_000, retainMs: RETAIN_MS, everyMs: EVERY_MS };
}
