/**
 * **The proposals strip** — work a repo's SCRIPT proposed (a cron job, a
 * findings collector), drawn at the top of the launcher, above the lists, in a
 * hue of its own so it cannot be lost among the bell's items.
 *
 * Drawn only while a proposal waits; there is no snooze and no timeout — it
 * goes when each row is fired, scheduled or deleted (shared
 * `isPendingProposal`, the host clears the push by the same edge). A count is
 * a filter: the strip (one repo) or each repo's door (several) opens the
 * backlog on exactly those rows, through `openBacklogCut`, so the filter bar
 * says *n of N* with its clear. The rows keep their own fire / when / remove.
 */
import { Lightbulb } from "lucide-react";
import { chipRows } from "../../kit";
import { proposalCut, proposalsCutLabel, proposalsHeadline, proposersWords } from "../../backlogFilter";
import { track } from "../../usage";
import { useStore } from "../../sdk";
import { backlog } from "./store";
import { openBacklogCut } from "./actions";

export function ProposalsStrip({ repoName }: { repoName: (dir: string) => string }) {
  const { items } = useStore(backlog);
  const cut = proposalCut(items);
  if (cut.total === 0) return null;
  const open = (dir: string, ids: string[]) => {
    track("action:launcher.proposals");
    openBacklogCut(dir, ids, proposalsCutLabel(ids.length, repoName(dir)));
  };
  const head = proposalsHeadline(cut.total);
  if (cut.repos.length === 1) {
    const r = cut.repos[0];
    return (
      // A BUTTON, not a banner: the number is the way to those rows. Raw, as
      // `AttentionChip` is: a full-width strip in its own hue, not a kit key.
      <button className="proposals-strip" data-hint="launcher.proposals" onClick={() => open(r.dir, r.ids)}>
        <Lightbulb size={16} />
        <span className="proposals-head">{head}</span>
        <span className="proposals-sub">from {proposersWords(r.proposers)} in {repoName(r.dir)} — fire, schedule or delete each</span>
      </button>
    );
  }
  const doors = chipRows(cut.repos.map((_, n) => n), (n) => ({ count: cut.repos[n].ids.length }), (n) => repoName(cut.repos[n].dir));
  return (
    <div className="proposals-strip" data-hint="launcher.proposals">
      <Lightbulb size={16} />
      <span className="proposals-head">{head}</span>
      <span className="proposals-sub">fire, schedule or delete each — one repo at a time:</span>
      <span className="proposals-doors">
        {doors.map((d) => {
          const r = cut.repos[d.key];
          return (
            <button key={r.dir} className="proposals-door" title={`from ${proposersWords(r.proposers)}`} onClick={() => open(r.dir, r.ids)}>
              {d.text}
            </button>
          );
        })}
      </span>
    </div>
  );
}
