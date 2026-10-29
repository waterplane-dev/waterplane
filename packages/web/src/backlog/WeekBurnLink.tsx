/**
 * The repo bar's second line: the week-end burn from this repo's backlog. A
 * REGION like `RepoBar.tsx` — no hooks, only the model.
 */
import { Flame } from "lucide-react";
import { isWeekBurnOrigin, weekBurnRowsLabel } from "@waterplane/shared";
import { track } from "../usage";
import type { BacklogModel } from "./backlogTypes";
import { Button } from "../kit/Button";
import { Hint } from "../kit/Hint";

/**
 * The week-end burn, from this repo's backlog: the burn's own sentence about the
 * repo when it has one, the door to the burn sheet, and — when the burn wrote
 * rows here — their count, which opens exactly those rows.
 */
export function WeekBurnLink({ m, repoDir }: { m: BacklogModel; repoDir: string }) {
  const { p } = m;
  const ids = p.items.filter((it) => it.repoDir === repoDir && isWeekBurnOrigin(it.origin)).map((it) => it.id);
  const text = p.nav.weekBurnText?.(repoDir) ?? null;
  return (
    <div className="form bl-repobar">
      {text && <Hint as="span"><Flame size={13} style={{ verticalAlign: "-2px" }} /> {text}</Hint>}
      {ids.length > 0 && p.nav.onOpenCut && (
        <Button onClick={() => { track("action:backlog.weekburnrows"); p.nav.onOpenCut!(repoDir, ids, weekBurnRowsLabel(ids.length)); }}>
          {weekBurnRowsLabel(ids.length)}
        </Button>
      )}
      <Button onClick={() => { track("action:backlog.weekburn"); p.nav.onOpenWeekBurn!(); }}>
        {!text && <Flame size={14} />} week-end burn…
      </Button>
    </div>
  );
}
