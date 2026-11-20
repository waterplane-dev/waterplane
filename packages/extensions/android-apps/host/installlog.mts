/**
 * **Which version of what is on which phone** — the desktop's copy of what the devices installed
 * (the android-apps extension's store; core's `host/installlog.ts` keeps its copy until
 * docs/notes/android-apps-architecture.md P5).
 *
 * The store is deliberately dumb:
 *
 *  - **It records, it never decides.** Nothing here installs anything, refuses anything, or tells a
 *    phone what to do (`CLAUDE.md`: nothing applies itself).
 *  - **A report is a re-statement.** Phones re-send their whole history on every connect, because the
 *    install worth having in the log is usually the one that happened at 3 a.m. with the tunnel down.
 *    The merge is keyed and idempotent (`mergeInstallLog`), so reconnecting a hundred times adds
 *    nothing.
 *  - **The host stamps only its own clock.** `at` belongs to the phone; an older shell that cannot
 *    say leaves it absent rather than getting the report time substituted for it.
 *
 * **The file is NOT moved**: `<api.stateDir>/installs.json`, the same `{entries}` shape core's store
 * reads and writes, no migration. This store is its ONE writer ({@link WRITE}); core's old store stopped
 * saving in the same commit that flipped the constant, so there was never a window with two writers or
 * an unpersisted report. `write: false` (tests) opens it read-only: it re-reads the file when it
 * changed on disk, and a `report` is neither merged nor persisted.
 */
import * as fs from "node:fs";
import { statSync } from "node:fs";
import { readStore, writeStore, type StoreFs } from "@waterplane/shared";
import {
  cleanInstallEntry, entryAt, INSTALL_LOG_CAP, installDevices, MAX_REPORT_ENTRIES, mergeInstallLog,
  trimLogDoc, type InstallLogDoc, type InstallLogEntry, type InstallReporter,
} from "../shared/wire.mjs";

/** Whether this store may write `installs.json`. `true`: it is the sole writer (core stopped). */
export const WRITE = true;

const SAVE_DEBOUNCE_MS = 500;

/** `fs` is a test seam (an injected EMFILE); default `node:fs`. */
export interface InstallLogOpts { write?: boolean; fs?: StoreFs }

export class InstallLogStore {
  private entries: InstallLogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seen = "";
  /** The file exists and was not read: never saved over until a read says otherwise. */
  private unreadable = false;
  /** Why it was not read (for the reply), and whether that was already said in the log. */
  private why = "";
  private warned = false;
  /** Where an unparsable file went; kept for the reply after the re-read finds the path absent. */
  private aside = "";
  private readonly fs: StoreFs;
  private readonly write: boolean;
  /** Whether a `report` is merged and saved (false while read-only: the chunk is thrown away). */
  get writes(): boolean { return this.write; }

  constructor(private readonly path: string, opts: InstallLogOpts = {}) {
    this.write = opts.write ?? WRITE;
    this.fs = opts.fs ?? fs;
    this.load();
  }

  private sig(): string {
    try { const st = statSync(this.path); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return ""; }
  }

  /** The `{entries}` file → cleaned rows. A bare array (the oldest shape) is read too. */
  private load(): void {
    this.seen = this.sig();
    this.entries = [];
    // Absent is the only empty start. A file that could not be READ (EMFILE, EACCES) is left as it
    // is and never saved over; a corrupt one was moved aside by readStore (shared/storefile.ts).
    const read = readStore(this.fs, this.path);
    this.unreadable = read.kind === "unreadable";
    this.why = read.kind === "unreadable" ? (read.corrupt ? "it did not parse" : String(read.error)) : "";
    if (read.kind !== "unreadable") this.warned = false;
    if (read.kind === "unreadable" && read.corrupt && read.movedTo) this.aside = read.movedTo;
    // Once per outage, not once per call, but a file moved aside is a new event with its own line.
    if (read.kind === "unreadable" && (!this.warned || (read.corrupt && read.movedTo))) {
      this.warned = true;
      console.warn(`[android-apps] install log ${this.path} was not read (${read.error}); ${read.process ? "will retry" : read.corrupt ? `moved aside to ${read.movedTo ?? "(not moved)"}` : "left as it is"}`);
    }
    if (read.kind !== "ok") return;
    try {
      const parsed = read.value;
      const rows = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === "object" ? (parsed as { entries?: unknown }).entries : null);
      if (!Array.isArray(rows)) return;
      // Re-cleaned on the way IN as well as on the way out. The file is plain JSON on a desktop
      // somebody may hand-edit, and a row that cannot say what was installed is a gap pretending to be
      // a log line wherever it is read.
      for (const row of rows) {
        const r = row as Record<string, unknown> | null;
        if (!r) continue;
        // **A row with no usable `reportedAt` is dropped, not stamped with now.** That field is this
        // host's own record of when it was told, and substituting the boot instant would sort a
        // hand-edited row to the top of the log and then persist the invention.
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
    } catch { /* a row that will not clean → start empty rather than throw */ }
  }

