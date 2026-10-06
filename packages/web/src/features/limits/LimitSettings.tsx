/**
 * The Sessions group's limit rows: auto-continue after a usage limit (this
 * feature's switch) and the usage BUDGET beside it — the other half of the same
 * question: that one recovers AFTER the wall, the budget stops short of it.
 *
 * The budget is the host's (`budget.state`, held by the core because the queue
 * flusher reads it synchronously); these rows only read it and send
 * `budget.set`. A slider drag is a LOCAL draft until the host echoes the saved
 * value — it used to be written into App's copy of the host's state, which is
 * the one place a phone-side guess could be read back as the host's answer.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Gauge, Hourglass } from "lucide-react";
import { budgetReasonText, type UsageBudget } from "@waterplane/shared";
import { useCore } from "../../sdk";
import { SetSlider, SetSwitch, SetWarn } from "../../SettingsKit";
import { hhmm } from "../../format";
import { track } from "../../usage";
import { setGlobalAuto } from "./actions";
import { useLimitAuto } from "./store";

export function LimitSettings() {
  const c = useCore();
  const limitAuto = useLimitAuto();
  const held = c.world.budget;
  // What the slider shows while a drag is in flight; dropped the moment the
  // host says what it saved.
  const [draft, setDraft] = useState<UsageBudget | null>(null);
  useEffect(() => { setDraft(null); }, [held]);
  const budget = held && draft ? { ...held, budget: draft } : held;
  const save = (b: UsageBudget) => c.conn.liveSend({ t: "budget.set", budget: b }, "usage budget saved");

  return (
    <>
      <SetSwitch
        id="limit-auto" label="auto-continue after a usage limit" icon={Hourglass}
        on={limitAuto}
        onChange={() => setGlobalAuto(!limitAuto)}
        note="When a session hits a Claude usage limit, send “continue” once the limit resets."
        more={<p>At the banner's reset time where there is one, else retrying periodically. Override per session via the hourglass chip in the session toolbar; session rows show the state, and a blocked session shows when it will resume.</p>}
      />

      {/* The other half of the row above: that one recovers AFTER the
          wall, this one stops short of it. */}
      <SetSwitch
        id="budget" label="usage budget" icon={Gauge}
        on={!!budget?.budget.enabled}
        onChange={() => {
          if (!budget) return;
          track("action:budget.toggle");
          c.conn.liveSend({ t: "budget.set", budget: { ...budget.budget, enabled: !budget.budget.enabled } }, `usage budget ${budget.budget.enabled ? "off" : "on"}`);
        }}
        note="Pause queued sends and automatic backlog starts once the 5-hour window is this far used."
        more={<p>It starts again by itself when the window resets — nothing is lost, the queue just waits. An explicit <strong>send now</strong>, an answer to a question box, and file uploads are never held back.</p>}
      >
        {/* What it says RIGHT NOW, in the host's own words — the same
            sentence a held queue row and a waiting backlog item show, so
            three surfaces can never disagree about one fact. Never
            folded: it is the state, not the argument. */}
        {budget && (
          <SetWarn tone={budget.verdict.blocked ? "bad" : "plain"} icon={budget.verdict.blocked ? AlertTriangle : Gauge}>
            {budgetReasonText(budget.verdict)}
            {budget.verdict.blocked && budget.verdict.resumeAt != null && ` — resumes ${hhmm(budget.verdict.resumeAt)}`}
          </SetWarn>
        )}
      </SetSwitch>

      {/* Whole numbers, coarse steps: this is a reserve, not a dial —
          and a slider is the one control that works with a thumb on a
          phone without a keyboard opening over the sheet. */}
      {budget && (
        <SetSlider
          id="budget-session" label="session ceiling"
          min={50} max={100} step={5} value={budget.budget.sessionMax}
          readout={budget.budget.sessionMax >= 100 ? "off" : `${budget.budget.sessionMax}%`}
          onInput={(v) => setDraft({ ...budget.budget, sessionMax: v })}
          onCommit={() => save(budget.budget)}
        />
      )}

      {budget && (
        <SetSwitch
          id="budget-weekly" label="weekly ceiling" icon={Gauge}
          on={budget.budget.weeklyMax != null}
          state={budget.budget.weeklyMax == null ? "off" : `${budget.budget.weeklyMax}%`}
          onChange={() => c.conn.liveSend({ t: "budget.set", budget: { ...budget.budget, weeklyMax: budget.budget.weeklyMax == null ? 90 : null } }, budget.budget.weeklyMax == null ? "weekly ceiling on" : "weekly ceiling off")}
          note="Off by default on purpose: the weekly window resets days out."
          more={<p>So a weekly ceiling stops unattended work until then. Turn it on deliberately.</p>}
        >
          {budget.budget.weeklyMax != null && (
            <input type="range" className="set-range" min={50} max={100} step={5} value={budget.budget.weeklyMax}
              onChange={(e) => setDraft({ ...budget.budget, weeklyMax: Number(e.target.value) })}
              onPointerUp={() => save(budget.budget)}
              onKeyUp={() => save(budget.budget)} />
          )}
        </SetSwitch>
      )}
    </>
  );
}
