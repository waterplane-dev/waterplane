/**
 * **This desktop's setup, as one checklist** — the rows about the MACHINE rather than a repo
 * (`scope: "host"`; today the live desktop's: helper built, Screen Recording, Accessibility, who
 * macOS asks, control). They used to be listed on every repo's checklist, where a fact about the
 * desktop read as a fault of that repo; the host now leaves them out there and answers them here
 * (`GET /api/host/setup`).
 *
 * A Fix is the host's (`POST /api/host/setup/fix`), and **what it did is said under the rows** —
 * most of these fixes act on the desktop's own screen (a macOS dialog, a System Settings pane),
 * where the phone cannot see them, so a tap that only re-drew the same rows read as a dead button.
 * No rows ⇒ no section: nothing on this desktop needs setting up yet (off macOS, before the live
 * desktop was first opened, and on a host too old to answer — none of those is a finding).
 */
import { useState } from "react";
import { AlertTriangle, Check, Monitor, RefreshCw, Wrench, X } from "lucide-react";
import type { HostSetupReport } from "@waterplane/shared";
import { api } from "../../api";
import { Empty, Button, Hint } from "../../kit";
import { SetCustom } from "../../SettingsKit";
import { useRemoteResource } from "../../useRemoteResource";
import { track } from "../../usage";

const STATUS_ICON = {
  pass: <Check size={16} color="var(--ok)" />,
  warn: <AlertTriangle size={16} color="var(--warn)" />,
  fail: <X size={16} color="var(--dead)" />,
} as const;

export function DesktopSetupChecklist() {
  const res = useRemoteResource<HostSetupReport>("hostsetup", () => api.hostSetup());
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string[] | null>(null);
  const checks = res.data?.checks ?? [];
  if (!checks.length) return null;
  const open = checks.filter((c) => c.status !== "pass").length;

  async function fix(id: string) {
    if (busy) return;
    track("action:hostSetup.fix");
    setBusy(true);
    setSaid(null);
    try {
      const r = await api.hostSetupFix([id]);
      setSaid(r.notes);
      res.set({ checks: r.checks });
    } catch (e) {
      setSaid([`The fix could not reach the desktop: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetCustom id="desktop-setup" icon={Monitor}
      label={`desktop setup · ${open ? `${open} to do` : "all set"}`}
      note="What this desktop needs, whichever repo you are in. A fix acts on the desktop's own screen — look there.">
      <Empty res={res} empty={false} noun="checklist" />
      <ul className="check-list">
        {checks.map((c) => (
          <li key={c.id} className={`check-row check-${c.status}`}>
            <div className="check-top">
              <span className="check-icon">{STATUS_ICON[c.status]}</span>
              <span className="check-label">{c.label}</span>
              {c.fix && (
                <Button onClick={() => void fix(c.fix!)}>
                  <Wrench size={12} /> {busy ? "fixing…" : "fix"}
                </Button>
              )}
            </div>
            <div className="check-detail">{c.detail}</div>
          </li>
        ))}
      </ul>
      {said?.map((n, i) => <Hint key={i}>{n}</Hint>)}
      <Button onClick={() => { setSaid(null); res.reload({ quiet: true }); }}>
        <RefreshCw size={14} className={res.inflight ? "spin" : undefined} /> re-check
      </Button>
    </SetCustom>
  );
}
