/**
 * The pure half of `Receipt.tsx` (decision D5, "every action ends on a visible result"): one
 * receipt on screen at a time, with a clock, an optional `Open` and an optional `Undo`.
 *
 * A receipt is a toast that can be acted on. It is NOT written to the toast log (the log keeps
 * sentences, not buttons); a caller that wants the sentence kept says it with `showToast` too.
 * Node-tested (`kit.test.mjs`) with no DOM.
 */

/** How long a receipt stays up. Spec D5: 6 s. */
export const RECEIPT_MS = 6000;

export interface ReceiptSpec {
  /** What happened, as a sentence that names the thing: "Saved flow.gif to Downloads." */
  text: string;
  /** `Open` takes the person to the result. `label` defaults to "Open" (the one word every receipt uses; "Open Archive" is allowed by the glossary). */
  open?: { run: () => void; label?: string };
  /** Present only where the action can be undone. */
  undo?: () => void;
  /** Overrides RECEIPT_MS (a slow job's progress line is not a receipt: do not use it for that). */
  ms?: number;
}

type Listener = (r: ReceiptSpec | null) => void;
let current: ReceiptSpec | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<Listener>();

function emit(): void { for (const fn of listeners) fn(current); }

let layerAsked = false;
/** Draw the layer on first use. A dynamic import so this file stays free of React (node tests load it);
 *  where there is no DOM or the module cannot load, the receipt is still held and read by `onReceipt`. */
function ensureLayer(): void {
  if (layerAsked || typeof document === "undefined") return;
  layerAsked = true;
  import("./Receipt").then((m) => m.mountReceiptLayer()).catch(() => { layerAsked = false; });
}

/** Say what just happened, with its buttons. Replaces a receipt still on screen (a second action's result wins). */
export function showReceipt(spec: ReceiptSpec): void {
  ensureLayer();
  current = spec;
  emit();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; current = null; emit(); }, spec.ms ?? RECEIPT_MS);
}

/** Take it down now (a tap on `Open`/`Undo`, or the person moving on). */
export function dismissReceipt(): void {
  if (timer) { clearTimeout(timer); timer = undefined; }
  if (current === null) return;
  current = null;
  emit();
}

/** Subscribe; the current receipt arrives at once. Returns the unsubscribe. */
export function onReceipt(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => { listeners.delete(fn); };
}

/** The receipt on screen now, or null (tests). */
export function currentReceipt(): ReceiptSpec | null { return current; }

/** The label of a receipt's open button: the caller's own, else "Open". */
export function openLabel(r: ReceiptSpec): string { return r.open?.label || "Open"; }
