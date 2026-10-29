/**
 * Every OTHER backend's own ledger cut to one span, for `/api/costwindow`'s `beside` block
 * (`docs/analysis/backend-parity-v3/c2.md` §2). Shown beside claude's figure, never in it.
 *
 * Backends that keep claude's log (claude, claude-local, claude-endpoint) are SKIPPED: their
 * tokens are already in claude's figure and counting them again would double it. Each ledger read
 * is bounded by a timeout; a throw or a timeout is an `absent` sentence, never a missing line that
 * reads as "ran nothing". The cut itself is shared `ledgerOverSpan`.
 */
import { ledgerOverSpan, type CostWindowBeside, type LedgerSpanInput } from "@waterplane/shared";
import { BACKENDS, derive, storeReaderFor } from "./backends/index.js";
import type { BackendDescriptor } from "./backends/types.js";

/** How stale a backend's own ledger may be before it is asked again (also `/api/tokenstats/<id>`'s TTL). */
export const BACKEND_LEDGER_MAX_AGE_MS = 15_000;
export const BESIDE_LEDGER_TIMEOUT_MS = 3_000;

export interface BesideDeps {
  backends?: () => readonly BackendDescriptor[];
  /** A backend's ledger document, or null when it keeps none of its own. */
  ledger?: (b: BackendDescriptor, maxAge: number) => Promise<unknown> | null;
  now?: () => number;
  timeoutMs?: number;
}

const defaultLedger = (b: BackendDescriptor, maxAge: number): Promise<unknown> | null => {
  const tokens = b.sources?.tokens;
  if (tokens) return tokens.ledger(maxAge);
  const store = storeReaderFor(b);
  if (store?.ledger) return store.ledger(maxAge);
  return null;
};

export async function besideSpend(from: number, to: number, deps: BesideDeps = {}): Promise<CostWindowBeside[]> {
  const list = (deps.backends ?? (() => BACKENDS))();
  const read = deps.ledger ?? defaultLedger;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? BESIDE_LEDGER_TIMEOUT_MS;
  const rows = await Promise.all(list.map(async (b): Promise<CostWindowBeside | null> => {
    if (derive(b).keepsClaudeLog) return null;
    let asked: Promise<unknown> | null;
    try { asked = read(b, BACKEND_LEDGER_MAX_AGE_MS); } catch { asked = Promise.reject(new Error("threw")); }
    if (!asked) return null;
    let timer: NodeJS.Timeout | undefined;
    let doc: unknown;
    try {
      doc = await Promise.race([
        Promise.resolve(asked),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("slow")), timeoutMs); }),
      ]);
    } catch {
      return { backend: b.id, label: b.label, absent: "its ledger could not be read in time" };
    } finally { clearTimeout(timer); }
    const cut = ledgerOverSpan(doc as LedgerSpanInput | null, from, to, now());
    if (cut.kind === "none") return null;
    if (cut.kind === "absent") return { backend: b.id, label: b.label, absent: cut.why };
    const scannedAt = (doc as { scannedAt?: unknown }).scannedAt;
    return { backend: b.id, label: b.label, kinds: cut.kinds, ...(cut.unit ? { unit: cut.unit } : {}), scannedAt: typeof scannedAt === "number" ? scannedAt : now() };
  }));
  return rows.filter((r): r is CostWindowBeside => r !== null);
}
