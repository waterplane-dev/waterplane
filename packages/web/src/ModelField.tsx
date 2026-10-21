/**
 * "Which model?", asked once.
 *
 * Two controls, chosen by what the backend HAS rather than offered side by
 * side: a drop-down over the backend's catalogue, and — only where that
 * catalogue is genuinely empty — a typed field, because a guessed list is a
 * launch that fails minutes later with a message from a binary about a name it
 * was handed from here (`backendCaps.modelChoices`).
 *
 * It is a component and not two `<select>`s because there are two places a
 * model is chosen BEFORE a session exists — the new-session defaults on the
 * settings screen and the per-session ask (`LaunchAskSheet`) — and the rule
 * below is the kind that is correct in the copy you are looking at and missing
 * from the one you are not:
 *
 * **A value the catalogue does not name is shown as ITSELF.** A `<select>` whose
 * `value` matches no `<option>` renders as the first one, so a model typed on
 * another device, or one dropped from the table after a CLI upgrade, would read
 * back as "default" — the control stating a fact about the launch that is not
 * true, which is this repo's one prohibited failure mode for a readout. It gets
 * its own option, labelled as being off the list, and stays selectable until the
 * person changes it.
 */
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { memoryPressureNote, windowAdviceText } from "@waterplane/shared";
import { FilterChip } from "./kit/FilterChip";
import { acquireLocalRtWatch, freshSample, modelBaseName, useLocalRt } from "./localRt";
import { SetNote } from "./SettingsKit";
import {
  backendInfo, isZeroCost, modelChoices, modelGroups, showWhereFilter,
  HOSTED_DISCLAIMER, WHERE_LABEL, WHERE_NOTE, ZERO_COST_DISCLAIMER,
  type BackendList, type ModelWhere,
} from "./backendCaps";

interface Props {
  /** Every backend the host described, or null when it described none. */
  backends: BackendList;
  /** Which backend's catalogue to offer. Absent ⇒ claude. */
  backend?: string;
  /** The chosen model id, or undefined for "the backend's own default". */
  value?: string;
  /** Undefined means "default" — never an empty string. */
  onChange: (model: string | undefined) => void;
  /** Shown on the typed field only; the drop-down says "default" in a row. */
  placeholder?: string;
}

