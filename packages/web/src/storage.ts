/**
 * Every `localStorage` key this app owns, in one place — plus the four readers
 * that every call site was otherwise re-writing.
 *
 * The keys were fine as string literals right up until there were sixty-seven
 * of them across thirty files, at which point three separate things stopped
 * being answerable by reading any one file:
 *
 *  - **Is this key synced?** `shared/settings.ts` holds the allow-list and
 *    `settings.ts` patches `setItem` to honour it, so a key written anywhere is
 *    synced correctly the day it is written — but nothing at the WRITE site
 *    says which way it went. `SYNCED` below is checked against the shared
 *    list at module load, so the two can no longer drift silently.
 *  - **Does this key still exist?** A renamed key leaves the old literal
 *    behind in the one file nobody grepped, and the symptom is a preference
 *    that silently reverts. A constant that no longer exists is a type error.
 *  - **What is the shape?** Nearly every read here is the same six tokens —
 *    `try { JSON.parse(getItem(k) ?? fb) } catch { fb }` — copied about forty
 *    times, each with its own idea of what an empty value is.
 *
 * The helpers are deliberately thin. They swallow their own errors and return
 * the fallback, because every failure mode available here — private browsing, a
 * quota, a hand-edited value, an older build's shape — is a reason to carry on
 * with a default and never a reason for the app not to start. That rule was
 * already followed at every call site; it is only stated once now.
 *
 * This is a registry, NOT a wrapper you must remember to use. The cross-cutting
 * rules that actually matter (sync, the timestamp) still live in the `setItem`
 * patch in `settings.ts`, for the reason that file states at length: a rule
 * that only holds where somebody remembered to call a helper is a rule that
 * breaks silently three edits later. `tools/eslint/rules.js` keeps new
 * prefixed literals from being written outside this file.
 *
 * Every key is `lsKey(name)`: the PREFIX is the brand's (`shared/brand.ts`),
 * so a rename edits one value there and no line here. A phone carrying an older
 * prefix has its keys copied across before the first read
 * (`boot/brandMigrate.ts`, run first by `hostBoot.ts`).
 */
import {
  BRAND_MIGRATED_KEY, SYNCED_SETTING_KEYS, lsKey,
} from "@waterplane/shared";

/**
 * The keys.
 *
 * Grouped by what they describe, because that grouping is what decides whether
 * a key may sync (see `SYNCED_SETTING_KEYS`' own note): things the user
 * AUTHORED follow the user; things describing this device, this link, or work
 * in flight stay here.
 */
