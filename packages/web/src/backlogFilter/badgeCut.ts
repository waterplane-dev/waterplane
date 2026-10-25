/**
 * The composer's backlog button: two numbers and the one cut they open.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 *
 * A done row is not news — a repo whose one item had finished wore a "1" that
 * read as new work — so settled-and-fine rows count nowhere. What is left is
 * split in two because it asks two different things of you: *waiting* (queued
 * or running) is work still to happen, *failed* is work that needs you. One
 * tap opens BOTH as one cut, and the sheet's status chips, counted inside that
 * cut, show the same numbers split further: a count is a filter.
 */
import type { BacklogItem } from "@waterplane/shared";
import { hiddenByArchive } from "./rowFilter.ts";

export type BadgeCut = { waiting: string[]; failed: string[] };

export function backlogBadgeCut(items: Pick<BacklogItem, "id" | "archived" | "status">[]): BadgeCut {
  const cut: BadgeCut = { waiting: [], failed: [] };
  for (const it of items) {
    if (hiddenByArchive(it)) continue;
    if (it.status === "queued" || it.status === "running") cut.waiting.push(it.id);
    else if (it.status === "failed") cut.failed.push(it.id);
  }
  return cut;
}

/** The cut bar's head, naming only what the cut holds. */
export function badgeCutLabel(c: BadgeCut): string {
  if (!c.failed.length) return "waiting or running";
  return c.waiting.length ? "waiting, running or failed" : "failed";
}

/** The button's words: the numbers as a sentence, never as colour alone. */
export function badgeCutWords(c: BadgeCut): string {
  const parts = [];
  if (c.waiting.length) parts.push(`${c.waiting.length} waiting or running`);
  if (c.failed.length) parts.push(`${c.failed.length} failed`);
  return parts.length ? parts.join(", ") : "nothing waiting";
}
