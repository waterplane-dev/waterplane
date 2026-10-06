// Cut from sessioncost.ts (move only): break-even and the one reading
// The one door stays `./sessioncost.js`; this slice imports its siblings directly, never the barrel.

import { CACHE_READ_MULT, CACHE_WRITE_1H_MULT } from "../pricing.js";
import { MULT_WARM, MULT_HEAVY, MULT_STEEP, MIN_TURNS, cacheLikelyCold, type SessionCostLevel, type SessionCostInput, type SessionCostReading } from "./costtypes.js";
import { fmtMultiple, fmtTok, usageText } from "./costwords.js";

/**
 * How many more turns of new work before a fresh session would have been
 * cheaper, at the measured cache multipliers.
 *
 * Continuing costs `n · tok · R` — every turn re-reads the whole conversation
 * out of the cache. A fresh session pays `base · W` to write its baseline once
 * and `base · R` for each turn after. Setting the two equal:
 *
 *   n · tok · R  =  base · W + (n - 1) · base · R
 *   n            =  base · (W - R) / (R · (tok - base))
 *
 * The multipliers do not cancel — the write premium is the whole reason a short
 * errand belongs in the session that is already warm. New work only: turns that
 * would have to re-read the same files in the new session are not free there,
 * which is why this is an answer about work that does not depend on what is
 * already in the window.
 *
 * **`W` is the 1-HOUR write tier, because that is the tier the fresh session
 * would actually write its baseline at.** Measured across all 13,397
 * conversation logs on this desktop: 8,160 of 8,160 main-conversation cache
 * writes were 1-hour (2×), across every CLI version from 2.1.220 to 2.1.267,
 * every entry point and every model; the 5-minute tier appears only in the 571
 * subagent logs, which is a harness policy per request kind and not a fact
 * about this machine. This read `CACHE_WRITE_5M_MULT` until that was measured,
 * which understated every break-even by about 65% — the one number in this
 * module that was quietly wrong rather than absent. `writeMult` is overridable
 * for a caller that has measured a different tier for its own session.
 *
 * **`R` is the flat 0.1× read rule, not the model's own.** Fable 5.1 publishes
 * a 0.025× cache read (`pricing.ts`), which would make its break-even four
 * times further away; nothing here knows which model ran, and inventing one
 * would be worse than a stated limit. On this desktop every main conversation
 * ran on a model that takes the flat rule.
 */
export function breakEvenTurns(
  tok: number,
  baseTok: number | null,
  writeMult: number = CACHE_WRITE_1H_MULT,
): number | null {
  if (baseTok == null || baseTok <= 0) return null;
  const gap = tok - baseTok;
  if (gap <= 0) return null;
  const n = (baseTok * (writeMult - CACHE_READ_MULT)) / (CACHE_READ_MULT * gap);
  if (!Number.isFinite(n)) return null;
  // A break-even beyond a couple of dozen turns is not a reminder, it is noise:
  // at that distance the session is barely above its own baseline.
  const rounded = Math.max(1, Math.ceil(n));
  return rounded > 24 ? null : rounded;
}

function levelOf(multiple: number | null, turns: number | null): SessionCostLevel {
  if (multiple == null) return "fresh";
  if (turns != null && turns < MIN_TURNS) return "fresh";
  if (multiple >= MULT_STEEP) return "steep";
  if (multiple >= MULT_HEAVY) return "heavy";
  if (multiple >= MULT_WARM) return "warm";
  return "fresh";
}

/**
 * The whole reading, sentences included.
 *
 * Every screen that mentions this — the launcher row, the session header, the
 * context sheet, the one toast — renders what this returns. None of them writes
 * its own wording, for the reason `clihealth.ts` states about verdicts: one
 * fact worded two ways reads as two facts.
 */
/**
 * The advice that matters when the AGENTS are the bill. Both doors on the cost
 * panel (`/compact`, a fresh session) lower what the parent's next turn costs;
 * neither touches an agent, which re-reads its OWN window on every step. On a
 * fan-out session that is most of the money — measured: 786M of 817M on one
 * session whose panel offered only `/compact` — so the panel says where the
 * lever is. Null below half: then the parent's window is the bigger half and
 * the sentences above it are the right ones.
 */
export function agentAdvice(usageTok: number | null, agentTok: number | null): string | null {
  if (usageTok == null || agentTok == null || usageTok <= 0 || agentTok * 2 <= usageTok) return null;
  return `Most of what this session spent — ${fmtTok(agentTok)} of ${fmtTok(usageTok)} — was its subagents, and compacting or a new session lowers only what the next turn here costs. Each agent re-reads its own growing window on every step, so agents with a narrower task that finish sooner are what brings that down.`;
}

/**
 * A subagent's CURRENT window from which the phone says something while it
 * runs. Measured: one agent ran 819 requests averaging 484k and peaked at 967k
 * of a 1M window — about a quarter of a week's usage in one agent — and nothing
 * said so until it had finished. Half a 1M window is where a run like that is
 * already dear on every step; the ordinary agents on this desktop sit far below.
 */
export const AGENT_LARGE_TOK = 500_000;

