/**
 * Every writer of the limits store, and every frame the sheet and the toolbar
 * toggle send. All live-only: a limit decision replayed an hour later is a
 * decision about a situation that has moved on.
 */
import { netRetryToggleText, type LimitResumeMode, type NetRetryConfig } from "@waterplane/shared";
import { core } from "../../sdk";
import { modeToast, overrideToast } from "./logic";
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

/** `netretry.config`: the host's saved switch and whether its environment overrides it. */
export function onNetRetryConfig(msg: NetRetryConfig): void {
  netRetryCfg.set({ enabled: msg.enabled === true, ...(msg.envOff ? { envOff: true } : {}) });
}

/** The Settings switch. Off also cancels every pending retry on the desktop. */
export function setNetRetry(enabled: boolean, envOff = false): void {
  core().conn.liveSend({ t: "netretry.set", enabled }, netRetryToggleText(enabled, envOff));
}
