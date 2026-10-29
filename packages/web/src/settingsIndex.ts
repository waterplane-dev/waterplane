/**
 * What is IN Settings, as data — the one list of every row on that screen, the
 * group it belongs to and the words somebody would type looking for it.
 *
 * It exists for three jobs that were previously done three different ways or
 * not at all:
 *
 *  - **Search.** Seventeen sections and sixty-odd switches is past the point
 *    where scrolling is a way to find anything. A query is matched against this
 *    catalogue, never against the rendered DOM: a row's *keywords* are how
 *    "dark mode", "font", "password" or "battery" find the rows that actually
 *    answer them, and none of those words appear in the labels.
 *  - **Grouping.** The seventeen sections were seventeen decisions taken one at
 *    a time, and three of them ("Usage", "Usage limit", "Usage budget") were
 *    one subject filed under three heads. The group a row lives in is stated
 *    here once, so moving a row between groups is an edit to this file and not
 *    a cut-and-paste of JSX.
 *  - **A check.** `settingsIndex.test.mjs` reads `App.tsx` and fails when a
 *    rendered row carries an id this file does not name, or when this file
 *    names an id nothing renders. A catalogue nothing verifies is a catalogue
 *    that silently goes stale, and a stale one makes search quietly lie —
 *    the row is on screen and the query that should find it does not.
 *
 * Pure on purpose: no React, no DOM, no storage. The kit that draws the rows is
 * `SettingsKit.tsx`; what the rows DO stays in `App.tsx`, which is where the
 * state they mutate lives.
 */

/** The seven group ids — the `group` a feature's settings rows name
 *  (`SettingsRowsDef` in `sdk/types.ts`). */
export type SettingsGroupId = "sessions" | "notifications" | "appearance" | "writing" | "offline" | "connection" | "tools";

/** A group of rows, in the order Settings draws them. */
export interface SettingGroupMeta {
  id: SettingsGroupId;
  /** The heading, exactly as it reads on screen. */
  title: string;
}

/** One row — a switch, a choice, an action, a stepper or a slider. */
export interface SettingRowMeta {
  id: string;
  /** Owning group id. */
  group: SettingsGroupId;
  /** The label on the row, as it reads on screen. */
  label: string;
  /**
   * The words that are NOT on the row but are what somebody types. "dark" for
   * the theme, "font" for text size, "battery" for the background link. Split
   * on whitespace like the query is, so order does not matter.
   */
  keywords?: string;
}

/**
 * Seven groups, ordered by what brings a person here.
 *
 * The order is deliberate and is not the old one: the top of this screen used
 * to be a readout (token statistics) because it was the one thing that was not
 * a switch, which is a reason to give it a home, not a reason to make it the
 * first thing anybody scrolls past. What actually brings somebody to Settings
 * is a session behaving differently from how they want it to, so that is first;
 * diagnostics — the things you open once and read — are last.
 */
export const SETTING_GROUPS: SettingGroupMeta[] = [
  { id: "sessions", title: "Sessions" },
  { id: "notifications", title: "Notifications" },
  { id: "appearance", title: "Appearance" },
  { id: "writing", title: "Writing & reading" },
  { id: "offline", title: "Offline & data" },
  { id: "connection", title: "Connection" },
  { id: "tools", title: "Tools & diagnostics" },
];

/*
 * A group carries no keywords of its own, deliberately.
 *
 * It did, and every word in the list matched every row underneath: "gemini" on
 * the Sessions group meant a search for it returned all fourteen session rows —
 * the backend, the model, both budget ceilings — instead of the eight that were
 * about the oracle (now a plugin, found under Tools' `plugins` row). A
 * group-level word is a word about a dozen rows at once,
 * which is the opposite of what a query is for. The group's TITLE still matches
 * its rows, because searching "notifications" to see the notification settings
 * is a person asking for the group; a synonym of a single row belongs on that
 * row.
 */

