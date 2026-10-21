/**
 * Device-local state, read back off `localStorage`.
 *
 * Two kinds live here, and the difference is the point:
 *
 *  - **Preferences** — launch flags, hidden repos, per-session send mode, the
 *    manual row order, collapsed groups. Device-local by choice: which repos you
 *    have folded away is a viewing preference, not host state, and syncing it
 *    would make one phone rearrange another.
 *  - **Snapshots** (`loadSnap`/`saveSnap`) — the last session list, repo list
 *    and friends, so the launcher paints instantly on load rather than sitting
 *    empty until the WebSocket handshake completes. That wait is seconds when
 *    the desktop is asleep or Tailscale is warming a path, which is exactly when
 *    someone opens the app.
 *
 * Every reader here swallows its own errors and returns the empty value. A
 * parse failure means a hand-edited key, an older build's shape, or private
 * browsing — none of which is a reason for the app not to start.
 *
 * `saveSessionsSnap` writes the TIME alongside the list on purpose: a snapshot
 * without its age is unreadable offline, because "this session is waiting for an
 * answer" means something very different four seconds old than four hours old,
 * and the questions sheet is read almost exclusively when there is no link to
 * check against.
 */
import type { BuildConfig, CaptureTarget, LaunchOpts, RepoTarget, ScheduleEntry, SessionInfo } from "@waterplane/shared";
import { cleanHealth } from "@waterplane/shared";
import type { CliHealthDoc } from "./CliHealthSheet";
import type { Snippet } from "./SnippetSheet";
import { LS, lsDel, lsGet, lsJson, lsNum, lsSetJson } from "./storage";
import { type PendingMarks, parsePendingMarks } from "./pendingMarks";

/** What the compose bar's send button does: straight away, queued for this
 *  session, held until the agent is idle, or handed to the scheduler. Declared
 *  here because its persisted per-session map is. */

export function loadLaunch(): LaunchOpts {
  return lsJson(LS.launch, {});
}

export function loadHiddenRepos(): Set<string> {
  try { return new Set(JSON.parse(lsGet(LS.hiddenRepos) || "[]")); } catch { return new Set(); }
}

// Last-known boot state, cached so the launcher paints instantly on load instead
// of sitting empty until the WebSocket handshake completes (seconds when the
// desktop is asleep or Tailscale is warming a path). Hydrated the moment the
// live session.list/recent/closed/repos arrive.
export function loadSnap<T>(key: string, fallback: T): T {
  return lsJson<T>(key, fallback);
}
export function saveSnap(key: string, v: unknown): void {
  lsSetJson(key, v);
}
/** When the session list last came from the host. Stored next to the snapshot
 *  because a snapshot without its age is unreadable offline: "this session is
 *  waiting for an answer" means something different if it was true four seconds
 *  ago or four hours ago, and the questions sheet is read almost exclusively
 *  when there is no link to check against. */
export const SNAP_AT_KEY = LS.snapAt;
export function saveSessionsSnap(list: SessionInfo[]): void {
  saveSnap(LS.snapSessions, list);
  saveSnap(SNAP_AT_KEY, Date.now());
}

/**
 * The repo listing, with the moment it landed.
 *
 * Same argument as `saveSessionsSnap`, and the same bug on the other list: the
 * launcher paints repos from this snapshot instantly, which is right — and it
 * then said nothing about whether the host had confirmed them THIS minute or
 * last Tuesday. The listing is an HTTP read (`/api/repos`), separate from the
 * socket, so it can be stale while everything else looks live.
 */
export function saveReposSnap(list: RepoTarget[]): void {
  saveSnap(LS.snapRepos, list);
  saveSnap(LS.snapReposAt, Date.now());
}
export function loadReposAt(): number {
  return lsNum(LS.snapReposAt, 0);
}

export const CMD_HISTORY_MAX = 50;
export function loadCmdHistory(): string[] {
  return lsJson(LS.cmdHistory, []);
}

// Saved reusable compose snippets — personal, cross-repo, and synced through the
// host so the same templates exist on every client (see settings.ts).
export function loadSnippets(): Snippet[] {
  return lsJson(LS.snippets, []);
}

