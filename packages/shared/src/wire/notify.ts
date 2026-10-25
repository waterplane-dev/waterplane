/**
 * Which alert kinds may fire at all.
 *
 * The two pure functions live with the types because both ends run them: the
 * host checks inside `notify()` — before the feed entry AND before the push,
 * since muting only the display still buzzes the phone — and the client checks
 * to render the switches.
 */

/**
 * Kinds of in-app notification (drives the icon shown, and what may be muted).
 *
 * Declared as a list rather than a bare union because it is also the ORDER the
 * settings UI offers them in, and the set a stored preference is validated
 * against: a kind removed from this list must not keep muting anything.
 *
 * `undelivered` sits next to `limit` on purpose: it fires when the host opened
 * a session and then could NOT get the prompt into it — a state nothing else
 * reports, because the op was acked `ok` (accepted) long before the typing
 * failed. It used to be a broadcast toast, i.e. a sentence shown to whoever
 * happened to be looking at a phone at that second, for a prompt that was gone.
 *
 * `cli` sits right after `limit` for the same reason and is the same class of
 * alert: something outside this app has changed under it and work is being lost
 * because of it. It fires when one of the integration points this app reads the
 * CLI through — the choice-box detector, the hook pipe, the echo probe, the
 * conversation log (`shared/clihealth.ts`) — stops answering. Every one of those
 * degrades to null by design and therefore fails in silence, which is how a 22%
 * delivery-confirmation failure ran for a week with nobody told. This is the
 * telling.
 *
 * `disk` sits right after `cli`, same class: the desktop's home volume is
 * nearly full (`host/diskwatch.ts`). Not cosmetic — on macOS, low space starts
 * `cache_delete`, which ENDS apps to empty their caches, Tailscale among them
 * (2026-10-21: the tunnel died that way, cutting the phone off). Default ON,
 * once per level crossed, words only: nothing is deleted.
 *
 * `burn` sits right after `limit` because it is the limit's early warning: the
 * weekly figure is climbing faster than a threshold (`shared/burn.ts`). Default
 * ON — it fires at most once per cooldown and never twice for one stretch, so
 * it is not `idle`'s class — and it is words only: nothing is paused.
 *
 * `approval` sits right after `prompt` because it is the same class: a plugin's
 * request a person must approve NOW (a vault fingerprint), urgent like a waiting
 * question. It is its own kind and not `plugin` so the phone can give it the
 * loud channel while a plugin's ordinary "FYI" stays quiet. Default ON.
 *
 * `followup` sits right after `backlog`: a session was flagged for follow up
 * WITHOUT a tap — its launch option on finishing, or its own agent with a
 * reason (`followup.ts`). Default ON; a flag set by hand sends none.
 *
 * `health` sits after `followup`: a repo's health index (`healthindex.ts`)
 * made a move unusual for that repo's own past. Default ON — it fires on a
 * called move only, at most one per repo per week — and words only.
 *
 * `agent` sits after `health`: a RUNNING subagent's window passed the person's
 * line (`agentWindowWarnSetting`), pushed once per agent. Default ON — once per
 * agent, words only; nothing is stopped or held.
 *
 * `weekburn` sits last (a kind added later arrives with its own default): the
 * week-end burn's once-a-week offer, "pick repos for the rest of the week's
 * budget" (`weekburn.ts`). Default ON — at most one per week, words only; it
 * starts nothing, the person's pick is the approval.
 */
export const NOTIFICATION_KINDS = [
  "prompt", "approval", "limit", "burn", "cli", "disk", "undelivered", "backlog", "followup", "health", "agent", "artifact", "image", "plugin", "autofire", "idle", "info", "weekburn",
] as const;

/** Kind of in-app notification (drives the icon shown). */
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Which kinds the user wants to hear about. Absent kind = the default below.
 *
 * Stored sparsely (only the kinds explicitly set) so that a kind added later
 * arrives with its own default rather than as "muted, because the phone that
 * wrote this file had never heard of it".
 */
export type NotifyPrefs = Partial<Record<NotificationKind, boolean>>;

/**
 * Kinds that are OFF unless the user turns them on.
 *
 * `idle` is the per-turn "Turn finished" ping, and it is the one kind that
 * fires on every single turn of every session: half a dozen agents working a
 * backlog produce a notification a minute, which buries the two kinds that
 * actually need a human — a waiting question and a usage limit — under a wall
 * of identical rows. It stays available, it just is not the default.
 *
 * `cli` is deliberately NOT here. A health readout that ships muted is not a
 * readout — the failure it exists to end is precisely one nobody was told about
 * — and it is rate-limited by construction anyway: it fires on a verdict
 * TRANSITION into degraded or broken, per signal, never per observation.
 */