/**
 * How recent an agent's last record must be for it to count as RUNNING
 * (`ContextSpark.liveAgentTok`). An agent writes one record per request, and a
 * request on a huge window with a long tool call between can take minutes, so
 * a tight gap would flicker a working agent off and on; ten minutes is longer
 * than any step seen here and short enough that a finished agent stops being
 * called live the same quarter-hour. Asked TWICE on purpose: by the host when
 * it builds the spark, and by the phone against its own clock at render,
 * because the spark is only rebuilt when a log moves — a finished agent's
 * spark would otherwise say "running" for ever.
 */
export const AGENT_LIVE_MS = 10 * 60_000;

/**
 * The one sentence about a large RUNNING subagent, or null.
 *
 * Null below `AGENT_LARGE_TOK`, for an absent reading, and — when `lastAt` is
 * given — once the agent's last record is older than `AGENT_LIVE_MS` by the
 * caller's clock. A readout: it names the lever and refuses nothing.
 */
export function liveAgentText(liveAgentTok: number | null | undefined, lastAt?: number | null, now?: number): string | null {
  if (liveAgentTok == null || !(liveAgentTok >= AGENT_LARGE_TOK)) return null;
  if (lastAt != null && now != null && now - lastAt > AGENT_LIVE_MS) return null;
  return `A subagent is re-reading ${fmtTok(liveAgentTok)} on every step — agents with a narrower task that finish sooner cost less.`;
}

export function sessionCost(input: SessionCostInput): SessionCostReading {
  const { tok, baseTok, turns, spentTok } = input;
  const cacheCold = input.cacheCold ?? null;
  // Normalised, not trusted: an older caller (and every JS one) passes neither
  // field, and `undefined` on the way out would read as "measured nothing" to
  // anything asking `usageTok != null`.
  const usageTok = input.usageTok ?? null;
  const agentTok = input.agentTok ?? null;
  const multiple = baseTok != null && baseTok > 0 && tok > 0 ? tok / baseTok : null;
  const level = levelOf(multiple, turns);
  const breakEven = level === "fresh" ? null : breakEvenTurns(tok, baseTok);

  // The total wins over the carried volume where it exists: it is the same
  // fact with the two things missing from it put back (what the turns wrote,
  // and what the agents spent), so printing both would be one number twice.
  const spentNote = usageTok != null && usageTok > 0
    ? ` ${usageText(usageTok, agentTok)}`
    : spentTok != null && spentTok > 0
      ? ` This conversation has carried ${fmtTok(spentTok)} tokens in total.`
      : "";

  // ── What a COLD cache changes ─────────────────────────────────────────
  //
  // Not the multiple: `tok / baseTok` is the ratio of what the two sessions
  // carry, and a cold resume re-writes both of them at the same tier, so it
  // cancels. What it changes is the price of the FIRST turn — those tokens are
  // written at 1.25-2× input instead of read at 0.1× — and that is the one
  // sentence in this module that becomes false when it happens: "a quick
  // question is still cheaper here" is advice that was true of a warm window
  // and is wrong by an order of magnitude on a window nobody has touched for
  // hours. So the correction goes exactly there.
  //
  // No dollar figure and no minutes. A figure needs the model and a rate this
  // function has never been given, and the share of a cold resume still served
  // from cache varies from 3% to 30% (the tools-and-system preamble stays warm
  // from sibling sessions in the same repo, measured at 5-23k), so any amount
  // printed here would be a plausible wrong number rather than an absent one.
  const coldNote = cacheCold
    ? ` Nothing has run here for hours: the cached prefix has very likely expired, so the next turn re-WRITES these ${fmtTok(tok)} rather than re-reading them, which is the expensive direction by an order of magnitude.`
    : "";
  // The clause a cold window makes false, and its replacement.
  const quick = cacheCold
    ? " Even a quick question pays that re-write first, so there is no cheap turn left here."
    : " A quick question is still cheaper here.";

  if (level === "fresh") {
    const note = baseTok == null
      ? `Each turn re-reads ${fmtTok(tok)} of context. How that compares with a fresh session here is not known — this conversation's log is longer than the host reads in one go, so there is no first reading to measure against.`
      : `Each turn re-reads ${fmtTok(tok)} of context — about what a fresh session in this repo costs.${spentNote}`;
    // A cold window is only worth a sentence where re-writing it is worth
    // money. At `fresh` WITH a baseline this session carries about what a new
    // one would, so the re-write is the price of starting anywhere and saying
    // so would be noise on every idle session on the list. The no-baseline
    // branch is the opposite case — the log is truncated, which only happens
    // to the longest conversations — so it keeps the warning.
    const coldOnly = baseTok == null ? coldNote : "";
    return {
      level, tok, baseTok, multiple, breakEven, spentTok, usageTok, agentTok, turns,
      chip: null,
      note: note + coldOnly,
      advice: joinAdvice(coldOnly ? "New work belongs in a fresh session; this window has to be paid for again before it can answer anything." : null, agentAdvice(usageTok, agentTok)),
    };
  }

  const mult = fmtMultiple(multiple!);
  const note = `Each turn re-reads ${fmtTok(tok)} of context — ${mult} what a fresh session in this repo costs (${fmtTok(baseTok!)}).${spentNote}${coldNote}`;

  const advice = breakEven != null
    ? `More than ${breakEven} ${breakEven === 1 ? "turn" : "turns"} of work that does not need what is already in this window would be cheaper in a new session.${quick}`
    : level === "steep"
      ? `New work that does not need what is already in this window would be markedly cheaper in a new session.${quick}`
      : cacheCold
        ? `New work that does not need what is already in this window would be cheaper in a new session.${quick}`
        : null;

  return { level, tok, baseTok, multiple, breakEven, spentTok, usageTok, agentTok, turns, chip: mult, note, advice: joinAdvice(advice, agentAdvice(usageTok, agentTok)) };
}

