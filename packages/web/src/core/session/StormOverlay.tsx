/**
 * The storm: what an EMPTY session screen shows in the native shell while the
 * link is down. Never over anything readable — terminal output, scrollback or
 * a transcript cached on this phone turn it off at once (`stormPhase.ts`).
 *
 * The logo's plane holds over rough water in the rain; once the socket has
 * stayed open (`stormPhase.ts`) the weather calms, the plane flares, touches
 * down, and the logo's cursor block lights up beside it — then it fades and the
 * output is back. All of it is drawn on one canvas from code: no image, font or
 * sound asset, so the OTA bundle grows by this file and nothing else.
 *
 * APK only (`isNativeShell`); `?storm` in the URL shows it in a browser for
 * looking at. "Hide animation" hides it for this outage — the screen's own
 * offline card and banner show instead, and the next outage may bring it back.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { Button } from "../../kit/Button";
import { isNativeShell } from "../../hostUrl";
import { LAND_MS, STABLE_MS, STORM_OFF, nextStorm, type StormState } from "./stormPhase";

const wantStorm = (): boolean => {
  if (isNativeShell()) return true;
  try { return new URLSearchParams(location.search).has("storm"); } catch { return false; }
};

/** The phase machine, ticked while it runs. `status` is the socket's, `connVisible` the banner's,
 *  `quiet` = nothing on this screen or cached that a person could read. */
export function useStorm(status: string, connVisible: boolean, quiet: boolean): { state: StormState; dismiss: () => void } {
  const [enabled] = useState(wantStorm);
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState<StormState>(STORM_OFF);
  const open = status === "open";
  useEffect(() => { if (open) setDismissed(false); }, [open]);
  useEffect(() => {
    if (!enabled) return;
    const step = () => setState((s) => {
      const n = nextStorm(s, { down: connVisible && !open, open, quiet, dismissed, now: Date.now() });
      return n.phase === s.phase && n.since === s.since && n.shownAt === s.shownAt ? s : n;
    });
    step();
    if (state.phase === "off" && !(connVisible && !open)) return;
    const t = window.setInterval(step, 200);
    return () => window.clearInterval(t);
  }, [enabled, open, connVisible, quiet, dismissed, state.phase]);
  return { state, dismiss: () => setDismissed(true) };
}

/** Below this height (CSS px) the storm is not drawn at all — the banner shows instead. With the
 *  keyboard up the stage can shrink to a sliver, and a few rows of moving rain under the header
 *  read as a glitch, not a picture (owner, 11-18). */
export const STORM_MIN_H = 220;

/** Whether the stage `ref` is tall enough for the storm. */
export function useStormRoom(ref: RefObject<HTMLElement | null>): boolean {
  const [room, setRoom] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setRoom(el.getBoundingClientRect().height >= STORM_MIN_H);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, [ref]);
  return room;
}

export function StormOverlay({ state, tailscaleIp, onDismiss }: {
  state: StormState; tailscaleIp?: string | null; onDismiss: () => void;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    return runStorm(cv, () => stateRef.current);
  }, []);
  const words = state.phase === "storm" ? "connection lost — reconnecting…"
    : state.phase === "approach" ? "link is back — waiting for it to hold"
    : "back online";
  return (
    <div className={`storm storm-${state.phase}`}>
      <canvas ref={canvasRef} className="storm-canvas" aria-hidden="true" />
      <div className="storm-line" role="status">{words}{tailscaleIp ? ` · ${tailscaleIp}` : ""}</div>
      {/* Big, worded and first in reading order: someone who has never seen
          this must know at a glance it is a picture they can put away. */}
      <Button className="storm-hide" onClick={onDismiss}>
        <X size={18} aria-hidden="true" /> hide animation
      </Button>
    </div>
  );
}

// ── the drawing ─────────────────────────────────────────────────────────────

const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const clamp = (u: number) => Math.max(0, Math.min(1, u));
type Drop = { x: number; y: number; l: number; v: number };
type Puff = { x: number; y: number; vx: number; vy: number; life: number };

