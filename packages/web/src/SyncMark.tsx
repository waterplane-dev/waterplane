/**
 * **"Is this anywhere but this phone?" — as one line, written once.**
 *
 * Every screen that edits synced content gets the same sentence from the same
 * store (`syncState.ts`), for `Empty.tsx`'s reason: a rule stated on six
 * screens is a rule that reads six ways within a month, and this one is about
 * whether a person's own words exist anywhere else.
 *
 * Deliberately NOT a badge or a dot. A dot is the thing this replaces — the
 * green light beside a sheet that has not reached the desktop since Tuesday —
 * and the whole complaint behind this feature was an interface that looked
 * identical whether the desktop had your notes or not. So it is prose, it is
 * legible on a phone, and `synced` says so out loud rather than by absence:
 * the state a person most needs confirmed is the good one.
 */
import { useEffect, useState } from "react";
import { CircleCheck, CircleSlash, CloudOff, CloudUpload, RefreshCw, type LucideIcon } from "lucide-react";
import { rowChipWord, subscribeSync, syncSentence, syncSummary, worstSync, type SyncPhase } from "./syncState";

/**
 * The good state is a GREEN CHECK, and that is the whole point of the mark.
 *
 * It used to be a muted cloud, on the argument that a reassurance should not
 * shout. That was the wrong read of what is being reassured: the question is
 * "can I put the phone down now", the answer is a yes or a no, and a grey cloud
 * beside grey prose is a shape the eye skips on a screen it is scanning for
 * exactly one thing. Green is the colour this app already uses for "this
 * happened and it worked" (`--ok`), and a check is the mark a person is looking
 * for when they ask that question.
 */
const ICON: Record<Exclude<SyncPhase, "unknown">, LucideIcon> = {
  synced: CircleCheck,
  pending: CloudUpload,
  offline: CloudOff,
  superseded: RefreshCw,
  failed: CircleSlash,
};

export function SyncMark({ keys, thing = "these" }: {
  /** The synced `localStorage` keys this screen edits. */
  keys: readonly string[];
  /** What the sentence is about, in OBJECT position: "…{thing} are still only
   *  on this phone". Plural, because every sentence here is. */
  thing?: string;
}) {
  // Coarse on purpose: the store emits on any change and a sheet shows one
  // line, so a per-key subscription would be machinery with no reader.
  const [, bump] = useState(0);
  useEffect(() => subscribeSync(() => bump((n) => n + 1)), []);
  const state = worstSync(keys);
  const text = syncSentence(state, thing);
  // `unknown` renders NOTHING. Between a cold start and the `settings.all` that
  // lands on hello there is no honest answer, and that window is exactly when a
  // confident "synced" would be the most damaging thing to print.
  if (!text) return null;
  const Icon = ICON[state.phase as Exclude<SyncPhase, "unknown">];
  return (
    <div className={`sync-mark sync-${state.phase}`}>
      <Icon size={12} />
      <span>{text}</span>
    </div>
  );
}

/**
 * The same fact on a LIST ROW, where the sentence does not fit.
 *
 * A chip, not a dot: it carries a word (`syncChipWord`), and the sentence is
 * its `title` rather than being lost. The vocabulary, the colours and the icons
 * are the ones above — a row saying "on desktop" in green and a sheet saying
 * "saved on the desktop" in green are one claim, made twice at two sizes,
 * which is the only way six screens can stay in step about it.
 *
 * `unknown` renders NOTHING, for the reason the mark does: between a cold start
 * and the host's own listing there is no honest answer, and that gap is exactly
 * where a confident green check would do the damage.
 *
 * A row is still never silent about the good case BY DEFAULT. `saidAbove` is
 * for a list that says it once at its head instead (`SyncSummary`): every card
 * wearing the same green "on desktop" was one fact printed per row, and it hid
 * the exception it exists to show. With `saidAbove` this draws only the
 * exceptions; the list that passes it owes the head.
 */
export function SyncChip({ phase, thing = "it", plural = false, saidAbove = false }: {
  phase: SyncPhase;
  /** What the title sentence is about, in object position. */
  thing?: string;
  /** A row is one thing, so the sentence is singular by default here and plural
   *  in `SyncMark` — one table of wordings, agreeing with its caller. */
  plural?: boolean;
  /** The list's head draws `SyncSummary`, so the synced case is said there. */
  saidAbove?: boolean;
}) {
  const word = rowChipWord(phase, saidAbove);
  if (!word) return null;
  const Icon = ICON[phase as Exclude<SyncPhase, "unknown">];
  return (
    <span className={`tag sync-chip sync-${phase}`} title={syncSentence({ phase, wroteAt: null, ackedAt: null }, thing, plural) ?? undefined}>
      <Icon size={12} /> {word}
    </span>
  );
}

/**
 * The good case of a LIST, said once in its head — the other half of
 * `SyncChip`'s `saidAbove`. Same chip, same green, same word; it counts
 * ("3 of 4 on desktop") when a row below is the exception, and draws nothing
 * when no row is on the desktop (`syncSummary`).
 */
export function SyncSummary({ phases }: { phases: readonly SyncPhase[] }) {
  const s = syncSummary(phases);
  if (!s) return null;
  return (
    <span className="tag sync-chip sync-synced" title={s.title}>
      <CircleCheck size={12} /> {s.word}
    </span>
  );
}
