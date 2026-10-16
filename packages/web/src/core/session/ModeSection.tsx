/**
 * The model wheel popover's MODE half: the desktop's mode menu (Manual · Edit
 * automatically · Plan · Auto) as rows, and the ultracode switch. Effort stays
 * on the wheel itself.
 *
 * A row tap is `session.mode` through `liveAsk` — live only, never queued
 * offline (a mode switch delivered an hour late changes what an unwatched
 * session may do unasked). The row then says "switching…" until the host's
 * `session.moded` lands or `MODE_SWITCH_MS` passes (`modeSwitch.ts`). A
 * no-approval mode is never armed by one tap: it asks first (`askConfirm`).
 *
 * Ultracode is a slash command (`/effort ultracode on|off`), so it takes the
 * same queued `submitInput` "command" path the wheel's `/effort` does. Its
 * state is what the CLI last CONFIRMED on screen; absent is "not known", never
 * drawn as off.
 *
 * Rules and words: `modePick.ts`.
 */
import type { ReactNode } from "react";
import { Check, Code, Hand, Loader2, Lock, ScrollText, ShieldOff, Sparkles, Zap } from "lucide-react";
import type { BackendInfo, ClientMessage, PermissionMode, SessionInfo } from "@waterplane/shared";
import { CLAUDE, backendIdOf, backendInfo, effortChoices, permModeChoices } from "../../backendCaps";
import { askConfirm } from "../../Confirm";
import {
  MODE_DEFS, modeNow, modeNowText, modeRows, modeTap, modeTitle, ultraCommand, ultraState, ultraText,
  type ModeIcon,
} from "../../modePick";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { Unavailable } from "../../Unavailable";
import { RISKY_PERM_WARNING } from "../settings/permModes";
import { beginModeSwitch, useModeSwitch } from "./modeSwitch";

const ICONS: Record<ModeIcon, typeof Hand> = {
  hand: Hand, code: Code, scroll: ScrollText, zap: Zap, shieldOff: ShieldOff, lock: Lock,
};

/** A mode's icon — the rows' and the closed wheel button's badge. */
export function ModeGlyph({ mode, size = 16 }: { mode: PermissionMode; size?: number }): ReactNode {
  const Icon = ICONS[MODE_DEFS[mode]?.icon ?? "hand"];
  return <Icon size={size} aria-hidden />;
}

/** What the section draws: the mode rows this backend lists, and whether
 *  ultracode applies (`/effort` is claude's, and ultracode rides on it). */
function parts(backends: BackendInfo[] | null, cur: SessionInfo, canSlash: boolean) {
  const isClaude = backendIdOf(cur) === CLAUDE;
  return {
    isClaude,
    rows: modeRows(permModeChoices(backends, cur.backend), cur),
    ultraOk: isClaude && canSlash && effortChoices(backends, cur.backend).length > 0,
  };
}

/** Whether the popover has a mode half at all (the head's title names it). */
export function hasModeSection(backends: BackendInfo[] | null, cur: SessionInfo, canSlash: boolean): boolean {
  const p = parts(backends, cur, canSlash);
  return p.rows.length > 0 || p.ultraOk;
}

export interface ModeSectionProps {
  cur: SessionInfo;
  backends: BackendInfo[] | null;
  canSlash: boolean;
  submitInput(id: string, cwd: string, text: string, kind: "prompt" | "command", holdUntilIdle?: boolean): boolean;
  liveAsk(frame: ClientMessage, blocked?: string): boolean;
  /** Closes the popover — a confirm is drawn UNDER it otherwise. */
  onClose(): void;
}

export function ModeSection({ cur, backends, canSlash, submitInput, liveAsk, onClose }: ModeSectionProps): ReactNode {
  const switching = useModeSwitch(cur.id);
  const { isClaude, rows, ultraOk } = parts(backends, cur, canSlash);
  const now = modeNow(cur);
  if (rows.length === 0 && !ultraOk) return null;

  const send = (mode: PermissionMode) => {
    track(`action:mode.${mode}`);
    if (liveAsk({ t: "session.mode", id: cur.id, mode }, "no connection — a mode switch is never queued; try again when the link is back")) {
      beginModeSwitch(cur.id, mode);
    }
  };
  const pick = async (mode: PermissionMode) => {
    const t = modeTap(mode, now);
    if (t.kind === "none") { showToast(t.say); return; }
    if (t.kind === "confirm") {
      onClose();
      const ok = await askConfirm({
        title: `Switch this session to ${modeTitle(mode)}?`,
        lines: [...RISKY_PERM_WARNING.slice(0, 2), "This session only — new sessions keep their own launch mode."],
        confirmLabel: `Switch to ${modeTitle(mode)}`,
      });
      if (!ok) return;
    }
    send(mode);
  };
  const ultra = (on: boolean) => {
    const cmd = ultraCommand(on);
    track(`action:ultracode.${on ? "on" : "off"}`);
    if (submitInput(cur.id, cur.cwd, cmd, "command")) showToast(cmd);
  };
  const ust = ultraState(cur.ultracode);

  return (
    <div className="mode-sec">
      {rows.length > 0 && <>
        <div className="mode-head muted">Mode{isClaude ? " · shift+tab on the desktop" : ""}</div>
        <div className="form-hint mode-now">{modeNowText(now)}</div>
        {isClaude ? (
          <div className="mode-rows" role="group" aria-label="permission mode">
            {rows.map((r) => {
              const isNow = now.mode === r.mode;
              const busy = switching === r.mode;
              return (
                <button key={r.mode} className={`mode-row${isNow && now.source === "live" ? " cur" : ""}`}
                  aria-pressed={isNow && now.source === "live"} onClick={() => void pick(r.mode)}>
                  <span className="mode-ico"><ModeGlyph mode={r.mode} /></span>
                  <span className="mode-txt">
                    <span className="mode-title">{r.title}</span>
                    <span className="mode-desc muted">{busy ? "switching…" : r.desc}</span>
                  </span>
                  <span className="mode-mark">
                    {busy ? <Loader2 size={16} className="spin" />
                      : isNow && now.source === "live" ? <Check size={16} />
                        : isNow ? <span className="muted">at launch</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          // Switching live is claude's shift+tab; another backend's mode is the
          // launch flag it started with. A sentence, never a dimmed list.
          <Unavailable cants={[{
            label: "switching mode here",
            reason: `${backendInfo(backends, cur.backend)?.label ?? cur.backend} takes its mode at launch — change it in Settings and relaunch.`,
          }]} />
        )}
      </>}
      {ultraOk && (
        <div className="mode-ultra">
          <span className="mode-ico"><Sparkles size={16} aria-hidden /></span>
          <span className="mode-txt">
            <span className="mode-title">Ultracode</span>
            <span className="mode-desc muted">{ultraText(cur.ultracode)}</span>
          </span>
          <span className="mode-acts">
            {/* Unknown gets BOTH verbs: neither is "the toggle" when nobody
                knows which side it is on. */}
            {ust !== "on" && <button className="key" onClick={() => ultra(true)}>turn on</button>}
            {ust !== "off" && <button className="key" onClick={() => ultra(false)}>turn off</button>}
          </span>
        </div>
      )}
    </div>
  );
}
