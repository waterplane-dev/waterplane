/** The two moves every writer of the images feature shares. */
import type { Overlay } from "../../routing";
import { copyText } from "../../api";
import { core } from "../../sdk";
import { returnVerb } from "../../backStep";

/**
 * Back to `o` — the sheet the images screen on top covered — or close the top when `o` is null.
 * The feature's ONE return path: when one close lands on `o` it closes (the same pop as Back,
 * so the sheet comes back with its kept cut and what it was opened on); only a sheet nothing
 * covered is opened, fresh (`returnVerb`, `backStep.ts`).
 */
export function goTo(o: Overlay): void {
  const nav = core().nav;
  const how = returnVerb(o, nav.overlay);
  if (how === "close" && nav.overlay) nav.close(nav.overlay);
  else if (how === "open" && o) nav.open(o);
}

/** A path into the compose box + the clipboard, said. */
export function insertPath(p: string): void {
  core().compose.insert(p); void copyText(p); core().say.toast(`path copied: ${p}`);
}
