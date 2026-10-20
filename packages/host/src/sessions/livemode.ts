/**
 * A session's permission mode and ultracode as the CLI's footer shows them
 * (`SessionInfo.liveMode` / `.ultracode`, read by `permmode.ts`), and the one
 * verb that changes the mode from the phone (`session.mode`).
 *
 * Stateless functions over the `Session` record, reaching the rest of the
 * manager only through `core`.
 *
 * - **liveMode is the screen NOW, or absent.** Re-read on the quiet tick
 *   (`turn.ts`'s `markIdle`, beside the context meter): a shift+tab typed at
 *   the desk is output, and four seconds after it the reading follows. A null
 *   reading DELETES the field — a box over the footer may itself be about to
 *   change the mode ("Yes, and switch to auto mode"), so last-known is not
 *   kept. Never persisted: `live/` records carry no `SessionInfo`, so a
 *   restart starts absent and the first quiet tick reads it again.
 * - **keyHints is the screen NOW, or absent** (`keyhints.ts`): read on the
 *   same tick, so a picker's `s for this session only` reaches the phone's
 *   key row while the picker is up.
 * - **ultracode is sticky.** The confirmation line scrolls away and the mode
 *   reader cannot ask the CLI, so the last screen that SAID something stands
 *   until another one does (`ultracodeVerdict`). Absent until one did.
 * - **`setMode` presses shift+tab like a person** and re-reads the footer
 *   between presses, so it never counts positions in a cycle it was told
 *   about: it stops on the target, when the cycle comes back round (the mode
 *   is not in it), or at a hard cap. Serialised per session.
 */
import { sameKeyHints, type PermissionMode } from "@waterplane/shared";
import { readKeyHints } from "../keyhints.js";
import { permModeWords, readPermMode, readUltracode, ultracodeVerdict } from "../permmode.js";
import type { Session, SessionCore } from "./core.js";
import { MODE_MAX_PRESSES, MODE_POLL_MS, MODE_PRESS_WAIT_MS } from "./knobs.js";

/** shift+tab, as the terminal sends it. */
const SHIFT_TAB = "\x1b[Z";

/** What `session.moded` carries: the mode the footer shows after the walk,
 *  and the sentence whenever that is not the mode asked for. */
export interface ModeReply { mode?: PermissionMode; reason?: string }

/** Claude's footer is drawn only by claude's TUI. The caps gate whether the
 *  reader RUNS; another backend's session simply has no field. */
function readsFooter(s: Session): boolean {
  return s.backend.caps.promptBoxes === "claude-numbered" && s.backend.caps.permissionModes.length > 0;
}

/** The live grid — the recorder's VT, a buffer read. `""` = unknown. */
const gridOf = (s: Session): string => s.screenLog?.gridText() ?? "";

/** Write what one grid says onto the info. Returns whether a field moved. */
function applyGrid(s: Session, grid: string): boolean {
  let changed = false;
  const mode = grid ? readPermMode(grid) : null;
  if (mode !== (s.info.liveMode ?? null)) {
    if (mode) s.info.liveMode = mode; else delete s.info.liveMode;
    changed = true;
  }
  // The footer's and an open picker's shortcuts, for the phone's key row.
  // Like the mode: the screen NOW, or absent.
  const hints = grid ? readKeyHints(grid) : [];
  if (!sameKeyHints(hints, s.info.keyHints)) {
    if (hints.length) s.info.keyHints = hints; else delete s.info.keyHints;
    changed = true;
  }
  if (grid) {
    const r = readUltracode(grid);
    if (r.border === "label") s.ultracodeLabelSeen = true;
    const on = ultracodeVerdict(r, !!s.ultracodeLabelSeen);
    if (on !== null && on !== s.info.ultracode) { s.info.ultracode = on; changed = true; }
  }
  return changed;
}

/** The quiet-tick re-read. Emits `updated` only on a change. */
export function checkMode(core: SessionCore, s: Session): void {
  if (!s.info.running || !readsFooter(s)) return;
  if (applyGrid(s, gridOf(s))) core.emit("updated", s.info);
}

