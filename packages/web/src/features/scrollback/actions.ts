/**
 * The one writer of the scrollback store.
 */
import { core } from "../../sdk";
import { absorb as absorbScreenLog } from "../../screenlog";
import { liveGrid } from "./store";

/**
 * Open the local scrollback for the session on screen.
 *
 * The grid is read HERE, before the sheet replaces the terminal: rendering the
 * sheet unmounts `TerminalView`, and a snapshot taken after that is empty. It
 * is also folded into the log on the way past, so the sheet's last line is
 * what the user was just looking at even if the 400 ms settle hadn't fired.
 */
export function openScrollback(): void {
  const c = core();
  const active = c.world.active;
  if (!active) { c.say.toast("no active session"); return; }
  const live = c.term.snapshot();
  if (live.length) absorbScreenLog(active.id, live);
  liveGrid.set(live);
  c.nav.open("scrollback");
}
