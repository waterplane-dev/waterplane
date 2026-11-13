/**
 * The links sheet's state and its ONE writer. Every host answer comes through `client` (`plugin.call`
 * on the one socket — never a second transport); the store is written only by the actions here.
 *
 * The host's one push, `changed`, means "read `state` again" (a discovery half finished).
 */
import { core, createStore, featureSheetId, openExternal, pluginClient, type PluginCallResult } from "@waterplane/sdk";
import { askConfirm } from "@waterplane/kit";
import type { LinkEnv, LinksMethods, LinksState, PinnedView } from "../shared/wire.mts";
import { NO_FACETS, type Facets, type GroupBy, type RepoCut } from "./logic.ts";

export const LINKS_SHEET = featureSheetId("links", "main");
const client = pluginClient<LinksMethods>("links");

export interface LinksView {
  res: PluginCallResult<LinksState> | null;
  at: number | null;
  /** The repo the sheet is cut to (from a repo chip), or null = every repo. */
  cut: RepoCut;
  showHidden: boolean;
  /** The search box's words — kept while the sheet is closed, cleared by its × or by a chip. */
  q: string;
  /** The chip filters (env, where, up/down) — kept while the sheet is closed, like the search. */
  facets: Facets;
  groupBy: GroupBy;
  /** Folded group headers, `pin|<group key>` / `found|<group key>`. */
  folded: string[];
}
export const links = createStore<LinksView>({ res: null, at: null, cut: null, showHidden: false, q: "", facets: NO_FACETS, groupBy: "repo", folded: [] });

const take = (res: PluginCallResult<LinksState>) => {
  // A failed write answers an error; keep the last good list on screen and say the error in a toast.
  if (!res.ok && links.get().res?.ok) { core().say.toast(res.error); return; }
  links.set((v) => ({ ...v, res, at: Date.now() }));
};

let reading: Promise<void> | null = null;
/** Cheap: the host only re-reads its pins file. Joined while one is in flight. */
export function readState(): Promise<void> {
  if (core().conn.status !== "open") return Promise.resolve();
  return (reading ??= client.read("state", {}).then(take).finally(() => { reading = null; }));
}

let askedLook = false;
/**
 * For the repo chips: read once when nothing has been read, or the last read is a minute old. When
 * the desktop has not looked at all since it started, ask it to look ONCE per page load, so a repo
 * with nothing pinned can still say what was found (its `changed` push re-reads). Each half's own
 * cache still applies, so this never adds a look the sheet opening would not have made.
 */
export function readIfStale(): void {
  const v = links.get();
  if (v.at && Date.now() - v.at <= 60_000) return;
  void readState().then(() => {
    const r = links.get().res;
    if (askedLook || !r?.ok || r.result.localAt != null || r.result.cloudAt != null) return;
    askedLook = true;
    void client.read("discover", {}).then(take);
  });
}

/** Opening the sheet: look again (each half only when its cache is stale), then check every pin. */
export async function lookOnOpen(cloud = false): Promise<void> {
  if (core().conn.status !== "open") return;
  take(await client.read("discover", cloud ? { cloud: true } : {}));
  take(await client.read("probe", {}));
}

async function act<K extends "pin" | "add" | "edit" | "unpin">(m: K, args: LinksMethods[K]["args"], done?: string): Promise<boolean> {
  const res = await client.call(m, args);
  if (res.ok) { links.set((v) => ({ ...v, res, at: Date.now() })); if (done) core().say.toast(done); return true; }
  core().say.toast(`not saved: ${res.error}`);
  return false;
}

export const pinFound = (key: string) => act("pin", { key }, "pinned");
export const addLink = (a: { label: string; url: string; repo: string | null; env: LinkEnv }) => act("add", a, "pinned");
export const editLink = (id: string, patch: { label?: string; env?: LinkEnv; repo?: string | null }) => act("edit", { id, ...patch });

export async function unpinLink(p: PinnedView): Promise<void> {
  const ok = await askConfirm({ title: `Unpin ${p.label}?`, lines: ["It stays in the found list while it is still running or deployed, so it can be pinned again."], confirmLabel: "Unpin", tone: "info" });
  if (ok) await act("unpin", { id: p.id }, `unpinned ${p.label}`);
}

export function openLink(url: string): void {
  if (!openExternal(url)) core().say.toast(`could not open ${url} — the browser blocked it`);
}

export function openLinks(cut: RepoCut = null): void {
  // A chip's count is the cut it opens: words left in the box or a chip filter would hide some of
  // those n, and "show all" would add hidden found rows the "found n" chip did not count.
  links.set((v) => ({ ...v, cut, q: cut ? "" : v.q, facets: cut ? NO_FACETS : v.facets, showHidden: cut ? false : v.showHidden }));
  core().nav.open(LINKS_SHEET);
}

export const clearCut = () => links.set((v) => ({ ...v, cut: null }));
export const setQuery = (q: string) => links.set((v) => ({ ...v, q }));
export const setShowHidden = (showHidden: boolean) => links.set((v) => ({ ...v, showHidden }));
export const setFacet = <K extends keyof Facets>(k: K, val: Facets[K]) => links.set((v) => ({ ...v, facets: { ...v.facets, [k]: val } }));
export const clearFacets = () => links.set((v) => ({ ...v, facets: NO_FACETS }));
export const setGroupBy = (groupBy: GroupBy) => links.set((v) => ({ ...v, groupBy }));
export const toggleFold = (key: string) => links.set((v) => ({ ...v, folded: v.folded.includes(key) ? v.folded.filter((k) => k !== key) : [...v.folded, key] }));
/** Collapse every group given. */
export const collapseAll = (keys: string[]) => links.set((v) => ({ ...v, folded: [...new Set([...v.folded, ...keys])] }));
/** Expand every group given. */
export const expandAll = (keys: string[]) => links.set((v) => ({ ...v, folded: v.folded.filter((k) => !keys.includes(k)) }));
export const closeLinks = () => core().nav.close(LINKS_SHEET);

/** The host's `changed` push. */
export function onChanged(): void {
  void readState();
}
