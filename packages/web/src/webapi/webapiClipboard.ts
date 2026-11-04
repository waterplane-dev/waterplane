import { scrubTickets } from "../hostUrl";

/** Copy text to clipboard with a textarea fallback for non-secure contexts. */
export async function copyText(raw: string): Promise<boolean> {
  const text = scrubTickets(raw); // the one copy path: a read ticket never leaves on a copied link
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