// Manual live-session row order (session ids, top first). Device-local — the row
// order is a viewing preference, not host state. Empty ⇒ pure createdAt order.
export const SESSION_ORDER_KEY = LS.sessionOrder;
export const SESSION_DRAG_MS = 400; // long-press before a row becomes draggable
export function loadSessionOrder(): string[] {
  try {
    const v = JSON.parse(lsGet(SESSION_ORDER_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string") : [];
  } catch { return []; }
}

// Collapsed live-session repo groups (repo names). Device-local like the row
// order — a viewing preference, not host state. With many repos open the
// overview is a long scroll; collapsing a group hides its session rows while
// the header (session count, worktree count, actions) stays.
export const COLLAPSED_REPOS_KEY = LS.collapsedRepos;
export function loadCollapsedRepos(): Set<string> {
  try {
    const v = JSON.parse(lsGet(COLLAPSED_REPOS_KEY) || "[]");
    return new Set(Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}

/**
 * Stars and follow-up flags pressed with no link — the one piece of HOST state
 * this file keeps a device-local shadow of, and only until the host agrees.
 *
 * `session.star` / `session.followup` are fire-and-forget frames: offline they
 * land in the socket's in-memory queue, which paints nothing (the star stayed
 * hollow, so the press read as ignored) and is thrown away by a reload — which
 * the `ws.ts` watchdog performs on exactly the link this happens on. So the
 * INTENT is written here: id → wanted flag, overriding the host's value on
 * screen and re-sent on reconnect. It is not a preference and it never wins an
 * argument — `reconcileMarks` (`pendingMarks.ts`, the pure half both marks
 * share) drops each entry the moment a LIVE session says the host has it, which
 * is also what makes a mark set from another device visible here.
 */
export const PENDING_STARS_KEY = LS.pendingStars;
export const PENDING_FOLLOWUPS_KEY = LS.pendingFollowUps;
export type PendingStars = PendingMarks;

export function loadPendingMarks(key: string): PendingMarks {
  return parsePendingMarks(lsGet(key));
}

export function savePendingMarks(key: string, p: PendingMarks): void {
  // quota / private mode — the intent still holds for this page (both helpers swallow it)
  if (Object.keys(p).length === 0) lsDel(key);
  else lsSetJson(key, p);
}

/**
 * The build commands and the schedules, cached with the moment they landed.
 *
 * Both lists are HOST state pushed over the socket, and both are read almost
 * exclusively at the moment there is no socket: the build sheet is the escape
 * hatch for when Claude is rate-limited or the link is bad, and "what is armed
 * to run tonight" is a question you ask from a train. Offline they rendered as
 * EMPTY — the build sheet said "no build commands yet" for a repo with five and
 * offered to spend tokens working them out again, and the schedule sheet said
 * there was nothing scheduled. An empty list is a claim, and it was a false one.
 *
 * What is cached is only the READING. Running a build and arming a schedule
 * still go through the durable send queue, exactly as before — the fix is that
 * the list you pick from survives the link, not that anything is decided here.
 *
 * The time is stored beside the list for `saveSessionsSnap`'s reason, which
 * bites harder here: a build command deleted on the desktop last week is
 * indistinguishable from a live one unless the sheet can say how old the copy
 * is.
 */
export interface Cached<T> { v: T; at: number }

/** Per-repo build configs, keyed by worktree path. Bounded — this is a cache,
 *  and a machine with a hundred repos must not grow one for ever. */
const BUILD_SNAP_REPOS = 40;
export function loadBuildsSnap(): Record<string, Cached<BuildConfig[]>> {
  const v = lsJson<Record<string, Cached<BuildConfig[]>>>(LS.snapBuilds, {});
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, Cached<BuildConfig[]>> = {};
  for (const [dir, e] of Object.entries(v)) {
    if (e && Array.isArray(e.v) && typeof e.at === "number") out[dir] = e;
  }
  return out;
}

export function saveBuildsSnap(repoDir: string, builds: BuildConfig[]): Record<string, Cached<BuildConfig[]>> {
  const all = loadBuildsSnap();
  all[repoDir] = { v: builds, at: Date.now() };
  const dirs = Object.keys(all);
  if (dirs.length > BUILD_SNAP_REPOS) {
    // Oldest first — the repo you have not opened in months is the one whose
    // cached copy is worth least.
    for (const dir of dirs.sort((a, b) => all[a].at - all[b].at).slice(0, dirs.length - BUILD_SNAP_REPOS)) delete all[dir];
  }
  lsSetJson(LS.snapBuilds, all);
  return all;
}

/**
 * Per-repo capture targets, cached exactly as the build commands are.
 *
 * The argument is `saveBuildsSnap`'s and it lands harder here, because of what
 * the capture sheet is FOR: you open it to find out what a screen looks like
 * when you are not at the desk, which is the same moment the link is worst. An
 * uncached list paints as empty, and an empty list is a CLAIM — "this repo has
 * nothing to capture" — about a repo that may have sixteen targets. So the
 * reading is kept, with `listAt` beside it, and the sheet says how old the copy
 * is rather than passing last Tuesday's targets off as this minute's.
 *
 * Only the READING is cached. Running a capture is a durable queued op and
 * saving an edited target list needs the desktop; neither is decided here.
 */
const CAPTURE_SNAP_REPOS = 40;
export function loadCaptureSnap(): Record<string, Cached<CaptureTarget[]>> {
  const v = lsJson<Record<string, Cached<CaptureTarget[]>>>(LS.snapCapture, {});
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, Cached<CaptureTarget[]>> = {};
  for (const [dir, e] of Object.entries(v)) {
    if (e && Array.isArray(e.v) && typeof e.at === "number") out[dir] = e;
  }
  return out;
}

export function saveCaptureSnap(repoDir: string, targets: CaptureTarget[]): Record<string, Cached<CaptureTarget[]>> {
  const all = loadCaptureSnap();
  all[repoDir] = { v: targets, at: Date.now() };
  const dirs = Object.keys(all);
  if (dirs.length > CAPTURE_SNAP_REPOS) {
    // Oldest first, `saveBuildsSnap`'s rule: the repo you have not opened in
    // months is the one whose cached copy is worth least.
    for (const dir of dirs.sort((a, b) => all[a].at - all[b].at).slice(0, dirs.length - CAPTURE_SNAP_REPOS)) delete all[dir];
  }
  lsSetJson(LS.snapCapture, all);
  return all;
}

export function loadSchedulesSnap(): Cached<ScheduleEntry[]> {
  const v = lsJson<Cached<ScheduleEntry[]>>(LS.snapSchedules, { v: [], at: 0 });
  return v && Array.isArray(v.v) && typeof v.at === "number" ? v : { v: [], at: 0 };
}

export function saveSchedulesSnap(entries: ScheduleEntry[]): void {
  // `running` is transient — the host stamps it while a sweep is in flight and
  // never persists it. Caching it would leave a row claiming, days later and
  // offline, to be running something no process is doing.
  lsSetJson(LS.snapSchedules, { v: entries.map(({ running: _running, ...e }) => e), at: Date.now() });
}

/**
 * The CLI health board (`shared/clihealth.ts`), as the host last pushed it.
 *
 * Cached for the same reason the build commands are, with the argument one turn
 * sharper: this board is READ at the moment the link is misbehaving — "is the
 * tunnel bad, or has the app stopped being able to read the CLI?" is one
 * question, and a sheet that shows nothing offline answers it by looking
 * broken. What needs the host is OBSERVING a signal; reading the last verdicts
 * does not.
 *
 * Re-cleaned on the way out (`cleanHealth`), because a persisted record is not
 * a trusted value — the same posture `cleanBudget` and `cleanIntentRow` take, and
 * the reason a hand-edited `misses: 9999` cannot pin a permanent red here
 * either. The rollup is stored rather than recomputed so the sheet and the
 * launcher's chip cannot disagree about a copy neither of them fetched.
 */
export function loadCliHealthSnap(): { value: CliHealthDoc; savedAt: number } | null {
  const c = lsJson<Cached<CliHealthDoc> | null>(LS.snapCliHealth, null);
  if (!c || typeof c.at !== "number" || !c.v?.health || !c.v?.rollup) return null;
  const src = c.v.source;
  const source = src && typeof src.repo === "string" && typeof src.stateDir === "string" ? { repo: src.repo, stateDir: src.stateDir } : undefined;
  return { value: { health: cleanHealth(c.v.health), rollup: c.v.rollup, source }, savedAt: c.at };
}

export function saveCliHealthSnap(doc: CliHealthDoc): void {
  lsSetJson(LS.snapCliHealth, { v: doc, at: Date.now() });
}
