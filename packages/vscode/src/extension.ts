/**
 * waterplane for Claude Code: reads the claude CLI's own logs on this machine and shows what each
 * prompt cost. No telemetry; the one network call is Copilot's quota, off until turned on (`copilotquota.ts`). The corpus scan runs only when the panel opens (unless the
 * last one is under 10 minutes old), on the rescan command, and every 10 minutes while the panel is
 * visible — never on activation — and always in a worker thread (`scanworker.ts`), never on the
 * extension host's own.
 *
 * Repo health is read only when the Health view or the tree comes on screen, and measured only on a tap (or
 * the healthRefresh command), in a worker thread (`healthworker.mjs`); nothing health-related runs
 * on activation.
 *
 * Activation reads only the active folder's newest session (`readSession`): the host's cursor reads
 * synchronously, in bounded 24 MB chunks, so its cost is that one log's size, once; every later poll
 * reads only what was appended. The week's headline at startup is the small `HeadlineSummary` the
 * last finished scan left in `globalState` (zero IO), printed with its age.
 */
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { BRAND, fmtUsd, healthSpendWeeks } from "@waterplane/shared";
import { repoOfWorktree } from "../../host/src/costwindow.js";
import {
  anyLive, claudeConfigDir, listSessions, projectDirFor, RECENT_MS, recentRows, SessionLedger, summaryOf, thisRepoWeek, weighFolder, WINDOW_MS,
} from "./data/index.js";
import type { HeadlineSummary } from "./data/index.js";
import { DEFAULT_HEALTH_SECONDS, HealthRun } from "./health/healthrun.js";
import { InstructionLens } from "./codelens.js";
import { Panel } from "./panel.js";
import { NavTree, PICK, PICK_FOLDER, QUOTA, SHOW } from "./navtree.js";
import { CopilotQuota } from "./copilotquota.js";
import { CopilotLocalReader, userDirOf } from "../../extensions/copilot-usage/host/vscodelocal.mts";
import type { NavState } from "./navtree.js";
import { deliver, PROMPTS, render } from "./prompts.js";
import type { ScanJob, ScanMsg } from "./scanworker.js";
import type { CopilotSwitches } from "./protocol.js";
import type { CorpusDoc, HealthDoc, PromptId, TabId, SessionDoc, SessionRow, SessionSummary, ToExtension, ToWebview, WeightDoc } from "./protocol.js";
import { RestartWatch } from "./restartwatch.js";
import { StatusBar } from "./statusbar.js";
import { LogWatch } from "./logwatch.js";

type Origin = "panel";

interface RowsState { folder: string | null; rows: SessionSummary[]; selected: string | null; older: number; capped: number; automated: number }
const blankRows = (folder: string | null): RowsState => ({ folder, rows: [], selected: null, older: 0, capped: 0, automated: 0 });

const RESCAN_MS = 10 * 60_000;
/** The globalState key of the last finished scan's `HeadlineSummary`. */
const SUMMARY_KEY = `${BRAND.slug}.headline`;

/** The ledger's repo keys for a folder: as given and realpath-resolved, exactly (no prefix matching). */
function repoKeysOf(folder: string): string[] {
  let real = folder;
  try { real = realpathSync(folder); } catch { /* the path as given */ }
  return [...new Set([folder, real].map(repoOfWorktree))];
}
const OPEN_HOSTS = new Set([BRAND.domain, "marketplace.visualstudio.com", "open-vsx.org"]);

const sentence = (e: unknown): string => {
  const m = (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");
  return `Could not read the logs: ${m}.`;
};

/** Only https links to our own site or the marketplaces; anything else is dropped. */
export function allowedUrl(raw: string): vscode.Uri | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || !OPEN_HOSTS.has(u.hostname)) return null;
    return vscode.Uri.parse(u.toString());
  } catch { return null; }
}

const TABS: readonly TabId[] = ["session", "all", "always-on", "health", "prompts"];
const isTab = (v: unknown): v is TabId => typeof v === "string" && (TABS as readonly string[]).includes(v);

