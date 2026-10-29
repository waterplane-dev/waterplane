/**
 * Settings › Sessions: "retry on network errors" — the host's switch for
 * typing `continue` after the CLI gave up a turn on a transient API error
 * (host `netretrycfg.ts` + `sessions/apiretry.ts`, R-connection-025).
 *
 * The switch itself is the top-level `NetRetrySwitch.tsx` — the same one a
 * stalled backlog/Activity row draws beside Retry now. Absent until the host
 * has said; an environment-forced off is a sentence, never a greyed switch.
 */
import { NetRetrySwitch } from "../../NetRetrySwitch";

export function NetRetrySettings() {
  return (
    <NetRetrySwitch
      id="net-retry" label="retry on network errors"
      note="When the desktop loses the network mid-turn and claude gives up, type “continue” for it once the line is back."
      more={<p>On a widening wait, up to a set number of tries; a session shows the retry under its terminal with a cancel. Typing into the session, or a turn starting, calls it off. Turning this off cancels every pending retry. Work whose retries ran out stays running, marked stalled, with Retry now on its row.</p>}
    />
  );
}
