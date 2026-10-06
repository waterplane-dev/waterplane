/**
 * The launcher's lists below the repos: "Recently closed" (reopen, or pick an
 * older conversation), "Resume recent", and the Hidden fold (sessions, recent
 * rows and repos in a hidden repo, each with the verb that brings it back).
 */
import { PromptPair } from "../../PromptPair";
import { useState } from "react";
import { Archive, Ban, Bot, Camera, CircleCheck, Eye, History, RotateCw, Trash2, X, XCircle } from "lucide-react";
import { branchLabel, trimDefaultBranch } from "@waterplane/shared";
import { ConfirmButton } from "../../Confirm";
import { SessionName } from "../../SessionName";
import { ago, baseName, repoAccentStyle } from "../../format";
import { launchLabel, resumeHint, resumeIdOf } from "../../sessionFacts";
import { backendMark, hasCap, isShellBackend } from "../../backendCaps";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { pickImageFor } from "../../features/images";
import { statusTags } from "../sessions/tags";
import type { LauncherProps } from "./types";
import type { LauncherModel } from "./useLauncherModel";
import { countBadges } from "./SessionRow";
import { CountChips, FilterBar } from "../../kit";
import {
  closedCut, closedFilterWords, closedHeadline, closedKindWord, closedMeta, closedOutcome,
  closedReason, closedSubtitle, isAutoClosed, type ClosedFilter,
} from "./closedRowWords";

const ICON = 16;

