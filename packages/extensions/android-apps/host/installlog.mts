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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  cleanInstallEntry, entryAt, INSTALL_LOG_CAP, installDevices, MAX_REPORT_ENTRIES, mergeInstallLog,
  trimLogDoc, type InstallLogDoc, type InstallLogEntry, type InstallReporter,
} from "../shared/wire.mjs";

/** Whether this store may write `installs.json`. `true`: it is the sole writer (core stopped). */
export const WRITE = true;

const SAVE_DEBOUNCE_MS = 500;

export interface InstallLogOpts { write?: boolean }

export class InstallLogStore {
  private entries: InstallLogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seen = "";
  private readonly write: boolean;
  /** Whether a `report` is merged and saved (false while read-only: the chunk is thrown away). */
  get writes(): boolean { return this.write; }

  constructor(private readonly path: string, opts: InstallLogOpts = {}) {
    this.write = opts.write ?? WRITE;
    this.load();
  }

  private sig(): string {
    try { const st = statSync(this.path); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return ""; }
  }

  /** The `{entries}` file → cleaned rows. A bare array (the oldest shape) is read too. */
  private load(): void {
    this.seen = this.sig();
    this.entries = [];
    try {
      if (!existsSync(this.path)) return;
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
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
    } catch { /* corrupt or unreadable → start empty rather than throw */ }
  }

  /** Read-only mode follows the file: core is still writing it, so a copy loaded once would go stale. */
  private refresh(): void {
    if (!this.write && this.sig() !== this.seen) this.load();
  }

  /** How many entries are held. */
  count(): number { this.refresh(); return this.entries.length; }

  /**
   * Everything, for `log` — trimmed oldest-first to stay under the reply cap. The devices are DERIVED
   * on every read (`installDevices`) rather than kept beside the entries: a device list that can
   * disagree with the log is one nobody can trust. `total` is what the host holds.
   */
  doc(): InstallLogDoc { this.refresh(); return trimLogDoc(this.entries, this.entries.length); }

  /** The untrimmed doc (tests, and anything that must see the whole ring). */
  fullDoc(): InstallLogDoc {
    this.refresh();
    return { entries: this.entries, devices: installDevices(this.entries), total: this.entries.length };
  }

  /**
   * Fold one chunk of one phone's report in. Answers what CHANGED, so the caller can stay quiet when a
   * reconnect re-states a history the host already holds — the common case. Read-only: nothing is
   * merged or kept, and the answer is `{0, 0}`.
   */
  report(reporter: InstallReporter, rows: readonly unknown[]): { added: number; updated: number } {
    if (!this.write) return { added: 0, updated: 0 };
    const now = Date.now();
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
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.persist(); }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.(); // never hold the daemon open for a log file
  }

  /**
   * As core's `writeJsonAtomic` (host/src/jsonstore.ts, not importable from an extension): a HIDDEN
   * tmp name opened exclusively (`wx`), fsync, rename, and the tmp deleted if anything fails. A
   * corrupt file is moved aside, never overwritten.
   */
  private persist(): void {
    if (!this.write) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (existsSync(this.path)) {
        try { JSON.parse(readFileSync(this.path, "utf8")); }
        catch { try { renameSync(this.path, `${this.path}.corrupt-${Date.now()}`); } catch { /* keep going */ } }
      }
      const tmp = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${Date.now().toString(36)}.tmp`);
      let fd: number | null = null;
      try {
        fd = openSync(tmp, "wx", 0o666);
        writeFileSync(fd, JSON.stringify({ entries: this.entries }, null, 2));
        try { fsyncSync(fd); } catch { /* a filesystem that cannot fsync still gets the rename */ }
        closeSync(fd);
        fd = null;
        renameSync(tmp, this.path);
      } catch (e) {
        if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
        try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
        throw e;
      }
    } catch { /* a log that cannot be written must not take the daemon down */ }
  }
}
