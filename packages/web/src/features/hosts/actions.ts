/**
 * The host switcher's verbs. Storage is `hosts.ts`'s; this file words the
 * questions and keeps `store.ts` in step.
 */
import { NOTIFICATIONS_SHELL_VIEW, parkedKeyFor, waitingTotal, type PairTarget, type SavedHost, type WaitingSummary } from "@waterplane/shared";
import { core } from "../../sdk";
import { askChoice, askConfirm } from "../../Confirm";
import { LS, lsGet } from "../../storage";
import { activeHost, browserKV, listHosts, realHosts, removeHost, setHostTlsOff, switchTo } from "../../hosts";
import { forgetUpdateKey } from "../../webUpdate";
import { api } from "../../api";
import { bearerForSaved, tokenForHost } from "../../deviceToken";
import { resyncShellLink, SHELL_NUDGE_EVENT } from "../../shellLink";
import { dialBaseOf, tokenWithheld } from "../../hostUrl";
import { routePinsChanged, syncShellPins } from "../../lanLink";
import { refusalFits } from "../../lanRoute";
import { hasShellTls, shellTls, shellTlsRefusal } from "../../sdk";
import {
  countHostWords, elsewhereRiseText, elsewhereRose, nextAskIn, nextRead, plainHttpDoneText, plainHttpLines, removeLines, rowPairTarget, type HostWords,
} from "./logic";
import { elsewhere, hosts, readHostsState, view } from "./store";
import { setHostRoute as setRoute, type HostRouteView } from "../../hostRoute";

export function refreshHosts(): void {
  hosts.set(readHostsState());
  // The background link watches every saved desktop: a desktop added, renamed, re-addressed or
  // removed re-points it (only when it is on, and only when the set changed — `shellLink.ts`).
  void resyncShellLink();
}

/** The desktop in use, or null (a browser; no host saved yet). */
export function activeDesktopId(): string | null {
  return activeHost()?.id ?? null;
}

/**
 * A tapped OS alert of ANOTHER desktop (`host:<id>|<rest>` from the background link): the tap is
 * the person's ask, so switch there and land on `rest` (the switch parks this desktop's drafts,
 * nothing is lost). Never called without a tap — nothing switches by itself. A desktop no longer
 * saved here is said, and nothing happens.
 */
