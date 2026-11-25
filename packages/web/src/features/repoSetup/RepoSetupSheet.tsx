/**
 * `set up <repo>`: the rows, the ticks and Go. Rows, default ticks and the plan are `shared/reposetup.ts`
 * (one cut for the rows drawn, the button's count and what runs); this draws them.
 *
 * Two reads, each with its own failure: the opt-ins and the setup checklist (the basics row).
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleAlert, Clock, SquareCheckBig, Loader, RefreshCw, Search, Wrench } from "lucide-react";
import { SETUP_BASICS, optInActiveWords, optInDef, repoShown, setupRows } from "@waterplane/shared";
import type { ComplianceReport, OptInReport, RepoTarget, SetupRow } from "@waterplane/shared";
import { api } from "../../api";
import { OptInDoor, untokened, useAskedDownloadRule } from "../../optInActs";
import { optInSentWords } from "../../optInSeed";
import { useSlowJob } from "../../slowJobs";
import { useRemoteResource } from "../../useRemoteResource";
import { Sheet } from "../../Sheet";
import { Empty } from "../../Empty";
import { CantInline } from "../../Unavailable";
import { Button, Hint, useOfflineGate } from "../../kit";
import { useCore, useQueueEntries, useStore } from "../../sdk";
import {
  IN_QUEUE_WORDS, activeHead, flatRows, footerView, outcomeWords, pageRows, paidWords, planNow, queuedOptIns, sentLine, shownOutcomes, standing, tickable,
  tickedKeys, NO_RUN, type Outcome,
} from "./logic";
import { closeRepoSetup, go, retry, seedLook, setTick, skipRepoSetup, takePicks } from "./actions";
import { openOn, runs } from "./store";

const ICON = 16;
/** A just-created repo is listed within a scan or two; after this the page says what to do instead. */
const LIST_TRIES = 8;
const LIST_EVERY_MS = 2000;

/** Keyed by the path: another repo opened over this one is another page. */
export function RepoSetupSheet() {
  const at = useStore(openOn);
  return at ? <For key={at} at={at} /> : null;
}

function For({ at }: { at: string }) {
  const core = useCore();
  const repo = core.world.repos.find((r) => r.worktreePath === at) ?? null;
  return repo ? <Page repo={repo} /> : <NotListedYet at={at} />;
}

