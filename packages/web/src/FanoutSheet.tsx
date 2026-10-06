import { useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronDown, ChevronUp, CircleAlert, CircleCheck, CornerDownRight, Loader, Pencil, Play, Send, Split, Square, SquareCheck } from "lucide-react";
import type { FanoutRun, FanoutTarget, RepoTarget } from "@waterplane/shared";
import { track } from "./usage";
import { PromptComposer } from "./PromptComposer";
import { RepoPicker } from "./RepoPicker";
import { SnippetSheet } from "./SnippetSheet";
import { loadPresets, resetPresets, savePresets, type Preset } from "./presets";
import { onSettingsChange } from "./settings";
import { LS, lsJson, lsSetJson } from "./storage";
import { SheetHead } from "./Sheet";
import { useBackStep } from "./backStep";
import { SyncMark } from "./SyncMark";

interface Props {
  repos: RepoTarget[];
  /** Recent runs, newest first. */
  runs: FanoutRun[];
  /** Fire the sweep. App routes it through the durable send queue, so this is
   *  never lost to a dead tunnel — it just runs later. */
  onRun: (dirs: string[], text: string) => void;
  /** Send another instruction into the sessions a run already spawned. */
  onFollowUp: (runId: string, text: string, dirs: string[]) => void;
  /** Hand the composed sweep to the schedule editor instead of running it now.
   *  The repo picker and the prompt box ARE the sweep — retyping both in another
   *  sheet is the only other way to say "this, but on Thursday". */
  onSchedule: (dirs: string[], text: string) => void;
  /** false = no socket. The run is still accepted (it queues); the button says so. */
  online?: boolean;
  /** Open a spawned session (tap a target row). */
  onOpen: (sessionId: string) => void;
  onClose: () => void;
}

/** Sticky selection + draft — a maintenance sweep is usually the same repo set twice. */
const SEL_KEY = LS.fanoutSel;
const TEXT_KEY = LS.fanoutText;
const load = <T,>(key: string, fallback: T): T => {
  return lsJson<T>(key, fallback);
};
const save = (key: string, v: unknown) => { lsSetJson(key, v); };

/** How many preset chips are shown before the "more" toggle. The full list is
 *  long on purpose (it is the routine-sweep menu), and a phone screen has room
 *  for one row of chips above the repo checklist, which is the control that
 *  actually has to be reachable. */
const PRESETS_SHOWN = 6;

const STATUS_TAG: Record<FanoutTarget["status"], string> = {
  pending: "idle", starting: "coding", running: "coding", done: "ok", failed: "dead",
};

/**
 * Fan-out: one prompt, N repos, a FRESH claude session in each — the maintenance
 * sweep ("/init everywhere", "what did this project cost this month?") that would
 * otherwise be N repo taps and N retypings.
 *
 * Each target is an ordinary session afterwards: tap it to open the terminal.
 */
