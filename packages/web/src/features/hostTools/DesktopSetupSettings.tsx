/**
 * **This desktop's setup, as ONE door row.** The rows about the MACHINE (the live desktop's helper,
 * Screen Recording, Accessibility, the claude CLI, price list, auto-compact ...) are listed, ranked and
 * fixable on the Setup check sheet's "this machine" scope, with what was checked and found fine
 * beside them. The row IS the door: its count is `findingCut`, the same one the sheet draws, and the
 * tap lands on exactly those. A host too old to answer the check shows nothing: not a finding.
 */
import { MonitorCog } from "lucide-react";
import { findingCut } from "@waterplane/shared";
import { api } from "../../api";
import { core } from "../../sdk";
import { SetAction } from "../../SettingsKit";
import { useRemoteResource } from "../../useRemoteResource";
import { track } from "../../usage";

export function DesktopSetupChecklist() {
  const res = useRemoteResource("setupcheck:-", () => api.setupCheck(null), { cache: { shape: 1 } });
  const doc = res.data;
  if (!doc) return null;
  const n = findingCut(doc.findings, { scope: "machine" }).count;
  return (
    <SetAction id="desktop-setup" icon={MonitorCog} opens
      label={`desktop setup · ${n ? `${n} to look at` : "all set"}`}
      title="Opens the setup check on this machine: what this desktop needs, with what was checked and found fine."
      onClick={() => { track("action:settings.desktopSetup"); core().nav.openSetupCheck(null, { scope: "machine" }); }} />
  );
}
