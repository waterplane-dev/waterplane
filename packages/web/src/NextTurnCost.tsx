/**
 * What the next turn costs against a fresh session — a reading, never a gate. Shared by the phone's context
 * sheet and the VS Code session view. The lead is the note and the advice; the doors' difference and the
 * mechanism fold. The doors are the PHONE's: a shell with no way to start a session or send `/compact` passes
 * `noDoors` and the panel is the reading alone (no button, and no "cannot start one here" line either).
 */
import { Plus, TrendingUp } from "lucide-react";
import type { SessionCostReading } from "@waterplane/shared";
import { costDoorsText } from "@waterplane/shared";
import { Unavailable } from "./Unavailable";

export function NextTurnCost({ cost, onFresh, onCompact, noDoors }: {
  cost: SessionCostReading;
  onFresh?: () => void;
  onCompact?: () => void;
  noDoors?: boolean;
}) {
  return (
    <div className={`ctx-cost ctx-cost-${cost.level}`}>
      <div className="ctx-cost-head">
        <TrendingUp size={14} />
        <span>{cost.chip ? `${cost.chip} a fresh session` : "about a fresh session"}</span>
      </div>
      <div className="ctx-cost-note">{cost.note}</div>
      {cost.advice && <div className="ctx-cost-note">{cost.advice}</div>}
      {/* The fresh-session door. Its sibling, `/compact` — which keeps the
          thread, where this keeps nothing — is the one on the Context
          window chart's name above, the reading it changes; a copy here
          was a second door to the same send. Its absence is said there. */}
      {cost.advice && !noDoors && onFresh && (
        <div className="sheet-actions">
          <button className="key" onClick={onFresh}>
            <Plus size={14} /> new session in this repo
          </button>
        </div>
      )}
      {cost.advice && !noDoors && !onFresh && (
        <Unavailable cants={[{
          label: "a new session from here",
          reason: "this session's directory is not one of this desktop's repos, so there is nowhere to start one",
        }]} />
      )}
      {/* The mechanism, and what each door keeps — folded, never cut:
          it is the sentence that stops this panel reading as a scold. */}
      <details className="hint-more ctx-method ctx-cost-more">
        <summary>why the next turn costs this</summary>
        <p>
          Every turn re-sends the whole conversation, so the next one is priced by what is
          already here, not by what you are about to ask.
          {cost.advice && !noDoors && onCompact && costDoorsText(true) ? ` ${costDoorsText(true)}` : ""}
        </p>
      </details>
    </div>
  );
}
