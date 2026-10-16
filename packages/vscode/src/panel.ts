/**
 * The one webview panel, opened as an editor tab. Strict CSP: a nonce for the script and stylesheet, nothing remote, no
 * inline handlers; the webview may only read from dist/.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { BRAND } from "@waterplane/shared";
import type { TabId, ToExtension, ToWebview } from "./protocol.js";

const TITLES: Record<TabId, string> = {
  session: "Session", all: "All sessions", "always-on": "Always-on context", health: "Repo health", prompts: "Prompts",
};
const panelTitle = (tab: TabId): string => `${BRAND.name} · ${TITLES[tab]}`;

/** The panel's page: a nonce for the script and stylesheet, nothing remote, no inline handlers. */
export function webviewHtml(w: vscode.Webview, dist: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const js = w.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
  const css = w.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css"));
  const csp = [
    "default-src 'none'",
    `style-src ${w.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${BRAND.name}</title>
<link nonce="${nonce}" rel="stylesheet" href="${css}">
</head><body><div id="root" data-mode="panel"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
}

export class Panel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private subs: vscode.Disposable[] = [];
  private dist: vscode.Uri;

  constructor(
    extensionUri: vscode.Uri,
    private onMessage: (m: ToExtension) => void,
    private onVisible: (visible: boolean) => void,
    /** The person closed the panel (not merely hid it): whatever it was waiting for can stop. */
    private onClosed: () => void = () => {},
  ) {
    this.dist = vscode.Uri.joinPath(extensionUri, "dist");
  }

  private view: TabId = "session";

  get open(): boolean { return this.panel !== null; }
  get visible(): boolean { return this.panel?.visible ?? false; }

  /** The editor tab's title names the view it shows: the panel has no tab bar of its own. */
  setView(tab: TabId): void {
    this.view = tab;
    if (this.panel) this.panel.title = panelTitle(tab);
  }

  show(): void {
    if (this.panel) { this.panel.reveal(undefined, false); return; }
    // In the active editor group: the content sits in the centre, its navigation is the tree on the left.
    const p = vscode.window.createWebviewPanel(BRAND.slug, panelTitle(this.view), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [this.dist],
    });
    p.webview.html = webviewHtml(p.webview, this.dist);
    this.subs = [
      p.webview.onDidReceiveMessage((m: ToExtension) => this.onMessage(m)),
      p.onDidChangeViewState(() => this.onVisible(p.visible)),
      p.onDidDispose(() => { this.drop(); this.onVisible(false); this.onClosed(); }),
    ];
    this.panel = p;
    this.onVisible(true);
  }

  post(m: ToWebview): void { void this.panel?.webview.postMessage(m); }

  private drop(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.panel = null;
  }

  dispose(): void {
    const p = this.panel;
    this.drop();
    p?.dispose();
  }
}
