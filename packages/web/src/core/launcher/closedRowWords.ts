/**
 * What one "Recently closed" row SAYS — the pure half of `ClosedRows.tsx`.
 *
 * A closed row is recognised by what it WAS (the backlog item it ran, its tab
 * name, how it was opened) and why it ENDED (you, a relaunch, the host closing
 * it on its own, the CLI exiting, a usage limit). Every fact beyond the
 * original id/cwd/title/closedAt is optional on the wire (`ClosedSession`,
 * `shared/closed.ts`) and ABSENT means the host did not know — an older row, a
 * close no code path names — so every function here answers `undefined` (or
 * drops the line) rather than guessing. An old row renders exactly as before:
 * its title, and nothing else from here.
 *
 * `closedCut` is the ONE bucketing function behind both a chip's number and
 * the cut it opens (a count on a control is a filter).
 *
 * No React, no DOM — tested by `closedRowWords.test.mjs` under `node --test`.
 */
import type { ClosedSession, SessionOriginKind } from "@waterplane/shared";
import { trimDefaultBranch } from "@waterplane/shared";

/** The row's headline: the item it ran, else its derived tab name, else the
 *  folder title (default branch trimmed), as the row always said. */
export function closedHeadline(c: ClosedSession): string {
  return c.itemLabel || c.tabTitle || trimDefaultBranch(c.title) || c.title;
}

/** The folder title under the headline — only when the headline is NOT it
 *  already (an old row says its title once, not twice). */
export function closedSubtitle(c: ClosedSession): string | undefined {
  const folder = trimDefaultBranch(c.title) || c.title;
  return folder && folder !== closedHeadline(c) ? folder : undefined;
}

const KIND_WORDS: Record<SessionOriginKind, string> = {
  hand: "by hand",
  fork: "fork",
  backlog: "backlog",
  schedule: "scheduled",
  agent: "agent",
  fanout: "fan-out",
  resurrect: "reopened after limit",
};

/** How the session was opened, as a chip's words; absent kind ⇒ no chip. */
export function closedKindWord(c: ClosedSession): string | undefined {
  return c.kind && c.kind in KIND_WORDS ? KIND_WORDS[c.kind] : undefined;
}

/** Closed by the HOST, not a person and not the CLI: close-when-done after
 *  the work finished, or reaped early to free a slot for a waiting item. */
export function isAutoClosed(c: ClosedSession): boolean {
  return c.closedBy === "auto-done" || c.closedBy === "auto-slot";
}

/** Nobody closed it: the desktop restarted under it, or it ended while
 *  the host was not running to see it. */
export function isCutOff(c: ClosedSession): boolean {
  return c.closedBy === "reboot" || c.closedBy === "lost";
}

/** `quiet` is the everyday case (said small), `auto` the host's own close and
 *  `cut` one nobody chose (both marked with a pill), `note` an end worth a
 *  second look (exit, limit). */
export type ClosedTone = "quiet" | "auto" | "cut" | "note";

/** Why it ended, in words; absent `closedBy` ⇒ nothing. */
export function closedReason(c: ClosedSession): { text: string; tone: ClosedTone } | undefined {
  switch (c.closedBy) {
    case "you": return { text: "closed by you", tone: "quiet" };
    case "replaced": return { text: "replaced by a relaunch", tone: "quiet" };
    case "auto-done": return { text: "closed automatically — work finished", tone: "auto" };
    case "auto-slot": return { text: "closed automatically to make room for a waiting item", tone: "auto" };
    case "exited": {
      if (typeof c.exitSignal === "number" && c.exitSignal !== 0) return { text: `ended on its own (signal ${c.exitSignal})`, tone: "note" };
      if (typeof c.exitCode === "number" && c.exitCode !== 0) return { text: `ended on its own (exit ${c.exitCode})`, tone: "note" };
      return { text: "ended on its own", tone: "quiet" };
    }
    case "limit":
      return { text: c.resumedAs ? "stopped at usage limit — reopened" : "stopped at usage limit", tone: "note" };
    case "reboot": return { text: "stopped by a desktop restart", tone: "cut" };
    case "lost": return { text: "ended while the desktop was not watching", tone: "cut" };
    default: return undefined;
  }
}

/** The item's settled outcome (+ its one-line detail); nothing when the item
 *  never settled or the row has no item. */
export function closedOutcome(c: ClosedSession): { text: string; tone: "ok" | "bad" | "muted" } | undefined {
  if (!c.itemState) return undefined;
  const tail = c.itemDetail ? `: ${c.itemDetail}` : "";
  if (c.itemState === "canceled") return { text: `item canceled${tail}`, tone: "muted" };
  if (c.itemState === "failed" || c.itemOk === false) return { text: `item failed${tail}`, tone: "bad" };
  return { text: `item done${tail}`, tone: "ok" };
}

/** A SPAN of time, compact: "40s", "12m", "2h 5m", "3d 4h". */
export function spanWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** The small print: how long it was open, when it last did something, how
 *  many prompts went in from here (a FLOOR — desk-typed ones are not
 *  counted, so the words say "from here"), the model. Each piece only when
 *  known; an old row gets an empty list. */
export function closedMeta(c: ClosedSession, now: number): string[] {
  const out: string[] = [];
  if (typeof c.openedAt === "number" && c.closedAt >= c.openedAt) out.push(`open ${spanWords(c.closedAt - c.openedAt)}`);
  if (typeof c.lastActiveAt === "number") out.push(`last active ${spanWords(now - c.lastActiveAt)} ago`);
  if (typeof c.turns === "number" && c.turns > 0) out.push(`${c.turns} prompt${c.turns === 1 ? "" : "s"} sent from here`);
  if (c.model) out.push(c.model);
  return out;
}

/** This list's filters: what the person marked, the sessions nobody closed, the host's own closes. */
export const CLOSED_FILTERS = ["starred", "flagged", "cut", "auto"] as const;
export type ClosedFilterKey = (typeof CLOSED_FILTERS)[number];
export type ClosedFilter = ClosedFilterKey | null;
// closed: the keys are this screen's own chips, never on the wire
export const CLOSED_FILTER_LABEL: Record<ClosedFilterKey, string> = {
  starred: "starred",
  flagged: "flagged",
  cut: "stopped unexpectedly",
  auto: "closed automatically",
};

/** The rows a filter shows — and, by length, the number on its chip. */
export function closedCut(rows: readonly ClosedSession[], f: ClosedFilter): ClosedSession[] {
  switch (f) {
    case "starred": return rows.filter((c) => !!c.starred);
    case "flagged": return rows.filter((c) => !!c.followUp);
    case "cut": return rows.filter(isCutOff);
    case "auto": return rows.filter(isAutoClosed);
    case null: return [...rows];
  }
}

/** "2 of 7 shown — closed automatically": what the filtered view hides. */
export function closedFilterWords(shown: number, total: number, f: ClosedFilterKey): string {
  return `${shown} of ${total} shown — ${CLOSED_FILTER_LABEL[f]}`;
}