export const LS = {
  // ── Authored content and preferences (all synced) ──────────────────────
  /** Reusable prompt text the compose box appends — "prompt templates". */
  snippets: lsKey("snippets"),
  /** One-tap chips in the session header. */
  headerCmds: lsKey("headerCmds"),
  /** Fan-out sweep presets. */
  fanoutPresets: lsKey("fanout.presets"),
  /** Terminal toolbar layout: order, hidden items, pinned header actions. */
  toolbar: lsKey("toolbar"),
  /** Default launch flags (model / effort / permission mode) for new sessions. */
  launch: lsKey("launch"),
  /** Ask which backend and model to run every time, rather than using `launch`. */
  launchAsk: lsKey("launchAsk"),
  /** The spend warnings' orange/red thresholds (`shared/spendwarn.ts`). */
  spendWarn: lsKey("spendWarn"),
  /** The prompt pad — untargeted drafts, written on one device, sent from another. */
  pad: lsKey("pad"),
  /** Repos hidden from the launcher list. */
  hiddenRepos: lsKey("hiddenRepos"),
  /** Enter submits vs. inserts a newline. */
  enterSends: lsKey("enterSends"),
  /** Dictation vocabulary: terms the transcriber should spell the person's way. */
  dictateTerms: lsKey("dictate.terms"),
  /** Drain the send queue automatically when the link returns. */
  autoSend: lsKey("autoSend"),
  /** Run queued session-opens for one repo one at a time. */
  serialSessions: lsKey("serialSessions"),
  /** Ask before draining text that was queued offline. */
  confirmQueue: lsKey("confirmQueue"),
  /** Reader view: how much of a tool call is shown, and downloaded at all. */
  readerTools: lsKey("readerTools"),
  /** Annotator move mode: knobs on strings (`annKnobs.ts`), not drag. Synced (`SYNCED_SETTING_KEYS`). */
  annKnobs: lsKey("annKnobs"),
  /** Annotator toolbar: shown controls, order, rail or row (`annLayout.ts`). Synced. */
  annTools: lsKey("annTools"),
  /** Annotator: the session's prompt shown above the picture (phone; a wide
   *  window draws the session beside it instead). Per device, never synced. */
  annPrompt: lsKey("annPrompt"),
  /** Button hints: the mode, and which explanations have been dismissed. */
  hints: lsKey("hints"),
  /**
   * Which ring the per-repo colours come from, and every hue pinned by hand
   * (`shared/repocolor.ts`). Synced: a repo's colour is how it is recognised,
   * and a repo recognised by one colour on the phone and another on the desktop
   * is not recognised at all.
   */
  repoColors: lsKey("repoColors"),
  /** Packages a downloaded build may install by itself (`installPolicy.ts`). */
  installAllow: lsKey("installAllow"),
  /** Close an AUTOMATIC session once its work is done — `"1"` on, else OFF. The HOST reads it
   *  (`closeWhenDoneSetting`); a row's own `closeWhenDone` overrides it either way. Synced. */
  closeWhenDone: lsKey("backlog.closeWhenDone"),
  /** LOCAL-model sessions working at once; `"0"` no cap, absent = desktop default (host: `localSessionsSetting`). Synced. */
  localSessions: lsKey("local.maxSessions"),

  // ── This device's identity and its pairing ─────────────────────────────
  /** What makes this device this device, in the usage/netlog docs. */
  deviceId: lsKey("deviceId"),
  /**
   * What to CALL this device in the install log.
   *
   * Deliberately NOT synced: it is the one setting whose whole job is to be
   * different on each phone, and a synced copy would have the second device
   * overwrite the first one's name with its own (`shared/settings.ts` keeps
   * `deviceId` out for exactly this reason).
   */
  deviceName: lsKey("deviceName"),
  /**
   * The last install log this desktop sent, cached.
   *
   * Read-side only, and cached for the reason `localState.ts` caches the build
   * and schedule lists: **an empty list is a CLAIM.** Without it, opening the
   * log after a cold start with the tunnel down says "nothing has installed
   * itself yet" about a fleet this phone has simply not been told about.
   */
  installLog: lsKey("installLog"),
  /**
   * The ACTIVE host's address — what the request shim and the socket dial.
   * Rewritten from `hosts` + `hostActive` at every boot (`hosts.ts`), so it is
   * a derived copy, kept because every reader predates the list.
   */
  hostBase: lsKey("hostBase"),
  /** The desktops this phone knows (`SavedHost[]`, `shared/hosts.ts`). */
  hosts: lsKey("hosts"),
  /** Which of `hosts` is active: its keys are the bare ones. */
  hostActive: lsKey("hostActive"),
  /**
   * A host switch asked for and not yet carried out: `{from, to, drop?}`.
   * The park/restore runs at the NEXT boot, before any other module has read
   * or can write a host key (`hostBoot.ts`) — never in the page that asked,
   * whose pagehide flushes would land in the new host's namespace.
   */
  hostSwitch: lsKey("hostSwitch"),
  /**
   * Hosts removed from the list whose parked keys are still on this phone.
   * Re-adding the same address reuses the id, which is what brings the
   * parked drafts and queue back (`hosts.ts` `addHost`).
   */
  hostsGone: lsKey("hostsGone"),
  /**
   * This phone's device token on the ACTIVE host (`POST /api/auth/token`), sent
   * as `Authorization: Bearer` / the `<protocol>-tok.` subprotocol (`deviceToken.ts`).
   * HOST-scoped: a token is one desktop's ledger row, parked with its host.
   */
  deviceToken: lsKey("deviceToken"), passive: lsKey("passive"), // "1": that token is a passive one (`passiveMode.ts`)
  /**
   * The active host's LAN identity `{hostId, secret}` (`GET /api/lan/identity`,
   * read over the tailnet) — what a LAN address must prove it knows before this
   * phone sends it anything (`lanRoute.ts`). HOST-scoped, like the token.
   */
  lanIdentity: lsKey("lanIdentity"),

  // ── Properties of the LINK (never synced — see SYNCED_SETTING_KEYS) ────
  /** Data saver: skip thumbnails and prefetch. `bgFresh`: the hidden app's catch-up (`core/term/bgFresh.ts`). */
  dataSaver: lsKey("dataSaver"), bgFresh: lsKey("bgFresh"),
  /** Long edge an upload is re-encoded to before it goes up. */
  uploadScale: lsKey("uploadScale"),
  /** Measured uplink, used to size the send queue's receipt deadlines. */
  upKbps: lsKey("upKbps"),
  /** The bounded request-timing window `netlog.ts` keeps. */
  netlog: lsKey("netlog"),
  /** Byte totals for the traffic half of the pulse strip. */
  netTraffic: lsKey("nettraffic"),
  /** Last-connected / last-full-sync, persisted across the watchdog reload. */
  netSync: lsKey("netsync"),
  /** The permanent connection strip, on or off. Per device, deliberately. */
  netPulse: lsKey("netPulse"),
  /**
   * The LOCAL RUNNER strip, on or off — `netPulse`'s argument, verbatim.
   *
   * Switching it on spends THIS desktop's poll, THIS phone's radio on a frame
   * every few seconds, and a line of THIS screen. All three are facts about the
   * device in your hand and the machine it is paired with, none about the
   * person. `always` by default so a new device sees the runner without hunting
   * for the row; one tap turns it off where it is noise.
   */
  localRtBar: lsKey("localRtBar"), unfoldToEnd: lsKey("unfoldToEnd") /* launcher unfold → last row */, repoSort: lsKey("repoSort") /* launcher repo order */,
  /**
   * The SESSION-TAB strip: on or off, how many tabs fit the screen, and whether
   * the order is the sequence they were opened in or the ones opened most.
   *
   * Per device, `netPulse`'s argument verbatim — and the COUNT makes it plainer
   * than either strip above: "four fit" is a measurement of THIS screen, and a
   * phone's answer carried onto a desktop tab is four tabs stretched across
   * 1200 px. The switch and the ordering stay beside it rather than being split
   * off as preferences, because a strip configurable from two places is one you
   * can only half configure from the device you are looking at.
   */
  sessionTabs: lsKey("sessionTabs"),
  sessionTabsCount: lsKey("sessionTabs.count"),
  sessionTabsOrder: lsKey("sessionTabs.order"), sessionTabsLimit: lsKey("sessionTabs.limit"),
  /**
   * How many times each session has been opened FROM THIS DEVICE — what the
   * dynamic order sorts on.
   *
   * Per device because it is a record of taps on one screen, and because the
   * alternative is a counter two phones race to increment. Pruned to the
   * sessions that still exist every time the strip is published, so a daemon
   * that has been up for months does not carry a count per archived
   * conversation.
   */
  tabOpens: lsKey("sessionTabs.opens"), tabFiles: lsKey("sessionTabs.files"), // pinned files: a choice, never in UI_RESET_KEYS
  /**
   * The last local-runner reading this phone was told, so an offline open can
   * say "last seen: qwen3-coder:30b holding 18.2 GB, 2h ago" instead of nothing.
   *
   * The RING is memory-only and deliberately not here: a series drawn as
   * current must BE current, and a chart rebuilt from an hour-old buffer after
   * a reload is the stale-presented-as-live failure the whole readout exists to
   * avoid. Only the last sample and its age persist. Per device for
   * `snapCliHealth`'s reason — it describes one desktop's runner, and carried to
   * a phone paired with another machine it would report the wrong one.
   */
  localRt: lsKey("localrt"),

  // ── Work in flight (never synced — a replay is a prompt typed twice) ───
  /** The offline send queue itself. */
  outbox: lsKey("outbox"),
  /** Per-session compose drafts. */
  compose: lsKey("compose"),
  composeDrafts: lsKey("compose.drafts"),
  composeOutbox: lsKey("compose.outbox"),
  composeSheets: lsKey("compose.sheets"),
  /** Uploads whose bytes are gone: what `attachState` reads as a dead file. */
  deadUploads: lsKey("deadUploads"),
  /**
   * Recordings the desktop has not read yet (`dictateHold.ts` / `dictateQueue.ts`).
   *
   * The INDEX only — the WAV bytes are in IndexedDB, keyed by the same id. Per
   * device and never synced, for the reason the send queue is not: a clip is
   * audio this phone holds the only copy of, and a second device adopting the
   * row would claim words it has no bytes for.
   */
  dictations: lsKey("dictations"),
  /**
   * Which language the microphone is read as (`dictateLang.ts`).
   *
   * Per DEVICE and not synced, because the microphone is: this is a fact about
   * the phone that is held up and spoken into, and a desktop browser adopting
   * it would silently re-aim a transcriber nobody there is talking to.
   */
  dictateLang: lsKey("dictate.lang"),
  /**
   * Which languages the microphone's own picker lists (`dictateLang.ts`).
   *
   * A JSON array of codes, chosen in Settings. Per device with the language
   * itself: a picker is a fact about the phone whose microphone it is on.
   */
  dictateLangs: lsKey("dictate.langs"),
  /**
   * THE RETIRED GIVE-UPS LEDGER — read once, then never written again.
   *
   * It held a clipped 200-character head of every send that stopped, for a day,
   * because the queue row itself did not survive: a message expired after
   * thirty minutes and its failed row retired an hour later. Nothing retires
   * now, so a failed send keeps its own row with its full words and its repo,
   * and Activity is where it is triaged.
   *
   * The KEY stays, and is deliberately not deleted on upgrade. A phone coming
   * to this build has rows in here that name work the queue no longer holds —
   * `migrateGiveUps` in `core/queue/migrate.ts` turns each of them into a failed queue row
   * exactly once (`giveupsMigrated`) and leaves this value untouched, so a
   * migration that got something wrong has not also destroyed its input.
   */
  giveups: lsKey("giveups"),
  /** Set once `migrateGiveUps` has run. Its absence is what makes the
   *  conversion happen; its presence is what stops it happening twice and
   *  resurrecting rows the user has since dealt with. */
  giveupsMigrated: lsKey("giveups.migrated"),
  /**
   * Activity rows filed as seen-and-not-wanted: row key → when.
   *
   * NOT synced, deliberately. Most of what it names is this phone's own ledger
   * (a give-up row's key is an ackId this device minted, and another device has
   * never heard of it), so a synced copy would be a growing list of keys that
   * match nothing — and worse, a dismissal travelling to a device that still
   * holds the row would hide work on a phone whose owner never decided that.
   */
  activityDismissed: lsKey("activity.dismissed"),
  /**
   * Activity rows this device's OWNER, not the desktop, decided actually ran:
   * row key → when. The desktop's own detector degraded and never confirmed
   * it (`DeliveryTruth === "unconfirmed"` — typed into the session, screen
   * unreadable back), a person looked at the terminal and saw it worked, and
   * this is that call, kept apart from `activityDismissed` because it moves
   * the row into "done", not out of sight. Same reason not synced: the row it
   * names is this phone's own queue entry, minted by this device.
   */
  activityConfirmedDone: lsKey("activity.confirmedDone"),
  /**
   * THE RETIRED PAD RESCUE STORE — read once, then never written again.
   *
   * It held the notes an adopted pad value dropped, because `pad` was
   * merged last-write-wins on the WHOLE list and a device pushing a stale copy
   * deleted every note the other one had. The pad merges per note now
   * (`shared/pad.ts`, with tombstones), so nothing drops and nothing needs
   * catching.
   *
   * The KEY stays, and is deliberately not deleted on upgrade — the `giveups`
   * precedent: a phone coming to this build has the only copy of some words in
   * here (ten of them, on the device this was reported from), and a migration
   * that got something wrong must not also have destroyed its input.
   * `migratePadRescue` in `core/queue/migrate.ts` puts each one back on the pad exactly once
   * and leaves this value untouched.
   */
  padRescue: lsKey("padRescue"),
  /** Set once `migratePadRescue` has run. Its absence is what makes the
   *  conversion happen; its presence is what stops it happening twice and
   *  resurrecting notes the user has since dealt with. Written only after the
   *  pad write SUCCEEDED, so a quota refusal retries on the next boot. */
  padRescueMigrated: lsKey("padRescue.migrated"),
  /** Star and follow-up flag presses made with no link, replayed on reconnect (`pendingMarks.ts`). */
  pendingStars: lsKey("pendingStars"), pendingFollowUps: lsKey("pendingFollowUps"),
  /** The download queue's own state. */
  pullState: lsKey("pull.state"),
  /** This WebView's auto-download master switch (`autoPull()`), "0" = off. */
  pullAuto: lsKey("pull.auto"),
  /** "1" once this browser answered whether the APK on the same phone should be
   *  the only one fetching automatically (`browserPullAsk`). */
  pullBrowserAsk: lsKey("pull.browserask"),
  /**
   * Put every finished download into the phone's Downloads without a tap.
   *
   * Device-local and deliberately NOT synced: which folder a file lands in is a
   * fact about this phone (the browser has no such folder to write to), so a
   * setting travelling from a tablet would turn it on where it cannot be
   * honoured.
   */
  pullAutoSave: lsKey("pull.autosave"),

  // ── Caches and reading positions (re-derivable, all bigger than they look)
  /** Boot snapshots, so the launcher paints instantly instead of empty. */
  snapSessions: lsKey("snap.sessions"),
  snapRepos: lsKey("snap.repos"),
  /** When that repo listing last came from the host. Beside the snapshot for
   *  the same reason `snapAt` is beside the session list: a snapshot that
   *  cannot say how old it is reads as current, which offline it is not. */
  snapReposAt: lsKey("snapReposAt"),
  snapRecent: lsKey("snap.recent"),
  snapClosed: lsKey("snap.closed"),
  snapBacklog: lsKey("snap.backlog"),
  snapHistory: lsKey("snap.history"),
  /**
   * Per-repo build commands, keyed by worktree path, each with the moment the
   * host last confirmed them.
   *
   * The build sheet is the escape hatch you reach for when the link is bad, and
   * its list arrived over the socket only: offline it painted "no build
   * commands yet" for a repo that has five, and offered to spend tokens
   * defining them again. What the commands ARE is device-cacheable — the
   * decision that needs the host is RUNNING one, and that already queues.
   */
  snapBuilds: lsKey("snap.builds"),
  /**
   * Per-repo CAPTURE targets, keyed by worktree path, each with the moment the
   * host last confirmed them — `snapBuilds`' argument, unchanged.
   *
   * Its own key rather than a corner of the builds snapshot because the two
   * lists are confirmed at different moments: opening the capture sheet re-asks
   * `capture.list` and nothing else, so one age stamp covering both would be
   * wrong about whichever list was not the one that just landed.
   */
  snapCapture: lsKey("snap.capture"),
  /** The schedule list, with the moment it landed. Same argument as the builds
   *  snapshot: reading which runs are armed needs no link, arming one does. */
  snapSchedules: lsKey("snap.schedules"),
  /**
   * The CLI integration's health board, with the moment the host last pushed it.
   *
   * NOT synced, and that is the load-bearing part: this record is about THIS
   * desktop's `claude` binary — its version, its hook pipe, its screens. A copy
   * carried to another phone paired with another host would report the wrong
   * machine's heuristics as if they were this one's, which for a readout whose
   * whole job is to be believed is worse than having no readout.
   */
  snapCliHealth: lsKey("snap.clihealth"),
  /** When the session snapshot was taken. A snapshot without its age is
   *  unreadable offline, which is when it is read. */
  snapAt: lsKey("snap.at"),
  /** The slash-command list, minus each command's `output`. */
  slashCache: lsKey("slashCache"),
  /** path → mtime, so a thumb URL can be versioned without a `stat=1`. */
  fileMtimes: lsKey("fileMtimes"),
  /** Marks drawn on an artifact, kept local and instant. */
  artMarks: lsKey("artMarks"),
  /** Remarks on text files in the file viewer's review mode (`FileReview.tsx`),
   *  per repo + path, plus the comment being written. Typed words: kept by the
   *  hard reset like the compose drafts are. */
  fileRemarks: lsKey("fileRemarks"),
  /** Images already seen in a repo, so "new" means new. */
  newImages: lsKey("newimg"),
  /** Local write times for the synced keys. Last write wins on these. */
  syncTs: lsKey("syncTs"),
  /** Compose history (recalled with ↑), capped. */
  cmdHistory: lsKey("cmdHistory"),

  // ── This device's own view state ───────────────────────────────────────
  /** Manual session row order, and which repo groups are folded away. */
  sessionOrder: lsKey("sessionOrder"),
  collapsedRepos: lsKey("collapsedRepos"),
  /** Terminal toolbar strip revealed (the burger in the session header). Off by
   *  default: on a phone that row is a whole line of screen spent on verbs the
   *  header can pin. */
  toolbarOpen: lsKey("toolbarOpen"),
  /** Reader view vs. terminal. */
  readMode: lsKey("readMode"),
  /** Raw key pipe instead of a prompt box. Per device, NOT synced. */
  cliMode: lsKey("cliMode"),
  /** The newest prompt's cost fold (`CostFold`) is open to the full card
   *  rather than its one-line head — ONE preference for the terminal's strip
   *  (`TermCostStrip.tsx`) and the reader's newest turn, since they are the
   *  same card. Per device: how much of a phone's height it may spend is this
   *  screen's question. The key keeps its old name so the choice survives. */
  termCostOpen: lsKey("termCostOpen"),
  /**
   * How each repo's last send was aimed — the composer's armed mode, and the
   * Send sheet's last WHEN (`sendMemory.ts`).
   *
   * NOT the `sendMode` key that was deleted: that one armed the primary button
   * with a wall clock and said so nowhere. Only `now`/`idle` ever reach the
   * button, and both are spelled out on its face; a schedule is recalled onto
   * the SHEET, which draws the rule and says it was recalled.
   *
   * Per device, NOT synced: queueing a run of prompts the same way is a fact about the sitting
   * you are in, and a tablet inheriting a phone's half-hour-ago clock would arm it for work nobody is watching.
   */
  sendMemory: lsKey("sendMemory"),
  slotAskOff: lsKey("slotAskOff"), // repos (worktree paths) where the slot check's ask is OFF (`slotAskStore.ts`); per host, not synced
  /**
   * The backend+model pair last answered to the per-launch ask
   * (`LaunchAskSheet`), so the sheet re-opens where you left it.
   *
   * NOT `launch`, and deliberately not synced. `launch` is the
   * DEFAULT a session you are not thinking about runs, and the ask exists
   * precisely because answering it must not re-point that default — writing
   * this answer there is the silent drift the sheet was built to remove. This
   * is the weaker claim: what this phone picked last time it was asked. Per
   * device because it is the starting point of a control on THIS screen, and a
   * pair carried to a tablet paired with another desktop can name a backend
   * that host does not have (`launchAskStart` drops such a pair, but the honest
   * fix is not to send it).
   */
  launchLast: lsKey("launchLast"),
  /** Models taken OFF the model wheel (`WheelPicker`): hidden, not shown, so a new one appears by itself. */
  wheelHidden: lsKey("wheelHidden"),
  /** Give the terminal the chrome's rows back while the compose box has focus
   *  (the on-screen keyboard is up). Per device, NOT synced: it is a fact about
   *  how much screen THIS device has left once its keyboard opens. */
  typingRoom: lsKey("typingRoom"),
  /** The `?` explain-mode chip in the launcher and session headers:
   *  "" (never asked) · "asked" (kept after the one-time ask) · "hidden". */
  hintChip: lsKey("hintChip"),
  termCornerPos: lsKey("termCornerPos"), // corner group's dragged offset (`useCornerDrag.ts`), per device
  /** The wide layout's sidebar width in CSS px, dragged by its edge (`core/layout/sideWidth.ts`).
   *  Per device: it is about this screen's width, not the person. */
  wideSideW: lsKey("wideSideW"),
  wideBesideW: lsKey("wideBesideW"), // the annotator column beside the session (`BesideGrip.tsx`), px; absent = half the room
  widePanelW: lsKey("widePanelW"), // the wide side panel (`.ws-panel`, `BesideGrip.tsx`), px; absent = CSS default
  /** Drop the keyboard after a send · the hold card (`ShortcutCard.tsx`): "0" off, absent = on + toast unsaid. */
  closeKbOnSend: lsKey("closeKbOnSend"), shortcutCard: lsKey("shortcutCard"),
  busySend: lsKey("busySend"), // Send on a working session: "" ask, else the remembered "now"/"idle"
  btwToCli: lsKey("btwToCli"), // after a /btw from the reader: "" ask to switch to the CLI, else the remembered "switch"/"stay"
  /** Light, dark, or follow the OS (`theme.ts`). Per device — see
   *  `shared/settings.ts` for why this one is not a fact about the person. */
  theme: lsKey("theme"),
  /** What this host's `<config dir>/theme.json` said last (`themeOverlay.ts`),
   *  cleaned — so a cold start paints the fork's look before the host answers. */
  themeOverlay: lsKey("themeOverlay"),
  /** The stylesheet derived from it, read by `index.html`'s inline script
   *  before the bundle parses (the no-flash half). Absent with no overlay. */
  themeOverlayCss: lsKey("themeOverlayCss"),
  /**
   * How big the text and the icons are (`uiScale.ts`), as multipliers.
   *
   * Per device for `theme`'s reason, and harder: a phone at arm's length and a
   * 27-inch display want different numbers out of the same pair of eyes. What
   * travels is the person; what does not is how far away the screen is.
   */
  textScale: lsKey("textScale"),
  iconScale: lsKey("iconScale"),
  /**
   * How big the TERMINAL draws, as a multiplier on top of `textScale`
   * (`uiScale.ts`). Per device for the two above's reason, and a knob of its
   * own because "I can read this" and "I can see enough of it" are different
   * questions: a smaller console font is a BIGGER grid, which is a fact about
   * the session the host is asked to resize, not about eyesight.
   */
  termZoom: lsKey("termZoom"),
  /**
   * The same knob for the READER (`uiScale.ts`). Stored apart from the console's
   * because they are different documents in different units — a terminal is a
   * grid whose size the host is told about, a transcript is a page that
   * reflows — and wanting the CLI dense while the conversation stays
   * comfortable is not a contradiction.
   */
  readerZoom: lsKey("readerZoom"),
  /**
   * The same knob again for the SCROLLBACK sheet (`ScrollbackSheet.tsx`).
   *
   * A third value rather than the console's, though it shows the console's own
   * text, because zooming the console resizes the GRID — the host is told the
   * new cols/rows and the PTY is resized under a live session. Reading an
   * hour of history is not a reason to reshape the session that wrote it. And
   * not the reader's either: that is prose that reflows, this is fixed-width
   * lines that were wrapped by an 80-column terminal, so the size that stops
   * them wrapping a second time is a different number.
   */
  scrollZoom: lsKey("scrollZoom"),
  /**
   * The same knob for the git review sheet (`GitView.tsx`): the file list and
   * the diff. Its own value because what wants shrinking there is long paths
   * and diff lines, not prose or a terminal grid.
   */
  gitZoom: lsKey("gitZoom"),
  /**
   * Whether the Terminal text sheet (`TextDumpLines.tsx`) wraps long lines.
   * Off by default: a terminal grid is already broken into rows, and wrapping
   * them again turns one screen row into two ragged ones. A transcript
   * paragraph is one long line, so the reader turns it on when it needs it.
   */
  textDumpWrap: lsKey("textDumpWrap"),
  /**
   * RETIRED — the bulk-close dialog's custom "close older than N hours" field.
   * `CloseSheet.tsx` offers fixed idle-for/open-for edges as facet chips
   * instead of one typed number; `useLauncherModel.ts` `lsDel`s this once on
   * load so an old value does not linger with nothing left to read it.
   */
  closeCustomH: lsKey("closeCustomH"),
  /**
   * The last headroom percentage typed by hand into the Send sheet's
   * *only if there is headroom* row, so the next rule is offered it as a chip
   * beside the four fixed ones.
   *
   * Device-local rather than synced: it is the same kind of fact as the cutoff
   * above it — a habit about how this phone is driven, not content somebody
   * authored and expects to find on the other device. The rule it ends up on
   * travels; the shortcut to writing the next one does not.
   */
  schedPctLeft: lsKey("schedPctLeft"),
  /** The last lead time typed into *how long before*'s *another…* field, in
   *  minutes — offered as a chip beside the presets. Device-local for the same
   *  reason as `schedPctLeft`. */
  schedLeadMin: lsKey("schedLeadMin"),
  /**
   * RETIRED — which ONE clock the bulk-close cutoff measured: how long a
   * session had been QUIET, or how long it had EXISTED. `CloseSheet.tsx`
   * offers both as independent "idle for" / "open for" facets that COMBINE,
   * rather than a switch that picked one. `lsDel`'d once, same as `closeCustomH`.
   */
  closeBy: lsKey("closeBy"),
  /**
   * Whether a bulk close spares the STARRED sessions.
   *
   * Default on, and it is a setting rather than another cut because a star is
   * the one thing in this app a person set BY HAND to mean "come back to this":
   * a sweep that needs re-teaching that on every open is a sweep nobody trusts
   * with "All". Off is a real answer — closing the ones you marked is how a
   * finished shortlist gets cleared — so it is a toggle, not a guard.
   */
  closeKeepStar: lsKey("closeKeepStar"),
  /** Backlog sheet: last repo, its draft, and whether archived rows show. */
  backlogRepo: lsKey("backlogRepo"),
  backlogDraft: lsKey("backlogDraft"),
  backlogShowArchived: lsKey("backlogShowArchived"),
  /** Fan-out sheet: the composed sweep, kept across a close. */
  fanoutText: lsKey("fanout.text"),
  fanoutSel: lsKey("fanout.sel"),
  /** Fan-out sheet: the model a sweep launches with, when it is not the new-session default. */
  fanoutModel: lsKey("fanout.model"),
  /** Collage sheet: gutter width, and whether panels are numbered. */
  collageGap: lsKey("collageGap"),
  collageLabels: lsKey("collageLabels"),
  /** Feature-usage counts, flushed to the host as deltas. */
  usage: lsKey("usage"),
  /** Notification feed: what has been seen. */
  notifSeen: lsKey("notifSeen"),
  /**
   * The sentences this phone has shown as toasts, newest first and bounded.
   *
   * NOT synced, deliberately: every row is a thing that happened on THIS
   * screen ("copied", "queued — waiting until the session can take it"), and
   * carried to a tablet it would read as that tablet's own history of taps it
   * never made. Durable because the point of it is to survive the reload that
   * takes the sentence you were reading with it (`toast.ts`).
   */
  toastLog: lsKey("toastLog"),
  /**
   * That the hosted-model notice has been read and accepted on THIS device,
   * with the version of the text that was shown.
   *
   * NOT synced, and that is the whole point: the acknowledgement is a statement
   * made by whoever was holding this device after reading words on this screen.
   * Syncing it would mark the notice "read" on a tablet nobody read it on,
   * which turns a consent record into a fiction. The version is stored so a
   * material change to the text re-asks rather than silently inheriting an
   * agreement to something else.
   */
  hostedAck: lsKey("hostedAck"),
  /**
   * Which sessions have already been TOLD what a turn in them costs, and at
   * which level — so the reminder fires once per session per step up, not once
   * per frame that arrives while a long session is running.
   *
   * Deliberately not synced: it records that a toast appeared on THIS screen,
   * and a phone that was in a pocket while the desktop was told nothing has not
   * been told anything. Bounded on write.
   */
  costNoticed: lsKey("costNoticed"),
  /** Per session, the subagent last announced as running over
   *  `AGENT_LARGE_TOK` (`costNotice.ts`'s `shouldNoticeAgent`). Not synced for
   *  the reason `costNoticed` is not. Bounded on write. */
  agentNoticed: lsKey("agentNoticed"),
  /** Per session, the spend mark last announced (`shouldNoticeSpend`); as `agentNoticed`. */
  spendNoticed: lsKey("spendNoticed"),

  // ── This browser's history with its own banners ────────────────────────
  /** The insecure-origin banner is snoozed a week, not dismissed. */
  dismissInsecure: lsKey("dismissInsecure"),
  /** Phone-setup banner snoozed until (ms). Per device: it is about THIS phone. */
  dismissPhoneSetup: lsKey("dismissPhoneSetup"),
  /** The code-folder dialog's "later": the guesses it was dismissed on, as `<picked>:<root>`
   *  (`features/codeFolder/logic.ts`). Per device; a host that guesses differently asks again. */
  codeFolderLater: lsKey("codeFolderLater"),
  dismissedUpdate: lsKey("dismissedUpdate"), annHintHidden: lsKey("annHintHidden"),
  /** Strips folded into the session's status line (`stow.ts`): `<slot>|<content key>` → when.
   *  Per device; a NEW content key unfolds by itself. Bounded on write. */
  stowed: lsKey("stowed"),
  /** The first fold said where folded strips go; once per device. */
  stowTold: lsKey("stowTold"),
  /** The watchdog reload's own loop guard. */
  lastForcedReload: lsKey("lastForcedReload"),
  /** Web bundle staged for the next start, and whether to take it unasked. */
  webUpdateStaged: lsKey("webUpdate.staged"),
  webUpdateAuto: lsKey("webUpdate.auto"),
  /** Whether a staged build may restart the app by itself, and the per-build
   *  attempt count that stops a bundle which never becomes current from
   *  reloading the app every time it is put down. */
  webUpdateApply: lsKey("webUpdate.apply"),
  webUpdateApplyTries: lsKey("webUpdate.applyTries"),
  /** The last native fallback (`lastRecoveryAt`) this phone has already been
   *  told about, so the "did not start" toast is said once per fallback. */
  webUpdateRecoverySeen: lsKey("webUpdate.recoverySeen"),
  /** The staged-build banner, hidden for a few hours rather than for this page
   *  life only. Per build, with an end (`updateSnooze.ts`). */
  webUpdateSnooze: lsKey("webUpdate.snooze"),
  /**
   * The screen this device was last on, and the one-shot arm that says the next
   * start is a different bundle (`resumeRoute.ts`).
   *
   * Device-local by construction: the route names a session and a sheet on THIS
   * phone, and a tablet restored onto it would be put somewhere nobody left it.
   */
  routeLast: lsKey("route.last"),
  routeResume: lsKey("route.resume"),
  /**
   * Which contributed session views (the live desktop) have a tab in the
   * session header (`core/session/headerViews.ts`): one is added when the view
   * is opened from the ☰ menu and removed by its tab's ×. The host's, like the
   * desktop it shows.
   */
  headerViews: lsKey("headerViews"),
  /**
   * The brand migration's two marks (`boot/brandMigrate.ts`): that this phone's
   * localStorage was copied from an older prefix (`shared/brandmigrate.ts`
   * writes it), and which IndexedDB databases / caches were copied too.
   *
   * DEVICE keys, and the reason is a resurrection: a host switch parks every
   * host key, so a host-scoped mark would vanish from the bare namespace on the
   * first switch, the copy would run again, and a draft the person had since
   * cleared would come back from its stale legacy copy.
   */
  brandMigrated: BRAND_MIGRATED_KEY,
  brandStores: lsKey("brand.stores"),
  /**
   * The demo this device chose to be in (`demo/mode.ts` `enterDemo`), as a
   * scenario id. A DEVICE key: it is about this screen, and a host switch must
   * not carry a person out of — or into — the demo. A `?demo=<id>` URL turns
   * the demo on for that page without ever writing this.
   */
  demo: lsKey("demo"),
  /**
   * APK only: the saved host that was active when the demo was entered, so
   * leaving it goes back there (`hosts.leaveDemoHost`). A DEVICE key for the
   * demo's own reason — the switch that enters and leaves the demo parks every
   * host key, and this one must outlive it.
   */
  demoReturn: lsKey("demo.return"),
  /**
   * The demo's hook and "More to try" tour (`features/demoTour`): how far
   * the first minute got, and which rows a tap has reached. A DEVICE key for `demo`'s
   * reason; cleared when the demo is entered or left, so each visit starts at
   * the beginning.
   */
  demoTour: lsKey("demo.tour"),
} as const;

