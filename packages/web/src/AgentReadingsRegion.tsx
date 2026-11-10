/**
 * Region 5 of the repo-readings sheet, **Agent readings**: what only this
 * desktop's claude conversation logs can say about a repo, one ISO week at a
 * time (host `agentreadings.ts`, `GET /api/repos/:id/agentreadings`).
 *
 * Readings, not the health score and not a checklist: no stripe, no status
 * colour, counted in nothing, and nothing here refuses or applies anything.
 * Each reading carries a `?` whose words are the HOST's rule (`doc.rules`), so
 * the explanation can never drift from the classification that produced the
 * number. A total never stands without its split: the rework share names all
 * three classes and draws the token kinds under it; exploration cost draws the
 * median session's own kinds. An absent reading prints the host's sentence.
 *
 * The week row is a body-changing choice (`.ts-filter`, labelled chips, above
 * what it changes); one chip for EVERY week the host answers, so a dash in the
 * table always has a chip whose sentence says why; the chips carry dates, never
 * counts. The weeks table is the same figures as text, every week at once.
 */
import { useEffect, useState } from "react";
import { isAgentAbsent, tokenTotal, type AgentReadingAbsent, type AgentReadingsResponse, type RepoTarget } from "@waterplane/shared";
import { api } from "./api";
import { useRemoteResource } from "./useRemoteResource";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { FilterChip } from "./kit/FilterChip";
import { KindBar } from "./kit/chart/TokenComposition";
import { RefreshKey } from "./RepoHealthCards";
import {
  AGENT_REGION_WORDS, TABLE_NOTE, compactBeside, compactLine, escapedLines, exploreBeside, exploreLine, reworkBeside,
  reworkLine, reworkWhole, weekCells, weekChip, weekHeading,
} from "./agentReadingsWords";

function Absent({ r }: { r: AgentReadingAbsent }) {
  return <div className="rh-cap ctx-note">{r.absent}</div>;
}

function Reading({ title, rule, children }: { title: string; rule: string; children: React.ReactNode }) {
  return (
    <div className="rh-card">
      <div className="section-head">
        <span className="rh-chart-label">{title}</span>
        <Explain of={title}>{rule}</Explain>
      </div>
      <div className="rh-gutter">{children}</div>
    </div>
  );
}

export function AgentReadingsRegion({ repo }: { repo: RepoTarget | null }) {
  const repoId = repo?.id ?? "";
  const res = useRemoteResource<AgentReadingsResponse>(`agentreadings:${repoId}`, () => api.agentReadings(repoId), { enabled: !!repoId });
  const doc = res.data?.ok ? res.data : null;
  const refused = res.data && !res.data.ok ? res.data : null;
  const weeks = doc?.weeks ?? [];
  const [pick, setPick] = useState<string | null>(null);
  // A new repo (or a new answer that no longer holds the picked week) lands on the newest week.
  useEffect(() => { setPick(null); }, [repoId]);
  const week = weeks.find((w) => w.week === pick) ?? weeks[weeks.length - 1] ?? null;
  const newest = weeks[weeks.length - 1]?.week;

  return (
    <div className="rh-region">
      <div className="ts-filter" role="group" aria-label="agent readings">
        <span className="ctx-stackpick-lab">agents</span>
        <Explain of="what agent readings are">{AGENT_REGION_WORDS}</Explain>
        <RefreshKey busy={res.inflight} label={res.inflight ? "reading…" : "read again"} onClick={() => res.reload({ quiet: true })} />
      </div>
      <Empty res={res} empty={!doc} thing="this repo's agent readings" noun="reading">
        {refused ? <>{refused.error}</> : null}
      </Empty>
      {doc && week ? (<>
        <div className="ts-filter" role="group" aria-label="week">
          <span className="ctx-stackpick-lab">week of</span>
          {weeks.map((w) => (
            <FilterChip key={w.week} on={w.week === week.week} clears={false} onClick={() => setPick(w.week)}>
              {weekChip(w.week)}
            </FilterChip>
          ))}
        </div>
        <div className="rh-cap rh-gutter">{weekHeading(week.week, week.week === newest)}</div>

        <Reading title="Exploration cost" rule={doc.rules.explore}>
          {isAgentAbsent(week.explore) ? <Absent r={week.explore} /> : (<>
            <div>{exploreLine(week.explore)}</div>
            <KindBar bag={week.explore.split} whole={tokenTotal(week.explore.split)} />
            <div className="rh-cap">{exploreBeside(week.explore)}</div>
          </>)}
        </Reading>

        <Reading title="Rework spend" rule={doc.rules.rework}>
          {isAgentAbsent(week.rework) ? <Absent r={week.rework} /> : (<>
            <div>{reworkLine(week.rework)}</div>
            <KindBar bag={reworkWhole(week.rework)} whole={week.rework.totalTok} />
            <div className="rh-cap">{reworkBeside(week.rework)}</div>
          </>)}
        </Reading>

        <Reading title="Compactions per committed session" rule={doc.rules.compact}>
          {isAgentAbsent(week.compact) ? <Absent r={week.compact} /> : (<>
            <div>{compactLine(week.compact)}</div>
            <div className="rh-cap">{compactBeside(week.compact)}</div>
          </>)}
        </Reading>

        <Reading title="Escaped defects" rule={doc.rules.escaped}>
          {(() => { const e = escapedLines(week.escaped); return (<><div>{e.crash}</div><div>{e.bugs}</div></>); })()}
        </Reading>

        <div className="rh-card">
          <div className="section-head"><span className="rh-chart-label">every week, as numbers</span></div>
          <div className="rh-table-wrap rh-fade">
            <table className="rh-table">
              <thead>
                <tr>
                  <th scope="col">week of</th>
                  <th scope="col" className="num">explore</th>
                  <th scope="col" className="num">rework</th>
                  <th scope="col" className="num">compact</th>
                  <th scope="col" className="num">crash</th>
                  <th scope="col" className="num">bugs</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => {
                  const c = weekCells(w);
                  return (
                    <tr key={w.week}>
                      <th scope="row">{w.week}</th>
                      <td className="num">{c.explore}</td>
                      <td className="num">{c.rework}</td>
                      <td className="num">{c.compact}</td>
                      <td className="num">{c.crash}</td>
                      <td className="num">{c.bugs}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="rh-cap rh-gutter">{TABLE_NOTE}</div>
        </div>
      </>) : null}
    </div>
  );
}
