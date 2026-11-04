/**
 * Which card the gate draws in the Android shell, and its words. Pure.
 */
import type { PeerKind } from "@waterplane/shared";

/**
 * What the shell draws instead of the password form, which cannot work there on any route: the page
 * is `http://localhost`, so the cookie the login sets never rides (`hostUrl.ts`). `locked`: the
 * sign-in is sealed and shut. `gone`: this desktop refused the phone with nothing left to send, and
 * only pairing brings it back. Null: the form, as in a browser.
 */
export function shellCase(native: boolean, sealedShut: boolean): "locked" | "gone" | null {
  if (!native) return null;
  return sealedShut ? "locked" : "gone";
}

/** The first sentence of the `gone` card. On the LAN a person expects a password box, so it says there is none. */
export function goneLead(kind: PeerKind): string {
  return kind === "lan"
    ? "This desktop no longer knows this phone on the local network, and a password cannot sign it in here."
    : "This phone's sign-in for this desktop is gone.";
}
