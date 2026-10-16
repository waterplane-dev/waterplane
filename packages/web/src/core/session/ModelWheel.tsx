/**
 * The model wheel popover: picks model AND effort for the live session in one
 * gesture (`WheelChart`), and under it the permission mode and ultracode
 * (`ModeSection.tsx` — live switches, not picks waiting for Apply). Opened by the button left of the reader switch
 * (`ScreenCorner`).
 *
 * A tap or a drag only SELECTS; Apply lands it, and the sentence ABOVE the
 * chart says what Apply will do — above, because the choosing thumb covers
 * whatever is under the chart. What a pick does is `planPick`: `/model` and
 * `/effort` typed through the queue where the CLI has them (no restart),
 * `launch.relaunch` only where it does not — no new send path.
 *
 * FLOATING for `.term-zoom`'s reason: a popover in flow would resize the
 * terminal, and a refit SIGWINCHes the PTY. Fixed to the VIEWPORT and portalled
 * to `<body>`, not boxed in the terminal: with the chrome showing on a small
 * phone the terminal is ~250px tall, and a popover capped to it cut the wheel
 * off mid-chart (and the chart takes the touch, so it could not be scrolled
 * into view either). `wheelTop` puts it under the button, slid up to fit.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cacheLikelyCold, sessionCostOf, type BackendInfo, type ClientMessage, type Effort, type LaunchOpts, type SessionInfo } from "@waterplane/shared";
import { CLAUDE, backendIdOf, effortChoices, modelChoices } from "../../backendCaps";
import { planPick, switchCostText, wheelCandidates, wheelLanded, wheelNow, wheelTop } from "../../modelWheel";
import { ago } from "../../format";
import { resumeIdOf } from "../../sessionFacts";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { WheelPicker, type WheelPick } from "../../WheelChart";
import { ModeSection, hasModeSection } from "./ModeSection";

export interface ModelWheelProps {
  cur: SessionInfo;
  backends: BackendInfo[] | null;
  canSlash: boolean;
  submitInput(id: string, cwd: string, text: string, kind: "prompt" | "command", holdUntilIdle?: boolean): boolean;
  setLaunchOpt(patch: Partial<LaunchOpts>): void;
  relaunch(s: SessionInfo, patch: Partial<LaunchOpts>): void;
  /** `session.mode` is live only (`ModeSection`). */
  liveAsk(frame: ClientMessage, blocked?: string): boolean;
  /** The button that opened it — the popover hangs under it while it fits. */
  anchor: { current: HTMLElement | null };
  onClose(): void;
}

/** The last live switch sent from the wheel, per session, until the log shows
 *  a turn on it (`wheelLanded`). Memory only: it answers "did my tap do
 *  anything" in the minutes after it, and a reload forgets it with the toast. */
const sentSwitch = new Map<string, { commands: string[]; model?: string; effort?: Effort; at: number }>();

export function ModelWheel(p: ModelWheelProps): ReactNode {
  // Portalled with its scrim: a tap anywhere off the wheel closes it, and is
  // not also a tap on whatever is underneath.
  return createPortal(<>
    <div className="model-wheel-scrim" onPointerDown={(e) => { e.preventDefault(); p.onClose(); }} />
    <Placed anchor={p.anchor}><WheelBody {...p} /></Placed>
  </>, document.body);
}

function Placed({ anchor, children }: { anchor: { current: HTMLElement | null }; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  // Before the first measure it sits at the top margin, never under the fold.
  const [top, setTop] = useState(8);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      setTop(wheelTop(a ? a.bottom : 0, el.offsetHeight, window.innerHeight));
    };
    place();
    // Its height changes on a pick (cost line, Apply) and the viewport on the
    // keyboard (`interactive-widget=resizes-content`).
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => { ro.disconnect(); window.removeEventListener("resize", place); };
  }, [anchor]);
  return <div ref={ref} className="model-wheel-place" style={{ ["--mw-top" as string]: `${top}px` }}>{children}</div>;
}

