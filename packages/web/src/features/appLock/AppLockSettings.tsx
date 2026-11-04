/**
 * Settings › Connection › lock this app. One authentication each way; the pref
 * is written only after the sheet passed. Rendered in the Android shell only.
 */
import { useEffect, useRef, useState } from "react";
import { Fingerprint } from "lucide-react";
import { LOCK_ROW_MORE, lockRowCant, lockRowNote, lockRowRefusal, lockSwitchPrompt, lockVerdict, needsReread, type LockReread } from "../../appLock";
import { isNativeShell } from "../../hostUrl";
import { isKeystoreError, toKeystoreError } from "../../nativeKeystore";
import { SetAction, SetNote, SetSwitch } from "../../SettingsKit";
import { isDemo, plainHostRoute, usePref, setPref, useCore } from "../../sdk";
import { appLockAdapter } from "./actions";
import { savedPlain } from "./lockActions";

export function AppLockSettings() {
  const core = useCore();
  const on = usePref("appLock");
  const [read, setRead] = useState<LockReread | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const shell = isNativeShell() && appLockAdapter.path() !== null;

  useEffect(() => {
    if (!shell || on) return;
    let live = true;
    void appLockAdapter.reread().then((r) => { if (live) setRead(r); });
    return () => { live = false; };
  }, [shell, on]);

  if (!isNativeShell() || isDemo()) return null; // a browser, the PWA: no switch, nothing to say
  const path = appLockAdapter.path();

  const cant = on ? null : lockRowCant(path, plainHostRoute(), read, savedPlain());
  if (cant) return <SetAction id="app-lock" label="lock this app" icon={Fingerprint} cant={cant} onClick={() => {}} />;

  const toggle = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setSaid(null);
    const turningOn = !on;
    try {
      if (turningOn) {
        await appLockAdapter.enable(lockSwitchPrompt(true));
        setPref("appLock", true);
        core.say.track("action:appLock.on");
        core.say.toast("locked from now on when the app opens — Settings › Connection › lock this app turns it off");
      } else {
        await offAfterConfirm();
        setPref("appLock", false);
        void appLockAdapter.forget();
        core.say.track("action:appLock.off");
        core.say.toast("the app no longer locks itself");
      }
    } catch (e) {
      const err = isKeystoreError(e) ? e : toKeystoreError(e);
      setSaid(lockRowRefusal(err.code, turningOn, err.message, savedPlain()));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <SetSwitch
      id="app-lock" label="lock this app" icon={Fingerprint} on={on} onChange={() => void toggle()}
      state={busy ? "checking…" : undefined}
      note={lockRowNote(path)} more={<p>{LOCK_ROW_MORE}</p>}
    >
      {said && <SetNote className="oracle-warn">{said}</SetNote>}
    </SetSwitch>
  );
}

/**
 * Turning off asks once. A key the phone's own credential already reset has
 * nothing left to ask with; `lockVerdict` says when that is the case, and the
 * switch then goes off without a sheet. Any other refusal keeps the lock on.
 */
async function offAfterConfirm(): Promise<void> {
  try {
    await appLockAdapter.confirm(lockSwitchPrompt(false));
  } catch (e) {
    const err = isKeystoreError(e) ? e : toKeystoreError(e);
    const reread = needsReread(err.code) ? await appLockAdapter.reread() : null;
    if (lockVerdict(err.code, reread) === "stay") throw err;
  }
}