function NotListedYet({ at }: { at: string }) {
  const core = useCore();
  const [tries, setTries] = useState(0);
  const refresh = core.world.refreshRepos;
  useEffect(() => {
    if (tries >= LIST_TRIES) return;
    refresh();
    const t = window.setTimeout(() => setTries((n) => n + 1), LIST_EVERY_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refresh` is this render's; the clock is the trigger
  }, [tries]);
  const name = at.split("/").filter(Boolean).pop() ?? at;
  const given = tries >= LIST_TRIES;
  return (
    <Sheet title={`set up ${name}`} icon={<SquareCheckBig size={ICON} />} onClose={closeRepoSetup}
      footer={<>
        {given && <Button onClick={() => setTries(0)}><RefreshCw size={14} /> look again</Button>}
        <Button onClick={closeRepoSetup}>done</Button>
      </>}>
      <div className="empty empty-msg">
        {given
          ? <>The desktop does not list {name} yet. Look again, or close this and open the repo's ⋯ menu › set up this repo once it is in the list.</>
          : <>Reading {name}…</>}
      </div>
    </Sheet>
  );
}

function Page({ repo }: { repo: RepoTarget }) {
  const core = useCore();
  const at = repo.worktreePath;
  const offers = useRemoteResource<OptInReport>(`optins:${repo.id}`, () => api.optIns(repo.id).then(untokened));
  const checks = useSlowJob<ComplianceReport>("setup.check", repo.id, { auto: true, verb: "read the setup checklist" });
  const run = useStore(runs).get(at) ?? NO_RUN;
  const queue = useQueueEntries();
  const gate = useOfflineGate();
  const [openActive, setOpenActive] = useState(false);

  const live = useMemo(() => setupRows({ rows: offers.data?.rows ?? [], picks: offers.data?.picks }, checks.data?.checks ?? []),
    [offers.data, checks.data]);
  const page = pageRows(live, run);
  const rows = flatRows(page.groups);
  const queued = queuedOptIns(queue, at);
  const ticks = tickedKeys(rows, run, queued);
  const plan = planNow(rows, run, queued);
  const foot = footerView(plan, { busy: run.busy, outcomes: shownOutcomes(rows, run.outcomes) }, {
    auto: core.world.backlogAuto,
    tickableN: rows.filter((r) => tickable(r, run.outcomes, queued)).length,
    unread: !offers.data && !checks.data,
  });

  useAskedDownloadRule(at, rows.some((r) => r.action?.kind === "download"));
  // What Go did shows on the rows at once; the report catches up behind it.
  const reload = offers.reload;
  useEffect(() => { if (!run.busy && run.kept.length) reload({ quiet: true }); }, [run.busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = rows.filter((r) => r.pick);
  const askable = rows.filter((r) => r.key !== SETUP_BASICS && r.kind !== "door").map((r) => ({ id: r.key }));

  const footer = (
    <>
      <div className="rs-foot" role="status">{run.busy && <Loader size={14} className="spin" />} {foot.line}{gate.note}</div>
      {foot.leave === "skip"
        ? <Button onClick={() => skipRepoSetup(repoShown(repo))}>skip</Button>
        : <Button onClick={closeRepoSetup}>done</Button>}
      {foot.go && <button className="send" onClick={gate.guard("set this up", () => go(repo, page.groups, plan))}>{foot.go}</button>}
    </>
  );

  return (
    <Sheet title={`set up ${repoShown(repo)}`} icon={<SquareCheckBig size={ICON} />} onClose={closeRepoSetup} className="repo-setup" footer={footer}
      actions={<Button onClick={() => { offers.reload({ quiet: true }); checks.start(); }} title="read this repo again" aria-label="re-check this repo">
        <RefreshCw size={14} className={offers.inflight || checks.inflight ? "spin" : undefined} />
      </Button>}>
      <div className="sheet-scroll">
        <div className="section-head">
          <span className="section section-hint">Tick what you want. Ticked in advance is free.</span>
        </div>
        <Empty res={offers} empty={!offers.data} thing="what this repo can turn on" noun="list">The desktop listed nothing to turn on.</Empty>
        {!checks.data && <Empty res={checks} thing="the setup checklist">The basics are not listed.</Empty>}

        {askable.length > 0 && (
          <div className="rs-look">
            <Button onClick={() => seedLook(repo, askable)} title="Opens the Send sheet on words that only read this repo and suggest; sets nothing up. Costs an agent session.">
              <Search size={14} /> let an agent look first… · costs a session
            </Button>
            {picked.length > 0 && <Button onClick={() => takePicks(at, picked)}><Check size={14} /> use these suggestions</Button>}
          </div>
        )}

        {page.active.length > 0 && (<>
          <button className="section optin-fold" onClick={() => setOpenActive((o) => !o)} aria-expanded={openActive}>
            {openActive ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {activeHead(page.active.length)}
          </button>
          {openActive && (
            <ul className="check-list">
              {page.active.map((r) => (
                <li key={r.id} className="rs-on">{optInDef(r.id)!.title}<span className="check-kind"> · {optInActiveWords(r)}</span></li>
              ))}
            </ul>
          )}
        </>)}

        {run.said.length > 0 && <Hint>The desktop said: {run.said.join(" · ")}</Hint>}

        {page.groups.map((g) => (
          <section key={g.group}>
            <div className="section">{g.title}</div>
            <ul className="check-list">
              {g.rows.map((r) => (
                <RowItem key={r.key} row={r} repo={repo} on={ticks.has(r.key)} outcome={standing(r, run.outcomes)}
                  inQueue={queued.has(r.key)}
                  onRetry={run.busy ? null : gate.guard("try it again", () => retry(repo, page.groups, r))} />
              ))}
            </ul>
          </section>
        ))}
        {offers.data && checks.data && rows.length === 0 && (
          <div className="empty empty-msg">Nothing left to set up here: everything that fits this repo is on or answered.</div>
        )}
      </div>
    </Sheet>
  );
}

/** What only a tap shows: pitch and cost, and the probe's detail where it adds to them. */
function saysMore(row: SetupRow): boolean {
  return !!row.detail && (row.key === SETUP_BASICS || !!row.unknown || (!!row.started && !row.sent));
}

function RowItem({ row, repo, on, outcome, inQueue, onRetry }: {
  row: SetupRow; repo: RepoTarget; on: boolean; outcome: Outcome | null; inQueue: boolean; onRetry: (() => void) | null;
}) {
  const core = useCore();
  const [open, setOpen] = useState(false);
  // A row that landed needs no more selling.
  const landed = outcome?.s === "done";
  const door = row.kind === "door";
  const ticked = !door && !outcome && !inQueue;
  const Chev = open ? ChevronDown : ChevronRight;
  // The tick and the text are two targets: the text opens the row's pitch and cost, never touches the tick.
  // A row with an outcome says it right under its title instead of its pitch (and has no pitch to open).
  const text = outcome ? (
    <span className="rs-words">
      <span className="rs-title">{row.title}</span>
      <span className={`rs-outcome${outcome.s === "failed" ? " rs-failed" : ""}`}>
        <span>{outcomeWords(outcome)}</span>
        {outcome.s === "failed" && outcome.retry && onRetry && <Button onClick={onRetry}><RefreshCw size={14} /> try again</Button>}
      </span>
    </span>
  ) : (
    <button type="button" className="rs-text" aria-expanded={open} aria-label={`${row.title}: ${open ? "hide" : "show"} details`}
      onClick={() => setOpen((o) => !o)}>
      <span className="rs-words">
        <span className="rs-title">{row.title}</span>
        <span className="rs-short">
          {row.kind === "paid" && <span className="rs-paid">{paidWords(row.action)} · </span>}{row.short}
        </span>
      </span>
      <Chev size={16} className="rs-chev" aria-hidden />
    </button>
  );
  return (
    <li className={`rs-row${outcome ? " rs-marked" : ""}${door ? " rs-door" : ""}`}>
      <div className="rs-line">
        {ticked
          ? <label className="rs-box" aria-label={`set up ${row.title}`}>
            <input type="checkbox" checked={on} onChange={(e) => setTick(repo.worktreePath, row.key, e.target.checked)} />
          </label>
          : (outcome || !door) && <span className="rs-box">{outcome && <OutcomeMark o={outcome} />}</span>}
        {text}
        {door && row.action && !outcome && (
          <div className="rs-door-act">
            {row.action.kind === "open" || row.action.kind === "download"
              ? <OptInDoor action={row.action} label={row.verb ?? "open"} repo={repo} onSeries={() => core.nav.openRepoHealth(repo)} />
              // A fix that asks first asks on the Opt-ins card, where its confirm lives (no checklist row carries it).
              : row.action.kind === "fix"
                ? <Button onClick={() => core.nav.openSetup(repo.id, { region: "optins" })}><Wrench size={14} /> {row.verb}</Button>
                : <CantInline>This app version cannot open it.</CantInline>}
          </div>
        )}
      </div>
      {open && !outcome && (
        <div className="rs-more">
          <span className="rs-pitch">{row.pitch}</span>
          <span className="rs-cost">{row.cost}</span>
          {saysMore(row) && <span className="rs-detail">{row.detail}</span>}
        </div>
      )}
      {row.sent && !outcome && <span className="rs-detail rs-under">{door ? optInSentWords(row.sent) : sentLine(row.sent)}</span>}
      {row.pick && !landed && <span className="rs-pick rs-under">suggested {row.pick.want ? "on" : "off"}: {row.pick.why}</span>}
      {!outcome && inQueue && <div className="rs-outcome rs-under"><span>{IN_QUEUE_WORDS}</span></div>}
    </li>
  );
}

function OutcomeMark({ o }: { o: Outcome }) {
  switch (o.s) {
    case "done": return <Check className="rs-mark rs-ok" size={20} aria-label="done" />;
    case "failed": return <CircleAlert className="rs-mark rs-bad" size={20} aria-label="did not work" />;
    case "running": return <Loader className="rs-mark spin" size={20} aria-label="working" />;
    default: return <Clock className="rs-mark" size={20} aria-label="waiting" />;
  }
}
