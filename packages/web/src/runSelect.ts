import { droppedWords, type FireFate } from "./core/queue/fireFate.ts";

/**
 * Which build run is open. `null` = the newest (so a run just started is the
 * one you see), `""` = none (folded away), an id = that run. An id that is no
 * longer in the list selects NOTHING and says so (`gone`): the old
 * `find(id) ?? runs[0]` opened the repo's newest run of any build instead of
 * the one a schedule card's "last run" door named.
 */
export function selectRun<R extends { runId: string }>(runs: readonly R[], sel: string | null, listed = true, pool: readonly R[] = runs): { run: R | null; gone: boolean } {
  if (sel === "") return { run: null, gone: false };
  if (sel === null) return { run: runs[0] ?? null, gone: false };
  // An id is looked up in `pool` (the UNCUT list): a run that left a status cut
  // but is still in the list stays open; `gone` means gone from the list.
  const run = pool.find((r) => r.runId === sel) ?? null;
  // `gone` is a claim about the HOST's list: until that list was read after the
  // id was asked for, a miss only means "not here yet".
  return { run, gone: run === null && listed };
}

/**
 * The rows to draw: the newest `cap`, plus the selected run when it lies beyond
 * them (appended), so a selected run is always drawn.
 */
export function drawnRuns<R extends { runId: string }>(runs: readonly R[], selected: R | null, cap = 8): R[] {
  const head = runs.slice(0, cap);
  return selected && !head.includes(selected) ? [...head, selected] : head;
}

export const RUN_GONE_NOTE = "That run has left the list — only the newest runs are kept.";

/**
 * A build fire the sheet is waiting on. `ack`: the host's `op.ack` for that
 * fire — absent until it arrives; `runId` absent on it = a receipt that names
 * no run.
 */
export interface PendingFire {
  ack?: { ok: boolean; runId?: string };
}

/**
 * The run a just-fired build started, by IDENTITY: the run the receipt names.
 * It was once inferred ("the first run not known at fire time"), which opened a
 * scheduled build's or another device's run as if it were this tap's; the
 * older-host fallback that kept one such guess is gone (owner decision
 * 2026-10-30). A receipt that names no run opens nothing (`RUN_UNNAMED_NOTE`).
 * No receipt yet, or a refused fire: null.
 */
export function startedRun<R extends { runId: string }>(runs: readonly R[], fire: PendingFire): R | null {
  const id = fire.ack?.runId;
  return id ? runs.find((r) => r.runId === id) ?? null : null;
}

/** The `sel` to hand `selectRun` while a fire is pending: its run once known and listed, "" (nothing open) before. */
export function startingSel<R extends { runId: string }>(runs: readonly R[], fire: PendingFire | null, sel: string | null): string | null {
  if (!fire) return sel;
  return startedRun(runs, fire)?.runId ?? "";
}

export const RUN_STARTING_NOTE = "Starting — its log opens here as soon as the desktop reports the new run.";

export const RUN_UNNAMED_NOTE = "The desktop took the build but did not say which run it started — find it in the list.";

/** The receipt `startedRun` reads, off a fire's fate (`core/queue/fireFate.ts`, the one owner). */
export function ackOfFate(fate: FireFate | null): PendingFire["ack"] {
  if (fate?.kind === "acked") return fate.runId ? { ok: true, runId: fate.runId } : { ok: true };
  return fate?.kind === "refused" ? { ok: false } : undefined;
}

/** The note to draw for a fire, or null. A refusal gives the desktop's reason here too — its toast is not always there (a verdict replayed after a reconnect has none); an acked fire opens the run it names, or says it named none; until that named run is listed it still reads Starting. Never says it ran. */
export function fireNote(fate: FireFate, runOpen: boolean): string | null {
  if (fate.kind === "dropped") return droppedWords("build", fate.reason);
  if (fate.kind === "refused") return `The desktop refused the build — ${(fate.reason ?? "it gave no reason").replace(/\.$/, "")}.`;
  if (fate.kind === "acked" && !fate.runId) return RUN_UNNAMED_NOTE;
  return (fate.kind === "pending" || fate.kind === "acked") && !runOpen ? RUN_STARTING_NOTE : null;
}
