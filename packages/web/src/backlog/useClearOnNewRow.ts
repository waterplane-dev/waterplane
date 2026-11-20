/**
 * A new row must be seen (decision 5): when this repo gains an item while a cut or the search would
 * hide it, the cut goes and the sheet says so ("Filter cleared to show your new item."). Its own
 * file because the sheet's cut is never local state (`tools/backlogpins.test.mjs`); only this line is.
 */
import { useEffect, useRef, useState } from "react";
import { NO_BACKLOG_FILTER, hasBacklogFilter, type BacklogFilter } from "../backlogFilter.ts";
import { showNewRow } from "../kit/chips.ts";
import type { BacklogProps } from "./backlogTypes";

export function useClearOnNewRow(p: BacklogProps, repoDir: string, text: string, filter: BacklogFilter) {
  const [clearedLine, setClearedLine] = useState<string | null>(null);
  const seen = useRef<{ dir: string; n: number } | null>(null);
  const here = p.items.filter((it) => !it.archived && it.repoDir === repoDir).length;
  const hiding = hasBacklogFilter(filter) || text.trim() !== "";
  useEffect(() => {
    const prev = seen.current;
    seen.current = { dir: repoDir, n: here };
    if (!prev || prev.dir !== repoDir) { setClearedLine(null); return; }
    if (here <= prev.n) return;
    const r = hiding ? showNewRow<string>("cut", "item") : { line: null };
    if (r.line) {
      p.setCut((c) => ({ ...c, text: "", idsLabel: undefined, filter: NO_BACKLOG_FILTER }));
      setClearedLine(r.line);
    } else setClearedLine(null);
  }, [here, repoDir]); // eslint-disable-line react-hooks/exhaustive-deps
  return { clearedLine, dismissClearedLine: () => setClearedLine(null) };
}
