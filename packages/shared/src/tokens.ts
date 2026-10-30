/**
 * What a pile of token counts MEANS — the derived figures and the words for
 * them, in one place because both ends say them.
 *
 * ── The one way this readout can lie ────────────────────────────────────────
 *
 * Measured across one machine's 9,444 conversation logs: 13.65 billion tokens
 * total, of which **13.15 billion — 96% — were cache reads**. Output was 29.7M
 * and fresh input was 1.0M. So "tokens used" as a single number is, almost
 * entirely, the conversation being re-read out of the prompt cache on every
 * turn. That is a real thing that really happened and it is worth showing, but
 * a reader who takes it for "what I spent" is out by two orders of magnitude.
 *
 * Every rule here follows from that: the four kinds are never merged in a
 * store or a DTO, the total always ships beside its split, and `TOKEN_KINDS`
 * carries a sentence per kind so no screen has to invent one.
 */
import { CACHE_READ_MULT, CACHE_WRITE_1H_MULT, CACHE_WRITE_5M_MULT, addCost, zeroCost } from "./pricing.js";
import type { TokenGroup, TokenTotals } from "./wire/telemetry.js";

/** An empty tally, for a fold's seed and for a group nobody has written to. */
export function zeroTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, turns: 0 };
}

/** Add `b` into `a`, in place. The one fold every aggregate uses. */
export function addTotals(a: TokenTotals, b: Partial<TokenTotals>): TokenTotals {
  a.input += b.input ?? 0;
  a.output += b.output ?? 0;
  a.cacheRead += b.cacheRead ?? 0;
  a.cacheWrite += b.cacheWrite ?? 0;
  a.cacheWrite1h += b.cacheWrite1h ?? 0;
  a.turns += b.turns ?? 0;
  return a;
}

/**
 * Every token that passed through, of any kind. Never shown without the split
 * beside it — see the header.
 *
 * `cacheWrite1h` is deliberately absent: it is a SUBSET of `cacheWrite`, kept
 * only so the cost estimate can charge the 2× tier correctly. Adding it here
 * would double-count 84% of the cache writes.
 */
