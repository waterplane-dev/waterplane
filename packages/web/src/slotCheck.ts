/**
 * **The slot check, on the phone** — the pure half: when to ask, what the
 * backlog's *check these N* counts, and what the assessment sheet says about a
 * slot run and its two new kinds of card (conflict, split).
 *
 * A slot is `@waterplane/shared`'s (`intent/slot.ts`): the waiting timed rows
 * that fire TOGETHER, at one usage-window reset or one instant. CLAUDE.md: a
 * count on a control is a filter, so every number here is read off `slotOf` /
 * `slotMates` / `slotsOf` and the ids a check sends are the SAME ids the number
 * was counted from — never a second walk of the list.
 *
 * Nothing here applies anything. The ask opens a sheet; the sheet produces a
 * proposal; a conflict is words with no apply choice at all; a split is applied
 * only when ticked and only by the host.
 *
 * Pure and node-tested (`slotCheck.test.mjs`); the ask's store and its
 * per-repo switch are `slotAskStore.ts`, the card is `SlotAskLayer.tsx`.
 */
import type { AssessChoices, AssessItem, AssessProposal, AssessScope, BacklogItem, Slot, SlotRow } from "@waterplane/shared";
import {
  assessConflictSentence, assessSplitSentence, fmtWhen, inWords, parseSlotKey, slotMates, slotOf, slotOthersText,
  slotRowOfItem, slotsOf,
} from "@waterplane/shared";

/** One repo's backlog rows as slot rows — the ONE input every count here reads. */
export function slotRowsOf(items: readonly BacklogItem[], repoDir: string): SlotRow[] {
  const out: SlotRow[] = [];
  for (const it of items) {
    if (it.repoDir !== repoDir) continue;
    const r = slotRowOfItem(it);
    if (r) out.push(r);
  }
  return out;
}

/** What a check is sent with: exactly these ids, named as this slot. */
export interface SlotCheck {
  repoDir: string;
  ids: string[];
  scope: AssessScope;
  kind: Slot["kind"];
  at: number;
  period?: string;
}

export function slotCheckOf(repoDir: string, s: Slot): SlotCheck {
  return { repoDir, ids: [...s.ids], scope: { kind: "slot", key: s.key }, kind: s.kind, at: s.at, period: s.period };
}

// ── The ask after a timed send ───────────────────────────────────────────────

/** The ask, once the list holds the row: `others` IS `slotMates(...).length`. */
export interface SlotAsk { id: string; others: number; check: SlotCheck }

/**
 * **Ask about this row's slot, or not.** Null when it fires alone (no mates),
 * when the person switched the ask off in this repo, or when the row is in no
 * slot at all (recurring, unarmed, not waiting).
 */
export function slotAskFor(items: readonly BacklogItem[], repoDir: string, id: string, off: boolean): SlotAsk | null {
  if (off) return null;
  const rows = slotRowsOf(items, repoDir);
  const mates = slotMates(rows, id);
  if (!mates.length) return null;
  const slot = slotOf(rows, id);
  if (!slot) return null;
  return { id, others: mates.length, check: slotCheckOf(repoDir, slot) };
}

/** The ask's sentence: "3 others run at this reset — check them together?" */
export function slotAskText(a: SlotAsk): string {
  return `${slotOthersText(a.others, a.check.kind)} — check them together?`;
}
export const SLOT_ASK_CHECK = "check";
export const SLOT_ASK_LATER = "not now";
export const SLOT_ASK_OFF = "don't ask in this repo";
/** The control that brings the ask back — drawn in that repo's backlog only
 *  while the ask is off there, and named by the toast that switched it off. */
export const SLOT_ASK_ON_LABEL = "ask after a timed send";
export function slotAskOffToast(repoName: string): string {
  return `won't ask in ${repoName} again — “${SLOT_ASK_ON_LABEL}” in its backlog brings it back`;
}
export function slotAskOnToast(repoName: string): string {
  return `will ask again in ${repoName} when a timed send lands beside others`;
}
export const SLOT_ASK_ON_TITLE =
  "after you post a timed row here that runs together with others, offer to check them as a group";

