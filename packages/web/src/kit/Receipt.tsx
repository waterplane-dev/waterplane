/**
 * **The receipt** (D5): what an action says when it is done — a sentence that names the thing, and
 * `Open` (go to it) and, where the action can be undone, `Undo`. It stays 6 s, sits where the toast
 * sits (above the bottom bars, never over a sheet's primary button) and mounts itself, so a caller
 * is one line: `showReceipt({ text, open: { run } })` (`receiptStore.ts`).
 *
 * A receipt is for a RESULT. A refusal says why in text (`Unavailable.tsx`); a slow action shows its
 * progress line at once ("Sending…") and the receipt replaces it when it lands.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "./Button";
import { dismissReceipt, onReceipt, openLabel, type ReceiptSpec } from "./receiptStore";

export { showReceipt, dismissReceipt, type ReceiptSpec } from "./receiptStore";

/** The drawn receipt. Mounted once by `showReceipt`'s first call; also usable on its own. */
export function ReceiptLayer() {
  const [r, setR] = useState<ReceiptSpec | null>(null);
  useEffect(() => onReceipt(setR), []);
  if (!r) return null;
  return (
    <div className="toast receipt" role="status" aria-live="polite"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--sp-8)", cursor: "default", zIndex: 25 }}>
      <span style={{ flex: "1 1 auto" }}>{r.text}</span>
      {r.open && (
        <Button onClick={() => { const run = r.open!.run; dismissReceipt(); run(); }}>{openLabel(r)}</Button>
      )}
      {r.undo && (
        <Button onClick={() => { const run = r.undo!; dismissReceipt(); run(); }}>Undo</Button>
      )}
    </div>
  );
}

let mounted = false;
/** Idempotent: draws the layer into its own root on first use, so no screen has to render it. */
export function mountReceiptLayer(): void {
  if (mounted || typeof document === "undefined") return;
  mounted = true;
  const host = document.createElement("div");
  host.id = "receipt-root";
  document.body.appendChild(host);
  createRoot(host).render(<ReceiptLayer />);
}
