/**
 * Whose shells sheet is open, when it is NOT the attached session's.
 *
 * `context`'s `ctxSid` exactly: the sheet reads `SessionInfo.shellList`, which
 * already rides every `session.list`/`session.updated`, so it has never
 * needed the session to be attached — the launcher row's own shells chip is a
 * second door beside the session header's, and it must not hand over whatever
 * conversation happens to be open underneath it.
 *
 * Null means "the attached one". Written only by `actions.ts`, cleared on
 * close so the sheet cannot re-open on a session you left.
 *
 * The pending-close id tracking (`session.remove` sent by THIS phone, so its
 * `session.closed` broadcast toasts here and nowhere else) is pure bookkeeping
 * with nothing subscribed to it — it lives in `logic.ts` (`notePendingClose`/
 * `takePendingClose`) beside the rest of this feature's no-React half, not
 * here.
 */
import { createStore } from "../../sdk";

export const shellsSid = createStore<string | null>(null);
