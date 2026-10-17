/**
 * Pick up a fresh install without a hand reload. `code --install-extension --force` swaps the files
 * on disk but every open window keeps running the copy it loaded; the desktop app's install build
 * (option `restart`, on by default) then drops RESTART_FLAG into the installed folder, which it finds
 * with `code --locate-extension`. Each window's extension host polls its own install's siblings and
 * restarts itself once when a flag is newer than its own start — so every open window reloads once,
 * and a window opened after the install never does.
 *
 * Only a real install looks: a development host runs from the source tree, where nothing installs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { BRAND } from "@waterplane/shared";

export const RESTART_FLAG = ".restart-requested";
const POLL_MS = 3000;

export class RestartWatch implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private readonly since = Date.now();
  private fired = false;

  constructor(ctx: vscode.ExtensionContext) {
    if (ctx.extensionMode !== vscode.ExtensionMode.Production) return;
    const root = path.dirname(ctx.extensionPath);
    // An install's folder is `<publisher>.<name>-<version>`; any version of this one counts.
    const prefix = `${ctx.extension.id.toLowerCase()}-`;
    this.timer = setInterval(() => void this.look(root, prefix), POLL_MS);
    this.timer.unref?.();
  }

  private async look(root: string, prefix: string): Promise<void> {
    if (this.fired) return;
    let names: string[];
    try { names = await fs.readdir(root); } catch { return; }
    for (const n of names) {
      if (!n.toLowerCase().startsWith(prefix)) continue;
      const st = await fs.stat(path.join(root, n, RESTART_FLAG)).catch(() => null);
      if (!st || st.mtimeMs <= this.since) continue;
      this.fired = true;
      this.dispose();
      void vscode.window.setStatusBarMessage(`$(sync~spin) ${BRAND.displayName}: a new build was installed — restarting extensions`, 4000);
      await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
      return;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
