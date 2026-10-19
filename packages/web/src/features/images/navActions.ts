/** The two moves every writer of the images feature shares. */
import type { Overlay } from "../../routing";
import { copyText } from "../../api";
import { core } from "../../sdk";

/** Show `o`, or close whatever is on top when `o` is null (App's `setOverlay(o)`). */
export function goTo(o: Overlay): void {
  const nav = core().nav;
  if (o) nav.open(o);
  else if (nav.overlay) nav.close(nav.overlay);
}

/** A path into the compose box + the clipboard, said. */
export function insertPath(p: string): void {
  core().compose.insert(p); void copyText(p); core().say.toast(`path copied: ${p}`);
}
