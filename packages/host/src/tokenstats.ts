/**
 * How many tokens every conversation on this desktop has ever used.
 *
 * ── Why the logs and not a meter of our own ─────────────────────────────────
 *
 * `meter.ts` counts what THIS app spends on its own model calls (the text reader, plugins), and `usage.ts` scrapes
 * the CLI's `/usage` screen for a percentage of the current window. Neither
 * answers "how much have I used, ever, across everything" — the first is one
 * small subsystem and the second is a rolling percentage with no history and no
 * total. The CLI already writes the real answer down: every assistant turn in
 * every conversation jsonl carries `message.usage`, and those files go back to
 * the first day this machine ran the CLI, including sessions this app never
 * drove. Same source as the transcript and the context graph; no new bookkeeping
 * to desync.
 *
 * ── The three things that make it correct ───────────────────────────────────
 *
 *  1. **Dedupe by `message.id`.** A streaming turn is written several times with
 *     one id and one usage block. Measured here: 69,931 real turns and 49,260
 *     duplicate records — counting them would inflate every number on the screen
 *     by 70%. The set is per FILE, which is why a changed file is re-read whole
 *     rather than appended to (below).
 *  2. **Skip the `<synthetic>` turns.** A usage-limit rejection is written as an
 *     assistant turn with a zero usage block; it is not a turn that happened.
 *  3. **Keep the four kinds apart, for ever.** 96% of the total is cache reads
 *     (`shared/tokens.ts` has the measurement). A store that summed them could
 *     never un-sum them, and every screen would then be free to imply that 13.65
 *     billion tokens is what somebody spent.
 *
 * Sidechains ARE counted, unlike in `ctxlog.ts`. There the question is "how full
 * is THIS conversation's window", and a subagent's turns belong to a different
 * one; here the question is what was spent, and a subagent spends real tokens.
 *
 * ── Why per-file summaries rather than a patched aggregate ──────────────────
 *
 * A cold scan is ~4.5 s over 9,444 files and 2 GB, which is fine once and
 * unacceptable per request. The obvious fix — keep a running aggregate and add
 * deltas — needs a subtract path for any file that changes, and a subtract path
 * for the per-day and per-model buckets means keeping those buckets per file
 * anyway. So the store IS the per-file summaries and the aggregate is DERIVED on
 * every read: no patching, no drift, and a deleted conversation simply stops
 * being in the fold. Measured, that costs 1.76 MB on disk, 6 ms to reparse, and
 * a warm refresh is a 35 ms stat sweep plus a re-read of only what changed
 * (average file: 1.01 days, 1.00 models, so a summary is a handful of numbers).
 *
 * Everything here is read-only with respect to the CLI's files and best-effort
 * with respect to its own: a corrupt store rebuilds from scratch, a failed write
 * is dropped. A statistics screen is not worth taking the daemon down for.
 */
