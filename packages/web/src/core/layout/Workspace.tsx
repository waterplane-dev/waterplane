/**
 * THE FRAME: what `App` puts on screen, phone or wide.
 *
 * DOM contract (styled by the `[data-layout="wide"]` block at the end of
 * styles.css — P1c — and nowhere else):
 *   - grid root   `#root`, under `html[data-layout="wide"]`. No wrapper element
 *                 of its own: see "never a remount" below.
 *   - sidebar     `aside.ws-side` — the first child of `#root`, wide only. Holds
 *                 `LauncherScreen`, unchanged (its own `.screen`).
 *   - main pane   `.ws-main` is NOT a wrapper either: the main pane is the
 *                 element after the sidebar, `#root > .ws-side + *` — the
 *                 session's `.screen`, a sheet's `.sheet`, or, with nothing
 *                 attached, `.screen.ws-empty`.
 *   - layout      `<html data-layout="wide"|"phone">`, `useLayout()` /
 *                 `useWide()` (`layout.ts`).
 *
 * PHONE IS UNCHANGED: below 1024px this returns exactly what `App` returned —
 * the sheet if one is open, else the session if one is attached, else the
 * launcher — with no element added (a null slot renders nothing).
 *
 * NEVER A REMOUNT ON A CROSSING: both layouts return the same two-slot
 * fragment, `[sidebar | null, main]`, so the session screen sits at the SAME
 * React position at every width and resizing across 1024 is a reflow and one
 * debounced fit, never a new xterm (plan §1). That is why the main pane has no
 * wrapper: a `div.ws-main` drawn only in wide would change the session's
 * parent, and React remounts on a changed parent. The launcher does move (main
 * slot → sidebar), which costs its local view state, not a byte of a session.
 *
 * Wide, phase 1: a sheet takes the main pane and the sidebar stays. Side
 * panels are phase 2 (P2b adds the slot here).
 */
import type { ReactElement, ReactNode } from "react";
import { Empty } from "../../Empty";
import { useWide } from "./layout.ts";

export interface WorkspaceProps {
  /** `overlayLayer`'s result: the sheet on top, or null. */
  sheet: ReactNode;
  /** The launcher, always built — wide draws it as the sidebar. */
  launcher: ReactElement;
  /** The session screen, or null when nothing is attached. */
  session: ReactElement | null;
}

export function Workspace({ sheet, launcher, session }: WorkspaceProps) {
  const wide = useWide();
  const top = sheet || null; // `if (sheet) return sheet`, as App had it
  if (!wide) return <>{null}{top ?? session ?? launcher}</>;
  const main = top ?? session ?? (
    <div className="screen ws-empty">
      <Empty>Pick a session in the list, or start one.</Empty>
    </div>
  );
  return <><aside className="ws-side">{launcher}</aside>{main}</>;
}
