/**
 * The Tools group's first row: the door into token statistics. Drawn in the
 * core sheet's lead band for that group, above the door rack.
 */
import { BarChart3 } from "lucide-react";
import { core } from "../../sdk";
import { SetAction } from "../../SettingsKit";
import { track } from "../../usage";

export function TokenSettings() {
  return (
    <SetAction
      id="token-stats" label="token statistics" icon={BarChart3} opens
      onClick={() => { track("overlay:tokens"); core().nav.open("tokens"); }}
      note="Every token this desktop has ever used, cumulative and per day, by model and by repo."
      more={<p>Read out of the CLI's own conversation logs, so it covers sessions this app never drove.</p>}
    />
  );
}
