/**
 * What a session's turn produced, on the two screens: the strip above the
 * compose bar (thumbs, `ref`, fold, dismiss), the launcher row's count chip,
 * and the session toolbar's `inbox` count. A count is a filter: each opens
 * exactly what it counted.
 */
import { FileText, Images, Minimize2, X } from "lucide-react";
import type { RepoTarget } from "@waterplane/shared";
import { api } from "../../api";
import { pickThumbWidth, sized } from "../../media";
import { useNewImagesMinimized, useNewImagesOf } from "./store";
import {
  browseNewImages, dismissNewImages, minimizeNewImages, openFileRef, openNewImages, openOutboxFor, referenceNewImage, restoreNewImages,
} from "./actions";
import { isMarkdownPath, isVideoPath, isViewable } from "./logic";
import { Button, Tag } from "../../kit";

/** The folder a document sits in, for its tile: the last path segment before the name. */
function docFolder(relPath: string): string {
  const parts = relPath.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

/** The session screen's strip, or its folded pill; nothing with no new files.
 *  Pictures open the swipeable viewer; a markdown tile opens the reader. */
export function NewImagesStrip({ sessionId }: { sessionId: string }) {
  const list = useNewImagesOf(sessionId);
  const folded = useNewImagesMinimized(sessionId);
  if (!list.length) return null;
  if (folded) return (
    <button className="newimg-pill" onClick={() => restoreNewImages(sessionId)} title="show new files">
      <Images size={14} /> new {list.length}
    </button>
  );
  return (
    <div className="newimg-strip">
      {/* One narrow column, not three side by side: the row is the thumbs'. */}
      <div className="newimg-ctl">
        <span className="newimg-label"><Images size={14} /> new {list.length}</span>
        <div className="newimg-ctl-btns">
          <button className="newimg-min" onClick={() => minimizeNewImages(sessionId)} title="minimize"><Minimize2 size={14} /></button>
          <button className="newimg-x" onClick={() => dismissNewImages(sessionId)} title="dismiss"><X size={14} /></button>
        </div>
      </div>
      {list.map((im) => {
        const ext = (im.name.split(".").pop() || "").toUpperCase();
        if (isMarkdownPath(im.relPath)) return (
          <div key={im.relPath} className="newimg">
            <button className="newimg-thumb newimg-doc" onClick={() => openFileRef(im.repoId, im.relPath)}
              title={`${im.relPath} — ${im.changed ? "edited" : "new"} this session · tap to read`}>
              <FileText size={14} />
              <span className="newimg-doc-name">{im.name}</span>
              {/* Several SKILL.md / README.md in one turn are told apart only
                  by the folder they live in. */}
              {docFolder(im.relPath) && <span className="newimg-doc-dir">{docFolder(im.relPath)}</span>}
              <span className="newimg-doc-type">{im.changed ? `${ext} · edited` : ext}</span>
            </button>
            <button className="newimg-ref" onClick={() => referenceNewImage(im)} title={`insert path: ${im.relPath}`}>ref</button>
          </div>
        );
        const vid = isVideoPath(im.relPath);
        return (
          <div key={im.relPath} className="newimg">
            <button className="newimg-thumb" onClick={() => browseNewImages(sessionId, im)} title={`${im.name} — tap to open · swipe between images`}>
              {/* Thumbnails, not originals: this strip appears on every turn
                  that produced a screenshot, and the originals average ~600 KB
                  each. preload="none" + a server poster frame keeps video rows
                  from pulling the movie. */}
              {vid
                ? <video src={api.artifactUrl(im.repoId, im.relPath)}
                         poster={sized(api.artifactUrl(im.repoId, im.relPath), pickThumbWidth(120), im.mtime)}
                         muted playsInline preload="none" />
                : <img src={sized(api.artifactUrl(im.repoId, im.relPath), pickThumbWidth(120), im.mtime)} alt={im.name} loading="lazy" decoding="async" />}
              {ext && <span className="newimg-type">{ext}</span>}
            </button>
            <button className="newimg-ref" onClick={() => referenceNewImage(im)} title={`insert path: ${im.relPath}`}>ref</button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The launcher row's count of new images — a tap opens them full-screen. A
 * span with role="button" rather than a real <button>, exactly like
 * `statusTags`' filter pill beside it: these read as one row of FACTS, and a
 * chip built as a button would wear the strip's button styling.
 */
export function NewImagesTag({ sessionId }: { sessionId: string }) {
  // Pictures only: the tap opens the viewer, and a count opens exactly what it counted.
  const n = useNewImagesOf(sessionId).filter((im) => isViewable(im.relPath)).length;
  if (n <= 0) return null;
  return (
    <Tag className="img tag-filter" role="button" tabIndex={0}
      title={`${n} new image${n > 1 ? "s" : ""} from this session — tap to browse them`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openNewImages(sessionId); } }}
      onClick={(e) => { e.stopPropagation(); openNewImages(sessionId); }}>
      <Images size={12} /> {n}
    </Tag>
  );
}

/** The toolbar's `inbox`: new outbox files since this repo was last opened. */
export function InboxToolbarItem({ repo, dismiss }: { repo: RepoTarget | null; dismiss(): void }) {
  if (!repo || repo.outboxCount <= 0) return null;
  return <Button key="inbox" className="count" title={`${repo.outboxCount} new outbox file${repo.outboxCount > 1 ? "s" : ""} since last opened — open gallery`}
    onClick={() => { dismiss(); openOutboxFor(repo.id); }}><Images size={16} /> {repo.outboxCount}</Button>;
}
