/**
 * The Tools rack's first door: the CLI health board, toned by the rollup so a
 * broken heuristic is visible from Settings too. Compact — it sits in the core
 * sheet's door rack, first of nine.
 */
import { Waypoints } from "lucide-react";
import { SetAction } from "../../SettingsKit";
import { track } from "../../usage";
import { openCliHealth } from "./actions";
import { useCliRollup } from "./store";

export function CliHealthSettings() {
  const cliRollup = useCliRollup();
  return (
    <SetAction id="tool-cli-health" compact label="CLI health" icon={Waypoints}
      tone={cliRollup?.verdict === "broken" ? "danger" : cliRollup?.verdict === "degraded" ? "warn" : undefined}
      title="every point where this app reads something it does not own — the choice-box detector, the hook pipe, the echo probe, the conversation log"
      onClick={() => { track("overlay:clihealth"); openCliHealth(null); }} />
  );
}
