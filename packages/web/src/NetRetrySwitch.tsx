/**
 * THE network-error retry switch — one implementation, drawn in two places:
 * Settings › Sessions (`features/limits/NetRetrySettings.tsx`, the catalogued
 * row `net-retry`) and a STALLED backlog/Activity row (`NetStalled.tsx`), next
 * to Retry now. Both flip the same host setting (`netretry.set`, host
 * `netretrycfg.ts`), never a setting of their own.
 *
 * `SetSwitch` (label left, its state pinned right). When the desktop's
 * environment forces the retry off the switch shows and saves the SAVED value
 * ("saved on") and says why in a sentence (`netRetryEnvOffText`) — never a
 * greyed switch. Absent until the host has said (an older host has no switch).
 */
import type { ReactNode } from "react";
import { AlertTriangle, WifiOff } from "lucide-react";
import { netRetryEffective, netRetryEnvOffText } from "@waterplane/shared";
import { SetSwitch, SetWarn } from "./SettingsKit";
import { setNetRetry, useNetRetryCfg } from "./netRetryCfg";

export function NetRetrySwitch({ id, label, note, more }: {
  /** The Settings catalogue id — only the Settings row has one (a row's copy is uncounted). */
  id?: string;
  label: string;
  note?: ReactNode;
  more?: ReactNode;
}): ReactNode {
  const cfg = useNetRetryCfg();
  if (!cfg) return null;
  return (
    <SetSwitch
      id={id} label={label} icon={WifiOff}
      on={cfg.envOff ? cfg.enabled : netRetryEffective(cfg)}
      state={cfg.envOff ? (cfg.enabled ? "saved on" : "saved off") : undefined}
      onChange={() => setNetRetry(!cfg.enabled, !!cfg.envOff)}
      note={note} more={more}
    >
      {cfg.envOff && <SetWarn tone="plain" icon={AlertTriangle}>{netRetryEnvOffText()}</SetWarn>}
    </SetSwitch>
  );
}
