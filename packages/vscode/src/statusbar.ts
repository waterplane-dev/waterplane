/**
 * The status bar is the door, not the pitch: `$4.21 · 38%`, hidden when the folder has no session
 * (never a "$0"). A click opens the panel.
 */
import * as vscode from "vscode";
import { BRAND, contextPct, fmtCount, fmtUsd, PRICES_AS_OF } from "@waterplane/shared";
import type { SessionDoc } from "./protocol.js";
import { sessionTotal } from "./data/sessiontotal.js";
import type { SessionTotal } from "./data/sessiontotal.js";

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private doc: SessionDoc | null = null;
  private scan: { done: number; total: number } | null = null;
  private enabled = true;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = command;
    this.item.name = BRAND.displayName;
  }

  setEnabled(on: boolean): void { this.enabled = on; this.render(); }
  setDoc(doc: SessionDoc | null): void { this.doc = doc; this.render(); }
  setScan(p: { done: number; total: number } | null): void { this.scan = p; this.render(); }

  private render(): void {
    if (!this.enabled) { this.item.hide(); return; }
    if (this.scan) {
      this.item.text = `$(sync~spin) reading logs ${fmtCount(this.scan.done)}/${fmtCount(this.scan.total)}`;
      this.item.tooltip = `${BRAND.name} is reading Claude Code's logs on this machine. Nothing leaves it.`;
      this.item.show();
      return;
    }
    const d = this.doc;
    if (!d) { this.item.hide(); return; }
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

  dispose(): void { this.item.dispose(); }
}
