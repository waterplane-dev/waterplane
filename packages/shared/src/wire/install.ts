/**
 * **What got installed on which phone** — the DTOs for the install log.
 *
 * One host, many clients. The installs themselves happen on the phones: a
 * package on that phone's allow-list is installed by `ShellPullService` with the
 * app closed and the document frozen, so the only account of it is a row in the
 * phone's own download queue. Which is fine until there are two phones, and the
 * question becomes *which version of what is on which device* — a question no
 * single phone can answer, because it cannot see the other one.
 *
 * So the phones REPORT and the desktop KEEPS. The host is the only thing that
 * outlives a reinstall of the app, sees every device, and is already where the
 * builds came from.
 *
 * Two rules the shapes here exist to enforce:
 *
 *  - **The phone says what happened; the host says when it was told.** `at` is
 *    the instant the install actually finished, which only the shell knows and
 *    an older shell does not know at all — absent, never the report time
 *    wearing an install's clothes. `reportedAt` is the host's own stamp and is
 *    always there. A reader that needs "when" and has no `at` says *reported*,
 *    which is a different and true sentence.
 *  - **A report is a re-statement, not an event.** A phone re-sends everything
 *    it still holds on every connect — that is what makes an install that
 *    happened at 3 a.m. with the tunnel down eventually land — so every entry
 *    carries a key the phone can reproduce, and the host merges on it. Nothing
 *    is appended twice because the link flapped.
 */

/** How an install ended. Only terminal outcomes are logged: `asked` is the
 *  system installer waiting for a person and is not a thing that happened. */
export type InstallOutcome = "installed" | "failed";

/** One install, as a PHONE reports it. The host adds identity and its own
 *  clock; nothing here is trusted for either. */
export interface InstallReportEntry {
  /** The download row it came from. With the device id and `at`, this is what
   *  makes a repeated report the same entry rather than a second one. */
  pullId: string;
  pkg: string;
  /** The app's own label, where the package manager could read it. */
  label?: string;
  version?: string;
  /** Build number (`versionCode`) — the only monotonic thing an APK carries. */
  code?: number;
  /** The file it arrived as, and the repo that produced it. Both are how a
   *  person recognises a build that a package name does not identify. */
  file?: string;
  repo?: string;
  outcome: InstallOutcome;
  /** The installer's own words, where it failed. */
  error?: string;
  /**
   * Did it install itself (the package was on this phone's allow-list), or did
   * somebody tap? A log that cannot tell those apart cannot answer "why is this
   * version on my phone".
   *
   * **Absent means nobody recorded it** — a row written by a shell older than
   * the field, which is an ordinary state here because the UI updates over the
   * air while the binary does not. It is optional for exactly the reason `at`
   * is: `false` is not the absence of a claim, it is the positive claim *a
   * person tapped this*, and printing that about an install that ran by itself
   * overnight is a lie the log would tell every time.
   */
  auto?: boolean;
  /** When the install finished, by the phone's clock. Absent where the shell
   *  is older than this field — never substituted. */
  at?: number;
}

/** One install, as the host keeps it. */
export interface InstallLogEntry extends InstallReportEntry {
  /** `<deviceId>:<pullId>:<at or 0>`. Stable across re-reports, and distinct
   *  per install: re-installing the same build makes a second entry, because
   *  it is a second thing that happened. */
  key: string;
  deviceId: string;
  /** What that phone is called, as it called itself at report time. */
  deviceName?: string;
  /** Model read off the user agent, where it was legible. */
  deviceModel?: string;
  /** When the host was told. Always present. */
  reportedAt: number;
}

/** One device that has ever reported. Derived from the entries, never stored
 *  apart from them — a device list that can disagree with the log is a device
 *  list nobody can trust. */
export interface InstallDevice {
  id: string;
  name?: string;
  model?: string;
  /** The newest install this device has reported (its `at`, else `reportedAt`). */
  lastAt: number;
  installs: number;
  failures: number;
}

/** The whole log, as the host sends it. */
export interface InstallLogDoc {
  /** Newest first, capped. */
  entries: InstallLogEntry[];
  devices: InstallDevice[];
  /** How many entries the host holds — the same as `entries.length` today, and
   *  a separate field so a future page of the log cannot silently claim to be
   *  the whole of it. */
  total: number;
}

/** How this device identifies itself when it reports. */
export interface InstallReporter {
  id: string;
  name?: string;
  model?: string;
}
