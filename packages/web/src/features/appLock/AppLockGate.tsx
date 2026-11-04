/**
 * What the lock does to the page: watches the app go and come back, and while
 * locked draws the card over everything and takes the rest out of reach.
 * `App` stays mounted under it, so sends, notifications and updates carry on.
 */
import { useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { holdBack } from "../../backStep";
import { sayIfCannotLock } from "./actions";
import { LockScreen } from "./LockScreen";
import { useAppLock } from "./store";

/** A hardware keyboard still reaches the app's document-level shortcuts past `inert`. */
function swallowKey(e: KeyboardEvent): void {
  if (!(e.target instanceof Element && e.target.closest(".app-lock"))) e.stopImmediatePropagation();
}

/**
 * The card alone, before `App` exists: nothing here dials. In `#root` and not a portal, or the
 * boot trap reads an empty root as a boot that failed and paints over it.
 */
export function SealGate() {
  useLayoutEffect(() => {
    holdBack(true);
    return () => holdBack(false);
  }, []);
  return <LockScreen />;
}

export function AppLockGate() {
  const isLocked = useAppLock();

  useEffect(() => { sayIfCannotLock(); }, []);

  // Layout, not passive: nothing under the card may take a tap in its first frame.
  useLayoutEffect(() => {
    if (!isLocked) return;
    const root = document.getElementById("root");
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // the keyboard goes with it
    root?.toggleAttribute("inert", true);
    holdBack(true);
    window.addEventListener("keydown", swallowKey, true);
    return () => {
      root?.toggleAttribute("inert", false);
      holdBack(false);
      window.removeEventListener("keydown", swallowKey, true);
    };
  }, [isLocked]);

  return isLocked ? createPortal(<LockScreen />, document.body) : null;
}
