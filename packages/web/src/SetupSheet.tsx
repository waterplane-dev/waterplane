/**
 * `Repo readings` — everything this app has measured about one repo, in one
 * sheet, split by the only thing that actually separates the two halves.
 *
 * ── Why the two sheets merged, and where the seam now is ───────────────────
 *
 * There were two screens. The setup checklist asked "is this repo wired the
 * way the app expects", and the repo-health sheet asked "what has this repo
 * been doing to itself". Both are readings about a repo, both are reached from
 * the same repo row, and a person looking for either had to already know which
 * of two menu entries held it — which is precisely the knowledge nobody has
 * before they look.
 *
 * What separates them is not time, and not how they are gathered. It is the
 * COMPARATOR:
 *
 *  - **Against the conventions** (`ComplianceCheck`). A fact about this repo
 *    against a line somebody chose — the `context-weight` threshold, "the
 *    transport dirs are gitignored", "no secret is tracked". A fact can be on
 *    the wrong side of a line, so these rows have a status, a stripe, a place
 *    in the badge, and where the host can write the patch, a `fix`.
 *  - **Against its own past** (the series). A fact about this repo against the
 *    same fact on earlier commits. There is no side to be on — the tool holds
 *    no threshold and no grade on purpose — so these rows have no stripe, no
 *    status colour, and they are never counted into anything.
 *
 * That distinction is the whole design. Region 2 may not grow a fourth status,
 * a coloured band, a red zone or a "getting worse" caption; region 1 may not
 * lose its stripes. Every rule under it follows: the wording of both halves
 * lives in modules their own tests hold to a verdict-word ban
 * (`repoHealthWords.ts`), the geometry is a module that cannot compute a rank
 * (`repoHealthPlot.ts`), and the drawing is SVG with no status hue in it
 * (`RepoHealthTiles.tsx`).
 *
 * ── Two reads, never one state ─────────────────────────────────────────────
 *
 * TWO `useRemoteResource`s, two `Empty`s, two age lines. "The checklist could
 * not be read" and "the series could not be read" are different sentences with
 * different next actions, and a repo whose series is a 200 is not a repo whose
 * conventions are unknown. One `res` for both would have made each region lie
 * about the other exactly half the time. Two write halves for the same reason:
 * a failed `fix` and a refused refresh are different facts.
 *
 * ── The proof the merge is real ────────────────────────────────────────────
 *
 * `context-weight` is the one subject measured BOTH ways, and today the two
 * paths agree on the number while differing in clock: the checklist reads the
 * working tree as it is now, the series reads the last commit measured. So
 * that row keeps its stripe — it has a threshold, and the threshold is
 * argued with right there in `ContextLimits.tsx` — and gains, underneath, the
 * series' own sparkline and the tool's rank sentence. The two figures are
 * printed side by side, each named by its clock, and NOTHING reconciles them:
 * an uncommitted CLAUDE.md edit showing up as a gap between them is exactly
 * what a reader wants to see.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  Activity, AlertTriangle, Check, EyeOff, Lightbulb, ListChecks, RefreshCw, Send, ShieldAlert, ToggleRight, Wrench, X,
} from "lucide-react";
import { isSetupConsider, isSetupFinding, isWatchCheck } from "@waterplane/shared";
import type {
  ComplianceAcceptRequest, ComplianceCheck, ComplianceReport, ComplianceTriageRequest, RepoHealthPlotSeries, RepoHealthView, RepoTarget,
} from "@waterplane/shared";
import { api } from "./api";
import { track } from "./usage";
import { RepoSelect } from "./RepoPicker";
import { useRemoteResource } from "./useRemoteResource";
import { Sheet } from "./Sheet";
import { Empty } from "./Empty";
import { loadPresets, remedyFor, type Preset } from "./presets";
import {
  agentFindings, agentVerb, bulkLabel, bulkNote, findingsCutWords, fixConfirmWords, fixNeedsConfirm, fixTitle, fixVerb, patchFindings, patchIds, remedyPrompt, setupRows,
} from "./setupRemedy";
import { ConfirmButton } from "./Confirm";
import { ContextLimitsEditor } from "./ContextLimits";
import { AskRulesHere } from "./AskRulesHere";
import { SeriesSpark } from "./RepoHealthTiles";
import { SeriesRegion } from "./RepoHealthRegion";
import { OptInRegion } from "./OptInRegion";
import { OPTINS_REGION_WORDS } from "./optInSeed";
import type { SendSeed } from "./sendIntent";
import { CLAUDE_MD_KEY, DESC_KEY } from "./repoHealthPlot";
import { bothClocksWords, rankSentence, regionWords, seriesValueWords } from "./repoHealthWords";
import { core } from "./core/api";
import { Explain } from "./Explain";
import { FilterChip } from "./kit/FilterChip";
import type { CoreApi } from "./sdk/types";
import { showToast } from "./toast";
import { Button } from "./kit/Button";
import { Hint } from "./kit/Hint";
import { AlwaysOnRows, type SessionDoor } from "./AlwaysOnRows";
import { AcceptControl, AcceptedSection, StaleMarksSection, DigestGroup, TriageControl } from "./ExposureAccept";
import {
  WATCH_HEAD_WORDS, WATCH_REGION_WORDS, cutElsewhereWords, exposureCut, exposureMeta, inExposureMainList,
  clearTriageRequest, WATCH_EMPTY_WORDS, WATCH_EMPTY_LINK,
  WATCH_RECHECK_LABEL, WATCH_RECHECK_RUNNING, WATCH_RECHECK_TITLE, watchRecheckFailed,
} from "./exposureWords";

const STATUS_ICON = {
  pass: <Check size={16} color="var(--ok)" />,
  warn: <AlertTriangle size={16} color="var(--warn)" />,
  fail: <X size={16} color="var(--dead)" />,
} as const;

/** `optins` is region 3 (`OptInRegion.tsx`): offers, not readings — counted in nothing.
 *  `watch` is region 4: the checklist rows `isWatchCheck` names (the daily exposure watch and
 *  Scorecard), drawn by the same `SetupRegion` as set-up so a finding looks and acts the same in
 *  both — split off because a convention the repo is wired to and an advisory the world published
 *  about its dependencies are different questions with different owners. */
