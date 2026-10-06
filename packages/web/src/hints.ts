/**
 * Button hints — "what does this actually do?", answerable on a touchscreen.
 *
 * The catalog and the one decision rule live in `@waterplane/shared` (`hints.ts`), so
 * a node e2e can pin them. This file is the runtime: where the dismissals are
 * kept, and the delegated gesture handling.
 *
 * Two ways in, because they answer different questions:
 *
 *  - **Long-press anything.** "What is this?" — asked before committing, which
 *    is exactly why a first-tap dialog cannot be the only route: the
 *    destructive buttons are the ones you least want to probe by tapping. It
 *    works on every button in the app with no per-site edit, because the
 *    handler is DELEGATED and falls back to the element's own `title`. That is
 *    the same argument `settings.ts` makes for patching localStorage and
 *    `hostUrl.ts` for patching `fetch`: a rule that only holds where somebody
 *    remembered a helper breaks silently three edits later — and here it would
 *    break into the exact symptom it fixes, a button that explains nothing.
 *  - **Explain-then-confirm on first use**, for the curated `confirm` set.
 *    Explaining all ~290 buttons would turn a fresh install into a click-
 *    through; those ~30 are the ones whose icon cannot be guessed.
 *
 * Plus `explainMode`, a global "the next tap explains instead of acting"
 * toggle — the relearn path once everything has been dismissed, and the reason
 * a permanent dismissal is safe to offer at all.
 *
 * State is one synced key (`waterplane.hints`), so dismissals follow the USER: being
 * re-taught on the desktop what you already read on the phone is precisely the
 * annoyance this is meant to remove.
 */
import { decideHint, HINTS as SHARED_HINTS, type HintDef, type HintMode } from "@waterplane/shared";
import { LS, lsGet, lsSetJson } from "./storage";

/**
 * Hints for readouts that exist only on this side of the wire.
 *
 * The catalog proper is `@waterplane/shared`'s, and it stays there for the reason
 * stated in that file: `e2e-hints.mjs` pins the rules with no DOM. These are
 * the local-runner strip's, registered here because the strip's readings are a
 * pure client rendering of one wire frame, so it was briefly tempting to keep
 * its five hint defs beside the component that draws them.
 *
 * They live in `shared/hints.ts` with every other def instead, and the reason is
 * a check rather than a preference: `scripts/e2e-hints.mjs` scans every
 * `data-hint` in `packages/web/src/**` and holds each one against SHARED's dist.
 * A second, web-local catalog is invisible to that scan, so every id in it reads
 * as a missing definition — a long-press that silently explains nothing, which
 * is exactly the failure the scan exists to catch. One catalog, one check.
 *
 * Every reading on the strip gets its own def, because 22 px can only show a
 * shape and a number — "18.2 GB" invites the question "held by what, and what
 * happens if I start another one?", and a long press is where that is answered.
 */
export const HINTS: Record<string, HintDef> = SHARED_HINTS;
export type { HintDef, HintMode };

// ── State ────────────────────────────────────────────────────────────

interface HintState { mode: HintMode; seen: Record<string, number> }

/** Synced (see `shared/settings.ts`), so a dismissal follows the user. */
const KEY = LS.hints;
const LONG_PRESS_MS = 450;
/** Past this the press is a scroll or a drag, not a question about a button. */
const MOVE_TOL = 10;

function read(): HintState {
  try {
    const raw = JSON.parse(lsGet(KEY) || "{}") as Partial<HintState>;
    const mode: HintMode = raw.mode === "press" || raw.mode === "off" ? raw.mode : "first";
    const seen: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.seen ?? {})) if (typeof v === "number") seen[k] = v;
    return { mode, seen };
  } catch { return { mode: "first", seen: {} }; }
}

function write(st: HintState): void {
  lsSetJson(KEY, st);
}

export function hintMode(): HintMode { return read().mode; }

export function setHintMode(mode: HintMode): void { write({ ...read(), mode }); }

export function hintSeenCount(): number { return Object.keys(read().seen).length; }

/** Forget every dismissal — "explain them to me again". */
export function resetHints(): void { write({ mode: read().mode, seen: {} }); }

function markSeen(id: string): void {
  const st = read();
  st.seen[id] = Date.now();
  write(st);
}

// ── Explain mode ─────────────────────────────────────────────────────
// Deliberately NOT persisted: it is a mode you switch on for ten seconds to
// interrogate a row of icons, and one that survived a reload would leave the
// app silently refusing to do anything on the next launch.

let explain = false;
const explainListeners = new Set<(on: boolean) => void>();

export function explainMode(): boolean { return explain; }

export function setExplainMode(on: boolean): void {
  if (explain === on) return;
  explain = on;
  for (const fn of explainListeners) fn(on);
}

export function onExplainChange(fn: (on: boolean) => void): () => void {
  explainListeners.add(fn);
  return () => { explainListeners.delete(fn); };
}

// ── The card, as seen by whoever renders it ──────────────────────────

export interface ActiveHint {
  id: string;
  def: HintDef;
  /** Present only when a tap was intercepted: run the action after all. */
  proceed?: () => void;
  /** True when the user was mid-tap, so the card offers "do it" rather than "got it". */
  intercepted: boolean;
}