  /** Read-only mode follows the file: core is still writing it, so a copy loaded once would go stale. */
  private refresh(): void {
    if (!this.write && this.sig() !== this.seen) this.load();
    // A file that was there and not read (a transient EMFILE) is read again, so the screen never
    // shows an empty log for the daemon's life while the file is fine.
    else if (this.write && this.unreadable && this.recover()) this.schedule();
  }

  /**
   * Read the file again after an unreadable start and fold what this run holds into it. Answers
   * whether this run holds something the file does not (so a save is due). Still unreadable ⇒ the
   * held rows are kept and nothing is written.
   */
  private recover(): boolean {
    const mine = this.entries;
    this.load();
    if (this.unreadable) { this.entries = mine; return false; }
    const m = mergeInstallLog(this.entries, mine, INSTALL_LOG_CAP);
    this.entries = m.entries;
    return m.added > 0 || m.updated > 0;
  }

  /** How many entries are held. */
  count(): number { this.refresh(); return this.entries.length; }

  /**
   * Everything, for `log` — trimmed oldest-first to stay under the reply cap. The devices are DERIVED
   * on every read (`installDevices`) rather than kept beside the entries: a device list that can
   * disagree with the log is one nobody can trust. `total` is what the host holds.
   */
  doc(): InstallLogDoc { this.refresh(); return this.say(trimLogDoc(this.entries, this.entries.length)); }

  /** Whether `report` can save: writing is on and the file is not sitting unread. */
  get saves(): boolean { return this.write && !this.unreadable; }

  private say(d: InstallLogDoc): InstallLogDoc {
    if (this.unreadable) return { ...d, unreadable: this.why };
    return this.aside ? { ...d, movedAside: this.aside } : d;
  }

  /** The untrimmed doc (tests, and anything that must see the whole ring). */
  fullDoc(): InstallLogDoc {
    this.refresh();
    return this.say({ entries: this.entries, devices: installDevices(this.entries), total: this.entries.length });
  }

  /**
   * Fold one chunk of one phone's report in. Answers what CHANGED, so the caller can stay quiet when a
   * reconnect re-states a history the host already holds — the common case. Read-only: nothing is
   * merged or kept, and the answer is `{0, 0}`.
   */
  report(reporter: InstallReporter, rows: readonly unknown[]): { added: number; updated: number } {
    if (!this.write) return { added: 0, updated: 0 };
    const now = Date.now();
    if (this.unreadable && this.recover()) this.schedule();
    const incoming: InstallLogEntry[] = [];
    for (const row of rows) {
      const clean = cleanInstallEntry(row, reporter, now);
      if (clean) incoming.push(clean);
    }
    // Truncation keeps the NEWEST, not whichever the sender happened to list first.
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

  /** Synchronous: `deactivate` and `shutdown` call it and nobody awaits them. */
  flush(): void {
    // A run that holds rows while the file is still unreadable tries once more at shutdown.
    const held = this.write && this.unreadable && this.entries.length > 0;
    if (this.timer || held) { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.persist(); }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.(); // never hold the daemon open for a log file
  }

  /**
   * Core's persistence rule through the shared store helper (`@waterplane/shared` storefile): atomic
   * write, and a file that could not be read is never written over.
   */
  private persist(): void {
    if (!this.write) return;
    try {
      // The file was there and could not be read at load: look again and fold what this run
      // gathered into it. Still unreadable ⇒ nothing is written, the file stays.
      if (this.unreadable) { this.recover(); if (this.unreadable) return; }
      writeStore(this.fs, this.path, { entries: this.entries }, { space: 2 });
    } catch { /* a log that cannot be written must not take the daemon down */ }
  }
}
