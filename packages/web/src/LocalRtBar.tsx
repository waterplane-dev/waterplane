import { Bot, Boxes, Cpu, Gpu, MemoryStick, X } from "lucide-react";
import { useEffect } from "react";
import {
  acquireLocalRtWatch, barVisible, cpuBusyPct, cpuSeries, gbText, heldBytes, heldSeries, heldUntil,
  localRtState, machineText, memAvailBytes, memTight, seriesCeiling, useLocalRt, type LocalRtSnapshot, type LocalRtReading,
} from "./localRt";
import type { LoadedModel } from "@waterplane/shared";
import { useLink } from "./link";
import { dur } from "./format";
import { agentCountText, agentLevel, dismissAgentStrip, useAgentCount, useAgentForced } from "./agentCount";
import { showToast } from "./toast";
import { usePref } from "./core/prefs";

/**
 * **The desktop strip** — how hard the machine is working (CPU, GPU, memory
 * available), and, whenever a local model is resident, that model as the
 * headline: its name, its bytes and their line. Pinned to the top of every
 * screen while it is switched on. Module and storage names keep `localRt` —
 * they predate the wider job, and renaming a stored key loses the switch.
 *
 * `NetPulseBar` is the shape, and the argument is the same one transposed one
 * layer down. That strip exists because everything else in the app reports the
 * LINK only after something has already gone wrong. This one exists because
 * nothing in the app reports the DESKTOP'S MEMORY at all: a hosted model's cost
 * appears on an invoice, and a local model's cost — 18 GB resident, measured,
 * on a machine already at 59.3 GB of RSS with a nearly-full swap file — appears
 * nowhere. You find out by the desktop becoming unusable.
 *
 * Why a graph and not a number: a model being loaded or evicted is a STEP, and
 * a step is the event worth seeing. "18.2 GB" tells you what is true now; the
 * shape tells you that ten minutes ago it was zero, which is the difference
 * between "this is how the machine is" and "this started when I opened that
 * session". Samples where the runner did not answer are drawn as their own
 * full-height marks, never averaged into the line and never bridged across —
 * `link.ts`'s rule, for its reason: those are a different kind of event, not a
 * small number.
 *
 * **It observes, it never steers.** Nothing on this strip starts a model, stops
 * one, evicts one or refuses a launch. The strongest thing the whole feature
 * does anywhere is put a sentence under a model picker.
 *
 * **Tokens per second is deliberately absent.** There is no slot for it, no
 * dash and no placeholder: nothing this app can read publishes live throughput,
 * and the available estimate (PTY bytes over wall clock) is wrong in the two
 * directions that matter — a TUI repaints, and a model thinking emits nothing
 * while doing the expensive part.
 *
 * Every reading is its own tap target with its own hint, and each one opens the
 * sheet AT ITS OWN SECTION (`app:open-localrt` carries a focus) — four facts
 * share 22 px, so they can only be a shape and a number here, and dropping the
 * reader at the top of the sheet to hunt for the one they tapped is how a
 * readout becomes work.
 */

/** Which reading sent the user to the sheet. */
export type LocalRtFocus = "models" | "history" | "cpu" | "memory" | "agents";

/** Samples drawn. Fewer than the ring the store keeps: 84 px cannot show a
 *  hundred and twenty marks without becoming a smear. */
const GRAPH_N = 30;
const W = 84;
const H = 16;

function openLocalRt(focus: LocalRtFocus, e?: { stopPropagation(): void }): void {
  e?.stopPropagation();
  try { window.dispatchEvent(new CustomEvent("app:open-localrt", { detail: { focus } })); } catch { /* no DOM */ }
}

/**
 * Held bytes over the window.
 *
 * Right-aligned like the link strip's: the newest sample is at the right edge
 * and older ones march left, so a window that is not yet full grows into the
 * space rather than stretching four points across it and implying a history
 * that does not exist.
 */