export function tokenTotal(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

export type TokenKind = "input" | "output" | "cacheRead" | "cacheWrite";

/**
 * The four kinds, in a FIXED order.
 *
 * Fixed because the order IS the colour assignment: a categorical hue follows
 * the entity and never its rank, so a filter or a re-sort must not repaint the
 * survivors. The `slot` is an index into the chart palette, owned by the web
 * side; this file names the entity, not the colour.
 */
export const TOKEN_KINDS: { id: TokenKind; slot: number; name: string; what: string }[] = [
  {
    id: "input", slot: 0, name: "Input",
    what: "Fresh prompt tokens — the part of each request that was not already in the cache. The smallest of the four by a wide margin, and the one closest to “what I typed”.",
  },
  {
    id: "output", slot: 1, name: "Output",
    what: "Everything the model generated: replies, tool calls, thinking. The number that tracks how much work came back.",
  },
  {
    id: "cacheRead", slot: 2, name: "Cache read",
    what: "Context served out of the prompt cache. Usually the overwhelming majority — every turn re-reads the whole conversation — which is why a single “tokens used” figure is mostly this.",
  },
  {
    id: "cacheWrite", slot: 3, name: "Cache write",
    what: "Context written into the cache so later turns can read it back. Rises when a conversation grows or is compacted.",
  },
];

/**
 * A `ContextSample.kinds` tuple as the shape everything else here speaks.
 *
 * The ONE reader of that tuple's order, and the reason it may be a tuple at
 * all: 1,200 samples × four key names is most of a document's bytes, but a
 * positional array read in two places is a chart with the right numbers in the
 * wrong colours the first time somebody reorders `TOKEN_KINDS`. So the order
 * lives here, beside the list it has to match, and nothing else indexes it.
 *
 * `turns: 1` because a sample IS one request — the same denominator
 * `tokenstats.ts` counts, so a per-request figure means the same thing on the
 * per-session screen and the corpus one.
 */
export function sampleTotals(k: readonly [number, number, number, number]): TokenTotals {
  return { input: k[0], output: k[1], cacheRead: k[2], cacheWrite: k[3], cacheWrite1h: 0, turns: 1 };
}

/**
 * How much of the context the cache carried, 0..100, or null when there is
 * nothing to divide.
 *
 * Deliberately over `cacheRead / (cacheRead + cacheWrite + input)` — the three
 * kinds that make up what went IN. Output is not context and putting it in the
 * denominator would make the ratio drift with how talkative the model was
 * rather than with how well the cache worked.
 */
export function cacheHitPct(t: TokenTotals): number | null {
  const served = t.cacheRead + t.cacheWrite + t.input;
  return served > 0 ? (t.cacheRead / served) * 100 : null;
}

/** Mean tokens per assistant turn, or null with no turns. */
export function perTurn(t: TokenTotals): number | null {
  return t.turns > 0 ? tokenTotal(t) / t.turns : null;
}

/**
 * ── Is a 96% cache-read share GOOD, or is it context pollution? ─────────────
 *
 * The question this screen invites and could not answer. A reader who sees one
 * kind at 96% of the tokens and 55% of the money reasonably asks whether that
 * is the cache doing its job or the same bloated conversation being re-read for
 * ever, and those are two different facts that happen to look identical in a
 * share.
 *
 * **The share cannot tell them apart, so it is never asked to.** A cache read
 * bills at `CACHE_READ_MULT` — a tenth of the input rate — so context arriving
 * as a cache read rather than as fresh input is the CHEAP shape of the same
 * traffic, and a share near 100% is what a healthy corpus looks like. The share
 * would only fall by re-sending that context at full price. There is no number
 * of cache reads that is "too many" in itself.
 *
 * Two ratios underneath it do carry a verdict, and both are arithmetic over
 * counts already on the wire rather than a judgement:
 *
 *   • **Reuse** — `cacheRead / cacheWrite`, how many times each token written
 *     into the cache was read back. A write costs 1.25× (5-minute) or 2×
 *     (1-hour) the input rate against 0.1× for a read, so a write pays for
 *     itself at `mult / (1 - CACHE_READ_MULT)` reads — about 1.4 and 2.2. Below
 *     that the caching is LOSING money against simply sending the tokens fresh,
 *     which is a real and nameable failure: sessions dying before their prefix
 *     is read back, or a window invalidated every turn.
 *   • **Context per turn** — what a turn actually carried. THIS is the pollution
 *     number: the measurement in `sessioncost.ts`'s header found conversations
 *     past ~200k carrying 76% of every token spent on this desktop. It is the
 *     size of the window, not the share of it served from cache, that makes a
 *     turn expensive.
 *
 * The caveat travels with it because it is the same measurement: this is a MEAN
 * over every turn on disk, and the distribution it came from was 1.4% of
 * conversations holding 76% of the tokens. A lean average does not mean there
 * are no monsters — `sessionCost` is the per-conversation reading and the only
 * one that can name one.
 *
 * Sentences, never a gate, for the reason `sessioncost.ts` states at length.
 */

/** Context per turn at which the corpus's own measurement says a conversation
 *  has become the expensive kind. Read off that measurement, not chosen. */
export const CTX_PER_TURN_HEAVY = 200_000;
/** Below this a mean turn is nowhere near the heavy tail. */
export const CTX_PER_TURN_LEAN = 100_000;

export type CachePosture = "lean" | "ordinary" | "heavy";

export interface CacheReading {
  /** `cacheHitPct`, carried so a caller states the share it is judging. */
  sharePct: number;
  /** Reads per written token, or null when nothing was written. */
  reuse: number | null;
  /** Reads a write must earn back to beat sending the tokens fresh, blended
   *  across the two TTL tiers actually used. Null when nothing was written. */
  payback: number | null;
  /** Mean context carried per turn — read + write + input over turns. Null when
   *  no turns were counted, and then there is no posture either. */
  perTurnCtx: number | null;
  posture: CachePosture | null;
  /** What the share means. */
  cacheNote: string;
  /** What the per-turn context means, or null when turns are unknown. */
  contextNote: string | null;
  /** The one thing worth doing about it, when there is one. */
  advice: string | null;
}

/** Reads a cache write must earn back before it beats paying full input price
 *  for the same tokens, at the tier mix actually written. */
function paybackReads(t: TokenTotals): number | null {
  if (t.cacheWrite <= 0) return null;
  const w1h = Math.min(t.cacheWrite1h, t.cacheWrite);
  const mult = ((t.cacheWrite - w1h) * CACHE_WRITE_5M_MULT + w1h * CACHE_WRITE_1H_MULT) / t.cacheWrite;
  return mult / (1 - CACHE_READ_MULT);
}

/**
 * WHOSE tokens are being read — which changes two sentences and nothing else.
 *
 * `corpus` is every conversation on the desktop (the all-sessions screen), and
 * there the mean's caveat can point at the per-session reading as the place to
 * name a monster. On the context sheet that reading IS the screen the reader is
 * on, so the same sentence sends them where they already are, and the advice
 * duplicates the cost panel sitting six lines above it with its own button.
 * The arithmetic, the thresholds and the share sentence are identical — this
 * only decides what the mean's caveat says and whether an advice line is
 * offered at all.
 */
export type CacheScope = "corpus" | "session";

/**
 * The whole reading. Null when nothing went in at all — absent rather than a
 * verdict about zero.
 */
export function cacheReading(t: TokenTotals, scope: CacheScope = "corpus"): CacheReading | null {
  const share = cacheHitPct(t);
  if (share == null) return null;
  const payback = paybackReads(t);
  const reuse = t.cacheWrite > 0 ? t.cacheRead / t.cacheWrite : null;
  const served = t.cacheRead + t.cacheWrite + t.input;
  const perTurnCtx = t.turns > 0 ? served / t.turns : null;
  const posture = perTurnCtx == null
    ? null
    : perTurnCtx >= CTX_PER_TURN_HEAVY ? "heavy" : perTurnCtx >= CTX_PER_TURN_LEAN ? "ordinary" : "lean";

  const thin = reuse != null && payback != null && reuse < payback;
  const cacheNote = thin
    ? `Cache reads are ${Math.round(share)}% of everything sent in, but each token written into the cache was read back only ${reuse!.toFixed(1)}× — under the ${payback!.toFixed(1)}× a write has to earn back before it beats paying full input price. That is sessions ending or being invalidated before their context is re-read, not a context that is too big.`
    : reuse != null
      ? `Cache reads are ${Math.round(share)}% of everything sent in, and each token written into the cache was read back ${reuse >= 10 ? Math.round(reuse) : reuse.toFixed(1)}× — well past the ${payback!.toFixed(1)}× that makes a write worth writing. A high share is the cheap shape of this traffic, not a symptom: a cache read bills at a tenth of the input rate, and the only way to lower the share is to re-send the same context at full price.`
      : `Cache reads are ${Math.round(share)}% of everything sent in. A cache read bills at a tenth of the input rate, so a high share is the cheap shape of the same traffic rather than a symptom.`;

  const mark = `the ~${fmtCount(CTX_PER_TURN_HEAVY)} mark where this desktop's own logs found the spend concentrating (the conversations past 200k were 1.4% of them and 76% of every token)`;
  // A mean is stated as a mean, every time. The distribution it came out of is
  // the most skewed in this repo's measurements, and a reader who takes 190k
  // for "my turns are 190k" has read a ceiling off an average.
  const tail = scope === "session"
    // One conversation's own mean. The corpus wording's escape hatch — go and
    // read the per-session figure — is this screen, so it names what the mean
    // is over instead: a session that spent its first hour small and its last
    // one at 900k averages to something neither half ever carried.
    ? "A mean is not a ceiling: this is every request this conversation logged, the small early ones averaged in with whatever the window grew to. The curve above is where it actually went."
    : "A mean is not a ceiling: the long conversations are averaged in with the short ones, and only the per-session reading on the context screen can name one.";
  const contextNote = perTurnCtx == null
    ? null
    : posture === "heavy"
      ? `The mean turn carried ${fmtCount(perTurnCtx)} of context — past ${mark}. What makes a turn expensive is the size of the window, not the share of it served from cache. ${tail}`
      : posture === "ordinary"
        ? `The mean turn carried ${fmtCount(perTurnCtx)} of context, just under ${mark}. ${tail}`
        // The corpus can say what its norm is; one conversation has no norm to
        // be, so the session wording stops at the comparison it can make.
        : `The mean turn carried ${fmtCount(perTurnCtx)} of context, well under ${mark}${scope === "session" ? "" : " — long sessions are not the norm here"}. ${tail}`;

  // On one session there is already an advice line with a DOOR next to it —
  // the cost panel and its "new session in this repo" button — so a second
  // paragraph saying the same thing without one is noise. The reading keeps
  // its two facts and offers nothing.
  const advice = scope === "session"
    ? null
    : thin
      ? "Worth a look at what ends sessions after a turn or two, or at anything rewriting the start of the prompt between turns."
      : posture === "heavy"
        ? "The lever is the length of a conversation, not the cache: work that does not need what is already in the window is cheaper in a new session. The per-session reading on the context screen names the ones that grew."
        : null;

  return { sharePct: share, reuse, payback, perTurnCtx, posture, cacheNote, contextNote, advice };
}

/**
 * Keep the biggest `n` groups and fold the tail into one "Other".
 *
 * The categorical palette runs out at eight, and a ninth hue is never generated
 * — it is indistinguishable from an existing one under CVD. So the tail folds,
 * and "Other" is NAMED with its count so the chart never quietly drops rows:
 * "Other (12 repos)" is a legend entry, "12 rows missing" is a bug.
 */
export function topGroups(groups: TokenGroup[], n: number, otherLabel = "repos"): TokenGroup[] {
  const sorted = [...groups].sort((a, b) => tokenTotal(b) - tokenTotal(a));
  // Folding a tail of ONE is worse than not folding: it replaces a row that had
  // a name with a row that says "Other (1)", which is strictly less information
  // in the same amount of space.
  if (sorted.length <= n + 1) return sorted;
  const head = sorted.slice(0, n);
  const tail = sorted.slice(n);
  const singular = otherLabel.replace(/s$/, "");
  const other: TokenGroup = {
    key: "__other__",
    label: `Other (${tail.length} ${tail.length === 1 ? singular : otherLabel})`,
    ...zeroTotals(),
    cost: zeroCost(),
  };
  for (const g of tail) { addTotals(other, g); addCost(other.cost, g.cost); }
  return [...head, other];
}

/**
 * A share as a percentage label — `27%`, `<1%`, `>99%`, `0%`.
 *
 * The distinction matters on exactly this data: a model with 21 million tokens
 * against a 13.6-billion total rounds to `0%`, which reads as "did not happen"
 * next to a bar that is visibly there. Something small is not nothing, and the
 * label has to be able to say so.
 *
 * The same rule at the OTHER end, for the same reason: 99.8% rounds to `100%`,
 * which reads as "and nothing else" beside a list that visibly has four more
 * rows in it. Only an exact whole is `100%`.
 */
export function fmtShare(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return "0%";
  const pct = fraction * 100;
  if (pct < 1) return "<1%";
  if (pct < 100 && Math.round(pct) === 100) return ">99%";
  return `${Math.round(pct)}%`;
}

/**
 * The running total, day by day — the "cumulative" the whole screen is for.
 *
 * Over the DAYS PRESENT, not over a filled calendar: a gap in the series is a
 * weekend, and a flat line drawn across it says the same thing at a tenth of
 * the points. The caller draws it as a step/area over real dates, so the gap
 * still reads as elapsed time.
 */
export function cumulative(days: { day: string; total: number }[]): { day: string; total: number; sum: number }[] {
  let sum = 0;
  return days.map((d) => {
    sum += d.total;
    return { ...d, sum };
  });
}

/** `YYYY-MM-DD` → epoch ms at LOCAL midnight. The days were bucketed in the
 *  host's local zone (see `TokenDay`), so they must be read back in one. */
export function dayToMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

/** The day an hour key belongs to. A prefix, never a re-derivation — that is
 *  the whole point of nesting the two keys. */
export function hourDay(hour: string): string {
  return hour.slice(0, 10);
}

/**
 * `13.6B` / `459M` / `29.8M` / `68.8k` / `84`. Big numbers, three significant
 * figures — this is a readout, not a ledger.
 *
 * One decimal below 100 and none above, which is what keeps the HERO figure
 * honest: at 0 decimals a 13.62-billion total renders "14B", and rounding away
 * 380 million tokens in the one number the screen exists to show is not a
 * formatting choice.
 */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  const unit = a >= 1e9 ? ["B", 1e9] as const : a >= 1e6 ? ["M", 1e6] as const : a >= 1e3 ? ["k", 1e3] as const : null;
  if (!unit) return String(Math.round(n));
  const v = n / unit[1];
  return `${v.toFixed(Math.abs(v) < 100 ? 1 : 0).replace(/\.0$/, "")}${unit[0]}`;
}

/** A native amount (a backend's own unit): as stated, at most one decimal — never a "≈",
 *  nothing was converted. The ONE rule behind the ledger beside-row, the session-budget words and
 *  the budget form's preview. */
export function fmtNative(n: number): string {
  if (Number.isInteger(n)) return fmtCount(n);
  const r = Math.round(n * 10) / 10;
  return n > 0 && r === 0 ? "<0.1" : String(r); // a positive amount is never printed as nothing
}

/** The same number in full, grouped — for the one place a reader wants to see
 *  every digit (the hero's own tooltip, the table view). */
export function fmtExact(n: number): string {
  return Math.round(n).toLocaleString();
}
