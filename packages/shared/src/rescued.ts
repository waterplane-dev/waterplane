/**
 * **A backlog row the app filed for the person, from words it rescued.**
 *
 * When the phone saves words nobody sent (a draft stranded under a pending id
 * that never opened, a draft about to be seeded over, a dictation whose box was
 * gone) they used to land on the pad, where nothing counts them. They now land
 * on the backlog of the repo they belong to, marked `rescued` with a one-line
 * reason: never auto-fired (the row is `manual`), counted on the launcher's
 * repo row ("N rescued"), and cleared from that count the moment the row is
 * sent or discarded. One bucketing function (`isRescuedOpen`) feeds both the
 * number and the cut it opens, so the chip and the list cannot disagree.
 *
 * Optional on every DTO: an older host or phone drops it and the row is an
 * ordinary manual one. Pure; no clock.
 */

/** The mark: why the app filed it, and when. Absent = a person filed it. */
export interface Rescued {
  why: string;
  at: number;
}

/** One line of at most this many characters; longer is clipped, never dropped. */
export const MAX_RESCUED_WHY = 120;

/** The mark off the wire or a hand-edited file: both fields or nothing. */
export function cleanRescued(raw: unknown): Rescued | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as { why?: unknown; at?: unknown };
  if (typeof r.why !== "string") return undefined;
  const why = r.why.trim().replace(/\s+/g, " ").slice(0, MAX_RESCUED_WHY).trim();
  if (!why || typeof r.at !== "number" || !Number.isFinite(r.at)) return undefined;
  return { why, at: r.at };
}

/** The minimal row facts the bucketing reads (a `BacklogItem` satisfies it). */
export interface RescueFacts {
  rescued?: Rescued;
  status: string;
  archived?: boolean;
}

/**
 * Still waiting for a person: marked rescued, not archived, and not yet sent or
 * discarded. A row that ran (`running`/`done`/`failed`) has been taken care of,
 * and a discarded one is gone from the list. A failed row stays out on purpose:
 * it is Activity's account now, not an unattended rescue.
 */
export function isRescuedOpen(it: RescueFacts): boolean {
  return !!it.rescued && !it.archived && (it.status === "queued" || it.status === "blocked");
}

/** The ONE count and cut: `rows.filter(isRescuedOpen)`. */
export function rescuedOpen<T extends RescueFacts>(rows: readonly T[]): T[] {
  return rows.filter(isRescuedOpen);
}

/** Why a draft was rescued: the reasons the three automatic paths give. */
export const RESCUE_WHY = {
  neverOpened: "Typed for a session that never opened.",
  replaced: "A draft that was about to be replaced by new words.",
  dictation: "A dictation that could not reach the box it was said for.",
} as const;

/** The receipt, saying where the words went. */
export function rescuedFiledToast(repo: string, offline: boolean): string {
  return offline
    ? `kept as rescued in ${repo}'s backlog — it reaches the desktop when the link is back`
    : `kept in ${repo}'s backlog as rescued`;
}

/** The pad fallback's receipt: nowhere to file it, so it is on the pad. */
export const RESCUED_PAD_TOAST = "no repo to file them under — kept on the pad";

/** The chip on a repo row. */
export function rescuedChipText(n: number): string {
  return `${n} rescued`;
}

/** The sentence on the backlog row (TEXT, never a title). */
export function rescuedRowWords(r: Rescued): string {
  return `Rescued — ${r.why}`;
}
