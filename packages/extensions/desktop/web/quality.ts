/**
 * The Quality sheet's state and the `DesktopParams` it means. Pure (`quality.test.mjs`).
 *
 * The person picks a PRESET (`wire.mts` `PRESETS`) or Custom knobs; the source and "Crop to view"
 * are theirs in both. What is remembered (per host, through the SDK's `extStorage`) is the CHOICE,
 * never the params the view computed from it — a phone held the other way, or a crop, is this
 * moment's, not a preference. The view adds the moment: the phone's pixel width and the crop.
 */
import {
  DEFAULT_PARAMS, PRESETS, applyPreset, cleanDesktopParams,
  type DesktopCodec, type DesktopParams, type DesktopSource, type NormRect, type PresetId,
} from "../shared/wire.mts";
import type { InputMode } from "./gestures.ts";

export type Resolution = "fit" | "half" | "third" | "native";
export const RESOLUTIONS: readonly { id: Resolution; label: string; factor: number }[] = [
  { id: "fit", label: "fit phone", factor: 1 },
  { id: "half", label: "½ phone", factor: 0.5 },
  { id: "third", label: "⅓ phone", factor: 1 / 3 },
  { id: "native", label: "native", factor: 0 },
];
export const FPS_STEPS = [2, 5, 8, 15, 30, 60] as const;
export const BITRATE_STEPS = [150, 300, 800, 1500, 3000, 6000] as const;
export const JPEG_Q_STEPS = [20, 40, 60, 80] as const;
export const KEYFRAME_STEPS: readonly { s: number; label: string }[] = [
  { s: 0, label: "on demand" }, { s: 5, label: "5 s" }, { s: 10, label: "10 s" }, { s: 30, label: "30 s" },
];
export const CAP_STEPS = [0, 20, 50, 100, 250] as const;

export interface CustomKnobs {
  codec: DesktopCodec;
  res: Resolution;
  fps: number;
  bitrateKbps: number;
  jpegQuality: number;
  grayscale: boolean;
  keyframeEverySec: number;
  cursor: boolean;
}

export interface QualityChoice {
  preset: PresetId | "custom";
  custom: CustomKnobs;
  source: DesktopSource;
  cropToView: boolean;
  /** Start in Data saver on a cellular connection (and say so). */
  cellularSaver: boolean;
  /** Pause after this many MB in one view; 0 = no cap. */
  capMb: number;
  mode: InputMode;
}

export const DEFAULT_CUSTOM: CustomKnobs = {
  codec: "h264", res: "fit", fps: 15, bitrateKbps: 800, jpegQuality: 50, grayscale: false, keyframeEverySec: 0, cursor: true,
};

export const DEFAULT_CHOICE: QualityChoice = {
  preset: "auto", custom: DEFAULT_CUSTOM, source: { kind: "display" }, cropToView: true, cellularSaver: true, capMb: 0, mode: "touch",
};

