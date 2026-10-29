/**
 * The person-facing switch for the host's retry of a turn the CLI gave up on a
 * transient API error (`netretry.ts`, host `sessions/apiretry.ts`,
 * R-connection-024/025). Persisted on the HOST (`<state dir>/netretry.json`),
 * because whether this desktop types `continue` by itself is a fact about the
 * desktop, not about the phone that set it — the auto-continue precedent.
 *
 * The env knob stays a hard override: `WATERPLANE_NET_RETRY=0` turns the retry
 * off whatever the switch says, and the host says so (`envOff`) so the phone can
 * print the sentence below instead of a switch that does nothing.
 */
import { envName } from "./brand.js";

/** `netretry.config` (host → phone, on hello and on every change). `enabled` is
 *  the saved switch; `envOff` is present only when the environment forces it off. */
export interface NetRetryConfig { enabled: boolean; envOff?: true }

/** Is the retry actually on: the switch, unless the environment overrides it. */
export function netRetryEffective(c: NetRetryConfig): boolean {
  return c.enabled && !c.envOff;
}

/** The one sentence for an environment-forced off — phone and host log alike. */
export function netRetryEnvOffText(): string {
  return `Off on this desktop: ${envName("NET_RETRY")}=0 is set in its environment, and that wins over this switch. Remove it there and restart the host to use the switch.`;
}

/** The receipt for a tap on the switch; `envOff` ⇒ saved, but the environment still wins. */
export function netRetryToggleText(enabled: boolean, envOff = false): string {
  if (envOff) return `saved ${enabled ? "on" : "off"} — still off on this desktop while its environment says so`;
  return enabled ? "network-error retry on" : "network-error retry off — pending retries cancelled";
}
