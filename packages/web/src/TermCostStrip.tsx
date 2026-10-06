/**
 * The last prompt's cost card, under the TERMINAL — the reader's per-turn
 * `CostFold` (head + card, `TurnCostCard.tsx`) for the newest turn with
 * figures, so the question "what did that prompt just cost" has an answer
 * without switching views. Only the data and the fixed height are this file's.
 *
 * Three rules from `Terminal.tsx` shape it, because this sits in the flex
 * column above the key row and every pixel it takes is a pixel off the PTY:
 *
 *  - **A resize repaints the whole screen.** So the strip has exactly TWO
 *    heights, both fixed in CSS: the one-line chip and the expanded card in a
 *    box of its own height that scrolls. A new turn changes the words, never
 *    the height. Only the person's tap moves between them, and that resizes
 *    once.
 *  - **It does not come and go per turn.** It is drawn from the newest turn
 *    WITH figures, which once found stays found for the session; it is absent
 *    only while no turn has any (a new session, a backend that records none).
 *  - **No second read path.** The figures come from the same IndexedDB copy the
 *    reader seeds from, refreshed by the same `prefetchTranscript` the term
 *    feed already runs on attach and turn end — forced here only on the
 *    turn-end nonce, never per PTY byte, and joined to an in-flight read
 *    rather than doubled.
 *
 * It says WHICH prompt in words (`lastTurnLabel`): the last one, the running
 * one so far, or the previous one while a new one runs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { nextTurnText, type SessionCostReading, type TranscriptTurn } from "@waterplane/shared";
import { agentsSoFarAt, lastCostTurn, lastTurnWhich } from "./lastTurnCost";
import { getTranscriptAt, prefetchTranscript } from "./offlineCache";
import { LS, lsBool, lsSetBool } from "./storage";
import { CostFold } from "./TurnCostCard";
import { mixSlots } from "./turnMix";
import { track } from "./usage";

interface Props {
  sessionId: string;
  /** The term feed's turn-end nonce (`transcriptNonce`): a bump re-reads. */
  refreshKey: number;
  /** A turn is in flight (the reader's `busy`, same derivation). */
  busy: boolean;
  turnStartedAt?: number;
  /** What the next prompt re-reads — drawn only under a FINISHED last turn. */
  nextTurn?: SessionCostReading | null;
  usdPerWeekPct: number | null;
  weekIncl: string | null;
  /** The context & cost sheet — the same door the reader's card opens. */
  onOpenCost?: () => void;
  /** Typing room / full screen: the chrome is hidden to give rows to the
   *  output, so the card stays a chip whatever was stored. That change rides
   *  on a resize already happening (the keyboard, the header going). */
  chipOnly?: boolean;
}

/** The newest cached turns for a session, re-read after each turn end. */
function useCachedTurns(sessionId: string, refreshKey: number): TranscriptTurn[] | null {
  const [turns, setTurns] = useState<TranscriptTurn[] | null>(null);
  const heldAt = useRef<number | null>(null);
  useEffect(() => {
    let live = true;
    const readCache = async () => {
      const hit = await getTranscriptAt(sessionId).catch(() => null);
      // Only a MOVED document re-renders: a 204 leaves the same copy behind.
      if (!live || !hit || hit.value.updatedAt === heldAt.current) return;
      heldAt.current = hit.value.updatedAt;
      setTurns(hit.value.turns);
    };
    // Cache first (milliseconds, and all there is offline), then a read of the
    // log that writes the cache, then the cache again.
    void readCache()
      .then(() => prefetchTranscript(sessionId, true))
      .catch(() => undefined)
      .then(readCache);
    return () => { live = false; };
  }, [sessionId, refreshKey]);
  return turns;
}

export function TermCostStrip({ sessionId, refreshKey, busy, turnStartedAt, nextTurn, usdPerWeekPct, weekIncl, onOpenCost, chipOnly }: Props) {
  const turns = useCachedTurns(sessionId, refreshKey);
  const [stored, setStored] = useState(() => lsBool(LS.termCostOpen));
  const slots = useMemo(() => mixSlots(turns ?? []), [turns]);
  const t = useMemo(() => lastCostTurn(turns ?? []), [turns]);
  if (!turns || !t) return null;
  const which = lastTurnWhich(t, busy, turnStartedAt);
  const toggle = () => {
    const next = !stored;
    track(next ? "action:term.cost.open" : "action:term.cost.close");
    lsSetBool(LS.termCostOpen, next);
    setStored(next);
  };
  return (
    <CostFold className="tcs" bodyClass="tcs-body" growsUp t={t} which={which}
      open={stored && !chipOnly} onToggle={toggle}
      onChip={chipOnly && onOpenCost ? () => { track("action:term.cost"); onOpenCost(); } : undefined}
      slots={slots} agentsSoFar={agentsSoFarAt(turns, t.id)}
      usdPerWeekPct={usdPerWeekPct} weekIncl={weekIncl} onOpen={onOpenCost} trackId="action:term.cost"
      next={which === "last" && t.id === turns[turns.length - 1]?.id ? nextTurnText(nextTurn) : null} why />
  );
}
