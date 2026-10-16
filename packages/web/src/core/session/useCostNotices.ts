/**
 * The session-cost toasts, lifted out of `App.tsx` as ONE hook App calls once:
 * the cost level stepping up, and a running subagent re-reading a huge window.
 *
 * Both decisions are pure and node-tested in `costNotice.ts`; what lives here
 * is the effect around them, because `active` is a fresh object every frame
 * and no JSX effect can be pinned by a test. Only for the session on screen:
 * a notice about a conversation you are not in is one you cannot act on.
 * Nothing here disables, intercepts or refuses anything.
 */
import { useEffect, useRef } from "react";
import { liveAgentText, sessionCostOf, type SessionInfo } from "@waterplane/shared";
import { shouldNotice, shouldNoticeAgent, shouldNoticeSpend } from "../../costNotice";
import { useSpendWarn } from "../sessions/spendWarn";
import { showToast } from "../../toast";
import { LS, lsJson, lsSetJson } from "../../storage";
import { budgetToast, shouldNoticeBudget } from "../../features/sessionBudget";

export function useCostNotices(active: SessionInfo | null | undefined): void {
  /** Which sessions have already been told what they cost — see the effect. */
  const costNoticedRef = useRef<Record<string, string> | null>(null);

  /**
   * Say once, out loud, what a turn in the session you are watching costs.
   *
   * The chip is on the row and in the header, and a chip is something you look
   * at when you already suspect something. The measurement that prompted all of
   * this says the opposite is what happens: the expensive sessions are the ones
   * nobody was suspicious of, because they got expensive one ordinary turn at a
   * time. So the step up is announced — and only the step UP, once per level.
   *
   * Everything about this is deliberately weak. It is a toast, so it retires on
   * its own clock; it says what is true and what would be cheaper and never
   * "stop"; it fires only for the session on screen, because a notice about a
   * conversation you are not in is a notice you cannot act on; and it is
   * recorded per session and level, so a long afternoon in one session produces
   * at most three of them in total, not one per turn.
   */
  useEffect(() => {
    if (!active || !active.running) return;
    const r = sessionCostOf(active.contextSpark, { lastTurnAt: active.lastTurnAt, turnActive: active.turnActive, now: Date.now() });
    if (!r || r.level === "fresh") return;
    // `active` is a fresh object on every frame the session list moves, so this
    // effect runs constantly while an expensive session is on screen. The
    // record is therefore held in a ref and read from storage ONCE — parsing a
    // localStorage document per frame to decide not to toast is the readout
    // costing more than the thing it reports on.
    const seen = costNoticedRef.current ??= lsJson<Record<string, string>>(LS.costNoticed, {});
    // The decision itself (once per level step up, never downward, bounded)
    // is pure and lives in `costNotice.ts`, where it can be pinned by a test
    // no JSX effect can host.
    const { notice, next } = shouldNotice(active.id, r.level, seen);
    if (!notice) return;
    costNoticedRef.current = next;
    lsSetJson(LS.costNoticed, next);
    showToast(r.advice ? `${r.note} ${r.advice}` : r.note);
  }, [active]);

  /** Which running subagents have already been announced — see the effect. */
  const agentNoticedRef = useRef<Record<string, string> | null>(null);
  /**
   * Say once when a subagent under the session on screen is re-reading a huge
   * window. One agent ran 819 requests at 484k average and nothing said so
   * until it had finished. Once per session per crossing (`shouldNoticeAgent`:
   * dropping back under re-arms it), only for the session on screen, a toast
   * that retires on its own clock. It stops nothing.
   */
  useEffect(() => {
    if (!active) return;
    const sp = active.contextSpark;
    const text = active.running ? liveAgentText(sp?.liveAgentTok, sp?.liveAgentAt, Date.now()) : null;
    const seen = agentNoticedRef.current ??= lsJson<Record<string, string>>(LS.agentNoticed, {});
    const { notice, next } = shouldNoticeAgent(active.id, text ? (sp?.liveAgentId ?? "agent") : null, seen);
    if (next !== seen) { agentNoticedRef.current = next; lsSetJson(LS.agentNoticed, next); }
    if (notice && text) showToast(text);
  }, [active]);

  /** Which sessions have already been told they passed a spend mark. */
  const spendNoticedRef = useRef<Record<string, string> | null>(null);
  const spendWarnOf = useSpendWarn();
  const spendWarn = spendWarnOf(active);
  /**
   * Say once when the session on screen passes the person's orange or red
   * spend mark (Settings › Sessions). The triangle on the Σ figure is the
   * standing readout; this is the moment it appears, worded, with where the
   * marks are set. Once per level step up, only for the session on screen. It
   * stops nothing.
   */
  useEffect(() => {
    if (!active || !spendWarn) return;
    const seen = spendNoticedRef.current ??= lsJson<Record<string, string>>(LS.spendNoticed, {});
    const { notice, next } = shouldNoticeSpend(active.id, spendWarn.level, seen);
    if (!notice) return;
    spendNoticedRef.current = next;
    lsSetJson(LS.spendNoticed, next);
    showToast(`${spendWarn.text} Marks are set in Settings › Sessions › spend marks. Nothing was stopped.`);
  }, [active, spendWarn]);

  /** Which sessions have already been told they are over their own budget. In
   *  memory on purpose: it is a CROSSING, and a reload that finds a session still
   *  over is worth saying once more, which no stored list would allow. */
  const budgetNoticedRef = useRef<ReadonlySet<string>>(new Set());
  /**
   * Say once when the session on screen crosses its OWN budget. The host
   * notifies too, but a phone that is open on the session wants the sentence
   * where it is looking, and the chip alone is something you look at when you
   * already suspect. Once per crossing (`shouldNoticeBudget`: leaving over
   * re-arms), only for the session on screen. The toast refuses nothing; the
   * hold is the queue's (`budgetHeldLanes`) and it says so itself.
   */
  useEffect(() => {
    if (!active) return;
    const b = active.budget;
    const { notice, next } = shouldNoticeBudget(active.id, b?.verdict.state === "over", budgetNoticedRef.current);
    budgetNoticedRef.current = next;
    if (notice && b) showToast(budgetToast(active.title, b));
  }, [active]);
}
