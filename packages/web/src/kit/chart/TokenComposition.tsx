/**
 * What a pile of tokens was MADE OF — the one strip, everywhere a total is
 * printed.
 *
 * ── Why this is a module and not a component in one sheet ───────────────────
 *
 * `shared/tokens.ts` opens with the measurement this whole idea rests on: over
 * this desktop's 9,444 logs, 96% of every token was a cache read. A bare
 * "16M spent" is therefore the most misleading number the app can print, and
 * the rule the all-sessions screen has always followed is that the total never
 * appears without its split. The per-session context sheet printed exactly
 * that bare number for months, because the strip that would have fixed it
 * lived inside `TokenStatsSheet.tsx` as a private function — twice, once for
 * each ledger.
 *
 * So the strip, the palette and the cache verdict live here, and the three
 * screens that show a token total are three call sites of one rendering. The
 * point is not the saved lines: it is that a reader who learns to read the
 * band on one screen has learnt to read it on the others, and that a kind
 * cannot pick up a different hue on the way between them.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It decides no numbers. The bag it paints, what "the whole" is, and how a
 * value is formatted all come from the caller, because the two ledgers count
 * differently (`TokenStatsSheet`'s header: they never meet in one reducer) and
 * one of them has no prices at all. This file owns the colours, the order and
 * the words for a kind — nothing else.
 */
import type { ReactNode } from "react";
import {
  TOKEN_KINDS, cacheReading, fmtCount, fmtExact,
  type CacheScope, type TokenTotals,
} from "@waterplane/shared";
import { compose } from "./statsPlot";

/**
 * The categorical palette, validated as a SET against the surface a chart sits
 * on — and validated once per theme, which is why these are custom properties
 * and not the four hex literals they used to be. `styles.css` holds both sets
 * and `theme.test.mjs` re-measures them: all four ≥3:1 against the surface,
 * worst all-pairs CIEDE2000 ≥15 to normal vision and ≥5 under simulated
 * protan/deutan/tritan. Slot order is the CVD-safety mechanism, not decoration
 * — never generate a fifth.
 */
export const SLOT = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

/** A MODEL's colour, by `modelHue.ts`'s fixed family slot: the four hues above,
 *  plus one grey at `REST_SLOT` for everything no family owns. The grey is not
 *  a fifth hue — it is the fold, and it reads as "the rest" in either theme. */
export const MODEL_SLOT = [...SLOT, "var(--muted)",
  // Older versions of a family (`modelHue.ts`'s `TINT_STEP`): the family's own
  // hue mixed toward the surface, so a second opus is still read as opus and
  // the warm-is-dear order holds. Lightness, not a new hue — no fifth colour.
  ...[65, 40].flatMap((pct) => [
    ...SLOT.map((c) => `color-mix(in srgb, ${c} ${pct}%, var(--panel))`), "var(--muted)",
  ])];

/** One series → the same blue the context graph uses. Two chart families in one
 *  app wearing two different "this is the data" colours is one too many. */
export const SERIES = SLOT[0];

/**
 * The four kinds as one 100%-wide bar, with the exact values beside it.
 *
 * `bag` is keyed by the kind ids and nothing else is assumed about it: the
 * token view passes counts, the money view passes costs under the same keys,
 * and the two produce completely different pictures of the same traffic (96/3
 * by tokens is 55/38 by money) — which is the point of being able to pass
 * either.
 *
 * `whole` is the denominator for the percentages, and it is the caller's
 * because it is not always the sum of the bag: opencode's ledger has a fifth
 * kind the four-slot palette has no hue for, and the shares have to be against
 * everything counted rather than against everything painted.
 */
export function KindBar({ bag, whole, fmt = fmtCount, exact = fmtExact, children }: {
  /**
   * The values to paint, keyed by kind id. A `TokenTotals` because that is
   * what `compose` measures its segment widths against — the money view
   * therefore passes its costs under the same keys with the two non-kind
   * fields zeroed, which is correct: `cacheWrite1h` is a SUBSET of
   * `cacheWrite` and counting it would double-count most of the writes.
   */
  bag: TokenTotals;
  whole: number;
  /** How a value is written in the legend. Defaults to a token count. */
  fmt?: (n: number) => string;
  /** The tooltip's full-precision form. */
  exact?: (n: number) => string;
  /** Extra legend entries — a kind this palette has no colour for. Rendered
   *  after the four, deliberately with no swatch of their own. */
  children?: ReactNode;
}) {
  const segs = compose(bag, TOKEN_KINDS.map((k) => ({ id: k.id, slot: k.slot, name: k.name })));
  return (
    <div className="ts-comp">
      <div className="ts-bar" role="img" aria-label="what the tokens were">
        {segs.map((s) => (
          <span key={s.kind} className="ts-seg" title={`${s.kind}: ${exact(s.value)} (${s.pct < 0.1 ? "<0.1" : s.pct.toFixed(1)}%)`}
            style={{ left: `${s.x}%`, width: `${s.w}%`, background: SLOT[s.slot] }} />
        ))}
      </div>
      {/* At four series the palette's own ladder makes direct labels mandatory
          — yellow and orange are on screen together — so every kind carries its
          number here rather than only in a tooltip. */}
      <div className="ts-legend">
        {TOKEN_KINDS.map((k) => {
          const v = bag[k.id];
          const pct = whole > 0 ? (v / whole) * 100 : 0;
          return (
            <span key={k.id} className="ts-leg" title={`${k.name} — ${k.what}`}>
              <i style={{ background: SLOT[k.slot] }} />
              <b>{k.name}</b> {fmt(v)}
              <em>{pct < 0.1 ? "<0.1%" : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}</em>
            </span>
          );
        })}
        {children}
      </div>
    </div>
  );
}

/**
 * Whether that share is a GOOD share — the question the strip above provokes
 * and cannot answer.
 *
 * "96% cache reads" reads as either *the cache is carrying everything* or *the
 * same bloated conversation is being re-read for ever*, and nothing on either
 * screen used to say which. `cacheReading` (shared, so the phone and anything
 * else that asks get one wording) separates them: the SHARE is not the signal —
 * a cache read bills at a tenth of the input rate, so a high share is the cheap
 * shape of the same traffic and the only way to lower it is to re-send that
 * context at full price. The two ratios underneath it are: reads per written
 * token against what a write has to earn back, and the context an average turn
 * carried against the ~200k where this desktop's own logs found the spend
 * concentrating.
 *
 * `scope` changes two sentences and no arithmetic — see `CacheScope`. On one
 * session the mean's caveat cannot point at "the per-session reading" (that is
 * the screen it is on) and the advice would duplicate the cost panel above it,
 * which has an actual button.
 *
 * Sentences and never a gate, and absent rather than wrong: no turns counted ⇒
 * no per-turn line, nothing sent in at all ⇒ no block.
 */
export function CacheVerdict({ totals, scope = "corpus" }: { totals: TokenTotals; scope?: CacheScope }) {
  const r = cacheReading(totals, scope);
  if (!r) return null;
  return (
    <div className="empty ts-caveat">
      {r.cacheNote}
      {r.contextNote ? <> {r.contextNote}</> : null}
      {r.advice ? <> {r.advice}</> : null}
    </div>
  );
}