export type ReadingsRegion = "setup" | "series" | "optins" | "watch";

// `CLAUDE_MD_KEY` / `DESC_KEY` (the weight stack's two series) live in
// `repoHealthPlot.ts`, a leaf both regions read, so region 2 never imports this sheet back.

interface Props {
  repos: RepoTarget[];
  /** Repo to open on, when the sheet was reached from that repo's badge rather
   *  than from the launcher menu — landing on an unrelated repo would make the
   *  badge's one tap into three. */
  initialRepoId?: string;
  /** Which region to open on. The badge and the checklist entry land on
   *  `setup`; the repo-health entry lands on `series`. Both are the same
   *  sheet, so a reader who arrived for one can see the other exists. */
  initialRegion?: ReadingsRegion;
  /**
   * Open region 1 already cut to the open findings.
   *
   * A count on a control is a filter: the repo badge says "3" off
   * `isSetupFinding` and a tap on it must open exactly those three, never the
   * whole checklist for the reader to re-derive them from. The cut then says
   * what it is hiding, `n of N` against the unfiltered list, and carries the
   * only way back out. It is a TAP and not a setting — it lives in state that
   * dies with the sheet. Region 2 is untouched by it and says nothing about
   * it: a finding and a reading are not the same kind of thing, and a filter
   * named for one must not appear to have cut the other.
   */
  focus?: "findings" | "context-weight";
  /**
   * Send a check's remedy prompt, or a series reading's question, at the repo
   * it belongs to.
   *
   * Separate from `fix`, which is a host-side idempotent patch. A check like
   * `context-weight` cannot be patched — which half of a CLAUDE.md is
   * reference is a judgement — so its row offers the PROMPT, through the
   * ordinary send sheet, where the target and the timing stay the user's. A
   * SERIES row offers a different prompt for a different reason: there is no
   * finding at all, so the prompt asks for an explanation and a proposal and
   * explicitly authorises no change. Optional: without it a row still states
   * what it found, it just has no button.
   */
  onRemedy?: (prompt: string, repo: RepoTarget, label: string) => void;
  /** Open a repo file from the readings (the longest-files tape). The caller
   *  owns where Back from that file lands. */
  onOpenFile?: (repoId: string, relPath: string) => void;
  /** Region 3: open the Send sheet on a seed an opt-in built (nothing sent). */
  onSeed?: (seed: SendSeed) => void;
  /** Region 3: open the capture sheet for this repo. */
  onCapture?: (repo: RepoTarget) => void;
  /** The context-weight row's doors: this repo's live sessions, each opening what its own first
   *  request carried. A function because the repo is this sheet's own state. */
  sessionDoorsFor?: (repoId: string) => SessionDoor[];
  /** The context-weight row's door to the all-sessions token screen. */
  onAllSessions?: () => void;
  /** The always-on list's file door, whose Back lands on the checklist (not the series, as
   *  `onOpenFile`'s does). Falls back to `onOpenFile`. */
  onOpenInstructionFile?: (repoId: string, relPath: string) => void;
  onClose: () => void;
}