let current: ActiveHint | null = null;
const cardListeners = new Set<(h: ActiveHint | null) => void>();

export function onHintCard(fn: (h: ActiveHint | null) => void): () => void {
  cardListeners.add(fn);
  fn(current);
  return () => { cardListeners.delete(fn); };
}

function show(h: ActiveHint | null): void {
  current = h;
  for (const fn of cardListeners) fn(h);
}

/** Dismiss without acting. `remember` = do not explain this one again. */
export function closeHint(remember: boolean): void {
  if (current && remember) markSeen(current.id);
  show(null);
}

/** Dismiss and run the action the tap was going to run. */
export function proceedHint(): void {
  const h = current;
  show(null);
  if (!h) return;
  markSeen(h.id); // confirming IS having read it — never ask for this one again
  h.proceed?.();
}

/** Open a card by hand (the `?` chip explaining itself, a settings preview). */
export function showHint(id: string): void {
  const def = HINTS[id];
  if (def) show({ id, def, intercepted: false });
}

// ── Delegation ───────────────────────────────────────────────────────

/**
 * Build a hint for a button with no registry entry, out of its own `title`.
 *
 * This is what makes the feature cover the whole app on day one: those strings
 * are already written and already accurate — they were simply never rendered on
 * a touchscreen. `null` for a button with neither title nor label.
 */
function defFor(el: HTMLElement): { id: string; def: HintDef } | null {
  const id = el.dataset.hint;
  if (id && HINTS[id]) return { id, def: HINTS[id] };
  const title = el.getAttribute("title") || el.getAttribute("aria-label") || "";
  if (!title.trim()) return null;
  // The button's own words make the better head when it has any; otherwise the
  // first clause of the title, which is how most of these were written ("hold it
  // until this session can take it: …"). An icon-only button with a one-clause
  // title has no name to show, so the card just answers the question instead of
  // inventing one.
  const own = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const [head, ...rest] = title.split(/\s*[:—]\s+/);
  const compound = rest.length > 0;
  return {
    id: id || `title:${title.slice(0, 80)}`,
    def: {
      title: own || (compound ? head : "What this does"),
      what: compound && !own ? rest.join(" — ") : title,
    },
  };
}

/** The element the interceptor is deliberately letting through, once. */
let bypass: HTMLElement | null = null;
/** A long-press just fired; swallow the click it is about to become. */
let swallowClick = false;

function target(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  // `data-nohint` opts an element out — the session rows own press-and-hold for
  // dragging, and two long-press meanings on one element is one too many.
  if (node.closest("[data-nohint]")) return null;
  return node.closest<HTMLElement>("[data-hint], button[title], button[aria-label]");
}

/** Wire the delegated handlers. Idempotent; safe to call before React mounts. */
export function installHints(): void {
  if (typeof document === "undefined") return;
  const self = installHints as unknown as { done?: boolean };
  if (self.done) return;
  self.done = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;

  function onMove(ev: PointerEvent) {
    if (!start) return;
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > MOVE_TOL) clear();
  }

  function clear() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    start = null;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", clear, true);
    window.removeEventListener("pointercancel", clear, true);
    window.removeEventListener("scroll", clear, true);
  }

  document.addEventListener("pointerdown", (ev) => {
    if (read().mode === "off") return;
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    const el = target(ev.target);
    if (!el) return;
    const found = defFor(el);
    if (!found) return;
    start = { x: ev.clientX, y: ev.clientY };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", clear, true);
    window.addEventListener("pointercancel", clear, true);
    window.addEventListener("scroll", clear, true);
    timer = setTimeout(() => {
      clear();
      // A long-press ANSWERS a question; it never performs the action, which is
      // the whole reason it is safe to try on a red button.
      swallowClick = true;
      navigator.vibrate?.(12);
      show({ ...found, intercepted: false });
    }, LONG_PRESS_MS);
  }, true);

  // Otherwise Android raises its text-selection callout over the card we just
  // opened, and the card is the thing the press was for.
  document.addEventListener("contextmenu", (ev) => {
    if (swallowClick && target(ev.target)) ev.preventDefault();
  }, true);

  document.addEventListener("click", (ev) => {
    const el = target(ev.target);
    if (bypass && el === bypass) { bypass = null; return; } // our own re-dispatch
    if (swallowClick) {
      swallowClick = false;
      if (el) { ev.preventDefault(); ev.stopPropagation(); }
      return;
    }
    if (!el) return;
    const mode = read().mode;
    if (mode === "off" && !explain) return;
    const found = defFor(el);
    if (!found) return;
    const what = decideHint({ mode, explain, def: found.def, seen: !!read().seen[found.id] });
    if (what === "act") return;
    ev.preventDefault(); ev.stopPropagation();
    // "explain" spends the tap on the question and runs nothing; only
    // "explainThenAct" keeps a way through, behind the card's own button.
    show(what === "explain"
      ? { ...found, intercepted: false }
      : { ...found, intercepted: true, proceed: () => { bypass = el; el.click(); } });
  }, true);
}
