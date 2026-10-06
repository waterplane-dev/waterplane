/**
 * **A fork's look, read off `<config dir>/theme.json`** — the third config
 * overlay beside `prompts/<name>.md` (`prompts.ts`) and `models.json`
 * (`backends/claudemodels.ts`), same posture: optional, never throws, a bad
 * file is one log line and today's behaviour. The shape and every rule about
 * what is kept live in `@waterplane/shared`'s `themeoverlay.ts`, which the phone
 * runs again over what this serves.
 *
 * Read on demand with an mtime+size check, so an edit takes effect on the next
 * read (the phone's next boot, the next tmux colour query) with no restart and
 * no file read per query.
 *
 * Who reads it: `GET /api/theme` (`api.ts`), the tmux OSC 10/11 answers
 * (`hostTermColors`, `sessions.ts` → `termqueries.ts`), the served
 * `manifest.webmanifest` and `index.html` (`brandManifest`, `brandIndexHtml`,
 * `server/http.ts`), the icon files at `/theme-icon/<slot>` (`themeIconFile`)
 * and the doctor's `overlays` row (`overlaysCheck`).
 *
 * **Icons are files from the config dir, so they get the containment rule.** A
 * slot's path is shape-checked in `shared` (relative, no `..`, `.png`/`.svg`),
 * then resolved HERE with symlinks followed on BOTH sides (`realResolve`, the
 * same comparison `inRoot` makes — `/var` → `/private/var`) and refused unless
 * it lands inside the config dir; then it must be a regular file under
 * `ICON_MAX_BYTES` whose bytes ARE what its extension says (PNG signature, an
 * `<svg` root). Only a slot `theme.json` names is ever served — the URL carries
 * the slot, never a path — and an SVG goes out under a `default-src 'none'`
 * CSP with `nosniff`, so a fork's logo opened as a page runs nothing on the
 * app's origin.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import {
  describeThemeOverlay, parseThemeOverlay, termColorsFor, themeIconPathOk, themeOverlayEmpty,
  THEME_ICON_SLOTS, type TermColors, type ThemeIconSlot, type ThemeOverlay,
} from "@waterplane/shared";
import { configDir } from "./branddirs.js";
import { realResolve } from "./paths.js";
import { overriddenPrompts } from "./prompts.js";
import { parseModelsOverride } from "./backends/claudemodels.js";

export interface ThemeOverlayState {
  file: string;
  /** The file exists. */
  present: boolean;
  /** The cleaned overlay — `{}` when absent or ignored whole. */
  overlay: ThemeOverlay;
  /** Entries dropped, one sentence each. */
  notes: string[];
  /** Why the whole file was ignored, when it was. */
  error?: string;
}

export const themeFile = (): string => join(configDir(), "theme.json");

let cache: { file: string; tag: string; state: ThemeOverlayState } | null = null;
const said = new Set<string>();

/** The overlay as the file says right now. Never throws. */
export function themeOverlayState(file: string = themeFile()): ThemeOverlayState {
  let tag = "absent";
  try { const st = statSync(file); tag = `${st.size}:${st.mtimeMs}`; } catch { /* absent */ }
  if (cache && cache.file === file && cache.tag === tag) return cache.state;
  let state: ThemeOverlayState;
  if (tag === "absent") state = { file, present: false, overlay: {}, notes: [] };
  else {
    try {
      const r = parseThemeOverlay(readFileSync(file, "utf8"));
      state = "error" in r
        ? { file, present: true, overlay: {}, notes: [], error: r.error }
        : { file, present: true, overlay: r.overlay, notes: r.notes };
    } catch (e) {
      state = { file, present: true, overlay: {}, notes: [], error: `unreadable (${(e as Error).message})` };
    }
    const key = `${file}\0${tag}`;
    if (!said.has(key)) {
      said.add(key);
      if (state.error) console.warn(`[theme] ${file} ignored: ${state.error}; using the built-in look`);
      for (const n of state.notes) console.warn(`[theme] ${file}: ${n}`);
    }
  }
  cache = { file, tag, state };
  return state;
}

/** What the tmux client is told its colours are (OSC 10/11). Dark, as before
 *  this overlay existed — the host has no phone theme to follow. */
export function hostTermColors(): TermColors {
  return termColorsFor("dark", themeOverlayState().overlay);
}