/**
 * The static web demo's own corner of localStorage: every key the page reads or
 * writes lives under this prefix while `?demo=` is on a non-host origin (the
 * facade is `demo/world.ts`), so a demo opened on a real host's origin neither
 * reads its drafts, queue and settings nor leaves any. In the APK the demo is a
 * SavedHost and gets the `waterplane.h.<id>.` namespace instead.
 */
export const DEMO_WORLD_PREFIX = lsKey("demoworld.");

/**
 * Reader-view watermarks are per SESSION, so the key is built rather than
 * listed. Kept here anyway: it is the one prefixed key a grep of this file
 * would otherwise miss, and `BootGuard` has to recognise it to sweep it.
 */
export const TR_SEEN_PREFIX = lsKey("trSeen.");
export const trSeenKey = (sessionId: string): string => `${TR_SEEN_PREFIX}${sessionId}`;

/**
 * An in-repo EXTENSION's own corner (`sdk/extStorage.ts`): `<prefix>ext.<pluginId>.<name>`. Built
 * rather than listed for `trSeenKey`'s reason — the names are the extension's — and HOST-scoped
 * (`HOST_KEY_PREFIXES`), so a remembered choice is per desktop and parks with it on a switch.
 */
export const EXT_PREFIX = lsKey("ext.");
export const extKey = (pluginId: string, name: string): string => `${EXT_PREFIX}${pluginId}.${name}`;

