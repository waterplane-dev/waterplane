/**
 * The cost WINDOW: the token ledger folded over an arbitrary `[from, to)` span,
 * by hour, by repo and by conversation — `GET /api/costwindow`.
 *
 * ── Why a fold of its own and not a field on `TokenStatsDoc` ─────────────
 *
 * The all-time document cannot answer "where did THIS week go": its repo rows
 * and its costliest list are all-time, and its hour rows carry no
 * conversation. The store (`tokenstats.ts`) keeps every hour of every file
 * crossed by model, so any span can be cut out of it here, priced per (model,
 * day) exactly as `aggregate()` prices it — the two folds must agree to the
 * cent over a span that covers everything.
 *
 * ── The one edge rule ────────────────────────────────────────────────────
 *
 * An hour is the finest bucket on record, so an hour whose top is `h` is in iff
 * `h >= hourFloor(from) && h < to`. Where a WINDOW starts is not decided here:
 * the phone sends `from` = `windowStartHour(openedAt)` (shared — the nearest
 * hour boundary, `windowCells`' rule and the live cut's), already on the hour,
 * so the floor is the identity and both ends agree on the edge by construction.
 * The floor only bites for a caller that asks from a raw instant (the burn
 * push's stretch), and the document says how much wider than asked that is
 * (`fromHour`).
 *
 * ── What it never does ───────────────────────────────────────────────────
 *
 * It never charges an unpriced model zero (those tokens go to `unpriced`), it
 * never drops a conversation nobody can name (title and launch are JOINED from
 * what the host holds and are absent when it holds nothing), and a lookup that
 * throws leaves its field absent rather than failing the read.
 */

import { basename } from "node:path";
import {
  COST_CONVOS_CAP, PRICES_AS_OF, addCost, addTotals, clipClosedText, costOf, hourFloor, hourKeyMs, tokenTotal, undatedLogsOf, undatedSince,
  zeroCost, zeroTotals,
  type ClosedSession, type CostBreakdown, type CostConvo, type CostConvoHour, type CostConvoRest, type CostHour, type CostHourRepo,
  type CostLaunch, type CostWindowDoc, type Intent, type ModelSlice, type SessionInfo, type SessionOrigin,
  type TokenTotals,
} from "@waterplane/shared";
import { CROSS, type FileSummary, type Tally } from "./tokenscan.js";

/** slug (project dir name) → path below it, no extension → summary (`tokenstats.ts`' store). */
export type Files = Record<string, Record<string, FileSummary>>;

/** What the host knows about a conversation beyond its ledger, keyed by the CLI's conversation id. */
export interface CostMeta {
  byConv: Map<string, { title?: string; live: boolean; launch?: CostLaunch }>;
}

/**
 * The repo a worktree belongs to. An agent worktree the CLI makes under
 * `<repo>/.claude/worktrees/<name>` is that repo's work — counted apart it
 * printed `agent-aae5b06d449c4da1a` as a repo of its own in the by-repo list,
 * beside the repo it was spending for. Lives here (re-exported by
 * `tokenstats.ts`) so this module and that one import each other in one
 * direction only.
 */
export function repoOfWorktree(w: string): string {
  const i = w.indexOf("/.claude/worktrees/");
  return i > 0 ? w.slice(0, i) : w;
}

const UNKNOWN_REPO = "unknown repo";
const repoLabel = (repo: string): string => (repo ? basename(repo) || repo : UNKNOWN_REPO);

const uncross = (k: string): [hour: string, model: string] => {
  const i = k.indexOf(CROSS);
  return i < 0 ? ["", k] : [k.slice(0, i), k.slice(i + 1)];
};

const tallyToTotals = (t: Tally): TokenTotals =>
  ({ input: t[0], output: t[1], cacheRead: t[2], cacheWrite: t[3], cacheWrite1h: t[4], turns: t[5] });

