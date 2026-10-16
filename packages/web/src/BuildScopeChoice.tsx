import { GitBranch, Laptop } from "lucide-react";
import { SetChoice } from "./SettingsKit";
import { buildScopeNote } from "./buildScope";
import { track } from "./usage";

/** The build editor's two-way choice of where an entry lives. Drawn only for a
 *  host that sent `localIds`; an older host has no second file, so no control. */
export function BuildScopeChoice({ local, wasShared, onChange }: { local: boolean; wasShared: boolean; onChange: (local: boolean) => void }) {
  return (
    <SetChoice label="Where it lives" value={local ? "local" : "shared"}
      onChange={(v) => { track("action:build.scope"); onChange(v === "local"); }}
      options={[
        { value: "shared", label: "Every checkout", icon: GitBranch },
        { value: "local", label: "This desktop only", icon: Laptop },
      ]}
      note={buildScopeNote(local, wasShared)} />
  );
}
