/**
 * "What should this one run?" — asked at the moment a session is started,
 * because the answer is not always the same one twice.
 *
 * The new-session defaults on the settings screen are a good answer for the
 * session you are not thinking about. They are the wrong shape for a person who
 * runs a cheap model for a quick question and an expensive one for the work
 * after it: changing a default, opening a session and changing it back is three
 * screens and one thing to forget, and forgetting it is silent — the session
 * starts, looks right, and is running the wrong binary until something about
 * the output feels off. So this is the same two controls, moved to where the
 * decision actually is, behind a switch (`waterplane.launchAsk`) that is OFF by
 * default: an app that asks a question nobody wanted is worse than one that
 * assumes.
 *
 * **Just this launch.** Answering here does not write the defaults back. That
 * is deliberate and is said on the sheet: a picker that quietly re-points the
 * defaults would make the NEXT session inherit a choice made for this one, which
 * is exactly the silent drift the sheet exists to remove. The settings screen
 * stays the one place a default is set.
 *
 * **…but it does REMEMBER.** Not writing the defaults back is not the same as
 * forgetting: re-posing the question with the same wrong-for-you answer
 * pre-filled every launch is the switch's cost paid again for a decision already
 * made, and it is why this sheet read as broken. The pair answered here is kept
 * per device in `LS.launchLast` and is where the two controls START next time
 * (`launchAskStart` — pure, tested, and it drops a pair whose backend this host
 * does not describe). The stored defaults remain what a launch that was never
 * asked about runs, which is the claim they were always making.
 *
 * **Closing starts nothing.** This sheet stands between a tap and a
 * `session.create`; there is no session yet and no queued op, so the × is a
 * cancel and says so. Nothing here is durable and nothing is sent from here —
 * `onStart` hands the opts back to the one create constructor
 * (`App.createOp` → `wireLaunch`), so a backend this host never described is
 * still stripped on the way to the wire.
 */
import { useState } from "react";
import { Play, RefreshCw, Wallet } from "lucide-react";
import type { Effort, LaunchOpts, SessionBudget } from "@waterplane/shared";
import { SheetHead } from "./Sheet";
import { ModelField } from "./ModelField";
import { BudgetField } from "./BudgetField";
import { budgetChipWords } from "./budgetInput";
import { CantInline } from "./Unavailable";
import { CLAUDE, agentBackends, backendIdOf, backendOptionLabel, backendUnavailable, effortChoices, launchAskStart, modelChoices, showBackendPicker, windowNote, type BackendList } from "./backendCaps";
import { wheelSpokes } from "./modelWheel";
import { WheelPicker } from "./WheelChart";
import { LS, lsJson, lsSetJson } from "./storage";

interface Props {
  /** What is about to be opened, for the sentence at the top. */
  title: string;
  /** Every backend this host described, or null when it described none. */
  backends: BackendList;
  /** The stored defaults — where the two controls START, never where they end. */
  defaults: LaunchOpts;
  /** A budget the caller already chose (the Send sheet's) — where the field STARTS. */
  budget?: SessionBudget;
  /** Start it, with the opts as answered here. `budget` is the answer too: a cap,
   *  or null for none — never undefined, so a cleared field cannot fall back to
   *  the caller's. */
  onStart: (launch: LaunchOpts, budget: SessionBudget | null) => void;
  /** Ask the desktop to look again at a backend that said unavailable. The
   *  answer is a fresh backends list, which re-renders this sheet. */
  onRecheck?: () => void;
  /** Close without starting anything. */
  onClose: () => void;
}

