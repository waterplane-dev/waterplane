/**
 * A new schedule must be seen (decision 5), the Scheduled tab's half of `backlog/useClearOnNewRow.ts`:
 * when the list gains a rule while a cut or the search would hide it, both go and the sheet says so
 * ("Filter cleared to show your new schedule."). `external` is the same sentence from a path that ran
 * while the sheet was not mounted (the receipt's Open, `features/schedule/actions.ts`
 * `showNewSchedule`), which clears the search too.
 */
import { useEffect, useRef, useState } from "react";
import { showNewRow } from "./kit/chips";

/** The sentence, from the one place that words it (`kit/chips.ts` `showNewRow`). */
export const SCHEDULE_CLEARED_LINE = showNewRow<string>("cut", "schedule").line as string;

export function useClearOnNewSchedule(
  total: number,
  hiding: boolean,
  clear: () => void,
  external: string | null = null,
  dismissExternal?: () => void,
) {
  const [own, setOwn] = useState<string | null>(null);
  const seen = useRef<number | null>(null);
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    const prev = seen.current;
    seen.current = total;
    // From an empty list nothing was hidden: that is the first read landing, not a new rule under a cut.
    if (!prev || total <= prev) return;
    const r = hiding ? showNewRow<string>("cut", "schedule") : { line: null };
    if (r.line) { clearRef.current(); setOwn(r.line); } else setOwn(null);
  }, [total]); // eslint-disable-line react-hooks/exhaustive-deps
  // The tap that opened the sheet cleared its cut before it mounted: the search text, which only the
  // sheet holds, goes with it.
  useEffect(() => { if (external) clearRef.current(); }, [external]);
  return { line: own ?? external, dismiss: () => { setOwn(null); dismissExternal?.(); } };
}
