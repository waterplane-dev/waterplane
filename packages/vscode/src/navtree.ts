/**
 * The activity-bar view: a native tree that only NAVIGATES. Every number on it is a one-line
 * headline whose explanation is in the panel; a click opens the panel (an editor tab, in the
 * centre) at that view, or drills it into that session. Nothing here is a second copy of the
 * panel's list — the panel has no session list and no tab bar; this tree is its navigation.
 * Every absence is a description in words, never a "$0" or an empty row.
 */
import * as vscode from "vscode";
import { BRAND, CHARS_PER_TOKEN, contextPct, fmtCount, fmtUsd, isoWeekOf, repoHealthIndexOf } from "@waterplane/shared";
import { COPILOT_LEDGER } from "./protocol.js";
import type { HealthDoc, SessionSummary, TabId, WeightDoc, CorpusDoc } from "./protocol.js";
import { fmtAge, isLive, isRunning } from "./data/running.js";
import { copilotWeekWords, currentSummary, thisRepoWeek, weekFigure, weekSplit } from "./data/summary.js";
import type { HeadlineSummary } from "./data/summary.js";
import { seriesValueWords } from "../../web/src/repoHealthWords.js";
import { signedWhole, weekWhenWords } from "../../web/src/healthIndexWords.js";
import { NOT_GIT, XCODE_LICENSE } from "./health/sourcewords.js";
import { quotaTooltip, quotaWords } from "./copilotquota.js";
import { localWords } from "../../extensions/copilot-usage/host/vscodelocal.mts";
import type { QuotaState } from "./copilotquota.js";

export interface NavState {
  folders: string[];
  folder: string | null;
  /** The folder's listed sessions (newest write first) and what the list left out. */
  rows: SessionSummary[];
  selected: string | null;
  following: boolean;
  older: number; capped: number; automated: number;
  /** The tree's own sentence when there are no rows (no folder, no logs). */
  why: string | null;
  corpus: CorpusDoc | null;
  scanning: { done: number; total: number } | null;
  weight: WeightDoc | null;
  health: HealthDoc | null;
  healthRunning: boolean;
  quota: QuotaState;
  /** The last finished scan's seven days, kept across reloads; null before the first one. */
  summary: HeadlineSummary | null;
  /** Some listed session is running or was written to in the last half hour (`anyLive`). */
  live: boolean;
  /** The ledger's repo keys for the folder (as given and realpath-resolved). */
  folderKeys: string[];
}

/** The views the tree lists. The ready-made prompts are not one: they stay beside the numbers they quote. */
type NavTab = Exclude<TabId, "session" | "prompts">;

type Node =
  | { kind: "folder" }
  | { kind: "sessions" }
  | { kind: "session"; row: SessionSummary }
  | { kind: "follow" }
  | { kind: "note"; text: string; tab?: TabId }
  | { kind: "view"; tab: NavTab }
  | { kind: "quota" };

const VIEWS: { tab: NavTab; label: string; icon: string }[] = [
  { tab: "all", label: "All sessions", icon: "graph" },
  { tab: "health", label: "Repo health", icon: "pulse" },
  { tab: "always-on", label: "Always-on context", icon: "file-text" },
];

export const SHOW = `${BRAND.slug}.show`;
export const PICK = `${BRAND.slug}.pickSession`;
export const PICK_FOLDER = `${BRAND.slug}.pickFolder`;
export const QUOTA = `${BRAND.slug}.copilotQuota`;

/** The workspace-state key holding whether the person collapsed Sessions; unset = follow `live`. */
const COLLAPSED_KEY = `${BRAND.slug}.sessionsCollapsed`;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const base = (f: string): string => f.split(/[\\/]/).filter(Boolean).pop() ?? f;

function ctxWords(s: SessionSummary): string {
  if (s.lastTok == null) return "no context yet";
  const pct = contextPct(s.lastTok, s.windowTok);
  return pct == null ? "window unknown" : `${Math.round(pct)}%`;
}