/**
 * Every row on the screen.
 *
 * Keywords carry the vocabulary the labels do not: the failure this is written
 * against is a person who knows exactly what they want to change and cannot
 * find the word the app chose for it.
 */
export const SETTING_ROWS: SettingRowMeta[] = [
  // ── Sessions ───────────────────────────────────────────────────────────
  { id: "launch-backend", group: "sessions", label: "backend", keywords: "binary claude engine which runs cli plugin" },
  { id: "launch-model", group: "sessions", label: "model", keywords: "opus sonnet haiku alias version local hosted default" },
  { id: "launch-effort", group: "sessions", label: "effort", keywords: "reasoning thinking depth high low" },
  { id: "launch-permission", group: "sessions", label: "permission mode", keywords: "approvals dangerous skip ask tool calls yolo bypass" },
  { id: "launch-remote", group: "sessions", label: "remote control", keywords: "claude.ai steer remote-control" },
  { id: "launch-ask", group: "sessions", label: "ask before each launch", keywords: "prompt every time silently defaults pick" },
  { id: "spend-warn", group: "sessions", label: "spend marks", keywords: "cost warning orange red triangle threshold dollars percent week alert expensive api" },
  { id: "confirm-close", group: "sessions", label: "ask before closing a session", keywords: "close confirm uncommitted unmerged warning don't ask again dialog" },
  { id: "close-when-done", group: "sessions", label: "close automatic sessions when done", keywords: "backlog scheduled linger keep open reap slot auto-close" },
  { id: "local-sessions", group: "sessions", label: "local model sessions at once", keywords: "ollama qwen gpu runner local model limit cap one at a time concurrent" },
  { id: "hosted-notice", group: "sessions", label: "hosted-model notice", keywords: "privacy disclaimer acknowledge server third party leaves machine" },
  { id: "limit-auto", group: "sessions", label: "auto-continue after a usage limit", keywords: "rate limit resume reset blocked wall resurrect" },
  { id: "net-retry", group: "sessions", label: "retry on network errors", keywords: "network wifi offline dns outage api error continue retry automatic connection lost" },
  { id: "budget", group: "sessions", label: "usage budget", keywords: "reserve headroom pause unattended percent ceiling session window" },
  { id: "budget-session", group: "sessions", label: "session ceiling", keywords: "5-hour window percent reserve pause headroom" },
  { id: "automation", group: "sessions", label: "automation", keywords: "schedule schedules clock cron runs on its own backlog auto peer" },
  { id: "weekburn", group: "sessions", label: "week-end burn", keywords: "this week's burn spend leftover unused budget subscription repos improve" },
  { id: "budget-weekly", group: "sessions", label: "weekly ceiling", keywords: "week cap percent reserve" },
  { id: "budget-leftover", group: "sessions", label: "leftovers in a new week", keywords: "leftover reset week spare budget before reset waiver" },
  { id: "billing-profile", group: "sessions", label: "billing profile", keywords: "api key subscription bedrock vertex cloud account detect override console" },
  { id: "billing-periods", group: "sessions", label: "dollar periods and caps", keywords: "month monthly week day spend cap budget dollars billing cycle anchor rolling span time zone limit" },
  { id: "ask-rules", group: "sessions", label: "ask before", keywords: "ask rules permission confirm git push force main master deploy publish dangerous irreversible guard tap prod release" },
  { id: "auto-compact-default", group: "sessions", label: "auto-compact window", keywords: "autoCompactWindow compact context 400k repo setup settings.json threshold" },

  // ── Notifications ──────────────────────────────────────────────────────
  { id: "notif-feed", group: "notifications", label: "open the feed", keywords: "alerts unread inbox in-app list bell notification" },
  { id: "notif-info-push", group: "notifications", label: "push information too", keywords: "receipts buzz quiet information pushes push" },
  { id: "notif-kinds", group: "notifications", label: "what may fire", keywords: "mute kinds needs you limit cli backlog prompt not delivered per type" },
  { id: "phone-setup", group: "notifications", label: "phone setup", keywords: "permission allow android background notifications install unknown apps checklist" },
  { id: "notif-push", group: "notifications", label: "OS push", keywords: "web push system notification https secure context service worker" },
  { id: "notif-shell-link", group: "notifications", label: "background link", keywords: "android apk foreground service app closed freezer wake" },
  { id: "notif-shell-battery", group: "notifications", label: "allow background use", keywords: "battery doze exemption reboot android optimisation optimization" },

  // ── Appearance ─────────────────────────────────────────────────────────
  { id: "theme", group: "appearance", label: "theme", keywords: "dark light mode night follow device colour color scheme" },
  { id: "text-size", group: "appearance", label: "text size", keywords: "font bigger smaller larger zoom readable accessibility scale" },
  { id: "icon-size", group: "appearance", label: "icon size", keywords: "glyph bigger smaller tap target thumb scale" },
  { id: "terminal-zoom", group: "appearance", label: "terminal size", keywords: "console font columns rows grid pty wrap diff cli zoom" },
  { id: "repo-colours", group: "appearance", label: "repo colours", keywords: "color hue ring pin per repo tab stripe colour blind cvd" },
  { id: "tabs", group: "appearance", label: "session tabs", keywords: "strip open sessions switch between bar top" },
  { id: "tabs-count", group: "appearance", label: "tabs that fit", keywords: "how many width narrower wider strip" },
  { id: "tabs-limit", group: "appearance", label: "most tabs shown", keywords: "limit cap max maximum how many strip hide" },
  { id: "tabs-order", group: "appearance", label: "tab order", keywords: "sort opened frequent recent where was i" },
  { id: "tabs-sync", group: "appearance", label: "same tab order on every device", keywords: "sync share phone desktop devices order opened recent across" },
  { id: "repo-order", group: "appearance", label: "repo order", keywords: "launcher sort alphabetical sessions open busiest list repos rank" },
  { id: "unfold-to-end", group: "appearance", label: "unfolding a repo shows its last row", keywords: "launcher expand collapse fold scroll bottom end list sessions chevron" },
  { id: "net-pulse", group: "appearance", label: "connection strip", keywords: "ping latency graph round trip bar link live network" },
  { id: "local-rt", group: "appearance", label: "desktop strip", keywords: "local runner ollama lm studio model loaded memory pressure cpu gpu utilization machine mac bar" },
  { id: "agent-warn", group: "appearance", label: "warn above this many agents", keywords: "parallel subagents running at once count concurrent amber notice threshold" },
  { id: "agent-alarm", group: "appearance", label: "alarm above this many agents", keywords: "parallel subagents running at once count concurrent red limit threshold too many" },
  { id: "ui-reset", group: "appearance", label: "reset UI settings to default", keywords: "restore defaults factory look layout hidden buttons theme size zoom tabs strips" },

  // ── Writing & reading ──────────────────────────────────────────────────
  { id: "enter-sends", group: "writing", label: "what Return does", keywords: "enter key send newline keyboard compose submit" },
  { id: "dictate-lang", group: "writing", label: "dictation is read as", keywords: "voice speech microphone mic whisper language german english translate transcribe auto detect" },
  { id: "dictate-langs", group: "writing", label: "languages on the microphone", keywords: "voice speech dictation picker list offer languages mic which" },
  { id: "dictate-terms", group: "writing", label: "words dictation should know", keywords: "voice speech vocabulary glossary dictionary custom terms names jargon misheard recognise spelling whisper prompt" },
  { id: "close-kb-on-send", group: "writing", label: "keyboard after Send", keywords: "keyboard close hide dismiss blur send focus" },
  { id: "shortcut-card", group: "writing", label: "hold Ctrl to see shortcuts", keywords: "keyboard shortcut shortcuts chord hotkey cheat sheet ctrl cmd command alt option modifier hold card" },
  { id: "busy-send", group: "writing", label: "Send while it works", keywords: "send busy working turn running queue when free ask now wait" },
  { id: "btw-to-cli", group: "writing", label: "/btw from the reader", keywords: "btw aside overlay cli terminal switch ask reader" },
  { id: "typing-room", group: "writing", label: "typing room", keywords: "hide chrome header keyboard space terminal rows full" },
  { id: "reader-tools", group: "writing", label: "tool calls in the reader", keywords: "transcript fold list full download details offline" },
  { id: "hints-mode", group: "writing", label: "button hints", keywords: "explain long press help tooltip first time" },
  { id: "hints-explain", group: "writing", label: "explain mode", keywords: "help what does this button do tap" },
  { id: "hints-chip", group: "writing", label: "? button in the headers", keywords: "help question mark explain chip hide remove space header launcher" },
  { id: "hints-reset", group: "writing", label: "explain them again", keywords: "reset dismissed hints help" },

  // ── Offline & data ─────────────────────────────────────────────────────
  { id: "install", group: "offline", label: "install this app", keywords: "pwa home screen add standalone chrome ios safari" },
  { id: "auto-send", group: "offline", label: "auto-send the queue", keywords: "offline queued messages reconnect deliver hold send now" },
  { id: "serial-sessions", group: "offline", label: "one session at a time per repo", keywords: "queue parallel serialize worktree agents limit" },
  { id: "confirm-queue", group: "offline", label: "ask on reconnect", keywords: "queue review before sending offline drafts stale" },
  { id: "queue-manage", group: "offline", label: "manage the queue", keywords: "queued messages waiting outbox" },
  { id: "bg-fresh", group: "offline", label: "in the background", keywords: "battery drain power hidden background stream offline dead zone fresh latest screen catch up" },
  { id: "data-saver", group: "offline", label: "data saver", keywords: "roaming hotel bandwidth smaller images polling mobile" },
  { id: "downloads", group: "offline", label: "downloads", keywords: "pull files artifacts background fetch resume auto copy once duplicate space keep" },
  { id: "upload-scale", group: "offline", label: "upload size", keywords: "image width shrink annotator camera photo auto slow link" },

  // ── Connection ─────────────────────────────────────────────────────────
  { id: "hosts", group: "connection", label: "hosts", keywords: "desktop address daemon apk android pair change ip switch add remove lan wifi peer desktops tailnet tailscale computer machine" },
  { id: "code-folder", group: "connection", label: "Code folder", keywords: "root repos folder scan dev projects directory path where desktop host workspace env variable" },
  { id: "add-desktop", group: "connection", label: "add a desktop", keywords: "new desktop host computer machine pc mac linux windows tailnet tailscale found discover scan add pair peer" },
  { id: "web-desktops", group: "connection", label: "another desktop, without the app", keywords: "browser web pwa no app without apk iphone ios pair second desktop another phone home screen address tailnet code" },
  { id: "demo", group: "connection", label: "try the demo", keywords: "demo sample example pretend fake tour first look leave play store reviewer" },
  { id: "pair-phone", group: "connection", label: "pair another phone", keywords: "qr code pairing new phone add device scan invite tailscale" },
  { id: "paired-devices", group: "connection", label: "paired devices", keywords: "revoke sign in token phones ledger last seen remove device" },
  { id: "app-version", group: "connection", label: "app version", keywords: "apk update build install shell android" },
  { id: "endpoints", group: "connection", label: "how you reach this host", keywords: "url address lan tailscale https tunnel origin reopen connection" },
  { id: "lan-password", group: "connection", label: "LAN password", keywords: "auth gate local network secure token login public" },
  { id: "lan-gate-tailscale", group: "connection", label: "gate Tailscale too", keywords: "password auth peers trusted" },
  { id: "lan-logout", group: "connection", label: "log out this device", keywords: "auth token sign out lan" },
  { id: "sync-push", group: "connection", label: "push this device's settings", keywords: "sync host copy conflict templates presets pad toolbar wins" },

  // ── Tools & diagnostics ────────────────────────────────────────────────
  { id: "token-stats", group: "tools", label: "token statistics", keywords: "usage cost spend money per day model repo cache history tokens" },
  { id: "tool-secret", group: "tools", label: "secret", keywords: "api key write only env credential" },
  { id: "desktop-setup", group: "tools", label: "desktop setup", keywords: "checklist mac screen recording accessibility permission grant live desktop helper privacy security system settings" },
  { id: "tool-repo-setup", group: "tools", label: "repo setup", keywords: "checklist gitignore claude.md context weight check fix" },
  { id: "tool-speedtest", group: "tools", label: "speed test", keywords: "bandwidth latency diagnostics connection throughput" },
  { id: "tool-net-health", group: "tools", label: "connection health", keywords: "link prompts delivery retries lost dropped" },
  { id: "tool-storage", group: "tools", label: "storage", keywords: "space full disk bytes cache clear downloads thumbnails quota evicted free up" },
  { id: "tool-cli-health", group: "tools", label: "CLI health", keywords: "heuristics detector hook echo probe conversation log broken degraded" },
  { id: "tool-features", group: "tools", label: "feature usage", keywords: "which features used never analytics track" },
  { id: "tool-host-stat", group: "tools", label: "host stat", keywords: "cpu memory load desktop mac pressure temperature" },
  { id: "tool-screenshot", group: "tools", label: "screenshot the desktop", keywords: "capture screen mac image" },
  { id: "whats-new", group: "tools", label: "what's new", keywords: "release version changelog new features overview 0.1.8 automation burn downloads notifications" },
  { id: "tool-updates", group: "tools", label: "updates", keywords: "update self plugin install available new version restart roll back" },
  { id: "tool-decisions", group: "tools", label: "decision log", keywords: "activity auto-continue usage limit what a plugin answered suggested history archive" },
  { id: "updates-auto", group: "tools", label: "check daily for updates", keywords: "update plugin automatic check github new version" },
  { id: "plugins", group: "tools", label: "plugins", keywords: "plugin extension add-on installed oracle gemini enable disable" },
];

