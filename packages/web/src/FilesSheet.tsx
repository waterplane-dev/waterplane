import { useCallback, useEffect, useRef, useState } from "react";
import {
  AtSign, Copy, Eye, File as FileIcon, Folder, MessageSquarePlus, Pencil, Pin, PinOff, RotateCw, Save, Search, X,
} from "lucide-react";
import { api, copyText, type TreeEntry, type TreeFile, type TreeListing } from "./api";
import { ago, fmtSize } from "./format";
import { getArtifactText, getTreeListing, putArtifactText, putTreeListing } from "./offlineCache";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { useBackStep } from "./backStep";
import { stalenessNote, useRemoteResource } from "./useRemoteResource";
import { Empty } from "./Empty";
import { DownloadButton } from "./DownloadButton";
import { Markdown, type FileRefCtx } from "./Markdown";
import { isImage, isMarkdown, isVideo } from "./docKind";
import { ZoomableImage } from "./ZoomableImage";
import { sized, viewerWidth } from "./media";
import { FileReview, storedRemarkCount } from "./FileReview";
import { fileTabKey, fileTabLabel, noteFileOnScreen, setFilePinned, useSessionTabs } from "./sessionTabs";
import { showToast } from "./toast";
import { Button } from "./kit/Button";
import { Row, RowTitle, RowSub } from "./kit/Row";
import { Hint } from "./kit/Hint";

/**
 * Browse the repo as a TREE, and edit a file now and then.
 *
 * Why this is not a Gallery tab: the gallery answers "what did an agent leave
 * me" — a flat, mtime-sorted list of deliverables whose cached listings are
 * keyed by COVERAGE (shared/gallery.ts) so one can be re-filtered into another.
 * A directory listing has no coverage: it is the folder you asked for or it is
 * not, and its rows are ordered by name, not time. Two different questions.
 *
 * Offline is the same deal it is everywhere else here: every listing and every
 * opened file is cached (`offlineCache`), a cached view SAYS how old it is, and
 * the parts that need the host — saving above all — are disabled with a reason
 * rather than failing at the tap. Saving is deliberately never queued: a write
 * composed now and replayed in an hour carries a base the file left behind long
 * ago, and the only honest answer for it is the stale refusal it would get.
 */

interface Props {
  repoId: string;
  repoName?: string;
  /** True while the WebSocket is open — the only state in which saving is safe. */
  socketOpen: boolean;
  /** Drop a repo-relative path into the compose bar (same contract as Gallery). */
  onInsertPath: (relPath: string) => void;
  /** Remarks on a file (`FileReview.tsx`) into the chat. False = they did not
   *  go, and the remarks stay. Absent = no review mode. */
  onRemarks?: (relPath: string, text: string) => boolean;
  /** A worktree-relative file to open straight into, from a sheet that named
   *  it (the readings' longest-files tape). Closing that file then closes the
   *  sheet — the reader came for the file, not for its folder. */
  initialFile?: string;
  onClose: () => void;
}


/** Porcelain code → the short word the git sheet already uses. */
function statusLabel(code: string): string {
  const c = code.trim();
  if (c === "??") return "new";
  if (c.includes("D")) return "deleted";
  if (c.startsWith("R")) return "renamed";
  if (c.includes("A")) return "added";
  return "modified";
}