/**
 * A timed send this phone made, waiting for the host's list to hold it.
 * `was` is the row's clock as the list showed it at the tap (null for a new
 * row): a re-time is a row that already exists, and the list that arrives
 * first may still carry its OLD clock.
 */
export interface SlotAskPending { id: string; repoDir: string; was: string | null; since: number }

/** How long a send waits for the list to hold it before the ask is given up.
 *  Offline posts reach the desktop later; past this, the backlog's own
 *  *check these N* is the way in. */
export const SLOT_ASK_WAIT_MS = 10 * 60_000;

/** A row's clock as one comparable value — rule and armed instant. */
export function clockStamp(it: Pick<BacklogItem, "at"> | undefined): string | null {
  return it?.at ? JSON.stringify([it.at.rule, it.at.nextAt]) : null;
}

export type SlotAskStep = { kind: "wait" } | { kind: "drop" } | { kind: "ask"; ask: SlotAsk };

/** What one pending send becomes on this list: still waiting, nothing to ask,
 *  or the ask. Never asks on a clock the tap did not set. */
export function resolveSlotAsk(p: SlotAskPending, items: readonly BacklogItem[], now: number, off: boolean): SlotAskStep {
  if (off || now - p.since > SLOT_ASK_WAIT_MS) return { kind: "drop" };
  const it = items.find((x) => x.id === p.id);
  if (!it) return { kind: "wait" };
  if (clockStamp(it) === p.was) return { kind: "wait" };
  const ask = slotAskFor(items, p.repoDir, p.id, off);
  return ask ? { kind: "ask", ask } : { kind: "drop" };
}

// ── The backlog's *check these N* ────────────────────────────────────────────

/** Every slot in this repo with two or more waiting rows — one verb each. */
export function slotChecks(items: readonly BacklogItem[], repoDir: string): SlotCheck[] {
  return slotsOf(slotRowsOf(items, repoDir)).filter((s) => s.ids.length >= 2).map((s) => slotCheckOf(repoDir, s));
}

function slotWhere(c: Pick<SlotCheck, "kind" | "at" | "period">): string {
  return c.kind === "reset" ? `at the ${c.period ?? "usage"} reset, ${fmtWhen(c.at)}` : `at ${fmtWhen(c.at)}`;
}

/** The verb: N is exactly `ids.length`, the rows the run will read. */
export function slotCheckLabel(c: SlotCheck, now: number): string {
  return `check these ${c.ids.length} · ${inWords(c.at, now)}`;
}
export function slotCheckTitle(c: SlotCheck): string {
  return `the ${c.ids.length} rows that run together ${slotWhere(c)} — one assessment reads them as a group `
    + "(rows that contradict each other, a row that is two jobs, their order). Nothing changes until you approve it.";
}

// ── The sheet ────────────────────────────────────────────────────────────────

/** What a slot run is, said at the top of the sheet. Null for any other run. */
export function assessSlotIntro(scope: AssessScope | undefined | null, n: number | undefined, now: number): string | null {
  if (!scope || scope.kind !== "slot") return null;
  const k = parseSlotKey(scope.key);
  const these = n ? (n === 2 ? "these two" : `these ${n}`) : "these rows";
  if (!k) return `A slot check: ${these} run together.`;
  return `A slot check: ${these} run together ${slotWhere(k)} (${inWords(k.at, now)}). `
    + "It looks for rows that contradict each other, a row that is two jobs, and the order they should go in.";
}

/** The run button when the next run is a slot check. */
export function slotRunLabel(n: number, hasRun: boolean): string {
  return `${hasRun ? "check again" : "check"} ${n === 2 ? "these two" : `these ${n}`} together`;
}

/** One of the rows a conflict or a split names, with its words — or null when
 *  this phone does not hold them (said, never hidden). */
export interface SlotCardRow { id: string; text: string | null }

const rowOf = (byId: ReadonlyMap<string, AssessItem>, id: string): SlotCardRow =>
  ({ id, text: byId.get(id)?.text ?? null });

const index = (items: readonly AssessItem[]) => {
  const m = new Map<string, AssessItem>();
  for (const it of items) if (it?.id) m.set(it.id, it);
  return m;
};

