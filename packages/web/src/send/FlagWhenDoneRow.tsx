/**
 * The *To* section's "Flag for follow up when done" (R-sessions-043): off
 * unless ticked, no global setting, and drawn only where the desktop opens the
 * session (`flagWhenDoneOffered`) — absent, never dimmed, everywhere else.
 */
import type { ReactNode } from "react";
import { Flag } from "lucide-react";
import { flagWhenDoneOffered, type SendTarget, type SendWhen } from "../sendIntent";

export function FlagWhenDoneRow({ target, when, setTarget }: {
  target: SendTarget; when: SendWhen; setTarget: (t: SendTarget) => void;
}): ReactNode {
  if (!flagWhenDoneOffered(target, when) || (target.kind !== "repo" && target.kind !== "repos")) return null;
  const on = target.flagWhenDone === true;
  return (
    <>
      <div className="sched-days" style={{ marginTop: 6 }}>
        <button className={`row-chip${on ? " on" : ""}`} aria-pressed={on} data-hint="session.followup"
          onClick={() => setTarget({ ...target, flagWhenDone: on ? undefined : true })}>
          <Flag size={13} fill={on ? "currentColor" : "none"} /> Flag for follow up when done
        </button>
      </div>
      {on && <div className="form-hint">{target.kind === "repos" ? "Each session it opens" : "The session it opens"} gets the follow-up flag once it is done — not if it failed or stopped on a usage limit.</div>}
    </>
  );
}
