import { scrubTickets } from "../hostUrl.ts";

/**
 * Copy text to the clipboard — the ONE way this app writes it (`local/one-copy-path`).
 * The async API first; where a webview denies it (a VS Code tab) or the context is not
 * secure, a textarea + `execCommand("copy")`. The fallback gives focus and the selection
 * back, so it neither closes a phone keyboard nor loses a caret.
 */
export async function copyText(raw: string): Promise<boolean> {
  const text = scrubTickets(raw); // a read ticket never leaves on a copied link
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  let ta: HTMLTextAreaElement | null = null;
  let prev: HTMLElement | null = null;
  let sel: Selection | null = null;
  const ranges: Range[] = [];
  try {
    prev = document.activeElement as HTMLElement | null;
    sel = document.getSelection?.() ?? null;
    for (let i = 0; sel && i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i));
    ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true; // readonly: focusing it raises no on-screen keyboard
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    try { ta?.parentNode?.removeChild(ta); } catch { /* gone */ }
    try {
      if (sel) { sel.removeAllRanges(); for (const r of ranges) sel.addRange(r); }
      if (prev && prev !== document.body && typeof prev.focus === "function") prev.focus({ preventScroll: true });
    } catch { /* focus is best effort */ }
  }
}
