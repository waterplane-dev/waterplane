/**
 * One live session under its repo header: the tap that opens it, the badges
 * that say what it is doing, and the four verbs (outline, star, rename, close).
 */
import type { ReactNode } from "react";
import { CalendarClock, Clock, FileDiff, Images, List, Pencil, Radio, Star, X } from "lucide-react";
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import { sessionName } from "@waterplane/shared";
import { ContextSparkline, SpendSparkline } from "../../ContextGraph";
import { SessionName } from "../../SessionName";
import { dur, repoAccentStyle } from "../../format";
import { fmtWhen } from "../../sendIntent";
import { launchLabel } from "../../sessionFacts";
import { PromptPair } from "../../PromptPair";
import { promptPairParts } from "../../promptPairParts";
import { backendMark } from "../../backendCaps";
import { track } from "../../usage";
import { openContextFor } from "../../features/context";
import { openSessionBudget } from "../../features/sessionBudget";
import { openBacklogCut } from "../../features/backlog";
import { NewImagesTag, openOutboxFor } from "../../features/images";
import { useLimitAuto } from "../../features/limits";
import { budgetTag, contextTag, costTag, limitTag, liveAgentTag, shellsTag, statusTags, tallyTitle, turnTally, type TagFilter } from "../sessions/tags";
import { PluginBadges } from "../../features/plugins";
import { PeerRowTags, PeerWaitTag } from "../../features/peers";
import { openShellsFor } from "../../features/shells";
import type { LauncherProps } from "./types";
import { renameSession } from "../session/rename";
import type { LauncherModel } from "./useLauncherModel";

const ICON = 16;

// Blue count badges (new outbox artifacts / changed files) — same on repo rows
// and active/recent session rows so the row's repo state is visible everywhere.
// Outbox, not inbox: the badge answers "did an agent leave me something", and
// the inbox holds what this phone uploaded, which it already knows about.
export const countBadges = (repo: RepoTarget | null, openGitFor: (repoId: string) => void): ReactNode => repo ? (<>
  {repo.outboxCount > 0 && <button className="row-act count" title={`${repo.outboxCount} new outbox file${repo.outboxCount > 1 ? "s" : ""} since last opened — open gallery`} onClick={() => openOutboxFor(repo.id)}><Images size={14} />{repo.outboxCount}</button>}
  {repo.changedCount > 0 && <button className="row-act count" title={`${repo.changedCount} changed file${repo.changedCount > 1 ? "s" : ""} — open git`} onClick={() => openGitFor(repo.id)}><FileDiff size={14} />{repo.changedCount}</button>}
</>) : null;

