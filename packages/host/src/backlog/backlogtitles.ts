/**
 * The mark on a session the backlog opened: a prefix, never an exact title.
 * Split out of `backlog.ts` (move only).
 */

function baseName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

/**
 * The mark that a session was opened by MACHINERY — a prefix, never an exact
 * title.
 *
 * It was read as an exact string while there was one session per repo, and the
 * move to one per item is exactly why it must not be: `backlog · myrepo · fix the
 * flaky test` and the older `backlog · myrepo` are both automatic sessions, both
 * count against the cap, and both are reapable. `isBacklogTitle` was already a
 * prefix test, which is what made this a rename rather than a migration.
 */
export const BACKLOG_PREFIX = "backlog \u00b7 ";
/** A repo's own auto-titled session — the sheet's "open a session here". */
export const backlogTitle = (repoDir: string): string => `${BACKLOG_PREFIX}${baseName(repoDir)}`;
/** ONE ITEM's session. Clipped, because a title is a row on a phone. */
export const itemTitle = (repoDir: string, label: string): string =>
  `${backlogTitle(repoDir)} \u00b7 ${label.split("\n")[0].trim().slice(0, 40)}`;
export const isBacklogTitle = (title: string): boolean => title.startsWith(BACKLOG_PREFIX);

/**
 * The same title, with the machinery mark taken off — what a session a PERSON
 * opened is allowed to be called.
 *
 * The prefix is the ONLY mark of an automatic session: it is what
 * `autoSessionCount()` counts against the cap, what `reapAutoSession` may close
 * to make room and what `lingerSweep` retires after ten minutes. A finished
 * item's session is closed by the linger sweep WITH its title, so it lands in
 * *Recently closed* still called `backlog · myrepo · fix the flaky test` — and the
 * reopen button sends that title straight back. The session a person is now
 * driving was therefore counted against the cap, reapable after sixty seconds of
 * a silent screen (a permission box, a long tool call) and lingered after ten
 * minutes. "Never a session somebody is looking at" was only ever true while the
 * socket was attached, and a phone in a pocket is not attached.
 *
 * So a create that came off the WIRE never wears it: `routes/session.ts` strips
 * it, and the three host-side openers that mint it (`openItemSession`,
 * `ensureRepoSession`, `doResurrect`) are unaffected, because none of them goes
 * through a route. A person who wants that name back can rename the tab.
 */
export function withoutBacklogMark(title?: string): string | undefined {
  if (!title) return title;
  if (!isBacklogTitle(title)) return title;
  return title.slice(BACKLOG_PREFIX.length).trim() || undefined;
}