/** What `/api/theme` sends: the cleaned overlay minus `icons` (desktop paths; the shell carries the links). */
export function wireThemeOverlay(o: ThemeOverlay): ThemeOverlay {
  if (!o.icons) return o;
  const { icons: _icons, ...rest } = o;
  return rest;
}

export const ICON_MAX_BYTES = 1024 * 1024;
export const THEME_ICON_PREFIX = "/theme-icon/";

export interface ThemeIconFile { slot: ThemeIconSlot; file: string; mime: "image/png" | "image/svg+xml"; body: Buffer; tag: string }

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A slot's icon, resolved, contained and sniffed — or why not, in words.
 * `dir` is the config dir (a parameter for the tests). Never throws.
 */
export function themeIconFile(slot: string, overlay: ThemeOverlay = themeOverlayState().overlay, dir: string = configDir()): ThemeIconFile | { error: string } {
  if (!(THEME_ICON_SLOTS as readonly string[]).includes(slot)) return { error: `unknown icon slot "${slot}"` };
  const rel = overlay.icons?.[slot as ThemeIconSlot];
  if (rel === undefined) return { error: `no "${slot}" icon set` };
  // Shape again: this module must not trust that the overlay came through the cleaner.
  if (!themeIconPathOk(rel) || isAbsolute(rel)) return { error: `"${slot}": not a .png/.svg path relative to the config dir` };
  const root = realResolve(dir);
  const file = realResolve(join(dir, rel));
  if (!file.startsWith(root + sep)) return { error: `"${slot}": ${rel} resolves outside the config dir; refused` };
  let size = 0; let mtimeMs = 0;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { error: `"${slot}": ${rel} is not a file` };
    size = st.size; mtimeMs = st.mtimeMs;
  } catch { return { error: `"${slot}": ${rel} not found` }; }
  if (size > ICON_MAX_BYTES) return { error: `"${slot}": ${rel} is over ${ICON_MAX_BYTES / 1024} KB` };
  let body: Buffer;
  try { body = readFileSync(file); } catch (e) { return { error: `"${slot}": ${rel} unreadable (${(e as Error).message})` }; }
  const svg = rel.endsWith(".svg");
  const ok = svg ? /<svg[\s>]/i.test(body.subarray(0, 4096).toString("utf8")) : body.subarray(0, 8).equals(PNG_SIG);
  if (!ok) return { error: `"${slot}": ${rel} is not ${svg ? "an SVG" : "a PNG"}` };
  const tag = `${size.toString(36)}${Math.floor(mtimeMs).toString(36)}`;
  return { slot: slot as ThemeIconSlot, file, mime: svg ? "image/svg+xml" : "image/png", body, tag };
}

/** Every slot that resolves right now → its served URL (cache-busted by size+mtime). */
export function themeIconUrls(overlay: ThemeOverlay = themeOverlayState().overlay, dir: string = configDir()): Partial<Record<ThemeIconSlot, { url: string; mime: string }>> {
  const out: Partial<Record<ThemeIconSlot, { url: string; mime: string }>> = {};
  for (const slot of THEME_ICON_SLOTS) {
    if (!overlay.icons?.[slot]) continue;
    const r = themeIconFile(slot, overlay, dir);
    if ("error" in r) continue;
    out[slot] = { url: `${THEME_ICON_PREFIX}${slot}?v=${r.tag}`, mime: r.mime };
  }
  return out;
}

/** A short validator suffix for a served shell file that embeds these URLs ("" with none). */
export const iconUrlsTag = (icons: Partial<Record<ThemeIconSlot, { url: string }>>): string =>
  THEME_ICON_SLOTS.filter((s) => icons[s]).map((s) => icons[s]!.url.split("?v=")[1] ?? "").join(".");

type IconUrls = Partial<Record<ThemeIconSlot, { url: string; mime: string }>>;

/**
 * The PWA manifest with the overlay's display name and icons, or `body`
 * unchanged. An icon entry is replaced only by the slot of its own size —
 * `192`, `512`, `maskable` by purpose, `favicon` the `any`-sized SVG when it is
 * an SVG — so a slot not given keeps the built-in one.
 */
