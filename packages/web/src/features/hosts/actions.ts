/**
 * The host switcher's verbs. Storage is `hosts.ts`'s; this file words the
 * questions and keeps `store.ts` in step.
 */
import { parkedKeyFor, type PairTarget, type SavedHost } from "@waterplane/shared";
import { core } from "../../sdk";
import { askConfirm } from "../../Confirm";
import { LS, lsGet } from "../../storage";
import { removeHost, switchTo } from "../../hosts";
import { countHostWords, removeLines, type HostWords } from "./logic";
import { hosts, readHostsState, view } from "./store";
import { setHostRoute as setRoute, type HostRouteView } from "../../hostRoute";

export function refreshHosts(): void {
  hosts.set(readHostsState());
}

/** Open the switcher on its list. */
export function openHosts(): void {
  refreshHosts();
  view.set({ mode: "list" });
  core().nav.open("hosts");
}
export function showAddHost(): void { view.set({ mode: "add" }); }

/** A pairing deep-link `…://pair` link arrived (`shellLink.onShellPair`): open the pair form
 *  prefilled. Any app can fire that link, so this ASKS — the redeem is the
 *  person's tap on pair (`PairForm.tsx`). */
export function askPairFromLink(target: PairTarget): void {
  core().say.track("action:hosts.pairLink");
  refreshHosts();
  view.set({ mode: "pair", target });
  core().nav.open("hosts");
}

/** "Pair another phone": the QR sheet. Mints on the ACTIVE host (the one
 *  this page talks to), so the switcher offers it on that row only. */
export function openPairQr(): void {
  core().say.track("overlay:pairqr");
  core().nav.open("pairqr");
}

/** Settings → Connection → paired devices. */
export function openPairedDevices(): void {
  core().say.track("overlay:devices");
  core().nav.open("devices");
}
export function showEditHost(id: string): void { view.set({ mode: "edit", id }); }

/** Straight to the form of the host IN USE — where its LAN address, Wi-Fi
 *  names and "switch to LAN automatically" are changed. Opened from the
 *  sentence that reports them (Connection health → Link right now). No saved
 *  active host (never, once the shell has booted one) ⇒ the list instead. */
export function openEditActiveHost(): void {
  core().say.track("action:hosts.editActive");
  refreshHosts();
  const id = hosts.get().activeId;
  view.set(id ? { mode: "edit", id } : { mode: "list" });
  core().nav.open("hosts");
}
export function showHostList(): void { refreshHosts(); view.set({ mode: "list" }); }

/** P4's seam: the route the active host is on now, or null (unknown). */
export function setHostRoute(r: HostRouteView | null): void {
  setRoute(r);
}

/** One tap: park this host, restore that one, reload. */
export function switchHost(id: string): void {
  core().say.track("action:hosts.switch");
  if (!switchTo(id)) core().say.toast("already on that host");
}

/** A host's unsent words, read where they are: bare for the active host,
 *  under its parked prefix for any other. */
export function wordsOf(id: string, activeId: string | null): HostWords {
  const get = id === activeId ? (k: string) => lsGet(k) : (k: string) => lsGet(parkedKeyFor(k, id));
  return countHostWords(get, {
    composeDrafts: LS.composeDrafts, composeSheets: LS.composeSheets, compose: LS.compose,
    backlogDraft: LS.backlogDraft, fanoutText: LS.fanoutText, pad: LS.pad,
    composeOutbox: LS.composeOutbox, outbox: LS.outbox,
  });
}

/** Remove, once asked — with the count of what stays saved stated first. */
export async function confirmRemoveHost(host: SavedHost): Promise<void> {
  const { hosts: list, activeId } = readHostsState();
  const active = host.id === activeId;
  const next = active ? list.find((h) => h.id !== host.id) ?? null : null;
  const ok = await askConfirm({
    title: `Remove ${host.name}?`,
    lines: removeLines(wordsOf(host.id, activeId), active, next),
    confirmLabel: "Remove",
  });
  if (!ok) return;
  core().say.track("action:hosts.remove");
  const r = removeHost(host.id);
  if (r === "dropped") { refreshHosts(); core().say.toast(`${host.name} removed`); }
  else if (r === null) core().say.toast("could not remove that host");
}
