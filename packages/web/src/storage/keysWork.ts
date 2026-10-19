/**
 * Keys of the LS registry, slice 2: work in flight, caches and reading positions.
 * Moved out of `storage.ts` byte-identical; `LS` there spreads the three slices in order.
 */
import { lsKey } from "@waterplane/shared";

export const LS_WORK = {
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

} as const;
