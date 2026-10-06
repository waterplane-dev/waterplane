import { useEffect, useMemo, useState } from "react";
import { Archive, GitBranch, RotateCw, Search, Trash2, X } from "lucide-react";
import type { ArchivedConversation, ArchiveListing, RepoTarget } from "@waterplane/shared";
import { api } from "./api";
import { ago, fmtSize } from "./format";
import { RepoSelect } from "./RepoPicker";
import { useRemoteResource, ConfirmButton, Empty, SearchBox, StaleHead } from "./kit";

const ICON = 16;

interface Props {
  repos: RepoTarget[];
  /** Repo the sheet opens on — the focused one, or the row that opened it. */
  initialRepoId: string;
  /** Conversation ids that are already open as live sessions: their rows say so
   *  and resume in place rather than offering a second copy of the same chat. */
  liveIds: Set<string>;
  onClose: () => void;
  /** Resume one conversation: `claude --resume <id>` in its own worktree. */
  onResume: (cwd: string, title: string, conversationId: string) => void;
  /**
   * Open a COPY of one conversation — `--resume <id> --fork-session`, which
   * mints a new id and leaves the original file exactly as it is.
   *
   * The row next to it is the only irreversible act in this app, and the two
   * verbs it sits between are "resume this" and "delete this for good". Forking
   * is the third thing you want from an old conversation and had no route at
   * all: it is how you carry a week-old chat's context into a new direction
   * without writing over the account of what actually happened. Optional — the
   * button is not drawn without it.
   */
  onFork?: (cwd: string, title: string, conversationId: string) => void;
  /** Jump to a conversation that is already open. */
  onOpenLive: (conversationId: string) => void;
  /**
   * One line saying that resuming from here launches Claude Code, whatever the
   * launcher currently defaults to.
   *
   * Passed only when this desktop can launch something else — a fact this
   * sheet cannot know and should not have to. With one backend the sentence is
   * noise; with two it is the difference between "resume this conversation"
   * and a new session opened with somebody else's session id on its command
   * line. The archive lists claude's own logs and nothing else: a backend that
   * keeps its sessions in a global database has nothing to list here at all,
   * which is why this is a NOTE and not a filter.
   */
  backendNote?: string;
  showToast: (msg: string) => void;
}

/**
 * **Every conversation this repo ever had.**
 *
 * Closing a session was never a delete — the PTY dies and the conversation log
 * stays on disk, resumable with `--resume`. What was missing is the route back:
 * "Recently closed" and "Resume recent" are capped shortlists, and one bulk
 * close of a busy repo retires more sessions than either can hold. Everything
 * past their edge was still there and unreachable from the phone.
 *
 * This lists the logs themselves, so there is no bookkeeping to fall out of sync
 * and nothing a host restart can lose. A row is titled by its first prompt —
 * which is how you actually recognise a conversation weeks later — and resuming
 * one is the same op the launcher's resume rows use.
 *
 * Deleting is deliberately awkward (a second tap, per row): it is the ONLY way
 * to lose a conversation in this app, and it is not what the × on a session row
 * does.
 */
