/**
 * Settings that follow the USER, not the browser.
 *
 * Everything the app remembers has lived in localStorage, which was right for
 * most of it — a send queue, a scroll watermark, a measured uplink rate all
 * describe THIS device. But the same store also held the things the user
 * AUTHORED: prompt templates (snippets), fan-out presets, header commands, the
 * prompt pad, the toolbar layout, the default launch flags. Those are not
 * properties of a browser, and keeping them there meant a phone, a desktop tab
 * and the Android shell each had their own private copy — write a template on
 * the phone and it does not exist anywhere else, reinstall the PWA and it is
 * gone. There is exactly one host and it already persists far more valuable
 * state, so that is where they belong.
 *
 * The design is deliberately dumb, because the alternative is a sync engine:
 *
 *  - **Opaque values.** The host stores the raw localStorage STRING per key and
 *    never parses it. Shapes change with the client (`presets.ts`'s
 *    `{ list, removed }` grew a field once already); a host that understood
 *    them would have to be upgraded in lockstep with the UI it serves — which
 *    it explicitly is not, since `webbundle.ts` lets the phone update its own
 *    web bundle without touching the daemon.
 *  - **Last write wins, per key, on a timestamp the WRITER stamps.** No
 *    merging: two devices editing the same list concurrently is rare (one
 *    person, one phone in hand) and a wrong merge of a prompt list is worse
 *    than a lost edit that is still visible in the other client's UI until it
 *    reloads. The pad is the one key whose CLIENT merges on adopt
 *    (`shared/pad.ts`, per note, with tombstones): the host still stores a
 *    string and still compares a `ts`, and this contract is unchanged.
 *  - **An allow-list, not a mirror.** Syncing everything would drag the send
 *    outbox, the paired host address and per-device cache state onto other
 *    devices — the outbox especially, where a second device replaying another
 *    device's queue is a prompt typed twice. Keys are opted IN, one at a time.
 *
 * The list below is the contract both ends check against, which is why it is
 * here rather than in either package.
 */

import { lsKey } from "./brand.js";

/** One synced setting as the host holds it: the client's raw string + when. */
export interface SettingRecord {
  /** Exactly what the client had in localStorage — never parsed by the host. */
  value: string;
  /** Epoch ms stamped by the client that wrote it. Last write wins. */
  ts: number;
  /** Which device wrote it last, for the "changed elsewhere" notice. */
  device?: string;
}

/** The whole synced document, keyed by localStorage key. */
export type SettingsDoc = Record<string, SettingRecord>;

/**
 * The keys that follow the user.
 *
 * Every entry is content or a preference the user set ON PURPOSE and would be
 * annoyed to re-create on another device. Anything describing the device, the
 * link, or work in flight stays local — see the note below the list.
 */
