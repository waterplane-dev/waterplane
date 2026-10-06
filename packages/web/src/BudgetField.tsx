/**
 * One control for "how much may this session spend": a unit, a number, and the
 * switch for what happens at the cap. Drawn by the budget sheet (live session),
 * the Send sheet (a launch or a queued item) and the launch ask — one field, so
 * the three cannot word the same cap three ways (`ModelField`'s argument).
 *
 * It owns its text and reports a CLEAN budget upward, or null: blank is "no
 * budget" and a refusal is a sentence under the field, never a dimmed button.
 * Nothing here sends anything. The caps are words only — `parseBudgetInput`
 * validates for speed, `cleanSessionBudget` on the host is the gate.
 *
 * Built from the app's own controls, not new ones: the unit is `.segmented`
 * (the Send sheet's *When*), the number a `.search`-styled box with the unit
 * written beside it, the quick picks `.row-chip`s, the switch `SettingsKit`'s
 * `SetSwitch`. With a live session (`spark` given) it orients: what has been
 * spent so far in the chosen unit, with its subagent split, and the typed cap
 * against it (`budgetPreview`). A launch has no session and draws neither.
 */
import { useId, useState } from "react";
import type { SessionBudget, SessionBudgetCal, SessionBudgetSpark, SessionBudgetUnit } from "@waterplane/shared";
import { SetSwitch } from "./SettingsKit";
import {
  BUDGET_UNITS, budgetPreview, budgetSpentLine, budgetText, calibrationWords, isPctUnit, parseBudgetInput, presetLabel, unitInfo,
} from "./budgetInput";

export function BudgetField({ initial, cal, onChange, calFor, spark }: {
  /** The cap already set, if any — read once, where the field STARTS. */
  initial?: SessionBudget | null;
  /** The host's calibration: null = the host sent none; undefined = none to expect (a launch, or no budget set yet). */
  cal?: SessionBudgetCal | null;
  /** A clean budget, or null (blank or refused). Called on every edit. */
  onChange: (b: SessionBudget | null) => void;
  /** Words for a percent unit when there is no calibration to quote (a launch, or no budget set yet). */
  calFor?: string;
  /** The live session's spend, for the "so far" line and the preview. Absent: no session (a launch). */
  spark?: SessionBudgetSpark | null;
}) {
  const id = useId();
  const [unit, setUnit] = useState<SessionBudgetUnit>(initial?.unit ?? "usd");
  const [text, setText] = useState(initial ? budgetText(initial) : "");
  const [interrupt, setInterrupt] = useState(initial?.interrupt ?? true);
  const now = Date.now();
  const parsed = text.trim() ? parseBudgetInput(unit, text) : null;
  const emit = (u: SessionBudgetUnit, t: string, i: boolean) => {
    const p = t.trim() ? parseBudgetInput(u, t) : null;
    onChange(p && p.ok ? { unit: u, max: p.max, interrupt: i } : null);
  };
  const info = unitInfo(unit);
  const pct = isPctUnit(unit);
  const calWords = !pct ? null : cal === undefined ? calFor ?? null : calibrationWords(unit, cal, now);
  const spent = budgetSpentLine(unit, spark, cal, now);
  const preview = parsed && parsed.ok ? budgetPreview({ unit, max: parsed.max }, spark, cal, now) : null;
  const typedMax = parsed && parsed.ok ? parsed.max : null;
  return (
    <div className="budget-field">
      <div className="set-item">
        <div className="set-lead"><span className="set-lbl">measured in</span></div>
        <div className="segmented budget-units" role="group" aria-label="budget unit">
          {BUDGET_UNITS.map((u) => (
            <button key={u.unit} className={`seg${unit === u.unit ? " on" : ""}`} aria-pressed={unit === u.unit}
              onClick={() => { setUnit(u.unit); emit(u.unit, text, interrupt); }}>{u.label}</button>
          ))}
        </div>
      </div>
      {spent && <div className="budget-spent"><span className="budget-k">spent</span> {spent}</div>}
      <div className="set-item">
        <label className="set-lead" htmlFor={id}><span className="set-lbl">cap</span></label>
        <div className="budget-input">
          {info.prefix && <span className="budget-affix">{info.prefix}</span>}
          <input id={id} value={text} inputMode="decimal" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder={`e.g. ${info.example}`} aria-label={`cap in ${info.label}`}
            onChange={(e) => { setText(e.target.value); emit(unit, e.target.value, interrupt); }} />
          {info.suffix && <span className="budget-affix">{info.suffix}</span>}
        </div>
        <div className="set-chips budget-presets" role="group" aria-label="quick picks">
          {info.presets.map((p) => {
            const v = parseBudgetInput(unit, p);
            const on = v.ok && typedMax === v.max;
            return (
              <button key={p} className={`row-chip${on ? " on" : ""}`} aria-pressed={on}
                onClick={() => { setText(p); emit(unit, p, interrupt); }}>{presetLabel(unit, p)}</button>
            );
          })}
          <span className="set-note budget-blank">a blank field is no budget</span>
        </div>
      </div>
      {parsed && !parsed.ok && <div className="set-note warn">{parsed.reason}</div>}
      {preview && <div className="budget-preview">{preview}</div>}
      {calWords && <div className="set-note">{calWords}</div>}
      <SetSwitch label="interrupt the running turn when hit" on={interrupt}
        onChange={() => { setInterrupt(!interrupt); emit(unit, text, !interrupt); }}
        note={<>
          {interrupt
            ? "At the cap: sends to this session are held, you are told, and the turn that is running gets one Esc where it is safe to send one."
            : "At the cap: sends to this session are held and you are told. The turn that is running is left to finish."}
          {" "}Sends you arm by hand, answers to a question and uploads still go.
        </>} />
    </div>
  );
}
