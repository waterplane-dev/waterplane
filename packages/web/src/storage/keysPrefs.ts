/**
 * Keys of the LS registry, slice 1: authored/synced preferences, device identity, the link.
 * Moved out of `storage.ts` byte-identical; `LS` there spreads the three slices in order.
 */
import { lsKey } from "@waterplane/shared";

export const LS_PREFS = {
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
  /** Ask before closing a session that would lose work (uncommitted, unmerged, shells). */
  confirmClose: lsKey("confirmClose"),
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
  /** Tokens at which a RUNNING subagent is called large (`agentWindowWarnSetting`); the host pushes on it too. Synced. */
  agentWindowWarn: lsKey("agentWindowWarn"),
  /** Parallel-agent count's amber/red marks (`agentCount.ts`). Synced. */ agentWarn: lsKey("agentWarn"),

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
   * This device's strip follows the order every device shares — `"0"` off,
   * absent ON. Per device: opting one screen out must not turn it off on the
   * others.
   */
  sessionTabsSync: lsKey("sessionTabs.sync"),
  /** `"1"` once this device was offered to stop that sharing during the
   *  current saver spell (`core/sessions/tabsSyncSaver.ts`); cleared when no
   *  saver is on, so the next spell asks again. */
  tabsSaverAsked: lsKey("sessionTabs.saverAsked"),
  /**
   * The SHARED tab order and open history, used instead of `sessionTabsOrder`
   * and `tabOpens` while `sessionTabsSync` is on. Synced (`shared/settings.ts`);
   * the opens are merged on adopt (`mergeOpens`), never last-write-wins, and
   * hold sessions only — a file looked at is this device's.
   */
  tabOrderShared: lsKey("tabsShared.order"), tabOpensShared: lsKey("tabsShared.opens"),
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

} as const;