type Bag = { totals: TokenTotals; cost: CostBreakdown };
const bag = (): Bag => ({ totals: zeroTotals(), cost: zeroCost() });
const slot = <K, V>(m: Map<K, V>, k: K, blank: () => V): V => m.get(k) ?? m.set(k, blank()).get(k)!;
const slices = (m: Map<string, Bag>): ModelSlice[] =>
  [...m.entries()]
    .map(([model, b]) => ({ model, totals: b.totals, cost: b.cost }))
    .sort((a, b) => tokenTotal(b.totals) - tokenTotal(a.totals));
const byCostDesc = (a: Bag, b: Bag): number =>
  (b.cost.total - a.cost.total) || (tokenTotal(b.totals) - tokenTotal(a.totals));

interface ConvoAcc extends Bag {
  id: string;
  repo: string;
  agentTotals: TokenTotals;
  agentCost: CostBreakdown;
  agents: number;
  first: string;
  last: string;
  byModel: Map<string, Bag>;
  agentByModel: Map<string, Bag>;
  byHour: Map<string, CostConvoHour>;
}

/** A folded group's launch: a run's own fields only — one target's `itemId` (and model) is not
 *  the run's, and a group of forty must not name one member as if it were the whole. */
const groupLaunch = (l: CostLaunch): CostLaunch =>
  l.runId ? { kind: l.kind, runId: l.runId, ...(l.label ? { label: l.label } : {}) } : l;

interface HourAcc extends Bag {
  byRepo: Map<string, Bag>;
  byModel: Map<string, Bag>;
}

/**
 * Records the store counted that carry no readable timestamp (the empty hour of `crossKey`): in
 * every total, in no hour. Said on every document that sums hours (`undated`), so a span figure
 * reads ABSENT by the shared rule (`undatedWhy`) instead of a floor that looks exact. Derived from
 * the store as it is — a store written before this field existed already keeps those records under
 * the empty hour, so nothing is rescanned. With `from`, only logs whose mtime is at or after it
 * (or unknown) count: per-file mtime and the per-file empty-hour tally are already in the store,
 * so the bound needs no version bump and no rescan.
 */
export function undatedRecords(files: Files, from = -Infinity): number {
  const n = undatedSince(undatedFields(files), from);
  return typeof n === "number" ? n : 0;
}

/**
 * The undated fields every claude document carries (`TokenStatsDoc.undated`/`undatedUntil`/
 * `undatedLogs`), built ONCE from the store, so the count a window prints on the phone and the one
 * `/api/costwindow` sends come from one list read by one function (shared `undatedSince`).
 */
export function undatedFields(files: Files): { undated: number; undatedUntil?: number; undatedLogs?: Array<[number, number]> } {
  const byFile = undatedByFile(files);
  const undated = byFile.reduce((n, [, k]) => n + k, 0);
  if (undated === 0) return { undated };
  const until = undatedUntil(files);
  const logs = undatedLogsOf(byFile);
  return { undated, ...(until != null ? { undatedUntil: until } : {}), ...(logs.length ? { undatedLogs: logs } : {}) };
}

/**
 * The newest mtime of a log holding an undated record (`TokenStatsDoc.undatedUntil`), undefined
 * when there is none or any such log's mtime is unknown (then no span may be called clean).
 */
export function undatedUntil(files: Files): number | undefined {
  let newest: number | undefined;
  for (const [m] of undatedByFile(files)) {
    if (!Number.isFinite(m)) return undefined;
    newest = newest == null ? m : Math.max(newest, m);
  }
  return newest;
}

/**
 * `[mtime, count]` per log holding records with no readable hour. A record in a log is never
 * later than the log's mtime (`FileSummary.m`), so only logs written at or after a span's start
 * can hold one of its records — the bound that keeps one odd old log from blanking every window.
 */
function undatedByFile(files: Files): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const byFile of Object.values(files)) {
    for (const sum of Object.values(byFile)) {
      let k = 0;
      for (const [key, t] of Object.entries(sum.x)) {
        if (uncross(key)[0] === "") k += t[5];
      }
      if (k > 0) out.push([typeof sum.m === "number" ? sum.m : NaN, k]);
    }
  }
  return out;
}

