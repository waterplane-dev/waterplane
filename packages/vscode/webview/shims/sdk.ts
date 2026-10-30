/**
 * The webview's `@waterplane/sdk`: just what the token-stats screen (`TokenStatsBody` and the cards
 * under it) imports — `ledgers`, the dollar-period words and their types. The full SDK reaches the
 * phone's socket, its IndexedDB and the extension registry, none of which exist in a VS Code webview.
 *
 * `ledgers` reads through the phone's own `statsApi` (`webapiStats.ts`, every path spelled once),
 * whose `jget` is this webview's (`shims/jget.ts`): the extension host asks a waterplane desktop on
 * this machine. With none there, every read REJECTS with that sentence and the card that asked
 * draws its own absence — never a zero. No contributed ledger views: those are other extensions'
 * code (opencode's is private), so a backend with a ledger is a generic tab here.
 */
import type { UsageSourceHistoryDoc } from "@waterplane/shared";
import { statsApi } from "../../../web/src/webapi/webapiStats.ts";

export {
  modelRows, pacing, pacingLine, periodCap, periodReadSpan, periodTitle, primaryUsdPeriod, usdWords,
  type ModelRow, type Pacing,
} from "../../../web/src/periodWords.ts";
export type { LedgerSummary, LedgerViewDef, LedgerViewParts } from "../../../web/src/sdk/types.ts";

const never = (): Promise<never> => Promise.reject(new Error("the VS Code panel keeps no copy of this ledger"));
const noCache = { fromCache: async () => null, toCache: async () => {} };

export const ledgers = {
  /** Claude's ledger is the panel's own scan (`CorpusDoc`), handed to the body as `doc` — never read here. */
  tokenStats: { read: never, ...noCache },
  views: () => [] as const,
  viewDoc: () => ({ read: never, ...noCache }),
  backendTokens: statsApi.backendTokens,
  localUsage: statsApi.localUsage,
  usageLog: statsApi.usageLog,
  /** The phone's rule (`sdk/ledgers.ts`): any failure or a bad shape is absent, never a guess. */
  sourceHistory: async (source: string, signal?: AbortSignal): Promise<UsageSourceHistoryDoc | null> => {
    try {
      const d = await statsApi.usageLogSource(source, signal);
      return d && Array.isArray(d.samples) ? d : null;
    } catch { return null; }
  },
  tokenWindows: statsApi.tokenWindows,
  costWindow: statsApi.costWindow,
  /** No scrape from here: the reading is whatever the desktop last took. */
  refreshUsage: (): void => {},
};