export interface ConflictCard { cid: string; sentence: string; rows: SlotCardRow[] }
export function assessConflictCards(p: AssessProposal | null, items: readonly AssessItem[]): ConflictCard[] {
  const byId = index(items);
  return (p?.conflicts ?? []).map((c) => ({ cid: c.cid, sentence: assessConflictSentence(c), rows: c.ids.map((id) => rowOf(byId, id)) }));
}
/** Above every conflict card: there is nothing to approve. */
export const CONFLICT_NOTE = "words only — nothing here is applied. Edit one, drop one, or leave them as they are.";
export const CONFLICT_DROP_LABEL = "drop this one";
export const CONFLICT_DROP_CONFIRM = "archive it?";
export const CONFLICT_DROP_TITLE = "archive this row — its words are kept and the backlog's archived cut brings it back";
export const CONFLICT_IGNORE_LABEL = "leave them";

export interface SplitCard { sid: string; id: string; sentence: string; original: SlotCardRow; texts: string[] }
export function assessSplitCards(p: AssessProposal | null, items: readonly AssessItem[]): SplitCard[] {
  const byId = index(items);
  return (p?.splits ?? []).map((s) => ({ sid: s.sid, id: s.id, sentence: assessSplitSentence(s), original: rowOf(byId, s.id), texts: [...s.texts] }));
}

/**
 * **What *check* does when the repo already has a run.** One run per repo is
 * the host's rule, and an unapplied proposal is a decision somebody has not
 * made yet — so a check never replaces one silently:
 *
 *  - `run`: nothing running, nothing waiting (or the last one was applied or
 *    failed) — start the slot check;
 *  - `same`: the proposal on file IS this slot's check — open it, spend nothing;
 *  - `busy`: a run is going — open it; the slot check is one tap on the sheet
 *    once it ends;
 *  - `waiting`: another proposal is waiting for a decision — open it, and the
 *    sheet's run button is the slot check (`slotRunLabel`).
 */
export type SlotCheckStart = "run" | "same" | "busy" | "waiting";
export function slotCheckStart(
  run: { status: string; scope?: AssessScope; scopedIds?: string[] } | null | undefined,
  c: Pick<SlotCheck, "ids" | "scope">,
): SlotCheckStart {
  if (!run || run.status === "applied" || run.status === "failed") return "run";
  if (run.status === "running") return "busy";
  const ids = run.scopedIds ?? [];
  const same = run.scope?.kind === "slot" && run.scope.key === c.scope.key
    && ids.length === c.ids.length && c.ids.every((id) => ids.includes(id));
  return same ? "same" : "waiting";
}
/** The receipt for each of those; null where opening the sheet says it all. */
export function slotCheckStartToast(s: SlotCheckStart, n: number): string | null {
  if (s === "busy") return "an assessment is already running here — when it ends, the sheet's check button runs this one";
  if (s === "waiting") return `another proposal is waiting here — decide it, or tap “${slotRunLabel(n, true)}” to replace it`;
  return null;
}

/**
 * **What Apply sends** — the ticks as `AssessChoices`. Approved splits ride in
 * `splits` (absent when none, which is what every apply sent before the slot
 * check); a conflict has NO input here at all, because it is words and there
 * is nothing about one to approve.
 */
export function assessChoicesOf(o: {
  rows: Iterable<string>; merges: Iterable<string>; news: Iterable<number>; splits: Iterable<string>;
  pinRanks?: boolean; writeNames?: boolean;
}): AssessChoices {
  const splits = [...o.splits];
  return {
    rows: [...o.rows], merges: [...o.merges], news: [...o.news],
    ...(splits.length ? { splits } : {}),
    pinRanks: o.pinRanks,
    writeNames: o.writeNames,
  };
}

/** The approve confirm's lines: both new texts in full, and what happens to the original. */
export function splitConfirmLines(c: SplitCard, repoName: string): string[] {
  return [
    `In ${repoName}, this row is archived (its words kept):`,
    c.original.text ?? `${c.id} — its words are not on this phone`,
    "and two rows are posted on the same clock:",
    `1. ${c.texts[0] ?? ""}`,
    `2. ${c.texts[1] ?? ""}`,
  ];
}
