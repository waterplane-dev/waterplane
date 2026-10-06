import { Download, Eye, Trash2, TriangleAlert } from "lucide-react";
import { track } from "../usage";
import { Empty } from "../Empty";
import { ConfirmButton } from "../Confirm";
import { isImage, isVideo } from "../docKind";
import { downloadStatus } from "../downloadState";
import { fmtSize } from "../format";
import { GridThumb, GridVideo } from "./GalleryTiles";
import { MARK_TITLE, PAGE, fmtCreated, fmtCreatedFull } from "./galleryTypes";
import type { GalleryModel } from "./useGallery";

/** The tiles (thumbnail, name, date, read / download badges, the inbox delete) and "load more". */
export function GalleryGrid({ m }: { m: GalleryModel }) {
  const { files, loading, loadErr, query, kind, scope, truncated, showFile, badSrc, markBad, urlFor, thumbFor, markOf, pullOf,
    pullBadge, isInboxFile, removeInbox, setLimit } = m;
  return (
    <>
      <div className={`grid${loading && files.length ? " stale" : ""}`}>
        {files.map((f) => (
          <div key={`${f.repoId ?? ""}:${f.relPath}`} className="thumb-wrap">
            <button className="thumb" onClick={() => showFile(f)}>
              {isImage(f.relPath)
                ? <GridThumb url={thumbFor(f)} name={f.name} missing={badSrc.has(thumbFor(f))} onMissing={() => markBad(thumbFor(f))} />
                : isVideo(f.relPath)
                  ? <GridVideo src={urlFor(f)} poster={thumbFor(f)} name={f.name} />
                  : <span className="doc">{f.name.split(".").pop()?.toUpperCase()}</span>}
              <span className="thumb-name">{f.name}</span>
              <span className="thumb-date" title={fmtCreatedFull(f.ctime ?? f.mtime)}>
                {fmtCreated(f.ctime ?? f.mtime)}
                {f.size ? <span className="thumb-size"> · {fmtSize(f.size)}</span> : null}
              </span>
              {f.repoName && <span className="thumb-repo">{f.repoName}</span>}
              <span className="thumb-badges">
                {markOf(f) && !pullOf(f) && (
                  <span className={`thumb-mark ${markOf(f)}`} title={MARK_TITLE[markOf(f)!]}>
                    {markOf(f) === "new" ? "new" : markOf(f) === "downloaded" ? <Download size={11} /> : <Eye size={11} />}
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
              : scope === "outbox"
                ? "Outbox is empty. Agents drop phone-facing artifacts in .claude/outbox or .outbox — ask the agent to save screenshots there. To browse images saved elsewhere in the repo, switch to “this repo”."
                : "Nothing here yet."}
          </Empty>
        )}
      </div>

      {truncated && (
        <div className="annot-tools">
          <button className="key" onClick={() => { track("action:gallery.more"); setLimit((n) => n + PAGE); }}>
            load {PAGE} more
          </button>
          <span className="viewer-doc-note">showing the newest {files.length}</span>
        </div>
      )}
    </>
  );
}
