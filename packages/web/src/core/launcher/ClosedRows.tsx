/**
 * The launcher's lists below the repos: "Recently closed" (reopen, or pick an
 * older conversation), "Resume recent", and the Hidden fold (sessions, recent
 * rows and repos in a hidden repo, each with the verb that brings it back).
 */
import { PromptPair } from "../../PromptPair";
import { ContextSparkline, SpendSparkline } from "../../ContextGraph";
import { useState } from "react";
import { Archive, Ban, Bot, Camera, ChevronDown, ChevronRight, CircleCheck, Eye, History, RotateCw, Search, Trash2, X, XCircle } from "lucide-react";
import { branchLabel, repoLabel, trimDefaultBranch } from "@waterplane/shared";
import { ConfirmButton } from "../../Confirm";
import { SessionName } from "../../SessionName";
import { ago, repoAccentStyle } from "../../format";
import { launchLabel, resumeHint, resumeIdOf } from "../../sessionFacts";
import { backendMark, hasCap, isShellBackend } from "../../backendCaps";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { pickImageFor } from "../../features/images";
import { statusTags } from "../sessions/tags";
import type { LauncherProps } from "./types";
import type { LauncherModel } from "./useLauncherModel";
import { countBadges } from "./SessionRow";
import { matchesText } from "./model";
import { Empty } from "../../Empty";
import { CountChips, FilterBar, Row, RowTitle, RowSub, Tag } from "../../kit";
import { FOLLOWUP_CLEAR, FlagIcon, FollowUpLine, followUpClass } from "../sessions/followUp";
import { BookmarkIcon } from "../sessions/bookmark";
import {
  closedCut, closedFilterWords, closedHeadline, closedKindWord, closedMeta, closedOutcome,
  closedReason, closedSubtitle, isAutoClosed, type ClosedFilter,
} from "./closedRowWords";

const ICON = 16;