export const SYNCED_SETTING_KEYS = [
  /** Reusable prompt text the compose box appends — "prompt templates". */
  lsKey("snippets"),
  /** One-tap chips in the session header (`headerCmds.ts`). */
  lsKey("headerCmds"),
  /** Fan-out sweep presets (`presets.ts`). */
  lsKey("fanout.presets"),
  /** Terminal toolbar layout: order, hidden items, pinned header actions. */
  lsKey("toolbar"),
  /** Default launch flags (model / effort / permission mode) for new sessions. */
  lsKey("launch"),
  /**
   * Ask which backend and model to run EVERY time a new session is started,
   * instead of applying `<prefix>launch` silently.
   *
   * Synced beside the defaults it modifies, and for the same reason: "I want to
   * be asked" is a statement about how this person works, not about the browser
   * they happened to say it in. A phone that asked and a desktop tab that did
   * not would make the same tap mean two different things.
   */
  lsKey("launchAsk"),
  /**
   * The spend warnings' thresholds (`spendwarn.ts`): orange and red as a share
   * of the week, and in dollars where no week is calibrated. How much one
   * session may spend before it is worth a mark is the person's budget, not a
   * fact about the phone it was set on.
   */
  lsKey("spendWarn"),
  /** The prompt pad — untargeted drafts, written on one device, sent from another. */
  lsKey("pad"),
  /** Repos hidden from the launcher list. */
  lsKey("hiddenRepos"),
  /** Enter submits vs. inserts a newline. */
  lsKey("enterSends"),
  /**
   * The person's dictation vocabulary (`dictateterms.ts`) — words the
   * transcriber keeps getting wrong. Unlike the dictation LANGUAGE, which is a
   * fact about the phone being spoken into, this is a fact about the person's
   * work: `BA3` is misheard the same way on every device they carry.
   */
  lsKey("dictate.terms"),
  /** Drain the send queue automatically when the link returns. */
  lsKey("autoSend"),
  /**
   * Run queued session-opens for one repo ONE AT A TIME rather than all at once
   * (`shared/queue.ts`'s `serial`). A statement about how the person wants their
   * account's usage spent and their repo edited, which is the same wherever they
   * queue the work from — the phone that wrote the queue is rarely the device
   * that watches it drain.
   */
  lsKey("serialSessions"),
  /** Ask before draining text that was queued offline. */
  lsKey("confirmQueue"),
  /**
   * Reader view: how much of a tool call is shown, and how much of it is even
   * downloaded (`web/transcriptUtil.ts`). A preference about reading, which is
   * the same on every device the same person reads on.
   */
  lsKey("readerTools"),
  /**
   * The image annotator moves, sizes and turns a mark by KNOBS on strings
   * instead of by relative drag (`web/annKnobs.ts`). A way of pointing this
   * person chose on purpose and asked to have remembered; the annotator opens on
   * whichever device the picture happens to be on, and flipping it back every
   * time is the annoyance. Relative drag stays what a new person starts on.
   */
  lsKey("annKnobs"),
  /**
   * The image annotator's toolbar as the person arranged it — which controls
   * show, their order, rail or row (`web/annLayout.ts`). Authored, like the
   * terminal toolbar's layout above, and for the same reason.
   */
  lsKey("annTools"),
  /**
   * Button hints: the mode, and which explanations have been dismissed
   * (`web/hints.ts`). Synced because the whole point of dismissing one is not
   * being told again — being re-taught on the desktop what you already read on
   * the phone is the annoyance the feature exists to remove.
   */
  lsKey("hints"),
  /**
   * Which ring the per-repo identity colours come from, and every hue a person
   * pinned over it (`shared/repocolor.ts`).
   *
   * Synced, unlike `<prefix>theme` two rules below — and the two look alike enough
   * that the difference is worth stating. The theme is a fact about the DEVICE
   * (a phone in a dark bedroom, a desktop under a window). Which colour a repo
   * is, is a fact about the PERSON: it is the thing they use to recognise a
   * group header at a glance and a tab at 85 px, and having it be one colour on
   * the phone and another on the desktop would cost exactly the recognition the
   * colour exists for.
   */
  lsKey("repoColors"),
  /**
   * Which apps a build downloaded from the desktop may install by itself
   * (`web/installPolicy.ts`, mirrored into the Android shell).
   *
   * Synced for the same reason `<prefix>repoColors` is: it is a fact about the
   * PERSON and their own apps — "Tiptoi and TalkingPictures are mine, put the
   * new build on without asking" is the same answer on every phone they carry,
   * and a second phone that had to be taught it again would be asked the one
   * question this feature exists to stop asking.
   *
   * It grants nothing by itself. The phone's own "install unknown apps" access
   * is per DEVICE and is not synced, cannot be, and is the thing that actually
   * decides whether anything installs.
   */
  lsKey("installAllow"),
  /**
   * Close an AUTOMATIC session (`backlog · <repo> · <label>`, the one a fired
   * item opens) once its work is done and it has lingered — `"1"` on, anything
   * else (and absent) OFF. Read by the HOST, which is why it is a constant
   * below rather than only a localStorage name: `closeWhenDoneSetting` is the
   * one parse. An item's own `Intent.closeWhenDone` overrides it either way.
   *
   * Synced because it is a statement about how the person works — "leave what
   * the machine did open until I have looked at it" — and the desktop is the
   * one place it acts, whichever device said it.
   */
  lsKey("backlog.closeWhenDone"),
  /**
   * How many LOCAL-model coding sessions may be working at once on this
   * desktop (`LOCAL_SESSIONS_KEY`, read by the HOST — `localSessionsSetting` is
   * the one parse). A whole number; `"0"` is no cap; absent is the desktop's
   * own default (`WATERPLANE_LOCAL_SESSIONS`, else 1). Synced because the cap
   * acts on the desktop whichever device set it.
   */
  lsKey("local.maxSessions"),
] as const satisfies readonly string[];

/** The synced key the host reads for the local-model session cap. */
export const LOCAL_SESSIONS_KEY = lsKey("local.maxSessions");

