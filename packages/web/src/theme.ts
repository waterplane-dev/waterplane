/**
 * Light or dark, as a decision the user makes once.
 *
 * Three values, not two, and the key is PER DEVICE (`shared/settings.ts` states
 * why at length). `system` is the default and the only one that can be right on
 * two devices at once: the phone this app is mostly used on follows a schedule
 * the desktop does not. `dark` and `light` are the overrides for someone who
 * has decided that THIS device's OS is wrong about them — which is why they do
 * not travel: overriding one OS says nothing about another.
 *
 * The RESOLVED theme is written to `<html data-theme>` and nowhere else. Every
 * colour in the app is a custom property (`styles.css`), so one attribute
 * repaints the lot — and the two things that are NOT CSS are pushed from here:
 *
 *  - the `<meta name="theme-color">` the browser paints its own chrome with,
 *  - the Android shell's system bars (`ShellAndroidInterface.setTheme`),
 *    which are real window attributes and cannot be reached from a stylesheet.
 *
 * The attribute is also set by an inline script in `index.html`, BEFORE this
 * module is parsed. That is not redundancy: a bundle is fetched, and a theme
 * applied when React mounts is a flash of the wrong colour on every cold start
 * — most visibly in the APK, where the whole document is read off disk fast
 * enough for the wrong background to be a full frame.
 */
import { shellInterface } from "./shellBridge";
import { overlayChromeBg } from "@waterplane/shared";
import { LS, lsGet, lsSet } from "./storage";
import { onThemeOverlay, themeOverlay } from "./themeOverlay";

export type ThemeChoice = "system" | "dark" | "light";
export type Theme = "dark" | "light";

/** What the browser chrome is painted with — must match `--bg` per theme.
 * closed: the theme is the phone's own two-way pref */
const CHROME: Record<Theme, string> = { dark: "#0b0d10", light: "#eef1f6" };
/** …or a fork's `--bg` for that theme (`themeOverlay.ts`). */
const chrome = (t: Theme): string => overlayChromeBg(t, themeOverlay()) ?? CHROME[t];

const isChoice = (v: string | null): v is ThemeChoice =>
  v === "system" || v === "dark" || v === "light";

/** What the user picked. `system` when nothing has been picked or the stored
 *  value is from a build that spelled it differently. */
export function themeChoice(): ThemeChoice {
  const v = lsGet(LS.theme);
  return isChoice(v) ? v : "system";
}

const mq = (): MediaQueryList | null => {
  try { return window.matchMedia("(prefers-color-scheme: light)"); } catch { return null; }
};

/** What the OS says, when we are asked to follow it. Dark when it will not say
 *  — this app was dark-only until now, so that is the answer that surprises
 *  nobody. */
function systemTheme(): Theme {
  return mq()?.matches ? "light" : "dark";
}

/** The theme actually on screen. */
export function resolvedTheme(): Theme {
  const c = themeChoice();
  return c === "system" ? systemTheme() : c;
}

type Listener = (theme: Theme, choice: ThemeChoice) => void;
const listeners = new Set<Listener>();

/** Subscribe to the resolved theme. Fires on a pick, on an OS switch while
 *  `system` is selected, and on a pick made on another device. */
export function onThemeChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

let applied: Theme | null = null;

/**
 * Push the resolved theme everywhere it has to go.
 *
 * Idempotent by design: it is called from a pick, from the OS media query, from
 * the settings-sync handler and from the shell bridge, and three of those four
 * routinely fire with nothing changed. `applied` is what stops a no-op repaint
 * turning into a notification storm — the listeners drive the terminal's own
 * palette, which is a full-screen redraw.
 */
export function applyTheme(): Theme {
  const theme = resolvedTheme();
  const choice = themeChoice();
  try {
    document.documentElement.setAttribute("data-theme", theme);
    // `color-scheme` is what makes the browser's OWN widgets — scrollbars, the
    // caret, a native <select>'s popup, form autofill — switch. Without it a
    // light page keeps dark scrollbars and an unreadable autofill highlight.
    document.documentElement.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", chrome(theme));
  } catch { /* pre-DOM, or a document being torn down */ }

  // The Android window's status and navigation bars. Optional on purpose: the
  // UI updates over the air and the shell does not, so a bundle that knows
  // about this may well be running inside an APK that does not.
  try {
    shellInterface<{ setTheme?: (t: string, bg: string) => void }>()?.setTheme?.(theme, chrome(theme));
  } catch { /* shell absent (browser) or an older interface */ }

  if (theme !== applied) {
    applied = theme;
    for (const fn of listeners) { try { fn(theme, choice); } catch { /* one listener must not stop the rest */ } }
  }
  return theme;
}

/** Record a pick and apply it. Local only — the key is not in the synced
 *  allow-list, so the patched `setItem` in `settings.ts` leaves it alone. */
export function setThemeChoice(choice: ThemeChoice): void {
  lsSet(LS.theme, choice);
  applyTheme();
}

/**
 * Called once from `main.tsx`. Applies the stored choice and subscribes to the
 * OS — the subscription matters even when the choice is not `system`, because
 * it can be switched back to `system` while the app is open, and the media
 * query has to already be listening for that to mean anything.
 */
export function installTheme(): void {
  applyTheme();
  // A fork's overlay arriving (or changing) repaints what is not CSS: the
  // chrome colour, and — through the listeners — the terminal's palette.
  onThemeOverlay(() => { applied = null; applyTheme(); });
  const m = mq();
  if (!m) return;
  const onOs = () => { if (themeChoice() === "system") applyTheme(); };
  if (typeof m.addEventListener === "function") m.addEventListener("change", onOs);
  else if (typeof (m as unknown as { addListener?: (f: () => void) => void }).addListener === "function") {
    (m as unknown as { addListener: (f: () => void) => void }).addListener(onOs);
  }
}
