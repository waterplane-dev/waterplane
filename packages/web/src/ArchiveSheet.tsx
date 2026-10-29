import { useEffect, useMemo, useState } from "react";
import { CantInline } from "./Unavailable";
import { Archive, ArrowRight, BookOpen, GitBranch, Pencil, RotateCw, Search, Trash2, X } from "lucide-react";
import type { ArchivedConversation, ArchiveListing, Bookmark, RepoTarget } from "@waterplane/shared";
import { repoLabel } from "@waterplane/shared";
import { api } from "./api";
import { ago, baseName, fmtSize, repoAccentStyle } from "./format";
import { PromptPair } from "./PromptPair";
import { RepoSelect } from "./RepoPicker";
import { useBackStep } from "./backStep";
import { ArchiveReader } from "./ArchiveReader";
import { BookmarkIcon, BookmarkNoteEdit, BOOKMARK_ON, BOOKMARK_SET, removeBookmark, setBookmark } from "./core/sessions/bookmark";
import { archiveRowLines, bookmarkChipText, bookmarkCount, bookmarkCutText, withBookmark } from "./core/sessions/bookmarkFacts";
import { useRemoteResource, ConfirmButton, Empty, FilterChip, SearchBox, StaleHead, Row, RowTitle, RowSub, Hint, Tag } from "./kit";

const ICON = 16;

/**
 * One list the sheet can show: claude's jsonl archive, or a backend whose
 * derived facts include `conversations` (`features/tools/logic.ts`'s
 * `archiveBackends` decides which). `note` is that list's one sentence about
 * itself — for claude, the "resuming starts Claude Code" line where a second
 * backend exists; for any other, what a tap starts and what is not offered.
 */
export interface ArchiveBackendTab { id: string; label: string; note?: string }

const CLAUDE_TAB: ArchiveBackendTab = { id: "claude", label: "Claude Code" };

interface Props {
  repos: RepoTarget[];
  /** Repo the sheet opens on — the focused one, or the row that opened it. */
  initialRepoId: string;
  /** Conversation ids that are already open as live sessions: their rows say so
   *  and resume in place rather than offering a second copy of the same chat. */
  liveIds: Set<string>;
  onClose: () => void;
  /**
   * Whose conversations can be listed, claude FIRST. One entry (the default,
   * and every host whose other backends list none) draws no switch at all:
   * the sheet is then exactly the claude archive it always was.
   */
  archiveBackends?: ArchiveBackendTab[];
  /** Resume one conversation in its own worktree, under the backend that
   *  wrote it (`claude --resume <id>` for claude's rows). */
  onResume: (cwd: string, title: string, conversationId: string, backendId: string) => void;
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
export function ArchiveSheet({ repos, initialRepoId, liveIds, onClose, onResume, onFork, onOpenLive, showToast, archiveBackends }: Props) {
  const tabs = archiveBackends && archiveBackends.length ? archiveBackends : [CLAUDE_TAB];
  const [backendId, setBackendId] = useState(tabs[0].id);
  // A frame that dropped the lit backend falls back to the first list (claude),
  // never to a list nobody can see the switch for.
  const tab = tabs.find((t) => t.id === backendId) ?? tabs[0];
  /** Claude's own archive: the only list with a reader, forks and bookmarks. */
  const isClaude = tab.id === CLAUDE_TAB.id;
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
  // Another backend's list is asked for by ABSOLUTE cwd (`worktreePath`, the
  // same field the picker keys on); a 404 there is the host's sentence, which
  // `api.conversations` carries into the resource's `error` for `Empty`.
  const res = useRemoteResource<ArchiveListing>(
    isClaude ? `${repo?.id ?? ""}|${q}` : `${repo?.id ?? ""}|be:${tab.id}|${q}`,
    (signal) => isClaude
      ? api.archive(repo!.id, { offset: 0, q: q || undefined })
      : api.conversations(tab.id, repo!.worktreePath, { offset: 0, q: q || undefined }, signal),
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
    // Bookmarks are claude's (the host's bookmark routes gate on its jsonl).
    { enabled: !!repo && isClaude },
  );
  const bm = bookmarkCount(bmRes.data);
  const bmCut = bmOnly && isClaude;
  const cur = bmCut ? bmRes : res;
  // An older host ignored the filter: its rows are EVERY conversation, and
  // calling them bookmarks would be the lie the field exists to prevent.
  const listing = bmCut && bm.kind === "old-host" ? null : cur.data;
  /** Pages 2..N, appended. Reset whenever the first page is re-asked. */
  const [extra, setExtra] = useState<ArchivedConversation[]>([]);
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => { setExtra([]); setMore("idle"); setEditing(null); }, [repoId, q, bmCut, tab.id]);

