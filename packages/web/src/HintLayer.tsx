import { useEffect, useState } from "react";
import { AlertTriangle, Check, HelpCircle, Info, X } from "lucide-react";
import {
  closeHint, explainMode, onExplainChange, onHintCard, proceedHint, setExplainMode,
  type ActiveHint,
} from "./hints";
import { track } from "./usage";

/**
 * Renders whatever `hints.ts` decided to say, and the explain-mode banner.
 *
 * One instance, mounted next to `NetActivity` in both of `App`'s top-level
 * returns — for the same reason: the layer has to be reachable from inside
 * every sheet, and a sheet is a full-screen sibling, not a child.
 */
export function HintLayer() {
  const [hint, setHint] = useState<ActiveHint | null>(null);
  const [explain, setExplain] = useState(explainMode());

  useEffect(() => onHintCard(setHint), []);
  useEffect(() => onExplainChange(setExplain), []);

  // Explain mode intercepts every tap, so it must be leavable by a key too —
  // on a desktop the banner's Done button can be off in a corner of a sheet.
  useEffect(() => {
    if (!explain) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setExplainMode(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [explain]);

  return (
    <>
      {explain && (
        <div className="hint-mode-bar">
          <HelpCircle size={14} />
          <span>Explain mode — tap any button to read what it does. Nothing runs.</span>
          <button className="key" data-nohint onClick={() => setExplainMode(false)}><X size={14} /> done</button>
        </div>
      )}
      {hint && (
        // The backdrop closes WITHOUT remembering: dismissing a card you did not
        // read should not count as having read it. "Got it" is the button that
        // says never again.
        <div className="hint-backdrop" onClick={() => closeHint(false)}>
          <div className={`hint-card${hint.def.danger ? " danger" : ""}`} role="dialog" aria-modal="true"
            onClick={(e) => e.stopPropagation()}>
            <div className="hint-card-head">
              {hint.def.danger ? <AlertTriangle size={16} /> : <Info size={16} />}
              <span>{hint.def.title}</span>
            </div>
            <p className="hint-card-what">{hint.def.what}</p>
            {hint.def.when && <p className="hint-card-when">{hint.def.when}</p>}
            <div className="hint-card-acts">
              {hint.intercepted ? (
                <>
                  <button className="key" data-nohint onClick={() => closeHint(false)}><X size={14} /> not now</button>
                  <span className="spacer" />
                  <button className={`send${hint.def.danger ? " danger" : ""}`} data-nohint
                    onClick={() => { track("action:hint.proceed"); proceedHint(); }}>do it</button>
                </>
              ) : (
                <>
                  <span className="spacer" />
                  <button className="send" data-nohint onClick={() => closeHint(true)}><Check size={14} /> got it</button>
                </>
              )}
            </div>
            <div className="hint-card-foot">
              {hint.intercepted
                ? "Explained once. The next tap on this button just does it."
                : "Long-press any button for this. “Got it” stops it being explained again."}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The `?` chip. Lives in the launcher and session headers — the two bars that
 * are on screen no matter which sheet is open, and explain mode is global.
 *
 * `data-nohint` on purpose: in explain mode every other button is intercepted,
 * and a toggle that explained itself instead of switching off would be a trap.
 */
export function HintToggle({ compact = false }: { compact?: boolean }) {
  const [on, setOn] = useState(explainMode());
  useEffect(() => onExplainChange(setOn), []);
  return (
    <button className={`key hint-toggle${on ? " on" : ""}`} data-nohint
      aria-pressed={on}
      onClick={() => { if (!on) track("action:hints.explain"); setExplainMode(!on); }}>
      <HelpCircle size={compact ? 14 : 16} />{!compact && (on ? " done" : "")}
    </button>
  );
}
