import { useEffect, useState } from "react";
import { CloudDownload, Download, Loader2, Smartphone, TriangleAlert } from "lucide-react";
import { api, copyText, isOffline } from "../api";
import { track } from "../usage";
import { isHtml, isImage } from "../docKind";
import { artifactMark } from "../artifactMarks";
import { pulls, type PullRecord } from "../pull";
import { downloadStatus } from "../downloadState";
import { canFullRes, repoOfRow, thumbForRow, urlForRow, viewForRow } from "./galleryUrls";
import type { GalleryProps, Row } from "./galleryTypes";
import { useGalleryOpen } from "./useGalleryOpen";
import { useGalleryListing } from "./useGalleryListing";
import { useGalleryViewer } from "./useGalleryViewer";
import { useGalleryPick } from "./useGalleryPick";

/**
 * Everything the gallery's three regions (bar, grid, viewer) read and call.
 *
 * Hook order is the original component's: the open file (and its Back step),
 * the pull subscription, the listing's effects, then the viewer's, then the
 * local copy and the keyboard — effect ORDER is behaviour.
 */
export function useGallery(props: GalleryProps) {
  const { repoId, openFile, onClose } = props;
  const { open, showFile, closeDoc } = useGalleryOpen({ openFile, onClose });
  const [copied, setCopied] = useState<string | null>(null);
  // Transient confirmation for actions the app hands off and can no longer see —
  // a browser download is the case that matters: on a slow link the tap has no
  // visible effect at all until the browser's own UI catches up, so it reads as
  // a dead button and gets tapped again (two transfers on a bad link both
  // finish later than one).
  const [note, setNote] = useState<string | null>(null);
  const say = (msg: string) => { setNote(msg); window.setTimeout(() => setNote((n) => (n === msg ? null : n)), 4000); };
  // Image URLs that failed to load — offline, host gone, or the file was deleted
  // under us. Keyed by SRC (not by row) so re-rendering can't remount the same
  // failing <img> in a retry loop, and so asking for a different width or a
  // regenerated file (`v=<mtime>` changes) gets a fresh attempt for free.
  // Without this the grid shows the browser's broken-image glyph — an unlabelled
  // grey box that reads as a bug rather than as "this file didn't arrive".
  const [badSrc, setBadSrc] = useState<Set<string>>(new Set());
  const markBad = (src: string) => setBadSrc((prev) => (prev.has(src) ? prev : new Set(prev).add(src)));
  // Auto-download state per file (pull.ts). The grid is where a download is
  // STARTED ("to phone"), so it is also where "you already have this" has to be
  // visible — otherwise the same 90 MB APK gets queued a second time because the
  // tile looks exactly like it did before.
  const [pullRecs, setPullRecs] = useState<PullRecord[]>([]);
  useEffect(() => pulls.subscribe(setPullRecs), []);
  const lst = useGalleryListing(props);
  const { scope, files, loading, setReload } = lst;
  const vw = useGalleryViewer({ open, scope, repoId });
  const { fullRes, docRaw, markTick } = vw;

  /** Chip class — `busy` marks the chip whose listing is on the wire, so the tap
   *  keeps its highlight (and a spinner) instead of releasing back to plain. */
  const busyMark = (active: boolean) => (active && loading ? <> <Loader2 size={12} className="spin" /></> : null);

  const repoOf = (f: Row) => repoOfRow(repoId, f);
  const urlFor = (f: Row) => urlForRow(scope, repoId, f);
  const thumbFor = (f: Row) => thumbForRow(scope, repoId, f);
  const viewFor = (f: Row) => viewForRow(scope, repoId, fullRes, f);

  // Inbox files (phone→repo uploads) are the only deletable artifacts.
  const isInboxFile = (f: Row) => scope === "inbox" || f.relPath.startsWith(".claude/inbox/");

  // Read/download state of a row. "new" is only worth saying in the outbox —
  // that tab is a stream of agent drops you are meant to work through. The
  // repo/all-repos tabs list arbitrary existing files, where "never opened in
  // the app" is the boring default and badging all of it would be noise; there
  // only a positive opened/downloaded mark shows. `markTick` is read so the
  // memo-free render re-evaluates after a mark.
  const markOf = (f: Row) => {
    void markTick;
    if (scope === "inbox") return null;
    const m = artifactMark(repoOf(f), f.relPath, f.mtime);
    return m === "new" && scope !== "outbox" ? null : m;
  };

  /** Auto-download record for a row, matched on repo + path + mtime. The mtime is
   *  part of the match on purpose: a rebuilt artifact at the same path is a
   *  different file, and reporting the previous build as "on this phone" is the
   *  one wrong answer here (same rule as artifactMarks). */
  const pullOf = (f: Row): PullRecord | undefined => {
    const repo = repoOf(f);
    return pullRecs.find((r) =>
      r.item.repoId === repo && r.item.relPath === f.relPath
      && Math.round(r.item.mtime) === Math.round(f.mtime));
  };
  /** What a download button needs to know about a row: the file's identity
   *  (repo + path + mtime — a rebuilt artifact is a different file) plus the
   *  labels a queue row shows. */
  const dlTarget = (f: Row) => ({
    repoId: repoOf(f), relPath: f.relPath, name: f.name,
    size: f.size, mtime: f.mtime, repoName: f.repoName,
  });
  /** Badge contents for a pull record — deliberately NOT the eye/read mark's
   *  vocabulary: a phone icon for bytes that are here, a spinner + percent while
   *  they are arriving. The PHASE comes from `downloadState.ts`, so the badge
   *  and the button under the open file cannot claim different things — in
   *  particular an EVICTED record, which is `done` with no bytes, and which this
   *  badge used to label "on phone". */
  const pullBadge = (rec: PullRecord) => {
    const st = downloadStatus(rec);
    if (st.phase === "have" || st.phase === "saved") return <><Smartphone size={11} /> on phone</>;
    if (st.phase === "downloading") return <><Loader2 size={11} className="spin" /> {st.pct}%</>;
    if (st.phase === "failed") return <><TriangleAlert size={11} /> stopped</>;
    if (st.phase === "idle") return <><Download size={11} /> was here</>;
    return <><CloudDownload size={11} /> queued</>;
  };

  // ── Bytes already on this phone ──────────────────────────────────────
  // A finished auto-download IS the original file. Rendering the viewer from it
  // beats the network on every count: it works with the tunnel down, it costs
  // no bytes, and it is full resolution without asking anyone. Only `done`
  // records qualify — a half-downloaded blob would paint a truncated image and
  // look like a corrupt file rather than an interrupted transfer.
  const openPull = open ? pullOf(open) : undefined;
  const localPullId = openPull?.state === "done" ? openPull.item.id : null;
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  useEffect(() => {
    setLocalUrl(null);
    if (!localPullId) return;
    let url: string | null = null;
    let dead = false;
    void pulls.objectUrl(localPullId).then((u) => {
      if (!u) return;
      if (dead) { URL.revokeObjectURL(u); return; }   // closed while we were reading
      url = u;
      setLocalUrl(u);
    });
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [localPullId]);

  /** Viewer source for the open file: the local original when this phone has it,
   *  else the served (screen-width) copy. Downloads and annotation deliberately
   *  keep using `urlFor` — those hand a URL to something else. */
  const mediaSrc = (f: Row) => localUrl ?? viewFor(f);
  const fileSrc = (f: Row) => localUrl ?? urlFor(f);

  /** An HTML file being PAINTED rather than read as tags. It is its own state
   *  because three places downstream ask the same question — the frame, the two
   *  notes about the fetched text, and the "saved copy" line under the path —
   *  and a second spelling of it is how one of them comes to lie. */
  const htmlLive = !!open && isHtml(open.relPath) && !docRaw;

  // Swipe/arrow navigation in the viewer walks the images of the current grid, in grid order.
  const imgs = files.filter((f) => isImage(f.relPath));
  const openIdx = open ? imgs.findIndex((f) => f.relPath === open.relPath && f.repoId === open.repoId) : -1;
  function nav(dir: 1 | -1) {
    const next = openIdx >= 0 ? imgs[openIdx + dir] : undefined;
    if (next) showFile(next);
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") nav(1);
      else if (e.key === "ArrowLeft") nav(-1);
      // preventDefault: answered here, so `core/layout/escape.ts` adds no second Back.
      else if (e.key === "Escape") { e.preventDefault(); closeDoc(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Delete is a WRITE, and writes have no offline half: the file lives on the
   *  desktop. Say that instead of throwing into the console and leaving the row
   *  on screen, which reads as "the delete button is broken". */
  async function removeInbox(f: Row): Promise<boolean> {
    try {
      await api.deleteInbox(repoOf(f), f.name);
      setReload((n) => n + 1);
      return true;
    } catch (e) {
      say(isOffline(e)
        ? `Could not delete ${f.name} — the host didn't answer. The file is still on the desktop.`
        : `Could not delete ${f.name} — ${String((e as Error)?.message || e)}`);
      return false;
    }
  }
  async function del(f: Row) {
    track("action:gallery.delete");
    // Not `closeDoc`: the file is GONE, and the grid re-reading without it is
    // the receipt for that. A direct open lands on a listing it did not ask
    // for, which is the one case where that listing is worth showing.
    if (await removeInbox(f)) showFile(null);
  }

  // Picking pictures to combine (`useGalleryPick`).
  const pick = useGalleryPick({ onCombine: props.onCombine, singleRepo: lst.singleRepo, files, repoOf, urlFor });

  async function copy(p: string) {
    const ok = await copyText(p);
    setCopied(ok ? p : null);
    setTimeout(() => setCopied(null), 1500);
  }

  return {
    props, ...lst, ...vw, open, showFile, closeDoc, copied, note, badSrc, markBad, busyMark,
    repoOf, urlFor, thumbFor, canFullRes, isInboxFile, markOf, pullOf, dlTarget, pullBadge,
    localUrl, mediaSrc, fileSrc, htmlLive, imgs, openIdx, nav, removeInbox, del, copy,
    ...pick,
  };
}

export type GalleryModel = ReturnType<typeof useGallery>;