export function HeldSpark({ series, ceiling, w = W, h = H }: { series: readonly (number | null)[]; ceiling: number; w?: number; h?: number }) {
  const n = Math.max(2, Math.round(w / (W / GRAPH_N)));
  const shown = series.slice(-n);
  const step = w / (n - 1);
  const x = (i: number) => w - (shown.length - 1 - i) * step;
  const y = (b: number) => h - Math.min(1, b / ceiling) * (h - 1) - 0.5;

  // One polyline per unbroken run of samples the runner answered. A line drawn
  // across a miss would cross the exact event this graph exists to show.
  const runs: string[] = [];
  let run: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    const v = shown[i];
    if (v == null) { if (run.length > 1) runs.push(run.join(" ")); run = []; continue; }
    run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  }
  if (run.length > 1) runs.push(run.join(" "));
  // A lone answered sample between two misses belongs to no line; draw it as a
  // point so it is not silently dropped.
  const dots = shown
    .map((v, i) => (v != null
      && (i === 0 || shown[i - 1] == null)
      && (i === shown.length - 1 || shown[i + 1] == null) ? { i, v } : null))
    .filter((d): d is { i: number; v: number } => d != null);

  return (
    <svg className="lrt-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {shown.map((v, i) => (v == null ? (
        <rect key={`m${i}`} x={Math.max(0, x(i) - step / 2)} y={0} width={Math.max(1.5, step)} height={h} className="lrt-miss" />
      ) : null))}
      {runs.map((pts, i) => <polyline key={`r${i}`} points={pts} className="lrt-line" />)}
      {dots.map((d) => <circle key={`d${d.i}`} cx={x(d.i)} cy={y(d.v)} r={1.2} className="lrt-dot" />)}
    </svg>
  );
}

/**
 * The state word, in 22 px.
 *
 * Five states share this slot and they are FIVE DIFFERENT SENTENCES — the
 * decision is `localRtState`'s and is made once, pure and tested. What is
 * chosen here is only how each one is abbreviated to fit, with the whole
 * sentence in the title and the hint. None of them may be shortened into
 * another: "off here" and "no runner" are opposite problems with opposite
 * fixes, and "idle" said about a desktop nobody could reach is a lie.
 */
/** The first resident model's name, with how many more beside it. */
function modelNames(models: readonly LoadedModel[]): string {
  const [first, ...rest] = models;
  return rest.length ? `${first.name} +${rest.length}` : first.name;
}

export function shortReading(r: LocalRtReading): string {
  if (r.kind === "holding" && r.sample) {
    return `${modelNames(r.sample.models)} · ${gbText(heldBytes(r.sample.models))}`;
  }
  switch (r.kind) {
    case "idle": return "holding nothing";
    case "unreachable": return "no runner";
    case "disabled": return "not polled here";
    case "unanswered": return "no answer";
    default: return "…";
  }
}

/** The LED's tone. Green for a current reading of the machine — with or
 *  without a runner, since a desktop with none is the NORMAL case. Amber for
 *  the two states a person can act on: memory tight, or a desktop too old to
 *  answer. Muted for anything stale. */
function ledTone(r: LocalRtReading, tight: boolean): string {
  if (r.kind === "unanswered" || (tight && !r.stale)) return "lrt-old";
  if (r.stale || !r.sample) return "lrt-quiet";
  return "lrt-live";
}

export function LocalRtBar() {
  const mode = useLocalRt((s) => s.mode);
  /**
   * **The lease belongs to the MODE, not to whether the strip is drawn.**
   *
   * It used to live in `Strip`, which mounts only once `barVisible()` is
   * already true — so `auto` could never turn itself on: nothing visible ⇒ no
   * lease ⇒ no sample ⇒ nothing ever learns a model was loaded ⇒ still nothing
   * visible. The one mode whose entire job is to appear when a model appears
   * was structurally incapable of it, and the settings row said out loud that
   * it polls. Holding the lease here, keyed on the mode, is what makes that
   * sentence true.
   */
  useEffect(() => (mode === "off" ? undefined : acquireLocalRtWatch()), [mode]);
  // `live` only while this device is watching. The once-a-second clock exists
  // for `auto`'s linger and for the stale marks; with the mode off it is a
  // timer waking a backgrounded phone to recompute a number nobody is looking
  // at, which is the cost this readout measures and must not itself pay.
  const vis = useLocalRt((s) => {
    const held = s.last && s.last.reachable && s.last.models.length > 0;
    return barVisible(s.mode, {
      holding: !!held,
      lastHeldAt: heldUntil(s.samples, s.last),
      now: s.now,
    });
  }, mode !== "off");
  // Past a parallel-agent mark the strip shows itself whatever the mode, until
  // the person closes it (`agentCount.ts`'s `stripForced`).
  const forced = useAgentForced();
  const enabled = vis || forced;

  // The strip's height, published as a CSS variable rather than measured by
  // every screen: `.screen` and `.sheet` add it to their top padding, so one
  // number keeps every view — including sheets written later — clear of the bar
  // instead of being covered by it.
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-localrt-h", enabled ? "18px" : "0px");
    return () => { document.documentElement.style.removeProperty("--ui-localrt-h"); };
  }, [enabled]);

  // With the mode off nothing polls the machine, so the forced strip is the
  // count alone — never a machine strip saying "not polled here".
  if (!enabled) return null;
  return mode === "off" ? <AgentOnlyStrip /> : <Strip closable={forced && !vis} />;
}

