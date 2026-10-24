/**
 * The run in progress (or the last one): one line per repo it touched, by repo
 * id, and whether it is still going. Written ONLY by `actions.ts`; module
 * state, so closing the sheet does not stop a run — reopening it shows where
 * the run has got to.
 */
import { createStore } from "../../sdk";
import type { RowState, SyncVerb } from "./logic";

export const run = createStore<{ verb: SyncVerb | null; active: boolean; rows: Record<string, RowState> }>({
  verb: null, active: false, rows: {},
});
