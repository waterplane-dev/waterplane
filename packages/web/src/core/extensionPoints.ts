/**
 * The ONE registry reader for the extension points that are not a sheet or a wire message: repo
 * actions, repo chips, setup-row words and the token statistics sheet's ledger views (bound into
 * `ledgers.views()`, sdk, because the extension that draws them reaches core only through the SDK). Consumers (`RepoGroup`, `SetupSheet`) import from here and
 * never the registry (`local/feature-boundary`).
 *
 * Every table is LAZY. `features/setup` imports `SetupSheet`, which imports this, which would import
 * the registry, which imports `features/setup` — built at module load that is a cycle reading an
 * undefined `FEATURES`. Built on first call, the registry is long since initialised.
 */
import { logTag } from "@waterplane/shared";
import type { RepoTarget } from "@waterplane/shared";
import { FEATURES } from "../features/registry.ts";
import { setupRowLookup, type SetupRowLookup } from "../setupRemedy.ts";
import { core } from "./api.ts";
import { createRepoActionTable, createRepoChipList, setupRowDefs, type RepoActionItem } from "./featureRun.ts";
import { bindLedgerViews } from "../sdk/ledgers.ts";
import type { FeatureManifest, LedgerViewDef } from "../sdk/types.ts";

let actionTable: ReturnType<typeof createRepoActionTable> | null = null;
let chips: ReturnType<typeof createRepoChipList> | null = null;
let rows: SetupRowLookup | null = null;
let views: readonly LedgerViewDef<any>[] | null = null;

/** The menu lines extensions offer for this repo, registry order. */
export const repoActions = (repo: RepoTarget): RepoActionItem[] => (actionTable ??= createRepoActionTable(FEATURES, core)).actions(repo);

/** Every repo chip def, registry order. */
export const repoChips = () => (chips ??= createRepoChipList(FEATURES));

/** The contributed setup-row words. */
export const setupRows = (): SetupRowLookup => {
  if (!rows) {
    rows = setupRowLookup(setupRowDefs(FEATURES));
    if (rows.refused.length) console.error(`${logTag} setup rows refused (they name a core guidance key or fix): ${rows.refused.join(", ")}`);
  }
  return rows;
};

/**
 * Every contributed ledger view, registry order. An id of `claude` (the sheet's own first tab) or one
 * an earlier manifest took is refused — two tabs reading one document would be one ledger counted
 * twice on the screen that exists to refuse that — and said once.
 */
export function ledgerViewDefs(features: readonly FeatureManifest[]): { views: LedgerViewDef<any>[]; refused: string[] } {
  const out: LedgerViewDef<any>[] = [];
  const refused: string[] = [];
  for (const f of features) {
    for (const v of f.ledgerViews ?? []) {
      if (v.id === "claude" || out.some((o) => o.id === v.id)) refused.push(`${f.id}:${v.id}`);
      else out.push(v);
    }
  }
  return { views: out, refused };
}

bindLedgerViews(() => {
  if (!views) {
    const r = ledgerViewDefs(FEATURES);
    if (r.refused.length) console.error(`${logTag} ledger views refused (claude, or an id already taken): ${r.refused.join(", ")}`);
    views = r.views;
  }
  return views;
});
