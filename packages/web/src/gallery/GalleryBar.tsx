import { CloudOff, HardDrive, Loader2, RotateCw, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { isDemo } from "../demo/mode";
import { SheetHead } from "../Sheet";
import { FilterBar } from "../kit/FilterBar";
import { fmtCreated } from "./galleryTypes";
import { newCutText } from "./galleryCuts";
import { GalleryFilters } from "./GalleryFilters";
import type { GalleryModel } from "./useGallery";
import { Button } from "../kit/Button";

declare const __BUILD_ID__: string; // injected by vite define — UI build stamp

/** The sheet head, the search box, the where/what controls (`GalleryFilters`) and the notes
 *  about the list. */
export function GalleryBar({ m }: { m: GalleryModel }) {
  const { scope, loading, files, truncated, query, setQuery, singleRepo, setSince, onNewCut, setOnNewCut, loadErr,
    setReload, cachedAt, staleWhy, note, open } = m;
  const { onClose, onSweep, onSurvey, initialNew } = m.props;
  const n = files.length;
  const clearTime = () => { setSince(undefined); setOnNewCut(false); };
  return (
    <>
      <SheetHead title="Images & documents" onClose={onClose}>
        {/* The count is said once, here, and only when there is one: "0 files" over a grid
            saying nothing is here was the empty state twice. The build stamp is this span's
            long-press text, not on screen, where the hash read as a debug leftover; Settings ›
            app version is where the APK says which bundle it runs. Not in the demo (no bundle). */}
        {(n > 0 || loading) && (
          <span className="gallery-meta" title={isDemo() ? undefined : `build ${__BUILD_ID__}`}>
            {loading && !n ? <Loader2 size={12} className="spin" /> : `${n}${truncated ? "+" : ""} file${n === 1 && !truncated ? "" : "s"}`}
          </span>
        )}
        {/* Only on the two TRANSPORT scopes: those are the only directories a
            sweep is allowed to touch (`files.ts deleteArtifact`'s guard), so
            offering it over "this repo" would be offering a verb that refuses.
            Not drawn at all rather than drawn dimmed — CLAUDE.md. */}
        {onSweep && singleRepo && (scope === "inbox" || scope === "outbox") && (
          <Button className="gallery-head-btn" title={`clear out old ${scope} files`} aria-label={`clear out old ${scope} files`}
            onClick={() => onSweep(scope)}><Trash2 size={17} /></Button>
        )}
        {/* The same verb where it CAN'T be per-repo: ranked bytes across every
            repo, each row opening exactly that repo's sweep. */}
        {onSurvey && scope === "all" && (
          <Button className="gallery-head-btn" title="what is taking space, repo by repo" aria-label="what is taking space"
            onClick={onSurvey}><HardDrive size={17} /></Button>
        )}
      </SheetHead>

      <div className="form">
        <div className="search-row">
          <Search size={16} />
          <input
            className="search"
            placeholder={scope === "all" ? "Search every repo by name" : "Search by name"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && <Button aria-label="clear the search" onClick={() => setQuery("")}><X size={14} /></Button>}
        </div>
      </div>

      <GalleryFilters m={m} />

      {/* A filtered list says so, with the way out — the kit's bar, the one the
          launcher and the logins sheet carry. Without it a badge of 42 opening
          on 42 rows is indistinguishable from a badge of 42 opening on
          everything, which is the whole complaint. */}
      {onNewCut && (
        <FilterBar onClear={clearTime} clearLabel="show all">
          {newCutText(initialNew!.count, n, loading, truncated)}
        </FilterBar>
      )}

      {/* A failed listing is its own state. Rows already on screen are KEPT (a
          dead tunnel should not also erase what you were looking at) — this
          says they are stale and offers the retry. */}
      {loadErr && (
        <div className="gallery-note err">
          <TriangleAlert size={14} />
          <span>Could not load the list ({loadErr}){n ? " — showing what was already loaded" : ""}.</span>
          <Button onClick={() => setReload((x) => x + 1)}><RotateCw size={14} /> retry</Button>
        </div>
      )}

      {/* Rows this device saved earlier. Never presented as the current state of
          the repo: what is on screen is what the phone last SAW, with the age
          said out loud — a list of files that no longer exist is only a problem
          if you were told it was live. */}
      {cachedAt != null && (
        <div className="gallery-note">
          <CloudOff size={14} />
          <span>
            {staleWhy
              ? `Showing the list this phone last saw, ${fmtCreated(cachedAt)} — ${staleWhy}.`
              : `Showing the list this phone last saw, ${fmtCreated(cachedAt)} — refreshing…`}
          </span>
          {staleWhy && <Button onClick={() => setReload((x) => x + 1)}><RotateCw size={14} /> retry</Button>}
        </div>
      )}
      {/* Actions the gallery hands off report here too when no viewer is open —
          a delete that failed because the link is down must say so somewhere. */}
      {note && !open && <div className="gallery-note">{note}</div>}
    </>
  );
}
