/**
 * **A fork's look: `<config dir>/theme.json`**, validated the same way at both ends.
 *
 *     { "displayName": "acme remote",
 *       "colors":   { "dark":  { "--accent": "#ff7a00" },
 *                     "light": { "accent":   "#b34d00" } },
 *       "terminal": { "dark":  { "background": "#101214", "foreground": "#e6e6e6" } } }
 *
 * Every key is optional and an absent file is today's app byte for byte. The
 * host reads the file (`host/themeoverlay.ts`), serves the CLEANED overlay on
 * `GET /api/theme`, and the phone runs the same `cleanThemeOverlay` over what it
 * got (and over its own cached copy) before applying it — a value either end
 * did not validate is never painted.
 *
 * - `colors` — overrides of the CSS custom properties on `:root` in
 *   `web/src/styles.css`, per theme. A key is a token name with or without the
 *   leading `--`; anything not in `THEME_TOKENS` is IGNORED with a note (never
 *   applied, never fatal). A value is a colour — hex, `rgb()`/`rgba()`,
 *   `hsl()`/`hsla()` — and is re-serialised from its parsed channels, so no text
 *   from the file ever reaches a stylesheet. A hue token whose washes are derived
 *   from a channel triple (`--accent` → `--accent-rgb`) is applied AS that triple,
 *   so its tints follow it; those must be opaque.
 * - `terminal` — the grid's background/foreground per theme. This is the ONE
 *   statement of them: `termColorsFor` feeds the phone's xterm palette, the
 *   host's OSC 10/11 answers to tmux (`host/termqueries.ts`), and `--term-bg`
 *   (which is therefore not a `colors` key — `.term-wrap` must equal the grid).
 * - `displayName` — what the running UI calls itself (title, logo, wordmark, the
 *   served manifest). Build-time brand (`shared/brand.ts`, Android) is not this.
 *   It lives in this file rather than a `brand.json` of its own because it is
 *   the only brand field a running install can change: one file, one read, one
 *   cache key, one doctor entry, and no file whose name promises the rest of
 *   `BRAND` is overridable.
 * - `icons` — the fork's own icons, slot → a path RELATIVE to the config dir
 *   (`"icons": { "favicon": "icons/mark.svg", "192": "icons/192.png" }`). The
 *   rule here is only the path's SHAPE (relative, no `..`, `.png`/`.svg`); the
 *   host resolves it, realpath-compares it against the config dir, sniffs the
 *   bytes, and serves it at `/theme-icon/<slot>` (`host/themeoverlay.ts`). The
 *   served shell's `<link rel="icon">`s and the manifest's `icons` point there;
 *   a slot not given keeps the built-in icon. Never sent to the phone: the
 *   paths are the desktop's business, the shell already carries the links.
 */
import { TERM_COLORS, type TermColors, type TermThemeName } from "./termpalette.js";

/**
 * The overridable tokens: every custom property declared on `:root` in
 * `styles.css` that holds a colour, minus the channel triples (`*-rgb`, derived)
 * and `--term-bg` (the terminal's). `web/src/themeOverlay.test.mjs` parses the
 * stylesheet and holds this list to it, both ways.
 */
export const THEME_TOKENS: readonly string[] = [
  "--bg", "--panel", "--sub", "--raise", "--well", "--line", "--pipe-bg",
  "--fg", "--muted", "--dim", "--ring",
  "--accent", "--ok", "--dead", "--warn", "--star", "--limit", "--ask", "--pair",
  "--purple", "--sched", "--defer", "--ctx-low",
  "--on-accent", "--on-accent-strong", "--on-accent-line", "--on-dead", "--on-ok", "--on-limit", "--on-star", "--on-media",
  "--accent-wash", "--accent-tint", "--accent-tint-hi", "--accent-edge", "--accent-edge-hi",
  "--ok-wash", "--ok-edge",
  "--dead-wash", "--dead-tint", "--dead-edge", "--dead-edge-hi",
  "--warn-wash", "--warn-tint", "--warn-tint-hi", "--warn-edge",
  "--star-wash", "--star-edge", "--star-edge-hi",
  "--limit-edge",
  "--ask-wash", "--ask-tint-hi", "--ask-edge",
  "--ctx-low-edge",
  "--hover-soft", "--hover", "--hover-hi", "--sheen",
  "--panel-veil", "--panel-veil-hi", "--bg-veil",
  "--scrim", "--scrim-media", "--scrim-label", "--shadow", "--shadow-soft",
  "--media-bg", "--paper",
  "--chart-1", "--chart-2", "--chart-3", "--chart-4",
  "--ctx-series", "--ctx-compact", "--ctx-limit",
  "--repo-veil", "--repo-veil-on",
];

