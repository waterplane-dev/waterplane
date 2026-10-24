/**
 * Pull, push or sync every repo at once — the git view's three buttons, over
 * the whole list. A row opens that repo's git view; the run itself lives in
 * `actions.ts` and outlives the sheet.
 */
import { ArrowDownToLine, ArrowDownUp, ArrowUpFromLine, Loader, Square } from "lucide-react";
import { core, useStore } from "../../sdk";
import { Button, Hint, Row, RowSub, RowTitle, Sheet, useNow } from "../../kit";
import { gitSyncText } from "../../gitCounts";
import { leftOutWords, planWords, syncable, targets, type RowState } from "./logic";
import { startRun, stopRun } from "./actions";
import { run } from "./store";

const ICON = 16;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function stateWords(st: RowState, now: number): string {
  switch (st.s) {
    case "waiting": return "waiting";
    case "pulling": return "pulling…";
    case "pushing": return `pushing… ${clock(now - st.startedAt)} — pre-push checks first`;
    default: return st.text;
  }
}

export function RepoSyncSheet() {
  const c = core();
  const { visibleRepos } = c.world;
  const cur = useStore(run);
  const now = useNow(1000);
  const repos = visibleRepos.filter(syncable);
  const pushN = targets(repos, "push").length;
  const close = () => c.nav.close("reposync");
  const go = (verb: "pull" | "push" | "sync") => { void startRun(verb, visibleRepos); };
  return (
    <Sheet title="Sync repos" icon={<ArrowDownUp size={ICON} />} onClose={close}>
      <div className="sheet-scroll">
        <Hint>{planWords(repos.length, pushN)}</Hint>
        {leftOutWords(visibleRepos.length - repos.length) && <Hint>{leftOutWords(visibleRepos.length - repos.length)}</Hint>}
        {repos.length > 0 && (
          <div className="sheet-actions">
            {cur.active ? (
              <Button onClick={stopRun} title="let what is running finish, drop what is still waiting">
                <Square size={14} /> Stop
              </Button>
            ) : (
              <>
                <Button onClick={() => go("pull")}><ArrowDownToLine size={14} /> Pull all</Button>
                {/* The count is exactly the rows marked ↑ below — the push touches those and no others. */}
                {pushN > 0 && <Button onClick={() => go("push")}><ArrowUpFromLine size={14} /> Push {pushN}</Button>}
                <Button onClick={() => go("sync")} title="pull each, then push whatever is still ahead"><ArrowDownUp size={14} /> Sync all</Button>
              </>
            )}
          </div>
        )}
        {repos.map((r) => {
          const st = cur.rows[r.id];
          const counts = gitSyncText(r);
          const spin = st && (st.s === "pulling" || st.s === "pushing");
          return (
            <Row as="button" key={r.id} kind="grow" onClick={() => c.nav.openGit(r.id)} title="open this repo's git view">
              <RowTitle>
                {spin && <Loader size={12} className="spin" />} {r.repoName}{r.isPrimary ? "" : ` · ${r.branch}`}
                {counts && <span className="git-ab"> {counts}</span>}
              </RowTitle>
              {st && <RowSub className={st.s === "failed" ? "warn" : ""}>{stateWords(st, now)}</RowSub>}
            </Row>
          );
        })}
      </div>
    </Sheet>
  );
}
