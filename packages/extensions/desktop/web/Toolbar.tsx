/**
 * The view's toolbar row: the input-mode segment (Touch · Trackpad · View only), screenshot, fullscreen, and the stats
 * chip — then, under it, every line that says why something is not happening: control blocked, the
 * cellular start, stills instead of video. Each says what to do about it; nothing is greyed.
 */
import { useState } from "react";
import { Eye, Hand, Maximize, MousePointer2, Power, ShieldCheck } from "lucide-react";
import { useStore } from "@waterplane/sdk";
import { ConfirmButton, Button, Hint } from "@waterplane/kit";
import type { InputMode } from "./gestures.ts";
import { chipText, detailLines } from "./stats.ts";
import { presetLabel } from "./quality.ts";
import { askGrant, choice, grantNote, setChoice, turnOnControl } from "./state.ts";
import { controlBlock, controlSteps, stepsHead } from "./words.ts";
import type { DesktopController, Ui } from "./controller.ts";
import { ShotButton } from "./Shot.tsx";

const MODES: readonly { id: InputMode; label: string; title: string; icon: typeof Hand }[] = [
  { id: "touch", label: "Touch", title: "Touch — a tap clicks where your finger is, a long press right-clicks, a drag drags, two fingers scroll, three fingers move the zoomed view", icon: Hand },
  { id: "trackpad", label: "Trackpad", title: "Trackpad — one finger moves a cursor, a tap clicks at it, a two-finger tap right-clicks, two fingers scroll, double-tap and drag to drag, three fingers move the zoomed view", icon: MousePointer2 },
  { id: "view", label: "View only", title: "View only — nothing is sent to the desktop; one finger pans", icon: Eye },
];

const SEG = { padding: "6px 8px", gap: 4 } as const;
const SEG_BTN = { minHeight: 40, padding: "4px 6px", fontSize: "calc(13px * var(--ui-font, 1))" } as const;
const LINE = { padding: "4px 12px" } as const;
const STEP = { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, marginTop: 6 } as const;
const STEP_BTN = { minHeight: 36, padding: "4px 10px" } as const;

export function Toolbar({ ctl, ui, onFull }: { ctl: DesktopController; ui: Ui; onFull: () => void }) {
  const [open, setOpen] = useState(false);
  const block = controlBlock(ui.mode, ui.status);
  const steps = controlSteps(ui.mode, ui.status);
  const asked = useStore(grantNote);
  return (
    <>
      <div className="segmented" style={SEG}>
        {MODES.map((m) => (
          <button key={m.id} className={`seg${ui.mode === m.id ? " on" : ""}`} style={SEG_BTN} title={m.title} aria-pressed={ui.mode === m.id}
            onClick={() => setChoice({ mode: m.id })}><m.icon size={15} /> {m.label}</button>
        ))}
        {/* Fullscreen, not fit: this icon reads as fullscreen, and a fit button at fit (the default)
            did nothing on a tap. Fit is drawn over the picture while zoomed instead (DesktopSheet). */}
        <ShotButton />
        <Button title="fullscreen — the desktop gets the whole screen" aria-label="fullscreen" onClick={onFull}><Maximize size={15} /></Button>
      </div>
      <button className="form-hint mono" style={{ ...LINE, background: "none", border: 0, textAlign: "left", width: "100%", cursor: "pointer" }}
        title="what this view costs — tap for the split" aria-expanded={open} onClick={() => setOpen(!open)}>
        {chipText(ui.kbps, ui.fps, ui.meter)}
      </button>
      {open && (
        <Hint style={LINE}>
          {detailLines(ui.meter, ui.status && { ...ui.status, auto: ui.auto }).map((l) => <div key={l}>{l}</div>)}
        </Hint>
      )}
      {steps.length > 0 ? (
        <Hint tone="warn" style={LINE}>
          <div>{stepsHead(steps.length)}</div>
          {steps.map((st, i) => (
            <div key={st.need} style={STEP}>
              <div>{steps.length > 1 ? `${i + 1}. ` : ""}{st.text}</div>
              {st.need === "setting" ? (
                <ConfirmButton className="key primary" confirm="tap again: every app on the desktop" onConfirm={turnOnControl}>
                  <Power size={15} /> {st.button}
                </ConfirmButton>
              ) : (
                <Button style={STEP_BTN} onClick={() => void askGrant("accessibility")}><ShieldCheck size={15} /> {st.button}</Button>
              )}
              {st.need === "accessibility" && asked && <div className="row-sub">{asked}</div>}
            </div>
          ))}
        </Hint>
      ) : block && <Hint tone="warn" style={LINE}>{block}</Hint>}
      {ui.note && (
        <Hint style={LINE}>
          {ui.note}{" "}
          <Button style={{ minHeight: 32, padding: "2px 8px" }} onClick={() => ctl.dropOverride()}>use {presetLabel(choice.get().preset)}</Button>
        </Hint>
      )}
      {ui.noVideo && <Hint tone="warn" style={LINE}>{ui.noVideo}</Hint>}
    </>
  );
}
