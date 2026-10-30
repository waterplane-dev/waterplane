/**
 * Which `autoCompactWindow` the Repo readings checklist writes when you take
 * its suggestion — and the line under which a repo's window reads as fine.
 *
 * Host-side (`/api/host/setupprefs`), not a synced setting: the sweep decides
 * where the row passes with no phone attached, and `settings.ts` stores
 * strings the daemon never parses. Nothing here writes into a repo; it only
 * changes what the checklist offers to write.
 */
import { useEffect, useState } from "react";
import { Minimize2 } from "lucide-react";
import { AUTO_COMPACT_CHOICES, AUTO_COMPACT_SUGGESTED } from "@waterplane/shared";
import { api } from "../../api";
import { SetChoice } from "../../SettingsKit";
import { showToast } from "../../toast";

export function AutoCompactSettings() {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    api.setupPrefs(ac.signal)
      .then((r) => { if (!ac.signal.aborted) setValue(r.autoCompactDefault); })
      .catch((e) => { if (!ac.signal.aborted) setError(String((e as Error).message || e)); });
    return () => ac.abort();
  }, []);

  async function choose(v: string) {
    const prev = value;
    setValue(v);
    try {
      const r = await api.setSetupPrefs(v === AUTO_COMPACT_SUGGESTED ? null : v);
      if (!r.ok) { setValue(prev); showToast(r.error || "the desktop did not store it"); return; }
      setValue(r.autoCompactDefault ?? v);
      setError(null);
    } catch (e) {
      setValue(prev);
      showToast(`not saved — ${String((e as Error).message || e)}`);
    }
  }

  return (
    <SetChoice
      id="auto-compact-default" label="auto-compact window" icon={Minimize2}
      value={value ?? ""}
      options={AUTO_COMPACT_CHOICES.map((c) => ({
        value: c, label: c === AUTO_COMPACT_SUGGESTED ? `${c} (default)` : c,
      }))}
      onChange={(v) => void choose(v)}
      note={error
        ? `Could not read this desktop's choice: ${error}`
        : "What Repo readings offers to write into a repo's .claude/settings.json, and the size under which a repo's window counts as fine. Nothing is written until you tap it there."}
      more={<p>A conversation compacts once its context passes this, so one long agent stops re-reading a whole 1M window on every step. Smaller is cheaper per step and compacts more often. Stored on the desktop, the same for every device.</p>}
    />
  );
}
