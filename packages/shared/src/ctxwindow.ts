/**
 * How big a model's context window is — the number every context graph calls
 * 100%.
 *
 * The conversation log records the model on every assistant turn but never the
 * window it was given, and the TUI prints the window only sometimes. So the one
 * thing that makes every session's graph COMPARABLE — a y axis where 100% means
 * the same on every chart — has to be resolved from what we do have.
 *
 * ── Why this is not a table keyed on the model id ───────────────────────────
 *
 * That was the first design, and it is wrong. It rested on the CLI's `[1m]`
 * suffix marking the long-context variant, which is true of the id you LAUNCH
 * with and not of the id that ends up in the log: measured across one machine's
 * conversation logs, `claude-opus-5` reached **998,242** tokens of context and
 * `claude-opus-4-8` reached **994,851** — both plainly 1M windows, both written
 * to the log with no suffix at all. A 200k table would have drawn those
 * sessions at 500% and, far worse, drawn a fresh one at five times its real
 * fullness with nothing on screen saying so. Two of the same machine's other
 * models also exceeded 200k (`claude-opus-4-7` at 335,928, `claude-fable-5` at
 * 263,800), so it is not one model's exception either.
 *
 * ── What replaces it ────────────────────────────────────────────────────────
 *
 * A MEASUREMENT, snapped to the ladder of windows that actually exist. A
 * conversation that provably held 346k tokens was not running in a 200k window
 * — that is evidence, not a guess, and it is evidence this app already reads on
 * every turn. The host keeps the high-water mark per model (`host/ctxwindow.ts`)
 * so the answer survives restarts and applies to a session that has not got
 * there yet, and `resolveContextWindow` is the ONE place the sources are
 * ordered. `windowFrom` travels with the number so a screen can say which of
 * them answered, and `"none"` stays a visible state with its own sentence
 * rather than a silent fall back to a per-session axis.
 */

/**
 * The windows that exist, smallest first.
 *
 * A measurement is snapped UP to one of these rather than used raw: a series
 * that peaked at 346k did not have a 346k window, and an axis whose top is the
 * highest number this conversation happened to reach is exactly the per-series
 * axis the shared scale exists to replace.
 */
export const WINDOW_LADDER = [200_000, 1_000_000] as const;

/** Every Claude model, absent any evidence to the contrary. */
export const DEFAULT_WINDOW_TOK = WINDOW_LADDER[0];
/** What an explicit `[1m]` on a LAUNCH id means. */
export const LONG_WINDOW_TOK = WINDOW_LADDER[WINDOW_LADDER.length - 1];

/** The `[1m]` variant marker, in the two spellings the CLI has used. Present on
 *  a launch id; usually absent from the id the log records. */
const LONG_RE = /(\[1m\]|-1m)$/i;

/** Whether an id is a Claude model at all — a full id or a launch alias.
 *  `<synthetic>`, the model the CLI stamps on its own usage-wall turns, is
 *  deliberately not one. */
export function isClaudeModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const base = model.trim().toLowerCase().replace(LONG_RE, "");
  if (!base) return false;
  return /^claude-/.test(base) || ["opus", "sonnet", "haiku", "fable"].includes(base);
}

/** The smallest window on the ladder that holds `tok`, or the largest when
 *  nothing does — a reading past the top rung means the ladder is out of date,
 *  and the biggest window we know of is a better answer than none. */
export function windowContaining(tok: number): number {
  for (const w of WINDOW_LADDER) if (tok <= w) return w;
  return LONG_WINDOW_TOK;
}

/**
 * The window for a model id ALONE, or null when we do not recognise it.
 *
 * Only the id — no evidence. This is the weakest of the three sources and is
 * kept honest about it: it is right for a 200k model, right for a launch id
 * carrying `[1m]`, and wrong for a 1M conversation whose log dropped the
 * suffix, which is why `resolveContextWindow` prefers a measurement over it.
 */
export function contextWindowFor(model: string | null | undefined): number | null {
  if (!isClaudeModel(model)) return null;
  return LONG_RE.test(model!.trim()) ? LONG_WINDOW_TOK : DEFAULT_WINDOW_TOK;
}

/** Where the number behind "100%" came from. Mirrors `ContextWindowSource` on
 *  the wire; kept here so the resolver can name its own answer. */
export type WindowSource = "screen" | "measured" | "model" | "none";

export interface WindowEvidence {
  /** The model the log says ran. */
  model?: string | null;
  /**
   * The most context this model has EVER been seen to hold, on this host. The
   * strongest signal there is: a conversation cannot exceed its own window.
   */
  observedTok?: number | null;
  /** An absolute gauge the TUI actually printed for THIS session. */
  screenTok?: number | null;
}

/**
 * The window, and which source answered — the one ordering.
 *
 * Screen first: it is a direct statement about this session rather than an
 * inference. Then the measurement, snapped to the ladder. Then the id alone.
 * Then nothing, and the caller says so instead of inventing an axis.
 */
export function resolveContextWindow(ev: WindowEvidence): { tok: number | null; from: WindowSource } {
  if (ev.screenTok && ev.screenTok > 0) return { tok: ev.screenTok, from: "screen" };
  if (ev.observedTok && ev.observedTok > 0 && isClaudeModel(ev.model)) {
    return { tok: windowContaining(ev.observedTok), from: "measured" };
  }
  const byId = contextWindowFor(ev.model);
  return byId != null ? { tok: byId, from: "model" } : { tok: null, from: "none" };
}

/** Percent of the window a reading used, or null when the window is unknown.
 *  Not clamped: a reading over 100% is a fact worth drawing, not one to hide. */
export function contextPct(tok: number, windowTok: number | null): number | null {
  if (!windowTok || windowTok <= 0) return null;
  return (tok / windowTok) * 100;
}
