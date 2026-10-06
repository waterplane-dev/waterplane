/**
 * What a session's turn produced, on the two screens: the strip above the
 * compose bar (thumbs, `ref`, fold, dismiss), the launcher row's count chip,
 * and the session toolbar's `inbox` count. A count is a filter: each opens
 * exactly what it counted.
 */
import { Images, Minimize2, X } from "lucide-react";
import type { RepoTarget } from "@waterplane/shared";
import { api } from "../../api";
import { pickThumbWidth, sized } from "../../media";
import { useNewImagesMinimized, useNewImagesOf } from "./store";
import {
  browseNewImages, dismissNewImages, minimizeNewImages, openNewImages, openOutboxFor, referenceNewImage, restoreNewImages,
} from "./actions";
import { isVideoPath } from "./logic";

/** The session screen's strip, or its folded pill; nothing with no new images. */
export function NewImagesStrip({ sessionId }: { sessionId: string }) {
  const list = useNewImagesOf(sessionId);
  const folded = useNewImagesMinimized(sessionId);
  if (!list.length) return null;
  if (folded) return (
    <button className="newimg-pill" onClick={() => restoreNewImages(sessionId)} title="show new images">
      <Images size={14} /> new {list.length}
    </button>
  );
  return (
    <div className="newimg-strip">
      <button className="newimg-x" onClick={() => dismissNewImages(sessionId)} title="dismiss"><X size={14} /></button>
      <button className="newimg-min" onClick={() => minimizeNewImages(sessionId)} title="minimize"><Minimize2 size={14} /></button>
      <span className="newimg-label"><Images size={14} /> new {list.length}</span>
      {list.map((im) => {
        const ext = (im.name.split(".").pop() || "").toUpperCase();
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
  const n = useNewImagesOf(sessionId).length;
  if (n <= 0) return null;
  return (
    <span className="tag img tag-filter" role="button" tabIndex={0}
      title={`${n} new image${n > 1 ? "s" : ""} from this session — tap to browse them`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openNewImages(sessionId); } }}
      onClick={(e) => { e.stopPropagation(); openNewImages(sessionId); }}>
      <Images size={12} /> {n}
    </span>
  );
}

/** The toolbar's `inbox`: new outbox files since this repo was last opened. */
export function InboxToolbarItem({ repo, dismiss }: { repo: RepoTarget | null; dismiss(): void }) {
  if (!repo || repo.outboxCount <= 0) return null;
  return <button key="inbox" className="key count" title={`${repo.outboxCount} new outbox file${repo.outboxCount > 1 ? "s" : ""} since last opened — open gallery`}
    onClick={() => { dismiss(); openOutboxFor(repo.id); }}><Images size={16} /> {repo.outboxCount}</button>;
}
