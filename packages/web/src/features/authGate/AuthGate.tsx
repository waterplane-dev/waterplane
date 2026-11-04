/**
 * The LAN password gate. The host closed this (untrusted) socket pending a
 * password; this takes over the screen. On success the cookie is set and the
 * socket reconnects — the new handshake carries it, so the host lets us in and
 * sends a normal welcome. Lifted from `App.tsx` unchanged.
 */
import { useState } from "react";
import { KeyRound, Lock, RotateCw } from "lucide-react";
import { BRAND } from "@waterplane/shared";
import { api } from "../../api";
import { heldTokens, sealedMode } from "../../deviceToken";
import { goneLead, shellCase } from "./logic";
import { isNativeShell, requestHostSetup } from "../../hostUrl";
import { useStore } from "../../sdk";
import { gate } from "./store";
import { unlocked } from "./actions";
import { Button } from "../../kit";
import { SetNote } from "../../SettingsKit";

const ICON = 16;

export function AuthGate({ reconnect, unlockSeal }: {
  /** App's `connRef.current.reconnect()` — the ONE socket, re-dialled. */
  reconnect: () => void;
  /** Open the sealed sign-ins: null when they are in memory, else why not. */
  unlockSeal: () => Promise<string | null>;
}) {
  const authGate = useStore(gate);
  const [authPw, setAuthPw] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const doLogin = async () => {
    setAuthBusy(true); setAuthErr(null);
    try {
      const r = await api.auth.login(authPw);
      if (r.ok) { setAuthPw(""); unlocked(); reconnect(); }
      else setAuthErr(r.error || "login failed");
    } catch (e) {
      setAuthErr(String((e as Error).message || e));
    } finally {
      setAuthBusy(false);
    }
  };

  const doUnseal = async () => {
    if (authBusy) return;
    setAuthBusy(true); setAuthErr(null);
    const why = await unlockSeal();
    setAuthBusy(false);
    if (why) { setAuthErr(why); return; }
    unlocked(); reconnect();
  };

  if (!authGate) return null;
  const shell = authGate.enabled ? shellCase(isNativeShell(), sealedMode() && !heldTokens()) : null;
  if (shell) {
    return (
      <div className="sheet auth-gate">
        <div className="auth-card">
          <div className="auth-title"><Lock size={20} style={{ verticalAlign: "-3px", marginRight: 6 }} />Locked</div>
          {shell === "locked"
            ? <SetNote as="p">This desktop needs this phone's sign-in, which is locked.</SetNote>
            : <SetNote as="p">{goneLead(authGate.kind)} On the desktop run <code>{BRAND.slug} pair</code>, then tap pair with code.</SetNote>}
          {authErr && <SetNote className="oracle-warn" style={{ marginTop: 8 }}>{authErr}</SetNote>}
          {shell === "locked" && (
            <Button variant="primary" style={{ marginTop: 12, width: "100%" }} onClick={() => void doUnseal()}>
              {authBusy ? "checking…" : "unlock the sign-in"}
            </Button>
          )}
          {/* This card takes the whole screen, so Settings is out of reach: the pair form opens from here. */}
          <Button style={{ marginTop: 12, width: "100%" }} onClick={requestHostSetup}><KeyRound size={ICON} /> pair with code</Button>
          {shell === "gone" && <Button style={{ marginTop: 12, width: "100%" }} onClick={() => reconnect()}><RotateCw size={ICON} /> retry</Button>}
        </div>
      </div>
    );
  }
  return (
    <div className="sheet auth-gate">
      <div className="auth-card">
        <div className="auth-title"><Lock size={20} style={{ verticalAlign: "-3px", marginRight: 6 }} />Locked</div>
        {authGate.enabled ? (
          <>
            <SetNote as="p">This device is on the {authGate.kind === "lan" ? "local network" : "network"}, which is password-protected. Enter the password to continue.</SetNote>
            {/* The button stays pressable with nothing typed and SAYS why it did not
                unlock, rather than greying out (`Unavailable.tsx`). */}
            <form onSubmit={(e) => { e.preventDefault(); if (!authPw) setAuthErr("type the password first"); else if (!authBusy) doLogin(); }}>
              <input
                className="auth-input" type="password" autoFocus placeholder="password"
                value={authPw} onChange={(e) => { setAuthPw(e.target.value); setAuthErr(null); }}
              />
              {authErr && <SetNote className="oracle-warn" style={{ marginTop: 8 }}>{authErr}</SetNote>}
              <Button variant="primary" type="submit" style={{ marginTop: 12, width: "100%" }}>
                {authBusy ? "checking…" : "unlock"}
              </Button>
            </form>
          </>
        ) : (
          <>
            <SetNote as="p">This device is on the local network, and LAN access is protected — but no password has been set yet. Set one from the desktop itself, or from a phone connected over Tailscale (Settings → LAN access), then retry.</SetNote>
            <Button style={{ marginTop: 12 }} onClick={() => reconnect()}><RotateCw size={ICON} /> retry</Button>
          </>
        )}
      </div>
    </div>
  );
}
