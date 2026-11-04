/**
 * The lock card. The sheet opens by itself once, when the app can be seen; after
 * that the button is the way back to it. At a cold start with the sign-ins sealed the same card is
 * the gate (`tokenSealActions.ts`): one sheet opens both, and it may offer a second way on.
 */
import { useEffect, useRef, useState } from "react";
import { Fingerprint } from "lucide-react";
import { lockBody, lockOnStart } from "../../appLock";
import { Button } from "../../kit";
import { SetNote } from "../../SettingsKit";
import { appLockAdapter, appLockOn, openWithoutTokens, sealCardNote, tryUnlock } from "./actions";
import { cardActions, SEAL_EXIT_NOTE } from "./logic";
import { sealCardBody } from "./tokenSealActions";
import { useSealGate } from "./store";

export function LockScreen() {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const running = useRef(false);
  const asked = useRef(false);
  const gate = useSealGate();
  const path = appLockAdapter.path();
  const acts = gate.waiting ? cardActions(gate, lockOnStart(appLockOn(), path)) : { unlock: true, exit: false };

  // Over bytes nobody can open, unlock is the lock's own sheet, or not on the card at all.
  const body = !gate.waiting ? lockBody(path) : !gate.unreadable ? sealCardBody() : acts.unlock ? lockBody(path) : null;

  const unlock = async () => {
    if (running.current) return; // a second tap while the sheet is up does nothing
    running.current = true;
    setBusy(true); setSaid(null);
    const words = await tryUnlock();
    running.current = false;
    setBusy(false); setSaid(words);
  };

  useEffect(() => {
    const askOnce = () => {
      if (asked.current || document.visibilityState !== "visible") return;
      asked.current = true;
      void unlock();
    };
    askOnce();
    document.addEventListener("visibilitychange", askOnce);
    return () => document.removeEventListener("visibilitychange", askOnce);
  }, []);

  return (
    <div className="app-lock" role="dialog" aria-modal="true" aria-label="Locked">
      <div className="auth-card">
        <div className="auth-title"><Fingerprint size={20} style={{ verticalAlign: "-3px", marginRight: 6 }} />Locked</div>
        {body && <SetNote as="p">{body}</SetNote>}
        {gate.waiting && gate.unreadable && <SetNote className="oracle-warn" style={{ marginTop: 8 }}>{sealCardNote()}</SetNote>}
        {said && <SetNote className="oracle-warn" style={{ marginTop: 8 }}>{said}</SetNote>}
        {acts.unlock && (
          <Button variant="primary" style={{ marginTop: 12, width: "100%" }} onClick={() => void unlock()}>
            {busy ? "checking…" : "unlock"}
          </Button>
        )}
        {acts.exit && (
          <>
            <Button style={{ marginTop: 12, width: "100%" }} onClick={openWithoutTokens}>open without the sign-ins</Button>
            <SetNote as="p" style={{ marginTop: 8 }}>{SEAL_EXIT_NOTE}</SetNote>
          </>
        )}
      </div>
    </div>
  );
}
