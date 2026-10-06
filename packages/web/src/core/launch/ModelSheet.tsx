/**
 * "Switch model" for the session on screen (overlay `model`).
 *
 * Two ways to land a model, chosen by what the backend HAS: `/model` typed
 * through the queue where slash commands exist, otherwise the launch flag —
 * `launch.relaunch`, the kill-and-create as one durable op, which lives in
 * `useLaunch` because it builds a `session.create` (`createOp.test.mjs`).
 */
import type { BackendInfo, LaunchOpts, SessionInfo } from "@waterplane/shared";
import { SheetHead } from "../../Sheet.tsx";
import { Unavailable } from "../../Unavailable.tsx";
import { CLAUDE, backendIdOf, effortChoices, freeTextNote, modelChoices, type capReason, type hasCap } from "../../backendCaps.ts";
import { shortModel } from "../../sessionFacts.tsx";
import { showToast } from "../../toast.ts";

export interface ModelSheetProps {
  cur: SessionInfo;
  backends: BackendInfo[] | null;
  /** The typed id — App-lifetime state in `useLaunch`, so it survives a close. */
  modelInput: string;
  setModelInput(v: string): void;
  submitInput(id: string, cwd: string, text: string, kind: "prompt" | "command", holdUntilIdle?: boolean): boolean;
  setLaunchOpt(patch: Partial<LaunchOpts>): void;
  relaunch(s: SessionInfo, patch: Partial<LaunchOpts>): void;
  sessionCan(s: { backend?: string } | null | undefined, cap: Parameters<typeof hasCap>[2]): boolean;
  sessionCant(s: { backend?: string } | null | undefined, cap: Parameters<typeof capReason>[2]): string | null;
  onClose(): void;
}

export function ModelSheet({ cur, backends, modelInput, setModelInput, submitInput, setLaunchOpt, relaunch, sessionCan, sessionCant, onClose }: ModelSheetProps) {
  // The catalogue is the BACKEND's, not this app's: claude's aliases are a
  // fallback for a host that never described one, and a backend whose
  // catalogue came back empty gets the typed field below and no list at
  // all. An id here may carry a slash and a colon
  // (`ollama/qwen3-coder:30b`) — nothing splits or strips one.
  const cat = modelChoices(backends, cur.backend);
  const canSlash = sessionCan(cur, "slash");
  const efforts = effortChoices(backends, cur.backend);
  // Via submitInput, NOT a raw one-chunk sendInput("…\r"): text+Return in one
  // write lands as a PASTE in claude's TUI (the \r stays literal, the command
  // never submits). submitInput splits the writes and tracks the ack.
  const pickModel = (m: string) => { submitInput(cur.id, cur.cwd, `/model ${m}`, "command"); setLaunchOpt({ model: m }); onClose(); showToast(`/model ${m}`); };
  const relaunchWith = (patch: Partial<LaunchOpts>) => relaunch(cur, patch);
  // Two ways to land a model, chosen by what the backend HAS rather than
  // offered side by side: `/model` mid-session where slash commands exist,
  // and otherwise the launch flag — which is a kill and a relaunch, and
  // says so. Never a `/model` typed into a CLI that would treat it as the
  // first line of a prompt.
  const applyModel = (m: string) => (canSlash ? pickModel(m) : relaunchWith({ model: m }));
  // Effort is live too where the CLI has `/effort` (claude's — read off the
  // binary); elsewhere it stays the launch flag and the relaunch says so.
  const liveEffort = canSlash && backendIdOf(cur) === CLAUDE;
  const applyEffort = (e: (typeof efforts)[number]) => {
    if (!liveEffort) { relaunchWith({ effort: e }); return; }
    submitInput(cur.id, cur.cwd, `/effort ${e}`, "command"); setLaunchOpt({ effort: e }); onClose(); showToast(`/effort ${e}`);
  };
  return (
    <div className="sheet">
      <SheetHead title="Switch model" onClose={onClose} />
      <div className="form-hint">
        Current: {shortModel(cur.model) || "default"}{cur.effort ? ` · ${cur.effort}` : ""}.{" "}
        {canSlash
          ? <>Picking a model sends <span className="mono">/model</span> to this session.</>
          : "Picking a model is a launch flag here — it kills and relaunches this session."}
      </div>
      <div className="list">
        {cat.aliases.length > 0 && <div className="section">Aliases</div>}
        {cat.aliases.map((m) => (
          <button key={m} className="row" onClick={() => applyModel(m)}>
            <span className="row-title mono">{m}</span>
            {cur.model === m && <span className="tag ok">current</span>}
          </button>
        ))}
        {cat.ids.length > 0 && <div className="section">Versions</div>}
        {cat.ids.map((m) => (
          <button key={m} className="row" onClick={() => applyModel(m)}>
            <span className="row-title mono">{m}</span>
            {cur.model === m && <span className="tag ok">current</span>}
          </button>
        ))}
        <div className="section">Custom</div>
        {/* The only control when the backend names no models at all — a
            typed id, never a guessed list. */}
        {cat.freeText && <div className="form-hint">{freeTextNote(backends, cur.backend)}</div>}
        <div className="form">
          <input
            className="search mono"
            placeholder={cat.ids[0] ? `e.g. ${cat.ids[0]}` : "model id"}
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && modelInput.trim()) { applyModel(modelInput.trim()); setModelInput(""); } }}
          />
          {/* Never greyed while the field is empty: the tap says what is missing. */}
          <button className="send" onClick={() => {
            if (!modelInput.trim()) { showToast("type a model id first"); return; }
            applyModel(modelInput.trim()); setModelInput("");
          }}>
            {canSlash ? "Send /model" : "Relaunch on it"}
          </button>
        </div>
        {canSlash ? (
          <button className="row" onClick={() => { submitInput(cur.id, cur.cwd, "/model", "command"); onClose(); }}>
            <span className="row-title">Open the model picker…</span>
          </button>
        ) : (
          // The CLI's own picker is a slash command. Absent, with the
          // reason — never a greyed row (`Unavailable.tsx`).
          <Unavailable cants={[{ label: "the CLI’s own model picker", reason: sessionCant(cur, "slash")! }]} />
        )}
      </div>
      {efforts.length > 0 ? <>
        <div className="form-hint">{liveEffort
          ? <>Picking an effort sends <span className="mono">/effort</span> to this session.</>
          : "Effort is a launch flag here — picking it kills + relaunches this session."}</div>
        <div className="form">
          <div className="annot-tools">
            {efforts.map((e) => (
              <button key={e} className={`key ${cur.effort === e ? "active" : ""}`} onClick={() => applyEffort(e)}>{e}</button>
            ))}
          </div>
        </div>
      </> : (
        <Unavailable cants={[{ label: "effort", reason: sessionCant(cur, "effort") ?? "this session has no effort setting" }]} />
      )}
    </div>
  );
}