/** Starts the loop on `cv`; returns its stop. */
function runStorm(cv: HTMLCanvasElement, read: () => StormState): () => void {
  const ctx = cv.getContext("2d");
  if (!ctx) return () => {};
  const still = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } })();
  let w = 0, h = 0, dpr = 1, raf = 0, last = performance.now();
  let t = 0, boltAt = -10, nextBolt = 3 + Math.random() * 5, boltSeed = 1;
  let touched = false, landFrom: { x: number; y: number } | null = null, lastPhase = "off";
  const drops: Drop[] = [];
  const puffs: Puff[] = [];
  const clouds = Array.from({ length: 6 }, (_, i) => ({ x: i * 170 + Math.random() * 80, y: 0.06 + Math.random() * 0.22, r: 60 + Math.random() * 70, v: 14 + Math.random() * 16 }));

  const fit = () => {
    const r = cv.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, r.width); h = Math.max(1, r.height);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    while (drops.length < 160) drops.push({ x: Math.random() * w * 1.3, y: Math.random() * h, l: 8 + Math.random() * 14, v: 500 + Math.random() * 350 });
  };
  const ro = new ResizeObserver(fit);
  ro.observe(cv);
  fit();

  // Motion in px/s was tuned on a full screen; on a shorter stage the same speed crosses it
  // in a fraction of the time and reads as frantic, so pace scales with the height.
  const pace = () => clamp(h / 520) * 0.65 + 0.35;
  const sea = () => h * 0.64;
  const wave = (x: number, A: number, ph: number, sp: number) =>
    A * (0.6 * Math.sin(x * 0.011 + t * 1.25 * sp + ph) + 0.3 * Math.sin(x * 0.026 - t * 0.9 * sp + ph * 2) + 0.14 * Math.sin(x * 0.067 + t * 2.3 * sp));

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000) * (still ? 0.4 : 1);
    last = now; t += dt;
    const st = read();
    const age = Date.now() - st.since;
    if (st.phase !== lastPhase) {
      if (st.phase === "storm") { touched = false; landFrom = null; }
      lastPhase = st.phase;
    }
    const u = st.phase === "landing" ? clamp(age / LAND_MS) : 0;
    const calm = st.phase === "approach" ? 0.25 * clamp(age / STABLE_MS)
      : st.phase === "landing" ? 0.25 + 0.75 * ease(u / 0.7) : 0;
    const storm = 1 - calm;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Sky: the logo's, darkened by the storm, warmed by the landing.
    const sky = ctx.createLinearGradient(0, 0, 0, sea());
    sky.addColorStop(0, "#0A1B28"); sky.addColorStop(1, "#10324A");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = `rgba(2,6,10,${0.45 * storm})`; ctx.fillRect(0, 0, w, h);
    if (calm > 0.3) {
      const g = ctx.createRadialGradient(w * 0.62, sea(), 0, w * 0.62, sea(), Math.max(w, h) * 0.6);
      g.addColorStop(0, `rgba(245,169,63,${0.3 * (calm - 0.3)})`); g.addColorStop(1, "rgba(245,169,63,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    // Lightning — soft, and never with reduced motion.
    if (!still && storm > 0.7 && t > nextBolt) { boltAt = t; boltSeed = Math.random() * 1000; nextBolt = t + 5 + Math.random() * 9; }
    const flash = Math.max(0, 1 - (t - boltAt) / 0.35) * storm;
    if (flash > 0) {
      ctx.fillStyle = `rgba(220,235,255,${0.14 * flash})`; ctx.fillRect(0, 0, w, h);
      if (flash > 0.45) {
        let bx = (boltSeed % 1) * w * 0.6 + w * 0.2 + ((boltSeed * 7) % 60), by = 0;
        ctx.beginPath(); ctx.moveTo(bx, by);
        for (let i = 1; by < sea() * 0.85; i++) { by += 18 + ((boltSeed * i) % 22); bx += ((boltSeed * i * 13) % 40) - 20; ctx.lineTo(bx, by); }
        ctx.strokeStyle = `rgba(235,245,255,${flash})`; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    // Clouds drifting with the wind.
    for (const c of clouds) {
      const x = ((c.x - t * c.v * (0.3 + storm)) % (w + 400) + w + 400) % (w + 400) - 200;
      const g = ctx.createRadialGradient(x, c.y * h, 0, x, c.y * h, c.r * 1.6);
      g.addColorStop(0, `rgba(30,46,60,${0.8 * storm + 0.1})`); g.addColorStop(1, "rgba(30,46,60,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, c.y * h, c.r * 1.6, c.r * 0.7, 0, 0, 7); ctx.fill();
    }

    // The plane — computed before the front waves so it can sit IN the water.
    const A = h * 0.06 * (0.12 + 0.88 * storm) + 1.5;
    const size = Math.min(w * 0.17, h * 0.2, 80) / 230;
    const hold = { x: w * 0.36 + Math.sin(t * 0.31) * w * 0.07, y: h * 0.3 + Math.sin(t * 0.83) * h * 0.03 };
    const jolt = storm * pace() * (Math.sin(t * 6.3) * Math.sin(t * 1.7) * 7 + (Math.sin(t * 0.7) > 0.93 ? Math.sin(t * 40) * 5 : 0));
    let px = hold.x, py = hold.y + jolt, pitch = Math.cos(t * 0.83) * 0.08 + jolt * 0.01;
    if (st.phase === "landing") {
      if (!landFrom) landFrom = { x: px, y: py };
      const tdX = w * 0.52, waterAt = (x: number) => sea() + A * 0.25 + wave(x, A, 0, 1) - 80 * size;
      if (u < 0.5) {
        const k = ease(u / 0.5);
        px = landFrom.x + (tdX - landFrom.x) * k;
        py = landFrom.y + (waterAt(px) - landFrom.y) * k + jolt * (1 - k);
        pitch = u < 0.38 ? 0.12 : -0.12 * ease((u - 0.38) / 0.12); // descend nose-down, flare nose-up
      } else {
        const k = ease((u - 0.5) / 0.35);
        px = tdX + w * 0.08 * k;
        py = waterAt(px);
        const slope = (wave(px + 6, A, 0, 1) - wave(px - 6, A, 0, 1)) / 12;
        pitch = Math.atan(slope) - 0.12 * (1 - k);
        if (!touched) {
          touched = true;
          for (let i = 0; i < 40; i++) puffs.push({ x: px - 30 * size, y: sea() + wave(px, A, 0, 1), vx: -40 - Math.random() * 120, vy: -80 - Math.random() * 160, life: 1 });
        }
        if (Math.random() < 0.5 * (1 - k)) puffs.push({ x: px - 70 * size, y: py + 30 * size, vx: -60 - Math.random() * 40, vy: -30 - Math.random() * 40, life: 0.7 });
      }
    }

    // Back waves.
    const layer = (dy: number, ph: number, sp: number, fill: string | CanvasGradient, step = 8) => {
      ctx.beginPath(); ctx.moveTo(0, h);
      for (let x = 0; x <= w + step; x += step) ctx.lineTo(x, sea() + dy + wave(x, A, ph, sp));
      ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    };
    layer(-A * 1.1, 2.1, 0.7, "#0b3540");
    layer(-A * 0.4, 4.2, 0.85, "#0d4853");
    // Speed lines behind the plane, as on the logo.
    ctx.save(); ctx.translate(px, py); ctx.rotate(pitch);
    if (st.phase !== "landing" || u < 0.5) {
      ctx.strokeStyle = "rgba(233,244,242,0.25)"; ctx.lineWidth = 2; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-125 * size, -55 * size); ctx.lineTo(-170 * size, -58 * size);
      ctx.moveTo(-120 * size, 62 * size); ctx.lineTo(-165 * size, 66 * size); ctx.stroke();
    }
    drawPlane(ctx, size);
    ctx.restore();
    // Front wave over the plane's floats.
    const sg = ctx.createLinearGradient(0, sea() - A, 0, h);
    sg.addColorStop(0, "#0F5A66"); sg.addColorStop(1, "#061219");
    layer(A * 0.25, 0, 1, sg, 6);
    // Whitecaps on the crests, while it's rough.
    if (storm > 0.2) {
      ctx.strokeStyle = `rgba(233,244,242,${0.55 * storm})`; ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let x = 6; x < w; x += 6) {
        const y0 = wave(x - 6, A, 0, 1), y1 = wave(x, A, 0, 1), y2 = wave(x + 6, A, 0, 1);
        if (y1 < y0 && y1 < y2 && y1 < -A * 0.35) {
          const y = sea() + A * 0.25 + y1;
          ctx.moveTo(x - 10, y + 3); ctx.quadraticCurveTo(x, y - 3, x + 12, y + 2);
          if (!still && Math.random() < 0.08 * storm) puffs.push({ x, y, vx: -60 - Math.random() * 60, vy: -40 - Math.random() * 70, life: 0.6 });
        }
      }
      ctx.stroke();
    }
    // The logo's cursor block, lit beside the landed plane.
    if (st.phase === "landing" && u > 0.62) {
      const on = Math.floor((t * 1000) / 550) % 2 === 0;
      if (on) {
        ctx.fillStyle = "#F5A93F";
        const bw = 128 * size, bh = 28 * size, bx = px + 133 * size, by = sea() + A * 0.25 + wave(bx, A, 0, 1) - bh;
        ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 9 * size); ctx.fill();
      }
    }
    // Spray.
    ctx.fillStyle = "rgba(233,244,242,0.7)";
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.vy += 380 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * 1.2;
      if (p.life <= 0) { puffs.splice(i, 1); continue; }
      ctx.globalAlpha = p.life; ctx.fillRect(p.x, p.y, 2, 2);
    }
    ctx.globalAlpha = 1;
    // Rain, slanted by the wind; it thins out as it calms.
    const k = pace();
    const n = Math.round(drops.length * (still ? 0.4 : 1) * clamp(storm * 1.3 - 0.2));
    if (n > 0) {
      ctx.strokeStyle = "rgba(200,225,235,0.32)"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const d = drops[i];
        d.y += d.v * k * dt; d.x -= d.v * k * 0.28 * dt;
        if (d.y > h || d.x < -20) { d.y = -d.l; d.x = Math.random() * w * 1.3; }
        ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.l * k * 0.28, d.y - d.l * k);
      }
      ctx.stroke();
    }
    // Fade out at the end of the landing.
    if (u > 0.88) { cv.style.opacity = String(1 - (u - 0.88) / 0.12); }
    else cv.style.opacity = "1";
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); ro.disconnect(); };
}

/** The logo's plane (`public/assets/icon-dark.svg`), centred at the origin, nose right. */
function drawPlane(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.save();
  ctx.scale(s, s);
  ctx.rotate(7 * Math.PI / 180);
  ctx.translate(-185, -228);
  const g = ctx.createLinearGradient(60, 140, 300, 320);
  g.addColorStop(0, "#F5A93F"); g.addColorStop(1, "#EC6F55");
  ctx.strokeStyle = g; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.lineWidth = 50; ctx.beginPath(); ctx.moveTo(128, 146); ctx.lineTo(286, 228); ctx.lineTo(128, 310); ctx.stroke();
  ctx.lineWidth = 22; ctx.beginPath(); ctx.moveTo(272, 228); ctx.lineTo(84, 228); ctx.stroke();
  ctx.lineWidth = 15; ctx.beginPath(); ctx.moveTo(92, 204); ctx.lineTo(104, 228); ctx.lineTo(92, 252); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(140, 160); ctx.lineTo(270, 228); ctx.stroke();
  ctx.fillStyle = "rgba(10,27,40,0.5)"; ctx.beginPath(); ctx.arc(250, 228, 6.5, 0, 7); ctx.fill();
  ctx.restore();
}
