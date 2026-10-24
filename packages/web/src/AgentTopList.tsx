/**
 * The most expensive subagents of one conversation, as a compact table under
 * the swim lanes, and the one control for the line that calls an agent large.
 *
 * Pure paint over `agentTop` (`contextPlot/cplotAgents.ts` decides the rows):
 * a figure nobody measured is an EMPTY cell, never 0 and never a dash that
 * claims a value. Cost is roughly requests x window, which is why turns sit
 * beside the peak window. A tap on a row picks that agent, exactly as a tap on
 * its bar does (ringed in the chart, read in the line under it).
 */
import { fmtUsd, type AgentRun } from "@waterplane/shared";
import { fmtTokens } from "./kit/chart/chartFmt";
import { agentTop } from "./contextPlot/cplotAgentTop";
import { Hint } from "./kit/Hint";
import { Button } from "./kit/Button";

const TOP_N = 5;

export function AgentTopList({ agents, models, picked, onPick }: {
  agents: AgentRun[];
  models: string[] | undefined;
  picked: AgentRun | null;
  onPick: (a: AgentRun) => void;
}) {
  const rows = agentTop(agents, models, TOP_N);
  if (!rows.length) return null;
  return (
    <div className="agent-top">
      <div className="ctx-summary">
        {agents.length > rows.length
          ? `${rows.length} dearest of ${agents.length} agents`
          : `${rows.length} agent${rows.length > 1 ? "s" : ""}, dearest first`}
      </div>
      <table className="agent-top-t">
        <thead>
          <tr><th scope="col">agent</th><th scope="col">requests</th><th scope="col">peak window</th><th scope="col">tokens</th><th scope="col">cost</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.run === picked || r.id === picked?.id ? "on" : undefined}
              tabIndex={0} onClick={() => onPick(r.run)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(r.run); } }}>
              <th scope="row">
                {r.type}
                <small>{[r.model, r.running ? "running" : null].filter(Boolean).join(" · ")}</small>
              </th>
              <td>{r.turns != null ? r.turns : ""}</td>
              <td>{r.peakTok != null ? fmtTokens(r.peakTok) : ""}</td>
              <td>{fmtTokens(r.tok)}</td>
              <td>{r.costUsd != null ? fmtUsd(r.costUsd) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Hint>Tap a row to ring that agent in the chart above. Cost is roughly requests times window; an empty cell was not measured.</Hint>
    </div>
  );
}

/** The chips offered for the large-agent line, in tokens. */
export const AGENT_WARN_CHOICES = [200_000, 300_000, 400_000, 500_000] as const;

/**
 * "warn when an agent passes" - labelled chips, the current one lit. A value
 * synced from elsewhere that is none of the four is SAID rather than hidden.
 * It warns (chip, toast, push) and never stops an agent.
 */
export function AgentWarnLine({ value, onChange }: { value: number; onChange: (tok: number) => void }) {
  const custom = !AGENT_WARN_CHOICES.some((t) => t === value);
  return (
    <div className="agent-warn">
      <div className="ts-filter agent-warn-row" role="group" aria-label="warn when an agent passes">
        <span className="ctx-stackpick-lab">warn when an agent passes</span>
        {AGENT_WARN_CHOICES.map((t) => (
          <Button className={t === value ? "active" : undefined} key={t} aria-pressed={t === value} onClick={() => onChange(t)}>
            {fmtTokens(t)}
          </Button>
        ))}
      </div>
      <div className="ctx-cost-note">
        {custom ? `Set to ${fmtTokens(value)} elsewhere. ` : ""}
        It warns you - a chip on the session, a toast and a push - and never stops an agent. Syncs to the desktop, which sends the push.
      </div>
    </div>
  );
}