/** Row lookup, built once — search runs on every keystroke. */
const BY_ID = new Map(SETTING_ROWS.map((r) => [r.id, r]));
const GROUP_BY_ID = new Map(SETTING_GROUPS.map((g) => [g.id, g]));

/**
 * The words a row is findable by: its own label, its own keywords, its id, and
 * its group's HEADING — nothing else. See the note on `SETTING_GROUPS`.
 */
function haystack(row: SettingRowMeta): string {
  const g = GROUP_BY_ID.get(row.group);
  return [row.label, row.keywords, g?.title, row.id.replace(/-/g, " ")]
    .filter(Boolean).join(" ").toLowerCase();
}

const HAY = new Map(SETTING_ROWS.map((r) => [r.id, haystack(r)]));

/**
 * Rows an extension catalogues for itself (`SettingsRowsDef.rows`). An
 * extension lives outside this repo's core, so its row cannot be a line in
 * `SETTING_ROWS` — and an uncatalogued row is not merely unfindable: under any
 * query it matches nothing, so its group's `gone` hides it along with the
 * heading. The vault row vanished on "vault" that way. A core id wins over an
 * extension claiming the same one.
 */
const EXTRA: SettingRowMeta[] = [];

export function addSettingRows(rows: readonly SettingRowMeta[]): void {
  for (const r of rows) {
    if (BY_ID.has(r.id)) continue;
    EXTRA.push(r);
    BY_ID.set(r.id, r);
    HAY.set(r.id, haystack(r));
  }
}

