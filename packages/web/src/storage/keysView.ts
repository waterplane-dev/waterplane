/**
 * Keys of the LS registry, slice 3: this device's view state and its banners.
 * Moved out of `storage.ts` byte-identical; `LS` there spreads the three slices in order.
 */
import { BRAND_MIGRATED_KEY, lsKey } from "@waterplane/shared";

export const LS_VIEW = {
  // ── This device's own view state ───────────────────────────────────────
  /** Manual session row order, and which repo groups are folded away. */
  sessionOrder: lsKey("sessionOrder"),
  collapsedRepos: lsKey("collapsedRepos"),
  /** Terminal toolbar strip revealed (the burger in the session header). Off by
   *  default: on a phone that row is a whole line of screen spent on verbs the
   *  header can pin. */
  toolbarOpen: lsKey("toolbarOpen"),
  /** The last desktop boot seen per host, and how long its last restart kept
   *  this phone waiting (`link/hostRestart.ts`): `{ [hostKey]: { bootId, usualMs? } }`. */
  hostBoots: lsKey("hostBoots"),
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
  sessChromeH: lsKey("sessChromeH"), // the session header + status line's dragged height cap (`chromeCap.ts`), px; absent = all of it
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
  /** The one-time note that information no longer counts on the bell: set once dismissed. */
  notifInfoNote: lsKey("notifInfoNote"),
  /** What's new: the desktop version this phone last announced (or was told about) — the launcher row shows once per version. */
  whatsNewSeen: lsKey("whatsNewSeen"),
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
  /** The waterplane version whose update banner was dismissed (`features/plugins`); a newer one asks again. */
  dismissedSelfUpdate: lsKey("dismissedSelfUpdate"),
  /** `at` of the last desktop update receipt shown, so `self.lastResult` is said once (`features/plugins`). */
  updatesReceiptSeen: lsKey("updatesReceiptSeen"),
  dismissedUpdate: lsKey("dismissedUpdate"), annHintHidden: lsKey("annHintHidden"),
  /** Strips folded into the session's status line (`stow.ts`): `<slot>|<content key>` → when.
   *  Per device; a NEW content key unfolds by itself. Bounded on write. */
  stowed: lsKey("stowed"),
  /** The first fold said where folded strips go; once per device. */
  stowTold: lsKey("stowTold"),
  /** Backends this phone has shown "was not told about the outbox" for (`toldWords.ts`): once each. */
  toldNoticed: lsKey("toldNoticed"),
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
