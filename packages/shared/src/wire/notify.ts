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
 *
 * `git` sits after `weekburn` (added 2026-10-25): a pull or push the desktop
 * ran in one worktree — from the git view or the sync sheet — ended. A FAILED
 * one is attention and stays until the next run of that verb succeeds or the
 * person taps done (`gitAttentionKey`); a successful push is information; a
 * successful pull raises nothing at all. Default ON.
 *
 * `exposure` sits last (added 2026-10-26): the exposure watch (`exposurepush.ts`) found a NEW
 * open alert in a repo that is on the watch — one push per finding, keyed (repo, measure,
 * subject, version) and spent for good; more than three at once in one repo is a single push.
 * Critical and high severity are attention, the rest information. Default ON. Words only.
 */
export const NOTIFICATION_KINDS = [
  "prompt", "approval", "limit", "burn", "cli", "disk", "undelivered", "backlog", "followup", "health", "agent", "artifact", "image", "plugin", "autofire", "idle", "info", "weekburn", "git", "exposure",
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

/**
 * Two levels, and only one of them is allowed to ask for a person (owner,
 * 2026-10-25: the bell read 9+ and stopped meaning anything).
 *
 * - `attention` — something waits on the person or broke: it counts on the
 *   bell's red badge, it is pushed, and it stays until handled (`handled`).
 * - `info` — a receipt (a run that went fine, a new file): readable in the
 *   feed, never counted, pushed only when the person asked for that
 *   (`notify.prefs`' `pushInfo`).
 */
export type NotifyLevel = "attention" | "info";

/** What a run that raised the alert came to, when the call site knows. */
export type NotifyOutcome = "ok" | "failed";

/**
 * The level a kind has when its call site says nothing more. A kind not here
 * is `info`. `followup` is attention because a session's AGENT chose to raise
 * it; the launch option's routine "done" flag passes `level: "info"` itself.
 */
export const ATTENTION_KINDS: readonly NotificationKind[] = ["prompt", "approval", "cli", "disk", "undelivered", "followup"];

/**
 * THE one rule for a notification's level, run by the host when it fires and
 * by the phone for an item an older host sent without one. An explicit level
 * from the call site wins; then a known outcome (failed ⇒ attention, ok ⇒
 * info, whatever the kind); then the kind's default.
 */
export function notifyLevel(kind: NotificationKind, outcome?: NotifyOutcome, explicit?: NotifyLevel): NotifyLevel {
  if (explicit === "attention" || explicit === "info") return explicit;
  if (outcome === "failed") return "attention";
  if (outcome === "ok") return "info";
  return ATTENTION_KINDS.includes(kind) ? "attention" : "info";
}

/** An item's level: the host's stamp, else the same rule over its kind. */
export function levelOf(item: Pick<NotificationItem, "kind" | "level">): NotifyLevel {
  return item.level === "attention" || item.level === "info" ? item.level : notifyLevel(item.kind);
}

/**
 * Does this item still need the person — the ONE predicate behind the bell's
 * count, the cut a tap on it opens, and the per-repo chips (the host derives
 * `RepoTarget.gitFailed`/`buildFailed` from its own store with it).
 */
export function needsYou(item: Pick<NotificationItem, "kind" | "level" | "handled">): boolean {
  return levelOf(item) === "attention" && !item.handled;
}

/**
 * What a failure's attention `key` NAMES, read and written by ONE pair (`attentionKey` /
 * `parseAttentionKey`) on both ends: the host files under it, the phone reads repo and verb
 * (or build entry) back off it. The format is `git:<repoId>:<pull|push>`,
 * `build:<repoId>:<buildId>` and `pr:<repoId>:<number>`, and it is FROZEN — phones in the field
 * read it with their own copy of the old pattern, so nothing new rides inside it (a failed push's
 * branch is the item's own `branch` field, never a fourth segment).
 *
 * `pr` is a pull request's notice (`prs.ts`: a failed check, a change request, a merge). It is NOT
 * a repo chip — `RepoTarget.gitFailed`/`buildFailed` are `git`/`build` only, and a phone in the
 * field parses `pr:` keys to null — so a reader that means "a failed pull, push or build" narrows
 * with `isRepoChipKey`, never with `!== null`. The string was spelled by hand in `prs.ts` before
 * it joined this pair; stored attention files still hold it, so its bytes never change.
 */
export type AttentionKey =
  | { kind: "git"; repoId: string; verb: "pull" | "push" }
  | { kind: "build"; repoId: string; buildId: string }
  | { kind: "pr"; repoId: string; number: number };

/** The one writer of the format, total for what `parseAttentionKey` accepts. Throws on a PR
 *  number that is not a positive safe integer — `0`, `NaN`, `1.5` or `1e21` would be written as a
 *  key the reader refuses, a notice nothing could ever resolve. That is a programming error in the
 *  host (the forge hands PR numbers as integers), never input from a phone. */
export function attentionKey(k: AttentionKey): string {
  // closed: `parseAttentionKey` returns null for a kind this build does not know
  switch (k.kind) {
    case "git": return `git:${k.repoId}:${k.verb}`;
    case "build": return `build:${k.repoId}:${k.buildId}`;
    case "pr":
      if (!Number.isSafeInteger(k.number) || k.number < 1) throw new Error(`PR number out of range: ${k.number}`);
      return `pr:${k.repoId}:${k.number}`;
  }
}

/** The kinds behind a repo's red chip (a failed pull, push or build) — what the phone's chips,
 *  its resolved-toast and What's new count. A `pr` key is attention, but not one of these. */
export function isRepoChipKey(k: AttentionKey | null): k is Extract<AttentionKey, { kind: "git" | "build" }> {
  return k?.kind === "git" || k?.kind === "build";
}

/** The one reader of the format: null for anything that is not EXACTLY a key `attentionKey`
 *  writes — an unknown kind, an empty repo, a git verb that is not pull/push, a PR number that
 *  is not a positive integer as `attentionKey` writes it, an extra segment
 *  after the verb (`git:<id>:push:<branch>` is a host-side identity, never a wire key). The
 *  LAST segment is the verb or build id and everything between is the repo, as the reader
 *  phones in the field carry it: a repo id may hold `:`, a build id may not round-trip one.
 *  Degrades to null, never to a wrong verb. */
export function parseAttentionKey(key: string | null | undefined): AttentionKey | null {
  if (typeof key !== "string") return null;
  const m = /^(git|build|pr):(.+):([^:]+)$/.exec(key);
  if (!m) return null;
  if (m[1] === "build") return { kind: "build", repoId: m[2], buildId: m[3] };
  // A PR number is a positive integer written without a leading zero, so the key round-trips.
  if (m[1] === "pr") return /^[1-9]\d*$/.test(m[3]) ? { kind: "pr", repoId: m[2], number: Number(m[3]) } : null;
  return m[3] === "pull" || m[3] === "push" ? { kind: "git", repoId: m[2], verb: m[3] } : null;
}

/** The `key` a failed pull or push of one repo/worktree is filed under —
 *  spelled once, so the host's resolve and the phone's chip cannot drift. */
export function gitAttentionKey(repoId: string, verb: "pull" | "push"): string {
  return attentionKey({ kind: "git", repoId, verb });
}

/** The identity a failed PUSH is kept under on the host: one per BRANCH, so a failure on
 *  another branch never hands this one off as "replaced", and a push of that branch resolves
 *  only its own. `gitAttentionKey(repo, "push")` + `:<branch>` (git refuses `:` in a branch
 *  name); no branch (detached, or a record an older host kept) is the bare key. HOST-ONLY: the
 *  WIRE item keeps the bare key (`parseAttentionKey` refuses this form) and carries the branch
 *  as `NotificationItem.branch`. */
export function gitPushFailureKey(repoId: string, branch?: string): string {
  const k = gitAttentionKey(repoId, "push");
  return branch ? `${k}:${branch}` : k;
}

/** The `key` a pull request's notices are filed under (`prs.ts`): one per PR of one
 *  repo/worktree, so its merge or close resolves exactly the check failure filed before it. */
export function prAttentionKey(repoId: string, number: number): string {
  return attentionKey({ kind: "pr", repoId, number });
}

/** The `key` a failed build is filed under: one per build ENTRY of one
 *  repo/worktree, so only the next successful run of that same entry resolves it. */
export function buildAttentionKey(repoId: string, buildId: string): string {
  return attentionKey({ kind: "build", repoId, buildId });
}

/** "push of feature" / "push" / "pull" — a failed git verb named with its branch when the
 *  host said one (`NotificationItem.branch`, `gitFailed.branch`); absent says the verb alone. */
export function gitVerbWords(verb: string, branch?: string): string {
  return verb === "push" && branch ? `push of ${branch}` : verb;
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
   * `attention` or `info` (`notifyLevel`). ABSENT on an older host: the phone
   * derives it with `levelOf`, never a second way.
   */
  level?: NotifyLevel;
  /**
   * What an attention item is ABOUT, so its cause going away can resolve it:
   * `gitAttentionKey`, `buildAttentionKey`, `prompt:<sessionId>`,
   * `followup:<sessionId>`, `undelivered:<sessionId>`. Absent = only the
   * person's done clears it.
   */
  key?: string;
  /**
   * A failed push's BRANCH (the one its `key` cannot carry: the key's format is frozen, see
   * `AttentionKey`), so two branches' failures read apart. ABSENT on an older host, on a push
   * from a detached HEAD, and on everything that is not a failed push — never a guess.
   */
  branch?: string;
  /**
   * Set once an attention item is dealt with: by the person's `done`, or by
   * its cause going away (`by: "resolved"`, `note` saying how — "fixed by the
   * 14:02 push"). A handled item stays in the feed and stops counting.
   */
  handled?: NotifyHandled;
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
  | { to: "plugin"; id: string }
  /** That repo's (or worktree's) git view, showing the stored failure — or, for
   *  `explain`, its Explain view on the answer that just came back. */
  | { to: "git"; repoId: string; verb?: "pull" | "push" | "explain" }
  /** That repo's (or worktree's) build sheet, on the failed entry. */
  | { to: "build"; repoId: string; buildId?: string }
  /** That repo's readings sheet, on the exposure watch region. */
  | { to: "setup"; repoId: string };

/** How an attention item was dealt with. */
export interface NotifyHandled {
  at: number;
  by: "person" | "resolved";
  /** One line, for `resolved`: what took it away. */
  note?: string;
}

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