export function FanoutSheet({ repos, runs, onRun, onFollowUp, onSchedule, onOpen, onClose, online = true }: Props) {
  const [text, setText] = useState<string>(() => load(TEXT_KEY, ""));
  const [sel, setSel] = useState<Set<string>>(() => new Set(load<string[]>(SEL_KEY, [])));
  /** One-tap routine sweeps. User-owned: editable, reorderable, extendable. */
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  // Presets follow the user across devices (settings.ts) — re-read when another
  // device edits the list while this sheet is open.
  useEffect(() => onSettingsChange(() => setPresets(loadPresets()), [LS.fanoutPresets]), []);
  const [allPresets, setAllPresets] = useState(false);
  const [editPresets, setEditPresets] = useState(false);
  /** Which run's follow-up composer is open, plus its draft and target subset. */
  const [fuRun, setFuRun] = useState<string | null>(null);
  const [fuText, setFuText] = useState("");
  const [fuSel, setFuSel] = useState<Set<string>>(new Set());

  // A selected worktree stays selected (and counted) even while the shared
  // picker is filtered to primaries — hiding a row must not silently drop it
  // from the run. `RepoPicker` carries that rule now (`visibleRepos`).
  const chosen = useMemo(() => repos.filter((r) => sel.has(r.worktreePath)), [repos, sel]);
  const dirs = useMemo(() => [...sel], [sel]);

  /** Tapping a preset must never eat a prompt that was typed by hand: it REPLACES
   *  an empty composer (and one holding another preset — that is preset switching),
   *  and otherwise appends, so "repo health" plus your own extra sentence is one tap
   *  and one line of typing. */
  function applyPreset(p: Preset) {
    track("action:fanout.preset");
    const cur = text.trim();
    const isPreset = presets.some((x) => x.text.trim() === cur);
    const next = !cur || isPreset ? p.text : `${text.replace(/\s+$/, "")}\n\n${p.text}`;
    setText(next);
    save(TEXT_KEY, next);
  }
  function writePresets(next: Preset[]) { setPresets(next); savePresets(next); }

  /** The one writer of the selection: state + the sticky copy, together. */
  function setAll(next: string[]) {
    setSel(new Set(next));
    save(SEL_KEY, next);
  }
  function go() {
    const dirs = chosen.map((r) => r.worktreePath);
    if (!dirs.length || !text.trim()) return;
    track("action:fanout.run");
    save(TEXT_KEY, text);
    onRun(dirs, text.trim());
  }

  /** Targets of a run that can still be typed into (they have a session). */
  const addressable = (run: FanoutRun) => run.targets.filter((t) => t.sessionId);

  function openFollowUp(run: FanoutRun) {
    track("action:fanout.followup.open");
    setFuRun(run.id);
    setFuText("");
    // Default to every target that has a session — the common case is "all of
    // them again". Unticking is one tap; hunting for the ones you want is not.
    setFuSel(new Set(addressable(run).map((t) => t.dir)));
  }
  function toggleFu(dir: string) {
    setFuSel((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir); else next.add(dir);
      return next;
    });
  }
  function sendFollowUp(run: FanoutRun) {
    const dirs = addressable(run).filter((t) => fuSel.has(t.dir)).map((t) => t.dir);
    if (!dirs.length || !fuText.trim()) return;
    track("action:fanout.followup");
    onFollowUp(run.id, fuText.trim(), dirs);
    setFuRun(null);
    setFuText("");
  }

  // Back — the gesture as much as the arrow — closes this step, not the sheet.
  useBackStep(editPresets, () => setEditPresets(false));
  // Same list editor the compose snippets use — nested here rather than as its own
  // overlay, so closing it lands back on the fan-out with the selection intact.
  if (editPresets)
    return <SnippetSheet
      snippets={presets}
      onSave={writePresets}
      onReset={() => setPresets(resetPresets())}
      onClose={() => setEditPresets(false)}
      heading="Fan-out presets"
      hint={<>The one-tap chips over the fan-out prompt. Anything the CLI accepts works — slash commands included.</>}
      emptyText="No presets. Tap “new” to add one, or “defaults” to restore the shipped list."
      textPlaceholder="What should every selected repo do?"
      trackId="action:fanout.presets.save"
    />;

  return (
    <div className="sheet">
      <SheetHead title={<><Split size={16} /> Fan-out</>} onClose={onClose} />
      {/* The saved repo sets are synced; a run is not. This line is about the
          presets only, which is why it names them. */}
      <SyncMark keys={[LS.fanoutPresets]} thing="your saved sets" />

      {/* Everything below the head scrolls as ONE column. Without this the repo
          list and each run's list are sibling `flex:1` boxes, so a few recorded
          runs squeeze the repo checklist to nothing and no repo can be picked. */}
      <div className="sheet-scroll">
      <div className="form-hint">
        One prompt, a fresh CLI session per selected repo, all at once. Slash commands work (<span className="mono">/init</span>, <span className="mono">/cost</span>). Each session is a normal session afterwards — tap a result row to open it, or follow up in all of them at once.
      </div>

      <div className="form">
        {/* The one prompt-writing surface (`PromptComposer`). Inline, because
            the sweep's other half — the repo checklist — is what the rest of
            this sheet is for and must not be squeezed off the screen. No chain:
            a fan-out is ONE prompt across N repos by definition. */}
        <PromptComposer
          inline rows={3}
          prompts={[text]}
          onChange={(next) => { const v = next[0] ?? ""; setText(v); save(TEXT_KEY, v); }}
          placeholder="What should every selected repo do?"
        />
        <div className="annot-tools wrap">
          {(allPresets ? presets : presets.slice(0, PRESETS_SHOWN)).map((p) => (
            <button key={p.id} className="key" title={p.text} onClick={() => applyPreset(p)}>{p.title}</button>
          ))}
          {presets.length > PRESETS_SHOWN && (
            <button className="key" onClick={() => setAllPresets(!allPresets)}>
              {allPresets ? <><ChevronUp size={14} /> less</> : <><ChevronDown size={14} /> {presets.length - PRESETS_SHOWN} more</>}
            </button>
          )}
          <button className="key" title="edit the preset list"
            onClick={() => { track("action:fanout.presets.edit"); setEditPresets(true); }}><Pencil size={14} /></button>
        </div>
      </div>

      {/* The shared picker (`RepoPicker.tsx`) — its own all/none and its own
          worktree filter, which this sheet and the schedule editor used to
          implement twice, differently. */}
      <RepoPicker multi selected={dirs} onChange={setAll} repos={repos} countHint="· a fresh session in each" />

      {runs.length > 0 && (
        <>
          <div className="section">Runs</div>
          {runs.slice(0, 5).map((run) => {
            const live = addressable(run);
            const picking = fuRun === run.id;
            return (
            <div key={run.id}>
              <div className="form-hint mono">{run.text.length > 90 ? `${run.text.slice(0, 90)}…` : run.text}</div>
              {run.followUps?.map((f, i) => (
                <div key={i} className="form-hint mono"><CornerDownRight size={11} /> {f.text.length > 90 ? `${f.text.slice(0, 90)}…` : f.text}
                  {f.dirs.length < run.targets.length ? <span className="section-hint"> · {f.dirs.length} of {run.targets.length}</span> : null}
                </div>
              ))}
              <div className="list">
                {run.targets.map((t) => (
                  <div key={t.dir} className="row-wrap">
                    <button className="row grow" disabled={!t.sessionId} onClick={() => t.sessionId && onOpen(t.sessionId)}>
                      <span className="row-title">
                        {t.status === "starting" || t.status === "running" ? <Loader size={12} className="spin" /> : null}
                        {t.status === "done" ? <CircleCheck size={12} /> : null}
                        {t.status === "failed" ? <CircleAlert size={12} /> : null}
                        {" "}{t.title} <span className={`tag ${STATUS_TAG[t.status]}`}>{t.status}</span>
                      </span>
                      <span className="row-sub">{t.error || (t.sessionId ? "tap to open the session" : "starting…")}</span>
                    </button>
                    {/* Picking targets is a SEPARATE control from the row: tapping
                        the row must keep meaning "open that session". */}
                    {picking && (
                      <button className={`row-act ${t.sessionId && fuSel.has(t.dir) ? "on" : ""}`} disabled={!t.sessionId}
                        title={t.sessionId ? "include in the follow-up" : "no session to send to"}
                        onClick={() => t.sessionId && toggleFu(t.dir)}>
                        {t.sessionId && fuSel.has(t.dir) ? <SquareCheck size={16} /> : <Square size={16} />}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {live.length > 0 && !picking && (
                <div className="form">
                  <button className="key" data-hint="fanout.followup" onClick={() => openFollowUp(run)}>
                    <CornerDownRight size={14} /> follow up in {live.length} session{live.length === 1 ? "" : "s"}
                  </button>
                </div>
              )}
              {picking && (
                <div className="form">
                  {/* The same composer, inline: a follow-up is a prompt like
                      any other, and it sits inside a run's own list. */}
                  <PromptComposer
                    inline rows={2} autoFocus
                    prompts={[fuText]}
                    onChange={(next) => setFuText(next[0] ?? "")}
                    placeholder="Next instruction for the selected sessions…"
                  />
                  <div className="annot-tools">
                    <button className="key" onClick={() => setFuSel(new Set(live.map((t) => t.dir)))}>all</button>
                    <button className="key" onClick={() => setFuSel(new Set())}>none</button>
                    <button className="key" onClick={() => { setFuRun(null); setFuText(""); }}>cancel</button>
                    <span className="spacer" />
                    <button className="send" disabled={!fuText.trim() || !live.some((t) => fuSel.has(t.dir))}
                      onClick={() => sendFollowUp(run)}>
                      <Send size={14} /> send to {live.filter((t) => fuSel.has(t.dir)).length}
                    </button>
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </>
      )}
      </div>

      <div className="sheet-actions">
        <span className="spacer" />
        <button
          className="key" data-hint="fanout.schedule"
          disabled={!chosen.length || !text.trim()}
          title="Run it later instead — once tonight, or every week at a time you pick"
          onClick={() => {
            track("action:fanout.schedule");
            save(TEXT_KEY, text);
            onSchedule(chosen.map((r) => r.worktreePath), text.trim());
          }}
        ><CalendarClock size={16} /> later</button>
        <button className="send" data-hint="fanout.run" disabled={!chosen.length || !text.trim()} onClick={go}
          title={online ? undefined : "no connection — the sweep is queued and runs when the link is back"}>
          <Play size={16} /> {online ? "Run" : "Queue"} in {chosen.length} repo{chosen.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
