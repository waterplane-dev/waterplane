/**
 * The ledgers' one line to the price-list reader: "I just met an Anthropic
 * model I could not price". Dependency-free on purpose — `costwindow.ts` and
 * the context ledgers are bundled into the VS Code extension from source, and
 * the fetch (`pricefetch.ts`) must not ride along. The host registers the
 * listener at boot; in the extension nobody does, and a gap is just counted.
 */
import { isAnthropicModel, rateFor } from "@waterplane/shared";

type GapListener = (model: string, usedAt: number) => void;
let listener: GapListener | null = null;

/** Set (or clear) who hears about an unpriced Anthropic model. */
export function onPriceGap(fn: GapListener | null): void {
  listener = fn;
}

/**
 * Called where a ledger puts tokens into `unpriced`. Only an Anthropic model
 * (never `<synthetic>`) with no rate counts — a local model has no list price
 * to read. `usedAt` is when those tokens were spent (epoch ms), so a model last
 * used months ago does not keep asking for the page.
 */
export function notePriceGap(model: string | null | undefined, usedAt: number): void {
  if (!listener || !model || model === "<synthetic>") return;
  if (!isAnthropicModel(model) || rateFor(model) != null) return;
  try { listener(model, usedAt); } catch { /* a reading is not worth a throw */ }
}
