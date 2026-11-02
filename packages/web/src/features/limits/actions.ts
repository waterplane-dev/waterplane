/**
 * Every writer of the limits store, and every frame the sheet and the toolbar
 * toggle send. All live-only: a limit decision replayed an hour later is a
 * decision about a situation that has moved on.
 */
import type { LimitResumeMode, NetRetryConfig } from "@waterplane/shared";
import { core } from "../../sdk";
import { continueQueueLabel, continueQueuedToast, modeToast, overrideToast } from "./logic";
import { limitCfg, netRetryCfg } from "./store";

/** `limit.config`: the switch and the hold always; the mode only when sent (an
 *  older host omits it, and the last known mode stands). */
export function onLimitConfig(msg: { enabled: boolean; holdUntil: number | null; mode?: LimitResumeMode }): void {
  limitCfg.set((prev) => ({ auto: msg.enabled, hold: msg.holdUntil ?? null, mode: msg.mode ?? prev.mode }));
}

export function setGlobalAuto(enabled: boolean): void {
  core().conn.liveSend({ t: "limit.setAuto", enabled }, `auto-continue ${enabled ? "on" : "off"}`);
}

export function setResumeMode(mode: LimitResumeMode): void {
  const c = core();
  c.conn.send({ t: "limit.setMode", mode });
  c.say.toast(modeToast(mode));
}

export function setSessionOverride(id: string, override: boolean | null): void {
  core().conn.liveSend({ t: "limit.session", id, override }, "saved for this session");
}

/** The toolbar toggle's tap: one step of the override cycle, said with what
 *  `inherit` means right now. */
export function cycleSessionOverride(id: string, next: boolean | null): void {
  const c = core();
  c.conn.send({ t: "limit.session", id, override: next });
  c.say.toast(overrideToast(next, limitCfg.get().auto));
}

export function setResumeFirst(id: string, on: boolean): void {
  core().conn.liveSend({ t: "limit.first", id, on }, on ? "this one resumes first" : "resume order cleared");
}

export function resumeNow(id?: string): void {
  const c = core();
  c.conn.send({ t: "limit.resume", id });
  c.say.toast(id ? "resuming that session…" : "starting the queue…");
}

/**
 * The person's *continue* after a sign-in (`signin.continue`): the DURABLE path
 * (`queueOp`, an ackId), like every op the host must take at most once — the
 * host de-dupes on the ackId and, delivered late, types only into sessions still
 * waiting, so the tap is safe to keep through a dead tunnel. One lane for the
 * account. Online the receipt is the host's own sentence (`onOpAck` toasts it,
 * naming any id that was not waiting); offline the toast says it was kept.
 */
export function continueSignedIn(ids: readonly string[]): void {
  if (!ids.length) return;
  const c = core();
  const offline = c.queue.queueOp({ t: "signin.continue", ids: [...ids] }, "signin", continueQueueLabel(ids.length));
  if (offline) c.say.toast(continueQueuedToast(ids.length));
}

/** `netretry.config`: the host's saved switch and whether its environment overrides it. */
export function onNetRetryConfig(msg: NetRetryConfig): void {
  netRetryCfg.set({ enabled: msg.enabled === true, ...(msg.envOff ? { envOff: true } : {}) });
}

/** The Settings switch (also on a stalled row): one sender, `netRetryCfg.ts`'s. */
export { setNetRetry } from "../../netRetryCfg";