/**
 * The demo's persisted fake desktop, one key per scenario (`demo/transport.ts`).
 *
 * In **sessionStorage**, never localStorage — so it is not in `KEY_SCOPE` and a
 * host switch never sees it: a reload of this tab (the watchdog's, after a
 * dropped demo socket) must find the demo as it was, and a new tab is a fresh
 * demo. Built rather than listed for `trSeenKey`'s reason, and kept here so the
 * one file that names every key still does.
 */
export const DEMO_SNAP_PREFIX = lsKey("demo.snap.");
export const demoSnapKey = (scenarioId: string): string => `${DEMO_SNAP_PREFIX}${scenarioId}`;

/**
 * Which keys follow the PHONE and which follow the ACTIVE HOST.
 *
 * Several desktops share this phone (`hosts.ts`). The active host's keys live
 * bare; switching parks every host key under `<prefix>h.<id>.` and restores the
 * next host's (`shared/hosts.ts` `planHostSwitch`). A DEVICE key is never
 * moved: it is about this screen, this hand or this link, not about whichever
 * desktop was on the other end.
 *
 * A record typed over every `LS` name, so a new key that is not classified is
 * a TYPE ERROR, not a key that silently follows the wrong owner — and
 * `storage.test.mjs` checks the same thing at run time. When in doubt, `host`:
 * a host key that should have been a device key costs a setting chosen twice,
 * a device key that should have been a host key shows one desktop's queue to
 * another. Every SYNCED key is `host` (sync is per host, and so is its
 * bookkeeping `syncTs`).
 */
