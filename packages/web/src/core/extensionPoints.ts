/**
 * The ONE registry reader for the extension points that are not a sheet or a wire message: repo
 * actions, repo chips, session views, launcher items, setup-row words and the token statistics sheet's ledger views (bound into
 * `ledgers.views()`, sdk, because the extension that draws them reaches core only through the SDK). Consumers (`RepoGroup`) import from here and
 * never the registry (`local/feature-boundary`); the setup-row words are BOUND into `setupRemedy.ts`'s
 * `setupRows()` for `SetupSheet`, the same way and for the same reason as the ledger views.
 *
 * Every table is LAZY. `features/setup` imports `SetupSheet`, which imports this, which would import
 * the registry, which imports `features/setup` — built at module load that is a cycle reading an
 * undefined `FEATURES`. Built on first call, the registry is long since initialised.
 */
import { logTag } from "@waterplane/shared";
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import { FEATURES } from "../features/registry.ts";
import { bindSetupRows, setupRowLookup, type SetupRowLookup } from "../setupRemedy.ts";
import { core } from "./api.ts";
import {
  createLauncherItemTable, createMenuItemTable, createSecretFillerTable, createRepoActionTable, createRepoChipList, createSessionViewTable, menuItemCatalog, setupRowDefs, type ContributedEntry, type RepoActionItem,
} from "./featureRun.ts";
import { bindLedgerViews } from "../sdk/ledgers.ts";
import { bindMenuCatalog } from "../toolbar.ts";
import type { FeatureManifest, LedgerViewDef, SecretFillContext } from "../sdk/types.ts";

let actionTable: ReturnType<typeof createRepoActionTable> | null = null;
let chips: ReturnType<typeof createRepoChipList> | null = null;
let rows: SetupRowLookup | null = null;
let views: readonly LedgerViewDef<any>[] | null = null;
let sessionViewTable: ReturnType<typeof createSessionViewTable> | null = null;
let launcherItemTable: ReturnType<typeof createLauncherItemTable> | null = null;
let menuItemTable: ReturnType<typeof createMenuItemTable> | null = null;
let secretFillerTable: ReturnType<typeof createSecretFillerTable> | null = null;
let menuCatalog: ReturnType<typeof menuItemCatalog> | null = null;

/** The menu lines extensions offer for this repo, registry order. */
export const repoActions = (repo: RepoTarget): RepoActionItem[] => (actionTable ??= createRepoActionTable(FEATURES, core)).actions(repo);

/** The views extensions add to a session's header segment (`SessionViewDef`); [] when none does,
 *  which leaves the header exactly as it was. */
export const sessionViews = (sessionId: string): ContributedEntry[] =>
  (sessionViewTable ??= createSessionViewTable(FEATURES, core)).views(sessionId);

/** The buttons extensions add to the launcher's header row (`LauncherItemDef`); [] when none does. */
export const launcherItems = (): ContributedEntry[] => (launcherItemTable ??= createLauncherItemTable(FEATURES, core)).items();

/**
 * A tapped alert from plugin `pluginId` (a vault fingerprint ask has no session): open its screen
 * through its first launcher item, which for the vault is the home that shows live asks. An unknown
 * id, or an item that is unavailable right now, does nothing beyond the app being open. True if opened.
 */
export function openPluginFromNotification(pluginId: string): boolean {
  const e = launcherItems().find((x) => x.feature === pluginId && !x.unavailable);
  if (!e) return false;
  e.open();
  return true;
}

/** The ☰ lines extensions add for this session (`MenuItemDef`), each keyed by its catalog id. */
export const menuItems = (active: SessionInfo): ContributedEntry[] => (menuItemTable ??= createMenuItemTable(FEATURES, core)).items(active);
// `toolbar.ts` is imported by the registry's own features (`toolbarCfg`), so it reads the contributed
// catalog through a binding rather than importing this module — the same cycle as `setupRows`.
bindMenuCatalog(() => (menuCatalog ??= menuItemCatalog(FEATURES)));

/** The buttons extensions add to the masked password field's row (`SecretFillerDef`); [] when none does. */
export const secretFillers = (ctx: SecretFillContext): ContributedEntry[] =>
  (secretFillerTable ??= createSecretFillerTable(FEATURES, core)).items(ctx);

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
// `SetupSheet` reads them through `setupRemedy.ts`'s `setupRows()`, never this module: it is drawn
// by `features/setup`, which the registry imports, so importing this would close a cycle.
bindSetupRows(setupRows);

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
