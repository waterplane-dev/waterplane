/**
 * ESCAPE IS ONE BACK — on a wide window only (docs/analysis/desktop-workspace-plan.md §3).
 *
 * A desktop reaches for Esc to close a side panel. It is NOT a second close
 * path: it calls the same `history.back()` the shell's Back, the gesture and
 * the sheet's own arrow take, so the route stack (`backStep.ts`) unwinds
 * exactly one entry and lands where those would.
 *
 * Two places Esc already belongs to someone else, and is left alone:
 *   - the compose box in CLI mode (`textarea.pipe`, `cliKeys.ts`) pipes Esc to
 *     the CLI — dismissing a menu there must not also close the screen;
 *   - xterm's own input (`.xterm-helper-textarea`) sends it to the PTY.
 * And with nothing pushed (`depth` 0) a Back would leave the app.
 *
 * A component that answers Esc itself (the image swiper, the gallery's open
 * file, the model wheel, explain mode) calls `preventDefault()`; the listener
 * decides AFTER every keydown handler has run, so one press is one step, never
 * two.
 */

/** The slice of an event target the decision reads (fakeable in a node test). */
export interface EscTarget {
  tagName?: string;
  /** An SVG element's `className` is not a string — read as no class. */
  className?: unknown;
}

export type EscStep = "back" | "ignore";

/** Whose Esc it is. Pure. */
export function escapeStep(depth: number, target: EscTarget | null | undefined): EscStep {
  if (!(depth > 0)) return "ignore";
  if (target && String(target.tagName ?? "").toUpperCase() === "TEXTAREA") {
    const cls = typeof target.className === "string" ? target.className.split(/\s+/) : [];
    if (cls.includes("pipe") || cls.includes("xterm-helper-textarea")) return "ignore";
  }
  return "back";
}

/** The slice of `window` the listener needs. */
export interface EscWindow {
  addEventListener(type: "keydown", fn: (e: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown", fn: (e: KeyboardEvent) => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

/**
 * Install the listener; returns the uninstall. `depth` reads the route stack,
 * `back` is `history.back()` — both injected so this module stays DOM-free.
 * The caller installs it only while the layout is wide.
 */
export function startEscape(win: EscWindow, depth: () => number, back: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.isComposing) return;
    if (escapeStep(depth(), e.target as EscTarget | null) !== "back") return;
    // After every other keydown handler on this press: one that answered Esc
    // itself has called preventDefault by then.
    win.setTimeout(() => { if (!e.defaultPrevented && depth() > 0) back(); }, 0);
  };
  win.addEventListener("keydown", onKey);
  return () => win.removeEventListener("keydown", onKey);
}