export type KeyScope = "device" | "host";
export const KEY_SCOPE = {
  // synced — the settings document is per host
  snippets: "host", headerCmds: "host", fanoutPresets: "host", toolbar: "host", launch: "host",
  launchAsk: "host", spendWarn: "host", pad: "host", hiddenRepos: "host", enterSends: "host", dictateTerms: "host",
  autoSend: "host", serialSessions: "host", confirmQueue: "host", readerTools: "host", annKnobs: "host", annTools: "host", annPrompt: "device",
  hints: "host", repoColors: "host", installAllow: "host", closeWhenDone: "host", localSessions: "host", syncTs: "host",
  // identity and the host list itself
  deviceId: "device", deviceName: "device", hostBase: "device", hosts: "device", hostActive: "device",
  hostSwitch: "device", hostsGone: "device",
  // that host's ledger row and LAN identity: parked with it
  deviceToken: "host", lanIdentity: "host", passive: "host",
  // what that host's install log last said
  installLog: "host",
  // the link: the phone's own switches are device, what was MEASURED against a host is host
  dataSaver: "device", bgFresh: "device", uploadScale: "device", netPulse: "device", localRtBar: "device", unfoldToEnd: "device", repoSort: "device",
  upKbps: "host", netlog: "host", netTraffic: "host", netSync: "host", localRt: "host",
  // the session tab strip: its SHAPE is this screen's, its open counts are that host's sessions
  sessionTabs: "device", sessionTabsCount: "device", sessionTabsOrder: "device", sessionTabsLimit: "device", tabOpens: "host", tabFiles: "host",
  // work in flight: that host's words, that host's queue
  outbox: "host", compose: "host", composeDrafts: "host", composeOutbox: "host", composeSheets: "host",
  deadUploads: "host", dictations: "host", pendingStars: "host", pendingFollowUps: "host", backlogDraft: "host",
  // the language spoken into THIS phone (the vocabulary, `dictateTerms`, is the person's and synced)
  dictateLang: "device", dictateLangs: "device",
  fanoutText: "host", fanoutSel: "host", fanoutModel: "host", backlogRepo: "host", backlogShowArchived: "host",
  // retired stores, read once by a migration: never moved, so the migration finds them
  giveups: "device", giveupsMigrated: "device", padRescue: "device", padRescueMigrated: "device",
  activityDismissed: "host", activityConfirmedDone: "host",
  pullState: "host", pullAuto: "host", pullBrowserAsk: "host", pullAutoSave: "host",
  // what that host last said, cached for an offline cold start
  snapSessions: "host", snapRepos: "host", snapReposAt: "host", snapRecent: "host", snapClosed: "host",
  snapBacklog: "host", snapHistory: "host", snapBuilds: "host", snapCapture: "host", snapSchedules: "host",
  snapCliHealth: "host", snapAt: "host", themeOverlay: "host", themeOverlayCss: "host", slashCache: "host", fileMtimes: "host", artMarks: "host", fileRemarks: "host",
  newImages: "host", cmdHistory: "host", usage: "host", notifSeen: "host",
  costNoticed: "host", agentNoticed: "host", spendNoticed: "host",
  sessionOrder: "host", collapsedRepos: "host", sendMemory: "host", slotAskOff: "host", launchLast: "host", wheelHidden: "host",
  // how this phone is held and read
  toolbarOpen: "device", readMode: "device", cliMode: "device", termCostOpen: "device",
  typingRoom: "device", hintChip: "device", termCornerPos: "device", wideSideW: "device", wideBesideW: "device", widePanelW: "device", closeKbOnSend: "device", shortcutCard: "device", busySend: "device", btwToCli: "device", theme: "device", textScale: "device", iconScale: "device", termZoom: "device",
  readerZoom: "device", scrollZoom: "device", gitZoom: "device", textDumpWrap: "device", closeCustomH: "device",
  schedPctLeft: "device", schedLeadMin: "device", closeBy: "device", closeKeepStar: "device", collageGap: "device",
  collageLabels: "device", toastLog: "device", hostedAck: "device",
  // dismissals and the app's own update machinery
  dismissInsecure: "device", dismissPhoneSetup: "device", codeFolderLater: "device", dismissedUpdate: "device", annHintHidden: "device",
  stowed: "device", stowTold: "device",
  lastForcedReload: "device", webUpdateRecoverySeen: "device",
  webUpdateStaged: "host", webUpdateAuto: "host", webUpdateApply: "host", webUpdateApplyTries: "host",
  webUpdateSnooze: "host", routeLast: "host", routeResume: "host", headerViews: "host",
  // the brand migration's marks: about this phone's storage, never parked
  brandMigrated: "device", brandStores: "device",
  // the demo switch: about this phone, never parked with a host
  demo: "device",
  demoReturn: "device",
  demoTour: "device",
} as const satisfies Record<keyof typeof LS, KeyScope>;

