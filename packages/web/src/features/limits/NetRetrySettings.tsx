/**
 * Settings › Sessions: "retry on network errors" — the host's switch for
 * typing `continue` after the CLI gave up a turn on a transient API error
 * (host `netretrycfg.ts` + `sessions/apiretry.ts`, R-connection-025).
 *
 * Absent until the host has said (an older host has no switch to reach). When
 * the desktop's environment forces the retry off, the row says so in a
 * sentence (`netRetryEnvOffText`) — never a greyed switch — and the switch
 * shows and saves the SAVED value ("saved on"), which takes effect the day that
 * override is removed.
 */
import { AlertTriangle, WifiOff } from "lucide-react";
import { netRetryEffective, netRetryEnvOffText } from "@waterplane/shared";
import { SetSwitch, SetWarn } from "../../SettingsKit";
import { setNetRetry } from "./actions";
import { useNetRetryCfg } from "./store";

export function NetRetrySettings() {
  const cfg = useNetRetryCfg();
  if (!cfg) return null;
  return (
    <SetSwitch
      id="net-retry" label="retry on network errors" icon={WifiOff}
      on={cfg.envOff ? cfg.enabled : netRetryEffective(cfg)}
      state={cfg.envOff ? (cfg.enabled ? "saved on" : "saved off") : undefined}
      onChange={() => setNetRetry(!cfg.enabled, !!cfg.envOff)}
      note="When the desktop loses the network mid-turn and claude gives up, type “continue” for it once the line is back."
      more={<p>On a widening wait, up to a set number of tries; a session shows the retry under its terminal with a cancel. Typing into the session, or a turn starting, calls it off. Turning this off cancels every pending retry.</p>}
    >
      {cfg.envOff && <SetWarn tone="plain" icon={AlertTriangle}>{netRetryEnvOffText()}</SetWarn>}
    </SetSwitch>
  );
}
