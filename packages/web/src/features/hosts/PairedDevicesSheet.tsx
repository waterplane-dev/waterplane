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
import { PIN_MAX, PIN_MIN, cleanDeviceRow, normalizePin, sortDevices, type DeviceRow } from "@waterplane/shared";
import { Baby, KeyRound, Loader2, Lock, RotateCw, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Sheet } from "../../Sheet";
import { Empty } from "../../Empty";
import { askConfirm } from "../../Confirm";
import { askText } from "../../AskText";
import { passiveApi } from "../../passiveApi";
import { api } from "../../api";
import { dropDeviceToken } from "../../deviceToken";
import { useRemoteResource } from "../../useRemoteResource";
import { useCore } from "../../sdk";
import { openSettingsAt } from "../../settingsFocus";
import { deviceRouteText, devicesEmptyText, revokeLines, seenAgo } from "./logic";
import { Button, Row, RowTitle, RowSub, Hint } from "../../kit";

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
  // The passive devices' unlock PIN: `undefined` = not asked yet.
  const [pinSet, setPinSet] = useState<boolean | undefined>(undefined);
  useEffect(() => { void passiveApi.status().then((st) => { if (st) setPinSet(!!st.pinSet); }); }, []);
  const anyPassive = rows.some((d) => d.scope === "passive");

  async function setPin(): Promise<void> {
    const raw = await askText({
      title: pinSet ? "Change the unlock PIN" : "Set the unlock PIN",
      placeholder: `${PIN_MIN}–${PIN_MAX} digits`, okLabel: "Save",
      note: "A passive device unlocks the full app for 30 minutes with this PIN. Changing it locks every unlocked one.",
    });
    if (raw === null) return;
    const pin = normalizePin(raw);
    if (!pin) { c.say.toast(`not saved: a PIN is ${PIN_MIN}–${PIN_MAX} digits`); return; }
    c.say.track("action:devices.pin");
    try {
      const r = await passiveApi.setPin(pin);
      setPinSet(r.pinSet);
      c.say.toast("unlock PIN saved");
    } catch (e) {
      c.say.toast(`PIN not saved: ${(e as Error)?.message || "no answer"}`);
    }
  }

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
        <Button aria-label="refresh" onClick={() => res.reload({ quiet: true })}>
          {res.inflight ? <Loader2 size={ICON} className="spin" /> : <RotateCw size={ICON} />}
        </Button>
      }
    >
      <Empty res={res} empty={rows.length === 0} thing="the paired devices">{devicesEmptyText(passwordSet)}</Empty>
      {rows.length > 0 && (
        <div className="list">
          {rows.map((d) => (
            <Row key={d.id} kind="wrap">
              <Row kind="grow">
                <RowTitle>{d.scope === "passive" ? <Baby size={12} /> : <Smartphone size={12} />} {d.name}{d.current ? " · this phone" : ""}{d.scope === "passive" ? " · passive" : ""}</RowTitle>
                <RowSub className="dim">
                  paired {new Date(d.createdAt).toLocaleDateString()} · last seen {seenAgo(Math.max(0, now - d.lastSeenAt))} · {deviceRouteText(d.lastKind)}
                </RowSub>
              </Row>
              <div className="row-acts">
                {revoking === d.id ? (
                  <span className="key" aria-label="revoking"><Loader2 size={ICON} className="spin" /></span>
                ) : (
                  <Button aria-label={`revoke ${d.name}`} onClick={() => void revoke(d)}><Trash2 size={ICON} /></Button>
                )}
              </div>
            </Row>
          ))}
        </div>
      )}
      {!passwordSet && rows.length > 0 && (
        <>
          <Hint>No host password is set right now, so these rows cannot sign in until one is.</Hint>
          <div className="set-row">
            <Button onClick={() => openSettingsAt("lan-password")}><KeyRound size={ICON} /> set the LAN password</Button>
          </div>
        </>
      )}
      {(anyPassive || pinSet) && (
        <>
          <Hint>
            {pinSet === undefined ? "Asking the desktop whether an unlock PIN is set…"
              : pinSet ? "Passive devices get app updates only; the unlock PIN opens the full app on one for 30 minutes."
              : "No unlock PIN is set, so a passive device cannot be unlocked."}
          </Hint>
          <div className="set-row">
            <Button title="the PIN a passive device unlocks with" onClick={() => void setPin()}>
              <Lock size={ICON} /> {pinSet ? "change the unlock PIN" : "set the unlock PIN"}
            </Button>
          </div>
        </>
      )}
      <Hint>
        Each row is one phone's own sign-in. Revoking it ends that phone's access at once; changing the host password revokes every row.
      </Hint>
    </Sheet>
  );
}
