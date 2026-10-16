import { useEffect, useState } from "react";
import { AlertTriangle, Check, HelpCircle, Info, X } from "lucide-react";
import {
  closeHint, explainMode, onExplainChange, onHintCard, proceedHint, setExplainMode,
  type ActiveHint,
} from "./hints";
import { track } from "./usage";
import { prefs, setPref, usePref } from "./core/prefs";
import { showToast } from "./toast";

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
  // The one-time ask: the first time explain mode is LEFT, the person has just
  // used the `?` and knows what it does — so ask whether it may go, to give
  // the headers its room back. Asked on leaving, never on entering: the
  // question only makes sense after the answer to "what is this button".
  const [askChip, setAskChip] = useState(false);
  useEffect(() => onExplainChange((on) => {
    setExplain(on);
    if (!on && prefs.get("hintChip") === "") setAskChip(true);
  }), []);

  // Explain mode intercepts every tap, so it must be leavable by a key too —
  // on a desktop the banner's Done button can be off in a corner of a sheet.
  useEffect(() => {
    if (!explain) return;
    // preventDefault: answered here, so `core/layout/escape.ts` adds no Back.
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setExplainMode(false); } };
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
      {askChip && !hint && (
        // Backdrop = not answered: asked again next time, like a hint card.
        <div className="hint-backdrop" onClick={() => setAskChip(false)}>
          <div className="hint-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="hint-card-head"><HelpCircle size={16} /><span>Keep the ? button?</span></div>
            <p className="hint-card-what">Now you know what it does. Long-pressing any button explains it too, so the ? can go
              to give the headers their space back — in the launcher and in every session.</p>
            <p className="hint-card-when">Settings › Writing &amp; reading brings it back, or resets the whole UI to its defaults.</p>
            <div className="hint-card-acts">
              <button className="key" data-nohint onClick={() => { setPref("hintChip", "asked"); setAskChip(false); }}>keep it</button>
              <span className="spacer" />
              <button className="send" data-nohint onClick={() => {
                track("action:hints.chipHidden");
                setPref("hintChip", "hidden"); setAskChip(false);
                showToast("? removed — Settings › Writing & reading brings it back");
              }}><X size={14} /> remove it</button>
            </div>
          </div>
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
  // Removed by the one-time ask (or the Settings switch) — from BOTH headers,
  // since this one component is what each of them draws.
  if (usePref("hintChip") === "hidden") return null;
  return (
    <button className={`key hint-toggle${on ? " on" : ""}`} data-nohint
      aria-pressed={on}
      onClick={() => { if (!on) track("action:hints.explain"); setExplainMode(!on); }}>
      <HelpCircle size={compact ? 14 : 16} />{!compact && (on ? " done" : "")}
    </button>
  );
}