/** Tokens declared as `rgb(var(<token>-rgb))`: an override is written to the triple. */
export const THEME_RGB_TOKENS: readonly string[] = ["--accent", "--ok", "--dead", "--warn", "--star", "--limit", "--ask", "--pair"];

const TOKENS = new Set(THEME_TOKENS);
const RGB_TOKENS = new Set(THEME_RGB_TOKENS);
const THEMES: readonly TermThemeName[] = ["dark", "light"];
export const DISPLAY_NAME_MAX = 40;

/**
 * The icon slots a fork may replace, and what each one stands in for:
 * `favicon` every `<link rel="icon">` (and the manifest's `any`-sized SVG when
 * it is one), `apple-touch` the `apple-touch-icon`, `192`/`512`/`maskable` the
 * manifest entries of those sizes.
 */
export const THEME_ICON_SLOTS = ["favicon", "apple-touch", "192", "512", "maskable"] as const;
export type ThemeIconSlot = (typeof THEME_ICON_SLOTS)[number];
const ICON_SLOTS = new Set<string>(THEME_ICON_SLOTS);
/** Relative, segment by segment, no dot-segments, no backslashes, `.png`/`.svg`. */
const ICON_PATH_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.(?:png|svg)$/;
export const ICON_PATH_MAX = 200;
/** A slot's path as the file wrote it, when its shape is acceptable. */
export const themeIconPathOk = (p: unknown): p is string =>
  typeof p === "string" && p.length <= ICON_PATH_MAX && ICON_PATH_RE.test(p) && !p.split("/").some((seg) => seg === "." || seg === "..");

export interface ThemeOverlay {
  displayName?: string;
  /** Cleaned: slot → a config-dir-relative path of acceptable shape (host-only). */
  icons?: Partial<Record<ThemeIconSlot, string>>;
  /** Cleaned: token (with `--`) → a serialised colour. */
  colors?: Partial<Record<TermThemeName, Record<string, string>>>;
  /** Cleaned: `#rrggbb` only (the host answers tmux in X11 `rgb:` form). */
  terminal?: Partial<Record<TermThemeName, Partial<TermColors>>>;
}

export interface Rgba { r: number; g: number; b: number; a: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100; h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as [number, number, number];
}

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
const FUNC_RE = new RegExp(String.raw`^(rgba?|hsla?)\(\s*(${NUM})(%?)(?:\s*,\s*|\s+)(${NUM})(%?)(?:\s*,\s*|\s+)(${NUM})(%?)(?:\s*(?:,|\/)\s*(${NUM})(%?))?\s*\)$`, "i");

/** A colour value, parsed — or null. Hex (3/4/6/8), `rgb[a]()`, `hsl[a]()`; nothing else (no names, no `var()`). */
export function parseThemeColour(v: unknown): Rgba | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  m = FUNC_RE.exec(s);
  if (!m) return null;
  const fn = m[1].toLowerCase();
  const alpha = m[8] === undefined ? 1 : clamp(Number(m[8]) / (m[9] ? 100 : 1), 0, 1);
  if (fn.startsWith("rgb")) {
    const ch = (x: string, pct: string) => Math.round(clamp(pct ? (Number(x) * 255) / 100 : Number(x), 0, 255));
    return { r: ch(m[2], m[3]), g: ch(m[4], m[5]), b: ch(m[6], m[7]), a: alpha };
  }
  if (m[3] || !m[5] || !m[7]) return null; // hsl: a bare hue, two percentages
  const [r, g, b] = hslToRgb(Number(m[2]), Number(m[4]), Number(m[6]));
  return { r, g, b, a: alpha };
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const hexOf = (c: Rgba) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
/** The one serialisation a cleaned overlay holds: `#rrggbb`, or `rgb(r g b / a)` with alpha. */
const serialise = (c: Rgba) => (c.a >= 1 ? hexOf(c) : `rgb(${c.r} ${c.g} ${c.b} / ${Math.round(c.a * 1000) / 1000})`);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Clean whatever claims to be an overlay. Never throws: everything it cannot
 * use is dropped and said in `notes`, one sentence per entry.
 */