/** The biggest cap a person may type; anything above is "no cap" in practice. */
export const LOCAL_SESSIONS_MAX = 16;

/**
 * The local-model cap off its raw string: a whole number 1..16 is that cap,
 * `"0"` is NO cap (`null`), and absent, empty or garbage is `fallback` — the
 * desktop's own default, never a guessed number.
 */
export function localSessionsSetting(raw: string | undefined | null, fallback: number | null): number | null {
  const v = (raw ?? "").trim();
  if (!/^\d{1,2}$/.test(v)) return fallback;
  const n = Number(v);
  if (n === 0) return null;
  return n <= LOCAL_SESSIONS_MAX ? n : fallback;
}

/** The synced key the host reads for the global close-when-done default. */
export const CLOSE_WHEN_DONE_KEY = lsKey("backlog.closeWhenDone");

/**
 * The global *close automatic sessions when done* default, off the raw synced
 * string. `"1"`/`"true"` is on (the client's flag spelling); absent, empty or
 * anything else is OFF — the default the person chose: nothing closes a
 * session they did not ask to have closed.
 */
export function closeWhenDoneSetting(raw: string | undefined | null): boolean {
  return raw === "1" || raw === "true";
}

export type SyncedSettingKey = (typeof SYNCED_SETTING_KEYS)[number];

/**
 * Why the obvious candidates are NOT in the list above — kept as prose because
 * the next person to add a key will ask exactly this.
 *
 *  - `<prefix>outbox` / `<prefix>compose.*` / `<prefix>deadUploads` — work in flight.
 *    Replaying another device's queue types the same prompt twice; the ack
 *    ledger de-dupes a RETRY of the same ackId, not a second device deciding to
 *    send someone else's entry.
 *  - `<prefix>hostBase`, `<prefix>deviceId` — what makes this device this device.
 *  - `<prefix>dataSaver`, `<prefix>uploadScale`, `<prefix>upKbps` — properties of the
 *    LINK. A phone on a DERP-relayed 5G path and a desktop on the LAN want
 *    opposite answers, and copying one over the other makes the bad link worse.
 *  - `<prefix>theme` — light, dark, or follow the OS (`web/theme.ts`). The one
 *    that looks most like a fact about the PERSON and is not: the phone is held
 *    in a dark bedroom and the desktop sits under an office window, the two
 *    panels are different, and "dark on OLED" is a battery decision about one
 *    of them. `system` — the DEFAULT — already carries the per-person answer,
 *    since each OS is told the same thing by the same person; what an explicit
 *    pick overrides is THIS device's OS, which is a fact about this device.
 *    There is a second reason, learned while building it. Every synced key is
 *    last-write-wins on a CLIENT-SUPPLIED timestamp, and a client that reports
 *    a wrong clock parks that key for as long as the skew lasts: nothing ever
 *    lowers a stored `ts`, so every later pick loses to it and is echoed back
 *    undone. For the pad or the toolbar that risk buys a feature worth having.
 *    For a setting whose whole job is one tap that changes what you are looking
 *    at, a failure mode where the tap silently reverts is worse than not
 *    syncing at all.
 *  - `<prefix>netPulse` — the permanent connection strip (`web/netpulse.ts`). It
 *    looks like a display preference, but switching it on spends THIS device's
 *    radio on an extra ping every three seconds and THIS device's screen on
 *    22 px: exactly the trade a phone on a bad tunnel wants to make and a
 *    desktop on the LAN does not. Same reason as the row above.
 *  - `<prefix>snap.*`, `<prefix>slashCache`, `<prefix>artMarks`, `<prefix>trSeen.*`,
 *    `<prefix>pull.state`, `<prefix>netlog` — caches and per-device reading
 *    positions, all re-derivable and all bigger than they look.
 *  - `<prefix>dismiss*`, `<prefix>lastForcedReload`, `<prefix>webUpdate.*` — this
 *    browser's own history with its own banners.
 */
/** Cheap membership test that also narrows the type. */
export function isSyncedKey(key: string): key is SyncedSettingKey {
  return (SYNCED_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * Per-value cap, sized ABOVE what the client's own caps can produce: a full
 * preset list is 80 items × 8000 chars ≈ 640 KB, and a value the host refuses
 * is the worst outcome available — the two ends then disagree with nothing on
 * screen saying so. Anything past this is a client bug, not a big list.
 */
export const MAX_SETTING_BYTES = 1024 * 1024;

/** Whole-document cap, so a misbehaving client cannot grow the file forever. */
export const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