export function ArchiveSheet({ repos, initialRepoId, liveIds, onClose, onResume, onFork, onOpenLive, showToast, backendNote }: Props) {
  const [repoId, setRepoId] = useState(initialRepoId);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");

  const repo = useMemo(() => repos.find((r) => r.id === repoId) ?? repos[0], [repos, repoId]);

  /**
   * The FIRST page, told honestly (`useRemoteResource`).
   *
   * Paging stays hand-rolled beside it, because the two are different questions:
   * "what is in this repo's archive" is a read that can be stale, refused or
   * unreachable, while "give me the next thirty" is an append that only ever
   * happens with the link up and a page already on screen. Folding the append
   * into the resource would make every "load more" able to blank the list it is
   * extending, which is exactly the failure the hook exists to prevent.
   */
  const res = useRemoteResource<ArchiveListing>(
    `${repo?.id ?? ""}|${q}`,
    () => api.archive(repo!.id, { offset: 0, q: q || undefined }),
    { enabled: !!repo },
  );
  const listing = res.data;
  /** Pages 2..N, appended. Reset whenever the first page is re-asked. */
  const [extra, setExtra] = useState<ArchivedConversation[]>([]);
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => { setExtra([]); setMore("idle"); }, [repoId, q]);

  const rows = useMemo(() => [...(listing?.rows ?? []), ...extra], [listing, extra]);

  async function loadMore() {
    if (!repo) return;
    setMore("loading");
    try {
      const r = await api.archive(repo.id, { offset: rows.length, q: q || undefined });
      setExtra((prev) => [...prev, ...r.rows]);
      setMore("idle");
    } catch {
      setMore("failed");
    }
  }

  async function del(row: ArchivedConversation) {
    if (!repo) return;
    const r = await api.archiveDelete(repo.id, row.id).catch(() => ({ ok: false, error: "offline" }));
    if (!r.ok) { showToast(`delete failed: ${r.error ?? "?"}`); return; }
    // Drop it from both halves of the list, and from the counts the hint prints.
    if (listing) res.set({ ...listing, rows: listing.rows.filter((x) => x.id !== row.id), total: Math.max(0, listing.total - 1), scanned: Math.max(0, listing.scanned - 1) });
    setExtra((prev) => prev.filter((x) => x.id !== row.id));
    showToast("conversation deleted");
  }

  const hasMore = !!listing && rows.length < listing.total;
  const loading = res.state === "loading";

  return (
    <div className="sheet">
      <StaleHead title={<><Archive size={ICON} style={{ verticalAlign: "-3px", marginRight: 4 }} />Archive</>} onClose={onClose}
        refreshTitle="re-read the archive" onRefresh={() => res.reload()} />

      {repos.length > 1 && (
        <div className="search-row">
          {/* The shared picker (`RepoPicker.tsx`) — worktrees behind the toggle,
              which is what makes a repo with nine branches pickable at all. */}
          <RepoSelect
            repos={repos}
            className="search grow"
            value={repo?.worktreePath ?? ""}
            onChange={(dir) => { const r = repos.find((x) => x.worktreePath === dir); if (r) setRepoId(r.id); }}
            aria-label="repo"
          />
        </div>
      )}

      {/* Search is a submit, not a keystroke filter: matching a query costs the
          host a title read of every log in the directory, and a busy repo holds
          thousands of them. */}
      <div className="form">
        <div className="row-wrap">
          <SearchBox className="grow" value={draft} placeholder="Search first prompts…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setQ(draft.trim()); }} />
          {q && <button className="row-act" title="clear the search" onClick={() => { setDraft(""); setQ(""); }}><X size={ICON} /></button>}
          <button className="row-act" title="search" onClick={() => setQ(draft.trim())}><Search size={ICON} /></button>
        </div>
      </div>

      <div className="form-hint">
        Every conversation the CLI ever wrote for {repo?.repoName ?? "this repo"} — closing a session
        never deleted one. Tap to resume it exactly (<code>claude --resume</code>), with its full history.
        {listing && (q
          ? ` ${listing.total} of ${listing.scanned} match.`
          : ` ${listing.scanned} on disk.`)}
      </div>

      {backendNote && <div className="form-hint">{backendNote}</div>}

      <div className="list hist">
        {/* Two different nothings. The archive lives on the desktop, so a dead
            tunnel is not an empty archive — and saying "No conversations here
            yet" about a repo holding four hundred of them is the exact lie this
            hook was written to stop. Both sentences live in `Empty.tsx` now,
            along with the cached-age line this list never had. */}
        <Empty res={res} empty={rows.length === 0} thing="the archive" noun="archive listing">
          {q ? "No conversation matches that." : "No conversations here yet."}
        </Empty>
        {rows.map((row) => {
          const live = liveIds.has(row.id);
          return (
            <div key={row.id} className="olog-card">
              <button className="olog-body" title={live ? "already open — jump to it" : "resume this conversation"}
                onClick={() => (live ? onOpenLive(row.id) : onResume(row.cwd, row.title || "resumed", row.id))}>
                <span className="row-title">{row.title || <em>(no prompt — never typed into)</em>}</span>
                <span className="row-sub">
                  {live ? <>open now</> : <><RotateCw size={12} /> resume</>} · {ago(row.mtime)} · {fmtSize(row.size)}
                </span>
              </button>
              <div className="olog-foot">
                <span className="olog-sess" title={row.id}>{row.id.slice(0, 8)}</span>
                {/* The armed tap this sheet invented, now the shared one
                    (`Confirm.tsx`) — which adds the half that was missing: it
                    disarms itself. A row armed and then scrolled past used to
                    stay armed indefinitely, so the next brush of it deleted a
                    conversation for good, which is the exact accident two taps
                    exist to prevent. `deleteArchived` is the only way to lose a
                    conversation in this app. */}
                {/* Non-destructive, and still an ARMED tap: it sits one thumb-
                    width from "delete for good", it opens a session, and the
                    shared `ConfirmButton` is what disarms itself after a row is
                    scrolled past. Never `window.confirm`. */}
                {onFork ? (
                  <ConfirmButton className="link-btn"
                    title="open a copy of this conversation — the original is left exactly as it is"
                    confirmTitle="tap again to open a fork of this conversation"
                    confirm={<><GitBranch size={12} style={{ verticalAlign: "-2px" }} /> fork it?</>}
                    onConfirm={() => onFork(row.cwd, `${row.title || "conversation"} (fork)`, row.id)}>
                    <GitBranch size={12} style={{ verticalAlign: "-2px" }} /> fork
                  </ConfirmButton>
                ) : null}
                <ConfirmButton className="link-btn"
                  title={live ? "close the session before deleting its conversation" : "delete this conversation for good"}
                  confirmTitle="tap again to delete this conversation for good"
                  disabled={live}
                  confirm={<><Trash2 size={12} style={{ verticalAlign: "-2px" }} /> delete for good?</>}
                  onConfirm={() => { void del(row); }}>
                  <Trash2 size={12} style={{ verticalAlign: "-2px" }} /> delete
                </ConfirmButton>
              </div>
            </div>
          );
        })}
        {more === "failed" && <Empty>The next page did not arrive — tap again.</Empty>}
        {hasMore && more !== "loading" && !loading && (
          <button className="row grow" onClick={() => void loadMore()}>
            <span className="row-title">load more</span>
            <span className="row-sub">{rows.length} of {listing?.total}</span>
          </button>
        )}
        {more === "loading" && <Empty>Reading the next page…</Empty>}
      </div>
    </div>
  );
}
