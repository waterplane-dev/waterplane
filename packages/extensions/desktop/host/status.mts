/**
 * What the phone is told about its view (`DesktopStatus`), from what the helper last said
 * (its kind-4 `status` and `stats` records) and what the host decided (the Auto bitrate, the
 * control setting). Pure.
 *
 * The control gate lives here in words and in `index.mts`'s input path in effect: clicks and keys
 * reach the helper only while the person's "Let the phone control this desktop" is on. `control.on`
 * additionally needs Accessibility, because without it the helper drops every event, and a view
 * that said "control on" then would be lying. The reason names whichever is missing — both, when
 * both are.
 */
import type { DesktopCodec, DesktopStatus, NormRect } from "../shared/wire.mjs";
import { CONTROL_OFF, NEEDS_ACCESSIBILITY } from "./knobs.mjs";

const STATES = new Set<DesktopStatus["state"]>(["starting", "running", "error", "stopped"]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const sentence = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : undefined);

export function controlOf(settingOn: boolean, accessibility: boolean | null | undefined): DesktopStatus["control"] {
  if (settingOn && accessibility === true) return { on: true };
  if (!settingOn) {
    return accessibility === false
      ? { on: false, reason: `${CONTROL_OFF} ${NEEDS_ACCESSIBILITY}`, needs: ["setting", "accessibility"] }
      : { on: false, reason: CONTROL_OFF, needs: ["setting"] };
  }
  if (accessibility === false) return { on: false, reason: NEEDS_ACCESSIBILITY, needs: ["accessibility"] };
  return { on: false, reason: "Whether wp-desktop may control this desktop is not known yet." };
}

export interface StatusInputs {
  /** The helper's newest `t:"status"` record, or null before its first. */
  helper: Record<string, unknown> | null;
  /** The newest `t:"stats"` frame rate, or null. Folded in, so the chip shows what was encoded. */
  measuredFps: number | null;
  /** The bitrate the host chose right now (Auto's pick, or the fixed cap). */
  bitrateKbps: number;
  /** The control setting. */
  control: boolean;
}

/** The region the helper says it is encoding: four numbers in 0..1, a real area. The whole source is allowed here
 *  (`cleanDesktopParams` drops a full crop from a REQUEST; a status names the full source as `{0,0,1,1}`). */
function regionOf(v: unknown): NormRect | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const [x, y, w, h] = [r.x, r.y, r.w, r.h].map((n) => (typeof n === "number" && Number.isFinite(n) ? n : Number.NaN));
  if ([x, y, w, h].some(Number.isNaN)) return undefined;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return undefined;
  return { x, y, w, h };
}

/** The status the phone gets. Every helper field is checked; a bad one is absent, never guessed. */
export function desktopStatus(i: StatusInputs): DesktopStatus {
  const h = i.helper ?? {};
  const state = STATES.has(h.state as DesktopStatus["state"]) ? (h.state as DesktopStatus["state"]) : "starting";
  const out: DesktopStatus = { state, control: controlOf(i.control, typeof h.accessibility === "boolean" ? h.accessibility : null) };
  const reason = sentence(h.reason);
  if (reason) out.reason = reason;
  if (h.codec === "h264" || h.codec === "jpeg") out.codec = h.codec as DesktopCodec;
  for (const k of ["width", "height", "srcWidth", "srcHeight"] as const) {
    const v = num(h[k]);
    if (v !== undefined) out[k] = Math.round(v);
  }
  const fps = i.measuredFps ?? num(h.fps);
  if (fps !== undefined && fps !== null) out.fps = Math.round(fps * 10) / 10;
  const crop = regionOf(h.crop);
  if (crop) out.crop = crop;
  const seq = num(h.regionSeq);
  if (seq !== undefined && Number.isInteger(seq)) out.regionSeq = seq;
  if (state === "running" || state === "starting") out.bitrateKbps = Math.round(i.bitrateKbps);
  return out;
}

/** The stats record's frame rate, or null. */
export function statsFps(rec: Record<string, unknown>): number | null {
  return num(rec.fps) ?? null;
}
