/**
 * Claude's ledger with the NON-Anthropic models taken out — pure, so `node --test` runs it.
 *
 * claude-local is the Claude Code binary pointed at another runner, so an
 * Ollama model's tokens land in the SAME jsonl logs as Claude's own, and the
 * Claude Code tab used to count `qwen3-coder:30b-64k` into a hero that reads as
 * "what Claude did". The host makes the complementary cut for the claude-local
 * tab (`localSliceLedger`); this makes this one, off the per-model buckets the
 * document already carries — no second tally, so the two tabs show every token
 * exactly once and are never summed.
 *
 * What is cut, exactly: `totals`, `cost`, `unpriced`, `models`, and every day,
 * hour and repo through its `byModel` slices (a day's subagent launches by
 * their model). What CANNOT be cut, because the store does not cross it with
 * the model, is named in `unsplit` and the screen says so in a sentence: the
 * clock face, the subagent slice, the costliest conversations, the expired-cache
 * tally, the conversation count, and the rate-limit window boxes the host folds.
 * (The per-repo request split, `byRepo`, keeps local turns in `turns` — but they
 * were never in `pricedTurns`, the only denominator a price per request uses.)
 *
 * A bucket with tokens and NO `byModel` (an older host) makes the cut
 * impossible — refused with a sentence, and the screen shows every model, never
 * a half-cut document.
 */
import {
  type CostBreakdown, isAnthropicModel, type ModelSlice, type TokenDay, type TokenGroup, type TokenHour,
  type TokenStatsDoc, type TokenTotals, tokenTotal,
} from "@waterplane/shared";

export interface LocalSplit {
  /** The document with only Anthropic's models in it. */
  doc: TokenStatsDoc;
  /** The model ids taken out, largest first. */
  local: string[];
  /** Their tokens, all time — the figure the note under the switch names. */
  localTok: number;
  /** Models drawn on the cut view / in the whole ledger. */
  shown: number;
  all: number;
  /** Readings on screen the cut does not reach — said, never silently mixed. */
  unsplit: string[];
}

export const UNSPLIT = [
  "the time-of-day clock",
  "the subagent slice",
  "the costliest conversations",
  "the expired-cache tally",
  "the conversation count",
  "the rate-limit window boxes",
] as const;

const KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "turns"] as const;
const CKEYS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/** `a − b` per kind, clamped at zero: a malformed slice must not make a bucket negative. */
export function subTotals<T extends TokenTotals>(a: T, b: TokenTotals): T {
  const out = { ...a };
  for (const k of KEYS) out[k] = Math.max(0, (a[k] ?? 0) - (b[k] ?? 0));
  return out;
}

export function subCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const out = { ...a };
  for (const k of CKEYS) out[k] = Math.max(0, (a[k] ?? 0) - (b[k] ?? 0));
  return out;
}

const isLocal = (model: string) => !isAnthropicModel(model);
const active = (t: TokenTotals) => tokenTotal(t) > 0 || t.turns > 0;

/** Take the local slices off one bucket that carries `byModel`. */
function cutBucket<B extends TokenTotals & { cost: CostBreakdown; byModel?: ModelSlice[] }>(b: B): B {
  let out = { ...b };
  const keep: ModelSlice[] = [];
  for (const s of b.byModel ?? []) {
    if (isLocal(s.model)) { out = subTotals(out, s.totals); out.cost = subCost(out.cost, s.cost); }
    else keep.push(s);
  }
  out.byModel = keep;
  return out;
}

/** A bucket with activity and no model split cannot be cut. */
const uncuttable = (b: TokenTotals & { byModel?: ModelSlice[] }) => active(b) && !b.byModel;

/**
 * The cut, or why there is none.
 *
 * `null` — no local model in the ledger, nothing to cut, and the screen is
 * exactly what it was. `{refused}` — there are local models but some bucket has
 * no model split; the screen shows everything and says why.
 */
export function splitLocal(doc: TokenStatsDoc): LocalSplit | { refused: string } | null {
  const localGroups = doc.models.filter((g) => isLocal(g.key) && active(g));
  if (localGroups.length === 0) return null;
  const names = localGroups.map((g) => g.key);
  if (doc.days.some(uncuttable) || doc.hours.some(uncuttable) || doc.repos.some(uncuttable)) {
    return {
      refused: `${names.join(", ")} ${names.length === 1 ? "is" : "are"} not Anthropic’s, but this host’s document does not split every day, hour and repo by model, so they cannot be taken out — every model is counted below. A re-scan on a current host splits them.`,
    };
  }
  let totals = { ...doc.totals };
  let cost = { ...doc.cost };
  let unpriced = { ...doc.unpriced };
  for (const g of localGroups) {
    totals = subTotals(totals, g);
    cost = subCost(cost, g.cost);
    // Every non-Anthropic id is outside the list, so it was counted unpriced.
    unpriced = subTotals(unpriced, g);
  }
  const days: TokenDay[] = doc.days
    .map((d) => {
      const c = cutBucket(d);
      return d.agents ? { ...c, agents: d.agents.filter((a) => !isLocal(a.model)) } : c;
    })
    .filter(active);
  const hours: TokenHour[] = doc.hours.map(cutBucket).filter(active);
  const repos: TokenGroup[] = doc.repos.map(cutBucket).filter(active);
  const models = doc.models.filter((g) => !isLocal(g.key));
  return {
    doc: { ...doc, totals, cost, unpriced, days, hours, repos, models },
    local: names,
    localTok: localGroups.reduce((n, g) => n + tokenTotal(g), 0),
    shown: models.length,
    all: doc.models.length,
    unsplit: [...UNSPLIT],
  };
}

/** The sentence under the switch, for the cut view. `tab` is the label of the
 *  tab the local models are on, when this host has one. */
export function splitNoteText(s: LocalSplit, fmt: (n: number) => string, tab: string | null): string {
  const where = tab ? `they are on the ${tab} tab` : "this host has no tab for them, so show all to include them";
  return `${s.shown} of ${s.all} models shown — ${s.local.length === 1 ? "one model is" : `${s.local.length} models are`} not Anthropic’s (${s.local.join(", ")}, ${fmt(s.localTok)} tokens); ${where}. Not split by model, so still counting them: ${s.unsplit.join(", ")}.`;
}

/** The sentence for the uncut view, so "all" is never mistaken for "Anthropic's". */
export function allNoteText(s: LocalSplit, fmt: (n: number) => string): string {
  return `All ${s.all} models shown, including ${s.local.length === 1 ? "one" : s.local.length} not Anthropic’s (${s.local.join(", ")}, ${fmt(s.localTok)} tokens).`;
}