class Ext implements vscode.Disposable {
  private statusBar = new StatusBar(`${BRAND.slug}.open`);
  private panel: Panel;
  private tree: NavTree;
  private quota: CopilotQuota;
  private health: HealthRun;
  /** A tab the panel should show once it says `ready` (rides the ready round-trip). */
  private wantTab: TabId | null = null;
  /**
   * The panel said `ready` with no view of its own before the active folder's rows were read:
   * its default (Session while one is live, else All sessions) is chosen once they are, by
   * `resolveDefault`, rather than guessed from an empty list. An explicit `showTab` cancels it.
   */
  private defaultPending = false;
  private watch: LogWatch;
  private rescanTimer: NodeJS.Timeout | null = null;
  private activeFolder: string | null = null;
  private pinned = new Map<string, string>();
  private ledger = new SessionLedger();
  private sessions: SessionRow[] = [];
  /**
   * The listed sessions' rows, newest write first, with the folder they were read for (a message
   * is only ever posted under the folder it belongs to) and what was left out: `older` = outside
   * the window, `capped` = recent ones past the row cap, `automated` = unattended `claude -p` runs.
   */
  private rows: RowsState = blankRows(null);
  private session: { folder: string | null; doc: SessionDoc | null; why?: string } = { folder: null, doc: null };
  private weight: { doc: WeightDoc | null; why?: string } = { doc: null };
  private lens!: InstructionLens;
  private corpus: { doc: CorpusDoc | null; why?: string } = { doc: null };
  private scanning: { done: number; total: number } | null = null;
  /** The running scan's worker; terminated when the panel closes or the config dir changes. */
  private worker: Worker | null = null;
  /** When the last scan finished (ms); 0 = none this window. */
  private lastScanAt = 0;
  /** The last finished scan's seven days, from any window; null before one, or for another config dir. */
  private summary: HeadlineSummary | null = null;
  /** `repoKeysOf` for the active folder, kept: the tree asks on every row it draws. */
  private keys: { folder: string; keys: string[] } | null = null;
  /** Fires when the newest listed session stops counting as live, so the status bar and tree follow. */
  private liveTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private again = false;
  private disposed = false;