/** Re-read now, publish a change, and hand back the mode (null = unreadable). */
function readNow(core: SessionCore, s: Session): PermissionMode | null {
  if (applyGrid(s, gridOf(s))) core.emit("updated", s.info);
  return s.info.liveMode ?? null;
}

/**
 * After one press: the first READABLE footer that differs from `from`, or the
 * last reading when the window closed without one (null = it never read).
 */
async function nextMode(s: Session, from: PermissionMode): Promise<{ moved: boolean; mode: PermissionMode | null }> {
  const until = Date.now() + MODE_PRESS_WAIT_MS;
  let last: PermissionMode | null = from;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, MODE_POLL_MS));
    if (!s.info.running) return { moved: false, mode: null };
    last = readPermMode(gridOf(s));
    if (last && last !== from) return { moved: true, mode: last };
  }
  return { moved: false, mode: last };
}

/** Why a target can be missing from a cycle, where the binary told us. */
function notInCycle(target: PermissionMode): string {
  const why = target === "bypassPermissions" ? " — it is only there when the session was launched with it"
    : target === "dontAsk" ? " — it is only there as the mode a session was launched in"
    : "";
  return `${permModeWords(target)} isn't in this session's shift+tab cycle${why}`;
}

async function walk(core: SessionCore, id: string, target: PermissionMode): Promise<ModeReply> {
  const s = core.sessions.get(id);
  if (!s || !s.info.running) return { reason: "that session has ended, so there is no mode to change" };
  if (!readsFooter(s)) return { reason: "only a claude session has a permission mode to switch" };
  if (!s.backend.caps.permissionModes.includes(target)) return { reason: `"${String(target)}" is not a permission mode this session knows` };
  if (!s.info.remoteControl) return { reason: "remote control is off for this session — mode not changed" };
  // A box takes shift+tab for itself (and its footer hides the mode anyway):
  // pressing would act on the question, not on the mode.
  if (s.info.prompt || s.info.awaitingInput) {
    return { reason: "a question is open on the desktop — answer it first; shift+tab would go to the box, not the mode" };
  }
  const start = readNow(core, s);
  if (!start) return { reason: "the mode line under the prompt box can't be read right now (a box or menu covers it), so nothing was pressed" };
  if (start === target) return { mode: start };
  const seen = new Set<PermissionMode>([start]);
  let cur: PermissionMode = start;
  for (let press = 1; press <= MODE_MAX_PRESSES; press++) {
    if (!core.write(id, SHIFT_TAB)) return { mode: readNow(core, s) ?? undefined, reason: "the session stopped taking keys, so the mode was left where it is" };
    const next = await nextMode(s, cur);
    const shown = readNow(core, s);
    if (!next.moved) {
      return shown
        ? { mode: shown, reason: `shift+tab did not move the mode line (it still reads ${permModeWords(shown)}), so the host stopped pressing` }
        : { reason: "the mode line stopped being readable after shift+tab, so the host stopped pressing" };
    }
    cur = next.mode!;
    if (cur === target) return { mode: cur };
    if (seen.has(cur)) return { mode: cur, reason: notInCycle(target) };
    seen.add(cur);
  }
  return { mode: cur, reason: `${MODE_MAX_PRESSES} presses did not reach ${permModeWords(target)}; the mode reads ${permModeWords(cur)}` };
}

/**
 * Switch a live claude session's permission mode (`session.mode`). Always
 * resolves — with the mode reached, a sentence, or both — and never throws.
 * A second call for the same session waits for the first, then reads the
 * footer again: a double tap is one walk and an immediate "already there".
 */
export function setMode(core: SessionCore, id: string, target: PermissionMode): Promise<ModeReply> {
  const s = core.sessions.get(id);
  if (!s) return Promise.resolve({ reason: "that session is not open" });
  const run = (s.modeChain ?? Promise.resolve()).then(() => walk(core, id, target));
  s.modeChain = run.catch(() => undefined);
  return run.catch((err: unknown) => ({ reason: `the mode was not changed: ${err instanceof Error ? err.message : String(err)}` }));
}
