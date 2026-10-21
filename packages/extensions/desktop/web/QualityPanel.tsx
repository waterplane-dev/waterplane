/**
 * The Quality panel, over the live view (so the stream stays open and the current preset shows its
 * measured rate): presets, Custom knobs, the source, Crop to view, the cellular start and the data
 * cap. Every choice is remembered per host (`setChoice` → `extStorage`). A knob that does not apply
 * to the codec in use is not drawn; one line says which codec the absent ones belong to.
 */
import { useState, type ReactNode } from "react";
import { AppWindow, Monitor, MousePointerClick, X } from "lucide-react";
import { useStore } from "@waterplane/sdk";
import { RadioRows, Button, Hint } from "@waterplane/kit";
import { PRESETS, type DesktopSource, type DesktopWindow } from "../shared/wire.mts";
import {
  BITRATE_STEPS, CAP_STEPS, FPS_STEPS, JPEG_Q_STEPS, KEYFRAME_STEPS, RESOLUTIONS, fmtKbps, presetLine,
  type CustomKnobs, type QualityChoice,
} from "./quality.ts";
import { choice, client, probe, setChoice } from "./state.ts";
import type { DesktopController, Ui } from "./controller.ts";

const PANEL = {
  position: "absolute", inset: 0, zIndex: 2, overflowY: "auto", touchAction: "pan-y", background: "var(--bg)",
  paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)",
} as const;
const HEAD = { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--line)" } as const;
const CHIPS = { display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 14px 8px" } as const;
const SMALL = { minHeight: 38, padding: "4px 10px" } as const;

function Chips<T>({ label, opts, value, show, onPick, radio }: { radio?: boolean; label: string; opts: readonly T[]; value: T; show(v: T): string; onPick(v: T): void }) {
  return (
    <div>
      <div className="section-hint" style={{ padding: "6px 14px 0" }}>{label}</div>
      {radio ? (
        <div style={{ padding: "2px 14px 8px" }}>
          <RadioRows label={label} value={String(show(value))} onChange={(k) => onPick(opts.find((o) => String(show(o)) === k)!)}
            options={opts.map((o) => ({ key: String(show(o)), label: show(o) }))} />
        </div>
      ) : <div style={CHIPS}>
        {opts.map((o) => (
          <button key={String(show(o))} className={`key${o === value ? " active" : ""}`} style={SMALL} aria-pressed={o === value} onClick={() => onPick(o)}>{show(o)}</button>
        ))}
      </div>}
    </div>
  );
}

function Toggle({ label, on, hint, onFlip }: { label: string; on: boolean; hint: string; onFlip(): void }) {
  return (
    <li className="check-row">
      <button className={`key${on ? " active" : ""}`} style={{ alignSelf: "flex-start", ...SMALL }} aria-pressed={on} onClick={onFlip}>
        {label}: {on ? "on" : "off"}
      </button>
      <Hint style={{ padding: 0 }}>{hint}</Hint>
    </li>
  );
}

const sameSource = (a: DesktopSource, b: DesktopSource) => a.kind === b.kind && (a.kind === "front" || ("id" in a ? a.id : undefined) === ("id" in b ? b.id : undefined));

function SourcePicker({ c }: { c: QualityChoice }) {
  const p = useStore(probe);
  const [wins, setWins] = useState<{ list: DesktopWindow[] } | { error: string } | null>(null);
  const displays = p.k === "ok" ? p.r.displays : [];
  const pick = (source: DesktopSource) => setChoice({ source });
  const row = (key: string, on: boolean, icon: ReactNode, text: string, src: DesktopSource) => (
    <button key={key} className={`key${on ? " active" : ""}`} style={{ ...SMALL, textAlign: "left" }} aria-pressed={on} onClick={() => pick(src)}>{icon} {text}</button>
  );
  return (
    <div>
      <div className="section-hint" style={{ padding: "6px 14px 0" }}>source</div>
      <div style={CHIPS}>
        {displays.length === 0 && row("main", c.source.kind === "display", <Monitor size={14} />, "the main display", { kind: "display" })}
        {displays.map((d, i) => row(`d${d.id}`, c.source.kind === "display" && (c.source.id ?? (d.main ? d.id : -1)) === d.id, <Monitor size={14} />,
          `display ${i + 1} · ${d.width}×${d.height}${d.main ? " (main)" : ""}`, { kind: "display", id: d.id }))}
        {row("front", c.source.kind === "front", <MousePointerClick size={14} />, "the front window (follows focus)", { kind: "front" })}
        <Button style={SMALL} onClick={() => {
          setWins(null);
          void client.read("windows", {}).then((r) => setWins(r.ok ? { list: r.result.windows } : { error: r.error }));
        }}><AppWindow size={14} /> one window…</Button>
      </div>
      {wins && "error" in wins && <Hint tone="warn" style={{ padding: "0 14px" }}>The window list did not come: {wins.error}</Hint>}
      {wins && "list" in wins && (wins.list.length === 0
        ? <Hint style={{ padding: "0 14px" }}>The desktop reports no windows it can show.</Hint>
        : <div style={CHIPS}>{wins.list.map((w) => row(`w${w.id}`, sameSource(c.source, { kind: "window", id: w.id }), <AppWindow size={14} />,
            `${w.app}${w.title ? ` — ${w.title}` : ""}`, { kind: "window", id: w.id }))}</div>)}
    </div>
  );
}

function Custom({ k }: { k: CustomKnobs }) {
  const set = (patch: Partial<CustomKnobs>) => setChoice({ custom: { ...k, ...patch } });
  const h264 = k.codec === "h264";
  return (
    <>
      <Chips radio label="codec" opts={["h264", "jpeg"] as const} value={k.codec} show={(v) => (v === "h264" ? "H.264 video" : "JPEG stills")} onPick={(codec) => set({ codec })} />
      <Chips label="resolution" opts={RESOLUTIONS.map((r) => r.id)} value={k.res} show={(v) => RESOLUTIONS.find((r) => r.id === v)!.label} onPick={(res) => set({ res })} />
      <Chips label="frames per second, at most" opts={FPS_STEPS} value={k.fps as (typeof FPS_STEPS)[number]} show={String} onPick={(fps) => set({ fps })} />
      {h264 && <Chips label="bitrate cap" opts={BITRATE_STEPS} value={k.bitrateKbps as (typeof BITRATE_STEPS)[number]} show={fmtKbps} onPick={(bitrateKbps) => set({ bitrateKbps })} />}
      {h264 && <Chips label="keyframe refresh" opts={KEYFRAME_STEPS.map((x) => x.s)} value={k.keyframeEverySec} show={(v) => KEYFRAME_STEPS.find((x) => x.s === v)!.label} onPick={(keyframeEverySec) => set({ keyframeEverySec })} />}
      {!h264 && <Chips label="JPEG quality" opts={JPEG_Q_STEPS} value={k.jpegQuality as (typeof JPEG_Q_STEPS)[number]} show={String} onPick={(jpegQuality) => set({ jpegQuality })} />}
      <ul className="check-list">
        {!h264 && <Toggle label="grayscale" on={k.grayscale} hint="Gray stills: fewer bytes each, colour gone." onFlip={() => set({ grayscale: !k.grayscale })} />}
        <Toggle label="cursor" on={k.cursor} hint="Draw the desktop's own mouse pointer into the picture." onFlip={() => set({ cursor: !k.cursor })} />
      </ul>
      <Hint style={{ padding: "0 14px" }}>
        {h264 ? "JPEG quality and grayscale are for JPEG stills." : "Bitrate and keyframe refresh are for H.264 video."}
      </Hint>
    </>
  );
}

export function QualityPanel({ ctl, ui, onClose }: { ctl: DesktopController; ui: Ui; onClose(): void }) {
  const c = useStore(choice);
  const current = ui.override ?? c.preset;
  const live = ui.phase === "open" && ui.meter.frames > 0 ? ui.kbps : null;
  const pickPreset = (preset: QualityChoice["preset"]) => { setChoice({ preset }); ctl.dropOverride(); };
  return (
    <div style={PANEL}>
      <div style={HEAD}>
        <b style={{ flex: 1 }}>Quality</b>
        <Button title="close — the view keeps these settings" aria-label="close" onClick={onClose}><X size={16} /></Button>
      </div>
      <div style={{ padding: "4px 14px 8px" }}>
        <RadioRows label="quality preset" value={current} onChange={pickPreset}
          options={[
            ...PRESETS.map((p) => ({ key: p.id as QualityChoice["preset"], label: p.label, note: presetLine(p.hint, current === p.id, live) })),
            { key: "custom" as const, label: "Custom", note: presetLine("Every knob, below", current === "custom", live) },
          ]} />
      </div>
      {current === "custom" && <Custom k={c.custom} />}
      <SourcePicker c={c} />
      <ul className="check-list">
        <Toggle label="Crop to view" on={c.cropToView}
          hint="Zoomed in, stream only what is on screen, at this phone's own resolution — small text stays sharp for a fraction of the bytes."
          onFlip={() => setChoice({ cropToView: !c.cropToView })} />
        <Toggle label="Data saver on cellular" on={c.cellularSaver}
          hint="Start in Data saver when this phone is on a cellular connection, and say so."
          onFlip={() => setChoice({ cellularSaver: !c.cellularSaver })} />
      </ul>
      <Chips label="data cap — pause after this many MB in one view" opts={CAP_STEPS} value={c.capMb as (typeof CAP_STEPS)[number]}
        show={(v) => (v === 0 ? "no cap" : `${v} MB`)} onPick={(capMb) => setChoice({ capMb })} />
    </div>
  );
}
