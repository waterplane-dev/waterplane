/**
 * The per-prompt cost card — ONE component for both views. `CostFold` is the
 * whole thing (a one-line head with the figure, which prompt, a chevron; the
 * card under it when open); `TurnCost` is the card. The reader draws a fold
 * under every turn, the terminal's strip (`TermCostStrip.tsx`) draws the
 * newest turn's in a fixed-height box — the only difference between them, and
 * the "?" says why (`COST_WHERE`).
 */
import { useState, type ReactNode } from "react";
import { Bot, ChevronDown, ChevronRight, ChevronUp, CircleDollarSign, HelpCircle } from "lucide-react";
import {
  COST_WHERE, COST_WHERE_HEAD, DOLLARS_WHY, DOLLARS_WHY_HEAD, fmtTok, fmtUsd, turnCostParts, turnTokensText,
  type TranscriptTurn,
} from "@waterplane/shared";
import { hasFigures, lastTurnChip, lastTurnLabel, lastTurnNote, turnAgents, type LastTurnWhich } from "./lastTurnCost";
import { turnMix, type MixSlots } from "./turnMix";
import { track } from "./usage";

/** A model's colour — `TokenComposition.tsx`'s `MODEL_SLOT` (four validated
 *  hues + the grey tail at `REST_SLOT`), named here rather than imported so the
 *  reader does not pull the charts module. */
const SLOT_VARS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--muted)"];

/** The turn's model split as a ring: one arc per model, in its fixed slot,
 *  a hairline gap between arcs so two adjacent hues never read as one. */
function MixDonut({ parts }: { parts: { id: string; slot: number; share: number }[] }) {
  const r = 12;
  const c = 2 * Math.PI * r;
  const gap = parts.length > 1 ? 1.2 : 0;
  let off = 0;
  return (
    <svg className="tr-mix-donut" viewBox="0 0 32 32" width="32" height="32" aria-hidden>
      <circle cx="16" cy="16" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      {parts.map((m) => {
        const len = m.share * c;
        const seg = (
          <circle key={m.id} cx="16" cy="16" r={r} fill="none" stroke={SLOT_VARS[m.slot]} strokeWidth="6"
            strokeDasharray={`${Math.max(0.6, len - gap)} ${c}`} strokeDashoffset={-off}
            transform="rotate(-90 16 16)" />
        );
        off += len;
        return seg;
      })}
    </svg>
  );
}

/**
 * What this turn cost, the conversation's running total by then, and the
 * context its last request carried — the foot of every turn, so a reader can
 * see which prompt was dear without opening the context sheet. Host
 * `transcript.ts` prices it with `ctxlog.ts`'s accounting; every part is ABSENT
 * rather than zero (a tail-read log has no running total, an unpriced model no
 * figure), and nothing is drawn at all when none of the three was measured.
 *
 * Shared by the reader (under every turn) and the terminal's strip (the
 * newest turn only, `TermCostStrip.tsx`); `trackId` tells their taps apart.
 */
export function TurnCost({ t, slots, agentsSoFar, usdPerWeekPct, weekIncl, onOpen, next, trackId = "action:read.cost", why = false }: { t: TranscriptTurn; slots: MixSlots | null; agentsSoFar: boolean; usdPerWeekPct: number | null; weekIncl: string | null; onOpen?: () => void; next: string | null; trackId?: string; why?: boolean }) {
  const p = turnCostParts({
    costUsd: t.costUsd, cumCostUsd: t.cumCostUsd, ctxTok: t.ctxTok, agents: turnAgents(t), agentsSoFar,
    agentCostUsd: t.agentCostUsd, cumAgentCostUsd: t.cumAgentCostUsd, agentsRunning: t.agentsRunning,
    agentUnpricedTok: t.agentUnpricedTok, usdPerWeekPct, weekIncl,
  });
  const mix = turnMix(t, slots);
  const kinds = t.agentTypes ?? [];
  // The split behind the dollar figure (a total is never printed without it),
  // and on the newest finished turn what the NEXT prompt re-reads.
  const toks = turnTokensText(t.tokens);
  if (!p && !mix && !kinds.length && !toks && !next) return null;
  const main = (
    <>
      {p?.turn && <span className="tr-cost-head">{p.turn}</span>}
      {p && (p.agents || p.total || p.ctx) && (
        <span className="tr-cost-parts">
          {[p.agents, p.total, p.ctx].filter(Boolean).map((x, i) => <span key={i}>{x}</span>)}
        </span>
      )}
      {toks && <span className="tr-cost-toks">{toks}</span>}
      {next && <span className="tr-cost-next">{next}</span>}
      {/* Which models spent it: the donut beside this, shares by money where
          every model has a rate, else by tokens — and the legend SAYS which.
          A colour is the model's everywhere in the app (`modelHue.ts`). */}
      {mix && (
        <span className="tr-mix-legend">
          {mix.parts.map((m) => (
            <span key={m.id}>
              <i style={{ background: SLOT_VARS[m.slot] }} />
              {m.name} {m.costUsd != null && m.costUsd > 0 ? fmtUsd(m.costUsd) : fmtTok(m.tok)}
              {mix.parts.length > 1 && <span className="tr-mix-share"> {Math.round(m.share * 100)}%</span>}
            </span>
          ))}
          {mix.parts.length > 1 && <span className="tr-mix-share">split by {mix.by}</span>}
        </span>
      )}
      {/* The subagents this turn STARTED, by kind — a count off the tool calls
          themselves. What they spent is in the figure above, split out. */}
      {kinds.length > 0 && (
        <span className="tr-cost-agents">
          {kinds.map((k) => (
            <span className="tr-cost-agent" key={k.type}><Bot size={11} /> {k.type}{k.n > 1 ? ` ×${k.n}` : ""}</span>
          ))}
        </span>
      )}
      {p?.note && <span className="tr-cost-note">{p.note}</span>}
    </>
  );
  // With a model split the donut stands where the dollar glyph did and the
  // text runs in one column beside it — a ring instead of a full-width bar row.
  const body = (
    <>
      {mix ? <MixDonut parts={mix.parts} /> : p && <CircleDollarSign size={12} />}
      {mix ? <span className="tr-cost-col">{main}</span> : main}
      {onOpen && <ChevronRight size={12} className="tr-cost-go" />}
    </>
  );
  // A tap opens the whole session's context & cost sheet — the same screen the
  // header's cost chip opens, so the strip is a door to it, not a second copy.
  const card = onOpen
    ? <button type="button" className="tr-cost tr-cost-btn" onClick={() => { track(trackId); onOpen(); }}>{body}</button>
    : <div className="tr-cost">{body}</div>;
  // Why a dollar figure at all, on a flat-fee plan — a "?" in the card's
  // top-right corner, never a row of its own (a full line under every newest
  // turn was too much room for a question asked once). A SIBLING laid over the
  // card, never inside it: the card is a button, and a toggle nested in a
  // button is invalid and steals its tap. Only where a dollar figure is drawn.
  const dollars = !!(p?.turn || p?.total) || mix?.by === "cost";
  return why && dollars ? <WhyCorner>{card}</WhyCorner> : card;
}

