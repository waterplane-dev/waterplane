/**
 * The `devices` overlay: the phones that hold their own sign-in for this
 * desktop (the host's device ledger, `GET /api/devices`), and revoke.
 *
 * Works in the APK and the browser PWA alike. Rows: name, first seen, last
 * seen, how it last came in, and "this phone" on the caller's own row. Revoke
 * asks through `Confirm.tsx`; revoking THIS phone is allowed and says it signs
 * this phone out. With no host password there is no ledger to list — said as a
 * sentence (`devicesEmptyText`), never as a greyed control.
 */
import { cleanDeviceRow, sortDevices, type DeviceRow } from "@waterplane/shared";
import { KeyRound, Loader2, RotateCw, Smartphone, Trash2 } from "lucide-react";
import { useState } from "react";
import { Sheet } from "../../Sheet";
import { Empty } from "../../Empty";
import { askConfirm } from "../../Confirm";
import { api } from "../../api";
import { dropDeviceToken } from "../../deviceToken";
import { useRemoteResource } from "../../useRemoteResource";
import { useCore } from "../../sdk";
import { openSettingsAt } from "../../settingsFocus";
import { deviceRouteText, devicesEmptyText, revokeLines, seenAgo } from "./logic";

const ICON = 16;

async function readDevices(): Promise<DeviceRow[]> {
  const r = await api.devices.list();
  return sortDevices((Array.isArray(r?.devices) ? r.devices : []).map(cleanDeviceRow).filter((x): x is DeviceRow => !!x));
}

export function PairedDevicesSheet() {
  const c = useCore();
  const res = useRemoteResource<DeviceRow[]>("devices", readDevices);
  const [revoking, setRevoking] = useState<string | null>(null);
  const passwordSet = c.conn.info.auth.enabled;
  const rows = res.data ?? [];
  const now = Date.now();

  async function revoke(row: DeviceRow): Promise<void> {
    const ok = await askConfirm({ title: `Revoke ${row.name}?`, lines: revokeLines(row), confirmLabel: "Revoke" });
    if (!ok) return;
    c.say.track("action:devices.revoke");
    setRevoking(row.id);
    try {
      const r = await api.devices.revoke(row.id);
      // Its token is dead on the host now; this phone's own copy goes too.
      if (row.current) dropDeviceToken();
      c.say.toast(r.revoked ? `${row.name} revoked` : `${row.name} was already revoked`);
      res.set(rows.filter((x) => x.id !== row.id));
      res.reload({ quiet: true });
    } catch (e) {
      c.say.toast(`could not revoke ${row.name}: ${(e as Error)?.message || "no answer"}`);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <Sheet
      title="Paired devices"
      icon={<Smartphone size={ICON} />}
      onClose={() => c.nav.close("devices")}
      actions={
        <button className="key" aria-label="refresh" onClick={() => res.reload({ quiet: true })}>
          {res.inflight ? <Loader2 size={ICON} className="spin" /> : <RotateCw size={ICON} />}
        </button>
      }
    >
      <Empty res={res} empty={rows.length === 0} thing="the paired devices">{devicesEmptyText(passwordSet)}</Empty>
      {rows.length > 0 && (
        <div className="list">
          {rows.map((d) => (
            <div key={d.id} className="row-wrap">
              <div className="row grow">
                <span className="row-title"><Smartphone size={12} /> {d.name}{d.current ? " · this phone" : ""}</span>
                <span className="row-sub dim">
                  paired {new Date(d.createdAt).toLocaleDateString()} · last seen {seenAgo(Math.max(0, now - d.lastSeenAt))} · {deviceRouteText(d.lastKind)}
                </span>
              </div>
              <div className="row-acts">
                {revoking === d.id ? (
                  <span className="key" aria-label="revoking"><Loader2 size={ICON} className="spin" /></span>
                ) : (
                  <button className="key" aria-label={`revoke ${d.name}`} onClick={() => void revoke(d)}><Trash2 size={ICON} /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {!passwordSet && rows.length > 0 && (
        <>
          <div className="form-hint">No host password is set right now, so these rows cannot sign in until one is.</div>
          <div className="set-row">
            <button className="key" onClick={() => openSettingsAt("lan-password")}><KeyRound size={ICON} /> set the LAN password</button>
          </div>
        </>
      )}
      <div className="form-hint">
        Each row is one phone's own sign-in. Revoking it ends that phone's access at once; changing the host password revokes every row.
      </div>
    </Sheet>
  );
}
