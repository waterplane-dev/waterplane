/**
 * A backend's own token ledger on the wire, served at `GET /api/tokenstats/<backendId>` from the
 * store reader the backend names (`shared/backendsources.ts`'s `ledger`). Never summed with
 * `TokenStatsDoc` or with another backend's: the kinds are each backend's own accounting.
 *
 * An extension whose ledger predates this shape keeps its OWN document type in its folder (opencode's
 * five-kind document is `packages/extensions/opencode/shared/octokens.mts`); core serves either
 * verbatim and reads neither.
 */

/**
 * A ledger in the backend's OWN unit, served at `GET /api/tokenstats/<backendId>`
 * (`docs/analysis/backends-design.md` §1.1).
 *
 * Same `available:true|false` union, and for the same reason: "no store here" is
 * an answer, not an error. `kinds` is a `Record<string, number>` instead of five
 * fixed fields because the kinds are the backend's (Copilot has none of
 * opencode's cache tiers) — **kinds are never folded into one another and never
 * summed with another backend's**. `unit` is present only where the bill is not
 * tokens (Copilot: premium requests); absent means tokens.
 */
export type BackendTokensDoc =
  | {
      available: true;
      totals: { kinds: Record<string, number>; turns: number };
      /** `byModel` (optional, additive): the day split by model, largest first —
       *  absent where the ledger does not cross day × model. */
      days: { day: string; kinds: Record<string, number>; turns: number; byModel?: { key: string; kinds: Record<string, number>; turns: number }[] }[];
      models: { key: string; label: string; kinds: Record<string, number>; turns: number }[];
      /** Sessions counted. ABSENT where the ledger cannot count them — a slice of
       *  another ledger cut by model has no per-model conversation count, and a 0
       *  there would be a wrong number. */
      sessions?: number;
      /**
       * Where this document comes from when it is NOT a ledger of its own: the
       * claude-local slice of Claude's jsonl ledger says so here, and the screen
       * repeats it. Absent for a backend's own store.
       */
      sliceOf?: string;
      /** What the tokens cost, where a price is known — see `BackendLedgerCost`.
       *  Absent = this ledger is never priced (say so, never $0). */
      cost?: BackendLedgerCost;
      /** The unit when it is not tokens; `perDay` is keyed by the same local-zone day as `days`. */
      unit?: { name: string; perDay: Record<string, number> };
      firstAt: number | null;
      lastAt: number | null;
      scannedAt: number;
    }
  | {
      available: false;
      /** Why, in words a person can act on. Never empty, never a code. */
      reason: string;
    };

/**
 * A backend ledger's money, per MODEL, each in its own currency.
 *
 * `totals` is one entry per currency and never a sum across them. A model is
 * one of three things, never a fourth: priced (by the list or by the person's
 * `prices.json`), zero because the backend's own catalogue says it runs on this
 * machine (`zero: "local"`), or unpriced with the sentence that says how to add
 * a price. An unpriced model is never in `totals` and never a $0.
 */
export interface BackendLedgerCost {
  totals: { currency: string; total: number }[];
  models: (
    | { key: string; currency: string; total: number; source: "list" | "user" | "local"; pattern?: string }
    | { key: string; unpriced: string }
  )[];
  /** The file prices are read from, for the sentence that says how to add one. */
  pricesFile: string;
  /** Entries of that file that were refused, each a sentence. */
  problems?: string[];
}