  const rows = useMemo(() => [...(listing?.rows ?? []), ...extra], [listing, extra]);

  async function loadMore() {
    if (!repo) return;
    setMore("loading");
    try {
      const r = isClaude
        ? await api.archive(repo.id, { offset: rows.length, q: q || undefined, bookmarked: bmCut || undefined })
        : await api.conversations(tab.id, repo.worktreePath, { offset: rows.length, q: q || undefined });
      setExtra((prev) => [...prev, ...r.rows]);
      setMore("idle");
    } catch {
      setMore("failed");
    }
  }

  async function del(row: ArchivedConversation) {
    if (!repo) return;
    const r = await (isClaude ? api.archiveDelete(repo.id, row.id) : api.conversationsDelete(tab.id, repo.worktreePath, row.id))
      .catch(() => ({ ok: false, error: "offline" }));
    if (!r.ok) { showToast(`delete failed: ${r.error ?? "?"}`); return; }
    // Drop it from both halves of the list, and from the counts the hint prints.
    if (listing) res.set({ ...listing, rows: listing.rows.filter((x) => x.id !== row.id), total: Math.max(0, listing.total - 1), scanned: Math.max(0, listing.scanned - 1) });
    setExtra((prev) => prev.filter((x) => x.id !== row.id));
    showToast("conversation deleted");
    if (isClaude) bmRes.reload({ quiet: true });
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

  // The reader reads claude's jsonl only, and is only ever opened from claude's list.
  if (reading && repo) {
    const live = liveIds.has(reading.id);
    return <ArchiveReader repoId={repo.id} row={reading} live={live} onToast={showToast} onBack={() => setReading(null)}
      onResume={() => (live ? onOpenLive(reading.id) : onResume(reading.cwd, reading.name || reading.title || "resumed", reading.id, CLAUDE_TAB.id))} />;
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

      {/* Whose conversations: a VIEW switch, not a count — no number on it.
          Drawn only when a second backend's facts include `conversations`;
          a claude-only host never sees this row. */}
      {tabs.length > 1 && (
        <div className="form">
          <Row kind="wrap">
            {tabs.map((t) => (
              <FilterChip key={t.id} on={t.id === tab.id} clears={false} busy={t.id === tab.id && res.inflight}
                onClick={() => { if (t.id !== tab.id) setBackendId(t.id); }}
                title={t.id === tab.id ? `showing the conversations ${t.label} wrote` : `show the conversations ${t.label} wrote`}>
                {t.label}
              </FilterChip>
            ))}
          </Row>
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
      {isClaude && (
        <div className="form">
          <Row kind="wrap">
            <FilterChip on={bmOnly} busy={bmOnly && bmRes.inflight} onClick={() => setBmOnly((v) => !v)}
              title={bmOnly ? "show every conversation again" : "show only the bookmarked conversations"}>
              <BookmarkIcon on={bmOnly} size={13} /> {bookmarkChipText(bm)}
            </FilterChip>
          </Row>
        </div>
      )}

      {!isClaude ? (
        // Another backend's list: ONE sentence names what a tap starts and what
        // is not offered here (read, fork, bookmarks) — those controls are
        // absent below, never dimmed.
        <Hint>
          {tab.note}
          {listing && (q
            ? ` ${listing.total} of ${listing.scanned} match.`
            : ` ${listing.total} listed.`)}
        </Hint>
      ) : bmOnly ? (
        <Hint>{bookmarkCutText(bm, bmRes.data?.scanned ?? null)}{" "}
          <button className="link-btn" onClick={() => setBmOnly(false)}>show all</button>
        </Hint>
      ) : (
        <Hint>
          Every conversation the CLI ever wrote for {repo ? repoLabel(repo) : "this repo"} — closing a session
          never deleted one. Tap to resume it exactly (<code>claude --resume</code>); <em>read</em> opens
          it read-only, without starting anything.
          {listing && (q
            ? ` ${listing.total} of ${listing.scanned} match.`
            : ` ${listing.scanned} on disk.`)}
        </Hint>
      )}

      {isClaude && tab.note && <Hint>{tab.note}</Hint>}

      <div className="list hist">
        {/* Two different nothings. The archive lives on the desktop, so a dead
            tunnel is not an empty archive — and saying "No conversations here
            yet" about a repo holding four hundred of them is the exact lie this
            hook was written to stop. Both sentences live in `Empty.tsx` now,
            along with the cached-age line this list never had. */}
        {!(bmCut && bm.kind === "old-host") && (
          // Another backend's 404 ("lists none right now") arrives as the
          // resource's `error`, so `Empty` prints the HOST's sentence — never
          // "No conversations here yet" about a list nobody could read.
          <Empty res={cur} empty={rows.length === 0} thing={isClaude ? "the archive" : `the conversations ${tab.label} wrote`} noun="archive listing">
            {bmCut
              ? (q ? "No bookmarked conversation matches that." : "No bookmarks in this repo yet — bookmark a row below, or an open session from its menu.")
              : q ? "No conversation matches that."
              : isClaude ? "No conversations here yet." : `${tab.label} lists no conversation in this folder yet.`}
          </Empty>
        )}
        {rows.map((row) => {
          const live = liveIds.has(row.id);
          const { title, sub } = archiveRowLines(row);
          // Bookmarks are claude's: a mark another backend's listing carried is
          // not drawn where it could not be edited or removed.
          const b = isClaude ? row.bookmark : undefined;
          const resume = () => (live ? onOpenLive(row.id) : onResume(row.cwd || repo?.worktreePath || "", row.name || row.title || "resumed", row.id, tab.id));
          return (
            // The open session's CARD (`SessionRow.tsx`; the grid in
            // `05-rows-approve.css`, entered through `.closed-card` exactly as
            // "Recently closed" does — never `data-sid`, the LIVE rows' drag and
            // scroll lookup): name/prompt + file facts on the head line, how old
            // it is where the live card's status pill sits, the first prompt as
            // the gist when a name took the title, the verbs pinned right, the
            // bookmark (toggle and note) at the foot where a live card's chips go.
            <div key={row.id} className="row-wrap closed-card archive-card" style={repoAccentStyle(repo ? repoLabel(repo) : baseName(row.cwd))}>
              {/* The whole card resumes on tap: the row button is `display:
                  contents`, its children the grid's items; every control lives
                  OUTSIDE it, in `.row-acts` (nested buttons are invalid). */}
              <Row as="button" kind="grow" title={live ? "already open — jump to it" : isClaude ? "resume this conversation" : `resume this conversation in ${tab.label}`}
                onClick={resume}>
                <span className="row-head">
                  <RowTitle>{b && !b.note && <><span className="bm-mark"><BookmarkIcon on size={12} /></span> </>}{title || <em>(no prompt — never typed into)</em>}</RowTitle>
                  <span className="row-meta">
                    <RowSub className="olog-sess" title={row.id}>{row.id.slice(0, 8)}</RowSub>
                    {/* A plugin row has no log file of its own (`size: 0` on the
                        wire): no size is printed rather than a wrong one. */}
                    {isClaude && <RowSub>{fmtSize(row.size)}</RowSub>}
                  </span>
                </span>
                {/* Where the live card says "coding" / "done": what this one IS. */}
                <span className="row-stat">
                  <Tag className="closed-stat" title={`last active ${new Date(row.mtime).toLocaleString()}`}>{live ? "open now" : `active ${ago(row.mtime)}`}</Tag>
                </span>
                {/* The first prompt, when a tab name took the title line. The
                    archive DTO carries no latest prompt — only the first. */}
                {sub && <span className="row-gist"><PromptPair firstPrompt={sub} className="closed-gist" /></span>}
              </Row>
              <div className="row-acts">
                <span className="row-tags">
                  {/* The note, once, at the foot of the card it is about — tap
                      to edit it in place (one line). Never a badge beside the
                      title as well. */}
                  {b && (editing === row.id
                    ? <span className="archive-note"><BookmarkNoteEdit initial={b.note ?? ""} onCancel={() => setEditing(null)}
                        onSave={(note) => { setEditing(null); void bookmark(row, { note }); }} /></span>
                    : (
                      <button className="link-btn bm-note-line archive-note" title="edit the bookmark's one-line note" onClick={() => setEditing(row.id)}>
                        <Pencil size={12} /> {b.note || "add a note"}
                      </button>
                    ))}
                  {/* The bookmark toggle, on the card it marks. Removing one that
                      carries a note deletes words somebody typed: armed then.
                      On another backend's list the bookmark, read and fork
                      controls are ABSENT and the hint above says why, once. */}
                  {!isClaude ? null : b && b.note ? (
                    <ConfirmButton className="bm-btn bm-chip on" title={`${BOOKMARK_ON} — tap to remove`}
                      confirmTitle="tap again to remove the bookmark and its note"
                      confirm={<><BookmarkIcon on size={12} /> remove, with its note?</>}
                      onConfirm={() => { void unbookmark(row); }}>
                      <BookmarkIcon on size={12} /> {BOOKMARK_ON}
                    </ConfirmButton>
                  ) : (
                    <button className={`bm-btn bm-chip${b ? " on" : ""}`} data-hint="session.bookmark" aria-pressed={!!b}
                      title={b ? `${BOOKMARK_ON} — tap to remove` : "bookmark this conversation — Bookmarks finds it again"}
                      onClick={() => { if (b) void unbookmark(row); else void bookmark(row, row.name ? { name: row.name } : {}); }}>
                      <BookmarkIcon on={!!b} size={12} /> {b ? BOOKMARK_ON : BOOKMARK_SET}
                    </button>
                  )}
                  {live && <CantInline>can't delete — the session is open, close it first</CantInline>}
                </span>
                <span className="row-ctl">
                  {isClaude && (
                    <button className="row-act" title="read this conversation here, read-only — nothing is started"
                      onClick={() => { setEditing(null); setReading(row); }}>
                      <BookOpen size={ICON} />
                    </button>
                  )}
                  {/* Non-destructive, and still an ARMED tap: it sits one thumb-
                      width from "delete for good", it opens a session, and the
                      shared `ConfirmButton` is what disarms itself after a row is
                      scrolled past. Never `window.confirm`. Armed, the tile
                      widens to carry its question in words (`.archive-card`). */}
                  {onFork && isClaude ? (
                    <ConfirmButton className="row-act"
                      title="open a copy of this conversation — the original is left exactly as it is"
                      confirmTitle="tap again to open a fork of this conversation"
                      confirm={<><GitBranch size={12} /> fork it?</>}
                      onConfirm={() => onFork(row.cwd, `${row.title || "conversation"} (fork)`, row.id)}>
                      <GitBranch size={ICON} />
                    </ConfirmButton>
                  ) : null}
                  {/* The armed tap this sheet invented, now the shared one
                      (`Confirm.tsx`) — which adds the half that was missing: it
                      disarms itself. A row armed and then scrolled past used to
                      stay armed indefinitely, so the next brush of it deleted a
                      conversation for good, which is the exact accident two taps
                      exist to prevent. `deleteArchived` is the only way to lose a
                      conversation in this app. Absent while the session is open:
                      the reason is the sentence at the foot. */}
                  {!live && (
                    <ConfirmButton className="row-act"
                      title="delete this conversation for good"
                      confirmTitle="tap again to delete this conversation for good"
                      confirm={<><Trash2 size={12} /> delete for good?</>}
                      onConfirm={() => { void del(row); }}>
                      <Trash2 size={ICON} />
                    </ConfirmButton>
                  )}
                  {/* The card's own verb, said as a button too (as "Recently
                      closed" does): the whole card is the same tap. */}
                  <button className="row-act" title={live ? "already open — jump to it" : "resume this conversation"} onClick={resume}>
                    {live ? <ArrowRight size={ICON} /> : <RotateCw size={ICON} />}
                  </button>
                </span>
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
