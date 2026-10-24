import { useEffect, useMemo, useState, type ComponentType } from "react";
import { CalendarClock, ChevronDown, ChevronUp, CircleAlert, CircleCheck, CornerDownRight, Flag, Loader, Pencil, Play, Send, Split, Square, SquareCheck } from "lucide-react";
import type { BackendInfo, FanoutRun, FanoutTarget, LaunchOpts, RepoTarget } from "@waterplane/shared";
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
import { LaunchPicker, launchOf, type LaunchPick } from "./LaunchPicker";
import { backendUnavailable, launchAskStart } from "./backendCaps";
import { CantInline } from "./Unavailable";
import { kickoff, kickoffSent, targetSubline } from "./fanoutKickoff";
import { Button } from "./kit/Button";
import { Row, RowTitle, RowSub } from "./kit/Row";
import { Hint } from "./kit/Hint";
import { Tag } from "./kit/Tag";
import { SetNote } from "./SettingsKit";

interface Props {
  repos: RepoTarget[];
  /** Recent runs, newest first. */
  runs: FanoutRun[];
  /** The host's backends (model catalogue), null when it described none. */
  backends: BackendInfo[] | null;
  /** The new-session defaults — the model row starts on theirs. */
  launch: LaunchOpts;
  /** Fire the sweep. App routes it through the durable send queue, so this is
   *  never lost to a dead tunnel — it just runs later. `launch` is the sweep's
   *  own pick (backend, model, effort) over the new-session defaults. */
  onRun: (dirs: string[], text: string, launch: LaunchOpts, flagWhenDone?: boolean) => void;
  /** Send another instruction into the sessions a run already spawned. */
  onFollowUp: (runId: string, text: string, dirs: string[]) => void;
  /** Hand the composed sweep to the schedule editor instead of running it now.
   *  The repo picker and the prompt box ARE the sweep — retyping both in another
   *  sheet is the only other way to say "this, but on Thursday". */
  onSchedule: (dirs: string[], text: string, launch: LaunchOpts) => void;
  /** false = no socket. The run is still accepted (it queues); the button says so. */
  online?: boolean;
  /** Open a spawned session (tap a target row). */
  onOpen: (sessionId: string) => void;
  /** A line of words above Run (what the last similar sweep cost). Never a gate. */
  CostHint?: ComponentType<{ text: string }>;
  onClose: () => void;
}

/** Sticky selection + draft — a maintenance sweep is usually the same repo set twice. */
const SEL_KEY = LS.fanoutSel;
/** The sweep's launch when it is NOT the new-session default: null follows the
 *  defaults. Stored before backend/effort were on the row as `{ model }` alone,
 *  which meant "on the default backend" — read back that way (`sweepStart`). */
type SweepPick = LaunchPick | null;
const TEXT_KEY = LS.fanoutText;
const load = <T,>(key: string, fallback: T): T => {
  return lsJson<T>(key, fallback);
};
const save = (key: string, v: unknown) => { lsSetJson(key, v); };

/**
 * Where the sweep's row starts: the stored pick, read through the ask's own
 * guard (`launchAskStart`) so a backend this host no longer describes drops
 * the pick AS A WHOLE back to the defaults — a `<select>` off its options
 * renders as the first, and the row would say claude while the run carried
 * something else. A pick stored as `{ model }` alone predates the backend
 * control and meant the default backend, so it is read as that.
 */