export function openFromOtherDesktop(hostId: string, rest: string): void {
  const h = realHosts(listHosts()).find((x) => x.id === hostId);
  if (!h) { core().say.toast("That alert came from a desktop this phone no longer has saved."); return; }
  core().say.track("action:hosts.switchFromAlert");
  core().say.toast(`Switching to ${h.name}…`);
  // A summary of several items has no single target: land on the list that shows them.
  switchTo(h.id, rest || NOTIFICATIONS_SHELL_VIEW);
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

/** Pair by code on this row's own address: the way back from a changed key, an address that went
 *  quiet, or plain HTTP. The person types the code; nothing is sent until "pair". */
export function pairHostByCode(host: Pick<SavedHost, "base" | "lan">): void {
  core().say.track("action:hosts.pairByCode");
  refreshHosts();
  view.set({ mode: "pair", target: rowPairTarget(host), typed: true });
  core().nav.open("hosts");
}

/** `pairHostByCode` for the host in use: what a readout outside this feature opens. */
export function pairActiveByCode(): void {
  const h = activeHost();
  if (h) pairHostByCode(h);
}

async function switchToPlainHttp(host: SavedHost): Promise<void> {
  const kv = browserKV();
  const r = kv ? setHostTlsOff(kv, host.id, true) : { ok: false as const, why: "Could not reach this phone's saved desktops." };
  if (!r.ok) { core().say.toast(r.why); return; }
  // A pin that stays here is removed at the next boot (`syncShellPins`); the row already says plain.
  try { await shellTls.removePin(host.id); } catch { /* next boot */ }
  core().say.track("action:hosts.plainHttp");
  refreshHosts();
  routePinsChanged();
  core().say.toast(plainHttpDoneText(host.name));
}

/**
 * "Use plain HTTP for this desktop": the way out for a desktop with its encrypted link turned off,
 * reachable with no connection. Only a person's tap gets here. With a recorded refusal at this
 * desktop's address the same question leads with what that means and offers pairing by code first.
 */
export async function askPlainHttp(host: SavedHost): Promise<void> {
  const seen = await shellTlsRefusal();
  const changed = [host.base, host.lan?.base].some((b) => !!b && refusalFits(seen, b));
  if (!changed) {
    if (await askConfirm({ title: `Use plain HTTP for ${host.name}?`, lines: plainHttpLines(false), confirmLabel: "Use plain HTTP" })) await switchToPlainHttp(host);
    return;
  }
  const a = await askChoice({
    title: `${host.name}'s key changed`, lines: plainHttpLines(true), tone: "warn",
    confirmLabel: "Pair by code", altLabel: "Use plain HTTP", cancelLabel: "Cancel",
  });
  if (a?.ok) pairHostByCode(host);
  else if (a?.alt) await switchToPlainHttp(host);
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

/** One tap: park this host, restore that one, reload. `open` (a `shellOpen` string: a plugin's
 *  screen, a session id) is where the next boot lands — a tap on one waiting item elsewhere. */
export function switchHost(id: string, open?: string): void {
  core().say.track(open ? "action:hosts.switchTo" : "action:hosts.switch");
  if (!switchTo(id, open)) core().say.toast("already on that host");
}

/** "Waiting elsewhere": the sheet listing exactly the rows the chip counted. */
export function openElsewhere(): void {
  core().say.track("overlay:elsewhere");
  refreshHosts();
  core().nav.open("elsewhere");
}

// ── The poll of the other desktops ──────────────────────────────────────

/** The last total this page SAW per desktop (memory only): the toast fires on a rise, once. */
const seenTotal = new Map<string, number>();
/** When each desktop may be asked next (the backoff). */
const askAt = new Map<string, number>();
/** When each desktop was last asked: a focus or nudge asks again at once, but not twice in 10 s. */
const askedAt = new Map<string, number>();
const AGAIN_MIN_MS = 10_000;
/** A pass of asks is running (they are sequential, never one per desktop at once). */
let polling = false;

/** Ask every other saved desktop that is due, one after another. Only while the app is on screen. */
async function pollElsewhere(force: boolean): Promise<void> {
  if (polling) return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  const { hosts: list, activeId } = readHostsState();
  const others = realHosts(list).filter((h) => h.id !== activeId);
  polling = true;
  try {
    for (const h of others) {
      const now = Date.now();
      const due = (askAt.get(h.id) ?? 0) <= now;
      const again = force && now - (askedAt.get(h.id) ?? 0) >= AGAIN_MIN_MS;
      if (!due && !again) continue;
      askedAt.set(h.id, now);
      // A pinned LAN-only desktop is asked on its TLS address, like every other dial of it.
      const base = dialBaseOf(h, hasShellTls());
      const url = `${base}/api/attention`;
      // That desktop's OWN parked token, and only to its saved origin (`bearerForSaved`).
      const auth = bearerForSaved({ ...h, base }, tokenForHost(h.id), url);
      let res: { status: number; summary: WaitingSummary | null } = { status: 0, summary: null };
      // Withheld reads as no answer: asked without the token, it would say this phone is signed out.
      if (!tokenWithheld(base, h)) {
        try { res = await api.waitingAt(base, auth); } catch { /* no answer */ }
      }
      const at = Date.now();
      const read = nextRead(elsewhere.get()[h.id], at, res);
      elsewhere.set((prev) => ({ ...prev, [h.id]: read }));
      askAt.set(h.id, at + nextAskIn(read.fails));
      if (res.summary) {
        const total = waitingTotal(res.summary);
        if (elsewhereRose(seenTotal.get(h.id), total)) core().say.toast(elsewhereRiseText(h, res.summary));
        seenTotal.set(h.id, total);
      }
    }
  } finally {
    polling = false;
  }
}

/**
 * Start asking the other desktops (the manifest's `boot`, shell only, two or more of the
 * person's own desktops, never a passive device). Every 45 s while visible, at once when the
 * app comes back on screen, gains focus or the shell nudges it; nothing while hidden. Returns
 * the stop. Never switches anything: the chip and the sheet are the way, a tap the decision.
 */
export function startElsewherePoll(): () => void {
  const tick = () => { void pollElsewhere(false); };
  const now = () => { void pollElsewhere(true); };
  const onVisible = () => { if (document.visibilityState === "visible") now(); };
  const timer = setInterval(tick, 5_000);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", now);
  window.addEventListener(SHELL_NUDGE_EVENT, now);
  now();
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", now);
    window.removeEventListener(SHELL_NUDGE_EVENT, now);
  };
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
  // Before the row goes: its id is the only name the native pin has, and a switch reloads the page.
  const noKey = await forgetUpdateKey(host);
  const r = removeHost(host.id);
  // The host in use goes through a reload, and its boot does the same.
  if (r === "dropped") { refreshHosts(); void syncShellPins(); core().say.toast(noKey ? `${host.name} removed` : `${host.name} removed. This phone keeps its update key, so unsigned updates stay refused.`); }
  else if (r === null) core().say.toast("could not remove that host");
}