export function brandManifest(body: Buffer, displayName: string | undefined, icons: IconUrls = {}): Buffer {
  const anyIcon = Object.keys(icons).length > 0;
  if (!displayName && !anyIcon) return body;
  try {
    const j = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    if (displayName) { j.name = displayName; j.short_name = displayName; }
    if (anyIcon && Array.isArray(j.icons)) {
      j.icons = (j.icons as Record<string, unknown>[]).map((e) => {
        const slot: ThemeIconSlot | null =
          e.purpose === "maskable" ? "maskable"
          : e.sizes === "192x192" ? "192"
          : e.sizes === "512x512" ? "512"
          : e.sizes === "any" && icons.favicon?.mime === "image/svg+xml" ? "favicon"
          : null;
        const r = slot ? icons[slot] : undefined;
        if (!r) return e;
        // The entry keeps its declared size: the fork supplies the size the slot names.
        return { ...e, src: r.url, type: r.mime };
      });
    }
    return Buffer.from(JSON.stringify(j, null, 2) + "\n");
  } catch {
    return body;
  }
}

/**
 * The served `index.html` with a fork's icons: `favicon` replaces every
 * `<link rel="icon">` with one link, `apple-touch` the `apple-touch-icon`'s
 * href. No icons ⇒ the same bytes.
 */
export function brandIndexHtml(body: Buffer, icons: IconUrls): Buffer {
  if (!icons.favicon && !icons["apple-touch"]) return body;
  let html = body.toString("utf8");
  if (icons.favicon) {
    let first = true;
    html = html.replace(/[ \t]*<link rel="icon"[^>]*>\n?/g, (m) => {
      if (!first) return "";
      first = false;
      const indent = /^[ \t]*/.exec(m)?.[0] ?? "";
      return `${indent}<link rel="icon" type="${icons.favicon!.mime}" href="${icons.favicon!.url}" />\n`;
    });
  }
  const at = icons["apple-touch"];
  if (at) html = html.replace(/(<link rel="apple-touch-icon"[^>]*href=")[^"]*(")/, `$1${at.url}$2`);
  return Buffer.from(html);
}

export interface OverlayCheck { id: "overlays"; status: "ok" | "warn"; detail: string; fix?: string }

/**
 * The doctor's `overlays` row: which fork overlays are active in the config
 * dir, and whether any entry was refused. `ok` with none is the normal case.
 */
export function overlaysCheck(): OverlayCheck {
  const dir = configDir();
  const active: string[] = [];
  const bad: string[] = [];
  const prompts = overriddenPrompts();
  if (prompts.length) active.push(`prompts/ (${prompts.join(", ")})`);

  const modelsFile = join(dir, "models.json");
  let modelsText: string | null = null;
  try { modelsText = readFileSync(modelsFile, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") bad.push(`models.json unreadable`);
  }
  if (modelsText !== null) {
    const r = parseModelsOverride(modelsText);
    if ("error" in r) bad.push(`models.json ignored: ${r.error}`);
    else active.push(`models.json (+${r.add.aliases.length + r.add.ids.length} / −${r.hide.length})`);
  }

  const t = themeOverlayState(join(dir, "theme.json"));
  if (t.error) bad.push(`theme.json ignored: ${t.error}`);
  else if (t.present) {
    if (!themeOverlayEmpty(t.overlay)) active.push(`theme.json (${describeThemeOverlay(t.overlay)})`);
    for (const slot of THEME_ICON_SLOTS) {
      if (!t.overlay.icons?.[slot]) continue;
      const r = themeIconFile(slot, t.overlay, dir);
      if ("error" in r) bad.push(`theme.json icon ${r.error}`);
    }
    if (t.notes.length) bad.push(`theme.json: ${t.notes.length} entr${t.notes.length === 1 ? "y" : "ies"} ignored — ${t.notes[0]}${t.notes.length > 1 ? " …" : ""}`);
  }

  const detail = active.length ? `active in ${dir}: ${active.join(" · ")}` : `none in ${dir} — upstream defaults`;
  if (!bad.length) return { id: "overlays", status: "ok", detail };
  return {
    id: "overlays", status: "warn",
    detail: `${detail}; ${bad.join("; ")}`,
    fix: "Fix or remove the named entries — an ignored entry keeps the built-in value (CONTRIBUTING.md, Forks).",
  };
}
