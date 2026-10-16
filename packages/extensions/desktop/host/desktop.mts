/**
 * The live desktop's host half, assembled (docs/analysis/desktop-stream-plan.md §1, §5, §6): the
 * helper binary (`helperbin.mts`), the probe (`probe.mts`), and the stream `screen` with one
 * `wp-desktop serve` per open view (`session.mts`). `index.mts` hands it the plugin API's pieces;
 * the tests hand it fakes (a fake helper is just another executable path).
 *
 * Refusals, in words: neither macOS nor Windows-through-WSL (R-desktop-008), a helper that cannot be built or is still being
 * built, a third view while two are still opening, a helper that cannot be started. A third view
 * while two are OPEN is not refused: the oldest one ends with cause `replaced`.
 */
import type { PluginStreamHandlers, PluginStreamSub, StreamEndCause } from "@waterplane/shared";
import type { DesktopParams } from "../shared/wire.mjs";
import { HelperBin, type Runner } from "./helperbin.mjs";
import { BUILDING, MAX_STREAMS, NOT_MAC, REPLACED, TOO_MANY, osOf, type DesktopOs } from "./knobs.mjs";
import { Prober } from "./probe.mjs";
import { HelperSession } from "./session.mjs";

export interface DesktopDeps {
  platform: NodeJS.Platform;
  /** Overrides what `platform` alone says (`detectDesktopOs`: a WSL host is `windows`). */
  os?: DesktopOs | null;
  stateDir: string;
  sourceDir: string | null;
  /** A binary to run as it is: nothing is built (`WATERPLANE_DESKTOP_HELPER`, or a test's fake). */
  prebuilt?: string | null;
  /** Synthetic test pattern, no capture, dry input (`WATERPLANE_DESKTOP_SYNTHETIC`). */
  synthetic: boolean;
  log(msg: string): void;
  /** The person's "Let the phone control this desktop". */
  control(): boolean;
  run?: Runner;
  now?(): number;
  /** How long an open waits for a build before refusing with "being built". */
  openWaitMs?: number;
  termMs?: number;
  killMs?: number;
  tickMs?: number;
}

export interface Desktop {
  bin: HelperBin;
  prober: Prober;
  handlers: PluginStreamHandlers;
  /** The control setting moved: every open view hears it, and the log says it once. */
  controlChanged(on: boolean): void;
  /** Every helper stopped (the plugin is switched off or the daemon stops). */
  stopAll(): void;
  /** Open views (helper processes not yet told to stop). */
  openCount(): number;
  /** Helper pids still running, closing ones included (tests). */
  pids(): number[];
}

export function summary(p: DesktopParams): string {
  const src = p.source.kind === "display" ? `display${p.source.id !== undefined ? `:${p.source.id}` : ""}` : p.source.kind === "window" ? `window:${p.source.id}` : "front";
  const crop = p.crop ? ` crop=${[p.crop.x, p.crop.y, p.crop.w, p.crop.h].map((v) => v.toFixed(2)).join(",")}` : "";
  return `codec=${p.codec} source=${src}${crop} maxWidth=${p.maxWidth || "native"} fps=${p.fps} ${p.auto ? "auto≤" : ""}${p.bitrateKbps}kbps${p.codec === "jpeg" ? ` q=${p.jpegQuality}${p.grayscale ? " gray" : ""}` : ""}`;
}

