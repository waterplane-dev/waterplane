/**
 * The live desktop extension's wire, typed once for both ends. Pure, no node imports: the host
 * compiles it, the phone bundles it. Plan: docs/analysis/desktop-stream-plan.md.
 *
 * Transport:
 * - **The picture** is the core's plugin stream `screen` (`api.stream`, plugin API 1.4). Binary
 *   frames on the one socket, `kind` = `FRAME_*` below.
 * - **Steering** is `stream.params` with a `DesktopParams`.
 * - **Clicks and keys** are `stream.input` with a `DesktopInput`.
 * - **What the host picked** comes back as `stream.status` with a `DesktopStatus`.
 * - **Questions with an answer** (probe, the window list) are `plugin.call` (`DesktopMethods`).
 *
 * The phone never knows desktop pixels. Every coordinate is normalised 0..1 of the SOURCE (the
 * whole display or window being captured, NOT the crop), so a crop change never moves a click.
 * `cleanDesktopParams` and `cleanDesktopInput` run on the HOST: whatever a phone sends, the helper
 * only ever sees clamped, known fields.
 */

export const PLUGIN_ID = "desktop";
export const STREAM_NAME = "screen";

/** The `control` switch's label, as the manifest declares it and the phone draws it. */
export const CONTROL_SWITCH = "Let the phone control this desktop";
/** Where that switch is on the phone, as drawn: the Tools & diagnostics group, its `plugins` row, the
 *  plugin's section (the manifest's name). One string for the host's words and the phone's —
 *  `logic.test.mjs` checks each step against the settings index and the manifest. */
export const CONTROL_SETTING_PATH = "Settings › Tools & diagnostics › plugins › Live desktop";

/** `kind` of a stream frame. These match the helper's stdout record kinds (helper/PROTOCOL.md). */
export const FRAME_H264 = 1;
export const FRAME_JPEG = 2;

export type DesktopCodec = "h264" | "jpeg";

export type DesktopSource =
  | { kind: "display"; id?: number }
  | { kind: "window"; id: number }
  | { kind: "front" };

/** A normalised rectangle, 0..1 of the source. */
export interface NormRect { x: number; y: number; w: number; h: number }

export interface DesktopParams {
  codec: DesktopCodec;
  source: DesktopSource;
  /** Stream only this part of the source (the zoomed-in view). Absent = all of it. */
  crop?: NormRect;
  /** Width in px of the encoded picture. 0 = the source's own. The phone sends its own pixel width. */
  maxWidth: number;
  fps: number;
  /** The cap. With `auto`, the host's controller moves below it and never above it. */
  bitrateKbps: number;
  auto: boolean;
  jpegQuality: number;
  /** JPEG only. In H.264 the saving is too small to be worth a knob. */
  grayscale: boolean;
  /** 0 = only on demand (a skip, a decoder error, a reopened view). */
  keyframeEverySec: number;
  cursor: boolean;
}

export const DEFAULT_PARAMS: DesktopParams = {
  codec: "h264",
  source: { kind: "display" },
  maxWidth: 1280,
  fps: 30,
  bitrateKbps: 4000,
  auto: true,
  jpegQuality: 50,
  grayscale: false,
  keyframeEverySec: 0,
  cursor: true,
};

export type PresetId = "auto" | "saver" | "balanced" | "sharp" | "stills";

export interface Preset {
  id: PresetId;
  label: string;
  /** One line under the label: what it is for. */
  hint: string;
  /** What it sets. `maxWidth` here is a FACTOR of the phone's own width (1 = fit phone, 0 = native). */
  set: Omit<Partial<DesktopParams>, "maxWidth" | "source" | "crop"> & { widthFactor: number };
}

export const PRESETS: readonly Preset[] = [
  { id: "auto", label: "Auto", hint: "Follows the connection, up to 4 Mbit/s", set: { codec: "h264", widthFactor: 1, fps: 30, bitrateKbps: 4000, auto: true } },
  { id: "saver", label: "Data saver", hint: "For cellular: 8 fps, about 150 kbit/s", set: { codec: "h264", widthFactor: 0.6, fps: 8, bitrateKbps: 150, auto: false } },
  { id: "balanced", label: "Balanced", hint: "15 fps, about 800 kbit/s", set: { codec: "h264", widthFactor: 1, fps: 15, bitrateKbps: 800, auto: false } },
  { id: "sharp", label: "Sharp text", hint: "Full resolution for reading code, about 3 Mbit/s", set: { codec: "h264", widthFactor: 0, fps: 30, bitrateKbps: 3000, auto: false } },
  { id: "stills", label: "Stills", hint: "A JPEG every half second. Works without the video decoder", set: { codec: "jpeg", widthFactor: 1, fps: 2, jpegQuality: 40, auto: false } },
];

