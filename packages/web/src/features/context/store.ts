/**
 * Whose context sheet is open, when it is NOT the attached session's.
 *
 * The sheet reads its series by id over HTTP (`api.contextSeries`), so it has
 * never needed the session to be attached — it was scoped to `active` only
 * because the one door into it was the session header's chip. A launcher
 * row's cost tile is a second door, and it must not hand over the readings of
 * whatever conversation happens to be open underneath it.
 *
 * Null means "the attached one", which is what every existing caller means;
 * it is cleared on close, so the sheet cannot re-open on a session you left.
 * Written only by `actions.ts`.
 */
import { createStore } from "../../sdk";

export const ctxSid = createStore<string | null>(null);
