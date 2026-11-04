/**
 * The page's own coming and going, registered ONCE for the life of the page. Not the gate
 * component's effect: the pairing screen replaces the whole tree, and a phone put down there must
 * still have its away clock running. Plain imports so `node --test` can run it.
 */
let watching = false;

export function watchPage(hidden: () => void, wake: () => void): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") hidden(); else wake(); });
  window.addEventListener("pagehide", hidden);
  window.addEventListener("focus", wake);
  window.addEventListener("pageshow", wake);
}
