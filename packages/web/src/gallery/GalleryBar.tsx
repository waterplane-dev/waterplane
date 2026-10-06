import { CloudOff, HardDrive, Inbox, Loader2, RotateCw, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { SheetHead } from "../Sheet";
import { KINDS, SINCE, fmtCreated } from "./galleryTypes";
import type { GalleryModel } from "./useGallery";

declare const __BUILD_ID__: string; // injected by vite define — UI build stamp

/** The sheet head, the search box, the tab / kind / time chips and the notes about the list. */
export function GalleryBar({ m }: { m: GalleryModel }) {
  const { scope, loading, files, truncated, query, setQuery, singleRepo, chipCls, busyMark, changeScope, kind, setKind,
    since, setSince, newSecs, onNewCut, setOnNewCut, loadErr, setReload, cachedAt, staleWhy, note, open } = m;
  const { onClose, onSweep, onSurvey, initialNew } = m.props;
  return (
    <>
      <SheetHead title="Images & documents" onClose={onClose}>
        {/* Live count makes scope switching visibly verifiable; build stamp confirms which bundle loaded. */}
        <span className="gallery-meta" title={`build ${__BUILD_ID__}`}>
          {scope} · {loading ? <Loader2 size={11} className="spin" /> : <>{files.length}{truncated ? "+" : ""}</>} <span className="gallery-build">{__BUILD_ID__}</span>
        </span>
      </SheetHead>

      <div className="form">
        <div className="search-row">
          <Search size={16} />
          <input
            className="search"
            placeholder={scope === "all" ? "Search all repos by name (e.g. screenshot, .pdf)…" : "Search by name (e.g. report, .csv)…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && <button className="key" onClick={() => setQuery("")}><X size={14} /></button>}
        </div>
      </div>

      <div className="annot-tools">
        {singleRepo && <>
          <button className={chipCls(scope === "inbox")} onClick={() => changeScope("inbox")}><Inbox size={16} /> inbox{busyMark(scope === "inbox")}</button>
          <button className={chipCls(scope === "outbox")} onClick={() => changeScope("outbox")}>outbox{busyMark(scope === "outbox")}</button>
          <button className={chipCls(scope === "repo")} onClick={() => changeScope("repo")}>this repo{busyMark(scope === "repo")}</button>
        </>}
        <button className={chipCls(scope === "all")} onClick={() => changeScope("all")}>all repos{busyMark(scope === "all")}</button>
        {/* Only on the two TRANSPORT scopes: those are the only directories a
            sweep is allowed to touch (`files.ts deleteArtifact`'s guard), so
            offering it over "this repo" would be offering a verb that refuses.
            Not drawn at all rather than drawn dimmed — CLAUDE.md. */}
        {onSweep && singleRepo && (scope === "inbox" || scope === "outbox") && <>
          <span className="spacer" />
          <button className="key" onClick={() => onSweep(scope)}><Trash2 size={16} /> clear out…</button>
        </>}
        {/* The same verb where it CAN'T be per-repo: ranked bytes across every
            repo, each row opening exactly that repo's sweep. */}
        {onSurvey && scope === "all" && <>
          <span className="spacer" />
          <button className="key" onClick={onSurvey}><HardDrive size={16} /> what’s taking space…</button>
        </>}
      </div>

      <div className="annot-tools">
        {KINDS.map((k) => (
          <button key={k.value} className={chipCls(kind === k.value)} onClick={() => setKind(k.value)}>{k.label}{busyMark(kind === k.value)}</button>
        ))}
        {scope !== "inbox" && <>
          <span className="spacer" />
          {/* The badge's own cut, named. It exists only while it is the answer
              to a question somebody asked by tapping a number — every other
              chip clears it, and reopening without a badge never shows it. */}
          {newSecs !== undefined && (
            <button className={chipCls(onNewCut)}
              title={`the ${initialNew!.count} file${initialNew!.count > 1 ? "s" : ""} added since you last opened this outbox — the badge you tapped`}
              onClick={() => { setSince(newSecs); setOnNewCut(true); }}>
              new {initialNew!.count}{busyMark(onNewCut)}
            </button>
          )}
          {SINCE.map((s) => (
            <button key={s.label} className={chipCls(since === s.secs)} onClick={() => { setSince(s.secs); setOnNewCut(false); }}>{s.label}{busyMark(since === s.secs)}</button>
          ))}
        </>}
      </div>

      {/* A filtered list says so, with the way out — the same bar the launcher
          and the schedules sheet carry. Without it a badge of 42 opening on 42
          rows is indistinguishable from a badge of 42 opening on everything,
          which is the whole complaint. */}
      {onNewCut && (
        <div className="gallery-note">
          <span>showing the {initialNew!.count} added since you last looked{files.length ? ` · ${files.length} here` : ""}</span>
          <button className="key" onClick={() => { setSince(undefined); setOnNewCut(false); }}>
            <X size={14} /> show everything
          </button>
        </div>
      )}

      {/* A failed listing is its own state. Rows already on screen are KEPT (a
          dead tunnel should not also erase what you were looking at) — this
          says they are stale and offers the retry. */}
      {loadErr && (
        <div className="gallery-note err">
          <TriangleAlert size={14} />
          <span>Could not load the list ({loadErr}){files.length ? " — showing what was already loaded" : ""}.</span>
          <button className="key" onClick={() => setReload((n) => n + 1)}><RotateCw size={14} /> Retry</button>
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
          {staleWhy && <button className="key" onClick={() => setReload((n) => n + 1)}><RotateCw size={14} /> Retry</button>}
        </div>
      )}
      {/* Actions the gallery hands off report here too when no viewer is open —
          a delete that failed because the link is down must say so somewhere. */}
      {note && !open && <div className="gallery-note">{note}</div>}
    </>
  );
}