export function SessionRow({ p, m, s, repoName }: { p: LauncherProps; m: LauncherModel; s: SessionInfo; repoName: string }) {
  const { backends, openGitFor } = p;
  const { status, liveSend } = p.conn;
  const { lastVisitedId } = p.route;
  const { attach, openReader } = p.term;
  const { sessionCan } = p.launchCore;
  const { pendingStars, toggleStar, closeSession } = p.verbs;
  const { dragSid, dragRef, armRowDrag, sessionRowBranch, sessionRepoName, sessionRepoLabel, sessionRowTitle, sessionRepo, repliesBySession } = m;
  const limitAuto = useLimitAuto();
  // The row badge is a FILTER control here — the one list that has a filter.
  const tagFilter: TagFilter = { isOn: (st) => m.statusFilterActive(st), toggle: (st) => m.toggleStatusFilter(st) };
  // Hint: the first and the latest prompt, verbatim, as two parts
  // (`PromptPair`; the pinned entry replaces the latest). Falls back to the
  // custom title only before any prompt has been recorded.
  const repoLabel = sessionRepoLabel(s);
  const hasPrompts = (() => { const p = promptPairParts(s); return !!(p.first || p.now); })();
  const gist = hasPrompts ? "" : (s.title && s.title !== repoLabel && s.title !== repoName ? s.title : "");
  return (
    <div className={`row-wrap${s.id === lastVisitedId ? " row-recent" : ""}${s.id === dragSid ? " row-dragging" : ""}`} style={repoAccentStyle(repoName)} data-sid={s.id}>
      <button
        className={`row grow${s.id === dragSid ? " dragging" : ""}`}
        data-nohint
        title="tap to open · press and hold to drag into a new position"
        onPointerDown={(e) => armRowDrag(e, s.id)}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => { if (dragRef.current) return; attach(s); }}>
        {/* The branch, the desktop's own name for the session,
            or — when neither says anything — the repo. Two spans
            rather than one string: the name is the softer of the
            two and wraps on its own, and on a primary sitting on
            `main` it simply moves left into the space the word
            used to take. A row is never left without a title. */}
        {/* `.row-head`: the title line as ONE grid item — the card is a grid
            (styles.css) and this line shares its row with the status chip. */}
        <span className="row-head">
        {sessionRowBranch(s) && <span className="row-title">{sessionRowBranch(s)}</span>}
        {sessionName(s)
          ? <SessionName s={s} />
          : !sessionRowBranch(s) && <span className="row-title">{sessionRepoName(s)}</span>}
        {/* One meta line, not one line per fact: as separate
            `flex-basis: 100%` spans "default" and "2d" ate two
            full rows of a phone screen each. And not a line of its
            own either — it rides the RIGHT END of the title's line,
            which was two thirds empty (styles.css). */}
        <span className="row-meta">
          {/* The backend leads the launch line ONLY when it is
              not claude (`backendMark` answers null otherwise),
              so every row that ran the default binary is exactly
              the string it has always been. */}
          <span className={`row-sub row-launch${backendMark(backends, s.backend) ? " row-foreign" : ""}`}>{launchLabel(s, backendMark(backends, s.backend), backends)}</span>
          {s.createdAt && s.running && <span className="row-sub" title={`session open for ${dur(s.createdAt)}`}><Clock size={11} /> {dur(s.createdAt)}</span>}
        </span>
        </span>
        {/* The prompt: the card's left column. The buttons and readings are
            its right column (styles.css' grid) and live outside this
            <button>, because a nested button is invalid. */}
        <span className="row-gist">
          {hasPrompts ? <PromptPair firstPrompt={s.firstPrompt} lastPrompt={s.lastPrompt} pinnedPrompt={s.pinnedPrompt} /> : gist && <span className="row-summary">{gist}</span>}
        </span>
      </button>
      {/* Actions are a TOOLBAR ROW, not a column beside it. As columns
          they stretched to the row's height, so a row with a long prompt
          drew tall vertical rules between icons and the list read as a
          table whose "cells" were mostly empty — and the taller the row,
          the further the icons sat from what they act on.
          On a session card it renders BELOW the text (styles.css floors it
          there; other rows keep it on top), LAST in the DOM too, so the row
          reads title → prompt → status → actions in both senses.
          The badges belong with it: the status filter pill
          and the limit tag used to be down on the title line, so "the
          buttons" were wherever you happened to look. They are IN this
          strip now (`.row-tags`) and there is one edge again. */}
      <div className="row-acts">
        {/* The row's BADGES, in the strip — not on the title line.
            Five chips (new · RC · new images · status · the
            auto-continue hourglass) wrapped onto a second and often
            a third line under the title, while this strip carried
            two counts, three icon buttons and half a phone screen of
            nothing between them. The facts move into the gap that was
            already there; the title keeps a line to itself and the row
            comes out SHORTER than it was.

            `.row-tags` is the flex item that grows and wraps INSIDE
            itself, so the counts stay pinned left and star/rename/×
            stay pinned right however many chips a session carries.

            They are out of the row `<button>` now, so the tappable
            ones are no longer interactive elements nested inside a
            button. The stopPropagation pairs stay: the strip is not
            the drag handle, but `statusTags` is shared with the
            filter pill and the pair costs nothing where it is idle.
            The price is that a tap on a READOUT chip no longer falls
            through to "open the session" — the rest of the row still
            is that button, and it is most of the row. */}
        {/* ORDER, FIXED: the status pill FIRST on every card, then RC, then
            what else this session IS (schedule · shells · context · budget ·
            limit · plugin badges), then the ALERTS (new · new images), then
            the REPO's own counts. The alerts used to lead, so on a card with
            no new images the status pill sat one slot to the left of where it
            sat on the card above — with the strip at the bottom of every card
            the eye runs down that column, and a pill that wanders is one you
            hunt for. Chips that are always there lead, chips that come and go
            follow, and least specific (the repo counts, the same on every
            row) is still last.

            The status pill is also the chip a tap CUTS the list with, and a
            control that moves depending on what a session carries is one you
            have to look for every time. */}
        {/* The status pill, at the right end of the TITLE line, beside the
            age it qualifies. "new" (something happened while you were not
            looking) is not a chip of its own any more: it is a mark ON this
            one, because both answer "what is this session doing / done". */}
        <span className="row-stat">{statusTags(s, tagFilter, s.starred && s.newActivity, backends)}</span>
        <span className="row-tags">
          {s.remoteControlled && <span className="tag rc-tag" title="a desktop is driving this session"><Radio size={12} /> RC</span>}
          {/* **Words already on a clock for THIS session.**
              A count, so it is a filter: the tap opens exactly
              these rows in that repo's backlog and never the
              repo's whole list for the reader to find them in.
              Drawn wherever it is true, not only on a waiting
              row — a session that is working also has a right to
              say something is queued behind the turn. */}
          {(() => {
            const sched = repliesBySession.get(s.id);
            if (!sched) return null;
            const n = sched.ids.length;
            const when = sched.nextAt != null ? fmtWhen(sched.nextAt) : "when its window opens";
            const open = () => { track("action:session.scheduled.open"); openBacklogCut(s.cwd, sched.ids, `scheduled for ${s.title}`); };
            return (
              <span className="tag sched tag-filter" role="button" tabIndex={0}
                title={`${n} prompt${n > 1 ? "s" : ""} on a clock for this session — next ${when}; tap to open ${n > 1 ? "them" : "it"}`}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(); } }}
                onClick={(e) => { e.stopPropagation(); open(); }}>
                <CalendarClock size={12} /> {n > 1 ? `${n} · ` : ""}{when}
              </span>
            );
          })()}
          <PeerWaitTag s={s} />
          <PeerRowTags s={s} />
          {shellsTag(s, () => openShellsFor(s))}
          {limitTag(s, limitAuto)}
          <PluginBadges s={s} />
          {/* The one badge here that NAMES SOMETHING YOU CAN OPEN, so it is
              a control rather than a readout. On the title line, as a bare
              span, a tap on it fell through to the row and attached the CLI
              — the one screen that is not the pictures — and nothing on
              screen said why. `tag-filter` is the house mark for "this tag
              takes a tap". Still a span with role="button" rather than
              a real <button>, exactly like `statusTags`' filter pill
              above it: these read as one row of FACTS, and a chip built
              as a button would wear the strip's button styling. */}
          <NewImagesTag sessionId={s.id} />
          {countBadges(sessionRepo(s), openGitFor)}
        </span>
        {/* The session's READINGS, one section at the strip's right end:
            the way into its recent prompts (the outline, right under the
            ×), how full its window is and its token limit, then the cost
            tile. They were spread over three places — the outline among the verbs, the
            context and limit chips in the run of facts, the tile floated in
            the prompt — and every one of them answers "where is this
            conversation at", so they are read together. */}
        {(() => {
          const budget = budgetTag(s, () => openSessionBudget(s.id));
          const ctx = contextTag(s);
          const canOutline = sessionCan(s, "transcript");
          return (budget || ctx || canOutline || s.contextSpark) && (
          <span className="row-side">
            {/* Straight to the reader with the outline open. Same icon
                the outline verb carries everywhere else (toolbar.ts),
                so it reads as that verb rather than a fourth view.
                ABSENT, not greyed, for a backend that keeps no
                conversation log — exactly where the header's reader
                toggle is absent, and for the same reason. */}
            {canOutline && (() => { const n = turnTally(s); return (
              <button className={`row-act${n == null ? "" : " tally"}`} title={`outline — where this session got to, without opening the terminal${tallyTitle(n)}`} onClick={() => openReader(s)}><List size={ICON} />{n == null ? null : n}</button>
            ); })()}
            {(budget || ctx) && <span className="row-side-top">
              {ctx}
              {budget}
            </span>}
            {/* ── What this conversation is costing, as ONE tile ──
                Four readings of one subject, and they used to sit
                on two lines at opposite edges of the row: the
                multiple wrapped onto the badge line at the far
                LEFT while the curve, the reading and the total were
                right-aligned on the line below it. Two glances, and
                the one figure that is a judgement rather than a
                measurement was the furthest from the numbers it is
                derived from.

                The order is the argument, top to bottom: the multiple
                FIRST, then the window curve and the reading it ends
                at, then the spend curve and the session total. The
                multiple is the only reading here that is a JUDGEMENT
                rather than a measurement — it is the one that answers
                "should this go in a fresh session", which is the
                decision this tile exists to inform — and it was last,
                below two curves, where it read as a footnote to the
                numbers instead of the thing they add up to. It is also
                the only chip wearing a colour, so at the top it cannot
                be misread as part of a figure: only the token limit,
                outside the tile, sits above it. `contextTag`'s percentage stays up on
                the badge line deliberately: "how much window is LEFT"
                is a different question (`sessionCostPill`), and it is
                colour-coded like a status because it behaves like one.

                A CONTROL, and the second door into the context
                sheet: four readings of a subject whose whole chart
                exists two taps away used to open the TERMINAL,
                because the only thing under the tile was the row.
                Whoever taps a curve wants the curve.

                Span + `role="button"`, not a real `<button>`, so it is
                drawn as a tile and not as the strip's buttons — with
                the same stopPropagation PAIR the image badge above
                uses: the click, and the `pointerdown` that arms the
                row drag. Without the second one a press-and-hold on
                the tile starts dragging the row it sits in.

                The affordance is the TILE'S OWN EDGE (`.row-spark`
                is a well with a border now), never a `title` and
                never a cursor: this app's rule about dimmed buttons
                says a hover is nothing at all on a phone. A dotted
                underline — what every other tappable readout here
                wears — is for a line of text, not for a stack of two
                SVGs and a chip.

                It does NOT attach the session. The sheet reads its
                series by id over HTTP, so opening a row's numbers
                costs no PTY and leaves the list where it was; the
                way in to the conversation itself is the rest of the
                row, which is most of it. */}
              {s.contextSpark && (
                <span className="row-spark tappable" role="button" tabIndex={0}
                  aria-label={`what this session has cost — open the context graph for ${sessionRowTitle(s)}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openContextFor(s); } }}
                  onClick={(e) => { e.stopPropagation(); openContextFor(s); }}>
                  {costTag(s)}
                  {liveAgentTag(s)}
                  <ContextSparkline spark={s.contextSpark} value />
                  {/* The spend curve, under the window curve: what this
                      conversation has cost, against what its next turn
                      re-reads. Absent on a host that sends no `usedPts`,
                      and then the `Σ` total stays up on the first row
                      exactly as it was. */}
                  <SpendSparkline spark={s.contextSpark} />
                </span>
              )}
          </span>
        ); })()}
        {/* The BUTTONS of this strip, as one group pinned right.
            The outline used to sit on the LEFT, between the two
            counts and the badges — an action in the middle of a run
            of readouts, and ~95px the badges did not have: enough
            that the auto-continue hourglass wrapped onto a second
            line of strip while whitespace sat beside the star. It is
            a verb like the three beside it, so it reads with them.

            A wrapper rather than `margin-left: auto` on the first
            button: the auto margin belongs to the GROUP, and on each
            button it would push them APART rather than together.
            Same reason as the session header's `.hdr-ctl` — a break
            must never land between two of these. `.row-tags` takes
            the slack between, so the group sits right whether or not
            a session carries any badges at all. */}
        <span className="row-ctl">
          <button className={`row-act${s.starred ? " starred" : ""}${s.id in pendingStars ? " star-pending" : ""}`} data-hint="session.star" title={s.id in pendingStars ? (status === "open" ? "starred here — the desktop has not confirmed it yet" : "starred here — offline, so it is only on this phone until the link is back") : s.starred ? "unstar (prima interest)" : "star — mark as prima interest to come back to"} onClick={() => toggleStar(s.id, !s.starred)}><Star size={ICON} fill={s.starred ? "currentColor" : "none"} /></button>
          <button className="row-act" title="name this session" onClick={() => { void renameSession(s, liveSend); }}><Pencil size={ICON} /></button>
          <button className="row-act danger" title={s.running ? "close" : "remove"} onClick={() => closeSession(s)}><X size={ICON} /></button>
        </span>
      </div>
    </div>
  );
}
