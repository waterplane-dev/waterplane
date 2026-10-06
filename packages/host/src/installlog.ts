/**
 * **Which version of what is on which phone** — the desktop's copy of what the
 * devices installed.
 *
 * This exists because of an asymmetry the rest of the download path does not
 * have: **there is one host and there may be many clients.** A build is
 * produced here, fetched by every phone whose allow-list names its package, and
 * installed on each of them by `ShellPullService` with the app closed. Every
 * account of that install is on the phone that did it — so "is the new Tiptoi on
 * both phones, and when did the second one get it?" is a question no device can
 * answer and this desktop can.
 *
 * The store is deliberately dumb, in `settings.ts`'s posture:
 *
 *  - **It records, it never decides.** Nothing here installs anything, refuses
 *    anything, or tells a phone what to do. It is an account of what already
 *    happened (`CLAUDE.md`: nothing applies itself).
 *  - **A report is a re-statement.** Phones re-send their whole history on every
 *    connect, because the install worth having in the log is usually the one
 *    that happened at 3 a.m. with the tunnel down. The merge is keyed and
 *    idempotent (`@waterplane/shared`'s `mergeInstallLog`), so reconnecting a hundred
 *    times adds nothing — and it is the shared module rather than a local copy
 *    precisely because losing or duplicating a history is invisible until
 *    somebody goes looking for a date.
 *  - **The host stamps only its own clock.** `at` — when the install actually
 *    finished — belongs to the phone, and an older shell that cannot say leaves
 *    it absent rather than getting the report time substituted for it.
 *
 * Persisted to `<STATE_DIR>/installs.json`, tmp+rename, debounced, flushed on
 * shutdown: the same arrangement as `settings.ts` and `sentlog.ts`, and for the
 * same reason — `npm run restart` is routine here, and a log that a restart
 * wipes is not a log.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { 
  cleanInstallEntry, entryAt, INSTALL_LOG_CAP, installDevices, MAX_REPORT_ENTRIES, mergeInstallLog,
  type InstallLogDoc, type InstallLogEntry, type InstallReporter } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

const SAVE_DEBOUNCE_MS = 500;

export class InstallLogStore {
  private path: string;
  private entries: InstallLogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(root: string) {
    this.path = join(hostStateDir(root), "installs.json");
    try {
      if (existsSync(this.path)) {
        const parsed = readJsonGuarded<any>(this.path, null) as unknown;
        const rows = Array.isArray(parsed)
          ? parsed
          : (parsed && typeof parsed === "object" ? (parsed as { entries?: unknown }).entries : null);
        if (Array.isArray(rows)) {
          // Re-cleaned on the way IN as well as on the way out. The file is
          // plain JSON on a desktop somebody may hand-edit, and a row that
          // cannot say what was installed is a gap pretending to be a log line
          // wherever it is read.
          for (const row of rows) {
            const r = row as Record<string, unknown> | null;
            if (!r) continue;
            // **A row with no usable `reportedAt` is dropped, not stamped with
            // now.** That field is this host's own record of when it was told,
            // and substituting the boot instant would sort a hand-edited row to
            // the top of the log and then persist the invention — the same
            // wrong-number-for-an-absent-one this module refuses for `at`.
            const told = r.reportedAt;
            if (typeof told !== "number" || !Number.isFinite(told) || told <= 0) continue;
            const clean = cleanInstallEntry(
              r,
              { id: String(r.deviceId ?? ""), name: r.deviceName as string | undefined, model: r.deviceModel as string | undefined },
              Math.floor(told),
            );
            if (clean) this.entries.push(clean);
          }
          this.entries = mergeInstallLog([], this.entries).entries;
        }
      }
    } catch { /* corrupt or unreadable → start empty rather than throw */ }
  }

  /** Everything, for `install.log`. The devices are DERIVED on every read
   *  (`installDevices`) rather than kept beside the entries: a device list that
   *  can disagree with the log is one nobody can trust. */
  doc(): InstallLogDoc {
    return { entries: this.entries, devices: installDevices(this.entries), total: this.entries.length };
  }

  /**
   * Fold one phone's report in.
   *
   * Answers what CHANGED, so the route can stay quiet when a reconnect
   * re-states a history the host already holds — which is the common case and
   * would otherwise broadcast the whole log to every socket on every handshake.
   */
  report(reporter: InstallReporter, rows: readonly unknown[]): { added: number; updated: number } {
    const now = Date.now();
    const incoming: InstallLogEntry[] = [];
    for (const row of rows) {
      const clean = cleanInstallEntry(row, reporter, now);
      if (clean) incoming.push(clean);
    }
    // Truncation keeps the NEWEST, not whichever the sender happened to list
    // first. A phone holding more terminal rows than one report may carry would
    // otherwise lose the same entries on every report for ever — and which ones
    // would depend on the order of a list this module has never seen.
    if (incoming.length > MAX_REPORT_ENTRIES) {
      incoming.sort((a, b) => entryAt(b) - entryAt(a));
      incoming.length = MAX_REPORT_ENTRIES;
    }
    if (!incoming.length) return { added: 0, updated: 0 };
    const merged = mergeInstallLog(this.entries, incoming, INSTALL_LOG_CAP);
    this.entries = merged.entries;
    if (merged.added || merged.updated) this.schedule();
    return { added: merged.added, updated: merged.updated };
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.persist();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.(); // never hold the daemon open for a log file
  }

  private persist(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeJsonAtomic(this.path, { entries: this.entries }, { space: 2 });
    } catch { /* a log that cannot be written must not take the daemon down */ }
  }
}