/** The keys a host switch never moves. */
export const DEVICE_KEYS: ReadonlySet<string> = new Set(
  (Object.keys(KEY_SCOPE) as (keyof typeof LS)[]).filter((k) => KEY_SCOPE[k] === "device").map((k) => LS[k]),
);

/** Built keys (not in `LS`) and whom they follow. Every one is a host's. */
export const HOST_KEY_PREFIXES: readonly string[] = [TR_SEEN_PREFIX, EXT_PREFIX];

/** The predicate `planHostSwitch` is handed. An UNREGISTERED prefixed key (an
 *  older build's, a built one) is a host key: parked, never lost. */
export function isDeviceKey(key: string): boolean {
  return DEVICE_KEYS.has(key);
}

/**
 * The synced half, as a set, checked against the shared allow-list at load.
 *
 * The check is the point: the allow-list is the contract both ends read, and a
 * key renamed here but not there syncs nothing while looking like it does. In
 * dev this is loud; in production it degrades to the same silent local-only
 * behaviour that a missing key already has.
 */
export const SYNCED = new Set<string>(SYNCED_SETTING_KEYS);
if (import.meta.env?.DEV) {
  const known = new Set<string>(Object.values(LS));
  const missing = SYNCED_SETTING_KEYS.filter((k) => !known.has(k));
  if (missing.length) console.warn("[storage] synced keys missing from the registry:", missing);
}

