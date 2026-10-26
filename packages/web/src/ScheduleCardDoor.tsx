import { Hammer, ListTodo, Terminal } from "lucide-react";
import type { Intent, ScheduleAction } from "@waterplane/shared";
import { track } from "./usage";
import { ago } from "./format";
import { scheduleItemsLabel } from "./backlogFilter";
import { lastRunWord } from "./buildSchedule";

/**
 * **Where a schedule card's work goes, in one slot with four shapes.**
 * In order of how much each knows:
 *
 *  - the SESSION its last run was actually typed into, when one is still
 *    open — the most specific answer there is;
 *  - a BUILD rule's last RUN (`lastResult.childId` is the run's id): opens the
 *    repo's Build sheet with that run unfolded, its output and artifacts;
 *  - else the ITEM a backlog rule wrote, as a filter: "1 item" opens exactly
 *    that row in its repo's backlog, never the repo's fifty-two;
 *  - else the repo's BACKLOG, still the true answer to "where does this land"
 *    for a backlog rule that has not fired yet.
 *
 * A fan-out has neither a single session nor a single backlog (that is the
 * fan-out view's job), and a build rule whose run left the list has nothing
 * to open — both get nothing, never a door to a guess.
 */
export function ScheduleCardDoor({ act, child, childSession, typed, repoName, onOpenSession, onOpenBacklog, onOpenBuildRun }: {
  act: ScheduleAction;
  child?: Intent;
  childSession: string | null;
  typed: string | null;
  repoName: (dir: string) => string;
  onOpenSession?: (sessionId: string) => void;
  onOpenBacklog?: (repoDir: string, ids?: string[], label?: string) => void;
  onOpenBuildRun?: (repoDir: string, runId: string) => void;
}) {
  if (childSession && onOpenSession) {
    return (
      <button className="link-btn" data-hint="schedule.session"
        title="Open the session this item ran in"
        onClick={() => { track("action:schedule.session"); onOpenSession(childSession); }}>
        <Terminal size={13} /> session
      </button>
    );
  }
  if (act.kind === "build") {
    if (!child || !onOpenBuildRun) return null;
    const word = lastRunWord(child);
    const when = child.settledAt ?? child.startedAt;
    return (
      <button className="link-btn" data-hint="schedule.buildrun"
        title={`Open the run this rule last started, in ${repoName(act.repoDir)}'s builds`}
        onClick={() => { track("action:schedule.buildrun"); onOpenBuildRun(act.repoDir, child.id); }}>
        <Hammer size={13} /> last run · {word}{when && word !== "running" && word !== "waiting" ? ` ${ago(when)}` : ""}
      </button>
    );
  }
  if (act.kind !== "backlog" || !onOpenBacklog) return null;
  return child ? (
    <button className="link-btn" data-hint="schedule.backlogitems"
      title={`Show the item this rule wrote, in ${repoName(act.repoDir)}'s backlog`}
      onClick={() => {
        track("action:schedule.backlog");
        onOpenBacklog(act.repoDir, [child.id], scheduleItemsLabel(typed || act.text.slice(0, 40)));
      }}>
      <ListTodo size={13} /> backlog · 1 item
    </button>
  ) : (
    <button className="link-btn" data-hint="schedule.backlogitems"
      title={`Show ${repoName(act.repoDir)}'s backlog — this is the list each run of this rule writes into`}
      onClick={() => { track("action:schedule.backlog"); onOpenBacklog(act.repoDir); }}>
      <ListTodo size={13} /> backlog
    </button>
  );
}