export function ModelField({ backends, backend, value, onChange, placeholder }: Props) {
  // Declared before the free-text early return below: a hook after a return is
  // a hook that runs in some renders and not others, which React forbids and
  // `react-hooks/rules-of-hooks` catches. Harmless-looking here because the
  // branch depends on the catalogue, which changes whenever the backend does.
  const [only, setOnly] = useState<ModelWhere | null>(null);
  /**
   * **What a LOCAL model is about to cost this desktop, as a sentence.**
   *
   * Choosing a hosted model spends somebody's money; choosing a local one
   * spends the machine you are driving, and until now that was invisible at the
   * exact moment of the choice. Two local models on a 64 GB desktop genuinely
   * may not fit — 18 GB for `qwen3-coder:30b` beside 9.2 GB for `gemma4:e4b`,
   * measured — and the runner answers by evicting one and reloading it from
   * disk on every switch, which is minutes of wall clock per turn.
   *
   * **It is a sentence and it never disables Start.** The numbers are good
   * enough to warn on and nowhere near good enough to refuse work on — the
   * reasons are stated in full on `memoryPressureNote` — and CLAUDE.md's rule
   * stands regardless: nothing applies itself.
   *
   * A mounted picker holds a watch lease of its own, ref-counted against the
   * strip's, so this works with the strip switched off and neither can switch
   * the other's readings off by unmounting. Declared before the free-text early
   * return below, with the filter state, because a hook after a return is a
   * hook that runs in some renders and not others.
   */
  useEffect(() => acquireLocalRtWatch(), []);
  const rt = useLocalRt((s) => freshSample(s.last, s.now), true);
  const cat = modelChoices(backends, backend);
  // The backend's own sentence about this list ("Copilot lists only Auto for
  // this account") — so a near-empty picker says WHY instead of looking broken.
  const listNote = backendInfo(backends, backend)?.models.note?.trim() || null;
  // A catalogue that came back EMPTY is a typed field, never a guessed list —
  // and an id here may carry a slash and a colon (`ollama/qwen3-coder:30b`), so
  // nothing splits it.
  if (cat.freeText) {
    const field = (
      <input className="search" placeholder={placeholder ?? "model id (blank = this backend’s default)"}
        value={value ?? ""} onChange={(e) => onChange(e.target.value.trim() || undefined)} />
    );
    return listNote ? <div className="model-field">{field}<div className="set-note">{listNote}</div></div> : field;
  }
  const listed = new Set([...cat.aliases, ...cat.ids]);
  const offList = value && !listed.has(value) ? value : null;
  /**
   * Where each model runs, from the host (`shared/wire/backend.ts`). Thirty ids
   * in one alphabetical drop-down is a list nobody reads to the end, and the
   * two facts that actually decide the choice — does this need the tunnel, does
   * this cost money — were not on screen at all.
   */
  const info = backendInfo(backends, backend);
  const groups = modelGroups(cat.ids, info?.models.where);
  const zeroCostIds = info?.models.zeroCost;
  const pickWhere = showWhereFilter(groups);
  // A filter the catalogue no longer has a group for is not a filter — it is an
  // empty list with no way out. Fall back to showing everything rather than
  // holding a selection nothing matches (switching backend is how you get here).
  const active = only && groups.some((g) => g.where === only) ? only : null;
  const shown = active ? groups.filter((g) => g.where === active) : groups;
  const note = active ? WHERE_NOTE[active] : null;
  /**
   * Is a hosted model actually on the table right now?
   *
   * Two ways it can be, and both must count. The group is open (you are
   * browsing them), or the model ALREADY CHOSEN is one — which is the case a
   * group-only condition misses entirely, and it is the case where the warning
   * matters most: the picker is closed, the value is set, and the next thing
   * that happens is a session reading your repo into somebody's server.
   */
  const whereMap = info?.models.where;
  const valueIsHosted = !!value && whereMap?.[value] === "hosted";
  /**
   * **Strip the provider prefix before matching, at the FIRST `/` only.**
   *
   * opencode's id for a local model is `ollama/qwen3-coder:30b`; the runner's
   * own `/api/ps` calls the same bytes `qwen3-coder:30b`. Compared unstripped,
   * the model that is ALREADY RESIDENT looks absent — and the note then warns,
   * at length, that a second model may evict the first, about the only model
   * running. A warning that fires on the happy path is one people learn to
   * ignore, which costs the warning that matters. Pinned in `localRt.test.mjs`.
   *
   * A stale or absent sample yields NO note: `freshSample` already withheld it
   * above rather than letting this describe models the desktop may have evicted
   * twenty minutes ago.
   */
  const pressure = value && whereMap?.[value] === "local" && rt
    ? memoryPressureNote(rt.models, modelBaseName(value), rt.memFree)
    : null;
  /** How much of this model's window Claude Code's own prompt took last time —
   *  two MEASURED numbers from the host or no sentence (`windowadvice.ts`). */
  const advice = value ? windowAdviceText(info?.models.contextWindow?.[value], info?.models.overheadTok?.[value]) : null;
  const hostedInPlay = active === "hosted" || valueIsHosted;
  const zeroCostShown = valueIsHosted
    ? isZeroCost(zeroCostIds, value!)
    // Browsing the group: say it if ANY model in it is free, since the reader
    // has not picked yet and the sentence is about the class they are choosing from.
    : (groups.find((g) => g.where === "hosted")?.ids ?? []).some((id) => isZeroCost(zeroCostIds, id));
  return (
    <div className="model-field">
      {/* A COUNT ON A CONTROL IS A FILTER (CLAUDE.md): "local · 2" opens exactly
          those two. Drawn only when there is more than one group — one group is
          furniture implying a decision nobody has. */}
      {pickWhere && (
        <div className="fchips wrap model-where">
          {groups.map((g) => (
            <FilterChip key={g.where} on={active === g.where}
              onClick={() => setOnly(active === g.where ? null : g.where)}>
              {WHERE_LABEL[g.where]} · {g.ids.length}
            </FilterChip>
          ))}
        </div>
      )}
      {/* What the chosen group MEANS, in a sentence. The filtered view saying
          what it is showing is the same rule the rest of the app follows; here
          it also carries the only warning this screen owes anybody, which is
          that a hosted model needs the tunnel and may bill. */}
      {note && <SetNote>{note}</SetNote>}
      {/* What this local model costs the desktop it will run on, measured from
          what the runner is holding RIGHT NOW. A sentence, never a refusal —
          the estimate cannot see the model this desktop has never loaded, and
          "free memory" on a machine with a page cache and a compressor is not a
          number anybody's work should be blocked on. Nothing here disables
          Start; see `localRt.ts`. */}
      {pressure && <SetNote>{pressure}</SetNote>}
      {advice && <SetNote>{advice}</SetNote>}
      {/* THE HARD PART, and it is deliberately not dismissible. It is drawn
          whenever a hosted model is in play — when the group is selected, and
          whenever the CURRENT value is one — because the moment that matters is
          the moment somebody points this at a private repo, not the moment they
          first opened a menu. `Unavailable.tsx`'s rule inverted: a consequence
          gets words, never an icon on its own. */}
      {hostedInPlay && (
        <div className="model-warn">
          <AlertTriangle size={14} />
          <span>{HOSTED_DISCLAIMER}</span>
        </div>
      )}
      {/* Only for ids the HOST MEASURED at zero (`models.zeroCost`) — never
          inferred from a `-free` in the name, and never shown for a price this
          app was not told. */}
      {hostedInPlay && zeroCostShown && (
        <div className="model-warn">
          <AlertTriangle size={14} />
          <span>{ZERO_COST_DISCLAIMER}</span>
        </div>
      )}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">default</option>
        {offList && <option value={offList}>{offList} — not in this list</option>}
        {/* Aliases and versions are the SAME decision at two precisions, so they
            are two groups of one control rather than two controls: "opus" is a
            standing instruction to run the newest Opus, "claude-opus-5" pins
            one. Both were always in the table; only the aliases were reachable,
            because the picker showed `aliases || ids` and claude's aliases are
            never empty. */}
        {cat.aliases.length > 0 && !active && (
          <optgroup label="Aliases — always the newest">
            {cat.aliases.map((m) => <option key={m} value={m}>{m}</option>)}
          </optgroup>
        )}
        {/* One `<optgroup>` per place the models run. With no locality from the
            host this is the single "Versions" group it has always been, which is
            why `modelGroups` answers one unknown group rather than nothing. */}
        {shown.map((g) => (
          <optgroup key={g.where} label={g.where === "unknown" && groups.length === 1 ? "Versions" : WHERE_LABEL[g.where]}>
            {g.ids.map((m) => <option key={m} value={m}>{m}</option>)}
          </optgroup>
        ))}
      </select>
      {listNote && <SetNote>{listNote}</SetNote>}
      {/* A model chosen and then filtered out of view is still the model that
          will run. Say so rather than letting the control look empty-handed. */}
      {active && value && !shown.some((g) => g.ids.includes(value)) && (
        <SetNote>Still set to <code>{value}</code>, which is not in this group.</SetNote>
      )}
    </div>
  );
}
