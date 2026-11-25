/**
 * The launcher's first-run card (`firstRunCard` decides): on a host that has never opened a
 * session, the ways in (`firstRunWays`): build your first app, the repos already listed below it (a
 * line with their count, `existingReposLine`) or, with none, a new project, a clone, another code
 * folder; try the demo. While a
 * job runs or waits on the person, the same place shows where it is and opens its checklist.
 */
import { CircleDot, FolderOpen, GitBranch, Loader, OctagonAlert, PlayCircle, Plus, Rocket, X } from "lucide-react";
import { useCore } from "../../sdk";
import { dismissFirstRun, openOnboard } from "./actions";
import { useFirstRunDismissed, useOnboardJob } from "./store";
import { existingReposLine, firstRunCard, firstRunWays } from "./logic";
import { Button } from "../../kit";

/** Which card the launcher shows now: the one place that decides, so a line under it can stand down. */
export function useFirstRunWhich(demo: boolean) {
  const c = useCore();
  const job = useOnboardJob();
  const dismissed = useFirstRunDismissed();
  return {
    job,
    which: firstRunCard({
      online: c.conn.status === "open",
      sessions: c.world.sessions.length, recent: c.world.recent.length, closed: c.world.closed.length,
      job, dismissed, demo,
    }),
  };
}

export function FirstRunCard({ repos, demo, onDemo }: { repos: number; demo: boolean; onDemo(): void }) {
  const c = useCore();
  const { job, which } = useFirstRunWhich(demo);
  if (which === "none") return null;
  const reposLine = existingReposLine(repos);
  const ways = firstRunWays(repos);
  if (which === "job" && job) {
    const stopped = job.state === "stopped";
    return (
      <div className="onb-card" data-card="job">
        <button className="onb-card-head onb-card-job" onClick={openOnboard}>
          {stopped ? <OctagonAlert size={18} /> : <Loader size={18} className="spin" />}
          <span>{stopped ? `${job.name} is waiting for you` : `Making ${job.name}`}</span>
        </button>
        <div className="onb-card-body">{job.summary}</div>
      </div>
    );
  }
  return (
    <div className="onb-card" data-card="first-run">
      <div className="onb-card-head"><CircleDot size={18} /> <span>Start here</span>
        <button className="onb-card-x" aria-label="not now" title="not now — hide this until the app reloads" onClick={dismissFirstRun}><X size={16} /></button>
      </div>
      <div className="onb-card-body">
        This desktop has not run a session from the phone yet. Pick one way in.
        {reposLine && <> {reposLine}</>}
      </div>
      <div className="onb-card-acts">
        {ways.includes("build") && <button className="send onb-build" onClick={openOnboard}><Rocket size={16} /> Build your first app</button>}
        {ways.includes("project") && (
          <div className="onb-card-pair">
            <Button onClick={() => c.nav.openNew("repo")}><Plus size={16} /> New project</Button>
            <Button onClick={() => c.nav.openNew("clone")}><GitBranch size={16} /> Clone a repo</Button>
          </div>
        )}
        {ways.includes("folder") && (
          <Button onClick={() => c.nav.open("codefolder")}><FolderOpen size={16} /> Choose another folder</Button>
        )}
        <Button onClick={() => { c.say.track("action:onboard.demo"); onDemo(); }}>
          <PlayCircle size={16} /> Try the demo
        </Button>
      </div>
    </div>
  );
}