/** The params a preset gives on a phone `phonePx` pixels wide, keeping source and crop. */
export function applyPreset(base: DesktopParams, id: PresetId, phonePx: number): DesktopParams {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return base;
  const { widthFactor, ...rest } = p.set;
  const maxWidth = widthFactor === 0 ? 0 : Math.round(clampNum(phonePx, 320, 4096, 1280) * widthFactor);
  return cleanDesktopParams({ ...base, ...rest, maxWidth });
}

const LIMITS = {
  maxWidth: [0, 7680],
  fps: [1, 60],
  bitrateKbps: [50, 20000],
  jpegQuality: [1, 100],
  keyframeEverySec: [0, 300],
} as const;

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

function cleanRect(v: unknown): NormRect | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const x = clampNum(r.x, 0, 1, Number.NaN), y = clampNum(r.y, 0, 1, Number.NaN);
  const w = clampNum(r.w, 0, 1, Number.NaN), h = clampNum(r.h, 0, 1, Number.NaN);
  if ([x, y, w, h].some(Number.isNaN)) return undefined;
  const cw = Math.min(w, 1 - x), ch = Math.min(h, 1 - y);
  // Smaller than 2% of a side is a pinch gone wrong, not a view anyone can read.
  if (cw < 0.02 || ch < 0.02) return undefined;
  if (x === 0 && y === 0 && cw >= 1 && ch >= 1) return undefined;
  return { x, y, w: cw, h: ch };
}

function cleanSource(v: unknown): DesktopSource {
  const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (s.kind === "window" && Number.isInteger(s.id) && (s.id as number) > 0) return { kind: "window", id: s.id as number };
  if (s.kind === "front") return { kind: "front" };
  if (Number.isInteger(s.id) && (s.id as number) >= 0) return { kind: "display", id: s.id as number };
  return { kind: "display" };
}

/** Any JSON in, a complete `DesktopParams` out: unknown fields dropped, numbers clamped, a missing
 *  field takes its default. Never throws. */
export function cleanDesktopParams(raw: unknown): DesktopParams {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PARAMS;
  const out: DesktopParams = {
    codec: r.codec === "jpeg" ? "jpeg" : "h264",
    source: cleanSource(r.source),
    maxWidth: Math.round(clampNum(r.maxWidth, ...LIMITS.maxWidth, d.maxWidth)),
    fps: Math.round(clampNum(r.fps, ...LIMITS.fps, d.fps)),
    bitrateKbps: Math.round(clampNum(r.bitrateKbps, ...LIMITS.bitrateKbps, d.bitrateKbps)),
    auto: typeof r.auto === "boolean" ? r.auto : d.auto,
    jpegQuality: Math.round(clampNum(r.jpegQuality, ...LIMITS.jpegQuality, d.jpegQuality)),
    grayscale: r.grayscale === true,
    keyframeEverySec: Math.round(clampNum(r.keyframeEverySec, ...LIMITS.keyframeEverySec, d.keyframeEverySec)),
    cursor: typeof r.cursor === "boolean" ? r.cursor : d.cursor,
  };
  const crop = cleanRect(r.crop);
  if (crop) out.crop = crop;
  return out;
}

// ── input ───────────────────────────────────────────────────────────────────

export type MouseButton = "l" | "r" | "m";
export type Modifier = "cmd" | "alt" | "ctrl" | "shift";

export type DesktopInput =
  | { k: "move"; x: number; y: number }
  | { k: "down" | "up"; b: MouseButton; x: number; y: number }
  | { k: "click"; b: MouseButton; x: number; y: number; n: number }
  | { k: "scroll"; x: number; y: number; dx: number; dy: number }
  | { k: "key"; key: string; mods: Modifier[] }
  | { k: "text"; s: string };

/** Named keys the helper maps. A single printable character is also a key. */
export const NAMED_KEYS = [
  "Escape", "Tab", "Return", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
] as const;

/** Typed text per event. A longer paste is sent as several events. */
export const TEXT_MAX = 500;
/** Pixels per scroll event, either way. */
export const SCROLL_MAX = 2000;

const MODS: readonly Modifier[] = ["cmd", "alt", "ctrl", "shift"];

