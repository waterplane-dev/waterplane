/**
 * The app tab: the waterplane app itself, framed in an editor tab from the host that already runs on
 * THIS machine. No second UI and no host in here: it never starts one and never runs a command.
 *
 * Nothing is contacted until the person runs the command, and nothing at all on a remote window. One
 * GET of `/api/health` decides between the frame and a page that says why not. A host that restarts
 * needs nothing from here: the app inside reconnects by itself.
 *
 * The framed app can ask for exactly one thing, a link opened in the browser. No clipboard, no
 * prompt, no session op, ever: the contract and its checks are in `apptab.ts`.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { BRAND } from "@waterplane/shared";
import { appBase, appHtml, DOCS, INSTALL_DOCS, OpenGate, openMessage, probeHost, remoteRefusal, stopHtml, stopMessage } from "./apptab.js";
import type { StopOp } from "./apptab.js";

export const OPEN_APP = `${BRAND.slug}.openApp`;
export const OPEN_APP_IN_BROWSER = `${BRAND.slug}.openAppInBrowser`;
export const RELOAD_APP = `${BRAND.slug}.reloadApp`;
const VIEW_TYPE = `${BRAND.slug}.app`;
/** Context key: something answers at the tab's address, so the title's "Open in browser" has a page to open. */
const ANSWERED = `${BRAND.slug}.appAnswered`;

const nonce = (): string => randomBytes(16).toString("hex");

const remote = (): string | null => remoteRefusal(vscode.env.remoteName, vscode.env.uiKind === vscode.UIKind.Web);

/** As a string, not a Uri: a Uri decodes the query on its way out, and a sign-in link's `%26` would become `&`. */
const openInBrowser = (url: string): Thenable<boolean> => vscode.env.openExternal(url as unknown as vscode.Uri);

export class AppPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private subs: vscode.Disposable[] = [];
  private gate = new OpenGate();
  /** What the tab shows: the app, or a page with these buttons. */
  private shown: { app: true } | { app: false; offered: readonly StopOp[] } = { app: false, offered: [] };
  /** The address something answered at; null while nothing has. */
  private answered: string | null = null;
  /** Each check takes a number; one that is no longer the latest draws nothing. */
  private run = 0;

  /** `waterplane.openApp`: one tab. A second run shows it again, and checks again unless the app is in it. */
  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (!this.shown.app) await this.check();
      return;
    }
    const p = vscode.window.createWebviewPanel(VIEW_TYPE, BRAND.name, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    this.panel = p;
    this.subs = [p.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m)), p.onDidDispose(() => this.drop())];
    await this.check();
  }

  /** `waterplane.openAppInBrowser`, in the tab's title while something answers. */
  async browse(): Promise<void> {
    if (!remote() && this.answered) await openInBrowser(`${this.answered}/`);
  }

  /** `waterplane.reloadApp`: check again and load afresh. The way out when a host stopped as the frame loaded and left it blank. */
  async reload(): Promise<void> {
    if (this.panel) await this.check();
  }

  private async check(): Promise<void> {
    const run = ++this.run;
    this.setAnswered(null);
    const no = remote();
    if (no) { this.stop(no, ["docs"]); return; }
    const b = appBase(vscode.workspace.getConfiguration(BRAND.slug).get<string>("desktopUrl", ""));
    if ("off" in b) { this.stop(b.off, ["check"]); return; }
    this.stop(`Looking for the ${BRAND.name} desktop at ${b.base}…`, []);
    const r = await probeHost(b.base);
    if (run !== this.run || !this.panel) return;
    this.setAnswered(r.ok || r.answered ? b.base : null);
    if (!r.ok) { this.stop(r.why, r.answered ? ["check", "browser", "install"] : ["check", "install"]); return; }
    this.shown = { app: true };
    this.panel.webview.html = appHtml(b.base, nonce());
  }

  private stop(why: string, offered: readonly StopOp[]): void {
    if (!this.panel) return;
    this.shown = { app: false, offered };
    this.panel.webview.html = stopHtml(why, offered, nonce());
  }

  private async onMessage(m: unknown): Promise<void> {
    if (this.shown.app) {
      const url = openMessage(m);
      if (url && this.gate.allow(Date.now())) await openInBrowser(url);
      return;
    }
    switch (stopMessage(m, this.shown.offered)) {
      case "check": await this.check(); break;
      case "browser": await this.browse(); break;
      case "install": await openInBrowser(INSTALL_DOCS); break;
      case "docs": await openInBrowser(DOCS); break;
      default: break;
    }
  }

  private setAnswered(base: string | null): void {
    this.answered = base;
    void vscode.commands.executeCommand("setContext", ANSWERED, base !== null);
  }

  private drop(): void {
    this.run++;
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.panel = null;
    this.shown = { app: false, offered: [] };
    this.setAnswered(null);
  }

  dispose(): void {
    const p = this.panel;
    this.drop();
    p?.dispose();
  }
}