export function FilesSheet({ repoId, repoName, socketOpen, onInsertPath, onRemarks, initialFile, onClose }: Props) {
  const [dir, setDir] = useState(() =>
    initialFile && initialFile.includes("/") ? initialFile.slice(0, initialFile.lastIndexOf("/")) : "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  /** The query the HOST answered, i.e. we are looking at search hits. */
  const [searched, setSearched] = useState<string | null>(null);
  const [open, setOpen] = useState<TreeFile | null>(null);

  // ── Listing ─────────────────────────────────────────────────────────
  // Cache first, live read second, and the label in between — the rule lives in
  // `useRemoteResource` now, along with the reason it is not optional. The one
  // thing this sheet adds is `offline`: with the socket down there is no point
  // spending a request that can only time out, and `navigator.onLine` cannot
  // tell us that: it stays true while the Tailscale path is dead, which is the
  // exact failure this whole sheet has to survive.
  const tree = useRemoteResource<TreeListing>(
    `${repoId}:${dir}`,
    () => api.tree(repoId, dir),
    {
      fromCache: async () => {
        const hit = await getTreeListing<TreeListing>(repoId, dir);
        return hit ? { value: hit.listing, savedAt: hit.savedAt } : null;
      },
      toCache: (l) => putTreeListing(repoId, dir, l),
    },
  );
  const listing = tree.data;

  const load = useCallback((path: string) => {
    setSearched(null);
    setError(null);
    if (path === dir) tree.reload();
    else setDir(path);
  }, [dir, tree]);

  /** Recursive name search from the current folder down. Needs the host — a
   *  cache of listings is not an index, and pretending otherwise would answer
   *  a whole-repo question with one folder's worth of files. */
  async function searchRepo() {
    const q = filter.trim();
    if (!q) return;
    track("action:files.search");
    setLoading(true); setError(null);
    try {
      const l = await api.tree(repoId, dir, q);
      tree.set(l); setSearched(q);
    } catch {
      setError("search needs the host — showing this folder only");
    } finally {
      setLoading(false);
    }
  }

  // ── Opening a file ──────────────────────────────────────────────────
  async function openEntry(e: TreeEntry) {
    if (e.dir) { setFilter(""); setDir(e.path); return; }
    track("action:files.open");
    setError(null);
    if (!socketOpen) {
      const hit = await getArtifactText(repoId, e.path, e.mtime);
      if (!hit) { setError(`no link — "${e.name}" isn't cached on the phone`); return; }
      // No sha: a cached body was read at some past mtime, so it can never arm
      // a save. That is the correct outcome, not a limitation to work around.
      setOpen({ path: e.path, size: e.size, mtime: e.mtime, body: hit.text, truncated: hit.truncated, editable: false });
      return;
    }
    setLoading(true);
    try {
      const f = await api.treeFile(repoId, e.path);
      setOpen(f);
      if (f.body != null) void putArtifactText(repoId, f.path, f.mtime, f.body, !!f.truncated);
    } catch {
      const hit = await getArtifactText(repoId, e.path, e.mtime);
      if (hit) setOpen({ path: e.path, size: e.size, mtime: e.mtime, body: hit.text, truncated: hit.truncated, editable: false });
      else setError(`couldn't open ${e.name}`);
    } finally {
      setLoading(false);
    }
  }

  // Straight into the named file, once. `direct` stays true while that file
  // is the one open, so its close returns to the sheet that named it.
  const direct = useRef(!!initialFile);
  const aimed = useRef(false);
  useEffect(() => {
    if (!initialFile || aimed.current) return;
    aimed.current = true;
    const name = initialFile.split("/").pop() || initialFile;
    // mtime 0: unknown until the host answers, so an offline open can only
    // miss the cache — and says so, rather than showing a stale body.
    void openEntry({ name, path: initialFile, dir: false, size: 0, mtime: 0 });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per named file (guarded by `aimed`); `openEntry` is a per-render closure
  }, [initialFile]);

  const closeFile = () => { setOpen(null); tree.reload({ quiet: true }); };
  // Back — the gesture as much as the arrow — steps back INSIDE the sheet: out
  // of the file to the folder it was opened from, then up one folder at a time.
  // A file opened by name from elsewhere (`direct`) is not a step: Back leaves
  // the sheet, back to whatever named it.
  // ONE step for both, so opening a file from a sub-folder moves no entry.
  useBackStep(open ? !direct.current : dir !== "", () => {
    if (open) { closeFile(); return; }
    setFilter(""); setDir(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");
  });

  if (open) {
    return (
      <FileView
        repoId={repoId} repoName={repoName ?? ""} file={open} socketOpen={socketOpen}
        onReopen={async () => { try { setOpen(await api.treeFile(repoId, open.path)); } catch { /* keep what we have */ } }}
        onInsertPath={onInsertPath}
        onRemarks={onRemarks}
        onOpenPath={(rel) => void openEntry({ name: rel.split("/").pop() || rel, path: rel, dir: false, size: 0, mtime: 0 })}
        // Quiet: the folder behind the viewer is already painted, and blanking it
        // to re-fetch would flash on exactly the link this sheet is written for.
        onClose={() => {
          if (direct.current) { onClose(); return; }
          closeFile();
        }}
      />
    );
  }

  // Local filter over the rows we have. A search that went to the host has
  // already filtered them, so filtering again by the same text is harmless.
  const q = filter.trim().toLowerCase();
  const rows = (listing?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q) || (searched && e.path.toLowerCase().includes(q)));
  const crumbs = dir ? dir.split("/") : [];

  return (
    <div className="sheet">
      <SheetHead title={<>Files{repoName ? ` · ${repoName}` : ""}</>} onClose={onClose}>
        <Button title="refresh" onClick={() => load(dir)}><RotateCw size={16} /></Button>
      </SheetHead>

      <div className="crumbs">
        <button className={`crumb ${dir ? "" : "here"}`} onClick={() => { setFilter(""); setDir(""); }}>/</button>
        {crumbs.map((c, i) => (
          <button key={i} className={`crumb ${i === crumbs.length - 1 ? "here" : ""}`}
            onClick={() => { setFilter(""); setDir(crumbs.slice(0, i + 1).join("/")); }}>{c}</button>
        ))}
      </div>

      <div className="form">
        <Row kind="wrap">
          <input className="search grow" placeholder="Filter this folder…" value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") searchRepo(); }} />
          {filter && <button className="row-act" title="clear" onClick={() => { setFilter(""); if (searched) load(dir); }}><X size={16} /></button>}
          <button className="row-act" title="search this folder and everything under it" disabled={!filter.trim()} onClick={searchRepo}><Search size={16} /></button>
        </Row>
      </div>

      {searched && (
        <Hint>
          Matches for “{searched}” under /{dir} — build and dependency folders are not searched.
        </Hint>
      )}
      {/* The staleness sentence is `useRemoteResource`'s, not this sheet's: the
          wording is a PROMISE about freshness, and one written per sheet is one
          that can quietly overstate it. */}
      {tree.state === "cached" && (
        <Hint>{stalenessNote(tree.state, tree.age)}</Hint>
      )}
      {tree.state === "offline" && (
        <Hint>No link, and this folder isn't cached on the phone.</Hint>
      )}
      {tree.state === "error" && (
        <Hint>Couldn't read this folder: {tree.error}</Hint>
      )}
      {listing?.truncated && <Hint>Long folder — showing the first {listing.entries.length} entries.</Hint>}
      {error && <Hint>{error}</Hint>}

      <div className="list">
        {/* No `res` here, deliberately: this sheet already answers the read's
            four states in the notes ABOVE the list (it is the one sheet that
            imported `stalenessNote`), so passing the resource in would print
            each of them twice. What is shared is the BOX and the plain
            nothing-here sentence. */}
        {(loading || tree.state === "loading") && !listing && <Empty>Reading this folder…</Empty>}
        {listing && rows.length === 0 && <Empty>{q ? "Nothing matches." : "Empty folder."}</Empty>}
        {rows.map((e) => (
          <button key={e.path} className={`row grow ${e.ignored ? "dim" : ""}`} onClick={() => openEntry(e)}>
            <span className="row-ico">{e.dir ? <Folder size={16} /> : <FileIcon size={16} />}</span>
            <RowTitle className="mono">{searched ? e.path : e.name}{e.dir ? "/" : ""}</RowTitle>
            {e.status && <span className={`gstat g-${statusLabel(e.status)}`}>{statusLabel(e.status)}</span>}
            <RowSub>
              {e.dir ? (e.count != null ? `${e.count}` : "") : `${fmtSize(e.size)} · ${ago(e.mtime)}`}
            </RowSub>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── One file: read, and edit in the rare case ─────────────────────────

interface ViewProps {
  repoId: string;
  /** The tab strip's colour for a pin (`sessionTabs.ts` `FileTab`). */
  repoName: string;
  file: TreeFile;
  socketOpen: boolean;
  onReopen: () => Promise<void>;
  onInsertPath: (relPath: string) => void;
  onRemarks?: (relPath: string, text: string) => boolean;
  /** Open another file of this repo — a picture a markdown file links. */
  onOpenPath: (relPath: string) => void;
  onClose: () => void;
}

function FileView({ repoId, repoName, file, socketOpen, onReopen, onInsertPath, onRemarks, onOpenPath, onClose }: ViewProps) {
  const [editing, setEditing] = useState(false);
  /** Pinned to the tab strip — read off the strip's own store, so an × on the
   *  strip flips this button too. */
  const pinKey = fileTabKey({ repoId, path: file.path });
  const pinned = useSessionTabs((s) => s.files.some((f) => fileTabKey(f) === pinKey));
  const stripOn = useSessionTabs((s) => s.enabled);
  // While this file is on screen its pinned tab is the front one.
  useEffect(() => {
    noteFileOnScreen(pinKey);
    return () => noteFileOnScreen(null);
  }, [pinKey]);
  function togglePin() {
    track("action:files.pin");
    setFilePinned({ repoId, repo: repoName, path: file.path }, !pinned);
    const name = fileTabLabel(file.path);
    showToast(pinned ? `unpinned ${name}`
      : stripOn ? `pinned ${name} to the tab strip`
      : `pinned ${name} — the tab strip is off, turn it on in Settings to see it`);
  }
  /** Review mode (`FileReview.tsx`): mark lines, say what should change, send
   *  the lot to the chat. Exclusive with editing — the remarks name lines on
   *  disk, and a box being typed into is not that. */
  const [review, setReview] = useState(false);
  const [remarkCount, setRemarkCount] = useState(() => storedRemarkCount(repoId, file.path));
  useEffect(() => { setRemarkCount(storedRemarkCount(repoId, file.path)); }, [repoId, file.path]);
  /** Markdown reads formatted by default, like the gallery's viewer
   *  (`docKind.ts` `isMarkdown`); this is the toggle back to the source. */
  const [raw, setRaw] = useState(false);
  /** A picture or a clip is SHOWN, like the gallery shows one — "binary,
   *  nothing to show" about a PNG was the browser refusing to do its one job.
   *  An SVG is text too, so it keeps the toggle to its source. */
  const media = isImage(file.path) || isVideo(file.path);
  const rendered = (isMarkdown(file.path) || media) && !file.binary;
  /** Text there is to mark: not a picture or a clip, but an SVG's source is. */
  const reviewable = !!onRemarks && !file.binary && file.body != null && (!media || /\.svg$/i.test(file.path));
  const [mediaErr, setMediaErr] = useState(false);
  useEffect(() => setMediaErr(false), [file.path, file.mtime]);
  const fileUrl = api.artifactUrl(repoId, file.path);
  const filesCtx: FileRefCtx = {
    repoId,
    url: (rel, w, mtime) => { const u = api.artifactUrl(repoId, rel); return w ? sized(u, w, mtime) : u; },
    open: onOpenPath,
    // A README's hero, a doc's screenshots: image links resolve against
    // this file's folder (`docImageRef`).
    docPath: file.path,
  };
  // Sized and mtime-versioned like the gallery's viewer — except a GIF (the
  // host's thumbnail of one is a still) and an SVG (nothing to resample).
  const mediaSrc = isVideo(file.path) || /\.(gif|svg)$/i.test(file.path) ? fileUrl : sized(fileUrl, viewerWidth(), file.mtime);
  /** This file, as a download target — the shared button follows the transfer
   *  from here (`DownloadButton.tsx`). */
  const dlTarget = { repoId, relPath: file.path, name: file.path.split("/").pop(), size: file.size, mtime: file.mtime };
  const [text, setText] = useState(file.body ?? "");
  const [note, setNote] = useState<string | null>(null);
  /** A save the host refused as stale. The typed text is untouched — this only
   *  says the next move has to be deliberate. */
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const baseRef = useRef(file.sha ?? "");

  useEffect(() => {
    setText(file.body ?? "");
    baseRef.current = file.sha ?? "";
  }, [file]);

  // Dirty is about the TEXT, not the mode: toggling back to reading with
  // unsaved changes must not hide the Save button and strand them.
  const dirty = text !== (file.body ?? "");
  const canSave = dirty && file.editable && socketOpen && !busy;

  async function save() {
    if (!canSave) return;
    track("action:files.save");
    setBusy(true); setNote(null);
    const r = await api.treeWrite(repoId, file.path, text, baseRef.current).catch(
      () => ({ ok: false as const, error: "the host didn't answer — nothing was written", code: "failed" as const }),
    );
    setBusy(false);
    if (r.ok) {
      baseRef.current = r.sha;
      // Fold the saved text in as the new baseline so the view stops reading
      // dirty, and re-read from disk so mtime/size are the file's, not ours.
      setNote("Saved.");
      setEditing(false);
      void putArtifactText(repoId, file.path, r.mtime, text, false);
      void onReopen();
      return;
    }
    if (r.code === "stale") {
      // The one case that must never be retried blindly: someone — almost
      // always an agent working in this repo — wrote the file while it was open
      // here. Keep both versions and make the user choose.
      setStale(true);
      setNote("Changed on disk since you opened it — nothing was written. Your text is still here; reload to take the version on disk instead.");
      return;
    }
    setNote(r.error);
  }

  async function reload() {
    setBusy(true);
    await onReopen();
    setBusy(false);
    setStale(false); setNote(null); setEditing(false);
  }

  const why = !file.editable
    ? (file.binary ? "binary file"
      : file.truncated ? "too big to edit here — showing the start of it"
      : "read-only (opened from the phone's cache)")
    : !socketOpen ? "the link is down — saving needs the host, and a write held until later would land on a file that moved on"
    : null;

  return (
    <div className="sheet">
      <SheetHead title={file.path} brandClass="mono" onClose={onClose}>
        <Button className={pinned ? "active" : ""}
          title={pinned ? "unpin from the tab strip" : "pin to the tab strip — one tap back to this file from anywhere"}
          aria-pressed={pinned} onClick={togglePin}>
          {pinned ? <PinOff size={16} /> : <Pin size={16} />}
        </Button>
        {reviewable && !editing && (
          <Button className={review ? "active" : ""}
            title={review ? "back to reading — the remarks are kept" : "mark lines and say what should change — sent to the chat as one message"}
            onClick={() => { track("action:files.review"); setReview(!review); }}>
            <MessageSquarePlus size={16} />{remarkCount > 0 && <span className="key-count">{remarkCount}</span>}
          </Button>
        )}
        {file.editable && !review && (
          <Button className={editing ? "active" : ""} title={editing ? "stop editing" : "edit"}
            onClick={() => { track("action:files.edit"); setEditing(!editing); }}>
            {editing ? <Eye size={16} /> : <Pencil size={16} />}
          </Button>
        )}
        {/* Every file, not only a binary one: a text file past the preview cap
            is shown in part, and "the rest" is a download like any other
            (`download.ts`). */}
        <DownloadButton target={dlTarget} compact trackId="action:files.download" />
        <Button title="use this path in the prompt" onClick={() => { onInsertPath(file.path); onClose(); }}><AtSign size={16} /></Button>
      </SheetHead>

      <Hint>
        {fmtSize(file.size)} · {ago(file.mtime)}{why && !review ? ` · ${why}` : ""}{dirty ? " · unsaved" : ""}
        {review && dirty ? " · remarks name the lines as saved on disk, not your unsaved edits" : ""}
        {!review && remarkCount > 0 ? ` · ${remarkCount} remark${remarkCount === 1 ? "" : "s"} waiting` : ""}
        {rendered && !editing && (
          <Button className="md-toggle" onClick={() => setRaw((v) => !v)}>{raw ? "rendered" : "source"}</Button>
        )}
      </Hint>

      {review && onRemarks ? (
        <FileReview key={file.path} repoId={repoId} path={file.path} body={file.body ?? ""}
          rendered={isMarkdown(file.path) && !raw} files={filesCtx}
          onCopy={(t) => void copyText(t)} onCount={setRemarkCount}
          onSend={(t) => onRemarks(file.path, t)} />
      ) : media && !editing && (file.binary || !raw) ? (
        mediaErr ? (
          <Empty>
            Couldn&apos;t load this {isVideo(file.path) ? "clip" : "picture"} — it comes from the desktop, so it needs the link.
            <DownloadButton target={dlTarget} trackId="action:files.download" />
          </Empty>
        ) : isVideo(file.path) ? (
          <video key={mediaSrc} className="viewer-video" src={mediaSrc} controls preload="metadata" onError={() => setMediaErr(true)} />
        ) : (
          // The gallery's stage, not a bare <img>: an architecture diagram on a
          // phone is unreadable until you can pinch into it.
          <ZoomableImage key={mediaSrc} src={mediaSrc} alt={file.path} onError={() => setMediaErr(true)} />
        )
      ) : file.binary ? (
        <Empty>
          Binary — nothing to show.
          {/* The same download every other screen offers (`download.ts`): the
              resumable queue and the Downloads sheet. It was an `<a download>`,
              which is the browser's own download in a tab and NOTHING AT ALL in
              the APK — the one shell where this sheet is most often the only way
              at a file. */}
          <DownloadButton target={dlTarget} trackId="action:files.download" />
        </Empty>
      ) : editing ? (
        <textarea className="code-edit mono" value={text} spellCheck={false}
          autoCapitalize="off" autoCorrect="off" autoComplete="off"
          onChange={(e) => setText(e.target.value)} />
      ) : rendered && !raw ? (
        // The TEXT, not `file.body`: unsaved edits read back formatted too.
        <div className="viewer-doc-body"><Markdown src={text} q="" onCopy={(t) => void copyText(t)} files={filesCtx} /></div>
      ) : (
        <pre className="code-view mono">{text}</pre>
      )}

      {stale && (
        <Hint>
          Saving again would overwrite whatever was written there — so it is not offered. Copy your
          text out if you need it, then reload.
        </Hint>
      )}

      <div className="sheet-actions">
        {/* Never offered while `stale`: re-arming with the fresh base and
            re-sending is the one action that would clobber the other writer. */}
        {dirty && !stale && <button className="send" onClick={save} disabled={!canSave}><Save size={16} /> Save</button>}
        {stale && (
          <Button onClick={async () => setNote(await copyText(text) ? "Your version is on the clipboard." : "Couldn't reach the clipboard — select the text instead.")}>
            <Copy size={16} /> Copy mine
          </Button>
        )}
        {(stale || dirty) && <Button onClick={reload} disabled={busy}>Reload from disk</Button>}
      </div>
      {note && <Hint>{note}</Hint>}
    </div>
  );
}
