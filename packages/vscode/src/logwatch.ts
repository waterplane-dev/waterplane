/**
 * Notices that a Claude Code log moved. A file watcher on the project dir (it lives outside the
 * workspace, hence RelativePattern) plus a stat poll of the active log and the listed recent ones
 * as the backstop for writes the watcher misses. Both feed one 300 ms debounce.
 */
import * as fs from "node:fs";
import * as vscode from "vscode";

export interface WatchHandlers { sessionMoved(): void; projectChanged(): void }

export class LogWatch implements vscode.Disposable {
  private fsw: vscode.FileSystemWatcher | null = null;
  private subs: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private activeLog: string | null = null;
  private recent: string[] = [];
  /** Each watched log's last stat as the POLL saw it (new logs: as of when they joined the set). */
  private seen = new Map<string, string>();
  private pollMs: number;
  private pending: { session: boolean; project: boolean } = { session: false, project: false };

  constructor(private h: WatchHandlers, pollSeconds: number) {
    this.pollMs = Math.max(2, pollSeconds) * 1000;
  }

  setProjectDir(dir: string | null): void {
    this.dropWatcher();
    if (!dir) return;
    this.fsw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), "**/*.jsonl"));
    const hit = (u: vscode.Uri): void => this.hit(u.fsPath === this.activeLog);
    this.subs = [this.fsw.onDidChange(hit), this.fsw.onDidCreate(hit), this.fsw.onDidDelete(hit)];
  }

  setActiveLog(path: string | null): void {
    this.activeLog = path;
    this.sync();
  }

  /** The other listed logs, polled beside the active one. */
  setRecent(paths: string[]): void {
    this.recent = paths;
    this.sync();
  }

  setPollSeconds(s: number): void {
    this.pollMs = Math.max(2, s) * 1000;
    this.restartPoll();
  }

  private paths(): string[] {
    return [...new Set([this.activeLog, ...this.recent].filter((p): p is string => !!p))];
  }

  private statOf(p: string): string {
    try {
      const st = fs.statSync(p);
      return `${st.size}:${st.mtimeMs}`;
    } catch { return "gone"; }
  }

  /**
   * A refresh re-announces the set of logs on every pass; that must neither restart the interval
   * (refreshes faster than `pollMs` would then starve it for ever) nor re-baseline a log we already
   * know (a write between the refresh's read and this call would be folded in and never seen).
   * Only logs new to the set get a baseline now; the poll alone advances the others.
   */
  private sync(): void {
    const now = this.paths();
    for (const p of [...this.seen.keys()]) if (!now.includes(p)) this.seen.delete(p);
    for (const p of now) if (!this.seen.has(p)) this.seen.set(p, this.statOf(p));
    if (!now.length) { this.stopPoll(); return; }
    if (!this.timer) this.restartPoll();
  }

  private stopPoll(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private restartPoll(): void {
    this.stopPoll();
    if (!this.seen.size) return;
    this.timer = setInterval(() => {
      let moved = false;
      for (const [p, was] of this.seen) {
        const cur = this.statOf(p);
        if (cur !== was) { this.seen.set(p, cur); moved = true; }
      }
      if (moved) this.hit(true);
    }, this.pollMs);
  }

  private hit(session: boolean): void {
    if (session) this.pending.session = true; else this.pending.project = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      const p = this.pending;
      this.pending = { session: false, project: false };
      this.debounce = null;
      if (p.project) this.h.projectChanged();
      if (p.session) this.h.sessionMoved();
    }, 300);
  }

  private dropWatcher(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.fsw?.dispose();
    this.fsw = null;
  }

  dispose(): void {
    this.dropWatcher();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = null;
  }
}