/** Raw string, or null. Never throws — private mode is not a crash. */
export function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Write a raw string. Goes through the patched `setItem`, so a synced key
 *  still syncs — do not reach past this to a stored reference. */
export function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota / private mode — non-fatal */ }
}

export function lsDel(key: string): void {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

/**
 * JSON read with a fallback. The forty-odd copies of this were all identical
 * except for what they considered empty, which is now the caller's single
 * argument rather than a literal buried in each `catch`.
 */
export function lsJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") return fallback;
    const v = JSON.parse(raw) as T;
    // `null` round-trips as a valid parse but is never what a caller wanted
    // back in place of its own default.
    return v === null ? fallback : v;
  } catch { return fallback; }
}

export function lsSetJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
}

/** `"1"`/`"0"` flags, with the default applied to an unset key. */
export function lsBool(key: string, fallback = false): boolean {
  const v = lsGet(key);
  return v === null ? fallback : v === "1" || v === "true";
}

export function lsSetBool(key: string, value: boolean): void { lsSet(key, value ? "1" : "0"); }

/**
 * A finite number, or the fallback. A hand-edited key reads as unset. The
 * `null` check is load-bearing: `Number(null)` is 0, so an UNSET key once
 * answered zero rather than the caller's default.
 */
export function lsNum(key: string, fallback: number): number {
  const raw = lsGet(key);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
