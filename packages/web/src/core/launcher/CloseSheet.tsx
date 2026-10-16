/**
 * The bulk-close sheet — every listed session, or one repo's, cut by
 * combinable facets instead of the five single-cut buttons `CloseAllPicker.tsx`
 * used to offer. Facets AND together, the options inside one OR (`closeModel.ts`).
 *
 * Replaces `core/launcher/CloseAllPicker.tsx` (deleted): that dialog could not
 * combine cuts, closed a NUMBER rather than a reviewable list, was blind to
 * agents/shells/drafts/queued words, and silently orphaned background shells.
 * This sheet shows every row it is about to touch (`SessionFacts`, plus a
 * "keep" toggle per row) and says what it stops before it stops it.
 *
 * A full `Sheet`, layered over the launcher the way `RetimeBar.tsx` layers its
 * own editor over a list — `useBackStep` gives it its own Back/gesture step
 * without needing a route of its own, and closing it (any way) resets every
 * facet and every per-row keep: nothing here is worth restoring after a reload
 * or a second look.
 */
import { useEffect, useState } from "react";
import { CircleDot, Clock, ShieldCheck, SquareTerminal, X } from "lucide-react";
import type { SessionInfo } from "@waterplane/shared";
import { shellsChipText, shellsSummary } from "@waterplane/shared";
import { Sheet } from "../../Sheet";
import { ConfirmButton } from "../../Confirm";
import { Empty } from "../../Empty";
import { Explain } from "../../Explain";
import { useBackStep } from "../../backStep";
import { SessionFacts, sessionStatus } from "../../sessionFacts";
import { draftSessionIds } from "../../outbox";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { noteSessionClosing } from "../../features/shells";
import { useBacklog } from "../../features/backlog";
import { FilterChip } from "../../kit/FilterChip";
import { RadioRows } from "../../kit/RadioRows";
import { chipText } from "../../kit/chips";
import { hhmm } from "../../format";
import type { LauncherProps } from "./types";
import type { LauncherModel } from "./useLauncherModel";
import { closeMarked, closeScope, markedWords, starredSpared } from "./model";
import {
  CLOSE_STATE_OPTIONS, CONVO_OPTIONS, type CloseFacets, type CloseCtx, EMPTY_CLOSE_FACETS, STAKES_OPTIONS,
  TIME_EDGE_OPTIONS, UNDER_OPTIONS, CLOSE_STATE_LABEL, CONVO_LABEL, STAKES_LABEL, TIME_EDGE_LABEL, UNDER_LABEL,
  closeCut, closeFacetCounts, closeFilterBarLabel, closeFacetsActive, closeFootLabel, closeSendList,
  closeShellsAtStake, closeToast, closeWaitingCount, idleUnknownNote, isKept, timedKeptNote,
} from "./closeModel";

const ICON = 16;

/** One facet: its label, and beside it a kit `FilterChip` per option some
 *  session here answers. Every option that NO session answers is still said —
 *  once, in one lower-case line under the chips ("none: idle, exited") —
 *  because a filter left off the strip without a word reads as a filter that
 *  does not exist: the rule `Unavailable.tsx` states for a verb, applied here
 *  to a filter, and why nothing about this sheet may go quiet by omission. An
 *  option that is ACTIVE stays a chip even at 0, so a tap that emptied it can
 *  still be taken back. A facet with no chip at all is its label and that one
 *  line. None of it sits in a `.section`, whose uppercase shouted the line. */
