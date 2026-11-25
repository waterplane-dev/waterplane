/**
 * The ONE file that knows waterplane may be framed inside a VS Code tab.
 *
 * The app is the same app there. The only thing a VS Code webview cannot do for
 * it is open a link (`window.open` returns null), so the contract with the
 * other end is exactly ONE message, page to parent:
 *
 *     { shell: "vscode", v: 1, op: "open", url }
 *
 * posted with `targetOrigin` set to the parent's exact origin, never "*".
 * No clipboard, no prompt, no session op, and NO message listener at all: the
 * page never receives anything from its parent. The other end is
 * `packages/vscode/src/apppanel.ts`. `tools/vscodeshell.test.mjs` keeps every
 * other file from mentioning the shell.
 */

/** The parts of a window this file reads — so node tests can pass a plain object. */
export interface FrameWindow {
  parent?: unknown;
  location?: { ancestorOrigins?: ArrayLike<string> };
  postMessage?: unknown;
}

const WEBVIEW = "vscode-webview://";

/** The parent's origin when `win` is framed directly by a VS Code webview, else null. Never throws. */
export function vscodeParentOf(win: FrameWindow | null | undefined): string | null {
  try {
    if (!win || win.parent === win || !win.parent) return null;
    const first = win.location?.ancestorOrigins?.[0];
    return typeof first === "string" && first.startsWith(WEBVIEW) ? first : null;
  } catch {
    return null;
  }
}

/** Posts the one message; false when not framed or `url` is not http(s). Never throws. */
export function openInVscodeFrom(win: FrameWindow | null | undefined, url: string): boolean {
  try {
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return false;
    const origin = vscodeParentOf(win);
    if (!origin) return false;
    (win!.parent as { postMessage(m: unknown, o: string): void }).postMessage({ shell: "vscode", v: 1, op: "open", url }, origin);
    return true;
  } catch {
    return false;
  }
}

const here = (): FrameWindow | null => (typeof window === "undefined" ? null : window);

export function vscodeParent(): string | null { return vscodeParentOf(here()); }

/** Ask the VS Code side to open `url` in the person's browser. */
export function openInVscode(url: string): boolean { return openInVscodeFrom(here(), url); }

/**
 * One capture-phase click handler for `<a target="_blank" href="http(s)…">`
 * (Markdown links and the like), dead inside a webview. Installed once, and
 * only when framed. Anchors with `download` are left alone.
 */
export function installVscodeLinks(): void {
  if (typeof document === "undefined" || !vscodeParent()) return;
  document.addEventListener("click", (e) => {
    const t = e.target as Element | null;
    const a = t?.closest?.("a[target=_blank][href]") as HTMLAnchorElement | null;
    if (!a || a.hasAttribute("download")) return;
    const href = a.href;
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    openInVscode(href);
  }, true);
}
