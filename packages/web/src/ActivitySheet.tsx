/**
 * Activity — the one "what happened to my stuff" screen.
 *
 * Decision 5 of the rework: two surfaces, not twelve. This is the second one.
 * Every posted piece of work is ONE row for its whole life, with an honest
 * verdict and at least one action; a row never vanishes on a state change, it
 * changes verdict. It replaces the send queue sheet, the give-ups list buried
 * in network diagnostics, the schedule list, the fan-out runs, the build runs,
 * the launch gate and the download queue — seven partial ledgers that between
 * them made "did my prompt run?" a question with no answer screen.
 *
 * ── What this file is and is not ───────────────────────────────────────────
 *
 * It is a VIEW. Every decision — which lifecycle a source's status maps onto,
 * which sentence a blocked row says, which action is disabled and why, which
 * chip a row falls under, and the order — is `activityRows.ts`'s, computed
 * once, and re-deriving any of it here would put a second explanation next to
 * the behaviour it explains. The list this renders arrives ranked; nothing
 * below sorts, filters on a fact the selector did not publish, or invents a
 * sentence.
 *
 * It is also NOT the owner of what the actions do. It takes them as callbacks
 * and hands back the row, because a "cancel" is a different message per source
 * and routing it is App's job. What this file guarantees is that the tap
 * happens on a control which said, before it was pressed, what it would do —
 * and that a control which cannot be pressed said why.
 *
 * ── Phone first, and a link that may be dead ───────────────────────────────
 *
 * Every row here is renderable from state the phone already holds: the send
 * queue and the give-ups ledger are localStorage, the download records are
 * IndexedDB, and the host-sourced lists are App's snapshots. So the sheet opens
 * and paints with the tunnel down — which is the state it will most often be
 * opened in, because a dead tunnel is what makes a person ask where their
 * prompt went. Rows that are LAST KNOWN rather than live say so, per row, with
 * their age; the phone's own rows do not, because they are the original.
 *
 * One thumb: a row's primary action is a full-width-ish button on its own line,
 * and the rest live behind "more" so the prose is never squeezed into four
 * characters by a strip of eight icons — the mistake `QueueSheet` had to undo.
 *
 * ── Triage: the size this list actually reaches ────────────────────────────
 *
 * One real phone, first use: 217 rows, 84 of them failed. Every row being
 * individually actionable is correct and, at 84, the same as not being
 * actionable at all — the user's question was "how do I clean it up in the
 * sense of finding out what still makes sense to implement, and fire the
 * request". That is three steps: read what never ran, decide (still wanted /
 * already done / obsolete), fire the survivors. The screen carries one thing
 * for each:
 *
 *   • **grouped** — identical words collapse to one strip that says ×N and,
 *     crucially, whether one of those copies ALREADY RAN. The unresolved sends
 *     are mostly repeated re-sends of the same few texts, which is what a person
 *     does when the app tells them their prompt did not run; collapsing them
 *     turns eighty-four rows into a dozen decisions.
 *   • **hide chatter** — "continue please", "done?", a bare `/cost`. Not lost work,
 *     and re-reading it is pure cost. Off by default and it names its count,
 *     because a filter that removes rows from the screen you opened to find a
 *     lost prompt must be a deliberate tap.
 *   • **oldest first** — the triage order. A ranked list buries the rows that have
 *     been waiting longest, which is how eighty-four of them accumulated.
 *   • **select** + the bulk bar — file many away, or send many again, in one
 *     confirmation with a count and a sample of the actual words.
 *
 * Filing is not deleting: the row keeps its words, its verdict and its buttons
 * under the `dismissed` chip, and one tap brings it back. That is the whole
 * reason a bulk button over eighty-four prompts is allowed to exist here.
 *
 * ── This file is the FACADE ──────────────────────────────────────────────
 *
 * It composes the regions in the order the one component used to draw them.
 * The state and every derived list are `activity/useActivityModel.ts`; the
 * regions (`activity/Activity*.tsx`) read that model and hold no hooks, so the
 * hook order stays what it was. A row and a group of rows keep their own
 * disclosure state (`ActivityRowCard.tsx`, `ActivityGroupCard.tsx`).
 * `ReviewMarks` and `ActivitySheetProps` are re-exported from here.
 */
import { Hourglass } from "lucide-react";
import { Sheet } from "./Sheet";
import { ActivityBulkBar } from "./activity/ActivityBulkBar";
import { ActivityHead } from "./activity/ActivityHead";
import { ActivityList } from "./activity/ActivityList";
import { ActivityNotices } from "./activity/ActivityNotices";
import { useActivityModel } from "./activity/useActivityModel";
import type { ActivitySheetProps } from "./activity/activitySheetTypes";
import { SHEET } from "./sheetNames";

export type { ActivitySheetProps, ReviewMarks } from "./activity/activitySheetTypes";

export function ActivitySheet(p: ActivitySheetProps) {
  const m = useActivityModel(p);
  const { PeerJobs } = m;
  return (
    <Sheet title={SHEET.activity} icon={<Hourglass size={18} />} onClose={p.onClose}
      footer={m.selecting ? <ActivityBulkBar m={m} p={p} /> : null}
      head={<ActivityHead m={m} />}>
      <ActivityNotices m={m} online={p.online} />
      {/* ONE scroll region: as flex siblings the list shrank to nothing beside peer jobs. */}
      <div className="sheet-scroll">
        <ActivityList m={m} p={p} />
        {/* Work handed to a paired desktop (absent if it never delegated). Not under a cut:
            "showing the messages that were not delivered" over peer jobs would be a lie. */}
        {PeerJobs && !m.focus && m.filter === "all" && <PeerJobs sessions={p.sessions} onOpenSession={p.onOpenSession} />}
      </div>
    </Sheet>
  );
}
