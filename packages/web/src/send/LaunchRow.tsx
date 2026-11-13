/** The *model* row: which model the session(s) a send opens start on. Split from `ToSection.tsx` (docs/notes/send-architecture.md). */
import { Cpu } from "lucide-react";
import { LaunchPicker, launchOf } from "../LaunchPicker";
import type { LaunchOpts } from "@waterplane/shared";
import { launchOfTarget, launchWords } from "../sendIntent";
import { defaultsLaunch, keepSeededMode, pickedModel, seededMode } from "../sendIntent/sendSeedMode.ts";
import { launchFor } from "../backendCaps";
import type { SendSheetModel } from "./useSendSheet";
import { SetNote, SetWarn } from "../SettingsKit";

/**
 * **The Start-with picker, offered on a chip and never forced.** The launch
 * ask's own controls (`LaunchPicker`), opened only by a tap: untouched, the
 * send runs on the new-session defaults and no dialogue stands between Send
 * and the session — the sheet's button is never routed through the ask
 * (`SendIntent.launchChosen`). Same two targets as the budget, and the answer
 * lives on the target (`SendTarget.launch`) so the *To* row and the button
 * restate it. A later run carries it to the desktop on the row itself.
 */
export function LaunchRow({ m, setLaunch }: {
  m: SendSheetModel;
  /** The one write of a launch: the caller decides what a backend change does to the cap under it. */
  setLaunch: (l: LaunchOpts | null) => void;
}) {
  const { target, when, launchOpen, setLaunchOpen } = m;
  const backends = m.backends ?? null;
  const defaults = m.launchDefaults ?? {};
  const lau = launchOfTarget(target);
  const at = lau ?? defaults;
  // A mode the seed set (the vault's plan-mode explainer) outlives every pick here; a backend that cannot start in it is SAID, never silent.
  const seeded = seededMode(lau, defaults), modeLost = !!lau && !!seeded && launchFor(lau, backends).permissionMode !== seeded;
  return (
    <>
      <div className="sched-days" style={{ marginTop: 6 }}>
        <button className={`row-chip${lau ? " on" : ""}`} aria-pressed={launchOpen}
          onClick={() => setLaunchOpen(!launchOpen)}>
          <Cpu size={13} /> model: {launchWords(lau)}
        </button>
      </div>
      {launchOpen && (
        <div className="form">
          <LaunchPicker backends={backends} defaults={defaults}
            nowLead={target.kind === "repos" ? "Every repo starts on" : "Starts on"}
            value={{ backend: at.backend, model: at.model, effort: at.effort }}
            onChange={(p) => setLaunch(keepSeededMode(launchOf(defaults, p), lau, defaults))}>
            <SetNote as="span">
              {/* Where a later run's "nothing picked" lands: the DESKTOP opens
                  it, on its own defaults — not this phone's. */}
              {pickedModel(lau) ? "Just this send — your new-session defaults don’t change." : when.kind === "now"
                ? "Nothing picked: it starts on your new-session defaults."
                : "Nothing picked: the desktop opens it on its own defaults."}{" "}
              {pickedModel(lau) && <button className="link-btn" onClick={() => setLaunch(defaultsLaunch(lau, defaults))}>use the defaults</button>}
            </SetNote>
            {modeLost && <SetWarn>This backend cannot start in {seeded} mode: the session would run with its own permissions. Pick claude, or do not send this.</SetWarn>}
          </LaunchPicker>
        </div>
      )}
    </>
  );
}
