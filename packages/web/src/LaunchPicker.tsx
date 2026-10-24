/**
 * Which binary, which model, which effort — the controls, once.
 *
 * Two places choose a launch before a session exists: the per-launch ask
 * (`LaunchAskSheet`, "Start with…") and the fan-out's one row for a whole
 * sweep. They used to be two different controls for the same three choices —
 * the ask drew the wheel, the sweep a bare drop-down that could not pick a
 * backend or an effort at all — so a person who had learnt one met a second
 * look for the same decision. This is the ask's set lifted out whole: the
 * backend drop-down (only when the host described several), the wheel for
 * claude's short alias list with "a specific version…" behind a chip, and
 * `ModelField` for a backend whose catalogue a wheel cannot carry.
 *
 * Owns no state but the version disclosure: the caller holds the pick and
 * decides what it is FOR (one launch, or a sweep) and what is remembered.
 */
import { useState, type ReactNode } from "react";
import type { Effort, LaunchOpts } from "@waterplane/shared";
import { ModelField } from "./ModelField";
import { CLAUDE, agentBackends, backendIdOf, backendOptionLabel, effortChoices, modelChoices, showBackendPicker, windowNote, backendDrift, type BackendList } from "./backendCaps";
import { wheelSpokes } from "./modelWheel";
import { WheelPicker } from "./WheelChart";
import { SetLine, SetNote } from "./SettingsKit";

export interface LaunchPick { backend?: string; model?: string; effort?: Effort }

/** The wheel is claude's: a short alias list that fits on spokes. A backend
 *  with a long or place-grouped catalogue keeps `ModelField`, whose groups and
 *  hosted disclaimer a wheel cannot carry — and effort is only picked here. */
export const pickHasWheel = (backend: string | undefined): boolean => backendIdOf({ backend }) === CLAUDE;

/** The launch a pick stands for: the defaults with the three answered over
 *  them. Effort only where it was picked here (the wheel); elsewhere it stays
 *  the defaults' and `launchFor` strips it if the backend cannot take it. */
export function launchOf(defaults: LaunchOpts, p: LaunchPick): LaunchOpts {
  return { ...defaults, backend: p.backend, model: p.model, ...(pickHasWheel(p.backend) ? { effort: p.effort } : {}) };
}

interface Props {
  backends: BackendList;
  value: LaunchPick;
  onChange: (next: LaunchPick) => void;
  /** The new-session defaults: what "back to my defaults" restores, and the
   *  effort a switch back to the default backend picks up again. */
  defaults: LaunchOpts;
  /** The line above the wheel, e.g. "Starts on" — the model and effort follow. */
  nowLead: string;
  /** Drawn under the backend/model row, before the wheel. */
  children?: ReactNode;
}

export function LaunchPicker({ backends, value, onChange, defaults, nowLead, children }: Props) {
  const { backend, model, effort } = value;
  const wheel = pickHasWheel(backend);
  const [versionOpen, setVersionOpen] = useState(false);
  const pickBackends = showBackendPicker(backends);
  /**
   * Switching backend clears the model with it, for `App.pickBackend`'s reason:
   * a model id belongs to the catalogue it came from — `opus` means nothing to a
   * local runner and `ollama/qwen3-coder:30b` means nothing to claude — and
   * carrying one across is how a launch fails with a message from a binary about
   * a name it was handed by this app.
   */
  const pickBackend = (id: string | undefined) =>
    onChange({ backend: id, model: undefined, effort: id === defaults.backend ? defaults.effort : undefined });
  const setModel = (m: string | undefined) => onChange({ ...value, model: m });
  const efforts = effortChoices(backends, backend);
  const cat = modelChoices(backends, backend);
  const spokes = wheel ? wheelSpokes(cat, model) : [];
  const atDefaults = backend === defaults.backend && model === defaults.model && effort === defaults.effort;
  const win = windowNote(backends, backend);
  const drift = backendDrift(backends, backend);
  return <>
    {/* `.set-row` and not a bare `<label>`: the labelled-control styling in
        this app lives on that class (the settings screen's own rows), and a
        `<label><select>` outside it is an unstyled browser widget flush
        against the screen edge. One class, so every launch choice and the
        settings screen cannot drift into two looks for the same controls. */}
    <SetLine>
      {pickBackends && (
        <label>backend
          <select value={backend ?? CLAUDE}
            onChange={(e) => pickBackend(e.target.value === CLAUDE ? undefined : e.target.value)}>
            {agentBackends(backends)!.map((b) => <option key={b.id} value={b.id}>{backendOptionLabel(b)}</option>)}
          </select>
        </label>
      )}
      {!wheel && (
        <label>model
          <ModelField backends={backends} backend={backend} value={model} onChange={setModel} />
        </label>
      )}
      {/* Said only when it IS known — never a 0k, and never claude's window
          borrowed for a local model (`windowNote`). */}
      {win && <SetNote as="span">{win}.</SetNote>}
      {drift && <SetNote as="span">{drift}</SetNote>}
      {children}
    </SetLine>
    {wheel && spokes.length > 0 && <>
      {/* The same picker the live session's popover draws (`WheelPicker`):
          one look everywhere a model is chosen. */}
      <WheelPicker cat={cat} efforts={efforts} value={model ? { model, effort: effort ?? null } : null}
        onPick={(p) => onChange({ ...value, model: p.model, ...(p.effort ? { effort: p.effort } : {}) })}
        now={<>{nowLead} {model || "the default model"}{efforts.length > 0 ? ` · ${effort || "default effort"}` : ""}</>}
        says={`Tap or drag to a point${efforts.length > 0 ? " — centre is low effort, the rim is max" : ""}.`} />
      <div className="sched-days">
        {/* The versioned ids (`claude-opus-5-5`, …) do not fit on spokes;
            one picked here becomes a spoke of its own. */}
        <button className={`row-chip${versionOpen ? " on" : ""}`} aria-pressed={versionOpen} onClick={() => setVersionOpen(!versionOpen)}>
          a specific version…
        </button>
        {!atDefaults && (
          <button className="row-chip" onClick={() => onChange({ backend: defaults.backend, model: defaults.model, effort: defaults.effort })}>
            back to my defaults
          </button>
        )}
      </div>
      {versionOpen && <SetLine><ModelField backends={backends} backend={backend} value={model} onChange={setModel} /></SetLine>}
    </>}
  </>;
}