/**
 * Fold the store over `[from, to)`. Pure: no clock, no disk.
 *
 * The tally loop is `aggregate()`'s — uncross, `tallyToTotals`, `costOf` per
 * (model, day) — so a cent here is a cent there. An agent transcript folds into
 * the conversation `fileKey.split("/")[0]` names; a conversation whose logs
 * named no cwd is the "" repo ("unknown repo"); a record with no parseable
 * timestamp has no hour and is in no window.
 */
export function foldCostWindow(
  files: Files, from: number, to: number, meta: CostMeta, scannedAt: number, cap: number = COST_CONVOS_CAP,
): CostWindowDoc {
  const fromHour = hourFloor(from);
  const totals = zeroTotals();
  const cost = zeroCost();
  const agentTotals = zeroTotals();
  const agentCost = zeroCost();
  const unpriced = zeroTotals();
  const hours = new Map<string, HourAcc>();
  const convos = new Map<string, ConvoAcc>();

  // Pass 1, over EVERY file and not just the window's: a conversation's repo
  // is its parent's worktree, whenever the parent ran — an agent's only holds
  // the place where the parent named none. Settled first so the hour's repo
  // split and the conversation row cannot name two different repos.
  // Keyed by slug too, as `aggregate()` keys it: two project directories never
  // share a conversation, but nothing enforces it.
  const repoOf = new Map<string, { repo: string; parent: boolean }>();
  for (const [slug, byFile] of Object.entries(files)) {
    for (const [fileKey, sum] of Object.entries(byFile)) {
      if (!sum.w) continue;
      const cKey = `${slug}\u0000${fileKey.split("/")[0]}`;
      const had = repoOf.get(cKey);
      if (!sum.sub) repoOf.set(cKey, { repo: repoOfWorktree(sum.w), parent: true });
      else if (!had) repoOf.set(cKey, { repo: repoOfWorktree(sum.w), parent: false });
    }
  }

  for (const [slug, byFile] of Object.entries(files)) {
    for (const [fileKey, sum] of Object.entries(byFile)) {
      const convoId = fileKey.split("/")[0];
      const sub = !!sum.sub;
      const cKey = `${slug}\u0000${convoId}`;
      const repo = repoOf.get(cKey)?.repo ?? "";
      let cv: ConvoAcc | undefined;
      for (const [key, tally] of Object.entries(sum.x)) {
        const [hour, model] = uncross(key);
        if (!hour) continue;
        const h = hourKeyMs(hour);
        if (!(h >= fromHour && h < to)) continue;
        const v = tallyToTotals(tally);
        if (tokenTotal(v) <= 0) continue;
        if (!cv) {
          cv = slot(convos, cKey, () => ({
            id: convoId, repo, ...bag(), agentTotals: zeroTotals(), agentCost: zeroCost(),
            agents: 0, first: "", last: "", byModel: new Map(), agentByModel: new Map(), byHour: new Map(),
          }));
          // One transcript with a turn in the window is one agent, however
          // many hours it spans.
          if (sub) cv.agents++;
        }

        const day = hour.slice(0, 10);
        const c = costOf(v, model, day);
        const ha = slot(hours, hour, () => ({ ...bag(), byRepo: new Map(), byModel: new Map() }));
        const touched: Bag[] = [slot(cv.byModel, model, bag), slot(ha.byModel, model, bag), slot(ha.byRepo, repo, bag)];
        const agentSide: Bag[] = sub ? [slot(cv.agentByModel, model, bag)] : [];
        const ch = slot(cv.byHour, hour, () => ({ hour, usd: 0, tok: 0 }));
        if (!cv.first || hour < cv.first) cv.first = hour;
        if (!cv.last || hour > cv.last) cv.last = hour;
        ch.tok += tokenTotal(v);
        addTotals(totals, v); addTotals(cv.totals, v); addTotals(ha.totals, v);
        for (const b of touched) addTotals(b.totals, v);
        // A slice OF the totals, never a second total.
        if (sub) { addTotals(agentTotals, v); addTotals(cv.agentTotals, v); for (const b of agentSide) addTotals(b.totals, v); }
        // An unpriced model adds tokens and no money — never a zero charge,
        // which reads as free.
        if (!c) { addTotals(unpriced, v); continue; }
        ch.usd += c.total;
        addCost(cost, c); addCost(cv.cost, c); addCost(ha.cost, c);
        for (const b of touched) addCost(b.cost, c);
        if (sub) { addCost(agentCost, c); addCost(cv.agentCost, c); for (const b of agentSide) addCost(b.cost, c); }
      }
    }
  }

  // The cap: the dearest `cap` conversations ship whole, the rest fold by
  // repo × launch (`CostConvoRest`) so every total, repo and launch stays
  // whole. Hours already count everything; they gain how many of their
  // conversations are folded, and `convoIds` on the phone are built from the
  // carried rows only, so no hour names a conversation that is not there.
  const ranked = [...convos.values()].sort(byCostDesc);
  const keep = Math.max(0, Math.floor(cap));
  const folded = ranked.slice(keep);
  const restByHour = new Map<string, number>();
  const restGroups = new Map<string, CostConvoRest & { models: Map<string, Bag> }>();
  for (const cv of folded) {
    for (const hour of cv.byHour.keys()) restByHour.set(hour, (restByHour.get(hour) ?? 0) + 1);
    const launch = meta.byConv.get(cv.id)?.launch;
    const gKey = `${cv.repo}\u0000${launch?.runId || launch?.itemId || launch?.kind || ""}`;
    const g = slot(restGroups, gKey, () => ({
      repo: cv.repo, label: repoLabel(cv.repo), ...(launch ? { launch: groupLaunch(launch) } : {}),
      count: 0, agents: 0, ...bag(), agentTotals: zeroTotals(), agentCost: zeroCost(),
      byModel: [], firstAt: null, lastAt: null, models: new Map<string, Bag>(),
    }));
    g.count++;
    g.agents += cv.agents;
    addTotals(g.totals, cv.totals); addCost(g.cost, cv.cost);
    addTotals(g.agentTotals, cv.agentTotals); addCost(g.agentCost, cv.agentCost);
    for (const [model, b] of cv.byModel) { const m = slot(g.models, model, bag); addTotals(m.totals, b.totals); addCost(m.cost, b.cost); }
    const f = cv.first ? hourKeyMs(cv.first) : null;
    const l = cv.last ? hourKeyMs(cv.last) : null;
    if (f != null) g.firstAt = g.firstAt == null ? f : Math.min(g.firstAt, f);
    if (l != null) g.lastAt = g.lastAt == null ? l : Math.max(g.lastAt, l);
  }
  const rest: CostConvoRest[] = [...restGroups.values()]
    .map(({ models, ...g }) => ({ ...g, byModel: slices(models) }))
    .sort(byCostDesc);

  const convoRows: CostConvo[] = ranked
    .slice(0, keep)
    .map((cv) => {
      const m = meta.byConv.get(cv.id);
      const row: CostConvo = {
        id: cv.id,
        repo: cv.repo,
        label: repoLabel(cv.repo),
        firstAt: cv.first ? hourKeyMs(cv.first) : null,
        lastAt: cv.last ? hourKeyMs(cv.last) : null,
        totals: cv.totals,
        cost: cv.cost,
        agentTotals: cv.agentTotals,
        agentCost: cv.agentCost,
        agents: cv.agents,
        byModel: slices(cv.byModel),
        agentByModel: slices(cv.agentByModel),
        byHour: [...cv.byHour.values()].sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0)),
        live: m?.live ?? false,
        ...(m?.title ? { title: m.title } : {}),
        ...(m?.launch ? { launch: m.launch } : {}),
      };
      return row;
    });

  const hourRows: CostHour[] = [...hours.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hour, ha]) => ({
      hour,
      t: hourKeyMs(hour),
      totals: ha.totals,
      cost: ha.cost,
      byRepo: [...ha.byRepo.entries()]
        .map(([repo, b]): CostHourRepo => ({ repo, label: repoLabel(repo), totals: b.totals, cost: b.cost }))
        .sort(byCostDesc),
      byModel: slices(ha.byModel),
      ...(restByHour.get(hour) ? { restConvos: restByHour.get(hour) } : {}),
    }));

  return {
    from, to, fromHour,
    hours: hourRows,
    convos: convoRows,
    ...(folded.length ? { convosTotal: ranked.length, rest } : {}),
    totals, cost, agentTotals, agentCost, unpriced,
    pricesAsOf: PRICES_AS_OF,
    scannedAt,
    // Only logs written since the window opened can hold an undated record IN it.
    undated: undatedRecords(files, fromHour),
  };
}