/** The card with a "?" laid over its top-right corner; a tap opens the shared
 *  wording (`DOLLARS_WHY`, then `COST_WHERE`) in place under the card — each
 *  heading said in the text, so the answer never depends on the glyph or a
 *  `title`. */
function WhyCorner({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tr-cost-why">
      {children}
      <button type="button" className="tr-cost-q" aria-label={DOLLARS_WHY_HEAD} aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        <HelpCircle size={14} />
      </button>
      {open && <p className="tr-cost-why-text"><b>{DOLLARS_WHY_HEAD}</b> {DOLLARS_WHY}</p>}
      {open && <p className="tr-cost-why-text"><b>{COST_WHERE_HEAD}</b> {COST_WHERE}</p>}
    </div>
  );
}

type CardProps = Omit<Parameters<typeof TurnCost>[0], "t">;

/**
 * A prompt's cost as a FOLD: one line — glyph, `$0.42 · 70k ctx`, which prompt
 * (`lastTurnLabel`), chevron — and the `TurnCost` card under it when open.
 * The same head in both views, so a person learns one control.
 *
 * Open/closed is the CALLER's state (the newest turn's is one stored
 * preference both views share; an older reader turn's is the reader's), and
 * `onChip` replaces the toggle where the card cannot open (the terminal in
 * typing room / full screen) — the tap then goes to the context sheet.
 * `bodyClass` is the one layout difference: the terminal's body is a box of
 * fixed height that scrolls, the reader's grows with the page. `growsUp`
 * turns the chevron for the terminal, whose strip sits on the key row and
 * opens by pushing the grid up.
 *
 * Absent when the turn has no figures and nothing to say about the next
 * prompt — never a fold over an empty card.
 */
export function CostFold({ t, which, open, onToggle, onChip, growsUp = false, className = "", bodyClass = "", ...card }: CardProps & {
  t: TranscriptTurn;
  which: LastTurnWhich;
  open: boolean;
  onToggle: () => void;
  onChip?: () => void;
  growsUp?: boolean;
  className?: string;
  bodyClass?: string;
}) {
  if (!hasFigures(t) && !card.next) return null;
  const chip = lastTurnChip(t);
  const label = lastTurnLabel(t, which);
  const note = lastTurnNote(which);
  return (
    <div className={`cost-fold${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      {/* `preventDefault` on pointerdown: a tap here must not take focus from
          the compose box (on Android a blur re-summons or drops the keyboard,
          and the terminal resizes for it). */}
      <button type="button" className="cost-fold-head" aria-expanded={onChip ? undefined : open}
        aria-label={onChip ? "open the context and cost sheet"
          : `${open ? "collapse" : "expand"} the cost of ${label}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={onChip ?? onToggle}>
        <CircleDollarSign size={13} className="cost-fold-glyph" />
        {/* The figure only while FOLDED: open, the card's first line says the
            same dollars and context in full, and the head saying them too
            was the same number twice, one line apart. */}
        {chip && !(open && !onChip) && <span className="cost-fold-chip">{chip}</span>}
        <span className="cost-fold-label">{label}</span>
        {!onChip && (open !== growsUp
          ? <ChevronUp size={14} className="cost-fold-chev" />
          : <ChevronDown size={14} className="cost-fold-chev" />)}
      </button>
      {open && !onChip && (
        <div className={`cost-fold-body${bodyClass ? ` ${bodyClass}` : ""}`}>
          {note && <div className="cost-fold-note">{note}</div>}
          <TurnCost t={t} {...card} />
        </div>
      )}
    </div>
  );
}

/**
 * "Why dollars on a subscription?" — a FOLD, opened in place, with the shared
 * wording (`DOLLARS_WHY`). Words and a glyph, never a `title` (invisible on a
 * phone). Used under the per-prompt card and on the context & cost sheet.
 */
export function DollarsWhy({ className = "" }: { className?: string }) {
  return (
    <details className={`hint-more dollars-why ${className}`.trim()}>
      <summary><HelpCircle size={12} /> {DOLLARS_WHY_HEAD}</summary>
      <p>{DOLLARS_WHY}</p>
    </details>
  );
}
