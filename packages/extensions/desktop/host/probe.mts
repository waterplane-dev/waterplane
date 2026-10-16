/**
 * The two questions with an answer (`DesktopMethods`): `probe` — can this desktop be shown, and
 * what is granted — and `windows`. Both run the helper's one-shot commands, which never prompt
 * (helper/PROTOCOL.md, "probe"). `probe` is what the session segment and the home button ask, so
 * its answer is kept 5 s and concurrent askers share one run.
 *
 * Asking `probe` is what builds the helper the first time: the phone asks only once somebody
 * looks at a desktop entry, which is the first use. The setup rows read `cached()` and never build.
 */
import type { DesktopDisplay, DesktopMethods, DesktopWindow } from "../shared/wire.mjs";
import type { HelperBin, Runner } from "./helperbin.mjs";
import { runFile } from "./helperbin.mjs";
import { BUILDING, NOT_MAC, WIN_NO_DESKTOP, osOf, type DesktopOs } from "./knobs.mjs";

export type ProbeResult = DesktopMethods["probe"]["result"];

/** The raw `wp-desktop probe` object, as far as the host reads it. */
export interface RawProbe {
  screenRecording: boolean | null;
  accessibility: boolean | null;
  responsibleSelf: boolean | null;
  displays: DesktopDisplay[];
  os?: string;
  helperVersion?: string;
}

export interface ProberOpts {
  platform: NodeJS.Platform;
  /** Overrides what `platform` alone says (`detectDesktopOs`: a WSL host is `windows`). */
  os?: DesktopOs | null;
  bin: HelperBin;
  /** `--no-capture` on every helper run (synthetic mode). */
  noCapture: boolean;
  control(): boolean;
  run?: Runner;
  now?(): number;
  ttlMs?: number;
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export function parseProbe(stdout: string): RawProbe | null {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  let o: Record<string, unknown>;
  try { o = JSON.parse(line ?? "") as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const displays: DesktopDisplay[] = [];
  for (const d of Array.isArray(o.displays) ? o.displays : []) {
    const r = (d ?? {}) as Record<string, unknown>;
    if (![r.id, r.width, r.height].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const scale = typeof r.scale === "number" && Number.isFinite(r.scale) && r.scale > 0 ? { scale: r.scale } : {};
    displays.push({ id: r.id as number, width: r.width as number, height: r.height as number, ...scale, main: r.main === true });
  }
  return {
    screenRecording: bool(o.screenRecording), accessibility: bool(o.accessibility), responsibleSelf: bool(o.responsibleSelf), displays,
    ...(typeof o.os === "string" ? { os: o.os } : {}), ...(typeof o.helperVersion === "string" ? { helperVersion: o.helperVersion } : {}),
  };
}

export function parseWindows(stdout: string): DesktopWindow[] {
  let o: { windows?: unknown };
  try { o = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "") as { windows?: unknown }; } catch { return []; }
  const out: DesktopWindow[] = [];
  for (const w of Array.isArray(o?.windows) ? o.windows : []) {
    const r = (w ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(r.id) || (r.id as number) <= 0) continue;
    out.push({ id: r.id as number, app: typeof r.owner === "string" ? r.owner : "", title: typeof r.name === "string" ? r.name : "" });
  }
  return out;
}

export class Prober {
  private last: { at: number; raw: RawProbe } | null = null;
  private inflight: Promise<ProbeResult> | null = null;
  private readonly run: Runner;
  private readonly now: () => number;

  private readonly os: DesktopOs | null;

  constructor(private readonly o: ProberOpts) {
    this.os = osOf(o);
    this.run = o.run ?? runFile;
    this.now = o.now ?? Date.now;
  }

  /** The newest helper answer, however old, or null. Never runs anything. */
  cached(): RawProbe | null { return this.last?.raw ?? null; }

  /** Drop the cached answer (a rebuild, a setting that changes what it means). */
  forget(): void { this.last = null; }

  async probe(): Promise<ProbeResult> {
    const controlEnabled = this.o.control();
    if (this.os === null) return { available: false, reason: NOT_MAC, screenRecording: null, accessibility: null, controlEnabled, displays: [] };
    if (this.last && this.now() - this.last.at < (this.o.ttlMs ?? 5000)) return this.result(this.last.raw);
    this.inflight ??= this.fresh().finally(() => { this.inflight = null; });
    const r = await this.inflight;
    return { ...r, controlEnabled: this.o.control() };
  }

  /** A probe only when the helper is already built and current: what the setup rows may start. */
  async refreshIfBuilt(): Promise<void> {
    if (this.os === null || this.inflight || this.o.bin.isBuilding) return;
    const st = await this.o.bin.check();
    if (st.kind !== "current" && st.kind !== "prebuilt") return;
    await this.probe();
  }

  async windows(): Promise<{ windows: DesktopWindow[] }> {
    if (this.os === null) throw new Error(NOT_MAC);
    const ready = await this.o.bin.ensure();
    if (!ready.ok) throw new Error(ready.reason);
    const r = await this.run(ready.path, ["windows"], 5000);
    if (r.code !== 0) throw new Error(`The desktop helper could not list windows: ${r.stderr.trim().split("\n").at(-1) || r.error || `exit ${r.code}`}`);
    return { windows: parseWindows(r.stdout) };
  }

  private async fresh(): Promise<ProbeResult> {
    const off = (reason: string): ProbeResult => ({ available: false, reason, screenRecording: null, accessibility: null, controlEnabled: this.o.control(), displays: [] });
    const bin = this.o.bin;
    const st = await bin.check();
    if (st.kind === "missing" || st.kind === "stale") void bin.build();
    if (bin.isBuilding) return off(BUILDING);
    const ready = await bin.ensure();
    if (!ready.ok) return off(ready.reason);
    const r = await this.run(ready.path, ["probe", ...(this.o.noCapture ? ["--no-capture"] : [])], 5000);
    const raw = r.code === 0 ? parseProbe(r.stdout) : null;
    if (!raw) return off(`The desktop helper did not answer its probe: ${r.stderr.trim().split("\n").at(-1) || r.error || `exit ${r.code}`}`);
    this.last = { at: this.now(), raw };
    return this.result(raw);
  }

  private result(raw: RawProbe): ProbeResult {
    // Windows grants nothing per app: a helper that cannot see the desktop is in the wrong session
    // (or the screen is locked), and no button on the phone changes that, so it is a sentence.
    if (this.os === "windows" && raw.screenRecording === false) {
      return { available: false, reason: WIN_NO_DESKTOP, screenRecording: null, accessibility: null, controlEnabled: this.o.control(), displays: raw.displays };
    }
    return { available: true, screenRecording: raw.screenRecording, accessibility: raw.accessibility, controlEnabled: this.o.control(), displays: raw.displays };
  }
}