/** Longest label a launch carries — the DTO's clip. */
const LABEL_CAP = 120;

/** `a@t#3` → `a@t`: a fan-out target's id is `${runId}#${n}` (`fanout.ts`). */
const runIdOf = (itemId: string | undefined): string | undefined => {
  if (!itemId) return undefined;
  const i = itemId.lastIndexOf("#");
  return i > 0 ? itemId.slice(0, i) : undefined;
};

const tryGet = <T>(f: () => T): T | undefined => {
  try { return f(); } catch { return undefined; }
};

/**
 * Join titles and launches from what the host already holds: the live
 * sessions (and how each was opened), the closed stack, and the intent rows a
 * fan-out run left behind. Live wins over closed; among closed rows the newest
 * (first in the stack) wins. Never throws — a lookup that throws leaves its
 * field absent, because a missing name is a row labelled `repo · id8` and a
 * failed read is a card with nothing on it.
 */
export function costMeta(
  sessions: { list(): SessionInfo[]; originOf(id: string): SessionOrigin | undefined; listClosed(): ClosedSession[] },
  intents: { get(id: string): Intent | undefined },
): CostMeta {
  const byConv: CostMeta["byConv"] = new Map();
  const runLabels = new Map<string, string | undefined>();

  /** A run's display label off its parent row (a scheduled sweep's occurrence
   *  `id@startedAt` is labelled by its standing row `id`). */
  const runLabel = (runId: string): string | undefined => {
    if (runLabels.has(runId)) return runLabels.get(runId);
    const it = tryGet(() => intents.get(runId.split("@")[0]));
    const step = it?.payload?.kind === "prompt" ? it.payload.steps?.[0] : undefined;
    const label = it ? clipClosedText(it.label ?? it.headline ?? it.title ?? step, LABEL_CAP) : undefined;
    runLabels.set(runId, label);
    return label;
  };

  const launchOf = (kind: CostLaunch["kind"] | undefined, itemId?: string, itemLabel?: string, model?: string): CostLaunch | undefined => {
    if (!kind) return undefined;
    // A fan-out target names its run; a resurrect of one keeps that grouping.
    const runId = kind === "fanout" || kind === "resurrect" ? runIdOf(itemId) : undefined;
    // The RUN's label first for a fan-out: every target of one run carries the
    // same prompt as its own label, and the run's name is what was launched.
    const label = (runId ? runLabel(runId) : undefined) ?? clipClosedText(itemLabel, LABEL_CAP);
    return {
      kind,
      ...(runId ? { runId } : {}),
      ...(itemId ? { itemId } : {}),
      ...(label ? { label } : {}),
      ...(model ? { model } : {}),
    };
  };

  for (const info of tryGet(() => sessions.list()) ?? []) {
    const id = info.claudeSessionId;
    if (!id || byConv.has(id)) continue;
    const o = tryGet(() => sessions.originOf(info.id));
    const title = clipClosedText(info.tabTitle ?? info.title);
    const launch = tryGet(() => launchOf(o?.kind, o?.itemId, o?.itemLabel, info.model));
    byConv.set(id, { live: true, ...(title ? { title } : {}), ...(launch ? { launch } : {}) });
  }
  for (const row of tryGet(() => sessions.listClosed()) ?? []) {
    const id = row.claudeSessionId;
    if (!id || byConv.has(id)) continue;
    const title = clipClosedText(row.tabTitle ?? row.title);
    const launch = tryGet(() => launchOf(row.kind, row.itemId, row.itemLabel, row.model ?? row.launch?.model));
    byConv.set(id, { live: false, ...(title ? { title } : {}), ...(launch ? { launch } : {}) });
  }
  return { byConv };
}