export function ClosedRows({ p, m }: { p: LauncherProps; m: LauncherModel }) {
  const { backends, openGitFor } = p;
  const { send } = p.conn;
  const { setOverlay } = p.route;
  const { hiddenRepos, toggleHideRepo } = p.view;
  const { openCwd, openRepo, reopenCant } = p.launchCore;
  const { attach } = p.term;
  const { closeSession } = p.verbs;
  const { repoForCwd, sessionRepo, visibleRecent, hiddenRecent, hiddenSessions, hiddenCount, showHidden, setShowHidden } = m;
  // The one filter on this list — "closed automatically · N". Ephemeral, like
  // the launcher's status filter: a cut that survived a reload would hide rows
  // with no visible cause.
  // A shell has no conversation to continue: `openCwd` itself turns a resume of
  // a shell row into a FRESH shell in the same folder, and the row says so.
  const isShell = (r: { launch?: { backend?: string } }) => isShellBackend(backends, r.launch?.backend);
  const reopenHint = (r: Parameters<typeof resumeIdOf>[0] & { launch?: { backend?: string } }) =>
    isShell(r) ? "starts a new shell in this folder — a shell has no conversation to continue" : resumeHint(!!resumeIdOf(r));
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>(null);
  return (
    <>
    {(() => {
      // Sessions closed (incl. mis-tapped ×) whose conversation isn't already back open.
      const reopenable = m.reopenable;
      if (!reopenable.length) return null;
      const autoCount = reopenable.filter(isAutoClosed).length;
      // A cut with nothing left in it falls back to the whole list rather
      // than an empty section with a chip that no longer exists.
      const filter: ClosedFilter = closedFilter === "auto" && autoCount > 0 ? "auto" : null;
      const shown = closedCut(reopenable, filter);
      const now = Date.now();
      return <>
        <div className="section section-head">
          <span>Recently closed <span className="section-hint">· tap to reopen (newest first)</span></span>
          <span className="head-acts tight">
            <button className="head-act" aria-label="open the archive" title="older conversations — the full archive on disk"
              onClick={() => { track("overlay:archive"); setOverlay("archive"); }}><Archive size={ICON} /></button>
            {/* Clearing the SHORTLIST, not the conversations: they stay on
                disk and stay listed in the archive. The confirm says so. */}
            {/* Armed tap, not a dialog: what this does is known when
                the button renders, so the second tap IS the answer and
                nothing has to be dismissed. */}
            <ConfirmButton className="head-act" aria-label="clear recently-closed list"
              title="clear the recently-closed shortlist (the conversations stay, in the archive)"
              confirmTitle="tap again to clear the shortlist — the conversations stay on disk and remain resumable from the archive"
              confirm={<><Trash2 size={ICON} /> clear?</>}
              onConfirm={() => { send({ t: "closed.clear" }); showToast("shortlist cleared — conversations kept"); }}>
              <Trash2 size={ICON} />
            </ConfirmButton>
          </span>
        </div>
        {/* Drawn only while there is something to cut to: a standing
            "closed automatically · 0" on every launcher is noise. */}
        {autoCount > 0 && (
          <CountChips className="annot-tools closed-chips" keys={["auto"] as const}
            bucket={() => ({ count: autoCount })} label={() => "closed automatically"}
            active={filter} onPick={(k) => setClosedFilter(k)} />
        )}
        {filter && (
          <FilterBar onClear={() => setClosedFilter(null)} clearLabel="show all">
            {closedFilterWords(shown.length, reopenable.length)}
          </FilterBar>
        )}
        {shown.map((c) => {
          // What it was and why it ended (`closedRowWords.ts`). Every piece is
          // absent when the host did not know — an old row draws exactly its
          // title, launch label and "reopen · closed …", as before.
          const sub = closedSubtitle(c);
          const kind = closedKindWord(c);
          const reason = closedReason(c);
          const outcome = closedOutcome(c);
          const meta = closedMeta(c, now);
          return (
          <div key={c.id} className={`row-wrap${isAutoClosed(c) ? " closed-auto-row" : ""}`} style={repoAccentStyle(repoForCwd(c.cwd)?.repoName ?? baseName(c.cwd))}>
            <button className="row grow" title={`reopen ${trimDefaultBranch(c.title)} — ${reopenHint(c)}`} onClick={() => openCwd(c.cwd, trimDefaultBranch(c.title) || c.title, true, "continue", c.launch, resumeIdOf(c))}>
              <span className="row-title">{closedHeadline(c)}</span>
              {reason?.tone === "auto" && (
                <span className="closed-line"><span className="tag closed-auto"><Bot size={12} /> {reason.text}</span></span>
              )}
              <span className="row-meta">
                {sub && <span className="row-sub closed-folder">{sub}</span>}
                <span className={`row-sub row-launch${backendMark(backends, c.launch?.backend) ? " row-foreign" : ""}`}>{launchLabel(c.launch ?? {}, backendMark(backends, c.launch?.backend), backends)}</span>
                {kind && <span className="tag closed-kind">{kind}</span>}
                {reason && reason.tone !== "auto" && <span className={`row-sub${reason.tone === "note" ? " closed-note" : ""}`}>{reason.text}</span>}
                <span className="row-sub"><RotateCw size={12} /> {isShell(c) ? "new shell here" : "reopen"} · closed {ago(c.closedAt)}</span>
                {/* …and when the reopen is APPROXIMATE, that is said HERE
                    — on the row where the tap is decided — rather than in
                    the cants strip of the session you land in, which is
                    after the fact and on a different screen. The sentence
                    is `capReason`'s own (`resumePick`), so the missing
                    picker and the inexact reopen are worded once.

                    Two conditions, both needed: the backend has no picker
                    to offer instead (claude and every host that never sent
                    a `backends` frame answer null here, so those rows are
                    byte-identical), AND this row carries no id to resume
                    exactly — with one, the tap IS exact and a warning
                    about the folder's conversation would be false. */}
                {reopenCant(c)}
              </span>
              {outcome && (
                <span className={`row-sub closed-line closed-outcome ${outcome.tone}`}>
                  {outcome.tone === "ok" ? <CircleCheck size={12} /> : outcome.tone === "bad" ? <XCircle size={12} /> : <Ban size={12} />} {outcome.text}
                </span>
              )}
              <span className="row-gist"><PromptPair firstPrompt={c.firstPrompt} lastPrompt={c.lastPrompt} className="closed-gist" /></span>
              {meta.length > 0 && <span className="row-sub closed-line closed-meta">{meta.join(" · ")}</span>}
            </button>
            {/* "Pick an older conversation" is claude's own `--resume`
                list. A backend whose session ids are DISCOVERED rather
                than minted, and whose conversations do not live beside
                the repo, has nothing to put in that list — so the verb
                is absent rather than opening a picker that would be
                empty for a reason the picker could not explain.
                `reopen` beside it still works and is the whole row.

                Gated on `resumePick`, NOT on `transcript`. They were the
                same flag until a backend arrived with a readable
                conversation record and no picker this host knows how to
                drive — and the host's `launchArgs` REFUSES `"pick"` for
                it in words. The moment `transcript` flips true for such
                a backend, a `transcript` gate here offers a button whose
                only possible outcome is that refusal. `resumePick`
                resolves to `transcript` when a descriptor never heard of
                it, so every older host keeps the button exactly where it
                was (`backendCaps.ts`). */}
            {hasCap(backends, c.launch?.backend, "resumePick")
              && <button className="row-act" title="pick an older conversation in this folder — the binary's own list" onClick={() => openCwd(c.cwd, c.title, true, "pick", c.launch)}><History size={ICON} /></button>}
            {countBadges(repoForCwd(c.cwd), openGitFor)}
          </div>
          );
        })}
      </>;
    })()}

    {visibleRecent.length > 0 && (
      <div className="section section-head">
        <span>Resume recent</span>
        <span className="head-acts tight">
          <ConfirmButton className="head-act" aria-label="clear recent list"
            title="clear the recent-sessions list"
            confirmTitle="tap again to clear the recent-sessions list"
            confirm={<><Trash2 size={ICON} /> clear?</>}
            onConfirm={() => { send({ t: "recent.clear" }); showToast("recent cleared"); }}>
            <Trash2 size={ICON} />
          </ConfirmButton>
        </span>
      </div>
    )}
    {/* `key` through `resumeIdOf` for the same reason the tap goes
        through it: keyed on `claudeSessionId` alone, two recent opencode
        conversations in one repo both fell back to `r.cwd` and React was
        handed the same key twice. */}
    {visibleRecent.map((r) => (
      <div key={resumeIdOf(r) ?? r.cwd} className="row-wrap" style={repoAccentStyle(repoForCwd(r.cwd)?.repoName ?? baseName(r.cwd))}>
        <button className="row grow" title={`${isShell(r) ? "open a new shell in" : "resume"} ${r.title} — ${reopenHint(r)}`} onClick={() => openCwd(r.cwd, r.title, true, "continue", r.launch, resumeIdOf(r))}>
          <span className="row-title">{r.title}</span>
          <span className="row-sub"><RotateCw size={12} /> {isShell(r) ? "new shell here" : "resume"}</span>
          {reopenCant(r)}
        </button>
        {countBadges(repoForCwd(r.cwd), openGitFor)}
        {repoForCwd(r.cwd) && <button className="row-act" title="send image to this repo" onClick={() => pickImageFor(repoForCwd(r.cwd)!.id)}><Camera size={ICON} /></button>}
      </div>
    ))}


    {hiddenCount > 0 && (
      <>
        <button className="section" onClick={() => setShowHidden((v) => !v)} style={{ background: "none", border: 0, textAlign: "left", cursor: "pointer", width: "100%" }}>
          Hidden ({hiddenCount}) {showHidden ? "▾" : "▸"}
        </button>
        {showHidden && <>
          {hiddenSessions.map((s) => (
            <div key={s.id} className="row-wrap">
              <button className="row grow" onClick={() => attach(s)}>
                <span className="row-title">{s.title}<span className={`row-sub${backendMark(backends, s.backend) ? " row-foreign" : ""}`}> {launchLabel(s, backendMark(backends, s.backend), backends)}</span></span>
                <SessionName s={s} />
                {statusTags(s, undefined, undefined, backends)}
              </button>
              {countBadges(sessionRepo(s), openGitFor)}
              {sessionRepo(s) && <button className="row-act" title="send image to this session" onClick={() => pickImageFor(sessionRepo(s)!.id)}><Camera size={ICON} /></button>}
              <button className="row-act danger" title={s.running ? "close" : "remove"} onClick={() => closeSession(s)}><X size={ICON} /></button>
            </div>
          ))}
          {hiddenRecent.map((r) => (
            <div key={resumeIdOf(r) ?? r.cwd} className="row-wrap">
              <button className="row grow" title={`${isShell(r) ? "open a new shell in" : "resume"} ${r.title} — ${reopenHint(r)}`} onClick={() => openCwd(r.cwd, r.title, true, "continue", r.launch, resumeIdOf(r))}>
                <span className="row-title">{r.title}</span>
                <span className="row-sub"><RotateCw size={12} /> {isShell(r) ? "new shell here" : "resume"}</span>
              </button>
              {countBadges(repoForCwd(r.cwd), openGitFor)}
              {repoForCwd(r.cwd) && <button className="row-act" title="send image to this repo" onClick={() => pickImageFor(repoForCwd(r.cwd)!.id)}><Camera size={ICON} /></button>}
            </div>
          ))}
          {hiddenRepos.map((t) => (
            <div key={t.id} className={`row-wrap ${t.isPrimary ? "" : "row-wt"}`}>
              <button className="row grow" onClick={() => openRepo(t)}>
                <span className="row-title">{t.isPrimary ? t.repoName : <span className="wt-branch">{t.branch}</span>}</span>
                {(t.isPrimary ? branchLabel(t) : "worktree") && <span className="row-sub">{t.isPrimary ? branchLabel(t) : "worktree"}</span>}
              </button>
              <button className="row-act" title="show repo" onClick={() => toggleHideRepo(t.id)}><Eye size={ICON} /></button>
            </div>
          ))}
        </>}
      </>
    )}
    </>
  );
}
