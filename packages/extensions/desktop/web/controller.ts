/**
 * One open Desktop view: the stream, the player, the gestures and the view's geometry, wired
 * together. Everything with a rule in it lives in a pure module (`view.ts`, `gestures.ts`,
 * `quality.ts`, `stats.ts`, `keys.ts`, `words.ts`); this is the glue and the DOM.
 *
 * React reads `ui` (a store, refreshed on events and twice a second for the numbers). The canvas
 * and the trackpad cursor are placed IMPERATIVELY on every view change — a pinch is sixty layouts
 * a second, and none of them should be a React render.
 *
 * Lifecycle (the sheet drives it): `start()` when mounted and the page is visible, `stop()` when
 * hidden, `dispose()` on close. A stream is never kept open for a screen nobody looks at.
 */
import { core, createStore, openStream, type StreamHandle, type StreamState, type StreamStopCause } from "@waterplane/sdk";
import { STREAM_FLAG_KEY, type StreamFrame } from "@waterplane/shared";
import {
  FRAME_JPEG, PLUGIN_ID, SCROLL_MAX, STREAM_NAME,
  type DesktopInput, type DesktopParams, type DesktopStatus, type Modifier, type NormRect, type PresetId,
} from "../shared/wire.mts";
import { createCoalescer, createGestures, type GestureOut, type InputMode } from "./gestures.ts";
import { keyboardEvent, rowKeyEvent, textEvents, toggleMod, type KeyPress, type RowKey } from "./keys.ts";
import { Player, videoSupported } from "./player.ts";
import { connectionType, paramsFor, startPreset } from "./quality.ts";
import { choice } from "./state.ts";
import { addFrame, addInputs, addLatency, newMeter, overCap, totalBytes, type Meter } from "./stats.ts";
import {
  FULL, aspectOf, clampView, fitWidth, isPanButton, keepInView, overviewDrag, overviewGrab, overviewPoint, overviewRect, overviewSize, panBy,
  regionOnFrame, regionOnStatus, regionRect, regionStart, sameCrop, scaleOf, screenToSource, sourceToScreen,
  visibleRect, zoomAt, type Box, type Pt, type RegionTrack, type View,
} from "./view.ts";
import { controlBlock, noVideoSentence, partialSendLine, reopensBySelf } from "./words.ts";

export type Phase = "checking" | StreamState | "paused" | "stopped";

export interface Ui {
  phase: Phase;
  reason?: string;
  /** Why it ended, once `ended`/`refused`: `replaced` (another screen took it) waits for a tap. */
  cause?: StreamStopCause;
  status: DesktopStatus | null;
  kbps: number;
  fps: number;
  meter: Meter;
  mode: InputMode;
  held: Modifier[];
  /** The cellular start note, while this view runs on the override. */
  note: string | null;
  override: PresetId | undefined;
  /** Why this view streams stills, when it does without being asked to. */
  noVideo: string | null;
  /** A picture has been drawn since the last (re)open. */
  drawn: boolean;
  /** The params last sent ask the host's Auto controller to pick the bitrate. */
  auto: boolean;
  /** Zoomed or panned off fit width — only then is the fit button drawn (at fit it would do nothing). */
  zoomed: boolean;
  /** The overview's size while zoomed (`overviewSize`), or null when the box has no room for one. */
  map: Box | null;
}

/** After the last pinch or pan, how long before the crop is re-aimed. */
export const CROP_SETTLE_MS = 300;
/** How often the overview's picture is refreshed from a picture of the whole source. */
export const OVERVIEW_SNAP_MS = 1000;
/** The overview's kept picture, source-shaped, this wide in canvas px (a 160 px map at 2x). */
const SNAP_W = 320;

function asStatus(data: unknown): DesktopStatus | null {
  if (!data || typeof data !== "object") return null;
  const s = data as DesktopStatus;
  if (typeof s.state !== "string" || !s.control || typeof s.control.on !== "boolean") return null;
  return s;
}

export class DesktopController {
  readonly ui = createStore<Ui>({
    phase: "checking", status: null, kbps: 0, fps: 0, meter: newMeter(), mode: choice.get().mode, held: [],
    note: null, override: undefined, noVideo: null, drawn: false, auto: false, zoomed: false, map: null,
  });