export class NavTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private view: vscode.TreeView<Node>;
  private nodes = new Map<string, Node>();
  private sessionsNode: Node = { kind: "sessions" };
  private timer: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private subs: vscode.Disposable[] = [];
  /**
   * Whether the person collapsed Sessions. Kept here (and across reloads) because revealing the
   * selected session expands its parent: without it every log write re-opened the section.
   * Undefined until they fold it once: then it is open while something is live, closed otherwise.
   */
  private folded: boolean | undefined;

  constructor(private state: () => NavState, onVisible: (v: boolean) => void, private memo: vscode.Memento) {
    this.folded = memo.get<boolean | undefined>(COLLAPSED_KEY);
    this.view = vscode.window.createTreeView(`${BRAND.slug}.sidebar`, { treeDataProvider: this, showCollapseAll: false });
    const fold = (on: boolean) => (e: vscode.TreeViewExpansionEvent<Node>) => {
      if (e.element.kind !== "sessions") return;
      // A fold that matches the live/idle default hands the choice back to it (a reveal expanding
      // an open section must not pin it open for the idle hours after).
      this.folded = on === !this.state().live ? undefined : on;
      void this.memo.update(COLLAPSED_KEY, this.folded);
    };
    this.subs.push(this.view.onDidCollapseElement(fold(true)), this.view.onDidExpandElement(fold(false)));
    this.subs.push(this.view.onDidChangeVisibility((e) => {
      this.tick(e.visible);
      onVisible(e.visible);
    }));
    this.tick(this.view.visible);
  }

  get visible(): boolean { return this.view.visible; }

  /** Re-read the state, coalesced: a refresh posts several messages in a row. */
  refresh(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.changed.fire(undefined);
      this.revealSelected();
    }, 50);
  }

  /** Ages ("2 min ago") and the live marker move with the clock, so the tree does too while it is on screen. */
  private tick(on: boolean): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = on ? setInterval(() => this.changed.fire(undefined), 30_000) : null;
  }

  private revealSelected(): void {
    const s = this.state();
    if (!this.view.visible || !s.selected || this.collapsed(s.live)) return;
    const n = this.nodes.get(s.selected);
    if (n) void this.view.reveal(n, { select: true, focus: false }).then(undefined, () => {});
  }

  /** A remembered fold wins; otherwise Sessions is open exactly while something is live. */
  private collapsed(live: boolean): boolean { return this.folded ?? !live; }

  getParent(n: Node): Node | undefined {
    return n.kind === "session" || n.kind === "follow" || (n.kind === "note" && n.tab !== undefined) ? this.sessionsNode : undefined;
  }

  getChildren(n?: Node): Node[] {
    const s = this.state();
    if (!n) {
      // Insight first: the week's figure leads; the session list sits second while something is
      // being worked on and drops to the bottom when nothing is.
      const view = (tab: NavTab): Node => ({ kind: "view", tab });
      const top: Node[] = [view("all")];
      if (s.folders.length > 1) top.push({ kind: "folder" });
      if (s.live) top.push(this.sessionsNode);
      top.push(view("health"), view("always-on"), { kind: "quota" });
      if (!s.live) top.push(this.sessionsNode);
      return top;
    }
    if (n.kind !== "sessions") return [];
    this.nodes.clear();
    if (!s.rows.length) {
      // This list is Claude Code's sessions only; on a Copilot-only machine say where Copilot's went.
      if (s.corpus?.copilot?.available) return [{ kind: "note", text: "No Claude Code sessions here. Copilot Chat's tokens are under All sessions.", tab: "all" }];
      return [{ kind: "note", text: s.why ?? "No session in this folder has been written to lately." }];
    }
    const out: Node[] = [];
    if (!s.following) out.push({ kind: "follow" });
    for (const row of s.rows) {
      const node: Node = { kind: "session", row };
      this.nodes.set(row.id, node);
      out.push(node);
    }
    const left: string[] = [];
    if (s.capped > 0) left.push(`${s.capped} more from the last day`);
    if (s.automated > 0) left.push(`${s.automated} claude -p ${s.automated === 1 ? "run" : "runs"} not listed`);
    if (s.older > 0) left.push("older ones under All sessions");
    if (left.length) out.push({ kind: "note", text: left.join(" · "), tab: s.older > 0 ? "all" : undefined });
    return out;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const s = this.state();
    const now = Date.now();
    switch (n.kind) {
      case "folder": {
        const it = new vscode.TreeItem(s.folder ? base(s.folder) : "No folder", vscode.TreeItemCollapsibleState.None);
        it.description = "folder · click to switch";
        it.iconPath = new vscode.ThemeIcon("root-folder");
        it.command = { command: PICK_FOLDER, title: "Switch folder" };
        return it;
      }
      case "sessions": {
        const it = new vscode.TreeItem("Sessions",
          this.collapsed(s.live) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        // VS Code keeps an item's fold by id and ignores a new state for the same id, so the
        // live/idle default needs its own id to take; a remembered fold is the same either way.
        it.id = s.live ? "sessions:live" : "sessions:idle";
        it.description = s.rows.length ? (s.following ? "following the newest" : "pinned to one") : undefined;
        it.iconPath = new vscode.ThemeIcon("comment-discussion");
        return it;
      }
      case "session": {
        const r = n.row;
        const running = isRunning(r.open, r.mtime, now);
        const live = isLive(r.mtime, running, now);
        const cost = r.costUsd != null ? fmtUsd(r.costUsd) : r.costNote ?? "no price";
        const label = r.lastPrompt ? clip(r.lastPrompt, 80) : r.prompts ? "(empty prompt)" : "(no prompt yet)";
        const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        it.id = `s:${r.id}`;
        it.description = `${cost} · ${ctxWords(r)} · ${running ? "running" : fmtAge(now - r.mtime)}`;
        it.iconPath = running ? new vscode.ThemeIcon("loading~spin")
          : live ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon("circle-outline");
        const md = new vscode.MarkdownString();
        md.appendText(`${cost} list price · ${r.lastTok != null ? `${fmtCount(r.lastTok)} tokens of context` : "no context yet"} · ${r.prompts} ${r.prompts === 1 ? "prompt" : "prompts"} · ${fmtAge(now - r.mtime)}${live ? (running ? " · running" : " · live") : ""}\n\n`);
        md.appendText(r.lastPrompt || "No prompt yet.");
        it.tooltip = md;
        it.accessibilityInformation = { label: `${label}, ${it.description}${live ? (running ? ", running" : ", live") : ""}` };
        it.command = { command: PICK, title: "Show this session", arguments: [r.id] };
        return it;
      }
      case "follow": {
        const it = new vscode.TreeItem("Follow the newest session", vscode.TreeItemCollapsibleState.None);
        it.id = "follow";
        it.description = "pinned now";
        it.iconPath = new vscode.ThemeIcon("pinned");
        it.command = { command: PICK, title: "Follow the newest session", arguments: [null] };
        return it;
      }
      case "note": {
        const it = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon("info");
        if (n.tab) it.command = { command: SHOW, title: "Open", arguments: [n.tab] };
        return it;
      }
      case "quota": {
        const q = s.quota;
        const it = new vscode.TreeItem("Copilot", vscode.TreeItemCollapsibleState.None);
        it.id = "quota";
        it.contextValue = q.on ? "copilotQuotaOn" : "copilotQuotaOff";
        it.iconPath = new vscode.ThemeIcon(q.busy ? "loading~spin" : "copilot");
        const words = q.reading ? quotaWords(q.reading) : null;
        // GitHub's figure when read; otherwise the plan and local count, which need no sign-in.
        const local = q.local ? localWords(q.local) : null;
        it.description = words ?? local ?? (q.on && q.why ? "not read · hover for why" : q.busy ? "reading…" : "not read yet");
        it.tooltip = quotaTooltip(q);
        // A click stays local: it opens Copilot Chat's token ledger. GitHub's figure needs a sign-in,
        // so it is its own action (the row's GitHub button, or right-click), never the row's click.
        it.command = { command: SHOW, title: "Open Copilot Chat's token use", arguments: ["all", COPILOT_LEDGER.id] };
        return it;
      }
      case "view": {
        const v = VIEWS.find((x) => x.tab === n.tab)!;
        const it = new vscode.TreeItem(v.label, vscode.TreeItemCollapsibleState.None);
        it.id = `v:${n.tab}`;
        it.iconPath = new vscode.ThemeIcon(v.icon);
        it.description = this.viewWords(n.tab, s);
        if (n.tab === "all" && !s.scanning) {
          const sum = currentSummary(s.summary, Date.now());
          if (sum && weekFigure(sum)) it.tooltip = this.summaryTip(sum, s.corpus !== null);
        }
        it.command = { command: SHOW, title: `Open ${v.label}`, arguments: [n.tab] };
        return it;
      }
    }
  }

  /** The one-line headline beside each view; the panel says what it means. */
  private viewWords(tab: NavTab, s: NavState): string {
    switch (tab) {
      case "all": {
        if (s.scanning) return `reading logs ${fmtCount(s.scanning.done)}/${fmtCount(s.scanning.total)}`;
        // Always the seven days, before and after this window's scan (which refreshes the summary):
        // the all-time total is the panel footer's. A week with nothing in it says so once scanned.
        const sum = currentSummary(s.summary, Date.now());
        const words = sum ? this.summaryWords(sum, s.folderKeys) : null;
        return words ?? copilotWeekWords(s.corpus) ?? (s.corpus ? "nothing in the last 7 days" : "read when opened");
      }
      case "always-on":
        if (!s.weight) return "nothing measured";
        if (!s.weight.files.length) return "no instruction files here";
        // Each agent that reads something here, by its every-request weight.
        const { claude, copilot } = s.weight.agents;
        const bits = [
          claude.files ? `Claude ~${fmtCount(s.weight.reading.alwaysOnTokens)}` : null,
          copilot.files ? `Copilot ~${fmtCount(Math.round(copilot.always / CHARS_PER_TOKEN))}` : null,
        ].filter(Boolean);
        return `${bits.join(" · ")} tokens every request`;
      case "health": {
        if (s.healthRunning) return "measuring…";
        // The score leads, as on the phone's launcher chip (trend second, the worst alert level named);
        // the p95 line stands in only where there is no scored week.
        const hi = repoHealthIndexOf(s.health?.index?.series ?? null, s.health?.index?.move);
        if (hi) {
          const d = hi.deltaWeek;
          const when = weekWhenWords(hi.week, isoWeekOf(new Date().toISOString().slice(0, 10)));
          return `score ${Math.round(hi.value)}${hi.alert ? ` · ${hi.alert}` : ""}${d !== null && Number.isFinite(d) ? ` · ${signedWhole(d)} ${when}` : ""}`;
        }
        const p95 = s.health?.plot?.series.find((x) => x.key === "size.p95") ?? null;
        if (p95) return `${p95.label} ${seriesValueWords(p95.last, p95.unit)}`;
        if (s.health?.series) return "measured";
        if (s.health?.readError) {
          if (XCODE_LICENSE.test(s.health.readError)) return "git blocked: Xcode license";
          return NOT_GIT.test(s.health.readError) ? "not a git repository" : "could not be read";
        }
        return "not measured yet";
      }
    }
  }

  /**
   * The last scan's week: `7 d: here $14 · all $80 · 2 h ago`, short so the age survives a narrow
   * sidebar. A scan within the last minute (this window's own) drops the age: it is now.
   */
  private summaryWords(sum: HeadlineSummary, keys: string[]): string | null {
    const all = weekFigure(sum);
    if (!all) return null;
    const repo = thisRepoWeek(sum, keys);
    const ms = Date.now() - sum.scannedAt;
    const age = ms < 60_000 ? "" : ` · ${fmtAge(ms)}`;
    return repo ? `7 d: here ${fmtUsd(repo.usd)} · all ${all}${age}` : `7 d: all ${all}${age}`;
  }

  private summaryTip(sum: HeadlineSummary, scanned: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendText(`Last 7 days, ${weekSplit(sum)}.\n\n`);
    const from = scanned ? "" : " From the last scan; opening the view reads the logs again.";
    md.appendText(sum.week.cost ? `List prices.${from}` : `Nothing in these days was priced.${from}`);
    return md;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    for (const d of this.subs) d.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}

