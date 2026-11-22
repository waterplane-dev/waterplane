/**
 * The all-sessions corpus: the saved fold (`corpus.v1.json`) shown while a fresh scan runs, the
 * scan itself in a `worker_threads` Worker off the extension host's thread (`scanworker.ts`), and
 * its progress. Owns no UI: what the panel, the status bar and the open folder's readings do with
 * a change is `Ext`'s, through the hooks.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { buildText } from "./buildstamp.js";
import { loadCorpus, saveCorpus, summaryOf } from "./data/index.js";
import type { HeadlineSummary } from "./data/index.js";
import type { ScanJob, ScanMsg } from "./scanworker.js";
import type { CorpusDoc, ToWebview } from "./protocol.js";
import { userDirOf } from "../../extensions/copilot-usage/host/vscodelocal.mts";

export type Scanning = { done: number; total: number };

export interface CorpusHooks {
  configDir(): string;
  disposed(): boolean;
  post(m: ToWebview): void;
  /** The status bar's scan progress; null when no scan runs. */
  setScan(s: Scanning | null): void;
  /** A finished scan's seven days, to keep and show. */
  summary(s: HeadlineSummary): void;
  /** The open folder's repo-health reading, which folds the spend off the corpus. */
  refreshHealth(): void;
  /** The open folder's Setup check, whose log rules run over the corpus. */
  refreshFindings(): void;
}

export const sentence = (e: unknown): string => {
  const m = (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");
  return `Could not read the logs: ${m}.`;
};

export class CorpusScan {
  corpus: { doc: CorpusDoc | null; why?: string } = { doc: null };
  scanning: Scanning | null = null;
  /** When the last scan finished (ms); 0 = none this window. */
  lastScanAt = 0;
  /** The running scan's promise, so an explicit rescan asked during one still has something to show progress for. */
  private scanP: Promise<void> | null = null;
  /** The running scan's worker; terminated when the panel closes or the config dir changes. */
  private worker: Worker | null = null;
  /** The saved fold is read once per config dir, when the panel first needs it — never on activation. */
  private loaded = false;
  private loadP: Promise<void> | null = null;

  /** `storageDir`: the extension's global storage; `extensionDir`: where `dist/scanworker.js` is. */
  constructor(private storageDir: string, private extensionDir: string, private hooks: CorpusHooks) {}

  private corpusFile(): string { return path.join(this.storageDir, "corpus.v1.json"); }

  /** The config dir moved: everything read so far belongs to the old one. */
  reset(): void {
    this.cancel();
    this.lastScanAt = 0;
    this.corpus = { doc: null };
    this.loaded = false;
    this.loadP = null;
  }

  /** Stop a running scan: its worker is terminated and its result, if one still arrives, dropped. */
  cancel(): void {
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate();
    if (this.scanning) {
      this.scanning = null;
      this.hooks.setScan(null);
    }
  }

  /**
   * Show the last finished fold while the scan that replaces it runs. Async and off the activation
   * path (called when the panel is shown or says `ready`); a scan that finished first wins.
   */
  loadCached(): Promise<void> {
    if (this.hooks.disposed()) return Promise.resolve();
    if (this.loaded) return this.loadP ?? Promise.resolve();
    this.loaded = true;
    return this.loadP = this.readCached();
  }

  private async readCached(): Promise<void> {
    const dir = this.hooks.configDir();
    const doc = await loadCorpus(this.corpusFile(), dir, buildText);
    if (!doc || this.hooks.disposed() || this.corpus.doc || dir !== this.hooks.configDir()) return;
    this.corpus = this.corpus.why ? { doc, why: this.corpus.why } : { doc };
    this.hooks.post({ t: "corpus", ...this.corpus, ...(this.scanning ? { scanning: this.scanning } : {}) });
    this.hooks.refreshHealth();
    this.hooks.refreshFindings();
  }

  scan(): Promise<void> {
    if (this.scanning) return this.scanP ?? Promise.resolve();
    const p = this.run().finally(() => { if (this.scanP === p) this.scanP = null; });
    this.scanP = p;
    return p;
  }

  private run(): Promise<void> {
    const h = this.hooks;
    this.scanning = { done: 0, total: 0 };
    h.setScan(this.scanning);
    h.post({ t: "corpus", ...this.corpus, scanning: this.scanning });
    // A first scan has no corpus to count over: say "reading the logs" now, not a count that scan will change.
    if (!this.corpus.doc) h.refreshFindings();
    const dir = this.storageDir;
    const job: ScanJob = {
      configDir: h.configDir(), cacheFile: path.join(dir, "tokenstore.v5.json"),
      copilot: { userDir: userDirOf(dir), cacheFile: path.join(dir, "copilotchat.v1.json") },
    };
    return new Promise<void>((resolve) => {
      let w: Worker;
      const finish = (next: { doc: CorpusDoc | null; why?: string }): void => {
        if (this.worker !== w) { resolve(); return; } // cancelled: the panel closed, or the config dir moved
        this.worker = null;
        void w.terminate();
        this.corpus = next;
        this.loaded = true;
        this.lastScanAt = Date.now();
        if (next.doc && !next.why) void saveCorpus(this.corpusFile(), job.configDir, next.doc, buildText);
        if (next.doc && !next.why) h.summary(summaryOf(next.doc, job.configDir));
        this.scanning = null;
        h.setScan(null);
        if (!h.disposed()) h.post({ t: "corpus", ...this.corpus });
        // The score's spend line is folded off this scan: the open folder's reading gains it now.
        h.refreshHealth();
        h.refreshFindings();
        resolve();
      };
      fs.mkdir(dir, { recursive: true }).then(() => {
        if (!this.scanning || h.disposed()) { resolve(); return; }
        w = new Worker(path.join(this.extensionDir, "dist", "scanworker.js"), { workerData: job });
        this.worker = w;
        w.on("message", (m: ScanMsg) => {
          if (this.worker !== w) return;
          if (m.t === "progress") {
            this.scanning = { done: m.done, total: m.total };
            h.setScan(this.scanning);
            h.post({ t: "corpus", ...this.corpus, scanning: this.scanning });
          } else if (m.t === "done") finish({ doc: m.doc });
          else finish({ doc: this.corpus.doc, why: sentence(m.message) });
        });
        w.on("error", (e) => finish({ doc: this.corpus.doc, why: sentence(e) }));
        // An exit before "done" (a crash, an out-of-memory) keeps the last figures and says so.
        w.on("exit", () => finish({ doc: this.corpus.doc, why: "The log scan stopped before it finished; the figures shown are from the last complete one." }));
      }, (e: unknown) => {
        this.scanning = null;
        h.setScan(null);
        this.corpus = { doc: this.corpus.doc, why: sentence(e) };
        if (!h.disposed()) h.post({ t: "corpus", ...this.corpus });
        // The score's spend line is folded off this scan: the open folder's reading gains it now.
        h.refreshHealth();
        resolve();
      });
    });
  }
}
