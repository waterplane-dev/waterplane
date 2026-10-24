/**
 * One control for "how much may this session spend": a unit, a number, and
 * what happens at the cap — `soft` (the default: queued work waits, the
 * person's own sends go, one optional Esc) or `hard` (the person's sends ask
 * first, every other turn gets an Esc). Both rows carry their whole meaning. Drawn by the budget sheet (live session),
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
import { RadioRows } from "./kit";
import { useId, useState } from "react";
import type { SessionBudget, SessionBudgetCal, SessionBudgetSpark, SessionBudgetUnit } from "@waterplane/shared";
import { SetNote, SetSwitch } from "./SettingsKit";
import {
  BUDGET_MODES, type BudgetMode, budgetPreview, budgetSpentLine, budgetText, budgetUnitsFor, calibrationWords, isPctUnit, parseBudgetInput, presetLabel, unitInfo,
} from "./budgetInput";

export function BudgetField({ initial, cal, onChange, calFor, spark, windowsOff }: {
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
  /** The session's backend does not spend from claude's windows: no percent
   *  unit is offered, and THIS sentence stands under the units saying why
   *  (shared `sessionBudgetWindowsOffText`). Absent: all four, as ever. */
  windowsOff?: string | null;
}) {
  const id = useId();
  const [unit, setUnit] = useState<SessionBudgetUnit>(initial?.unit ?? "usd");
  const [text, setText] = useState(initial ? budgetText(initial) : "");
  const [interrupt, setInterrupt] = useState(initial?.interrupt ?? true);
  const [mode, setMode] = useState<BudgetMode>(initial?.hard ? "hard" : "soft");
  const now = Date.now();
  const parsed = text.trim() ? parseBudgetInput(unit, text) : null;
  const emit = (u: SessionBudgetUnit, t: string, i: boolean, m: BudgetMode = mode) => {
    const p = t.trim() ? parseBudgetInput(u, t) : null;
    // Hard always interrupts (the host's `cleanSessionBudget` says the same).
    onChange(p && p.ok ? (m === "hard" ? { unit: u, max: p.max, interrupt: true, hard: true } : { unit: u, max: p.max, interrupt: i }) : null);
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
        <RadioRows
          label="budget unit"
          options={budgetUnitsFor(!!windowsOff, initial?.unit).map((u) => ({ key: u.unit, label: u.label }))}
          value={unit}
          onChange={(u) => { setUnit(u); emit(u, text, interrupt); }} />
      </div>
      {windowsOff && <SetNote>{windowsOff}</SetNote>}
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
          <SetNote as="span" className="budget-blank">a blank field is no budget</SetNote>
        </div>
      </div>
      {parsed && !parsed.ok && <SetNote className="warn">{parsed.reason}</SetNote>}
      {preview && <div className="budget-preview">{preview}</div>}
      {calWords && <SetNote>{calWords}</SetNote>}
      <div className="set-item">
        <div className="set-lead"><span className="set-lbl">at the cap</span></div>
        <RadioRows
          label="what happens at the cap"
          options={BUDGET_MODES.map((m) => ({ key: m.key, label: m.label, note: m.note }))}
          value={mode}
          onChange={(m) => { setMode(m); emit(unit, text, interrupt, m); }} />
      </div>
      {mode === "soft" && (
        <SetSwitch label="interrupt the running turn when hit" on={interrupt}
          onChange={() => { setInterrupt(!interrupt); emit(unit, text, !interrupt); }}
          note={interrupt
            ? "The turn running when the cap is hit gets one Esc, where it is safe to send one."
            : "The turn running when the cap is hit is left to finish."} />
      )}
    </div>
  );
}
