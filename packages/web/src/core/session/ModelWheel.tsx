/**
 * The model wheel popover: picks model AND effort for the live session in one
 * gesture (`WheelChart`). Opened by the button left of the reader switch
 * (`ScreenCorner`).
 *
 * A tap or a drag only SELECTS; Apply lands it, and the sentence ABOVE the
 * chart says what Apply will do — above, because the choosing thumb covers
 * whatever is under the chart. What a pick does is `planPick`: `/model` and
 * `/effort` typed through the queue where the CLI has them (no restart),
 * `launch.relaunch` only where it does not — no new send path.
 *
 * FLOATING for `.term-zoom`'s reason: a popover in flow would resize the
 * terminal, and a refit SIGWINCHes the PTY.
 */
import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cacheLikelyCold, sessionCostOf, type BackendInfo, type LaunchOpts, type SessionInfo } from "@waterplane/shared";
import { CLAUDE, backendIdOf, effortChoices, modelChoices } from "../../backendCaps";
import { planPick, switchCostText, wheelCandidates } from "../../modelWheel";
import { resumeIdOf } from "../../sessionFacts";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { WheelPicker, type WheelPick } from "../../WheelChart";

export interface ModelWheelProps {
  cur: SessionInfo;
  backends: BackendInfo[] | null;
  canSlash: boolean;
  submitInput(id: string, cwd: string, text: string, kind: "prompt" | "command", holdUntilIdle?: boolean): boolean;
  setLaunchOpt(patch: Partial<LaunchOpts>): void;
  relaunch(s: SessionInfo, patch: Partial<LaunchOpts>): void;
  onClose(): void;
}

export function ModelWheel({ cur, backends, canSlash, submitInput, setLaunchOpt, relaunch, onClose }: ModelWheelProps): ReactNode {
  const cat = modelChoices(backends, cur.backend);
  const efforts = effortChoices(backends, cur.backend);
  const [sel, setSel] = useState<WheelPick | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (wheelCandidates(cat).length === 0 && !cur.model) {
    return (
      <div className="model-wheel-pop" role="dialog" aria-label="model wheel">
        <WheelHead onClose={onClose} />
        <div className="form-hint">
          This backend did not name its models, so there is nothing to put on a wheel. Switch model in the menu
          takes a typed id.
        </div>
      </div>
    );
  }

  // `/effort` is claude's command; another backend's slash set may not have it,
  // and a `/effort high` typed into one would be the first line of a prompt.
  const plan = sel ? planPick(cur, sel, { slash: canSlash, effort: backendIdOf(cur) === CLAUDE }) : null;
  const pickName = sel ? `${sel.model}${sel.effort ? ` · ${sel.effort}` : ""}` : "";
  const keepsConvo = resumeIdOf(cur) ? "the conversation is resumed" : "no conversation id is known, so it starts clean";
  const says = !plan
    ? `Tap or drag to a point${efforts.length > 0 ? " — centre is low effort, the rim is max" : ""}.${efforts.length > 0 ? "" : " This backend has no effort setting."}`
    : plan.kind === "none"
      ? `This session started on ${pickName}.`
      : plan.kind === "live"
        // No "no restart" here: a live switch is the normal case, so only the
        // relaunch says it restarts.
        ? `Sends ${plan.commands.join(" then ")}.`
        : `Kills and relaunches this session on ${pickName}; ${keepsConvo}.`;

  // What the switch costs beyond the work: the cache it throws away.
  const reading = sessionCostOf(cur.contextSpark, { lastTurnAt: cur.lastTurnAt, turnActive: cur.turnActive, now: Date.now() });
  const cost = sel && plan && plan.kind !== "none"
    ? switchCostText({
      from: { model: cur.model, effort: cur.effort }, to: sel, ids: cat.ids,
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
      setLaunchOpt({ ...(plan.model ? { model: plan.model } : {}), ...(plan.effort ? { effort: plan.effort } : {}) });
      showToast(plan.commands.join(" · "));
    } else {
      relaunch(cur, plan.patch);
    }
    onClose();
  };

  return (
    <div className="model-wheel-pop" role="dialog" aria-label="model wheel">
      <WheelHead onClose={onClose} />
      {/* Everything to READ sits above the chart — the choosing thumb covers
          whatever is under it. "Started on", not "now": the session record
          holds the launch flags, and a /model typed since is not in it. */}
      <WheelPicker cat={cat} efforts={efforts} current={{ model: cur.model, effort: cur.effort }}
        value={sel} onPick={setSel} onClear={() => setSel(null)} says={says}
        now={<>Started on {cur.model || "the default model"}{cur.effort ? ` · ${cur.effort}` : efforts.length > 0 ? " · default effort" : ""}</>}>
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
      </WheelPicker>
    </div>
  );
}

function WheelHead({ onClose }: { onClose(): void }): ReactNode {
  return (
    <div className="mw-head">
      <span>Model · effort</span>
      <button className="key" aria-label="close the model wheel" onClick={onClose}><X size={16} /></button>
    </div>
  );
}