export function cleanThemeOverlay(raw: unknown): { overlay: ThemeOverlay; notes: string[] } {
  const notes: string[] = [];
  const overlay: ThemeOverlay = {};
  if (!isObj(raw)) {
    if (raw !== undefined && raw !== null) notes.push("top level must be an object; nothing applied");
    return { overlay, notes };
  }
  for (const k of Object.keys(raw)) {
    if (k !== "displayName" && k !== "colors" && k !== "terminal" && k !== "icons" && !k.startsWith("//")) notes.push(`unknown key "${k}" ignored (allowed: displayName, colors, terminal, icons)`);
  }

  if (raw.displayName !== undefined) {
    const d = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
     
    if (!d || d.length > DISPLAY_NAME_MAX || /[\u0000-\u001f\u007f]/.test(d)) {
      notes.push(`"displayName" must be 1–${DISPLAY_NAME_MAX} printable characters; ignored`);
    } else overlay.displayName = d;
  }

  if (raw.colors !== undefined) {
    if (!isObj(raw.colors)) notes.push(`"colors" must be an object of { dark, light }; ignored`);
    else {
      for (const t of Object.keys(raw.colors)) {
        if (!THEMES.includes(t as TermThemeName)) { notes.push(`"colors.${t}" ignored (allowed: dark, light)`); continue; }
        const set: unknown = (raw.colors as Record<string, unknown>)[t];
        if (!isObj(set)) { notes.push(`"colors.${t}" must be an object of token → colour; ignored`); continue; }
        const out: Record<string, string> = {};
        for (const [key, val] of Object.entries(set)) {
          const tok = key.startsWith("--") ? key : `--${key}`;
          if (tok === "--term-bg") { notes.push(`"colors.${t}.${key}" ignored: set "terminal.${t}.background" instead (the grid and its frame are one colour)`); continue; }
          if (!TOKENS.has(tok)) { notes.push(`"colors.${t}.${key}" ignored: not a colour token of this version`); continue; }
          const c = parseThemeColour(val);
          if (!c) { notes.push(`"colors.${t}.${key}" ignored: ${JSON.stringify(val)} is not a colour (hex, rgb(), hsl())`); continue; }
          if (RGB_TOKENS.has(tok) && c.a < 1) { notes.push(`"colors.${t}.${key}" ignored: must be opaque (its tints are derived from it)`); continue; }
          out[tok] = serialise(c);
        }
        if (Object.keys(out).length) (overlay.colors ??= {})[t as TermThemeName] = out;
      }
    }
  }

  if (raw.terminal !== undefined) {
    if (!isObj(raw.terminal)) notes.push(`"terminal" must be an object of { dark, light }; ignored`);
    else {
      for (const t of Object.keys(raw.terminal)) {
        if (!THEMES.includes(t as TermThemeName)) { notes.push(`"terminal.${t}" ignored (allowed: dark, light)`); continue; }
        const set: unknown = (raw.terminal as Record<string, unknown>)[t];
        if (!isObj(set)) { notes.push(`"terminal.${t}" must be an object of { background, foreground }; ignored`); continue; }
        const out: Partial<TermColors> = {};
        for (const [key, val] of Object.entries(set) as [string, unknown][]) {
          if (key !== "background" && key !== "foreground") { notes.push(`"terminal.${t}.${key}" ignored (allowed: background, foreground)`); continue; }
          const c = parseThemeColour(val);
          if (!c || c.a < 1) { notes.push(`"terminal.${t}.${key}" ignored: ${JSON.stringify(val)} is not an opaque colour`); continue; }
          out[key] = hexOf(c);
        }
        if (Object.keys(out).length) (overlay.terminal ??= {})[t as TermThemeName] = out;
      }
    }
  }
  if (raw.icons !== undefined) {
    if (!isObj(raw.icons)) notes.push(`"icons" must be an object of slot → path; ignored`);
    else {
      const out: Partial<Record<ThemeIconSlot, string>> = {};
      for (const [slot, val] of Object.entries(raw.icons)) {
        if (!ICON_SLOTS.has(slot)) { notes.push(`"icons.${slot}" ignored (allowed: ${THEME_ICON_SLOTS.join(", ")})`); continue; }
        if (!themeIconPathOk(val)) { notes.push(`"icons.${slot}" ignored: ${JSON.stringify(val)} is not a .png/.svg path relative to the config dir`); continue; }
        out[slot as ThemeIconSlot] = val;
      }
      if (Object.keys(out).length) overlay.icons = out;
    }
  }
  return { overlay, notes };
}

