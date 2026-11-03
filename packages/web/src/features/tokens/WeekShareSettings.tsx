/**
 * Settings › Sessions › count every paired desktop: the weekly calibration's spend side
 * (`weekCalSpend`). Off (the default) is this desktop's own logs, refused in words where a paired
 * desktop on the same account spent more; on asks every paired desktop for its week and adds it.
 */
import { MonitorSmartphone } from "lucide-react";
import { useStore } from "../../sdk";
import { SetSwitch } from "../../SettingsKit";
import { track } from "../../usage";
import { recalibrateWeek } from "./actions";
import { setWeekAllDesktops, weekAllDesktops } from "./store";

export function WeekShareSettings() {
  const on = useStore(weekAllDesktops);
  return (
    <SetSwitch
      id="week-all-desktops" label="count every paired desktop" icon={MonitorSmartphone}
      on={on}
      onChange={() => { track("action:weekAllDesktops.toggle"); setWeekAllDesktops(!on); recalibrateWeek(); }}
      note={on
        ? <>"% of week" counts what every paired desktop on this account spent, not only this one.</>
        : <>"% of week" is worked out from this desktop's spend alone — and not shown where a paired desktop on the account spent more.</>}
      more={<p>The weekly percentage is the whole account's; each desktop's logs hold only its own spend. A desktop you rarely use would otherwise read one percent of the week as a few cents and every session's share far too high. Paired desktops answer over the peer link; one that does not answer is left out, never counted as zero.</p>}
    />
  );
}