import { existsSync, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { 
  PRICES_AS_OF, addCost, addTotals, costOf, dayToMs, isPriced, normalizeModel, tokenTotal, zeroCost, zeroTotals,
  type CostBreakdown, type ModelSlice, type TokenDay, type TokenGroup, type TokenHour, type TokenHourSlot,
  type TokenConvo, type TokenStatsDoc, type TokenTotals, type TokenWindow, type TokenWindowSeries, type TokenWindowsDoc,
  type CostWindowDoc, windowStartHour } from "@waterplane/shared";
import { claudeConfigDir } from "./claudeconfig.js";
import { env } from "./env.js";
import { CROSS, type FileSummary, localHour, summarizeLog, type Tally, walkLogs } from "./tokenscan.js";
import { hostStateDir } from "./branddirs.js";
import { foldCostWindow, repoOfWorktree, type CostMeta } from "./costwindow.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** A single log this big is not read. Nothing observed comes near it; the cap
 *  exists so one pathological file cannot stall the sweep. */
const MAX_FILE = 256 * 1024 * 1024;
/** How long a change waits before the store reaches disk. */
const FLUSH_MS = 5_000;
/** Files read between yields to the event loop. Small enough that the longest
 *  pause is a few milliseconds even on the biggest logs, large enough that the
 *  scheduling overhead stays noise. */
const YIELD_EVERY = 64;
/** Store format. A bump discards the file and rebuilds rather than migrating —
 *  it is a cache of something still on disk, so rebuilding is always available. */
const VERSION = 5;
/** How far back the HOUR buckets travel on the wire. The store keeps every hour
 *  it ever saw (they cost ~3 entries per conversation); this bounds only what a
 *  phone is asked to download and cache. 14 days is two full weeks of the
 *  intraday chart, which is the longest window anybody reads it over. */
/** How many conversations `TokenStatsDoc.top` names. */
const TOP_CONVOS = 12;

/** Moved to `costwindow.ts` (one import direction between the two); re-exported
 *  so `packages/host/test/*` and every caller keep importing it from here. */
export { repoOfWorktree } from "./costwindow.js";

const HOURS_DAYS = Math.max(1, Number(env("TOKENSTATS_HOUR_DAYS") || 14));


/**
 * The one bucket key: a local HOUR and a model, joined.
 *
 * Crossed rather than kept as two independent maps because a bucket cannot be
 * priced without knowing which model ran in it — rates differ per model and one
 * of them changed mid-corpus.
 *
 * The hour rather than the day (it was the day through store version 3) because
 * a day key cannot be refined back into hours, while an hour key IS a day key
 * in its first ten characters: `aggregate()` folds hours into days and the two
 * therefore cannot disagree. It costs a little: measured, a conversation
 * averages 1.01 days and 1.00 models but ~3 hours, so the store grows roughly
 * threefold — 1.76 MB to ~5 MB on the corpus this was built against, which
 * buys the only chart that can show a burst at 14:00.
 */
const uncross = (k: string): [hour: string, model: string] => {
  const i = k.indexOf(CROSS);
  return i < 0 ? ["", k] : [k.slice(0, i), k.slice(i + 1)];
};


/**
 * slug (project dir name) → path within it → summary.
 *
 * Grouped by slug so the long directory name is written once rather than ~10k
 * times. The inner key is the path BELOW the project directory, without the
 * extension, so a top-level conversation is `<uuid>` and a subagent transcript
 * is `<uuid>/subagents/agent-<id>` — one flat map, and the shape of the key
 * says which it is.
 */
type Store = Record<string, Record<string, FileSummary>>;




function tallyToTotals(t: Tally): TokenTotals {
  return { input: t[0], output: t[1], cacheRead: t[2], cacheWrite: t[3], cacheWrite1h: t[4], turns: t[5] };
}


/** `YYYY-MM-DDTHH` back to the epoch ms of the TOP of that local hour — the
 *  inverse of `localHour`, and the same local-zone assumption `dayToMs` makes
 *  one level up. */
function hourToMs(hour: string): number {
  const [y, mo, d] = hour.slice(0, 10).split("-").map(Number);
  const h = Number(hour.slice(11, 13));
  return new Date(y, (mo || 1) - 1, d || 1, h || 0, 0, 0, 0).getTime();
}

/**
 * Which cells of a window grid an hour bucket belongs to.
 *
 * A cell `k` is the window `[anchor - (k+1)*lenMs, anchor - k*lenMs)`, and an
 * hour counts in it under exactly the rule the LIVE cut states on screen
 * (`web/usageCut.ts`): from `windowStartHour(opened)` — the NEAREST hour
 * boundary to the instant the window opened — up to `windowStartHour(closes)`,
 * which is the next window's start. The finest bucket on record is an hour, so
 * the honest move is to state a span off by at most half an hour at each edge
 * exactly, rather than to be approximately right about the window; the rule is
 * shared (`shared/costwindow.ts`), never re-decided here, so cell 0 of a grid
 * and the phone's own reading of the window running now are the same number.
 *
 * Flooring the start used to put the hour a window OPENED in into two cells
 * (and 59 minutes of last week into a week resetting at 18:59). Rounding both
 * edges makes the cells TILE: every hour is in exactly one. Still a LIST, so
 * an empty answer (before the grid, after the anchor) needs no sentinel.
 *
 * Exported for `packages/host/test/tokenwindows.test.mjs`: the arithmetic is
 * the whole of the correctness and it needs no store, no files and no clock.
 */
export function windowCells(hourMs: number, anchor: number, lenMs: number): number[] {
  if (!Number.isFinite(hourMs) || !Number.isFinite(anchor) || !(lenMs > 0)) return [];
  // The cell whose RAW window holds this hour. Cells run BACKWARDS; rounding
  // can only move an hour into the NEXT-NEWER cell (an hour at or after a
  // rounded-down close), never an older one, so these two are every candidate.
  const hi = Math.ceil((anchor - hourMs) / lenMs) - 1;
  const out: number[] = [];
  for (const k of [hi - 1, hi]) {
    if (k < 0) continue;
    const opened = anchor - (k + 1) * lenMs;
    const closes = anchor - k * lenMs;
    if (hourMs >= windowStartHour(opened) && hourMs < windowStartHour(closes)) out.push(k);
  }
  return out;
}

export class TokenStatsStore {
  private path: string;
  private store: Store = {};
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private lastScan = 0;
  private lastLogs = 0;
  private lastReread = 0;
  /** A scan in flight. Two concurrent walks would do the same work twice and
   *  race each other's `store` assignment. */
  private inFlight: Promise<void> | null = null;

  constructor(root: string) {
    const dir = hostStateDir(root);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "tokenstats.json");
    try {
      if (existsSync(this.path)) {
        const raw = readJsonGuarded<any>(this.path, null) as { v?: number; store?: Store };
        if (raw?.v === VERSION && raw.store && typeof raw.store === "object") this.store = raw.store;
      }
    } catch { /* corrupt → rebuild from the logs, which are the source anyway */ }
  }

  /**
   * Bring the store up to date and return the aggregate.
   *
   * `maxAgeMs` skips the filesystem entirely when the last pass was recent
   * enough — the sheet has a re-read button and a phone that reopens it twice
   * in ten seconds should not walk 9,444 files twice.
   */
  async read(maxAgeMs = 15_000): Promise<TokenStatsDoc> {
    if (Date.now() - this.lastScan > maxAgeMs) {
      // Share one walk between concurrent callers — the boot warm-up and a
      // phone opening the screen at the same moment is the ordinary case.
      this.inFlight ??= this.refresh().finally(() => { this.inFlight = null; });
      try { await this.inFlight; } catch { /* serve what we already have */ }
    }
    return this.aggregate();
  }

  /**
   * Walk the CLI's project directories and re-read whatever moved.
   *
   * Async, and it yields, for a reason that has nothing to do with speed: a
   * cold scan is ~7 s of `readFileSync` over 2 GB, and done in one go it holds
   * the daemon's event loop for all of it — no PTY frames, no socket writes, no
   * hook POSTs, for every session on the machine. Measured on a host driving 44
   * sessions, that is not a slow screen, it is a seven-second outage. So the
   * loop hands control back every `YIELD_EVERY` files: the scan takes slightly
   * longer in wall-clock and the rest of the daemon keeps running through it.
   *
   * Every filesystem call is the ASYNC one (the directory walk, the stats, the
   * reads), and one log is read in `SCAN_CHUNK` slices with a yield every
   * `SLICE_MS` of parsing (`summarizeLog`) — yielding between files was not
   * enough, because one big log was itself a 0.5-2.4 s stall. The numbers are
   * pinned equal to the one-buffer reader's by `tokenscan.test.mjs`.
   */
  private async refresh(): Promise<void> {
    const root = join(claudeConfigDir(), "projects");
    const next: Store = {};
    let logs = 0;
    let reread = 0;

    let slugs: string[];
    try {
      slugs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // No project directory at all — a fresh machine, or `WATERPLANE_CLAUDE_HOME`
      // pointed somewhere empty. An empty answer, not a stale one.
      this.store = {};
      this.lastScan = Date.now();
      this.lastLogs = 0;
      this.lastReread = 0;
      this.dirty = true;
      this.schedule();
      return;
    }

    for (const slug of slugs) {
      const prev = this.store[slug] ?? {};
      // Recursive, because a third of the spend is not at the top level: the
      // CLI writes every Task-tool subagent to
      // `<projectDir>/<conversation>/subagents/agent-<id>.jsonl`, and 681 such
      // files here held ~3.5 billion tokens. A top-level-only walk produced a
      // headline figure a third too small, which is the kind of wrong that
      // looks completely plausible.
      const rels = await walkLogs(join(root, slug));
      // One directory's stats in parallel, consumed in walk order.
      const stats = await Promise.all(rels.map((rel) => stat(join(root, slug, rel)).catch(() => null)));
      for (let i = 0; i < rels.length; i++) {
        const rel = rels[i];
        const p = join(root, slug, rel);
        const st = stats[i];
        if (!st) continue;
        logs++;
        if (st.size === 0 || st.size > MAX_FILE) continue;
        const key = rel.replace(/\.jsonl$/, "");
        const was = prev[key];
        // Unchanged size AND mtime is the only thing that lets a file be
        // skipped. Either moving means re-read the WHOLE file: the duplicate
        // rule needs the file's own id set, and an appended read cannot have
        // one (see the header).
        if (was && was.s === st.size && was.m === Math.round(st.mtimeMs)) {
          (next[slug] ??= {})[key] = was;
          continue;
        }
        const sum = await summarizeLog(p, st.size, Math.round(st.mtimeMs));
        reread++;
        // Let the daemon breathe. Only after a real READ — a skipped file cost
        // one `stat`, and yielding on those would triple the sweep for nothing.
        if (reread % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
        if (sum) (next[slug] ??= {})[key] = { ...sum, ...(rel.includes("/subagents/") ? { sub: 1 as const } : {}) };
      }
    }

    this.store = next;
    this.lastScan = Date.now();
    this.lastLogs = logs;
    this.lastReread = reread;
    this.dirty = true;
    this.schedule();
  }

  /**
   * Fold every per-file summary into the document.
   *
   * Derived rather than maintained, which is what makes the store impossible to
   * drift: there is no code path that adds to a total without the file it came
   * from being present in this loop.
   */
  private aggregate(): TokenStatsDoc {
    const totals = zeroTotals();
    const subagents = zeroTotals();
    const days = new Map<string, TokenTotals>();
    /** Every hour on record, keyed `YYYY-MM-DDTHH`. Bounded only when it is
     *  put on the wire — folding is cheap and the cut needs the whole set to
     *  build the time-of-day profile from. */
    const hours = new Map<string, TokenTotals>();
    /** 0..23 → the same tokens, folded over every day. */
    const slots: TokenTotals[] = Array.from({ length: 24 }, zeroTotals);
    const models = new Map<string, TokenTotals>();
    const repos = new Map<string, TokenTotals>();
    let conversations = 0;
    let subagentLogs = 0;

    // Cost is accumulated in the SAME loop as the tokens, per (day, model)
    // bucket, because that is the only granularity at which it is well defined:
    // rates differ per model, and one of them changed partway through this
    // corpus. Adding costs afterwards from a day row — which has no model —
    // would have to pick a rate, and any pick is a fabrication.
    const cost = zeroCost();
    const subCost = zeroCost();
    const dayCost = new Map<string, CostBreakdown>();
    const hourCost = new Map<string, CostBreakdown>();
    const slotCost: CostBreakdown[] = Array.from({ length: 24 }, zeroCost);
    const modelCost = new Map<string, CostBreakdown>();
    const repoCost = new Map<string, CostBreakdown>();
    /** Tokens we could not price at all — an unknown model. Named on screen
     *  rather than silently charged zero. */
    const unpriced = zeroTotals();
    // day → model → the same two tallies, for the stacked-by-model chart. The
    // cross key already holds both, so this is a projection of what the loop
    // below is reading anyway — no second pass and no rescan.
    const dayModel = new Map<string, Map<string, TokenTotals>>();
    const dayModelCost = new Map<string, Map<string, CostBreakdown>>();
    // hour → model → the same two tallies. The live rate-limit windows are not
    // calendar days — a rolling five hours, and a week that resets on a
    // Thursday evening — so the only bucket either of them can be cut out of is
    // the hour. Same projection as `dayModel`, off the same cross key.
    const hourModel = new Map<string, Map<string, TokenTotals>>();
    const hourModelCost = new Map<string, Map<string, CostBreakdown>>();
    /** day → model → subagents STARTED. A count of events, not of tokens. */
    const dayAgents = new Map<string, Map<string, number>>();
    /** day → repo → requests (all, and priced) and money: the price per
     *  request over time, per repo. Same cross key, one more projection. */
    const dayRepo = new Map<string, Map<string, { turns: number; pricedTurns: number; usd: number }>>();
    // repo → model → the same two tallies. The bar list says a repo is 42% of
    // the tokens and cannot say why it is 61% of the money; this is the answer,
    // and it is the same cross key the loop is already reading.
    const repoModel = new Map<string, Map<string, TokenTotals>>();
    const repoModelCost = new Map<string, Map<string, CostBreakdown>>();
    const nest = <T>(m: Map<string, Map<string, T>>, day: string, key: string, blank: () => T): T => {
      const inner = m.get(day) ?? m.set(day, new Map()).get(day)!;
      return inner.get(key) ?? inner.set(key, blank()).get(key)!;
    };
    let fastTurns = 0;
    /**
     * Every re-write of an expired cache on this desktop, priced per (model,
     * day) exactly like everything else in this loop.
     *
     * Two money figures because they answer two questions: `usd` is what those
     * writes cost, and `premiumUsd` is what they cost ABOVE reading the same
     * tokens back — the part that the CLOCK spent rather than the work. The
     * second is the one worth putting on a screen: the first includes tokens
     * the conversation was always going to send.
     */
    const cold = { count: 0, tok: 0, usd: 0, premiumUsd: 0 };

    /** conversation id → its spend, agents folded in. Keyed by slug too: two
     *  project directories never share a conversation, but nothing enforces it. */
    const convos = new Map<string, TokenConvo & { first: string; last: string }>();
    /** conversation key → the agents' slice by model ("Opus subagents: N% of this session's cost"). */
    const agentModel = new Map<string, Map<string, { totals: TokenTotals; cost: CostBreakdown }>>();

    for (const [slug, files] of Object.entries(this.store)) {
      for (const [fileKey, sum] of Object.entries(files)) {
        if (sum.sub) subagentLogs++; else conversations++;
        if (sum.f) fastTurns += sum.f;
        const repoKey = sum.w ? repoOfWorktree(sum.w) : slug;
        const convoId = fileKey.split("/")[0];
        const cKey = `${slug}\u0000${convoId}`;
        const cv = convos.get(cKey) ?? convos.set(cKey, {
          id: convoId, repo: repoKey, label: basename(repoKey) || repoKey, firstAt: null, lastAt: null,
          totals: zeroTotals(), cost: zeroCost(), agentTotals: zeroTotals(), agentCost: zeroCost(), agents: 0,
          first: "", last: "",
        }).get(cKey)!;
        // The parent's own worktree names the conversation's repo; an agent
        // file seen first only holds the place until the parent arrives.
        if (!sum.sub && sum.w) { cv.repo = repoKey; cv.label = basename(repoKey) || repoKey; }
        if (sum.sub) cv.agents++;
        // A subagent transcript is ONE launch, dated by the earliest bucket it
        // has and attributed to the model that ran in that bucket. The file is
        // the event; counting its buckets would count a long agent several
        // times, and counting its turns would be the tokens again.
        if (sum.sub) {
          let earliest = "";
          let earliestModel = "unknown";
          for (const key of Object.keys(sum.x)) {
            const [hour, model] = uncross(key);
            if (!hour) continue;
            if (!earliest || hour < earliest) { earliest = hour; earliestModel = model; }
          }
          if (earliest) {
            const day = earliest.slice(0, 10);
            const inner = dayAgents.get(day) ?? dayAgents.set(day, new Map()).get(day)!;
            inner.set(earliestModel, (inner.get(earliestModel) ?? 0) + 1);
          }
        }
        for (const [key, r] of Object.entries(sum.r ?? {})) {
          const [hour, model] = uncross(key);
          const day = hour.slice(0, 10);
          cold.count += r[0];
          cold.tok += r[1];
          const wrote = costOf(
            { input: 0, output: 0, cacheRead: 0, cacheWrite: r[1], cacheWrite1h: r[2] },
            model, day || undefined,
          );
          const asRead = costOf(
            { input: 0, output: 0, cacheRead: r[1], cacheWrite: 0, cacheWrite1h: 0 },
            model, day || undefined,
          );
          // An unpriced model adds to neither figure and is NOT counted into
          // `unpriced` here: those tokens are already in it through the tally
          // loop below, and counting them twice would make the "not priced"
          // line bigger than the traffic it describes.
          if (wrote) {
            cold.usd += wrote.total;
            if (asRead) {
              const prem = Math.max(0, wrote.total - asRead.total);
              cold.premiumUsd += prem;
              if (prem > 0) cv.coldUsd = (cv.coldUsd ?? 0) + prem;
            }
          }
        }
        for (const [key, t] of Object.entries(sum.x)) {
          const [hour, model] = uncross(key);
          // The day is a PREFIX of the hour, never a second derivation — see
          // `crossKey`. A record whose timestamp would not parse carries the
          // empty key and is counted into the totals and the model/repo rows
          // but into no time bucket at all, which is the same thing version 3
          // did with its empty day.
          const day = hour.slice(0, 10);
          const slot = hour.length >= 13 ? Number(hour.slice(11, 13)) : NaN;
          const v = tallyToTotals(t);
          if (day) addTotals(days.get(day) ?? days.set(day, zeroTotals()).get(day)!, v);
          if (hour) addTotals(hours.get(hour) ?? hours.set(hour, zeroTotals()).get(hour)!, v);
          if (slot >= 0 && slot < 24) addTotals(slots[slot], v);
          addTotals(models.get(model) ?? models.set(model, zeroTotals()).get(model)!, v);
          addTotals(repos.get(repoKey) ?? repos.set(repoKey, zeroTotals()).get(repoKey)!, v);
          addTotals(totals, v);
          // A slice OF the total, never a second total — see the DTO.
          if (sum.sub) addTotals(subagents, v);

          if (day) addTotals(nest(dayModel, day, model, zeroTotals), v);
          if (hour) addTotals(nest(hourModel, hour, model, zeroTotals), v);
          const dr = day ? nest(dayRepo, day, repoKey, () => ({ turns: 0, pricedTurns: 0, usd: 0 })) : null;
          if (dr) dr.turns += v.turns;
          addTotals(nest(repoModel, repoKey, model, zeroTotals), v);
          addTotals(cv.totals, v);
          if (sum.sub) addTotals(cv.agentTotals, v);
          const am = sum.sub ? nest(agentModel, cKey, model, () => ({ totals: zeroTotals(), cost: zeroCost() })) : null;
          if (am) addTotals(am.totals, v);
          if (hour) {
            if (!cv.first || hour < cv.first) cv.first = hour;
            if (!cv.last || hour > cv.last) cv.last = hour;
          }
          const c = costOf(v, model, day || undefined);
          if (!c) { addTotals(unpriced, v); continue; }
          if (dr) { dr.pricedTurns += v.turns; dr.usd += c.total; }
          addCost(cv.cost, c);
          if (sum.sub) addCost(cv.agentCost, c);
          if (am) addCost(am.cost, c);
          if (day) addCost(nest(dayModelCost, day, model, zeroCost), c);
          if (hour) addCost(nest(hourModelCost, hour, model, zeroCost), c);
          addCost(nest(repoModelCost, repoKey, model, zeroCost), c);
          addCost(cost, c);
          if (sum.sub) addCost(subCost, c);
          if (day) addCost(dayCost.get(day) ?? dayCost.set(day, zeroCost()).get(day)!, c);
          if (hour) addCost(hourCost.get(hour) ?? hourCost.set(hour, zeroCost()).get(hour)!, c);
          if (slot >= 0 && slot < 24) addCost(slotCost[slot], c);
          addCost(modelCost.get(model) ?? modelCost.set(model, zeroCost()).get(model)!, c);
          addCost(repoCost.get(repoKey) ?? repoCost.set(repoKey, zeroCost()).get(repoKey)!, c);
        }
      }
    }

    // Ranked by money, tokens breaking ties and standing in where nothing was
    // priced — an unpriced conversation is not a free one.
    const top: TokenConvo[] = [...convos.entries()]
      .filter(([, c]) => tokenTotal(c.totals) > 0)
      .sort(([, a], [, b]) => (b.cost.total - a.cost.total) || (tokenTotal(b.totals) - tokenTotal(a.totals)))
      .slice(0, TOP_CONVOS)
      .map(([cKey, { first, last, ...c }]) => {
        // Absent, not `[]`, on a conversation with no agents.
        const am = agentModel.get(cKey);
        return {
          ...c, firstAt: first ? hourToMs(first) : null, lastAt: last ? hourToMs(last) : null,
          ...(am?.size ? {
            agentByModel: [...am.entries()].map(([model, b]) => ({ model, totals: b.totals, cost: b.cost }))
              .sort((x, y) => tokenTotal(y.totals) - tokenTotal(x.totals)),
          } : {}),
        };
      });

    const dayRows: TokenDay[] = [...days.entries()]
      .map(([day, t]) => ({
        day, ...t, cost: dayCost.get(day) ?? zeroCost(),
        // Descending by tokens inside the day, so the band order is stable
        // where the mix is stable; the SCREEN still assigns colour off the
        // all-time model ranking, because a per-day rank would repaint the
        // stack every column.
        byModel: [...(dayModel.get(day) ?? new Map()).entries()]
          .map(([model, tt]) => ({ model, totals: tt, cost: dayModelCost.get(day)?.get(model) ?? zeroCost() }))
          .sort((x, y) => tokenTotal(y.totals) - tokenTotal(x.totals)),
        // An empty array is a day on which none ran — a reading. It is only
        // absent where the whole field is (an older host).
        agents: [...(dayAgents.get(day) ?? new Map()).entries()]
          .map(([model, count]) => ({ model, count }))
          .sort((x, y) => y.count - x.count),
        byRepo: [...(dayRepo.get(day) ?? new Map()).entries()]
          .map(([repo, r]) => ({ repo, ...r }))
          .sort((x, y) => y.usd - x.usd),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    // The hour rows are cut to a recent window on the way OUT, not on the way
    // in: the store keeps every hour, so widening `WATERPLANE_TOKENSTATS_HOUR_DAYS`
    // is a restart rather than a rescan, and the time-of-day profile above is
    // built from all of them either way.
    const cutFrom = new Date();
    cutFrom.setHours(0, 0, 0, 0);
    cutFrom.setDate(cutFrom.getDate() - (HOURS_DAYS - 1));
    const cutKey = localHour(cutFrom.getTime()).slice(0, 10);
    const hourRows: TokenHour[] = [...hours.entries()]
      .filter(([hour]) => hour.slice(0, 10) >= cutKey)
      .map(([hour, t]) => ({
        hour, ...t, cost: hourCost.get(hour) ?? zeroCost(),
        // Descending by tokens inside the hour, for the same reason the day
        // rows are: a stable order where the mix is stable. Colour is still
        // assigned off the all-time model ranking by the screen.
        byModel: [...(hourModel.get(hour) ?? new Map()).entries()]
          .map(([model, tt]) => ({ model, totals: tt, cost: hourModelCost.get(hour)?.get(model) ?? zeroCost() }))
          .sort((x, y) => tokenTotal(y.totals) - tokenTotal(x.totals)),
      }))
      .sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
    // Stated from the ROWS, not from the cut: with nothing in the window the
    // honest answer is "no hours", and a `hoursFrom` pointing at a fortnight
    // that holds nothing would read as a fortnight off.
    const hoursFrom = hourRows.length ? dayToMs(hourRows[0].hour.slice(0, 10)) : null;
    const slotRows: TokenHourSlot[] = slots.map((t, hour) => ({ hour, ...t, cost: slotCost[hour] }));

    const group = (
      m: Map<string, TokenTotals>,
      costs: Map<string, CostBreakdown>,
      label: (k: string) => string,
      /** The model split, for the groups it means something on. A MODEL row's
       *  split would be the row itself, so only the repos get one. */
      split?: Map<string, Map<string, TokenTotals>>,
      splitCost?: Map<string, Map<string, CostBreakdown>>,
    ): TokenGroup[] =>
      [...m.entries()]
        .map(([key, t]) => ({
          key, label: label(key), ...t, cost: costs.get(key) ?? zeroCost(), priced: isPriced(key),
          ...(split ? {
            byModel: [...(split.get(key) ?? new Map()).entries()]
              .map(([model, tt]) => ({ model, totals: tt, cost: splitCost?.get(key)?.get(model) ?? zeroCost() }))
              .sort((x, y) => tokenTotal(y.totals) - tokenTotal(x.totals)),
          } : {}),
        }))
        .sort((a, b) => tokenTotal(b) - tokenTotal(a));

    // First and last are derived from the DAY keys rather than kept as instants:
    // the buckets are the only thing the store holds, and a span that disagreed
    // with the chart under it would be the readout contradicting itself.
    const first = dayRows[0]?.day ?? null;
    const last = dayRows[dayRows.length - 1]?.day ?? null;
    const ms = (d: string | null) => {
      if (!d) return null;
      const [y, mo, da] = d.split("-").map(Number);
      return new Date(y, (mo || 1) - 1, da || 1).getTime();
    };

    return {
      totals,
      days: dayRows,
      hours: hourRows,
      hoursFrom,
      hourOfDay: slotRows,
      // Labelled by the alias, not the raw id: the log records dated snapshots
      // (`claude-haiku-4-5-20251001`) and context variants, which are the same
      // model at the same price. The raw id stays as the row's `key`, so the
      // tooltip can still show exactly what ran.
      models: group(models, modelCost, (k) => normalizeModel(k) ?? k),
      repos: group(repos, repoCost, (k) => basename(k) || k, repoModel, repoModelCost),
      conversations,
      subagents,
      subagentLogs,
      cost,
      subagentCost: subCost,
      unpriced,
      fastTurns,
      coldStarts: {
        count: cold.count,
        tok: cold.tok,
        ...(cold.usd > 0 ? { usd: cold.usd } : {}),
        ...(cold.premiumUsd > 0 ? { premiumUsd: cold.premiumUsd } : {}),
      },
      top,
      pricesAsOf: PRICES_AS_OF,
      firstAt: ms(first),
      lastAt: ms(last),
      scannedAt: this.lastScan,
      logs: this.lastLogs,
      reread: this.lastReread,
    };
  }

  /**
   * The same ledger folded into PAST rate-limit windows — one grid per spec.
   *
   * ── Why this is a second read and not a field on the document ────────────
   *
   * `TokenStatsDoc` ships a bounded fortnight of hours, because the hours are
   * ~24× the rows of the days and a phone caches the whole document. That is
   * enough to cut the window running now and nothing older: a weekly window
   * from July is four months back in a record the wire does not carry. The
   * store, though, keeps every hour it ever saw — so the fold has to happen
   * HERE, and what crosses the wire is one small row per window that had
   * anything in it rather than a megabyte of buckets.
   *
   * ── Why the anchor is a PARAMETER ────────────────────────────────────────
   *
   * Neither the reset instant nor the length of a window is a fact about a
   * ledger of hours: one is scraped off the CLI's own `/usage` screen and the
   * other is a property of the plan. This module folds buckets into a grid
   * somebody else defined and asserts nothing about what the grid means, which
   * is also what keeps the two windows' semantics in ONE place on the phone.
   *
   * Only windows with something in them are returned. A window with no row ran
   * nothing — a reading, drawn as an empty cell — and `oldestHour` is what
   * tells that apart from a window the record does not reach back to.
   */
  async windowSeries(
    specs: { id: string; anchor: number; lenMs: number }[],
    maxAgeMs = 15_000,
  ): Promise<TokenWindowsDoc> {
    if (Date.now() - this.lastScan > maxAgeMs) {
      this.inFlight ??= this.refresh().finally(() => { this.inFlight = null; });
      try { await this.inFlight; } catch { /* fold what we already have */ }
    }

    /** spec index → cell index → model → the two tallies. Crossed by model for
     *  the reason everything here is: a rate belongs to a model and a day, so a
     *  cell priced as a whole would be charged at whichever model happened to
     *  come last. */
    const cells = specs.map(() => new Map<number, Map<string, { t: TokenTotals; c: CostBreakdown }>>());
    let oldest = "";
    let newest = "";

    for (const files of Object.values(this.store)) {
      for (const sum of Object.values(files)) {
        for (const [key, tally] of Object.entries(sum.x)) {
          const [hour, model] = uncross(key);
          // A record whose timestamp would not parse carries the empty hour and
          // is in no time bucket at all — the same thing `aggregate()` does
          // with it, and the same reason: a window is an instant, and a row
          // with no instant cannot be put in one.
          if (!hour) continue;
          if (!oldest || hour < oldest) oldest = hour;
          if (!newest || hour > newest) newest = hour;
          const hourMs = hourToMs(hour);
          const day = hour.slice(0, 10);
          const v = tallyToTotals(tally);
          const c = costOf(v, model, day || undefined);
          for (let i = 0; i < specs.length; i++) {
            for (const k of windowCells(hourMs, specs[i].anchor, specs[i].lenMs)) {
              const cell = cells[i].get(k) ?? cells[i].set(k, new Map()).get(k)!;
              const bag = cell.get(model) ?? cell.set(model, { t: zeroTotals(), c: zeroCost() }).get(model)!;
              addTotals(bag.t, v);
              // An unpriced model adds tokens and no money — never a zero
              // charge, which reads as free. The window's own `priced` story is
              // the model rows underneath it.
              if (c) addCost(bag.c, c);
            }
          }
        }
      }
    }

    const series: TokenWindowSeries[] = specs.map((spec, i) => ({
      id: spec.id,
      anchor: spec.anchor,
      lenMs: spec.lenMs,
      windows: [...cells[i].entries()]
        .map(([back, byModel]): TokenWindow => {
          const totals = zeroTotals();
          const cost = zeroCost();
          const models: ModelSlice[] = [];
          for (const [model, bag] of byModel) {
            addTotals(totals, bag.t);
            addCost(cost, bag.c);
            models.push({ model, totals: bag.t, cost: bag.c });
          }
          return {
            back, ...totals, cost,
            // Descending by tokens, the order every other split here is in, so
            // colour assigned off the all-time ranking still lands on a stable
            // list.
            byModel: models.sort((a, b) => tokenTotal(b.totals) - tokenTotal(a.totals)),
          };
        })
        // Ascending by `back`: the newest window is `back: 0`, and a grid is
        // drawn from one end or the other by the screen, never by the order a
        // Map happened to be filled in.
        .sort((a, b) => a.back - b.back),
      oldestHour: oldest ? hourToMs(oldest) : null,
      newestHour: newest ? hourToMs(newest) : null,
    }));

    return { series, scannedAt: this.lastScan };
  }

  /**
   * The same store folded over an arbitrary `[from, to)` — `GET /api/costwindow`,
   * the "where did this week go" read. The fold and its edge rule are
   * `costwindow.ts`'s; this only brings the store up to date first.
   */
  async costWindow(from: number, to: number, meta: CostMeta, maxAgeMs = 15_000): Promise<CostWindowDoc> {
    if (Date.now() - this.lastScan > maxAgeMs) {
      this.inFlight ??= this.refresh().finally(() => { this.inFlight = null; });
      try { await this.inFlight; } catch { /* fold what we already have */ }
    }
    return foldCostWindow(this.store, from, to, meta, this.lastScan);
  }

  private schedule(): void {
    if (this.timer || !this.dirty) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS);
    this.timer.unref?.();
  }

  /** Write now. Called on the debounce and on SIGTERM — losing it costs a
   *  4.5 s rebuild on the next open, which after a routine restart is exactly
   *  the wait this store exists to remove. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    try {
      writeJsonAtomic(this.path, { v: VERSION, store: this.store });
      this.dirty = false;
    } catch { /* a statistics cache is not worth taking the daemon down for */ }
  }
}