function unit(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/** Any JSON in, one valid event or null. The host drops a null. A malformed click is never
 *  guessed into a click somewhere. */
export function cleanDesktopInput(raw: unknown): DesktopInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = unit(r.x), y = unit(r.y);
  const b: MouseButton | null = r.b === "l" || r.b === "r" || r.b === "m" ? r.b : null;
  switch (r.k) {
    case "move":
      return x === null || y === null ? null : { k: "move", x, y };
    case "down":
    case "up":
      return x === null || y === null || !b ? null : { k: r.k, b, x, y };
    case "click": {
      if (x === null || y === null || !b) return null;
      const n = r.n === 2 || r.n === 3 ? r.n : 1;
      return { k: "click", b, x, y, n };
    }
    case "scroll": {
      if (x === null || y === null) return null;
      const dx = clampNum(r.dx, -SCROLL_MAX, SCROLL_MAX, 0), dy = clampNum(r.dy, -SCROLL_MAX, SCROLL_MAX, 0);
      return dx === 0 && dy === 0 ? null : { k: "scroll", x, y, dx: Math.round(dx), dy: Math.round(dy) };
    }
    case "key": {
      const key = typeof r.key === "string" ? r.key : "";
      const ok = (NAMED_KEYS as readonly string[]).includes(key) || [...key].length === 1;
      if (!ok) return null;
      const mods = Array.isArray(r.mods) ? MODS.filter((m) => (r.mods as unknown[]).includes(m)) : [];
      return { k: "key", key, mods };
    }
    case "text": {
      if (typeof r.s !== "string" || !r.s) return null;
      return { k: "text", s: [...r.s].slice(0, TEXT_MAX).join("") };
    }
    default:
      return null;
  }
}

// ── status and calls ────────────────────────────────────────────────────────

/** `stream.status` data. What the host is actually doing for this view: the phone draws its stats
 *  chip and every "why" from this, never from what it asked for. */
export interface DesktopStatus {
  state: "starting" | "running" | "error" | "stopped";
  /** The sentence for `error` (a missing permission names the System Settings pane). */
  reason?: string;
  codec?: DesktopCodec;
  /** The encoded picture. */
  width?: number;
  height?: number;
  /** The source, in pixels. */
  srcWidth?: number;
  srcHeight?: number;
  fps?: number;
  /** What the Auto controller picked right now (or the fixed cap). */
  bitrateKbps?: number;
  /**
   * Whether clicks and keys reach the desktop, and if not, why (setting off, permission missing).
   * `needs` names each missing gate so the view can put the one tap that fixes it beside its words;
   * absent from an older host (the sentence still says it) and while Accessibility is unknown.
   */
  control: { on: boolean; reason?: string; needs?: ControlNeed[] };
  /**
   * The region of the source the frames now being SENT cover (the full source is `{0,0,1,1}`), and
   * a counter that grows with every change of it. Not "the crop last asked for": the helper writes
   * a status naming a new region immediately before the first frame encoded for it, so on the one
   * ordered socket this status is followed by that region's frames and by no earlier region's.
   * Absent until the first frame has been encoded; a status without them changes nothing on the phone.
   */
  crop?: NormRect;
  regionSeq?: number;
}

/** A gate between the phone's taps and the desktop: the person's switch, or macOS's Accessibility grant. */
export type ControlNeed = "setting" | "accessibility";

/** `scale` (source pixels per point) is absent when the helper did not say: never guessed as 1. */
export interface DesktopDisplay { id: number; width: number; height: number; scale?: number; main: boolean }
export interface DesktopWindow { id: number; app: string; title: string }

/** `plugin.call` methods. `probe` is cheap and is what the segment and the home button ask. */
export interface DesktopMethods {
  probe: {
    args: Record<string, never>;
    result: {
      /** False on anything but macOS, or without the helper. `reason` says which. */
      available: boolean;
      reason?: string;
      screenRecording: boolean | null;
      accessibility: boolean | null;
      controlEnabled: boolean;
      displays: DesktopDisplay[];
    };
  };
  windows: { args: Record<string, never>; result: { windows: DesktopWindow[] } };
  /**
   * A person's tap asking macOS for one grant: the same as the desktop checklist's Fix (macOS's
   * dialog on the desktop's screen, else the System Settings pane). `note` says which happened.
   */
  grant: { args: { kind: "screen" | "accessibility" }; result: { applied: boolean; note: string } };
}