function sweepStart(backends: BackendInfo[] | null, launch: LaunchOpts, pick: SweepPick): LaunchPick | null {
  if (!pick) return null;
  const stored = { ...pick, backend: "backend" in pick ? pick.backend : launch.backend };
  const pair = launchAskStart(backends, launch, stored);
  if (pair.backend !== stored.backend || pair.model !== stored.model) return null;
  return { ...pair, effort: "effort" in pick ? pick.effort : launch.effort };
}

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
export function FanoutSheet({ repos, runs, backends, launch, onRun, onFollowUp, onSchedule, onOpen, CostHint, onClose, online = true }: Props) {
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
  /** A sweep is ONE decision over N repos, so it gets one launch row — not the
   *  per-launch ask, but the same controls (`LaunchPicker`). Sticky like the
   *  selection: a sweep is usually re-run. */
  const [pick, setPick] = useState<SweepPick>(() => load<SweepPick>(LS.fanoutModel, null));
  const defaults: LaunchPick = { backend: launch.backend, model: launch.model, effort: launch.effort };
  const chose = sweepStart(backends, launch, pick) ?? defaults;
  const sweep = launchOf(launch, chose);
  function pickLaunch(p: LaunchPick) {
    // Picking the defaults back IS following them — so a later change to a
    // default reaches the sweep too, instead of a stale copy of it.
    const same = p.backend === launch.backend && p.model === launch.model && p.effort === launch.effort;
    const next: SweepPick = same ? null : { backend: p.backend, model: p.model, effort: p.effort };
    setPick(next);
    save(LS.fanoutModel, next);
  }
  // A backend the host says cannot start now: the sentence replaces Run, as
  // on the ask — N launches that would fail are not offered.
  const blocked = backendUnavailable(backends, chose.backend);
  /** The tap that has not shown up as a run yet: the run ids that existed
   *  before it, so the first new one is this tap's. The host stamps
   *  `startedAt`, and the phone's clock is not its clock. */
  const [fired, setFired] = useState<{ known: Set<string>; repos: number; offline: boolean } | null>(null);

  // A selected worktree stays selected (and counted) even while the shared
  // picker is filtered to primaries — hiding a row must not silently drop it
  // from the run. `RepoPicker` carries that rule now (`visibleRepos`).
  const chosen = useMemo(() => repos.filter((r) => sel.has(r.worktreePath)), [repos, sel]);
  // Why "later" / "Run" are not drawn: a sentence, never a dimmed button.
  const gate = !chosen.length ? "pick at least one repo" : !text.trim() ? "write the instruction first" : null;
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
  // "Flag for follow up when done" (R-sessions-043): this run only, off unless
  // ticked — never remembered, there is no global setting for it.
  const [flagWhenDone, setFlagWhenDone] = useState(false);
  function go() {
    const dirs = chosen.map((r) => r.worktreePath);
    if (!dirs.length || !text.trim()) return;
    track("action:fanout.run");
    save(TEXT_KEY, text);
    setFired({ known: new Set(runs.map((r) => r.id)), repos: dirs.length, offline: !online });
    onRun(dirs, text.trim(), sweep, flagWhenDone || undefined);
  }

  // The strip above Run: this tap's run once the host wrote it down, else the
  // newest run still going (reopening the sheet mid-sweep still shows it).
  const mine = fired ? runs.find((r) => !fired.known.has(r.id)) : undefined;
  const shown = mine ?? (fired ? undefined : runs.find((r) => !r.finishedAt));
  const kick = shown ? kickoff(shown.targets) : null;

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
      <Hint>
        One prompt, a fresh CLI session per selected repo, all at once. Slash commands work (<span className="mono">/init</span>, <span className="mono">/cost</span>). Each session is a normal session afterwards — tap a result row to open it, or follow up in all of them at once.
      </Hint>

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
            <Button key={p.id} title={p.text} onClick={() => applyPreset(p)}>{p.title}</Button>
          ))}
          {presets.length > PRESETS_SHOWN && (
            <Button onClick={() => setAllPresets(!allPresets)}>
              {allPresets ? <><ChevronUp size={14} /> less</> : <><ChevronDown size={14} /> {presets.length - PRESETS_SHOWN} more</>}
            </Button>
          )}
          <Button title="edit the preset list"
            onClick={() => { track("action:fanout.presets.edit"); setEditPresets(true); }}><Pencil size={14} /></Button>
        </div>
        <LaunchPicker backends={backends} defaults={launch} nowLead="Every repo starts on"
          value={chose} onChange={pickLaunch}>
          {pick && (
            <SetNote as="span">
              This sweep only — new sessions still start on {launch.model ?? "the default"}{launch.effort ? ` · ${launch.effort}` : ""}.{" "}
              <button className="link-btn" onClick={() => pickLaunch(defaults)}>use that</button>
            </SetNote>
          )}
        </LaunchPicker>
        <div className="annot-tools wrap">
          <button className={`row-chip${flagWhenDone ? " on" : ""}`} aria-pressed={flagWhenDone} data-hint="session.followup"
            onClick={() => setFlagWhenDone((v) => !v)}>
            <Flag size={13} fill={flagWhenDone ? "currentColor" : "none"} /> Flag for follow up when done
          </button>
        </div>
        {flagWhenDone && <Hint>Each session this run opens gets the follow-up flag once it is done — not if it failed or stopped on a usage limit. Not carried to “later”.</Hint>}
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
            <div key={run.id} id={`fanout-run-${run.id}`}>
              <Hint>{run.text.length > 90 ? `${run.text.slice(0, 90)}…` : run.text}</Hint>
              {run.followUps?.map((f, i) => (
                <Hint key={i}><CornerDownRight size={11} /> {f.text.length > 90 ? `${f.text.slice(0, 90)}…` : f.text}
                  {f.dirs.length < run.targets.length ? <span className="section-hint"> · {f.dirs.length} of {run.targets.length}</span> : null}
                </Hint>
              ))}
              <div className="list">
                {run.targets.map((t) => (
                  <Row key={t.dir} kind="wrap">
                    <Row as={t.sessionId ? "button" : "div"} kind="grow" onClick={t.sessionId ? () => onOpen(t.sessionId!) : undefined}>
                      <RowTitle>
                        {t.status === "starting" || t.status === "running" ? <Loader size={12} className="spin" /> : null}
                        {t.status === "done" ? <CircleCheck size={12} /> : null}
                        {t.status === "failed" ? <CircleAlert size={12} /> : null}
                        {" "}{t.title} <Tag className={STATUS_TAG[t.status]}>{t.status}</Tag>
                      </RowTitle>
                      <RowSub>{targetSubline(t)}</RowSub>
                    </Row>
                    {/* Picking targets is a SEPARATE control from the row: tapping
                        the row must keep meaning "open that session". */}
                    {picking && (t.sessionId ? (
                      <button className={`row-act ${fuSel.has(t.dir) ? "on" : ""}`}
                        title="include in the follow-up"
                        onClick={() => toggleFu(t.dir)}>
                        {fuSel.has(t.dir) ? <SquareCheck size={16} /> : <Square size={16} />}
                      </button>
                    ) : <CantInline>no session to send to</CantInline>)}
                  </Row>
                ))}
              </div>
              {live.length > 0 && !picking && (
                <div className="form">
                  <Button data-hint="fanout.followup" onClick={() => openFollowUp(run)}>
                    <CornerDownRight size={14} /> follow up in {live.length} session{live.length === 1 ? "" : "s"}
                  </Button>
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
                    <Button onClick={() => setFuSel(new Set(live.map((t) => t.dir)))}>all</Button>
                    <Button onClick={() => setFuSel(new Set())}>none</Button>
                    <Button onClick={() => { setFuRun(null); setFuText(""); }}>cancel</Button>
                    <span className="spacer" />
                    {!fuText.trim() ? <CantInline>write the instruction first</CantInline>
                      : !live.some((t) => fuSel.has(t.dir)) ? <CantInline>pick a session to send to</CantInline>
                      : (
                        <button className="send" onClick={() => sendFollowUp(run)}>
                          <Send size={14} /> send to {live.filter((t) => fuSel.has(t.dir)).length}
                        </button>
                      )}
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </>
      )}
      </div>

      {/* Kickoff progress, pinned above Run: the run's own rows are below the
          whole repo checklist, so without this a tap on Run showed a toast and
          then nothing. Words, never a tap that filters — "show" scrolls to the
          run's full list. */}
      {(kick || (fired && !mine)) && (
        <div className="fanout-kick">
          {kick && shown ? <>
            {kick.waiting + kick.starting > 0 ? <Loader size={14} className="spin" /> : kick.failed ? <CircleAlert size={14} /> : kick.working ? <Loader size={14} className="spin" /> : <CircleCheck size={14} />}
            <span className="grow">{kick.line}</span>
            <button className="link-btn" onClick={() => document.getElementById(`fanout-run-${shown.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              show the {kick.total}
            </button>
            <span className="pull-bar"><span className="pull-bar-fill" style={{ width: `${kick.total ? (100 * kick.kicked) / kick.total : 0}%` }} /></span>
          </> : fired && <>
            <Loader size={14} className="spin" />
            <span className="grow">{kickoffSent(fired.offline, fired.repos)}</span>
          </>}
        </div>
      )}

      {CostHint && <CostHint text={text} />}

      <div className="sheet-actions">
        <span className="spacer" />
        {gate ? <CantInline>{gate}</CantInline> : <Button data-hint="fanout.schedule"
          title="Run it later instead — once tonight, or every week at a time you pick"
          onClick={() => {
            track("action:fanout.schedule");
            save(TEXT_KEY, text);
            onSchedule(chosen.map((r) => r.worktreePath), text.trim(), sweep);
          }}
        ><CalendarClock size={16} /> later</Button>}
        {blocked ? <CantInline>{blocked}</CantInline> : gate ? null : (
        <button className="send" data-hint="fanout.run" onClick={go}
          title={online ? undefined : "no connection — the sweep is queued and runs when the link is back"}>
          <Play size={16} /> {online ? "Run" : "Queue"} in {chosen.length} repo{chosen.length === 1 ? "" : "s"}
        </button>
        )}
      </div>
    </div>
  );
}