  private handle: StreamHandle | null = null;
  private player: Player<NormRect> | null = null;
  private wrap: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private dot: HTMLElement | null = null;
  private box: Box = { w: 0, h: 0 };
  private view: View = { zoom: 1, ox: 0, oy: 0 };
  /** The person has zoomed or panned: a resize keeps their view instead of re-fitting. */
  private touched = false;
  private pic: { w: number; h: number } | null = null;
  /** The overview: its canvas and rectangle while drawn, the last picture of the WHOLE source (kept
   *  even while it is hidden — with Crop to view on, a zoomed view's frames are only the crop), and
   *  the point a press on it holds. */
  private mapCanvas: HTMLCanvasElement | null = null;
  private mapRect: HTMLElement | null = null;
  private snap: HTMLCanvasElement | null = null;
  private snapAt = 0;
  private grab: Pt | null = null;
  /** A middle-button drag in progress: the pointer and where it last was. */
  private midPan: { id: number; x: number; y: number } | null = null;
  /** The region of the source the frames now ARRIVING cover (see `regionOnStatus`), and the one last DRAWN. */
  private track: RegionTrack = regionStart(null);
  private drawnRegion: NormRect = FULL;
  private sent: DesktopParams | null = null;
  private forceJpeg = false;
  private started = false;
  private capFrom = 0;
  private meter: Meter = newMeter();
  private gestures = createGestures(
    {
      toSource: (p) => screenToSource(this.box, this.aspect(), this.view, p),
      unitsPerPx: () => { const s = scaleOf(this.box, this.view) || 1; return { x: 1 / s, y: 1 / (s * this.aspect()) }; },
      srcPxPerPx: () => this.srcPxPerPx(),
    },
    { mode: choice.get().mode },
  );
  private coalesce = createCoalescer(SCROLL_MAX);
  private flushRaf = 0;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private cropTimer: ReturnType<typeof setTimeout> | null = null;
  private statTimer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private firstStart = true;
  /** It ended as `replaced`: only `retry()` (the person's tap) opens it again, never a page that
   *  comes back into view — or two phones take the view from each other for ever. */
  private heldOff = false;

  // ── wiring ──────────────────────────────────────────────────────────────

  attach(wrap: HTMLElement, canvas: HTMLCanvasElement, dot: HTMLElement): void {
    this.wrap = wrap; this.canvas = canvas; this.dot = dot;
    this.player = new Player<NormRect>(canvas, {
      onDrawn: (lat, w, h, tag) => this.drawn(lat, w, h, tag),
      onNeedKey: () => this.handle?.keyframe(),
      onUnsupported: () => this.unsupported(),
    });
    this.unsub = choice.subscribe(() => this.choiceChanged());
    this.statTimer = setInterval(() => this.refreshNumbers(), 500);
  }