/**
 * Split from the switch above so a strip that is not DRAWN holds no
 * subscription.
 *
 * It deliberately does NOT hold the lease any more — that moved up to
 * `LocalRtBar` and is keyed on the MODE. See the note there: a lease taken by
 * the visible component made `auto` unable to ever become visible. Switching
 * the mode to `off` is still what stops the desktop polling; that is now said
 * by the effect that owns it rather than by where this component happens to
 * mount.
 *
 * **Two layouts, one slot that changes owner.** With no model resident the
 * strip is the MACHINE: CPU busy and its line lead, memory available and GPU
 * sit right. The moment a local model is resident it takes the lead slot —
 * name, bytes held and the held-memory line, in the accent — and the machine
 * shrinks to the numbers on the right. A loaded model is the one thing on this
 * desktop that can eat 20 GB without anybody typing, so when there is one it
 * is the headline; when there is none, "holding nothing" was a headline about
 * an absence, and the machine itself is the more useful line.
 */
function Strip({ closable }: { closable: boolean }) {
  const s = useLocalRt<LocalRtSnapshot>((x) => x, true);
  // Online-ness comes from `link.ts`, the one store that owns it. Deriving it a
  // second time here is the bug class that file was written to end.
  const online = useLink((x) => x.online);

  const r = localRtState({
    last: s.last, disabled: s.disabled, online,
    askedAt: s.askedAt, answeredAt: s.answeredAt, now: s.now,
  });
  const age = r.at != null && r.stale ? dur(r.at) : null;
  // The machine's numbers ride on every answered sample, runner or not.
  const m = r.kind === "holding" || r.kind === "idle" || r.kind === "unreachable" ? s.last : null;
  const model = r.kind === "holding" && r.sample ? r.sample : null;
  const tight = m ? memTight(m) : false;
  const series = model ? heldSeries(s.samples) : cpuSeries(s.samples);

  return (
    <div className={`localrt-bar ${ledTone(r, tight)}${model ? " lrt-has-model" : ""}`} role="status" data-hint="localrt.bar"
      title={`${model ? r.text : m ? machineText(m, r.stale) : r.text}${age ? ` (${age} ago)` : ""} — tap for this desktop`}
      onClick={() => openLocalRt(model ? "models" : "cpu")}>
      <span className="lrt-led" />
      {model ? (
        // The lead slot belongs to the model while there is one.
        <span className={`lrt-models lrt-lead${r.stale ? " stale" : ""}`} role="button" data-hint="localrt.models"
          title={`${r.text}${age ? ` — last reading ${age} ago` : ""}. Tap for the model`}
          onClick={(e) => openLocalRt("models", e)}>
          <Boxes size={11} aria-hidden="true" />
          {/* The name gives way at phone width; the bytes held never do. */}
          <span className="lrt-lead-text">{modelNames(model.models)}</span>
          <span className="lrt-lead-size">{gbText(heldBytes(model.models))}{age ? <span className="lrt-age"> · {age} ago</span> : null}</span>
        </span>
      ) : m ? (
        <span className={`lrt-cpu lrt-lead${r.stale ? " stale" : ""}`} role="button" data-hint="localrt.cpu"
          title={`the desktop's CPU is ${Math.round(cpuBusyPct(m))}% busy. Tap for the detail`}
          onClick={(e) => openLocalRt("cpu", e)}>
          <Cpu size={11} aria-hidden="true" /> {Math.round(cpuBusyPct(m))}%{age ? <span className="lrt-age"> · {age} ago</span> : null}
        </span>
      ) : (
        // No machine reading at all: disabled, unanswered or still asking.
        // Each is its own sentence, abbreviated — never a row of zeros.
        <span className="lrt-models stale" title={r.text}>{shortReading(r)}</span>
      )}
      {/* Drawn only when there is something to draw. An empty graph frame is a
          claim that a series exists and is flat. */}
      {m && series.length > 1 && (
        <span className="lrt-graph" role="button" data-hint={model ? "localrt.graph" : "localrt.cpu"}
          title={model
            ? `held memory over the last ${series.length} samples — a sample the runner did not answer is drawn as its own mark. Tap for the larger graph`
            : `CPU busy over the last ${series.length} samples, 0-100%. Tap for the larger graph`}
          onClick={(e) => openLocalRt("history", e)}>
          <HeldSpark series={series} ceiling={model ? seriesCeiling(series) : 100} w={model ? 56 : W} />
        </span>
      )}
      <AgentCountReading />
      <span className="lrt-right">
        {/* Absent, not zero, when nothing has been measured — this app's
            standing rule for a reading it does not have. GPU first while a
            model is resident: it is the number a generating model moves. */}
        {m?.gpuPct != null && (
          <span className="lrt-gpu" role="button" data-hint="localrt.cpu"
            title={`the desktop's GPU is ${Math.round(m.gpuPct)}% busy, system-wide. Tap for the detail`}
            onClick={(e) => openLocalRt("cpu", e)}>
            <Gpu size={10} aria-hidden="true" /> {Math.round(m.gpuPct)}%
          </span>
        )}
        {/* CPU is not repeated while a model leads: at 390 px the model's name
            and the memory it is eating are the two that must fit, and GPU is
            the number a generating model moves. The sheet has the CPU. */}
        {m && (
          <span className={`lrt-mem${tight ? " lrt-tight" : ""}`} role="button" data-hint="localrt.memory"
            title={`${gbText(memAvailBytes(m))} available of ${gbText(m.memTotal)} on the desktop${tight ? " — memory is tight" : ""}. Tap for where it went`}
            onClick={(e) => openLocalRt("memory", e)}>
            <MemoryStick size={10} aria-hidden="true" /> {gbText(memAvailBytes(m))}
          </span>
        )}
      </span>
      {closable && <CloseAgentStrip />}
    </div>
  );
}

