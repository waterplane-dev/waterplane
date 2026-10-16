/**
 * THE FRAME: what `App` puts on screen, phone or wide.
 *
 * DOM contract (styled by the `[data-layout="wide"]` block at the end of
 * styles.css — P1c — and nowhere else):
 *   - grid root   `#root`, under `html[data-layout="wide"]`. No wrapper element
 *                 of its own: see "never a remount" below.
 *   - sidebar     `aside.ws-side` — the first child of `#root`, wide only. Holds
 *                 `LauncherScreen`, unchanged (its own `.screen`), and its
 *                 resize handle `.ws-side-grip` (`SideGrip.tsx`).
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
 * SIDE PANELS (phase 2, plan §3): wide, a sheet whose overlay is NOT in
 * `WIDE_FULL` (`routing.ts`) is drawn LAST, in `div.ws-panel`, over the right
 * edge of the main pane — and the main pane keeps exactly what it had with no
 * sheet (session ?? empty), same element, same position. So opening or
 * closing a panel neither remounts the session nor changes the terminal's
 * width (no SIGWINCH, no repaint). Children of `#root`, wide:
 *   - no sheet / panel sheet: `aside.ws-side`, main, `div.ws-panel` | nothing
 *   - a `WIDE_FULL` sheet:    `aside.ws-side`, the sheet as main, nothing
 * Phone draws the trailing slot as null, which renders nothing.
 *
 * BESIDE (the annotator for the session on screen, on a window with room —
 * `useAnnBeside`): the sheet is a THIRD grid column, `div.ws-beside`, after the
 * session, so the person types the prompt in the session's own box while
 * marking. Unlike a panel it takes width from the main pane (the terminal
 * re-fits once — a reflow, the session element never moves), because a panel
 * over the session would cover the very box it is there to keep in reach. Esc
 * does not close it: the caret is usually in the compose box, and one habitual
 * Esc there would throw away every mark on the picture.
 *
 * Wide only, two keyboard affordances live here because this is the one
 * component that knows a panel is up: Esc is one Back (`escape.ts`), and a
 * panel that opens takes focus on its `.back` (unless the sheet focused one of
 * its own fields), handing it back to the compose box on close when the box
 * had it.
 */
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Empty } from "../../Empty";
import { routeStack } from "../../backStep";
import { isWideFull, type Overlay } from "../../routing";
import { startEscape } from "./escape.ts";
import { useWide } from "./layout.ts";
import { SideGrip } from "./SideGrip.tsx";
import { useAnnBeside } from "../../features/images";
import { besideFull, useBesideFull } from "../../besideRoom";
import { BesideGrip } from "./BesideGrip.tsx";

export interface WorkspaceProps {
  /** `overlayLayer`'s result: the sheet on top, or null. */
  sheet: ReactNode;
  /** The route's overlay name — decides panel vs main pane on a wide window. */
  overlay: Overlay;
  /** The launcher, always built — wide draws it as the sidebar. */
  launcher: ReactElement;
  /** The session screen, or null when nothing is attached. */
  session: ReactElement | null;
}

export function Workspace({ sheet, overlay, launcher, session }: WorkspaceProps) {
  const wide = useWide();
  const top = sheet || null; // `if (sheet) return sheet`, as App had it
  const beside = useAnnBeside() && overlay === "image" && !!top && !!session;
  const full = useBesideFull() && beside;
  useBesideFullKeys(beside, full);
  const panel = wide && !!top && !isWideFull(overlay);
  usePanelKeys(wide && !!top && !beside, panel ? overlay : null);
  if (!wide) return <>{null}{top ?? session ?? launcher}{null}</>;
  if (beside) return <><aside className="ws-side">{launcher}<SideGrip /></aside>{session}<div className={`ws-beside${full ? " full" : ""}`}>{top}{full ? null : <BesideGrip />}</div></>;
  const main = (panel ? null : top) ?? session ?? (
    <div className="screen ws-empty">
      <Empty>Pick a session in the list, or start one.</Empty>
    </div>
  );
  return <><aside className="ws-side">{launcher}<SideGrip /></aside>{main}{panel ? <div className="ws-panel">{top}<BesideGrip of="panel" /></div> : null}</>;
}

/** The beside column's full screen: Esc steps back to beside (never closes
 *  the annotator), and the next picture starts beside again. */
function useBesideFullKeys(beside: boolean, full: boolean) {
  useEffect(() => { if (!beside) besideFull.set(false); }, [beside]);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); besideFull.set(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
}

/** Esc while wide AND a sheet is up, and the panel's focus hand-off.
 *  `panelOf` is the overlay drawn in the panel, or null with none. Esc closes a
 *  sheet, never a session: on a bare session screen the route depth is still
 *  above 0, and a desktop hand presses Esc out of habit (a menu, a selection) —
 *  leaving the session for the empty pane on that press would be a trap. */
function usePanelKeys(sheetUp: boolean, panelOf: Overlay) {
  useEffect(() => (sheetUp ? startEscape(window, () => routeStack.depth, () => history.back()) : undefined), [sheetUp]);
  const composeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    if (!panelOf) {
      // Closed: back to the compose box if it had the caret and nothing else
      // took it since (focus fell to <body> with the panel's button).
      const box = composeRef.current;
      composeRef.current = null;
      if (box?.isConnected && (!focused || focused === document.body)) box.focus();
      return;
    }
    if (focused?.matches?.(".compose textarea")) composeRef.current = focused;
    const el = document.querySelector<HTMLElement>("#root > .ws-panel");
    if (el && !el.contains(focused)) el.querySelector<HTMLElement>(".back")?.focus();
  }, [panelOf]);
}