function WheelBody({ cur, backends, canSlash, submitInput, setLaunchOpt, relaunch, liveAsk, onClose }: ModelWheelProps): ReactNode {
  const withMode = hasModeSection(backends, cur, canSlash);
  // The mode rows and ultracode: UNDER the chart and its Apply, ABOVE the model
  // chips — read after a pick, and out of the way of the dragging thumb.
  const modes = <ModeSection cur={cur} backends={backends} canSlash={canSlash} submitInput={submitInput} liveAsk={liveAsk} onClose={onClose} />;
  const cat = modelChoices(backends, cur.backend);
  const efforts = effortChoices(backends, cur.backend);
  const [sel, setSel] = useState<WheelPick | null>(null);

  useEffect(() => {
    // preventDefault: answered here, so `core/layout/escape.ts` adds no Back.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (wheelCandidates(cat).length === 0 && !cur.model) {
    return (
      <div className="model-wheel-pop" role="dialog" aria-label="model wheel">
        <WheelHead onClose={onClose} withMode={withMode} />
        <div className="form-hint">
          This backend did not name its models, so there is nothing to put on a wheel. Switch model in the menu
          takes a typed id.
        </div>
        {modes}
      </div>
    );
  }

  // `/effort` is claude's command; another backend's slash set may not have it,
  // and a `/effort high` typed into one would be the first line of a prompt.
  // Planned against what the last turn RAN on, not the launch flags: after a
  // `/model` landed, the launch flags still name the old model and the wheel
  // kept offering the switch that had already happened.
  const now = wheelNow(cur, cat);
  const sent = sentSwitch.get(cur.id);
  if (sent && wheelLanded(sent, now, cat.ids)) sentSwitch.delete(cur.id);
  const waiting = sent && sentSwitch.has(cur.id) ? sent : null;
  const plan = sel ? planPick(now, sel, { slash: canSlash, effort: backendIdOf(cur) === CLAUDE }) : null;
  const pickName = sel ? `${sel.model}${sel.effort ? ` · ${sel.effort}` : ""}` : "";
  const keepsConvo = resumeIdOf(cur) ? "the conversation is resumed" : "no conversation id is known, so it starts clean";
  const says = !plan
    ? `Tap or drag to a point${efforts.length > 0 ? " — centre is low effort, the rim is max" : ""}.${efforts.length > 0 ? "" : " This backend has no effort setting."}`
    : plan.kind === "none"
      ? now.from === "turn" ? `The last turn already ran on ${pickName}.` : `This session started on ${pickName}.`
      : plan.kind === "live"
        // No "no restart" here: a live switch is the normal case, so only the
        // relaunch says it restarts.
        ? `Sends ${plan.commands.join(" then ")}.`
        : `Kills and relaunches this session on ${pickName}; ${keepsConvo}.`;

  // What the switch costs beyond the work: the cache it throws away.
  const reading = sessionCostOf(cur.contextSpark, { lastTurnAt: cur.lastTurnAt, turnActive: cur.turnActive, now: Date.now() });
  const cost = sel && plan && plan.kind !== "none"
    ? switchCostText({
      from: { model: now.model, effort: now.effort }, to: sel, ids: cat.ids,
      tok: reading?.tok ?? null, baseTok: reading?.baseTok ?? null,
      cold: cacheLikelyCold(cur.lastTurnAt, Date.now(), cur.turnActive),
    })
    : null;

  const apply = () => {
    if (!plan || plan.kind === "none") return;
    track(`action:modelwheel.${plan.kind}`);
    if (plan.kind === "live") {
      // submitInput, never a one-chunk "…\r" (`ModelSheet`'s reason: it lands
      // as a paste). One per command, in order — the queue keeps that order.
      for (const c of plan.commands) submitInput(cur.id, cur.cwd, c, "command");
      sentSwitch.set(cur.id, { commands: plan.commands, model: plan.model, effort: plan.effort, at: Date.now() });
      setLaunchOpt({ ...(plan.model ? { model: plan.model } : {}), ...(plan.effort ? { effort: plan.effort } : {}) });
      showToast(plan.commands.join(" · "));
    } else {
      relaunch(cur, plan.patch);
    }
    onClose();
  };

  return (
    <div className="model-wheel-pop" role="dialog" aria-label="model wheel">
      <WheelHead onClose={onClose} withMode={withMode} />
      {/* Everything to READ sits above the chart — the choosing thumb covers
          whatever is under it. "Last turn ran on" when the log says so (a
          /model typed since launch shows there), "Started on" when only the
          launch flags are known — never "now" for either. */}
      <WheelPicker cat={cat} efforts={efforts} current={{ model: now.model, effort: now.effort }}
        value={sel} onPick={setSel} onClear={() => setSel(null)} says={says}
        now={<>
          {now.from === "turn"
            ? <>Last turn ran on {cur.turnModel}{cur.turnEffort ? ` · ${cur.turnEffort}` : ""}</>
            : <>Started on {cur.model || "the default model"}{cur.effort ? ` · ${cur.effort}` : efforts.length > 0 ? " · default effort" : ""}</>}
          {waiting && <><br />Sent {waiting.commands.join(" then ")} {ago(waiting.at)}; no turn has run on it yet.</>}
        </>}>
        {/* UNDER the chart, unlike the words: it appears on the first pick, and
            above the chart it would shove the wheel down under a dragging finger.
            Present only when there is something to do — never a greyed Apply;
            the sentence above already says why there is none. */}
        {cost && <div className="form-hint mw-cost">{cost}</div>}
        {plan && plan.kind !== "none" && (
          <button className="send mw-apply" onClick={apply}>
            {plan.kind === "live" ? `Switch to ${pickName}` : `Relaunch on ${pickName}`}
          </button>
        )}
        {modes}
      </WheelPicker>
    </div>
  );
}

function WheelHead({ onClose, withMode }: { onClose(): void; withMode: boolean }): ReactNode {
  return (
    <div className="mw-head">
      <span>Model · effort{withMode ? " · mode" : ""}</span>
      <button className="key" aria-label="close the model wheel" onClick={onClose}><X size={16} /></button>
    </div>
  );
}
