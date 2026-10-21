import { Download, Eye, Trash2, TriangleAlert } from "lucide-react";
import { DocIcon } from "./DocIcon";
import { track } from "../usage";
import { Empty } from "../Empty";
import { ConfirmButton } from "../Confirm";
import { isImage, isVideo } from "../docKind";
import { downloadStatus } from "../downloadState";
import { fmtSize } from "../format";
import { GridThumb, GridVideo } from "./GalleryTiles";
import { MARK_TITLE, PAGE, fmtCreated, fmtCreatedFull } from "./galleryTypes";
import { emptyCutText } from "./galleryCuts";
import { GalleryPickBar } from "./GalleryPickBar";
import type { GalleryModel } from "./useGallery";
import { Button } from "../kit/Button";

/** The tiles (thumbnail, name, date, read / download badges, the inbox delete) and "load more". */
export function GalleryGrid({ m }: { m: GalleryModel }) {
  const { files, loading, loadErr, query, kind, scope, truncated, showFile, badSrc, markBad, urlFor, thumbFor, markOf, pullOf,
    pullBadge, isInboxFile, removeInbox, setLimit, onNewCut, since, setSince, setOnNewCut } = m;
  /** Inside the badge's own cut every tile is new and the bar says so once: no mark per tile. */
  const shownMark = (f: Parameters<typeof markOf>[0]) => (onNewCut && markOf(f) === "new" ? null : markOf(f));
  const cutEmpty = scope !== "inbox" && !onNewCut ? emptyCutText(since) : null;
  const { picked, pickIndex, togglePicked } = m;
  return (
    <>
      <GalleryPickBar m={m} />
      <div className={`grid${loading && files.length ? " stale" : ""}`}>
        {files.map((f) => (
          <div key={`${f.repoId ?? ""}:${f.relPath}`} className={`thumb-wrap${pickIndex(f) >= 0 ? " picked" : ""}`}>
            {picked && pickIndex(f) >= 0 && <span className="thumb-pick" aria-hidden="true">{pickIndex(f) + 1}</span>}
            <button className="thumb" aria-pressed={picked && isImage(f.relPath) ? pickIndex(f) >= 0 : undefined}
              onClick={() => (picked ? togglePicked(f) : showFile(f))}>
              {isImage(f.relPath)
                ? <GridThumb url={thumbFor(f)} name={f.name} missing={badSrc.has(thumbFor(f))} onMissing={() => markBad(thumbFor(f))} />
                : isVideo(f.relPath)
                  ? <GridVideo src={urlFor(f)} poster={thumbFor(f)} name={f.name} />
                  : <DocIcon name={f.name} />}
              <span className="thumb-name">{f.name}</span>
              <span className="thumb-date" title={fmtCreatedFull(f.ctime ?? f.mtime)}>
                {fmtCreated(f.ctime ?? f.mtime)}
                {f.size ? <span className="thumb-size"> · {fmtSize(f.size)}</span> : null}
              </span>
              {f.repoName && <span className="thumb-repo">{f.repoName}</span>}
              <span className="thumb-badges">
                {/* "new" is a dot (the unread mark), not a worded pill on every fresh tile. */}
                {shownMark(f) && !pullOf(f) && (
                  <span className={`thumb-mark ${shownMark(f)}`} title={MARK_TITLE[shownMark(f)!]}>
                    {shownMark(f) === "new" ? <span className="sr-only">new</span> : shownMark(f) === "downloaded" ? <Download size={11} /> : <Eye size={11} />}
                  </span>
                )}
                {/* Never both badges: the read mark's `downloaded` and the pull
                    badge's "on phone" are the same claim in two vocabularies,
                    and the pull record is the one that KNOWS (the mark is a
                    localStorage note, the record is bytes). */}
                {pullOf(f) && (
                  <span className={`thumb-pull ${pullOf(f)!.state}`} title={downloadStatus(pullOf(f)).detail}>
                    {pullBadge(pullOf(f)!)}
                  </span>
                )}
              </span>
            </button>
            {isInboxFile(f) && (
              // Two taps on the tile's own × (`Confirm.tsx`), not a native
              // modal: a delete is destructive, this button is thumb-sized and
              // sits under a scrolling grid, and `window.confirm` blocked the
              // WebView's event loop to ask.
              <ConfirmButton className="thumb-del" title={`delete ${f.name}`}
                confirmTitle={`tap again to delete ${f.name}`}
                confirm={<TriangleAlert size={14} />}
                onConfirm={() => { void removeInbox(f); }}>
                <Trash2 size={14} />
              </ConfirmButton>
            )}
          </div>
        ))}
        {/* First load with nothing to keep: skeleton tiles, so the grid area
            reads as "filling in" rather than as an empty result. */}
        {files.length === 0 && loading && Array.from({ length: 8 }, (_, i) => (
          <div key={`skel-${i}`} className="thumb-wrap"><div className="thumb skel-thumb" /></div>
        ))}
        {files.length === 0 && !loading && !loadErr && (
          <Empty>
            {query || kind !== "all"
              ? "No matches."
              // Only the time cut hides things: say that, with the way out ("empty" was false).
              : cutEmpty
                ? <>{cutEmpty} <button className="link-btn" onClick={() => { setSince(undefined); setOnNewCut(false); }}>show older files</button></>
                : scope === "outbox"
                  ? "The outbox is empty. Claude puts screenshots and files meant for your phone in .claude/outbox. To see images anywhere in the repo, switch to this repo."
                  : "Nothing here yet."}
          </Empty>
        )}
      </div>

      {truncated && (
        <div className="annot-tools">
          <Button onClick={() => { track("action:gallery.more"); setLimit((n) => n + PAGE); }}>
            load {PAGE} more
          </Button>
          <span className="viewer-doc-note">showing the newest {files.length}</span>
        </div>
      )}
    </>
  );
}
