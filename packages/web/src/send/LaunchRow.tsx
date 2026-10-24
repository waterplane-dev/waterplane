/** The *model* row: which model the session(s) a send opens start on. Split from `ToSection.tsx` (docs/notes/send-architecture.md). */
import { Cpu } from "lucide-react";
import { LaunchPicker, launchOf } from "../LaunchPicker";
import { launchOfTarget, launchWords, withLaunch, withoutLaunch } from "../sendIntent";
import type { SendSheetModel } from "./useSendSheet";
import { SetNote } from "../SettingsKit";

/**
 * **The Start-with picker, offered on a chip and never forced.** The launch
 * ask's own controls (`LaunchPicker`), opened only by a tap: untouched, the
 * send runs on the new-session defaults and no dialogue stands between Send
 * and the session — the sheet's button is never routed through the ask
 * (`SendIntent.launchChosen`). Same two targets as the budget, and the answer
 * lives on the target (`SendTarget.launch`) so the *To* row and the button
 * restate it. A later run carries it to the desktop on the row itself.
 */
export function LaunchRow({ m }: { m: SendSheetModel }) {
  const { target, setTarget, when, launchOpen, setLaunchOpen } = m;
  const backends = m.backends ?? null;
  const defaults = m.launchDefaults ?? {};
  const lau = launchOfTarget(target);
  const at = lau ?? defaults;
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
            onChange={(p) => setTarget((t) => withLaunch(t, launchOf(defaults, p)))}>
            <SetNote as="span">
              {/* Where a later run's "nothing picked" lands: the DESKTOP opens
                  it, on its own defaults — not this phone's. */}
              {lau ? "Just this send — your new-session defaults don’t change." : when.kind === "now"
                ? "Nothing picked: it starts on your new-session defaults."
                : "Nothing picked: the desktop opens it on its own defaults."}{" "}
              {lau && <button className="link-btn" onClick={() => setTarget(withoutLaunch)}>use the defaults</button>}
            </SetNote>
          </LaunchPicker>
        </div>
      )}
    </>
  );
}
