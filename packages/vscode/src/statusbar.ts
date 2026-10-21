/**
 * The status bar is the door, not the pitch. While a session is being worked on (`anyLive`) it is
 * that session: `$4.21 · 38%`. Otherwise it is the last scan's seven days, this repo's when the
 * ledger has a priced figure for it (`7 d here $14`), else everything (`7 d all $80`); a reading
 * over a day old says its age in the text (`7 d here $14 · 3 d ago`), a younger one on hover.
 * Hidden when there is neither, or the scan is older than the seven days (never a "$0").
 * A click opens the panel.
 */
import * as vscode from "vscode";
import { BRAND, contextPct, fmtCount, fmtUsd, PRICES_AS_OF } from "@waterplane/shared";
import type { SessionDoc } from "./protocol.js";
import { sessionTotal } from "./data/sessiontotal.js";
import type { SessionTotal } from "./data/sessiontotal.js";
import { fmtAge } from "./data/running.js";
import { currentSummary, weekFigure, weekSplit } from "./data/summary.js";
import type { HeadlineSummary } from "./data/summary.js";

/** Past this the reading's age is in the status-bar text, not only on hover. */
const AGE_IN_TEXT_MS = 24 * 3_600_000;

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private doc: SessionDoc | null = null;
  private scan: { done: number; total: number } | null = null;
  private enabled = true;
  private summary: HeadlineSummary | null = null;
  private repo: { usd: number } | null = null;
  /** Re-renders the summary so its age moves with the clock (and it hides once the scan is too old). */
  private ageTimer: NodeJS.Timeout | null = null;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = command;
    this.item.name = BRAND.displayName;
  }

  setEnabled(on: boolean): void { this.enabled = on; this.render(); }
  setDoc(doc: SessionDoc | null): void { this.doc = doc; this.render(); }
  setScan(p: { done: number; total: number } | null): void { this.scan = p; this.render(); }
  /** The last scan's seven days, and this folder's share of them (null: no priced figure for it). */
  setSummary(s: HeadlineSummary | null, repo: { usd: number } | null): void { this.summary = s; this.repo = s ? repo : null; this.render(); }

  private ticking(on: boolean): void {
    if (on && !this.ageTimer) this.ageTimer = setInterval(() => this.render(), 60_000);
    if (!on && this.ageTimer) { clearInterval(this.ageTimer); this.ageTimer = null; }
  }

  private render(): void {
    this.ticking(false);
    if (!this.enabled) { this.item.hide(); return; }
    if (this.scan) {
      this.item.text = `$(sync~spin) reading logs ${fmtCount(this.scan.done)}/${fmtCount(this.scan.total)}`;
      this.item.tooltip = `${BRAND.name} is reading Claude Code's logs on this machine. Nothing leaves it.`;
      this.item.show();
      return;
    }
    const d = this.doc;
    if (!d) { this.renderSummary(); return; }
    // The latest RAW reading (`lastTok`), never the chart's downsampled last point.
    const tok = d.lastTok;
    const pct = tok != null ? contextPct(tok, d.windowTok) : null;
    // The same total the panel's headline prints: the conversation plus its subagents.
    const total = sessionTotal(d);
    const parts: string[] = [];
    if (total.cost) parts.push(fmtUsd(total.cost.total));
    if (pct != null) parts.push(`${Math.round(pct)}%`);
    if (!parts.length) parts.push(`${fmtCount(d.usageTok)} tok`);
    this.item.text = `$(graph-line) ${parts.join(" · ")}`;
    this.item.tooltip = this.tooltip(d, pct, tok, total);
    this.item.show();
  }

  private tooltip(d: SessionDoc, pct: number | null, tok: number | null, total: SessionTotal): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**This session** · ${d.turns} prompt${d.turns === 1 ? "" : "s"}\n\n`);
    if (tok != null) {
      md.appendMarkdown(pct != null
        ? `Context: ${fmtCount(tok)} of ${fmtCount(d.windowTok ?? 0)} tokens (${Math.round(pct)}%)\n\n`
        : `Context: ${fmtCount(tok)} tokens (window unknown)\n\n`);
    }
    const c = total.cost;
    if (c) {
      md.appendMarkdown(`${fmtUsd(c.total)}: input ${fmtUsd(c.input)} · output ${fmtUsd(c.output)} · cache read ${fmtUsd(c.cacheRead)} · cache write ${fmtUsd(c.cacheWrite)}\n\n`);
      if (total.agentUsd != null) {
        md.appendMarkdown(`Subagents: ${fmtUsd(total.agentUsd)} of it, ${fmtUsd(c.total - total.agentUsd)} the conversation itself.\n\n`);
      }
    } else if (total.withheld) {
      md.appendMarkdown(`${total.withheldWhy ?? "No dollar figure."}\n\n`);
    }
    if (total.unpricedTok > 0) md.appendMarkdown(`${fmtCount(total.unpricedTok)} tokens ran on a model with no published rate and are not priced.\n\n`);
    md.appendMarkdown(`List price at ${PRICES_AS_OF}, not your bill. Click to open.`);
    return md;
  }

  private renderSummary(): void {
    const now = Date.now();
    const s = currentSummary(this.summary, now);
    const all = s ? weekFigure(s) : null;
    if (!s || !all) { this.item.hide(); return; }
    const age = now - s.scannedAt;
    this.item.text = `$(graph-line) 7 d ${this.repo ? `here ${fmtUsd(this.repo.usd)}` : `all ${all}`}${age > AGE_IN_TEXT_MS ? ` · ${fmtAge(age)}` : ""}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Last 7 days, as of ${fmtAge(age)}**`);
    if (this.repo) md.appendMarkdown(` · this repo ${fmtUsd(this.repo.usd)}`);
    md.appendMarkdown(` · all ${all}\n\n${weekSplit(s)}\n\n`);
    md.appendMarkdown(s.week.cost ? `List price at ${PRICES_AS_OF}, not your bill. Click to open.` : "Nothing in these days was priced. Click to open.");
    this.item.tooltip = md;
    this.item.show();
    this.ticking(true);
  }

  dispose(): void { this.ticking(false); this.item.dispose(); }
}
