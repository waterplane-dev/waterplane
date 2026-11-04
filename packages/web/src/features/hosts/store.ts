/**
 * The host switcher's state. Written only by `actions.ts`.
 *
 * - `hosts` — the saved list and the active id, as `hosts.ts` read them. The
 *   list only changes by this page's own verbs (or a reload), so it is read at
 *   load and re-read after each verb.
 * - `view` — what the switcher sheet shows: the list, the add/edit form, or
 *   the pair form a deep link prefilled.
 * - `elsewhere` — the poll's last read of each OTHER desktop (`GET /api/attention`), by host id;
 *   memory only, so a reload starts with no number rather than an old one.
 * - the route chip — `hostRoute.ts` (root: the strip reads it too). `null` until the LAN
 *   runtime (`lanLink.ts`) writes it; the launcher door and the sheet draw
 *   its chip only when set.
 */
import type { PairTarget, SavedHost } from "@waterplane/shared";
import { createStore, useStore } from "../../sdk";
import { activeHost, listHosts } from "../../hosts";
import { isNativeShell } from "../../hostUrl";
import type { ElsewhereRead } from "./logic";

export interface HostsState { hosts: SavedHost[]; activeId: string | null }
export type SwitcherView =
  | { mode: "list" }
  | { mode: "add" }
  | { mode: "edit"; id: string }
  /** "Pair with code", prefilled from a pairing deep-link `…://pair` link — never redeemed until
   *  tapped. `typed`: opened from a host row on its own address, so the person types the code. */
  | { mode: "pair"; target: PairTarget; typed?: boolean };
export type { HostRouteView } from "../../hostRoute";

export function readHostsState(): HostsState {
  if (!isNativeShell()) return { hosts: [], activeId: null };
  return { hosts: listHosts(), activeId: activeHost()?.id ?? null };
}

export const hosts = createStore<HostsState>(readHostsState());
export const view = createStore<SwitcherView>({ mode: "list" });

export const elsewhere = createStore<Record<string, ElsewhereRead>>({});

export function useElsewhere(): Record<string, ElsewhereRead> {
  return useStore(elsewhere);
}

export function useHosts(): HostsState {
  return useStore(hosts);
}
export function useSwitcherView(): SwitcherView {
  return useStore(view);
}
/** The route chip's state lives in `hostRoute.ts` (written by `lanLink.ts`). */
export { useHostRoute } from "../../hostRoute";
