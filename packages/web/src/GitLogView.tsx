import { useEffect, useRef, useState } from "react";
import { ArrowUpFromLine, Check, CloudDownload, Loader, ShieldCheck, X } from "lucide-react";
import type { GitCommit, GitLog } from "@waterplane/shared";
import { api } from "./api";
import { track } from "./usage";
import { useRemoteResource } from "./useRemoteResource";
import { SheetHead } from "./Sheet";
import { Empty } from "./Empty";
import { ago } from "./format";
import { Button } from "./kit/Button";
import { RowSub } from "./kit/Row";
import { Hint } from "./kit/Hint";
import { checksHint, commitVerbs, verdictWords, type CommitVerbs } from "./gitChecks";

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

function CommitRow({ repoId, c, act }: { repoId: string; c: GitCommit; act?: RowVerbs }) {
  const [body, setBody] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  function toggle() {
    track("action:git.log.show");
    setOpen((o) => !o);
    if (body == null) api.gitShow(repoId, c.sha).then(setBody, (e) => setBody(`Could not read this commit: ${e instanceof Error ? e.message : String(e)}`));
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
      {open && <pre className="git-commit-body">{body ?? "reading…"}</pre>}
    </div>
  );
}

function Section({ repoId, title, hint, rows, total, none, act }: {
  repoId: string; title: string; hint: string; rows: GitCommit[]; total: number; none: string;
  /** The row's verbs, for the list that has any. */
  act?: (c: GitCommit, index: number) => RowVerbs;
}) {
  return (
    <>
      <div className="section">{title} · {total} <span className="section-hint">— {hint}</span></div>
      {rows.length === 0 && <div className="empty">{none}</div>}
      {rows.map((c, i) => <CommitRow key={c.sha} repoId={repoId} c={c} act={act?.(c, i)} />)}
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
  const res = useRemoteResource<GitLog>(`gitlog:${repoId}`, () => api.gitLog(repoId));
  const log = res.data;
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const fetchingRef = useRef(false);

  async function fetchRemote() {
    if (fetchingRef.current) return;
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

  const total = log ? log.incomingTotal + log.outgoingTotal + log.shared.length : 0;
  const shownN = !log ? 0 : focus === "in" ? log.incomingTotal : focus === "out" ? log.outgoingTotal : total;
  const showIn = focus !== "out";
  const showOut = focus !== "in";
  const showShared = focus === "all";

  return (
    <div className="sheet">
      <SheetHead title={<>History · {log?.branch ?? "…"}</>} onClose={onClose}>
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
        {fetchNote && <Hint className="git-note">{fetchNote}</Hint>}
        {log && log.upstream && showIn && (
          <Section repoId={repoId} title="Incoming" hint={`on ${up}, not here — a pull brings these`}
            rows={log.incoming} total={log.incomingTotal}
            none={fetching ? "Checking…" : `Nothing on ${up} that is not here.`} />
        )}
        {log && log.upstream && showOut && checksHint(log) && <Hint>{checksHint(log)}</Hint>}
        {log && log.upstream && showOut && (
          <Section repoId={repoId} title="Not pushed" hint={`here, not on ${up} — a push sends these`}
            rows={log.outgoing} total={log.outgoingTotal} none="Every commit here is already pushed."
            act={(c, i) => ({ verbs: commitVerbs(log, i, c.check), onCheck, onPushTo })} />
        )}
        {log && showShared && (
          <Section repoId={repoId} title={log.upstream ? "On both" : "History"}
            hint={log.upstream ? "recent, already pushed" : "no upstream — nothing to compare against"}
            rows={log.shared} total={log.shared.length} none="No commits yet." />
        )}
      </div>
    </div>
  );
}
