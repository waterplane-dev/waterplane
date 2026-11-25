/**
 * What the set-up page holds: which repo it is on, and per repo (by worktree path) the person's ticks
 * and what became of each row. Outcomes outlive the sheet, so closing and reopening it can never post
 * a row twice. One writer: `actions.ts`.
 */
import { createStore } from "../../sdk";
import type { RepoRun } from "./logic";

/** The worktree path the sheet is on; null = closed. */
export const openOn = createStore<string | null>(null);

export const runs = createStore<ReadonlyMap<string, RepoRun>>(new Map());
