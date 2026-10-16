/**
 * The spend warning a session wears (`shared/spendwarn.ts`): the person's
 * thresholds (`usePref("spendWarn")`) against this week's dollars-per-point,
 * when there is one. One hook for the header and the launcher row, so a session
 * named on both screens wears the same mark. A readout: it holds nothing.
 */
import { spendWarnOf, type SessionInfo, type SpendWarn } from "@waterplane/shared";
import { usePref } from "../prefs";
import { useWeekUsdPerPct } from "../../features/tokens";

export function useSpendWarn(): (s: SessionInfo | null | undefined) => SpendWarn | null {
  const cfg = usePref("spendWarn");
  const rate = useWeekUsdPerPct();
  return (s) => (s ? spendWarnOf(s.contextSpark?.costUsd, rate, cfg) : null);
}