  constructor(private ctx: vscode.ExtensionContext) {
    const cfg = vscode.workspace.getConfiguration(BRAND.slug);
    this.panel = new Panel(ctx.extensionUri, (m) => void this.onMessage(m, "panel"), (v) => this.onVisible(v), () => this.cancelScan());
    // The tree on screen reads the cheap state and the cached health reading — never a corpus scan.
    // Before the tree, which reads its state; off until the person turns it on (its one network call).
    this.quota = new CopilotQuota(ctx.globalState, new CopilotLocalReader(userDirOf(ctx.globalStorageUri.fsPath)), () => this.tree?.refresh());
    this.tree = new NavTree(() => this.navState(), (v) => {
      if (!v) return;
      void this.refreshSession();
      if (this.activeFolder) void this.health.read(this.activeFolder);
    }, ctx.workspaceState);
    this.health = new HealthRun({
      workerFile: path.join(ctx.extensionUri.fsPath, "dist", "healthworker.mjs"),
      storageDir: path.join(ctx.globalStorageUri.fsPath, "health"),
      stepMs: () => Math.max(10, vscode.workspace.getConfiguration(BRAND.slug).get<number>("healthSeconds", DEFAULT_HEALTH_SECONDS)) * 1000,
      extraPath: () => this.gitDir(),
      onChange: (folder) => this.postHealth(folder),
    });
    this.watch = new LogWatch(
      { sessionMoved: () => void this.refreshSession(), projectChanged: () => void this.refreshSession() },
      cfg.get<number>("pollSeconds", 5),
    );
    this.statusBar.setEnabled(cfg.get<boolean>("statusBar", true));
    const kept = ctx.globalState.get<HeadlineSummary>(SUMMARY_KEY);
    this.summary = kept?.v === 1 && kept.configDir === this.configDir() ? kept : null;
    this.lens = new InstructionLens({
      active: (folder) => (this.weight.doc?.folder === folder ? this.weight.doc : null),
      switches: copilotSwitches,
      saved: (folder) => this.reweigh(folder),
      command: SHOW,
    });
    ctx.subscriptions.push(
      this,
      this.tree,
      this.lens,
      new RestartWatch(ctx),
      vscode.commands.registerCommand(`${BRAND.slug}.open`, () => this.openCommand()),
      vscode.commands.registerCommand(SHOW, (tab: unknown) => this.showTab(isTab(tab) ? tab : "session")),
      vscode.commands.registerCommand(PICK, (id: unknown) => this.pickCommand(typeof id === "string" ? id : null)),
      vscode.commands.registerCommand(PICK_FOLDER, () => this.pickFolderCommand()),
      vscode.commands.registerCommand(`${BRAND.slug}.healthRefresh`, () => this.healthCommand()),
      vscode.commands.registerCommand(`${BRAND.slug}.rescan`, () => this.rescan()),
      vscode.commands.registerCommand(QUOTA, () => this.quota.click()),
      vscode.commands.registerCommand(`${QUOTA}Off`, () => this.quota.turnOff()),
      vscode.commands.registerCommand(`${BRAND.slug}.copyPrompt`, () => this.copyPromptCommand()),
      vscode.window.onDidChangeActiveTextEditor(() => this.onEditor()),
      vscode.window.onDidChangeActiveTerminal(() => this.sendPrompts()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.sendFolders(); this.onEditor(true); }),
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfig(e)),
    );
    this.activeFolder = this.editorFolder() ?? this.folders()[0] ?? null;
    void this.refreshSession();
  }

  // ---- folders -----------------------------------------------------------------------------
  private folders(): string[] { return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath); }

  /** The folder the active text editor belongs to; null for a webview, a terminal, or a file outside every folder. */
  private editorFolder(): string | null {
    const ed = vscode.window.activeTextEditor?.document.uri;
    return (ed ? vscode.workspace.getWorkspaceFolder(ed) : undefined)?.uri.fsPath ?? null;
  }

  /**
   * Follow the editor across folders, but only when it says something: focusing this panel, a
   * terminal or a file outside the workspace keeps the current folder, so a folder picked in the
   * panel stands until an editor in ANOTHER folder becomes active. A folder that left the
   * workspace is replaced by the editor's, else the first.
   */
  private onEditor(force = false): void {
    const all = this.folders();
    const ed = this.editorFolder();
    const kept = this.activeFolder && all.includes(this.activeFolder) ? this.activeFolder : null;
    const f = ed ?? kept ?? all[0] ?? null;
    if (!force && f === this.activeFolder) return;
    this.activeFolder = f;
    this.sendFolders();
    void this.refreshSession();
  }

  private configDir(): string {
    const o = vscode.workspace.getConfiguration(BRAND.slug).get<string>("claudeConfigDir", "").trim();
    return claudeConfigDir(o || undefined);
  }

  private onConfig(e: vscode.ConfigurationChangeEvent): void {
    // A Copilot instruction switch changes who reads which file: weigh again.
    if (["github.copilot.chat.codeGeneration.useInstructionFiles", "chat.useAgentsMdFile", "chat.useClaudeMdFile"].some((k) => e.affectsConfiguration(k))) {
      void this.refreshSession();
      this.lens.reset();
    }
    if (!e.affectsConfiguration(BRAND.slug)) return;
    const cfg = vscode.workspace.getConfiguration(BRAND.slug);
    this.statusBar.setEnabled(cfg.get<boolean>("statusBar", true));
    this.watch.setPollSeconds(cfg.get<number>("pollSeconds", 5));
    if (e.affectsConfiguration(`${BRAND.slug}.claudeConfigDir`)) {
      this.ledger.clear();
      this.cancelScan();
      this.lastScanAt = 0;
      this.corpus = { doc: null };
      this.summary = null;
      void this.ctx.globalState.update(SUMMARY_KEY, undefined);
      this.pushSummary();
      void this.refreshSession();
      if (this.panel.visible) void this.scan();
    }
  }

  // ---- session + weight (cheap; runs on activation) -------------------------------------------
  private async refreshSession(): Promise<void> {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.readActive();
      } while (this.again && !this.disposed);
    } finally { this.busy = false; }
  }

  private async readActive(): Promise<void> {
    const folder = this.activeFolder;
    if (!folder) {
      this.sessions = [];
      this.rows = blankRows(null);
      this.session = { folder: null, doc: null, why: "Open a folder to see its Claude Code session." };
      this.weight = { doc: null, why: this.session.why };
      this.watch.setProjectDir(null);
      this.watch.setActiveLog(null);
      this.watch.setRecent([]);
      this.applyLive();
      this.sendAll("panel");
      return;
    }
    // The folder can change while a read awaits; what it read then belongs to a folder nobody is
    // looking at, and the rerun that the change queued posts the right one.
    const stale = (): boolean => this.disposed || folder !== this.activeFolder;
    try {
      const { dir, why } = await projectDirFor(this.configDir(), folder);
      this.watch.setProjectDir(dir);
      if (!dir) {
        this.sessions = [];
        this.rows = blankRows(folder);
        this.session = { folder, doc: null, why: why ?? "No Claude Code logs were found for this folder." };
        this.watch.setActiveLog(null);
        this.watch.setRecent([]);
      } else {
        this.sessions = await listSessions(dir);
        // Which recent logs are unattended runs: asked of the head of each, before the list is cut.
        const now = Date.now();
        await this.ledger.peek(this.sessions.filter((s, i) => i === 0 || now - s.mtime < WINDOW_MS));
        // A pin that matches no listed log is dropped, not half-honoured: "pinned" must mean pinned.
        const pin = this.pinned.get(folder);
        const pinnedRow = pin ? this.sessions.find((s) => s.id === pin) : undefined;
        if (pin && !pinnedRow) this.pinned.delete(folder);
        const row = pinnedRow ?? this.sessions.find((s) => !this.ledger.auto(s)) ?? this.sessions[0];
        if (!row) {
          this.rows = blankRows(folder);
          this.session = { folder, doc: null, why: "This folder has no Claude Code session yet. Start one with claude and it shows up here." };
          this.watch.setActiveLog(null);
          this.watch.setRecent([]);
        } else {
          const r = await this.ledger.read(row, folder);
          this.session = r.doc ? { folder, doc: r.doc } : { folder, doc: null, why: r.why };
          this.watch.setActiveLog(row.path);
          const { listed, older, capped, automated } = recentRows(this.sessions, now, row.id, this.ledger.auto);
          this.watch.setRecent(listed.map((l) => l.path));
          if (stale()) return;
          // The drilled-in session first, posted before the other logs are read: a cold start of
          // twelve big ones must not hold up the headline. Rows already on screen for this folder
          // stay (only the selected summary is swapped in): collapsing a full list to one row and
          // back on every refresh would flicker it and misreport the counts in between.
          const prior = this.rows.folder === folder && this.rows.rows.length ? this.rows.rows : null;
          const first = r.sum
            ? (prior ? (prior.some((x) => x.id === r.sum!.id) ? prior.map((x) => (x.id === r.sum!.id ? r.sum! : x)) : [r.sum, ...prior]) : [r.sum])
            : (prior ?? []);
          this.rows = { folder, rows: first, selected: row.id, older, capped, automated };
          this.post(this.sessionsMsg(folder));
          this.resolveDefault();
          const full = await this.ledger.rows(listed, folder, r.sum);
          if (stale()) return;
          this.rows = { folder, rows: full, selected: row.id, older, capped, automated };
        }
      }
    } catch (e) {
      this.session = { folder, doc: null, why: sentence(e) };
    }
    try {
      this.weight = { doc: await weighFolder(folder, copilotSwitches()) };
    } catch (e) {
      this.weight = { doc: null, why: sentence(e) };
    }
    if (stale()) return;
    this.applyLive();
    this.post({ t: "session", folder, doc: this.session.doc, why: this.session.why, following: !this.pinned.has(folder) });
    this.post(this.sessionsMsg(folder));
    this.resolveDefault();
    this.post({ t: "weight", ...this.weight });
    this.lens.refresh();
    this.postHealth(folder);
  }

  /** The panel's pending default view, now that the active folder has been read (see `defaultPending`). */
  private resolveDefault(): void {
    if (!this.defaultPending || this.wantTab) return;
    this.defaultPending = false;
    const id: TabId = anyLive(this.myRows(), Date.now()) ? "session" : "all";
    this.panel.setView(id);
    this.post({ t: "tab", id }, "panel");
  }

  /** An instruction file was saved: weigh that folder again so the Always-on view and the lenses agree at once. */
  private async reweigh(folder: string): Promise<void> {
    if (folder !== this.activeFolder) return;
    try { this.weight = { doc: await weighFolder(folder, copilotSwitches()) }; } catch (e) { this.weight = { doc: null, why: sentence(e) }; }
    this.post({ t: "weight", ...this.weight });
  }

  private folderKeys(): string[] {
    const f = this.activeFolder;
    if (!f) return [];
    if (this.keys?.folder !== f) this.keys = { folder: f, keys: repoKeysOf(f) };
    return this.keys.keys;
  }

  /** The active folder's listed rows, or none while they belong to another folder. */
  private myRows(): SessionSummary[] {
    return this.activeFolder && this.rows.folder === this.activeFolder ? this.rows.rows : [];
  }

  /**
   * The status bar's mode from `anyLive`: the session while one is being worked on, else the last
   * scan's week. Re-armed to run again when the newest row ages out of "recent", since nothing is
   * written then to trigger a read.
   */
  private applyLive(): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    if (this.disposed) return;
    const rows = this.myRows();
    const now = Date.now();
    const live = anyLive(rows, now);
    this.statusBar.setDoc(live && this.session.folder === this.activeFolder ? this.session.doc : null);
    this.pushSummary();
    if (live) {
      const newest = Math.max(...rows.map((r) => r.mtime));
      this.liveTimer = setTimeout(() => { this.applyLive(); this.tree.refresh(); }, Math.max(1000, newest + RECENT_MS - now + 1000));
    }
  }

  private pushSummary(): void {
    const s = this.summary;
    this.statusBar.setSummary(s, s ? thisRepoWeek(s, this.folderKeys()) : null);
  }

  private sessionsMsg(folder: string): ToWebview {
    const { rows, selected, older, capped, automated } = this.rows;
    return { t: "sessions", folder, rows, selected, older, capped, automated, following: !this.pinned.has(folder) };
  }

  // ---- corpus (explicit only, in a worker) ---------------------------------------------------
  private rescan(): void {
    this.panel.show();
    void this.scan();
  }

  /** Stop a running scan: its worker is terminated and its result, if one still arrives, dropped. */
  private cancelScan(): void {
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate();
    if (this.scanning) {
      this.scanning = null;
      this.statusBar.setScan(null);
    }
  }

  private scan(): Promise<void> {
    if (this.scanning) return Promise.resolve();
    this.scanning = { done: 0, total: 0 };
    this.statusBar.setScan(this.scanning);
    this.post({ t: "corpus", ...this.corpus, scanning: this.scanning });
    const dir = this.ctx.globalStorageUri.fsPath;
    const job: ScanJob = { configDir: this.configDir(), cacheFile: path.join(dir, "tokenstore.v5.json") };
    return new Promise<void>((resolve) => {
      let w: Worker;
      const finish = (next: { doc: CorpusDoc | null; why?: string }): void => {
        if (this.worker !== w) { resolve(); return; } // cancelled: the panel closed, or the config dir moved
        this.worker = null;
        void w.terminate();
        this.corpus = next;
        this.lastScanAt = Date.now();
        if (next.doc && !next.why) {
          this.summary = summaryOf(next.doc, job.configDir);
          void this.ctx.globalState.update(SUMMARY_KEY, this.summary);
          this.pushSummary();
        }
        this.scanning = null;
        this.statusBar.setScan(null);
        if (!this.disposed) this.post({ t: "corpus", ...this.corpus });
        // The score's spend line is folded off this scan: the open folder's reading gains it now.
        if (this.activeFolder) this.postHealth(this.activeFolder);
        resolve();
      };
      fs.mkdir(dir, { recursive: true }).then(() => {
        if (!this.scanning || this.disposed) { resolve(); return; }
        w = new Worker(path.join(this.ctx.extensionUri.fsPath, "dist", "scanworker.js"), { workerData: job });
        this.worker = w;
        w.on("message", (m: ScanMsg) => {
          if (this.worker !== w) return;
          if (m.t === "progress") {
            this.scanning = { done: m.done, total: m.total };
            this.statusBar.setScan(this.scanning);
            this.post({ t: "corpus", ...this.corpus, scanning: this.scanning });
          } else if (m.t === "done") finish({ doc: m.doc });
          else finish({ doc: this.corpus.doc, why: sentence(m.message) });
        });
        w.on("error", (e) => finish({ doc: this.corpus.doc, why: sentence(e) }));
        // An exit before "done" (a crash, an out-of-memory) keeps the last figures and says so.
        w.on("exit", () => finish({ doc: this.corpus.doc, why: "The log scan stopped before it finished; the figures shown are from the last complete one." }));
      }, (e: unknown) => {
        this.scanning = null;
        this.statusBar.setScan(null);
        this.corpus = { doc: this.corpus.doc, why: sentence(e) };
        if (!this.disposed) this.post({ t: "corpus", ...this.corpus });
        // The score's spend line is folded off this scan: the open folder's reading gains it now.
        if (this.activeFolder) this.postHealth(this.activeFolder);
        resolve();
      });
    });
  }

  private onVisible(visible: boolean): void {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    if (!visible || this.disposed) return;
    // Revealing the panel again is not a reason to re-read 9k logs: a scan under 10 minutes old stands.
    if (Date.now() - this.lastScanAt >= RESCAN_MS) void this.scan();
    this.rescanTimer = setInterval(() => void this.scan(), RESCAN_MS);
  }

  // ---- webview traffic ------------------------------------------------------------------------
  /** To the panel, if open; the tree re-reads the same state on its own. */
  private post(m: ToWebview, _to?: Origin): void {
    if (this.panel.open) this.panel.post(m);
    this.tree.refresh();
  }

  /** What the tree prints, from the same state the panel is sent. */
  private navState(): NavState {
    const folder = this.activeFolder;
    const mine = !!folder && this.rows.folder === folder;
    const h = folder ? this.health.state(folder) : null;
    return {
      folders: this.folders(),
      folder,
      rows: mine ? this.rows.rows : [],
      selected: mine ? this.rows.selected : null,
      following: !folder || !this.pinned.has(folder),
      older: mine ? this.rows.older : 0, capped: mine ? this.rows.capped : 0, automated: mine ? this.rows.automated : 0,
      why: this.session.folder === folder && !this.session.doc ? this.session.why ?? null : folder ? null : "Open a folder to see its Claude Code sessions.",
      corpus: this.corpus.doc,
      scanning: this.scanning,
      weight: this.weight.doc,
      health: h?.doc ?? null,
      healthRunning: !!h?.run,
      quota: this.quota.state,
      summary: this.summary,
      live: anyLive(mine ? this.rows.rows : [], Date.now()),
      folderKeys: this.folderKeys(),
    };
  }

  /** The folder named by a webview must be one of the workspace's own. */
  private known(folder: string): boolean { return this.folders().includes(folder); }

  /** VS Code's `git.path` (a string or a list), as a directory to put on the worker's PATH; null when it is just "git". */
  private gitDir(): string | null {
    const raw = vscode.workspace.getConfiguration("git").get<string | string[] | null>("path");
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (!first || !/[\\/]/.test(first)) return null;
    return path.dirname(first);
  }

  private postHealth(folder: string, to?: Origin): void {
    if (this.disposed) return;
    const st = this.health.state(folder);
    this.post({ t: "health", folder, doc: this.withSpend(folder, st.doc), ...(st.why ? { why: st.why } : {}), run: st.run }, to);
  }

  /**
   * The dotted context-per-request line beside the score, as the desktop app's route adds it
   * (`apirepowork.ts` `healthindex`): folded off the log scan's day rows, never a scan of its own.
   * Before the first scan — or for a scope, which has no score — `spend` stays ABSENT, so the chart
   * draws no line and says nothing about one; an empty fold is the chart's own "no request" sentence.
   */
  private withSpend(folder: string, doc: HealthDoc | null): HealthDoc | null {
    const days = this.corpus.doc?.days;
    if (!doc?.index?.series || !days) return doc;
    const spend = healthSpendWeeks(days, repoKeysOf(folder));
    return { ...doc, index: { ...doc.index, spend } };
  }

  private showTab(tab: TabId): void {
    this.defaultPending = false;
    this.panel.setView(tab);
    // An open panel will not say `ready` again, so tell it now; a new one gets it on its `ready`.
    if (this.panel.open) { this.panel.show(); this.post({ t: "tab", id: tab }, "panel"); return; }
    this.wantTab = tab;
    this.panel.show();
  }

  /** The panel in the centre and its navigation on the left: one without the other is half a tool. */
  private openCommand(): void {
    this.panel.show();
    void vscode.commands.executeCommand(`workbench.view.extension.${BRAND.slug}`).then(undefined, () => {});
  }

  /** A session row in the tree: drill the panel into it (null = follow the newest again). */
  private async pickCommand(id: string | null): Promise<void> {
    const folder = this.activeFolder;
    if (!folder) return;
    if (id == null) this.pinned.delete(folder); else this.pinned.set(folder, id);
    this.showTab("session");
    await this.refreshSession();
  }

  private async pickFolderCommand(): Promise<void> {
    const all = this.folders();
    const pick = await vscode.window.showQuickPick(
      all.map((f) => ({ label: path.basename(f), description: f === this.activeFolder ? "shown now" : undefined, detail: f, f })),
      { title: `${BRAND.name}: which folder's sessions?` },
    );
    if (!pick || pick.f === this.activeFolder) return;
    this.activeFolder = pick.f;
    this.sendFolders();
    await this.refreshSession();
  }

  private healthCommand(): void {
    const folder = this.activeFolder;
    this.showTab("health");
    if (!folder) { void vscode.window.showInformationMessage("Open a folder to measure its repo health."); return; }
    void this.health.refresh(folder);
  }

  /** Open a file the plot named, only if it really lives inside the folder (symlinks resolved). */
  private async openFile(folder: string, rel: string): Promise<void> {
    let real: string;
    try {
      const root = await fs.realpath(folder);
      real = await fs.realpath(path.resolve(root, rel));
      const r = path.relative(root, real);
      if (r === "" || r.startsWith("..") || path.isAbsolute(r)) {
        void vscode.window.showInformationMessage(`${BRAND.name} only opens files inside the folder it measured.`);
        return;
      }
    } catch {
      void vscode.window.showInformationMessage(`${rel} is not in the working tree any more, so there is nothing to open.`);
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(real));
  }

  private sendFolders(): void {
    const list = this.folders();
    if (this.activeFolder) this.post({ t: "folders", list, active: this.activeFolder });
  }

  private sendPrompts(to?: Origin): void {
    this.post({ t: "prompts", list: PROMPTS, terminal: vscode.window.activeTerminal?.name ?? null }, to);
  }

  /** Everything cheap, to whoever just said `ready`. Health is only what is cached: no read, no run. */
  private sendAll(to: Origin): void {
    const list = this.folders();
    if (this.activeFolder) this.post({ t: "folders", list, active: this.activeFolder }, to);
    // Only what was read for the active folder: a read for another one may still be in flight.
    const mine = this.session.folder === this.activeFolder;
    this.post({
      t: "session", folder: this.activeFolder ?? "", doc: mine ? this.session.doc : null,
      why: mine ? this.session.why : "Reading this folder's sessions…",
      following: !this.activeFolder || !this.pinned.has(this.activeFolder),
    }, to);
    if (this.activeFolder && this.rows.folder === this.activeFolder) this.post(this.sessionsMsg(this.activeFolder), to);
    this.post({ t: "weight", ...this.weight }, to);
    this.post({ t: "corpus", ...this.corpus, scanning: this.scanning ?? undefined }, to);
    this.sendPrompts(to);
    if (this.activeFolder) this.postHealth(this.activeFolder, to);
    if (to === "panel" && this.wantTab) {
      this.post({ t: "tab", id: this.wantTab }, "panel");
      this.wantTab = null;
    }
  }

  private async onMessage(m: ToExtension, from: Origin): Promise<void> {
    try {
      switch (m.t) {
        case "ready": {
          const asked = this.wantTab;
          this.sendAll(from);
          // The panel's default view: what it was left on, else the session while one is live, else All sessions.
          // Before the active folder's rows are read, "nothing live" would only mean "not read yet".
          if (from === "panel" && !asked) {
            if (m.tab == null && this.activeFolder && this.rows.folder !== this.activeFolder) { this.defaultPending = true; void this.refreshSession(); break; }
            this.defaultPending = false;
            const id: TabId = m.tab ?? (anyLive(this.myRows(), Date.now()) ? "session" : "all");
            this.panel.setView(id);
            this.post({ t: "tab", id }, "panel");
          }
          break;
        }
        case "rescan": void this.scan(); break;
        case "pickFolder":
          if (this.folders().includes(m.folder)) { this.activeFolder = m.folder; this.sendFolders(); await this.refreshSession(); }
          break;
        case "pickSession":
          if (m.id == null) this.pinned.delete(m.folder); else this.pinned.set(m.folder, m.id);
          await this.refreshSession();
          break;
        case "prompt": {
          // One receipt per tap, and it is what actually happened — posted after acting.
          const text = await this.runPrompt(m.id, m.how, m.turn);
          this.post({ t: "receipt", text, ...(m.tap != null ? { tap: m.tap } : {}) }, from);
          break;
        }
        case "healthRead": if (this.known(m.folder)) { this.postHealth(m.folder, from); void this.health.read(m.folder); } break;
        case "healthScope": if (this.known(m.folder)) void this.health.setScope(m.folder, typeof m.scope === "string" ? m.scope : null); break;
        case "healthRefresh": if (this.known(m.folder)) void this.health.refresh(m.folder); break;
        case "healthForget": if (this.known(m.folder)) void this.health.forget(m.folder); break;
        case "healthCancel": if (this.known(m.folder)) this.health.cancel(m.folder); break;
        case "openFile": if (this.known(m.folder)) await this.openFile(m.folder, m.path); break;
        case "openPanel": this.showTab(m.tab); break;
        case "open": {
          const u = allowedUrl(m.url);
          if (u) await vscode.env.openExternal(u);
          else void vscode.window.showInformationMessage(`${BRAND.name} only opens links to ${BRAND.domain} and the extension marketplaces.`);
          break;
        }
      }
    } catch (e) {
      void vscode.window.showWarningMessage(sentence(e));
    }
  }

  /** Build the prompt in the form `how` needs (one line for a terminal) and deliver it; the sentence says what happened. */
  private async runPrompt(id: PromptId, how: "copy" | "terminal", turn?: number): Promise<string> {
    const r = render(id, { session: this.session.doc, weight: this.weight.doc, turn, health: this.activeFolder ? this.health.state(this.activeFolder).doc : null }, how);
    if (!r.ok) return r.why;
    try {
      return (await deliver(r.text, how)).message;
    } catch (e) {
      const m = (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");
      return how === "copy" ? `Could not copy it: ${m}.` : `Could not type it into the terminal: ${m}.`;
    }
  }

  private async copyPromptCommand(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      PROMPTS.map((p) => ({ label: p.title, id: p.id })),
      { title: `${BRAND.name}: copy an optimisation prompt`, placeHolder: "Nothing is sent or changed; the text goes to your clipboard" },
    );
    if (!pick) return;
    let turn: number | undefined;
    if (pick.id === "explain-turn") {
      const turns = [...(this.session.doc?.turnCosts ?? [])]
        .filter((t) => t.costUsd != null)
        .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
        .slice(0, 20);
      if (!turns.length) { void vscode.window.showInformationMessage("No priced prompts in this session yet."); return; }
      const t = await vscode.window.showQuickPick(
        turns.map((x) => ({ label: `${fmtUsd(x.costUsd ?? 0)} · prompt ${x.n}`, description: x.prompt, n: x.n })),
        { title: "Which prompt? Dearest first, list prices" },
      );
      if (!t) return;
      turn = t.n;
    }
    // The command palette has no panel to show a receipt in, so this route alone uses a toast.
    void vscode.window.showInformationMessage(await this.runPrompt(pick.id, "copy", turn));
  }

  dispose(): void {
    this.disposed = true;
    this.cancelScan();
    if (this.liveTimer) clearTimeout(this.liveTimer);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    this.health.dispose();
    this.watch.dispose();
    this.panel.dispose();
    this.statusBar.dispose();
    this.quota.dispose();
  }
}

/** The VS Code settings that switch an instruction family off for Copilot chat; unset stays undefined. */
function copilotSwitches(): CopilotSwitches {
  const get = (k: string): boolean | undefined => {
    const v = vscode.workspace.getConfiguration().get<unknown>(k);
    return typeof v === "boolean" ? v : undefined;
  };
  return {
    instructionFiles: get("github.copilot.chat.codeGeneration.useInstructionFiles"),
    agentsMd: get("chat.useAgentsMdFile"),
    claudeMd: get("chat.useClaudeMdFile"),
  };
}

export function activate(ctx: vscode.ExtensionContext): void {
  new Ext(ctx);
}

export function deactivate(): void {}