export function SetupSheet({
  repos, initialRepoId, initialRegion = "setup", focus, onRemedy, onOpenFile, onSeed, onCapture,
  sessionDoorsFor, onAllSessions, onOpenInstructionFile, onClose,
}: Props) {
  const primaryRepos = repos.filter((r) => r.isPrimary);
  // A worktree can be badged too, so the picker (primaries only) may not list
  // the id we were handed — fall back rather than render an empty select.
  const [repoId, setRepoId] = useState(
    initialRepoId && repos.some((r) => r.id === initialRepoId) ? initialRepoId : primaryRepos[0]?.id ?? "");
  const [region, setRegion] = useState<ReadingsRegion>(initialRegion);
  // The cut is the tap, not a setting: it starts where the caller aimed it and
  // is cleared by the bar's own button. Re-aimed when the caller changes its
  // mind (the badge tapped again while the sheet is up).
  const [cut, setCut] = useState(focus === "findings");
  useEffect(() => { setCut(focus === "findings"); }, [focus]);
  useEffect(() => { setRegion(initialRegion); }, [initialRegion]);
  /** The badge counts both checklist regions. Aimed at the findings with none left under set-up but
   *  some under watch, land on watch: a count's tap opens the rows it counted, not an empty cut. */
  const [landed, setLanded] = useState(false);
  useEffect(() => { setLanded(false); }, [focus, initialRegion, repoId]);

  /** The checklist's WRITE half — a fix in flight, and what it said. The read's
   *  own states belong to its hook; mixing the two is how "the checklist could
   *  not be read" and "the fix failed" ended up sharing one `error` string. */
  const [busy, setBusy] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  /** What the last fix said it did, in its own words (`ComplianceFixResult.notes`). A fix whose
   *  effect is elsewhere — a dialog on the desktop's screen, a job in the background — left the
   *  rows exactly as they were, and a tap with no visible answer read as a dead button. */
  const [fixNotes, setFixNotes] = useState<string[]>([]);
  // The user's own list, so an edited preset edits the remedy — and a deleted
  // one removes the button rather than sending words that are no longer theirs.
  const [presets] = useState<Preset[]>(loadPresets);

  // ── the two reads ────────────────────────────────────────────────────────
  //
  // Two hooks, two keys, two states. A checklist that could not be READ is not
  // a repo with no problems; a series that could not be read is not a repo
  // with no history; and neither sentence is the other's.
  const checkRes = useRemoteResource<ComplianceReport>(
    repoId, () => api.compliance(repoId), { enabled: !!repoId });
  // WHICH reading region 2 is showing: the repo, or one subtree of it. It
  // lives here and not in the region because it is part of the resource KEY —
  // a scope switch is a different series, so it reloads rather than re-filters
  // something already on screen.
  const [scope, setScope] = useState<string | null>(null);
  const healthRes = useRemoteResource<RepoHealthView>(
    `repohealth:${repoId}:${scope ?? ""}`, () => api.repoHealth(repoId, scope), { enabled: !!repoId });

  const report = checkRes.data;
  const view = healthRes.data;
  const repo = repos.find((r) => r.id === repoId) ?? null;

  /** Ignore (or stop ignoring) one advisory row here. The host answers with
   *  the re-run report, so the row folds without a second read. */
  async function setIgnored(id: string, ignore: boolean) {
    if (!repoId) return;
    track(ignore ? "action:setup.ignore" : "action:setup.unignore");
    setBusy(true);
    setFixError(null);
    setFixNotes([]);
    try {
      const r = await api.complianceIgnore(repoId, id, ignore);
      if (r.ok && r.report) checkRes.set(r.report);
      else setFixError(r.error || "the desktop did not store it");
    } catch (e) {
      setFixError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  /** Accept (or stop accepting) one exposure finding. Returns the host's refusal as text so the
   *  form keeps what was typed; the re-run report folds the row. */
  async function setAccepted(req: ComplianceAcceptRequest): Promise<string | null> {
    if (!repoId) return "No repo is open, so there is nothing to accept.";
    track(req.accept ? "action:setup.accept" : "action:setup.unaccept");
    setBusy(true);
    setFixError(null);
    try {
      const r = await api.complianceAccept(repoId, req);
      if (r.ok && r.report) { checkRes.set(r.report); return null; }
      return r.error || "the desktop did not store it";
    } catch (e) {
      return String((e as Error).message || e);
    } finally {
      setBusy(false);
    }
  }

  /** Mark (or clear the mark of) one exposure finding; same shape as setAccepted. */
  async function setMark(req: ComplianceTriageRequest): Promise<string | null> {
    if (!repoId) return "No repo is open, so there is nothing to mark.";
    track(req.clear ? "action:setup.unmark" : "action:setup.mark");
    setBusy(true);
    setFixError(null);
    try {
      const r = await api.complianceTriage(repoId, req);
      if (r.ok && r.report) { checkRes.set(r.report); return null; }
      return r.error || "the desktop did not store it";
    } catch (e) {
      return String((e as Error).message || e);
    } finally {
      setBusy(false);
    }
  }

  async function applyFixes(fixes: string[]): Promise<ComplianceReport | null> {
    if (!repoId || !fixes.length) return null;
    track("action:setup.fix");
    setBusy(true);
    setFixError(null);
    try {
      // A confirm-gated fix (its second tap is the consent) goes alone with the token the
      // report it was drawn from carried; the host refuses it without one.
      const confirm = fixes.length === 1 ? report?.confirm?.[fixes[0]] : undefined;
      const r = await api.complianceFix(repoId, fixes, confirm);
      // The fix returns the re-run report, so the list updates without a second
      // round trip. `set` deliberately does not touch the resource's state:
      // what is on screen is exactly as fresh as it was a moment ago.
      if (r.ok) setFixNotes(r.notes ?? []);
      if (r.ok && r.report) { checkRes.set(r.report); return r.report; }
      if (!r.ok) setFixError(r.error || "fix failed");
    } catch (e) {
      setFixError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
    return null;
  }

  // The checklist read is ONE report; `set-up` and `watch` are two cuts of it by `isWatchCheck`,
  // and every count, list and bulk button below is the cut's — never the whole report's.
  const allChecks = report?.checks ?? [];
  const watchChecks = allChecks.filter(isWatchCheck);
  const setupChecks = allChecks.filter((c) => !isWatchCheck(c));
  const checks = region === "watch" ? watchChecks : setupChecks;
  /** The badge's findings that are NOT in the region on screen — said on the cut, with a way there. */
  const otherFindings = (region === "watch" ? setupChecks : watchChecks).filter(isSetupFinding).length;
  // Two kinds of open finding, and the difference is not cosmetic: one is an
  // idempotent patch the host writes, the other is work. `Fix all` used to mean
  // only the first, so a repo whose findings were all of the second kind showed
  // a checklist with no button anywhere on it.
  const patchable = patchFindings(checks);
  const forAgent = agentFindings(checks);
  const canAsk = !!onRemedy && !!repo;
  const bulkCount = patchable.length + (canAsk ? forAgent.length : 0);
  const findings = checks.filter(isSetupFinding);
  const rows = cut ? findings : checks;

  /**
   * One tap for everything open: patch what the host can patch, then hand what
   * is LEFT to the agent — read off the re-run report the fix returns, not off
   * the list as it was before, so nothing is described to the agent as broken
   * after it has just been fixed. A failed patch stops there: `fixError` is on
   * screen and composing a prompt on top of it would bury it.
   */
  async function fixEverything() {
    if (!repo) return;
    let now = report;
    if (patchable.length) {
      const fresh = await applyFixes(patchIds(checks));
      if (!fresh) return;
      now = fresh;
    }
    const rest = now ? agentFindings(now.checks.filter((c) => isWatchCheck(c) === (region === "watch"))) : [];
    if (rest.length && onRemedy) {
      onRemedy(remedyPrompt(rest, repo.repoName, setupRows()), repo,
        rest.length === 1 ? rest[0].label.toLowerCase() : `${rest.length} setup findings`);
    }
  }

  useEffect(() => {
    if (landed || !report || !cut || region !== "setup") return;
    setLanded(true);
    if (!setupChecks.some(isSetupFinding) && watchChecks.some(isSetupFinding)) setRegion("watch");
  }, [landed, report, cut, region, setupChecks, watchChecks]);

  // `focus: "context-weight"` (the context sheet's door): bring that row into view once it is drawn.
  useEffect(() => {
    if (focus !== "context-weight" || !report || region !== "setup") return;
    document.querySelector('[data-check="context-weight"]')?.scrollIntoView({ block: "start" });
  }, [focus, report, region, repoId]);

  const plot = view?.plot ?? null;
  const claudeMdSeries = plot?.series.find((s) => s.key === CLAUDE_MD_KEY) ?? null;

  return (
    <Sheet
      className="readings-sheet"
      title="Repo readings"
      icon={<Activity size={18} />}
      onClose={onClose}
    >
      <div className="sheet-scroll">
        <div className="form">
          {/* The shared picker (`RepoPicker.tsx`), keyed by worktreePath like
              every other one — the id round-trip is local to this sheet, which
              talks to both APIs in repo ids. Above the region switch, because
              it changes what BOTH regions are about. */}
          {/* Primaries only, no worktree toggle: a worktree's readings are its
              repo's first-parent history again. The current value stays listed
              (`RepoSelect` keeps it) when the sheet was opened on a worktree. */}
          <RepoSelect
            repos={repos.filter((r) => r.isPrimary || r.id === repoId)}
            value={repos.find((r) => r.id === repoId)?.worktreePath ?? ""}
            onChange={(dir) => { const r = repos.find((x) => x.worktreePath === dir); if (r) setRepoId(r.id); }}
            aria-label="repo"
          />

          {/* A body-changing choice: a labelled row of chips, directly above
              the first thing it changes (`ContextSheet.tsx`'s grammar, written
              above both its returns). The kit's FilterChips, like the repo-health
              scope row right under it: a solid `.key.active` here stacked two
              chip styles on one screen. One of the two is always lit, so no ×. */}
          <div className="ts-filter" role="group" aria-label="reading">
            <span className="ctx-stackpick-lab">reading</span>
            {/* Back to the repo's own reading with the region. The checklist
                half reads `claudeMdSeries` off the same plot, and a subtree's
                CLAUDE.md series is a different claim about a different file —
                so the scope is dropped rather than left to leak into a region
                that has no picker to say it is on. */}
            <FilterChip on={region === "setup"} clears={false}
              onClick={() => { setRegion("setup"); setScope(null); }}>
              <ListChecks size={14} /> set-up
            </FilterChip>
            <FilterChip on={region === "series"} clears={false} onClick={() => setRegion("series")}>
              <Activity size={14} /> over time
            </FilterChip>
            <FilterChip on={region === "watch"} clears={false}
              onClick={() => { setRegion("watch"); setScope(null); }}>
              <ShieldAlert size={14} /> watch
            </FilterChip>
            <FilterChip on={region === "optins"} clears={false}
              onClick={() => { setRegion("optins"); setScope(null); }}>
              <ToggleRight size={14} /> opt-ins
            </FilterChip>
            <Explain of="what this region compares">{region === "optins" ? OPTINS_REGION_WORDS
              : region === "watch" ? WATCH_REGION_WORDS : regionWords(region)}</Explain>
          </div>

          {region === "setup" || region === "watch" ? (<>
            <SetupRegion
              kind={region}
              elsewhere={cut ? otherFindings : 0}
              onElsewhere={() => setRegion(region === "watch" ? "setup" : "watch")}
              onOptIns={() => { setRegion("optins"); setScope(null); }}
              repoId={repoId}
              repo={repo}
              res={checkRes}
              report={report}
              rows={rows}
              allRows={checks}
              cut={cut}
              onClearCut={() => setCut(false)}
              busy={busy}
              fixError={fixError}
              fixNotes={fixNotes}
              presets={presets}
              canAsk={canAsk}
              bulkCount={bulkCount}
              patchable={patchable.length}
              forAgent={forAgent.length}
              onFix={applyFixes}
              onIgnore={setIgnored}
              onAccept={setAccepted}
              onMark={setMark}
              onFixAll={() => void fixEverything()}
              onRemedy={onRemedy}
              claudeMdSeries={claudeMdSeries}
              descSeries={plot?.series.find((s) => s.key === DESC_KEY) ?? null}
              onOpenFile={onOpenInstructionFile ?? onOpenFile}
              sessionDoors={sessionDoorsFor?.(repoId)}
              onAllSessions={onAllSessions}
            />
            {/* Not a check — a choice about this repo, kept beside the checklist
                because this is the screen a repo's own settings are on. */}
            {repo && region === "setup" && <AskRulesHere repo={repo} say={showToast} />}
          </>) : region === "optins" ? (
            <OptInRegion repo={repo} onSeed={onSeed} onCapture={onCapture}
              onSeries={() => setRegion("series")} onChecklist={(r) => checkRes.set(r)} />
          ) : (
            <SeriesRegion
              repo={repo}
              res={healthRes}
              view={view}
              onRemedy={onRemedy}
              scope={scope}
              onScope={setScope}
              onOpenFile={onOpenFile}
            />
          )}
        </div>
      </div>
    </Sheet>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Region 1 — against the conventions.
// ───────────────────────────────────────────────────────────────────────────

function SetupRegion({
  kind, elsewhere, onElsewhere, onOptIns, repoId, repo, res, report, rows, allRows, cut, onClearCut, busy, fixError, fixNotes, presets, canAsk,
  bulkCount, patchable, forAgent, onFix, onIgnore, onAccept, onMark, onFixAll, onRemedy, claudeMdSeries, descSeries,
  onOpenFile, sessionDoors, onAllSessions,
}: {
  /** Which cut of the checklist this is: the conventions, or the daily watch (`isWatchCheck`). */
  kind: "setup" | "watch";
  /** Under the findings cut: how many of the badge's findings live in the OTHER region (0 = none / no cut). */
  elsewhere: number;
  onElsewhere: () => void;
  /** The empty watch region's door to the opt-ins region, where the watch is switched on. */
  onOptIns: () => void;
  repoId: string;
  repo: RepoTarget | null;
  res: ReturnType<typeof useRemoteResource<ComplianceReport>>;
  report: ComplianceReport | null;
  rows: ComplianceCheck[];
  allRows: ComplianceCheck[];
  cut: boolean;
  onClearCut: () => void;
  busy: boolean;
  fixError: string | null;
  fixNotes: string[];
  presets: Preset[];
  canAsk: boolean;
  bulkCount: number;
  patchable: number;
  forAgent: number;
  onFix: (f: string[]) => Promise<ComplianceReport | null>;
  /** Ignore / stop ignoring an advisory row in this repo. */
  onIgnore: (id: string, ignore: boolean) => void;
  /** Accept / stop accepting an exposure finding; resolves to a refusal sentence or null. */
  onAccept: (req: ComplianceAcceptRequest) => Promise<string | null>;
  /** Mark / clear the mark of an exposure finding; resolves to a refusal sentence or null. */
  onMark: (req: ComplianceTriageRequest) => Promise<string | null>;
  onFixAll: () => void;
  onRemedy?: (prompt: string, repo: RepoTarget, label: string) => void;
  /** The series' own reading of the two halves of the always-on weight, when
   *  there is one. Region 1 draws it on exactly one row and nowhere else. */
  claudeMdSeries: RepoHealthPlotSeries | null;
  descSeries: RepoHealthPlotSeries | null;
  /** The always-on list under the context-weight row (`AlwaysOnRows`): its file door and session doors. */
  onOpenFile?: (repoId: string, relPath: string) => void;
  sessionDoors?: SessionDoor[];
  onAllSessions?: () => void;
}) {
  // The watch re-check's run and its one sentence, for the repo it ran on (a switch hides it).
  const [watchRunAt, setWatchRun] = useState<{ repoId: string; running: boolean; ok?: boolean; sentence?: string } | null>(null);
  const watchRun = watchRunAt?.repoId === repoId ? watchRunAt : null;
  // What the context-weight row's figure is made of, file by file, plus this desktop's rows and
  // the doors to what a live session actually carried. Absent `instructions` (an older host) is
  // said by the component, never drawn as an empty list.
  const aoRows = report
    ? <AlwaysOnRows doc={report.instructions} repoId={repoId} onOpenFile={onOpenFile}
        sessionDoors={sessionDoors} onAllSessions={onAllSessions} />
    : null;
  function card(c: ComplianceCheck) {
    if (!report) return null;
    // Per row, the same two answers as the bulk button. A preset is
    // preferred where one exists — it is the user's own words, and
    // editing the preset edits the remedy — but its ABSENCE no
    // longer means the row has nothing to offer: an open finding
    // with no host patch gets the prompt built from its own words.
    // A thing to CONSIDER keeps its remedy: it is a suggestion you
    // can take, it is only never counted.
    const open = (isSetupFinding(c) || isSetupConsider(c)) && !c.fix;
    const rem = open && canAsk ? remedyFor(c.id, presets) : null;
    const ask = open && canAsk && repo
      ? rem
        ? { label: rem.title, run: () => onRemedy!(rem.text, repo, rem.title) }
        : setupRows().byCheck(c.id)?.agent
      ? { label: agentVerb(c.id, setupRows()), run: () => runRowAgent(setupRows().byCheck(c.id)!.agent!, repo, c.label) }
      : { label: agentVerb(c.id, setupRows()), run: () => onRemedy!(remedyPrompt([c], repo.repoName, setupRows()), repo, c.label.toLowerCase()) }
      : null;
    // The one row whose finding is a COMPARISON: it quotes a
    // threshold, so it is the only place that threshold can be
    // argued with. Everything else here is a fact about the repo.
    const limits = c.id === "context-weight" && report.contextLimits
      ? <ContextLimitsEditor repoId={repoId} view={report.contextLimits}
          setAt={report.contextLimitsSetAt} onReport={(r) => res.set(r)} />
      : null;
    const twin = c.id === "context-weight"
      ? <WeightTwin claudeMd={claudeMdSeries} desc={descSeries} workingTree={c.alwaysOnChars ?? null} />
      : null;
    // An exposure finding: the line it crossed and where it was read, then Accept….
    const xp = c.exposure
      ? <>
          <div className="check-detail check-detail-quiet">{exposureMeta(c.exposure)}</div>
          <AcceptControl check={c} onAccept={onAccept} />
          <TriageControl check={c} onMark={onMark} />
        </>
      : null;
    return <Row key={c.id} c={c} busy={busy} onFix={onFix} remedy={ask}
      size={report.autoCompactDefault} onIgnore={onIgnore}
      extra={<>{twin}{c.id === "context-weight" ? aoRows : null}{limits}{xp}</>} />;
  }
  // The watch's re-check RUNS the collector on the desktop (host `exposurerun.ts`), then re-reads.
  async function onWatchRun() {
    if (watchRun?.running) return;
    const forRepo = repoId;
    setWatchRun({ repoId: forRepo, running: true });
    let r: { ok: boolean; sentence: string };
    try {
      const a = await api.exposureRun(forRepo);
      r = { ok: !!a?.ok, sentence: typeof a?.sentence === "string" && a.sentence ? a.sentence : watchRecheckFailed("the desktop gave no answer.") };
    } catch (e) { r = { ok: false, sentence: watchRecheckFailed((e as Error).message || "no link to the desktop.") }; }
    res.reload({ quiet: true });
    setWatchRun({ repoId: forRepo, running: false, ...r });
  }
  const xcut = exposureCut(allRows);
  const hasAlwaysOn = !!(report?.instructions?.files.length || report?.instructions?.desktop?.length);

  return (
    <>
      <div className="section-head">
        <span className="section section-hint">
          {kind === "watch" ? WATCH_HEAD_WORDS : <>
            Checks a repo follows the conventions: CLAUDE.md tells the agent to use the outbox,
            inbox/outbox are gitignored and secrets aren&apos;t committed. Re-run regularly.
          </>}
        </span>
        <Button onClick={kind === "watch" ? onWatchRun : () => res.reload({ quiet: true })} title={kind === "watch" ? WATCH_RECHECK_TITLE : "re-check"}>
          <RefreshCw size={14} className={res.inflight || watchRun?.running ? "spin" : undefined} /> {kind === "watch" ? WATCH_RECHECK_LABEL : "re-check"}
        </Button>
      </div>
      {kind === "watch" && watchRun?.running && <Hint>{WATCH_RECHECK_RUNNING}</Hint>}
      {kind === "watch" && watchRun?.sentence && <Hint tone={watchRun.ok ? undefined : "warn"}>{watchRun.sentence}</Hint>}

      {/* The checklist's OWN four nothings — and only one of them means "this
          repo is fine". `empty` is passed explicitly so the cached-age line can
          stand above a list that DOES have rows. */}
      <Empty res={res} empty={!report} thing="the setup checklist" noun="checklist">
        Nothing in this checklist applies to this repo yet.
      </Empty>
      {report && kind === "watch" && !allRows.length && (
        <Hint>{WATCH_EMPTY_WORDS} <button className="link-btn" onClick={onOptIns}>{WATCH_EMPTY_LINK}</button></Hint>
      )}
      {fixError && <Hint style={{ color: "var(--dead)" }}>Fix failed: {fixError}</Hint>}
      {fixNotes.map((n, i) => <Hint key={i}>{n}</Hint>)}

      {report && (
        <>
          {bulkCount > 0 && (
            <>
              <button className="send" onClick={onFixAll} disabled={busy}>
                <Wrench size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                {busy ? "Fixing…" : bulkLabel(patchable, canAsk ? forAgent : 0)}
              </button>
              {/* Only when one tap is about to do two different things — a
                  button that patches two files needs no footnote. */}
              {canAsk && repo && bulkNote(patchable, forAgent, repo.repoName) && (
                <Hint>{bulkNote(patchable, forAgent, repo.repoName)}</Hint>
              )}
            </>
          )}

          {/* What the cut is hiding, against the UNFILTERED list, with the only
              way out of it. Keyed on the cut and not on emptiness: a filter
              matching nothing must still say it is a filter. */}
          {cut && (
            <div className="section filter-bar">
              <span className="filter-bar-txt">
                {findingsCutWords(rows.length, allRows.length)}
                {elsewhere > 0 && <> · <button className="link-btn" onClick={onElsewhere}>
                  {cutElsewhereWords(elsewhere, kind === "watch" ? "setup" : "watch")}</button></>}
              </span>
              <button className="filter-bar-clear" onClick={onClearCut}>
                <X size={14} /> clear
              </button>
            </div>
          )}

          <ul className="check-list">
            {rows.filter((c) => !c.ignored && inExposureMainList(c)).map(card)}
          </ul>

          {/* Digest rows count in nothing and ciqkit has dozens: ONE closed head, the same cards inside.
              Not under the findings cut — a digest row is not a finding. */}
          {!cut && <DigestGroup n={xcut.digest.length}>{xcut.digest.map(card)}</DigestGroup>}

          {/* What the person said to leave alone here — still measured, so
              "stop ignoring" unfolds a row that says what it says today. Not
              under the findings cut: an ignored row is not a finding. */}
          {!cut && allRows.some((c) => c.ignored) && (
            <>
              <div className="section">Ignored in this repo</div>
              <ul className="check-list">
                {allRows.filter((c) => c.ignored).map((c) => (
                  <li key={c.id} className="check-row check-ignored">
                    <div className="check-top">
                      <span className="check-icon"><EyeOff size={16} color="var(--dim)" /></span>
                      <span className="check-label">{c.label}</span>
                      <Button onClick={() => onIgnore(c.id, false)}>
                        stop ignoring
                      </Button>
                    </div>
                    <div className="check-detail check-detail-quiet">
                      {c.status === "pass" ? "Fine here now." : "Still on the far side of its line — not counted, not suggested."}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Accepted exposure findings stay visible with their reason, never hidden; like Ignored,
              not under the findings cut (an accepted row is not a finding). */}
          {!cut && <AcceptedSection rows={xcut.accepted} now={Date.now()}
            onStop={(id) => void onAccept({ id, accept: false }).then((err) => { if (err) showToast(err); })}
            onClearMark={(id) => void onMark(clearTriageRequest(id)).then((err) => { if (err) showToast(err); })} />}
          {!cut && <StaleMarksSection marks={xcut.summary?.staleMarks ?? []}
            onClear={(id) => void onMark(clearTriageRequest(id)).then((err) => { if (err) showToast(err); })} />}

          {/* A repo with no CLAUDE.md has nothing to weigh and therefore no
              row — but it will be measured against this line the moment it
              gets one, and this sheet is the only place that line is visible.
              So the control survives the row's absence rather than appearing
              out of nowhere later. Drawn under the cut as well: the line is
              not a finding, so hiding it with the passing rows would remove a
              control that has nothing to do with the filter. */}
          {kind === "setup" && (report.contextLimits || hasAlwaysOn) && !allRows.some((c) => c.id === "context-weight") && (
            <div className="check-row check-pass">
              <div className="check-top"><span className="check-label">Agent context weight</span></div>
              <div className="check-detail">
                Nothing to weigh yet — this repo has no CLAUDE.md.
                {report.contextLimits ? " These are the thresholds it will be measured against once it does." : ""}
              </div>
              {/* No CLAUDE.md is not no always-on context: a `.mcp.json` server, a subagent or
                  this desktop's own files still ride every turn, so their list is drawn here too. */}
              {hasAlwaysOn && aoRows}
              {report.contextLimits && <ContextLimitsEditor repoId={repoId} view={report.contextLimits}
                setAt={report.contextLimitsSetAt} onReport={(r) => res.set(r)} />}
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * The one row that is measured BOTH ways, showing both.
 *
 * The check above states the working tree as it is now and compares it to a
 * line the user can change. This adds the same quantity as the series read it
 * on the last commit measured: the two halves' sparklines, the total at that
 * commit, and the tool's own rank sentence. The two numbers are printed by
 * their CLOCK and reconciled by nothing — see this file's header.
 *
 * Absent, not zeroed, wherever the series has nothing: a row that silently
 * loses its second half is a row that reads as having only ever had one.
 */
function WeightTwin({ claudeMd, desc, workingTree }: {
  claudeMd: RepoHealthPlotSeries | null;
  desc: RepoHealthPlotSeries | null;
  /**
   * The check's own figure for the WORKING TREE, now carried on the wire
   * rather than stated only inside its sentence. With it, the line names both
   * clocks and both numbers; without it (an older desktop) it says where the
   * other figure is instead. Never reconciled — a gap between them IS the
   * reading, because it means CLAUDE.md or a skill has been edited since the
   * last commit the series measured.
   */
  workingTree: number | null;
}) {
  if (!claudeMd && !desc) return null;
  const at = claudeMd?.points[claudeMd.points.length - 1]?.sha7
    ?? desc?.points[desc.points.length - 1]?.sha7 ?? null;
  const total = claudeMd?.last != null && desc?.last != null ? claudeMd.last + desc.last : null;
  const both = bothClocksWords(workingTree, total, at);
  return (
    <div className="rh-twin">
      {both ? <div className="rh-twin-line">{both}</div> : null}
      <ul className="rh-twin-rows">
        {[claudeMd, desc].filter(Boolean).map((s) => (
          <li key={s!.key}>
            <span className="rh-twin-key">{s!.label}</span>
            <span className="rh-twin-val">{seriesValueWords(s!.last, s!.unit)}</span>
            {/* A fixed width here on purpose: this miniature sits inside a
                checklist row, which has no measured box of its own, and it is
                a second look at a number the row already states rather than a
                chart anybody reads a value off. The full-size curve is the
                tile in the other region. */}
            <SeriesSpark points={s!.points} width={96} height={18} label={s!.label} />
          </li>
        ))}
      </ul>
      {rankSentence(claudeMd?.reading ?? desc?.reading) ? (
        <div className="rh-twin-read">{rankSentence(claudeMd?.reading ?? desc?.reading)}</div>
      ) : null}
    </div>
  );
}

/** An extension row's own hand-to-agent path (`SetupRowDef.agent`); a throw is a toast, never a dead tap. */
function runRowAgent(agent: (repo: RepoTarget, core: CoreApi) => void, repo: RepoTarget, label: string) {
  try { agent(repo, core()); } catch (e) { showToast(`${label} could not start: ${e instanceof Error ? e.message : String(e)}`); }
}

function Row({ c, busy, onFix, onIgnore, size, remedy, extra }: {
  c: ComplianceCheck;
  busy: boolean;
  onFix: (f: string[]) => unknown;
  onIgnore: (id: string, ignore: boolean) => void;
  /** The auto-compact window this desktop's fix writes. */
  size?: string;
  /** A prompt that answers this finding. Not a `fix` — see `onRemedy`. */
  remedy: { label: string; run: () => void } | null;
  /** Row-specific controls, under the sentence. Today: the context-weight
   *  thresholds, and that row's twin from the series. */
  extra?: ReactNode;
}) {
  // A thing to consider, not a finding: its own icon and stripe, and a word
  // saying so, because amber beside the badge's findings read as one of them.
  const consider = isSetupConsider(c);
  return (
    <li className={`check-row check-${consider ? "consider" : c.status}`} data-check={c.id}>
      <div className="check-top">
        <span className="check-icon">{consider ? <Lightbulb size={16} color="var(--accent)" /> : STATUS_ICON[c.status]}</span>
        <span className="check-label">{c.label}{consider && <span className="check-kind"> · consider</span>}</span>
        {c.fix && !fixNeedsConfirm(c.fix) && (
          <Button onClick={() => onFix([c.fix!])} disabled={busy}>
            <Wrench size={12} /> {fixVerb(c.fix, size, setupRows())}
          </Button>
        )}
      </div>
      <div className="check-detail">{c.detail}</div>
      {/* A short verb on the button, its full effect as TEXT: a title is invisible on a phone. */}
      {c.fix && !fixNeedsConfirm(c.fix) && fixTitle(c.fix) && <Hint>{fixTitle(c.fix)}</Hint>}
      {consider && !c.exposure && (
        <div className="check-acts check-acts-split">
          <Hint as="span">Not counted in the badge. Leaving it is a fine answer.</Hint>
          <Button onClick={() => onIgnore(c.id, true)}>
            <EyeOff size={12} /> ignore in this repo
          </Button>
        </div>
      )}
      {/* A fix that CHOOSES a setting (auto-compact's 400k) rather than
          repairing a convention: two taps, the armed label saying exactly what
          the second one writes, and never part of "Fix all". Under the
          sentence, because its label is a whole clause. */}
      {c.fix && fixNeedsConfirm(c.fix) && (
        <div className="check-acts">
          <ConfirmButton confirm={<><Wrench size={12} /> {fixConfirmWords(c.fix, size)}</>}
            disabled={busy} onConfirm={() => void onFix([c.fix!])}>
            <Wrench size={12} /> {fixVerb(c.fix, size, setupRows())}
          </ConfirmButton>
        </div>
      )}
      {/* Under the sentence, not beside the label: this one is not a one-tap
          patch, it opens a prompt you are going to read before sending — so it
          reads as the next step of the paragraph rather than as a second `fix`
          with a different meaning. */}
      {remedy && (
        <div className="check-acts">
          <Button onClick={remedy.run}>
            <Send size={12} /> {remedy.label}…
          </Button>
        </div>
      )}
      {extra}
    </li>
  );
}
