import { useEffect, useRef, useState } from "react";
import { CloudDownload, Loader, X } from "lucide-react";
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

/** Which side the tap came from: the ↑ count opens `out`, the ↓ count `in`. */
export type GitLogFocus = "in" | "out" | "all";

interface Props {
  repoId: string;
  focus: GitLogFocus;
  /** The filter is the tap — clearing it widens this view, never a setting. */
  onFocus: (f: GitLogFocus) => void;
  /** A fetch moved the upstream: the review sheet's counts must be re-read too. */
  onFetched: () => void;
  onClose: () => void;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function CommitRow({ repoId, c }: { repoId: string; c: GitCommit }) {
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
      </button>
      {open && <pre className="git-commit-body">{body ?? "reading…"}</pre>}
    </div>
  );
}

function Section({ repoId, title, hint, rows, total, none }: {
  repoId: string; title: string; hint: string; rows: GitCommit[]; total: number; none: string;
}) {
  return (
    <>
      <div className="section">{title} · {total} <span className="section-hint">— {hint}</span></div>
      {rows.length === 0 && <div className="empty">{none}</div>}
      {rows.map((c) => <CommitRow key={c.sha} repoId={repoId} c={c} />)}
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
export function GitLogView({ repoId, focus, onFocus, onFetched, onClose }: Props) {
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
        {log && log.upstream && showOut && (
          <Section repoId={repoId} title="Not pushed" hint={`here, not on ${up} — a push sends these`}
            rows={log.outgoing} total={log.outgoingTotal} none="Every commit here is already pushed." />
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