function FacetRow<K extends string>({ label, options, counts, active, labels, onToggle, hintId }: {
  label: string;
  options: readonly K[];
  counts: Record<K, number>;
  active: ReadonlySet<K>;
  labels: Record<K, string>;
  onToggle: (o: K) => void;
  /** Explain-mode entry (`shared/hints.ts`) for the whole facet — only the
   *  "Idle for" row carries one today. */
  hintId?: string;
}) {
  const shown = options.filter((o) => counts[o] > 0 || active.has(o));
  const none = options.filter((o) => !(counts[o] > 0 || active.has(o)));
  return (
    <div className="close-facet" data-hint={hintId}>
      <span className="close-facet-label">{label}</span>
      <div className="close-facet-body">
        {shown.length > 0 && (
          <div className="fchips wrap">
            {shown.map((o) => (
              <FilterChip key={o} on={active.has(o)}
                title={`${labels[o]} — ${counts[o]} session${counts[o] === 1 ? "" : "s"}`}
                onClick={() => onToggle(o)}>
                {chipText(labels[o], { count: counts[o] })}
              </FilterChip>
            ))}
          </div>
        )}
        {none.length > 0 && <div className="close-facet-none">{`none: ${none.map((o) => labels[o]).join(", ")}`}</div>}
      </div>
    </div>
  );
}

/** `idleUnknownNote` is one sentence with one dash: the fact, then what it
 *  does to the "idle for" chips. The fact is the line; the why is a closed `?`
 *  (it was three lines of prose, always drawn, over the chips it qualifies).
 *  The words are the model's — this only cuts them at the dash. No dash, no
 *  `?`: the whole sentence stays the line. */
function splitIdleNote(note: string): [lead: string, why: string] {
  const at = note.indexOf(" — ");
  if (at < 0) return [note.replace(/\.$/, ""), ""];
  const why = note.slice(at + 3);
  return [note.slice(0, at), why.charAt(0).toUpperCase() + why.slice(1)];
}

function toggled<T>(set: ReadonlySet<T>, o: T): Set<T> {
  const next = new Set(set);
  if (next.has(o)) next.delete(o); else next.add(o);
  return next;
}

function CloseRow({ s, repoLabel, kept, onToggleKeep, statusOf, now, timedAt, backends }: {
  s: SessionInfo; repoLabel?: string; kept: boolean; onToggleKeep: () => void;
  statusOf: (s: SessionInfo) => string; now: number; backends: LauncherProps["backends"];
  /** When the timed prompt aimed at this session fires, as words. */
  timedAt?: string;
}) {
  const waiting = statusOf(s) === "wait";
  return (
    <div className="row-wrap">
      <div className="row grow" style={{ cursor: "default" }}>
        <SessionFacts s={s} repoLabel={repoLabel} backends={backends} />
        {s.shellList?.length ? (
          <span className="row-sub"><SquareTerminal size={11} /> {shellsChipText(shellsSummary(s.shellList, now))} — will stop</span>
        ) : null}
        {timedAt && <span className="row-sub"><Clock size={11} /> a prompt is timed into it · {timedAt}{kept ? " — kept open" : " — its conversation is reopened then"}</span>}
        {waiting && <span className="row-sub warn"><CircleDot size={11} /> waiting on a box — closing answers nothing, it just ends the process</span>}
      </div>
      <button className={`row-act${kept ? " on" : ""}`}
        title={kept ? "kept — tap to put it back in this close" : "keep — leave this one open"}
        onClick={onToggleKeep}>
        <ShieldCheck size={ICON} />
      </button>
    </div>
  );
}

