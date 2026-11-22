import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowUpFromLine, Check, CloudDownload, Loader, ShieldCheck, X } from "lucide-react";
import type { GitCommit, GitCommitFile, GitLog, GitShow } from "@waterplane/shared";
import { api } from "./api";
import { track } from "./usage";
import { useRemoteResource } from "./useRemoteResource";
import { SheetHead } from "./Sheet";
import { TITLE } from "./sheetNames";
import { Empty } from "./Empty";
import { ago } from "./format";
import { Button } from "./kit/Button";
import { Row, RowSub, RowTitle } from "./kit/Row";
import { Hint } from "./kit/Hint";
import { useOfflineGate, offlineSentence } from "./kit/offlineGate";
import { linkOnline } from "./link";
import { checksHint, commitVerbs, verdictWords, type CommitVerbs } from "./gitChecks";
import { GitTextDiff, initialDiffMode, type DiffMode } from "./GitTextDiff";
import { useBackStep } from "./backStep";
import { ZoomPair } from "./ZoomPair";
import { gitZoom, nextReaderZoom, readerScale, setGitZoom, textScale } from "./uiScale";

/** Which side the tap came from: the ↑ count opens `out`, the ↓ count `in`. */
export type GitLogFocus = "in" | "out" | "all";

interface Props {
  repoId: string;
  focus: GitLogFocus;
  /** The filter is the tap — clearing it widens this view, never a setting. */
  onFocus: (f: GitLogFocus) => void;
  /** A fetch moved the upstream: the review sheet's counts must be re-read too. */
  onFetched: () => void;
  /** Run the checks on this commit, or push up to it. Both follow on the review sheet, which has the clock. */
  onCheck: (sha: string) => void;
  onPushTo: (sha: string, commits: number) => void;
  onClose: () => void;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

interface RowVerbs { verbs: CommitVerbs; onCheck: (sha: string) => void; onPushTo: (sha: string, commits: number) => void }

/** A file of a commit, opened: whose commit it is rides along for the head. */
interface OpenCommitFile { c: GitCommit; f: GitCommitFile }
type OnOpenFile = (c: GitCommit, f: GitCommitFile) => void;

/** git's status letter as the Changes list's word (and its `gstat g-*` colour). */
function fileWord(status: string): { word: string; cls: string } {
  switch (status) {
    case "A": return { word: "added", cls: "added" };
    case "D": return { word: "deleted", cls: "deleted" };
    case "R": return { word: "renamed", cls: "renamed" };
    case "C": return { word: "copied", cls: "added" };
    default: return { word: "modified", cls: "modified" };
  }
}

function CommitRow({ repoId, c, act, onOpenFile, zoomFont }: { repoId: string; c: GitCommit; act?: RowVerbs; onOpenFile: OnOpenFile; zoomFont: CSSProperties }) {
  const [show, setShow] = useState<GitShow | null>(null);
  const [open, setOpen] = useState(false);
  function toggle() {
    track("action:git.log.show");
    setOpen((o) => !o);
    if (show == null) api.gitShow(repoId, c.sha).then(setShow, (e) => setShow({ body: `Could not read this commit: ${e instanceof Error ? e.message : String(e)}` }));
  }
  return (
    <div className="git-commit">
      <button className="row git-commit-row" onClick={toggle}>
        <span className="git-commit-subject">{c.subject || "(no message)"}</span>
        <RowSub><span className="mono">{c.short}</span> · {c.author} · {ago(c.at)}</RowSub>
        {c.check && (
          <RowSub className={c.check.ok ? "" : "warn"}>
            {c.check.ok ? <Check size={12} /> : <X size={12} />} {verdictWords(c.check, ago(c.check.at))}
          </RowSub>
        )}
      </button>
      {/* A push up to a passed commit is what the list is for, so it shows; Run checks waits for the
          tap that opens the commit, or a long list wears the same button on every row. */}
      {act && ((open && act.verbs.check) || act.verbs.pushes != null) && (
        <div className="sheet-actions git-commit-acts">
          {open && act.verbs.check && (
            <Button onClick={() => act.onCheck(c.sha)} title="run the pre-push checks on exactly this commit — nothing is pushed">
              <ShieldCheck size={14} /> Run checks
            </Button>
          )}
          {act.verbs.pushes != null && (
            <Button onClick={() => act.onPushTo(c.sha, act.verbs.pushes!)} title="push this commit and the older ones; newer commits stay here">
              <ArrowUpFromLine size={14} /> Push up to here ({act.verbs.pushes})
            </Button>
          )}
        </div>
      )}
      {open && <pre className="git-commit-body">{show?.body ?? "reading…"}</pre>}
      {/* Each changed file opens its own diff in this commit. Absent `files` (an older desktop, or
          the list could not be read) draws no list: the stat above still names them. */}
      {open && show?.files && show.files.length > 0 && (
        <div className="git-files git-commit-files" style={zoomFont}>
          {show.files.map((f) => {
            const w = fileWord(f.status);
            return (
              <Row key={f.path} kind="wrap">
                <Row as="button" kind="grow" onClick={() => { track("action:git.log.file"); onOpenFile(c, f); }}>
                  <span className={`gstat g-${w.cls}`}>{w.word}</span>
                  <RowTitle className="mono">{f.from ? `${f.from} → ${f.path}` : f.path}</RowTitle>
                </Row>
              </Row>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Section({ repoId, title, hint, rows, total, none, act, onOpenFile, zoomFont }: {
  repoId: string; title: string; hint: string; rows: GitCommit[]; total: number; none: string; onOpenFile: OnOpenFile; zoomFont: CSSProperties;
  /** The row's verbs, for the list that has any. */
  act?: (c: GitCommit, index: number) => RowVerbs;
}) {
  return (
    <>
      <div className="section">{title} · {total} <span className="section-hint">— {hint}</span></div>
      {rows.length === 0 && <div className="empty">{none}</div>}
      {rows.map((c, i) => <CommitRow key={c.sha} repoId={repoId} c={c} act={act?.(c, i)} onOpenFile={onOpenFile} zoomFont={zoomFont} />)}
      {total > rows.length && <div className="empty">…and {plural(total - rows.length, "older commit")} not drawn here.</div>}
    </>
  );
}

/**
 * The commits behind the review sheet's ↑N ↓M: what a push sends, what a pull
 * brings, and the recent history both sides already have. Opening it fetches
 * once, so "incoming" is as of now — the ↓ on the sheet is only as fresh as
 * the desktop's last fetch, which may be days.
 */
export function GitLogView({ repoId, focus, onFocus, onFetched, onCheck, onPushTo, onClose }: Props) {
  const res = useRemoteResource<GitLog>(`git:log:${repoId}`, () => api.gitLog(repoId), { cache: { shape: 1 } });
  const gate = useOfflineGate();
  const log = res.data;
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const fetchingRef = useRef(false);

  // One file of one commit, opened over the list (Back returns to the list, the commit still open).
  const [openFile, setOpenFile] = useState<OpenCommitFile | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(initialDiffMode);
  useBackStep(openFile !== null, () => setOpenFile(null));
  // A commit never changes, so a cached copy is exact: it is what a re-open shows with the link down.
  const fileRes = useRemoteResource<string>(
    `git:showfile:${repoId}:${openFile?.c.sha ?? ""}:${openFile?.f.path ?? ""}`,
    (signal) => api.gitShowFile(repoId, openFile!.c.sha, openFile!.f.path, openFile!.f.from, signal),
    { enabled: openFile !== null, cache: { shape: 1 } });
  // The Changes screen's text size, shared (one stored value for every git diff).
  const [zoom, setZoomState] = useState(() => gitZoom());
  const txt = textScale();
  const zoomFont = { ["--ui-font" as string]: String(readerScale(txt, zoom)) };
  const applyZoom = (v: number) => { track("action:uiscale.git"); setZoomState(v); setGitZoom(v); };
  const openCommitFile: OnOpenFile = (c, f) => { setDiffMode(initialDiffMode()); setOpenFile({ c, f }); };

  async function fetchRemote() {
    if (fetchingRef.current) return;
    if (!linkOnline()) { setFetchNote(offlineSentence("check the upstream")); return; }
    fetchingRef.current = true;
    setFetching(true); setFetchNote(null);
    try {
      const r = await api.gitFetch(repoId);
      if (!r.ok) setFetchNote(r.error ?? "The fetch failed.");
    } catch (e) {
      setFetchNote(`Could not reach the desktop to fetch: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      fetchingRef.current = false;
      setFetching(false);
      res.reload({ quiet: true });
      onFetched();
    }
  }
  // Once per opening: the list a person came here for is "what is out there".
  useEffect(() => { void fetchRemote(); }, [repoId]); // eslint-disable-line react-hooks/exhaustive-deps -- once per repo opened; `fetchRemote` is a per-render closure

  const up = log?.upstream ?? "the upstream";
  const freshness = fetching
    ? <><Loader size={13} className="spin" /> checking {up} for new commits…</>
    : log?.fetchedAt ? <>Incoming as of the last check of {up}, {ago(log.fetchedAt)}.</>
    : log?.upstream ? <>{up} has never been checked from this worktree.</>
    : null;

  const fileView = openFile && (
      <div className="sheet">
        <SheetHead title={openFile.f.path} brandClass="mono" onClose={() => setOpenFile(null)}>
          <div className="sb-zoom">
            <ZoomPair smaller={nextReaderZoom(zoom, -1, txt)} bigger={nextReaderZoom(zoom, 1, txt)} onZoom={applyZoom}
              smallerHint=" — more of each line on screen" biggerHint=" — fewer characters across" />
          </div>
        </SheetHead>
        <Hint className="git-commit-of">In the commit “{openFile.c.subject || "(no message)"}”</Hint>
        <Empty res={fileRes} empty={fileRes.data == null} thing="this file's change in the commit" noun="change" />
        {fileRes.data != null && (
          <GitTextDiff repoId={repoId} path={openFile.f.path} staged={false} diff={fileRes.data || "(no text change to show)"} zoomFont={zoomFont}
            mode={diffMode} onMode={setDiffMode} commit />
        )}
      </div>
  );

  const total = log ? log.incomingTotal + log.outgoingTotal + log.shared.length : 0;
  const shownN = !log ? 0 : focus === "in" ? log.incomingTotal : focus === "out" ? log.outgoingTotal : total;
  const showIn = focus !== "out";
  const showOut = focus !== "in";
  const showShared = focus === "all";

  // The list stays mounted under an open file (display none, not unmounted: `.sheet` sets display, so the `hidden` attribute would lose): each row's open/read state
  // is its own, and Back must land on the commit that was open.
  return (<>
    {fileView}
    <div className="sheet" style={openFile ? { display: "none" } : undefined}>
      <SheetHead title={<>{TITLE.commits.replace(/ - branch$/, "")} - {log?.branch ?? "…"}</>} onClose={onClose}>
        {res.inflight && log && <Loader size={13} className="spin" aria-label="refreshing" />}
        {log?.upstream && (
          <Button onClick={() => { track("action:git.log.fetch"); void fetchRemote(); }}
            title={`fetch ${log.upstream} — moves no branch and no file`}>
            {fetching ? <Loader size={16} className="spin" /> : <CloudDownload size={16} />} {fetching ? "checking…" : "check"}
          </Button>
        )}
      </SheetHead>
      {log && (
        <div className="git-bar">
          <span className="mono">{log.branch}{log.upstream ? ` → ${log.upstream}` : " (no upstream)"}</span>
          {log.upstream && <span className="git-ab">↑{log.outgoingTotal} ↓{log.incomingTotal}</span>}
        </div>
      )}
      {focus !== "all" && log && (
        <div className="section filter-bar">
          <span className="filter-bar-txt">
            Only the commits {focus === "in" ? `on ${up} and not here` : `here and not on ${up}`} · {shownN} of {total}
          </span>
          <button className="filter-bar-clear" title="show incoming, not pushed and the shared history together"
            onClick={() => { track("action:git.log.filter.clear"); onFocus("all"); }}><X size={13} /> clear</button>
        </div>
      )}
      <div className="list git-log">
        <Empty res={res} empty={!log} thing="this branch's history" noun="history" />
        {freshness && <Hint className="git-log-fresh">{freshness}</Hint>}
        {gate.note}
        {fetchNote && !gate.sentence && <Hint className="git-note">{fetchNote}</Hint>}
        {log && log.upstream && showIn && (
          <Section repoId={repoId} title="Incoming" hint={`on ${up}, not here — a pull brings these`}
            rows={log.incoming} total={log.incomingTotal}
            none={fetching ? "Checking…" : `Nothing on ${up} that is not here.`} onOpenFile={openCommitFile} zoomFont={zoomFont} />
        )}
        {log && log.upstream && showOut && checksHint(log) && <Hint>{checksHint(log)}</Hint>}
        {log && log.upstream && showOut && (
          <Section repoId={repoId} title="Not pushed" hint={`here, not on ${up} — a push sends these`}
            rows={log.outgoing} total={log.outgoingTotal} none="Every commit here is already pushed." onOpenFile={openCommitFile} zoomFont={zoomFont}
            act={(c, i) => ({ verbs: commitVerbs(log, i, c.check), onCheck: gate.guard("run the checks", onCheck), onPushTo: gate.guard("push", onPushTo) })} />
        )}
        {log && showShared && (
          <Section repoId={repoId} title={log.upstream ? "On both" : "History"}
            hint={log.upstream ? "recent, already pushed" : "no upstream — nothing to compare against"}
            rows={log.shared} total={log.shared.length} none="No commits yet." onOpenFile={openCommitFile} zoomFont={zoomFont} />
        )}
      </div>
    </div>
  </>);
}