export function LaunchAskSheet({ title, backends, defaults, budget: startBudget, onStart, onRecheck, onClose }: Props) {
  // Set by "Check again", so the sheet can say it LOOKED when the sentence stays.
  const [asked, setAsked] = useState(false);
  // Read ONCE, in the initialiser: the sheet is mounted per ask, so the stored
  // pair is the starting point of this ask and never a value that changes under
  // the person while they are looking at it.
  const [start] = useState(() => {
    const last = lsJson<{ backend?: string; model?: string; effort?: Effort } | null>(LS.launchLast, null);
    const pair = launchAskStart(backends, defaults, last);
    // Effort rides with the remembered pair: kept only when the pair itself
    // was, so a dropped backend never leaves its effort behind on another.
    const kept = !!last && pair.backend === last.backend && pair.model === last.model;
    return { ...pair, effort: kept ? last.effort ?? defaults.effort : defaults.effort };
  });
  const [backend, setBackend] = useState<string | undefined>(start.backend);
  const [model, setModel] = useState<string | undefined>(start.model);
  const [effort, setEffort] = useState<Effort | undefined>(start.effort);
  // The wheel is claude's: a short alias list that fits on spokes. A backend
  // with a long or place-grouped catalogue keeps `ModelField`, whose groups and
  // hosted disclaimer a wheel cannot carry.
  const wheel = backendIdOf({ backend }) === CLAUDE;
  const [versionOpen, setVersionOpen] = useState(false);
  const [budget, setBudget] = useState<SessionBudget | null>(startBudget ?? null);
  // Collapsed behind its chip, like the Send sheet's: most launches want none,
  // and a field this size is a screen of furniture between the model and Start.
  const [budgetOpen, setBudgetOpen] = useState(!!startBudget);
  const pickBackends = showBackendPicker(backends);
  /**
   * Switching backend clears the model with it, for `App.pickBackend`'s reason:
   * a model id belongs to the catalogue it came from — `opus` means nothing to a
   * local runner and `ollama/qwen3-coder:30b` means nothing to claude — and
   * carrying one across is how a launch fails with a message from a binary about
   * a name it was handed by this app.
   */
  const pickBackend = (id: string | undefined) => { setBackend(id); setModel(undefined); setEffort(id === defaults.backend ? defaults.effort : undefined); };
  const efforts = effortChoices(backends, backend);
  const cat = modelChoices(backends, backend);
  const spokes = wheel ? wheelSpokes(cat, model) : [];
  const atDefaults = model === defaults.model && effort === defaults.effort;
  const win = windowNote(backends, backend);
  // The host says this backend cannot start now (e.g. its runner is not
  // reachable): it stays listed, and the sentence REPLACES the Start button —
  // a launch that would fail is not offered, and the reason is on screen.
  const blocked = backendUnavailable(backends, backend);
  return (
    <div className="sheet">
      <SheetHead title="Start with…" onClose={onClose} />
      {/* Its own scroller: `#root` is fixed and clips, so on a phone shorter
          than the wheel + chips (an iPhone 17 is) Start was below the edge
          with nothing to scroll. */}
      <div className="sheet-scroll">
      <div className="form-hint">
        {title} — {pickBackends ? "which binary and which model" : "which model"}{wheel ? " and effort" : ""} this session runs.
        Just this one: your new-session defaults don’t change, and everything else about the
        launch ({wheel ? "permission mode" : "effort, permission mode"}) still comes from them.
      </div>
      <div className="form">
        {/* `.set-row` and not a bare `<label>`: the labelled-control styling in
            this app lives on that class (the settings screen's own rows), and a
            `<label><select>` outside it is an unstyled browser widget flush
            against the screen edge — which is exactly what this sheet shipped
            as. One class, so the ask and the settings screen cannot drift into
            two looks for the same two controls. */}
        <div className="set-row">
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
          {win && <span className="set-note">{win}.</span>}
        </div>
        {wheel && spokes.length > 0 && <>
          {/* The same picker the live session's popover draws (`WheelPicker`):
              one look in both places. */}
          <WheelPicker cat={cat} efforts={efforts} value={model ? { model, effort: effort ?? null } : null}
            onPick={(p) => { setModel(p.model); if (p.effort) setEffort(p.effort); }}
            now={<>Starts on {model || "the default model"}{efforts.length > 0 ? ` · ${effort || "default effort"}` : ""}</>}
            says={`Tap or drag to a point${efforts.length > 0 ? " — centre is low effort, the rim is max" : ""}.`} />
          <div className="sched-days">
            {/* The versioned ids (`claude-opus-5-5`, …) do not fit on spokes;
                one picked here becomes a spoke of its own. */}
            <button className={`row-chip${versionOpen ? " on" : ""}`} aria-pressed={versionOpen} onClick={() => setVersionOpen(!versionOpen)}>
              a specific version…
            </button>
            {!atDefaults && (
              <button className="row-chip" onClick={() => { setModel(defaults.model); setEffort(defaults.effort); }}>
                back to my defaults
              </button>
            )}
          </div>
          {versionOpen && <div className="set-row"><ModelField backends={backends} backend={backend} value={model} onChange={setModel} /></div>}
        </>}
        {/* What this session may spend, subagents included — blank is none.
            Just this launch, like the model: nothing here is remembered. A
            percent unit is converted at the window's measured rate once the
            session is running, so it says so (no session to calibrate yet). */}
        <div className="sched-days budget-chip-row">
          <button className={`row-chip${budget ? " on" : ""}`} aria-pressed={budgetOpen} onClick={() => setBudgetOpen(!budgetOpen)}>
            <Wallet size={13} /> {budget ? budgetChipWords(budget) : "budget…"}
          </button>
        </div>
        {budgetOpen && (
          <BudgetField initial={budget ?? startBudget ?? null} onChange={setBudget}
            calFor="A percent is converted from dollars at the window's measured rate once this session is running — until there is a fresh usage reading, nothing is held." />
        )}
        {blocked ? (
          <>
            <div className="act-cants"><CantInline>{blocked}</CantInline></div>
            {onRecheck && (
              <button className="send" onClick={() => { setAsked(true); onRecheck(); }}>
                <RefreshCw size={14} /> Check again
              </button>
            )}
            {asked && <div className="form-hint">Asked the desktop to look again — if the sentence above is still here, it is still not reachable. Start appears here by itself once it is.</div>}
          </>
        ) : (
        <button className="send" onClick={() => {
          // Remembered before the tap is resumed, and as a PAIR — `onStart`
          // hands control back to the caller that posed the question, which may
          // unmount this sheet on the same frame.
          lsSetJson(LS.launchLast, { backend, model, ...(wheel ? { effort } : {}) });
          onStart({ ...defaults, backend, model, ...(wheel ? { effort } : {}) }, budget);
        }}>
          <Play size={14} /> Start {title}
        </button>
        )}
        <div className="form-hint">
          Closing this starts nothing — nothing is queued until you press Start.
        </div>
      </div>
      </div>
    </div>
  );
}