function joinAdvice(a: string | null, b: string | null): string | null {
  return a && b ? `${a} ${b}` : a ?? b;
}

/**
 * The two ways out of an expensive window, worded once.
 *
 * ── Why this is a sentence and not a button label ──────────────────────────
 *
 * `advice` above argues that new work would be cheaper somewhere else, and the
 * context sheet puts two doors under it: `/compact`, which keeps this
 * conversation and re-reads a summary of it, and a fresh session, which keeps
 * nothing. Those are not the same offer, and an argument that names one door
 * while the other is drawn beside it teaches a reader that the buttons and the
 * prose are about different things.
 *
 * ── Why the caller decides `canCompact` ────────────────────────────────────
 *
 * `/compact` is Claude's vocabulary. A backend whose descriptor says
 * `slash: "none"` reads it as English and is asked, in prose, to compact
 * itself — the bug `headerCmds.ts` exists for. The capability is the caller's
 * fact, not this module's, so the clause is simply ABSENT where the door is:
 * null, never a sentence promising a control that is not on the screen.
 */
export function costDoorsText(canCompact: boolean): string | null {
  if (!canCompact) return null;
  return "Compacting is the other door: it keeps this conversation and re-reads a summary of it instead of all of it, so work that still needs what is here stays here. A new session keeps nothing.";
}

/**
 * The three cost fields, derived from a full readings series.
 *
 * The ONE derivation, used by the host filling a `ContextSpark` and by the
 * context sheet reading the whole document — two places that hold the same
 * series at different resolutions and would otherwise each decide for
 * themselves what a baseline is. They already disagree once by construction
 * (the spark's `pts` is downsampled), which is precisely why the answer is
 * computed here from the raw readings and carried, never re-derived downstream.
 *
 * `truncated` withholds the baseline rather than quoting the oldest reading
 * that survived the cap: that reading is not a fresh session, it is the middle
 * of a long one, and using it would make the longest conversations — the only
 * ones that truncate — look the cheapest.
 */
export function seriesCostFields(samples: { tok: number }[], truncated: boolean, turns: number | null): {
  baseTok?: number;
  turns?: number;
  spentTok: number;
} {
  return {
    baseTok: truncated ? undefined : samples[0]?.tok,
    // NOT `samples.length`. A reading is one REQUEST — a turn that ran thirteen
    // tools wrote fourteen of them — so counting the series was counting the
    // CLI's round trips and calling them turns: a four-turn conversation read
    // as twenty-four. It is counted off the user records instead (host
    // `ctxlog.ts`, one rule with the reader's own `promptOf`), and is absent
    // when nothing counted it rather than falling back to a number that means
    // something else.
    ...(turns == null ? null : { turns }),
    spentTok: samples.reduce((n, p) => n + p.tok, 0),
  };
}

/**
 * The reading for a whole series document — the context sheet's own panel.
 *
 * `used` is what the HOST measured (the doc's `usageTok`/`agentTok`): the
 * output side and the subagent logs are not in `samples` and cannot be derived
 * from them, so they are carried or they are absent.
 */
export function sessionCostOfSeries(
  samples: { tok: number }[],
  truncated: boolean,
  turns: number | null,
  used?: { usageTok?: number; agentTok?: number } | null,
  live?: CacheAge | null,
): SessionCostReading | null {
  if (!samples.length) return null;
  const tok = samples[samples.length - 1].tok;
  if (!(tok > 0)) return null;
  const f = seriesCostFields(samples, truncated, turns);
  return sessionCost({
    tok,
    baseTok: f.baseTok ?? null,
    turns: f.turns ?? null,
    spentTok: f.spentTok,
    usageTok: used?.usageTok ?? null,
    agentTok: used?.agentTok ?? null,
    cacheCold: coldFrom(live),
  });
}

/**
 * What a caller knows about how long this conversation has been quiet.
 *
 * `lastTurnAt` is the CLI's own record of its newest turn (`SessionInfo`
 * already carries it — nothing new is put on the wire for this), `now` is the
 * clock of whatever is about to draw the sentence, and `turnActive` suppresses
 * the whole question while a turn is running.
 */
export interface CacheAge {
  lastTurnAt?: number | null;
  turnActive?: boolean | null;
  now: number;
}

export function coldFrom(live?: CacheAge | null): boolean | null {
  return live ? cacheLikelyCold(live.lastTurnAt, live.now, live.turnActive) : null;
}