/** The file's text → a cleaned overlay, or why the whole file was ignored. */
export function parseThemeOverlay(text: string): { overlay: ThemeOverlay; notes: string[] } | { error: string } {
  let j: unknown;
  try { j = JSON.parse(text); } catch (e) { return { error: `not valid JSON (${(e as Error).message})` }; }
  if (!isObj(j)) return { error: "top level must be an object" };
  return cleanThemeOverlay(j);
}

export const themeOverlayEmpty = (o: ThemeOverlay | null | undefined): boolean =>
  !o || (o.displayName === undefined && !o.colors && !o.terminal && !o.icons);

/**
 * The terminal's colours for a theme. With no override this IS `TERM_COLORS[theme]`
 * (the same object), so a caller comparing by identity still can.
 */
export function termColorsFor(theme: TermThemeName, overlay?: ThemeOverlay | null): TermColors {
  const o = overlay?.terminal?.[theme];
  if (!o || (!o.background && !o.foreground)) return TERM_COLORS[theme];
  return { ...TERM_COLORS[theme], ...o };
}

/**
 * The stylesheet an overlay adds, or `""` when it adds nothing. The selectors
 * out-rank `styles.css`'s `:root, [data-theme="dark"]` / `[data-theme="light"]`
 * by one element, so order of insertion does not matter.
 */
export function themeOverlayCss(overlay: ThemeOverlay | null | undefined): string {
  if (!overlay) return "";
  const blocks: string[] = [];
  for (const t of THEMES) {
    const decls: string[] = [];
    for (const [tok, val] of Object.entries(overlay.colors?.[t] ?? {})) {
      if (!TOKENS.has(tok)) continue;
      const c = parseThemeColour(val);
      if (!c) continue;
      if (RGB_TOKENS.has(tok)) decls.push(`${tok}-rgb: ${c.r} ${c.g} ${c.b};`);
      else decls.push(`${tok}: ${serialise(c)};`);
    }
    const bg = overlay.terminal?.[t]?.background;
    if (bg && parseThemeColour(bg)) decls.push(`--term-bg: ${hexOf(parseThemeColour(bg)!)};`);
    if (!decls.length) continue;
    const sel = t === "light" ? `html[data-theme="light"]` : `html:not([data-theme="light"])`;
    blocks.push(`${sel} { ${decls.join(" ")} }`);
  }
  return blocks.join("\n");
}

/** The page background an overlay sets for a theme (for `theme-color` and the shell's bars), as `#rrggbb`, else null. */
export function overlayChromeBg(theme: TermThemeName, overlay?: ThemeOverlay | null): string | null {
  const c = parseThemeColour(overlay?.colors?.[theme]?.["--bg"]);
  return c ? hexOf(c) : null;
}

/** One line for a doctor row: what this overlay changes. */
export function describeThemeOverlay(o: ThemeOverlay): string {
  const parts: string[] = [];
  if (o.displayName !== undefined) parts.push(`name "${o.displayName}"`);
  const n = THEMES.reduce((s, t) => s + Object.keys(o.colors?.[t] ?? {}).length, 0);
  if (n) parts.push(`${n} colour${n === 1 ? "" : "s"}`);
  if (o.terminal) parts.push(`terminal ${THEMES.filter((t) => o.terminal?.[t]).join("+")}`);
  if (o.icons) parts.push(`icons ${THEME_ICON_SLOTS.filter((s) => o.icons?.[s]).join("+")}`);
  return parts.length ? parts.join(", ") : "nothing usable";
}
