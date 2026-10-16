/**
 * THE SHORTCUT CARD — hold Ctrl (⌘, Alt/⌥) alone and a small card lists what
 * each key does with it RIGHT NOW. The table is `shortcuts.ts`, the hold is
 * `shortcutHold.ts`; this is the listener and the drawing.
 *
 * Mounted once in `main.tsx` beside `AskRepoHost` (it can come up over any
 * screen, and `main.tsx` may not import a feature). It never takes focus,
 * never takes a pointer, and never consumes a key: the listener is passive, so
 * a listed key pressed while the card is up runs its chord as it always would.
 *
 * Only with a physical keyboard — a fine pointer, or a hardware key seen this
 * session — so a touch-only phone never meets it. The first hardware key
 * pressed, one toast says so and names the setting that turns it off.
 */
import { createStore, useStore } from "./sdk/store.ts";
import { HOLD_MS, IDLE, hasKeyboard, holdStep, isHardwareKey, type HoldEvent, type HoldState } from "./shortcutHold";
import { detectMac, modLabel, registeredShortcuts, shortcutsFor, type HeldMod, type KeyEnv, type ShortcutRow } from "./shortcuts";
import { isStandalone } from "./platform";
import { isNativeShell } from "./hostUrl";
import { LS, lsGet, lsSet } from "./storage";
import { showToast } from "./toast";

interface Card { mod: HeldMod; env: KeyEnv; rows: ShortcutRow[] }

const card = createStore<Card | null>(null);
const keyboard = createStore(false);

/** Is a physical keyboard known on this device this session? (The Settings row reads it.) */
export const useHasKeyboard = (): boolean => useStore(keyboard);

/** The card is on unless Settings › Writing & reading turned it off. */
export const shortcutCardOn = (): boolean => lsGet(LS.shortcutCard) !== "0";

function keyEnv(): KeyEnv {
  return { mac: detectMac(navigator as never), tab: !isStandalone() && !isNativeShell() };
}

/**
 * A keyboard is known: the Settings row appears. The one-time notice waits for
 * a real key (`tell`), the moment the person is at the keyboard — said at boot
 * off a fine pointer, it raced the first paint and could expire unseen.
 */
function noteKeyboard(tell: boolean): void {
  keyboard.set(true);
  // Absent = on and never told; "1" = on and told; "0" = off (never tell).
  if (!tell || lsGet(LS.shortcutCard) != null) return;
  lsSet(LS.shortcutCard, "1");
  const mac = detectMac(navigator as never);
  showToast(`Hold ${modLabel(mac ? "meta" : "ctrl", { mac })} to see what each key does with it. Settings › Writing & reading turns the card off.`);
}

/** Install once (`main.tsx`); returns the uninstall. */
export function installShortcutCard(win: Window = window): () => void {
  let state: HoldState = IDLE;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const apply = (ev: HoldEvent) => {
    const next = holdStep(state, ev);
    if (next === state) return;
    state = next;
    if (timer) { clearTimeout(timer); timer = null; }
    if (state.phase === "armed") {
      const mod = state.mod;
      timer = setTimeout(() => { timer = null; apply({ type: "timer", mod }); }, HOLD_MS);
    }
    if (state.phase === "shown" && shortcutCardOn()) {
      const env = keyEnv();
      const rows = shortcutsFor(registeredShortcuts(), state.mod, env);
      card.set(rows.length ? { mod: state.mod, env, rows } : null);
    } else if (card.get()) {
      card.set(null);
    }
  };

  let told = false;
  const onDown = (e: KeyboardEvent) => {
    if (!told && isHardwareKey(e)) { told = true; noteKeyboard(true); }
    apply({ type: "down", e });
  };
  const onUp = (e: KeyboardEvent) => apply({ type: "up", e });
  const onBlur = () => apply({ type: "blur" });
  const onVis = () => { if (win.document.visibilityState !== "visible") apply({ type: "blur" }); };

  let fine = false;
  try { fine = win.matchMedia?.("(pointer: fine)").matches ?? false; } catch { /* no matchMedia */ }
  if (hasKeyboard(fine, false)) noteKeyboard(false);
  win.addEventListener("keydown", onDown, { capture: true, passive: true });
  win.addEventListener("keyup", onUp, { capture: true, passive: true });
  win.addEventListener("blur", onBlur);
  win.document.addEventListener("visibilitychange", onVis);
  return () => {
    if (timer) clearTimeout(timer);
    win.removeEventListener("keydown", onDown, { capture: true });
    win.removeEventListener("keyup", onUp, { capture: true });
    win.removeEventListener("blur", onBlur);
    win.document.removeEventListener("visibilitychange", onVis);
    card.set(null);
  };
}

/** Mounted once in `main.tsx`. Renders nothing unless a modifier is being held. */
export function ShortcutCardHost() {
  const c = useStore(card);
  if (!c) return null;
  const mod = modLabel(c.mod, c.env);
  return (
    <div className="shortcut-card" aria-live="polite" role="status">
      <div className="shortcut-card-head">{mod} +</div>
      <ul className="shortcut-card-rows">
        {c.rows.map((r) => (
          <li key={r.id} className="shortcut-card-row">
            <kbd className="kbd">{r.key}</kbd>
            <span className="shortcut-card-what">
              {r.what}
              {r.note && <span className="shortcut-card-note">{r.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