  dispose(): void {
    this.stop();
    this.player?.close();
    this.player = null;
    this.unsub?.();
    if (this.statTimer) clearInterval(this.statTimer);
    if (this.cropTimer) clearTimeout(this.cropTimer);
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.flushRaf) cancelAnimationFrame(this.flushRaf);
  }

  resize(box: Box): void {
    if (box.w <= 0 || box.h <= 0) return;
    if (box.w === this.box.w && box.h === this.box.h) return;
    this.box = box;
    this.view = this.touched ? clampView(box, this.aspect(), this.view) : fitWidth(box, this.aspect());
    this.remap();
    this.layout();
    this.applyParams();
  }

  // ── the stream ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started || this.heldOff) return;
    this.started = true;
    this.patch({ phase: "checking", reason: undefined, cause: undefined });
    const video = await videoSupported();
    if (!this.started) return; // stopped while asking
    if (!video) { this.forceJpeg = true; this.patch({ noVideo: noVideoSentence(globalThis.isSecureContext === true) }); }
    if (this.firstStart) {
      this.firstStart = false;
      const s = startPreset(choice.get(), connectionType(globalThis.navigator) === "cellular");
      this.patch({ override: s.override, note: s.note });
    }
    const params = this.params();
    this.sent = params;
    this.track = regionStart(params.crop);
    this.player?.reset();
    this.patch({ phase: "opening", drawn: false, auto: params.auto && params.codec === "h264" });
    this.handle = openStream(PLUGIN_ID, STREAM_NAME, params, {
      onFrame: (f) => this.frame(f),
      onStatus: (d) => this.statusIn(d),
      onOpened: () => {
        this.player?.reset();
        this.track = regionStart(this.sent?.crop);
        this.handle?.keyframe();
        this.patch({ phase: "open" });
      },
      onEnded: (cause, reason) => {
        this.handle = null;
        this.started = false;
        this.heldOff = !reopensBySelf(cause);
        this.player?.reset();
        this.patch({ phase: cause === "refused" ? "refused" : "ended", reason, cause });
      },
    });
  }

  stop(): void {
    this.started = false;
    this.handle?.close();
    this.handle = null;
    this.player?.reset();
    // A view held off keeps its line (and its take-it-back button) through a hide and a show.
    if (this.ui.get().phase !== "paused" && !this.heldOff) this.patch({ phase: "stopped" });
  }

  /** The person's tap (retry, take it back): the one way past a `replaced` end. */
  retry(): void { this.heldOff = false; this.stop(); void this.start(); }

  /** The data cap was reached: closed, and said. Resume grants another cap's worth. */
  private pause(): void {
    this.stop();
    this.patch({ phase: "paused" });
  }

  resume(): void {
    this.capFrom = totalBytes(this.meter);
    this.patch({ phase: "stopped" });
    void this.start();
  }

  private frame(f: StreamFrame): void {
    const arrival = performance.now();
    const key = f.kind === FRAME_JPEG || (f.flags & STREAM_FLAG_KEY) !== 0;
    this.meter = addFrame(this.meter, f.payload.byteLength, key);
    this.track = regionOnFrame(this.track, key);
    this.player?.push(f.kind, f.payload, arrival, this.track.arriving);
    if (overCap(this.meter, choice.get().capMb, this.capFrom)) this.pause();
  }

  private statusIn(data: unknown): void {
    const s = asStatus(data);
    if (!s) return;
    this.track = regionOnStatus(this.track, s.crop);
    const before = this.aspect();
    this.patch({ status: s });
    if (Math.abs(this.aspect() - before) > 1e-4) this.reaspect();
  }

  private drawn(lat: number, w: number, h: number, tag: NormRect): void {
    this.meter = addLatency(this.meter, lat);
    const before = this.aspect();
    const moved = tag !== this.drawnRegion || !this.pic || this.pic.w !== w || this.pic.h !== h;
    this.drawnRegion = tag;
    this.pic = { w, h };
    this.snapshot(tag);
    if (Math.abs(this.aspect() - before) > 1e-4) this.reaspect();
    else if (moved) this.layout();
    if (!this.ui.get().drawn) this.patch({ drawn: true });
  }

  private unsupported(): void {
    if (this.forceJpeg) return;
    this.forceJpeg = true;
    this.patch({ noVideo: noVideoSentence(globalThis.isSecureContext === true) });
    this.applyParams();
  }

  private refreshNumbers(): void {
    const st = this.handle?.stats();
    const phase = this.ui.get().phase;
    // The SDK reopens a stream across a dropped link by itself; the view says which side it is on.
    const live = st && (st.state === "opening" || st.state === "open") && (phase === "open" || phase === "opening") ? st.state : phase;
    this.patch({ kbps: st?.kbps ?? 0, fps: st?.fps ?? 0, meter: this.meter, phase: live });
  }

  // ── params ──────────────────────────────────────────────────────────────

  private params(): DesktopParams {
    const c = choice.get();
    const crop = c.cropToView ? visibleRect(this.box, this.aspect(), this.view) : null;
    const dpr = globalThis.devicePixelRatio || 1;
    const phonePx = Math.round((this.box.w || globalThis.innerWidth || 390) * dpr);
    return paramsFor(c, { phonePx, crop, forceJpeg: this.forceJpeg, presetOverride: this.ui.get().override });
  }

  private applyParams(): void {
    if (!this.handle) return;
    const p = this.params();
    if (this.sent && JSON.stringify(p) === JSON.stringify(this.sent)) return;
    const cropMoved = !sameCrop(p.crop, this.sent?.crop);
    if (!this.handle.setParams(p)) return;
    this.sent = p;
    // The picture changes meaning at the first key of the new region — ask for one, or an encoder that
    // keeps its output size would carry on in P-frames and the old placement would never be left.
    // Which key that is, the host's status says (`regionOnStatus`), not this ask.
    if (cropMoved) this.handle.keyframe();
    this.patch({ auto: p.auto && p.codec === "h264" });
  }

  private choiceChanged(): void {
    const c = choice.get();
    if (c.mode !== this.gestures.mode) {
      this.send(this.gestures.setMode(c.mode));
      if (c.mode === "trackpad") this.gestures.setCursor(screenToSource(this.box, this.aspect(), this.view, { x: this.box.w / 2, y: this.box.h / 2 }));
      this.patch({ mode: c.mode });
      this.layout();
    }
    this.applyParams();
  }

  /** The person picked a preset (or anything) on the Quality sheet: the cellular override is over. */
  dropOverride(): void {
    if (this.ui.get().override) { this.patch({ override: undefined, note: null }); this.applyParams(); }
  }

  // ── geometry ────────────────────────────────────────────────────────────

  /** The desktop's width in source pixels, as the host's status says it — or null. Never guessed:
   *  a decoded frame is the STREAM's width (scaled to `maxWidth`), and a stock 1920 was a 2× wrong
   *  scroll on a Retina display. A scroll before the first status is dropped. */
  private srcWidth(): number | null {
    const w = this.ui.get().status?.srcWidth;
    return typeof w === "number" && w > 0 ? w : null;
  }

  /** Source px per phone px at the current zoom, or null while the width is unknown. */
  private srcPxPerPx(): number | null {
    const w = this.srcWidth();
    return w === null ? null : w / (scaleOf(this.box, this.view) || 1);
  }

  aspect(): number { return aspectOf(this.ui.get().status, this.pic, this.drawnRegion); }

  private reaspect(): void {
    this.view = this.touched ? clampView(this.box, this.aspect(), this.view) : fitWidth(this.box, this.aspect());
    this.remap();
    this.layout();
  }

  private remap(): void {
    const m = overviewSize(this.box, this.aspect());
    const was = this.ui.get().map;
    if (m?.w === was?.w && m?.h === was?.h) return;
    this.patch({ map: m });
    this.paintMap();
  }

  private layout(): void {
    const a = this.aspect();
    if (this.canvas) {
      const r = regionRect(this.box, a, this.view, this.drawnRegion);
      const st = this.canvas.style;
      st.left = `${r.left}px`; st.top = `${r.top}px`; st.width = `${r.width}px`; st.height = `${r.height}px`;
    }
    if (this.dot) {
      const on = this.gestures.mode === "trackpad";
      this.dot.style.display = on ? "block" : "none";
      if (on) {
        const p = sourceToScreen(this.box, a, this.view, this.gestures.cursor());
        this.dot.style.transform = `translate(${p.x}px, ${p.y}px)`;
      }
    }
    this.layoutMap();
  }

  // ── the overview ────────────────────────────────────────────────────────

  /** The overview mounted (or went): its canvas gets the kept picture, its rectangle the view. */
  attachMap(canvas: HTMLCanvasElement | null, rect: HTMLElement | null): void {
    this.mapCanvas = canvas; this.mapRect = rect;
    this.grab = null;
    this.paintMap();
    this.layoutMap();
  }

  private layoutMap(): void {
    const map = this.ui.get().map;
    if (!this.mapRect || !map) return;
    const r = overviewRect(this.box, this.aspect(), this.view, map);
    const st = this.mapRect.style;
    st.left = `${r.left}px`; st.top = `${r.top}px`; st.width = `${r.width}px`; st.height = `${r.height}px`;
  }

  /** Keep a small copy of a picture of the whole source, at most once a second. */
  private snapshot(tag: NormRect): void {
    if (!this.canvas || tag.x > 0.005 || tag.y > 0.005 || tag.w < 0.995 || tag.h < 0.995) return;
    const now = performance.now();
    if (this.snap && now - this.snapAt < OVERVIEW_SNAP_MS) return;
    this.snapAt = now;
    const snap = this.snap ??= document.createElement("canvas");
    const w = SNAP_W, h = Math.max(1, Math.round(SNAP_W * this.aspect()));
    if (snap.width !== w) snap.width = w;
    if (snap.height !== h) snap.height = h;
    try { snap.getContext("2d")?.drawImage(this.canvas, 0, 0, w, h); } catch { return; }
    this.paintMap();
  }

  private paintMap(): void {
    const c = this.mapCanvas, map = this.ui.get().map;
    if (!c || !map) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.round(map.w * dpr), h = Math.round(map.h * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    if (this.snap) ctx.drawImage(this.snap, 0, 0, w, h);
    else { ctx.fillStyle = "#222"; ctx.fillRect(0, 0, w, h); }
  }

  /** A press on the overview at `p` (its px): grab the rectangle there, or centre the view there. */
  mapDown(p: Pt): void {
    const map = this.ui.get().map;
    if (!map) return;
    const n = overviewPoint(map, p);
    this.grab = overviewGrab(this.box, this.aspect(), this.view, n, map);
    this.view = overviewDrag(this.box, this.aspect(), this.view, n, this.grab);
    this.viewMoved();
  }

  mapMove(p: Pt): void {
    const map = this.ui.get().map;
    if (!map || !this.grab) return;
    this.view = overviewDrag(this.box, this.aspect(), this.view, overviewPoint(map, p), this.grab);
    this.viewMoved();
  }

  mapUp(): void { this.grab = null; }

  private viewMoved(): void {
    this.touched = true;
    if (!this.ui.get().zoomed) this.patch({ zoomed: true });
    this.layout();
    if (this.cropTimer) clearTimeout(this.cropTimer);
    this.cropTimer = setTimeout(() => { this.cropTimer = null; this.applyParams(); }, CROP_SETTLE_MS);
  }

  /** Back to fit width (the toolbar's button), which also drops the crop. */
  fit(): void {
    this.touched = false;
    this.view = fitWidth(this.box, this.aspect());
    this.viewMoved();
    this.touched = false;
    this.patch({ zoomed: false });
  }

  // ── fingers ─────────────────────────────────────────────────────────────

  private local(e: PointerEvent) {
    const r = this.wrap!.getBoundingClientRect();
    return { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  }

  pointerDown(e: PointerEvent): void {
    if (!this.wrap) return;
    try { this.wrap.setPointerCapture(e.pointerId); } catch { /* not capturable: fine */ }
    // The middle button drags the picture (a mouse has no three fingers); it never reaches the desktop.
    if (isPanButton(e)) { const p = this.local(e); this.midPan = { id: e.pointerId, x: p.x, y: p.y }; return; }
    this.send(this.gestures.down(this.local(e)));
    this.armTick();
  }
  pointerMove(e: PointerEvent): void {
    if (!this.wrap) return;
    if (this.midPan?.id === e.pointerId) {
      const p = this.local(e), d = { x: p.x - this.midPan.x, y: p.y - this.midPan.y };
      this.midPan = { id: e.pointerId, x: p.x, y: p.y };
      if (d.x || d.y) this.send([{ t: "pan", d }]);
      return;
    }
    this.send(this.gestures.move(this.local(e)));
  }
  pointerUp(e: PointerEvent): void {
    if (!this.wrap) return;
    if (this.midPan?.id === e.pointerId) { this.midPan = null; return; }
    this.send(this.gestures.up(this.local(e)));
    this.armTick();
  }
  pointerCancel(e: PointerEvent): void {
    if (!this.wrap) return;
    if (this.midPan?.id === e.pointerId) { this.midPan = null; return; }
    this.send(this.gestures.cancel(this.local(e)));
  }

  /** A wheel or trackpad on a desktop browser: Ctrl+wheel zooms, a wheel scrolls (Touch/Trackpad). */
  wheel(e: WheelEvent): void {
    if (!this.wrap) return;
    const r = this.wrap.getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (e.ctrlKey) { this.send([{ t: "zoom", factor: Math.exp(-e.deltaY / 200), at, pan: { x: 0, y: 0 } }]); return; }
    if (this.gestures.mode === "view") { this.send([{ t: "pan", d: { x: -e.deltaX, y: -e.deltaY } }]); return; }
    const k = this.srcPxPerPx();
    if (k === null) return; // the desktop's size is not known yet: dropped, never guessed
    const p =this.gestures.mode === "trackpad" ? this.gestures.cursor() : screenToSource(this.box, this.aspect(), this.view, at);
    const dx = Math.round(-e.deltaX * k), dy = Math.round(-e.deltaY * k);
    if (dx || dy) this.send([{ t: "input", ev: { k: "scroll", ...p, dx, dy } }]);
  }

  private armTick(): void {
    if (this.tickTimer) { clearTimeout(this.tickTimer); this.tickTimer = null; }
    const at = this.gestures.nextTick();
    if (at == null) return;
    this.tickTimer = setTimeout(() => { this.tickTimer = null; this.send(this.gestures.tick(performance.now())); }, Math.max(0, at - performance.now()) + 5);
  }

  private send(outs: GestureOut[]): void {
    for (const o of outs) {
      if (o.t === "zoom") { this.view = zoomAt(this.box, this.aspect(), this.view, o.factor, o.at, o.pan); this.viewMoved(); }
      else if (o.t === "pan") { this.view = panBy(this.box, this.aspect(), this.view, o.d); this.viewMoved(); }
      else if (o.t === "cursor") {
        const p = sourceToScreen(this.box, this.aspect(), this.view, o.at);
        const next = keepInView(this.box, this.aspect(), this.view, p);
        if (next !== this.view) { this.view = next; this.viewMoved(); } else this.layout();
      } else this.queue(o.ev);
    }
  }

  // ── upstream ────────────────────────────────────────────────────────────

  /** Why input goes nowhere right now, or null. */
  blocked(): string | null {
    const ui = this.ui.get();
    const c = controlBlock(ui.mode, ui.status);
    if (c) return c;
    if (!this.handle || ui.phase !== "open") return "The live view is not open — nothing can be sent until it is.";
    return null;
  }

  private queue(ev: DesktopInput): void {
    if (this.blocked()) return; // the line under the toolbar already says why
    this.coalesce.push(ev);
    if (!this.flushRaf) this.flushRaf = requestAnimationFrame(() => { this.flushRaf = 0; this.flush(); });
  }

  private flush(): number {
    let n = 0;
    for (const ev of this.coalesce.drain()) if (this.handle?.input(ev)) n++;
    this.meter = addInputs(this.meter, n);
    return n;
  }

  /** Send now (a key, typed text), in order, after anything coalesced. True if every event went. */
  private sendNow(evs: DesktopInput[]): boolean {
    const why = this.blocked();
    if (why) { core().say.toast(why); return false; }
    this.flush();
    let n = 0;
    for (const ev of evs) { if (!this.handle?.input(ev)) break; n++; }
    this.meter = addInputs(this.meter, n);
    if (n < evs.length) core().say.toast(partialSendLine(n, evs.length));
    return n === evs.length;
  }

  toggleMod(m: Modifier): void { this.patch({ held: toggleMod(this.ui.get().held, m) }); }

  pressRowKey(k: RowKey): void {
    if (this.sendNow([rowKeyEvent(this.ui.get().held, k)])) this.patch({ held: [] });
  }

  /** Typed words for the desktop: true when all of it went (the caller then clears the box). */
  typeText(s: string, thenReturn: boolean): boolean {
    const evs = textEvents(s, this.ui.get().held);
    if (thenReturn) evs.push({ k: "key", key: "Return", mods: [] });
    if (!evs.length) return false;
    const ok = this.sendNow(evs);
    if (ok) this.patch({ held: [] });
    return ok;
  }

  /** A hardware keyboard's press: true when it went to the desktop (the caller then keeps it from
   *  the page). Blocked is silent — the line under the toolbar already says why, and a toast per
   *  key repeat would bury it. */
  pressKeyboard(e: KeyPress): boolean {
    if (this.blocked()) return false;
    const ev = keyboardEvent(e, this.ui.get().held);
    if (!ev) return false;
    this.flush();
    if (!this.handle?.input(ev)) return false;
    this.meter = addInputs(this.meter, 1);
    if (this.ui.get().held.length) this.patch({ held: [] });
    return true;
  }

  private patch(p: Partial<Ui>): void { this.ui.set((u) => ({ ...u, ...p })); }
}
