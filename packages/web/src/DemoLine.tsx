/**
 * **"Demo — nothing runs on a computer", on every screen while the demo is on.**
 *
 * The demo is a real-looking app over a pretend desktop; the one thing it must
 * never do is be mistaken for the real one, so this line is not dismissible and
 * not snoozeable. It is mounted in `main.tsx` beside the strips for the reason
 * they are (`App` returns early once per overlay), and publishes its height as
 * `--ui-demo-h` so every screen's top padding clears it (`styles.css`).
 *
 * What it OFFERS depends on where the demo runs (`demoEntry.ts` `demoPlace`):
 * the Android shell can connect a real desktop (or, with one already paired,
 * just leave); a browser served by a host can leave; a static page can do
 * neither — it says where to open waterplane from instead. Everywhere it offers
 * "More to try", the feature tour (`features/demoTour`), asked for by event
 * because this line is outside `App`.
 */
import { useEffect } from "react";
import { BRAND } from "@waterplane/shared";
import { FlaskConical, LogOut, Plug, Sparkles } from "lucide-react";
import { isDemo } from "./demo/mode";
import { demoPlace, haveRealHost, leaveDemo, openDemoTour } from "./demoEntry";

/** One-line height; the static variant wraps to two. */
const ONE_LINE = 22;
const TWO_LINES = 36;

export function DemoLine() {
  const on = isDemo();
  const place = demoPlace();
  const h = place === "static" ? TWO_LINES : ONE_LINE;
  useEffect(() => {
    if (!on) return undefined;
    document.documentElement.style.setProperty("--ui-demo-h", `${h}px`);
    return () => { document.documentElement.style.removeProperty("--ui-demo-h"); };
  }, [on, h]);
  if (!on) return null;

  const connect = place === "shell" && !haveRealHost();
  return (
    <div className={place === "static" ? "demo-line static" : "demo-line"} role="status" style={{ height: h }}>
      <FlaskConical size={12} />
      <span className="demo-line-text">
        {place === "static"
          ? <>Demo — nothing runs on a computer. To use {BRAND.name} for real, open it from your own desktop host.</>
          : "Demo — nothing runs on a computer"}
      </span>
      <button className="key demo-line-go" onClick={openDemoTour}><Sparkles size={11} /> More to try</button>
      {place !== "static" && (
        <button className="key demo-line-go" onClick={leaveDemo}>
          {connect ? <><Plug size={11} /> Connect a real desktop</> : <><LogOut size={11} /> Leave the demo</>}
        </button>
      )}
    </div>
  );
}
