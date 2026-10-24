/**
 * The Desktop view: a full sheet (`<Sheet full>`) with the live picture edge to edge, the toolbar
 * row above it and the key row below. One `DesktopController` per open view.
 *
 * Fullscreen (the toolbar's button) gives the picture the whole screen: over the status strips, the
 * session tabs and the sheet's own header, and — in the Android shell — over the system bars too
 * (`shellImmersive`; a swipe from the edge shows them for a moment). In a browser it asks for real
 * fullscreen as well, best effort. Every control of ours hides behind one handle on the picture
 * (`Handle.tsx`): a tap shows exit, close, screenshot, fit and the key row, another tap hides them,
 * and a drag moves the handle off whatever it covered. Entering says so, once per entry. The
 * column is portalled into a node that fullscreen moves to `<body>`: in the sheet it sat in the wide layout's `.ws-panel`
 * (z-index 15, its own stacking context), so its z-index 80 lost to the strips (60+) — they covered
 * the desktop's top and the exit button with it.
 *
 * A hardware keyboard types on the desktop while the view is open and control is on, unless the
 * focus is in a text field (the typing box keeps its own words).
 *
 * Zoomed, an overview in the picture's corner shows the whole desktop with the part on screen
 * outlined: drag it, or press on it, to move there (`Overview.tsx`); the middle mouse button drags the
 * picture. Both are a mouse's way around a zoomed view — neither sends anything to the desktop.
 *
 * Screenshot (the toolbar's camera, and behind the handle in fullscreen) saves the whole desktop at full
 * resolution into the session repo's `.claude/outbox/` (`Shot.tsx`); its receipt is a line in the
 * column, above the key row.
 *
 * The header's back arrow is one Back, like the gesture: with the Quality or typing panel open it
 * shuts the panel, else the view. Close (in the header, and behind the handle in fullscreen) takes the view down; the session's ☰
 * menu and the launcher's ☰ menu are the ways back in.
 *
 * Lifecycle: the stream opens when the sheet mounts AND the page is visible; `visibilitychange`
 * hidden closes it, visible reopens it (a fresh keyframe); closing the sheet closes it. Not an
 * option — a stream nobody looks at is bandwidth for nothing. When the desktop cannot serve a live
 * view the body is that sentence, with a way to ask again.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minimize, Monitor, MonitorUp, MousePointerClick, RefreshCw, ShieldCheck, Shrink, SlidersHorizontal, X } from "lucide-react";
import { shellImmersive, useBackStep, useConnStatus, useStore } from "@waterplane/sdk";
import { Sheet, Button, RowSub } from "@waterplane/kit";
import { DesktopController } from "./controller.ts";
import { KeyRow } from "./KeyRow.tsx";
import { Handle } from "./Handle.tsx";
import { Overview } from "./Overview.tsx";
import { QualityPanel } from "./QualityPanel.tsx";
import { ShotButton, ShotLine } from "./Shot.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { TypePanel } from "./TypePanel.tsx";
import { askGrant, choice, closeDesktop, grantNote, probe, refreshProbe, setChoice, takeReopen } from "./state.ts";
import { capSentence } from "./stats.ts";
import type { DesktopSource } from "../shared/wire.mts";
import { FULL_ENTERED, GRANT_SCREEN, TAKE_BACK, USE_MAIN, availability, captureStopped, goneDisplay, streamLine } from "./words.ts";

const COLUMN = { position: "absolute", inset: 0, display: "flex", flexDirection: "column" } as const;
// Above every app layer (the highest in styles.css is 70), the status strips included: the person
// asked for the desktop and nothing else. The insets keep the picture off a notch and the key row
// clear of the gesture bar (in the Android shell they are 0 — the shell pads its own frame).
const FULL_COLUMN = {
  ...COLUMN, position: "fixed", zIndex: 80, background: "#000",
  paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)",
  paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)",
} as const;
// Siblings of the viewport, not children: a press inside it is a click on the desktop.
const FLOAT = { position: "absolute", zIndex: 2, minHeight: 36, padding: "4px 10px", opacity: 0.85 } as const;
// The stage holds the picture's element and, beside it (never inside: a press inside is a click on the
// desktop), the overview while zoomed.
const STAGE = { position: "relative", flex: "1 1 auto", minHeight: 0 } as const;
const VIEWPORT = { position: "absolute", inset: 0, overflow: "hidden", touchAction: "none", background: "#000" } as const;
const CANVAS = { position: "absolute", left: 0, top: 0, width: 0, height: 0, imageRendering: "auto" } as const;
const DOT = {
  position: "absolute", left: -7, top: -7, width: 14, height: 14, borderRadius: 7, pointerEvents: "none", display: "none",
  background: "var(--accent)", border: "2px solid #fff", boxShadow: "0 0 3px #000",
} as const;
const ENTERED = {
  position: "absolute", left: 12, right: 12, bottom: 12, zIndex: 2, padding: "8px 12px", borderRadius: 10, pointerEvents: "none",
  background: "var(--panel)", border: "1px solid var(--line)", textAlign: "center",
} as const;
const ENTERED_MS = 5000;
const NOTE = {
  position: "absolute", left: 12, right: 12, top: 12, zIndex: 1, padding: "10px 12px", borderRadius: 10,
  background: "var(--panel)", border: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 8,
} as const;

// Keyboard Lock (Chromium on a desktop OS, only in the browser's fullscreen): the shortcuts the
// browser keeps for itself — ⌘W, ⌘T, ⌘N, Esc — reach the page, so the keydown path sends them to
// the desktop. Elsewhere (Safari, Firefox, an Android WebView) it is absent and those stay the
// browser's. Holding Esc still leaves the browser's fullscreen, which leaves ours.
type KeyboardApi = { lock(keys?: string[]): Promise<void>; unlock(): void };
const keyboardApi = (): KeyboardApi | undefined => (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard;
const lockKeys = () => { void keyboardApi()?.lock?.().catch(() => {}); };

export function DesktopSheet() {
  const ctl = useMemo(() => new DesktopController(), []);
  const ui = useStore(ctl.ui);
  const picked = useStore(choice);
  const p = useStore(probe);
  const asked = useStore(grantNote);
  const link = useConnStatus();
  const [panel, setPanel] = useState<null | "quality" | "type">(() => (takeReopen() ? "type" : null));
  const [full, setFull] = useState(false);
  // Fullscreen's controls: hidden behind the handle until it is tapped. `entered` is the one-time line.
  const [controls, setControls] = useState(false);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    setControls(false);
    if (!full) { setEntered(false); return; }
    setEntered(true);
    const t = setTimeout(() => setEntered(false), ENTERED_MS);
    return () => clearTimeout(t);
  }, [full]);
  // Outside fullscreen the controls are simply there; the typing box keeps its row while open.
  const shown = !full || controls || panel === "type";
  // A panel over the stream: Back shuts it (typed words stay in TypePanel), not the whole desktop.
  useBackStep(panel !== null, () => setPanel(null));
  // The column always renders into `host`; fullscreen MOVES that node to <body> rather than
  // re-rendering elsewhere, so the canvas, its listeners and the controller's hold on them survive.
  const host = useMemo(() => { const d = document.createElement("div"); d.style.display = "contents"; return d; }, []);
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    (full ? document.body : slot.current)?.appendChild(host);
  }, [full, host]);
  useLayoutEffect(() => () => host.remove(), [host]);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dot = useRef<HTMLDivElement>(null);
  const avail = availability(p);
  const ready = avail === true;

  // Ask again on open and on every reconnect.
  useEffect(() => { if (link === "open") void refreshProbe(); }, [link]);

  // The DOM: the controller places the canvas and cursor itself and reads the fingers natively
  // (a passive React listener could not stop the page from scrolling or zooming under a pinch).
  useEffect(() => {
    const w = wrap.current, c = canvas.current, d = dot.current;
    if (!w || !c || !d) return;
    ctl.attach(w, c, d);
    const ro = new ResizeObserver(() => ctl.resize({ w: w.clientWidth, h: w.clientHeight }));
    ro.observe(w);
    ctl.resize({ w: w.clientWidth, h: w.clientHeight });
    const down = (e: PointerEvent) => { e.preventDefault(); ctl.pointerDown(e); };
    const move = (e: PointerEvent) => { e.preventDefault(); ctl.pointerMove(e); };
    const up = (e: PointerEvent) => ctl.pointerUp(e);
    const cancel = (e: PointerEvent) => ctl.pointerCancel(e);
    const wheel = (e: WheelEvent) => { e.preventDefault(); ctl.wheel(e); };
    const menu = (e: Event) => e.preventDefault(); // a long press is a right click on the desktop, not the phone's menu
    // The middle button pans the picture (controller); keep the browser's autoscroll and paste off it.
    const middle = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };
    w.addEventListener("pointerdown", down);
    w.addEventListener("pointermove", move);
    w.addEventListener("pointerup", up);
    w.addEventListener("pointercancel", cancel);
    w.addEventListener("wheel", wheel, { passive: false });
    w.addEventListener("contextmenu", menu);
    w.addEventListener("mousedown", middle);
    w.addEventListener("auxclick", middle);
    return () => {
      ro.disconnect();
      w.removeEventListener("pointerdown", down);
      w.removeEventListener("pointermove", move);
      w.removeEventListener("pointerup", up);
      w.removeEventListener("pointercancel", cancel);
      w.removeEventListener("wheel", wheel);
      w.removeEventListener("contextmenu", menu);
      w.removeEventListener("mousedown", middle);
      w.removeEventListener("auxclick", middle);
      ctl.dispose();
    };
  }, [ctl]);

  // The browser's own fullscreen, best effort on top of the in-app one: leaving it (a back gesture,
  // Esc) leaves both, and leaving ours leaves the browser's.
  useEffect(() => {
    if (!full) return;
    const doc = document.documentElement;
    // The Android shell's bars: a WebView's requestFullscreen below never reaches them.
    shellImmersive(true);
    let asked = false;
    if (!document.fullscreenElement && doc.requestFullscreen) {
      asked = true;
      doc.requestFullscreen().then(lockKeys, () => { asked = false; });
    } else if (document.fullscreenElement) lockKeys();
    const left = () => { if (asked && !document.fullscreenElement) setFull(false); };
    document.addEventListener("fullscreenchange", left);
    return () => {
      document.removeEventListener("fullscreenchange", left);
      shellImmersive(false);
      keyboardApi()?.unlock?.();
      if (asked && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [full]);

  // A hardware keyboard → the desktop. Not from a text field (the typing box, the quality panel's
  // inputs): those keys are the person's words for that field.
  useEffect(() => {
    if (!ready || ui.mode === "view") return;
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (ctl.pressKeyboard(e)) e.preventDefault();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [ctl, ready, ui.mode]);

  // Visible and available ⇒ streaming; hidden ⇒ closed; back ⇒ reopened with a fresh keyframe.
  useEffect(() => {
    if (!ready) { ctl.stop(); return; }
    const sync = () => { if (document.visibilityState === "visible") void ctl.start(); else ctl.stop(); };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { document.removeEventListener("visibilitychange", sync); ctl.stop(); };
  }, [ctl, ready]);

  const line = streamLine(ui.phase === "checking" ? "opening" : ui.phase === "stopped" ? "opening" : ui.phase, ui.reason ?? ui.status?.reason, link === "open", ui.cause);
  const hostError = ui.phase === "open" && ui.status?.state === "error" ? captureStopped(ui.status.reason) : null;
  // A stale display pick: retry would ask for the gone display again, so the way out is offered here.
  const gone = hostError ? goneDisplay(picked.source, p) : null;
  // The header's focus toggle: on streams the front window (follows focus); off goes back to the
  // source picked before it, else the main display. The Quality panel's source row is the full picker.
  const following = picked.source.kind === "front";
  const before = useRef<DesktopSource>({ kind: "display" });
  const flipFocus = () => {
    if (following) { setChoice({ source: before.current }); return; }
    before.current = picked.source;
    setChoice({ source: { kind: "front" } });
  };
  const waiting = ui.phase === "open" && !ui.drawn && !hostError ? "Waiting for the first picture…" : null;

  return (
    <Sheet full title="Desktop" icon={<Monitor size={16} />}
      // The arrow lands where the Back gesture does: an open panel shuts first, then the view.
      onClose={panel !== null ? () => setPanel(null) : closeDesktop}
      actions={<>
        {ready && <Button className={following ? "active" : undefined} aria-pressed={following}
          title={following ? "streaming the front window, following focus — tap to go back to the previous source" : "stream only the front window, following focus"}
          onClick={flipFocus}><MousePointerClick size={16} /> focus</Button>}
        <Button className={panel === "quality" ? "active" : undefined} title="Quality — presets, bitrate, source, data cap"
          onClick={() => setPanel(panel === "quality" ? null : "quality")}><SlidersHorizontal size={16} /> quality</Button>
        <Button title="close the desktop view — open it again from the session's ☰ menu" onClick={closeDesktop}><X size={16} /> close</Button>
      </>}
      head={ready ? <Toolbar ctl={ctl} ui={ui} onFull={() => setFull(true)} /> : undefined}>
      <div ref={slot} style={COLUMN} />
      {createPortal(<div style={full ? FULL_COLUMN : COLUMN}>
        <div style={STAGE}>
          <div ref={wrap} style={VIEWPORT}>
            <canvas ref={canvas} style={CANVAS} />
            <div ref={dot} style={DOT} />
          </div>
          {ready && ui.zoomed && ui.map && shown && <Overview ctl={ctl} map={ui.map} />}
        </div>
        {ready && ui.zoomed && shown && (
          <Button style={{ ...FLOAT, left: 8, top: 8 }}
            title="fit the desktop's width again (and stream all of it)" onClick={() => ctl.fit()}><Shrink size={15} /> fit</Button>
        )}
        {full && <Handle open={controls} onToggle={() => { setEntered(false); setControls(!controls); }} />}
        {full && entered && <div style={ENTERED}>{FULL_ENTERED}</div>}
        {full && controls && (
          <Button style={{ ...FLOAT, right: 8, top: 8 }}
            title="leave fullscreen" onClick={() => setFull(false)}><Minimize size={15} /> exit</Button>
        )}
        {full && controls && (
          <Button style={{ ...FLOAT, right: 8, top: 52 }}
            title="close the desktop view — open it again from the session's ☰ menu" onClick={closeDesktop}><X size={15} /> close</Button>
        )}
        {full && controls && ready && <ShotButton worded style={{ ...FLOAT, right: 8, top: 96 }} />}
        {!ready && (
          <div style={NOTE}>
            <div>{avail}</div>
            {avail === GRANT_SCREEN && (
              <Button variant="primary" style={{ alignSelf: "flex-start" }} onClick={() => void askGrant("screen")}>
                <ShieldCheck size={16} /> ask macOS for Screen Recording
              </Button>
            )}
            {avail === GRANT_SCREEN && asked && <RowSub as="div">{asked}</RowSub>}
            <Button style={{ alignSelf: "flex-start" }} onClick={() => void refreshProbe()}><RefreshCw size={16} /> ask the desktop again</Button>
          </div>
        )}
        {ready && ui.phase === "paused" && (
          <div style={NOTE}>
            <div>{capSentence(choice.get().capMb)}</div>
            <Button style={{ alignSelf: "flex-start" }} onClick={() => ctl.resume()}>resume</Button>
          </div>
        )}
        {ready && ui.phase !== "paused" && (line || hostError || waiting) && (
          <div style={NOTE}>
            <div>{hostError ?? line ?? waiting}</div>
            {gone && <div>{gone}</div>}
            {gone && <Button style={{ alignSelf: "flex-start" }}
              onClick={() => { setChoice({ source: { kind: "display" } }); ctl.retry(); }}><Monitor size={16} /> {USE_MAIN}</Button>}
            {(ui.phase === "ended" || ui.phase === "refused" || hostError) && (ui.cause === "replaced" && !hostError
              ? <Button style={{ alignSelf: "flex-start" }} title="show the live view here again — the other screen's view ends"
                onClick={() => ctl.retry()}><MonitorUp size={16} /> {TAKE_BACK}</Button>
              : <Button style={{ alignSelf: "flex-start" }} onClick={() => ctl.retry()}><RefreshCw size={16} /> retry</Button>
            )}
          </div>
        )}
        {ready && <ShotLine />}
        {panel === "type" && ready && <TypePanel ctl={ctl} onClose={() => setPanel(null)} />}
        {ready && ui.mode !== "view" && shown && <KeyRow ctl={ctl} held={ui.held} typing={panel === "type"} onType={() => setPanel(panel === "type" ? null : "type")} />}
        {panel === "quality" && <QualityPanel ctl={ctl} ui={ui} onClose={() => setPanel(null)} />}
      </div>, host)}
    </Sheet>
  );
}
