/**
 * What a "test" button under one of a desktop's addresses says (pure; `HostSetup.tsx`). Each address has its own button and its
 * own sentence: the tailnet one names the folder the daemon serves, the Wi-Fi one says whether that desktop PROVED it is the one
 * (`lanLink.ts testLanAddress`, the HMAC check the route itself uses) — after a DHCP shuffle another device can own the old address.
 */
import { normalizeHostBase } from "@waterplane/shared";

/** One LAN test. `proven`: true = the desktop answered the identity check, false = something answered and failed it, null = not checked (no identity on this phone for this desktop). */
export type LanTest = { s: "ok"; ms: number; proven: boolean | null } | { s: "bad"; aborted: boolean };

export const ms = (n: number): string => `${Math.max(1, Math.round(n))} ms`;

export function tailnetOkWords(took: number, root: string): string {
  return `Reached in ${ms(took)}: the desktop serving ${root}.`;
}

export function lanTestWords(t: LanTest): { tone: "ok" | "warn" | "dead"; text: string } {
  if (t.s === "bad") {
    return { tone: "dead", text: t.aborted
      ? "No answer within 4 s. The desktop's Wi-Fi address may have changed, or this phone is not on that Wi-Fi."
      : "Could not reach that address. Check that this phone is on the same Wi-Fi as the desktop." };
  }
  if (t.proven === true) return { tone: "ok", text: `Reached in ${ms(t.ms)}: this desktop proved who it is.` };
  if (t.proven === false) return { tone: "dead", text: `Something answered in ${ms(t.ms)}, but it is not this desktop. The address may now belong to another device.` };
  return { tone: "warn", text: `A desktop answered in ${ms(t.ms)}. Which one is checked when the app switches to it; switch to this desktop to check it now.` };
}

/** The address the desktop reports NOW, when it differs from the typed one and the typed one has not proved itself. */
export function staleLanOffer(lanBase: string | null, test: LanTest | null, reported: readonly string[]): string | null {
  if (!lanBase || (test?.s === "ok" && test.proven === true)) return null;
  const typed = lanBase ? normalizeHostBase(lanBase) : null;
  const other = reported.find((ip) => normalizeHostBase(ip) !== typed);
  return other ?? null;
}
