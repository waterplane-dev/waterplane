/**
 * The two lists a RESET reads: what "reset UI settings to default" forgets, and
 * what `BootGuard`'s hard reset keeps. Out of `storage.ts` (past its line cap),
 * which still owns every key they name.
 */
import { HOST_PARK_PREFIX, LEGACY_STORAGE_PREFIXES } from "@waterplane/shared";
import { LS } from "./storage.ts";

/**
 * What "reset UI settings to default" forgets: how THIS phone draws the app —
 * theme, sizes, zooms, strips, tabs, layout switches, the `?` chip. Device
 * keys only, and never a store of words or a synced choice (header commands,
 * pins, hint dismissals): a reset of the look must not delete anything a
 * person wrote or chose for every device. `storage.test.mjs` holds it to that.
 */
export const UI_RESET_KEYS: readonly (keyof typeof LS)[] = [
  "theme", "textScale", "iconScale", "termZoom", "readerZoom", "scrollZoom", "gitZoom", "textDumpWrap",
  "sessionTabs", "sessionTabsCount", "sessionTabsOrder", "sessionTabsLimit", "sessionTabsSync", "netPulse", "localRtBar", "unfoldToEnd",
  "typingRoom", "closeKbOnSend", "shortcutCard", "busySend", "btwToCli", "toolbarOpen", "readMode", "cliMode", "termCostOpen", "termCornerPos",
  "hintChip", "annHintHidden",
];

/**
 * What `BootGuard`'s hard reset leaves in localStorage, by prefix.
 *
 * The reset drops the service-worker caches and the device-local view state,
 * and deliberately NOT the send outbox or the prompt pad — unsent text is the
 * one thing here that cannot be re-fetched from the host — nor the bookkeeping
 * that decides whether those survive the next sync. Here rather than in
 * `BootGuard.tsx` so a node test can hold it (`boot/brandMigrate.test.mjs`).
 */
export const RESET_KEEP_PREFIXES: readonly string[] = [
  LS.outbox, LS.pad, LS.compose,
  // Remarks written on a file and not yet sent: typed words, the only copy.
  LS.fileRemarks,
  // The RETIRED pad rescue store, and the mark that says it has been read.
  // `LS.pad` already covers both by prefix; named anyway, because until
  // `migratePadRescue` has run this holds the last copy of notes the old
  // whole-list merge dropped — and a crash recovery is exactly when that
  // migration has not happened yet. A rename would silently take it off the
  // list.
  LS.padRescue, LS.padRescueMigrated,
  // The RETIRED give-ups ledger. Nothing writes it any more — a failed send
  // keeps its own queue row, with its full words — but a device that has not
  // yet run `migrateGiveUps` still has the only copy of some words in here, and
  // a crash recovery is exactly when that migration has not happened yet.
  LS.giveups, LS.giveupsMigrated,
  // The sync bookkeeping, which is not view state.
  //
  // Dropping it made this reset a silent pad delete: with no recorded write
  // times every remote value is newer than everything local, so the next
  // `settings.all` replaces the pad (and the snippets, and the presets) with
  // whatever the host last heard from any device — including a copy from before
  // the notes on this phone were written. The one store a crash must not touch
  // was being emptied by the crash recovery.
  LS.syncTs,
  // The desktops this phone knows, and EVERY other host's parked keys — their
  // drafts, queue and pad under `<prefix>h.<id>.`. A reset that dropped them
  // would delete the words of every host but the one that crashed. `hostBase`
  // is rewritten from the list at the next boot, so it need not be kept.
  LS.hosts, LS.hostActive, LS.hostSwitch, LS.hostsGone, HOST_PARK_PREFIX,
  // Everything under an OLDER brand's prefix, and the marks that say it was
  // copied. Until the copy has run, a legacy key is the only copy of a draft;
  // after it, dropping the mark would run the copy again and bring back a
  // draft the person had cleared since.
  ...LEGACY_STORAGE_PREFIXES, LS.brandMigrated, LS.brandStores,
];
