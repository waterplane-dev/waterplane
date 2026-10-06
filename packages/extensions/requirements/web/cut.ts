/**
 * The requirements sheet's cut, in ONE place: `matches` is the predicate, and the chips' numbers, the
 * list and the "n of N" sentence are all made from it. A count on a control is a filter — the number on
 * "requested · 12" is exactly the rows a tap on it leaves, with the other axis and the search applied.
 * Pure; node-tested (`cut.test.mjs`).
 */
import type { RequirementStatus } from "@waterplane/shared";
import { askedRef } from "@waterplane/shared";
import type { ReqItem, ReqList } from "../shared/methods.mts";

export interface ReqCut { status: RequirementStatus | null; area: string | null }
export const NO_CUT: ReqCut = { status: null, area: null };

/** THE predicate: status, area, and a case-insensitive search over id, area and text. */
export function matches(it: ReqItem, cut: ReqCut, q: string): boolean {
  if (cut.status && it.status !== cut.status) return false;
  if (cut.area && it.area !== cut.area) return false;
  const n = q.trim().toLowerCase();
  return !n || `${it.id} ${it.area} ${it.text}`.toLowerCase().includes(n);
}

/** A status chip counts what is left when THAT status is chosen, keeping the area and the search. */
export const statusBucket = (items: readonly ReqItem[], cut: ReqCut, q: string) => (s: RequirementStatus) =>
  ({ count: items.filter((i) => matches(i, { ...cut, status: s }, q)).length });

/** An area chip counts what is left when THAT area is chosen, keeping the status and the search. */
export const areaBucket = (items: readonly ReqItem[], cut: ReqCut, q: string) => (a: string) =>
  ({ count: items.filter((i) => matches(i, { ...cut, area: a }, q)).length });

export const cutItems = (items: readonly ReqItem[], cut: ReqCut, q: string): ReqItem[] =>
  items.filter((i) => matches(i, cut, q));

/** What the cut is hiding, against the UNFILTERED list; null when nothing is cut. */
export function cutWords(cut: ReqCut, q: string, shown: number, all: number): string | null {
  const parts: string[] = [];
  if (cut.status) parts.push(cut.status);
  if (cut.area) parts.push(`area ${cut.area}`);
  if (q.trim()) parts.push(`“${q.trim()}”`);
  return parts.length ? [`${shown} of ${all}`, ...parts].join(" · ") : null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** How far behind the list is, in the words the setup row uses. A count that could not be made is omitted, never 0. */
export function builtWords(l: ReqList, ago: (ts: number) => string): string {
  const at = l.lastRun ? Date.parse(l.lastRun) : NaN;
  const prompts = l.promptsBehind;
  if (!Number.isFinite(at)) {
    return prompts == null ? "never built" : `never built — ${plural(prompts, "prompt")} to read`;
  }
  const parts = [`last built ${ago(at)}`];
  if (prompts != null) parts.push(`${plural(prompts, "prompt")} behind`);
  if (l.commitsBehind != null && l.commitsBehind > 0) parts.push(plural(l.commitsBehind, "commit"));
  return parts.join(" · ");
}

/** "2026-09-16 · session 61c1e521" per `asked:` entry, joined by " · "; what an entry lacks is left out. */
export function askedWords(asked: readonly string[]): string {
  return asked.map((a) => {
    const r = askedRef(a);
    const parts = [r.date, r.session ? `session ${r.session}` : r.note].filter(Boolean);
    return parts.length ? parts.join(" · ") : a.trim();
  }).join(" · ");
}