export function ClosedRows({ p, m }: { p: LauncherProps; m: LauncherModel }) {
  const { backends, openGitFor } = p;
  const { send, liveSend } = p.conn;
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
  // "Recently closed" and "Resume recent" sit folded behind one header, shut
  // by default: two long lists under the repos pushed everything else off a
  // phone screen. Ephemeral, like the filters — every launcher starts shut.
  // The search inside cuts BOTH lists, and says "n of N" while it does.
  const [foldOpen, setFoldOpen] = useState(false);
  const [query, setQuery] = useState("");
  const queryOn = query.trim() !== "";
  const allClosed = m.reopenable;
  const reopenable = queryOn
    ? allClosed.filter((c) => matchesText(query, [c.title, closedHeadline(c), closedSubtitle(c), c.cwd, c.firstPrompt, c.lastPrompt]))
    : allClosed;
  const recentRows = queryOn
    ? visibleRecent.filter((r) => matchesText(query, [r.title, r.cwd]))
    : visibleRecent;
  const foldTotal = allClosed.length + visibleRecent.length;
  const foldShown = reopenable.length + recentRows.length;
  return (
    <>
    {foldTotal > 0 && (
      <button className="section section-head closed-fold" aria-expanded={foldOpen}
        title={foldOpen ? "fold away recently closed and recent sessions" : "show recently closed and recent sessions, with a search"}
        onClick={() => setFoldOpen((v) => !v)}>
        <span>
          {foldOpen ? <ChevronDown size={ICON} /> : <ChevronRight size={ICON} />} Closed & recent
          <span className="section-hint"> · {allClosed.length} closed · {visibleRecent.length} recent</span>
        </span>
      </button>
    )}
    {foldOpen && foldTotal > 0 && (
      <div className="section quick-filter">
        <Search size={14} className="quick-filter-icon" />
        <input type="search" value={query} placeholder="search closed & recent"
          aria-label="search recently closed and recent sessions by title, folder and prompts"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); } }} />
        {queryOn && <span className="quick-filter-n">{foldShown} of {foldTotal}</span>}
        {queryOn && (
          <button className="head-act" aria-label="clear the search" title="clear the search — every row again"
            onClick={() => setQuery("")}><X size={ICON} /></button>
        )}
      </div>
    )}
    {foldOpen && queryOn && foldShown === 0 && <Empty>No closed or recent session shows “{query.trim()}”.</Empty>}
    {foldOpen && (() => {
      // Sessions closed (incl. mis-tapped ×) whose conversation isn't already back open.
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
          // title, launch label and "closed …", as before.
          const sub = closedSubtitle(c);
          const kind = closedKindWord(c);
          const reason = closedReason(c);
          const outcome = closedOutcome(c);
          const meta = closedMeta(c, now);
          const spark = c.contextSpark;
          const reopen = () => openCwd(c.cwd, trimDefaultBranch(c.title) || c.title, true, "continue", c.launch, resumeIdOf(c));
          return (
          // The open session's CARD (`SessionRow.tsx`, the grid in
          // `05-rows-approve.css`), not a table row: title + launch facts on
          // the head line, "closed …" where the live card's status pill sits,
          // the prompts as the left column, the verbs pinned right with the
          // readings under them, the repo's counts as chips at the foot.
          // `.closed-card`, never `data-sid`: that attribute is the drag and
          // scroll lookup for LIVE rows.
          <div key={c.id} className={`row-wrap closed-card${isAutoClosed(c) ? " closed-auto-row" : ""}`} style={repoAccentStyle(m.sessionRepoName(c))}>
            {/* The whole card still reopens on tap: the row button is
                `display: contents` (its children are the grid's items), and
                every part that is not itself a control lives inside it. */}
            <Row as="button" kind="grow" title={`reopen ${trimDefaultBranch(c.title)} — ${reopenHint(c)}`} onClick={reopen}>
              <span className="row-head">
                {/* A bookmark (R-conversations-007) is drawn ONCE: its note as a
                    line in the gist when it has one, else this small mark. */}
                <RowTitle>{c.bookmark && !c.bookmark.note && <><span className="bm-mark"><BookmarkIcon on size={12} /></span> </>}{closedHeadline(c)}</RowTitle>
                <span className="row-meta">
                  {sub && <RowSub className="closed-folder">{sub}</RowSub>}
                  <RowSub className={`row-launch${backendMark(backends, c.launch?.backend) ? " row-foreign" : ""}`}>{launchLabel(c.launch ?? {}, backendMark(backends, c.launch?.backend), backends)}</RowSub>
                  {kind && <Tag className="closed-kind">{kind}</Tag>}
                  {reason && reason.tone !== "auto" && <RowSub className={reason.tone === "note" ? "closed-note" : undefined}>{reason.text}</RowSub>}
                  {isShell(c) && <RowSub>new shell here</RowSub>}
                </span>
              </span>
              {/* Where the live card says "coding" / "done": what this one IS. */}
              <span className="row-stat"><Tag className="closed-stat" title={`closed ${new Date(c.closedAt).toLocaleString()}`}>closed {ago(c.closedAt)}</Tag></span>
              <span className="row-gist">
                {reason?.tone === "auto" && (
                  <span className="closed-line"><Tag className="closed-auto"><Bot size={12} /> {reason.text}</Tag></span>
                )}
                {outcome && (
                  <RowSub className={`closed-line closed-outcome ${outcome.tone}`}>
                    {outcome.tone === "ok" ? <CircleCheck size={12} /> : outcome.tone === "bad" ? <XCircle size={12} /> : <Ban size={12} />} {outcome.text}
                  </RowSub>
                )}
                <PromptPair firstPrompt={c.firstPrompt} lastPrompt={c.lastPrompt} className="closed-gist" />
                {meta.length > 0 && <RowSub className="closed-line closed-meta">{meta.join(" · ")}</RowSub>}
                {/* The follow-up flag outlives the session (R-sessions-041): its
                    one line here, and its "done" among the verbs. */}
                {c.followUp && <span className="closed-line"><FollowUpLine f={c.followUp} /></span>}
                {c.bookmark?.note && <span className="closed-line bm-mark"><BookmarkIcon on size={12} /> {c.bookmark.note}</span>}
                {/* …and when the reopen is APPROXIMATE, that is said HERE
                    — on the card where the tap is decided — rather than in
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
              {/* The live card's cost tile, as it stood at the close: the
                  window curve and the spend curve. A READOUT here, inside the
                  row button — a tap on it reopens like the rest of the card.
                  No `costTag`: it reads the live turn clock and answers
                  nothing for a session that is not running. */}
              {spark && (
                <span className="row-side">
                  <span className="row-spark">
                    <ContextSparkline spark={spark} value />
                    <SpendSparkline spark={spark} />
                  </span>
                </span>
              )}
            </Row>
            <div className="row-acts">
              <span className="row-tags">{countBadges(repoForCwd(c.cwd), openGitFor)}</span>
              <span className="row-ctl">
                {/* Marked read from here too — keyed on the CONVERSATION, which is
                    what the desktop keeps the flag by; answered by a fresh list. */}
                {c.followUp && (
                  <button className={`row-act fu-btn${followUpClass(c.followUp)}`} data-hint="session.followup" aria-pressed
                    title={`${FOLLOWUP_CLEAR} — the conversation stays where it is`}
                    onClick={() => {
                      track("action:session.followup.closed");
                      liveSend({ t: "session.followup", id: c.claudeSessionId ?? c.id, on: false },
                        "flag cleared", "no connection — the desktop didn't get that, the flag is still set");
                    }}><FlagIcon on size={ICON} /></button>
                )}
                {/* "Pick an older conversation" is claude's own `--resume`
                    list. A backend whose session ids are DISCOVERED rather
                    than minted, and whose conversations do not live beside
                    the repo, has nothing to put in that list — so the verb
                    is absent rather than opening a picker that would be
                    empty for a reason the picker could not explain.
                    `reopen` beside it still works and is the whole card.

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
                {/* The card's own verb, said as a button too: the whole card
                    is the same tap, but a card with no visible verb read as
                    a record rather than something to bring back. */}
                <button className="row-act" title={`${isShell(c) ? "start a new shell in this folder" : "reopen"} — ${reopenHint(c)}`} onClick={reopen}><RotateCw size={ICON} /></button>
              </span>
            </div>
          </div>
          );
        })}
      </>;
    })()}

    {foldOpen && recentRows.length > 0 && (
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
    {foldOpen && recentRows.map((r) => (
      <Row key={resumeIdOf(r) ?? r.cwd} kind="wrap" style={repoAccentStyle(m.sessionRepoName(r))}>
        <Row as="button" kind="grow" title={`${isShell(r) ? "open a new shell in" : "resume"} ${r.title} — ${reopenHint(r)}`} onClick={() => openCwd(r.cwd, r.title, true, "continue", r.launch, resumeIdOf(r))}>
          <RowTitle>{r.title}</RowTitle>
          <RowSub><RotateCw size={12} /> {isShell(r) ? "new shell here" : "resume"}</RowSub>
          {reopenCant(r)}
        </Row>
        {countBadges(repoForCwd(r.cwd), openGitFor)}
        {repoForCwd(r.cwd) && <button className="row-act" title="send image to this repo" onClick={() => pickImageFor(repoForCwd(r.cwd)!.id)}><Camera size={ICON} /></button>}
      </Row>
    ))}


    {hiddenCount > 0 && (
      <>
        <button className="section" onClick={() => setShowHidden((v) => !v)} style={{ background: "none", border: 0, textAlign: "left", cursor: "pointer", width: "100%" }}>
          Hidden ({hiddenCount}) {showHidden ? "▾" : "▸"}
        </button>
        {showHidden && <>
          {hiddenSessions.map((s) => (
            <Row key={s.id} kind="wrap">
              <Row as="button" kind="grow" onClick={() => attach(s)}>
                <RowTitle>{s.title}<RowSub className={backendMark(backends, s.backend) ? "row-foreign" : undefined}> {launchLabel(s, backendMark(backends, s.backend), backends)}</RowSub></RowTitle>
                <SessionName s={s} />
                {statusTags(s, undefined, undefined, backends)}
              </Row>
              {countBadges(sessionRepo(s), openGitFor)}
              {sessionRepo(s) && <button className="row-act" title="send image to this session" onClick={() => pickImageFor(sessionRepo(s)!.id)}><Camera size={ICON} /></button>}
              <button className="row-act danger" title={s.running ? "close" : "remove"} onClick={() => closeSession(s)}><X size={ICON} /></button>
            </Row>
          ))}
          {hiddenRecent.map((r) => (
            <Row key={resumeIdOf(r) ?? r.cwd} kind="wrap">
              <Row as="button" kind="grow" title={`${isShell(r) ? "open a new shell in" : "resume"} ${r.title} — ${reopenHint(r)}`} onClick={() => openCwd(r.cwd, r.title, true, "continue", r.launch, resumeIdOf(r))}>
                <RowTitle>{r.title}</RowTitle>
                <RowSub><RotateCw size={12} /> {isShell(r) ? "new shell here" : "resume"}</RowSub>
              </Row>
              {countBadges(repoForCwd(r.cwd), openGitFor)}
              {repoForCwd(r.cwd) && <button className="row-act" title="send image to this repo" onClick={() => pickImageFor(repoForCwd(r.cwd)!.id)}><Camera size={ICON} /></button>}
            </Row>
          ))}
          {hiddenRepos.map((t) => (
            <div key={t.id} className={`row-wrap ${t.isPrimary ? "" : "row-wt"}`}>
              <Row as="button" kind="grow" onClick={() => openRepo(t)}>
                <RowTitle>{t.isPrimary ? repoLabel(t) : <span className="wt-branch">{t.branch}</span>}</RowTitle>
                {(t.isPrimary ? branchLabel(t) : "worktree") && <RowSub>{t.isPrimary ? branchLabel(t) : "worktree"}</RowSub>}
              </Row>
              <button className="row-act" title="show repo" onClick={() => toggleHideRepo(t.id)}><Eye size={ICON} /></button>
            </div>
          ))}
        </>}
      </>
    )}
    </>
  );
}