export const NOTIFY_DEFAULT_OFF: readonly NotificationKind[] = ["idle"];

/** Whether a kind may be published, given the user's (possibly absent) prefs. */
export function notifyEnabled(prefs: NotifyPrefs | null | undefined, kind: NotificationKind): boolean {
  const explicit = prefs?.[kind];
  if (typeof explicit === "boolean") return explicit;
  return !NOTIFY_DEFAULT_OFF.includes(kind);
}

/** Drop anything that is not a known kind / boolean — the file is hand-editable. */
export function cleanNotifyPrefs(raw: unknown): NotifyPrefs {
  const out: NotifyPrefs = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of NOTIFICATION_KINDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

/**
 * An in-app notification. Mirrors every OS push the host fires, kept in a feed
 * inside the app so alerts work even without a secure context / granted push.
 */
export interface NotificationItem {
  id: string;
  ts: number;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Session to focus when tapped. */
  sessionId?: string;
  /** When set, tapping opens this image in the annotator. */
  image?: { repoId: string; relPath: string };
  /** When set, tapping downloads this artifact (outbox file, e.g. an APK).
   *  `mtime` is part of the file's IDENTITY, not decoration: the download queue
   *  keys a record on repo + path + mtime, so a payload without it makes every
   *  future build of `app.apk` the same row — and a tap on next week's
   *  notification hands over last week's bytes. */
  file?: { repoId: string; relPath: string; name: string; size: number; mtime?: number };
  /**
   * When set, tapping opens the Backlog on exactly these rows.
   *
   * The *Backlog groomed* notification is the only writer. Without it the phone
   * had to match the repo by BASENAME out of the notification's title, which is
   * a guess the moment two roots hold a `myapp` — and it had no way at all to
   * name the rows the sentence was about, so the tap opened the whole list for
   * the reader to re-derive the cut from. `ids` is the merged rows, which is
   * what CLAUDE.md's *a count on a control is a filter* asks for: the number in
   * the sentence and the cut the tap opens come from one place.
   */
  backlog?: { cwd: string; ids: string[] };
  /**
   * The id of the plugin that posted this. Filled by the HOST from the
   * registry entry, never taken from the plugin's own words. A tap opens that
   * plugin's screen (a vault ask has no session to focus).
   */
  plugin?: string;
  /**
   * Where a tap lands for an alert that names no session, file, image, backlog
   * cut or plugin of its own (a health move, a burning week).
   * Every tap has to land on a page that says more about what was tapped; an
   * alert with none of these opens the feed on its own row (`openNotif`).
   * Absent on an older host — never a guess.
   */
  open?: NotifyOpen;
  /**
   * A stable key: a later notification with the same tag REPLACES the earlier one in the OS tray (the APK posts
   * under `tag`; web push passes it to `showNotification`). A plugin's own tag is namespaced by the HOST
   * (`plugin-<id>-<tag>`), so no plugin can replace another's. The in-app feed keeps every item.
   */
  tag?: string;
}

/**
 * A screen a tapped alert opens. `repohealth`: that repo's health chart;
 * `tokens`: the token-stats sheet (the week's burn); `plugin`: that in-repo
 * extension's screen. The phone ignores a `to` it does not
 * know and falls back to the alert's own row in the feed.
 */
export type NotifyOpen =
  | { to: "repohealth"; repoId: string }
  | { to: "tokens" }
  | { to: "plugin"; id: string };

/**
 * A notification as the Android shell hands it back on a tap: `notif:<item JSON>`
 * (`ShellLinkService.openAppIntent`, for an alert with no session or plugin).
 * Null when the string is not one, or the JSON is not an item — never a
 * half-read item.
 */
export function notifFromShell(s: string): NotificationItem | null {
  if (!s.startsWith("notif:")) return null;
  try {
    const v = JSON.parse(s.slice("notif:".length)) as Partial<NotificationItem> | null;
    if (!v || typeof v !== "object" || typeof v.id !== "string" || typeof v.title !== "string" || typeof v.kind !== "string") return null;
    return { ...v, body: typeof v.body === "string" ? v.body : "", ts: typeof v.ts === "number" ? v.ts : Date.now() } as NotificationItem;
  } catch {
    return null;
  }
}