/**
 * Words a row is findable by that only exist at run time — the `plugins` row
 * holds a section per installed plugin, and "sensors" or a plugin's own name
 * must find it. Replaced whole by the one writer that knows them.
 */
const WORDS = new Map<string, string>();

export function setRowWords(id: string, words: string): void {
  WORDS.set(id, words.toLowerCase());
}

/**
 * Every term must appear somewhere in the row's words — AND, not OR.
 *
 * OR is the wrong answer for a screen this size: "tab order" under OR matches
 * every row with the word "order" in it and the query stops narrowing anything.
 * Substring rather than whole-word so "colour" finds "colours" and "notif"
 * finds "notifications" while you are still typing.
 */
export function rowMatches(id: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const base = HAY.get(id);
  if (base == null) return true; // an id this file does not know is never hidden
  const hay = WORDS.has(id) ? `${base} ${WORDS.get(id)}` : base;
  return wordsMatch(hay, q);
}

/** `rowMatches`' rule over any words: every term, as a substring, case-insensitive. */
export function wordsMatch(hay: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const h = hay.toLowerCase();
  return q.split(/\s+/).every((term) => h.includes(term));
}

/**
 * A piece NESTED inside a row (one plugin's section inside `plugins`): shown
 * whole when the parent's CATALOGUED words answer the query ("plugin" means all
 * of them), else only when its own `words` do — so a plugin's name shows that
 * plugin's section, and the sections beside it (which made the row match only
 * through `setRowWords`) step aside.
 */
