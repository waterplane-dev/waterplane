/**
 * The host's network-error retry switch (`netretry.config`, host
 * `netretrycfg.ts`, R-connection-025) and the two frames that act on a retry
 * from more than one screen: the switch itself and "Retry now"
 * (`session.netRetryNow`, host `sessions/apiretry.ts`'s `retryNow`).
 *
 * TOP-LEVEL rather than in `features/limits`, because three places that are not
 * that feature draw these: the stalled backlog row (`backlog/`), the stalled
 * Activity row (`activity/`) and the session's retry line (`core/session/
 * NetRetryBar.tsx`) — and a feature is imported only by App and core.
 * `features/limits` re-exports the store and keeps its ONE writer
 * (`onNetRetryConfig`). Both sends are live-only: a switch or a retry delivered
 * an hour late speaks for a situation that has moved on.
 */
import { NET_RETRY_NOW_SENT, netRetryToggleText, type NetRetryConfig } from "@waterplane/shared";
import { core, createStore, useStore } from "./sdk";

/** Null until the host has said: an older host never sends it, and every switch
 *  drawn off it is then ABSENT rather than a switch that reaches nothing. */
export const netRetryCfg = createStore<NetRetryConfig | null>(null);

export function useNetRetryCfg(): NetRetryConfig | null {
  return useStore(netRetryCfg);
}

/** The switch, from Settings or a stalled row. Off also cancels every PENDING
 *  retry on the desktop (a `gaveup` stays — a stalled row stands on it). */
export function setNetRetry(enabled: boolean, envOff = false): void {
  core().conn.liveSend({ t: "netretry.set", enabled }, netRetryToggleText(enabled, envOff));
}

/** "Retry now": the host types `continue` the way its own retry does. */
export function netRetryNow(sessionId: string): void {
  core().conn.liveSend({ t: "session.netRetryNow", id: sessionId }, NET_RETRY_NOW_SENT);
}