/**
 * How many agents run on the desktop at once (`agentCount.ts`): sessions mid-
 * turn plus the subagents under every session. Amber past the person's
 * warning mark, red past their limit (Settings → Appearance). Absent until a
 * session list has arrived, and absent at zero — a strip of zeros says nothing.
 * Tapped, it opens *This desktop* at the agents: the count over time and
 * which sessions hold them.
 */
function AgentCountReading() {
  const c = useAgentCount();
  const cfg = usePref("agentWarn");
  if (!c || c.total === 0) return null;
  const level = agentLevel(c.total, cfg);
  const mark = level === "alarm" ? ` — more than your limit of ${cfg.alarm}` : level === "warn" ? ` — more than your warning of ${cfg.warn}` : "";
  return (
    <span className={`lrt-agents lrt-agents-${level}`} role="button" data-hint="localrt.agents"
      title={`${agentCountText(c)}${mark}. Tap for which sessions and the count over time`}
      onClick={(e) => openLocalRt("agents", e)}>
      <Bot size={10} aria-hidden="true" /> {c.total}
    </span>
  );
}

/** The strip shown only because the count passed a mark, with the desktop
 *  strip itself switched off: the count, its words, and the ×. */
function AgentOnlyStrip() {
  const c = useAgentCount();
  return (
    <div className="localrt-bar lrt-old lrt-agents-only" role="status" data-hint="localrt.agents"
      onClick={() => openLocalRt("agents")}>
      <span className="lrt-led" />
      <AgentCountReading />
      <span className="lrt-agents-words">{c ? `agents running at once` : ""}</span>
      <CloseAgentStrip />
    </div>
  );
}

/** Hides the forced strip and says how it comes back — something that
 *  disappears names the way back at that moment. */
function CloseAgentStrip() {
  return (
    <button className="lrt-close" aria-label="hide the agent warning"
      title="hide until the count climbs past your next mark"
      onClick={(e) => {
        e.stopPropagation();
        dismissAgentStrip();
        showToast("Agent warning hidden. It comes back if the count passes your next mark; Settings → Appearance → desktop strip keeps the strip on.");
      }}>
      <X size={12} aria-hidden="true" />
    </button>
  );
}
