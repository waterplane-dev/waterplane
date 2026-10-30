import { useEffect, useState } from "react";
import { bgFetch, isOffline } from "../api";
import { getArtifactText, putArtifactText } from "../offlineCache";
import { isText } from "../docKind";
import { markArtifactOpened } from "../artifactMarks";
import { PREVIEW_MAX, type Row, type Scope } from "./galleryTypes";
import { repoOfRow, urlForRow } from "./galleryUrls";

/** What the open file needs beyond its row: the full-res opt-in, the read mark, and the document text. */
export function useGalleryViewer({ open, scope, repoId }: { open: Row | null; scope: Scope; repoId: string | undefined }) {
  // Viewer: images arrive screen-sized by default; this opts the open file back
  // to the original bytes (for pixel-peeping / zooming past the served width).
  const [fullRes, setFullRes] = useState(false);
  // Inline text/markdown preview of the open document.
  const [doc, setDoc] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [docErr, setDocErr] = useState<string | null>(null);
  // The open document is the copy this phone saved, from this instant.
  const [docCachedAt, setDocCachedAt] = useState<number | null>(null);
  const [docRaw, setDocRaw] = useState(false);
  // Bumped whenever a read/download mark changes, so the grid badges repaint
  // (the marks live in localStorage, not in React state).
  const [markTick, setMarkTick] = useState(0);

  // Every newly opened file starts at the served width; "full res" is per-open.
  useEffect(() => { setFullRes(false); }, [open?.relPath, open?.repoId]);

  // Opening a file in the viewer is what "I looked at this" means — mark it,
  // including when swipe/arrow nav walks to the next image. Inbox files are
  // phone→repo uploads, so a read mark on them says nothing.
  useEffect(() => {
    if (!open || scope === "inbox") return;
    markArtifactOpened(repoOfRow(repoId, open), open.relPath, open.mtime);
    setMarkTick((n) => n + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mark once per opened file (path + repo); `open` is a fresh object per listing while the same file stays open
  }, [open?.relPath, open?.repoId, scope]);

  // Fetch the open document's text so the viewer can render it in place. Kept
  // out of the grid load: it's one file, only when you actually open it — and
  // cached per path+mtime, because an outbox report is exactly the thing you
  // open once on wifi and want to READ on the train.
  useEffect(() => {
    setDocErr(null);
    setDocRaw(false);
    setDocCachedAt(null);
    if (!open || !isText(open.relPath)) { setDoc(null); return; }
    const ac = new AbortController();
    let live = false;
    const path = open.relPath;
    const repo = repoOfRow(repoId, open);
    const mtime = open.mtime;
    /**
     * **An un-versioned document is cacheable by nobody** — `fileMtime.ts`'s
     * rule, which was written for thumbnail URLs and is the same rule here.
     *
     * `open.mtime` is 0 whenever the viewer was seeded from a payload that
     * carried no version (`galleryCtxForFile` without one: a notification
     * about an artifact, `AssessSheet`'s *read the plan*). The document cache
     * is keyed on `(repo, relPath, mtime)` precisely so that a regenerated
     * report at the same path is a different document — but with mtime 0
     * every rewrite of one path collapses onto a SINGLE key, and the viewer
     * paints the cached hit first. the repo's plan file is rewritten at the same
     * path by every assessment run, so run A's plan would be served under run
     * B's verdicts, labelled only "saved copy from <date>": one run's evidence
     * under another run's conclusions, which is `settle.ts`'s `spendTurn`
     * problem on a screen a person approves with one tap.
     *
     * So an un-versioned open skips BOTH halves: no read, no write. Fresh
     * bytes or nothing — never somebody else's copy of the same path. It
     * costs exactly the offline copy that was never safe to keep, and it is
     * the general answer: any future caller that opens a path without a
     * version gets the same treatment without having to know about this.
     * Every gallery row carries the listing's mtime, so the ordinary open
     * caches precisely as it always did.
     */
    const versioned = mtime > 0;
    const showCached = async (): Promise<boolean> => {
      const hit = versioned ? await getArtifactText(repo, path, mtime) : null;
      if (ac.signal.aborted || live || !hit) return false;
      setDoc({ path, text: hit.text, truncated: hit.truncated });
      setDocCachedAt(hit.savedAt);
      return true;
    };
    void showCached();     // paints instantly offline; replaced below when the file arrives
    bgFetch(urlForRow(scope, repoId, open), { signal: ac.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => {
        if (ac.signal.aborted) return;
        live = true;
        const cut = { path, text: text.slice(0, PREVIEW_MAX), truncated: text.length > PREVIEW_MAX };
        setDoc(cut); setDocCachedAt(null);
        // The mtime is part of the key: a regenerated report at the same path is
        // a different document, and serving yesterday's under today's name is
        // the one wrong answer here. With no mtime there is no key that can
        // tell those apart, so nothing is written at all (see `versioned`).
        if (versioned) void putArtifactText(repo, path, mtime, cut.text, cut.truncated);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        void showCached().then((had) => {
          if (ac.signal.aborted || had) return;
          setDoc(null);
          setDocErr(isOffline(e) ? "the host didn't answer, and this device has no saved copy" : String(e?.message || e));
        });
      });
    return () => ac.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload per opened file (path + repo); `open` is a fresh object per listing while the same file stays open
  }, [open?.relPath, open?.repoId, scope]);
  return { fullRes, setFullRes, doc, docErr, docCachedAt, docRaw, setDocRaw, markTick, setMarkTick };
}
