import { forwardRef } from "react";
import { Bot, ChevronRight } from "lucide-react";
import { agentCountText, agentLevel, agentSeries, orderAgentRows, useAgents } from "./agentCount";
import { usePref } from "./core/prefs";
import { SysGraph } from "./SysGraph";
import { roomyCeiling } from "./graphGeom";
import { dur } from "./format";

/**
 * *This desktop*'s agents section (`agentCount.ts`): the parallel-agent count
 * over time against the person's two marks, and the sessions it is made of —
 * busiest first, each row a door into that session. The strip's number is a
 * count, and a count is a filter: these rows are exactly what it added up.
 */
export const AgentsSection = forwardRef<HTMLElement, { onOpenSession?: (id: string) => void }>(
  function AgentsSection({ onOpenSession }, ref) {
    const count = useAgents((s) => s.count);
    const samples = useAgents((s) => s.samples);
    const all = useAgents((s) => s.rows);
    const cfg = usePref("agentWarn");
    const rows = orderAgentRows(all);
    const total = agentSeries(samples);
    const subs = agentSeries(samples, (s) => s.subagents);
    const marks = [cfg.warn, cfg.alarm].filter((m) => m > 0);
    // The marks are on the axis whenever they are near the data, so a line
    // under them reads as under them — never fitted so tight a 3 looks like 30.
    const peak = total.reduce<number>((m, v) => (v != null && v > m ? v : m), 0);
    const hi = roomyCeiling([...total, ...marks.filter((m) => m <= peak * 2 + 5)], 10, 5);
    const span = samples.length > 1 ? { from: samples[0].at, to: samples[samples.length - 1].at } : {};
    const level = count ? agentLevel(count.total, cfg) : "ok";
    return (
      <section className="set-group" ref={ref}>
        <h3 className="set-title">Agents running at once</h3>
        {count ? (
          <span className={`lrt-verdict lrt-agents-verdict lrt-agents-${level}`}>
            {agentCountText(count)}
            {level === "alarm" ? ` — more than your limit of ${cfg.alarm}.` : level === "warn" ? ` — more than your warning of ${cfg.warn}.` : "."}
          </span>
        ) : (
          <span className="set-note">No session list from the desktop yet.</span>
        )}
        {total.length > 1 ? (
          <>
            <SysGraph lines={[
              { key: "agents", label: "all agents", tone: "app", series: total },
              { key: "subagents", label: "of them subagents", tone: "wired", series: subs },
            ]} lo={0} hi={hi} fmt={(v) => String(Math.round(v))} {...span} />
            <span className="set-note">
              One reading every 10 seconds and one on every change, while this app is open — kept in memory
              only, so a reload starts it again. A break is a stretch this phone was not watching, never bridged.
              {marks.length > 0 && <> Your marks: amber above {cfg.warn || "—"}, red above {cfg.alarm || "—"} (Settings → Appearance).</>}
            </span>
          </>
        ) : (
          <span className="set-note">The graph starts with the next reading — every 10 seconds while this app is open.</span>
        )}
        {rows.length > 0 && (
          <div className="lrt-rows">
            {rows.map((r) => (
              <button key={r.id} className="lrt-row lrt-agent-row" onClick={() => onOpenSession?.(r.id)}
                title={`open ${r.label}`}>
                <span className="lrt-name"><Bot size={12} aria-hidden="true" /> {r.label}</span>
                <span className="lrt-size">
                  {r.agents.length > 0 ? `${r.agents.length} subagent${r.agents.length === 1 ? "" : "s"}` : ""}
                  {r.agents.length > 0 && r.working ? " + " : ""}
                  {r.working ? "its own turn" : ""}
                </span>
                <ChevronRight size={14} aria-hidden="true" className="lrt-agent-go" />
                <span className="lrt-vram">{r.repo}</span>
                {r.agents.map((a, i) => (
                  <span className="lrt-vram" key={i}>
                    · {a.what}{a.model ? ` (${a.model})` : ""} — running {dur(a.startedAt)}
                  </span>
                ))}
              </button>
            ))}
          </div>
        )}
      </section>
    );
  },
);