export function createDesktop(d: DesktopDeps): Desktop {
  const os = osOf(d);
  const bin = new HelperBin({ stateDir: d.stateDir, sourceDir: d.sourceDir, prebuilt: d.prebuilt, log: d.log, os: os ?? "mac", run: d.run, now: d.now });
  const prober = new Prober({ platform: d.platform, os, bin, noCapture: d.synthetic, control: d.control, run: d.run, now: d.now });
  const sessions = new Map<string, HelperSession>();
  let reserved = 0;
  const live = (): number => [...sessions.values()].filter((s) => !s.isClosing).length;
  const args = d.synthetic ? ["--source", "synthetic", "--no-capture", "--dry-input"] : [];

  /** Source pixels per point for these params, off the last probe: the chosen display, else the main
   *  one. Null when no probe has said — never 1 by default, which was a 2× scroll on a Retina display
   *  — and when no probe ever answered one is started, so the next scroll knows (a session open
   *  means a built helper). A probe that answered without a scale is not asked again per scroll. */
  const scale = (p: DesktopParams): number | null => {
    const cached = prober.cached();
    const ds = cached?.displays ?? [];
    const want = p.source.kind === "display" && p.source.id !== undefined ? ds.find((x) => x.id === (p.source as { id?: number }).id) : undefined;
    const s = (want ?? ds.find((x) => x.main) ?? ds[0])?.scale;
    if (typeof s === "number" && s > 0) return s;
    if (!cached) void prober.probe().catch(() => { /* the setup rows and the view say what a failed probe means */ });
    return null;
  };

  async function waitReady(): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<{ ok: false; reason: string }>((res) => { timer = setTimeout(() => res({ ok: false, reason: BUILDING }), d.openWaitMs ?? 8000); });
    try { return await Promise.race([bin.ensure(), late]); } finally { clearTimeout(timer); }
  }

  const handlers: PluginStreamHandlers = {
    async open(sub: PluginStreamSub, params: unknown) {
      if (os === null) return NOT_MAC;
      if (live() + reserved >= MAX_STREAMS) {
        // The cap is hit: the OLDEST open view goes, never the newest. A tunnel that dropped leaves
        // subs on sockets nobody has noticed are dead yet (ping 20 s × 2), and refusing the person
        // opening the view NOW for those would lock the phone out of its own desktop.
        const oldest = [...sessions.values()].find((s) => !s.isClosing);
        if (!oldest) return TOO_MANY; // every slot is an open still in flight
        d.log(`stream replace id=${oldest.sub.key}: a newer view (id=${sub.key}) is opening and the cap is ${MAX_STREAMS}`);
        oldest.sub.end(REPLACED, "replaced"); // the core calls close(sub, "replaced"), which stops its helper
        oldest.close();
      }
      reserved++;
      let s: HelperSession;
      try {
        const ready = await waitReady();
        if (!ready.ok) return ready.reason;
        s = new HelperSession(sub, params, {
          bin: ready.path, args, log: d.log, control: d.control, scale, now: d.now, termMs: d.termMs, killMs: d.killMs, tickMs: d.tickMs,
          gone: (x) => { if (sessions.get(x.sub.key) === x) sessions.delete(x.sub.key); },
        });
        sessions.set(sub.key, s);
      } finally {
        reserved--;
      }
      const refusal = await s.start();
      if (refusal) { sessions.delete(sub.key); return refusal; }
      d.log(`stream open id=${sub.key} ${summary(s.params)} control=${d.control() ? "on" : "off"}${d.synthetic ? " (synthetic, dry input)" : ""} pid=${s.pid ?? "?"}`);
      return undefined;
    },
    params(sub, p) { sessions.get(sub.key)?.setParams(p); },
    input(sub, ev) { sessions.get(sub.key)?.input(ev); },
    keyframe(sub) { sessions.get(sub.key)?.keyframe(); },
    ack(sub) { sessions.get(sub.key)?.ack(); },
    close(sub, cause: StreamEndCause) {
      const s = sessions.get(sub.key);
      if (!s) return;
      d.log(`stream close id=${sub.key} cause=${cause} after ${(s.ageMs / 1000).toFixed(1)} s, ${(sub.sentBytes / 1e6).toFixed(2)} MB sent`);
      s.close();
    },
  };

  return {
    bin, prober, handlers,
    controlChanged(on) {
      d.log(on ? "control enabled: clicks and keys from the phone now reach this desktop" : "control disabled: the phone can only watch this desktop");
      for (const s of sessions.values()) s.controlChanged();
    },
    stopAll() {
      for (const s of sessions.values()) {
        if (s.isClosing) continue;
        s.sub.end("The live desktop was switched off on the desktop.");
        s.close();
      }
    },
    openCount: live,
    pids: () => [...sessions.values()].map((s) => s.pid).filter((p): p is number => typeof p === "number"),
  };
}