export function nestedMatches(parentId: string, words: string, query: string): boolean {
  if (!query.trim()) return true;
  const base = HAY.get(parentId);
  if (base != null && wordsMatch(base, query)) return true;
  return wordsMatch(words, query);
}

/**
 * Does any row in this group match?
 *
 * Used to HIDE the heading, never to skip rendering the rows: a group that
 * skipped its children stopped them counting themselves, and the filter bar's
 * denominator silently became "rows in groups that survived". The rows are
 * rendered either way and hide themselves; this only decides whether the
 * heading above them is drawn, and it is safe to ask because a group matches
 * exactly when one of its rows does.
 */
export function groupMatches(groupId: string, query: string): boolean {
  if (!query.trim()) return true;
  return [...SETTING_ROWS, ...EXTRA].some((r) => r.group === groupId && rowMatches(r.id, query));
}

/**
 * A door from elsewhere in the app ("change this") narrows the screen to ONE
 * row instead of landing on the top of a 54-row screen. The pin wins over the
 * query while it is set; typing in the box ends it (the sheet clears it).
 */
export function rowShown(id: string, query: string, only?: string | null): boolean {
  if (only) return id === only;
  return rowMatches(id, query);
}

/** The heading's half of `rowShown` — see `groupMatches`. */
export function groupShown(groupId: string, query: string, only?: string | null): boolean {
  if (only) return BY_ID.get(only)?.group === groupId;
  return groupMatches(groupId, query);
}