export function CloseSheet({ p, m }: { p: LauncherProps; m: LauncherModel }) {
  const { send } = p.conn;
  const {
    closeAllPick, setCloseAllPick, closeKeepStar, setCloseKeepStar, visibleSessions, sessionRepoName,
  } = m;
  const open = closeAllPick !== null;
  useBackStep(open, () => setCloseAllPick(null));

  const [facets, setFacets] = useState<CloseFacets>(EMPTY_CLOSE_FACETS);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  // Sessions a timed prompt is aimed at, and when it fires — they start KEPT.
  const { items: backlogItems } = useBacklog();
  // Facets reset on close — nothing here is worth restoring, and a filter
  // that survived would open the NEXT close on whatever the last one left.
  useEffect(() => { if (!open) { setFacets(EMPTY_CLOSE_FACETS); setKept(new Set()); } }, [open]);

  if (!open) return null;
  const repo = closeAllPick === "*" ? undefined : closeAllPick;
  const now = Date.now();
  const scope = closeScope(visibleSessions, repo, closeKeepStar, sessionRepoName);
  const sparedStars = starredSpared(visibleSessions, repo, closeKeepStar, sessionRepoName);
  // Stars and follow-up flags, one toggle (`isCloseSpared`).
  const marked = closeMarked(visibleSessions, repo, sessionRepoName);
  const starsHere = marked.n;
  const markedHere = markedWords(marked);

  const ctx: CloseCtx = {
    now, repoName: sessionRepoName,
    // `sessionFacts.tsx`'s ONE copy of the status ladder — never a second one.
    statusOf: (s) => sessionStatus(s, p.backends),
    draftIds: draftSessionIds(),
    outbox: p.outbox,
  };
  const repoNames = repo ? [] : [...new Set(scope.map(sessionRepoName))].sort();
  const counts = closeFacetCounts(scope, facets, ctx, repoNames);
  const cut = closeCut(scope, facets, ctx);
  const timedAt = new Map<string, string>();
  for (const it of backlogItems) {
    if (it.status !== "queued" || !it.at || !it.targetSessionId || timedAt.has(it.targetSessionId)) continue;
    timedAt.set(it.targetSessionId, it.at.nextAt != null ? hhmm(it.at.nextAt) : "when its rule comes round");
  }
  const timed = new Set(timedAt.keys());
  const sendList = closeSendList(cut, kept, timed);
  const timedNote = timedKeptNote(cut.filter((s) => timed.has(s.id) && isKept(s.id, kept, timed)).length);
  const shells = closeShellsAtStake(sendList);
  const waitingN = closeWaitingCount(sendList, ctx);
  const footLabel = closeFootLabel(sendList.length, shells);
  const [idleLead, idleWhy] = splitIdleNote(idleUnknownNote(counts.idleUnknown));

  function set<K extends keyof CloseFacets>(key: K, next: CloseFacets[K]) {
    setFacets((f) => ({ ...f, [key]: next }));
  }
  function clearFacets() { setFacets(EMPTY_CLOSE_FACETS); }
  function toggleKeep(id: string) { setKept((k) => toggled(k, id)); }

  function fire() {
    if (!sendList.length) return;
    track(`action:${repo ? "repo" : "session"}.close.facets`);
    // Mark every id THIS phone is asking to close — `session.closed` is a
    // broadcast, and this is what keeps its shells-stopped toast off every
    // OTHER open phone (`features/shells/store.ts`).
    for (const s of sendList) { noteSessionClosing(s.id); send({ t: "session.remove", id: s.id }); }
    setCloseAllPick(null);
    showToast(closeToast(sendList.length, shells, sparedStars > 0 ? markedHere : "", repo));
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 30, background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <Sheet
        title={repo ? `Close sessions in ${repo}?` : "Close sessions?"}
        icon={<X size={ICON} />}
        onClose={() => setCloseAllPick(null)}
        footer={
          <>
            {footLabel ? (
              <ConfirmButton className="key danger" confirm={`tap again to ${footLabel}`}
                title={footLabel} confirmTitle={`tap again to ${footLabel}`}
                onConfirm={fire}>
                <X size={ICON} /> {footLabel}
              </ConfirmButton>
            ) : (
              <div className="form-hint">
                {scope.length === 0
                  ? (sparedStars > 0
                    ? `Nothing left to close — every session here is starred or flagged. "Close them too" below puts ${sparedStars === 1 ? "it" : "them"} back in reach.`
                    : "Nothing here to close.")
                  : "Nothing in the cut, or every matching row is kept — nothing to send."}
              </div>
            )}
            <div className="form-hint">Conversations are kept — reopen under "Recently closed" or Archive.</div>
          </>
        }
      >
        {/* The ONE scroller: `Sheet` lays out head / children / footer in a
            100%-high column and scrolls nothing itself, so without this the
            chips and rows overflowed the fixed frame — no scroll, and the
            footer's close button pushed off the bottom of the screen. */}
        <div className="sheet-body">
        {starsHere > 0 && (
          <div className="section">
            <div style={{ padding: "10px 12px 0" }}>
              <RadioRows<"keep" | "close">
                label="what happens to the starred and flagged sessions"
                value={closeKeepStar ? "keep" : "close"}
                options={[
                  { key: "keep", label: `keep ${markedHere}`, title: `leave the ${markedHere} session(s) alone — out of every count and cut below` },
                  { key: "close", label: "close them too", title: `treat the ${markedHere} session(s) like any other` },
                ]}
                onChange={(k) => setCloseKeepStar(k === "keep")}
              />
            </div>
          </div>
        )}

        {closeFacetsActive(facets) && (
          <div className="filter-bar">
            <span className="filter-bar-txt">{closeFilterBarLabel(cut.length, scope.length, facets)}</span>
            <button className="filter-bar-clear" onClick={clearFacets}><X size={13} /> clear</button>
          </div>
        )}

        <div className="close-facets">
        <FacetRow label="State" options={CLOSE_STATE_OPTIONS} counts={counts.state} active={facets.state}
          labels={CLOSE_STATE_LABEL} onToggle={(o) => set("state", toggled(facets.state, o))} />
        <FacetRow label="Idle for" options={TIME_EDGE_OPTIONS} counts={counts.idleOver} active={facets.idleOver}
          labels={TIME_EDGE_LABEL} onToggle={(o) => set("idleOver", toggled(facets.idleOver, o))} hintId="session.close.stale" />
        {idleLead && (
          <div className="form-hint">
            {idleLead}.{" "}
            {idleWhy && <Explain of="the idle-for reading" label="what does that change?">{idleWhy}</Explain>}
          </div>
        )}
        <FacetRow label="Open for" options={TIME_EDGE_OPTIONS} counts={counts.openOver} active={facets.openOver}
          labels={TIME_EDGE_LABEL} onToggle={(o) => set("openOver", toggled(facets.openOver, o))} />
        <FacetRow label="Underneath" options={UNDER_OPTIONS} counts={counts.under} active={facets.under}
          labels={UNDER_LABEL} onToggle={(o) => set("under", toggled(facets.under, o))} />
        <FacetRow label="Words at stake" options={STAKES_OPTIONS} counts={counts.stakes} active={facets.stakes}
          labels={STAKES_LABEL} onToggle={(o) => set("stakes", toggled(facets.stakes, o))} />
        <FacetRow label="Conversation" options={CONVO_OPTIONS} counts={counts.convo} active={facets.convo}
          labels={CONVO_LABEL} onToggle={(o) => set("convo", toggled(facets.convo, o))} />
        {!repo && repoNames.length > 1 && (
          <FacetRow label="Repo" options={repoNames} counts={counts.repo} active={facets.repo}
            labels={Object.fromEntries(repoNames.map((n) => [n, n]))} onToggle={(o) => set("repo", toggled(facets.repo, o))} />
        )}
        </div>

        {timedNote && <div className="form-hint">{timedNote}</div>}
        {/* Sentence case like the facet labels above it: `.section` uppercases. */}
        <div className="section section-head close-cut"><span>The cut{waitingN > 0 ? ` · ${waitingN} waiting on a box` : ""}</span></div>
        {cut.length === 0 ? (
          <Empty>Nothing here matches every facet ticked above.</Empty>
        ) : (
          cut.map((s) => (
            <CloseRow key={s.id} backends={p.backends} s={s} repoLabel={repo ? undefined : sessionRepoName(s)} kept={isKept(s.id, kept, timed)}
              onToggleKeep={() => toggleKeep(s.id)} statusOf={ctx.statusOf} now={now} timedAt={timedAt.get(s.id)} />
          ))
        )}
        </div>
      </Sheet>
    </div>
  );
}
