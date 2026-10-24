/**
 * Tools' updates controls: the door to the updates sheet (its number is a filter: a tap opens
 * exactly those rows) and the daily-check switch.
 */
import { Download } from "lucide-react";
import { BRAND } from "@waterplane/shared";
import { setPref, useStore, usePref } from "../../sdk";
import { SetAction, SetSwitch } from "../../SettingsKit";
import { openUpdates } from "./updatesActions";
import { dueCount } from "./logic";
import { updatesStatus } from "./store";

export function UpdatesDoor() {
  const n = dueCount(useStore(updatesStatus));
  return (
    <SetAction id="tool-updates" compact icon={Download} label={n > 0 ? `updates · ${n}` : "updates"}
      title={n > 0 ? `${n} with an update — a tap opens exactly those` : `${BRAND.displayName} and plugin updates`}
      onClick={openUpdates} />
  );
}

export function UpdatesAutoRow() {
  const on = usePref("updatesAutoCheck");
  return (
    <SetSwitch id="updates-auto" label="check daily for updates" icon={Download} on={on}
      onChange={() => setPref("updatesAutoCheck", !on)}
      note={`The desktop looks for a new ${BRAND.displayName} and new plugin versions once a day. A check only looks; nothing installs until you confirm.`} />
  );
}