/** The row's own metadata, for a caller that wants its label or group. */
export function settingRow(id: string): SettingRowMeta | undefined {
  return BY_ID.get(id);
}

/**
 * What the filter bar says.
 *
 * `total` is what the screen WOULD show with no query — counted from the rows
 * that actually rendered this pass, never from this file's length: a good third
 * of these rows are conditional (no plugin installed, not the Android shell, tabs
 * switched off), and a denominator that counts rows the screen cannot show is a
 * denominator that makes the filter look broken.
 *
 * Which is also why a group is never hidden as a WHOLE under a query. It was,
 * and the rows inside a hidden group then never rendered, never counted
 * themselves, and the bar read "1 of 8" on a screen holding 54 — a denominator
 * that silently meant "of the rows in groups that survived", which is not a
 * number anybody can act on. Every row draws and hides itself; a group left
 * with none is removed by `:has()` in the stylesheet.
 */
export function filterSummary(shown: number, total: number, query: string, only?: string | null): string {
  if (only) {
    const label = BY_ID.get(only)?.label ?? only;
    if (shown === 0) return `“${label}” is not on this screen right now — ${total} settings here`;
    return `showing “${label}” only — ${shown} of ${total} settings`;
  }
  const q = query.trim();
  if (!q) return "";
  if (shown === 0) return `nothing matches “${q}” — ${total} settings on this screen`;
  return `${shown} of ${total} settings match “${q}”`;
}