const PRESET_IDS = new Set<string>(PRESETS.map((p) => p.id));
const pick = <T,>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** Whatever storage held (an older build's shape, a hand edit, nothing) → a whole choice. */
export function cleanChoice(raw: unknown): QualityChoice {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c = (r.custom && typeof r.custom === "object" ? r.custom : {}) as Record<string, unknown>;
  const d = DEFAULT_CHOICE, dc = DEFAULT_CUSTOM;
  // The source goes through the wire's own cleaner: one reading of what a source may be.
  const source = cleanDesktopParams({ source: r.source }).source;
  return {
    preset: r.preset === "custom" || PRESET_IDS.has(r.preset as string) ? (r.preset as QualityChoice["preset"]) : d.preset,
    custom: {
      codec: c.codec === "jpeg" ? "jpeg" : "h264",
      res: pick(c.res, RESOLUTIONS.map((x) => x.id), dc.res),
      fps: num(c.fps, 1, 60, dc.fps),
      bitrateKbps: num(c.bitrateKbps, 50, 20000, dc.bitrateKbps),
      jpegQuality: num(c.jpegQuality, 1, 100, dc.jpegQuality),
      grayscale: c.grayscale === true,
      keyframeEverySec: num(c.keyframeEverySec, 0, 300, dc.keyframeEverySec),
      cursor: typeof c.cursor === "boolean" ? c.cursor : dc.cursor,
    },
    source,
    cropToView: typeof r.cropToView === "boolean" ? r.cropToView : d.cropToView,
    cellularSaver: typeof r.cellularSaver === "boolean" ? r.cellularSaver : d.cellularSaver,
    capMb: num(r.capMb, 0, 100_000, d.capMb),
    mode: pick(r.mode, ["touch", "trackpad", "view"] as const, d.mode),
  };
}

/** The most frames a second worth asking for in JPEG when it was not chosen: every frame is a
 *  whole picture, and 30 of them a second is several Mbit/s. */
export const FORCED_JPEG_FPS = 5;

export interface Moment {
  /** The phone's own width in DEVICE pixels (CSS width × devicePixelRatio). */
  phonePx: number;
  /** The visible part of the source, when Crop to view is on and the view is zoomed in. */
  crop: NormRect | null;
  /** This connection cannot decode video: JPEG whatever the choice says. */
  forceJpeg: boolean;
  /** Start-of-view override (cellular): this preset instead of the remembered one. */
  presetOverride?: PresetId;
}

/** The params a choice means right now. */
export function paramsFor(choice: QualityChoice, m: Moment): DesktopParams {
  const preset = m.presetOverride ?? choice.preset;
  const base: DesktopParams = { ...DEFAULT_PARAMS, source: choice.source };
  let p: DesktopParams;
  let factor: number;
  if (preset === "custom") {
    const k = choice.custom;
    factor = RESOLUTIONS.find((r) => r.id === k.res)?.factor ?? 1;
    p = cleanDesktopParams({
      ...base, codec: k.codec, fps: k.fps, bitrateKbps: k.bitrateKbps, auto: false, jpegQuality: k.jpegQuality,
      grayscale: k.codec === "jpeg" && k.grayscale, keyframeEverySec: k.keyframeEverySec, cursor: k.cursor,
      maxWidth: factor === 0 ? 0 : Math.round(clampPx(m.phonePx) * factor),
    });
  } else {
    factor = PRESETS.find((x) => x.id === preset)?.set.widthFactor ?? 1;
    p = applyPreset(base, preset, m.phonePx);
  }
  if (m.forceJpeg && p.codec !== "jpeg") {
    p = { ...p, codec: "jpeg", fps: Math.min(p.fps, FORCED_JPEG_FPS), grayscale: false };
  }
  if (choice.cropToView && m.crop) {
    // A crop is streamed at the phone's own size: the point is that small text stays sharp, at a
    // fraction of what the whole 5K screen costs.
    p = cleanDesktopParams({ ...p, crop: m.crop, maxWidth: Math.round(clampPx(m.phonePx) * (factor > 0 ? factor : 1)) });
  }
  return p;
}

const clampPx = (px: number) => Math.min(4096, Math.max(320, Number.isFinite(px) && px > 0 ? px : 1280));

/** Cellular start: whether this view begins in Data saver, and the sentence that says so. */
export function startPreset(choice: QualityChoice, cellular: boolean): { override?: PresetId; note: string | null } {
  if (!cellular || !choice.cellularSaver || choice.preset === "saver" || choice.preset === "stills") return { note: null };
  return { override: "saver", note: `On cellular — started in Data saver instead of ${presetLabel(choice.preset)}.` };
}

export function presetLabel(id: PresetId | "custom"): string {
  return id === "custom" ? "Custom" : PRESETS.find((p) => p.id === id)?.label ?? id;
}

/** The current preset's one line on the Quality sheet: its hint, and what it measures live. */
export function presetLine(hint: string, current: boolean, kbps: number | null): string {
  if (!current) return hint;
  return kbps == null ? `${hint} · now: measuring…` : `${hint} · now: ${fmtKbps(kbps)}`;
}

export function fmtKbps(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`;
}

/** The connection type the phone reports, when it does (Chrome on Android; not Safari). */
export function connectionType(nav: unknown): string | null {
  const c = (nav as { connection?: { type?: unknown } } | undefined)?.connection;
  return typeof c?.type === "string" ? c.type : null;
}
