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

/** The top-of-Settings door beside Plugins: same sheet, same filter as `UpdatesDoor` (the number
 *  opens exactly those rows), plain button like its neighbour. */
export function UpdatesTopDoor() {
  const n = dueCount(useStore(updatesStatus));
  return (
    <button className="set-door" title={n > 0 ? `${n} with an update — a tap opens exactly those` : `Is there a newer ${BRAND.displayName}, or a newer plugin? A check only looks.`} onClick={openUpdates}>
      <Download size={14} /> {n > 0 ? `Updates · ${n}` : "Updates"}
    </button>
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
