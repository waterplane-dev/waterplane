import { useEffect, useMemo, useState } from "react";
import { Archive, BookOpen, GitBranch, Pencil, RotateCw, Search, Trash2, X } from "lucide-react";
import type { ArchivedConversation, ArchiveListing, Bookmark, RepoTarget } from "@waterplane/shared";
import { api } from "./api";
import { ago, fmtSize } from "./format";
import { RepoSelect } from "./RepoPicker";
import { useBackStep } from "./backStep";
import { ArchiveReader } from "./ArchiveReader";
import { BookmarkIcon, BookmarkNoteEdit, BOOKMARK_ON, BOOKMARK_SET, removeBookmark, setBookmark } from "./core/sessions/bookmark";
import { archiveRowLines, bookmarkChipText, bookmarkCount, bookmarkCutText, withBookmark } from "./core/sessions/bookmarkFacts";
import { useRemoteResource, ConfirmButton, Empty, FilterChip, SearchBox, StaleHead, Row, RowTitle, RowSub, Hint } from "./kit";

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
  /** The "Bookmarks (n)" cut (R-conversations-007). */
  const [bmOnly, setBmOnly] = useState(false);
  /** A row open in the read-only reader — a sub-view with its own Back. */
  const [reading, setReading] = useState<ArchivedConversation | null>(null);
  useBackStep(!!reading, () => setReading(null));
  /** The row whose bookmark note is being typed — one at a time. */
  const [editing, setEditing] = useState<string | null>(null);

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
  /**
   * The repo's bookmarks (`bookmarked=1`), under the same search. ONE listing
   * is both the number on the "Bookmarks" control and, with it lit, the list
   * under it — so the count and the cut can never disagree.
   */
  const bmRes = useRemoteResource<ArchiveListing>(
    `${repo?.id ?? ""}|bm|${q}`,
    () => api.archive(repo!.id, { offset: 0, q: q || undefined, bookmarked: true }),
    { enabled: !!repo },
  );
  const bm = bookmarkCount(bmRes.data);
  const cur = bmOnly ? bmRes : res;
  // An older host ignored the filter: its rows are EVERY conversation, and
  // calling them bookmarks would be the lie the field exists to prevent.
  const listing = bmOnly && bm.kind === "old-host" ? null : cur.data;
  /** Pages 2..N, appended. Reset whenever the first page is re-asked. */
  const [extra, setExtra] = useState<ArchivedConversation[]>([]);
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => { setExtra([]); setMore("idle"); }, [repoId, q, bmOnly]);

  const rows = useMemo(() => [...(listing?.rows ?? []), ...extra], [listing, extra]);

  async function loadMore() {
    if (!repo) return;
    setMore("loading");
    try {
      const r = await api.archive(repo.id, { offset: rows.length, q: q || undefined, bookmarked: bmOnly || undefined });
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
    bmRes.reload({ quiet: true });
  }

  /** A bookmark moved on one row: patch it where it is drawn, re-read the cut. */
  function patch(id: string, b: Bookmark | undefined) {
    if (res.data) res.set({ ...res.data, rows: withBookmark(res.data.rows, id, b) });
    if (bmRes.data) bmRes.set({ ...bmRes.data, rows: withBookmark(bmRes.data.rows, id, b) });
    setExtra((prev) => withBookmark(prev, id, b));
    bmRes.reload({ quiet: true });
  }
  async function bookmark(row: ArchivedConversation, fields: { note?: string; name?: string }) {
    if (!repo) return;
    const was = !!row.bookmark;
    const b = await setBookmark(repo.id, row.id, fields);
    if (!b) return;
    patch(row.id, b);
    showToast(was ? "bookmark note saved" : "bookmarked");
  }
  async function unbookmark(row: ArchivedConversation) {
    if (!repo) return;
    if (await removeBookmark(repo.id, row.id)) patch(row.id, undefined);
  }

  const hasMore = !!listing && rows.length < listing.total;
  const loading = cur.state === "loading";

  if (reading && repo) {
    const live = liveIds.has(reading.id);
    return <ArchiveReader repoId={repo.id} row={reading} live={live} onToast={showToast} onBack={() => setReading(null)}
      onResume={() => (live ? onOpenLive(reading.id) : onResume(reading.cwd, reading.name || reading.title || "resumed", reading.id))} />;
  }

  return (
    <div className="sheet">
      <StaleHead title={<><Archive size={ICON} style={{ verticalAlign: "-3px", marginRight: 4 }} />Archive</>} onClose={onClose}
        refreshTitle="re-read the archive" onRefresh={() => { res.reload(); bmRes.reload(); }} />

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
        <Row kind="wrap">
          <SearchBox className="grow" value={draft} placeholder="Search prompts, names, notes…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setQ(draft.trim()); }} />
          {q && <button className="row-act" title="clear the search" onClick={() => { setDraft(""); setQ(""); }}><X size={ICON} /></button>}
          <button className="row-act" title="search" onClick={() => setQ(draft.trim())}><Search size={ICON} /></button>
        </Row>
      </div>

      {/* "A count on a control is a filter": the number is the bookmarked
          listing's own total, and a tap shows exactly those rows. */}
      <div className="form">
        <Row kind="wrap">
          <FilterChip on={bmOnly} busy={bmOnly && bmRes.inflight} onClick={() => setBmOnly((v) => !v)}
            title={bmOnly ? "show every conversation again" : "show only the bookmarked conversations"}>
            <BookmarkIcon on={bmOnly} size={13} /> {bookmarkChipText(bm)}
          </FilterChip>
        </Row>
      </div>

      {bmOnly ? (
        <Hint>{bookmarkCutText(bm, bmRes.data?.scanned ?? null)}{" "}
          <button className="link-btn" onClick={() => setBmOnly(false)}>show all</button>
        </Hint>
      ) : (
        <Hint>
          Every conversation the CLI ever wrote for {repo?.repoName ?? "this repo"} — closing a session
          never deleted one. Tap to resume it exactly (<code>claude --resume</code>); <em>read</em> opens
          it read-only, without starting anything.
          {listing && (q
            ? ` ${listing.total} of ${listing.scanned} match.`
            : ` ${listing.scanned} on disk.`)}
        </Hint>
      )}

      {backendNote && <Hint>{backendNote}</Hint>}

      <div className="list hist">
        {/* Two different nothings. The archive lives on the desktop, so a dead
            tunnel is not an empty archive — and saying "No conversations here
            yet" about a repo holding four hundred of them is the exact lie this
            hook was written to stop. Both sentences live in `Empty.tsx` now,
            along with the cached-age line this list never had. */}
        {!(bmOnly && bm.kind === "old-host") && (
          <Empty res={cur} empty={rows.length === 0} thing="the archive" noun="archive listing">
            {bmOnly
              ? (q ? "No bookmarked conversation matches that." : "No bookmarks in this repo yet — bookmark a row below, or an open session from its menu.")
              : q ? "No conversation matches that." : "No conversations here yet."}
          </Empty>
        )}
        {rows.map((row) => {
          const live = liveIds.has(row.id);
          const { title, sub } = archiveRowLines(row);
          const b = row.bookmark;
          return (
            <div key={row.id} className="olog-card">
              <button className="olog-body" title={live ? "already open — jump to it" : "resume this conversation"}
                onClick={() => (live ? onOpenLive(row.id) : onResume(row.cwd, row.name || row.title || "resumed", row.id))}>
                <RowTitle>{title || <em>(no prompt — never typed into)</em>}</RowTitle>
                {sub && <RowSub>{sub}</RowSub>}
                <RowSub>
                  {live ? <>open now</> : <><RotateCw size={12} /> resume</>} · {ago(row.mtime)} · {fmtSize(row.size)}
                </RowSub>
              </button>
              {/* The note, once, under the row it is about — tap to edit it in
                  place (one line). Never a badge beside the title as well. */}
              {b && (editing === row.id
                ? <BookmarkNoteEdit initial={b.note ?? ""} onCancel={() => setEditing(null)}
                    onSave={(note) => { setEditing(null); void bookmark(row, { note }); }} />
                : (
                  <button className="link-btn bm-note-line" title="edit the bookmark's one-line note" onClick={() => setEditing(row.id)}>
                    <Pencil size={12} /> {b.note || "add a note"}
                  </button>
                ))}
              <div className="olog-foot">
                <span className="olog-sess" title={row.id}>{row.id.slice(0, 8)}</span>
                {/* The bookmark toggle, on the row it marks. Removing one that
                    carries a note deletes words somebody typed: armed then. */}
                {b && b.note ? (
                  <ConfirmButton className="link-btn bm-btn on" title={`${BOOKMARK_ON} — tap to remove`}
                    confirmTitle="tap again to remove the bookmark and its note"
                    confirm={<><BookmarkIcon on size={12} /> remove, with its note?</>}
                    onConfirm={() => { void unbookmark(row); }}>
                    <BookmarkIcon on size={12} /> {BOOKMARK_ON}
                  </ConfirmButton>
                ) : (
                  <button className={`link-btn bm-btn${b ? " on" : ""}`} data-hint="session.bookmark" aria-pressed={!!b}
                    title={b ? `${BOOKMARK_ON} — tap to remove` : "bookmark this conversation — Bookmarks finds it again"}
                    onClick={() => { if (b) void unbookmark(row); else void bookmark(row, row.name ? { name: row.name } : {}); }}>
                    <BookmarkIcon on={!!b} size={12} /> {b ? BOOKMARK_ON : BOOKMARK_SET}
                  </button>
                )}
                <button className="link-btn" title="read this conversation here, read-only — nothing is started"
                  onClick={() => { setEditing(null); setReading(row); }}>
                  <BookOpen size={12} style={{ verticalAlign: "-2px" }} /> read
                </button>
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
          <Row as="button" kind="grow" onClick={() => void loadMore()}>
            <RowTitle>load more</RowTitle>
            <RowSub>{rows.length} of {listing?.total}</RowSub>
          </Row>
        )}
        {more === "loading" && <Empty>Reading the next page…</Empty>}
      </div>
    </div>
  );
}
