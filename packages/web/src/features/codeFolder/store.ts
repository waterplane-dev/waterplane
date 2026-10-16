/**
 * The code folder's state: what the host last said about it, and where a save stands. Written only
 * by `actions.ts`; the sheet and the Settings row read them.
 */
import type { RootInfo } from "@waterplane/shared";
import { createStore } from "../../sdk";

/** `GET /api/host/root` as last read; null until the first read answers. */
export const rootInfo = createStore<RootInfo | null>(null);

export type RootUi =
  | { phase: "idle"; readError: string | null }
  /** The save went out and the host is restarting itself: the welcome that names `root` ends it. */
  | { phase: "restarting"; root: string; text: string }
  /** Saved; the host must be restarted by hand. */
  | { phase: "manual"; text: string };

export const rootUi = createStore<RootUi>({ phase: "idle", readError: null });
