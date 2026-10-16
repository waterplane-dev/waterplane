import { useState } from "react";
import { Check, ChevronLeft, CloudOff, FileQuestion, Pencil, Smartphone, X } from "lucide-react";
import { track } from "../usage";
import { api, copyText } from "../api";
import { ZoomableImage } from "../ZoomableImage";
import { Markdown } from "../Markdown";
import { Empty } from "../Empty";
import { DownloadButton } from "../DownloadButton";
import { isAudio, isMarkdown, isPdf, isRich, isText, isImage, isVideo } from "../docKind";
import { sized } from "../media";
import { startDownload } from "../download";
import { PREVIEW_MAX, fmtCreated, fmtCreatedFull } from "./galleryTypes";
import type { GalleryModel } from "./useGallery";
import { SessionPickButtons, SessionPickList } from "./GallerySessionPick";

/** The open file: image / video / document / pdf / audio body, its path lines and the action bar. */
export function GalleryViewer({ m }: { m: GalleryModel }) {
  const { open, closeDoc, repoOf, localUrl, fullRes, mediaSrc, fileSrc, imgs, nav, setDocRaw, docRaw, doc, docErr, docCachedAt,
    htmlLive, pullOf, dlTarget, files, showFile, openIdx, copied, copy, canFullRes, setFullRes, urlFor, setMarkTick,
    isInboxFile, del, note } = m;
  const { onAnnotate, onInsertPath, onClose } = m.props;
  const [picking, setPicking] = useState<string | null>(null); // the *to session* list, for THIS file only
  if (!open) return null;
  const pick = { relPath: open.relPath, repoId: repoOf(open), repoName: open.repoName, props: m.props, picking: picking === open.relPath, setPicking: (v: boolean) => setPicking(v ? open.relPath : null) };
  return (
        <div className="viewer" onClick={() => closeDoc()}>
          <button className="viewer-close" onClick={() => closeDoc()} aria-label="close"><X size={22} /></button>
          <div className="viewer-body" onClick={(e) => e.stopPropagation()}>
            {isImage(open.relPath)
              ? <ZoomableImage key={`${repoOf(open)}:${open.relPath}:${localUrl ? "local" : fullRes ? "full" : "fit"}`} src={mediaSrc(open)} alt={open.name} onNav={imgs.length > 1 ? nav : undefined} />
              : isVideo(open.relPath)
                ? <video key={`${repoOf(open)}:${open.relPath}:${localUrl ? "local" : "net"}`} className="viewer-video" src={fileSrc(open)} controls autoPlay playsInline />
                : isText(open.relPath)
                  ? (
                    <div className="viewer-doc">
                      {isRich(open.relPath) && (
                        <div className="viewer-doc-bar">
                          <button className="key" onClick={() => setDocRaw((v) => !v)}>{docRaw ? "rendered" : "source"}</button>
                          {/* Both notes are about the TEXT this viewer fetched, so
                              neither is true of a frame painting the file itself. */}
                          {doc?.truncated && !htmlLive && <span className="viewer-doc-note">showing the first {Math.round(PREVIEW_MAX / 1000)} KB — download for the rest</span>}
                          {docCachedAt != null && !htmlLive && <span className="viewer-doc-note"><CloudOff size={12} /> saved copy from {fmtCreated(docCachedAt)}</span>}
                        </div>
                      )}
                      {htmlLive
                        /* Ahead of the text gates on purpose: a rendered page needs
                           no fetched text, so a doc read that failed or is still in
                           flight must not stand between you and the picture. The
                           FILE, not `doc.text`, which is cut at PREVIEW_MAX — half a
                           document renders as a broken one. `sandbox` without
                           `allow-same-origin` puts it on an opaque origin: its
                           scripts run, and its `Origin: null` is refused by the
                           host's own guard (origin.ts), so an artifact cannot call
                           the API that produced it. */
                        ? <iframe key={`${repoOf(open)}:${open.relPath}:${localUrl ? "local" : "net"}`} className="viewer-html" src={fileSrc(open)} title={open.name} sandbox="allow-scripts" referrerPolicy="no-referrer" />
                        : docErr
                        ? <Empty>Could not load this file ({docErr}). <DownloadButton rec={pullOf(open)} target={dlTarget(open)} /></Empty>
                        : !doc || doc.path !== open.relPath
                          ? <Empty>Loading…</Empty>
                          : isMarkdown(open.relPath) && !docRaw
                            ? <div className="viewer-doc-body"><Markdown src={doc.text} q="" onCopy={(t) => copyText(t)}
                              files={{
                                // A report in the outbox routinely points at the screenshots
                                // next to it — render those inline instead of as dead text.
                                // Versioned when this device knows the mtime, which is what
                                // lets those inline pictures come out of the same cache the
                                // grid behind this viewer filled (fileMtime.ts).
                                repoId: repoOf(open!),
                                url: (rel, w, mtime) => { const u = api.artifactUrl(repoOf(open!), rel); return w ? sized(u, w, mtime) : u; },
                                // A mention of a file this listing does not hold: fetch it
                                // rather than navigating at it — a tab is not an answer in
                                // the APK, where `_blank` replaces the app in place.
                                open: (rel) => { const hit = files.find((f) => f.relPath === rel); if (hit) showFile(hit); else startDownload({ repoId: repoOf(open!), relPath: rel }); },
                                // The listing this viewer is sitting on top of, so a
                                // report that names its screenshots by bare filename
                                // resolves them (fileRefs.ts `bareFileRef`). Same repo
                                // only — a basename is not unique across repos.
                                known: files.filter((f) => repoOf(f) === repoOf(open!)).map((f) => f.relPath),
                                // Image links in the report resolve against its folder.
                                docPath: open.relPath,
                              }} /></div>
                            : <pre className="viewer-doc-pre">{doc.text}{doc.truncated ? "\n… (truncated — download for the rest)" : ""}</pre>}
                    </div>
                  )
                  : isAudio(open.relPath)
                    ? <audio key={`${repoOf(open)}:${open.relPath}:${localUrl ? "local" : "net"}`} className="viewer-audio" src={fileSrc(open)} controls preload="metadata" />
                    : isPdf(open.relPath)
                      ? (
                        <div className="viewer-doc">
                          <iframe className="viewer-pdf" src={fileSrc(open)} title={open.name} />
                          <div className="viewer-doc-note">
                            <DownloadButton rec={pullOf(open)} target={dlTarget(open)} /> if the preview stays blank
                          </div>
                        </div>
                      )
                      : (
                        /* Nothing this viewer can render (an .apk, an archive).
                           A sentence that FILLS the body, deliberately with no
                           download button of its own: the action bar below
                           already carries the one download button this app has
                           (`DownloadButton`), and the pair drew the same control
                           twice. The top copy was also the one that got cut in
                           half — a bare flex item in a body that has no top
                           padding by design (`.viewer-close`'s comment) sits
                           under the connection strip, and it dragged the path
                           lines up under the close button with it. */
                        <div className="viewer-none">
                          <FileQuestion size={28} />
                          <span>no preview for this kind of file — the actions below download it or copy its path</span>
                        </div>
                      )}
            <div className="viewer-path mono">{open.repoName ? `${open.repoName} · ` : ""}{open.relPath}</div>
            <div className="viewer-path">created {fmtCreatedFull(open.ctime ?? open.mtime)}{openIdx >= 0 && imgs.length > 1 ? ` · ${openIdx + 1} / ${imgs.length}` : ""}</div>
            {localUrl && <div className="viewer-doc-note"><Smartphone size={12} /> shown from the copy already on this phone — no host needed</div>}
            {/* A doc with a toolbar of its own already says up there that it is a
                saved copy; everything else says it here, where it is READ. */}
            {docCachedAt != null && !isRich(open.relPath) && (
              <div className="viewer-doc-note"><CloudOff size={12} /> saved copy from {fmtCreated(docCachedAt)}</div>
            )}
            <div className="sheet-actions">
              <button className="key" onClick={() => closeDoc()}><ChevronLeft size={16} /> back</button>
              <button className="key" onClick={() => copy(open.relPath)}>{copied === open.relPath ? <><Check size={16} /> copied</> : "copy path"}</button>
              {canFullRes(open) && !fullRes && !localUrl && (
                <button className="key" data-hint="gallery.fullres" title="load the original file instead of the screen-sized copy" onClick={() => { track("action:gallery.fullres"); setFullRes(true); }}>
                  full res{open.size ? ` (${Math.round(open.size / 1024)} KB)` : ""}
                </button>
              )}
              {isImage(open.relPath) && <button className="key" onClick={() => { track("action:gallery.annotate"); onAnnotate(urlFor(open!), open!.name, repoOf(open!)); }}><Pencil size={16} /> annotate</button>}
              {/* ONE download button, the same one every screen in this app
                  shows (`download.ts`): the resumable queue, the Downloads
                  sheet, and the device hand-off that says where it landed. The
                  pair that used to sit here — a raw `<a download>` and a
                  separate "to phone" — did different things in the browser and
                  in the APK, where the anchor silently did nothing at all. */}
              <DownloadButton rec={pullOf(open!)} target={dlTarget(open!)} trackId="action:gallery.download"
                /* Marked when the bytes are HERE, not when the tap happened: a
                 transfer that fails would otherwise leave the grid claiming the
                 file was downloaded. The pull record is what says "asked for",
                 and it draws its own badge. */
              onStart={() => setMarkTick((n) => n + 1)} />
              {isInboxFile(open) && <button className="key danger" onClick={() => del(open!)}>delete</button>}
              <SessionPickButtons {...pick} />
              <button className="send" onClick={() => { onInsertPath(open.relPath); onClose(); }}>insert path</button>
            </div>
            <SessionPickList {...pick} />
            {note && <div className="viewer-doc-note">{note}</div>}
          </div>
        </div>
  );
}
