/**
 * Everything a tap in the updates area sends, and the handlers for `updates.*`.
 *
 * `updates.apply` changes the desktop, so it asks first (`askConfirm`) and goes out ONCE, live:
 * it is never queued (an update delivered an hour later is a decision about a machine that has
 * moved on) and never retried. Its `ackId` is its own `reqId`, so a host that does see a repeat
 * re-acks instead of running it twice.
 */
import type { HostMessage, UpdatesTarget } from "@waterplane/shared";
import { core } from "../../sdk";
import { askConfirm } from "../../Confirm";
import { seqId } from "../../format";
import { activeHost } from "../../hosts";
import { LS, lsGet, lsSet } from "../../storage";
import { installConfirm, receiptDue, receiptWords, rollbackConfirm, selfConfirm, updatePluginConfirm, urlConfirm } from "./logic";
import { applies, checking, targetKey, updatesStatus } from "./store";

const OFFLINE = "no connection — updates run on the desktop and can't be started from here";

/** The active desktop's name, as the person calls it (hosts.ts). */
export function desktopLabel(): string {
  return activeHost()?.name || "the desktop";
}

export function askStatus(): void {
  core().conn.liveAsk({ t: "updates.get" }, OFFLINE);
}

export function checkNow(): void {
  if (core().conn.liveAsk({ t: "updates.check" }, "no connection — the desktop can't be asked to check from here")) checking.set(true);
}

/** Confirm, then send one apply. Resolves false when the person said no or the link is down. */
export async function applyTarget(target: UpdatesTarget, question: string, confirmLabel: string): Promise<boolean> {
  if (!(await askConfirm({ title: question, confirmLabel }))) return false;
  const reqId = seqId("up");
  if (!core().conn.liveAsk({ t: "updates.apply", target, reqId, ackId: reqId }, OFFLINE)) return false;
  applies.set({ ...applies.get(), [targetKey(target)]: { reqId, target, pending: true, at: Date.now() } });
  return true;
}

export function onStatus(msg: Extract<HostMessage, { t: "updates.status" }>): void {
  const prev = updatesStatus.get();
  const st = msg.status;
  updatesStatus.set(st);
  checking.set(false);
  // An apply still "working" when the link dropped is settled by what the host kept (`lastApply`).
  const la = st.lastApply;
  if (la) {
    const cur = applies.get();
    const k = targetKey(la.target);
    const a = cur[k];
    if (a && a.pending && la.at >= a.at - 5000) {
      applies.set({ ...cur, [k]: { reqId: a.reqId, target: a.target, pending: false, ok: la.ok, message: la.message, restart: la.restart } });
    }
  }
  // The receipt an apply leaves across a drop or restart: said ONCE, keyed on its own timestamp. The
  // newest of `lastApply` and a self update's `lastResult` (they are one event for a self apply).
  const lr = st.self.lastResult;
  const last: { ok: boolean; message: string; at: number } | undefined =
    la && (!lr || la.at >= lr.at) ? la : lr;
  const seen = Number(lsGet(LS.updatesReceiptSeen));
  if (last && receiptDue(last, Number.isFinite(seen) && seen > 0 ? seen : null, Date.now())) {
    lsSet(LS.updatesReceiptSeen, String(last.at));
    // Already said by the live `updates.result` of this tap: do not say it twice.
    const same = la && last === la ? applies.get()[targetKey(la.target)] : undefined;
    const spoken = !!same && !same.pending && same.message === last.message;
    if (!spoken) core().say.toast(receiptWords(last, !!prev && prev.self.current !== st.self.current));
  } else if (last && !(seen > 0)) {
    lsSet(LS.updatesReceiptSeen, String(last.at));
  }
}

export function onResult(msg: Extract<HostMessage, { t: "updates.result" }>): void {
  const cur = applies.get();
  const key = Object.keys(cur).find((k) => cur[k].reqId === msg.reqId);
  if (!key) return;
  applies.set({ ...cur, [key]: { reqId: msg.reqId, target: cur[key].target, pending: false, ok: msg.ok, message: msg.message, restart: msg.restart } });
  core().say.toast(msg.message);
}

// ── the verbs a button names (each asks first, in the words `updatesLogic` pins) ──

export function installFromOrg(repo: string, name: string, ref: string | null, origin: { fromOrg: boolean; url: string }): void {
  void applyTarget({ kind: "plugin-install", repo }, installConfirm({ name, ref, desktop: desktopLabel(), ...origin }), "install");
}

export function installFromUrl(url: string): Promise<boolean> {
  return applyTarget({ kind: "plugin-install", url }, urlConfirm({ url, desktop: desktopLabel() }), "install");
}

export function updatePlugin(id: string, name: string, from: string | undefined, to: string, origin: { fromOrg: boolean; url: string }): void {
  void applyTarget({ kind: "plugin-update", id }, updatePluginConfirm({ name, from, to, desktop: desktopLabel(), ...origin }), "update");
}

export function updateSelf(current: string, to: string): void {
  void applyTarget({ kind: "self" }, selfConfirm({ desktop: desktopLabel(), current, to }), "update");
}

export function rollbackSelf(current: string, to: string): void {
  void applyTarget({ kind: "self-rollback" }, rollbackConfirm({ desktop: desktopLabel(), current, to }), "roll back");
}

/** Only drawn after a result that said the host can bring itself back (`resultView().restartButton`). */
export function restartDesktop(): void {
  void applyTarget({ kind: "restart" }, `Restart ${desktopLabel()}? Sessions keep running.`, "restart");
}

/** Open the updates sheet, asking the host for a fresh copy of what it knows (a read, no check). */
export function openUpdates(): void {
  const c = core();
  askStatus();
  c.say.track("overlay:updates");
  c.nav.open("updates");
}
